// runner_workspace.js —— 对应 Go 文件：internal/domain/runner_workspace.go
// 作用：执行机器工作区操作（检查点、终端、浏览器等）的请求与响应类型。

"use strict";

const RunnerWorkspaceOperationCheckpointStatus = "checkpoint_status";
const RunnerWorkspaceOperationCheckpointExport = "checkpoint_export";
const RunnerWorkspaceOperationCheckpointRead = "checkpoint_read";
const RunnerWorkspaceOperationCheckpointClose = "checkpoint_close";
const RunnerWorkspaceOperationCheckpointUpload = "checkpoint_upload";
const RunnerWorkspaceOperationCheckpointAppend = "checkpoint_append";
const RunnerWorkspaceOperationCheckpointCommit = "checkpoint_commit";
const RunnerWorkspaceOperationArtifacts = "restore_artifacts";
const RunnerWorkspaceOperationReclaim = "reclaim";
const RunnerWorkspaceOperationCheckpoint = "checkpoint";
const RunnerWorkspaceOperationRestore = "restore";
const RunnerWorkspaceOperationPrepare = "prepare";
const RunnerWorkspaceOperationPreparationStatus = "preparation_status";
const RunnerWorkspaceOperationPreparationRecord = "preparation_record";
const RunnerWorkspaceOperationTerminal = "terminal";
const RunnerWorkspaceOperationWrite = "write";
const RunnerWorkspaceOperationInfo = "info";
const RunnerWorkspaceOperationTree = "tree";
const RunnerWorkspaceOperationFile = "file";
const RunnerWorkspaceOperationDiff = "diff";
const RunnerWorkspaceOperationSearch = "search";
const RunnerWorkspaceOperationLog = "log";
const RunnerWorkspaceOperationCommit = "commit";
const RunnerWorkspaceOperationBrowser = "browser";
const RunnerWorkspaceOperationCheckouts = "checkouts";
const RunnerWorkspaceOperationMaintenance = "maintenance";
const RunnerWorkspaceOperationLoginModels = "login_models";
const RunnerWorkspaceOperationSSHHostKeyProbe = "ssh_host_key_probe";
const RunnerWorkspaceOperationConversationCLI = "conversation_process";

// RunnerSSHKnownHostsWireLimit：runner 任务认领中 known_hosts 字段的编码上限。
const RunnerSSHKnownHostsWireLimit = 1 << 20;

// RunnerSSHHostKeyProbeHeader：在已认证控制连接上声明主机密钥发现能力。
const RunnerSSHHostKeyProbeHeader = "X-AgentFlow-SSH-Host-Key-Probe";

// GitSSHKnownHosts：经已认证 runner 传输的平台侧 SSH 主机密钥。
class GitSSHKnownHosts {
  constructor(init = {}) {
    this.Entries = init.Entries ?? "";
    this.ReadFailed = init.ReadFailed ?? false;
    this.TooLarge = init.TooLarge ?? false;
  }
}

// RunnerWorkspaceRequest：经 runner 出站控制套接字发送的有界工作区请求。
class RunnerWorkspaceRequest {
  constructor(init = {}) {
    this.Maintenance = init.Maintenance ?? null;
    this.ModelProvider = init.ModelProvider ?? "";
    this.SSHHostKeyAddress = init.SSHHostKeyAddress ?? "";
    this.SSHHostKeyOwnerID = init.SSHHostKeyOwnerID ?? 0;
    this.Conversation = init.Conversation ?? null;
    this.RunKind = init.RunKind ?? "";
    this.ConcurrentEdit = init.ConcurrentEdit ?? false;
    this.CheckpointTransfer = init.CheckpointTransfer ?? null;
    this.RefreshCleanRepositories = init.RefreshCleanRepositories ?? false;
    this.PreparationNodeID = init.PreparationNodeID ?? "";
    this.PreparationOutput = init.PreparationOutput ?? "";
    this.PreparationInvocation = init.PreparationInvocation ?? null;
    this.Sandbox = init.Sandbox ?? null;
    this.Workflow = init.Workflow ?? null;
    this.ArtifactFiles = init.ArtifactFiles ?? null;
    this.CheckpointLease = init.CheckpointLease ?? "";
    this.Checkpoint = init.Checkpoint ?? null;
    this.Terminal = init.Terminal ?? null;
    this.TerminalOwner = init.TerminalOwner ?? 0;
    this.TerminalGitSSHKeys = init.TerminalGitSSHKeys ?? null;
    this.GitSSHKnownHosts = init.GitSSHKnownHosts ?? null;
    this.TerminalGitHTTPCredentials = init.TerminalGitHTTPCredentials ?? null;
    this.Browser = init.Browser ?? null;
    this.WorkspaceRunID = init.WorkspaceRunID ?? "";
    this.RunID = init.RunID ?? "";
    this.RunStatus = init.RunStatus ?? "";
    this.WorkspaceLayout = init.WorkspaceLayout ?? "";
    this.Operation = init.Operation ?? "";
    this.Content = init.Content ?? "";
    this.ExpectedSHA256 = init.ExpectedSHA256 ?? "";
    this.Path = init.Path ?? "";
    this.Query = init.Query ?? "";
    this.Ref = init.Ref ?? "";
    this.Repositories = init.Repositories ?? null;
  }
}

