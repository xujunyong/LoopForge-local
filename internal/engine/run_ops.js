// run_ops.js —— 对应 Go 文件：internal/engine/run_ops.go
// 作用：运行人工操作：取消、暂停、批准、通过、打回、重试与继续。
// Go 返回 error 的 Engine 方法译为 throw；repo 方法按既有约定返回 err 或 [值, err]；context.Background() 译为 null；time.Time 零值译为 null；Go 的 map[string]bool 译为普通对象。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { NodeRun } = require("../domain/run.js"); // 对应 Go 的 domain.NodeRun，run.js 已翻译
const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { RunnerTaskQueued, RunnerTaskLeased, RunnerTaskRunning } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerTaskQueued/RunnerTaskLeased/RunnerTaskRunning，runner.js 已翻译
const { AttachPreviewBuild } = require("../domain/preview_build.js"); // 对应 Go 的 domain.AttachPreviewBuild，preview_build.js 已翻译

Engine.prototype.persistControlDecision = function (runID, r, ...expected) {
  if (r.Status === "running") {
    r.CancelRequested = false;
    r.PauseRequested = false;
  }
  // pause_requested 不参与运行快照写入。只要本次决策本身释放了暂停就清除它，包括群组因无在途任务而继续等待的情况。
  if (expected.length === 0 && !r.PauseRequested && !r.CancelRequested) {
    const err = this.repo.ClearRunControl(runID);
    if (err != null) {
      throw err;
    }
  }
  let err;
  if (expected.length > 0) {
    err = this.repo.PutRunAtRevision(r, r.Revision);
  } else {
    err = this.repo.PutRun(r);
  }
  if (err != null) {
    throw err;
  }
  this.publish(runID);
  if (this.executes()) {
    this.resume(runID);
    return null;
  }
  if (r.OwnerInstanceID !== "") {
    this.repo.ReleaseRunLease(runID, r.OwnerInstanceID, r.Generation);
  }
  return null;
};

Engine.prototype.Cancel = function (runID) {
  const cancelled = this.repo.CancelQueuedRun(runID);
  if (cancelled) {
    this.publish(runID);
    return null;
  }
  let [r, ok] = this.repo.RunState(runID);
  if (!ok) {
    throw new Error("run not found");
  }
  if (!isLiveStatus(r.Status)) {
    if (TerminalRunStatus(r.Status) && r.HasActiveNode()) {
      this.forceTerminate(runID, "cancelled", "流水线已取消");
      return null;
    }
    throw new Error("run is not active");
  }
  const [reqRun, reqErr] = this.repo.RequestRunCancel(runID);
  if (reqErr != null) {
    throw reqErr;
  }
  r = reqRun;
  const [full] = this.repo.RunState(runID);
  for (const childID of childRunIDs(full)) {
    const [child, childOk] = this.repo.RunState(childID);
    if (childOk && isLiveStatus(child.Status)) {
      try {
        this.Cancel(childID);
      } catch {}
    }
  }
  try {
    this.cancelRunnerTasksForRun(runID);
  } catch (err) {
    throw new Error(`cancel runner tasks: ${err.message}`);
  }
  this.publish(runID);
  // 等待中的 Run 没有活动进程来确认请求。同步终结它，让审批/暂停记录总能从纯控制面 API 进程取消。
  if (r.Status === "waiting") {
    this.forceTerminate(runID, "cancelled", "流水线已取消");
    return null;
  }
  if (this.Interrupt(runID)) {
    return null;
  }
  this.notifyRunControl(runID);
  // 本进程没有调度协程。存活的外来租约说明归属 worker 已收到通知（续租时也会看到该标志）。
  if (r.OwnerInstanceID !== "" && r.LeaseUntil != null && r.LeaseUntil.getTime() > Date.now() && !this.ownsRun(r)) {
    return null;
  }
  try {
    r = this.acquireLease(r);
  } catch {
    return null;
  }
  this.settleOrphan(runID, "运行已被手动终止（调度协程不存在，可能由服务重启导致）");
  this.repo.ReleaseRunLease(runID, this.instanceID, r.Generation);
  return null;
};

// Pause 中断活动节点，但不终结 Run、不销毁工作区。Worker 在人工决策点停下，操作员可补充上下文并继续被中断的节点。
Engine.prototype.Pause = function (runID) {
  const [r0, err] = this.repo.RequestRunPause(runID);
  if (err != null) {
    throw err;
  }
  let r = r0;
  const [full] = this.repo.RunState(runID);
  for (const childID of childRunIDs(full)) {
    const [child, ok] = this.repo.RunState(childID);
    if (ok && child.Status === "running") {
      try {
        this.Pause(childID);
      } catch {}
    }
  }
  try {
    this.cancelRunnerTasksForRun(runID);
  } catch (err2) {
    throw new Error(`pause runner tasks: ${err2.message}`);
  }
  this.publish(runID);
  if (this.Interrupt(runID)) {
    return null;
  }
  this.notifyRunControl(runID);
  if (r.OwnerInstanceID !== "" && r.LeaseUntil != null && r.LeaseUntil.getTime() > Date.now() && !this.ownsRun(r)) {
    return null;
  }
  try {
    r = this.acquireLease(r);
  } catch {
    return null;
  }
  this.pauseAt(runID, r.Generation, "运行已由用户暂停");
  this.repo.ReleaseRunLease(runID, this.instanceID, r.Generation);
  return null;
};

