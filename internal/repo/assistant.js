/**
 * @file internal/repo/assistant.js
 * 对应 Go 源文件：internal/repo/assistant.go
 *
 * 作用与职责边界：
 * 实现 Studio 助手会话（`assistant_sessions`）与定时助手任务（`assistant_tasks`）的核心持久层读写逻辑，
 * 包括会话查询、摘要投影与降级回填（标题与参与者）、事务内保存与死锁重试、归档、工作区绑定与回滚、删除，
 * 以及定时任务的增删改查、状态时间戳维护与完成通知入队。
 * 不负责流式生成生命周期管理与共享会话分支编排（分别位于同包其他文件中）。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；`db.Transaction` 回调同样失败抛错、成功正常返回。
 * - Go 的 `(值, bool)` 返回译为 `[值, boolean]` 元组。
 * - Go 的 `gorm` 链式调用按原样保留；`errors.Is` 译为 `===`，`errors.As` 译为 `instanceof`。
 * - Go 的 `atomic.Bool` 在单线程 JS 中译为普通布尔变量；死锁退避中的 `select` + `time.After` + `ctx.Done()` 译为 `async` + `sleepOrAbort`。
 * - Go 的 `time.Time` 零值译为 `null`，排序比较零值时按 Go 公元 1 年零值毫秒数 `-62135596800000` 处理。
 */

"use strict";

const path = require("node:path");
const { Buffer } = require("node:buffer");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause
const mysqldriver = require("github.com/go-sql-driver/mysql"); // Go 第三方包 github.com/go-sql-driver/mysql