class RunnerMaintenanceRequest {
  constructor(init = {}) {
    this.Provider = init.Provider ?? "";
    this.Apply = init.Apply ?? false;
    this.StatusOnly = init.StatusOnly ?? false;
  }
}

class RunnerMaintenanceResult {
  constructor(init = {}) {
    this.Status = init.Status ?? "";
    this.Current = init.Current ?? "";
    this.Version = init.Version ?? "";
    this.Message = init.Message ?? "";
    this.CanUpdate = init.CanUpdate ?? false;
  }
}

// RunnerToolRequest：与会话进程走同一条实例控制套接字转发的工具请求。
class RunnerToolRequest {
  constructor(init = {}) {
    this.SupportsCancel = init.SupportsCancel ?? false;
    this.Token = init.Token ?? "";
    this.Body = init.Body ?? null;
  }
}

class RunnerToolResponse {
  constructor(init = {}) {
    this.Body = init.Body ?? null;
    this.Error = init.Error ?? "";
  }
}

// WorkspaceImageBuildProgress：一次镜像构建的步骤进度。
class WorkspaceImageBuildProgress {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Step = init.Step ?? "";
    this.Done = init.Done ?? false;
    this.Failed = init.Failed ?? false;
  }
}

class WorkspaceCheckpointTransfer {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Size = init.Size ?? 0;
    this.SHA256 = init.SHA256 ?? "";
    this.Offset = init.Offset ?? 0;
    this.Data = init.Data ?? null;
  }
}

// IsCancelableRunnerWorkspaceOperation：识别持有工作区锁的可取消同步请求。
function IsCancelableRunnerWorkspaceOperation(op) {
  return IsWorkspaceCheckpointTransferOperation(op) || op === RunnerWorkspaceOperationCheckpoint || op === RunnerWorkspaceOperationPrepare;
}

function IsWorkspaceCheckpointTransferOperation(op) {
  switch (op) {
    case RunnerWorkspaceOperationCheckpointExport:
    case RunnerWorkspaceOperationCheckpointRead:
    case RunnerWorkspaceOperationCheckpointClose:
    case RunnerWorkspaceOperationCheckpointUpload:
    case RunnerWorkspaceOperationCheckpointAppend:
    case RunnerWorkspaceOperationCheckpointCommit:
      return true;
    default:
      return false;
  }
}

class RunnerWorkspaceResponse {
  constructor(init = {}) {
    this.Payload = init.Payload ?? null;
    this.Error = init.Error ?? "";
    this.Code = init.Code ?? "";
    this.Status = init.Status ?? 0;
  }
}

const WorkspaceErrorBusy = "workspace_busy";
const WorkspaceErrorMissing = "workspace_missing";
// WorkspaceErrorTerminalActive：独占人工终端持有工作区，等待无用。
const WorkspaceErrorTerminalActive = "workspace_terminal_active";
// WorkspaceErrorConversationState：携带执行机器侧安全的会话级准备错误。
const WorkspaceErrorConversationState = "conversation_state";

