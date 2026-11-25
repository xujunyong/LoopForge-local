// run.js —— 对应 Go 文件：internal/domain/run.go
// 作用：运行、节点运行与遥测事件类型。

"use strict";

// Run：一次运行。
class Run {
  constructor(init = {}) {
    this.Kind = init.Kind ?? "";
    this.ID = init.ID ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.WorkflowSnapshot = init.WorkflowSnapshot ?? new WorkflowDefinition();
    this.SandboxID = init.SandboxID ?? "";
    this.OwnerInstanceID = init.OwnerInstanceID ?? "";
    this.LeaseUntil = init.LeaseUntil ?? null;
    this.Generation = init.Generation ?? 0;
    this.WorkspaceHost = init.WorkspaceHost ?? "";
    this.WorkspaceEditorID = init.WorkspaceEditorID ?? 0;
    this.WorkspaceEditUntil = init.WorkspaceEditUntil ?? null;
    this.WorkspaceRoot = init.WorkspaceRoot ?? "";
    this.WorkspaceCleanedAt = init.WorkspaceCleanedAt ?? null;
    // WorkspaceCleanupNotBefore 推迟终态工作区的删除，预览终结器仍需运行目录时用；零值表示不保留。
    this.WorkspaceCleanupNotBefore = init.WorkspaceCleanupNotBefore ?? null;
    this.Status = init.Status ?? "";
    this.AdmissionState = init.AdmissionState ?? "";
    this.QueueEnteredAt = init.QueueEnteredAt ?? null;
    this.ConcurrencyExempt = init.ConcurrencyExempt ?? false;
    this.CancelRequested = init.CancelRequested ?? false;
    this.PauseRequested = init.PauseRequested ?? false;
    this.Input = init.Input ?? "";
    this.Repository = init.Repository ?? new RepositoryContext();
    // Repositories 列出冻结进本次运行的全部仓库；Repository 镜像第一项，旧读者（界面卡片、任务）继续可用；执行逻辑必须遍历 Repositories，把各项同等对待；旧运行只有 Repository。
    this.Repositories = init.Repositories ?? [];
    this.ExecutionContext = init.ExecutionContext ?? new TelemetryContext();
    this.Nodes = init.Nodes ?? {};
    this.Events = init.Events ?? [];
    this.Telemetry = init.Telemetry ?? [];
    this.TelemetrySequence = init.TelemetrySequence ?? 0;
    this.Logs = init.Logs ?? [];
    this.LogSequence = init.LogSequence ?? 0;
    this.Usage = init.Usage ?? new TokenUsage();
    this.ToolCalls = init.ToolCalls ?? 0;
    this.Artifacts = init.Artifacts ?? [];
    this.ArtifactCount = init.ArtifactCount ?? 0;
    this.HumanContext = init.HumanContext ?? "";
    this.Timing = init.Timing ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
    this.Revision = init.Revision ?? 0;
  }

  // IsWorkspace：区分按需聊天工作区与定时 SOP。
  IsWorkspace() {
    return this.Kind === RunKindWorkspace;
  }

  // IsPersonalWorkspace：标识访问范围限于其所有者的工作区。
  IsPersonalWorkspace() {
    return this.IsWorkspace() && this.ExecutionContext.ProjectID === "";
  }

  // LiveWorkspace：报告可编辑的聊天工作区；它没有可暂停的 SOP 图，主 Bot 与 IDE 里的人并排编辑，靠 expectedSha256 捕获冲突写入。
  LiveWorkspace() {
    return this.IsWorkspace() && !this.CancelRequested && this.WorkspaceCleanedAt == null && (this.Status === "running" || this.Status === "waiting");
  }

  // HumanEditable：报告人是否可在 IDE 里编辑工作区；像 AI IDE 一样随时可编辑，SOP 智能体运行时也不例外：什么都不暂停，expectedSha256 捕获冲突写入，智能体重读改动。
  HumanEditable() {
    if (this.WorkspaceCleanedAt != null) {
      return false;
    }
    switch (this.Status) {
      case "succeeded":
      case "failed":
      case "cancelled":
        return true;
      case "running":
      case "waiting":
        return !this.CancelRequested;
    }
    return false;
  }

  // HistoricalGroup：已退役角色组的记录；没有可恢复或重试的 SOP 图。
  HistoricalGroup() {
    return !this.IsWorkspace() && this.WorkflowSnapshot.CollaborationMode === "group";
  }

  // HasActiveNode：报告运行是否有节点仍在执行：正在运行，或因智能体中途索要输入而暂停。
  HasActiveNode() {
    for (const nr of Object.values(this.Nodes ?? {})) {
      if (nr != null && (nr.Status === "running" || nr.Status === "pending_input")) {
        return true;
      }
    }
    return false;
  }

