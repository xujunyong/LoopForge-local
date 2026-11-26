// runner_dispatch.js —— 对应 Go 文件：internal/engine/runner_dispatch.go
// 作用：执行机任务下发：Agent、脚本与门禁命令排队、等待与产物取回。
// context.Context 译为 AbortSignal；goroutine 译为不 await 的异步函数；sync.Mutex 在单线程 JS 里不需要；time.Duration 换算为毫秒；(值, error) 译为成功返回值、失败 throw；(值, bool) 译为 [值, bool]；filepath.ToSlash 译为 join 后把分隔符换成 /；errors.Is 译为 ===。

"use strict";

const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath
const { TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TelemetryEvent，run.js 已翻译
const { TelemetrySource, ExecutionModeCloud, ExecutionModeRunner, RunnerWorkspaceLayoutShared, ExecutionScopeRepositories } = require("../domain/observability.js"); // 对应 Go 的 domain.TelemetrySource/ExecutionModeCloud/ExecutionModeRunner/RunnerWorkspaceLayoutShared/ExecutionScopeRepositories，observability.js 已翻译
const { RepositoryProviderSSH } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryProviderSSH，project.js 已翻译
const { SandboxDriverDocker } = require("../domain/assets.js"); // 对应 Go 的 domain.SandboxDriverDocker，assets.js 已翻译
const { RunnerTask, RunnerTaskQueued, RunnerTaskLeased, RunnerTaskRunning, RunnerTaskSuccess, RunnerTaskFailed, RunnerTaskCanceled, RunnerTaskActionCleanupRun, RunnerTaskActionArchivePreview, RunnerVersionGitSSH, RunnerVersionCreateNewWorkBranch, RunnerVersionExistingWorkBranch, RunnerVersionCodeBuddyBaseURL, RunnerStatusOnline, RuntimeAuthLocal, RuntimeAuthPersonal, RunnerSandboxRequirements, RunnerCLIStateRequirement, RunnerInvocation, RunnerRepository } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerTask/RunnerTaskQueued/RunnerTaskLeased/RunnerTaskRunning/RunnerTaskSuccess/RunnerTaskFailed/RunnerTaskCanceled/RunnerTaskActionCleanupRun/RunnerTaskActionArchivePreview/RunnerVersionGitSSH/RunnerVersionCreateNewWorkBranch/RunnerVersionExistingWorkBranch/RunnerVersionCodeBuddyBaseURL/RunnerStatusOnline/RuntimeAuthLocal/RuntimeAuthPersonal/RunnerSandboxRequirements/RunnerCLIStateRequirement/RunnerInvocation/RunnerRepository，runner.js 已翻译
const { IsAgentCLI, AgentCLILabel } = require("../runtime/agent_cli.js"); // 对应 Go 的 runtime.IsAgentCLI/AgentCLILabel，runtime 待翻译
const { IsSSHReference } = require("../gitwork/ssh_remote.js"); // 对应 Go 的 gitwork.IsSSHReference，gitwork 待翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译

// SetRunnerDispatchNotify：接通长轮询唤醒，让刚排队的任务立刻到达空闲执行机，而不是等下一次认领重试。
Engine.prototype.SetRunnerDispatchNotify = function (fn) {
  this.runnerDispatchNotify = fn;
};

Engine.prototype.notifyRunnerDispatch = function (provider) {
  const fn = this.runnerDispatchNotify;
  if (fn != null) {
    fn(provider);
  }
};

// SetRunnerControlNotify：接通低延迟执行机 WebSocket 控制通道；监听缺失或断开无害，desired_state 是持久化的，租约续期也会返回。
Engine.prototype.SetRunnerControlNotify = function (fn) {
  this.runnerControlNotify = fn;
};

Engine.prototype.notifyRunnerControl = function (runnerID, taskID, desiredState) {
  const fn = this.runnerControlNotify;
  if (fn != null && runnerID.trim() !== "") {
    fn(runnerID, taskID, desiredState);
  }
};

Engine.prototype.cancelRunnerTasksForRun = function (runID) {
  const [ids, cancelErr] = this.repo.CancelRunnerTasksForRun(runID, new Date());
  if (cancelErr != null) {
    throw cancelErr;
  }
  for (const id of ids) {
    this.NotifyRunnerTaskChanged(id);
    const [task, ok] = this.repo.RunnerTask(id);
    if (ok) {
      this.notifyRunnerControl(task.LeaseOwner, id, task.DesiredState);
    }
  }
};

// runnerWorkspaceRel：一次运行在执行机侧冻结的工作区；新运行跨脚本、Agent 与门禁共用一个检出；该布局引入前创建的运行保留每节点路径，就地重试从原来失败的目录继续。
function runnerWorkspaceRel(run, nodeID) {
  if (run.ExecutionContext.RunnerWorkspaceLayout === RunnerWorkspaceLayoutShared) {
    return path.join("runs", safeRunnerPath(workspaceRunID(run)), "workspace").split(path.sep).join("/");
  }
  return path.join("runs", safeRunnerPath(run.ID), safeRunnerPath(nodeID)).split(path.sep).join("/");
}

// runnerPreviewWorkspaceRel：预览 SourcePath 相对的目录：共享检出，或旧布局的运行根目录。
function runnerPreviewWorkspaceRel(run) {
  if (run.ExecutionContext.RunnerWorkspaceLayout === RunnerWorkspaceLayoutShared) {
    return runnerWorkspaceRel(run, "");
  }
  return runnerRunWorkspaceRel(run.ID);
}

function runnerRunWorkspaceRel(runID) {
  return path.join("runs", safeRunnerPath(runID)).split(path.sep).join("/");
}

function safeRunnerPath(v) {
  v = v.trim();
  if (v === "") {
    return "node";
  }
  let b = "";
  for (const r of v) {
    if ((r >= "a" && r <= "z") || (r >= "A" && r <= "Z") || (r >= "0" && r <= "9") || r === "-" || r === "_" || r === ".") {
      b += r;
    } else {
      b += "-";
    }
  }
  return b;
}

// requireWorkBranchCapabilities：拒绝分支语义超出所选执行机能力的运行：旧 daemon 会忽略这些标志，静默检出同名已存在分支。
Engine.prototype.requireWorkBranchCapabilities = function (runnerID, repositories) {
  if (runnerID === "") {
    return;
  }
  for (const repository of repositories) {
    if (repository.Provider === RepositoryProviderSSH) {
      const [runner, ok] = this.repo.Runner(runnerID);
      if (!ok || !runner.SupportsGitSSH()) {
        throw new Error(`Git SSH 仓库需要执行机器升级至 ${RunnerVersionGitSSH} 或更新版本，请先更新 Runner`);
      }
    }
    if (repository.CreateNewWorkBranch) {
      const [runner, ok] = this.repo.Runner(runnerID);
      if (!ok || !runner.SupportsCreateNewWorkBranch()) {
        throw new Error(`按指定名字新建分支需要执行机器升级至 ${RunnerVersionCreateNewWorkBranch} 或更新版本，请先更新 Runner`);
      }
      continue;
    }
    if (!repository.RequireExistingWorkBranch) {
      continue;
    }
    const [runner, ok] = this.repo.Runner(runnerID);
    if (!ok || !runner.SupportsExistingWorkBranch()) {
      throw new Error(`继续已有分支需要执行机器升级至 ${RunnerVersionExistingWorkBranch} 或更新版本，请先更新 Runner`);
    }
  }
};

Engine.prototype.runnerSandboxSpec = function (run) {
  const runnerID = this.defaultExecutionRunner(run);
  this.requireWorkBranchCapabilities(runnerID, run.RepositoryContexts());
  const [profile, resources] = this.workspaceSandboxProfile(run);
  const spec = resolvedSandboxSnapshot(profile, resources);
  let codexLoginRelay = false;
  if (profile.Driver === SandboxDriverDocker && runnerID !== "") {
    const [runner, ok] = this.repo.Runner(runnerID);
    codexLoginRelay = ok && runner.RuntimeAuthMode("codex") === RuntimeAuthLocal;
  }
  const requirements = workspaceConversationRequirements(this.repo, run.WorkflowSnapshot, codexLoginRelay);
  spec.Requirements = new RunnerSandboxRequirements({
    PrivateHome: requirements.PrivateHome,
    BunFS: requirements.BunFS,
    RunnerLoginRelay: requirements.RunnerLoginRelay,
  });
  spec.Requirements.CLIStates = [];
  for (const state of requirements.CLIStates ?? []) {
    spec.Requirements.CLIStates.push(new RunnerCLIStateRequirement({ Directory: state.Directory, Files: [...state.Files] }));
  }
  return spec;
};

// dispatchRunnerTask：把一次 Agent 调用作为 RunnerTask 排队到责任人默认执行机，并等它到终态；各运行时选本机 CLI 登录或责任人保存的提供方凭证，只有后者放进任务级调用；运行仓库随任务走，沙箱/工作区在那台机器上创建。
Engine.prototype.dispatchRunnerTask = async function (ctx, runnerID, run, node, sb, workspace, ex, agent, assets, prompt, invocationID, options, sink) {
  this.requireWorkBranchCapabilities(runnerID, run.RepositoryContexts());
  this.requireRunnerProvider(runnerID, ex.Kind);
  const [runner] = this.repo.Runner(runnerID);
  const authMode = runner.RuntimeAuthMode(ex.Kind);
  const resumeSessionID = resolveRunnerResumeSessionID(run, node.ID, options);
  const invocation = new RunnerInvocation({
    ArchivedFiles: this.legacyArchivedWorkspaceFiles(run, node.ID),
    RunID: run.ID,
    NodeID: node.ID,
    InvocationID: invocationID,
    ResumeSessionID: resumeSessionID,
    Executor: ex,
    Agent: agent,
    Assets: assets,
    Artifacts: node.ArtifactOutputs,
    HumanContext: run.HumanContext,
    CredentialSource: authMode,
    GateResultPath: options.GateResultPath,
    RepositoryPreparationFallback: firstRepositoryAgent(run.WorkflowSnapshot, node),
  });
  if (options.GateResultPath.trim() !== "") {
    invocation.Artifacts = [...(invocation.Artifacts ?? []), gateResultContract(options.GateResultPath)];
  }
  if (authMode === RuntimeAuthPersonal) {
    switch (ex.Kind) {
    case "codex":
      if (sb.credentialSnapshot().Codex.APIKey.trim() === "") {
        throw new Error("当前责任人未配置 Codex API Key：请先在个人配置中配置，或将执行机器认证方式切回本机登录");
      }
      invocation.CodexAPIKey = sb.credentialSnapshot().Codex.APIKey;
      invocation.CodexBaseURL = sb.credentialSnapshot().Codex.BaseURL;
      break;
    case "claude-code":
      if (sb.credentialSnapshot().ClaudeCode.APIKey.trim() === "") {
        throw new Error("当前责任人未配置 Claude Code API Key：请先在个人配置中配置，或将执行机器认证方式切回本机登录");
      }
      invocation.ClaudeCodeAPIKey = sb.credentialSnapshot().ClaudeCode.APIKey;
      invocation.ClaudeCodeBaseURL = sb.credentialSnapshot().ClaudeCode.BaseURL;
      break;
    case "codebuddy": {
      const credential = sb.credentialSnapshot().CodeBuddy;
      if (credential.APIKey.trim() === "") {
        throw new Error("当前责任人未配置 CodeBuddy API Key：请先在个人配置中配置");
      }
      if (credential.BaseURL !== "" && !runner.SupportsCodeBuddyBaseURL()) {
        throw new Error(`执行机器需升级至 ${RunnerVersionCodeBuddyBaseURL} 才能使用 CodeBuddy Base URL`);
      }
      invocation.CodeBuddyAPIKey = credential.APIKey;
      invocation.CodeBuddyBaseURL = credential.BaseURL;
      invocation.CodeBuddyInternetEnvironment = credential.InternetEnvironment;
      break;
    }
    default:
      if (IsAgentCLI(ex.Kind)) {
        const cred = sb.credentialSnapshot().AgentCLI[ex.Kind] ?? {};
        if ((cred.APIKey ?? "").trim() === "") {
          throw new Error(`当前责任人未配置 ${AgentCLILabel(ex.Kind)} API Key：请先在个人配置中配置`);
        }
        invocation.AgentCLIAPIKey = cred.APIKey;
        invocation.AgentCLIBaseURL = cred.BaseURL;
        invocation.AgentCLIProtocol = cred.Protocol;
        invocation.AgentCLIModels = cred.Models;
      }
      break;
    }
  }
  bindRunnerRepositories(invocation, run, sb.credentialSnapshot().GitUserName, sb.credentialSnapshot().GitUserEmail);
  const reported = sb.reportedOutputs(node.ID);
  if (reported != null) {
    invocation.Artifacts = null;
    invocation.ReportOutputs = true;
    invocation.Inputs = reported.inputs;
    invocation.OutputFiles = artifactOutputFiles(run, node);
    if (options.GateResultPath.trim() !== "") {
      invocation.OutputFiles = [...(invocation.OutputFiles ?? []), options.GateResultPath];
    }
    invocation.RecoverOutputs = normalizeExecutionScope(node.ExecutionScope) !== ExecutionScopeRepositories;
  }
  invocation.MCPCallServers = this.resolveScriptMCPAssets(run.ExecutionContext.ProjectID, run.ExecutionContext.ResponsibleUserID).MCPServers;
  const task = new RunnerTask({
    ID: `rt-${BigInt(Date.now()) * 1000000n}-${safeRunnerPath(node.ID)}`,
    RunnerID: runnerID,
    Provider: ex.Kind,
    Prompt: prompt,
    Workspace: workspace,
    Status: RunnerTaskQueued,
    MaxAttempts: 1,
    RunID: run.ID,
    NodeID: node.ID,
    Invocation: invocation,
  });
  task.Sandbox = this.runnerSandboxSpec(run);
  validateSOPHandoffRunnerPayload(run, task);
  const putErr = this.repo.PutRunnerTask(task);
  if (putErr != null) {
    throw putErr;
  }
  this.notifyRunnerDispatch(ex.Kind);
  if (sink != null) {
    sink(new TelemetryEvent({
      Category: "sandbox", Name: "runner.dispatch", Phase: "start",
      Message: `任务下发到执行机器 ${runnerID}（provider=${ex.Kind} task=${task.ID}）`,
      Attributes: { provider: ex.Kind, runnerId: runnerID, taskId: task.ID },
    }));
  }
  const final = await this.awaitRunnerTask(ctx, task.ID, sink);
  if (reported != null) {
    reported.absorb(final.Outputs);
    this.recordWorkspaceFacts(run.ID, final.Outputs);
  }
  switch (final.Status) {
  case RunnerTaskSuccess: {
    if (reported == null) {
      try {
        restoreRunnerArtifacts(sb.Workspace(), task.Invocation.Artifacts, final.Artifacts);
      } catch (err) {
        throw new Error(`restore runner artifacts: ${err.message}`);
      }
    }
    if (sink != null) {
      sink(new TelemetryEvent({
        Category: "sandbox", Name: "runner.completed", Phase: "finish",
        Message: `执行机器任务完成（task=${final.ID} attempt=${final.Attempt} 产物 ${(final.Artifacts ?? []).length} 个）`,
        Attributes: { taskId: final.ID, attempt: final.Attempt, artifacts: (final.Artifacts ?? []).length },
      }));
    }
    return final.Result;
  }
  case RunnerTaskFailed: {
    let msg = final.Error.trim();
    if (msg === "") {
      msg = "runner task failed";
    }
    if (final.ExitCode != null) {
      msg = `${msg} (exit ${final.ExitCode})`;
    }
    throw explainGitAuthFailure(new Error(msg), (((sb.credentialSnapshot().GitHTTPCredentials ?? {})["github.com"] ?? {}).Token ?? "").trim() !== "");
  }
  case RunnerTaskCanceled:
    throw new Error("runner task canceled");
  default:
    throw new Error(`runner task ended in unexpected state ${JSON.stringify(final.Status)}`);
  }
};

// resolveRunnerResumeSessionID：选执行机侧调用应续接的 CLI 会话；引擎级选项优先：缺失提交恢复路径上它带着引擎刚观察到的会话（nr.SessionID），而 nr.ResumeSessionID 可能已被遥测清掉；节点字段是未走引擎循环的操作员请求续接的后备。
function resolveRunnerResumeSessionID(run, nodeID, options) {
  if (options.ResumeSessionID.trim() !== "") {
    return options.ResumeSessionID.trim();
  }
  const nr = run.Nodes[nodeID];
  if (nr != null) {
    return nr.ResumeSessionID.trim();
  }
  return "";
}

function bindRunnerRepositories(invocation, run, gitUserName, gitUserEmail) {
  if (invocation == null) {
    return;
  }
  invocation.GitUserName = gitUserName.trim();
  invocation.GitUserEmail = gitUserEmail.trim();
  invocation.GitHTTPUserID = run.ExecutionContext.ResponsibleUserID;
  if (run.Repository.CloneURL.trim() !== "" && run.Repositories.length === 0) {
    invocation.Repository = new RunnerRepository({
      RepositoryID: run.Repository.RepositoryID,
      Name: run.Repository.Name,
      CloneURL: run.Repository.CloneURL,
      Ref: repositoryBaseBranch(run.Repository),
      WorkBranch: run.Repository.WorkBranch,
      RequireExistingWorkBranch: run.Repository.RequireExistingWorkBranch,
      CreateNewWorkBranch: run.Repository.CreateNewWorkBranch,
      UseSSH: run.Repository.Provider === RepositoryProviderSSH || IsSSHReference(run.Repository.CloneURL),
    });
  }
  for (const rc of run.RepositoryContexts()) {
    if (rc.CloneURL.trim() === "") {
      continue;
    }
    invocation.Repositories = [...(invocation.Repositories ?? []), new RunnerRepository({
      RepositoryID: rc.RepositoryID,
      Name: rc.Name,
      CloneURL: rc.CloneURL,
      Ref: repositoryBaseBranch(rc),
      WorkBranch: rc.WorkBranch,
      RequireExistingWorkBranch: rc.RequireExistingWorkBranch,
      CreateNewWorkBranch: rc.CreateNewWorkBranch,
      UseSSH: rc.Provider === RepositoryProviderSSH || IsSSHReference(rc.CloneURL),
      Dir: rc.WorkspaceDir,
    })];
  }
  if (invocation.GitSSHRemotes().length > 0) {
    invocation.GitSSHUserID = run.ExecutionContext.ResponsibleUserID;
    if (invocation.Repository != null && invocation.Repository.UseSSH) {
      invocation.Repository.GitToken = "";
    }
    for (let i = 0; i < invocation.Repositories.length; i++) {
      if (invocation.Repositories[i].UseSSH) {
        invocation.Repositories[i].GitToken = "";
      }
    }
  }
}

function shellSingleQuote(value) {
  return "'" + value.replaceAll("'", `'"'"'`) + "'";
}

// dispatchRunnerScript：在运行冻结的执行机上执行工作流脚本；仓库元数据随任务走，脚本也可作首节点；后续共享布局节点复用同一检出及其工作区级 Git 索引标志。
Engine.prototype.dispatchRunnerScript = async function (ctx, runnerID, run, nodeID, workspace, language, script, artifactDirectory, artifacts, sb, gitToken, gitUserName, gitUserEmail, assets, sink) {
  this.requireWorkBranchCapabilities(runnerID, run.RepositoryContexts());
  this.requireRunnerProvider(runnerID, "terminal");
  let command = script;
  if (language.trim().toLowerCase() === "python") {
    command = "python3 -c " + shellSingleQuote(script);
  }
  const invocation = new RunnerInvocation({
    ArchivedFiles: this.legacyArchivedWorkspaceFiles(run, nodeID),
    RunID: run.ID, NodeID: nodeID, Artifacts: artifacts, ArtifactDirectory: artifactDirectory, Assets: assets, MCPCallServers: assets.MCPServers, HumanContext: run.HumanContext,
  });
  bindRunnerRepositories(invocation, run, gitUserName, gitUserEmail);
  const reported = sb.reportedOutputs(nodeID);
  if (reported != null) {
    invocation.Artifacts = null;
    invocation.ArtifactDirectory = "";
    invocation.ReportOutputs = true;
    invocation.Inputs = reported.inputs;
    for (const contract of artifacts) {
      const [rel, ok] = artifactRelPath(artifactDirectory, contract.Path);
      if (ok) {
        invocation.OutputFiles = [...(invocation.OutputFiles ?? []), rel];
      }
    }
    invocation.RecoverOutputs = artifactDirectory.trim() === "";
  }
  const task = new RunnerTask({
    ID: `rt-${BigInt(Date.now()) * 1000000n}-${safeRunnerPath(nodeID)}-script`,
    RunnerID: runnerID,
    Provider: "terminal",
    Command: command,
    Workspace: workspace,
    Status: RunnerTaskQueued,
    MaxAttempts: 1,
    RunID: run.ID,
    NodeID: nodeID,
    Invocation: invocation,
  });
  task.Sandbox = this.runnerSandboxSpec(run);
  validateSOPHandoffRunnerPayload(run, task);
  const putErr = this.repo.PutRunnerTask(task);
  if (putErr != null) {
    throw putErr;
  }
  this.notifyRunnerDispatch("terminal");
  if (sink != null) {
    sink(new TelemetryEvent({
      Category: "sandbox", Name: "runner.dispatch", Phase: "start",
      Message: `脚本下发到执行机器 ${runnerID}（task=${task.ID}）`,
      Attributes: { provider: "terminal", runnerId: runnerID, taskId: task.ID },
    }));
  }
  const final = await this.awaitRunnerTask(ctx, task.ID, sink);
  if (reported != null) {
    reported.absorb(final.Outputs);
    this.recordWorkspaceFacts(run.ID, final.Outputs);
  }
  switch (final.Status) {
  case RunnerTaskSuccess:
    if (reported == null) {
      try {
        restoreRunnerArtifacts(path.join(sb.Workspace(), artifactDirectory.split("/").join(path.sep)), artifacts, final.Artifacts);
      } catch (err) {
        throw new Error(`restore runner script artifacts: ${err.message}`);
      }
    }
    return final.Result;
  case RunnerTaskCanceled:
    throw new Error("runner script canceled");
  default: {
    let message = final.Error.trim();
    if (message === "") {
      message = final.Result.trim();
    }
    if (message === "") {
      message = "script failed on runner";
    }
    throw new Error(message);
  }
  }
};

// defaultExecutionRunner：解析责任人默认执行机；空表示云端模式。
Engine.prototype.defaultExecutionRunner = function (run) {
  switch (run.ExecutionContext.ExecutionMode) {
  case ExecutionModeCloud:
    return "";
  case ExecutionModeRunner:
    return run.ExecutionContext.ExecutionRunnerID.trim();
  }
  return this.repo.DefaultRunner(run.ExecutionContext.ResponsibleUserID);
};

// validateExecutionReconnect：冻结的执行目标不可达时，在改运行状态前让重试失败；实际下发会重复同一校验，覆盖检查与执行之间断连的情况。
Engine.prototype.validateExecutionReconnect = function (run, nodeID) {
  const runnerID = this.defaultExecutionRunner(run);
  if (runnerID === "" || isPoolRun(run)) {
    return;
  }
  const [runner, ok] = this.repo.Runner(runnerID);
  if (!ok) {
    throw new Error(`无法重连原执行环境：执行机器 ${runnerID} 不存在`);
  }
  if (runner.Status !== RunnerStatusOnline) {
    throw new Error(`无法重连原执行环境：执行机器 ${runnerID}（${runner.Name}）当前离线`);
  }
  for (const node of run.WorkflowSnapshot.Nodes) {
    if (node.ID !== nodeID) {
      continue;
    }
    let provider = "terminal";
    if (node.Type !== "script" && node.Type !== "command" && node.Type !== "approval") {
      const [agent, found] = workflowAgent(this.repo, run.WorkflowSnapshot, node.AgentID);
      if (!found) {
        throw new Error(`无法重连原执行环境：agent ${node.AgentID} 不存在`);
      }
      let executor;
      try {
        executor = workflowNodeExecutor(this.repo, run.WorkflowSnapshot, node, agent);
      } catch (err) {
        if (err === errSOPExecutorUnconfigured) {
          return;
        }
        throw new Error(`无法重连原执行环境：${err.message}`);
      }
      provider = executor.Kind;
    }
    if (!runner.SupportsProvider(provider)) {
      throw new Error(`无法重连原执行环境：执行机器 ${runnerID} 不再提供 ${provider}`);
    }
    return;
  }
  throw new Error(`无法重连原执行环境：快照中不存在节点 ${nodeID}`);
};

// queueRunnerRunCleanup：持久化调度清理到拥有冻结执行机工作区的机器；成功运行在正常收尾时调用，显式删除也为失败/取消的运行调用；确定性任务 ID 让这些路径幂等，不重置进行中/已完成的工作。
Engine.prototype.queueRunnerRunCleanup = function (run) {
  const runnerID = this.defaultExecutionRunner(run);
  if (runnerID === "") {
    return;
  }
  const taskID = "rt-cleanup-" + safeRunnerPath(run.ID);
  const [existing, ok] = this.repo.RunnerTask(taskID);
  if (ok) {
    switch (existing.Status) {
    case RunnerTaskQueued:
    case RunnerTaskLeased:
    case RunnerTaskRunning:
      return;
    }
  }
  const [, runnerOk] = this.repo.Runner(runnerID);
  if (!runnerOk) {
    return;
  }
  const task = new RunnerTask({
    ID: taskID,
    RunnerID: runnerID,
    Provider: "terminal",
    Action: RunnerTaskActionCleanupRun,
    Workspace: runnerRunWorkspaceRel(run.ID),
    Status: RunnerTaskQueued,
    MaxAttempts: 3,
    RunID: run.ID,
    Sandbox: run.WorkflowSnapshot.SandboxSnapshot,
  });
  const putErr = this.repo.PutRunnerTask(task);
  if (putErr != null) {
    throw putErr;
  }
  this.notifyRunnerDispatch("terminal");
};

Engine.prototype.queueRunnerPreviewArchive = function (run, spec) {
  const runnerID = this.defaultExecutionRunner(run);
  if (runnerID === "") {
    throw new Error("preview archive requires the original runner");
  }
  const taskID = "rt-preview-archive-" + safeRunnerPath(run.ID);
  const [existing, ok] = this.repo.RunnerTask(taskID);
  if (ok) {
    switch (existing.Status) {
    case RunnerTaskQueued:
    case RunnerTaskLeased:
    case RunnerTaskRunning:
      return;
    }
  }
  const [, runnerOk] = this.repo.Runner(runnerID);
  if (!runnerOk) {
    throw new Error(`preview archive runner ${runnerID} is unavailable`);
  }
  const task = new RunnerTask({
    ID: taskID,
    RunnerID: runnerID,
    Provider: "terminal",
    Action: RunnerTaskActionArchivePreview,
    Workspace: runnerPreviewWorkspaceRel(run),
    Status: RunnerTaskQueued,
    MaxAttempts: 3,
    RunID: run.ID,
    PreviewArchive: spec,
  });
  const putErr = this.repo.PutRunnerTask(task);
  if (putErr != null) {
    throw putErr;
  }
  this.notifyRunnerDispatch("terminal");
};

// dispatchRunnerCommand：在绑定的执行机上、节点任务工作区内运行终端命令（验证门禁）；调用携带与脚本任务相同的仓库 git token，否则 `git push` 之类的门禁在禁用提示且无凭证的情况下启动。
Engine.prototype.dispatchRunnerCommand = async function (ctx, runnerID, runID, nodeID, workspace, command, gateSink) {
  const task = new RunnerTask({
    ID: `rt-${BigInt(Date.now()) * 1000000n}-gate`,
    RunnerID: runnerID,
    Provider: "terminal",
    Command: command,
    Workspace: workspace,
    Status: RunnerTaskQueued,
    MaxAttempts: 1,
    RunID: runID,
    NodeID: nodeID,
  });
  const [run, ok] = this.repo.RunState(runID);
  if (ok) {
    task.Sandbox = this.runnerSandboxSpec(run);
    task.Invocation = this.gateCommandInvocation(run, nodeID);
  }
  const putErr = this.repo.PutRunnerTask(task);
  if (putErr != null) {
    throw putErr;
  }
  this.notifyRunnerDispatch("terminal");
  if (gateSink != null) {
    gateSink(new TelemetryEvent({ Category: "process", Name: "process.started", Phase: "start", Message: "门禁命令下发到执行器：" + command }));
  }
  const final = await this.awaitRunnerTask(ctx, task.ID, gateSink);
  switch (final.Status) {
  case RunnerTaskSuccess:
    if (gateSink != null) {
      gateSink(new TelemetryEvent({ Category: "process", Name: "process.finished", Phase: "finish", Message: "门禁在执行器上执行完成" }));
    }
    return final.Result;
  case RunnerTaskCanceled:
    throw new Error("runner task canceled");
  default: {
    let msg = final.Error.trim();
    if (msg === "") {
      msg = final.Result.trim();
    }
    if (msg === "") {
      msg = "command failed on runner";
    }
    throw new Error(msg);
  }
  }
};

// gateCommandInvocation：验证命令在执行机上所需的载荷；仓库条目提供责任人的 git token；已有检出留在原地，执行机只用该 token 认证这条命令。
Engine.prototype.gateCommandInvocation = function (run, nodeID) {
  const assets = this.resolveScriptMCPAssets(run.ExecutionContext.ProjectID, run.ExecutionContext.ResponsibleUserID);
  const invocation = new RunnerInvocation({
    RunID: run.ID, NodeID: nodeID, Assets: assets, MCPCallServers: assets.MCPServers,
  });
  const identity = resolveGitIdentity(this.repo, run.ExecutionContext.ResponsibleUserID);
  bindRunnerRepositories(invocation, run, identity.name, identity.email);
  return invocation;
};

// NotifyRunnerTaskChanged：唤醒等待执行机任务状态变迁的工作流 goroutine；DB 仍是权威来源，通知只避免每运行任务每秒查一次。
Engine.prototype.NotifyRunnerTaskChanged = function (taskID) {
  for (const resolve of this.runnerTaskSubs[taskID] ?? []) {
    resolve();
  }
};

Engine.prototype.subscribeRunnerTask = function (taskID) {
  let resolve;
  const changed = new Promise((r) => { resolve = r; });
  if (this.runnerTaskSubs[taskID] == null) {
    this.runnerTaskSubs[taskID] = new Set();
  }
  this.runnerTaskSubs[taskID].add(resolve);
  return [changed, () => {
    if (this.runnerTaskSubs[taskID] != null) {
      this.runnerTaskSubs[taskID].delete(resolve);
      if (this.runnerTaskSubs[taskID].size === 0) {
        delete this.runnerTaskSubs[taskID];
      }
    }
  }];
};

// awaitRunnerTask：等进程内任务通知，API 与 worker 分属不同进程时轮询持久任务/事件流；运行取消也会标记远端任务。
Engine.prototype.awaitRunnerTask = async function (ctx, taskID, sink) {
  let lastEventSeq = 0;
  let lastStatus = "";
  const reportStatus = (task) => {
    if (sink == null || task.Status === lastStatus) {
      return;
    }
    lastStatus = task.Status;
    switch (task.Status) {
    case RunnerTaskLeased:
      sink(new TelemetryEvent({
        Category: "sandbox", Name: "runner.claimed", Phase: "progress",
        Message: "执行机器已领取任务，正在准备工作区和沙箱",
        Provider: task.Provider,
        Source: new TelemetrySource({ Layer: "executor", Adapter: "runner-v1", Provider: task.Provider }),
      }));
      break;
    case RunnerTaskRunning:
      sink(new TelemetryEvent({
        Category: "process", Name: "runner.started", Phase: "start",
        Message: "执行机器已启动任务",
        Provider: task.Provider,
        Source: new TelemetrySource({ Layer: "executor", Adapter: "runner-v1", Provider: task.Provider }),
      }));
      break;
    }
  };
  for (;;) {
    let [current, ok] = this.repo.RunnerTask(taskID);
    if (!ok) {
      throw new Error(`runner task ${taskID} disappeared`);
    }
    lastEventSeq = bridgeRunnerEventsToSink(current, this.repo.RunnerTaskEventsAfter(taskID, lastEventSeq), lastEventSeq, sink);
    reportStatus(current);
    switch (current.Status) {
    case RunnerTaskSuccess:
    case RunnerTaskFailed:
    case RunnerTaskCanceled:
      this.flushAllObservations();
      return current;
    }
    const [changed, unsubscribe] = this.subscribeRunnerTask(taskID);
    [current, ok] = this.repo.RunnerTask(taskID);
    if (!ok) {
      unsubscribe();
      throw new Error(`runner task ${taskID} disappeared`);
    }
    lastEventSeq = bridgeRunnerEventsToSink(current, this.repo.RunnerTaskEventsAfter(taskID, lastEventSeq), lastEventSeq, sink);
    reportStatus(current);
    switch (current.Status) {
    case RunnerTaskSuccess:
    case RunnerTaskFailed:
    case RunnerTaskCanceled:
      unsubscribe();
      this.flushAllObservations();
      return current;
    }
    try {
      await Promise.race([changed, sleepOrAbort(ctx, 1000)]);
    } catch {
      unsubscribe();
      this.repo.CancelRunnerTask(taskID, new Date());
      throw ctx.reason;
    }
    unsubscribe();
  }
};

// bridgeRunnerEventsToSink：在持有运行租约的进程内归一化持久执行机事件；API 进程不得改 worker 拥有的运行：updateRun 会拒绝这种写入，之前还让远端可观测性悄悄消失，尽管 runner_task_events 里有完整流。
function bridgeRunnerEventsToSink(task, events, after, sink) {
  if (sink == null) {
    for (const event of events) {
      if (event.Seq > after) {
        after = event.Seq;
      }
    }
    return after;
  }
  for (const event of events) {
    if (event.Seq <= after) {
      continue;
    }
    after = event.Seq;
    if (event.Type === "observation") {
      let observation;
      try {
        observation = Object.assign(new TelemetryEvent(), JSON.parse(event.Data));
      } catch {
        continue;
      }
      observation.Timestamp = event.Ts;
      if (observation.Source.Layer === "") {
        observation.Source.Layer = "executor";
      }
      if (observation.Source.Adapter === "") {
        observation.Source.Adapter = "runner-v1";
      }
      if (observation.Source.Provider === "") {
        observation.Source.Provider = task.Provider;
      }
      if (observation.Provider === "") {
        observation.Provider = task.Provider;
      }
      sink(observation);
      continue;
    }
    if (event.Type !== "stdout" && event.Type !== "stderr") {
      continue;
    }
    if (task.Invocation != null) {
      if (event.Type === "stderr") {
        continue;
      }
      const protocol = (task.Invocation.Executor?.Protocol ?? "").toLowerCase().trim();
      if ((protocol === "jsonl" || protocol === "stream-json") && isValidJSON(event.Data)) {
        continue;
      }
    }
    let level = "info";
    if (event.Type === "stderr") {
      level = "error";
    }
    sink(new TelemetryEvent({
      Timestamp: event.Ts,
      Category: "process",
      Name: "process." + event.Type,
      Phase: "progress",
      Level: level,
      Message: event.Data,
      Provider: task.Provider,
      Source: new TelemetrySource({ Layer: "executor", Adapter: "runner-v1", Provider: task.Provider }),
    }));
  }
  return after;
}

// requireRunnerProvider：校验绑定的执行机在线且已启用该执行器的 CLI，错绑的角色快速失败并给出明确信息，而不是排队一个无人认领的任务。
Engine.prototype.requireRunnerProvider = function (runnerID, provider) {
  const [runner, ok] = this.repo.Runner(runnerID.trim());
  if (!ok) {
    throw new Error(`执行器 ${runnerID} 不存在：请到「个人 → 执行器」页面重新绑定`);
  }
  if (runner.Status !== RunnerStatusOnline) {
    throw new Error(`执行器 ${runnerID}（${runner.Name}）当前离线，无法路由 ${provider} 任务`);
  }
  if (!runner.SupportsProvider(provider)) {
    throw new Error(`执行器 ${runnerID}（${runner.Name}）未启用 ${provider} CLI：请在执行器页面开启或改用云端 API Key 模式`);
  }
};

// restoreRunnerArtifacts：把执行机上传的产物内容写回控制面运行沙箱工作区，collectArtifacts、验证门禁与下游交接无需改动继续工作。
function restoreRunnerArtifacts(sandboxWorkspace, contracts, uploaded) {
  if (contracts == null || contracts.length === 0 || uploaded == null || Object.keys(uploaded).length === 0) {
    return;
  }
  const byName = {};
  for (const contract of contracts) {
    byName[contract.Name] = contract;
  }
  for (const [name, content] of Object.entries(uploaded)) {
    const contract = byName[name];
    if (contract == null || contract.Path.trim() === "") {
      continue;
    }
    const target = path.join(sandboxWorkspace, contract.Path.split("/").join(path.sep));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, content, { mode: 0o644 });
  }
}

// sleepOrAbort：等满毫秒或等到 ctx 取消，对应 Go 的 time.NewTimer + select。
function sleepOrAbort(ctx, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(ctx.reason);
    };
    const cleanup = () => {
      if (ctx instanceof AbortSignal) {
        ctx.removeEventListener("abort", onAbort);
      }
    };
    if (ctx instanceof AbortSignal) {
      if (ctx.aborted) {
        onAbort();
        return;
      }
      ctx.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// isValidJSON：Go 的 json.Valid 无 JS 内置对应写法。
function isValidJSON(s) {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

module.exports = { runnerWorkspaceRel, runnerPreviewWorkspaceRel, runnerRunWorkspaceRel, safeRunnerPath, resolveRunnerResumeSessionID, bindRunnerRepositories, shellSingleQuote, bridgeRunnerEventsToSink, restoreRunnerArtifacts };
