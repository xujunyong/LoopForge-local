// assistant_execution.js —— 对应 Go 文件：internal/repo/assistant_execution.go
// 作用：会话执行模式切换与执行机器锁定错误。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { AssistantModePlatform, AssistantModeWorkspace } = require("../domain/assistant.js"); // 对应 Go 同包常量，assistant.js 已翻译
const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 本次一同翻译
const { assistantSessionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

const ErrAssistantSessionProjectChanged = new Error("会话项目已变更，请重新打开会话");

const ErrAssistantExecutionLocked = new Error("会话执行机器已固定，不能更换；请新建对话");

// SetAssistantRuntimeMode changes only the execution mode. The retained
// workspace and execution target survive returning to platform mode.
AssistantRepo.prototype.SetAssistantRuntimeMode = function (userID, id, projectID, mode, ...generationID) {
  const { decodeAssistantSession, assistantRecordID } = require("./assistant.js"); // 循环引用：调用时现取，不缓存
  if (mode !== AssistantModePlatform && mode !== AssistantModeWorkspace) {
    return new Error("无效的会话模式");
  }
  return this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    let err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", assistantRecordID(id), userID).Take(row).Error;
    if (err != null) {
      return err;
    }
    const item = decodeAssistantSession(row);
    const active = new assistantGenerationRow();
    err = tx.Where("session_id = ? AND status = ?", row.ID, "running").Take(active).Error;
    if (err != null && err !== gorm.ErrRecordNotFound) {
      return err;
    }
    if (err == null && (generationID.length === 0 || generationID[0] === "" || active.GenerationID !== generationID[0] || active.CancelRequested)) {
      return new Error("请先停止当前生成再切换模式");
    }
    if (item.ProjectID.trim() !== projectID.trim()) {
      return ErrAssistantSessionProjectChanged;
    }
    if (mode === AssistantModeWorkspace && item.WorkspaceRunID === "" && item.RunID === "") {
      return new Error("请先打开工作区");
    }
    item.RuntimeMode = mode;
    return tx.Model(new assistantSessionRow()).Where("id = ? AND user_id = ?", row.ID, userID).Update("payload", mustJSON(item)).Error;
  });
};

module.exports = { ErrAssistantSessionProjectChanged, ErrAssistantExecutionLocked };
