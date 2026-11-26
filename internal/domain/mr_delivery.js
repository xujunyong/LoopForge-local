/**
 * 对应 Go 文件：internal/domain/mr_delivery.go
 * 作用：定义工蜂 MR 合并状态的持久化记录结构以及 MR 复合主键标识。
 * 职责边界：仅负责 MR 交付状态持久化模型的数据定义，不包含后台轮询同步或数据库读写逻辑。
 * 语法差异说明：Go 的 time.Time 对应 Date，零值为 null。
 */

"use strict";

/**
 * 持久化保存的工蜂 MR 合并状态记录，供交付分析统计使用。
 * 记录来源于运行产物（工作分支到基线）及基线到默认分支的提升 MR，由后台同步任务定期刷新。
 */
class MRDeliveryState {
  /**
   * 构造 MR 交付状态记录对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<MRDeliveryState>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.MRProject = init.MRProject ?? "";
    this.MRIID = init.MRIID ?? 0;
    this.MRURL = init.MRURL ?? "";
    this.State = init.State ?? "";
    this.TargetBranch = init.TargetBranch ?? "";
    this.IssueID = init.IssueID ?? "";
    this.RegisteredBy = init.RegisteredBy ?? 0;
    this.MergedAt = init.MergedAt ?? null;
    this.CheckedAt = init.CheckedAt ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

/**
 * 唯一标识一条工蜂合并请求的复合键（项目标识 + MR 编号）。
 */
class MRDeliveryKey {
  /**
   * 构造 MR 标识键对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<MRDeliveryKey>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Project = init.Project ?? "";
    this.IID = init.IID ?? 0;
  }
}

module.exports = { MRDeliveryState, MRDeliveryKey };
