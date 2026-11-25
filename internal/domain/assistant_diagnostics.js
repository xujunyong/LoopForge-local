// assistant_diagnostics.js —— 对应 Go 文件：internal/domain/assistant_diagnostics.go
// 作用：一轮助手生成的有界脱敏诊断记录：尝试、工具、时间线与评估。

"use strict";

// AssistantFailure：可随回复展示的安全失败信息。
class AssistantFailure {
  constructor(init = {}) {
    this.Code = init.Code ?? "";
    this.Phase = init.Phase ?? "";
    this.Message = init.Message ?? "";
    this.Suggestion = init.Suggestion ?? "";
  }
}

// AssistantDiagnostics：一轮的有界脱敏记录，不含提示词、命令参数、环境与原始厂商流。
class AssistantDiagnostics {
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

// 事实可跨环境携带：无需主机名、用户身份、安装路径或环境转储即可识别构建与执行实例。
class AssistantDiagnosticEnvironment {
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

class AssistantDiagnosticTermination {
  constructor(init = {}) {
    this.At = init.At ?? null;
    this.Code = init.Code ?? "";
    this.Source = init.Source ?? "";
    this.Message = init.Message ?? "";
  }
}

// Assessment：只描述观察到的证据，绝不编造厂商根因。
class AssistantDiagnosticAssessment {
  constructor(init = {}) {
    this.Outcome = init.Outcome ?? "";
    this.Summary = init.Summary ?? "";
    this.Evidence = init.Evidence ?? [];
    this.Unknowns = init.Unknowns ?? [];
    this.NextSteps = init.NextSteps ?? [];
  }
}

class AssistantDiagnosticProcess {
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

class AssistantDiagnosticTool {
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

class AssistantCLIAttempt {
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

class AssistantDiagnosticEvent {
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
