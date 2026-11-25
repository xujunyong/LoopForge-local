// group_completion.js —— 对应 Go 文件：internal/domain/group_completion.go
// 作用：独立于节点执行与验证结果的交付验收记录。

"use strict";

// GroupCompletion：一次交付验收，验收结果不把跳过的测试变通过。
class GroupCompletion {
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
