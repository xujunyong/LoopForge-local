// requirement.js —— 对应 Go 文件：internal/domain/requirement.go
// 作用：需求总览快照与多通道进度类型。

"use strict";

// RequirementNodeStage：需求视图里的一个节点阶段。
class RequirementNodeStage {
  constructor(init = {}) {
    this.NodeID = init.NodeID ?? "";
    this.Name = init.Name ?? "";
    this.Status = init.Status ?? "";
    this.DurationMs = init.DurationMs ?? 0;
    // ChildRunID 与 Children 描述 SOP 节点启动的子运行。
    this.ChildRunID = init.ChildRunID ?? "";
    this.Children = init.Children ?? [];
  }
}

// RequirementLane：需求的一条执行通道。
class RequirementLane {
  constructor(init = {}) {
    this.BindingID = init.BindingID ?? "";
    this.Lane = init.Lane ?? "";
    this.Label = init.Label ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.WorkflowName = init.WorkflowName ?? "";
    this.LatestRunID = init.LatestRunID ?? "";
    this.LatestTaskID = init.LatestTaskID ?? "";
    this.Status = init.Status ?? "";
    this.Started = init.Started ?? false;
    this.RunCount = init.RunCount ?? 0;
    this.FailedRuns = init.FailedRuns ?? 0;
    this.Tokens = init.Tokens ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.ExecutionDurationMs = init.ExecutionDurationMs ?? 0;
    this.AssigneeUserID = init.AssigneeUserID ?? 0;
    this.Order = init.Order ?? 0;
    this.DependsOn = init.DependsOn ?? [];
    this.Handoff = init.Handoff ?? [];
    this.Orphan = init.Orphan ?? false;
    this.Stages = init.Stages ?? [];
  }
}

// RequirementStage：需求的一个阶段。
class RequirementStage {
  constructor(init = {}) {
    this.Key = init.Key ?? "";
    this.Label = init.Label ?? "";
    this.Status = init.Status ?? "";
    this.Hint = init.Hint ?? "";
  }
}

// RequirementOverall：需求的总体汇总。
class RequirementOverall {
  constructor(init = {}) {
    this.RunCount = init.RunCount ?? 0;
    this.FailedRuns = init.FailedRuns ?? 0;
    this.SucceededLanes = init.SucceededLanes ?? 0;
    this.ActiveLanes = init.ActiveLanes ?? 0;
    this.Tokens = init.Tokens ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.CostKnown = init.CostKnown ?? false;
    this.ExecutionDurationMs = init.ExecutionDurationMs ?? 0;
    this.CycleDurationMs = init.CycleDurationMs ?? 0;
    this.FirstRunAt = init.FirstRunAt ?? null;
    this.LastRunAt = init.LastRunAt ?? null;
    this.Status = init.Status ?? "";
  }
}

// RequirementSnapshot：需求快照。
class RequirementSnapshot {
  constructor(init = {}) {
    this.Issue = init.Issue ?? new Issue();
    this.Overall = init.Overall ?? new RequirementOverall();
    this.Lanes = init.Lanes ?? [];
    this.Stages = init.Stages ?? [];
    // Conversation 用于在对话工作区而非 SOP 里处理的需求。
    this.Conversation = init.Conversation ?? null;
  }
}

// RequirementConversation：需求所在的对话，代码直接改在对话工作区。
class RequirementConversation {
  constructor(init = {}) {
    // SessionID 是创建该需求的对话；需求来自别处时为空。
    this.SessionID = init.SessionID ?? "";
    // Available 在该对话被删除后为 false。
    this.Available = init.Available ?? false;
    // Branches 是其对话工作区的工作分支。
    this.Branches = init.Branches ?? [];
  }
}

// RequirementBranch：对话工作区检出的一个仓库。
class RequirementBranch {
  constructor(init = {}) {
    this.Repository = init.Repository ?? "";
    this.WebURL = init.WebURL ?? "";
    this.BaseBranch = init.BaseBranch ?? "";
    this.WorkBranch = init.WorkBranch ?? "";
  }
}

module.exports = { RequirementNodeStage, RequirementLane, RequirementStage, RequirementOverall, RequirementSnapshot, RequirementConversation, RequirementBranch };
