// runner.js —— 对应 Go 文件：internal/domain/runner.go
// 作用：执行机器（Runner）连接模型、Runner 任务与调用包。

"use strict";

const pathPosix = require("node:path").posix;

// cleanPath：Go path.Clean 的对应实现（去掉多余斜杠与末尾斜杠）。
function cleanPath(p) {
  const n = pathPosix.normalize(p);
  return n.length > 1 ? n.replace(/\/$/, "") : n;
}

const RunnerStatusOnline = "online";
const RunnerStatusOffline = "offline";

// RunnerTask 状态。
const RunnerTaskQueued = "queued";
const RunnerTaskLeased = "leased";
const RunnerTaskRunning = "running";
const RunnerTaskSuccess = "success";
const RunnerTaskFailed = "failed";
const RunnerTaskCanceled = "canceled";

// RunnerTaskDesiredState 随租约续期响应携带，让取消无需额外轮询通道。
const RunnerTaskDesiredCancel = "cancel";
const RunnerTaskActionCleanupRun = "cleanup_run";
const RunnerTaskActionArchivePreview = "archive_preview";
const RunnerTaskActionPullWorkBranch = "pull_work_branch";
const RunnerTaskActionPushWorkBranch = "push_work_branch";
const RunnerTaskActionIntegrate = "integrate";
const RunnerTaskActionAlignBaseline = "align_baseline";

// RunnerVersionWorkBranchSync：首个执行 pull/push 工作分支动作的版本。
const RunnerVersionWorkBranchSync = "0.2.0";

// RunnerVersionReportedOutputs：首个写 Invocation.Inputs 并上报 Outputs 的版本。
const RunnerVersionReportedOutputs = "0.3.0";

// RunnerVersionIntegrate：首个执行 integrate 动作的版本。
const RunnerVersionIntegrate = "0.4.0";

// RunnerVersionAlignBaseline：首个执行 align_baseline 动作的版本。
const RunnerVersionAlignBaseline = "0.5.0";

// RunnerVersionWorkspacePreparation：首个准备恢复后工作区并绑定交互终端的版本。
const RunnerVersionWorkspacePreparation = "0.6.0";

// RunnerVersionWorkspaceOwnerPreparation：支持子运行的已准备沙箱归属父运行检出。
const RunnerVersionWorkspaceOwnerPreparation = "0.7.1";

const RunnerVersionConversationWorkspace = "0.8.0";

// RunnerVersionConversationCLI：会话 CLI 执行含可取消的工作区导出与启动取消。
const RunnerVersionConversationCLI = "0.10.1";

// RunnerVersionCLISettings：机器卡片上支持聊天账号登录、CLI 测试与模型发现。
const RunnerVersionCLISettings = "0.10.2";

// RunnerVersionDefaultSelection：用户可选为默认执行机器的最老版本。
const RunnerVersionDefaultSelection = RunnerVersionConversationWorkspace;

// RunnerVersionSharedPush：首个直接合入并推送共享分支的版本。
const RunnerVersionSharedPush = "0.9.0";

const RunnerVersionGitSSH = "0.9.3";

// RunnerVersionGitHTTP：首个经会话网关应答 Git 凭据请求的版本。
const RunnerVersionGitHTTP = "0.11.0";

// RunnerVersionGitSSHKnownHosts：首个接受平台 SSH pin 的版本。
const RunnerVersionGitSSHKnownHosts = "0.11.1";

// RunnerVersionCodeBuddyBaseURL：旧版本会忽略自定义端点而用官方端点。
const RunnerVersionCodeBuddyBaseURL = "0.11.2";

// RunnerVersionRepositoryCache：首个复用宿主机缓存检出仓库的版本。
const RunnerVersionRepositoryCache = "0.12.0";

// RunnerVersionExistingWorkBranch：首个在明确续用既有分支时拒绝新建的版本。
const RunnerVersionExistingWorkBranch = "0.7.0";

// RunnerVersionCreateNewWorkBranch：首个在要求新建分支时拒绝同名远端分支的版本。
const RunnerVersionCreateNewWorkBranch = "0.9.1";

