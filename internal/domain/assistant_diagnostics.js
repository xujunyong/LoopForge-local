/**
 * @file internal/domain/assistant_diagnostics.js
 * 对应 Go 源文件：internal/domain/assistant_diagnostics.go
 *
 * 作用与职责边界：
 * 定义单轮助手生成的有界、脱敏诊断数据结构，涵盖用户可见的失败摘要、诊断主对象、
 * 构建与实例环境信息、终止记录、确定性评估结论、CLI 进程状态、工具调用记录、
 * CLI 调用尝试明细及诊断时间线事件。
 * 仅定义数据结构，不包含敏感提示词、环境变量、凭证采集或分析算法（分析逻辑见 `assistant_diagnostic_analysis.js`）。
 *
 * 语法差异说明：
 * - Go 指针字段（`*bool`、`*int`、`*time.Time` 等）与 `time.Time` 零值统一初始化为 `null`。
 * - Go 切片字段初始化为 `[]`，映射字段（`Dropped`）初始化为 `{}`。
 */

"use strict";

/**
 * 表示可安全展示在助手回复旁的结构化失败信息。
 * 不包含原始上游追踪 ID（原生 `requestId`/`traceId` 仅保存在诊断报告中）。
 */
class AssistantFailure {
  /**
   * 构造并初始化助手失败摘要实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Code = init.Code ?? "";
    this.Phase = init.Phase ?? "";
    this.Message = init.Message ?? "";
    this.Suggestion = init.Suggestion ?? "";
  }
}

/**
 * 表示单轮助手生成的有界、脱敏诊断报告主结构。
 * 不包含提示词、命令行参数、环境变量或厂商原始输出流，供故障排查与导出使用。
 */
class AssistantDiagnostics {
  /**
   * 构造并初始化助手诊断报告实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Version = init.Version ?? 0;
    this.GenerationID = init.GenerationID ?? "";
    this.SessionID = init.SessionID ?? "";
    this.Status = init.Status ?? "";
    this.StartedAt = init.StartedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
    this.Failure = init.Failure ?? null;
    this.Error = init.Error ?? "";
    this.Attempts = init.Attempts ?? [];
    this.Truncated = init.Truncated ?? false;
    this.Environment = init.Environment ?? null;
    this.LastCheckpointAt = init.LastCheckpointAt ?? null;
    this.Timeline = init.Timeline ?? [];
    this.Tools = init.Tools ?? [];
    this.Termination = init.Termination ?? null;
    this.Assessment = init.Assessment ?? null;
    this.Coverage = init.Coverage ?? [];
    this.Dropped = init.Dropped ?? {};
  }
}

/**
 * 表示可跨环境安全导出的构建与运行实例元信息。
 * 不含主机名、用户身份、安装路径或环境变量转储，仅用于定位平台版本与服务实例日志。
 */
class AssistantDiagnosticEnvironment {
  /**
   * 构造并初始化诊断环境元信息实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.PlatformVersion = init.PlatformVersion ?? "";
    this.Revision = init.Revision ?? "";
    this.Modified = init.Modified ?? null;
    this.GoVersion = init.GoVersion ?? "";
    this.OS = init.OS ?? "";
    this.Arch = init.Arch ?? "";
    this.InstanceID = init.InstanceID ?? "";
    this.InstanceStartedAt = init.InstanceStartedAt ?? null;
  }
}

/**
 * 表示平台侧记录的本轮生成终止事实（如用户主动停止、转向或心跳丢失）。
 */
class AssistantDiagnosticTermination {
  /**
   * 构造并初始化诊断终止记录实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.At = init.At ?? null;
    this.Code = init.Code ?? "";
    this.Source = init.Source ?? "";
    this.Message = init.Message ?? "";
  }
}

/**
 * 表示由离线分析产出的诊断评估结论。
 * 严格区分已观测证据（`Evidence`）、无法确认项（`Unknowns`）与排查建议（`NextSteps`），不臆测上游根因。
 */
class AssistantDiagnosticAssessment {
  /**
   * 构造并初始化诊断评估结论实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Outcome = init.Outcome ?? "";
    this.Summary = init.Summary ?? "";
    this.Evidence = init.Evidence ?? [];
    this.Unknowns = init.Unknowns ?? [];
    this.NextSteps = init.NextSteps ?? [];
  }
}

/**
 * 表示单次 CLI 调用对应的子进程生命周期与输出统计信息。
 * 包含进程号、状态、信号、CPU 耗时以及 stdout/stderr 行数与首末输出时间。
 */
class AssistantDiagnosticProcess {
  /**
   * 构造并初始化诊断进程状态实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.PID = init.PID ?? 0;
    this.State = init.State ?? "";
    this.StartedAt = init.StartedAt ?? null;
    this.FinishedAt = init.FinishedAt ?? null;
    this.Signal = init.Signal ?? "";
    this.UserCPUMs = init.UserCPUMs ?? 0;
    this.SystemCPUMs = init.SystemCPUMs ?? 0;
    this.StdoutLines = init.StdoutLines ?? 0;
    this.StderrLines = init.StderrLines ?? 0;
    this.FirstStdoutAt = init.FirstStdoutAt ?? null;
    this.LastStdoutAt = init.LastStdoutAt ?? null;
    this.FirstStderrAt = init.FirstStderrAt ?? null;
    this.LastStderrAt = init.LastStderrAt ?? null;
  }
}

/**
 * 表示诊断报告中单次工具调用的状态与脱敏错误元数据。
 */
class AssistantDiagnosticTool {
  /**
   * 构造并初始化诊断工具记录实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.AttemptID = init.AttemptID ?? "";
    this.Source = init.Source ?? "";
    this.Name = init.Name ?? "";
    this.ParentID = init.ParentID ?? "";
    this.Status = init.Status ?? "";
    this.StartedAt = init.StartedAt ?? null;
    this.FinishedAt = init.FinishedAt ?? null;
    this.Error = init.Error ?? "";
    this.ExitCode = init.ExitCode ?? null;
    this.StatusCode = init.StatusCode ?? 0;
    this.RequestID = init.RequestID ?? "";
    this.TraceID = init.TraceID ?? "";
  }
}

/**
 * 表示一轮助手生成中对底层 CLI 执行器的一次完整调用尝试记录。
 * 记录所用引擎、模型、版本来源、进程状态、退出码、stderr 片段、首个异常事件及原生会话标识。
 */
class AssistantCLIAttempt {
  /**
   * 构造并初始化 CLI 调用尝试实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Engine = init.Engine ?? "";
    this.Model = init.Model ?? "";
    this.Resume = init.Resume ?? false;
    this.StartedAt = init.StartedAt ?? null;
    this.FinishedAt = init.FinishedAt ?? null;
    this.Phase = init.Phase ?? "";
    this.Status = init.Status ?? "";
    this.ExitCode = init.ExitCode ?? null;
    this.Error = init.Error ?? "";
    this.Stderr = init.Stderr ?? [];
    this.Events = init.Events ?? [];
    this.CLIVersion = init.CLIVersion ?? "";
    this.VersionSource = init.VersionSource ?? "";
    this.BinarySource = init.BinarySource ?? "";
    this.Endpoint = init.Endpoint ?? "";
    this.Protocol = init.Protocol ?? "";
    this.Effort = init.Effort ?? "";
    this.Process = init.Process ?? null;
    this.FirstStderr = init.FirstStderr ?? [];
    this.FirstError = init.FirstError ?? null;
    this.NativeSessionID = init.NativeSessionID ?? "";
    this.NativeTurnID = init.NativeTurnID ?? "";
  }
}

/**
 * 表示诊断时间线或 CLI 尝试明细中的单条脱敏事件。
 * 记录事件时间戳、类型、脱敏消息、错误分类、上游请求/链路 ID、HTTP 状态码及是否可重试。
 */
class AssistantDiagnosticEvent {
  /**
   * 构造并初始化诊断事件实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.At = init.At ?? null;
    this.Kind = init.Kind ?? "";
    this.Message = init.Message ?? "";
    this.Code = init.Code ?? "";
    this.Phase = init.Phase ?? "";
    this.RequestID = init.RequestID ?? "";
    this.TraceID = init.TraceID ?? "";
    this.StatusCode = init.StatusCode ?? 0;
    this.Retryable = init.Retryable ?? null;
    this.Sequence = init.Sequence ?? 0;
    this.Source = init.Source ?? "";
    this.AttemptID = init.AttemptID ?? "";
    this.ToolID = init.ToolID ?? "";
    this.Tool = init.Tool ?? "";
  }
}

module.exports = { AssistantFailure, AssistantDiagnostics, AssistantDiagnosticEnvironment, AssistantDiagnosticTermination, AssistantDiagnosticAssessment, AssistantDiagnosticProcess, AssistantDiagnosticTool, AssistantCLIAttempt, AssistantDiagnosticEvent };
