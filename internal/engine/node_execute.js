// node_execute.js —— 对应 Go 文件：internal/engine/node_execute.go
// 作用：节点执行：运行主循环、节点分发、脚本与 Agent 执行、门禁循环。
// context.Context 译为 AbortSignal；goroutine 译为不 await 的异步函数；sync.WaitGroup 译为 Promise 集合；(值, error) 译为返回值、失败 throw，(值, bool) 译为 [值, bool]；time.Duration 译为毫秒数。

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
const { ExecutorDefinition } = require("../domain/agent.js"); // 对应 Go 的 domain.ExecutorDefinition，agent.js 已翻译
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
      let renewErr = null;
      try {
        renewErr = await this.renewRunLease(runID, generation);
      } catch (e) {
        renewErr = e;
      }
      if (renewErr != null) {
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
  // sync.Mutex 在单线程 JS 里不需要；sync.WaitGroup 译为 Promise 集合；wake 是带 1 个缓冲的信号。
  const inflight = new Set();
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
        if (!inflight.has(node.ID)) {
          ready.push(node);
        }
      }
      const running = inflight.size;
      if (ready.length === 0 && running > 0) {
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
        inflight.add(node.ID);
        const p = (async () => {
          try {
            await this.executeNode(ctx, runID, wf, node);
          } finally {
            inflight.delete(node.ID);
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
    this.repo.ReleaseRunLease(runID, this.instanceID, generation);
    this.mu.Lock();
    try {
      delete this.running[runID];
    } finally {
      this.mu.Unlock();
    }
  }
};

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
    [ex, found] = st.Executor(executorID);
  }
  if (!found) {
    const [legacy, ok] = st.Executor(executorID);
    if (ok) {
      [ex, found] = BuiltInExecutorForKind(legacy.Kind);
      if (found && agent.Model.trim() === "" && legacy.Model.trim() !== "") {
        ex.Model = legacy.Model;
      }
    }
  }
  if (!found) {
    return [new ExecutorDefinition({}), new Error(`executor ${JSON.stringify(executorID)} not found (agent ${agent.ID})`)];
  }
  if (agent.Model.trim() !== "") {
    ex.Model = agent.Model;
  }
  if (agent.Effort.trim() !== "") {
    ex.Effort = agent.Effort;
  }
  return [ex, null];
}

function workflowSandboxRequirements(st, wf) {
  const requirements = [];
  for (const node of wf.Nodes) {
    if (node.Type === "script" || node.Type === "command" || node.Type === "approval" || node.Type === "sop") {
      continue;
    }
    const [agent, ok] = workflowAgent(st, wf, node.AgentID);
    if (!ok) {
      return [null, new Error(`agent ${JSON.stringify(node.AgentID)} not found`)];
    }
    const [executor, executorErr] = workflowNodeExecutor(st, wf, node, agent);
    if (executorErr === errSOPExecutorUnconfigured) {
      continue;
    }
    if (executorErr != null) {
      return [null, executorErr];
    }
    requirements.push(ProviderRequirements(executor.Kind));
  }
  return [MergeSandboxRequirements(...requirements), null];
}

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

function dockerImageNeedsBuild(ctx, snap) {
  if (snap == null || snap.Dockerfile == null || snap.Dockerfile.Content.trim() === "") {
    return true;
  }
  return !DockerImageCached(ctx, snap.Dockerfile);
}

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

function dockerfileID(snap) {
  if (snap == null || snap.Dockerfile == null) {
    return "";
  }
  return snap.Dockerfile.ID;
}

