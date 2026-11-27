/**
 * @file internal/engine/workspace_preparation.js
 * 对应 Go 源文件：internal/engine/workspace_preparation.go
 *
 * 作用与职责边界：
 * 负责工作区执行环境的沙箱规格解析、对话环境获取、本地与远端环境准备、就绪状态查询、
 * 沙箱终端接入（含用户 Git 凭证解析）、可信控制请求构造以及工作区重建步骤收据记录；
 * `Engine` 方法挂载于 `Engine.prototype`（`Engine` 定义于 `engine.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)`、`(值1, 值2, error)` 与仅 `error` 返回统一按成功返回值（或二元组、`undefined`）、失败 `throw err` 处理；`(值, bool)` 译为 `[值, boolean]`。
 * - Go 的 `context.Context` 译为 `AbortSignal`；`context.Background()` 译为 `null`；`time.Time` 零值译为 `null`。
 * - Go 的 `sync.Mutex`（含 `e.runEnvMu` 与 `env.nodeMu`）在单线程 JS 中省略；`runEnvironment` 中的 `preparing` 与 `activeExecutions` 按 `run_environment.js` 约定为普通布尔/数值字段。
 * - Go 的 `defer` 译为 `try ... finally`。
 */

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { DefaultSandboxProfileID } = require("../repo/sandbox_defaults.js"); // 对应 Go 的 repo.DefaultSandboxProfileID，sandbox_defaults.js 已翻译
const { ValidateFrozenSandbox } = require("../domain/assets.js"); // 对应 Go 的 domain.ValidateFrozenSandbox，assets.js 已翻译
const { RunnerInvocation, RunnerVersionConversationWorkspace, RunnerVersionWorkspacePreparation, RunnerVersionWorkspaceOwnerPreparation } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerInvocation/RunnerVersionConversationWorkspace/RunnerVersionWorkspacePreparation/RunnerVersionWorkspaceOwnerPreparation，runner.js 已翻译
const { RunnerWorkspaceRequest, RunnerWorkspaceOperationPrepare, RunnerWorkspaceOperationPreparationStatus, RunnerWorkspaceOperationPreparationRecord, RunnerWorkspaceOperationTerminal } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspaceRequest/RunnerWorkspaceOperationPrepare/RunnerWorkspaceOperationPreparationStatus/RunnerWorkspaceOperationPreparationRecord/RunnerWorkspaceOperationTerminal，runner_workspace.js 已翻译
const { RunnerWorkspaceLayoutShared, ExecutionModeCloud } = require("../domain/observability.js"); // 对应 Go 的 domain.RunnerWorkspaceLayoutShared/ExecutionModeCloud，observability.js 已翻译
const { WithObserver } = require("../procwatch/procwatch.js"); // 对应 Go 的 procwatch.WithObserver，procwatch 待翻译
const { ProviderRequirements, MergeSandboxRequirements } = require("../runtime/provider.js"); // 对应 Go 的 runtime.ProviderRequirements/MergeSandboxRequirements，runtime 待翻译
const { ProvisionMCPAssets } = require("../runtime/mcp_provision.js"); // 对应 Go 的 runtime.ProvisionMCPAssets，runtime 待翻译
const { WorkspacePreparationStatus, WorkspacePreparationWorkflow, PreparationNodes, EnsureWorkspacePreparation, RecordWorkspacePreparation, WorkspacePreparationTrivial, WorkspacePreparationReusable, ReadWorkspacePreparationStatus } = require("../runtime/workspace_preparation.js"); // 对应 Go 的 runtime.WorkspacePreparationStatus/WorkspacePreparationWorkflow/PreparationNodes/EnsureWorkspacePreparation/RecordWorkspacePreparation/WorkspacePreparationTrivial/WorkspacePreparationReusable/ReadWorkspacePreparationStatus，runtime 待翻译
const { ReadSandboxEnvironmentIdentity } = require("../runtime/workspace_terminal_sandbox.js"); // 对应 Go 的 runtime.ReadSandboxEnvironmentIdentity，runtime 待翻译
const { TerminalGitCredentials } = require("../runtime/workspace_terminal.js"); // 对应 Go 的 runtime.TerminalGitCredentials，runtime 待翻译
const { runEnvironment, resolveSandbox, sandboxResourcesFromSnapshot } = require("./run_environment.js"); // 对应 Go 同包类型与函数，run_environment.js 已翻译
const { workspaceRunID, sharesWorkspace } = require("./workspace_owner.js"); // 对应 Go 同包函数，workspace_owner.js 已翻译
const { bindRunnerRepositories } = require("./runner_dispatch.js"); // 对应 Go 同包函数，runner_dispatch.js 已翻译
const { runnerWorkspaceResponseError } = require("./workspace_busy.js"); // 对应 Go 同包函数，workspace_busy.js 已翻译
const { sshRepositoryURLs } = require("./git_auth.js"); // 对应 Go 同包函数，git_auth.js 已翻译
const { workflowAgent } = require("./assets.js"); // 对应 Go 同包函数，assets.js 已翻译
const { workflowNodeExecutor } = require("./sop_executors.js"); // 对应 Go 同包函数，sop_executors.js 已翻译

