/**
 * @file internal/domain/workflow.js
 * @description 对应 Go 文件：internal/domain/workflow.go
 * 职责与边界：定义 SOP 工作流的核心领域模型，包括核查门（VerificationGate）、画布坐标、前置能力需求、
 * 节点（WorkflowNode）、边、产物契约、定义修订快照、SOP 检查点、协作组交接记录、工作流定义（含旧版 JSON 迁移反序列化），
 * 以及工作流与节点运行指标类型和度量阶段校验函数。
 * 语法差异说明：
 * - Go 切片零值初始化为 `[]`，普通映射 `map[string]V` 初始化为 `{}`，指针、`json.RawMessage` 与 `time.Time` 初始化为 `null`。
 * - Go 的 `error` 返回译为成功无返回值、失败 `throw Error`。
 */

"use strict";

/**
 * 描述节点或发布前需要通过的单个核查门配置（命令门、人工门或 MR 门）。
 */
class VerificationGate {
  /**
   * 构造核查门实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Mode = init.Mode ?? "";
    this.Stage = init.Stage ?? "";
    this.Commands = init.Commands ?? [];
    this.Required = init.Required ?? false;
    this.OnFailure = init.OnFailure ?? "";
    this.ExecutionScope = init.ExecutionScope ?? "";
  }
}

/**
 * 表示工作流节点在可视化编排画布上的二维坐标。
 */
class Position {
  /**
   * 构造画布坐标实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.X = init.X ?? 0;
    this.Y = init.Y ?? 0;
  }
}

/**
 * 声明一条 SOP 端到端交付前所需的外部前置能力（如 Git Token 或外部追踪系统 MCP），用于采用模板前的预检清单展示。
 */
class WorkflowRequirement {
  /**
   * 构造工作流前置能力需求实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Key = init.Key ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Label = init.Label ?? "";
    this.Hint = init.Hint ?? "";
    this.Setup = init.Setup ?? "";
  }
}

/**
 * 表示 SOP 工作流中的单个执行节点（Agent 角色、脚本、审批或子 SOP 节点）。
 */
class WorkflowNode {
  /**
   * 构造工作流节点实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.TaskPrompt = init.TaskPrompt ?? "";
    this.RequestedBy = init.RequestedBy ?? "";
    this.RequestID = init.RequestID ?? "";
    this.ClaimedFiles = init.ClaimedFiles ?? [];
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
    this.CredentialEnv = init.CredentialEnv ?? {};
    this.ExecutionScope = init.ExecutionScope ?? "";
    this.Command = init.Command ?? "";
    this.ArtifactOutputs = init.ArtifactOutputs ?? [];
    this.RejectTo = init.RejectTo ?? "";
    this.OnFailure = init.OnFailure ?? "";
    this.RetryStrategy = init.RetryStrategy ?? "";
    this.CarryOver = init.CarryOver ?? [];
    this.MaxAttempts = init.MaxAttempts ?? 0;
    this.MaxReworks = init.MaxReworks ?? 0;
    this.Notifications = init.Notifications ?? [];
    this.Position = init.Position ?? null;
  }
}

/**
 * 校验工作流中所有节点的 `MetricStage` 字段，防止拼写错误的统计阶段被静默丢弃。
 * 在创建或更新工作流定义时调用。
 * @param {WorkflowDefinition} workflow - 待校验的工作流定义对象。
 * @returns {void} 无返回值；发现不支持的 `MetricStage` 时抛出异常。
 */
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

/**
 * 描述工作流节点声明的输出产物契约（产物名称、相对工作区路径、媒体类型与是否必需）。
 */
class ArtifactContract {
  /**
   * 构造产物输出契约实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Name = init.Name ?? "";
    this.Path = init.Path ?? "";
    this.MediaType = init.MediaType ?? "";
    this.Required = init.Required ?? false;
  }
}

/**
 * 表示工作流有向图中连接源节点与目标节点的流转边。
 */
class WorkflowEdge {
  /**
   * 构造工作流边实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Source = init.Source ?? "";
    this.Target = init.Target ?? "";
    this.When = init.When ?? "";
  }
}

/**
 * 表示工作流或 Agent 的不可变版本修订快照，用于差异对比与版本回滚恢复。
 */
class DefinitionRevision {
  /**
   * 构造定义修订快照实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

/**
 * 冻结在运行记录 JSON 中的 SOP 检查点快照（不会出现在目录定义中），保存当时工作流与节点状态映射。
 */
class SOPCheckpoint {
  /**
   * 构造 SOP 检查点实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Workflow = init.Workflow ?? null;
    this.Nodes = init.Nodes ?? {};
  }
}

/**
 * 记录协作组模式中单个任务节点的定义及其最终运行状态快照。
 */
class GroupTaskHistory {
  /**
   * 构造协作组任务历史条目实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Node = init.Node ?? null;
    this.State = init.State ?? null;
  }
}

/**
 * 指向已归档的不可变上下文摘要与对话转录，供协作组恢复 SOP 节点时衔接上下文（仅存在于运行快照）。
 */
class GroupSOPHandoff {
  /**
   * 构造协作组交接记录实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示完整的 SOP 工作流定义（可作为目录模板存储，也可在启动运行时冻结为 `Run.WorkflowSnapshot`）。
 */
class WorkflowDefinition {
  /**
   * 构造工作流定义实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.GroupSOPHandoff = init.GroupSOPHandoff ?? null;
    this.GroupCompletion = init.GroupCompletion ?? null;
    this.GroupMembers = init.GroupMembers ?? [];
    this.SOPCheckpoint = init.SOPCheckpoint ?? null;
    this.GroupHistory = init.GroupHistory ?? [];
    this.GroupPlan = init.GroupPlan ?? [];
    this.CollaborationMode = init.CollaborationMode ?? "";
    this.TaskTitle = init.TaskTitle ?? "";
    this.Notifications = init.Notifications ?? [];
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Version = init.Version ?? 0;
    this.Revision = init.Revision ?? 0;
    this.PublishedRevision = init.PublishedRevision ?? 0;
    this.Status = init.Status ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Shared = init.Shared ?? false;
    this.Owner = init.Owner ?? "";
    this.Tags = init.Tags ?? [];
    this.Description = init.Description ?? "";
    this.SandboxProfileID = init.SandboxProfileID ?? "";
    this.MetricCategory = init.MetricCategory ?? "";
    this.SOPLane = init.SOPLane ?? "";
    this.Generic = init.Generic ?? false;
    this.Requirements = init.Requirements ?? [];
    this.SandboxSnapshot = init.SandboxSnapshot ?? null;
    this.Preview = init.Preview ?? null;
    this.Nodes = init.Nodes ?? [];
    this.Edges = init.Edges ?? [];
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
    this.ExecutorDefaults = init.ExecutorDefaults ?? {};
  }

  /**
   * 从 JSON 反序列化工作流定义，并兼容迁移节点级旧版沙箱配置字段（`sandboxProfileId` 与 `workspacePreparation`）。
   * 若多个旧节点声明了互相冲突的沙箱配置，或与工作流级 `SandboxProfileID` 冲突，则抛出错误拒绝静默猜测。
   * @param {string|Buffer} raw - 待解析的 JSON 字节或字符串。
   * @returns {void} 无返回值；JSON 解析失败或存在沙箱配置冲突时抛出异常。
   */
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

/**
 * 表示单条工作流的聚合运行统计指标，包含成功率、返工率、平均耗时、近期运行摘要与各节点指标。
 */
class WorkflowMetrics {
  /**
   * 构造工作流运行指标实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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
    this.RecentRuns = init.RecentRuns ?? [];
    this.NodeMetrics = init.NodeMetrics ?? [];
  }
}

/**
 * 表示单次工作流运行的精简指标摘要，用于近期运行趋势展示。
 */
class RunSummary {
  /**
   * 构造运行摘要实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示工作流中单个节点的执行次数、成功率、返工数与平均耗时统计。
 */
class WorkflowNodeMetric {
  /**
   * 构造工作流节点指标实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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
