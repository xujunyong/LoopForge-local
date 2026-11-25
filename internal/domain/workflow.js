// workflow.js —— 对应 Go 文件：internal/domain/workflow.go
// 作用：SOP 工作流定义、节点、边与核查门，以及运行指标类型。

"use strict";

class VerificationGate {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Mode = init.Mode ?? "";
    this.Stage = init.Stage ?? "";
    this.Commands = init.Commands ?? null;
    this.Required = init.Required ?? false;
    this.OnFailure = init.OnFailure ?? "";
    this.ExecutionScope = init.ExecutionScope ?? "";
  }
}

class Position {
  constructor(init = {}) {
    this.X = init.X ?? 0;
    this.Y = init.Y ?? 0;
  }
}

// WorkflowRequirement：SOP 交付前需要的外部能力。
class WorkflowRequirement {
  constructor(init = {}) {
    this.Key = init.Key ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Label = init.Label ?? "";
    this.Hint = init.Hint ?? "";
    this.Setup = init.Setup ?? "";
  }
}

class WorkflowNode {
  constructor(init = {}) {
    this.TaskPrompt = init.TaskPrompt ?? "";
    this.RequestedBy = init.RequestedBy ?? "";
    this.RequestID = init.RequestID ?? "";
    this.ClaimedFiles = init.ClaimedFiles ?? null;
    this.PlanItemID = init.PlanItemID ?? "";
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Type = init.Type ?? "";
    this.MetricStage = init.MetricStage ?? "";
    this.AgentID = init.AgentID ?? "";
    this.ExecutorID = init.ExecutorID ?? "";
    this.SOPWorkflowID = init.SOPWorkflowID ?? "";
    this.RunOnWorkspaceRebuild = init.RunOnWorkspaceRebuild ?? false;
    this.ScriptLanguage = init.ScriptLanguage ?? "";
    this.Script = init.Script ?? "";
    this.CredentialEnv = init.CredentialEnv ?? null;
    this.ExecutionScope = init.ExecutionScope ?? "";
    this.Command = init.Command ?? "";
    this.ArtifactOutputs = init.ArtifactOutputs ?? null;
    this.RejectTo = init.RejectTo ?? "";
    this.OnFailure = init.OnFailure ?? "";
    this.RetryStrategy = init.RetryStrategy ?? "";
    this.CarryOver = init.CarryOver ?? null;
    this.MaxAttempts = init.MaxAttempts ?? 0;
    this.MaxReworks = init.MaxReworks ?? 0;
    this.Notifications = init.Notifications ?? null;
    this.Position = init.Position ?? null;
  }
}

// ValidateWorkflowMetricStages：防止写错的 metricStage 被静默丢弃。
function ValidateWorkflowMetricStages(workflow) {
  for (const node of workflow.Nodes ?? []) {
    switch (node.MetricStage) {
      case "":
      case "clarification":
      case "development":
      case "testing":
      case "none":
        break;
      default:
        throw new Error(`workflow node ${JSON.stringify(node.ID)} has unsupported metricStage ${JSON.stringify(node.MetricStage)}`);
    }
  }
}

// ArtifactContract：工作流节点声明的输出契约。
class ArtifactContract {
  constructor(init = {}) {
    this.Name = init.Name ?? "";
    this.Path = init.Path ?? "";
    this.MediaType = init.MediaType ?? "";
    this.Required = init.Required ?? false;
  }
}

class WorkflowEdge {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Source = init.Source ?? "";
    this.Target = init.Target ?? "";
    this.When = init.When ?? "";
  }
}

// DefinitionRevision：工作流或 agent 的不可变快照。
class DefinitionRevision {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Kind = init.Kind ?? "";
    this.EntityID = init.EntityID ?? "";
    this.Version = init.Version ?? 0;
    this.Revision = init.Revision ?? 0;
    this.Name = init.Name ?? "";
    this.Summary = init.Summary ?? "";
    this.Payload = init.Payload ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
  }
}

