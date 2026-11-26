/**
 * @file internal/repo/assistant_proposals.js
 * 对应 Go 源文件：internal/repo/assistant_proposals.go
 *
 * 作用与职责边界：
 * 负责在会话处于非生成态且内容未发生并发变更的前提下，以乐观比对加行锁的方式保存会话，
 * 避免多个写入方同时响应同一提案（proposal）时互相覆盖。
 * 不负责提案内容解析或状态机流转本身。
 *
 * 语法差异说明：
 * - Go 仅返回 `error` 的方法在 JS 中成功返回 `undefined`、失败 `throw err`。
 * - GORM `DB.Transaction` 回调遵循失败 `throw err`、成功正常返回的约定。
 * - Go 的 `time.Time.Equal` 与 `bytes.Equal(json.Marshal(...))` 分别译为时间戳毫秒比较和 `JSON.stringify` 严格相等比较。
 */

"use strict";

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { decodeAssistantSession, assistantRecordID } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 本次一同翻译
const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 本次一同翻译
const { assistantSessionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

/**
 * 仅在库中会话仍与期望快照完全一致且当前没有运行中的回复生成时保存 `next`。
 * 用于提案确认/拒绝等需要乐观并发控制的会话改写场景，防止两个并发写入互相覆盖。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {Object} next - 准备写入的新会话对象（`AssistantSession`）。
 * @param {Object} expected - 调用方读取到的期望基线会话对象（`AssistantSession`），用于比对更新时间与消息列表。
 * @returns {void} 无返回值。
 * @throws {Error} 当会话不存在、已发生并发更新、正在生成回复或保存失败时抛出错误。
 */
AssistantRepo.prototype.PutAssistantSessionIfUnchanged = function (userID, next, expected) {
  this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", assistantRecordID(next.ID), userID).Take(row).Error;
    if (err != null) {
      throw err;
    }
    const old = decodeAssistantSession(row);
    const a = JSON.stringify(old.Messages);
    const b = JSON.stringify(expected.Messages);
    const oldMs = old.UpdatedAt == null ? null : old.UpdatedAt.getTime();
    const expectedMs = expected.UpdatedAt == null ? null : expected.UpdatedAt.getTime();
    if (oldMs !== expectedMs || a !== b) {
      throw new Error("会话已更新，请重新打开");
    }
    let active = 0;
    const countErr = tx.Model(new assistantGenerationRow()).Where("session_id = ? AND status = ?", row.ID, "running").Count(active).Error;
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

module.exports = {};