// WorkspaceRestoreStatus：与 SOP 执行分开描述的恢复状态。
class WorkspaceRestoreStatus {
  constructor(init = {}) {
    this.Status = init.Status ?? "";
    this.StartedAt = init.StartedAt ?? null;
    this.Error = init.Error ?? "";
  }
}

// WorkspaceTerminalRequest：传送瞬时 PTY 数据。
class WorkspaceTerminalRequest {
  constructor(init = {}) {
    this.ExpiresAt = init.ExpiresAt ?? null;
    this.Operation = init.Operation ?? "";
    this.ID = init.ID ?? "";
    this.Data = init.Data ?? "";
    this.Cols = init.Cols ?? 0;
    this.Rows = init.Rows ?? 0;
  }
}

// BrowserRequest：从任务面板驱动运行的 agent 浏览器。
class BrowserRequest {
  constructor(init = {}) {
    this.Operation = init.Operation ?? "";
    this.After = init.After ?? 0;
    this.WaitMs = init.WaitMs ?? 0;
    this.URL = init.URL ?? "";
    this.TargetID = init.TargetID ?? "";
    this.Width = init.Width ?? 0;
    this.Height = init.Height ?? 0;
    this.FrameWidth = init.FrameWidth ?? 0;
    this.Events = init.Events ?? null;
    this.Ref = init.Ref ?? "";
    this.Text = init.Text ?? "";
    this.Key = init.Key ?? "";
    this.Submit = init.Submit ?? false;
    this.WithSnapshot = init.WithSnapshot ?? false;
    this.Ensure = init.Ensure ?? false;
    this.HTTP = init.HTTP ?? null;
    this.File = init.File ?? "";
    this.Point = init.Point ?? null;
    this.Detail = init.Detail ?? false;
  }
}

// BrowserPoint：视口占比表示的位置（0..1）。
class BrowserPoint {
  constructor(init = {}) {
    this.X = init.X ?? 0;
    this.Y = init.Y ?? 0;
  }
}

// BrowserInspection：Agent 浏览器页面上某一点下的元素。
class BrowserInspection {
  constructor(init = {}) {
    this.Label = init.Label ?? "";
    this.Rect = init.Rect ?? null;
    this.Viewport = init.Viewport ?? null;
    this.Element = init.Element ?? null;
  }
}

// BrowserHTTPRequest：一次代理到运行沙箱内 localhost:Port 的请求。
class BrowserHTTPRequest {
  constructor(init = {}) {
    this.Port = init.Port ?? 0;
    this.Method = init.Method ?? "";
    this.Path = init.Path ?? "";
    this.Header = init.Header ?? null;
    this.Body = init.Body ?? null;
  }
}

// BrowserHTTPResponse：开发服务器对 BrowserHTTPRequest 的应答。
class BrowserHTTPResponse {
  constructor(init = {}) {
    this.Status = init.Status ?? 0;
    this.Header = init.Header ?? null;
    this.Body = init.Body ?? null;
  }
}

// BrowserInputEvent：坐标按帧归一化（0..1）的浏览器输入事件。
class BrowserInputEvent {
  constructor(init = {}) {
    this.Type = init.Type ?? "";
    this.Action = init.Action ?? "";
    this.X = init.X ?? 0;
    this.Y = init.Y ?? 0;
    this.Button = init.Button ?? "";
    this.Buttons = init.Buttons ?? 0;
    this.ClickCount = init.ClickCount ?? 0;
    this.Modifiers = init.Modifiers ?? 0;
    this.DeltaX = init.DeltaX ?? 0;
    this.DeltaY = init.DeltaY ?? 0;
    this.Key = init.Key ?? "";
    this.Code = init.Code ?? "";
    this.KeyCode = init.KeyCode ?? 0;
    this.Text = init.Text ?? "";
  }
}

class BrowserTab {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Title = init.Title ?? "";
    this.URL = init.URL ?? "";
    this.Active = init.Active ?? false;
  }
}