class Runner {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.OS = init.OS ?? "";
    this.Arch = init.Arch ?? "";
    this.RunnerVersion = init.RunnerVersion ?? "";
    this.Labels = init.Labels ?? null;
    this.MaxConcurrency = init.MaxConcurrency ?? 0;
    this.NativeSandboxAvailable = init.NativeSandboxAvailable ?? false;
    this.RunLimit = init.RunLimit ?? 0;
    this.Status = init.Status ?? "";
    this.Runtimes = init.Runtimes ?? null;
    this.LastSeenAt = init.LastSeenAt ?? null;
    this.OwnerUserID = init.OwnerUserID ?? 0;
    this.SessionTokenHash = init.SessionTokenHash ?? "";
    this.SessionExpiresAt = init.SessionExpiresAt ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  SupportsCLISettings() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionCLISettings);
  }

  SupportsConversationCLI() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionConversationCLI);
  }

  SupportsConversationWorkspace() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionConversationWorkspace);
  }

  // DefaultSelectionBlocker：说明该机器为何不能设为默认执行机器，能设时返回 ""。
  DefaultSelectionBlocker() {
    if (this.Status !== RunnerStatusOnline) {
      return "机器离线，不能设为默认执行机器，请先在该机器上启动执行机器服务";
    }
    if (!versionAtLeast(this.RunnerVersion, RunnerVersionDefaultSelection)) {
      let version = this.RunnerVersion.trim();
      if (version === "") {
        version = "未知";
      }
      return `执行机器版本 ${version} 过低，需升级至 ${RunnerVersionDefaultSelection} 及以上才能设为默认`;
    }
    return "";
  }

  SupportsGitSSH() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionGitSSH);
  }

  SupportsGitHTTP() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionGitHTTP);
  }

  SupportsCodeBuddyBaseURL() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionCodeBuddyBaseURL);
  }

  SupportsSharedPush() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionSharedPush);
  }

  SupportsExistingWorkBranch() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionExistingWorkBranch);
  }

  SupportsCreateNewWorkBranch() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionCreateNewWorkBranch);
  }

  SupportsWorkspacePreparation() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionWorkspacePreparation);
  }

  SupportsWorkspaceOwnerPreparation() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionWorkspaceOwnerPreparation);
  }

  SupportsAlignBaseline() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionAlignBaseline);
  }

  SupportsIntegrate() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionIntegrate);
  }

  SupportsWorkBranchSync() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionWorkBranchSync);
  }

  SupportsReportedOutputs() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionReportedOutputs);
  }

  // SupportsProvider：该机器最近是否上报过该 provider 的运行时。
  SupportsProvider(provider) {
    provider = provider.trim();
    if (provider === "") {
      return false;
    }
    for (const rt of this.Runtimes ?? []) {
      if (rt.Provider.toLowerCase() === provider.toLowerCase() && rt.Status !== RuntimeStatusDisabled) {
        return true;
      }
    }
    return false;
  }

  // RuntimeAuthMode：返回该 provider 配置的凭据来源。
  RuntimeAuthMode(provider) {
    if (IsAgentCLIKind(provider) && !SupportsRunnerLogin(provider)) {
      return RuntimeAuthPersonal;
    }
    provider = provider.trim();
    for (const rt of this.Runtimes ?? []) {
      if (rt.Provider.toLowerCase() === provider.toLowerCase()) {
        if (rt.AuthMode === RuntimeAuthPersonal) {
          return RuntimeAuthPersonal;
        }
        if (rt.AuthMode === RuntimeAuthLocal) {
          return RuntimeAuthLocal;
        }
        break;
      }
    }
    if (provider.toLowerCase() === "codebuddy") {
      return RuntimeAuthPersonal;
    }
    return RuntimeAuthLocal;
  }
}

// PublicRunner：去掉凭据后再把 runner 数据返回给管理调用方。
function PublicRunner(r) {
  const out = { ...r };
  out.SessionTokenHash = "";
  out.SessionExpiresAt = null;
  return out;
}

function PublicRunners(items) {
  return (items ?? []).map((r) => PublicRunner(r));
}

