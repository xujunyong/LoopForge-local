/**
 * @file internal/domain/task.js
 * @description 对应 Go 文件：internal/domain/task.go
 * 职责与边界：定义平台级的 SOP 派发任务实体（Task），用于跨实例幂等追踪一次需求派发的执行状态与来源信息。
 * 语法差异说明：
 * - Go 的 `time.Time` 字段与复合结构字段 `Repository` 零值在 JS 中初始化为 `null`。
 */

"use strict";

/**
 * 表示一次 SOP 派发产生的持久化任务记录，关联需求、角色、工作流、运行 ID、触发来源与仓库上下文。
 */
class Task {
  /**
   * 构造派发任务实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.AgentID = init.AgentID ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.RunID = init.RunID ?? "";
    this.Status = init.Status ?? "";
    this.DispatchMode = init.DispatchMode ?? "";
    this.ScheduleJobID = init.ScheduleJobID ?? "";
    this.TriggerOrigin = init.TriggerOrigin ?? "";
    this.Repository = init.Repository ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

module.exports = { Task };
