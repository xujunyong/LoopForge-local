/**
 * @file internal/engine/runner_dispatch.js
 * 对应 Go 源文件：internal/engine/runner_dispatch.go
 *
 * 作用与职责边界：
 * 实现 CLI 执行机器（Runner）任务下发与协作链路，涵盖长轮询/WebSocket 控制通道回调注册、
 * 执行机工作区相对路径规范化、分支与执行器能力校验、沙箱规格组装、Agent/脚本/验证门禁命令下发与等待、
 * 运行清理与预览归档任务排队、执行机事件流桥接至遥测接收器，以及执行机上传产物回写至控制面工作区。
 *
 * 语法差异说明：
 * - `Engine` 定义于 `engine.js`，本文件通过 `Engine.prototype` 挂载各执行机下发与等待方法。
 * - Go 的 `context.Context` 译为 `AbortSignal`；单线程 JS 不需要 `sync.Mutex`，相关加解锁语句直接略去。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；
 *   Go 中用 `_ = ...` 显式忽略的错误以 `try { ... } catch {}` 吸收；`(值, bool)` 译为 `[值, boolean]`。
 * - Go 的 `map[chan struct{}]struct{}` 存储非字符串的 Promise 唤醒回调函数，因此在 JS 中以 `Set` 表达。
 * - Go 的 `filepath.ToSlash` 译为按 `path.sep` 拆分后再用 `/` 拼接；`errors.Is` 译为 `===`；`fmt.Sprintf` `%q` 译为 `JSON.stringify`。
 */

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
const { workspaceRunID } = require("./workspace_owner.js"); // 对应 Go 同包函数，workspace_owner.js 已翻译
const { resolvedSandboxSnapshot } = require("./run_environment.js"); // 对应 Go 同包函数，run_environment.js 已翻译
const { workspaceConversationRequirements } = require("./workspace_preparation.js"); // 对应 Go 同包函数，workspace_preparation.js 已翻译
const { firstRepositoryAgent } = require("./git_preparation_fallback.js"); // 对应 Go 同包函数，git_preparation_fallback.js 已翻译
const { gateResultContract } = require("./gate_submit.js"); // 对应 Go 同包函数，gate_submit.js 已翻译
const { artifactOutputFiles, artifactRelPath } = require("./node_outputs.js"); // 对应 Go 同包函数，node_outputs.js 已翻译
const { normalizeExecutionScope, repositoryBaseBranch } = require("./execution_scope.js"); // 对应 Go 同包函数，execution_scope.js 已翻译
const { validateSOPHandoffRunnerPayload } = require("./legacy_handoff.js"); // 对应 Go 同包函数，legacy_handoff.js 已翻译
const { explainGitAuthFailure, resolveGitIdentity } = require("./git_auth.js"); // 对应 Go 同包函数，git_auth.js 已翻译
const { isPoolRun } = require("./cloud_pool.js"); // 对应 Go 同包函数，cloud_pool.js 已翻译
const { workflowAgent } = require("./assets.js"); // 对应 Go 同包函数，assets.js 已翻译
const { workflowNodeExecutor, errSOPExecutorUnconfigured } = require("./sop_executors.js"); // 对应 Go 同包函数与哨兵错误，sop_executors.js 已翻译

/**
 * 注册长轮询任务派发唤醒回调，使新入队的执行机任务立即送达空闲执行机，无需等待下次认领轮询。
 *
 * @param {function(string): void|null} fn - 接收 `provider` 名称的唤醒回调函数。
 * @returns {void} 无返回值。
 */
Engine.prototype.SetRunnerDispatchNotify = function (fn) {
  this.runnerDispatchNotify = fn;
};

/**
 * 触发指定提供方的执行机任务派发唤醒回调（若已注册）。
 *
 * @param {string} provider - 执行器提供方标识（如 `"terminal"`、`"codex"` 等）。
 * @returns {void} 无返回值。
 */
Engine.prototype.notifyRunnerDispatch = function (provider) {
  const fn = this.runnerDispatchNotify;
  if (fn != null) {
    fn(provider);
  }
};

