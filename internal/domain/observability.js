/**
 * @file internal/domain/observability.js
 * @description 对应 Go 源文件：internal/domain/observability.go
 * 职责边界：定义平台统一的可观测性契约，包括执行模式常量、遥测来源、关联上下文、指标采样点、工具/模型/错误观测结构、适配器描述、诊断日志记录与 Worker 入站信封。
 * 语法差异说明：
 * - Go 的 `time.Time` 对应 JS 的 `Date | null`（零值为 `null`）。
 * - Go 的指针字段（如 `*bool`、`*TelemetryEvent`、`*LogRecord`）零值统一为 `null`。
 * - Go 的 `map[string]string` 与 `map[string]any` 统一译为普通对象 `{}`。
 */

"use strict";

const ObservabilitySpecVersion = "agentflow.observability/v1";

const ExecutionModeCloud = "cloud";
const ExecutionModeRunner = "runner";
const ExecutionScopeRun = "run";
const ExecutionScopeRepositories = "repositories";

const RunnerWorkspaceLayoutShared = "shared";

/**
 * 遥测观测数据的来源标识。
 * 用于标记产出该观测的系统层级及归一化适配器；下游消费方不应直接按原生协议载荷分支。
 */
class TelemetrySource {
  /**
   * 构造遥测来源实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.Layer=""] - 产生观测的层级（如 executor、orchestrator、agent、sandbox、verification）。
   * @param {string} [init.Adapter=""] - 执行归一化的适配器名称。
   * @param {string} [init.Provider=""] - 模型或执行服务提供方标识。
   * @param {string} [init.Protocol=""] - 原生通信协议名称。
   */
  constructor(init = {}) {
    this.Layer = init.Layer ?? "";
    this.Adapter = init.Adapter ?? "";
    this.Provider = init.Provider ?? "";
    this.Protocol = init.Protocol ?? "";
  }
}

/**
 * 贯穿平台各层与产品业务的关联上下文。
 * 用于将运行、需求、调度任务、执行目标、工作区布局以及分布式链路 ID 关联到同一条观测记录。
 */
