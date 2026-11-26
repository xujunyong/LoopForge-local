/**
 * @file internal/domain/runner_workspace.js
 * @description 对应 Go 文件：internal/domain/runner_workspace.go
 * 职责与边界：定义经执行机器出站控制连接传输的瞬时工作区操作协议类型与常量，
 * 涵盖检查点导入导出、工作区准备、交互终端、Agent 浏览器控制、维护升级及归档产物文件，
 * 并提供可取消操作与检查点传输操作的判定函数。
 * 语法差异说明：
 * - Go 切片零值初始化为 `[]`，普通映射 `map[string]V` 初始化为 `{}`；
 *   二进制字段（`[]byte` / `json.RawMessage`）、指针与 `time.Time` 初始化为 `null`。
 */

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

// 执行机器任务认领中可选 `known_hosts` 字段的编码大小上限（1 MiB）。
const RunnerSSHKnownHostsWireLimit = 1 << 20;

// 在已认证控制连接上声明支持 SSH 主机密钥探测的请求头名称。
const RunnerSSHHostKeyProbeHeader = "X-AgentFlow-SSH-Host-Key-Probe";

/**
 * 承载通过已认证执行机器通道下发的平台 SSH 主机密钥列表及读取状态标志。
 * 读取失败或超限时也会随结构下发，以便执行机器按安全失败（fail-closed）策略处理。
 */
