// bot_identity.js —— 对应 Go 文件：internal/domain/bot_identity.go
// 作用：外部 Bot 用户绑定与绑定验证挑战。
// Go struct 的 gorm 标签无 JS 对应，略去。

"use strict";

// BotUserBinding：按外部 Bot ID 划定范围，不同企业或 Bot 命名空间的用户 ID 不可互换。
class BotUserBinding {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.BotID = init.BotID ?? "";
    this.SenderID = init.SenderID ?? "";
    this.UserID = init.UserID ?? 0;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

class BotBindingChallenge {
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