// versionAtLeast：比较点分数字版本，格式错误视为更旧。
function versionAtLeast(have, want) {
  const parse = (v) => {
    const s = v.trim();
    const t = s.startsWith("v") ? s.slice(1) : s;
    const parts = t.split(".");
    const out = [];
    for (const part of parts) {
      if (!/^[+-]?\d+$/.test(part)) {
        return null;
      }
      out.push(Number.parseInt(part, 10));
    }
    return out;
  };
  const h = parse(have);
  if (h === null) {
    return false;
  }
  const w = parse(want) ?? [];
  for (let i = 0; i < w.length; i++) {
    let hv = 0;
    if (i < h.length) {
      hv = h[i];
    }
    if (hv !== w[i]) {
      return hv > w[i];
    }
  }
  return true;
}

function SupportsRunnerLogin(provider) {
  switch (provider.trim().toLowerCase()) {
    case "codex":
    case "claude-code":
    case "agy":
      return true;
    default:
      return false;
  }
}

const RuntimeStatusOnline = "online";
const RuntimeStatusOffline = "offline";
const RuntimeStatusDisabled = "disabled";
const RuntimeAuthLocal = "local";
const RuntimeAuthPersonal = "personal";
const RuntimeCapabilityManagedUpdate = "managed_update";
const RuntimeCapabilityNativeUpdate = "native_update";

// RunnerRuntime：执行机器上发现的一个 Agent CLI。
class RunnerRuntime {
  constructor(init = {}) {
    this.Provider = init.Provider ?? "";
    this.BinaryPath = init.BinaryPath ?? "";
    this.Version = init.Version ?? "";
    this.Capabilities = init.Capabilities ?? null;
    this.Status = init.Status ?? "";
    this.AuthMode = init.AuthMode ?? "";
  }

  SupportsCLIUpdate() {
    for (const capability of this.Capabilities ?? []) {
      if (capability === RuntimeCapabilityManagedUpdate || capability === RuntimeCapabilityNativeUpdate) {
        return true;
      }
    }
    return false;
  }
}

class RunnerTask {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.RunnerID = init.RunnerID ?? "";
    this.Provider = init.Provider ?? "";
    this.Prompt = init.Prompt ?? "";
    this.Workspace = init.Workspace ?? "";
    this.Args = init.Args ?? null;
    this.Status = init.Status ?? "";
    this.DesiredState = init.DesiredState ?? "";
    this.LeaseOwner = init.LeaseOwner ?? "";
    this.LeaseUntil = init.LeaseUntil ?? null;
    this.Attempt = init.Attempt ?? 0;
    this.MaxAttempts = init.MaxAttempts ?? 0;
    this.ExitCode = init.ExitCode ?? null;
    this.Result = init.Result ?? "";
    this.Error = init.Error ?? "";
    this.StartedAt = init.StartedAt ?? null;
    this.CompletedAt = init.CompletedAt ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Invocation = init.Invocation ?? null;
    this.GitSSHKnownHosts = init.GitSSHKnownHosts ?? null;
    this.Sandbox = init.Sandbox ?? null;
    this.Command = init.Command ?? "";
    this.Action = init.Action ?? "";
    this.WorkBranchMessage = init.WorkBranchMessage ?? "";
    this.IntegrationLabel = init.IntegrationLabel ?? "";
    this.Artifacts = init.Artifacts ?? null;
    this.Outputs = init.Outputs ?? null;
    this.PreviewArchive = init.PreviewArchive ?? null;
  }
}

// RunnerSandboxRequirements：冻结所有运行节点所需沙箱能力的并集。
class RunnerSandboxRequirements {
  constructor(init = {}) {
    this.CLIStates = init.CLIStates ?? null;
    this.PrivateHome = init.PrivateHome ?? false;
    this.BunFS = init.BunFS ?? false;
    this.RunnerLoginRelay = init.RunnerLoginRelay ?? false;
  }
}

class RunnerCLIStateRequirement {
  constructor(init = {}) {
    this.Directory = init.Directory ?? "";
    this.Files = init.Files ?? null;
  }
}

class RunnerSandboxSpec {
  constructor(init = {}) {
    this.Requirements = init.Requirements ?? null;
    this.Profile = init.Profile ?? null;
    this.Dockerfile = init.Dockerfile ?? null;
  }

