/**
 * @file internal/domain/bot_identity.js
 * 对应 Go 源文件：internal/domain/bot_identity.go
 *
 * 作用与职责边界：
 * 定义外部即时通讯 Bot 身份与平台用户账号之间的绑定关系及一次性验证码挑战数据结构。
 * 仅描述领域实体，不负责验证码生成、校验逻辑或数据库持久化。
 *
 * 语法差异说明：
 * - Go 结构体上的 `gorm` 和 `json` 标签在 JS 中略去，`time.Time` 字段零值初始化为 `null`。
 */

"use strict";

/**
 * 表示外部 Bot 发送者身份与平台用户账号的绑定记录。
 * 绑定作用域严格按外部 `BotID` 隔离，不同企业或不同 Bot 命名空间下的 `SenderID` 不可互换。
 */
class BotUserBinding {
  /**
   * 构造并初始化 Bot 用户绑定实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.BotID = init.BotID ?? "";
    this.SenderID = init.SenderID ?? "";
    this.UserID = init.UserID ?? 0;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

/**
 * 表示绑定外部 Bot 身份时签发的验证码验证挑战记录。
 * 记录验证码哈希、校验状态、尝试次数及过期时间。
 */
class BotBindingChallenge {
  /**
   * 构造并初始化 Bot 绑定验证挑战实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.BindingID = init.BindingID ?? "";
    this.UserID = init.UserID ?? 0;
    this.CodeHash = init.CodeHash ?? "";
    this.Status = init.Status ?? "";
    this.Attempts = init.Attempts ?? 0;
    this.ExpiresAt = init.ExpiresAt ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
  }
}

module.exports = { BotUserBinding, BotBindingChallenge };
