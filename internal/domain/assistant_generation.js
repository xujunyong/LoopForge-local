/**
 * @file internal/domain/assistant_generation.js
 * 对应 Go 源文件：internal/domain/assistant_generation.go
 *
 * 作用与职责边界：
 * 定义单轮助手后台生成任务（Generation）的领域模型，包括会话槽位状态、
 * 运行中用户插话转向消息（Steer）、断线重连用的流式快照投影以及有序事件帧。
 * 不负责流推送传输或数据库租约管理。
 *
 * 语法差异说明：
 * - Go 指针字段、`time.Time` 与 `json.RawMessage` 零值统一初始化为 `null`。
 */

"use strict";

/**
 * 表示占据私有或共享会话槽位的一轮后台助手生成任务，其生命周期独立于前端浏览器连接。
 * 记录触发来源、执行状态、事件缓冲、流快照、最终回复、运行中转向请求与取消标记。
 */
class AssistantGeneration {
  /**
   * 构造并初始化助手生成任务实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示用户在回复仍在生成期间发送的转向（插话）消息。
 * 当前轮次保留已产出内容后，依据该转向内容和参数继续后续生成。
 */
class AssistantSteer {
  /**
   * 构造并初始化助手转向消息实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示生成流的有界状态投影。
 * 当早期细粒度 token 事件被淘汰或客户端断线重连时，前端可据此恢复当前已生成的回答、草稿与活动流。
 */
class AssistantStreamSnapshot {
  /**
   * 构造并初始化流式快照投影实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Sequence = init.Sequence ?? 0;
    this.Answer = init.Answer ?? "";
    this.DraftMessage = init.DraftMessage ?? "";
    this.DraftJSON = init.DraftJSON ?? "";
    this.Activity = init.Activity ?? [];
  }
}

/**
 * 表示带递增序号的单条生成流事件帧，用于增量推送与游标补拉。
 */
class AssistantGenerationEvent {
  /**
   * 构造并初始化生成流事件帧实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Sequence = init.Sequence ?? 0;
    this.Data = init.Data ?? null;
  }
}

module.exports = { AssistantGeneration, AssistantSteer, AssistantStreamSnapshot, AssistantGenerationEvent };
