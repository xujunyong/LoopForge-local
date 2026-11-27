/**
 * @file internal/engine/run_environment.js
 * 对应 Go 源文件：internal/engine/run_environment.go
 *
 * 作用与职责边界：
 * 管理单次工作流运行独占的沙箱与工作区环境（`runEnvironment`），包括沙箱规格解析与快照转换、
 * 按负责人动态刷新运行凭证、工作区租约绑定与离线宿主迁移、环境释放/分离，以及本地工作区路径解析。
 *
 * 语法差异说明：
 * - Go 的 `sync.Mutex`、`sync.RWMutex` 与 `atomic.Bool`/`atomic.Int64` 在单线程 JS 中省略或译为普通字段。
 * - Go 的 `context.Context` 译为 `AbortSignal`（或 `null`）；`time.Time` 零值译为 `null`。
 * - Go 的 `(值, error)` 与仅 `error` 返回均按统一约定译为成功返回值（或无返回值 `undefined`）、失败 `throw err`。
 * - Go 的 `map[string]*reportedOutputs` 译为普通对象 `{}`（零值为 `{}`）。
 */

"use strict";

const fs = require("node:fs"); // Go os
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { ErrRunLeaseLost, ErrRunWorkspaceBound } = require("../repo/repo.js"); // 对应 Go 的 repo.ErrRunLeaseLost/ErrRunWorkspaceBound，repo.js 已翻译
const { SandboxDriverDocker, RunnerSandbox } = require("../domain/assets.js"); // 对应 Go 的 domain.SandboxDriverDocker/RunnerSandbox，assets.js 已翻译
const { RunnerSandboxSpec } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerSandboxSpec，runner.js 已翻译
const { RunCredentials, ProviderCredential, MCPTarget, SandboxResources, ExtraRunCredentials, PrepareMCPServers, AgentCLIUserCredentials } = require("../runtime/runtime.js"); // 对应 Go 的 runtime 相关类型与函数，runtime 待翻译
const { newReportedOutputs } = require("./node_outputs.js"); // 对应 Go 同包函数，node_outputs.js 已翻译
const { sharesWorkspace, workspaceRunID, hasCodeWorkspace } = require("./workspace_owner.js"); // 对应 Go 同包函数，workspace_owner.js 已翻译
const { resolveCodeBuddyCredential } = require("./codebuddy_auth.js"); // 对应 Go 同包函数，codebuddy_auth.js 已翻译
const { resolveGitIdentity, sshRepositoryURLs } = require("./git_auth.js"); // 对应 Go 同包函数，git_auth.js 已翻译

/**
 * 持有一次工作流运行独占的沙箱与工作区句柄。
 * 使用场景：SOP 节点与群组任务在准备共享环境（拉取代码、准备脚本、输入）时串行准备，随后并行分支并发执行并记录在 `activeExecutions` 中。
 */
