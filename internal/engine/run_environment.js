// run_environment.js —— 对应 Go 文件：internal/engine/run_environment.go
// 作用：运行沙箱环境：获取、绑定、释放单次运行的工作区与凭证。
// context.Context 译为 AbortSignal；time.Time 零值译为 null；sync.Mutex/RWMutex 在单线程 JS 里不需要；os.Stat 的不存在错误译为 ENOENT 判断。

"use strict";

const fs = require("node:fs"); // Go os
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { ErrRunLeaseLost, ErrRunWorkspaceBound } = require("../repo/repo.js"); // 对应 Go 的 repo.ErrRunLeaseLost/ErrRunWorkspaceBound，repo.js 已翻译
const { SandboxProfile, SandboxDriverDocker, RunnerSandbox } = require("../domain/assets.js"); // 对应 Go 的 domain.SandboxProfile/SandboxDriverDocker/RunnerSandbox，assets.js 已翻译
const { RunnerSandboxSpec } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerSandboxSpec，runner.js 已翻译
const { RunCredentials, ProviderCredential, MCPTarget, SandboxResources, ExtraRunCredentials, PrepareMCPServers, AgentCLIUserCredentials } = require("../runtime/runtime.js"); // 对应 Go 的 runtime.RunCredentials/ProviderCredential/MCPTarget/SandboxResources/ExtraRunCredentials/PrepareMCPServers/AgentCLIUserCredentials，runtime 未翻译

// runEnvironment 持有一次工作流运行独占的沙箱/工作区。SOP 节点与群组任务只在准备共享环境（拉取代码、准备脚本、输入）时持有 nodeMu；并行分支随后并发执行，用 activeExecutions 计数。
class runEnvironment {
  constructor(init = {}) {
    this.sandbox = init.sandbox ?? null;
    this.credentials = init.credentials ?? null;
    this.repositoriesPrepared = init.repositoriesPrepared ?? false;
    this.preparing = init.preparing ?? false;
    this.activeExecutions = init.activeExecutions ?? 0;
    // reported 按节点保存执行机上报的内容（RunnerTask.Outputs 支持时）；缺失的节点用沙箱工作区。
    this.reported = init.reported ?? null;
  }
}

runEnvironment.prototype.beginReportedOutputs = function (nodeID, inputs) {
  if (this.reported == null) {
    this.reported = {};
  }
  const outputs = newReportedOutputs(inputs);
  this.reported[nodeID] = outputs;
  return outputs;
};

runEnvironment.prototype.reportedOutputs = function (nodeID) {
  if (this.reported == null) {
    return null;
  }
  return this.reported[nodeID] ?? null;
};

runEnvironment.prototype.endReportedOutputs = function (nodeID) {
  if (this.reported != null) {
    delete this.reported[nodeID];
  }
};

// prepareRepositoriesOnce 把仓库拉取固定在运行环境生命周期内。nodeMu 串行化调用方，重建的环境以 repositoriesPrepared=false 启动，因此进程重启与租约接管后仍会在执行节点前重验一次已持久化的工作区。
runEnvironment.prototype.prepareRepositoriesOnce = function (prepare) {
  if (this.repositoriesPrepared) {
    return null;
  }
  const err = prepare();
  if (err != null) {
    return err;
  }
  this.repositoriesPrepared = true;
  return null;
};

runEnvironment.prototype.ID = function () { return this.sandbox.ID(); };
runEnvironment.prototype.Workspace = function () { return this.sandbox.Workspace(); };
runEnvironment.prototype.Unwrap = function () {
  if (this == null) {
    return null;
  }
  return this.sandbox;
};
runEnvironment.prototype.Driver = function () {
  if (typeof this.sandbox?.Driver === "function") {
    return this.sandbox.Driver();
  }
  return "";
};
runEnvironment.prototype.Exec = function (ctx, command, sink) {
  return this.sandbox.Exec(ctx, command, sink);
};
runEnvironment.prototype.Recreate = function (ctx) {
  if (typeof this.sandbox?.Recreate === "function") {
    return this.sandbox.Recreate(ctx);
  }
  return null;
};

runEnvironment.prototype.BindWorkspace = function (ctx) {
  if (typeof this.sandbox?.BindWorkspace === "function") {
    return this.sandbox.BindWorkspace(ctx);
  }
  return this.Recreate(ctx);
};
runEnvironment.prototype.Close = function (ctx) { return this.sandbox.Close(ctx); };

runEnvironment.prototype.Detach = function () {
  if (typeof this.sandbox?.Detach === "function") {
    return this.sandbox.Detach();
  }
  return null;
};

