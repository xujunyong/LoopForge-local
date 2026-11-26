/**
 * @file internal/domain/runner.js
 * @description 对应 Go 文件：internal/domain/runner.go
 * 职责与边界：定义执行机器（Runner）的连接状态、版本能力探测、运行时描述、
 * 持久化任务（RunnerTask）、自包含调用包（RunnerInvocation）、沙箱规格与工作区结果类型，
 * 以及脱敏和工作区相对路径安全校验函数。
 * 语法差异说明：
 * - Go 切片零值初始化为 `[]`，普通映射 `map[string]V` 初始化为 `{}`，指针与 `time.Time` 初始化为 `null`。
 * - Go 多返回值 `(T, error)` 译为成功返回 `T`、失败 `throw Error`；仅 `error` 时成功无返回值、失败 `throw Error`。
 * - `RunnerSandboxSpec.UnmarshalJSON` 内通过函数内延迟 `require("./assets.js")` 避免与 `assets.js` 的循环依赖。
 */

"use strict";

const pathPosix = require("node:path").posix;
const { IsAgentCLIKind } = require("./agent.js");
const { StripURLCredentials } = require("./clone_url.js");

/**
 * 清理 POSIX 风格路径（对应 Go 标准库 `path.Clean`），合并多余斜杠并去除末尾斜杠。
 * 在工作区相对路径安全校验中用于规范化待检查路径。
 * @param {string} p - 待规范化的路径字符串。
 * @returns {string} 规范化后的 POSIX 路径。
 */
function cleanPath(p) {
  const n = pathPosix.normalize(p);
  return n.length > 1 ? n.replace(/\/$/, "") : n;
}

const RunnerStatusOnline = "online";
const RunnerStatusOffline = "offline";

// RunnerTask 状态；leased 位于 queued 与 running 之间，以便认领后未启动的任务可通过租约过期恢复。
const RunnerTaskQueued = "queued";
const RunnerTaskLeased = "leased";
const RunnerTaskRunning = "running";
const RunnerTaskSuccess = "success";
const RunnerTaskFailed = "failed";
const RunnerTaskCanceled = "canceled";

// RunnerTaskDesiredState 随租约续期响应携带，无需额外轮询通道即可通知取消或执行内置动作。
const RunnerTaskDesiredCancel = "cancel";
const RunnerTaskActionCleanupRun = "cleanup_run";
const RunnerTaskActionArchivePreview = "archive_preview";
const RunnerTaskActionPullWorkBranch = "pull_work_branch";
const RunnerTaskActionPushWorkBranch = "push_work_branch";
const RunnerTaskActionIntegrate = "integrate";
const RunnerTaskActionAlignBaseline = "align_baseline";

// 首个支持 pull/push 工作分支同步动作的执行机器版本。
const RunnerVersionWorkBranchSync = "0.2.0";

// 首个支持写入 Invocation.Inputs、清理门禁结果并上报 RunnerTask.Outputs 的版本。
const RunnerVersionReportedOutputs = "0.3.0";

// 首个支持 integrate（将集成分支合并进工作分支）动作的版本。
const RunnerVersionIntegrate = "0.4.0";

// 首个支持 align_baseline（将默认分支合并进集成分支）动作的版本。
const RunnerVersionAlignBaseline = "0.5.0";

// 首个支持准备恢复后的工作区并将交互终端绑定到冻结沙箱的版本。
const RunnerVersionWorkspacePreparation = "0.6.0";

// 支持在父运行检出目录中准备子运行沙箱，并按运行隔离就绪回执的版本。
const RunnerVersionWorkspaceOwnerPreparation = "0.7.1";

const RunnerVersionConversationWorkspace = "0.8.0";

// 会话 CLI 执行支持取消可抢占工作区导出与启动阶段取消的版本。
const RunnerVersionConversationCLI = "0.10.1";

// 在机器卡片中支持聊天账号登录、CLI 测试、模型发现与更新的版本。
const RunnerVersionCLISettings = "0.10.2";