/**
 * 注册低延迟执行机 WebSocket 控制通道回调，用于即时下发取消等期望状态。
 * 监听缺失或断开不影响正确性，因为 `desired_state` 已持久化且租约续期响应也会携带。
 *
 * @param {function(string, string, string): void|null} fn - 接收 `(runnerID, taskID, desiredState)` 的控制回调。
 * @returns {void} 无返回值。
 */
Engine.prototype.SetRunnerControlNotify = function (fn) {
  this.runnerControlNotify = fn;
};

/**
 * 通过已注册的控制通道向指定执行机推送任务期望状态变更。
 *
 * @param {string} runnerID - 目标执行机 ID。
 * @param {string} taskID - 任务 ID。
 * @param {string} desiredState - 期望控制状态（如取消标记）。
 * @returns {void} 无返回值。
 */
Engine.prototype.notifyRunnerControl = function (runnerID, taskID, desiredState) {
  const fn = this.runnerControlNotify;
  if (fn != null && runnerID.trim() !== "") {
    fn(runnerID, taskID, desiredState);
  }
};

/**
 * 取消指定运行下全部未终结的执行机任务，并唤醒等待协程与通知对应执行机控制通道。
 * 用于用户取消/暂停运行或恢复循环结算孤儿运行。
 *
 * @param {string} runID - 运行唯一标识。
 * @returns {void} 无返回值。
 * @throws {Error} 仓储批量取消任务失败时抛出错误。
 */
Engine.prototype.cancelRunnerTasksForRun = function (runID) {
  const ids = this.repo.CancelRunnerTasksForRun(runID, new Date());
  for (const id of ids) {
    this.NotifyRunnerTaskChanged(id);
    const [task, ok] = this.repo.RunnerTask(id);
    if (ok) {
      this.notifyRunnerControl(task.LeaseOwner, id, task.DesiredState);
    }
  }
};

/**
 * 计算一次运行在执行机侧冻结的工作区相对路径（统一使用 `/` 分隔）。
 * 新运行采用共享布局跨脚本、Agent 与门禁共用同一工作区（子 SOP 复用父工作区）；旧布局保留按节点隔离路径以兼容就地重试。
 *
 * @param {import("../domain/run.js").Run} run - 运行快照对象。
 * @param {string} nodeID - 节点唯一标识（共享布局下忽略）。
 * @returns {string} 相对执行机根目录的工作区路径。
 */
function runnerWorkspaceRel(run, nodeID) {
  if (run.ExecutionContext.RunnerWorkspaceLayout === RunnerWorkspaceLayoutShared) {
    return path.join("runs", safeRunnerPath(workspaceRunID(run)), "workspace").split(path.sep).join("/");
  }
  return path.join("runs", safeRunnerPath(run.ID), safeRunnerPath(nodeID)).split(path.sep).join("/");
}

/**
 * 计算预览构建产物 `SourcePath` 相对的执行机目录。
 * 共享布局指向共享工作区目录，旧布局指向运行根目录。
 *
 * @param {import("../domain/run.js").Run} run - 运行快照对象。
 * @returns {string} 相对执行机根目录的预览工作区路径。
 */
function runnerPreviewWorkspaceRel(run) {
  if (run.ExecutionContext.RunnerWorkspaceLayout === RunnerWorkspaceLayoutShared) {
    return runnerWorkspaceRel(run, "");
  }
  return runnerRunWorkspaceRel(run.ID);
}

/**
 * 计算指定运行在执行机侧的顶层工作目录相对路径（`runs/<runID>`）。
 *
 * @param {string} runID - 运行唯一标识。
 * @returns {string} 相对执行机根目录的运行目录路径。
 */
function runnerRunWorkspaceRel(runID) {
  return path.join("runs", safeRunnerPath(runID)).split(path.sep).join("/");
}

