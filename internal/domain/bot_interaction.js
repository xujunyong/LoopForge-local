/**
 * @file internal/domain/bot_interaction.js
 * 对应 Go 源文件：internal/domain/bot_interaction.go
 *
 * 作用与职责边界：
 * 定义外部 Bot 长连接租约状态、外部聊天会话与平台助手会话的映射关系，
 * 以及入站交互消息队列与回复追踪记录的数据模型。
 * 仅描述领域实体，不负责 Bot 协议收发、队列消费或数据库读写。
 *
 * 语法差异说明：
 * - Go 结构体上的 `gorm` 和 `json` 标签在 JS 中略去，`time.Time` 字段零值初始化为 `null`。
 */

"use strict";

/**
 * 表示单个外部 Bot 长连接在多实例部署下的持有者租约与当前连接状态。
 */
class BotConnection {
  /**
   * 构造并初始化 Bot 连接状态实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.BotID = init.BotID ?? "";
    this.Owner = init.Owner ?? "";
    this.LeaseUntil = init.LeaseUntil ?? null;
    this.State = init.State ?? "";
    this.LastError = init.LastError ?? "";
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

/**
 * 表示外部聊天窗口（单聊或群聊）与平台助手会话（`SessionID`）的绑定关系。
 */
class BotConversation {
  /**
   * 构造并初始化 Bot 聊天会话映射实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.BotID = init.BotID ?? "";
    this.ChatID = init.ChatID ?? "";
    this.ChatType = init.ChatType ?? "";
    this.SessionID = init.SessionID ?? "";
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

/**
 * 表示一条经由外部 Bot 接收并排队处理的交互消息或卡片动作记录。
 * 跟踪发送者、请求幂等键、正文与引用内容、卡片动作/投递标识、处理状态、回复正文及最近错误。
 */
class BotInteraction {
  /**
   * 构造并初始化 Bot 交互消息记录实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.BotID = init.BotID ?? "";
    this.ConversationID = init.ConversationID ?? "";
    this.SessionID = init.SessionID ?? "";
    this.SenderID = init.SenderID ?? "";
    this.RequestID = init.RequestID ?? "";
    this.Content = init.Content ?? "";
    this.Quote = init.Quote ?? "";
    this.Action = init.Action ?? "";
    this.CardTaskID = init.CardTaskID ?? "";
    this.DeliveryID = init.DeliveryID ?? "";
    this.Status = init.Status ?? "";
    this.Reply = init.Reply ?? "";
    this.LastError = init.LastError ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

module.exports = { BotConnection, BotConversation, BotInteraction };
