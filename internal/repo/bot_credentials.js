/**
 * @file internal/repo/bot_credentials.js
 * 对应 Go 源文件：internal/repo/bot_credentials.go
 *
 * 作用与职责边界：
 * 定义外部通知/交互 Bot 凭据密文表（`user_bot_credentials`）的行模型，
 * 并为 `UsersRepo` 提供按 Bot ID 读取密文以及在事务内保存与删除密文的方法。
 * 不负责密文的加解密算法或 Bot 业务配置管理。
 *
 * 语法差异说明：
 * - Go 的 `(string, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理。
 * - GORM `struct` 标签直接略去，`clause.OnConflict` 与链式调用按原样保留。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

/**
 * 对应数据库表 `user_bot_credentials` 的 Bot 凭据密文行模型。
 * 以 Bot ID 为主键持久化加密后的凭据文本。
 */
class botCredentialRow {
  /**
   * 构造 Bot 凭据行对象，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.BotID=""] - Bot 唯一标识（主键）。
   * @param {string} [init.Secret=""] - 加密存储的凭据密文（对应物理列 `ciphertext`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.BotID = init.BotID ?? "";
    this.Secret = init.Secret ?? "";
  }

  /**
   * 返回 GORM 映射的物理数据库表名。
   *
   * @returns {string} 表名 `"user_bot_credentials"`。
   */
  TableName() {
    return "user_bot_credentials";
  }
}

/**
 * 按 Bot ID 查询对应的加密凭据密文。
 * 供通知投递器或外部 Bot 长连接进程获取认证密钥时调用。
 *
 * @param {string} botID - 目标 Bot 的唯一标识。
 * @returns {string} 数据库中存储的凭据密文字符串。
 * @throws {Error} 记录不存在（`gorm.ErrRecordNotFound`）或数据库查询出错时抛出错误。
 */
UsersRepo.prototype.BotCredential = function (botID) {
  const row = new botCredentialRow();
  const err = this.DB.Where("bot_id = ?", botID).First(row).Error;
  if (err === gorm.ErrRecordNotFound) {
    throw err;
  }
  if (err != null) {
    throw err;
  }
  return row.Secret;
};

/**
 * 在外部传入的事务句柄中写入或覆盖指定 Bot 的凭据密文。
 * 供同包 `NotificationsRepo.SaveNotificationBot` 在同一事务中原子保存配置与密钥时调用。
 *
 * @param {object} tx - 当前事务的 `gorm.DB` 句柄。
 * @param {string} id - Bot 唯一标识。
 * @param {string} secret - 待保存的加密凭据密文。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
UsersRepo.prototype.putBotCredential = function (tx, id, secret) {
  const err = tx.Clauses(new clause.OnConflict({ UpdateAll: true })).Create(new botCredentialRow({ BotID: id, Secret: secret })).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 在外部传入的事务句柄中删除指定 Bot 的凭据密文记录。
 * 供同包 `NotificationsRepo.DeleteNotificationBot` 删除 Bot 时一并清理凭据。
 *
 * @param {object} tx - 当前事务的 `gorm.DB` 句柄。
 * @param {string} id - 待删除凭据对应的 Bot 唯一标识。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库删除失败时抛出错误。
 */
UsersRepo.prototype.deleteBotCredential = function (tx, id) {
  const err = tx.Where("bot_id = ?", id).Delete(new botCredentialRow()).Error;
  if (err != null) {
    throw err;
  }
};

module.exports = { botCredentialRow };