/**
 * 将任意标识字符串清洗为可用于执行机本地路径的安全片段。
 * 仅保留 ASCII 字母、数字及 `-`、`_`、`.`，其余字符统一替换为 `-`；空白串回退为 `"node"`。
 *
 * @param {string} v - 原始标识字符串。
 * @returns {string} 清洗后的路径安全片段。
 */
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

/**
 * 校验目标执行机版本是否支持仓库列表所需的 SSH 认证、按名新建分支或续用已有分支语义。
 * 防止旧版执行机忽略这些标志并静默检出同名已存在分支。
 *
 * @param {string} runnerID - 目标执行机 ID；为空时跳过校验。
 * @param {import("../domain/project.js").RepositoryContext[]} repositories - 参与运行的仓库上下文列表。
 * @returns {void} 校验通过时无返回值。
 * @throws {Error} 执行机不存在或版本不满足任一仓库所需能力时抛出中文提示错误。
 */
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

/**
 * 为下发至执行机的任务组装完整的沙箱快照与运行需求（含私密主目录、BunFS、登录中继与 CLI 状态目录）。
 *
 * @param {import("../domain/run.js").Run} run - 运行快照对象。
 * @returns {import("../domain/runner.js").RunnerSandboxSpec} 组装完成的执行机沙箱规格对象。
 * @throws {Error} 分支能力校验、沙箱配置解析或会话需求计算失败时抛出错误。
 */
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

/**
 * 将一次 Agent 节点调用封装为持久化 `RunnerTask` 下发至指定执行机，等待其到达终态并回写产物/上报输出。
 * 根据执行机认证模式决定使用本机 CLI 登录或携带责任人的个人提供方 API Key，同时附带仓库与沙箱规格。
 *
 * @param {AbortSignal|null} ctx - 控制任务等待取消的信号。
 * @param {string} runnerID - 目标执行机 ID。
 * @param {import("../domain/run.js").Run} run - 当前运行快照对象。
 * @param {import("../domain/workflow.js").WorkflowNode} node - 当前执行的 Agent 节点定义。
 * @param {import("./run_environment.js").runEnvironment} sb - 控制面运行环境（提供凭证快照、上报输出收集器与工作区路径）。
 * @param {string} workspace - 执行机侧工作区相对路径。
 * @param {import("../domain/agent.js").ExecutorDefinition} ex - 节点执行器定义。
 * @param {import("../domain/agent.js").AgentDefinition} agent - 节点角色定义。
 * @param {import("../domain/agent.js").AgentAssetBundle} assets - 编译后的角色资产包（规则、技能、MCP 等）。
 * @param {string} prompt - 编译完成的任务提示词。
 * @param {string} invocationID - 本次调用唯一标识。
 * @param {Object} options - 调用选项（含 `ResumeSessionID`、`GateResultPath` 等）。
 * @param {function(TelemetryEvent): void|null} sink - 实时遥测事件接收回调。
 * @returns {Promise<string>} 执行成功时返回执行机产出的最终结果文本。
 * @throws {Error} 校验失败、凭证缺失、任务入队/等待失败、产物回写失败或任务失败/取消时抛出错误。
 */
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
  this.repo.PutRunnerTask(task);
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

/**
 * 选择执行机侧调用应当续接的 CLI 会话 ID。
 * 引擎级 `options.ResumeSessionID` 优先（用于缺失提交恢复路径携带刚观察到的会话），其次回退到节点状态上的 `ResumeSessionID`。
 *
 * @param {import("../domain/run.js").Run} run - 当前运行快照对象。
 * @param {string} nodeID - 节点唯一标识。
 * @param {Object} options - 调用选项对象（含 `ResumeSessionID`）。
 * @returns {string} 选中的会话 ID；无需续接时返回 `""`。
 */
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

