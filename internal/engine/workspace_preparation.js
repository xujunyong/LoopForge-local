// workspace_preparation.js —— 对应 Go 文件：internal/engine/workspace_preparation.go
// 作用：工作区准备：沙箱规格、本地与远端环境准备、终端接入与重建记录。
// (值, error) 译为成功返回值、失败 throw，(值, bool) 译为 [值, bool]；context.Context 译为 AbortSignal；context.Background() 译为 null；time.Time 零值译为 null；atomic 的 Load/Store 按 Go 字面保留；defer 译为 try/finally。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
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

// acquireConversationEnvironment 不获取或抢占 SOP 调度器租约。工作区使用租约隔离清理；沙箱的工作区 flock 隔离另一进程。活跃的本地调度器共享已有句柄。
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
  const [sb, err] = this.sandboxes.AcquireRunIn(ctx, run.ID, workspaceRunID(run), profile, requirements, credentials, resources);
  if (err != null) {
    throw err;
  }
  const env = new runEnvironment({ sandbox: sb, credentials: credentials });
  this.runEnvs[run.ID] = env;
  return env;
};

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

// withPreparationProgress 把克隆与镜像构建步骤实时记到运行上。对话工作区没有节点，这些事件是缓慢或失败的检出、构建唯一可见之处。
Engine.prototype.withPreparationProgress = function (ctx, runID) {
  return WithObserver(ctx, (event) => {
    this.AppendRunEvent(runID, "workspace." + event.Stage + "." + event.Kind, event.Message);
  });
};

Engine.prototype.prepareLocalEnvironment = function (ctx, run, env) {
  // 下面第一次沙箱调用在镜像缺失时构建 Docker 镜像。
  ctx = this.withPreparationProgress(ctx, run.ID);
  env.preparing.Store(true);
  try {
    // 调用方持有 env.nodeMu，重建串行化而不把环境准备变成业务节点尝试。
    const assets = this.resolveScriptMCPAssets(run.ExecutionContext.ProjectID, run.ExecutionContext.ResponsibleUserID);
    if (PreparationNodes(workspacePreparationPlan(run)).length > 0) {
      const provisionErr = ProvisionMCPAssets(ctx, env, env.Workspace(), assets, null);
      if (provisionErr != null) {
        throw provisionErr;
      }
    }
    const [state, ensureErr] = EnsureWorkspacePreparation(this.withSSHKnownHosts(ctx), env.sandbox, workspacePreparationPlan(run), run.RepositoryContexts(), this.preparationSink(run.ID));
    if (ensureErr != null) {
      throw ensureErr;
    }
    return state;
  } finally {
    env.preparing.Store(false);
  }
};

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
  // 请求按持久化的冻结运行构造，绝不取客户端 JSON。
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
  // 状态与终端 I/O 不需要密钥。另一平台实例也能从共享存储自行解析凭证。
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

