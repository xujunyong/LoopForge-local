// assistant_proposals.js —— 对应 Go 文件：internal/repo/assistant_proposals.go
// 作用：提案写入时按版本号乐观保存，避免两个写入互相覆盖。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { decodeAssistantSession, assistantRecordID } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 本次一同翻译
const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 本次一同翻译
const { assistantSessionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// PutAssistantSessionIfUnchanged saves next only while the stored session is
// still expected and no reply is being generated, so two writers answering
// the same proposal cannot overwrite each other.
AssistantRepo.prototype.PutAssistantSessionIfUnchanged = function (userID, next, expected) {
  return this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", assistantRecordID(next.ID), userID).Take(row).Error;
    if (err != null) {
      return err;
    }
    const old = decodeAssistantSession(row);
    const a = JSON.stringify(old.Messages);
    const b = JSON.stringify(expected.Messages);
    const oldMs = old.UpdatedAt == null ? 0 : old.UpdatedAt.getTime();
    const expectedMs = expected.UpdatedAt == null ? 0 : expected.UpdatedAt.getTime();
    if (oldMs !== expectedMs || a !== b) {
      return new Error("会话已更新，请重新打开");
    }
    let active = 0;
    const countErr = tx.Model(new assistantGenerationRow()).Where("session_id = ? AND status = ?", row.ID, "running").Count(active).Error;
    if (countErr != null) {
      return countErr;
    }
    if (active > 0) {
      return new Error("生成期间不能改写会话");
    }
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    scoped.DB = tx;
    const base = { ...this.deps, DB: tx };
    scoped.deps = base;
    next.UpdatedAt = null;
    return scoped.putAssistantSession(userID, next);
  });
};

module.exports = {};