/**
 * 将运行关联的代码仓库列表、Git 作者身份及 HTTP/SSH 凭证用户 ID 绑定到执行机调用载荷中。
 * 对使用 SSH 协议的仓库会清空 `GitToken` 并回填 `GitSSHUserID`。
 *
 * @param {RunnerInvocation|null} invocation - 待填充的执行机调用载荷对象（就地修改）。
 * @param {import("../domain/run.js").Run} run - 运行快照对象。
 * @param {string} gitUserName - Git 提交用户名。
 * @param {string} gitUserEmail - Git 提交邮箱。
 * @returns {void} 无返回值。
 */
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

/**
 * 使用 POSIX 单引号对字符串进行转义包裹，便于安全拼入 `python3 -c` 等 shell 命令。
 *
 * @param {string} value - 待转义的原始文本。
 * @returns {string} 单引号安全包裹后的字符串。
 */
function shellSingleQuote(value) {
  return "'" + value.replaceAll("'", `'"'"'`) + "'";
}

/**
 * 在运行冻结的执行机上以 `terminal` 任务方式执行工作流脚本（Shell 或 Python），并等待结果与回写产物。
 * 载荷中附带仓库元数据，使脚本节点也能作为首个初始化工作区的节点。
 *
 * @param {AbortSignal|null} ctx - 控制任务等待取消的信号。
 * @param {string} runnerID - 目标执行机 ID。
 * @param {import("../domain/run.js").Run} run - 当前运行快照对象。
 * @param {string} nodeID - 脚本节点 ID。
 * @param {string} workspace - 执行机侧工作区相对路径。
 * @param {string} language - 脚本语言（`"python"` 或 shell）。
 * @param {string} script - 待执行的脚本正文。
 * @param {string} artifactDirectory - 产物相对输出目录。
 * @param {import("../domain/workflow.js").ArtifactContract[]} artifacts - 声明的产物契约列表。
 * @param {import("./run_environment.js").runEnvironment} sb - 控制面运行环境。
 * @param {string} gitToken - 保留参数（与 Go 签名对齐，实际凭证由 `bindRunnerRepositories` 经用户 ID 下发）。
 * @param {string} gitUserName - Git 提交用户名。
 * @param {string} gitUserEmail - Git 提交邮箱。
 * @param {import("../domain/agent.js").AgentAssetBundle} assets - 脚本可访问的 MCP 等资产包。
 * @param {function(TelemetryEvent): void|null} sink - 实时遥测事件接收回调。
 * @returns {Promise<string>} 执行成功时返回脚本输出文本。
 * @throws {Error} 校验失败、任务入队/等待失败、产物回写失败或脚本执行失败/取消时抛出错误。
 */
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
  this.repo.PutRunnerTask(task);
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

/**
 * 解析运行所使用的执行机 ID；返回空字符串表示云端模式。
 * 新运行读取冻结在 `ExecutionContext` 中的模式与执行机 ID，老运行兼容回退到责任人当前默认执行机。
 *
 * @param {import("../domain/run.js").Run} run - 运行快照对象。
 * @returns {string} 执行机 ID；云端模式或未绑定执行机时返回 `""`。
 */
Engine.prototype.defaultExecutionRunner = function (run) {
  switch (run.ExecutionContext.ExecutionMode) {
  case ExecutionModeCloud:
    return "";
  case ExecutionModeRunner:
    return run.ExecutionContext.ExecutionRunnerID.trim();
  }
  return this.repo.DefaultRunner(run.ExecutionContext.ResponsibleUserID);
};

/**
 * 在节点重试修改运行状态前，前置校验冻结的执行机是否仍在线且支持目标节点所需的提供方。
 * 云端模式与云池运行（启动节点时可重新绑定池内机器）直接放行。
 *
 * @param {import("../domain/run.js").Run} run - 运行快照对象。
 * @param {string} nodeID - 拟重试的节点 ID。
 * @returns {void} 可重连时无返回值。
 * @throws {Error} 执行机不存在、离线、不再支持目标提供方或快照中缺少节点/角色时抛出中文提示错误。
 */
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