// SOPCheckpoint：冻结在运行 JSON 里，从不在目录定义中出现。
class SOPCheckpoint {
  constructor(init = {}) {
    this.Workflow = init.Workflow ?? null;
    this.Nodes = init.Nodes ?? null;
  }
}

class GroupTaskHistory {
  constructor(init = {}) {
    this.Node = init.Node ?? null;
    this.State = init.State ?? null;
  }
}

// GroupSOPHandoff：指向已归档上下文，供恢复的 SOP 节点使用。
class GroupSOPHandoff {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.SummaryPath = init.SummaryPath ?? "";
    this.TranscriptPath = init.TranscriptPath ?? "";
    this.SummaryArtifactID = init.SummaryArtifactID ?? "";
    this.TranscriptArtifactID = init.TranscriptArtifactID ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
  }
}

class WorkflowDefinition {
  constructor(init = {}) {
    this.GroupSOPHandoff = init.GroupSOPHandoff ?? null;
    this.GroupCompletion = init.GroupCompletion ?? null;
    this.GroupMembers = init.GroupMembers ?? null;
    this.SOPCheckpoint = init.SOPCheckpoint ?? null;
    this.GroupHistory = init.GroupHistory ?? null;
    this.GroupPlan = init.GroupPlan ?? null;
    this.CollaborationMode = init.CollaborationMode ?? "";
    this.TaskTitle = init.TaskTitle ?? "";
    this.Notifications = init.Notifications ?? null;
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Version = init.Version ?? 0;
    this.Revision = init.Revision ?? 0;
    this.PublishedRevision = init.PublishedRevision ?? 0;
    this.Status = init.Status ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Shared = init.Shared ?? false;
    this.Owner = init.Owner ?? "";
    this.Tags = init.Tags ?? null;
    this.Description = init.Description ?? "";
    this.SandboxProfileID = init.SandboxProfileID ?? "";
    this.MetricCategory = init.MetricCategory ?? "";
    this.SOPLane = init.SOPLane ?? "";
    this.Generic = init.Generic ?? false;
    this.Requirements = init.Requirements ?? null;
    this.SandboxSnapshot = init.SandboxSnapshot ?? null;
    this.Preview = init.Preview ?? null;
    this.Nodes = init.Nodes ?? null;
    this.Edges = init.Edges ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
    this.ExecutorDefaults = init.ExecutorDefaults ?? null;
  }

  // UnmarshalJSON：迁移旧版工作流沙箱形态，节点上的旧字段仍可见时做兼容。
  UnmarshalJSON(raw) {
    const value = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    // JSON 键（小驼峰）到 Go 字段名的映射，未列出的按首字母大写。
    const cap = (k) => k.charAt(0).toUpperCase() + k.slice(1);
    const keyMap = {
      id: "ID", projectId: "ProjectID", sandboxProfileId: "SandboxProfileID",
      sopLane: "SOPLane", groupSopHandoff: "GroupSOPHandoff", sopCheckpoint: "SOPCheckpoint",
    };
    const nodeKeyMap = {
      id: "ID", requestId: "RequestID", planItemId: "PlanItemID",
      agentId: "AgentID", executorId: "ExecutorID", sopWorkflowId: "SOPWorkflowID",
    };
    // Go 先把整个结构重置为零值，再填入 JSON 字段。
    const fresh = new WorkflowDefinition();
    Object.assign(this, fresh);
    const legacyNodes = value.nodes ?? [];
    for (const [k, v] of Object.entries(value)) {
      if (k === "nodes") {
        continue;
      }
      this[keyMap[k] ?? cap(k)] = v;
    }
    if (typeof this.CreatedAt === "string") {
      this.CreatedAt = new Date(this.CreatedAt);
    }
    if (typeof this.UpdatedAt === "string") {
      this.UpdatedAt = new Date(this.UpdatedAt);
    }
    this.Nodes = [];
    let legacyProfile = "";
    for (const node of legacyNodes) {
      const mapped = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === "sandboxProfileId" || k === "runOnWorkspaceRebuild" || k === "workspacePreparation") {
          continue;
        }
        mapped[nodeKeyMap[k] ?? cap(k)] = v;
      }
      const wn = new WorkflowNode(mapped);
      if (node.runOnWorkspaceRebuild !== undefined && node.runOnWorkspaceRebuild !== null) {
        wn.RunOnWorkspaceRebuild = node.runOnWorkspaceRebuild;
      } else if (node.workspacePreparation === "environment" || node.workspacePreparation === "code") {
        wn.RunOnWorkspaceRebuild = true;
      }
      this.Nodes.push(wn);
      const profile = (node.sandboxProfileId ?? "").trim();
      if (profile === "") {
        continue;
      }
      if (legacyProfile !== "" && profile !== legacyProfile) {
        throw new Error(`workflow ${JSON.stringify(this.ID)} has conflicting legacy node sandbox profiles ${JSON.stringify(legacyProfile)} and ${JSON.stringify(profile)}`);
      }
      legacyProfile = profile;
    }
    if (this.SandboxProfileID === "") {
      this.SandboxProfileID = legacyProfile;
    } else if (legacyProfile !== "" && this.SandboxProfileID !== legacyProfile) {
      throw new Error(`workflow ${JSON.stringify(this.ID)} sandbox profile ${JSON.stringify(this.SandboxProfileID)} conflicts with legacy node profile ${JSON.stringify(legacyProfile)}`);
    }
  }
}