const { AssistantSession, AssistantTask, AssistantExecutionTarget, AssistantSourceSOP, AssistantSourceChat, AssistantModePlatform } = require("../domain/assistant.js"); // 对应 Go 同包类型与常量，assistant.js 已翻译
const { ExecutionModeCloud } = require("../domain/observability.js"); // 对应 Go 同包常量，observability.js 已翻译
const { CloneNotificationBindings } = require("../domain/notification_template.js"); // 对应 Go 同包函数，notification_template.js 已翻译
const { assistantSessionRow, assistantTaskRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON, upsert, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译
const { assistantDiagnosticsRow } = require("./assistant_diagnostics.js"); // 对应 Go 同包类型，assistant_diagnostics.js 本次一同翻译
const { deriveAssistantParticipants, summaryProjectionUnsupported } = require("./assistant_context.js"); // 对应 Go 同包函数，assistant_context.js 本次一同翻译
const { ErrAssistantSessionProjectChanged, ErrAssistantExecutionLocked } = require("./assistant_execution.js"); // 对应 Go 同包变量，assistant_execution.js 本次一同翻译
const { inferredAssistantSessionSource } = require("./assistant_session_cleanup.js"); // 对应 Go 同包函数，assistant_session_cleanup.js 本次一同翻译

// 当已有个人工作区的会话尝试改绑到项目时返回的领域错误。
const ErrAssistantPersonalWorkspaceProject = new Error("此会话已有个人工作区，请在项目中新建对话");

/**
 * 规整并校验助手会话或任务的记录 ID，剥离路径前缀并拒绝空值或相对目录标识。
 * 用于所有按 ID 读写会话/任务记录前的入参清洗，防止路径穿越类异常 ID 落库。
 *
 * @param {string} id - 原始记录标识字符串。
 * @returns {string} 清洗后的合法基础文件名形式 ID；非法或为空时返回 `""`。
 */
function assistantRecordID(id) {
  id = path.basename(id.trim());
  if (id === "" || id === "." || id === "..") {
    return "";
  }
  return id;
}

/**
 * 按所属用户与会话 ID 读取单条完整的助手会话记录（包含消息历史）。
 * 用于打开会话详情、权限校验以及保存前读取旧版本会话。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} id - 会话 ID。
 * @returns {[AssistantSession, boolean]} 返回 `[会话实例, 是否找到]`；未找到或入参非法时返回 `[空会话实例, false]`。
 */
AssistantRepo.prototype.AssistantSession = function (userID, id) {
  id = assistantRecordID(id);
  if (userID <= 0 || id === "") {
    return [new AssistantSession(), false];
  }
  const row = new assistantSessionRow();
  const err = this.DB.Table("assistant_sessions").Where("id = ? AND user_id = ?", id, userID).Take(row).Error;
  if (err != null) {
    return [new AssistantSession(), false];
  }
  return [decodeAssistantSession(row), true];
};

/**
 * 查询指定用户的全部助手会话摘要列表（剥离完整聊天记录 `Messages`），按更新时间倒序返回。
 * 用于侧边栏历史会话列表展示，避免传输和反序列化庞大的对话正文。
 *
 * @param {number} userID - 目标用户 ID。
 * @returns {AssistantSession[]} 用户的会话摘要列表；入参非法或查询失败时返回空数组 `[]`。
 */
AssistantRepo.prototype.ListAssistantSessions = function (userID) {
  if (userID <= 0) {
    return [];
  }
  let rows;
  try {
    rows = this.findAssistantSessionSummaries("user_id = ?", userID);
  } catch (err) {
    console.log(`assistant session list failed user=${userID}: ${err}`);
    return [];
  }
  const out = [];
  for (const row of rows) {
    const item = decodeAssistantSession(row);
    item.Messages = null;
    out.push(item);
  }
  return out;
};

/**
 * 构造在 SQL 层剔除 `$.messages` 的会话摘要查询句柄，同时附带消息条数与参与者投影摘要。
 * 供列表与权限检查使用，确保数据库不会把完整聊天历史传输到应用层。
 *
 * @returns {object} 配置好 `SELECT` 投影列的 `gorm.DB` 查询构造器。
 */
AssistantRepo.prototype.assistantSessionSummaries = function () {
  let summary = "json(" + this.assistantParticipantSummarySQL() + ")";
  if (this.DB.Dialector.Name() !== "sqlite") {
    summary = "CAST((" + this.assistantParticipantSummarySQL() + ") AS JSON)";
  }
  return this.DB.Table("assistant_sessions").Select("id, user_id, project_id, title, model, source, task_id, created_at, updated_at, JSON_SET(JSON_REMOVE(payload, '$.messages'), '$.executionMessageCount', " + this.assistantExecutionMessageCountSQL() + ", '$.participantSummaryMessages', " + summary + ") AS payload");
};

/**
 * 按当前数据库方言返回统计 `payload.messages` 数组长度的 SQL 表达式。
 * 用于在剥离消息正文的同时保留判断会话是否已有对话消息所需的数量信息。
 *
 * @returns {string} 适用于 SQLite 或 MySQL 的消息条数统计 SQL 片段。
 */
AssistantRepo.prototype.assistantExecutionMessageCountSQL = function () {
  if (this.DB.Dialector.Name() === "sqlite") {
    return "COALESCE(JSON_ARRAY_LENGTH(payload, '$.messages'), 0)";
  }
  return "COALESCE(JSON_LENGTH(JSON_EXTRACT(payload, '$.messages')), 0)";
};

// 进程级降级标记：当数据库不支持 JSON_TABLE 等新 JSON 函数时记住状态，避免每次查列表重复报错。
let noSummaryProjection = false;

/**
 * 按指定条件查询会话摘要行并在应用层排序与按需回填参与者缓存及缺失标题。
 * 优先使用带参与者投影的 SQL；若数据库不支持（如 MySQL 5.7 缺少 `JSON_TABLE`），自动降级为元数据查询并回填旧行缓存。
 * 排序放在应用层执行，避免 MySQL 8 对含大 JSON 字段的行做文件排序时耗尽排序缓冲。
 *
 * @param {string} where - SQL `WHERE` 条件子句。
 * @param {...any} args - 与 `where` 占位符对应的查询参数。
 * @returns {object[]} 已按更新时间倒序排好序的 `assistantSessionRow` 列表。
 * @throws {Error} 当降级查询仍失败时抛出底层数据库错误。
 */
AssistantRepo.prototype.findAssistantSessionSummaries = function (where, ...args) {
  let rows = [];
  if (!noSummaryProjection) {
    const err = this.assistantSessionSummaries().Where(where, ...args).Find(rows).Error;
    if (err == null) {
      sortAssistantSessionRows(rows);
      this.backfillAssistantTitles(rows);
      return rows;
    }
    if (summaryProjectionUnsupported(err)) {
      if (!noSummaryProjection) {
        noSummaryProjection = true;
        console.log(`assistant session summary projection unsupported by this database, using metadata fallback from now on: ${err}`);
      }
    } else {
      console.log(`assistant session summary projection failed, using metadata fallback: ${err}`);
    }
  }
  const fallback = () => {
    const out = [];
    const err = this.DB.Table("assistant_sessions").Select("id, user_id, project_id, title, model, source, task_id, created_at, updated_at, JSON_SET(JSON_REMOVE(payload, '$.messages'), '$.executionMessageCount', " + this.assistantExecutionMessageCountSQL() + ") AS payload").Where(where, ...args).Find(out).Error;
    sortAssistantSessionRows(out);
    if (err != null) {
      throw err;
    }
    return out;
  };
  rows = fallback();
  if (this.backfillAssistantParticipants(rows) > 0) {
    rows = fallback();
  }
  this.backfillAssistantTitles(rows);
  return rows;
};

/**
 * 根据消息列表中的第一条非空用户消息生成会话默认标题（超过 36 个字符时截断并追加省略号）。
 * 用于新对话自动命名以及历史空标题会话的回填。
 *
 * @param {object[]} messages - 会话消息列表（`domain.AssistantMessage[]`）。
 * @returns {string} 提取出的会话标题；若不存在有效用户消息则返回 `""`。
 */
function AssistantTitleFromMessages(messages) {
  for (const m of messages ?? []) {
    if (m.Role !== "user") {
      continue;
    }
    const title = [...m.Content.trim()];
    if (title.length > 0) {
      if (title.length > 36) {
        return title.slice(0, 36).join("") + "…";
      }
      return title.join("");
    }
  }
  return "";
}

/**
 * 为历史上标题为空的非 SOP 会话按首条用户消息（或兜底 `"新对话"`）一次性回填标题并同步更新内存行。
 * SOP 运行会话（ID 以 `"sop-"` 开头）始终由工作流命名，不参与此回填。
 *
 * @param {object[]} rows - 已查出的会话摘要行列表（`assistantSessionRow[]`），回填成功后会原地更新对应行的 `Title`。
 * @returns {void} 无返回值。
 */
AssistantRepo.prototype.backfillAssistantTitles = function (rows) {
  const index = {};
  const ids = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.Title.trim() === "" && !row.ID.startsWith("sop-")) {
      index[row.ID] = i;
      ids.push(row.ID);
    }
  }
  for (let start = 0; start < ids.length; start += 50) {
    const end = Math.min(start + 50, ids.length);
    const full = [];
    const err = this.DB.Table("assistant_sessions").Where("id IN ?", ids.slice(start, end)).Find(full).Error;
    if (err != null) {
      console.log(`assistant title backfill read failed: ${err}`);
      return;
    }
    for (const row of full) {
      const item = decodeAssistantSession(row);
      let title = item.Title.trim();
      if (title === "") {
        title = AssistantTitleFromMessages(item.Messages);
      }
      if (title === "") {
        title = "新对话";
      }
      const writeErr = this.DB.Exec("UPDATE assistant_sessions SET title = ? WHERE id = ? AND (title = '' OR title IS NULL)", title, row.ID).Error;
      if (writeErr != null) {
        console.log(`assistant title backfill write failed id=${row.ID}: ${writeErr}`);
        continue;
      }
      rows[index[row.ID]].Title = title;
    }
  }
};