/**
 * 为拥有冻结工作区的执行机持久化排队一次幂等的运行目录清理任务。
 * 成功运行在收尾时调用，失败/取消运行在显式删除时调用；确定性任务 ID 避免重复重置活跃清理任务。
 *
 * @param {import("../domain/run.js").Run} run - 待清理工作区的运行快照对象。
 * @returns {void} 无需清理、已有活跃清理任务或入队成功时无返回值。
 * @throws {Error} 任务落库失败时抛出错误。
 */
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
  this.repo.PutRunnerTask(task);
  this.notifyRunnerDispatch("terminal");
};

/**
 * 向原执行机排队一次预览产物归档上传任务。
 * 若已有排队/执行中的归档任务则幂等跳过；已完成的旧归档任务会在构建节点再次成功后被新任务替换。
 *
 * @param {import("../domain/run.js").Run} run - 关联运行快照对象。
 * @param {import("../domain/runner.js").RunnerPreviewArchiveSpec} spec - 预览归档规格（源路径与上传凭证等）。
 * @returns {void} 排队成功或已有活跃任务时无返回值。
 * @throws {Error} 运行未绑定执行机、执行机已不可用或任务落库失败时抛出错误。
 */
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
  this.repo.PutRunnerTask(task);
  this.notifyRunnerDispatch("terminal");
};

/**
 * 在绑定的执行机上、节点任务工作区内执行验证门禁终端命令，并等待其完成。
 * 载荷中携带责任人 Git 凭证，使 `git push` 等门禁命令在无交互提示环境下也能正常认证。
 *
 * @param {AbortSignal|null} ctx - 控制任务等待取消的信号。
 * @param {string} runnerID - 目标执行机 ID。
 * @param {string} runID - 运行唯一标识。
 * @param {string} nodeID - 节点唯一标识。
 * @param {string} workspace - 执行机侧工作区相对路径。
 * @param {string} command - 待执行的终端命令字符串。
 * @param {function(TelemetryEvent): void|null} gateSink - 门禁遥测事件接收回调。
 * @returns {Promise<string>} 命令执行成功时返回输出文本。
 * @throws {Error} 沙箱规格组装失败、入队/等待失败或命令失败/取消时抛出错误。
 */
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
  this.repo.PutRunnerTask(task);
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

/**
 * 构造验证门禁命令在执行机上运行所需的调用载荷，附带 MCP 资产与责任人 Git 身份及仓库凭证绑定。
 *
 * @param {import("../domain/run.js").Run} run - 运行快照对象。
 * @param {string} nodeID - 节点唯一标识。
 * @returns {RunnerInvocation} 填充完毕的门禁调用载荷。
 */
Engine.prototype.gateCommandInvocation = function (run, nodeID) {
  const assets = this.resolveScriptMCPAssets(run.ExecutionContext.ProjectID, run.ExecutionContext.ResponsibleUserID);
  const invocation = new RunnerInvocation({
    RunID: run.ID, NodeID: nodeID, Assets: assets, MCPCallServers: assets.MCPServers,
  });
  const identity = resolveGitIdentity(this.repo, run.ExecutionContext.ResponsibleUserID);
  bindRunnerRepositories(invocation, run, identity.name, identity.email);
  return invocation;
};

/**
 * 唤醒进程内所有正在等待指定执行机任务状态变更的协程。
 * 数据库仍是权威状态源，进程内通知仅用于降低轮询延迟与数据库查询频次。
 *
 * @param {string} taskID - 发生变更的执行机任务 ID。
 * @returns {void} 无返回值。
 */
Engine.prototype.NotifyRunnerTaskChanged = function (taskID) {
  for (const resolve of this.runnerTaskSubs[taskID] ?? []) {
    resolve();
  }
};

/**
 * 订阅指定执行机任务的进程内一次性变更通知，返回通知 Promise 与取消订阅函数。
 *
 * @param {string} taskID - 待监听的执行机任务 ID。
 * @returns {[Promise<void>, function(): void]} 返回 `[变更通知 Promise, 取消订阅回调]` 二元组。
 */