class runEnvironment {
  /**
   * 构造并初始化运行环境对象，缺省字段严格按 Go 零值填充。
   *
   * @param {object} [init={}] - 可选初始字段映射。
   * @param {object|null} [init.sandbox=null] - 底层运行时沙箱实例（`runtime.Sandbox`）。
   * @param {object} [init.credentials=new RunCredentials()] - 当前运行凭证快照（`runtime.RunCredentials`）。
   * @param {boolean} [init.repositoriesPrepared=false] - 本次环境生命周期内仓库是否已完成准备。
   * @param {boolean} [init.preparing=false] - 是否正在执行环境准备。
   * @param {number} [init.activeExecutions=0] - 当前并发执行中的节点计数。
   * @param {Object<string, object>} [init.reported={}] - 按节点 ID 保存执行机上报产物的映射（`map[string]*reportedOutputs`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.sandbox = init.sandbox ?? null;
    this.credentials = init.credentials ?? new RunCredentials();
    this.repositoriesPrepared = init.repositoriesPrepared ?? false;
    this.preparing = init.preparing ?? false;
    this.activeExecutions = init.activeExecutions ?? 0;
    // reported 按节点保存执行机上报的内容（RunnerTask.Outputs 支持时）；缺失的节点用沙箱工作区。
    this.reported = init.reported ?? {};
  }
}

/**
 * 为指定节点初始化并登记远端执行机上报产物收集器。
 * 使用场景：派发支持 `RunnerTask.Outputs` 的节点执行前调用。
 *
 * @param {string} nodeID - 工作流节点 ID。
 * @param {object[]} inputs - 下发给执行机的输入文件列表（`domain.RunnerInputFile[]`）。
 * @returns {object} 新建的 `reportedOutputs` 实例。
 */
runEnvironment.prototype.beginReportedOutputs = function (nodeID, inputs) {
  if (this.reported == null) {
    this.reported = {};
  }
  const outputs = newReportedOutputs(inputs);
  this.reported[nodeID] = outputs;
  return outputs;
};

/**
 * 查询指定节点当前登记的远端执行机上报产物收集器。
 * 使用场景：节点执行结束收集产物时判断应读上报结果还是沙箱工作区。
 *
 * @param {string} nodeID - 工作流节点 ID。
 * @returns {object|null} 对应的 `reportedOutputs` 实例，未登记时返回 `null`。
 */
runEnvironment.prototype.reportedOutputs = function (nodeID) {
  if (this.reported == null) {
    return null;
  }
  return this.reported[nodeID] ?? null;
};

/**
 * 清理指定节点的远端执行机上报产物收集器。
 * 使用场景：节点执行完成或取消退出时释放内存引用。
 *
 * @param {string} nodeID - 工作流节点 ID。
 * @returns {void} 无返回值。
 */
runEnvironment.prototype.endReportedOutputs = function (nodeID) {
  if (this.reported != null) {
    delete this.reported[nodeID];
  }
};

/**
 * 确保仓库准备回调在当前运行环境生命周期内仅成功执行一次。
 * 使用场景：重建的环境以 `repositoriesPrepared=false` 启动，进程重启或租约接管后在首次执行节点前会重新校验持久化工作区。
 *
 * @param {function(): void} prepare - 执行仓库拉取/恢复的回调函数（失败时抛出错误）。
 * @returns {void} 无返回值。
 * @throws {Error} `prepare` 执行失败时直接透传错误。
 */
runEnvironment.prototype.prepareRepositoriesOnce = function (prepare) {
  if (this.repositoriesPrepared) {
    return;
  }
  prepare();
  this.repositoriesPrepared = true;
};

/**
 * 返回底层沙箱的唯一标识。
 * 使用场景：记录节点运行元数据与遥测上下文的 `SandboxID`。
 *
 * @returns {string} 沙箱 ID。
 */
runEnvironment.prototype.ID = function () { return this.sandbox.ID(); };

/**
 * 返回底层沙箱挂载的工作区根目录路径。
 * 使用场景：在宿主机侧读写代码仓库、脚本输入或产物文件。
 *
 * @returns {string} 工作区绝对路径。
 */
runEnvironment.prototype.Workspace = function () { return this.sandbox.Workspace(); };

/**
 * 解包返回底层 `runtime.Sandbox` 实例。
 * 使用场景：需要访问具体沙箱驱动能力时调用。
 *
 * @returns {object|null} 底层沙箱对象；当前环境为空时返回 `null`。
 */
runEnvironment.prototype.Unwrap = function () {
  if (this == null) {
    return null;
  }
  return this.sandbox;
};

/**
 * 返回底层沙箱所使用的驱动类型名称（如 `"docker"`、`"native"`）。
 * 使用场景：日志、诊断或按驱动差异分支处理时调用。
 *
 * @returns {string} 驱动名称；底层沙箱未实现 `Driver()` 时返回 `""`。
 */
runEnvironment.prototype.Driver = function () {
  if (typeof this.sandbox?.Driver === "function") {
    return this.sandbox.Driver();
  }
  return "";
};

/**
 * 在底层沙箱中执行命令规格并将输出流转发到事件接收器。
 * 使用场景：执行 Agent CLI、脚本或准备命令。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {object} command - 命令规格对象（`runtime.CommandSpec`）。
 * @param {object} sink - 运行时事件接收器（`runtime.EventSink`）。
 * @returns {string} 命令输出结果。
 * @throws {Error} 命令执行失败或被取消时抛出错误。
 */
runEnvironment.prototype.Exec = function (ctx, command, sink) {
  return this.sandbox.Exec(ctx, command, sink);
};

/**
 * 在底层沙箱支持时重建沙箱实例（如容器）。
 * 使用场景：工作区或镜像状态异常需要重建容器时调用。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @returns {void} 无返回值。
 * @throws {Error} 底层重建失败时抛出错误。
 */
runEnvironment.prototype.Recreate = function (ctx) {
  if (typeof this.sandbox?.Recreate === "function") {
    this.sandbox.Recreate(ctx);
  }
};

/**
 * 将工作区重新绑定到沙箱；若底层沙箱未实现 `BindWorkspace`，则回退调用 `Recreate`。
 * 使用场景：工作区目录就绪或恢复后刷新容器挂载绑定。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @returns {void} 无返回值。
 * @throws {Error} 绑定或重建失败时抛出错误。
 */
runEnvironment.prototype.BindWorkspace = function (ctx) {
  if (typeof this.sandbox?.BindWorkspace === "function") {
    this.sandbox.BindWorkspace(ctx);
    return;
  }
  this.Recreate(ctx);
};

/**
 * 关闭并清理底层沙箱资源。
 * 使用场景：运行结束、绑定失败回滚或释放运行环境时调用。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @returns {void} 无返回值。
 * @throws {Error} 关闭沙箱失败时抛出错误。
 */
runEnvironment.prototype.Close = function (ctx) {
  this.sandbox.Close(ctx);
};

/**
 * 在底层沙箱支持时分离进程内句柄而不销毁底层持久化容器/工作区。
 * 使用场景：引擎优雅退出或释放内存缓存但保留现场时调用。
 *
 * @returns {void} 无返回值。
 * @throws {Error} 分离失败时抛出错误。
 */
runEnvironment.prototype.Detach = function () {
  if (typeof this.sandbox?.Detach === "function") {
    this.sandbox.Detach();
  }
};

/**
 * 将存储的沙箱配置解析为 Runner 可执行的沙箱规格；Docker 沙箱缺少 Dockerfile 时报错。
 * 使用场景：旧运行快照未固化 `SandboxSnapshot` 时按当前配置解析沙箱规格。
 *
 * @param {object} profile - 沙箱配置对象（`domain.SandboxProfile`）。
 * @returns {RunnerSandboxSpec} 解析后的 Runner 沙箱规格。
 * @throws {Error} Docker 沙箱未配置有效 Dockerfile 内容时抛出错误。
 */
function resolveSandbox(profile) {
  if (profile.Driver.trim() === SandboxDriverDocker && (profile.Dockerfile == null || profile.Dockerfile.Content.trim() === "")) {
    throw new Error(`docker sandbox ${JSON.stringify(profile.ID)} has no Dockerfile`);
  }
  return RunnerSandbox(profile);
}

/**
 * 根据沙箱配置与已解析资源构造冻结快照对象。
 * 使用场景：启动工作流时将沙箱配置和 Dockerfile 固化到运行快照中。
 *
 * @param {object} profile - 沙箱配置对象（`domain.SandboxProfile`）。
 * @param {object} resources - 沙箱依赖资源对象（`runtime.SandboxResources`）。
 * @returns {RunnerSandboxSpec} 冻结后的沙箱快照对象。
 */
function resolvedSandboxSnapshot(profile, resources) {
  const snapshot = new RunnerSandboxSpec({ Profile: profile });
  if (resources.Dockerfile.ID.trim() !== "") {
    const dockerfile = resources.Dockerfile;
    snapshot.Dockerfile = { ...dockerfile };
  }
  return snapshot;
}

/**
 * 从冻结的沙箱快照还原运行时所需的 `SandboxResources`。
 * 使用场景：获取或重建运行沙箱前提取快照中保存的 Dockerfile 资源。
 *
 * @param {RunnerSandboxSpec|null} snapshot - 冻结的沙箱快照对象。
 * @returns {object} 还原得到的 `SandboxResources` 实例。
 */
function sandboxResourcesFromSnapshot(snapshot) {
  const resources = new SandboxResources();
  if (snapshot == null) {
    return resources;
  }
  if (snapshot.Dockerfile != null) {
    resources.Dockerfile = { ...snapshot.Dockerfile };
  }
  return resources;
}

/**
 * 为指定运行获取（或复用）独占的 `runEnvironment`，必要时先恢复工作区检查点、校验租约并接管离线宿主的工作区绑定。
 * 使用场景：调度器准备执行节点前调用；每次进入都会按当前负责人刷新运行凭证。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {object} run - 当前运行对象（`domain.Run`）。
 * @param {object} profile - 沙箱配置对象（`domain.SandboxProfile`）。
 * @param {object} requirements - 沙箱运行时依赖要求（`runtime.SandboxRequirements`）。
 * @param {...function(): void} onWorkspaceBusy - 可选回调，当工作区检查点正在恢复且被占用时通知调用方。
 * @returns {Promise<[runEnvironment, boolean]>} 返回 `[env, first]` 二元组，`first` 表示本次是否为首次绑定该运行的工作区。
 * @throws {Error} 检查点恢复失败、租约丢失（`ErrRunLeaseLost`）、工作区绑定冲突、沙箱获取失败或持久化绑定失败时抛出错误。
 */
Engine.prototype.acquireRunEnvironment = async function (ctx, run, profile, requirements, ...onWorkspaceBusy) {
  let needsRestore = run.WorkspaceCleanedAt != null;
  if (!needsRestore && !sharesWorkspace(run) && this.defaultExecutionRunner(run) === "") {
    const [, saved] = this.repo.WorkspaceCheckpoint(run.ID);
    if (saved) {
      try {
        fs.statSync(this.sandboxes.RunWorkspace(run.ID));
      } catch (err) {
        needsRestore = err.code === "ENOENT";
      }
    }
  }
  if (needsRestore) {
    let onBusy;
    if (onWorkspaceBusy.length > 0) {
      onBusy = onWorkspaceBusy[0];
    }
    await this.restoreCheckpointForExecution(ctx, run, onBusy);
  }
  const [current, ok] = this.repo.RunState(run.ID);
  if (!ok || current.Generation !== run.Generation || !this.ownsRun(current)) {
    throw ErrRunLeaseLost;
  }
  this.adoptForeignWorkspace(current);
  // 凭证每次进入时都按负责人重新解析。沙箱目录保留，只刷新内存句柄。否则重试会沿用首次获取时捕获的令牌，包括负责人尚未确定时取到的空令牌。
  const credentials = this.resolveRunCredentials(current);
  const existing = this.runEnvs[run.ID];
  if (existing != null) {
    existing.setCredentials(credentials);
    return [existing, false];
  }
  let resources = sandboxResourcesFromSnapshot(run.WorkflowSnapshot.SandboxSnapshot);
  if (run.WorkflowSnapshot.SandboxSnapshot == null) {
    const spec = resolveSandbox(profile);
    profile = spec.Profile;
    resources = sandboxResourcesFromSnapshot(spec);
  }
  const sandbox = this.sandboxes.AcquireRunIn(ctx, run.ID, workspaceRunID(current), profile, requirements, credentials, resources);
  const env = new runEnvironment({
    sandbox: sandbox,
    credentials: credentials,
  });
  this.runEnvs[run.ID] = env;
  let first = false;
  try {
    first = this.repo.BindRunWorkspace(run.ID, this.instanceID, run.Generation, this.workspaceHost, this.sandboxes.Root());
    if (current.WorkspaceCleanedAt != null) {
      // 没有归档的旧运行由正常执行重建，不由预检恢复。一旦有了真实沙箱，就清除旧的清理标记，让后续写入与检查点捕获能用上它。
      this.repo.ResetRunWorkspaceCleanup(run.ID);
    }
  } catch (bindError) {
    delete this.runEnvs[run.ID];
    try {
      env.Close(null);
    } catch {}
    throw bindError;
  }
  return [env, first];
};

/**
 * 按运行负责人与项目上下文解析全套运行凭证（CodeBuddy、Git HTTP/SSH、Git 身份、模型供应商密钥及脚本 MCP 服务配置）。
 * 使用场景：每次获取或刷新运行环境时调用，确保凭证始终反映最新配置。
 *
 * @param {object} run - 运行对象（`domain.Run`）。
 * @returns {object} 组装完成的 `RunCredentials` 实例。
 */
Engine.prototype.resolveRunCredentials = function (run) {
  const userID = run.ExecutionContext.ResponsibleUserID;
  const credentials = new RunCredentials({
    CodeBuddy: resolveCodeBuddyCredential(this.repo, userID),
    GitHTTPCredentials: this.repo.GitHTTPCredentialSecrets(null, userID),
  });
  credentials.Extra = ExtraRunCredentials(userID);
  credentials.GitSSHKeys = this.repo.GitSSHKeysForRemotes(userID, sshRepositoryURLs(run.RepositoryContexts()));
  const identity = resolveGitIdentity(this.repo, userID);
  credentials.GitUserName = identity.name;
  credentials.GitUserEmail = identity.email;
  const [user, ok] = this.repo.User(userID);
  if (ok) {
    credentials.Codex = new ProviderCredential({ APIKey: user.CodexAPIKey, BaseURL: user.CodexBaseURL });
    credentials.ClaudeCode = new ProviderCredential({ APIKey: user.ClaudeCodeAPIKey, BaseURL: user.ClaudeCodeBaseURL });
    credentials.AgentCLI = AgentCLIUserCredentials(user);
  }
  const [scriptAssets] = PrepareMCPServers(this.resolveScriptMCPAssets(run.ExecutionContext.ProjectID, userID), new MCPTarget({
    GitHTTPCredentials: credentials.GitHTTPCredentials,
    ExtraCredentials: credentials.Extra,
  }));
  credentials.MCPServers = scriptAssets.MCPServers;
  return credentials;
};

/**
 * 获取当前运行环境持有的凭证快照。
 * 使用场景：节点执行或刷新沙箱环境变量时读取最新凭证。
 *
 * @returns {object} 当前 `RunCredentials` 对象。
 */
runEnvironment.prototype.credentialSnapshot = function () {
  return this.credentials;
};

/**
 * 更新运行环境内存中的凭证快照，并在底层沙箱支持 `SetCredentials` 时同步下发。
 * 使用场景：复用已有 `runEnvironment` 时刷新最新负责人凭证。
 *
 * @param {object} credentials - 新的运行凭证对象（`runtime.RunCredentials`）。
 * @returns {void} 无返回值。
 */
runEnvironment.prototype.setCredentials = function (credentials) {
  this.credentials = credentials;
  if (typeof this.sandbox?.SetCredentials === "function") {
    this.sandbox.SetCredentials(credentials);
  }
};

/**
 * 处理工作区原绑定宿主机已离线的运行：无代码改动时直接迁移到本实例；有未推送代码改动时仍迁回绑定以便下次重跑，但本次尝试失败报错。
 * 使用场景：由 `acquireRunEnvironment` 在确认本实例拥有运行租约后调用。
 *
 * @param {object} run - 当前运行对象（`domain.Run`）。
 * @returns {void} 无返回值。
 * @throws {Error} 原宿主仍存活导致阻塞（`ErrRunWorkspaceBound`）、共享父工作区无法自行重建、重绑定失败或原工作区代码改动已丢失时抛出错误。
 */
Engine.prototype.adoptForeignWorkspace = function (run) {
  if (!this.foreignWorkspaceBind(run)) {
    return;
  }
  if (this.workspaceBlocked(run)) {
    throw ErrRunWorkspaceBound;
  }
  const lost = hasCodeWorkspace(run);
  const message = this.workspaceLostMessage(run);
  if (sharesWorkspace(run)) {
    // 拉取属于父任务，只有它的重跑才能重建。
    throw new Error(message);
  }
  this.rebindWorkspaceHere(run, lost);
  if (lost) {
    throw new Error(message);
  }
};

/**
 * 将运行的工作区绑定从已离线宿主机迁移到本实例，先销毁本机可能残留的旧工作区目录再更新数据库并记录重绑定事件。
 * 使用场景：由 `adoptForeignWorkspace` 在确认原宿主离线且非共享工作区时调用。
 *
 * @param {object} run - 当前运行对象（`domain.Run`）。
 * @param {boolean} lost - 原宿主机上是否丢失了之前节点的未推送代码改动。
 * @returns {void} 无返回值。
 * @throws {Error} 清理本地残留工作区失败或更新工作区绑定记录失败时抛出错误。
 */
Engine.prototype.rebindWorkspaceHere = function (run, lost) {
  try {
    this.releaseRunEnvironment(run.ID, true);
  } catch (err) {
    throw new Error(`discard stale local workspace: ${err.message}`);
  }
  this.repo.RebindRunWorkspace(run.ID, this.instanceID, run.Generation, this.workspaceHost, this.sandboxes.Root());
  let message = `工作区原绑定 ${run.WorkspaceHost}:${run.WorkspaceRoot} 已离线，改由 ${this.workspaceHost} 重新拉取代码`;
  if (lost) {
    message += "；之前节点的代码改动未推送到远端，已随原机器丢失";
  }
  this.updateRun(run.ID, (r) => {
    r.WorkspaceHost = this.workspaceHost;
    r.WorkspaceRoot = this.sandboxes.Root();
    this.event(r, "", "workspace.rebound", message);
  });
};

/**
 * 从内存映射移除并关闭指定运行的沙箱环境；当 `destroy` 为 `true` 时同时清除工作区事实缓存并销毁磁盘工作区。
 * 使用场景：运行结束清理、重跑整条工作流丢弃容器或重绑定工作区前清理残留时调用。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {boolean} destroy - 是否同时销毁磁盘工作区目录。
 * @returns {void} 无返回值。
 * @throws {Error} 关闭沙箱或销毁工作区失败时抛出错误。
 */
Engine.prototype.releaseRunEnvironment = function (runID, destroy) {
  const env = this.runEnvs[runID];
  delete this.runEnvs[runID];
  if (destroy) {
    delete this.workspaceFacts[runID];
  }

  let closeErr = null;
  if (env != null) {
    try {
      env.Close(null);
    } catch (err) {
      closeErr = err;
    }
  }
  if (destroy) {
    try {
      this.sandboxes.DestroyRun(runID);
    } catch (err) {
      if (closeErr != null) {
        throw new Error(`close run sandbox: ${closeErr.message}; destroy workspace: ${err.message}`);
      }
      throw err;
    }
  }
  if (closeErr != null) {
    throw closeErr;
  }
};

/**
 * 从内存映射移除指定运行环境并分离其底层沙箱句柄（不销毁磁盘与容器）。
 * 使用场景：引擎释放租约或进程退出时保留运行工作区现场。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @returns {void} 无返回值。
 */
Engine.prototype.detachRunEnvironment = function (runID) {
  const env = this.runEnvs[runID];
  delete this.runEnvs[runID];
  if (env != null) {
    try {
      env.Detach();
    } catch {}
  }
};

/**
 * 分离本引擎实例内存中缓存的所有运行环境句柄。
 * 使用场景：引擎优雅关闭阶段调用。
 *
 * @returns {void} 无返回值。
 */
Engine.prototype.detachAllRunEnvironments = function () {
  const ids = Object.keys(this.runEnvs);
  for (const id of ids) {
    this.detachRunEnvironment(id);
  }
};

/**
 * 仅当本进程可直接读取权威工作区时解析并返回其本地路径；否则返回空路径及中文不可用原因说明。
 * 使用场景：控制面文件浏览、Diff 查看等接口判断能否直接访问本地目录。
 *
 * @param {object} run - 运行对象（`domain.Run`）。
 * @returns {[string, string]} 可读时返回 `[workspacePath, ""]`，不可读时返回 `["", reason]`。
 */
Engine.prototype.LocalRunWorkspace = function (run) {
  if (this.defaultExecutionRunner(run) !== "") {
    return ["", "工作区位于远程执行机器，当前版本暂不支持远程浏览"];
  }
  if (this.foreignWorkspaceBind(run)) {
    return ["", "工作区绑定在其他 LoopForge 实例"];
  }
  const workspace = this.sandboxes.RunWorkspace(workspaceRunID(run));
  if (workspace.trim() === "") {
    return ["", "当前实例未配置工作区目录"];
  }
  return [workspace, ""];
};

/**
 * 返回冻结在运行中的默认远程执行机 ID；为空字符串表示权威工作区归属于控制面。
 * 使用场景：HTTP 层与调度层判断运行是否在远程 Runner 上执行。
 *
 * @param {object} run - 运行对象（`domain.Run`）。
 * @returns {string} 远程执行机 ID，控制面本地执行时返回 `""`。
 */
Engine.prototype.RunExecutionRunner = function (run) {
  return this.defaultExecutionRunner(run);
};

module.exports = { runEnvironment, resolveSandbox, resolvedSandboxSnapshot, sandboxResourcesFromSnapshot };