/**
 * 按行记录的更新时间 `Updated` 稳定降序排列会话摘要行列表，缺失时间视为最早零值。
 * 用于在应用层替代数据库 `ORDER BY updated_at DESC`，避免大 JSON 载荷触发排序内存溢出。
 *
 * @param {object[]} rows - 待原地排序的 `assistantSessionRow` 数组。
 * @returns {void} 无返回值。
 */
function sortAssistantSessionRows(rows) {
  const at = (row) => (row.Updated == null ? -62135596800000 : row.Updated.getTime());
  rows.sort((a, b) => at(b) - at(a));
}

/**
 * 为尚未写入参与者版本缓存（`participantsVersion !== 1`）的历史会话分批补写参与者摘要到 JSON 载荷中。
 * 补写完成后，后续列表请求无需依赖 `JSON_TABLE` 也无需传输完整对话消息。
 *
 * @param {object[]} rows - 降级查出的会话摘要行列表（`assistantSessionRow[]`）。
 * @returns {number} 实际成功更新的数据库行数。
 */
AssistantRepo.prototype.backfillAssistantParticipants = function (rows) {
  const ids = [];
  for (const row of rows) {
    let meta = null;
    try {
      meta = JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8"));
    } catch (err) {
      meta = null;
    }
    if (meta != null && meta.participantsVersion !== 1) {
      ids.push(row.ID);
    }
  }
  let jsonArg = "CAST(? AS JSON)";
  if (this.DB.Dialector.Name() === "sqlite") {
    jsonArg = "json(?)";
  }
  let updated = 0;
  for (let start = 0; start < ids.length; start += 50) {
    const end = Math.min(start + 50, ids.length);
    const full = [];
    const err = this.DB.Table("assistant_sessions").Where("id IN ?", ids.slice(start, end)).Find(full).Error;
    if (err != null) {
      console.log(`assistant participant backfill read failed: ${err}`);
      return updated;
    }
    for (const row of full) {
      const item = decodeAssistantSession(row);
      let unknown = "false";
      if (item.UnknownParticipants) {
        unknown = "true";
      }
      const res = this.DB.Exec("UPDATE assistant_sessions SET payload = JSON_SET(payload, '$.participants', " + jsonArg + ", '$.participantsVersion', 1, '$.unknownParticipants', " + jsonArg + ") WHERE id = ? AND updated_at = ?",
        mustJSON(item.Participants).toString("utf8"), unknown, row.ID, row.Updated);
      if (res.Error != null) {
        console.log(`assistant participant backfill write failed id=${row.ID}: ${res.Error}`);
        continue;
      }
      updated += res.RowsAffected;
    }
  }
  return updated;
};

/**
 * 在行锁事务中保存或更新助手会话，并在遇到 InnoDB 间隙锁死锁（错误码 1213）时自动退避重试。
 * 供上层创建新会话或提交会话内容更新时调用。
 *
 * @param {number} userID - 操作归属的用户 ID。
 * @param {AssistantSession} v - 待保存的会话对象。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 校验失败、锁冲突重试耗尽或数据库写入异常时抛出错误。
 */
AssistantRepo.prototype.PutAssistantSession = async function (userID, v) {
  await this.retryAssistantDeadlock(() => this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ?", assistantRecordID(v.ID)).Take(row).Error;
    if (err != null && err !== gorm.ErrRecordNotFound) {
      throw err;
    }
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    scoped.DB = tx;
    const base = { ...this.deps, DB: tx };
    scoped.deps = base;
    scoped.putAssistantSession(userID, v);
  }));
};

/**
 * 等待指定毫秒数或在取消信号触发时提前中止，对应 Go 中基于 `ctx.Done()` 与 `time.After` 的 `select` 等待。
 * 用于死锁重试的指数退避阶段，确保上下文取消时立即中断等待。
 *
 * @param {AbortSignal|null|undefined} ctx - 可选的取消信号对象。
 * @param {number} ms - 需要等待的毫秒数。
 * @returns {Promise<void>} 到达等待时长后完成；若 `ctx` 触发取消则以取消原因拒绝。
 */
function sleepOrAbort(ctx, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(ctx.reason);
    };
    const cleanup = () => {
      if (ctx instanceof AbortSignal) {
        ctx.removeEventListener("abort", onAbort);
      }
    };
    if (ctx instanceof AbortSignal) {
      if (ctx.aborted) {
        onAbort();
        return;
      }
      ctx.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * 执行可能锁定不存在会话行的事务并在命中 MySQL 死锁错误（错误码 1213）时做最多 6 次指数退避重试。
 * 仅对已由 MySQL 完整回滚的 1213 死锁重放，绝不重放未知的提交或连接异常。
 *
 * @param {function(): (void|Promise<void>)} transaction - 单次事务执行回调；失败时抛出错误。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 非死锁错误、达到最大重试次数或上下文被取消时抛出错误。
 */
AssistantRepo.prototype.retryAssistantDeadlock = async function (transaction) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await transaction();
      return;
    } catch (err) {
      const sqlErr = err instanceof mysqldriver.MySQLError ? err : null;
      if (sqlErr == null || sqlErr.Number !== 1213 || attempt === 5) {
        throw err;
      }
    }
    await sleepOrAbort(this.DB.Statement.Context, (2 ** attempt) * 5);
  }
};