class GitSSHKnownHosts {
  /**
   * 构造 SSH 主机密钥承载对象，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Entries = init.Entries ?? "";
    this.ReadFailed = init.ReadFailed ?? false;
    this.TooLarge = init.TooLarge ?? false;
  }
}

/**
 * 表示经执行机器出站控制套接字发送的一次有界瞬时工作区请求。
 * 响应不会持久化写入 `runner_tasks` 或运行记录。
 */
class RunnerWorkspaceRequest {
  /**
   * 构造工作区控制请求实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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
    this.ArtifactFiles = init.ArtifactFiles ?? [];
    this.CheckpointLease = init.CheckpointLease ?? "";
    this.Checkpoint = init.Checkpoint ?? null;
    this.Terminal = init.Terminal ?? null;
    this.TerminalOwner = init.TerminalOwner ?? 0;
    this.TerminalGitSSHKeys = init.TerminalGitSSHKeys ?? {};
    this.GitSSHKnownHosts = init.GitSSHKnownHosts ?? null;
    this.TerminalGitHTTPCredentials = init.TerminalGitHTTPCredentials ?? {};
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
    this.Repositories = init.Repositories ?? [];
  }
}

/**
 * 描述发往执行机器的二进制或 CLI 维护升级请求。
 */
class RunnerMaintenanceRequest {
  /**
   * 构造维护请求实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Provider = init.Provider ?? "";
    this.Apply = init.Apply ?? false;
    this.StatusOnly = init.StatusOnly ?? false;
  }
}

/**
 * 描述执行机器维护检查或升级动作的返回结果。
 */
class RunnerMaintenanceResult {
  /**
   * 构造维护结果实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Status = init.Status ?? "";
    this.Current = init.Current ?? "";
    this.Version = init.Version ?? "";
    this.Message = init.Message ?? "";
    this.CanUpdate = init.CanUpdate ?? false;
  }
}

/**
 * 表示复用实例控制套接字转发的工具调用请求，用于避免回环调用和负载均衡亲和问题。
 */
class RunnerToolRequest {
  /**
   * 构造工具调用请求实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.SupportsCancel = init.SupportsCancel ?? false;
    this.Token = init.Token ?? "";
    this.Body = init.Body ?? null;
  }
}

/**
 * 表示工具调用请求的响应载荷或错误信息。
 */
class RunnerToolResponse {
  /**
   * 构造工具调用响应实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Body = init.Body ?? null;
    this.Error = init.Error ?? "";
  }
}

/**
 * 表示沙箱镜像构建的步骤进度，不包含 Docker 原始日志、构建参数或环境变量。
 */
class WorkspaceImageBuildProgress {
  /**
   * 构造镜像构建进度实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Step = init.Step ?? "";
    this.Done = init.Done ?? false;
    this.Failed = init.Failed ?? false;
  }
}

/**
 * 描述工作区检查点分块传输的元数据与数据片段。
 */
class WorkspaceCheckpointTransfer {
  /**
   * 构造检查点分块传输对象，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Size = init.Size ?? 0;
    this.SHA256 = init.SHA256 ?? "";
    this.Offset = init.Offset ?? 0;
    this.Data = init.Data ?? null;
  }
}

/**
 * 判断给定的工作区操作是否为持有工作区锁且支持取消的同步请求。
 * 会话进程拥有独立的停止协议，不包含在此集合中。
 * @param {string} op - 工作区操作名称常量。
 * @returns {boolean} 属于可取消同步工作区操作时返回 `true`，否则返回 `false`。
 */
function IsCancelableRunnerWorkspaceOperation(op) {
  return IsWorkspaceCheckpointTransferOperation(op) || op === RunnerWorkspaceOperationCheckpoint || op === RunnerWorkspaceOperationPrepare;
}

/**
 * 判断给定的工作区操作是否属于检查点分块导出/上传传输系列操作。
 * 在工作区锁控制与取消调度中调用。
 * @param {string} op - 工作区操作名称常量。
 * @returns {boolean} 属于检查点传输操作时返回 `true`，否则返回 `false`。
 */
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

/**
 * 表示执行机器对工作区控制请求返回的统一响应信封。
 */
class RunnerWorkspaceResponse {
  /**
   * 构造工作区响应对象，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Payload = init.Payload ?? null;
    this.Error = init.Error ?? "";
    this.Code = init.Code ?? "";
    this.Status = init.Status ?? 0;
  }
}

const WorkspaceErrorBusy = "workspace_busy";
const WorkspaceErrorMissing = "workspace_missing";
// 独占人工终端正占用工作区，在用户关闭前等待无效。
const WorkspaceErrorTerminalActive = "workspace_terminal_active";
// 承载来自执行机器、可安全展示的会话级工作区准备错误。
const WorkspaceErrorConversationState = "conversation_state";

/**
 * 描述与 SOP 执行分开追踪的工作区恢复状态。
 */
class WorkspaceRestoreStatus {
  /**
   * 构造工作区恢复状态实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Status = init.Status ?? "";
    this.StartedAt = init.StartedAt ?? null;
    this.Error = init.Error ?? "";
  }
}

/**
 * 承载瞬时交互终端（PTY）控制与输入数据，不落盘到聊天或运行日志。
 */
class WorkspaceTerminalRequest {
  /**
   * 构造终端请求实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ExpiresAt = init.ExpiresAt ?? null;
    this.Operation = init.Operation ?? "";
    this.ID = init.ID ?? "";
    this.Data = init.Data ?? "";
    this.Cols = init.Cols ?? 0;
    this.Rows = init.Rows ?? 0;
  }
}

/**
 * 描述从任务面板驱动运行内 Agent 浏览器的控制请求，画面帧与输入均为瞬时数据不落盘。
 */
class BrowserRequest {
  /**
   * 构造浏览器控制请求实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Operation = init.Operation ?? "";
    this.After = init.After ?? 0;
    this.WaitMs = init.WaitMs ?? 0;
    this.URL = init.URL ?? "";
    this.TargetID = init.TargetID ?? "";
    this.Width = init.Width ?? 0;
    this.Height = init.Height ?? 0;
    this.FrameWidth = init.FrameWidth ?? 0;
    this.Events = init.Events ?? [];
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

/**
 * 表示按视口比例归一化（0 到 1）的页面坐标点。
 */
class BrowserPoint {
  /**
   * 构造视口比例坐标点实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.X = init.X ?? 0;
    this.Y = init.Y ?? 0;
  }
}

/**
 * 描述在 Agent 浏览器页面指定坐标点下检出的 DOM 元素及其几何矩形信息。
 */
class BrowserInspection {
  /**
   * 构造页面元素检查结果实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Label = init.Label ?? "";
    this.Rect = init.Rect ?? null;
    this.Viewport = init.Viewport ?? null;
    this.Element = init.Element ?? null;
  }
}

/**
 * 描述代理发往运行沙箱网络命名空间内 `http://localhost:Port` 的单次 HTTP 请求。
 */
class BrowserHTTPRequest {
  /**
   * 构造代理 HTTP 请求实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Port = init.Port ?? 0;
    this.Method = init.Method ?? "";
    this.Path = init.Path ?? "";
    this.Header = init.Header ?? {};
    this.Body = init.Body ?? null;
  }
}

/**
 * 描述沙箱内开发服务器对 `BrowserHTTPRequest` 返回的 HTTP 响应。
 */
class BrowserHTTPResponse {
  /**
   * 构造代理 HTTP 响应实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Status = init.Status ?? 0;
    this.Header = init.Header ?? {};
    this.Body = init.Body ?? null;
  }
}

/**
 * 描述转发到 Agent 浏览器的单个鼠标、滚轮或键盘输入事件，坐标按画面帧归一化（0 到 1）。
 */
class BrowserInputEvent {
  /**
   * 构造浏览器输入事件实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

/**
 * 描述 Agent 浏览器中单个标签页的基本信息与激活状态。
 */
class BrowserTab {
  /**
   * 构造浏览器标签页实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Title = init.Title ?? "";
    this.URL = init.URL ?? "";
    this.Active = init.Active ?? false;
  }
}

/**
 * 描述 Agent 浏览器当前的整体状态，包括画面帧、尺寸、滚动位置、标签页、快照及代理响应。
 */
class BrowserState {
  /**
   * 构造浏览器状态实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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
    this.Tabs = init.Tabs ?? [];
    this.Snapshot = init.Snapshot ?? null;
    this.HTTP = init.HTTP ?? null;
    this.Inspect = init.Inspect ?? null;
  }
}

/**
 * 描述供语言模型阅读与交互的当前激活页面文本快照及其可寻址元素列表。
 */
class BrowserSnapshot {
  /**
   * 构造页面快照实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Text = init.Text ?? "";
    this.Truncated = init.Truncated ?? false;
    this.Elements = init.Elements ?? [];
  }
}

/**
 * 描述页面快照中可被引用（ref）定位的单个交互元素状态。
 */
class BrowserElement {
  /**
   * 构造快照元素实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Ref = init.Ref ?? "";
    this.Role = init.Role ?? "";
    this.Name = init.Name ?? "";
    this.Value = init.Value ?? "";
    this.Checked = init.Checked ?? false;
    this.Disabled = init.Disabled ?? false;
  }
}

/**
 * 描述一份不可变的已归档工作区产物文件，恢复工作区时仅在目标文件不存在时写入。
 */
class WorkspaceArtifactFile {
  /**
   * 构造归档产物文件实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Path = init.Path ?? "";
    this.Content = init.Content ?? "";
    this.SHA256 = init.SHA256 ?? "";
  }
}

module.exports = { RunnerWorkspaceOperationCheckpointStatus, RunnerWorkspaceOperationCheckpointExport, RunnerWorkspaceOperationCheckpointRead, RunnerWorkspaceOperationCheckpointClose, RunnerWorkspaceOperationCheckpointUpload, RunnerWorkspaceOperationCheckpointAppend, RunnerWorkspaceOperationCheckpointCommit, RunnerWorkspaceOperationArtifacts, RunnerWorkspaceOperationReclaim, RunnerWorkspaceOperationCheckpoint, RunnerWorkspaceOperationRestore, RunnerWorkspaceOperationPrepare, RunnerWorkspaceOperationPreparationStatus, RunnerWorkspaceOperationPreparationRecord, RunnerWorkspaceOperationTerminal, RunnerWorkspaceOperationWrite, RunnerWorkspaceOperationInfo, RunnerWorkspaceOperationTree, RunnerWorkspaceOperationFile, RunnerWorkspaceOperationDiff, RunnerWorkspaceOperationSearch, RunnerWorkspaceOperationLog, RunnerWorkspaceOperationCommit, RunnerWorkspaceOperationBrowser, RunnerWorkspaceOperationCheckouts, RunnerWorkspaceOperationMaintenance, RunnerWorkspaceOperationLoginModels, RunnerWorkspaceOperationSSHHostKeyProbe, RunnerWorkspaceOperationConversationCLI, RunnerSSHKnownHostsWireLimit, RunnerSSHHostKeyProbeHeader, GitSSHKnownHosts, RunnerWorkspaceRequest, RunnerMaintenanceRequest, RunnerMaintenanceResult, RunnerToolRequest, RunnerToolResponse, WorkspaceImageBuildProgress, WorkspaceCheckpointTransfer, IsCancelableRunnerWorkspaceOperation, IsWorkspaceCheckpointTransferOperation, RunnerWorkspaceResponse, WorkspaceErrorBusy, WorkspaceErrorMissing, WorkspaceErrorTerminalActive, WorkspaceErrorConversationState, WorkspaceRestoreStatus, WorkspaceTerminalRequest, BrowserRequest, BrowserPoint, BrowserInspection, BrowserHTTPRequest, BrowserHTTPResponse, BrowserInputEvent, BrowserTab, BrowserState, BrowserSnapshot, BrowserElement, WorkspaceArtifactFile };