class BrowserState {
  constructor(init = {}) {
    this.Available = init.Available ?? false;
    this.Reason = init.Reason ?? "";
    this.Kind = init.Kind ?? "";
    this.Seq = init.Seq ?? 0;
    this.Frame = init.Frame ?? "";
    this.Width = init.Width ?? 0;
    this.Height = init.Height ?? 0;
    this.URL = init.URL ?? "";
    this.Title = init.Title ?? "";
    this.ScrollX = init.ScrollX ?? 0;
    this.ScrollY = init.ScrollY ?? 0;
    this.ContentWidth = init.ContentWidth ?? 0;
    this.ContentHeight = init.ContentHeight ?? 0;
    this.CanGoBack = init.CanGoBack ?? false;
    this.CanGoForward = init.CanGoForward ?? false;
    this.Tabs = init.Tabs ?? null;
    this.Snapshot = init.Snapshot ?? null;
    this.HTTP = init.HTTP ?? null;
    this.Inspect = init.Inspect ?? null;
  }
}

// BrowserSnapshot：给语言模型看的当前页文本视图。
class BrowserSnapshot {
  constructor(init = {}) {
    this.Text = init.Text ?? "";
    this.Truncated = init.Truncated ?? false;
    this.Elements = init.Elements ?? null;
  }
}

class BrowserElement {
  constructor(init = {}) {
    this.Ref = init.Ref ?? "";
    this.Role = init.Role ?? "";
    this.Name = init.Name ?? "";
    this.Value = init.Value ?? "";
    this.Checked = init.Checked ?? false;
    this.Disabled = init.Disabled ?? false;
  }
}

// WorkspaceArtifactFile：不可变的归档产物，恢复时仅当文件不存在才写入。
class WorkspaceArtifactFile {
  constructor(init = {}) {
    this.Path = init.Path ?? "";
    this.Content = init.Content ?? "";
    this.SHA256 = init.SHA256 ?? "";
  }
}

module.exports = { RunnerWorkspaceOperationCheckpointStatus, RunnerWorkspaceOperationCheckpointExport, RunnerWorkspaceOperationCheckpointRead, RunnerWorkspaceOperationCheckpointClose, RunnerWorkspaceOperationCheckpointUpload, RunnerWorkspaceOperationCheckpointAppend, RunnerWorkspaceOperationCheckpointCommit, RunnerWorkspaceOperationArtifacts, RunnerWorkspaceOperationReclaim, RunnerWorkspaceOperationCheckpoint, RunnerWorkspaceOperationRestore, RunnerWorkspaceOperationPrepare, RunnerWorkspaceOperationPreparationStatus, RunnerWorkspaceOperationPreparationRecord, RunnerWorkspaceOperationTerminal, RunnerWorkspaceOperationWrite, RunnerWorkspaceOperationInfo, RunnerWorkspaceOperationTree, RunnerWorkspaceOperationFile, RunnerWorkspaceOperationDiff, RunnerWorkspaceOperationSearch, RunnerWorkspaceOperationLog, RunnerWorkspaceOperationCommit, RunnerWorkspaceOperationBrowser, RunnerWorkspaceOperationCheckouts, RunnerWorkspaceOperationMaintenance, RunnerWorkspaceOperationLoginModels, RunnerWorkspaceOperationSSHHostKeyProbe, RunnerWorkspaceOperationConversationCLI, RunnerSSHKnownHostsWireLimit, RunnerSSHHostKeyProbeHeader, GitSSHKnownHosts, RunnerWorkspaceRequest, RunnerMaintenanceRequest, RunnerMaintenanceResult, RunnerToolRequest, RunnerToolResponse, WorkspaceImageBuildProgress, WorkspaceCheckpointTransfer, IsCancelableRunnerWorkspaceOperation, IsWorkspaceCheckpointTransferOperation, RunnerWorkspaceResponse, WorkspaceErrorBusy, WorkspaceErrorMissing, WorkspaceErrorTerminalActive, WorkspaceErrorConversationState, WorkspaceRestoreStatus, WorkspaceTerminalRequest, BrowserRequest, BrowserPoint, BrowserInspection, BrowserHTTPRequest, BrowserHTTPResponse, BrowserInputEvent, BrowserTab, BrowserState, BrowserSnapshot, BrowserElement, WorkspaceArtifactFile };