/**
 * 用模型生成的摘要标题替换新会话的初始提示词标题。
 * 若用户已手动改名、已生成过摘要或该会话为分支派生会话，则保留原标题不做覆盖。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} id - 会话 ID。
 * @param {string} title - 模型生成的新标题（去除首尾空白后长度须在 1～36 个字符之间）。
 * @returns {void} 无返回值。
 * @throws {Error} 入参非法、会话不存在、无权访问或数据库写入失败时抛出错误。
 */
AssistantRepo.prototype.SetAssistantSessionGeneratedTitle = function (userID, id, title) {
  title = title.trim();
  id = assistantRecordID(id);
  if (userID <= 0 || id === "") {
    throw new Error("assistant session id is required");
  }
  const runes = [...title];
  if (runes.length === 0 || runes.length > 36) {
    throw new Error("assistant title is invalid");
  }
  this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ?", id).Take(row).Error;
    if (err != null) {
      throw err;
    }
    if (row.UserID !== userID) {
      throw new Error("assistant session belongs to another user");
    }
    const item = decodeAssistantSession(row);
    if (item.TitleEdited || item.TitleGenerated || item.ParentSessionID !== "") {
      return;
    }
    item.Title = title;
    item.TitleGenerated = true;
    item.UpdatedAt = null;
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    scoped.DB = tx;
    const base = { ...this.deps, DB: tx };
    scoped.deps = base;
    scoped.putAssistantSession(userID, item);
  });
};

/**
 * 在当前事务连接上合并服务端保护字段并持久化会话记录（供同包事务方法复用）。
 * 负责校验归属权、个人工作区与项目隔离、执行目标锁定、标题继承策略、准入回执滚动列表与参与者重算。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {AssistantSession} v - 待写入的会话对象。
 * @param {...string} acceptedRequest - 可选的本次已受理客户端请求 ID（用于记录幂等回执，最多保留最近 32 条）。
 * @returns {void} 无返回值。
 * @throws {Error} 参数非法、归属冲突、业务规则受限或数据库写入失败时抛出错误。
 */
AssistantRepo.prototype.putAssistantSession = function (userID, v, ...acceptedRequest) {
  if (userID <= 0) {
    throw new Error("assistant session user is required");
  }
  v.ID = assistantRecordID(v.ID);
  if (v.ID === "") {
    throw new Error("assistant session id is required");
  }
  const [existing, existingOK] = this.sessionByID(v.ID);
  if (existingOK && existing.UserID !== userID) {
    throw new Error("assistant session belongs to another user");
  }
  const [old, exists] = this.AssistantSession(userID, v.ID);
  if (exists) {
    if (old.ProjectID === "" && v.ProjectID.trim() !== "" && (old.WorkspaceRunID !== "" || (old.OwnWorkspaceRunIDs ?? []).length !== 0)) {
      throw ErrAssistantPersonalWorkspaceProject;
    }
    const target = old.Execution();
    if (old.ExecutionLocked() && v.ExecutionTarget != null && (v.ExecutionTarget.Pool !== target.Pool || v.ExecutionTarget.RunnerID !== target.RunnerID)) {
      throw ErrAssistantExecutionLocked;
    }
    if (old.ExecutionLocked() || v.ExecutionTarget == null) {
      v.ExecutionTarget = target;
    }
    v.ExecutionTargetLocked = old.ExecutionLocked() || v.ExecutionTargetLocked;
    v.RuntimeMode = old.Mode();
  } else {
    if (v.ExecutionTarget == null) {
      v.ExecutionTarget = new AssistantExecutionTarget({ Pool: ExecutionModeCloud });
    }
    v.RuntimeMode = AssistantModePlatform;
  }

  let now = new Date();
  const [oldAgain, okAgain] = this.AssistantSession(userID, v.ID);
  if (okAgain && oldAgain.CreatedAt != null) {
    v.CreatedAt = oldAgain.CreatedAt;
    const oldUpdatedMs = oldAgain.UpdatedAt == null ? 0 : oldAgain.UpdatedAt.getTime();
    if (!(now.getTime() > oldUpdatedMs)) {
      now = new Date(oldUpdatedMs + 1);
    }
    // 共享项目回复写入时通常不携带标题，应保留对话初始标题而非清空。
    if ((oldAgain.TitleEdited && !v.TitleEdited) || v.Title.trim() === "") {
      v.Title = oldAgain.Title;
    }
    // 后台生成的摘要并非用户手动改名；后续仍携带旧提示词标题的保存不得覆盖摘要。
    if (oldAgain.TitleGenerated && !v.TitleGenerated && !v.TitleEdited) {
      v.Title = oldAgain.Title;
    }
    v.TitleEdited = oldAgain.TitleEdited || v.TitleEdited;
    if (v.TitleEdited) {
      v.TitleGenerated = false;
    } else {
      v.TitleGenerated = oldAgain.TitleGenerated || v.TitleGenerated;
    }
    v.HistoryRevision = oldAgain.HistoryRevision;
    v.ParentSessionID = oldAgain.ParentSessionID;
    v.RootSessionID = oldAgain.RootSessionID;
    v.ForkMessageIndex = oldAgain.ForkMessageIndex;
    if (oldAgain.ParentSessionID !== "" && !v.TitleEdited) {
      v.Title = oldAgain.Title;
    }
    v.IssueID = oldAgain.IssueID;
    v.Archived = oldAgain.Archived;
    v.Shared = oldAgain.Shared;
    // 沙箱环境配置仅允许通过专用的带锁接口修改。
    v.SandboxProfileID = oldAgain.SandboxProfileID;
    if (v.WorkspaceRunID === "") {
      v.WorkspaceRunID = oldAgain.WorkspaceRunID;
    }
    v.OwnWorkspaceRunIDs = oldAgain.OwnWorkspaceRunIDs;
    if (v.Source === "") {
      v.Source = oldAgain.Source;
      if (v.Source === "") {
        v.Source = inferredAssistantSessionSource(oldAgain);
      }
    }
    if (v.TaskID === "") {
      v.TaskID = oldAgain.TaskID;
    }
    if (v.WorkflowID === "") {
      v.WorkflowID = oldAgain.WorkflowID;
    }
    if (oldAgain.Shared) {
      v.RunID = oldAgain.RunID;
      v.ProjectID = oldAgain.ProjectID;
      // 首次模型生成的摘要标题允许替换共享 SOP 默认标签；其他写入均保留原有标题。
      if (!(v.TitleGenerated && !oldAgain.TitleGenerated && !oldAgain.TitleEdited)) {
        v.Title = oldAgain.Title;
      }
    }
  } else {
    v.OwnWorkspaceRunIDs = null;
    if (v.CreatedAt == null) {
      v.CreatedAt = now;
    }
  }
  if (v.UpdatedAt == null) {
    v.UpdatedAt = now;
  }
  if (v.Source === "") {
    if (v.Shared && v.RunID !== "") {
      v.Source = AssistantSourceSOP;
    } else {
      v.Source = AssistantSourceChat;
    }
  }
  // 准入回执列表由服务端托管，跨后续聊天记录写入持续保留。
  v.RecentClientRequestIDs = old.RecentClientRequestIDs;
  if (acceptedRequest.length > 0 && acceptedRequest[0] !== "") {
    const maxReceipts = 32;
    let receipts = v.RecentClientRequestIDs ?? [];
    if (receipts.length >= maxReceipts) {
      receipts = receipts.slice(receipts.length - maxReceipts + 1);
    }
    v.RecentClientRequestIDs = [...receipts, acceptedRequest[0]];
  }
  v.UserID = userID;
  // 最新生成 ID 与未读状态属于列表查询投影字段，不随对话正文落盘。
  v.GenerationID = "";
  v.Unread = false;
  v.ExecutionTargetLocked = v.ExecutionLocked();
  deriveAssistantParticipants(v, v.Messages);
  upsert(this.DB, "assistant_sessions", {
    id: v.ID,
    user_id: userID,
    project_id: v.ProjectID.trim(),
    title: v.Title.trim(),
    model: v.Model.trim(),
    source: v.Source.trim(),
    task_id: v.TaskID.trim(),
    payload: mustJSON(v),
    created_at: timePtr(v.CreatedAt),
    updated_at: timePtr(v.UpdatedAt),
  });
};

