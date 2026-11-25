// task.js —— 对应 Go 文件：internal/domain/task.go
// 作用：执行任务记录，一次 SOP 派发对应一条任务。

"use strict";

// Task：一次 SOP 派发产生的执行任务。
class Task {
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
