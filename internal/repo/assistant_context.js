/**
 * @file internal/repo/assistant_context.js
 * 对应 Go 源文件：internal/repo/assistant_context.go
 *
 * 作用与职责边界：
 * 负责会话参与者推导、兼容 SQLite/MySQL 的参与者 SQL 摘要投影表达式生成、数据库投影能力判定，
 * 以及在行锁事务下修改或补绑会话关联的需求 ID（`IssueID`）。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 统一按成功返回值、失败 `throw err` 处理；`db.Transaction` 回调同样失败抛错、成功正常返回。
 * - Go 的 `errors.As` 译为 `instanceof`；原生 SQL 片段保持原样。
 * - Go 的 `map[int64]bool` 在此处以普通对象 `{}` 去重记录正整数用户 ID。
 */

"use strict";

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause
const mysql = require("github.com/go-sql-driver/mysql"); // Go 第三方包 github.com/go-sql-driver/mysql

const { AssistantSession, AssistantParticipant } = require("../domain/assistant.js"); // 对应 Go 同包类型，assistant.js 已翻译
const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 本次一同翻译
const { assistantSessionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

/**
 * 判断数据库错误是否属于服务端根本无法解析 JSON 投影语法（例如缺少 `JSON_TABLE`，对应 MySQL 1064/1305 错误码）。
 * 用于区分永久性的方言不支持与瞬时数据库故障，决定是否永久启用降级路径。
 *
 * @param {any} err - 数据库查询返回的错误对象。
 * @returns {boolean} 若为 MySQL 1064（语法错误）或 1305（函数不存在）返回 `true`，否则返回 `false`。
 */
function summaryProjectionUnsupported(err) {
  const sqlErr = err instanceof mysql.MySQLError ? err : null;
  if (sqlErr != null) {
    return sqlErr.Number === 1064 || sqlErr.Number === 1305;
  }
  return false;
}

/**
 * 依据真实对话消息列表推导会话的人类参与者列表并原地写入会话对象。
 * 忽略非用户消息、系统触发消息与草稿确认回执消息；历史私有消息缺失作者时归属存储所有者，共享会话缺失作者则标记 `UnknownParticipants`。
 *
 * @param {AssistantSession} s - 待原地填充 `Participants`、`ParticipantsVersion`、`UnknownParticipants` 的会话对象。
 * @param {object[]|null} messages - 对话消息列表（`domain.AssistantMessage[]`）。
 * @returns {void} 无返回值。
 */
function deriveAssistantParticipants(s, messages) {
  s.Participants = [];
  s.ParticipantsVersion = 1;
  s.UnknownParticipants = false;
  const seen = {};
  for (const m of messages ?? []) {
    if (m.Role !== "user" || m.Trigger !== "" || (m.Content.startsWith("已确认并执行 ") && m.Content.includes("请核对这条草稿的保存回执，继续完成原始请求"))) {
      continue;
    }
    let id = m.AuthorID;
    if (id === 0 && !s.Shared) {
      id = s.UserID;
    }
    if (id <= 0) {
      s.UnknownParticipants = true;
      continue;
    }
    if (!seen[id]) {
      s.Participants.push(new AssistantParticipant({ ID: id, Name: m.AuthorName }));
      seen[id] = true;
    }
  }
}

/**
 * 按当前数据库方言生成仅提取用户消息作者元数据的 SQL 表达式，用于尚未缓存参与者摘要的旧会话行。
 * 在数据库端过滤掉消息正文、附件和工具输出，减少列表接口的网络传输量。
 *
 * @returns {string} 适用于 SQLite 或 MySQL 8+ 的 JSON 投影子查询 SQL 文本。
 */
AssistantRepo.prototype.assistantParticipantSummarySQL = function () {
  if (this.DB.Dialector.Name() === "sqlite") {
    return `CASE WHEN json_extract(payload, '$.participantsVersion') = 1 THEN '[]' ELSE
   (SELECT json_group_array(json_object('role','user','authorId',json_extract(m.value,'$.authorId'),'authorName',json_extract(m.value,'$.authorName')))
    FROM json_each(payload,'$.messages') m WHERE json_extract(m.value,'$.role')='user'
    AND COALESCE(json_extract(m.value,'$.trigger'),'')=''
    AND COALESCE(json_extract(m.value,'$.content'),'') NOT LIKE '已确认并执行 %请核对这条草稿的保存回执，继续完成原始请求%') END`;
  }
  return `CASE WHEN JSON_EXTRACT(payload, '$.participantsVersion') = 1 THEN '[]' ELSE
  (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('role','user','authorId',m.author_id,'authorName',m.author_name)),JSON_ARRAY())
   FROM JSON_TABLE(payload,'$.messages[*]' COLUMNS (role VARCHAR(32) PATH '$.role', author_id BIGINT PATH '$.authorId', author_name VARCHAR(255) PATH '$.authorName', message_trigger VARCHAR(64) PATH '$.trigger', content LONGTEXT PATH '$.content')) m
   WHERE m.role='user' AND COALESCE(m.message_trigger,'')='' AND COALESCE(m.content,'') NOT LIKE '已确认并执行 %请核对这条草稿的保存回执，继续完成原始请求%') END`;
};

/**
 * 在与生成启动相同的行锁下更新会话绑定的需求 ID，校验乐观锁时间戳且确认无运行中生成。
 * 成功时会递增 `HistoryRevision` 并推进 `UpdatedAt`，防止旧快照覆盖上下文绑定变更。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} id - 会话 ID。
 * @param {string} issueID - 目标关联需求 ID（传空串表示解除关联）。
 * @param {Date|null} expected - 客户端持有的预期会话更新时间，用于并发冲突检测。
 * @returns {AssistantSession} 保存成功后的最新会话对象。
 * @throws {Error} 会话不存在、属于共享运行会话、版本过期、存在运行中生成或数据库更新失败时抛出错误。
 */
AssistantRepo.prototype.SetAssistantSessionIssue = function (userID, id, issueID, expected) {
  const { decodeAssistantSession, assistantRecordID } = require("./assistant.js"); // 循环引用：调用时现取，不缓存
  let saved = new AssistantSession();
  this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    let err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", assistantRecordID(id), userID).Take(row).Error;
    if (err != null) {
      throw new Error("会话不存在");
    }
    const s = decodeAssistantSession(row);
    if (s.Shared) {
      throw new Error("共享运行会话的需求由运行决定");
    }
    const updatedMs = s.UpdatedAt == null ? 0 : s.UpdatedAt.getTime();
    const expectedMs = expected == null ? 0 : expected.getTime();
    if (updatedMs !== expectedMs) {
      throw new Error("会话已更新，请重新打开后关联需求");
    }
    let active = 0;
    err = tx.Model(new assistantGenerationRow()).Where("session_id = ? AND status = ?", id, "running").Count(active).Error;
    if (err != null) {
      throw err;
    }
    if (active > 0) {
      throw new Error("请等待回复结束或停止生成，再关联需求");
    }
    s.IssueID = issueID.trim();
    s.HistoryRevision++;
    s.UpdatedAt = new Date();
    if (row.Updated != null && !(s.UpdatedAt.getTime() > row.Updated.getTime())) {
      s.UpdatedAt = new Date(row.Updated.getTime() + 1);
    }
    deriveAssistantParticipants(s, s.Messages);
    err = tx.Model(new assistantSessionRow()).Where("id = ? AND user_id = ?", s.ID, userID).Updates({ payload: mustJSON(s), updated_at: s.UpdatedAt }).Error;
    if (err != null) {
      throw err;
    }
    saved = s;
  });
  return saved;
};

