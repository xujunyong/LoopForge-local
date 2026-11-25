// assistant_generation.js —— 对应 Go 文件：internal/domain/assistant_generation.go
// 作用：一轮助手生成占用的会话槽位、转向消息与流快照。

"use strict";

// AssistantGeneration：一轮生成占用一个私有或共享会话槽位，与浏览器无关。
class AssistantGeneration {
  constructor(init = {}) {
    this.StartedAt = init.StartedAt ?? null;
    this.Trigger = init.Trigger ?? "";
    this.TriggerID = init.TriggerID ?? "";
    this.ID = init.ID ?? "";
    this.ClientRequestID = init.ClientRequestID ?? "";
    this.SessionID = init.SessionID ?? "";
    this.ActorID = init.ActorID ?? 0;
    this.ActorName = init.ActorName ?? "";
    this.UserID = init.UserID ?? 0;
    this.ProjectID = init.ProjectID ?? "";
    this.Status = init.Status ?? "";
    this.RuntimeMode = init.RuntimeMode ?? "";
    this.WorkspaceRunID = init.WorkspaceRunID ?? "";
    this.WorkspaceWarning = init.WorkspaceWarning ?? "";
    this.Error = init.Error ?? "";
    this.Failure = init.Failure ?? null;
    this.Events = init.Events ?? [];
    this.Stream = init.Stream ?? null;
    this.Reply = init.Reply ?? null;
    this.Steer = init.Steer ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
    this.CancelRequested = init.CancelRequested ?? false;
    this.MessageCount = init.MessageCount ?? 0;
  }
}

// AssistantSteer：在不丢弃已写内容的前提下重定向正在运行的回复。
class AssistantSteer {
  constructor(init = {}) {
    this.Content = init.Content ?? "";
    this.Attachments = init.Attachments ?? [];
    this.References = init.References ?? [];
    this.Model = init.Model ?? "";
    this.RequireExactModel = init.RequireExactModel ?? false;
    this.Effort = init.Effort ?? "";
    this.ApprovalMode = init.ApprovalMode ?? "";
    this.ActorID = init.ActorID ?? 0;
    this.ActorName = init.ActorName ?? "";
    this.Trigger = init.Trigger ?? "";
    this.TriggerID = init.TriggerID ?? "";
  }
}

// AssistantStreamSnapshot：有界投影，旧 token 事件淘汰后仍可存活并重连。
class AssistantStreamSnapshot {
  constructor(init = {}) {
    this.Sequence = init.Sequence ?? 0;
    this.Answer = init.Answer ?? "";
    this.DraftMessage = init.DraftMessage ?? "";
    this.DraftJSON = init.DraftJSON ?? "";
    this.Activity = init.Activity ?? [];
  }
}

class AssistantGenerationEvent {
  constructor(init = {}) {
    this.Sequence = init.Sequence ?? 0;
    this.Data = init.Data ?? null;
  }
}

module.exports = { AssistantGeneration, AssistantSteer, AssistantStreamSnapshot, AssistantGenerationEvent };