Engine.prototype.remoteWorkspacePreparation = function (ctx, run, operation) {
  const request = this.preparedWorkspaceRequest(run, new RunnerWorkspaceRequest({ RunID: run.ID, Operation: operation }));
  const response = this.requestWorkspaceCheckpoint(ctx, run, request);
  let state = new WorkspacePreparationStatus();
  if ((response.Payload ?? []).length > 0) {
    try {
      state = new WorkspacePreparationStatus(JSON.parse(Buffer.from(response.Payload).toString("utf8")));
    } catch {
      // Go 忽略该错误。
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

// WorkspacePreparationStatus 只读最后记录的就绪状态。实际来源与环境指纹每次使用前都会检查。
Engine.prototype.WorkspacePreparationStatus = function (ctx, id) {
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
    const active = env != null && env.preparing.Load();
    if (!active) {
      state.Status = "unprepared";
      state.Error = "上次工作区准备已中断，请重新准备";
    }
  }
  if (state.Status === "ready") {
    const env = this.runEnvs[id];
    let reason = "";
    if (env == null) {
      reason = "执行环境尚未检查；文件仍可浏览";
    } else {
      const [epoch, epochErr] = ReadSandboxEnvironmentIdentity(ctx, env.sandbox);
      if (epochErr != null || !WorkspacePreparationReusable(state, workspacePreparationPlan(run), run.RepositoryContexts(), epoch)) {
        reason = "执行环境或准备配置已变化，需要重新准备";
      }
    }
    if (reason !== "") {
      state.Status = "unprepared";
      state.Error = reason;
      for (const step of state.Steps) {
        step.Status = "unprepared";
      }
      return state;
    }
  }
  return state;
};

// EnsureWorkspaceReady 在文件恢复后建立执行环境。它特意不改运行结果与节点历史。
Engine.prototype.EnsureWorkspaceReady = function (ctx, id) {
  const [run0, ok] = this.repo.RunState(id);
  if (!ok) {
    throw new Error("运行不存在");
  }
  let run = run0;
  if (this.defaultExecutionRunner(run) !== "" || this.foreignWorkspaceBind(run)) {
    return this.remoteWorkspacePreparation(ctx, run, RunnerWorkspaceOperationPrepare);
  }
  const env = this.acquireConversationEnvironment(ctx, run);
  env.nodeMu.Lock();
  try {
    const [current, ok2] = this.repo.RunState(id);
    if (ok2) {
      run = current;
    }
    if (run.HasActiveNode() || env.activeExecutions.Load() > 0 || this.workspaceTerminals.HasRunScope(id) || (this.WorkspaceActive != null && this.WorkspaceActive(run))) {
      const state = ReadWorkspacePreparationStatus(env.Workspace(), env.ID());
      const [epoch, epochErr] = ReadSandboxEnvironmentIdentity(ctx, env.sandbox);
      // 环境里的智能体与 IDE 终端共用同一环境。
      if (epochErr == null && WorkspacePreparationReusable(state, workspacePreparationPlan(run), run.RepositoryContexts(), epoch)) {
        return state;
      }
      if (state.Status !== "preparing" && WorkspacePreparationTrivial(workspacePreparationPlan(run))) {
        return new WorkspacePreparationStatus({ Status: "ready", Steps: [] });
      }
      throw new Error("成员或终端正在使用工作区，请结束当前操作后重新准备");
    }
    return this.prepareLocalEnvironment(ctx, run, env);
  } finally {
    env.nodeMu.Unlock();
  }
};

Engine.prototype.PrepareNodeWorkspace = function (ctx, run, env) {
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
    // 兄弟分支、群组角色、收尾任务或快照可能暂时（或全程）持有执行机围栏。那是等待的理由，绝不是让本节点失败的理由。
    return this.waitWorkspaceNotBusy(ctx, run, (run) => {
      if (run.IsWorkspace()) {
        try {
          const state = this.remoteWorkspacePreparation(ctx, run, RunnerWorkspaceOperationPreparationStatus);
          if (state.Status === "ready") {
            return state;
          }
        } catch {
          // Go：取状态失败时继续准备。
        }
      }
      return this.remoteWorkspacePreparation(ctx, run, RunnerWorkspaceOperationPrepare);
    });
  }
  if (run.IsWorkspace() && env.activeExecutions.Load() > 0) {
    const state = ReadWorkspacePreparationStatus(env.Workspace(), env.ID());
    const [epoch, epochErr] = ReadSandboxEnvironmentIdentity(ctx, env.sandbox);
    if (epochErr == null && WorkspacePreparationReusable(state, workspacePreparationPlan(run), run.RepositoryContexts(), epoch)) {
      return state;
    }
    throw new Error("正在协作的工作区环境发生变化，请等待当前分工结束后重新准备");
  }
  return this.prepareLocalEnvironment(ctx, run, env);
};

// HandleWorkspaceTerminal 与 SOP 执行用完全相同的环境与准备契约。池拥有 PTY，Engine 拥有沙箱。
Engine.prototype.HandleWorkspaceTerminal = async function (ctx, id, pool, scope, req, actorID) {
  if (req.Operation === "open") {
    await this.RestoreConversationWorkspaceIfNeeded(ctx, id);
    this.EnsureWorkspaceReady(ctx, id);
  }
  const [run] = this.repo.RunState(id);
  run.ID = id;
  let credentials = new TerminalGitCredentials();
  if (req.Operation === "open") {
    credentials = this.WorkspaceTerminalGitCredentials(ctx, run, actorID);
  }
  return this.HandlePreparedWorkspaceTerminal(ctx, run, pool, scope, req, credentials);
};

// WorkspaceTerminalGitCredentials 在获取运行的编辑器事务前解析打开用户的凭证。
Engine.prototype.WorkspaceTerminalGitCredentials = function (ctx, run, actorID) {
  if (actorID <= 0) {
    return new TerminalGitCredentials();
  }
  return new TerminalGitCredentials({
    HTTPS: this.repo.GitHTTPCredentialSecrets(ctx, actorID),
    SSHKeys: this.repo.GitSSHKeysForRemotes(actorID, sshRepositoryURLs(run.RepositoryContexts())),
  });
};

// HandlePreparedWorkspaceTerminal 接收调用方传来的运行，调用方可能持有运行行锁：在此重读会等那把锁。运行须带节点状态（RunState，而非裸锁定行）：否则每个已成功的准备步骤看起来都待处理，就绪检查会被当作无事可准备而跳过。
Engine.prototype.HandlePreparedWorkspaceTerminal = function (ctx, run, pool, scope, req, credentials) {
  const id = run.ID;
  if (req.Operation !== "open") {
    const [result, handleErr] = pool.HandleSandbox(ctx, null, scope, req, null);
    if (handleErr != null) {
      throw handleErr;
    }
    return result;
  }
  const env = this.runEnvs[id];
  if (env == null) {
    throw new Error("工作区环境尚未准备，请重新打开终端");
  }
  const state = ReadWorkspacePreparationStatus(env.Workspace(), env.ID());
  const [epoch, epochErr] = ReadSandboxEnvironmentIdentity(ctx, env.sandbox);
  const trivial = run.WorkflowSnapshot.Nodes.length > 0 && WorkspacePreparationTrivial(workspacePreparationPlan(run));
  if (!trivial && (epochErr != null || state.Status !== "ready" || state.Environment !== epoch)) {
    throw new Error("工作区执行环境已变化，请重新准备后打开终端");
  }
  const [result, handleErr] = pool.HandleSandboxWithGit(this.withSSHKnownHosts(ctx), env.sandbox, scope, req, null, credentials);
  if (handleErr != null) {
    throw handleErr;
  }
  return result;
};

// TrustedWorkspaceRequest 把冻结的执行配置挂到已认证的工作区传输上。它绝不作为用户可控配置暴露。
Engine.prototype.TrustedWorkspaceRequest = function (id, request) {
  const [run, ok] = this.repo.RunState(id);
  if (!ok) {
    throw new Error("运行不存在");
  }
  return this.preparedWorkspaceRequest(run, request);
};

Engine.prototype.WorkspaceRemoteHost = function (run) { return this.foreignWorkspaceBind(run); };
Engine.prototype.ForwardWorkspaceRequest = function (ctx, run, request) {
  const trusted = this.preparedWorkspaceRequest(run, request);
  return this.requestWorkspaceCheckpoint(ctx, run, trusted);
};

// 已结算的历史工作流可能引用已从目录移除的角色。打开它的文件/终端不得要求复活该模型角色。执行仍用严格的工作流校验与执行器解析。
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
    const [executor, err] = workflowNodeExecutor(st, wf, node, agent);
    if (err != null) {
      continue;
    }
    const requirements = ProviderRequirements(executor.Kind);
    // 把 relay 需求冻结给整个工作流，准备、脚本、终端与智能体可复用同一 Docker 容器。
    requirements.RunnerLoginRelay = codexLoginRelay && executor.Kind === "codex";
    items.push(requirements);
  }
  return MergeSandboxRequirements(...items);
}

