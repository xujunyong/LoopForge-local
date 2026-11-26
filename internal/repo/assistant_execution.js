/**
 * @file internal/repo/assistant_execution.js
 * 对应 Go 源文件：internal/repo/assistant_execution.go
 *
 * 作用与职责边界：
 * 定义会话项目变更与执行机器锁定两类领域错误常量，并提供在行锁事务内安全切换会话运行模式（平台模式/工作区模式）的方法。
 * 切换模式时保留已绑定的工作区与执行目标，不清空历史工作区状态。
 *
 * 语法差异说明：
 * - Go 仅返回 `error` 的方法统一按成功无返回值（`undefined`）、失败 `throw err` 处理；`db.Transaction` 回调同样失败抛错、成功正常返回。
 * - Go 的 `errors.Is` 译为 `===`，可变参数 `generationID ...string` 译为剩余参数 `...generationID`。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { AssistantModePlatform, AssistantModeWorkspace } = require("../domain/assistant.js"); // 对应 Go 同包常量，assistant.js 已翻译
const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 本次一同翻译
const { assistantSessionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// 会话归属项目与请求预期不一致时抛出的错误。
const ErrAssistantSessionProjectChanged = new Error("会话项目已变更，请重新打开会话");

// 会话执行机器已锁定后试图切换执行目标时抛出的错误。
const ErrAssistantExecutionLocked = new Error("会话执行机器已固定，不能更换；请新建对话");

/**
 * 在行锁事务中仅修改会话的运行模式（`"platform"` 或 `"workspace"`），同时保留原有工作区与执行目标配置。
 * 切换前校验当前是否允许变更：存在其他运行中生成或当前生成已请求取消时拒绝切换；切入工作区模式时要求已绑定工作区或任务运行。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} id - 会话 ID。
 * @param {string} projectID - 期望的会话所属项目 ID。
 * @param {string} mode - 目标运行模式（`AssistantModePlatform` 或 `AssistantModeWorkspace`）。
 * @param {...string} generationID - 可选的当前发起切换的生成轮次 ID（用于在自身运行中的生成内部合法切换模式）。
 * @returns {void} 无返回值。
 * @throws {Error} 模式非法、会话不存在、存在冲突的运行中生成、项目已变更、未打开工作区或数据库更新失败时抛出错误。
 */
AssistantRepo.prototype.SetAssistantRuntimeMode = function (userID, id, projectID, mode, ...generationID) {
  const { decodeAssistantSession, assistantRecordID } = require("./assistant.js"); // 循环引用：调用时现取，不缓存
  if (mode !== AssistantModePlatform && mode !== AssistantModeWorkspace) {
    throw new Error("无效的会话模式");
  }
  this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    let err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", assistantRecordID(id), userID).Take(row).Error;
    if (err != null) {
      throw err;
    }
    const item = decodeAssistantSession(row);
    const active = new assistantGenerationRow();
    err = tx.Where("session_id = ? AND status = ?", row.ID, "running").Take(active).Error;
    if (err != null && err !== gorm.ErrRecordNotFound) {
      throw err;
    }
    if (err == null && (generationID.length === 0 || generationID[0] === "" || active.GenerationID !== generationID[0] || active.CancelRequested)) {
      throw new Error("请先停止当前生成再切换模式");
    }
    if (item.ProjectID.trim() !== projectID.trim()) {
      throw ErrAssistantSessionProjectChanged;
    }
    if (mode === AssistantModeWorkspace && item.WorkspaceRunID === "" && item.RunID === "") {
      throw new Error("请先打开工作区");
    }
    item.RuntimeMode = mode;
    const updateErr = tx.Model(new assistantSessionRow()).Where("id = ? AND user_id = ?", row.ID, userID).Update("payload", mustJSON(item)).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
};

module.exports = { ErrAssistantSessionProjectChanged, ErrAssistantExecutionLocked };