/**
 * 解析运行所使用的沙箱配置与资源配额；优先使用冻结在工作流快照中的 `SandboxSnapshot`，
 * 缺失时回退按 `SandboxProfileID`（或默认沙箱 ID）从仓库加载并校验冻结约束。
 * 使用场景：本地获取对话或工作区沙箱环境前调用。
 *
 * @param {object} run - 运行快照对象（`domain.Run`）。
 * @returns {[object, object]} 二元组 `[domain.SandboxProfile, runtime.SandboxResources]`。
 * @throws {Error} 沙箱配置不存在、解析失败或未通过冻结校验时抛出错误。
 */
Engine.prototype.workspaceSandboxProfile = function (run) {
  let spec = run.WorkflowSnapshot.SandboxSnapshot;
  if (spec == null) {
    let id = run.WorkflowSnapshot.SandboxProfileID.trim();
    if (id === "") {
      id = DefaultSandboxProfileID;
    }
    const [profile, ok] = this.repo.Sandbox(id);
    if (!ok) {
      throw new Error(`sandbox profile ${JSON.stringify(id)} not found`);
    }
    spec = resolveSandbox(profile);
  }
  ValidateFrozenSandbox(spec.Profile);
  return [spec.Profile, sandboxResourcesFromSnapshot(spec)];
};

/**
 * 获取或复用本地对话工作区的独占运行环境（不获取或抢占 SOP 调度器租约）；
 * 若本进程已缓存句柄则刷新其凭证并直接复用，否则申请新的沙箱实例并登记到 `runEnvs`。
 * 使用场景：本地工作区环境准备、重建收据记录或终端打开前调用。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {object} run - 运行快照对象（`domain.Run`）。
 * @returns {runEnvironment} 当前运行对应的本地沙箱环境句柄。
 * @throws {Error} 工作区属于其他执行实例、工作区已回收尚未恢复、或沙箱申请失败时抛出错误。
 */
Engine.prototype.acquireConversationEnvironment = function (ctx, run) {
  const [latest, ok] = this.repo.RunState(run.ID);
  if (ok) {
    run = latest;
  }
  if (this.foreignWorkspaceBind(run) || this.defaultExecutionRunner(run) !== "") {
    throw new Error("工作区属于其他执行实例");
  }
  if (run.WorkspaceCleanedAt != null) {
    const [meta, saved] = this.repo.WorkspaceCheckpoint(run.ID);
    if (saved && meta.SavedAt != null) {
      throw new Error("工作区已回收，请先恢复快照后再打开环境");
    }
  }
  const existing = this.runEnvs[run.ID];
  if (existing != null) {
    existing.setCredentials(this.resolveRunCredentials(run));
    return existing;
  }
  const [profile, resources] = this.workspaceSandboxProfile(run);
  const requirements = workspaceConversationRequirements(this.repo, run.WorkflowSnapshot, false);
  const credentials = this.resolveRunCredentials(run);
  const sb = this.sandboxes.AcquireRunIn(ctx, run.ID, workspaceRunID(run), profile, requirements, credentials, resources);
  const env = new runEnvironment({ sandbox: sb, credentials: credentials });
  this.runEnvs[run.ID] = env;
  return env;
};

/**
 * 构造过滤并转发工作区准备生命周期事件的事件接收器回调。
 * 使用场景：传给 `EnsureWorkspacePreparation`，将准备开始/完成/失败事件追加到运行事件流。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @returns {(event: object) => void} 接收 `domain.TelemetryEvent` 的回调函数。
 */
Engine.prototype.preparationSink = function (runID) {
  return (event) => {
    switch (event.Name) {
      case "workspace.preparation.started":
      case "workspace.preparation.completed":
      case "workspace.preparation.failed":
        this.AppendRunEvent(runID, event.Name, event.Message);
        break;
    }
  };
};

/**
 * 为上下文挂载进程观察器，将代码克隆与 Docker 镜像构建进度事件实时记录到运行事件流中。
 * 使用场景：对话工作区无业务节点，借此向前端展示缓慢或失败的检出与构建过程。
 *
 * @param {AbortSignal|null} ctx - 原始上下文信号。
 * @param {string} runID - 运行记录主键 ID。
 * @returns {object} 附带观察器的上下文对象。
 */