/**
 * 在行锁事务中更新指定会话的归档状态，不改动 `updated_at` 以避免与正在进行的生成产生冲突。
 * 用于用户在历史列表中归档或取消归档对话。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} id - 会话 ID。
 * @param {boolean} archived - 目标归档状态（`true` 为归档，`false` 为取消归档）。
 * @returns {void} 无返回值。
 * @throws {Error} 会话不存在或数据库更新失败时抛出错误。
 */
AssistantRepo.prototype.SetAssistantSessionArchived = function (userID, id, archived) {
  this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", assistantRecordID(id), userID).Take(row).Error;
    if (err != null) {
      throw new Error("会话不存在");
    }
    const item = decodeAssistantSession(row);
    item.Archived = archived;
    const updateErr = tx.Model(new assistantSessionRow()).Where("id = ? AND user_id = ?", row.ID, userID).Update("payload", mustJSON(item)).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
};

/**
 * 为普通会话绑定主助手选定的工作区运行 ID；当该工作区由本会话创建时同时记入自有工作区列表。
 * 在行锁内校验项目归属保持不变，且不修改 `updated_at` 以免影响正在进行的回复写入。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} id - 会话 ID。
 * @param {string} projectID - 期望的会话所属项目 ID。
 * @param {string} runID - 要绑定的工作区运行 ID。
 * @param {boolean} own - 该工作区是否由本会话新建并拥有。
 * @returns {void} 无返回值。
 * @throws {Error} 会话不存在、项目已变更、属于任务会话或数据库更新失败时抛出错误。
 */
AssistantRepo.prototype.SetAssistantSessionWorkspaceRun = function (userID, id, projectID, runID, own) {
  this.updateAssistantSessionWorkspace(userID, id, projectID, (item) => {
    item.WorkspaceRunID = runID.trim();
    const ownRunIDs = item.OwnWorkspaceRunIDs ?? [];
    if (own && item.WorkspaceRunID !== "" && !ownRunIDs.includes(item.WorkspaceRunID)) {
      ownRunIDs.push(item.WorkspaceRunID);
      item.OwnWorkspaceRunIDs = ownRunIDs;
    }
  });
};

/**
 * 在新工作区启动失败时于同一行锁内回滚会话的工作区绑定，并按需将失败的工作区从自有列表中移除。
 * 仅当当前生效的 `WorkspaceRunID` 仍是 `failedRunID` 时才恢复为 `previousRunID`。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} id - 会话 ID。
 * @param {string} projectID - 期望的会话所属项目 ID。
 * @param {string} failedRunID - 本次启动失败的工作区运行 ID。
 * @param {string} previousRunID - 需要恢复的前一个工作区运行 ID。
 * @param {boolean} discardFailedRun - 是否从 `OwnWorkspaceRunIDs` 中剔除 `failedRunID`。
 * @returns {string} 回滚后当前生效的工作区运行 ID。
 * @throws {Error} 会话不存在、项目已变更、属于任务会话或数据库更新失败时抛出错误。
 */
AssistantRepo.prototype.RollbackAssistantSessionWorkspaceRun = function (userID, id, projectID, failedRunID, previousRunID, discardFailedRun) {
  let activeRunID = "";
  this.updateAssistantSessionWorkspace(userID, id, projectID, (item) => {
    if (item.WorkspaceRunID === failedRunID) {
      item.WorkspaceRunID = previousRunID;
    }
    if (discardFailedRun) {
      item.OwnWorkspaceRunIDs = (item.OwnWorkspaceRunIDs ?? []).filter((runID) => runID !== failedRunID);
    }
    activeRunID = item.WorkspaceRunID;
  });
  return activeRunID;
};