  // UnmarshalJSON：把冻结环境资产里的普通变量带到当前沙箱。
  UnmarshalJSON(raw) {
    const payload = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    // Go 把整个结构重置为冻结部分的零值，再处理环境变量。
    const fresh = new RunnerSandboxSpec();
    Object.assign(this, fresh);
    this.Requirements = payload.requirements ?? null;
    this.Profile = payload.profile ?? {};
    this.Dockerfile = payload.dockerfile ?? null;
    const driver = (this.Profile.Driver ?? "").trim();
    const envID = ((payload.environment ?? {}).id ?? "").trim();
    if (!ConversationSandboxDriver(driver) || driver === SandboxDriverDocker || envID === "") {
      return;
    }
    const variables = (payload.environment ?? {}).variables ?? {};
    for (const [key, value] of Object.entries(variables)) {
      if (key === "PATH" || value.includes("$PREFIX") || value.includes("${PREFIX}") ||
        value.includes("$AGENTFLOW_ENVIRONMENT_ROOT") || value.includes("${AGENTFLOW_ENVIRONMENT_ROOT}")) {
        continue;
      }
      if (this.Profile.Environment != null && Object.prototype.hasOwnProperty.call(this.Profile.Environment, key)) {
        continue;
      }
      if (this.Profile.Environment == null) {
        this.Profile.Environment = {};
      }
      this.Profile.Environment[key] = value;
    }
  }
}

// PublicRunnerTask：去掉任务级凭据后再返回给管理调用方。
function PublicRunnerTask(task) {
  const out = { ...task };
  out.GitSSHKnownHosts = null;
  if (out.PreviewArchive != null) {
    const copySpec = { ...out.PreviewArchive };
    copySpec.UploadToken = "";
    out.PreviewArchive = copySpec;
  }
  if (out.Invocation == null) {
    return out;
  }
  const copyInvocation = { ...out.Invocation };
  copyInvocation.CodeBuddyAPIKey = "";
  copyInvocation.CodeBuddyBaseURL = "";
  copyInvocation.CodeBuddyInternetEnvironment = "";
  copyInvocation.CodexAPIKey = "";
  copyInvocation.CodexBaseURL = "";
  copyInvocation.ClaudeCodeAPIKey = "";
  copyInvocation.ClaudeCodeBaseURL = "";
  copyInvocation.AgentCLIAPIKey = "";
  copyInvocation.AgentCLIBaseURL = "";
  copyInvocation.AgentCLIProtocol = "";
  copyInvocation.AgentCLIModels = null;
  copyInvocation.GitSSHUserID = 0;
  copyInvocation.GitSSHKeys = null;
  copyInvocation.GitHTTPUserID = 0;
  copyInvocation.GitHTTPCredentials = null;
  if (copyInvocation.Repository != null) {
    copyInvocation.Repository = publicRunnerRepository(copyInvocation.Repository);
  }
  if ((copyInvocation.Repositories ?? []).length > 0) {
    copyInvocation.Repositories = copyInvocation.Repositories.map((repository) => publicRunnerRepository(repository));
  }
  out.Invocation = copyInvocation;
  return out;
}

// publicRunnerRepository：去掉一份检出配置里的 Git 凭据。
function publicRunnerRepository(repository) {
  const out = { ...repository };
  out.GitToken = "";
  out.CloneURL = StripURLCredentials(out.CloneURL);
  return out;
}

