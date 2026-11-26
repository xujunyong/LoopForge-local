/**
 * @file internal/repo/assistant_shared.js
 * 对应 Go 源文件：internal/repo/assistant_shared.go
 *
 * 作用与职责边界：
 * 负责 SOP 运行共享会话与项目共享会话的 ID 推导、首次创建与历史消息合并、
 * 摘要列表查询、元数据投影读取，以及带行锁与乐观版本校验的回执保存、会话分支创建与历史轮次改写。
 * 不负责普通个人会话的通用读写与流式生成状态机（分别位于同包其他文件中）。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；`db.Transaction` 回调同样失败抛错、成功正常返回。
 * - Go 的 `(值, bool)` 与 `(shared, project []domain.AssistantSession)` 多值无错返回译为二元组 `[值1, 值2]`。
 * - Go 的 `time.Time` 零值译为 `null`，比较相等时按 Go 零值时间毫秒数 `-62135596800000` 折算，与 `time.Time.Equal` 保持一致。
 * - Go 的结构体值拷贝（如消息遍历与事务作用域接收者）在 JS 中通过对象浅拷贝和原型克隆保持一致语义。
 */

"use strict";

const { createHash } = require("node:crypto");

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { AssistantSession, AssistantSourceSOP, AssistantSourceSOPDesigner } = require("../domain/assistant.js"); // 对应 Go 同包类型与常量，assistant.js 已翻译
const { decodeAssistantSession, assistantRecordID } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 已翻译
const { deriveAssistantParticipants } = require("./assistant_context.js"); // 对应 Go 同包函数，assistant_context.js 已翻译
const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 已翻译
const { assistantSessionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

/**
 * 根据 SOP 运行 ID 确定性生成对应的共享助手会话 ID（形如 `"sop-<40位十六进制>"`）。
 * 用于为同一运行的所有参与者定位或初始化唯一的根共享会话。
 *
 * @param {string} runID - SOP 运行记录 ID。
 * @returns {string} 以 `"sop-"` 为前缀、后接 SHA-256 前 20 字节十六进制编码的共享会话 ID。
 */
function RunAssistantSessionID(runID) {
  const sum = createHash("sha256").update(runID, "utf8").digest();
  return "sop-" + sum.subarray(0, 20).toString("hex");
}

/**
 * 按会话 ID 读取单条有效的 SOP 共享会话（包含主会话或合法派生分支）。
 * 用于访问共享会话前校验记录存在性及共享归属规则。
 *
 * @param {string} id - 共享会话 ID。
 * @returns {[AssistantSession, boolean]} 返回 `[会话实例, 是否有效]`；未找到或不满足共享规则时返回 `[空会话实例, false]`。
 */
AssistantRepo.prototype.SharedAssistantSession = function (id) {
  const row = new assistantSessionRow();
  if (this.DB.Where("id = ?", id).Take(row).Error != null) {
    return [new AssistantSession(), false];
  }
  const item = decodeAssistantSession(row);
  return [item, validSharedAssistantSession(item)];
};

/**
 * 获取或幂等创建指定 SOP 运行对应的根共享会话。
 * 若共享会话尚不存在，会合并该项目下同运行的历史私有讨论消息并补齐作者署名；
 * 仅当不存在历史讨论且传入了运行冻结执行目标时继承该执行目标。
 *
 * @param {string} runID - SOP 运行记录 ID。
 * @param {string} projectID - 所属项目 ID。
 * @param {string} title - 共享会话初始标题。
 * @param {number} userID - 触发创建的用户 ID（作为新共享会话的初始所有者）。
 * @param {...object} execution - 可选的运行执行目标（最多使用首个元素 `domain.AssistantExecutionTarget`）。
 * @returns {AssistantSession} 已存在或新创建的共享会话对象。
 * @throws {Error} 历史消息查询失败、写入冲突外错误或写后无法读回共享会话时抛出错误。
 */
AssistantRepo.prototype.EnsureRunAssistantSession = function (runID, projectID, title, userID, ...execution) {
  const id = RunAssistantSessionID(runID);
  const [item, ok] = this.SharedAssistantSession(id);
  if (ok) {
    return item;
  }
  const now = new Date();
  // Go 的 AssistantSession{...} 结构体字面量，JS 用构造器传同名字段。
  const session = new AssistantSession({ ID: id, RunID: runID, ProjectID: projectID, Title: title, UserID: userID, Shared: true, Source: AssistantSourceSOP, CreatedAt: now, UpdatedAt: now });
  // 将同一运行的既有讨论消息合并为共享会话的初始记录，并保留原作者信息。
  const rows = [];
  const err = this.DB.Where("project_id = ?", projectID).Where(this.sqlJSONText("$.runId") + " = ?", "$.runId", runID).Order("created_at ASC").Find(rows).Error;
  if (err != null) {
    throw err;
  }
  for (const row of rows) {
    const old = decodeAssistantSession(row);
    if (old.RunID !== runID || old.Shared) {
      continue;
    }
    for (let message of old.Messages ?? []) {
      // Go 的 range 变量是值拷贝，JS 用展开复制保持一致。
      message = { ...message };
      if (message.Role === "user" && message.AuthorID === 0) {
        message.AuthorID = old.UserID;
        message.AuthorName = `用户 ${old.UserID}`;
        const [u, found] = this.users.User(old.UserID);
        if (found) {
          message.AuthorName = u.LoginName;
        }
      }
      session.Messages.push(message);
    }
  }
  // 历史讨论继续沿用云端绑定；只有全新打开的运行会话才继承运行已冻结的执行目标。
  if (rows.length === 0 && execution.length > 0) {
    const target = execution[0];
    session.ExecutionTarget = target;
  }
  deriveAssistantParticipants(session, session.Messages);
  const row = new assistantSessionRow({ ID: id, UserID: userID, ProjectID: projectID, Title: title, Source: session.Source, TaskID: session.TaskID, Payload: mustJSON(session), Created: now, Updated: now });
  const createErr = this.DB.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
  if (createErr != null) {
    throw createErr;
  }
  const [saved, savedOk] = this.SharedAssistantSession(id);
  if (!savedOk) {
    throw new Error("shared session unavailable");
  }
  return saved;
};

/**
 * 查询全部有效的 SOP 共享会话摘要列表（剥离完整对话正文 `Messages`）。
 * 用于展示跨用户的运行共享会话列表；底层查询失败时记录日志并返回 `null`。
 *
 * @returns {AssistantSession[]|null} 有效的共享会话摘要数组；查询失败时返回 `null`。
 */
AssistantRepo.prototype.ListSharedAssistantSessions = function () {
  let rows;
  try {
    rows = this.findAssistantSessionSummaries("id LIKE ?", "sop-%");
  } catch (err) {
    console.log(`shared assistant session list failed: ${err}`);
    return null;
  }
  const out = [];
  for (const row of rows) {
    const item = decodeAssistantSession(row);
    if (validSharedAssistantSession(item)) {
      item.Messages = null;
      out.push(item);
    }
  }
  return out;
};

/**
 * 通过单次查询同时返回 SOP 共享会话与其他用户创建的项目共享会话摘要。
 * 供 HTTP 层结合项目成员权限进行过滤展示；查询失败时记录日志并返回 `[null, null]`。
 *
 * @param {number} excludeUserID - 当前访问用户的 ID，用于排除自己创建的项目会话。
 * @returns {[AssistantSession[]|null, AssistantSession[]|null]} 返回二元组 `[SOP共享会话列表, 其他用户的项目共享会话列表]`。
 */
AssistantRepo.prototype.ListCrossUserAssistantSessions = function (excludeUserID) {
  let rows;
  try {
    rows = this.findAssistantSessionSummaries("id LIKE ? OR (user_id <> ? AND project_id <> ?)", "sop-%", excludeUserID, "");
  } catch (err) {
    console.log(`cross-user assistant session list failed: ${err}`);
    return [null, null];
  }
  const shared = [];
  const project = [];
  for (const row of rows) {
    const item = decodeAssistantSession(row);
    item.Messages = null;
    if (item.ID.startsWith("sop-")) {
      if (validSharedAssistantSession(item)) {
        shared.push(item);
      }
    } else if (item.UserID !== excludeUserID && ProjectSharedAssistantSession(item)) {
      project.push(item);
    }
  }
  return [shared, project];
};

/**
 * 在行锁事务中保存共享会话或项目共享会话的草稿确认回执更新。
 * 写入前校验共享属性、期望的 `UpdatedAt`、消息快照一致性及不存在运行中的回复生成。
 *
 * @param {number} userID - 会话存储所有者用户 ID。
 * @param {AssistantSession} next - 准备写回的更新后会话对象。
 * @param {AssistantSession} expected - 调用方读取到的期望旧会话快照（用于并发冲突校验）。
 * @returns {void} 无返回值。
 * @throws {Error} 会话不存在、已被并发修改、存在运行中生成或数据库写入失败时抛出错误。
 */
AssistantRepo.prototype.PutSharedAssistantReceipt = function (userID, next, expected) {
  this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const takeErr = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", next.ID, userID).Take(row).Error;
    if (takeErr != null) {
      throw takeErr;
    }
    const old = decodeAssistantSession(row);
    const a = JSON.stringify(old.Messages);
    const b = JSON.stringify(expected.Messages);
    const oldMs = old.UpdatedAt == null ? -62135596800000 : old.UpdatedAt.getTime();
    const expectedMs = expected.UpdatedAt == null ? -62135596800000 : expected.UpdatedAt.getTime();
    if (!(old.Shared || ProjectSharedAssistantSession(old)) || oldMs !== expectedMs || a !== b) {
      throw new Error("共享会话已更新，请重新打开");
    }
    let active = 0;
    const countErr = tx.Model(new assistantGenerationRow()).Where("session_id = ? AND status = ?", next.ID, "running").Count(active).Error;
    if (countErr != null) {
      throw countErr;
    }
    if (active > 0) {
      throw new Error("生成期间不能改写会话");
    }
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    scoped.DB = tx;
    const base = { ...this.deps, DB: tx };
    scoped.deps = base;
    next.UpdatedAt = null;
    scoped.putAssistantSession(userID, next);
  });
};