Engine.prototype.Approve = function (runID, nodeID, humanContext, ...expected) {
  let [r, ok] = this.repo.RunState(runID);
  if (!ok) {
    throw new Error("run not found");
  }
  if (this.executes() && this.workspaceBlocked(r)) {
    throw new Error(`run ${runID} 的工作区绑定在 ${r.WorkspaceHost}:${r.WorkspaceRoot}，请在绑定实例上审批（或清理该 run 的 workspace 绑定后重试）`);
  }
  if (this.executes()) {
    r = this.acquireLease(r);
  }
  checkNodeExpectation(r, expected);
  forbidClosedGongfengIssue(this.repo, r);
  const n = r.Nodes[nodeID];
  if (n == null || n.Status !== "waiting_approval") {
    throw new Error("node is not waiting for approval");
  }
  n.Status = "succeeded";
  n.FinishedAt = new Date();
  const note = recordHumanContext(r, nodeID, "人工批准继续", humanContext);
  let decision = "# Approval\n\nApproved by a human gate.\n";
  if (note !== "") {
    decision += "\n" + note + "\n";
  }
  appendArtifact(r, nodeID, n.Attempt, "decision", "decision.md", "text/markdown", Buffer.from(decision, "utf8"));
  this.event(r, nodeID, "gate.approved", "人工门禁已通过");
  appendControlTelemetry(r, nodeID, "gate.approved", "人工门禁已通过");
  r.Status = "running";
  return this.persistControlDecision(runID, r, ...expected);
};

// Pass 把失败（或已暂停）的节点标记为成功，让下游无需重新执行即可继续。onFailure=fail 后、打回返工耗尽后，或硬脚本在执行中途被暂停、从头重试也无济于事时（例如环境问题），操作员会用它——硬脚本否则可能永远卡住运行。
Engine.prototype.Pass = async function (runID, nodeID, humanContext, ...expected) {
  this.pass(runID, nodeID, humanContext, ...expected);
  await this.resumeParentAfterChildRecovery(runID);
  return null;
};

Engine.prototype.pass = function (runID, nodeID, humanContext, ...expected) {
  let [r, ok] = this.repo.RunState(runID);
  if (!ok) {
    throw new Error("run not found");
  }
  if (this.executes() && this.workspaceBlocked(r)) {
    throw new Error(`run ${runID} 的工作区绑定在 ${r.WorkspaceHost}:${r.WorkspaceRoot}，请在绑定实例上通过该节点（或清理该 run 的 workspace 绑定后重试）`);
  }
  if (this.executes()) {
    r = this.acquireLease(r);
  }
  checkNodeExpectation(r, expected);
  forbidClosedGongfengIssue(this.repo, r);
  if (nodeID === "") {
    nodeID = resumeNodeID(r);
  }
  const n = r.Nodes[nodeID];
  if (n == null) {
    throw new Error("pass node not found");
  }
  // 人在执行中途暂停运行，导致硬脚本停在 waiting_approval（见 nodeCancelled/pauseAt），也可手动通过：恢复只会从头重跑脚本，卡住的问题重试也修不好。
  const pausedScript = r.Status === "waiting" && r.PauseRequested && n.Status === "waiting_approval";
  if (!pausedScript) {
    if (isLiveStatus(r.Status)) {
      throw new Error("run is still active");
    }
    if (r.Status !== "failed" || n.Status !== "failed") {
      throw new Error("only a failed node on a failed run can be passed");
    }
  }
  const wf = workflowForRun(this.repo, r);
  let def = null;
  let found = false;
  for (const node of wf.Nodes) {
    if (node.ID === nodeID) {
      def = node;
      found = true;
      break;
    }
  }
  if (!found || !isScriptNode(def)) {
    throw new Error("only a failed script node can be passed");
  }
  n.Status = "succeeded";
  n.FinishedAt = new Date();
  n.Activity = "人工通过，未重新执行";
  const note = recordHumanContext(r, nodeID, "人工通过该节点，继续下游", humanContext);
  let decisionReason = "after the node failed";
  if (pausedScript) {
    decisionReason = "while the run was paused mid-execution";
  }
  let decision = `# Pass\n\nManually passed by a human ${decisionReason}.\n`;
  if (note !== "") {
    decision += "\n" + note + "\n";
  }
  appendArtifact(r, nodeID, n.Attempt, "decision", "decision.md", "text/markdown", Buffer.from(decision, "utf8"));
  this.event(r, nodeID, "node.passed", "人工通过该节点，继续下游");
  appendControlTelemetry(r, nodeID, "node.passed", "人工通过该节点，继续下游");
  r.CancelRequested = false;
  r.PauseRequested = false;
  r.Status = "running";
  markRunRelationsRunning(this.repo, r);
  return this.persistControlDecision(runID, r, ...expected);
};