// ForwardPreparedWorkspaceRequest 在编辑器事务下使用，调用方已在运行行锁之外绑定全部配置。
Engine.prototype.ForwardPreparedWorkspaceRequest = function (ctx, run, request) {
  run.ExecutionContext.ExecutionMode = ExecutionModeCloud;
  return this.requestWorkspaceCheckpoint(ctx, run, request);
};

// 只有在正常 SOP 执行中已成功的脚本才能重放以重建环境。待处理/失败/当前/下游节点保持普通调度语义，绝不提前执行。
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

Engine.prototype.recordNodeWorkspacePreparation = function (ctx, run, env, node, output) {
  if (output.length > 32 << 10) {
    output = output.slice(0, 32 << 10);
  }
  if (!node.RunOnWorkspaceRebuild) {
    return null;
  }
  if (this.defaultExecutionRunner(run) !== "") {
    const request = this.preparedWorkspaceRequest(run, new RunnerWorkspaceRequest({ RunID: run.ID, Operation: RunnerWorkspaceOperationPreparationRecord, PreparationNodeID: node.ID, PreparationOutput: output }));
    const response = this.requestWorkspaceCheckpoint(ctx, run, request);
    if (response.Error !== "") {
      throw new Error(`记录工作区重建步骤失败：${response.Error}`);
    }
    return null;
  }
  // 收据是读改写；并行分支执行时不再持 nodeMu，记录本身再取锁。
  env.nodeMu.Lock();
  try {
    const [, recordErr] = RecordWorkspacePreparation(ctx, env.sandbox, WorkspacePreparationWorkflow(run.WorkflowSnapshot), run.RepositoryContexts(), node.ID, output);
    if (recordErr != null) {
      throw recordErr;
    }
    return null;
  } finally {
    env.nodeMu.Unlock();
  }
};

module.exports = { workspaceConversationRequirements, workspacePreparationPlan, workspaceCanRefreshRepositories };