/**
 * 判断会话对象是否为合法的 SOP 运行共享会话（根共享会话或其派生分支）。
 * 供读取与列表过滤共享会话时调用。
 *
 * @param {AssistantSession} s - 待校验的助手会话对象。
 * @returns {boolean} 符合 SOP 共享会话结构规则时返回 `true`，否则返回 `false`。
 */
function validSharedAssistantSession(s) {
  const root = RunAssistantSessionID(s.RunID);
  return s.Shared && s.RunID !== "" && (s.ID === root || (s.ParentSessionID !== "" && s.RootSessionID === root && s.ID.startsWith("sop-branch-")));
}

/**
 * 判断普通会话是否属于面向项目成员共享的对话。
 * SOP 运行会话遵循独立规则，历史私有运行讨论与 SOP 设计器画布会话均保持创建者私有。
 *
 * @param {AssistantSession} s - 待判断的助手会话对象。
 * @returns {boolean} 属于项目共享会话返回 `true`，否则返回 `false`。
 */
function ProjectSharedAssistantSession(s) {
  return !s.Shared && s.RunID === "" && s.ProjectID.trim() !== "" && !s.ID.startsWith("sop-") && s.Source !== AssistantSourceSOPDesigner;
}

// 仅查询助手会话元数据时使用的 SQL 列投影（在数据库端移除 `$.messages` 避免传输完整对话正文）。
const assistantSessionMetadataColumns = "id, user_id, project_id, title, model, source, task_id, created_at, updated_at, JSON_REMOVE(payload, '$.messages') AS payload";