Engine.prototype.executeNode = async function (ctx, runID, wf, node) {
  // Go 按值传参，JS 用展开复制结构体，避免写回调用方的 wf。
  wf = { ...wf };
  const [currentLease, ok] = this.repo.RunState(runID);
  if (!ok || !this.ownsRun(currentLease)) {
    return;
  }
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
        const [version, versionErr] = this.repo.SharedScheduleVersion(currentLease.ExecutionContext.SharedScheduleID, currentLease.ExecutionContext.SharedScheduleVersion);
        let scheduleErr = versionErr;
        if (scheduleErr == null) {
          scheduleErr = this.repo.ValidateSharedScheduleAssets(version);
        }
        if (scheduleErr != null) {
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
      const [requirementsValue, requirementsErr] = workflowSandboxRequirements(this.repo, wf);
      if (requirementsErr != null) {
        failNode(requirementsErr, nodeRejects(node));
        return;
      }
      requirements = requirementsValue;
      let acquireProfile = profile;
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
      sb.nodeMu.Lock();
      let preparing = true;
      try {
        const sink = (event) => { this.observe(runID, node.ID, event); };
        let gateExec = async (command, target, gateSink) => {
          const [spec, specErr] = CommandSpecWithCredentialEnv({ Argv: ["sh", "-lc", bindExecutionTarget(command, target)], Provider: "verification", CredentialBindings: [BindGit, BindMCP] }, node.CredentialEnv, sb.credentialSnapshot());
          if (specErr != null) {
            return ["", specErr];
          }
          try {
            const out = await sb.Exec(ctx, spec, gateSink);
            return [out, null];
          } catch (e) {
            return ["", e];
          }
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
            const [, restoreErr] = RestoreMissingWorkspaceArtifacts(sb.Workspace(), this.legacyArchivedWorkspaceFiles(current, node.ID));
            if (restoreErr != null) {
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
          if (repositoryFallback === "") {
            preparing = false;
            sb.nodeMu.Unlock();
          }
          const completeRepositoryFallback = async () => {
            if (repositoryFallback === "") {
              return;
            }
            if (this.defaultExecutionRunner(current) === "") {
              const verifyErr = await VerifyGitPreparation(ctx, sb.Workspace(), current.RepositoryContexts());
              if (verifyErr != null) {
                throw new Error(`Agent 仓库准备兜底校验失败: ${verifyErr.message}`);
              }
            }
            await this.PrepareNodeWorkspace(ctx, current, sb);
            sb.repositoriesPrepared = true;
            repositoryFallback = "";
            preparing = false;
            sb.nodeMu.Unlock();
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
                    [rawOutput, runErr] = await executeForTargets(current, node.ExecutionScope, async (target) => {
                      const bound = bindExecutionTarget(command, target);
                      const targetSink = executionTargetSink(sink, target);
                      const scriptAssets = this.resolveScriptMCPAssets(current.ExecutionContext.ProjectID, current.ExecutionContext.ResponsibleUserID);
                      const execMachine = this.defaultExecutionRunner(current);
                      if (execMachine !== "") {
                        const workspace = runnerWorkspaceRel(current, node.ID);
                        try {
                          const out = await this.dispatchRunnerScript(ctx, execMachine, current, node.ID, workspace, "shell", bound, target.directory(), effectiveNode.ArtifactOutputs ?? [], sb, (sb.credentialSnapshot().GitHTTPCredentials["github.com"] ?? {}).Token ?? "", sb.credentialSnapshot().GitUserName, sb.credentialSnapshot().GitUserEmail, scriptAssets, targetSink);
                          return [out, null];
                        } catch (e) {
                          return ["", e];
                        }
                      }
                      const provisionErr = await ProvisionMCPAssets(ctx, sb, sb.Workspace(), scriptAssets, targetSink);
                      if (provisionErr != null) {
                        return ["", provisionErr];
                      }
                      const [scriptSpec, scriptSpecErr] = CommandSpecWithCredentialEnv({ Argv: ["sh", "-lc", bound], Provider: "script", CredentialBindings: [BindGit, BindMCP] }, effectiveNode.CredentialEnv, sb.credentialSnapshot());
                      if (scriptSpecErr != null) {
                        return ["", scriptSpecErr];
                      }
                      try {
                        const out = await sb.Exec(ctx, scriptSpec, targetSink);
                        return [out, null];
                      } catch (e) {
                        return ["", e];
                      }
                    });
                  } catch (e) {
                    runErr = e;
                  }
                  const execMachine = this.defaultExecutionRunner(current);
                  if (execMachine !== "") {
                    const workspace = runnerWorkspaceRel(current, node.ID);
                    gateExec = async (command, target, gateSink) => {
                      try {
                        const out = await this.dispatchRunnerCommand(ctx, execMachine, runID, node.ID, workspace, bindExecutionTarget(command, target), gateSink);
                        return [out, null];
                      } catch (e) {
                        return ["", e];
                      }
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
                  return [rawOutput, runErr];
                };
                break;
              }
              default: {
                requiresSubmit = true;
                const [agent, found] = workflowAgent(this.repo, wf, node.AgentID);
                if (!found) {
                  err = new Error(`agent ${JSON.stringify(node.AgentID)} not found`);
                  break;
                }
                const [resolvedEx, errResolve] = workflowNodeExecutor(this.repo, wf, node, agent);
                if (errResolve != null) {
                  err = errResolve;
                  break;
                }
                ex = resolvedEx;
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
                      const [version, versionErr] = this.repo.SharedScheduleVersion(runCurrent.ExecutionContext.SharedScheduleID, runCurrent.ExecutionContext.SharedScheduleVersion);
                      if (versionErr != null) {
                        return ["", versionErr];
                      }
                      const assetErr = this.repo.ValidateSharedScheduleAssets(version);
                      if (assetErr != null) {
                        return ["", assetErr];
                      }
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
                      let result;
                      let dispatchErr = null;
                      try {
                        result = await this.dispatchRunnerTask(ctx, execMachine, runCurrent, effectiveNode, sb, workspace, invocationEx, agent, assets, prompt, invocationID, options, sink);
                      } catch (e) {
                        dispatchErr = e;
                      }
                      if (dispatchErr == null) {
                        gateExec = async (command, target, gateSink) => {
                          try {
                            const out = await this.dispatchRunnerCommand(ctx, execMachine, runID, node.ID, workspace, bindExecutionTarget(command, target), gateSink);
                            return [out, null];
                          } catch (e) {
                            return ["", e];
                          }
                        };
                      }
                      return [result ?? "", dispatchErr];
                    }
                    const repositories = runCurrent.RepositoryContexts();
                    const [boundAssets, skipped, bindErr] = await PrepareMCPServers(assets, {
                      GitHTTPCredentials: gitCredentials.GitHTTPCredentials,
                      ExtraCredentials: gitCredentials.Extra,
                      RequireCredentials: true,
                      SSHRepositoriesOnly: repositories.length > 0 && sshRepositoryURLs(repositories).length === repositories.length,
                    });
                    for (const warning of skipped) {
                      warnMCPSkipped(warning);
                    }
                    if (bindErr != null) {
                      return ["", bindErr];
                    }
                    try {
                      const result = await this.runner.Run(ctx, sb, invocationID, invocationEx, agent, boundAssets, prompt, options, sink);
                      return [result, null];
                    } catch (e) {
                      return ["", e];
                    }
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
                  const clearErr = clearGateResult(sb.Workspace(), submitPath);
                  if (clearErr != null) {
                    err = new Error(`clear submit_gate_result: ${clearErr.message}`);
                    failedAction = "human";
                    break;
                  }
                }
              }
              [output, err] = await runOnce(loopFeedback);
              if (this.dropLostCLISession(runID, node.ID, output, err)) {
                [output, err] = await runOnce("");
              }
              if (err != null && err.message.includes("without a terminal result")) {
                this.observe(runID, node.ID, new TelemetryEvent({ Category: "orchestration", Name: "agent.loop", Phase: "finish", Message: "执行器未返回 result，按工作区产物继续门禁，不再重跑 Agent", Attributes: { iteration } }));
                err = null;
              }
              let submitted = null;
              if (err == null && requiresSubmit) {
                [submitted, err] = readGateResultFrom(outputs, submitPath);
                if (err != null || submitted == null) {
                  let firstProblem = "未调用 submit_gate_result";
                  if (err != null) {
                    firstProblem = err.message;
                    if (reported == null) {
                      clearGateResult(sb.Workspace(), submitPath);
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
                    [output, err] = await runOnce(gateMissingRetryMarker);
                    if (this.dropLostCLISession(runID, node.ID, output, err)) {
                      [output, err] = await runOnce("");
                    }
                    if (err == null) {
                      [submitted, err] = readGateResultFrom(outputs, submitPath);
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
                    const mrErr = await this.verifyRunMRs(live, gitTok, async (rc) => {
                      const target = new executionTarget({ Scope: ExecutionScopeRepositories, Repository: rc });
                      const [out, execErr] = await gateExec(mrPendingCommand, target, executionTargetSink((event) => {
                        event.Category = "verification";
                        sink(event);
                      }, target));
                      if (execErr != null) {
                        return [new pushedWork(), execErr];
                      }
                      return parseMRPending(out);
                    });
                    if (mrErr != null) {
                      this.observe(runID, node.ID, new TelemetryEvent({ Category: "verification", Name: "gate.mr.failed", Phase: "finish", Level: "error", Message: "门禁未通过：" + gate.Name, Attributes: { gateId: gate.ID, gateName: gate.Name, iteration, detail: mrErr.message } }));
                      err = new Error(`verification ${gate.Name}: ${mrErr.message}`);
                      failedAction = candidate.onFailure;
                      if (mrErr === errMRUnverifiable) {
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
                    [verifyOutput, verifyErr] = await executeForTargets(current, gate.ExecutionScope, async (target) => {
                      const [out, execErr] = await gateExec(gateCmd, target, executionTargetSink(gateSink, target));
                      return [out, execErr];
                    });
                  } catch (e) {
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
        if (preparing) {
          sb.nodeMu.Unlock();
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

function scriptLanguageLabel(language) {
  if (language === "python") {
    return "Python";
  }
  return "Shell";
}

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

function clipHumanGateDetail(detail) {
  detail = detail.trim().split(/\s+/).join(" ");
  const limit = 300;
  if (detail.length <= limit) {
    return detail;
  }
  return detail.slice(0, limit) + "…";
}

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

// sleep：等满毫秒，对应 Go 的 time.Sleep / time.After。
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// aborted：ctx 取消时 resolve，对应 Go 的 <-ctx.Done()。
function aborted(ctx) {
  if (!(ctx instanceof AbortSignal)) {
    return new Promise(() => {});
  }
  if (ctx.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => ctx.addEventListener("abort", resolve, { once: true }));
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

module.exports = { resolveNodeExecutor, workflowSandboxRequirements, dockerImageBuildLabel, dockerImageNeedsBuild, formatElapsedCN, dockerfileID, scriptLanguageLabel, lostCLISession, clipHumanGateDetail, joinGateCommands };