// RunnerInvocation：runner 守护进程重建一次 Agent 节点调用所需的自包含包。
class RunnerInvocation {
  constructor(init = {}) {
    this.ArchivedFiles = init.ArchivedFiles ?? null;
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.InvocationID = init.InvocationID ?? "";
    this.ResumeSessionID = init.ResumeSessionID ?? "";
    this.GateResultPath = init.GateResultPath ?? "";
    this.Executor = init.Executor ?? null;
    this.Agent = init.Agent ?? null;
    this.Assets = init.Assets ?? null;
    this.Artifacts = init.Artifacts ?? null;
    this.ArtifactDirectory = init.ArtifactDirectory ?? "";
    this.Inputs = init.Inputs ?? null;
    this.ReportOutputs = init.ReportOutputs ?? false;
    this.OutputFiles = init.OutputFiles ?? null;
    this.RecoverOutputs = init.RecoverOutputs ?? false;
    this.HumanContext = init.HumanContext ?? "";
    this.CredentialSource = init.CredentialSource ?? "";
    this.CodeBuddyAPIKey = init.CodeBuddyAPIKey ?? "";
    this.CodeBuddyBaseURL = init.CodeBuddyBaseURL ?? "";
    this.CodeBuddyInternetEnvironment = init.CodeBuddyInternetEnvironment ?? "";
    this.CodexAPIKey = init.CodexAPIKey ?? "";
    this.CodexBaseURL = init.CodexBaseURL ?? "";
    this.ClaudeCodeAPIKey = init.ClaudeCodeAPIKey ?? "";
    this.ClaudeCodeBaseURL = init.ClaudeCodeBaseURL ?? "";
    this.AgentCLIAPIKey = init.AgentCLIAPIKey ?? "";
    this.AgentCLIBaseURL = init.AgentCLIBaseURL ?? "";
    this.AgentCLIProtocol = init.AgentCLIProtocol ?? "";
    this.AgentCLIModels = init.AgentCLIModels ?? null;
    this.MCPCallServers = init.MCPCallServers ?? null;
    this.GitUserName = init.GitUserName ?? "";
    this.GitUserEmail = init.GitUserEmail ?? "";
    this.Repository = init.Repository ?? null;
    this.GitSSHUserID = init.GitSSHUserID ?? 0;
    this.GitSSHKeys = init.GitSSHKeys ?? null;
    this.GitHTTPUserID = init.GitHTTPUserID ?? 0;
    this.GitHTTPCredentials = init.GitHTTPCredentials ?? null;
    this.RepositoryPreparationFallback = init.RepositoryPreparationFallback ?? false;
    this.Repositories = init.Repositories ?? null;
  }

  GitSSHRemotes() {
    let remotes = null;
    if (this != null) {
      for (const repository of this.Repositories ?? []) {
        if (repository.UseSSH) {
          remotes = [...(remotes ?? []), repository.CloneURL];
        }
      }
      if ((this.Repositories ?? []).length === 0 && this.Repository != null && this.Repository.UseSSH) {
        remotes = [...(remotes ?? []), this.Repository.CloneURL];
      }
    }
    return remotes;
  }
}

// RunnerRepository：runner 机器应创建的检出描述。
class RunnerRepository {
  constructor(init = {}) {
    this.RepositoryID = init.RepositoryID ?? "";
    this.Name = init.Name ?? "";
    this.CloneURL = init.CloneURL ?? "";
    this.Ref = init.Ref ?? "";
    this.WorkBranch = init.WorkBranch ?? "";
    this.GitToken = init.GitToken ?? "";
    this.UseSSH = init.UseSSH ?? false;
    this.RequireExistingWorkBranch = init.RequireExistingWorkBranch ?? false;
    this.CreateNewWorkBranch = init.CreateNewWorkBranch ?? false;
    this.Dir = init.Dir ?? "";
    this.SyncWorkBranch = init.SyncWorkBranch ?? false;
    this.IntegrateBranch = init.IntegrateBranch ?? "";
    this.PushIntegrate = init.PushIntegrate ?? false;
    this.SharedPushTarget = init.SharedPushTarget ?? "";
    this.DefaultBranch = init.DefaultBranch ?? "";
  }
}

// RunnerInputFile：运行前写入任务工作区的一个文件。
class RunnerInputFile {
  constructor(init = {}) {
    this.Path = init.Path ?? "";
    this.Content = init.Content ?? "";
  }
}

// RunnerTaskOutputs：runner 在调用或脚本后上报的工作区情况。
class RunnerTaskOutputs {
  constructor(init = {}) {
    this.Files = init.Files ?? null;
    this.TooLarge = init.TooLarge ?? null;
    this.Patches = init.Patches ?? null;
    this.Recovered = init.Recovered ?? null;
    this.Facts = init.Facts ?? null;
  }
}

