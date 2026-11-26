// assistant_sandbox.js —— 对应 Go 文件：internal/repo/assistant_sandbox.go
// 作用：切换会话的运行环境（沙箱），生成期间不允许切换。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { decodeAssistantSession, assistantRecordID } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 本次一同翻译
const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 本次一同翻译
const { assistantSessionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// SetAssistantSessionSandbox uses the same session → generation lock order as
// BeginAssistantGeneration, so a selection cannot race workspace creation.
AssistantRepo.prototype.SetAssistantSessionSandbox = function (userID, id, sandboxID) {
  return this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    let err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", assistantRecordID(id), userID).Take(row).Error;
    if (err != null) {
      return new Error("会话不存在");
    }
    const s = decodeAssistantSession(row);
    if (s.Shared || s.RunID !== "") {
      return new Error("任务会话使用任务的运行环境，不能切换");
    }
    const generation = new assistantGenerationRow();
    err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ?", row.ID).Take(generation).Error;
    if (err != null && err !== gorm.ErrRecordNotFound) {
      return err;
    }
    if (err == null && generation.Status === "running") {
      return new Error("生成期间不能切换运行环境");
    }
    s.SandboxProfileID = sandboxID.trim();
    return tx.Model(new assistantSessionRow()).Where("id = ? AND user_id = ?", row.ID, userID).Update("payload", mustJSON(s)).Error;
  });
};

module.exports = {};
