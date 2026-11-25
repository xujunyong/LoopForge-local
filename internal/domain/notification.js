// notification.js —— 对应 Go 文件：internal/domain/notification.go
// 作用：通知机器人、绑定与投递记录的类型定义。

"use strict";

// BotChat：通知机器人绑定的目标会话。
class BotChat {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Type = init.Type ?? "";
    this.LastMessageTime = init.LastMessageTime ?? "";
  }
}

// NotificationBot：项目配置的通知机器人。
class NotificationBot {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.OwnerID = init.OwnerID ?? 0;
    this.Model = init.Model ?? "";
    this.Name = init.Name ?? "";
    this.BotID = init.BotID ?? "";
    this.InteractionEnabled = init.InteractionEnabled ?? false;
    this.Enabled = init.Enabled ?? false;
    this.SecretConfigured = init.SecretConfigured ?? false;
    this.Target = init.Target ?? null;
    this.Health = init.Health ?? "";
    this.LastCheckedAt = init.LastCheckedAt ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

// NotificationBinding：机器人与触发事件、模板的绑定。
class NotificationBinding {
  constructor(init = {}) {
    this.BotID = init.BotID ?? "";
    this.Events = init.Events ?? [];
    this.Template = init.Template ?? "";
    this.Scope = init.Scope ?? "";
    this.ContentMode = init.ContentMode ?? "";
    this.AIInstruction = init.AIInstruction ?? "";
    this.WaitingPolicy = init.WaitingPolicy ?? "";
  }
}

// NodeNotification：节点通知，即 NotificationBinding 的别名。
const NodeNotification = NotificationBinding;

const DefaultNotificationReportModel = "default";

// NotificationReportRequest：一次通知报告的绑定与上下文。
class NotificationReportRequest {
  constructor(init = {}) {
    this.Binding = init.Binding ?? new NotificationBinding();
    this.Context = init.Context ?? new NotificationContext();
  }
}

// NotificationDelivery：一次通知投递的持久记录。
class NotificationDelivery {
  constructor(init = {}) {
    this.ReportRequest = init.ReportRequest ?? "";
    this.ReportState = init.ReportState ?? "";
    this.ReportModel = init.ReportModel ?? "";
    this.ReportError = init.ReportError ?? "";
    this.WaitingPolicy = init.WaitingPolicy ?? "";
    this.SourceType = init.SourceType ?? "";
    this.SourceID = init.SourceID ?? "";
    this.SourceName = init.SourceName ?? "";
    this.ContentSource = init.ContentSource ?? "";
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.BotID = init.BotID ?? "";
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.EventType = init.EventType ?? "";
    this.TargetID = init.TargetID ?? "";
    this.TargetType = init.TargetType ?? "";
    this.TargetName = init.TargetName ?? "";
    this.Content = init.Content ?? "";
    this.Status = init.Status ?? "";
    this.Attempts = init.Attempts ?? 0;
    this.Attempt = init.Attempt ?? 0;
    this.ReworkCount = init.ReworkCount ?? 0;
    this.NextAttemptAt = init.NextAttemptAt ?? null;
    this.LeaseUntil = init.LeaseUntil ?? null;
    this.LeaseToken = init.LeaseToken ?? "";
    this.LastError = init.LastError ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
    this.SentAt = init.SentAt ?? null;
  }

  TableName() {
    return "notification_deliveries";
  }
}

module.exports = { BotChat, NotificationBot, NotificationBinding, NodeNotification, DefaultNotificationReportModel, NotificationReportRequest, NotificationDelivery };