/**
 * 在行锁事务内校验普通会话的项目范围并执行工作区字段变更回调后写回 `payload`。
 * 为 `SetAssistantSessionWorkspaceRun` 与 `RollbackAssistantSessionWorkspaceRun` 共享的底层更新入口。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} id - 会话 ID。
 * @param {string} projectID - 期望的会话所属项目 ID。
 * @param {function(AssistantSession): void} update - 原地修改会话工作区字段的回调函数。
 * @returns {void} 无返回值。
 * @throws {Error} 会话不存在、项目已变更、属于任务会话或数据库更新失败时抛出错误。
 */
AssistantRepo.prototype.updateAssistantSessionWorkspace = function (userID, id, projectID, update) {
  this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", assistantRecordID(id), userID).Take(row).Error;
    if (err != null) {
      throw new Error("会话不存在");
    }
    const item = decodeAssistantSession(row);
    if (item.ProjectID !== projectID) {
      throw ErrAssistantSessionProjectChanged;
    }
    if (item.RunID !== "") {
      throw new Error("任务会话直接使用任务工作区");
    }
    update(item);
    const updateErr = tx.Model(new assistantSessionRow()).Where("id = ? AND user_id = ?", row.ID, userID).Update("payload", mustJSON(item)).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
};

/**
 * 在事务内删除指定用户的会话及其关联的已读游标、诊断证据与生成记录。
 * 删除前会锁定生成行，若当前仍有运行中的回复生成则拒绝删除。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} id - 待删除的会话 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 会话不存在、正在生成中或任意关联表删除失败时抛出错误。
 */
AssistantRepo.prototype.DeleteAssistantSession = function (userID, id) {
  const { assistantGenerationRow } = require("./assistant_generations.js"); // 循环引用：调用时现取，不缓存
  const { assistantSessionReadRow } = require("./assistant_session_reads.js"); // 循环引用：调用时现取，不缓存
  id = assistantRecordID(id);
  if (userID <= 0 || id === "") {
    throw new Error("assistant session not found");
  }
  this.DB.Transaction((tx) => {
    const job = new assistantGenerationRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ? AND user_id = ?", id, userID).Take(job).Error;
    if (err != null && err !== gorm.ErrRecordNotFound) {
      throw err;
    }
    if (err == null && job.Status === "running") {
      throw new Error("请先停止生成再删除会话");
    }
    const res = tx.Table("assistant_sessions").Where("id = ? AND user_id = ?", id, userID).Delete(null);
    if (res.Error != null) {
      throw res.Error;
    }
    if (res.RowsAffected === 0) {
      throw new Error("assistant session not found");
    }
    let deleteErr = tx.Where("session_id = ?", id).Delete(new assistantSessionReadRow()).Error;
    if (deleteErr != null) {
      throw deleteErr;
    }
    deleteErr = tx.Where("session_id = ? AND user_id = ?", id, userID).Delete(new assistantDiagnosticsRow()).Error;
    if (deleteErr != null) {
      throw deleteErr;
    }
    deleteErr = tx.Where("session_id = ? AND user_id = ?", id, userID).Delete(new assistantGenerationRow()).Error;
    if (deleteErr != null) {
      throw deleteErr;
    }
  });
};

/**
 * 按所属用户与任务 ID 读取单条定时助手任务记录。
 * 用于任务详情查看、编辑前读取与手动触发前的校验。
 *
 * @param {number} userID - 任务所属用户 ID。
 * @param {string} id - 定时任务 ID。
 * @returns {[AssistantTask, boolean]} 返回 `[定时任务实例, 是否找到]`；未找到或入参非法时返回 `[空任务实例, false]`。
 */
AssistantRepo.prototype.AssistantTask = function (userID, id) {
  id = assistantRecordID(id);
  if (userID <= 0 || id === "") {
    return [new AssistantTask(), false];
  }
  const row = new assistantTaskRow();
  const err = this.DB.Table("assistant_tasks").Where("id = ? AND user_id = ?", id, userID).Take(row).Error;
  if (err != null) {
    return [new AssistantTask(), false];
  }
  return [decodeAssistantTask(row), true];
};

/**
 * 查询指定用户的全部定时助手任务，并按更新时间倒序排列。
 * 用于用户的定时任务列表页面展示。
 *
 * @param {number} userID - 目标用户 ID。
 * @returns {AssistantTask[]} 按更新时间倒序排列的定时任务数组；入参非法或查询失败时返回 `[]`。
 */
AssistantRepo.prototype.ListAssistantTasks = function (userID) {
  if (userID <= 0) {
    return [];
  }
  const rows = [];
  const err = this.DB.Table("assistant_tasks").Where("user_id = ?", userID).Find(rows).Error;
  if (err != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    out.push(decodeAssistantTask(row));
  }
  out.sort((a, b) => (b.UpdatedAt == null ? -62135596800000 : b.UpdatedAt.getTime()) - (a.UpdatedAt == null ? -62135596800000 : a.UpdatedAt.getTime()));
  return out;
};

/**
 * 查询所有处于启用状态（`enabled = 1`）的定时助手任务。
 * 供后台调度器扫描到期任务时调用。
 *
 * @returns {AssistantTask[]} 已启用的定时任务列表；查询失败时返回 `[]`。
 */
AssistantRepo.prototype.EnabledAssistantTasks = function () {
  const rows = [];
  const err = this.DB.Table("assistant_tasks").Where("enabled = ?", 1).Find(rows).Error;
  if (err != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    out.push(decodeAssistantTask(row));
  }
  return out;
};