  // RepositoryContexts：返回本次运行冻结的仓库；新运行填 Repositories，旧运行只有单个 Repository 字段。
  RepositoryContexts() {
    if ((this.Repositories ?? []).length > 0) {
      return this.Repositories;
    }
    if (!this.Repository.IsZero()) {
      return [this.Repository];
    }
    return null;
  }

  // UnmarshalJSON：把共享沙箱实例从历史节点运行里提升上来；NodeRun.SandboxID 在引擎过渡期仍可读，新客户端用运行级字段。
  // Go 用别名类型避免递归；这里按 json tag 逐字段映射，时间字符串译为 Date。
  unmarshalJSON(raw) {
    const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    const value = JSON.parse(text);
    const fieldMap = { kind: "Kind", id: "ID", workflowId: "WorkflowID", workflowSnapshot: "WorkflowSnapshot", sandboxId: "SandboxID", ownerInstanceId: "OwnerInstanceID", leaseUntil: "LeaseUntil", executionGeneration: "Generation", workspaceHost: "WorkspaceHost", workspaceEditorId: "WorkspaceEditorID", workspaceEditUntil: "WorkspaceEditUntil", workspaceRoot: "WorkspaceRoot", workspaceCleanedAt: "WorkspaceCleanedAt", workspaceCleanupNotBefore: "WorkspaceCleanupNotBefore", status: "Status", admissionState: "AdmissionState", queueEnteredAt: "QueueEnteredAt", concurrencyExempt: "ConcurrencyExempt", cancelRequested: "CancelRequested", pauseRequested: "PauseRequested", input: "Input", repository: "Repository", repositories: "Repositories", executionContext: "ExecutionContext", nodes: "Nodes", events: "Events", telemetry: "Telemetry", telemetrySequence: "TelemetrySequence", logs: "Logs", logSequence: "LogSequence", usage: "Usage", toolCalls: "ToolCalls", artifacts: "Artifacts", artifactCount: "ArtifactCount", humanContext: "HumanContext", timing: "Timing", createdAt: "CreatedAt", updatedAt: "UpdatedAt", revision: "Revision" };
    const timeFields = new Set(["LeaseUntil", "WorkspaceEditUntil", "WorkspaceCleanedAt", "WorkspaceCleanupNotBefore", "QueueEnteredAt", "CreatedAt", "UpdatedAt"]);
    const mapped = {};
    for (const [key, field] of Object.entries(fieldMap)) {
      if (value[key] === undefined) {
        continue;
      }
      mapped[field] = timeFields.has(field) && value[key] != null ? new Date(value[key]) : value[key];
    }
    if (value.nodes != null) {
      const nodeFieldMap = { nodeId: "NodeID", status: "Status", attempt: "Attempt", reworkCount: "ReworkCount", sandboxId: "SandboxID", output: "Output", error: "Error", provider: "Provider", model: "Model", sessionId: "SessionID", resumeSessionId: "ResumeSessionID", activity: "Activity", feedback: "Feedback", usage: "Usage", usageSessionId: "UsageSessionID", usageCursor: "UsageCursor", toolCalls: "ToolCalls", gateResult: "GateResult", childRunId: "ChildRunID", startedAt: "StartedAt", finishedAt: "FinishedAt" };
      const nodes = {};
      for (const [nodeID, node] of Object.entries(value.nodes)) {
        if (node == null) {
          nodes[nodeID] = null;
          continue;
        }
        const nodeMapped = {};
        for (const [key, field] of Object.entries(nodeFieldMap)) {
          if (node[key] === undefined) {
            continue;
          }
          nodeMapped[field] = (field === "StartedAt" || field === "FinishedAt") && node[key] != null ? new Date(node[key]) : node[key];
        }
        nodes[nodeID] = new NodeRun(nodeMapped);
      }
      mapped.Nodes = nodes;
    }
    Object.assign(this, new Run(mapped));
    if (this.SandboxID !== "") {
      return;
    }
    for (const node of Object.values(this.Nodes ?? {})) {
      if (node == null || (node.SandboxID ?? "").trim() === "") {
        continue;
      }
      if (this.SandboxID !== "" && this.SandboxID !== node.SandboxID) {
        throw new Error(`run ${JSON.stringify(this.ID)} has conflicting legacy node sandbox ids ${JSON.stringify(this.SandboxID)} and ${JSON.stringify(node.SandboxID)}`);
      }
      this.SandboxID = node.SandboxID;
    }
  }
}

const RunKindWorkspace = "workspace";
const ConversationWorkspaceWorkflowID = "conversation-workspace";