Engine.prototype.subscribeRunnerTask = function (taskID) {
  let resolve;
  const changed = new Promise((r) => { resolve = r; });
  if (this.runnerTaskSubs[taskID] == null) {
    // 对应 Go 的 map[chan struct{}]struct{}：元素为非字符串的 resolve 回调函数，使用 Set 存储。
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

/**
 * 结合进程内通知与 1 秒兜底轮询，等待执行机任务进入终态（成功/失败/取消），并持续桥接任务事件流至遥测回调。
 * 当 `ctx` 取消时同步在仓储中标记取消远端任务并抛出取消原因。
 *
 * @param {AbortSignal|null} ctx - 控制等待取消的信号。
 * @param {string} taskID - 待等待的执行机任务 ID。
 * @param {function(TelemetryEvent): void|null} sink - 实时遥测事件接收回调。
 * @returns {Promise<RunnerTask>} 到达终态后的最新执行机任务对象。
 * @throws {Error} 任务记录消失或 `ctx` 触发取消时抛出错误。
 */
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
      try {
        this.repo.CancelRunnerTask(taskID, new Date());
      } catch {}
      throw ctx.reason;
    }
    unsubscribe();
  }
};

/**
 * 在持有运行租约的进程内，将持久化执行机任务事件流增量归一化并转发至遥测回调 `sink`。
 * 自动补齐 `observation` 事件的来源信息，并过滤已由适配器归一化过的 `stderr` 与结构化 JSON stdout 帧以避免重复噪音。
 *
 * @param {RunnerTask} task - 关联的执行机任务对象。
 * @param {import("../domain/runner.js").RunnerTaskEvent[]} events - 新读取的增量任务事件列表。
 * @param {number} after - 上一次已消费的最大事件序号。
 * @param {function(TelemetryEvent): void|null} sink - 遥测事件接收回调；为 `null` 时仅推进序号。
 * @returns {number} 本批处理后最新的最大事件序号。
 */
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

/**
 * 校验目标执行机存在、当前在线且已启用指定提供方 CLI，避免将任务排给不可用执行机而长期无人认领。
 *
 * @param {string} runnerID - 目标执行机 ID。
 * @param {string} provider - 所需执行器提供方名称。
 * @returns {void} 校验通过时无返回值。
 * @throws {Error} 执行机不存在、离线或未启用对应提供方时抛出中文提示错误。
 */
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

/**
 * 将执行机上传的产物内容按契约路径写回控制面运行沙箱工作区，保证后续产物采集、验证门禁与下游交接无需改动即可工作。
 *
 * @param {string} sandboxWorkspace - 控制面沙箱工作区根目录。
 * @param {import("../domain/workflow.js").ArtifactContract[]|null} contracts - 声明的产物契约列表。
 * @param {Object.<string, string>|null} uploaded - 执行机上传的产物名到文件内容的映射。
 * @returns {void} 无返回值。
 * @throws {Error} 创建父目录或写入产物文件失败时抛出文件系统错误。
 */
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

/**
 * 等待指定毫秒数或直到取消信号触发，对应 Go 的 `time.NewTimer` 搭配 `select <-ctx.Done()`。
 *
 * @param {AbortSignal|null} ctx - 可选取消信号；为 `null` 时仅按毫秒数等待。
 * @param {number} ms - 等待时长（毫秒）。
 * @returns {Promise<void>} 正常到时后兑现，无返回值。
 * @throws {Error} 等待期间 `ctx` 中止时拒绝并抛出 `ctx.reason`。
 */
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

/**
 * 判断字符串是否为合法 JSON 文本，对应 Go 的 `json.Valid`。
 *
 * @param {string} s - 待检测的字符串。
 * @returns {boolean} 解析成功返回 `true`，否则返回 `false`。
 */
function isValidJSON(s) {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

module.exports = { runnerWorkspaceRel, runnerPreviewWorkspaceRel, runnerRunWorkspaceRel, safeRunnerPath, resolveRunnerResumeSessionID, bindRunnerRepositories, shellSingleQuote, bridgeRunnerEventsToSink, restoreRunnerArtifacts };