/**
 * 在事务内创建或更新定时助手任务：校验归属权与通知绑定、填充服务端托管字段、落盘并在任务结束时投递通知。
 * 当任务从 `"running"` 结束为 `"ok"` 或 `"error"` 时，跳过通知配置重校验并按本次启动时的通知快照入队。
 *
 * @param {number} userID - 任务所属用户 ID。
 * @param {AssistantTask} v - 待保存的定时助手任务对象。
 * @returns {void} 无返回值。
 * @throws {Error} 参数非法、跨用户修改、通知绑定校验失败或数据库写入/通知入队失败时抛出错误。
 */
AssistantRepo.prototype.PutAssistantTask = function (userID, v) {
  if (userID <= 0) {
    throw new Error("assistant task user is required");
  }
  v.ID = assistantRecordID(v.ID);
  if (v.ID === "") {
    throw new Error("assistant task id is required");
  }
  const [existing, existingOK] = this.taskByID(v.ID);
  if (existingOK && existing.UserID !== userID) {
    throw new Error("assistant task belongs to another user");
  }
  this.DB.Transaction((tx) => {
    const row = new assistantTaskRow();
    let prior = new AssistantTask();
    const err = this.locking(tx).Where("id = ?", v.ID).First(row).Error;
    if (err == null) {
      prior = decodeAssistantTask(row);
      if (prior.UserID !== userID) {
        throw new Error("assistant task belongs to another user");
      }
    } else if (err !== gorm.ErrRecordNotFound) {
      throw err;
    }
    if (!(prior.LastStatus === "running" && v.LastStatus !== "running")) {
      this.notifications.validateNotificationBindings(tx, v.ProjectID, v.Notifications, true);
    }
    v = stampAssistantTask(v, prior, userID, new Date());
    let enabled = 0;
    if (v.Enabled) {
      enabled = 1;
    }
    upsert(tx, "assistant_tasks", {
      id: v.ID,
      user_id: userID,
      project_id: v.ProjectID.trim(),
      name: v.Name.trim(),
      enabled: enabled,
      interval_sec: v.IntervalSec,
      last_run_at: timePtr(v.LastRunAt),
      payload: mustJSON(v),
      created_at: timePtr(v.CreatedAt),
      updated_at: timePtr(v.UpdatedAt),
    });
    const [trigger, result, ok] = assistantTaskCompletion(prior, v);
    if (ok) {
      this.notifications.enqueueTaskNotifications(tx, "assistant_task", v.ID, v.ProjectID, v.Name, trigger, v.LastRunAt, prior.NotificationSnapshot, result, v.LastError);
    }
  });
};

/**
 * 为即将写入数据库的定时任务补全服务端托管字段。
 * 继承已有记录的 `CreatedAt`（新建时默认取 `now`），延续通知快照并在新一次运行开始时刷新快照，固定所属用户并补齐 `UpdatedAt`。
 *
 * @param {AssistantTask} v - 即将写入的任务对象。
 * @param {AssistantTask} prior - 数据库中已存在的旧任务对象（新建时为空对象）。
 * @param {number} userID - 所属用户 ID。
 * @param {Date} now - 当前服务端 UTC 时间。
 * @returns {AssistantTask} 补全服务端托管字段后的任务对象。
 */
function stampAssistantTask(v, prior, userID, now) {
  if (prior.ID !== "") {
    v.CreatedAt = prior.CreatedAt;
  } else if (v.CreatedAt == null) {
    v.CreatedAt = now;
  }
  v.NotificationSnapshot = CloneNotificationBindings(prior.NotificationSnapshot);
  const priorMs = prior.LastRunAt == null ? 0 : prior.LastRunAt.getTime();
  const vMs = v.LastRunAt == null ? 0 : v.LastRunAt.getTime();
  if (v.LastStatus === "running" && (prior.LastStatus !== "running" || priorMs !== vMs)) {
    v.NotificationSnapshot = CloneNotificationBindings(v.Notifications);
  }
  if (v.UpdatedAt == null) {
    v.UpdatedAt = now;
  }
  v.UserID = userID;
  return v;
}

/**
 * 判断将 `v` 覆写到 `prior` 是否标志着一次运行中定时任务的结束，并提取对应的通知触发类型与结果文本。
 * 用于 `PutAssistantTask` 判断是否需要触发完成通知投递。
 *
 * @param {AssistantTask} prior - 写入前的旧任务状态。
 * @param {AssistantTask} v - 本次写入的新任务状态。
 * @returns {[string, string, boolean]} 返回 `[触发事件类型, 结果文案, 是否触发完成]`；未结束时返回 `["", "", false]`。
 */
function assistantTaskCompletion(prior, v) {
  const trigger = { ok: "succeeded", error: "failed" }[v.LastStatus] ?? "";
  if (prior.ID === "" || prior.LastStatus !== "running" || trigger === "" || v.LastRunAt == null) {
    return ["", "", false];
  }
  let result = v.NotificationResult;
  if (result === "") {
    result = v.LastMessage;
  }
  return [trigger, result, true];
}

/**
 * 删除指定用户的单条定时助手任务记录。
 * 当任务不存在或不属于该用户时抛出未找到错误。
 *
 * @param {number} userID - 任务所属用户 ID。
 * @param {string} id - 待删除的定时任务 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 入参非法、任务不存在或数据库删除失败时抛出错误。
 */
AssistantRepo.prototype.DeleteAssistantTask = function (userID, id) {
  id = assistantRecordID(id);
  if (userID <= 0 || id === "") {
    throw new Error("assistant task not found");
  }
  const res = this.DB.Table("assistant_tasks").Where("id = ? AND user_id = ?", id, userID).Delete(null);
  if (res.Error != null) {
    throw res.Error;
  }
  if (res.RowsAffected === 0) {
    throw new Error("assistant task not found");
  }
};