// RunnerWorkspaceFacts：控制面曾从自有工作区副本读取的工作区属性。
class RunnerWorkspaceFacts {
  constructor(init = {}) {
    this.Frontend = init.Frontend ?? false;
    this.FrontendEvidence = init.FrontendEvidence ?? "";
  }
}

// RunnerIntegrationResult：一次 integrate 动作对一个仓库的结果。
class RunnerIntegrationResult {
  constructor(init = {}) {
    this.RepositoryID = init.RepositoryID ?? "";
    this.Name = init.Name ?? "";
    this.WorkBranch = init.WorkBranch ?? "";
    this.IntegrateBranch = init.IntegrateBranch ?? "";
    this.Head = init.Head ?? "";
    this.Conflicts = init.Conflicts ?? null;
    this.PushedIntegrate = init.PushedIntegrate ?? false;
  }
}

// RunnerAlignResult：一次 align_baseline 的结果。
class RunnerAlignResult {
  constructor(init = {}) {
    this.Head = init.Head ?? "";
    this.Conflicts = init.Conflicts ?? null;
    this.Blocks = init.Blocks ?? null;
  }
}

class RunnerWorkBranchHead {
  constructor(init = {}) {
    this.RepositoryID = init.RepositoryID ?? "";
    this.Name = init.Name ?? "";
    this.WorkBranch = init.WorkBranch ?? "";
    this.Head = init.Head ?? "";
    this.SharedBranch = init.SharedBranch ?? "";
    this.SharedHead = init.SharedHead ?? "";
  }
}

// RunnerTaskEvent：runner 上报的一条批量输出记录。
class RunnerTaskEvent {
  constructor(init = {}) {
    this.Seq = init.Seq ?? 0;
    this.Type = init.Type ?? "";
    this.Data = init.Data ?? "";
    this.Ts = init.Ts ?? null;
  }
}

// SafeWorkspaceRelPath：p 是否为工作区内干净的斜杠分隔相对路径。
function SafeWorkspaceRelPath(p) {
  if (p === "" || p.includes("\\") || p.startsWith("/")) {
    return false;
  }
  const clean = cleanPath(p);
  return clean === p && clean !== "." && clean !== ".." && !clean.startsWith("../");
}

module.exports = { RunnerStatusOnline, RunnerStatusOffline, RunnerTaskQueued, RunnerTaskLeased, RunnerTaskRunning, RunnerTaskSuccess, RunnerTaskFailed, RunnerTaskCanceled, RunnerTaskDesiredCancel, RunnerTaskActionCleanupRun, RunnerTaskActionArchivePreview, RunnerTaskActionPullWorkBranch, RunnerTaskActionPushWorkBranch, RunnerTaskActionIntegrate, RunnerTaskActionAlignBaseline, RunnerVersionWorkBranchSync, RunnerVersionReportedOutputs, RunnerVersionIntegrate, RunnerVersionAlignBaseline, RunnerVersionWorkspacePreparation, RunnerVersionWorkspaceOwnerPreparation, RunnerVersionConversationWorkspace, RunnerVersionConversationCLI, RunnerVersionCLISettings, RunnerVersionDefaultSelection, RunnerVersionSharedPush, RunnerVersionGitSSH, RunnerVersionGitHTTP, RunnerVersionGitSSHKnownHosts, RunnerVersionCodeBuddyBaseURL, RunnerVersionRepositoryCache, RunnerVersionExistingWorkBranch, RunnerVersionCreateNewWorkBranch, Runner, PublicRunner, PublicRunners, SupportsRunnerLogin, RuntimeStatusOnline, RuntimeStatusOffline, RuntimeStatusDisabled, RuntimeAuthLocal, RuntimeAuthPersonal, RuntimeCapabilityManagedUpdate, RuntimeCapabilityNativeUpdate, RunnerRuntime, RunnerTask, RunnerSandboxRequirements, RunnerCLIStateRequirement, RunnerSandboxSpec, PublicRunnerTask, RunnerInvocation, RunnerRepository, RunnerInputFile, RunnerTaskOutputs, RunnerWorkspaceFacts, RunnerIntegrationResult, RunnerAlignResult, RunnerWorkBranchHead, RunnerTaskEvent, SafeWorkspaceRelPath };