// 用户可选为默认执行机器的最低版本要求。
const RunnerVersionDefaultSelection = RunnerVersionConversationWorkspace;

// 首个支持在临时工作树中直接将工作分支合并并推送到共享分支的版本。
const RunnerVersionSharedPush = "0.9.0";

const RunnerVersionGitSSH = "0.9.3";

// 首个通过会话网关应答 Git 凭据与 gh/glab 请求的版本。
const RunnerVersionGitHTTP = "0.11.0";

// 首个接受平台下发 SSH 主机密钥固定列表（known_hosts）的版本。
const RunnerVersionGitSSHKnownHosts = "0.11.1";

// 首个支持自定义 CodeBuddy Base URL 的版本（旧版本会忽略并走官方端点）。
const RunnerVersionCodeBuddyBaseURL = "0.11.2";

// 首个在 native 工作区检出仓库时复用宿主机缓存的版本。
const RunnerVersionRepositoryCache = "0.12.0";

// 首个在显式续用已有分支时拒绝自动新建缺失分支的版本。
const RunnerVersionExistingWorkBranch = "0.7.0";

// 首个在要求新建分支时拒绝已有同名远端分支的版本。
const RunnerVersionCreateNewWorkBranch = "0.9.1";

/**
 * 表示一台运行在用户机器或云主机上、通过出站 HTTPS 连接控制面的长驻执行机器（Runner）。
 * 用于调度任务、查询可用 Agent CLI 运行时及判断版本能力。
 */
