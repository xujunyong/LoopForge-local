// mr_delivery.js —— 对应 Go 文件：internal/domain/mr_delivery.go
// 作用：工蜂 MR 合并状态的持久化记录与 MR 标识。

"use strict";

// MRDeliveryState：工蜂 MR 的合并状态，供交付分析使用。
class MRDeliveryState {
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

// MRDeliveryKey：一个工蜂 MR 的标识。
class MRDeliveryKey {
  constructor(init = {}) {
    this.Project = init.Project ?? "";
    this.IID = init.IID ?? 0;
  }
}

module.exports = { MRDeliveryState, MRDeliveryKey };
