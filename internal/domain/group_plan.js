// group_plan.js —— 对应 Go 文件：internal/domain/group_plan.go
// 作用：已退役角色组的共享工作计划项，仅供历史快照往返。

"use strict";

const FreeCollaborationWorkflowID = "free-collaboration";

// GroupPlanItem：已退役角色组的一个共享工作项。
class GroupPlanItem {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Title = init.Title ?? "";
    this.Detail = init.Detail ?? "";
    this.Owner = init.Owner ?? "";
    this.Status = init.Status ?? "";
    this.Note = init.Note ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Revision = init.Revision ?? 0;
    this.UpdatedBy = init.UpdatedBy ?? "";
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

module.exports = { FreeCollaborationWorkflowID, GroupPlanItem };