class Runner {
  /**
   * 构造执行机器实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.OS = init.OS ?? "";
    this.Arch = init.Arch ?? "";
    this.RunnerVersion = init.RunnerVersion ?? "";
    this.Labels = init.Labels ?? [];
    this.MaxConcurrency = init.MaxConcurrency ?? 0;
    this.NativeSandboxAvailable = init.NativeSandboxAvailable ?? false;
    this.RunLimit = init.RunLimit ?? 0;
    this.Status = init.Status ?? "";
    this.Runtimes = init.Runtimes ?? [];
    this.LastSeenAt = init.LastSeenAt ?? null;
    this.OwnerUserID = init.OwnerUserID ?? 0;
    this.SessionTokenHash = init.SessionTokenHash ?? "";
    this.SessionExpiresAt = init.SessionExpiresAt ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  /**
   * 判断该执行机器版本是否支持机器卡片上的 CLI 登录、测试、模型发现与更新能力。
   * 在前端展示或接口派发 CLI 设置操作前调用。
   * @returns {boolean} 版本达到 `RunnerVersionCLISettings` 时返回 `true`，否则返回 `false`。
   */
  SupportsCLISettings() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionCLISettings);
  }

  /**
   * 判断该执行机器版本是否支持带取消能力的会话 CLI 执行协议。
   * 在启动或路由会话 CLI 任务前调用。
   * @returns {boolean} 版本达到 `RunnerVersionConversationCLI` 时返回 `true`，否则返回 `false`。
   */
  SupportsConversationCLI() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionConversationCLI);
  }

  /**
   * 判断该执行机器版本是否支持会话工作区能力。
   * 在创建或打开会话工作区前调用。
   * @returns {boolean} 版本达到 `RunnerVersionConversationWorkspace` 时返回 `true`，否则返回 `false`。
   */
  SupportsConversationWorkspace() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionConversationWorkspace);
  }

  /**
   * 检查该执行机器为何不能被设为用户默认执行机器；满足条件时返回空字符串。
   * 用于个人执行器页面禁用「设为默认」按钮及服务端校验。
   * @returns {string} 阻塞原因提示文案；允许设为默认时返回空字符串 `""`。
   */
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

  /**
   * 判断该执行机器版本是否支持 Git SSH 密钥下发与检出。
   * 在组装使用 SSH 的仓库检出任务前调用。
   * @returns {boolean} 版本达到 `RunnerVersionGitSSH` 时返回 `true`，否则返回 `false`。
   */
  SupportsGitSSH() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionGitSSH);
  }

  /**
   * 判断该执行机器版本是否支持经会话网关应答 Git HTTPS 凭据请求。
   * 在下发 HTTPS Git 凭据执行前调用。
   * @returns {boolean} 版本达到 `RunnerVersionGitHTTP` 时返回 `true`，否则返回 `false`。
   */
  SupportsGitHTTP() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionGitHTTP);
  }

  /**
   * 判断该执行机器版本是否支持自定义 CodeBuddy Base URL。
   * 在下发自定义 CodeBuddy 端点配置前调用。
   * @returns {boolean} 版本达到 `RunnerVersionCodeBuddyBaseURL` 时返回 `true`，否则返回 `false`。
   */
  SupportsCodeBuddyBaseURL() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionCodeBuddyBaseURL);
  }

  /**
   * 判断该执行机器版本是否支持将工作分支直接合入并推送到共享分支。
   * 在执行共享分支直推前调用。
   * @returns {boolean} 版本达到 `RunnerVersionSharedPush` 时返回 `true`，否则返回 `false`。
   */
  SupportsSharedPush() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionSharedPush);
  }

  /**
   * 判断该执行机器版本是否支持严格续用已有工作分支（远端缺失时报错而非新建）。
   * 在需要严格续用既有分支的检出前调用。
   * @returns {boolean} 版本达到 `RunnerVersionExistingWorkBranch` 时返回 `true`，否则返回 `false`。
   */
  SupportsExistingWorkBranch() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionExistingWorkBranch);
  }

  /**
   * 判断该执行机器版本是否支持新建分支模式（同名远端分支已存在时报错拒绝）。
   * 在要求新建工作分支的任务派发前调用。
   * @returns {boolean} 版本达到 `RunnerVersionCreateNewWorkBranch` 时返回 `true`，否则返回 `false`。
   */
  SupportsCreateNewWorkBranch() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionCreateNewWorkBranch);
  }

  /**
   * 判断该执行机器版本是否支持工作区准备与交互终端沙箱绑定协议。
   * 在发送工作区准备或打开终端请求前调用。
   * @returns {boolean} 版本达到 `RunnerVersionWorkspacePreparation` 时返回 `true`，否则返回 `false`。
   */
  SupportsWorkspacePreparation() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionWorkspacePreparation);
  }

  /**
   * 判断该执行机器版本是否支持在父运行检出目录中准备子运行沙箱。
   * 在子运行复用父运行检出目录前调用。
   * @returns {boolean} 版本达到 `RunnerVersionWorkspaceOwnerPreparation` 时返回 `true`，否则返回 `false`。
   */
  SupportsWorkspaceOwnerPreparation() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionWorkspaceOwnerPreparation);
  }

  /**
   * 判断该执行机器版本是否支持执行 `align_baseline` 基线对齐动作。
   * 在入队基线对齐任务前调用。
   * @returns {boolean} 版本达到 `RunnerVersionAlignBaseline` 时返回 `true`，否则返回 `false`。
   */
  SupportsAlignBaseline() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionAlignBaseline);
  }

  /**
   * 判断该执行机器版本是否支持执行 `integrate` 集成合并动作。
   * 在入队集成合并任务前调用。
   * @returns {boolean} 版本达到 `RunnerVersionIntegrate` 时返回 `true`，否则返回 `false`。
   */
  SupportsIntegrate() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionIntegrate);
  }

  /**
   * 判断该执行机器版本是否支持 `pull_work_branch` / `push_work_branch` 工作分支同步动作。
   * 在入队工作分支拉取或推送任务前调用。
   * @returns {boolean} 版本达到 `RunnerVersionWorkBranchSync` 时返回 `true`，否则返回 `false`。
   */
  SupportsWorkBranchSync() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionWorkBranchSync);
  }

  /**
   * 判断该执行机器版本是否支持在任务完成时上报节点产出（文件、补丁与工作区事实）。
   * 在决定是否由执行机器直接上报产物前调用。
   * @returns {boolean} 版本达到 `RunnerVersionReportedOutputs` 时返回 `true`，否则返回 `false`。
   */
  SupportsReportedOutputs() {
    return versionAtLeast(this.RunnerVersion, RunnerVersionReportedOutputs);
  }

  /**
   * 判断该执行机器最近一次上报的运行时列表中是否包含指定 provider 且未被禁用。
   * 在选择可执行某类 Agent CLI 任务的执行机器时调用。
   * @param {string} provider - Agent CLI 提供方标识（不区分大小写）。
   * @returns {boolean} 存在匹配的未禁用运行时返回 `true`，否则返回 `false`。
   */
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

  /**
   * 返回指定 provider 在该执行机器上配置的凭据认证模式（`"local"` 或 `"personal"`）。
   * 不支持本机登录的扩展 Agent CLI 以及默认情况下的 CodeBuddy 使用个人凭据，其余默认使用本机登录态。
   * @param {string} provider - Agent CLI 提供方标识。
   * @returns {string} 认证模式常量：`RuntimeAuthLocal` 或 `RuntimeAuthPersonal`。
   */
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