/**
 * 按主键 ID（不限用户）读取单条助手会话记录，用于写入前检查 ID 是否已被他人占用。
 *
 * @param {string} id - 已清洗的会话 ID。
 * @returns {[AssistantSession, boolean]} 返回 `[会话实例, 是否存在]`。
 */
AssistantRepo.prototype.sessionByID = function (id) {
  const row = new assistantSessionRow();
  const err = this.DB.Table("assistant_sessions").Where("id = ?", id).Take(row).Error;
  if (err != null) {
    return [new AssistantSession(), false];
  }
  return [decodeAssistantSession(row), true];
};

/**
 * 按主键 ID（不限用户）读取单条定时助手任务记录，用于写入前检查 ID 是否已被他人占用。
 *
 * @param {string} id - 已清洗的定时任务 ID。
 * @returns {[AssistantTask, boolean]} 返回 `[定时任务实例, 是否存在]`。
 */
AssistantRepo.prototype.taskByID = function (id) {
  const row = new assistantTaskRow();
  const err = this.DB.Table("assistant_tasks").Where("id = ?", id).Take(row).Error;
  if (err != null) {
    return [new AssistantTask(), false];
  }
  return [decodeAssistantTask(row), true];
};

/**
 * 将数据库行 `assistantSessionRow` 反序列化为领域对象 `AssistantSession`，并用关系列补齐缺省元信息与参与者列表。
 * 支持完整记录与经 SQL 剥离 `messages` 后的摘要投影行：摘要行在缺少参与者缓存时会回退读取 `participantSummaryMessages`。
 *
 * @param {object} row - 从 `assistant_sessions` 表读出的 `assistantSessionRow` 行对象。
 * @returns {AssistantSession} 解码并补全默认字段后的助手会话领域对象。
 */
function decodeAssistantSession(row) {
  let parsed = {};
  try {
    parsed = JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8"));
  } catch (err) {
    // Go 忽略 JSON 解码错误，保留零值继续用表字段补齐。
  }
  const item = new AssistantSession(parsed);
  item.ExecutionTargetLocked = item.ExecutionLocked() || (parsed.executionMessageCount ?? 0) > 0;
  item.ID = row.ID;
  item.UserID = row.UserID;
  if (item.ExecutionTarget == null) {
    item.ExecutionTarget = new AssistantExecutionTarget({ Pool: ExecutionModeCloud });
  }
  if (item.RuntimeMode === "") {
    item.RuntimeMode = AssistantModePlatform;
  }
  if (item.ProjectID === "") {
    item.ProjectID = row.ProjectID;
  }
  if (item.Title === "") {
    item.Title = row.Title;
  }
  if (item.Model === "") {
    item.Model = row.Model;
  }
  if (item.Source === "") {
    item.Source = row.Source;
  }
  if (item.TaskID === "") {
    item.TaskID = row.TaskID;
  }
  if (item.CreatedAt == null && row.Created != null) {
    item.CreatedAt = row.Created;
  }
  if (row.Updated != null) {
    item.UpdatedAt = row.Updated;
  }
  if (parsed.Messages != null || parsed.messages != null) {
    deriveAssistantParticipants(item, item.Messages);
  } else if (item.ParticipantsVersion !== 1) {
    deriveAssistantParticipants(item, parsed.participantSummaryMessages ?? []);
  }
  return item;
}

/**
 * 将数据库行 `assistantTaskRow` 反序列化为领域对象 `AssistantTask`，并用关系列字段补齐缺失的基础属性与时间字段。
 *
 * @param {object} row - 从 `assistant_tasks` 表读出的 `assistantTaskRow` 行对象。
 * @returns {AssistantTask} 解码并补齐字段后的定时助手任务领域对象。
 */
function decodeAssistantTask(row) {
  let parsed = {};
  try {
    parsed = JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8"));
  } catch (err) {
    // Go 忽略 JSON 解码错误，保留零值继续用表字段补齐。
  }
  const item = new AssistantTask(parsed);
  item.ID = row.ID;
  item.UserID = row.UserID;
  if (item.ProjectID === "") {
    item.ProjectID = row.ProjectID;
  }
  if (item.Name === "") {
    item.Name = row.Name;
  }
  if (item.IntervalSec === 0) {
    item.IntervalSec = row.IntervalSec;
  }
  item.Enabled = row.Enabled === 1;
  if (item.LastRunAt == null && row.LastRunAt != null) {
    item.LastRunAt = row.LastRunAt;
  }
  if (item.CreatedAt == null && row.Created != null) {
    item.CreatedAt = row.Created;
  }
  if (row.Updated != null) {
    item.UpdatedAt = row.Updated;
  }
  return item;
}

/**
 * 检查指定项目下是否存在给定 ID 的定时助手任务。
 * 用于通知绑定、权限校验等只需判断任务存在性的场景。
 *
 * @param {string} projectID - 项目 ID。
 * @param {string} id - 定时任务 ID。
 * @returns {boolean} 若存在匹配记录返回 `true`，否则返回 `false`。
 */
AssistantRepo.prototype.AssistantTaskExists = function (projectID, id) {
  let count = 0;
  const err = this.DB.Model(new assistantTaskRow()).Where("id = ? AND project_id = ?", id, projectID).Count(count).Error;
  return err == null && count > 0;
};

module.exports = { ErrAssistantPersonalWorkspaceProject, assistantRecordID, AssistantTitleFromMessages, sortAssistantSessionRows, stampAssistantTask, assistantTaskCompletion, decodeAssistantSession, decodeAssistantTask, sleepOrAbort };
