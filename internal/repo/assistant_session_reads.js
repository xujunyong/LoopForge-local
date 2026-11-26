// assistant_session_reads.js —— 对应 Go 文件：internal/repo/assistant_session_reads.go
// 作用：记录读者已看过的最新回复，供历史列表标未读。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { assistantRecordID } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 本次一同翻译
const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 本次一同翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// ErrAssistantReplyNotFound: the conversation, as its owner holds it, has no
// reply to mark read.
const ErrAssistantReplyNotFound = new Error("对话不存在或还没有回复");

// assistantSessionReadRow is the latest reply a reader has seen in a
// conversation. The history list marks a reply that completed after it as
// unread until the reader opens the conversation, on any device.
class assistantSessionReadRow {
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.SessionID = init.SessionID ?? "";
    this.GenerationID = init.GenerationID ?? "";
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "assistant_session_reads";
  }
}

// MarkAssistantSessionRead records that the reader has seen the reply of a
// conversation owned by ownerID. Only the latest reply is recorded, so a
// stale tab reporting an older one cannot bring back a mark another tab
// cleared; it reports false and changes nothing.
AssistantRepo.prototype.MarkAssistantSessionRead = function (readerID, ownerID, sessionID, generationID) {
  sessionID = assistantRecordID(sessionID);
  generationID = generationID.trim();
  if (readerID <= 0 || ownerID <= 0 || sessionID === "" || generationID === "") {
    throw ErrAssistantReplyNotFound;
  }
  const latest = new assistantGenerationRow();
  const err = this.DB.Select("generation_id").Where("session_id = ? AND user_id = ?", sessionID, ownerID).Take(latest).Error;
  if (err === gorm.ErrRecordNotFound) {
    throw ErrAssistantReplyNotFound;
  }
  if (err != null) {
    throw err;
  }
  if (latest.GenerationID !== generationID) {
    return false;
  }
  const row = new assistantSessionReadRow({ UserID: readerID, SessionID: sessionID, GenerationID: generationID, Updated: new Date() });
  const upsertErr = this.DB.Clauses(new clause.OnConflict({
    Columns: [new clause.Column({ Name: "user_id" }), new clause.Column({ Name: "session_id" })],
    DoUpdates: clause.AssignmentColumns(["generation_id", "updated_at"]),
  })).Create(row).Error;
  if (upsertErr != null) {
    throw upsertErr;
  }
  return true;
};

module.exports = { ErrAssistantReplyNotFound, assistantSessionReadRow };