Engine.prototype.Reject = function (runID, req, ...expected) {
  let [r, ok] = this.repo.RunState(runID);
  if (!ok) {
    throw new Error("run not found");
  }
  if (this.executes() && this.workspaceBlocked(r)) {
    throw new Error(`run ${runID} 的工作区绑定在 ${r.WorkspaceHost}:${r.WorkspaceRoot}，请在绑定实例上打回（或清理该 run 的 workspace 绑定后重试）`);
  }
  if (this.executes()) {
    r = this.acquireLease(r);
  }
  checkNodeExpectation(r, expected);
  forbidClosedGongfengIssue(this.repo, r);
  const wf = workflowForRun(this.repo, r);
  let target = req.TargetID;
  if (target === "") {
    for (const n of wf.Nodes) {
      if (n.ID === req.NodeID) {
        target = n.RejectTo;
      }
    }
  }
  if (target === "") {
    throw new Error("reject target is required");
  }
  if (r.Nodes[target] == null) {
    throw new Error("reject target not found");
  }
  for (const n of wf.Nodes) {
    if (n.ID === req.NodeID && n.MaxReworks > 0 && r.Nodes[target].ReworkCount >= n.MaxReworks) {
      throw new Error("rework limit reached");
    }
  }
  const reset = descendants(wf, target);
  reset[target] = true;
  overlayLatestNodeBindings(this.repo, r, reset);
  const stale = [];
  const interrupted = {};
  for (const id of Object.keys(reset)) {
    const nr = r.Nodes[id];
    if (nr != null) {
      stale.push(nr.ChildRunID);
      if (nr.Status === "running" || nr.Status === "pending_input") {
        // 重置范围内仍在跑的并行兄弟：它的尝试被废弃，重跑必须算一次新的尝试，而不是接续被中断的那次。
        interrupted[id] = true;
        nr.Activity = "";
      }
      nr.Status = "pending";
      nr.Error = "";
      nr.Output = "";
      nr.ChildRunID = "";
      nr.FinishedAt = null;
      if (id === target) {
        nr.ReworkCount++;
        nr.Feedback = recordHumanContext(r, req.NodeID, req.Reason, req.Context);
      } else {
        nr.Feedback = "";
      }
    }
  }
  this.event(r, req.NodeID, "gate.rejected", `打回到 ${target}：${req.Reason}`);
  appendControlTelemetry(r, req.NodeID, "gate.rejected", `打回到 ${target}：${req.Reason}`);
  r.Status = "running";
  this.cancelLiveChildRuns(stale);
  this.persistControlDecision(runID, r, ...expected);
  this.cancelNodeExecutions(runID, interrupted);
  return null;
};

// Retry 从选定节点重开已停止的工作流，同时保留原运行、已成功的上游节点及其冻结产物。已成功的运行可能已清理工作区；这类运行会被复活，让操作员调整上下文后从某个节点重放。手动重试在节点已耗尽配置的自动尝试时恰好多给一次尝试。nodeID 为空时从中断的节点继续。
Engine.prototype.Retry = async function (runID, nodeID, reason, humanContext, ...expected) {
  return this.RetryContext(null, runID, nodeID, reason, humanContext, ...expected);
};

// RetryContext 在恢复被回收的运行时复用调用方的工作区租约。
Engine.prototype.RetryContext = async function (ctx, runID, nodeID, reason, humanContext, ...expected) {
  await this.retryContext(ctx, runID, nodeID, reason, humanContext, "", ...expected);
  await this.resumeParentAfterChildRecoveryContext(ctx, runID);
  return null;
};

// cancelLiveChildRuns 停止父节点已被重置、不再引用它们的子 SOP 运行，让它们既不再继续工作，也不再占用工作区。调用方持有 stateMu，Cancel 经 updateRun 结算时也要拿它，因此取消在调用方释放锁后执行。
Engine.prototype.cancelLiveChildRuns = function (ids) {
  const live = [];
  for (const id of ids) {
    if (id !== "") {
      live.push(id);
    }
  }
  if (live.length === 0) {
    return;
  }
  queueMicrotask(() => {
    for (const id of live) {
      const [child, ok] = this.repo.RunState(id);
      if (ok && isLiveStatus(child.Status)) {
        try {
          this.Cancel(id);
        } catch {}
      }
    }
  });
};

