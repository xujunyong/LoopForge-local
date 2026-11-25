// assistant.js —— 对应 Go 文件：internal/domain/assistant.go
// 作用：Studio 助手会话、消息、任务与原生审批的数据结构。

"use strict";

const { ExecutionModeCloud } = require("./observability.js"); // 对应 Go 同包常量，observability.js 翻译后补齐

// AssistantSourceChat：普通对话。
const AssistantSourceChat = "chat";
// AssistantSourceSOP：SOP 运行共有的对话。
const AssistantSourceSOP = "sop";
// AssistantSourceScheduled：定时任务产生的对话。
const AssistantSourceScheduled = "scheduled";
// AssistantSourceSOPDesigner：SOP 设计器 AI 编排器的私有对话。
const AssistantSourceSOPDesigner = "sop-designer";

// AssistantActivityEvent：只含用户可见的执行流，不含原始工具参数与结果。
class AssistantActivityEvent {
  constructor(init = {}) {
    this.Kind = init.Kind ?? "";
    this.Text = init.Text ?? "";
    this.Tool = init.Tool ?? "";
    this.Detail = init.Detail ?? "";
    this.ID = init.ID ?? "";
    this.Failed = init.Failed ?? false;
    this.Full = init.Full ?? false;
    this.At = init.At ?? null;
    this.Parent = init.Parent ?? "";
    this.Subagent = init.Subagent ?? "";
    this.Role = init.Role ?? "";
    this.AgentID = init.AgentID ?? "";
    this.Model = init.Model ?? "";
    this.Input = init.Input ?? "";
    this.Output = init.Output ?? "";
  }
}

class AssistantMessage {
  constructor(init = {}) {
    this.Assets = init.Assets ?? [];
    this.RunIDs = init.RunIDs ?? [];
    this.Activity = init.Activity ?? [];
    this.Trigger = init.Trigger ?? "";
    this.TriggerID = init.TriggerID ?? "";
    this.StartedAt = init.StartedAt ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.AuthorID = init.AuthorID ?? 0;
    this.AuthorName = init.AuthorName ?? "";
    this.SpeakerName = init.SpeakerName ?? "";
    this.SpeakerAgentID = init.SpeakerAgentID ?? "";
    this.Model = init.Model ?? "";
    this.Usage = init.Usage ?? null;
    this.Role = init.Role ?? "";
    this.Content = init.Content ?? "";
    this.References = init.References ?? [];
    this.Attachments = init.Attachments ?? [];
    this.Unfinished = init.Unfinished ?? "";
    this.GenerationID = init.GenerationID ?? "";
    this.Failure = init.Failure ?? null;
  }
}

class AssistantAssetRef {
  constructor(init = {}) {
    this.Kind = init.Kind ?? "";
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Status = init.Status ?? "";
    this.Tool = init.Tool ?? "";
  }
}

class AssistantReference {
  constructor(init = {}) {
    this.Type = init.Type ?? "";
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.ProjectName = init.ProjectName ?? "";
    this.Element = init.Element ?? null;
  }
}

// CloneAssistantReferences：为持久化任务载荷与消息构造返回独立副本。
function CloneAssistantReferences(refs) {
  if (refs == null || refs.length === 0) {
    return null;
  }
  return refs.slice();
}

// AssistantPageElement：在原生预览中选中的页面元素。
class AssistantPageElement {
  constructor(init = {}) {
    this.URL = init.URL ?? "";
    this.Title = init.Title ?? "";
    this.Selector = init.Selector ?? "";
    this.Tag = init.Tag ?? "";
    this.Text = init.Text ?? "";
    this.HTML = init.HTML ?? "";
    this.Rect = init.Rect ?? null;
    this.Viewport = init.Viewport ?? null;
    this.Styles = init.Styles ?? {};
    this.Component = init.Component ?? "";
    this.Framework = init.Framework ?? "";
    this.Source = init.Source ?? "";
  }
}

// ElementRect：CSS 像素盒子；视口只设尺寸。
class ElementRect {
  constructor(init = {}) {
    this.X = init.X ?? 0;
    this.Y = init.Y ?? 0;
    this.Width = init.Width ?? 0;
    this.Height = init.Height ?? 0;
  }
}

class AssistantAttachment {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.MimeType = init.MimeType ?? "";
    this.Size = init.Size ?? 0;
  }
}

class AssistantParticipant {
  constructor(init = {}) {
    this.ID = init.ID ?? 0;
    this.Name = init.Name ?? "";
  }
}

const AssistantModePlatform = "platform";
const AssistantModeWorkspace = "workspace";

