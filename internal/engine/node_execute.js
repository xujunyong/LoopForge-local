// node_execute.js —— 对应 Go 文件：internal/engine/node_execute.go
// 作用：工作流运行主调度循环与单节点执行编排，负责租约心跳续期、并行就绪分支派发、沙箱与代码仓库准备、脚本/Agent 执行、提交式门禁与验证门禁循环及节点结果提交。
// 职责边界：仅负责单次运行的调度推进与单节点执行生命周期编排；终态收敛由 node_outcome.js 处理，提示词渲染由 prompt.js 处理，门禁解析由 gate_submit.js/gate_mr.js 处理。
// 语法差异说明：context.Context 译为 AbortSignal；goroutine 译为不 await 的异步函数；sync.WaitGroup 译为持有 Promise 对象的 Set；sync.Mutex 在单线程 JS 中省略；map[string]bool 译为普通对象 {}；(值, error) 统一译为成功返回值、失败 throw Error（runOnce 失败时通过 err.output 携带部分输出）；(值, bool) 译为 [值, boolean]；time.Duration 译为毫秒数。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TelemetryEvent，run.js 已翻译
const { SandboxProfile, ValidateFrozenSandbox } = require("../domain/assets.js"); // 对应 Go 的 domain.SandboxProfile/ValidateFrozenSandbox，assets.js 已翻译
const { VerificationGate } = require("../domain/workflow.js"); // 对应 Go 的 domain.VerificationGate，workflow.js 已翻译
const { VerificationModeMR } = require("../domain/verification.js"); // 对应 Go 的 domain.VerificationModeMR，verification.js 已翻译
const { ExecutionScopeRepositories } = require("../domain/observability.js"); // 对应 Go 的 domain.ExecutionScopeRepositories，observability.js 已翻译
const { IsPreviewBuildNode, PreviewBuildNodeID } = require("../domain/preview.js"); // 对应 Go 的 domain.IsPreviewBuildNode/PreviewBuildNodeID，preview.js 已翻译
const { ApprovalWaitReason } = require("../domain/approval_reason.js"); // 对应 Go 的 domain.ApprovalWaitReason，approval_reason.js 已翻译
const { DetectFrontendProject } = require("../domain/preview_detect.js"); // 对应 Go 的 domain.DetectFrontendProject，preview_detect.js 已翻译
const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { BuiltInExecutor, BuiltInExecutorForKind } = require("../repo/catalog.js"); // 对应 Go 的 repo.BuiltInExecutor/BuiltInExecutorForKind，catalog.js 已翻译
const { ProviderRequirements, MergeSandboxRequirements } = require("../runtime/provider.js"); // 对应 Go 的 runtime.ProviderRequirements/MergeSandboxRequirements，runtime 待翻译
const { DockerImageCached, IsCwdMountFailure, IsSandboxInterrupt } = require("../runtime/sandbox_docker.js"); // 对应 Go 的 runtime.DockerImageCached/IsCwdMountFailure/IsSandboxInterrupt，runtime 待翻译
const { BindGit, BindMCP } = require("../runtime/runtime.js"); // 对应 Go 的 runtime.BindGit/BindMCP，runtime 待翻译
const { CommandSpecWithCredentialEnv } = require("../runtime/run_credentials_extra.js"); // 对应 Go 的 runtime.CommandSpecWithCredentialEnv，runtime 待翻译
const { EnsureControlRoot } = require("../runtime/materialize.js"); // 对应 Go 的 runtime.EnsureControlRoot，runtime 待翻译
const { RestoreMissingWorkspaceArtifacts } = require("../runtime/workspace_artifacts.js"); // 对应 Go 的 runtime.RestoreMissingWorkspaceArtifacts，runtime 待翻译
const { VerifyGitPreparation, GitPreparationFallbackPrompt } = require("../runtime/git_preparation_fallback.js"); // 对应 Go 的 runtime.VerifyGitPreparation/GitPreparationFallbackPrompt，runtime 待翻译
const { PrepareMCPServers } = require("../runtime/platform_mcp.js"); // 对应 Go 的 runtime.PrepareMCPServers，runtime 待翻译
const { ProvisionMCPAssets } = require("../runtime/mcp_provision.js"); // 对应 Go 的 runtime.ProvisionMCPAssets，runtime 待翻译
const { WithRepositoryCacheIn } = require("../runtime/repository_cache.js"); // 对应 Go 的 runtime.WithRepositoryCacheIn，runtime 待翻译
const { WithSSHKeys } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork.WithSSHKeys，gitwork 待翻译
const { executionTarget, executionTargetSink, bindExecutionTarget, executeForTargets } = require("./execution_scope.js"); // 对应 Go 同包符号，execution_scope.js 已翻译
const { gateMissingRetryMarker, verificationRun, gateResultPath, clearGateResult, readGateResultFrom, applyGateResult, appendSubmitGateInstruction } = require("./gate_submit.js"); // 对应 Go 同包符号，gate_submit.js 已翻译
const { mrPendingCommand, errMRUnverifiable, parseMRPending } = require("./gate_mr.js"); // 对应 Go 同包符号，gate_mr.js 已翻译
const { bindVerificationCommand } = require("./gate_bind.js"); // 对应 Go 同包函数，gate_bind.js 已翻译
const { workspaceOutputs, runnerArtifactInputs } = require("./node_outputs.js"); // 对应 Go 同包函数，node_outputs.js 已翻译
const { shouldCommitNodeOutcome, resolveGateOnFailure, isMaxTurnsErr, nodeRejects, allowRejectOnFailure, mergeArtifactContracts } = require("./node_outcome.js"); // 对应 Go 同包函数，node_outcome.js 已翻译
const { materializeInputs, recoverMisplacedArtifacts, validateArtifactOutputs, collectArtifactsMode } = require("./artifacts.js"); // 对应 Go 同包函数，artifacts.js 已翻译
const { workflowAgent, knowledgeSkippedWarning } = require("./assets.js"); // 对应 Go 同包函数，assets.js 已翻译
const { continuingInterruptedAttempt, settleStatusForCompletedGraph, pipelineFailedMessage } = require("./lifecycle.js"); // 对应 Go 同包符号，lifecycle.js 已翻译
const { readyNodes, workflowForRun, allSucceeded, hasWaiting, hasFailed, cancelledNode } = require("./workflow_graph.js"); // 对应 Go 同包函数，workflow_graph.js 已翻译
const { alignOnlyRun, autoSucceedAlignApprovals } = require("./align.js"); // 对应 Go 同包函数，align.js 已翻译
const { scheduledIntegratePending } = require("./lifecycle.js"); // 对应 Go 同包函数，lifecycle.js 已翻译
const { withRunGitCredentials, withGitIdentity, explainGitAuthFailure, sshRepositoryURLs } = require("./git_auth.js"); // 对应 Go 同包函数，git_auth.js 已翻译
const { firstRepositoryAgent } = require("./git_preparation_fallback.js"); // 对应 Go 同包函数，git_preparation_fallback.js 已翻译
const { prepareRepositories } = require("./repository_workspace.js"); // 对应 Go 同包函数，repository_workspace.js 已翻译
const { validateSOPHandoffArtifacts } = require("./legacy_handoff.js"); // 对应 Go 同包函数，legacy_handoff.js 已翻译
const { writeHumanContextFile } = require("./human_context.js"); // 对应 Go 同包函数，human_context.js 已翻译
const { workspaceRunID, nodeControlKey } = require("./workspace_owner.js"); // 对应 Go 同包函数，workspace_owner.js 已翻译
const { runnerWorkspaceRel, shellSingleQuote } = require("./runner_dispatch.js"); // 对应 Go 同包函数，runner_dispatch.js 已翻译
const { renderPromptWithStore, appendArtifactContract } = require("./prompt.js"); // 对应 Go 同包函数，prompt.js 已翻译

/**
 * 运行单次工作流的主调度循环：启动租约续期心跳，按依赖就绪情况并行派发节点，并在所有分支收敛后结算运行终态。
 * 在获取运行租约后由调度器异步启动；退出时保证等待所有在途节点结束并释放运行租约。
 *
 * @param {AbortSignal|null} ctx - 引擎或运行级取消信号。
 * @param {string} runID - 运行 ID。
 * @returns {Promise<void>} 主调度循环结束时 resolve，无返回值。
 */