// resumeParentAfterChildRecovery 让因该子 SOP 运行失败的父流程在子流程被重试或通过后继续：父流程重放它的 SOP 节点，跟随恢复后的子流程，而不是新起一个。
Engine.prototype.resumeParentAfterChildRecovery = async function (childID) {
  await this.resumeParentAfterChildRecoveryContext(null, childID);
};

Engine.prototype.resumeParentAfterChildRecoveryContext = async function (ctx, childID) {
  const [child, ok] = this.repo.RunState(childID);
  if (!ok) {
    return;
  }
  const parentID = child.ExecutionContext.ParentRunID.trim();
  const nodeID = child.ExecutionContext.ParentNodeID.trim();
  if (parentID === "" || nodeID === "") {
    return;
  }
  const [parent, parentOk] = this.repo.RunState(parentID);
  if (!parentOk || parent.Status !== "failed") {
    return;
  }
  const nr = parent.Nodes[nodeID];
  if (nr == null || nr.ChildRunID !== childID || nr.Status !== "failed") {
    return;
  }
  let pointsAtChild = false;
  for (const node of parent.WorkflowSnapshot.Nodes) {
    if (node.ID === nodeID) {
      pointsAtChild = node.SOPWorkflowID.trim() === child.WorkflowID;
    }
  }
  if (!pointsAtChild) {
    return;
  }
  try {
    await this.retryContext(ctx, parentID, nodeID, "子 SOP " + childID + " 已恢复，父流程重新接上", "", childID);
  } catch (err) {
    console.log(`resume parent ${parentID} after child ${childID} recovery: ${err.message}`);
    return;
  }
  await this.resumeParentAfterChildRecoveryContext(ctx, parentID);
};