class WorkflowMetrics {
  constructor(init = {}) {
    this.WorkflowID = init.WorkflowID ?? "";
    this.TotalRuns = init.TotalRuns ?? 0;
    this.ActiveRuns = init.ActiveRuns ?? 0;
    this.WaitingRuns = init.WaitingRuns ?? 0;
    this.SucceededRuns = init.SucceededRuns ?? 0;
    this.FailedRuns = init.FailedRuns ?? 0;
    this.CancelledRuns = init.CancelledRuns ?? 0;
    this.ReworkedRuns = init.ReworkedRuns ?? 0;
    this.ClosureRate = init.ClosureRate ?? 0;
    this.SuccessRate = init.SuccessRate ?? 0;
    this.ReworkRate = init.ReworkRate ?? 0;
    this.AverageDuration = init.AverageDuration ?? 0;
    this.TotalTokens = init.TotalTokens ?? 0;
    this.TotalToolCalls = init.TotalToolCalls ?? 0;
    this.TotalArtifacts = init.TotalArtifacts ?? 0;
    this.LastRunAt = init.LastRunAt ?? null;
    this.LastRunStatus = init.LastRunStatus ?? "";
    this.RecentRuns = init.RecentRuns ?? null;
    this.NodeMetrics = init.NodeMetrics ?? null;
  }
}

class RunSummary {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Status = init.Status ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
    this.DurationMs = init.DurationMs ?? 0;
    this.ReworkCount = init.ReworkCount ?? 0;
    this.TotalTokens = init.TotalTokens ?? 0;
    this.ToolCalls = init.ToolCalls ?? 0;
    this.Artifacts = init.Artifacts ?? 0;
  }
}

class WorkflowNodeMetric {
  constructor(init = {}) {
    this.NodeID = init.NodeID ?? "";
    this.Name = init.Name ?? "";
    this.Executions = init.Executions ?? 0;
    this.Succeeded = init.Succeeded ?? 0;
    this.Failed = init.Failed ?? 0;
    this.Waiting = init.Waiting ?? 0;
    this.Reworks = init.Reworks ?? 0;
    this.SuccessRate = init.SuccessRate ?? 0;
    this.AverageDuration = init.AverageDuration ?? 0;
  }
}

module.exports = { VerificationGate, Position, WorkflowRequirement, WorkflowNode, ValidateWorkflowMetricStages, ArtifactContract, WorkflowEdge, DefinitionRevision, SOPCheckpoint, GroupTaskHistory, GroupSOPHandoff, WorkflowDefinition, WorkflowMetrics, RunSummary, WorkflowNodeMetric };