/**
 * 剥离执行机器的会话令牌哈希与过期时间，返回适合管理接口展示的副本。
 * 在向管理端调用方返回单台执行机器数据时调用。
 * @param {Runner} r - 原始执行机器对象。
 * @returns {Object} 去除敏感会话字段后的浅拷贝对象。
 */
function PublicRunner(r) {
  const out = { ...r };
  out.SessionTokenHash = "";
  out.SessionExpiresAt = null;
  return out;
}

/**
 * 批量对执行机器列表执行脱敏处理，移除所有会话凭据字段。
 * 在管理接口返回执行机器列表时调用。
 * @param {Runner[]} items - 原始执行机器列表。
 * @returns {Object[]} 脱敏后的执行机器对象数组。
 */
function PublicRunners(items) {
  return (items ?? []).map((r) => PublicRunner(r));
}

/**
 * 比较两个点分数字版本号，判断 `have` 是否大于等于 `want`；格式非法时视为更旧。
 * 供 `Runner` 的各项版本能力判断方法内部调用。
 * @param {string} have - 实际版本字符串（可带 `v` 前缀）。
 * @param {string} want - 目标最低版本字符串（可带 `v` 前缀）。
 * @returns {boolean} `have >= want` 时返回 `true`，解析失败或版本更低时返回 `false`。
 */
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

/**
 * 判断指定 Agent CLI 提供方是否支持在执行机器本地通过账号登录并复用登录态。
 * 在确定运行时认证模式及展示登录入口时调用。
 * @param {string} provider - Agent CLI 提供方标识。
 * @returns {boolean} 为 `codex`、`claude-code` 或 `agy` 时返回 `true`，否则返回 `false`。
 */
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

/**
 * 描述执行机器上发现的单个 Agent CLI 运行时（路径、版本、能力、状态与认证模式）。
 * CLI 凭据保留在执行机器本地，控制面仅记录该元数据。
 */
class RunnerRuntime {
  /**
   * 构造执行机器运行时实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Provider = init.Provider ?? "";
    this.BinaryPath = init.BinaryPath ?? "";
    this.Version = init.Version ?? "";
    this.Capabilities = init.Capabilities ?? [];
    this.Status = init.Status ?? "";
    this.AuthMode = init.AuthMode ?? "";
  }

  /**
   * 判断该运行时是否声明了受管更新或原生更新能力。
   * 用于前端控制是否展示 CLI 一键升级按钮及后端维护接口校验。
   * @returns {boolean} 支持 CLI 更新时返回 `true`，否则返回 `false`。
   */
  SupportsCLIUpdate() {
    for (const capability of this.Capabilities ?? []) {
      if (capability === RuntimeCapabilityManagedUpdate || capability === RuntimeCapabilityNativeUpdate) {
        return true;
      }
    }
    return false;
  }
}

