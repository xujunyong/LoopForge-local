/**
 * 对应 Go 文件：internal/domain/group_plan.go
 * 作用：定义已退役自由协作工作流标识与角色组共享工作计划项数据结构。
 * 职责边界：仅用于保证历史运行快照反序列化与写回时不丢失字段，不承载新业务流程。
 * 语法差异说明：Go 的 time.Time 对应 Date，零值为 null。
 */

"use strict";

/** 已退役自由协作运行（含由数据迁移转换出的会话工作区）使用的工作流 ID。 */
const FreeCollaborationWorkflowID = "free-collaboration";

/**
 * 已退役角色组中的单条共享工作计划项。
 * 仅保留用于历史运行快照的完整往返读取与保存。
 */
class GroupPlanItem {
  /**
   * 构造共享工作计划项对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<GroupPlanItem>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
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