/**
 * 按会话 ID 读取任意创建者的项目共享会话元数据（不含消息正文）。
 * 调用方在返回数据或执行写入前必须自行完成所属项目的成员权限校验。
 *
 * @param {string} id - 会话 ID。
 * @returns {[AssistantSession, boolean]} 返回 `[会话元数据实例, 是否为有效项目共享会话]`；非法或未找到时返回 `[空会话实例, false]`。
 */
AssistantRepo.prototype.ProjectAssistantSession = function (id) {
  id = assistantRecordID(id);
  if (id === "" || id.startsWith("sop-")) {
    return [new AssistantSession(), false];
  }
  const row = new assistantSessionRow();
  if (this.DB.Table("assistant_sessions").Select(assistantSessionMetadataColumns).Where("id = ?", id).Take(row).Error != null) {
    return [new AssistantSession(), false];
  }
  const item = decodeAssistantSession(row);
  return [item, ProjectSharedAssistantSession(item)];
};

/**
 * 在原会话的生成行锁下冻结原会话状态并创建新分支会话，分支写入不会覆盖原会话。
 * 校验原会话更新时间一致且当前无运行中生成后，继承原会话的执行目标并持久化分支。
 *
 * @param {AssistantSession} source - 作为分叉起点的原会话快照。
 * @param {AssistantSession} branch - 待创建的新分支会话对象。
 * @returns {void} 无返回值。
 * @throws {Error} 原会话不存在、已发生更新、正在生成中或保存分支失败时抛出错误。
 */