class TelemetryContext {
  /**
   * 构造遥测上下文实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {boolean} [init.ExecutionPinned=false] - 执行目标是否已被显式固定。
   * @param {string} [init.ProjectID=""] - 所属项目 ID。
   * @param {string} [init.IssueID=""] - 本地需求 ID。
   * @param {string} [init.TAPDID=""] - 外部 TAPD 需求键（本地 IssueID 跨导入可能不同）。
   * @param {number} [init.ResponsibleUserID=0] - 负责用户 ID。
   * @param {string} [init.ExecutionMode=""] - 运行启动时冻结的执行模式（cloud 或 runner）。
   * @param {string} [init.ExecutionRunnerID=""] - 运行启动时冻结的目标执行机 ID。
   * @param {string} [init.ExecutionPool=""] - 执行机来源池（`"cloud"` 表示取自平台执行机池）。
   * @param {string} [init.RunnerWorkspaceLayout=""] - 自托管执行机磁盘工作区布局方式（空为旧版每节点布局，`"shared"` 为同运行共享仓库与 Git 索引）。
   * @param {number} [init.IssueNumber=0] - 需求序号。
   * @param {string} [init.TaskID=""] - 关联幂等任务 ID。
   * @param {string} [init.ScheduleJobID=""] - 关联定时任务 ID。
   * @param {string} [init.SharedScheduleID=""] - 共享定时模板 ID。
   * @param {number} [init.SharedScheduleVersion=0] - 共享定时模板版本号。
   * @param {string} [init.RunID=""] - 当前运行 ID。
   * @param {string} [init.ParentRunID=""] - 父运行 ID（子 SOP 场景）。
   * @param {string} [init.ParentNodeID=""] - 父节点 ID（子 SOP 场景）。
   * @param {string} [init.WorkspaceRunID=""] - 拥有子 SOP 共享工作区的顶层运行 ID（为空表示当前运行自有工作区）。
   * @param {string} [init.WorkflowID=""] - 工作流 ID。
   * @param {number} [init.WorkflowVersion=0] - 工作流版本号。
   * @param {string} [init.NodeID=""] - 当前节点 ID。
   * @param {string} [init.MetricStage=""] - 指标统计阶段名。
   * @param {number} [init.Attempt=0] - 当前节点尝试次数。
   * @param {string} [init.AgentID=""] - 当前 Agent ID。
   * @param {number} [init.AgentVersion=0] - 当前 Agent 版本号。
   * @param {string} [init.ExecutorID=""] - 当前执行器 ID。
   * @param {string} [init.SandboxID=""] - 当前沙箱 ID。
   * @param {string} [init.SessionID=""] - 当前会话 ID。
   * @param {string} [init.TraceID=""] - 分布式追踪 Trace ID。
   * @param {string} [init.SpanID=""] - 当前 Span ID。
   * @param {string} [init.ParentSpanID=""] - 父 Span ID。
   */
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
    // WorkspaceRunID 是拥有子 SOP 工作区的顶层运行 ID；空表示该运行拥有自己的工作区。
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

/**
 * 单个指标采样点。
 * 用于在遥测事件中携带计数、仪表盘或直方图类型的数值指标。
 */
class MetricPoint {
  /**
   * 构造指标采样点实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.Name=""] - 指标名称。
   * @param {number} [init.Value=0] - 指标采样数值。
   * @param {string} [init.Unit=""] - 指标单位。
   * @param {string} [init.Kind=""] - 指标类型（counter、gauge 或 histogram）。
   * @param {Object.<string, string>} [init.Dimensions={}] - 指标维度标签键值映射。
   */
  constructor(init = {}) {
    this.Name = init.Name ?? "";
    this.Value = init.Value ?? 0;
    this.Unit = init.Unit ?? "";
    this.Kind = init.Kind ?? "";
    this.Dimensions = init.Dimensions ?? {};
  }
}

/**
 * 单次工具调用的结构化观测数据。
 * 记录工具名称、操作类型、调用标识、成败结果及耗时。
 */
class ToolObservation {
  /**
   * 构造工具观测实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.Name=""] - 工具名称。
   * @param {string} [init.Operation=""] - 工具执行的具体操作。
   * @param {string} [init.CallID=""] - 工具调用唯一 ID。
   * @param {boolean|null} [init.Success=null] - 工具调用是否成功（未知时为 `null`）。
   * @param {number} [init.DurationMs=0] - 工具调用耗时（毫秒）。
   */
  constructor(init = {}) {
    this.Name = init.Name ?? "";
    this.Operation = init.Operation ?? "";
    this.CallID = init.CallID ?? "";
    this.Success = init.Success ?? null;
    this.DurationMs = init.DurationMs ?? 0;
  }
}

/**
 * 单次模型调用的结构化观测数据。
 * 记录模型提供方、模型名、操作类型、结束原因及上下文窗口大小。
 */
class ModelObservation {
  /**
   * 构造模型观测实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.Provider=""] - 模型提供方。
   * @param {string} [init.Model=""] - 模型名称。
   * @param {string} [init.Operation=""] - 模型操作类型。
   * @param {string} [init.FinishReason=""] - 响应终止原因。
   * @param {number} [init.ContextWindow=0] - 模型上下文窗口大小。
   */
  constructor(init = {}) {
    this.Provider = init.Provider ?? "";
    this.Model = init.Model ?? "";
    this.Operation = init.Operation ?? "";
    this.FinishReason = init.FinishReason ?? "";
    this.ContextWindow = init.ContextWindow ?? 0;
  }
}

/**
 * 单次错误事件的结构化观测数据。
 * 记录错误码、错误类型、可读错误消息以及是否可重试。
 */
class ErrorObservation {
  /**
   * 构造错误观测实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.Code=""] - 错误码。
   * @param {string} [init.Type=""] - 错误分类。
   * @param {string} [init.Message=""] - 错误详情说明。
   * @param {boolean} [init.Retryable=false] - 该错误是否允许重试。
   */
  constructor(init = {}) {
    this.Code = init.Code ?? "";
    this.Type = init.Type ?? "";
    this.Message = init.Message ?? "";
    this.Retryable = init.Retryable ?? false;
  }
}

/**
 * 遥测适配器的能力描述元信息。
 * 用于向外部接口公开平台支持的执行器类型、协议、能力与原始事件保留策略。
 */
class AdapterDescriptor {
  /**
   * 构造适配器描述实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - 适配器唯一 ID。
   * @param {string} [init.SpecVersion=""] - 遵循的可观测性规约版本。
   * @param {string[]} [init.ExecutorKinds=[]] - 支持的执行器种类列表。
   * @param {string[]} [init.NativeProtocols=[]] - 支持的原生协议列表。
   * @param {string[]} [init.Capabilities=[]] - 适配器能力标签列表。
   * @param {string} [init.RawEventPolicy=""] - 原始事件处理策略。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.SpecVersion = init.SpecVersion ?? "";
    this.ExecutorKinds = init.ExecutorKinds ?? [];
    this.NativeProtocols = init.NativeProtocols ?? [];
    this.Capabilities = init.Capabilities ?? [];
    this.RawEventPolicy = init.RawEventPolicy ?? "";
  }
}

/**
 * 平台可观测性规约声明。
 * 供观测元数据端点返回当前规约版本、事件分类、阶段、必填上下文、指标约定及已注册适配器。
 */
class ObservabilitySpec {
  /**
   * 构造可观测性规约实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.Version=""] - 规约版本号。
   * @param {string[]} [init.Categories=[]] - 支持的遥测事件分类列表。
   * @param {string[]} [init.Phases=[]] - 支持的生命周期阶段列表。
   * @param {string[]} [init.RequiredContext=[]] - 必填的上下文字段名列表。
   * @param {Object.<string, string>} [init.MetricConventions={}] - 标准指标命名与含义映射。
   * @param {AdapterDescriptor[]} [init.Adapters=[]] - 已注册的适配器描述列表。
   */
  constructor(init = {}) {
    this.Version = init.Version ?? "";
    this.Categories = init.Categories ?? [];
    this.Phases = init.Phases ?? [];
    this.RequiredContext = init.RequiredContext ?? [];
    this.MetricConventions = init.MetricConventions ?? {};
    this.Adapters = init.Adapters ?? [];
  }
}

/**
 * 独立的可按序号游标拉取的诊断日志记录。
 * 与遥测事件共享关联上下文，但不参与指标聚合。
 */
class LogRecord {
  /**
   * 构造诊断日志记录实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.SpecVersion=""] - 可观测性规约版本。
   * @param {string} [init.ID=""] - 日志记录唯一 ID。
   * @param {number} [init.Sequence=0] - 递增游标序号。
   * @param {Date|null} [init.Timestamp=null] - 日志产生时间。
   * @param {string} [init.Level=""] - 日志级别。
   * @param {string} [init.Stream=""] - 日志流来源（stdout、stderr、worker 或 platform）。
   * @param {string} [init.Body=""] - 日志正文文本。
   * @param {TelemetrySource} [init.Source] - 产生日志的来源信息。
   * @param {TelemetryContext} [init.Context] - 关联的执行上下文。
   * @param {Object.<string, *>} [init.Attributes={}] - 附加结构化属性。
   */
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

/**
 * 厂商中立的执行端入站数据信封。
 * 供 CLI、远程 Worker、SDK、容器执行机等后端统一上报遥测观测事件或诊断日志。
 */
class WorkerEnvelope {
  /**
   * 构造 Worker 入站信封实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.SpecVersion=""] - 可观测性规约版本。
   * @param {string} [init.Type=""] - 信封载荷类型（observation 或 log）。
   * @param {object|null} [init.Observation=null] - 遥测事件对象（TelemetryEvent）。
   * @param {LogRecord|null} [init.Log=null] - 诊断日志记录。
   */
  constructor(init = {}) {
    this.SpecVersion = init.SpecVersion ?? "";
    this.Type = init.Type ?? "";
    this.Observation = init.Observation ?? null;
    this.Log = init.Log ?? null;
  }
}

module.exports = { ObservabilitySpecVersion, ExecutionModeCloud, ExecutionModeRunner, ExecutionScopeRun, ExecutionScopeRepositories, RunnerWorkspaceLayoutShared, TelemetrySource, TelemetryContext, MetricPoint, ToolObservation, ModelObservation, ErrorObservation, AdapterDescriptor, ObservabilitySpec, LogRecord, WorkerEnvelope };