Engine.prototype.withPreparationProgress = function (ctx, runID) {
  return WithObserver(ctx, (event) => {
    this.AppendRunEvent(runID, "workspace." + event.Stage + "." + event.Kind, event.Message);
  });
};

/**
 * 在本地沙箱环境中执行工作区准备：必要时先下发脚本型 MCP 资产，再调用运行时完成仓库准备与重建脚本重放。
 * 使用场景：由 `EnsureWorkspaceReady` 或 `PrepareNodeWorkspace` 在本地模式下调用。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {object} run - 运行快照对象（`domain.Run`）。
 * @param {runEnvironment} env - 已获取的本地运行环境句柄。
 * @returns {object} 环境准备完成后的状态（`runtime.WorkspacePreparationStatus`）。
 * @throws {Error} MCP 资产下发或环境准备执行失败时抛出错误。
 */
Engine.prototype.prepareLocalEnvironment = function (ctx, run, env) {
  // 下面第一次沙箱调用会在镜像缺失时触发 Docker 镜像构建。
  ctx = this.withPreparationProgress(ctx, run.ID);
  env.preparing = true;
  try {
    // 调用方负责串行化准备（Go 侧持 env.nodeMu），避免把环境准备变成业务节点尝试。
    const assets = this.resolveScriptMCPAssets(run.ExecutionContext.ProjectID, run.ExecutionContext.ResponsibleUserID);
    if (PreparationNodes(workspacePreparationPlan(run)).length > 0) {
      ProvisionMCPAssets(ctx, env, env.Workspace(), assets, null);
    }
    return EnsureWorkspacePreparation(this.withSSHKnownHosts(ctx), env.sandbox, workspacePreparationPlan(run), run.RepositoryContexts(), this.preparationSink(run.ID));
  } finally {
    env.preparing = false;
  }
};

/**
 * 基于持久化的冻结运行状态构造可信的工作区控制请求（校验执行机版本能力、填充沙箱规格、工作流计划、仓库绑定、MCP 资产及按需附带 Git 凭证）。
 * 使用场景：向远端执行机或跨宿主 Worker 转发环境准备、状态查询、重建记录及终端操作前调用。
 *
 * @param {object} run - 持久化的运行快照（`domain.Run`）。
 * @param {RunnerWorkspaceRequest} request - 原始控制请求对象。
 * @returns {RunnerWorkspaceRequest} 填充完整可信配置后的控制请求对象。
 * @throws {Error} 执行机版本不满足能力要求、沙箱规格解析失败或目标节点未启用重建执行时抛出错误。
 */