AssistantRepo.prototype.CreateAssistantSessionBranch = function (source, branch) {
  this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const takeErr = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", source.ID, source.UserID).Take(row).Error;
    if (takeErr != null) {
      throw takeErr;
    }
    const old = decodeAssistantSession(row);
    const oldMs = old.UpdatedAt == null ? -62135596800000 : old.UpdatedAt.getTime();
    const sourceMs = source.UpdatedAt == null ? -62135596800000 : source.UpdatedAt.getTime();
    if (oldMs !== sourceMs) {
      throw new Error("原会话已更新，请重新打开后编辑");
    }
    let active = 0;
    const countErr = tx.Model(new assistantGenerationRow()).Where("session_id = ? AND status = ?", source.ID, "running").Count(active).Error;
    if (countErr != null) {
      throw countErr;
    }
    if (active > 0) {
      throw new Error("请先停止原会话的生成，再创建分支");
    }
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    scoped.DB = tx;
    const base = { ...this.deps, DB: tx };
    scoped.deps = base;
    const target = old.Execution();
    branch.ExecutionTarget = target;
    scoped.putAssistantSession(branch.UserID, branch);
  });
};

/**
 * 在与生成启动相同的行锁下改写指定下标的用户消息轮次并截断其后的历史消息。
 * 当传入可选主会话 `target` 时，允许将合法共享分支的改写结果覆盖回根共享主会话，并递增 `HistoryRevision`。
 *
 * @param {AssistantSession} source - 待编辑轮次的源会话快照。
 * @param {number} index - 要替换的用户消息在消息列表中的 0 基下标。
 * @param {object} edited - 编辑后的新用户消息对象（`domain.AssistantMessage`）。
 * @param {...AssistantSession} target - 可选的根共享主会话快照（传值时表示从共享分支覆盖主会话）。
 * @returns {void} 无返回值。
 * @throws {Error} 会话已更新、下标非用户消息、存在运行中生成、无权覆盖主会话或数据库更新失败时抛出错误。
 */
AssistantRepo.prototype.ReplaceAssistantTurn = function (source, index, edited, ...target) {
  this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const takeErr = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", source.ID, source.UserID).Take(row).Error;
    if (takeErr != null) {
      throw takeErr;
    }
    let old = decodeAssistantSession(row);
    const oldMs = old.UpdatedAt == null ? -62135596800000 : old.UpdatedAt.getTime();
    const sourceMs = source.UpdatedAt == null ? -62135596800000 : source.UpdatedAt.getTime();
    if (oldMs !== sourceMs) {
      throw new Error("会话已更新，请重新打开后编辑");
    }
    if (index < 0 || index >= old.Messages.length || old.Messages[index].Role !== "user") {
      throw new Error("请选择用户消息");
    }
    let active = 0;
    const countErr = tx.Model(new assistantGenerationRow()).Where("session_id = ? AND status = ?", source.ID, "running").Count(active).Error;
    if (countErr != null) {
      throw countErr;
    }
    if (active > 0) {
      throw new Error("请先停止生成再编辑消息");
    }
    if (old.ParentSessionID !== "" && old.Executor === "") {
      old.Executor = source.Executor;
    }
    const prefix = [...old.Messages.slice(0, index)];
    if (target.length > 0) {
      if (!source.Shared || source.RunID !== target[0].RunID || source.RootSessionID !== target[0].ID) {
        throw new Error("无权覆盖主会话");
      }
      const main = new assistantSessionRow();
      const mainTakeErr = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", target[0].ID, target[0].UserID).Take(main).Error;
      if (mainTakeErr != null) {
        throw mainTakeErr;
      }
      old = decodeAssistantSession(main);
      const mainOldMs = old.UpdatedAt == null ? -62135596800000 : old.UpdatedAt.getTime();
      const targetMs = target[0].UpdatedAt == null ? -62135596800000 : target[0].UpdatedAt.getTime();
      if (mainOldMs !== targetMs) {
        throw new Error("主会话已更新，请重新打开");
      }
      const mainCountErr = tx.Model(new assistantGenerationRow()).Where("session_id = ? AND status = ?", old.ID, "running").Count(active).Error;
      if (mainCountErr != null) {
        throw mainCountErr;
      }
      if (active > 0) {
        throw new Error("请先停止主会话生成");
      }
    }
    old.Messages = [...prefix, edited];
    old.UpdatedAt = null;
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    scoped.DB = tx;
    const base = { ...this.deps, DB: tx };
    scoped.deps = base;
    scoped.putAssistantSession(old.UserID, old);
    const [saved, savedOk] = scoped.AssistantSession(old.UserID, old.ID);
    if (!savedOk) {
      throw new Error("无法读取更新后的会话");
    }
    saved.HistoryRevision++;
    const updateErr = tx.Model(new assistantSessionRow()).Where("id = ? AND user_id = ?", saved.ID, saved.UserID).Update("payload", mustJSON(saved)).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
};

module.exports = { RunAssistantSessionID, ProjectSharedAssistantSession, assistantSessionMetadataColumns };