// resolveSandbox 是已存 profile 实际运行的 runner 规格。docker 沙箱没有 Dockerfile 就无法运行。
function resolveSandbox(profile) {
  if (profile.Driver.trim() === SandboxDriverDocker && (profile.Dockerfile == null || profile.Dockerfile.Content.trim() === "")) {
    throw new Error(`docker sandbox ${JSON.stringify(profile.ID)} has no Dockerfile`);
  }
  return RunnerSandbox(profile);
}

function resolvedSandboxSnapshot(profile, resources) {
  const snapshot = new RunnerSandboxSpec({ Profile: profile });
  if (resources.Dockerfile.ID.trim() !== "") {
    const dockerfile = resources.Dockerfile;
    snapshot.Dockerfile = { ...dockerfile };
  }
  return snapshot;
}

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
  const [sandbox, err] = this.sandboxes.AcquireRunIn(ctx, run.ID, workspaceRunID(current), profile, requirements, credentials, resources);
  if (err != null) {
    throw err;
  }
  const env = new runEnvironment({
    sandbox: sandbox,
    credentials: credentials,
  });
  this.runEnvs[run.ID] = env;
  const [first, bindErr] = this.repo.BindRunWorkspace(run.ID, this.instanceID, run.Generation, this.workspaceHost, this.sandboxes.Root());
  let bindError = bindErr;
  if (bindError == null && current.WorkspaceCleanedAt != null) {
    // 没有归档的旧运行由正常执行重建，不由预检恢复。一旦有了真实沙箱，就清除旧的清理标记，让后续写入与检查点捕获能用上它。
    bindError = this.repo.ResetRunWorkspaceCleanup(run.ID);
  }
  if (bindError != null) {
    delete this.runEnvs[run.ID];
    env.Close(null);
    throw bindError;
  }
  return [env, first];
};

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

runEnvironment.prototype.credentialSnapshot = function () {
  return this.credentials;
};

runEnvironment.prototype.setCredentials = function (credentials) {
  this.credentials = credentials;
  if (typeof this.sandbox?.SetCredentials === "function") {
    this.sandbox.SetCredentials(credentials);
  }
};

// adoptForeignWorkspace 处理绑定宿主已离线运行。没有代码改动的工作区直接搬到本实例；有代码改动的则随宿主丢失了改动：绑定仍搬过来，让重跑从全新拉取开始，但当前尝试改为失败，不静默地丢掉前面节点的成果继续跑。
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

// rebindWorkspaceHere 把运行的工作区绑定从已离线的宿主搬到本实例。本机该运行 ID 下残留的是早先停留的遗留物，直接丢弃，让下一个节点从全新拉取开始。
Engine.prototype.rebindWorkspaceHere = function (run, lost) {
  try {
    this.releaseRunEnvironment(run.ID, true);
  } catch (err) {
    throw new Error(`discard stale local workspace: ${err.message}`);
  }
  const err = this.repo.RebindRunWorkspace(run.ID, this.instanceID, run.Generation, this.workspaceHost, this.sandboxes.Root());
  if (err != null) {
    throw err;
  }
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

Engine.prototype.releaseRunEnvironment = function (runID, destroy) {
  const env = this.runEnvs[runID];
  delete this.runEnvs[runID];
  if (destroy) {
    delete this.workspaceFacts[runID];
  }

  let closeErr = null;
  if (env != null) {
    closeErr = env.Close(null);
  }
  if (destroy) {
    const err = this.sandboxes.DestroyRun(runID);
    if (err != null) {
      if (closeErr != null) {
        throw new Error(`close run sandbox: ${closeErr.message}; destroy workspace: ${err.message}`);
      }
      throw err;
    }
  }
  if (closeErr != null) {
    throw closeErr;
  }
  return null;
};

Engine.prototype.detachRunEnvironment = function (runID) {
  const env = this.runEnvs[runID];
  delete this.runEnvs[runID];
  if (env != null) {
    env.Detach();
  }
};

Engine.prototype.detachAllRunEnvironments = function () {
  const ids = Object.keys(this.runEnvs);
  for (const id of ids) {
    this.detachRunEnvironment(id);
  }
};

// LocalRunWorkspace 仅在本进程能读到权威拉取时解析控制面工作区。Runner 归属的工作区走 HTTP 层维护的有界只读通道。
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

// RunExecutionRunner 返回冻结进运行的执行机器。空表示权威工作区属于控制面。
Engine.prototype.RunExecutionRunner = function (run) {
  return this.defaultExecutionRunner(run);
};

module.exports = { runEnvironment, resolveSandbox, resolvedSandboxSnapshot, sandboxResourcesFromSnapshot };
