/**
 * 对应 Go 文件：internal/domain/group_completion.go
 * 作用：定义独立于节点执行与验证结果的交付验收记录数据结构。
 * 职责边界：仅描述交付验收事件的数据字段，不包含验收审批流程或持久化逻辑。
 * 语法差异说明：Go 的 time.Time 对应 Date，零值为 null。
 */

"use strict";

/**
 * 交付验收记录，独立于节点执行状态与测试验证结果。
 * 验收通过本身不会把跳过的测试项改写为通过。
 */
class GroupCompletion {
  /**
   * 构造交付验收记录对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<GroupCompletion>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ActorID = init.ActorID ?? 0;
    this.Reason = init.Reason ?? "";
    this.SourceSessionID = init.SourceSessionID ?? "";
    this.SourceGenerationID = init.SourceGenerationID ?? "";
    this.SourceMessageIndex = init.SourceMessageIndex ?? 0;
    this.SourceHistoryRevision = init.SourceHistoryRevision ?? 0;
    this.CreatedAt = init.CreatedAt ?? null;
  }
}

module.exports = { GroupCompletion };