// AssistantExecutionTarget：只选一次，与工作区无关。
class AssistantExecutionTarget {
  constructor(init = {}) {
    this.Pool = init.Pool ?? "";
    this.RunnerID = init.RunnerID ?? "";
  }
}

class AssistantSession {
  constructor(init = {}) {
    this.ExecutionTarget = init.ExecutionTarget ?? null;
    this.ExecutionTargetLocked = init.ExecutionTargetLocked ?? false;
    this.RuntimeMode = init.RuntimeMode ?? "";
    this.Source = init.Source ?? "";
    this.TaskID = init.TaskID ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.Participants = init.Participants ?? [];
    this.ParticipantsVersion = init.ParticipantsVersion ?? 0;
    this.UnknownParticipants = init.UnknownParticipants ?? false;
    this.HistoryRevision = init.HistoryRevision ?? 0;
    this.ParentSessionID = init.ParentSessionID ?? "";
    this.RootSessionID = init.RootSessionID ?? "";
    this.ForkMessageIndex = init.ForkMessageIndex ?? 0;
    this.Shared = init.Shared ?? false;
    this.GenerationStatus = init.GenerationStatus ?? "";
    this.GenerationID = init.GenerationID ?? "";
    this.RecentClientRequestIDs = init.RecentClientRequestIDs ?? [];
    this.Unread = init.Unread ?? false;
    this.Archived = init.Archived ?? false;
    this.ID = init.ID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Title = init.Title ?? "";
    this.TitleEdited = init.TitleEdited ?? false;
    this.TitleGenerated = init.TitleGenerated ?? false;
    this.ProjectID = init.ProjectID ?? "";
    this.Model = init.Model ?? "";
    this.Effort = init.Effort ?? "";
    this.Executor = init.Executor ?? "";
    this.RunID = init.RunID ?? "";
    this.WorkspaceRunID = init.WorkspaceRunID ?? "";
    this.OwnWorkspaceRunIDs = init.OwnWorkspaceRunIDs ?? [];
    this.SandboxProfileID = init.SandboxProfileID ?? "";
    this.Messages = init.Messages ?? [];
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  Execution() {
    if (this.ExecutionTarget != null) {
      return this.ExecutionTarget;
    }
    // 执行选择前的会话都在云端运行。
    return new AssistantExecutionTarget({ Pool: ExecutionModeCloud });
  }

  // 草稿在首轮开始前可换机器；历史编辑后保留显式锁定，旧会话据此推断。
  ExecutionLocked() {
    return this.ExecutionTargetLocked || this.Messages.length > 0 || this.RunID !== "" ||
      this.WorkspaceRunID !== "" || this.OwnWorkspaceRunIDs.length > 0 ||
      this.ParentSessionID !== "" || this.TaskID !== "";
  }

  Mode() {
    if (this.RuntimeMode !== "") {
      return this.RuntimeMode;
    }
    return AssistantModePlatform;
  }
}

class AssistantTask {
  constructor(init = {}) {
    this.Notifications = init.Notifications ?? [];
    this.NotificationSnapshot = init.NotificationSnapshot ?? [];
    this.NotificationResult = init.NotificationResult ?? "";
    this.ID = init.ID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Name = init.Name ?? "";
    this.Prompt = init.Prompt ?? "";
    this.References = init.References ?? [];
    this.Model = init.Model ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.SessionID = init.SessionID ?? "";
    this.Cron = init.Cron ?? "";
    this.IntervalSec = init.IntervalSec ?? 0;
    this.Enabled = init.Enabled ?? false;
    this.LastStatus = init.LastStatus ?? "";
    this.LastError = init.LastError ?? "";
    this.LastMessage = init.LastMessage ?? "";
    this.LastRunAt = init.LastRunAt ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

// AssistantNativeApproval：一次不可变的原生工具调用。
class AssistantNativeApproval {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.GenerationID = init.GenerationID ?? "";
    this.ActorID = init.ActorID ?? 0;
    this.Tool = init.Tool ?? "";
    this.Summary = init.Summary ?? "";
    this.Input = init.Input ?? null;
    this.InputDigest = init.InputDigest ?? "";
    this.Decision = init.Decision ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
  }
}

module.exports = { AssistantSourceChat, AssistantSourceSOP, AssistantSourceScheduled, AssistantSourceSOPDesigner, AssistantActivityEvent, AssistantMessage, AssistantAssetRef, AssistantReference, CloneAssistantReferences, AssistantPageElement, ElementRect, AssistantAttachment, AssistantParticipant, AssistantModePlatform, AssistantModeWorkspace, AssistantExecutionTarget, AssistantSession, AssistantTask, AssistantNativeApproval };
