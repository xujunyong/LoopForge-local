/**
 * @file internal/repo/assistant_sandbox.js
 * 对应 Go 源文件：internal/repo/assistant_sandbox.go
 *
 * 作用与职责边界：
 * 负责在事务锁保护下切换普通助手会话绑定的运行环境（沙箱配置 ID），禁止切换任务/共享会话
 * 或在回复生成期间修改运行环境。
 * 不负责沙箱配置本身的存在性校验或底层工作区容器重建。
 *
 * 语法差异说明：
 * - Go 仅返回 `error` 的方法在 JS 中成功返回 `undefined`、失败 `throw err`。
 * - GORM `DB.Transaction` 回调遵循失败 `throw err`、成功正常返回的约定；`errors.Is` 译为 `===`。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { decodeAssistantSession, assistantRecordID } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 本次一同翻译
const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 本次一同翻译
const { assistantSessionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

/**
 * 切换指定普通会话的运行环境（沙箱配置 ID）。
 * 采用与 `BeginAssistantGeneration` 相同的「先锁会话、再锁生成」加锁顺序，防止环境切换与工作区创建竞态。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} id - 目标会话 ID。
 * @param {string} sandboxID - 新的沙箱配置 ID（自动去除首尾空白，空字符串表示恢复默认）。
 * @returns {void} 无返回值。
 * @throws {Error} 当会话不存在、属于共享/任务会话、正处于生成期间或数据库更新失败时抛出错误。
 */
AssistantRepo.prototype.SetAssistantSessionSandbox = function (userID, id, sandboxID) {
  this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    let err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", assistantRecordID(id), userID).Take(row).Error;
    if (err != null) {
      throw new Error("会话不存在");
    }
    const s = decodeAssistantSession(row);
    if (s.Shared || s.RunID !== "") {
      throw new Error("任务会话使用任务的运行环境，不能切换");
    }
    const generation = new assistantGenerationRow();
    err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ?", row.ID).Take(generation).Error;
    if (err != null && err !== gorm.ErrRecordNotFound) {
      throw err;
    }
    if (err == null && generation.Status === "running") {
      throw new Error("生成期间不能切换运行环境");
    }
    s.SandboxProfileID = sandboxID.trim();
    const updateErr = tx.Model(new assistantSessionRow()).Where("id = ? AND user_id = ?", row.ID, userID).Update("payload", mustJSON(s)).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
};

module.exports = {};
