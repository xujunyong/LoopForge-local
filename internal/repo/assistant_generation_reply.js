/**
 * @file internal/repo/assistant_generation_reply.js
 * 对应 Go 源文件：internal/repo/assistant_generation_reply.go
 *
 * 作用与职责边界：
 * 负责在事务锁保护下提交助手单轮生成的对话记录（含正常回复、已停止或重定向的半成品文本，
 * 以及未完成回复的追踪与部分答案追加），防止过期进程或已被取消/替代的生成覆盖最新会话内容。
 * 不负责生成生命周期调度、心跳维护或前端流式推送。
 *
 * 语法差异说明：
 * - Go 仅返回 `error` 的方法在 JS 中成功返回 `undefined`、失败抛出异常；`(bool, error)` 译为成功返回布尔值、失败抛出异常。
 * - GORM `DB.Transaction` 回调遵循失败 `throw err`、成功正常返回的约定。
 * - Go 的 `json.Marshal` + `bytes.Equal` 比较译为 `JSON.stringify` 字符串严格相等比较；`time.Time{}` 零值译为 `null`。
 * - 同包多文件方法通过 `AssistantRepo.prototype.<Method>` 挂载。
 */

"use strict";

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { decodeAssistantSession } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 本次一同翻译
const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 本次一同翻译
const { assistantSessionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

/**
 * 提交当前运行中生成轮次的共享回复记录。
 * 仅允许当前仍在持有写入权且未被请求取消的生成提交，防止过期进程在生成取消或被替代后覆盖待处理对话。
 *
 * @param {number} ownerID - 会话所属用户 ID。
 * @param {string} generationID - 当前执行生成的轮次 ID。
 * @param {Object} next - 待保存的最新会话对象（`AssistantSession`）。
 * @returns {void} 无返回值。
 * @throws {Error} 当查询失败、生成已取消/被替代或会话历史已发生并发变更时抛出错误。
 */
AssistantRepo.prototype.PutAssistantGenerationReply = function (ownerID, generationID, next) {
  this.commitGenerationTranscript(ownerID, generationID, next, false);
};

/**
 * 提交已停止或被引导重定向的生成轮次对话记录。
 * 即使该生成已被标记请求取消，仍允许保存取消前已输出的文本内容。
 *
 * @param {number} ownerID - 会话所属用户 ID。
 * @param {string} generationID - 当前执行生成的轮次 ID。
 * @param {Object} next - 待保存的最新会话对象（`AssistantSession`）。
 * @returns {void} 无返回值。
 * @throws {Error} 当查询失败、生成不再处于运行态/被替代或会话历史已发生并发变更时抛出错误。
 */
AssistantRepo.prototype.CommitAssistantTranscript = function (ownerID, generationID, next) {
  this.commitGenerationTranscript(ownerID, generationID, next, true);
};

/**
 * 在行级写锁事务中校验生成归属与历史消息前缀一致性，然后持久化新的会话内容。
 * 由 `PutAssistantGenerationReply` 和 `CommitAssistantTranscript` 复用。
 *
 * @param {number} ownerID - 会话所属用户 ID。
 * @param {string} generationID - 期望持有写入权的生成轮次 ID。
 * @param {Object} next - 待保存的最新会话对象（`AssistantSession`）。
 * @param {boolean} allowStopped - 是否允许在生成已收到取消请求时仍提交对话记录。
 * @returns {void} 无返回值。
 * @throws {Error} 当记录不存在、生成已取消或被替代、历史消息被改写或持久化失败时抛出错误。
 */
AssistantRepo.prototype.commitGenerationTranscript = function (ownerID, generationID, next, allowStopped) {
  this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    let err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", next.ID, ownerID).Take(row).Error;
    if (err != null) {
      throw err;
    }
    const generation = new assistantGenerationRow();
    err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ? AND user_id = ?", next.ID, ownerID).Take(generation).Error;
    if (err != null) {
      throw err;
    }
    if (generation.GenerationID !== generationID || generation.Status !== "running" || (!allowStopped && generation.CancelRequested)) {
      throw new Error("会话生成已取消或被替代，不能保存旧回复");
    }
    const old = decodeAssistantSession(row);
    if (next.Messages.length < old.Messages.length) {
      throw new Error("会话已更新，请重新打开");
    }
    for (let i = 0; i < old.Messages.length; i++) {
      const a = JSON.stringify(old.Messages[i]);
      const b = JSON.stringify(next.Messages[i]);
      if (a !== b) {
        throw new Error("会话已更新，请重新打开");
      }
    }
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    scoped.DB = tx;
    const base = { ...this.deps, DB: tx };
    scoped.deps = base;
    scoped.putAssistantSession(ownerID, next);
  });
};

/**
 * 为未产出正式回复而结束的生成轮次追加执行轨迹和部分回答。
 * 仅在该生成仍归属当前会话且对话末尾恰好停留在它所响应的用户消息时写入，
 * 避免重试请求、新一轮对话或已被编辑的会话中出现错位回复。
 *
 * @param {number} ownerID - 会话所属用户 ID。
 * @param {string} sessionID - 目标会话 ID。
 * @param {string} generationID - 本轮生成的唯一 ID。
 * @param {number} messageCount - 期望的当前消息总数（最后一条须为用户消息）。
 * @param {Object} message - 待追加的助手消息对象（`AssistantMessage`）。
 * @returns {boolean} 实际完成追加返回 `true`；若参数无效、生成已变更或消息状态不匹配则返回 `false`。
 * @throws {Error} 当数据库查询或保存会话失败时抛出错误。
 */
AssistantRepo.prototype.AppendUnfinishedAssistantReply = function (ownerID, sessionID, generationID, messageCount, message) {
  if (messageCount <= 0 || generationID === "") {
    return false;
  }
  let appended = false;
  this.DB.Transaction((tx) => {
    const generation = new assistantGenerationRow();
    let err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ? AND user_id = ?", sessionID, ownerID).Take(generation).Error;
    if (err != null) {
      throw err;
    }
    if (generation.GenerationID !== generationID) {
      return;
    }
    const row = new assistantSessionRow();
    err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", sessionID, ownerID).Take(row).Error;
    if (err != null) {
      throw err;
    }
    const session = decodeAssistantSession(row);
    if (session.Messages.length !== messageCount || session.Messages[messageCount - 1].Role !== "user") {
      return;
    }
    session.Messages.push(message);
    session.UpdatedAt = null;
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    scoped.DB = tx;
    const base = { ...this.deps, DB: tx };
    scoped.deps = base;
    scoped.putAssistantSession(ownerID, session);
    appended = true;
  });
  return appended;
};

module.exports = {};