Engine.prototype.execute = async function (ctx, runID) {
  let [r, ok] = this.repo.RunState(runID);
  if (!ok || r.IsWorkspace() || r.HistoricalGroup() || r.Status === "queued" || r.AdmissionState === "unstarted") {
    this.clearRunning(runID);
    return;
  }
  if (!this.ownsRun(r)) {
    const [status, msg, done] = settleStatusForCompletedGraph(workflowForRun(this.repo, r), r);
    if (done && !(status === "succeeded" && scheduledIntegratePending(r))) {
      this.finishAt(runID, r.Generation, status, msg);
    }
    this.clearRunning(runID);
    return;
  }
  const generation = r.Generation;
  // context.WithCancel 译为 AbortController；父 ctx 取消时一并取消。
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (ctx instanceof AbortSignal) {
    if (ctx.aborted) {
      controller.abort();
    } else {
      ctx.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  ctx = controller.signal;
  // goroutine 译为不 await 的异步函数；ticker 译为 sleepOrAbort 循环。
  const heartbeatDone = (async () => {
    let interval = this.leaseTTL / 3;
    if (interval <= 0) {
      interval = 1000;
    }
    for (;;) {
      try {
        await sleepOrAbort(ctx, interval);
      } catch {
        return;
      }
      try {
        await this.renewRunLease(runID, generation);
      } catch {
        cancel();
        return;
      }
      if (this.runControlRequested(runID)) {
        cancel();
        return;
      }
      this.reconcileNodeExecutions(runID);
    }
  })();
  // Go 的 map[string]bool 译为普通对象 {}；sync.WaitGroup 译为持有 Promise 对象的 Set；wake 译为带 1 缓冲的唤醒信号。
  const inflight = {};
  const nodePromises = new Set();
  let wakePending = false;
  let wakeResolve = null;
  const signalWake = () => {
    if (wakeResolve != null) {
      const resolve = wakeResolve;
      wakeResolve = null;
      resolve();
    } else {
      wakePending = true;
    }
  };
  const waitWake = () => {
    if (wakePending) {
      wakePending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => { wakeResolve = resolve; });
  };
  // stopNodes 在运行结算前取消并排空所有在途节点，防止终态或暂停态写入到仍在执行的分支之下。
  const stopNodes = async () => {
    cancel();
    await Promise.all([...nodePromises]);
  };
  try {
    for (;;) {
      if (ctx.aborted) {
        await Promise.all([...nodePromises]);
        await this.finishInterruptedAt(runID, generation);
        return;
      }
      [r, ok] = this.repo.RunState(runID);
      if (!ok || TerminalRunStatus(r.Status) || r.IsWorkspace() || r.HistoricalGroup()) {
        return;
      }
      if (r.CancelRequested) {
        await stopNodes();
        this.finishAt(runID, generation, "cancelled", "流水线已取消");
        return;
      }
      if (r.PauseRequested) {
        await stopNodes();
        this.pauseAt(runID, generation, "运行已由用户暂停");
        return;
      }
      if (r.Generation !== generation || !this.ownsRun(r)) {
        return;
      }
      const wf = workflowForRun(this.repo, r);
      this.reconcileNodeExecutions(runID);
      const ready = [];
      for (const node of readyNodes(wf, r)) {
        if (!inflight[node.ID]) {
          ready.push(node);
        }
      }
      const running = Object.keys(inflight).length;
      if (ready.length === 0 && running > 0) {
        // 仍有兄弟分支在执行：其结果可能解锁更多节点，且不能在其完成前提前结算运行。
        await Promise.race([waitWake(), aborted(ctx), sleep(500)]);
        continue;
      }
      if (ready.length === 0) {
        if (allSucceeded(wf, r)) {
          let rework;
          try {
            rework = await this.integrateScheduledRun(runID);
          } catch (err) {
            this.finishAt(runID, generation, "failed", "合入 integration 失败：" + err.message);
            return;
          }
          if (rework) {
            continue;
          }
          this.finishAt(runID, generation, "succeeded", "流水线执行完成");
          return;
        }
        if (hasWaiting(wf, r)) {
          if (alignOnlyRun(r)) {
            this.updateRun(runID, (current) => {
              if (autoSucceedAlignApprovals(current, new Date())) {
                this.event(current, "", "gate.auto_approved", "基线对齐无需人工确认，已自动通过");
              }
            });
            continue;
          }
          this.updateRun(runID, (current) => { current.Status = "waiting"; });
          return;
        }
        if (hasFailed(wf, r)) {
          this.finishAt(runID, generation, "failed", pipelineFailedMessage);
          return;
        }
        const [cancelled, cancelledOk] = cancelledNode(wf, r);
        if (cancelledOk) {
          this.finishAt(runID, generation, "failed", "节点「" + cancelled.Name + "」已取消，流水线无法继续；请从该节点重跑");
          return;
        }
        await sleep(80);
        continue;
      }
      for (const node of ready) {
        inflight[node.ID] = true;
        const p = (async () => {
          try {
            await this.executeNode(ctx, runID, wf, node);
          } finally {
            delete inflight[node.ID];
            signalWake();
            nodePromises.delete(p);
          }
        })();
        nodePromises.add(p);
      }
    }
  } finally {
    cancel();
    await Promise.all([...nodePromises]);
    await heartbeatDone;
    // Go 的 `_ =` 丢弃返回值与错误。
    try {
      this.repo.ReleaseRunLease(runID, this.instanceID, generation);
    } catch {}
    // Go 的 e.mu 在单线程 JS 中省略。
    delete this.running[runID];
  }
};

/**
 * 解析节点与角色最终使用的执行器定义，并应用角色级的 Model 与 Effort 覆盖配置。
 * 优先查找内置执行器目录，对 mock 及历史旧执行器 ID 按 Kind 映射到内置 CLI。
 *
 * @param {Object} st - 数据仓库实例（repo.Store）。
 * @param {Object} node - 工作流节点定义（domain.WorkflowNode）。
 * @param {Object} agent - 角色定义对象（domain.AgentDefinition）。
 * @returns {Object} 解析后的执行器定义（domain.ExecutorDefinition）。
 * @throws {Error} 找不到匹配执行器时抛出 Error。
 */
function resolveNodeExecutor(st, node, agent) {
  let executorID = agent.ExecutorID;
  if (executorID === "") {
    executorID = node.ExecutorID;
  }
  if (executorID === "") {
    executorID = "codebuddy";
  }
  let [ex, found] = BuiltInExecutor(executorID);
  if (!found && executorID === "mock") {
    // 确定性 mock 执行器保留给内部测试与旧运行快照。
    [ex, found] = st.Executor(executorID);
  }
  if (!found) {
    // 兼容历史持久化任意执行器 ID：按 Kind 映射到对应内置 CLI，不复用旧二进制或参数。
    const [legacy, ok] = st.Executor(executorID);
    if (ok) {
      [ex, found] = BuiltInExecutorForKind(legacy.Kind);
      if (found && agent.Model.trim() === "" && legacy.Model.trim() !== "") {
        ex.Model = legacy.Model;
      }
    }
  }
  if (!found) {
    throw new Error(`executor ${JSON.stringify(executorID)} not found (agent ${agent.ID})`);
  }
  if (agent.Model.trim() !== "") {
    ex.Model = agent.Model;
  }
  if (agent.Effort.trim() !== "") {
    ex.Effort = agent.Effort;
  }
  return ex;
}

/**
 * 汇总整条工作流所有 Agent 节点对沙箱环境的依赖需求（合并各执行器 Provider 需求）。
 * 在获取或创建运行沙箱环境前调用；跳过脚本、命令、审批与子 SOP 节点。
 *
 * @param {Object} st - 数据仓库实例（repo.Store）。
 * @param {Object} wf - 工作流定义对象（domain.WorkflowDefinition）。
 * @returns {Object} 合并后的沙箱需求对象（runtime.SandboxRequirements）。
 * @throws {Error} 节点引用的角色不存在或执行器解析失败（非未配置错误）时抛出 Error。
 */
function workflowSandboxRequirements(st, wf) {
  // 延迟 require 打破与 sop_executors.js 的循环依赖。
  const { errSOPExecutorUnconfigured, workflowNodeExecutor } = require("./sop_executors.js");
  const requirements = [];
  for (const node of wf.Nodes) {
    if (node.Type === "script" || node.Type === "command" || node.Type === "approval" || node.Type === "sop") {
      continue;
    }
    const [agent, ok] = workflowAgent(st, wf, node.AgentID);
    if (!ok) {
      throw new Error(`agent ${JSON.stringify(node.AgentID)} not found`);
    }
    let executor;
    try {
      executor = workflowNodeExecutor(st, wf, node, agent);
    } catch (err) {
      if (err === errSOPExecutorUnconfigured) {
        continue;
      }
      throw err;
    }
    requirements.push(ProviderRequirements(executor.Kind));
  }
  return MergeSandboxRequirements(...requirements);
}

/**
 * 返回沙箱镜像构建提示中展示的镜像名称标签（优先 Dockerfile 名称，其次 ID，默认“沙箱镜像”）。
 * 在记录 sandbox.image.building 遥测事件时调用。
 *
 * @param {Object|null} snap - 沙箱快照对象（domain.RunnerSandboxSpec）。
 * @returns {string} 可读的镜像展示标签。
 */
function dockerImageBuildLabel(snap) {
  if (snap != null && snap.Dockerfile != null) {
    const name = snap.Dockerfile.Name.trim();
    if (name !== "") {
      return name;
    }
    const id = snap.Dockerfile.ID.trim();
    if (id !== "") {
      return id;
    }
  }
  return "沙箱镜像";
}

/**
 * 判断当前 Docker 沙箱镜像是否尚未在本地缓存、需要首次构建。
 * 在 bindDockerWorkspace 决定是否上报镜像构建进度事件时调用。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {Object|null} snap - 沙箱快照对象（domain.RunnerSandboxSpec）。
 * @returns {boolean} 需要构建返回 true，已命中本地缓存返回 false。
 */
function dockerImageNeedsBuild(ctx, snap) {
  if (snap == null || snap.Dockerfile == null || snap.Dockerfile.Content.trim() === "") {
    return true;
  }
  return !DockerImageCached(ctx, snap.Dockerfile);
}

/**
 * 将耗时毫秒数格式化为中文易读时长（如“12 秒”、“3 分钟”、“2 分 15 秒”）。
 * 在沙箱镜像构建完成日志中调用。
 *
 * @param {number} d - 耗时毫秒数（对应 Go 的 time.Duration）。
 * @returns {string} 格式化后的中文耗时字符串。
 */
function formatElapsedCN(d) {
  if (d < 0) {
    d = 0;
  }
  const sec = Math.round(d / 1000);
  if (sec < 60) {
    return `${sec} 秒`;
  }
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (rem === 0) {
    return `${min} 分钟`;
  }
  return `${min} 分 ${rem} 秒`;
}

/**
 * 将工作区绑定到 Docker 沙箱容器，并在首次需要构建镜像时上报构建开始与就绪耗时遥测事件。
 * 在仓库检出完成后、驱动为 docker 时由 executeNode 调用。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} runID - 运行 ID。
 * @param {string} nodeID - 当前节点 ID。
 * @param {Object|null} snap - 沙箱快照对象（domain.RunnerSandboxSpec）。
 * @param {Object} sb - 运行环境实例（runEnvironment）。
 * @returns {Promise<void>} 绑定成功时 resolve，无返回值。
 * @throws {Error} 容器绑定或镜像构建失败时抛出 Error。
 */
Engine.prototype.bindDockerWorkspace = async function (ctx, runID, nodeID, snap, sb) {
  const building = dockerImageNeedsBuild(ctx, snap);
  if (building) {
    this.observe(runID, nodeID, new TelemetryEvent({
      Category: "sandbox",
      Name: "sandbox.image.building",
      Phase: "start",
      Message: `首次运行：正在构建沙箱镜像（${dockerImageBuildLabel(snap)}），通常需要数分钟，完成后才会开始执行`,
      Attributes: { dockerfileId: dockerfileID(snap) },
    }));
    this.flushAllObservations();
  }
  const started = Date.now();
  await sb.BindWorkspace(ctx);
  if (building) {
    const elapsed = Date.now() - started;
    this.observe(runID, nodeID, new TelemetryEvent({
      Category: "sandbox",
      Name: "sandbox.image.ready",
      Phase: "finish",
      Message: `沙箱镜像已就绪，耗时 ${formatElapsedCN(elapsed)}`,
      Attributes: { durationMs: elapsed, dockerfileId: dockerfileID(snap) },
    }));
    this.flushAllObservations();
  }
};

/**
 * 提取沙箱快照中内嵌 Dockerfile 的 ID；不存在时返回空字符串。
 * 在构造镜像构建相关遥测属性时调用。
 *
 * @param {Object|null} snap - 沙箱快照对象（domain.RunnerSandboxSpec）。
 * @returns {string} Dockerfile ID 或空字符串。
 */
function dockerfileID(snap) {
  if (snap == null || snap.Dockerfile == null) {
    return "";
  }
  return snap.Dockerfile.ID;
}

/**
 * 执行工作流中的单个节点：涵盖节点加锁、状态推进、子 SOP/审批分流、沙箱与仓库准备、脚本或 Agent 调用、提交式门禁与验证门禁循环、自修正复盘及产物登记。
 * 由 Engine.execute 为每个就绪节点并发拉起。
 *
 * @param {AbortSignal|null} ctx - 运行级取消信号。
 * @param {string} runID - 运行 ID。
 * @param {Object} wf - 工作流定义对象（domain.WorkflowDefinition）。
 * @param {Object} node - 待执行的节点定义（domain.WorkflowNode）。
 * @returns {Promise<void>} 节点执行与终态提交完成后 resolve，无返回值。
 */
Engine.prototype.executeNode = async function (ctx, runID, wf, node) {
  // 延迟 require 打破与 sop_executors.js 的循环依赖。
  const { workflowNodeExecutor } = require("./sop_executors.js");
  // Go 按值传参，JS 用展开复制结构体，避免写回调用方的 wf。
  wf = { ...wf };
  const [currentLease, ok] = this.repo.RunState(runID);
  if (!ok || !this.ownsRun(currentLease)) {
    return;
  }
  // 兄弟分支并发执行；仅同一节点的另一次执行（恢复、返工或接管）会排队等待。
  const unlock = this.lockNodeExec(runID, node.ID);
  try {
    const executionGeneration = currentLease.Generation;
    let executionAttempt = 0;
    let started = false;
    this.updateRun(runID, (r) => {
      const nr = r.Nodes[node.ID];
      if (nr.Status !== "pending") {
        return;
      }
      if (nr.Error !== "" && IsCwdMountFailure(new Error(nr.Error))) {
        nr.Status = "failed";
        this.event(r, node.ID, "node.failed", nr.Error);
        return;
      }
      started = true;
      r.Status = "running";
      nr.Status = "running";
      if (!continuingInterruptedAttempt(nr)) {
        nr.Attempt++;
      }
      executionAttempt = nr.Attempt;
      nr.StartedAt = new Date();
      nr.GateResult = null;
      this.event(r, node.ID, "node.started", node.Name + " 开始执行");
    });
    if (!started) {
      return;
    }
    // context.WithCancel 译为 AbortController；父 ctx 取消时一并取消。
    const nodeController = new AbortController();
    const cancelNode = () => nodeController.abort();
    if (ctx instanceof AbortSignal) {
      if (ctx.aborted) {
        nodeController.abort();
      } else {
        ctx.addEventListener("abort", cancelNode, { once: true });
      }
    }
    ctx = nodeController.signal;
    const unregister = this.registerNodeExecution(runID, node.ID, executionAttempt, cancelNode);
    try {
      const failNode = (err, allowReject) => {
        if (err == null) {
          return;
        }
        if (ctx.aborted) {
          return;
        }
        if (IsSandboxInterrupt(err)) {
          this.requeueInterruptedNode(runID, node.ID, executionAttempt, executionGeneration);
          return;
        }
        this.nodeFailedAt(runID, node, executionAttempt, executionGeneration, err, allowReject);
      };
      if (currentLease.ExecutionContext.SharedScheduleID !== "") {
        try {
          const version = this.repo.SharedScheduleVersion(currentLease.ExecutionContext.SharedScheduleID, currentLease.ExecutionContext.SharedScheduleVersion);
          this.repo.ValidateSharedScheduleAssets(version);
        } catch (scheduleErr) {
          failNode(scheduleErr, false);
          return;
        }
      }
      if (node.Type === "sop") {
        await this.executeSOPNode(ctx, runID, wf, node, executionAttempt, executionGeneration);
        return;
      }
      if (node.Type === "approval") {
        let auto = false;
        this.updateRun(runID, (r) => {
          if (r.SandboxID !== "") {
            r.Nodes[node.ID].SandboxID = r.SandboxID;
          }
          if (!alignOnlyRun(r)) {
            return;
          }
          const nr = r.Nodes[node.ID];
          nr.Status = "succeeded";
          nr.FinishedAt = new Date();
          this.event(r, node.ID, "gate.auto_approved", "基线对齐无需人工确认，已自动通过");
          auto = true;
        });
        if (auto) {
          return;
        }
        let reason = "等待人工批准";
        const [approvalRun, approvalOk] = this.repo.RunState(runID);
        if (approvalOk) {
          const why = ApprovalWaitReason(approvalRun, node.ID);
          if (why !== "") {
            reason += "：" + why;
          }
        }
        this.waitApproval(runID, node, reason);
        return;
      }
      let [current] = this.repo.RunState(runID);
      try {
        current = await this.bindPoolRunner(ctx, current, node.ID);
      } catch (e) {
        failNode(e, false);
        return;
      }
      try {
        current = await this.resolveDeferredSOPExecutor(current, node);
      } catch (e) {
        failNode(e, nodeRejects(node));
        return;
      }
      wf.ExecutorDefaults = current.WorkflowSnapshot.ExecutorDefaults;
      let profile = new SandboxProfile({});
      if (current.WorkflowSnapshot.SandboxSnapshot != null) {
        profile = current.WorkflowSnapshot.SandboxSnapshot.Profile;
      } else {
        let found;
        [profile, found] = this.repo.Sandbox(wf.SandboxProfileID);
        if (!found) {
          failNode(new Error(`sandbox profile ${JSON.stringify(wf.SandboxProfileID)} not found`), nodeRejects(node));
          return;
        }
      }
      try {
        ValidateFrozenSandbox(profile);
      } catch (e) {
        failNode(e, false);
        return;
      }
      let requirements;
      try {
        requirements = workflowSandboxRequirements(this.repo, wf);
      } catch (requirementsErr) {
        failNode(requirementsErr, nodeRejects(node));
        return;
      }
      let acquireProfile = profile;
      // 已选定远端执行机器时，真实进程沙箱归属该机器，控制面仅保留本地暂存工作区。
      if (this.defaultExecutionRunner(current) !== "") {
        acquireProfile = new SandboxProfile({ ID: profile.ID + "-runner-staging", Name: profile.Name + " staging", Driver: "local" });
      }
      let sb;
      let created;
      try {
        [sb, created] = await this.acquireRunEnvironment(ctx, current, acquireProfile, requirements, () => {
          this.observe(runID, node.ID, new TelemetryEvent({ Category: "sandbox", Name: "workspace.waiting", Phase: "wait", Message: "等待工作区操作完成" }));
        });
      } catch (e) {
        failNode(e, nodeRejects(node));
        return;
      }
      if (created) {
        this.observe(runID, node.ID, new TelemetryEvent({ Category: "sandbox", Name: "sandbox.created", Phase: "start", Message: sb.ID(), Attributes: { profileId: profile.ID, driver: profile.Driver, instanceId: this.instanceID, workspaceHost: this.workspaceHost, workspaceRoot: this.sandboxes.Root() } }));
      }
      this.updateRun(runID, (r) => {
        r.SandboxID = sb.ID();
        r.Nodes[node.ID].SandboxID = sb.ID();
      });
      // Go 的 sb.nodeMu 在单线程 JS 中省略。
      const sink = (event) => { this.observe(runID, node.ID, event); };
      // gateExec 执行验证门禁命令：成功返回输出字符串，失败抛出 Error。
      let gateExec = async (command, target, gateSink) => {
        const spec = CommandSpecWithCredentialEnv({ Argv: ["sh", "-lc", bindExecutionTarget(command, target)], Provider: "verification", CredentialBindings: [BindGit, BindMCP] }, node.CredentialEnv, sb.credentialSnapshot());
        return await sb.Exec(ctx, spec, gateSink);
      };
      [current] = this.repo.RunState(runID);
      const gitCredentials = sb.credentialSnapshot();
      const gitTok = (gitCredentials.GitHTTPCredentials["github.com"] ?? {}).Token ?? "";
      ctx = withRunGitCredentials(ctx, sb.credentialSnapshot());
      ctx = WithSSHKeys(this.withSSHKnownHosts(ctx), gitCredentials.GitSSHKeys);
      ctx = withGitIdentity(ctx, sb.credentialSnapshot().GitUserName, sb.credentialSnapshot().GitUserEmail);
      let stagingCheckout = true;
      const [stagingRunner, stagingRunnerOk] = this.repo.Runner(this.defaultExecutionRunner(current));
      if (stagingRunnerOk && stagingRunner.SupportsIntegrate()) {
        stagingCheckout = false;
      }
      let repositoryFallback = "";
      const prepErr = sb.prepareRepositoriesOnce(() => {
        if (!stagingCheckout) {
          return null;
        }
        try {
          prepareRepositories(WithRepositoryCacheIn(ctx, sb.Unwrap()), sb.Workspace(), current.RepositoryContexts());
        } catch (e) {
          return explainGitAuthFailure(new Error(`repository checkout: ${e.message}`), gitTok.trim() !== "" || Object.keys(gitCredentials.GitHTTPCredentials ?? {}).length > 0);
        }
        for (const rc of current.RepositoryContexts()) {
          this.observe(runID, node.ID, new TelemetryEvent({ Category: "sandbox", Name: "repository.checked_out", Phase: "finish", Message: rc.Name + " @ " + rc.WorkBranch, Attributes: { repositoryId: rc.RepositoryID, repositoryDir: rc.WorkspaceDir, baseBranch: rc.BaseBranch, workBranch: rc.WorkBranch } }));
        }
        return null;
      });
      if (prepErr != null) {
        if (ctx.aborted || !firstRepositoryAgent(wf, node)) {
          failNode(prepErr, nodeRejects(node));
          return;
        }
        repositoryFallback = prepErr.message;
        this.observe(runID, node.ID, new TelemetryEvent({ Category: "sandbox", Name: "repository.preparation.fallback", Phase: "progress", Level: "warn", Message: "平台仓库准备失败，交给首个 Agent 节点处理：" + repositoryFallback }));
      }
      try {
        validateSOPHandoffArtifacts(current);
      } catch (e) {
        failNode(e, false);
        return;
      }
      let reported = null;
      let artifactContext = "";
      let endReported = null;
      try {
        const [reportedRunner, reportedRunnerOk] = this.repo.Runner(this.defaultExecutionRunner(current));
        if (reportedRunnerOk && reportedRunner.SupportsReportedOutputs()) {
          let inputs;
          [artifactContext, inputs] = runnerArtifactInputs(wf, node, current);
          reported = sb.beginReportedOutputs(node.ID, inputs);
          endReported = () => sb.endReportedOutputs(node.ID);
        } else {
          try {
            EnsureControlRoot(sb.Workspace());
          } catch (e) {
            failNode(new Error(`prepare AgentFlow control root: ${e.message}`), nodeRejects(node));
            return;
          }
          try {
            artifactContext = materializeInputs(sb.Workspace(), wf, node, current);
          } catch (e) {
            failNode(new Error(`artifact handoff: ${e.message}`), nodeRejects(node));
            return;
          }
          try {
            writeHumanContextFile(sb.Workspace(), current.HumanContext);
          } catch (e) {
            failNode(new Error(`write human context: ${e.message}`), nodeRejects(node));
            return;
          }
        }
        if (artifactContext !== "") {
          this.observe(runID, node.ID, new TelemetryEvent({ Category: "artifact", Name: "artifact.inputs.materialized", Phase: "finish", Message: artifactContext }));
        }
        if (reported == null) {
          try {
            RestoreMissingWorkspaceArtifacts(sb.Workspace(), this.legacyArchivedWorkspaceFiles(current, node.ID));
          } catch (restoreErr) {
            failNode(new Error(`restore archived outputs: ${restoreErr.message}`), nodeRejects(node));
            return;
          }
        }
        let outputs = workspaceOutputs(sb.Workspace());
        let retroWorkspace = sb.Workspace();
        if (reported != null) {
          outputs = reported;
          retroWorkspace = "";
        }
        if (sb.Driver().toLowerCase() === "docker") {
          try {
            await this.bindDockerWorkspace(ctx, runID, node.ID, current.WorkflowSnapshot.SandboxSnapshot, sb);
          } catch (e) {
            failNode(new Error(`bind docker workspace after checkout: ${e.message}`), nodeRejects(node));
            return;
          }
        }
        if (IsPreviewBuildNode(node.ID)) {
          let found = false;
          let evidence = "";
          const [facts, factsOk] = this.RunWorkspaceFacts(runID);
          if (reported != null && factsOk) {
            found = facts.Frontend;
            evidence = facts.FrontendEvidence;
          } else if (reported != null) {
            found = true;
          } else {
            [found, evidence] = DetectFrontendProject(sb.Workspace());
          }
          if (!found) {
            this.completeSkippedPreviewBuild(runID, node, executionGeneration, executionAttempt, current, evidence);
            return;
          }
        }
        if (repositoryFallback === "") {
          let preparationErr = null;
          try {
            await this.PrepareNodeWorkspace(ctx, current, sb);
          } catch (e) {
            preparationErr = e;
          }
          if (preparationErr != null) {
            if (this.defaultExecutionRunner(current) === "" || !firstRepositoryAgent(wf, node) || !preparationErr.message.includes("repositories") || ctx.aborted) {
              failNode(preparationErr, nodeRejects(node));
              return;
            }
            repositoryFallback = preparationErr.message;
          }
        }
        const completeRepositoryFallback = async () => {
          if (repositoryFallback === "") {
            return;
          }
          if (this.defaultExecutionRunner(current) === "") {
            try {
              await VerifyGitPreparation(ctx, sb.Workspace(), current.RepositoryContexts());
            } catch (verifyErr) {
              throw new Error(`Agent 仓库准备兜底校验失败: ${verifyErr.message}`);
            }
          }
          await this.PrepareNodeWorkspace(ctx, current, sb);
          sb.repositoriesPrepared = true;
          repositoryFallback = "";
          this.observe(runID, node.ID, new TelemetryEvent({ Category: "sandbox", Name: "repository.preparation.recovered", Phase: "finish", Message: "Agent 已完成仓库准备，冻结仓库和工作分支校验通过" }));
        };
        // Go 的 atomic.Int64.Add 译为数字加减。
        sb.activeExecutions += 1;
        try {
          let output = "";
          let defaultFailure = "fail";
          if (nodeRejects(node)) {
            defaultFailure = "reject";
          }
          let gates = [];
          // Go 的 effectiveNode := node 是结构体复制，JS 用展开复制。
          let effectiveNode = { ...node };
          let maxIterations = 1;
          let loopOnExhausted = "fail";
          let loopFeedback = "";
          let invocationSeq = 0;
          let requiresSubmit = false;
          let err = null;
          let ex = null;
          // runOnce：执行单轮脚本或 Agent 调用；成功返回输出字符串，失败抛出 Error（可附带 err.output 保存部分输出）。
          let runOnce;
          switch (node.Type) {
            case "script":
            case "command": {
              runOnce = async () => {
                if (reported != null) {
                  reported.reset();
                }
                let script = node.Script;
                let language = node.ScriptLanguage;
                if (node.Type === "command") {
                  script = node.Command;
                  language = "shell";
                }
                const started = Date.now();
                let command = script;
                if (language === "python") {
                  command = "python3 -c " + shellSingleQuote(script);
                }
                let rawOutput = "";
                let runErr = null;
                try {
                  rawOutput = await executeForTargets(current, node.ExecutionScope, async (target) => {
                    const bound = bindExecutionTarget(command, target);
                    const targetSink = executionTargetSink(sink, target);
                    const scriptAssets = this.resolveScriptMCPAssets(current.ExecutionContext.ProjectID, current.ExecutionContext.ResponsibleUserID);
                    const execMachine = this.defaultExecutionRunner(current);
                    if (execMachine !== "") {
                      const workspace = runnerWorkspaceRel(current, node.ID);
                      return await this.dispatchRunnerScript(ctx, execMachine, current, node.ID, workspace, "shell", bound, target.directory(), effectiveNode.ArtifactOutputs ?? [], sb, (sb.credentialSnapshot().GitHTTPCredentials["github.com"] ?? {}).Token ?? "", sb.credentialSnapshot().GitUserName, sb.credentialSnapshot().GitUserEmail, scriptAssets, targetSink);
                    }
                    await ProvisionMCPAssets(ctx, sb, sb.Workspace(), scriptAssets, targetSink);
                    const scriptSpec = CommandSpecWithCredentialEnv({ Argv: ["sh", "-lc", bound], Provider: "script", CredentialBindings: [BindGit, BindMCP] }, effectiveNode.CredentialEnv, sb.credentialSnapshot());
                    return await sb.Exec(ctx, scriptSpec, targetSink);
                  });
                } catch (e) {
                  rawOutput = e?.partialOutput ?? "";
                  runErr = e;
                }
                const execMachine = this.defaultExecutionRunner(current);
                if (execMachine !== "") {
                  const workspace = runnerWorkspaceRel(current, node.ID);
                  gateExec = async (command, target, gateSink) => {
                    return await this.dispatchRunnerCommand(ctx, execMachine, runID, node.ID, workspace, bindExecutionTarget(command, target), gateSink);
                  };
                }
                if (runErr == null && node.RunOnWorkspaceRebuild) {
                  try {
                    await this.recordNodeWorkspacePreparation(ctx, current, sb, node, rawOutput);
                  } catch (recordErr) {
                    this.AppendRunEvent(runID, "workspace.preparation.record_failed", "脚本 " + node.Name + " 已正常完成，但工作区重建记录保存失败：" + recordErr.message + "；不会自动重试已完成脚本");
                  }
                }
                const duration = Date.now() - started;
                let status = "成功";
                let level = "";
                if (runErr != null) {
                  status = "失败";
                  level = "error";
                }
                sink(new TelemetryEvent({
                  Category: "script", Name: "script.completed", Phase: "finish", Level: level,
                  Message: `${scriptLanguageLabel(language)} 脚本执行${status} · ${duration} ms · 输出 ${Buffer.byteLength(rawOutput)} bytes`,
                  Attributes: { language, status, durationMs: duration, outputBytes: Buffer.byteLength(rawOutput) },
                }));
                if (rawOutput.trim() === "") {
                  rawOutput = `# 脚本执行结果\n\n- 语言：${scriptLanguageLabel(language)}\n- 状态：${status}\n- 耗时：${duration} ms\n- 标准输出：无\n`;
                }
                if (runErr != null) {
                  runErr.output = rawOutput;
                  throw runErr;
                }
                return rawOutput;
              };
              break;
            }
            default: {
              // SOP Agent 节点必须通过 submit_gate_result 提交终态裁决以驱动流转。
              requiresSubmit = true;
              const [agent, found] = workflowAgent(this.repo, wf, node.AgentID);
              if (!found) {
                err = new Error(`agent ${JSON.stringify(node.AgentID)} not found`);
                break;
              }
              try {
                ex = workflowNodeExecutor(this.repo, wf, node, agent);
              } catch (errResolve) {
                err = errResolve;
                break;
              }
              effectiveNode.ArtifactOutputs = mergeArtifactContracts(agent.ArtifactOutputs, node.ArtifactOutputs);
              gates = [];
              for (const gate of agent.Verification) {
                gates.push(new verificationRun({ gate, onFailure: resolveGateOnFailure(gate.OnFailure, defaultFailure) }));
              }
              for (const point of agent.Interventions) {
                if (point.Required && (point.Stage === "after_execution" || point.Stage === "before_publish")) {
                  gates.push(new verificationRun({ gate: new VerificationGate({ ID: point.ID, Name: point.Name, Mode: "manual", Stage: point.Stage, Required: true }), onFailure: defaultFailure }));
                }
              }
              if (agent.Loop.Enabled) {
                maxIterations = Math.max(1, agent.Loop.MaxIterations);
                loopOnExhausted = agent.Loop.OnExhausted;
              }
              const agentLockOwner = workspaceRunID(current);
              runOnce = async (feedback) => {
                // 同角色节点共享控制目录，CLI 调用需排队串行化。
                const releaseAgent = this.lockAgentInvocation(agentLockOwner, agent.ID);
                try {
                  if (reported != null) {
                    reported.reset();
                  }
                  const [runCurrent] = this.repo.RunState(runID);
                  invocationSeq++;
                  let attempt = 1;
                  let resumeSessionID = "";
                  let resumeFeedback = "";
                  if (runCurrent.Nodes[node.ID] != null) {
                    const nr = runCurrent.Nodes[node.ID];
                    if (nr.Attempt > 0) {
                      attempt = nr.Attempt;
                    }
                    resumeSessionID = nr.ResumeSessionID.trim();
                    resumeFeedback = nr.Feedback.trim();
                    if (feedback === gateMissingRetryMarker) {
                      resumeSessionID = nr.SessionID.trim();
                    }
                  }
                  const invocationID = `${nodeControlKey(runCurrent, node.ID)}-${attempt}-${invocationSeq}`;
                  const rendered = renderPromptWithStore(this.repo, wf, effectiveNode, runCurrent);
                  const hadCatalog = rendered.includes("{{artifacts}}");
                  let prompt = rendered.replaceAll("{{artifacts}}", artifactContext);
                  if (!hadCatalog && artifactContext !== "") {
                    prompt += "\n\n# Upstream artifacts\n\n" + artifactContext;
                  }
                  prompt = appendArtifactContract(prompt, effectiveNode, runCurrent.RepositoryContexts());
                  if (feedback !== "" && feedback !== gateMissingRetryMarker) {
                    let template = agent.Loop.FeedbackPrompt;
                    if (template === "") {
                      template = "上一轮未通过 Agent 门禁。请根据以下反馈在同一工作区内修正，只重做失败部分：\n{{feedback}}";
                    }
                    prompt += "\n\n" + template.replaceAll("{{feedback}}", feedback);
                  }
                  if (resumeSessionID !== "") {
                    prompt = "请从刚才中断的位置继续执行。";
                    if (resumeFeedback !== "") {
                      prompt += "\n\n操作员补充了以下信息，请结合它继续：\n\n" + resumeFeedback;
                    }
                  }
                  if (requiresSubmit) {
                    prompt = appendSubmitGateInstruction(prompt, node.RejectTo, feedback === gateMissingRetryMarker);
                  }
                  if (repositoryFallback !== "") {
                    prompt = GitPreparationFallbackPrompt(runCurrent.RepositoryContexts(), repositoryFallback) + prompt;
                  }
                  if (runCurrent.ExecutionContext.SharedScheduleID !== "") {
                    const version = this.repo.SharedScheduleVersion(runCurrent.ExecutionContext.SharedScheduleID, runCurrent.ExecutionContext.SharedScheduleVersion);
                    this.repo.ValidateSharedScheduleAssets(version);
                  }
                  const assets = this.resolveAssets(agent, runCurrent.ExecutionContext.ProjectID, wf.ID, runCurrent.ExecutionContext.ResponsibleUserID);
                  const warnMCPSkipped = (message) => {
                    sink(new TelemetryEvent({ Category: "mcp", Name: "mcp.skipped", Phase: "start", Level: "warn", Message: message }));
                  };
                  const knowledgeWarning = knowledgeSkippedWarning(agent, assets);
                  if (knowledgeWarning !== "") {
                    warnMCPSkipped(knowledgeWarning);
                  }
                  const options = { RunID: runID, NodeID: node.ID, ResumeSessionID: resumeSessionID, Repositories: runCurrent.RepositoryContexts() };
                  if (requiresSubmit) {
                    options.GateResultPath = gateResultPath(nodeControlKey(runCurrent, node.ID), attempt);
                  }
                  let invocationEx = ex;
                  const cb = sb.credentialSnapshot().CodeBuddy ?? {};
                  if (invocationEx.Kind === "codebuddy" && cb.Sponsored) {
                    invocationEx = this.sponsoredExecutor(runID, invocationEx, cb.SponsoredModels ?? [], sink);
                  }
                  const execMachine = this.defaultExecutionRunner(runCurrent);
                  if (execMachine !== "") {
                    const workspace = runnerWorkspaceRel(runCurrent, node.ID);
                    const result = await this.dispatchRunnerTask(ctx, execMachine, runCurrent, effectiveNode, sb, workspace, invocationEx, agent, assets, prompt, invocationID, options, sink);
                    gateExec = async (command, target, gateSink) => {
                      return await this.dispatchRunnerCommand(ctx, execMachine, runID, node.ID, workspace, bindExecutionTarget(command, target), gateSink);
                    };
                    return result;
                  }
                  const repositories = runCurrent.RepositoryContexts();
                  const [boundAssets, skipped] = await PrepareMCPServers(assets, {
                    GitHTTPCredentials: gitCredentials.GitHTTPCredentials,
                    ExtraCredentials: gitCredentials.Extra,
                    RequireCredentials: true,
                    SSHRepositoriesOnly: repositories.length > 0 && sshRepositoryURLs(repositories).length === repositories.length,
                  });
                  for (const warning of skipped) {
                    warnMCPSkipped(warning);
                  }
                  return await this.runner.Run(ctx, sb, invocationID, invocationEx, agent, boundAssets, prompt, options, sink);
                } finally {
                  releaseAgent();
                }
              };
              break;
            }
          }
          if (err != null) {
            failNode(err, nodeRejects(node));
            return;
          }
          let gateRejected = false;
          let failedAction = "";
          let lastIteration = 0;
          let submitPath = "";
          if (requiresSubmit) {
            submitPath = gateResultPath(nodeControlKey(current, node.ID), executionAttempt);
          }
          for (let iteration = 1; iteration <= maxIterations; iteration++) {
            lastIteration = iteration;
            if (requiresSubmit) {
              this.updateRun(runID, (r) => {
                if (r.Nodes[node.ID] != null) {
                  r.Nodes[node.ID].GateResult = null;
                }
              });
              if (reported == null) {
                try {
                  clearGateResult(sb.Workspace(), submitPath);
                } catch (clearErr) {
                  err = new Error(`clear submit_gate_result: ${clearErr.message}`);
                  failedAction = "human";
                  break;
                }
              }
            }
            try {
              output = await runOnce(loopFeedback);
              err = null;
            } catch (e) {
              output = e?.output ?? "";
              err = e;
            }
            if (this.dropLostCLISession(runID, node.ID, output, err)) {
              try {
                output = await runOnce("");
                err = null;
              } catch (e) {
                output = e?.output ?? "";
                err = e;
              }
            }
            if (err != null && err.message.includes("without a terminal result")) {
              this.observe(runID, node.ID, new TelemetryEvent({ Category: "orchestration", Name: "agent.loop", Phase: "finish", Message: "执行器未返回 result，按工作区产物继续门禁，不再重跑 Agent", Attributes: { iteration } }));
              err = null;
            }
            let submitted = null;
            if (err == null && requiresSubmit) {
              try {
                submitted = readGateResultFrom(outputs, submitPath);
              } catch (e) {
                err = e;
              }
              if (err != null || submitted == null) {
                let firstProblem = "未调用 submit_gate_result";
                if (err != null) {
                  firstProblem = err.message;
                  if (reported == null) {
                    try {
                      clearGateResult(sb.Workspace(), submitPath);
                    } catch {}
                  }
                }
                this.flushAllObservations();
                const [resumable] = this.repo.RunState(runID);
                let sessionID = "";
                if (resumable.Nodes[node.ID] != null) {
                  sessionID = resumable.Nodes[node.ID].SessionID.trim();
                }
                if (sessionID === "") {
                  err = new Error(`${firstProblem}，且执行器没有返回可恢复的 CLI session ID`);
                } else {
                  this.observe(runID, node.ID, new TelemetryEvent({ Category: "verification", Name: "gate.submit.missing", Phase: "progress", Level: "warn", Message: firstProblem + "，恢复同一 CLI session 要求重新提交", Attributes: { iteration, sessionId: sessionID } }));
                  try {
                    output = await runOnce(gateMissingRetryMarker);
                    err = null;
                  } catch (e) {
                    output = e?.output ?? "";
                    err = e;
                  }
                  if (this.dropLostCLISession(runID, node.ID, output, err)) {
                    try {
                      output = await runOnce("");
                      err = null;
                    } catch (e) {
                      output = e?.output ?? "";
                      err = e;
                    }
                  }
                  if (err == null) {
                    try {
                      submitted = readGateResultFrom(outputs, submitPath);
                    } catch (e) {
                      err = e;
                    }
                  }
                }
              }
              if (err == null && submitted == null) {
                err = new Error("未收到 submit_gate_result，恢复 CLI session 后仍未提交");
              }
              if (err != null) {
                failedAction = "human";
              } else {
                this.updateRun(runID, (r) => {
                  if (r.Nodes[node.ID] != null) {
                    const copy = { ...submitted };
                    r.Nodes[node.ID].GateResult = copy;
                  }
                });
                this.observe(runID, node.ID, new TelemetryEvent({ Category: "verification", Name: "gate.submit.received", Phase: "finish", Message: "收到 Agent 节点终态：" + submitted.Decision, Attributes: { decision: submitted.Decision, reason: submitted.Reason } }));
                [err, failedAction, gateRejected] = applyGateResult(submitted, node.RejectTo);
                if (err != null) {
                  let skippedGates = 0;
                  for (const candidate of gates) {
                    if (candidate.gate.Mode.toLowerCase() === "manual" || candidate.gate.Mode.toLowerCase() === "submit") {
                      continue;
                    }
                    if (joinGateCommands(candidate.gate.Commands, effectiveNode.ArtifactOutputs ?? []) === "") {
                      continue;
                    }
                    skippedGates++;
                  }
                  if (skippedGates > 0 || (effectiveNode.ArtifactOutputs ?? []).length > 0) {
                    this.observe(runID, node.ID, new TelemetryEvent({ Category: "verification", Name: "gate.terminal", Phase: "finish", Level: "warn", Message: `decision=${submitted.Decision}; skipped by terminal decision (command gates ${skippedGates}, artifact contracts ${(effectiveNode.ArtifactOutputs ?? []).length})`, Attributes: { decision: submitted.Decision, skippedGates, artifactContracts: (effectiveNode.ArtifactOutputs ?? []).length } }));
                  }
                }
              }
            }
            if (err == null) {
              try {
                await completeRepositoryFallback();
              } catch (e) {
                err = e;
              }
            }
            if (err == null) {
              const [live] = this.repo.RunState(runID);
              let recovered;
              if (reported != null) {
                recovered = reported.takeRecovered();
              } else {
                recovered = recoverMisplacedArtifacts(sb.Workspace(), live.Repository.LocalPath, effectiveNode);
              }
              if (recovered.length > 0) {
                this.observe(runID, node.ID, new TelemetryEvent({ Category: "artifact", Name: "artifact.recovered", Phase: "progress", Message: "从错误写入位置收回交付物：" + recovered.join("；") }));
              }
              let validateErr = null;
              try {
                validateArtifactOutputs(outputs, live, effectiveNode);
              } catch (e) {
                validateErr = e;
              }
              if (validateErr != null) {
                err = new Error(`artifact contract: ${validateErr.message}`);
              } else if ((effectiveNode.ArtifactOutputs ?? []).length > 0) {
                this.observe(runID, node.ID, new TelemetryEvent({ Category: "artifact", Name: "artifact.contract.validated", Phase: "finish", Message: "产物契约校验通过", Attributes: { contracts: effectiveNode.ArtifactOutputs.length, iteration } }));
              }
            }
            if (err == null) {
              for (const candidate of gates) {
                const gate = candidate.gate;
                if (gate.Mode.toLowerCase() === "manual" || gate.Mode.toLowerCase() === "submit") {
                  continue;
                }
                if (gate.Mode.toLowerCase() === VerificationModeMR) {
                  const [live] = this.repo.RunState(runID);
                  let mrErr = null;
                  try {
                    await this.verifyRunMRs(live, gitTok, async (rc) => {
                      const target = new executionTarget({ Scope: ExecutionScopeRepositories, Repository: rc });
                      const out = await gateExec(mrPendingCommand, target, executionTargetSink((event) => {
                        event.Category = "verification";
                        sink(event);
                      }, target));
                      return parseMRPending(out);
                    });
                  } catch (e) {
                    mrErr = e;
                  }
                  if (mrErr != null) {
                    this.observe(runID, node.ID, new TelemetryEvent({ Category: "verification", Name: "gate.mr.failed", Phase: "finish", Level: "error", Message: "门禁未通过：" + gate.Name, Attributes: { gateId: gate.ID, gateName: gate.Name, iteration, detail: mrErr.message } }));
                    err = new Error(`verification ${gate.Name}: ${mrErr.message}`);
                    failedAction = candidate.onFailure;
                    if (mrErr === errMRUnverifiable || mrErr.message.startsWith(errMRUnverifiable.message)) {
                      failedAction = "human";
                    }
                    gateRejected = failedAction === "reject";
                    break;
                  }
                  this.observe(runID, node.ID, new TelemetryEvent({ Category: "verification", Name: "gate.mr.passed", Phase: "finish", Message: "门禁通过：" + gate.Name, Attributes: { gateId: gate.ID, gateName: gate.Name, iteration } }));
                  continue;
                }
                const gateCmd = joinGateCommands(gate.Commands, effectiveNode.ArtifactOutputs ?? []);
                if (gateCmd === "") {
                  continue;
                }
                const gateSink = (event) => {
                  event.Category = "verification";
                  if (event.Attributes == null) {
                    event.Attributes = {};
                  }
                  event.Attributes.gateId = gate.ID;
                  event.Attributes.gateName = gate.Name;
                  event.Attributes.iteration = iteration;
                  event.Attributes.command = gateCmd;
                  switch (event.Name) {
                    case "process.started":
                      event.Message = "门禁开始：" + gate.Name;
                      break;
                    case "process.finished":
                      if (event.Level === "error") {
                        event.Message = "门禁未通过：" + gate.Name;
                      } else {
                        event.Message = "门禁通过：" + gate.Name;
                      }
                      break;
                  }
                  sink(event);
                };
                let verifyOutput = "";
                let verifyErr = null;
                try {
                  verifyOutput = await executeForTargets(current, gate.ExecutionScope, async (target) => {
                    return await gateExec(gateCmd, target, executionTargetSink(gateSink, target));
                  });
                } catch (e) {
                  verifyOutput = e?.partialOutput ?? "";
                  verifyErr = e;
                }
                if (verifyErr != null) {
                  let detail = (verifyOutput ?? "").trim();
                  if (detail.length > 2000) {
                    detail = detail.slice(-2000);
                  }
                  if (detail === "") {
                    detail = "no command output";
                  }
                  err = new Error(`verification ${gate.Name} command ${JSON.stringify(gateCmd)}: ${verifyErr.message} (${detail})`);
                  failedAction = candidate.onFailure;
                  gateRejected = failedAction === "reject";
                }
                if (err != null) {
                  break;
                }
              }
            }
            if (err == null || iteration === maxIterations || ctx.aborted) {
              break;
            }
            if (failedAction !== "loop") {
              this.observe(runID, node.ID, new TelemetryEvent({ Category: "orchestration", Name: "agent.loop", Phase: "finish", Message: "门禁失败策略为 " + failedAction + "，跳过自修正", Attributes: { iteration, onFailure: failedAction, feedback: err.message } }));
              break;
            }
            loopFeedback = err.message;
            this.observe(runID, node.ID, new TelemetryEvent({ Category: "orchestration", Name: "agent.loop", Phase: "progress", Message: `第 ${iteration} 轮未通过，进入自修正`, Attributes: { iteration, maxIterations, feedback: loopFeedback } }));
          }
          await this.attachLoopRetro(runID, node.ID, retroWorkspace, lastIteration, err, failedAction);
          if (err != null) {
            this.freezeAvailableArtifacts(runID, effectiveNode, sb.Workspace(), reported, output);
            if (ctx.aborted || IsSandboxInterrupt(err)) {
              if (!ctx.aborted) {
                this.requeueInterruptedNode(runID, node.ID, executionAttempt, executionGeneration);
              }
              return;
            }
            if (isMaxTurnsErr(err)) {
              this.updateRun(runID, (r) => {
                const nr = r.Nodes[node.ID];
                if (!shouldCommitNodeOutcome(r, nr, executionGeneration, executionAttempt, false)) {
                  return;
                }
                [nr.Output, nr.Error, nr.Status, nr.Activity, nr.FinishedAt] = [output, err.message, "waiting_approval", "对话轮次用尽，等待确认是否重试", new Date()];
                this.event(r, node.ID, "agent.turns.exhausted", "对话轮次已用尽，请确认是否重试本节点");
              });
              return;
            }
            if (failedAction === "human") {
              this.updateRun(runID, (r) => {
                const nr = r.Nodes[node.ID];
                if (!shouldCommitNodeOutcome(r, nr, executionGeneration, executionAttempt, false)) {
                  return;
                }
                [nr.Output, nr.Error, nr.Status, nr.Activity, nr.FinishedAt] = [output, err.message, "waiting_approval", "等待人工确认", new Date()];
                let message = "Agent 请求人工确认";
                if (nr.GateResult != null && nr.GateResult.ActionRequired.trim() !== "") {
                  message += "：" + nr.GateResult.ActionRequired;
                } else if (nr.Error.trim() !== "") {
                  message += "：" + clipHumanGateDetail(nr.Error);
                }
                this.event(r, node.ID, "gate.waiting", message);
              });
              return;
            }
            if (maxIterations > 1 && loopOnExhausted === "human") {
              this.updateRun(runID, (r) => {
                const nr = r.Nodes[node.ID];
                if (!shouldCommitNodeOutcome(r, nr, executionGeneration, executionAttempt, false)) {
                  return;
                }
                [nr.Output, nr.Error, nr.Status, nr.FinishedAt] = [output, err.message, "waiting_approval", new Date()];
                this.event(r, node.ID, "agent.loop.exhausted", "Agent 自修正次数已耗尽，转人工判断：" + err.message);
              });
              return;
            }
            failNode(err, failedAction === "reject" || (failedAction === "" && allowRejectOnFailure(node, err, gateRejected)));
            return;
          }
          let manualGateName = "";
          for (const candidate of gates) {
            const gate = candidate.gate;
            if (gate.Mode === "manual" && gate.Required) {
              if (manualGateName === "") {
                manualGateName = gate.Name;
              }
              continue;
            }
          }
          [current] = this.repo.RunState(runID);
          let artifacts;
          try {
            artifacts = collectArtifactsMode(outputs, current, effectiveNode, output, false);
          } catch (e) {
            failNode(new Error(`artifact contract: ${e.message}`), nodeRejects(node));
            return;
          }
          if (!shouldCommitNodeOutcome(current, current.Nodes[node.ID], executionGeneration, executionAttempt, true)) {
            return;
          }
          this.updateRun(runID, (r) => {
            const nr = r.Nodes[node.ID];
            if (!shouldCommitNodeOutcome(r, nr, executionGeneration, executionAttempt, true)) {
              return;
            }
            r.Artifacts = [...r.Artifacts, ...artifacts];
            nr.Output = output;
            nr.Error = "";
            if (manualGateName !== "") {
              nr.Status = "waiting_approval";
              nr.FinishedAt = new Date();
              this.event(r, node.ID, "gate.waiting", "等待人工验证：" + manualGateName);
            } else {
              nr.Status = "succeeded";
              nr.FinishedAt = new Date();
              this.event(r, node.ID, "node.succeeded", node.Name + " 已完成");
            }
          });
          for (const artifact of artifacts) {
            this.observe(runID, node.ID, new TelemetryEvent({ Category: "artifact", Name: "artifact.published", Phase: "finish", Message: artifact.Name, Attributes: { artifactId: artifact.ID, path: artifact.Path, mediaType: artifact.MediaType, size: artifact.Size, sha256: artifact.SHA256 } }));
          }
          if (manualGateName !== "") {
            return;
          }
          if (IsPreviewBuildNode(node.ID)) {
            await this.archivePreviewAfterBuild(runID);
          }
        } finally {
          sb.activeExecutions -= 1;
        }
      } finally {
        if (endReported != null) {
          endReported();
        }
      }
    } finally {
      unregister();
      cancelNode();
    }
  } finally {
    unlock();
  }
};

/**
 * 在预览构建节点成功后立即归档静态预览站点，使后续人工演示门禁可在运行等待期间直接打开预览。
 * 在 executeNode 完成预览构建节点且无人工拦截门禁时调用。
 *
 * @param {string} runID - 运行 ID。
 * @returns {void} 无返回值。
 */
Engine.prototype.archivePreviewAfterBuild = function (runID) {
  if (this.preview == null) {
    return;
  }
  const [current, ok] = this.repo.RunState(runID);
  if (!ok || !current.WorkflowSnapshot.Preview.Static()) {
    return;
  }
  const nr = current.Nodes[PreviewBuildNodeID];
  if (nr == null || nr.Status !== "succeeded") {
    return;
  }
  this.preview.ArchiveBuiltPreview(current);
};

/**
 * 当工作区未检测到可构建的前端工程时，直接将预览构建节点标记为跳过并成功完成。
 * 在 executeNode 执行预览构建节点前检测到无前端工程时调用。
 *
 * @param {string} runID - 运行 ID。
 * @param {Object} node - 工作流节点定义（domain.WorkflowNode）。
 * @param {number} executionGeneration - 当前执行的租约代次。
 * @param {number} executionAttempt - 当前执行的尝试次数。
 * @param {Object} current - 当前运行对象（domain.Run）。
 * @param {string} evidence - 前端工程检测给出的补充依据说明。
 * @returns {void} 无返回值。
 */
Engine.prototype.completeSkippedPreviewBuild = function (runID, node, executionGeneration, executionAttempt, current, evidence) {
  let reason = "工作区没有前端工程，已跳过预览";
  if (evidence.trim() !== "") {
    reason = reason + "（" + evidence.trim() + "）";
  }
  if (this.preview != null) {
    this.preview.Skip(current, reason);
  }
  let output = "# 前端预览\n\n已跳过：工作区没有可构建的前端工程。业务交付不受影响。\n";
  if (evidence.trim() !== "") {
    output += "\n" + evidence.trim() + "\n";
  }
  this.observe(runID, node.ID, new TelemetryEvent({
    Category: "preview", Name: "preview.skipped", Phase: "finish", Message: reason,
  }));
  this.updateRun(runID, (r) => {
    const nr = r.Nodes[node.ID];
    if (!shouldCommitNodeOutcome(r, nr, executionGeneration, executionAttempt, true)) {
      return;
    }
    nr.Output = output;
    nr.Error = "";
    nr.Status = "succeeded";
    nr.FinishedAt = new Date();
    this.event(r, node.ID, "node.succeeded", node.Name + " 已跳过（非前端仓库）");
  });
};

/**
 * 返回脚本语言对应的展示名称（"Python" 或 "Shell"）。
 * 在脚本完成遥测与空输出摘要中调用。
 *
 * @param {string} language - 脚本语言标识（如 "python"、"shell"）。
 * @returns {string} 可读的语言名称。
 */
function scriptLanguageLabel(language) {
  if (language === "python") {
    return "Python";
  }
  return "Shell";
}

/**
 * 当检测到执行机器上已丢失历史 CLI 会话时，清空节点的 SessionID 与 ResumeSessionID 以便从头重跑。
 * 在 runOnce 执行返回后调用，避免因“No conversation found”导致缺失 submit_gate_result 并卡死在人工门禁。
 *
 * @param {string} runID - 运行 ID。
 * @param {string} nodeID - 节点 ID。
 * @param {string} output - 执行器标准输出文本。
 * @param {Error|null} err - 执行器返回的错误对象。
 * @returns {boolean} 确实清空了已有会话 ID 时返回 true，否则返回 false。
 */
Engine.prototype.dropLostCLISession = function (runID, nodeID, output, err) {
  if (!lostCLISession(output, err)) {
    return false;
  }
  let dropped = false;
  this.updateRun(runID, (r) => {
    const nr = r.Nodes[nodeID];
    if (nr == null || (nr.SessionID.trim() === "" && nr.ResumeSessionID.trim() === "")) {
      return;
    }
    nr.SessionID = "";
    nr.ResumeSessionID = "";
    dropped = true;
    this.event(r, nodeID, "agent.session.dropped", "原来的 CLI 会话已不在这台执行机器上，本节点将重新开始");
  });
  if (dropped) {
    this.observe(runID, nodeID, new TelemetryEvent({
      Category: "lifecycle", Name: "agent.session.dropped", Phase: "progress", Level: "warn",
      Message: "CLI 会话不存在，已放弃续跑并重新开始本节点",
    }));
  }
  return dropped;
};

/**
 * 判断执行器输出或错误文本是否命中“CLI 会话不存在”类特征短语。
 * 在 dropLostCLISession 中调用。
 *
 * @param {string} output - 执行器输出文本。
 * @param {Error|null} err - 执行器错误对象。
 * @returns {boolean} 命中任一会话丢失特征短语时返回 true，否则返回 false。
 */
function lostCLISession(output, err) {
  let msg = output.toLowerCase();
  if (err != null) {
    msg += "\n" + err.message.toLowerCase();
  }
  return msg.includes("no conversation found") ||
    msg.includes("session not found") ||
    msg.includes("no such session") ||
    msg.includes("conversation does not exist");
}

/**
 * 将人工门禁错误详情压缩空白并截断至最多 300 字符，避免事件摘要过长。
 * 在 failedAction === "human" 拼装 gate.waiting 事件文案时调用。
 *
 * @param {string} detail - 原始错误详情文本。
 * @returns {string} 压缩并按需截断后的摘要文本。
 */
function clipHumanGateDetail(detail) {
  detail = detail.trim().split(/\s+/).join(" ");
  const limit = 300;
  if (detail.length <= limit) {
    return detail;
  }
  return detail.slice(0, limit) + "…";
}

/**
 * 将验证门禁配置的多条命令逐条绑定产物契约规则并合并为单个 shell 脚本（多条命令时前缀 `set -e`）。
 * 避免按行拆分为独立进程破坏多行 shell 控制流（if/for/heredoc 等），同时保持首错即停的快速失败行为。
 *
 * @param {string[]} commands - 门禁配置的原始命令列表。
 * @param {Object[]} artifacts - 节点有效产物契约列表（domain.ArtifactContract[]）。
 * @returns {string} 合并后的单段 shell 脚本，无有效命令时返回空字符串。
 */
function joinGateCommands(commands, artifacts) {
  const bound = [];
  // Go 对 nil 切片 range 为空操作，JS 用 ?? [] 补空数组。
  for (const cmd of commands ?? []) {
    const trimmed = cmd.trim();
    if (trimmed === "") {
      continue;
    }
    bound.push(bindVerificationCommand(trimmed, artifacts));
  }
  if (bound.length === 0) {
    return "";
  }
  if (bound.length === 1) {
    return bound[0];
  }
  return "set -e\n" + bound.join("\n");
}

/**
 * 异步等待指定毫秒数，对应 Go 的 time.Sleep / time.After。
 * 在主调度循环轮询等待时调用。
 *
 * @param {number} ms - 等待时长（毫秒）。
 * @returns {Promise<void>} 计时结束后 resolve，无返回值。
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 返回一个在 AbortSignal 触发取消时 resolve 的 Promise，对应 Go 的 `<-ctx.Done()`。
 * 在主调度循环与唤醒信号、超时共同竞争（Promise.race）时调用。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @returns {Promise<void>} ctx 取消时 resolve；非 AbortSignal 时永不 settle。
 */
function aborted(ctx) {
  if (!(ctx instanceof AbortSignal)) {
    return new Promise(() => {});
  }
  if (ctx.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => ctx.addEventListener("abort", resolve, { once: true }));
}

/**
 * 等待指定毫秒数，若期间 AbortSignal 取消则立即 reject，对应 Go 的 `time.NewTicker` + `select <-ctx.Done()`。
 * 在租约续期心跳协程中调用。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {number} ms - 等待时长（毫秒）。
 * @returns {Promise<void>} 满时长 resolve，取消时 reject。
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

module.exports = { resolveNodeExecutor, workflowSandboxRequirements, dockerImageBuildLabel, dockerImageNeedsBuild, formatElapsedCN, dockerfileID, scriptLanguageLabel, lostCLISession, clipHumanGateDetail, joinGateCommands };