Engine.prototype.retryContext = async function (ctx, runID, nodeID, reason, humanContext, keepChildRunID, ...expected) {
  let [r, ok] = this.repo.RunState(runID);
  if (!ok) {
    throw new Error("run not found");
  }
  if (this.executes() && this.workspaceBlocked(r)) {
    throw new Error(`run ${runID} 的工作区绑定在 ${r.WorkspaceHost}:${r.WorkspaceRoot}，请在绑定实例上重试（或清理该 run 的 workspace 绑定后重试）`);
  }
  if (this.executes()) {
    r = this.acquireLease(r);
  }
  checkNodeExpectation(r, expected);
  forbidClosedGongfengIssue(this.repo, r);
  const explicitNode = nodeID !== "";
  if (nodeID === "") {
    nodeID = resumeNodeID(r);
  }
  if (r.Nodes[nodeID] == null) {
    throw new Error("retry node not found");
  }
  if (r.WorkflowSnapshot.Nodes.length > 0) {
    let found = false;
    for (const node of r.WorkflowSnapshot.Nodes) {
      if (node.ID === nodeID) {
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error("retry node is not in the current SOP");
    }
  }
  const nodeStatus = r.Nodes[nodeID].Status;
  const waitingRetry = r.Status === "waiting" && nodeStatus === "waiting_approval";
  const replaySucceeded = r.Status === "succeeded";
  if (r.Status === "running" || r.HasActiveNode()) {
    throw new Error("run is still active");
  }
  if (r.Status !== "waiting" && r.Status !== "failed" && r.Status !== "cancelled" && !replaySucceeded) {
    throw new Error("only failed, cancelled, waiting, or succeeded replay decisions can be resumed");
  }
  if (explicitNode && !replayUpstreamSucceeded(r, nodeID)) {
    throw new Error(`cannot replay node ${nodeID}: an upstream node has not succeeded`);
  }
  const cleaned = r.WorkspaceCleanedAt != null;
  if ((r.Status === "cancelled" || cleaned) && !explicitNode && !replaySucceeded) {
    throw new Error("run workspace has been cleaned or scheduled for cleanup; this run can no longer be retried");
  }
  this.validateExecutionReconnect(r, nodeID);
  if (cleaned) {
    await this.restoreCheckpointBeforeExecution(ctx, r);
    const [restored] = this.repo.RunState(runID);
    r = restored;

    const runnerID = this.defaultExecutionRunner(r);
    if (runnerID !== "") {
      const cleanupID = "rt-cleanup-" + safeRunnerPath(runID);
      const [task, exists] = this.repo.RunnerTask(cleanupID);
      if (exists) {
        switch (task.Status) {
          case RunnerTaskQueued: {
            const err = this.repo.CancelRunnerTask(cleanupID, new Date());
            if (err != null) {
              throw err;
            }
            break;
          }
          case RunnerTaskLeased:
          case RunnerTaskRunning:
            throw new Error("run workspace cleanup is still active; retry after it finishes");
        }
      }
    }
    const resetErr = this.repo.ResetRunWorkspaceCleanup(runID);
    if (resetErr != null) {
      throw resetErr;
    }
    r.WorkspaceCleanedAt = null;
    if (this.executes()) {
      try {
        this.releaseRunEnvironment(runID, false);
      } catch (err) {
        console.log(`discard run sandbox ${runID}: ${err.message}`);
      }
      this.sandboxes.DiscardRunContainer(null, runID);
    }
  }
  for (let i = 0; i < r.WorkflowSnapshot.Nodes.length; i++) {
    const n = r.WorkflowSnapshot.Nodes[i];
    if (n.ID === nodeID && n.MaxAttempts <= r.Nodes[nodeID].Attempt) {
      n.MaxAttempts = r.Nodes[nodeID].Attempt + 1;
    }
  }
  if (reason.trim() === "") {
    if (waitingRetry) {
      reason = "对话轮次用尽后人工确认重试";
    } else if (replaySucceeded) {
      reason = "从指定节点重跑";
    } else {
      reason = "从中断处继续";
    }
  }
  const reset = descendants(r.WorkflowSnapshot, nodeID);
  reset[nodeID] = true;
  if (this.executes() && Object.keys(reset).length >= r.WorkflowSnapshot.Nodes.length) {
    // 整条 SOP 重放时复用上次尝试的容器，会继承上次搞坏或塞满的状态，而且容器会一直活到运行最终成功。先丢掉句柄释放工作区 flock，删除才安全；ensureStarted 会在下次执行时重建干净容器。
    try {
      this.releaseRunEnvironment(runID, false);
    } catch (err) {
      console.log(`discard run sandbox ${runID}: ${err.message}`);
    }
    this.sandboxes.DiscardRunContainer(null, runID);
  }
  // 被取消一并停下的并行分支不是自身的失败：也一并恢复，否则没人再调度它们，运行永远无法终结。放在整条 SOP 检查之后，这样恢复兄弟分支永远不会丢掉拉取。
  const revived = [];
  for (const node of r.WorkflowSnapshot.Nodes) {
    if (reset[node.ID]) {
      continue;
    }
    const nr = r.Nodes[node.ID];
    if (nr != null && nr.Status === "cancelled") {
      revived.push(node.Name);
      reset[node.ID] = true;
      for (const id of Object.keys(descendants(r.WorkflowSnapshot, node.ID))) {
        reset[id] = true;
      }
    }
  }
  overlayLatestNodeBindings(this.repo, r, reset);
  for (const node of r.WorkflowSnapshot.Nodes) {
    if (node.ID === nodeID && isScriptNode(node)) {
      humanContext = "";
      break;
    }
  }
  const note = recordHumanContext(r, nodeID, reason, humanContext);
  const stale = [];
  for (const id of Object.keys(reset)) {
    const nr = r.Nodes[id];
    if (nr != null) {
      if (nr.ChildRunID !== keepChildRunID) {
        stale.push(nr.ChildRunID);
      }
      nr.Status = "pending";
      nr.Error = "";
      nr.Output = "";
      nr.ChildRunID = "";
      if (id === nodeID) {
        nr.ChildRunID = keepChildRunID;
      }
      nr.FinishedAt = null;
      if (id === nodeID) {
        nr.Feedback = note;
      } else {
        nr.Feedback = "";
      }
    }
  }
  let retryLabel = "从中断处继续";
  if (explicitNode) {
    retryLabel = "从指定节点重跑";
  }
  this.event(r, nodeID, "node.retry_requested", retryLabel + "：" + note);
  if (revived.length > 0) {
    this.event(r, "", "node.retry_requested", "一并恢复被取消的并行分支：" + revived.join("、"));
  }
  appendControlTelemetry(r, nodeID, "node.retry_requested", retryLabel + "：" + reason.trim());
  r.CancelRequested = false;
  r.PauseRequested = false;
  r.Status = "running";
  const issueID = r.ExecutionContext.IssueID;
  if (issueID !== "") {
    const [issue, found] = this.repo.Issue(issueID);
    if (found && issue.Status !== "done" && issue.Status !== "closed") {
      issue.Status = "in_progress";
      issue.UpdatedAt = new Date();
      this.repo.PutIssue(issue);
    }
  }
  const taskID = r.ExecutionContext.TaskID;
  if (taskID !== "") {
    const [task, found] = this.repo.Task(taskID);
    if (found) {
      task.Status = "running";
      task.UpdatedAt = new Date();
      this.repo.PutTask(task);
    }
  }
  this.cancelLiveChildRuns(stale);
  return this.persistControlDecision(runID, r, ...expected);
};

// ResumePaused 继续所有被操作员暂停打断的节点。它与 Retry 是分开的操作，普通审批门禁不受影响。与父流程一起暂停的子 SOP 运行随父流程一起恢复。先恢复子流程，让恢复后的父流程不会等一个仍暂停的子流程。
Engine.prototype.ResumePaused = async function (runID, humanContext, ...expected) {
  return this.ResumePausedContext(null, runID, humanContext, ...expected);
};

// ResumePausedContext 在恢复被暂停的 SOP 时保留工作区归属。
Engine.prototype.ResumePausedContext = async function (ctx, runID, humanContext, ...expected) {
  if (expected.length > 0) {
    const [r, ok] = this.repo.RunState(runID);
    if (!ok) {
      throw new Error("run not found");
    }
    checkNodeExpectation(r, expected);
  }
  const [r0, ok0] = this.repo.RunState(runID);
  if (ok0 && r0.Status === "waiting" && r0.PauseRequested) {
    for (const nr of Object.values(r0.Nodes)) {
      if (!isUserPausedNode(nr) || nr.ChildRunID === "") {
        continue;
      }
      const [child, childOk] = this.repo.RunState(nr.ChildRunID);
      if (!childOk || !child.PauseRequested) {
        continue;
      }
      switch (child.Status) {
        case "running":
          throw new Error(`子 SOP ${child.ID} 仍在停止当前任务，请稍后再继续`);
        case "waiting":
          try {
            await this.ResumePausedContext(ctx, child.ID, humanContext);
          } catch (err) {
            throw new Error(`继续子 SOP ${child.ID}：${err.message}`);
          }
          break;
      }
    }
  }
  await this.RestoreConversationWorkspaceIfNeeded(ctx, runID);
  return this.resumePaused(runID, humanContext, ...expected);
};

// childRunIDs 列出运行的 SOP 节点引用的子 SOP 运行。
function childRunIDs(r) {
  const ids = [];
  for (const nr of Object.values(r.Nodes)) {
    if (nr != null && nr.ChildRunID !== "") {
      ids.push(nr.ChildRunID);
    }
  }
  ids.sort();
  return ids;
}

Engine.prototype.resumePaused = function (runID, humanContext, ...expected) {
  let [r, ok] = this.repo.RunState(runID);
  if (!ok) {
    throw new Error("run not found");
  }
  checkNodeExpectation(r, expected);
  if (r.Status !== "waiting" || !r.PauseRequested) {
    throw new Error("run is not paused");
  }
  if (this.executes() && this.workspaceBlocked(r)) {
    throw new Error(`run ${runID} 的工作区绑定在 ${r.WorkspaceHost}:${r.WorkspaceRoot}，请在绑定实例上继续`);
  }
  const [activeRunnerTasks, err] = this.repo.ActiveRunnerTasksForRun(runID);
  if (err != null) {
    throw new Error(`check runner tasks: ${err.message}`);
  }
  if (activeRunnerTasks.length > 0) {
    throw new Error("执行机器仍在停止当前任务，请等待远端进程退出后再继续");
  }
  const paused = [];
  for (const [id, nr] of Object.entries(r.Nodes)) {
    if (isUserPausedNode(nr)) {
      paused.push(id);
    }
  }
  // 从群组模式返回会特意留下一个 pending 的 SOP 节点，而不是一个被中断的 worker。认出这个显式检查点，包括本次修复之前创建的记录，但不放行普通人工门禁。
  if (paused.length === 0 && !r.IsWorkspace()) {
    for (let i = r.Events.length - 1; i >= 0; i--) {
      const ev = r.Events[i];
      if (ev.Type === "group.sop_restored") {
        const nr = r.Nodes[ev.NodeID];
        if (nr != null && nr.Status === "pending" && nr.Activity === "切回 SOP，等待继续" && replayUpstreamSucceeded(r, ev.NodeID)) {
          paused.push(ev.NodeID);
        }
        break;
      }
    }
  }
  if (paused.length === 0) {
    // 暂停可能落在活动步骤已经完成后：最后一个节点已成功、调度器已退出，或群组协作本就空闲。暂停标志已设置，但没有节点停在 waiting_approval。继续这张图，而不是失败。普通人工门禁仍会挡住——它不是暂停检查点。
    const resumed = resumeUnpausedGraph(r);
    if (!resumed) {
      throw new Error("paused node not found");
    }
    if (this.executes() && r.Status === "running") {
      r = this.acquireLease(r);
    }
    let message = "人工确认直接继续运行";
    if (r.IsWorkspace() && r.Status === "waiting") {
      message = "继续自由协作";
    }
    this.event(r, "", "run.resumed", message);
    appendControlTelemetry(r, "", "run.resumed", message);
    if (r.Status === "running") {
      markRunRelationsRunning(this.repo, r);
    }
    return this.persistControlDecision(runID, r, ...expected);
  }
  if (this.executes()) {
    r = this.acquireLease(r);
  }
  paused.sort();
  const nodes = {};
  for (const node of r.WorkflowSnapshot.Nodes) {
    nodes[node.ID] = node;
  }
  let firstAgent = "";
  for (const id of paused) {
    if (!isScriptNode(nodes[id])) {
      firstAgent = id;
      break;
    }
  }
  let note = "";
  if (firstAgent !== "" && humanContext.trim() !== "") {
    note = recordHumanContext(r, firstAgent, "", humanContext);
  }
  for (const id of paused) {
    const nr = r.Nodes[id];
    let restoredFeedback = "";
    if (nr.Status === "pending" && nr.Activity === "切回 SOP，等待继续") {
      restoredFeedback = nr.Feedback;
    }
    nr.Status = "pending";
    nr.Error = "";
    nr.Activity = "";
    nr.FinishedAt = null;
    nr.Feedback = "";
    nr.ResumeSessionID = "";
    if (!isScriptNode(nodes[id])) {
      nr.Feedback = (restoredFeedback + "\n" + note).trim();
      nr.ResumeSessionID = nr.SessionID.trim();
    }
  }
  r.CancelRequested = false;
  r.PauseRequested = false;
  r.Status = "running";
  let message = "人工确认直接继续运行";
  if (note !== "") {
    message = "人工补充信息后继续运行";
  }
  this.event(r, paused[0], "run.resumed", message);
  appendControlTelemetry(r, paused[0], "run.resumed", message);
  markRunRelationsRunning(this.repo, r);
  return this.persistControlDecision(runID, r, ...expected);
};

// RefreshRunSOP 把已停止运行的冻结图换成最新发布的 SOP。同 ID 已完成的节点保留结果，新节点从 pending 开始，已落地的沙箱保持冻结。
Engine.prototype.RefreshRunSOP = function (runID) {
  let [r, ok] = this.repo.RunState(runID);
  if (!ok) {
    throw new Error("run not found");
  }
  if (r.Status === "running" || r.HasActiveNode() || (r.Status !== "waiting" && !TerminalRunStatus(r.Status))) {
    throw new Error("only a stopped run can update its SOP");
  }
  if (this.executes()) {
    r = this.acquireLease(r);
  }
  const [latest0, found] = latestWorkflowDefinition(this.repo, r.WorkflowID);
  if (!found) {
    throw new Error("workflow not found");
  }
  let latest = latest0;
  const previousVersion = r.WorkflowSnapshot.Version;
  const previousRevision = r.WorkflowSnapshot.Revision;
  if (previousVersion === latest.Version && previousRevision === latest.Revision) {
    return null;
  }
  // 图/角色更新不得悄悄替换已有工作区之下的环境。新运行会取最新的沙箱资产。
  latest.SandboxProfileID = r.WorkflowSnapshot.SandboxProfileID;
  latest.SandboxSnapshot = r.WorkflowSnapshot.SandboxSnapshot;
  latest = configureBaselineAlignCLI(latest);
  latest = AttachPreviewBuild(latest);
  for (const node of latest.Nodes) {
    if (r.Nodes[node.ID] == null) {
      r.Nodes[node.ID] = new NodeRun({ NodeID: node.ID, Status: "pending" });
    }
  }
  r.WorkflowSnapshot = latest;
  const message = `已更新为最新 SOP：v${previousVersion} #${previousRevision} → v${latest.Version} #${latest.Revision}（保留当前运行环境）`;
  this.event(r, "", "run.workflow_refreshed", message);
  appendControlTelemetry(r, "", "run.workflow_refreshed", message);
  const err = this.repo.PutRun(r);
  if (err != null) {
    throw err;
  }
  this.publish(runID);
  return null;
};

function isUserPausedNode(nr) {
  return nr != null && nr.Status === "waiting_approval" && nr.Activity.includes("用户暂停");
}

// resumeUnpausedGraph 清除没有打断节点的暂停。人工门禁仍会挡住：恢复不得批准它。否则已完成的 SOP 回到调度器等它终结，待办工作继续，空闲群组回到等待下一个任务。
function resumeUnpausedGraph(r) {
  if (r == null) {
    throw new Error("run not found");
  }
  const wf = r.WorkflowSnapshot;
  if (hasWaiting(wf, r)) {
    return false;
  }
  for (const n of wf.Nodes) {
    if (r.Nodes[n.ID] == null) {
      return false;
    }
  }
  const ready = readyNodes(wf, r);
  r.CancelRequested = false;
  r.PauseRequested = false;
  if (r.IsWorkspace() && ready.length === 0) {
    r.Status = "waiting";
    return true;
  }
  if (ready.length > 0 || allSucceeded(wf, r) || hasFailed(wf, r)) {
    r.Status = "running";
    return true;
  }
  return false;
}

function isScriptNode(node) {
  if (node == null) {
    return false;
  }
  return node.Type === "script" || node.Type === "command";
}

function markRunRelationsRunning(st, r) {
  const issueID = r.ExecutionContext.IssueID;
  if (issueID !== "") {
    const [issue, found] = st.Issue(issueID);
    if (found && issue.Status !== "done" && issue.Status !== "closed") {
      issue.Status = "in_progress";
      issue.UpdatedAt = new Date();
      st.PutIssue(issue);
    }
  }
  const taskID = r.ExecutionContext.TaskID;
  if (taskID !== "") {
    const [task, found] = st.Task(taskID);
    if (found) {
      task.Status = "running";
      task.UpdatedAt = new Date();
      st.PutTask(task);
    }
  }
}

Engine.prototype.DeclineRetry = function (runID, nodeID, ...expected) {
  let [r, ok] = this.repo.RunState(runID);
  if (!ok) {
    throw new Error("run not found");
  }
  checkNodeExpectation(r, expected);
  const n = r.Nodes[nodeID];
  if (n == null || n.Status !== "waiting_approval") {
    throw new Error("node is not waiting for approval");
  }
  n.Status = "failed";
  if (n.Error.trim() === "") {
    n.Error = "对话轮次用尽，人工选择不重试";
  }
  n.Activity = "人工选择不重试";
  n.FinishedAt = new Date();
  this.event(r, nodeID, "agent.turns.declined", "人工选择不重试本节点");
  appendControlTelemetry(r, nodeID, "agent.turns.declined", "人工选择不重试本节点");
  r.Status = "failed";
  let err;
  if (expected.length > 0) {
    err = this.repo.PutRunAtRevision(r, r.Revision);
  } else {
    err = this.repo.PutRun(r);
  }
  if (err != null) {
    throw err;
  }
  this.publish(runID);
  return null;
};

function overlayLatestNodeBindings(st, r, nodeIDs) {
  if (st == null || r == null || Object.keys(nodeIDs).length === 0) {
    return;
  }
  const [latest, ok] = latestWorkflowDefinition(st, r.WorkflowID);
  if (!ok) {
    return;
  }
  const byID = {};
  for (const n of latest.Nodes) {
    byID[n.ID] = n;
  }
  for (let i = 0; i < r.WorkflowSnapshot.Nodes.length; i++) {
    const n = r.WorkflowSnapshot.Nodes[i];
    if (!nodeIDs[n.ID]) {
      continue;
    }
    const src = byID[n.ID];
    if (src == null) {
      continue;
    }
    if (n.AgentID !== src.AgentID || n.ExecutorID !== src.ExecutorID) {
      if (r.WorkflowSnapshot.ExecutorDefaults != null) {
        delete r.WorkflowSnapshot.ExecutorDefaults[n.ID];
      }
    }
    n.AgentID = src.AgentID;
    n.ExecutorID = src.ExecutorID;
    n.ArtifactOutputs = src.ArtifactOutputs;
    n.OnFailure = src.OnFailure;
    n.RejectTo = src.RejectTo;
    n.RetryStrategy = src.RetryStrategy;
    n.CarryOver = src.CarryOver;
    if (src.MaxAttempts > n.MaxAttempts) {
      n.MaxAttempts = src.MaxAttempts;
    }
    if (src.MaxReworks > n.MaxReworks) {
      n.MaxReworks = src.MaxReworks;
    }
  }
  if (latest.Version > r.WorkflowSnapshot.Version) {
    r.WorkflowSnapshot.Version = latest.Version;
  }
}

function resumeNodeID(r) {
  const wf = r.WorkflowSnapshot;
  const order = [];
  for (const n of wf.Nodes) {
    order.push(n.ID);
  }
  if (order.length === 0) {
    for (const id of Object.keys(r.Nodes)) {
      order.push(id);
    }
  }
  for (const id of order) {
    const nr = r.Nodes[id];
    if (nr != null && (nr.Status === "cancelled" || nr.Status === "failed")) {
      return id;
    }
  }
  const ready = readyNodes(wf, r);
  if (ready.length > 0) {
    return ready[0].ID;
  }
  // 兜底：选第一个尚未成功的节点（例如取消/中断后仍停留在 running 的节点）。这样即便历史遗留的 run 节点状态未收敛，也能定位到续跑目标，避免返回空。
  for (const id of order) {
    const nr = r.Nodes[id];
    if (nr != null && nr.Status !== "succeeded") {
      return id;
    }
  }
  return "";
}

module.exports = { childRunIDs, isUserPausedNode, resumeUnpausedGraph, isScriptNode, markRunRelationsRunning, overlayLatestNodeBindings, resumeNodeID };