/**
 * 表示控制面持久化的一条执行机器任务单元，涵盖 Agent 调用、终端命令及内置守护进程动作。
 * 任务经租约认领与状态流转持久化存储，连接断开不会丢失任务。
 */
class RunnerTask {
  /**
   * 构造执行机器任务实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.RunnerID = init.RunnerID ?? "";
    this.Provider = init.Provider ?? "";
    this.Prompt = init.Prompt ?? "";
    this.Workspace = init.Workspace ?? "";
    this.Args = init.Args ?? [];
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
    this.Artifacts = init.Artifacts ?? {};
    this.Outputs = init.Outputs ?? null;
    this.PreviewArchive = init.PreviewArchive ?? null;
  }
}

/**
 * 冻结单次运行中所有节点所需沙箱能力的并集，使交互终端与脚本/Agent 任务共享同一沙箱身份。
 */
class RunnerSandboxRequirements {
  /**
   * 构造沙箱能力需求实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.CLIStates = init.CLIStates ?? [];
    this.PrivateHome = init.PrivateHome ?? false;
    this.BunFS = init.BunFS ?? false;
    this.RunnerLoginRelay = init.RunnerLoginRelay ?? false;
  }
}

/**
 * 描述需要在沙箱中挂载或保留的单个 CLI 状态目录及其关键文件列表。
 */
class RunnerCLIStateRequirement {
  /**
   * 构造 CLI 状态需求实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Directory = init.Directory ?? "";
    this.Files = init.Files ?? [];
  }
}

/**
 * 描述控制面解析并冻结后的执行机器沙箱规格，包含沙箱需求、配置档案与可选 Dockerfile 配方。
 */
class RunnerSandboxSpec {
  /**
   * 构造执行机器沙箱规格实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Requirements = init.Requirements ?? null;
    this.Profile = init.Profile ?? null;
    this.Dockerfile = init.Dockerfile ?? null;
  }

  /**
   * 从历史运行或已入队任务的 JSON 数据反序列化沙箱规格，并将旧版冻结环境资产中的普通环境变量迁入 `Profile.Environment`。
   * 内联配置的同名环境变量优先保留，跳过 `PATH` 及依赖旧环境前缀变量的条目。
   * @param {string|Buffer} raw - 待解析的 JSON 字节或字符串。
   * @returns {void} 无返回值；JSON 格式错误时抛出异常。
   */
  UnmarshalJSON(raw) {
    // 延迟引用同包 assets.js，避免与 assets.js 顶层引用 runner.js 形成循环依赖。
    const { ConversationSandboxDriver, SandboxDriverDocker } = require("./assets.js");
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

/**
 * 剥离执行机器任务中的全部任务级敏感凭据（上传令牌、CLI API Key、Git SSH/HTTP 凭据与克隆 URL 凭据）。
 * 在向管理接口调用方返回任务详情前调用；已认证的执行机器认领任务时仍接收原始载荷。
 * @param {RunnerTask} task - 原始执行机器任务对象。
 * @returns {Object} 去除敏感凭据字段后的任务副本对象。
 */
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

/**
 * 返回单份仓库检出配置的脱敏副本，清空 `GitToken` 并移除 `CloneURL` 中内嵌的凭据。
 * 供 `PublicRunnerTask` 内部调用。
 * @param {RunnerRepository} repository - 原始仓库检出配置对象。
 * @returns {Object} 去除 Git 凭据后的仓库检出配置副本。
 */
function publicRunnerRepository(repository) {
  const out = { ...repository };
  out.GitToken = "";
  out.CloneURL = StripURLCredentials(out.CloneURL);
  return out;
}

/**
 * 表示执行机器守护进程在本地工作区重建一次 Agent 节点调用所需的自包含配置包。
 * 包含执行器、角色、资产、产物契约、仓库检出配置以及按需注入的个人凭据。
 */
class RunnerInvocation {
  /**
   * 构造执行机器调用包实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ArchivedFiles = init.ArchivedFiles ?? [];
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.InvocationID = init.InvocationID ?? "";
    this.ResumeSessionID = init.ResumeSessionID ?? "";
    this.GateResultPath = init.GateResultPath ?? "";
    this.Executor = init.Executor ?? null;
    this.Agent = init.Agent ?? null;
    this.Assets = init.Assets ?? null;
    this.Artifacts = init.Artifacts ?? [];
    this.ArtifactDirectory = init.ArtifactDirectory ?? "";
    this.Inputs = init.Inputs ?? [];
    this.ReportOutputs = init.ReportOutputs ?? false;
    this.OutputFiles = init.OutputFiles ?? [];
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
    this.AgentCLIModels = init.AgentCLIModels ?? [];
    this.MCPCallServers = init.MCPCallServers ?? [];
    this.GitUserName = init.GitUserName ?? "";
    this.GitUserEmail = init.GitUserEmail ?? "";
    this.Repository = init.Repository ?? null;
    this.GitSSHUserID = init.GitSSHUserID ?? 0;
    this.GitSSHKeys = init.GitSSHKeys ?? {};
    this.GitHTTPUserID = init.GitHTTPUserID ?? 0;
    this.GitHTTPCredentials = init.GitHTTPCredentials ?? {};
    this.RepositoryPreparationFallback = init.RepositoryPreparationFallback ?? false;
    this.Repositories = init.Repositories ?? [];
  }

  /**
   * 收集本次调用中所有启用 SSH 检出的仓库远端地址列表（兼容旧版单仓库字段 `Repository`）。
   * 在认领任务或建立控制连接时用于按需填充用户 SSH 私钥。
   * @returns {string[]} 启用 SSH 的仓库克隆地址列表。
   */
  GitSSHRemotes() {
    const remotes = [];
    if (this != null) {
      for (const repository of this.Repositories ?? []) {
        if (repository.UseSSH) {
          remotes.push(repository.CloneURL);
        }
      }
      if ((this.Repositories ?? []).length === 0 && this.Repository != null && this.Repository.UseSSH) {
        remotes.push(this.Repository.CloneURL);
      }
    }
    return remotes;
  }
}

/**
 * 描述执行机器应在任务工作区中创建或同步的单个代码仓库检出配置。
 */
class RunnerRepository {
  /**
   * 构造仓库检出配置实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

/**
 * 描述任务执行前以只读方式写入工作区的单个上游输入文件。
 */
class RunnerInputFile {
  /**
   * 构造输入文件实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Path = init.Path ?? "";
    this.Content = init.Content ?? "";
  }
}

/**
 * 描述执行机器在单次 Agent 调用或脚本执行结束后上报的工作区产出与事实信息。
 */
class RunnerTaskOutputs {
  /**
   * 构造任务产出上报实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Files = init.Files ?? {};
    this.TooLarge = init.TooLarge ?? [];
    this.Patches = init.Patches ?? {};
    this.Recovered = init.Recovered ?? [];
    this.Facts = init.Facts ?? null;
  }
}

/**
 * 描述执行机器探测到的工作区特征事实（例如是否包含前端工程及依据）。
 */
class RunnerWorkspaceFacts {
  /**
   * 构造工作区事实实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Frontend = init.Frontend ?? false;
    this.FrontendEvidence = init.FrontendEvidence ?? "";
  }
}

/**
 * 描述 `integrate` 集成合并动作在单个仓库上的执行结果，包含合并提交与冲突文件列表。
 */
class RunnerIntegrationResult {
  /**
   * 构造集成合并结果实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.RepositoryID = init.RepositoryID ?? "";
    this.Name = init.Name ?? "";
    this.WorkBranch = init.WorkBranch ?? "";
    this.IntegrateBranch = init.IntegrateBranch ?? "";
    this.Head = init.Head ?? "";
    this.Conflicts = init.Conflicts ?? [];
    this.PushedIntegrate = init.PushedIntegrate ?? false;
  }
}

/**
 * 描述 `align_baseline` 基线对齐动作的执行结果；若存在冲突则合并已中止且未推送。
 */
class RunnerAlignResult {
  /**
   * 构造基线对齐结果实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Head = init.Head ?? "";
    this.Conflicts = init.Conflicts ?? [];
    this.Blocks = init.Blocks ?? [];
  }
}

/**
 * 描述 `pull_work_branch` 或 `push_work_branch` 动作更新后的单个仓库工作分支提交头信息。
 */
class RunnerWorkBranchHead {
  /**
   * 构造工作分支头信息实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.RepositoryID = init.RepositoryID ?? "";
    this.Name = init.Name ?? "";
    this.WorkBranch = init.WorkBranch ?? "";
    this.Head = init.Head ?? "";
    this.SharedBranch = init.SharedBranch ?? "";
    this.SharedHead = init.SharedHead ?? "";
  }
}

/**
 * 描述执行机器批量上报的单条任务输出事件，通过 `Seq` 与任务 ID 保证 HTTP 重试幂等。
 */
class RunnerTaskEvent {
  /**
   * 构造任务输出事件实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Seq = init.Seq ?? 0;
    this.Type = init.Type ?? "";
    this.Data = init.Data ?? "";
    this.Ts = init.Ts ?? null;
  }
}

/**
 * 判断路径 `p` 是否为工作区内干净、以正斜杠分隔的相对路径（非绝对路径、非根目录、不含父级跳转）。
 * 在读写工作区文件或登记产物路径前用于防止路径穿越。
 * @param {string} p - 待校验的相对路径字符串。
 * @returns {boolean} 路径合法且安全时返回 `true`，否则返回 `false`。
 */
function SafeWorkspaceRelPath(p) {
  if (p === "" || p.includes("\\") || p.startsWith("/")) {
    return false;
  }
  const clean = cleanPath(p);
  return clean === p && clean !== "." && clean !== ".." && !clean.startsWith("../");
}

module.exports = { RunnerStatusOnline, RunnerStatusOffline, RunnerTaskQueued, RunnerTaskLeased, RunnerTaskRunning, RunnerTaskSuccess, RunnerTaskFailed, RunnerTaskCanceled, RunnerTaskDesiredCancel, RunnerTaskActionCleanupRun, RunnerTaskActionArchivePreview, RunnerTaskActionPullWorkBranch, RunnerTaskActionPushWorkBranch, RunnerTaskActionIntegrate, RunnerTaskActionAlignBaseline, RunnerVersionWorkBranchSync, RunnerVersionReportedOutputs, RunnerVersionIntegrate, RunnerVersionAlignBaseline, RunnerVersionWorkspacePreparation, RunnerVersionWorkspaceOwnerPreparation, RunnerVersionConversationWorkspace, RunnerVersionConversationCLI, RunnerVersionCLISettings, RunnerVersionDefaultSelection, RunnerVersionSharedPush, RunnerVersionGitSSH, RunnerVersionGitHTTP, RunnerVersionGitSSHKnownHosts, RunnerVersionCodeBuddyBaseURL, RunnerVersionRepositoryCache, RunnerVersionExistingWorkBranch, RunnerVersionCreateNewWorkBranch, Runner, PublicRunner, PublicRunners, SupportsRunnerLogin, RuntimeStatusOnline, RuntimeStatusOffline, RuntimeStatusDisabled, RuntimeAuthLocal, RuntimeAuthPersonal, RuntimeCapabilityManagedUpdate, RuntimeCapabilityNativeUpdate, RunnerRuntime, RunnerTask, RunnerSandboxRequirements, RunnerCLIStateRequirement, RunnerSandboxSpec, PublicRunnerTask, RunnerInvocation, RunnerRepository, RunnerInputFile, RunnerTaskOutputs, RunnerWorkspaceFacts, RunnerIntegrationResult, RunnerAlignResult, RunnerWorkBranchHead, RunnerTaskEvent, SafeWorkspaceRelPath };
