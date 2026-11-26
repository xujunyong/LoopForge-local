/**
 * @file internal/repo/assistant_session_reads.js
 * 对应 Go 源文件：internal/repo/assistant_session_reads.go
 *
 * 作用与职责边界：
 * 负责持久化单个读者在某助手会话中最近看过的回复轮次，供历史会话列表跨设备计算未读状态。
 * 不负责列表聚合查询（由 `assistant_generations.js` 中的 `AssistantGenerationStatuses` 负责）或会话正文读取。
 *
 * 语法差异说明：
 * - Go `(bool, error)` 译为成功返回布尔值、失败 `throw err`；`errors.Is` 译为 `===`。
 * - `assistantSessionReadRow` 字段按 Go 零值初始化（`time.Time` 译为 `null`），同包方法挂载在 `AssistantRepo.prototype`。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { assistantRecordID } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 本次一同翻译
const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 本次一同翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// 会话不存在或所属者尚未产生任何可标记已读的回复时抛出的标准错误。
const ErrAssistantReplyNotFound = new Error("对话不存在或还没有回复");

/**
 * 对应数据库表 `assistant_session_reads` 的持久化行模型。
 * 记录某位读者在某会话中最近已查看的生成轮次 ID，用于跨设备判断是否仍有未读新回复。
 */
class assistantSessionReadRow {
  /**
   * 构造并初始化会话已读记录行对象。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.SessionID = init.SessionID ?? "";
    this.GenerationID = init.GenerationID ?? "";
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射的数据库表名。
   *
   * @returns {string} 表名 `"assistant_session_reads"`。
   */
  TableName() {
    return "assistant_session_reads";
  }
}

/**
 * 记录读者已查看归属于 `ownerID` 的指定会话最新回复。
 * 仅当传入的 `generationID` 恰好等于该会话最新一轮生成时才写入已读位点，
 * 防止陈旧标签页上报更早的轮次 ID 覆盖其他标签页已清除的未读状态（此时返回 `false` 且不修改数据）。
 *
 * @param {number} readerID - 当前阅读该会话的读者用户 ID。
 * @param {number} ownerID - 会话所属用户 ID。
 * @param {string} sessionID - 目标会话 ID。
 * @param {string} generationID - 读者已查看的回复生成轮次 ID。
 * @returns {boolean} 匹配最新轮次并成功更新已读位点返回 `true`；若传入轮次已过期则返回 `false`。
 * @throws {Error} 当参数非法、会话无回复（抛出 `ErrAssistantReplyNotFound`）或数据库查询/写入出错时抛出错误。
 */
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
