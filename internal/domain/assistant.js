/**
 * @file internal/domain/assistant.js
 * 对应 Go 源文件：internal/domain/assistant.go
 *
 * 作用与职责边界：
 * 定义 Studio 助手的核心会话领域模型，包括会话来源与运行模式常量、用户可见执行活动事件、
 * 消息与引用/页面元素/附件、参与者、执行目标选择、会话实体（含执行位置与锁定判定方法）、
 * 定时助手任务以及不可变原生工具审批记录。
 * 不负责会话持久化或流式回复调度。
 *
 * 语法差异说明：
 * - Go 指针字段、`time.Time` 与 `json.RawMessage` 零值统一初始化为 `null`。
 * - Go `CloneAssistantReferences` 在切片为空时返回 `nil`，对应 JS 返回 `null`。
 */

"use strict";

const { ExecutionModeCloud } = require("./observability.js"); // 对应 Go 同包常量，observability.js 翻译后补齐

// 普通对话会话来源。
const AssistantSourceChat = "chat";
// 由 SOP 运行拥有的共享协作会话来源。
const AssistantSourceSOP = "sop";
// 由定时任务触发产生的会话来源。
const AssistantSourceScheduled = "scheduled";
// SOP 设计器 AI 编排器的私有会话来源，归属单张画布，不出现在工作台会话列表。
const AssistantSourceSOPDesigner = "sop-designer";

/**
 * 表示单条用户可见的助手执行活动事件（不含原始工具参数与完整返回结果）。
 * 随单轮回复保存，防止后续轮次覆盖历史执行轨迹，并支持展示子 Agent 派发与模型切换记录。
 */
class AssistantActivityEvent {
  /**
   * 构造并初始化助手活动事件实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示会话中的单条对话消息（用户消息或助手回复）。
 * 记录正文内容、引用、附件、关联资产与运行 ID、执行活动流、模型用量及提前终止时的失败摘要。
 */
class AssistantMessage {
  /**
   * 构造并初始化助手消息实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示消息中引用或操作过的平台资产摘要卡片信息。
 */
class AssistantAssetRef {
  /**
   * 构造并初始化助手资产引用实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Kind = init.Kind ?? "";
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Status = init.Status ?? "";
    this.Tool = init.Tool ?? "";
  }
}

/**
 * 表示用户在发送消息或创建任务时显式附带的上下文引用（如需求、代码仓、资产或预览页面元素）。
 * 当 `Type` 为 `"element"` 时，`Element` 携带前端直传的页面元素上下文，不查平台对象库。
 */
class AssistantReference {
  /**
   * 构造并初始化助手上下文引用实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Type = init.Type ?? "";
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.ProjectName = init.ProjectName ?? "";
    this.Element = init.Element ?? null;
  }
}

/**
 * 返回上下文引用列表的浅拷贝，供持久化任务载荷与消息构造独立持有。
 * 输入为空或长度为 0 时返回 `null`（与 Go 返回 `nil` 切片一致）。
 *
 * @param {AssistantReference[]|null} refs - 原始上下文引用数组。
 * @returns {AssistantReference[]|null} 独立拷贝后的引用数组；输入为空时返回 `null`。
 */
function CloneAssistantReferences(refs) {
  if (refs == null || refs.length === 0) {
    return null;
  }
  return refs.slice();
}

/**
 * 表示用户在原生预览面板中点选的页面 DOM 元素上下文。
 * 包含页面 URL、选择器、文本/HTML 片段、元素位置框、视口尺寸、关键样式及框架组件信息。
 */
class AssistantPageElement {
  /**
   * 构造并初始化预览页面元素上下文实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示以 CSS 像素为单位的矩形区域；用于视口尺寸时仅设置宽高。
 */
class ElementRect {
  /**
   * 构造并初始化矩形区域实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.X = init.X ?? 0;
    this.Y = init.Y ?? 0;
    this.Width = init.Width ?? 0;
    this.Height = init.Height ?? 0;
  }
}

/**
 * 表示随消息上传的附件元数据（不含文件二进制内容）。
 */
class AssistantAttachment {
  /**
   * 构造并初始化消息附件元数据实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.MimeType = init.MimeType ?? "";
    this.Size = init.Size ?? 0;
  }
}

/**
 * 表示参与共享对话或协作会话的用户简要信息。
 */
class AssistantParticipant {
  /**
   * 构造并初始化会话参与者实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? 0;
    this.Name = init.Name ?? "";
  }
}

// 助手运行模式常量：平台编排模式与工作区直改模式。
const AssistantModePlatform = "platform";
const AssistantModeWorkspace = "workspace";

/**
 * 表示会话选定的执行目标位置（云端资源池或指定执行器），与是否开启工作区解耦。
 * 云端池下 `RunnerID` 为空表示使用平台内置执行宿主。
 */
class AssistantExecutionTarget {
  /**
   * 构造并初始化执行目标实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Pool = init.Pool ?? "";
    this.RunnerID = init.RunnerID ?? "";
  }
}

/**
 * 表示一条完整的 Studio 助手会话记录。
 * 涵盖会话元信息、执行目标与模式、协作参与者、分支派生关系、关联运行/工作区以及消息历史。
 */
class AssistantSession {
  /**
   * 构造并初始化助手会话实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回会话生效的执行目标。
   * 若会话显式配置了 `ExecutionTarget` 则返回该配置；否则按旧会话兼容规则默认返回云端池。
   *
   * @returns {AssistantExecutionTarget} 当前会话生效的执行目标对象。
   */
  Execution() {
    if (this.ExecutionTarget != null) {
      return this.ExecutionTarget;
    }
    // 执行目标选择功能上线前的历史会话均默认运行在云端。
    return new AssistantExecutionTarget({ Pool: ExecutionModeCloud });
  }

  /**
   * 判断会话的执行目标机器是否已锁定不可再切换。
   * 草稿在首轮对话开始前可切换执行机；一旦有显式锁、产生消息、绑定运行/工作区、派生自父会话或属于定时任务即锁定。
   *
   * @returns {boolean} 执行目标已锁定时返回 `true`，仍可切换时返回 `false`。
   */
  ExecutionLocked() {
    return this.ExecutionTargetLocked || this.Messages.length > 0 || this.RunID !== "" ||
      this.WorkspaceRunID !== "" || this.OwnWorkspaceRunIDs.length > 0 ||
      this.ParentSessionID !== "" || this.TaskID !== "";
  }

  /**
   * 返回会话生效的运行模式。
   * 未显式设置 `RuntimeMode` 时默认回退为平台模式（`AssistantModePlatform`）。
   *
   * @returns {string} 运行模式标识（`"platform"` 或 `"workspace"`）。
   */
  Mode() {
    if (this.RuntimeMode !== "") {
      return this.RuntimeMode;
    }
    return AssistantModePlatform;
  }
}

/**
 * 表示用户配置的定时助手任务（定时提示词）。
 * 支持 Cron 或固定间隔触发，在同一会话中持续产出回复并按绑定渠道发送通知。
 */
class AssistantTask {
  /**
   * 构造并初始化定时助手任务实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示单次不可变的原生工具调用审批记录。
 * 用于在写操作需要人工或 AI 批准时锁定工具名称、入参摘要及审批决策。
 */
class AssistantNativeApproval {
  /**
   * 构造并初始化原生工具审批记录实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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
