// observability.js —— 对应 Go 文件：internal/domain/observability.go
// 作用：可观测性契约：遥测上下文、指标与日志记录类型。

"use strict";

const ObservabilitySpecVersion = "agentflow.observability/v1";

const ExecutionModeCloud = "cloud";
const ExecutionModeRunner = "runner";
const ExecutionScopeRun = "run";
const ExecutionScopeRepositories = "repositories";

const RunnerWorkspaceLayoutShared = "shared";

// TelemetrySource：标识产生观测的层与归一化它的适配器；调用方不得按原生载荷分支。
class TelemetrySource {
  constructor(init = {}) {
    this.Layer = init.Layer ?? "";
    this.Adapter = init.Adapter ?? "";
    this.Provider = init.Provider ?? "";
    this.Protocol = init.Protocol ?? "";
  }
}

// TelemetryContext：关联三层平台与产品上下文。
class TelemetryContext {
  constructor(init = {}) {
    this.ExecutionPinned = init.ExecutionPinned ?? false;
    this.ProjectID = init.ProjectID ?? "";
    this.IssueID = init.IssueID ?? "";
    // TAPDID 是外部需求键；本地 IssueID 跨导入可能不同。
    this.TAPDID = init.TAPDID ?? "";
    this.ResponsibleUserID = init.ResponsibleUserID ?? 0;
    // ExecutionMode 与 ExecutionRunnerID 在运行开始时冻结执行目标；重试连回该目标，不跟随用户后改的默认执行机。
    this.ExecutionMode = init.ExecutionMode ?? "";
    this.ExecutionRunnerID = init.ExecutionRunnerID ?? "";
    // ExecutionPool 为 "cloud" 表示 ExecutionRunnerID 取自平台执行机池，而非用户默认机器。
    this.ExecutionPool = init.ExecutionPool ?? "";
    // RunnerWorkspaceLayout 冻结自托管执行机把流程节点映射到磁盘的方式；空为旧版每节点布局，shared 让新 Run 的全部节点共用同一仓库与 Git 索引。
    this.RunnerWorkspaceLayout = init.RunnerWorkspaceLayout ?? "";
    this.IssueNumber = init.IssueNumber ?? 0;
    this.TaskID = init.TaskID ?? "";
    this.ScheduleJobID = init.ScheduleJobID ?? "";
    this.SharedScheduleID = init.SharedScheduleID ?? "";
    this.SharedScheduleVersion = init.SharedScheduleVersion ?? 0;
    this.RunID = init.RunID ?? "";
    this.ParentRunID = init.ParentRunID ?? "";
    this.ParentNodeID = init.ParentNodeID ?? "";
    // WorkspaceRunID 是拥有子 SOP 工作区的工作区的运行：其 SOP 链的顶层运行；空表示该运行拥有自己的工作区。
    this.WorkspaceRunID = init.WorkspaceRunID ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.WorkflowVersion = init.WorkflowVersion ?? 0;
    this.NodeID = init.NodeID ?? "";
    this.MetricStage = init.MetricStage ?? "";
    this.Attempt = init.Attempt ?? 0;
    this.AgentID = init.AgentID ?? "";
    this.AgentVersion = init.AgentVersion ?? 0;
    this.ExecutorID = init.ExecutorID ?? "";
    this.SandboxID = init.SandboxID ?? "";
    this.SessionID = init.SessionID ?? "";
    this.TraceID = init.TraceID ?? "";
    this.SpanID = init.SpanID ?? "";
    this.ParentSpanID = init.ParentSpanID ?? "";
  }
}

// MetricPoint：一个指标采样点。
class MetricPoint {
  constructor(init = {}) {
    this.Name = init.Name ?? "";
    this.Value = init.Value ?? 0;
    this.Unit = init.Unit ?? "";
    this.Kind = init.Kind ?? "";
    this.Dimensions = init.Dimensions ?? {};
  }
}

// ToolObservation：一次工具调用的观测。
class ToolObservation {
  constructor(init = {}) {
    this.Name = init.Name ?? "";
    this.Operation = init.Operation ?? "";
    this.CallID = init.CallID ?? "";
    this.Success = init.Success ?? null;
    this.DurationMs = init.DurationMs ?? 0;
  }
}

// ModelObservation：一次模型调用的观测。
class ModelObservation {
  constructor(init = {}) {
    this.Provider = init.Provider ?? "";
    this.Model = init.Model ?? "";
    this.Operation = init.Operation ?? "";
    this.FinishReason = init.FinishReason ?? "";
    this.ContextWindow = init.ContextWindow ?? 0;
  }
}

// ErrorObservation：一次错误的观测。
class ErrorObservation {
  constructor(init = {}) {
    this.Code = init.Code ?? "";
    this.Type = init.Type ?? "";
    this.Message = init.Message ?? "";
    this.Retryable = init.Retryable ?? false;
  }
}

// AdapterDescriptor：一个遥测适配器的描述。
class AdapterDescriptor {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.SpecVersion = init.SpecVersion ?? "";
    this.ExecutorKinds = init.ExecutorKinds ?? [];
    this.NativeProtocols = init.NativeProtocols ?? [];
    this.Capabilities = init.Capabilities ?? [];
    this.RawEventPolicy = init.RawEventPolicy ?? "";
  }
}

// ObservabilitySpec：可观测性规约。
class ObservabilitySpec {
  constructor(init = {}) {
    this.Version = init.Version ?? "";
    this.Categories = init.Categories ?? [];
    this.Phases = init.Phases ?? [];
    this.RequiredContext = init.RequiredContext ?? [];
    this.MetricConventions = init.MetricConventions ?? {};
    this.Adapters = init.Adapters ?? [];
  }
}

// LogRecord：独立的、可按游标寻址的诊断通道；与遥测共享关联信息，但不用于指标聚合。
class LogRecord {
  constructor(init = {}) {
    this.SpecVersion = init.SpecVersion ?? "";
    this.ID = init.ID ?? "";
    this.Sequence = init.Sequence ?? 0;
    this.Timestamp = init.Timestamp ?? null;
    this.Level = init.Level ?? "";
    this.Stream = init.Stream ?? "";
    this.Body = init.Body ?? "";
    this.Source = init.Source ?? new TelemetrySource();
    this.Context = init.Context ?? new TelemetryContext();
    this.Attributes = init.Attributes ?? {};
  }
}

// WorkerEnvelope：任何 CLI、远程 worker、SDK、容器执行机或未来执行后端实现的厂商中立入站契约。
class WorkerEnvelope {
  constructor(init = {}) {
    this.SpecVersion = init.SpecVersion ?? "";
    this.Type = init.Type ?? "";
    this.Observation = init.Observation ?? null;
    this.Log = init.Log ?? null;
  }
}

module.exports = { ObservabilitySpecVersion, ExecutionModeCloud, ExecutionModeRunner, ExecutionScopeRun, ExecutionScopeRepositories, RunnerWorkspaceLayoutShared, TelemetrySource, TelemetryContext, MetricPoint, ToolObservation, ModelObservation, ErrorObservation, AdapterDescriptor, ObservabilitySpec, LogRecord, WorkerEnvelope };
