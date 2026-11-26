// assistant_generation_reply.js —— 对应 Go 文件：internal/repo/assistant_generation_reply.go
// 作用：提交一轮生成的回复 transcript，含未完成回复的追加。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { decodeAssistantSession } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 本次一同翻译
const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 本次一同翻译
const { assistantSessionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// Only the current writer can commit a shared reply. A stale process must not
// overwrite a pending turn after its generation has been cancelled or replaced.
AssistantRepo.prototype.PutAssistantGenerationReply = function (ownerID, generationID, next) {
  return this.commitGenerationTranscript(ownerID, generationID, next, false);
};

// CommitAssistantTranscript records a stopped or redirected turn. The owning
// generation may already have been asked to cancel, and still has to keep the
// text written before that request.
AssistantRepo.prototype.CommitAssistantTranscript = function (ownerID, generationID, next) {
  return this.commitGenerationTranscript(ownerID, generationID, next, true);
};

AssistantRepo.prototype.commitGenerationTranscript = function (ownerID, generationID, next, allowStopped) {
  return this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    let err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", next.ID, ownerID).Take(row).Error;
    if (err != null) {
      return err;
    }
    const generation = new assistantGenerationRow();
    err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ? AND user_id = ?", next.ID, ownerID).Take(generation).Error;
    if (err != null) {
      return err;
    }
    if (generation.GenerationID !== generationID || generation.Status !== "running" || (!allowStopped && generation.CancelRequested)) {
      return new Error("会话生成已取消或被替代，不能保存旧回复");
    }
    const old = decodeAssistantSession(row);
    if (next.Messages.length < old.Messages.length) {
      return new Error("会话已更新，请重新打开");
    }
    for (let i = 0; i < old.Messages.length; i++) {
      const a = JSON.stringify(old.Messages[i]);
      const b = JSON.stringify(next.Messages[i]);
      if (a !== b) {
        return new Error("会话已更新，请重新打开");
      }
    }
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    scoped.DB = tx;
    const base = { ...this.deps, DB: tx };
    scoped.deps = base;
    return scoped.putAssistantSession(ownerID, next);
  });
};

// AppendUnfinishedAssistantReply keeps the trace and partial answer of a turn
// that ended without a reply. It writes only while this generation still owns
// the session and the transcript still ends at the question it answered, so a
// retried call, a newer turn or an edited transcript never gets a stray reply.
AssistantRepo.prototype.AppendUnfinishedAssistantReply = function (ownerID, sessionID, generationID, messageCount, message) {
  if (messageCount <= 0 || generationID === "") {
    return false;
  }
  let appended = false;
  const err = this.DB.Transaction((tx) => {
    const generation = new assistantGenerationRow();
    let err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ? AND user_id = ?", sessionID, ownerID).Take(generation).Error;
    if (err != null) {
      return err;
    }
    if (generation.GenerationID !== generationID) {
      return null;
    }
    const row = new assistantSessionRow();
    err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", sessionID, ownerID).Take(row).Error;
    if (err != null) {
      return err;
    }
    const session = decodeAssistantSession(row);
    if (session.Messages.length !== messageCount || session.Messages[messageCount - 1].Role !== "user") {
      return null;
    }
    session.Messages.push(message);
    session.UpdatedAt = null;
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    scoped.DB = tx;
    const base = { ...this.deps, DB: tx };
    scoped.deps = base;
    err = scoped.putAssistantSession(ownerID, session);
    if (err != null) {
      return err;
    }
    appended = true;
    return null;
  });
  if (err != null) {
    throw err;
  }
  return appended;
};

module.exports = {};