// NodeRun：一个节点的运行记录。
class NodeRun {
  constructor(init = {}) {
    this.NodeID = init.NodeID ?? "";
    this.Status = init.Status ?? "";
    this.Attempt = init.Attempt ?? 0;
    this.ReworkCount = init.ReworkCount ?? 0;
    this.SandboxID = init.SandboxID ?? "";
    this.Output = init.Output ?? "";
    this.Error = init.Error ?? "";
    this.Provider = init.Provider ?? "";
    this.Model = init.Model ?? "";
    this.SessionID = init.SessionID ?? "";
    this.ResumeSessionID = init.ResumeSessionID ?? "";
    this.Activity = init.Activity ?? "";
    this.Feedback = init.Feedback ?? "";
    this.Usage = init.Usage ?? new TokenUsage();
    this.UsageSessionID = init.UsageSessionID ?? "";
    this.UsageCursor = init.UsageCursor ?? new TokenUsage();
    this.ToolCalls = init.ToolCalls ?? 0;
    this.GateResult = init.GateResult ?? null;
    this.ChildRunID = init.ChildRunID ?? "";
    this.StartedAt = init.StartedAt ?? null;
    this.FinishedAt = init.FinishedAt ?? null;
  }
}

// GateResult：Agent 通过调用期 submit_gate_result MCP 工具提交的结构化终态决定。
class GateResult {
  constructor(init = {}) {
    this.Decision = init.Decision ?? "";
    this.Reason = init.Reason ?? "";
    this.ActionRequired = init.ActionRequired ?? "";
    this.Summary = init.Summary ?? "";
    this.Findings = init.Findings ?? [];
  }
}

// GateFinding：门禁决定里的一项发现。
class GateFinding {
  constructor(init = {}) {
    this.Severity = init.Severity ?? "";
    this.Title = init.Title ?? "";
    this.Evidence = init.Evidence ?? "";
  }
}

// TokenUsage：一次调用的 token 用量。
class TokenUsage {
  constructor(init = {}) {
    this.InputTokens = init.InputTokens ?? 0;
    this.OutputTokens = init.OutputTokens ?? 0;
    this.CacheReadTokens = init.CacheReadTokens ?? 0;
    this.CacheWriteTokens = init.CacheWriteTokens ?? 0;
    this.TotalTokens = init.TotalTokens ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.ReasoningTokens = init.ReasoningTokens ?? 0;
    this.ContextWindow = init.ContextWindow ?? 0;
    // CostStatus 区分"成本为 0"与"成本未知"：reported（适配器上报）、estimated（按 token 估算）、unknown（未识别，展示为"未识别"而不是 ¥0）。空值视为 unknown，旧数据向后兼容。
    this.CostStatus = init.CostStatus ?? "";
  }
}

// TelemetryEvent：一条遥测事件。
class TelemetryEvent {
  constructor(init = {}) {
    this.SpecVersion = init.SpecVersion ?? "";
    this.ID = init.ID ?? "";
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Sequence = init.Sequence ?? 0;
    this.Timestamp = init.Timestamp ?? null;
    this.Category = init.Category ?? "";
    this.Name = init.Name ?? "";
    this.Phase = init.Phase ?? "";
    this.Level = init.Level ?? "";
    this.Message = init.Message ?? "";
    this.Provider = init.Provider ?? "";
    this.Model = init.Model ?? "";
    this.SessionID = init.SessionID ?? "";
    this.ToolCallID = init.ToolCallID ?? "";
    this.ParentID = init.ParentID ?? "";
    this.Usage = init.Usage ?? null;
    this.Attributes = init.Attributes ?? {};
    this.Source = init.Source ?? new TelemetrySource();
    this.Context = init.Context ?? new TelemetryContext();
    this.Metrics = init.Metrics ?? [];
    this.Tool = init.Tool ?? null;
    this.ModelOperation = init.ModelOperation ?? null;
    this.Error = init.Error ?? null;
  }
}

// RunEvent：运行事件日志里的一条。
class RunEvent {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Type = init.Type ?? "";
    this.Message = init.Message ?? "";
    this.Timestamp = init.Timestamp ?? null;
  }
}

// Artifact：不可变的、按尝试区分的快照；保留旧尝试可让返工审计， 下游节点消费最新的成功版本。
class Artifact {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Attempt = init.Attempt ?? 0;
    this.Name = init.Name ?? "";
    this.Path = init.Path ?? "";
    this.MediaType = init.MediaType ?? "";
    this.Size = init.Size ?? 0;
    this.SHA256 = init.SHA256 ?? "";
    this.Content = init.Content ?? "";
    // RepositoryDir 记录产物取自哪个运行仓库工作区（空为运行工作区根目录，SOP 交付物所在处）。
    this.RepositoryDir = init.RepositoryDir ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
  }
}

module.exports = { Run, RunKindWorkspace, ConversationWorkspaceWorkflowID, NodeRun, GateResult, GateFinding, TokenUsage, TelemetryEvent, RunEvent, Artifact };
