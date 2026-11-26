// assistant_context.js —— 对应 Go 文件：internal/repo/assistant_context.go
// 作用：会话参与人推导、参与人摘要 SQL、会话关联需求。
// errors.As 译为 instanceof；Go 原生 SQL 字符串按原样保留。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause
const mysql = require("github.com/go-sql-driver/mysql"); // Go 第三方包 github.com/go-sql-driver/mysql

const { AssistantSession, AssistantParticipant } = require("../domain/assistant.js"); // 对应 Go 同包类型，assistant.js 已翻译
const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 本次一同翻译
const { assistantSessionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// summaryProjectionUnsupported reports a server that cannot parse the
// projection at all (no JSON_TABLE), as opposed to a transient failure.
function summaryProjectionUnsupported(err) {
  const sqlErr = err instanceof mysql.MySQLError ? err : null;
  if (sqlErr != null) {
    return sqlErr.Number === 1064 || sqlErr.Number === 1305;
  }
  return false;
}

// Human participants come from the transcript, never project membership or a
// caller-supplied count. Legacy private messages belong to their storage owner;
// a legacy shared message without attribution remains explicitly unknown.
function deriveAssistantParticipants(s, messages) {
  s.Participants = [];
  s.ParticipantsVersion = 1;
  s.UnknownParticipants = false;
  const seen = {};
  for (const m of messages) {
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

// Old rows have no cached summary. Project only author metadata in SQL so a
// history list never transfers message bodies, attachments, or tool output.
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

// Keep binding changes under the same row lock used by generation startup. A
// normal transcript save cannot replace this context with an older snapshot.
AssistantRepo.prototype.SetAssistantSessionIssue = function (userID, id, issueID, expected) {
  const { decodeAssistantSession, assistantRecordID } = require("./assistant.js"); // 循环引用：调用时现取，不缓存
  let saved = new AssistantSession();
  const err = this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    let err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", assistantRecordID(id), userID).Take(row).Error;
    if (err != null) {
      return new Error("会话不存在");
    }
    const s = decodeAssistantSession(row);
    if (s.Shared) {
      return new Error("共享运行会话的需求由运行决定");
    }
    const updatedMs = s.UpdatedAt == null ? 0 : s.UpdatedAt.getTime();
    const expectedMs = expected == null ? 0 : expected.getTime();
    if (updatedMs !== expectedMs) {
      return new Error("会话已更新，请重新打开后关联需求");
    }
    let active = 0;
    err = tx.Model(new assistantGenerationRow()).Where("session_id = ? AND status = ?", id, "running").Count(active).Error;
    if (err != null) {
      return err;
    }
    if (active > 0) {
      return new Error("请等待回复结束或停止生成，再关联需求");
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
      return err;
    }
    saved = s;
    return null;
  });
  if (err != null) {
    throw err;
  }
  return saved;
};

// LinkAssistantSessionIssue links an ordinary conversation without a linked
// issue to issueID. It leaves updated_at alone so a
// generation still writing the session does not conflict, and reports whether
// it linked.
AssistantRepo.prototype.LinkAssistantSessionIssue = function (userID, id, issueID) {
  const { decodeAssistantSession, assistantRecordID } = require("./assistant.js"); // 循环引用：调用时现取，不缓存
  let linked = false;
  const err = this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", assistantRecordID(id), userID).Take(row).Error;
    if (err != null) {
      return new Error("会话不存在");
    }
    const s = decodeAssistantSession(row);
    if (s.Shared || s.RunID !== "" || s.IssueID !== "") {
      return null;
    }
    s.IssueID = issueID.trim();
    linked = true;
    return tx.Model(new assistantSessionRow()).Where("id = ? AND user_id = ?", row.ID, userID).Update("payload", mustJSON(s)).Error;
  });
  if (err != null) {
    throw err;
  }
  return linked;
};

module.exports = { summaryProjectionUnsupported, deriveAssistantParticipants };