/**
 * 为尚未绑定需求的普通个人会话自动补绑需求 ID，不修改 `updated_at` 以避免与正在写入的生成发生冲突。
 * 若会话为共享会话、任务运行会话或已关联其他需求，则静默跳过并返回 `false`。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} id - 会话 ID。
 * @param {string} issueID - 要补绑的需求 ID。
 * @returns {boolean} 实际完成绑定时返回 `true`，因已有绑定或类型不符跳过时返回 `false`。
 * @throws {Error} 会话不存在或数据库更新失败时抛出错误。
 */
AssistantRepo.prototype.LinkAssistantSessionIssue = function (userID, id, issueID) {
  const { decodeAssistantSession, assistantRecordID } = require("./assistant.js"); // 循环引用：调用时现取，不缓存
  let linked = false;
  this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", assistantRecordID(id), userID).Take(row).Error;
    if (err != null) {
      throw new Error("会话不存在");
    }
    const s = decodeAssistantSession(row);
    if (s.Shared || s.RunID !== "" || s.IssueID !== "") {
      return;
    }
    s.IssueID = issueID.trim();
    linked = true;
    const updateErr = tx.Model(new assistantSessionRow()).Where("id = ? AND user_id = ?", row.ID, userID).Update("payload", mustJSON(s)).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
  return linked;
};

module.exports = { summaryProjectionUnsupported, deriveAssistantParticipants };