Engine.prototype.preparedWorkspaceRequest = function (run, request) {
  const runnerID = this.defaultExecutionRunner(run);
  if (runnerID !== "") {
    if (run.ExecutionContext.RunnerWorkspaceLayout !== RunnerWorkspaceLayoutShared && PreparationNodes(WorkspacePreparationWorkflow(run.WorkflowSnapshot)).length > 0) {
      throw new Error("此历史运行使用逐节点工作区，不能自动重建共享环境；请重新发起一次运行");
    }
    const [runner, ok] = this.repo.Runner(runnerID);
    if (run.IsWorkspace() && (!ok || !runner.SupportsConversationWorkspace())) {
      throw new Error(`对话工作区需要执行机器升级至 ${RunnerVersionConversationWorkspace}`);
    }
    if (!ok || !runner.SupportsWorkspacePreparation()) {
      throw new Error(`执行机器需升级至 ${RunnerVersionWorkspacePreparation} 才能准备环境或打开沙箱终端`);
    }
    if (sharesWorkspace(run) && !runner.SupportsWorkspaceOwnerPreparation()) {
      throw new Error(`执行机器需升级至 ${RunnerVersionWorkspaceOwnerPreparation} 才能操作共享父工作区中的子 SOP 环境`);
    }
  }
  const spec = this.runnerSandboxSpec(run);
  request.RunID = run.ID;
  request.RunKind = run.Kind;
  request.WorkspaceRunID = workspaceRunID(run);
  request.RefreshCleanRepositories = request.Operation === RunnerWorkspaceOperationPrepare && workspaceCanRefreshRepositories(run);
  request.Sandbox = spec;
  // 请求严格依据持久化的冻结运行构造，绝不信任客户端 JSON。
  let wf = workspacePreparationPlan(run);
  if (request.Operation === RunnerWorkspaceOperationPreparationRecord) {
    wf = WorkspacePreparationWorkflow(run.WorkflowSnapshot);
    let found = false;
    for (const node of wf.Nodes) {
      if (node.ID === request.PreparationNodeID && node.RunOnWorkspaceRebuild) {
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error("节点未启用工作区重建执行");
    }
  }
  request.Workflow = wf;
  request.Repositories = run.RepositoryContexts();
  const credentials = this.resolveRunCredentials(run);
  const invocation = new RunnerInvocation();
  bindRunnerRepositories(invocation, run, credentials.GitUserName, credentials.GitUserEmail);
  invocation.GitSSHUserID = 0;
  invocation.GitHTTPUserID = 0;
  const assets = this.resolveScriptMCPAssets(run.ExecutionContext.ProjectID, run.ExecutionContext.ResponsibleUserID);
  invocation.Assets = assets;
  invocation.MCPCallServers = assets.MCPServers;
  request.PreparationInvocation = invocation;
  // 状态查询与普通终端 I/O 不需要密钥；独立平台实例也可从共享存储自行解析凭证。
  request.TerminalGitSSHKeys = null;
  request.TerminalGitHTTPCredentials = null;
  const terminalOpen = request.Operation === RunnerWorkspaceOperationTerminal && request.Terminal != null && request.Terminal.Operation === "open";
  if (runnerID !== "" && (request.Operation === RunnerWorkspaceOperationPrepare || terminalOpen)) {
    invocation.GitHTTPCredentials = credentials.GitHTTPCredentials;
    if (invocation.GitSSHRemotes().length > 0) {
      invocation.GitSSHKeys = credentials.GitSSHKeys;
    }
  }
  if (runnerID !== "" && terminalOpen) {
    const terminalCredentials = this.WorkspaceTerminalGitCredentials(null, run, request.TerminalOwner);
    request.TerminalGitHTTPCredentials = terminalCredentials.HTTPS;
    request.TerminalGitSSHKeys = terminalCredentials.SSHKeys;
  }
  request.RunStatus = run.Status;
  request.WorkspaceLayout = run.ExecutionContext.RunnerWorkspaceLayout;
  return request;
};

/**
 * 判断运行在重新准备环境时是否允许刷新干净的仓库目录：
 * 共享父工作区的子 SOP 或已有非准备类业务节点执行过的运行不允许刷新仓库，避免覆盖已有改动。
 * 使用场景：由 `preparedWorkspaceRequest` 计算 `RefreshCleanRepositories` 标志。
 *
 * @param {object} run - 运行快照对象（`domain.Run`）。
 * @returns {boolean} 允许刷新干净仓库时返回 `true`，否则返回 `false`。
 */
function workspaceCanRefreshRepositories(run) {
  if (sharesWorkspace(run)) {
    return false;
  }
  const preparation = {};
  for (const node of PreparationNodes(WorkspacePreparationWorkflow(run.WorkflowSnapshot))) {
    preparation[node.ID] = true;
  }
  for (const [id, node] of Object.entries(run.Nodes)) {
    if (node != null && node.Attempt > 0 && !preparation[id]) {
      return false;
    }
  }
  return true;
}

/**
 * 向远端执行机或跨宿主 Worker 发送工作区准备或准备状态查询请求，并解析返回的 `WorkspacePreparationStatus`。
 * 使用场景：远端运行执行 `WorkspacePreparationStatus`、`EnsureWorkspaceReady` 或 `PrepareNodeWorkspace` 时调用。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {object} run - 运行快照对象（`domain.Run`）。
 * @param {string} operation - 控制操作常量（准备或查询准备状态）。
 * @returns {Promise<object>} 远端返回的准备状态（`runtime.WorkspacePreparationStatus`）。
 * @throws {Error} 构造请求失败、控制通道出错、远端返回错误或远端不支持工作区准备时抛出错误。
 */
Engine.prototype.remoteWorkspacePreparation = async function (ctx, run, operation) {
  const request = this.preparedWorkspaceRequest(run, new RunnerWorkspaceRequest({ RunID: run.ID, Operation: operation }));
  const response = await this.requestWorkspaceCheckpoint(ctx, run, request);
  let state = new WorkspacePreparationStatus();
  if ((response.Payload ?? []).length > 0) {
    try {
      state = new WorkspacePreparationStatus(JSON.parse(Buffer.from(response.Payload).toString("utf8")));
    } catch {
      // Go 忽略响应体反序列化错误。
    }
  }
  if (response.Error !== "") {
    if (state.Status === "") {
      state.Status = "failed";
    }
    state.Error = response.Error;
    throw runnerWorkspaceResponseError(response);
  }
  if (state.Status === "") {
    throw new Error("执行端尚不支持工作区准备，请更新执行器");
  }
  return state;
};

/**
 * 查询指定运行最近一次记录的工作区准备就绪状态，并校验当前沙箱环境指纹与准备配置是否仍可复用。
 * 使用场景：前端展示工作区准备面板或终端打开前快速探查环境状态。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {string} id - 运行记录主键 ID。
 * @returns {Promise<object>} 当前工作区准备状态（`runtime.WorkspacePreparationStatus`）。
 * @throws {Error} 运行不存在或远端状态查询失败时抛出错误。
 */
Engine.prototype.WorkspacePreparationStatus = async function (ctx, id) {
  const [run, ok] = this.repo.RunState(id);
  if (!ok) {
    throw new Error("运行不存在");
  }
  if (this.defaultExecutionRunner(run) !== "" || this.foreignWorkspaceBind(run)) {
    return this.remoteWorkspacePreparation(ctx, run, RunnerWorkspaceOperationPreparationStatus);
  }
  const [root, reason] = this.LocalRunWorkspace(run);
  if (reason !== "") {
    return new WorkspacePreparationStatus({ Status: "unprepared", Steps: [] });
  }
  const scopeEnv = this.runEnvs[id];
  if (scopeEnv == null) {
    return new WorkspacePreparationStatus({ Status: "unprepared", Error: "执行环境尚未检查；文件仍可浏览", Steps: [] });
  }
  const state = ReadWorkspacePreparationStatus(root, scopeEnv.ID());
  if (state.Status === "preparing") {
    const env = this.runEnvs[id];
    const active = env != null && env.preparing;
    if (!active) {
      state.Status = "unprepared";
      state.Error = "上次工作区准备已中断，请重新准备";
    }
  }
  if (state.Status === "ready") {
    const env = this.runEnvs[id];
    let invalidReason = "";
    if (env == null) {
      invalidReason = "执行环境尚未检查；文件仍可浏览";
    } else {
      try {
        const epoch = ReadSandboxEnvironmentIdentity(ctx, env.sandbox);
        if (!WorkspacePreparationReusable(state, workspacePreparationPlan(run), run.RepositoryContexts(), epoch)) {
          invalidReason = "执行环境或准备配置已变化，需要重新准备";
        }
      } catch {
        invalidReason = "执行环境或准备配置已变化，需要重新准备";
      }
    }
    if (invalidReason !== "") {
      state.Status = "unprepared";
      state.Error = invalidReason;
      for (const step of state.Steps) {
        step.Status = "unprepared";
      }
      return state;
    }
  }
  return state;
};

/**
 * 在工作区文件恢复后确保执行环境处于就绪状态，且不改变运行结果与节点历史；
 * 若当前已有活跃节点、执行或终端占用工作区，则仅在环境可复用或准备步骤为空时放行，否则报错提示等待。
 * 使用场景：打开沙箱终端或用户手动触发工作区环境重建时调用。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {string} id - 运行记录主键 ID。
 * @returns {Promise<object>} 准备完成后的状态（`runtime.WorkspacePreparationStatus`）。
 * @throws {Error} 运行不存在、获取环境失败、工作区正被占用且不可复用，或准备执行失败时抛出错误。
 */
Engine.prototype.EnsureWorkspaceReady = async function (ctx, id) {
  const [run0, ok] = this.repo.RunState(id);
  if (!ok) {
    throw new Error("运行不存在");
  }
  let run = run0;
  if (this.defaultExecutionRunner(run) !== "" || this.foreignWorkspaceBind(run)) {
    return this.remoteWorkspacePreparation(ctx, run, RunnerWorkspaceOperationPrepare);
  }
  const env = this.acquireConversationEnvironment(ctx, run);
  // Go 的 env.nodeMu.Lock()/Unlock() 在单线程 JS 中省略。
  const [current, ok2] = this.repo.RunState(id);
  if (ok2) {
    run = current;
  }
  if (run.HasActiveNode() || env.activeExecutions > 0 || this.workspaceTerminals.HasRunScope(id) || (this.WorkspaceActive != null && this.WorkspaceActive(run))) {
    const state = ReadWorkspacePreparationStatus(env.Workspace(), env.ID());
    try {
      const epoch = ReadSandboxEnvironmentIdentity(ctx, env.sandbox);
      // 智能体所在的环境同样服务于 IDE 终端。
      if (WorkspacePreparationReusable(state, workspacePreparationPlan(run), run.RepositoryContexts(), epoch)) {
        return state;
      }
    } catch {
      // 环境指纹读取失败时走下方降级或报错逻辑。
    }
    if (state.Status !== "preparing" && WorkspacePreparationTrivial(workspacePreparationPlan(run))) {
      return new WorkspacePreparationStatus({ Status: "ready", Steps: [] });
    }
    throw new Error("成员或终端正在使用工作区，请结束当前操作后重新准备");
  }
  return this.prepareLocalEnvironment(ctx, run, env);
};

/**
 * 在节点调度执行前确保其工作区环境已就绪：
 * 远端执行机模式下通过 `waitWorkspaceNotBusy` 等待并发占用释放后再检查或准备；本地模式下复用已有协作环境或执行本地准备。
 * 使用场景：节点执行前由调度器调用。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {object} run - 运行快照对象（`domain.Run`）。
 * @param {runEnvironment|null} env - 本地模式下的运行环境句柄。
 * @returns {Promise<object>} 节点可用的准备状态（`runtime.WorkspacePreparationStatus`）。
 * @throws {Error} 远端等待超时/失败、协作工作区环境失效或本地准备失败时抛出错误。
 */
Engine.prototype.PrepareNodeWorkspace = async function (ctx, run, env) {
  if (PreparationNodes(WorkspacePreparationWorkflow(run.WorkflowSnapshot)).length === 0) {
    return new WorkspacePreparationStatus({ Status: "ready", Steps: [] });
  }
  if (this.defaultExecutionRunner(run) !== "") {
    if (run.IsWorkspace()) {
      const [current, ok] = this.repo.RunState(run.ID);
      if (ok) {
        run = current;
      }
    }
    // 兄弟分支、群组角色、收尾任务或快照可能短暂（或全程）持有执行机围栏，应等待而非直接失败。
    return this.waitWorkspaceNotBusy(ctx, run, async (currentRun) => {
      if (currentRun.IsWorkspace()) {
        try {
          const state = await this.remoteWorkspacePreparation(ctx, currentRun, RunnerWorkspaceOperationPreparationStatus);
          if (state.Status === "ready") {
            return state;
          }
        } catch {
          // Go：查询状态失败时继续尝试执行准备。
        }
      }
      return this.remoteWorkspacePreparation(ctx, currentRun, RunnerWorkspaceOperationPrepare);
    });
  }
  if (run.IsWorkspace() && env.activeExecutions > 0) {
    const state = ReadWorkspacePreparationStatus(env.Workspace(), env.ID());
    try {
      const epoch = ReadSandboxEnvironmentIdentity(ctx, env.sandbox);
      if (WorkspacePreparationReusable(state, workspacePreparationPlan(run), run.RepositoryContexts(), epoch)) {
        return state;
      }
    } catch {
      // 环境指纹读取失败视为环境已变化。
    }
    throw new Error("正在协作的工作区环境发生变化，请等待当前分工结束后重新准备");
  }
  return this.prepareLocalEnvironment(ctx, run, env);
};

/**
 * 处理工作区沙箱终端请求（打开、输入、缩放、关闭等），沿用与 SOP 执行完全一致的环境准备契约。
 * 当操作为 `"open"` 时，先按需恢复已回收工作区、确保环境就绪并解析操作用户的 Git 凭证。
 * 使用场景：HTTP 终端接口处理本地工作区终端请求。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {string} id - 运行记录主键 ID。
 * @param {object} pool - 终端池实例（`runtime.TerminalPool`）。
 * @param {string} scope - 终端作用域标识（通常为 `runID:actorID`）。
 * @param {object} req - 终端操作请求（`domain.WorkspaceTerminalRequest`）。
 * @param {number} actorID - 发起操作的用户 ID。
 * @returns {Promise<object>} 终端操作结果（`runtime.TerminalResult`）。
 * @throws {Error} 恢复工作区、准备环境或终端操作失败时抛出错误。
 */
Engine.prototype.HandleWorkspaceTerminal = async function (ctx, id, pool, scope, req, actorID) {
  if (req.Operation === "open") {
    await this.RestoreConversationWorkspaceIfNeeded(ctx, id);
    await this.EnsureWorkspaceReady(ctx, id);
  }
  const [run] = this.repo.RunState(id);
  run.ID = id;
  let credentials = new TerminalGitCredentials();
  if (req.Operation === "open") {
    credentials = this.WorkspaceTerminalGitCredentials(ctx, run, actorID);
  }
  return this.HandlePreparedWorkspaceTerminal(ctx, run, pool, scope, req, credentials);
};

/**
 * 为打开终端的操作用户解析其在当前运行所涉仓库上的 HTTPS 与 SSH Git 凭证。
 * 使用场景：在获取运行编辑器事务锁之前预先解析用户凭证。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {object} run - 运行快照对象（`domain.Run`）。
 * @param {number} actorID - 用户主键 ID；小于等于 0 时返回空凭证。
 * @returns {TerminalGitCredentials} 解析后的终端 Git 凭证对象。
 */
Engine.prototype.WorkspaceTerminalGitCredentials = function (ctx, run, actorID) {
  if (actorID <= 0) {
    return new TerminalGitCredentials();
  }
  return new TerminalGitCredentials({
    HTTPS: this.repo.GitHTTPCredentialSecrets(ctx, actorID),
    SSHKeys: this.repo.GitSSHKeysForRemotes(actorID, sshRepositoryURLs(run.RepositoryContexts())),
  });
};

/**
 * 基于调用方已读取的完整运行状态（携带节点状态以避免在行锁内重读）处理沙箱终端请求；
 * 打开终端前核验本地运行环境与环境指纹仍然就绪一致。
 * 使用场景：由 `HandleWorkspaceTerminal` 或内部控制通道 `HandleWorkspaceCheckpoint` 调用。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {object} run - 携带完整节点状态的运行快照（`domain.Run`）。
 * @param {object} pool - 终端池实例（`runtime.TerminalPool`）。
 * @param {string} scope - 终端作用域标识。
 * @param {object} req - 终端操作请求（`domain.WorkspaceTerminalRequest`）。
 * @param {TerminalGitCredentials} credentials - 打开终端时注入的 Git 凭证。
 * @returns {object} 终端操作结果（`runtime.TerminalResult`）。
 * @throws {Error} 环境尚未准备、环境指纹已变化或终端池操作失败时抛出错误。
 */
Engine.prototype.HandlePreparedWorkspaceTerminal = function (ctx, run, pool, scope, req, credentials) {
  const id = run.ID;
  if (req.Operation !== "open") {
    return pool.HandleSandbox(ctx, null, scope, req, null);
  }
  const env = this.runEnvs[id];
  if (env == null) {
    throw new Error("工作区环境尚未准备，请重新打开终端");
  }
  const state = ReadWorkspacePreparationStatus(env.Workspace(), env.ID());
  let epoch = "";
  let epochErr = null;
  try {
    epoch = ReadSandboxEnvironmentIdentity(ctx, env.sandbox);
  } catch (err) {
    epochErr = err;
  }
  const trivial = run.WorkflowSnapshot.Nodes.length > 0 && WorkspacePreparationTrivial(workspacePreparationPlan(run));
  if (!trivial && (epochErr != null || state.Status !== "ready" || state.Environment !== epoch)) {
    throw new Error("工作区执行环境已变化，请重新准备后打开终端");
  }
  return pool.HandleSandboxWithGit(this.withSSHKnownHosts(ctx), env.sandbox, scope, req, null, credentials);
};

/**
 * 按运行 ID 加载最新状态并生成附带冻结执行配置的可信工作区控制请求。
 * 使用场景：认证通过的内部传输路径构造转发请求，不暴露为用户可控配置。
 *
 * @param {string} id - 运行记录主键 ID。
 * @param {RunnerWorkspaceRequest} request - 原始控制请求对象。
 * @returns {RunnerWorkspaceRequest} 绑定冻结配置后的可信控制请求。
 * @throws {Error} 运行不存在或构造请求失败时抛出错误。
 */
Engine.prototype.TrustedWorkspaceRequest = function (id, request) {
  const [run, ok] = this.repo.RunState(id);
  if (!ok) {
    throw new Error("运行不存在");
  }
  return this.preparedWorkspaceRequest(run, request);
};

/**
 * 判断指定运行的工作区是否绑定在外部宿主机上。
 * 使用场景：对外暴露跨宿主判断以决定请求走本地还是转发。
 *
 * @param {object} run - 运行快照对象（`domain.Run`）。
 * @returns {boolean} 属于外部宿主机时返回 `true`，否则返回 `false`。
 */
Engine.prototype.WorkspaceRemoteHost = function (run) {
  return this.foreignWorkspaceBind(run);
};

/**
 * 先构造可信工作区控制请求，再通过控制通道转发到执行机或远端宿主机。
 * 使用场景：常规跨实例工作区控制操作转发。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {object} run - 运行快照对象（`domain.Run`）。
 * @param {RunnerWorkspaceRequest} request - 原始控制请求对象。
 * @returns {Promise<object>} 远端返回的控制响应（`domain.RunnerWorkspaceResponse`）。
 * @throws {Error} 构造请求或转发失败时抛出错误。
 */
Engine.prototype.ForwardWorkspaceRequest = function (ctx, run, request) {
  const trusted = this.preparedWorkspaceRequest(run, request);
  return this.requestWorkspaceCheckpoint(ctx, run, trusted);
};

/**
 * 汇总工作流中所有仍可解析的 Agent 节点所对应的沙箱运行需求；
 * 对已从目录移除的历史角色或执行器容错跳过，避免打开历史运行的文件或终端时报错。
 * 使用场景：获取对话或历史运行工作区沙箱前计算合并后的容器需求。
 *
 * @param {object} st - 仓库存储句柄（`repo.Store`）。
 * @param {object} wf - 工作流定义快照（`domain.WorkflowDefinition`）。
 * @param {boolean} codexLoginRelay - 是否为 `codex` 执行器启用登录中继需求。
 * @returns {object} 合并后的沙箱需求对象（`runtime.SandboxRequirements`）。
 */
function workspaceConversationRequirements(st, wf, codexLoginRelay) {
  const items = [];
  for (const node of wf.Nodes) {
    if (node.Type !== "agent") {
      continue;
    }
    const [agent, ok] = workflowAgent(st, wf, node.AgentID);
    if (!ok) {
      continue;
    }
    let executor;
    try {
      executor = workflowNodeExecutor(st, wf, node, agent);
    } catch {
      continue;
    }
    const requirements = ProviderRequirements(executor.Kind);
    // 将 relay 需求冻结给整个工作流，使准备、脚本、终端与智能体可复用同一 Docker 容器。
    requirements.RunnerLoginRelay = codexLoginRelay && executor.Kind === "codex";
    items.push(requirements);
  }
  return MergeSandboxRequirements(...items);
}

/**
 * 在编辑器事务内转发已预先绑定完配置的工作区控制请求，并强制以云端执行模式路由。
 * 使用场景：调用方已在运行行锁之外完成配置绑定后，通过控制通道转发请求。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {object} run - 运行快照对象（`domain.Run`）。
 * @param {RunnerWorkspaceRequest} request - 已准备好的控制请求对象。
 * @returns {Promise<object>} 远端返回的控制响应（`domain.RunnerWorkspaceResponse`）。
 * @throws {Error} 控制通道转发失败时抛出错误。
 */
Engine.prototype.ForwardPreparedWorkspaceRequest = function (ctx, run, request) {
  run.ExecutionContext.ExecutionMode = ExecutionModeCloud;
  return this.requestWorkspaceCheckpoint(ctx, run, request);
};

/**
 * 依据运行当前节点历史裁剪工作区准备计划：仅允许在正常 SOP 执行中已 `succeeded` 的重建脚本在环境重建时重放，
 * 未执行或失败的节点保留正常调度语义绝不提前执行。
 * 使用场景：本地与远端环境准备、可复用性检查及构造可信请求前调用。
 *
 * @param {object} run - 运行快照对象（`domain.Run`）。
 * @returns {object} 裁剪后的工作区准备专用工作流定义（`domain.WorkflowDefinition`）。
 */
function workspacePreparationPlan(run) {
  const wf = WorkspacePreparationWorkflow(run.WorkflowSnapshot);
  // Go 的 append 复制节点值，JS 用展开复制节点对象。
  wf.Nodes = wf.Nodes.map((node) => ({ ...node }));
  const states = run.Nodes;
  for (const node of wf.Nodes) {
    if (!node.RunOnWorkspaceRebuild) {
      continue;
    }
    const state = states[node.ID];
    if (state == null || state.Status !== "succeeded") {
      node.RunOnWorkspaceRebuild = false;
    }
  }
  wf.CollaborationMode = "";
  wf.SOPCheckpoint = null;
  return wf;
}

/**
 * 在启用了 `RunOnWorkspaceRebuild` 的节点执行成功后记录其工作区准备收据（输出截断至 32 KiB）；
 * 远端执行机模式通过控制通道转发记录，本地模式直接写入沙箱收据文件。
 * 使用场景：节点成功完成后的环境收据持久化。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {object} run - 运行快照对象（`domain.Run`）。
 * @param {runEnvironment|null} env - 本地模式下的运行环境句柄。
 * @param {object} node - 已成功执行的节点定义（`domain.WorkflowNode`）。
 * @param {string} output - 节点输出文本。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 远端记录失败或本地写入收据失败时抛出错误。
 */
Engine.prototype.recordNodeWorkspacePreparation = async function (ctx, run, env, node, output) {
  if (output.length > 32 << 10) {
    output = output.slice(0, 32 << 10);
  }
  if (!node.RunOnWorkspaceRebuild) {
    return;
  }
  if (this.defaultExecutionRunner(run) !== "") {
    const request = this.preparedWorkspaceRequest(run, new RunnerWorkspaceRequest({ RunID: run.ID, Operation: RunnerWorkspaceOperationPreparationRecord, PreparationNodeID: node.ID, PreparationOutput: output }));
    const response = await this.requestWorkspaceCheckpoint(ctx, run, request);
    if (response.Error !== "") {
      throw new Error(`记录工作区重建步骤失败：${response.Error}`);
    }
    return;
  }
  // Go 的 env.nodeMu.Lock()/Unlock() 在单线程 JS 中省略。
  RecordWorkspacePreparation(ctx, env.sandbox, WorkspacePreparationWorkflow(run.WorkflowSnapshot), run.RepositoryContexts(), node.ID, output);
};

module.exports = { workspaceConversationRequirements, workspacePreparationPlan, workspaceCanRefreshRepositories };
