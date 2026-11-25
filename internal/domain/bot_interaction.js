// bot_interaction.js —— 对应 Go 文件：internal/domain/bot_interaction.go
// 作用：Bot 连接、会话与交互消息记录。
// Go struct 的 gorm 标签无 JS 对应，略去。

"use strict";

class BotConnection {
  constructor(init = {}) {
    this.BotID = init.BotID ?? "";
    this.Owner = init.Owner ?? "";
    this.LeaseUntil = init.LeaseUntil ?? null;
    this.State = init.State ?? "";
    this.LastError = init.LastError ?? "";
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

class BotConversation {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.BotID = init.BotID ?? "";
    this.ChatID = init.ChatID ?? "";
    this.ChatType = init.ChatType ?? "";
    this.SessionID = init.SessionID ?? "";
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

class BotInteraction {
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
