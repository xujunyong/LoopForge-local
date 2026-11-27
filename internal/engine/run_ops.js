/**
 * @file internal/engine/run_ops.js
 * 对应 Go 源文件：internal/engine/run_ops.go
 *
 * 作用与职责边界：
 * 实现运行生命周期的人工与控制面操作，包括取消（`Cancel`）、暂停（`Pause`）、
 * 人工门禁批准（`Approve`）、失败/暂停脚本节点通过（`Pass`）、打回返工（`Reject`）、
 * 从中断或指定节点重试（`Retry`/`RetryContext`）、恢复已暂停运行（`ResumePaused`/`ResumePausedContext`）、
 * 刷新已停止运行的 SOP 定义（`RefreshRunSOP`）以及拒绝重试（`DeclineRetry`）。
 *
 * 语法差异说明：
 * - Go 的 `sync.Mutex`（`e.stateMu`）在单线程 JS 中省略；`context.Background()` 译为 `null`；`time.Time` 零值译为 `null`。
 * - Go 的 `(值, error)` 与仅 `error` 返回（含全部 `this.repo.*` 调用）均按统一约定译为成功返回值（或无返回值 `undefined`）、失败 `throw err`。
 * - Go 的 `map[string]bool`（含 `descendants()` 返回值）译为普通对象 `{}`，统一通过属性访问与 `Object.keys()` 读写。
 * - Go 中异步取消子运行的 `go func()` 译为 `queueMicrotask`。
 */

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { NodeRun } = require("../domain/run.js"); // 对应 Go 的 domain.NodeRun，run.js 已翻译
const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { RunnerTaskQueued, RunnerTaskLeased, RunnerTaskRunning } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerTaskQueued/RunnerTaskLeased/RunnerTaskRunning，runner.js 已翻译
const { AttachPreviewBuild } = require("../domain/preview_build.js"); // 对应 Go 的 domain.AttachPreviewBuild，preview_build.js 已翻译
const { descendants, workflowForRun, replayUpstreamSucceeded, latestWorkflowDefinition, hasWaiting, readyNodes, allSucceeded, hasFailed } = require("./workflow_graph.js"); // 对应 Go 同包图函数，workflow_graph.js 已翻译
const { isLiveStatus } = require("./workspace_cleanup.js"); // 对应 Go 同包函数，workspace_cleanup.js 已翻译
const { checkNodeExpectation } = require("./bot_control.js"); // 对应 Go 同包函数，bot_control.js 已翻译
const { forbidClosedGongfengIssue } = require("./node_outcome.js"); // 对应 Go 同包函数，node_outcome.js 已翻译
const { recordHumanContext } = require("./human_context.js"); // 对应 Go 同包函数，human_context.js 已翻译
const { appendArtifact } = require("./artifacts.js"); // 对应 Go 同包函数，artifacts.js 已翻译
const { appendControlTelemetry } = require("./run_events.js"); // 对应 Go 同包函数，run_events.js 已翻译
const { safeRunnerPath } = require("./runner_dispatch.js"); // 对应 Go 同包函数，runner_dispatch.js 已翻译
const { configureBaselineAlignCLI } = require("./align.js"); // 对应 Go 同包函数，align.js 已翻译

/**
 * 持久化人工控制决策后的运行状态、推送实时变更，并按当前进程角色恢复本地调度或释放租约。
 * 使用场景：由 `Approve`、`pass`、`Reject`、`retryContext`、`resumePaused` 在修改运行状态后统一收尾调用。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {object} r - 修改后的运行对象（`domain.Run`）。
 * @param {...object} expected - 可选节点期望断言列表（`NodeExpectation`），非空时走修订号乐观锁写入。
 * @returns {void} 无返回值。
 * @throws {Error} 清除控制标志或写入运行记录失败时抛出错误。
 */
Engine.prototype.persistControlDecision = function (runID, r, ...expected) {
  if (r.Status === "running") {
    r.CancelRequested = false;
    r.PauseRequested = false;
  }
  // pause_requested 不参与运行快照写入。只要本次决策本身释放了暂停就清除它，包括群组因无在途任务而继续等待的情况。
  if (expected.length === 0 && !r.PauseRequested && !r.CancelRequested) {
    this.repo.ClearRunControl(runID);
  }
  if (expected.length > 0) {
    this.repo.PutRunAtRevision(r, r.Revision);
  } else {
    this.repo.PutRun(r);
  }
  this.publish(runID);
  if (this.executes()) {
    this.resume(runID);
    return;
  }
  if (r.OwnerInstanceID !== "") {
    try {
      this.repo.ReleaseRunLease(runID, r.OwnerInstanceID, r.Generation);
    } catch {}
  }
};

/**
 * 取消指定运行及其存活子 SOP 运行：排队中直接取消，等待态同步终结，运行态持久化取消标志并中断或结算孤儿运行。
 * 使用场景：操作员或上游流程主动终止运行。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 运行不存在、运行已非活跃、持久化取消请求失败或取消 Runner 任务失败时抛出错误。
 */
Engine.prototype.Cancel = function (runID) {
  const cancelled = this.repo.CancelQueuedRun(runID);
  if (cancelled) {
    this.publish(runID);
    return;
  }
  let [r, ok] = this.repo.RunState(runID);
  if (!ok) {
    throw new Error("run not found");
  }
  if (!isLiveStatus(r.Status)) {
    if (TerminalRunStatus(r.Status) && r.HasActiveNode()) {
      this.forceTerminate(runID, "cancelled", "流水线已取消");
      return;
    }
    throw new Error("run is not active");
  }
  r = this.repo.RequestRunCancel(runID);
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
    return;
  }
  if (this.Interrupt(runID)) {
    return;
  }
  this.notifyRunControl(runID);
  // 本进程没有调度协程。存活的外来租约说明归属 worker 已收到通知（续租时也会看到该标志）。
  if (r.OwnerInstanceID !== "" && r.LeaseUntil != null && r.LeaseUntil.getTime() > Date.now() && !this.ownsRun(r)) {
    return;
  }
  try {
    r = this.acquireLease(r);
  } catch {
    return;
  }
  this.settleOrphan(runID, "运行已被手动终止（调度协程不存在，可能由服务重启导致）");
  try {
    this.repo.ReleaseRunLease(runID, this.instanceID, r.Generation);
  } catch {}
};

/**
 * 暂停指定运行及其运行中的子 SOP 运行：中断当前活动节点但不终结运行、不销毁工作区，停在人工决策点等待补充上下文并继续。
 * 使用场景：操作员需要临时介入正在执行的运行。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 持久化暂停请求失败或取消 Runner 任务失败时抛出错误。
 */
Engine.prototype.Pause = function (runID) {
  let r = this.repo.RequestRunPause(runID);
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
    return;
  }
  this.notifyRunControl(runID);
  if (r.OwnerInstanceID !== "" && r.LeaseUntil != null && r.LeaseUntil.getTime() > Date.now() && !this.ownsRun(r)) {
    return;
  }
  try {
    r = this.acquireLease(r);
  } catch {
    return;
  }
  this.pauseAt(runID, r.Generation, "运行已由用户暂停");
  try {
    this.repo.ReleaseRunLease(runID, this.instanceID, r.Generation);
  } catch {}
};

/**
 * 批准处于 `waiting_approval` 状态的人工门禁节点，记录决策产物与人工上下文，并将运行重新置为 `running`。
 * 使用场景：操作员通过界面或企微卡片批准审批节点。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {string} nodeID - 待批准的节点 ID。
 * @param {string} humanContext - 操作员附加的说明上下文。
 * @param {...object} expected - 可选节点期望断言（`NodeExpectation`）。
 * @returns {void} 无返回值。
 * @throws {Error} 运行不存在、工作区绑定阻塞、租约获取失败、断言不匹配、关联需求已关闭、节点未等待审批或持久化失败时抛出错误。
 */
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
  this.persistControlDecision(runID, r, ...expected);
};

/**
 * 手动将失败或中途暂停的脚本节点标记为成功以放行下游，并在该运行为子 SOP 时自动唤醒父流程重新接上。
 * 使用场景：`onFailure=fail`、返工次数耗尽或硬脚本在执行中途暂停且重跑无解时由操作员人工放行。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {string} nodeID - 待通过的脚本节点 ID（传空串时自动推断续跑节点）。
 * @param {string} humanContext - 操作员附加的说明上下文。
 * @param {...object} expected - 可选节点期望断言（`NodeExpectation`）。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 校验不通过或持久化失败时抛出错误。
 */
Engine.prototype.Pass = async function (runID, nodeID, humanContext, ...expected) {
  this.pass(runID, nodeID, humanContext, ...expected);
  await this.resumeParentAfterChildRecovery(runID);
};

/**
 * 执行人工通过脚本节点的核心状态更新与持久化逻辑。
 * 使用场景：由 `Pass` 在内部调用。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {string} nodeID - 待通过的脚本节点 ID。
 * @param {string} humanContext - 操作员附加的说明上下文。
 * @param {...object} expected - 可选节点期望断言（`NodeExpectation`）。
 * @returns {void} 无返回值。
 * @throws {Error} 运行不存在、节点非失败/暂停脚本节点、断言失败或持久化失败时抛出错误。
 */
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
  this.persistControlDecision(runID, r, ...expected);
};

/**
 * 将工作流打回到目标节点：重置目标节点及其全部下游节点状态、累加返工次数、取消孤立子运行与并行兄弟执行。
 * 使用场景：操作员在门禁或审查阶段要求打回上游节点返工。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {object} req - 打回请求对象（`domain.RejectRequest`，含 `NodeID`、`TargetID`、`Reason`、`Context`）。
 * @param {...object} expected - 可选节点期望断言（`NodeExpectation`）。
 * @returns {void} 无返回值。
 * @throws {Error} 运行不存在、打回目标缺失/不存在、超出最大返工次数或持久化失败时抛出错误。
 */
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
};

/**
 * 从选定节点（或自动推断的中断节点）重新打开已停止的工作流，保留已成功上游节点及其冻结产物；
 * 若节点已耗尽自动尝试次数，手动重试会额外授予一次尝试机会。
 * 使用场景：操作员在运行失败、取消、等待或成功后发起重试或重放。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {string} nodeID - 目标重跑节点 ID（为空时自动选择中断节点）。
 * @param {string} reason - 重试原因说明。
 * @param {string} humanContext - 操作员补充的上下文。
 * @param {...object} expected - 可选节点期望断言（`NodeExpectation`）。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 校验不通过、恢复检查点失败或持久化失败时抛出错误。
 */
Engine.prototype.Retry = async function (runID, nodeID, reason, humanContext, ...expected) {
  await this.RetryContext(null, runID, nodeID, reason, humanContext, ...expected);
};

/**
 * 带上下文的重试入口，在恢复被回收工作区的运行时复用调用方租约，并在完成后自动唤醒因该子 SOP 失败的父流程。
 * 使用场景：HTTP 或上层编排需要透传取消信号/工作区租约时调用。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} runID - 目标运行主键 ID。
 * @param {string} nodeID - 目标重跑节点 ID。
 * @param {string} reason - 重试原因说明。
 * @param {string} humanContext - 操作员补充的上下文。
 * @param {...object} expected - 可选节点期望断言（`NodeExpectation`）。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 校验不通过、恢复检查点失败或持久化失败时抛出错误。
 */
Engine.prototype.RetryContext = async function (ctx, runID, nodeID, reason, humanContext, ...expected) {
  await this.retryContext(ctx, runID, nodeID, reason, humanContext, "", ...expected);
  await this.resumeParentAfterChildRecoveryContext(ctx, runID);
};

/**
 * 异步取消已被父节点重置且不再被引用的子 SOP 运行，避免其继续执行或占用工作区。
 * 使用场景：由 `Reject` 或 `retryContext` 在重置节点并释放状态锁后执行。
 *
 * @param {string[]} ids - 待检查并取消的子运行 ID 列表（允许包含空字符串）。
 * @returns {void} 无返回值。
 */
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

/**
 * 在子 SOP 运行被重试或人工通过后，尝试自动唤醒因该子运行失败的父流程。
 * 使用场景：由 `Pass` 在内部调用。
 *
 * @param {string} childID - 已恢复的子 SOP 运行 ID。
 * @returns {Promise<void>} 无返回值。
 */
Engine.prototype.resumeParentAfterChildRecovery = async function (childID) {
  await this.resumeParentAfterChildRecoveryContext(null, childID);
};

/**
 * 带上下文地向上级联唤醒因指定子 SOP 运行失败的父流程，使父流程重放对应 SOP 节点并继续跟随恢复后的子运行。
 * 使用场景：由 `RetryContext` 和 `resumeParentAfterChildRecovery` 调用，支持多层嵌套 SOP 递归恢复。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} childID - 已恢复的子 SOP 运行 ID。
 * @returns {Promise<void>} 无返回值。
 */
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

/**
 * 执行重试/重放的核心流程：校验状态与上游、必要时恢复已清理的工作区检查点、重置目标及下游与被取消的并行分支并重新调度。
 * 使用场景：由 `RetryContext` 与 `resumeParentAfterChildRecoveryContext` 调用。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} runID - 目标运行主键 ID。
 * @param {string} nodeID - 目标节点 ID（为空时自动推断）。
 * @param {string} reason - 重试原因说明。
 * @param {string} humanContext - 操作员补充上下文（脚本节点会清空）。
 * @param {string} keepChildRunID - 需要保留不被取消的既有子运行 ID（父流程接回已恢复子 SOP 时使用）。
 * @param {...object} expected - 可选节点期望断言（`NodeExpectation`）。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 校验不通过、工作区恢复失败、清理任务仍在运行或持久化失败时抛出错误。
 */
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
            this.repo.CancelRunnerTask(cleanupID, new Date());
            break;
          }
          case RunnerTaskLeased:
          case RunnerTaskRunning:
            throw new Error("run workspace cleanup is still active; retry after it finishes");
        }
      }
    }
    this.repo.ResetRunWorkspaceCleanup(runID);
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
      try {
        this.repo.PutIssue(issue);
      } catch {}
    }
  }
  const taskID = r.ExecutionContext.TaskID;
  if (taskID !== "") {
    const [task, found] = this.repo.Task(taskID);
    if (found) {
      task.Status = "running";
      task.UpdatedAt = new Date();
      try {
        this.repo.PutTask(task);
      } catch {}
    }
  }
  this.cancelLiveChildRuns(stale);
  this.persistControlDecision(runID, r, ...expected);
};

/**
 * 恢复因操作员暂停而中断的全部节点（不影响普通人工审批门禁）；会先递归恢复一并暂停的子 SOP 运行。
 * 使用场景：操作员在暂停状态下点击继续运行。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {string} humanContext - 操作员补充的上下文。
 * @param {...object} expected - 可选节点期望断言（`NodeExpectation`）。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 子 SOP 仍在停止中、工作区恢复失败、断言不匹配或持久化失败时抛出错误。
 */
Engine.prototype.ResumePaused = async function (runID, humanContext, ...expected) {
  await this.ResumePausedContext(null, runID, humanContext, ...expected);
};

/**
 * 带上下文地恢复被暂停的运行，先恢复所有已暂停子 SOP 与会话工作区，再推进当前运行状态。
 * 使用场景：需要透传取消信号或工作区归属上下文时调用。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} runID - 目标运行主键 ID。
 * @param {string} humanContext - 操作员补充的上下文。
 * @param {...object} expected - 可选节点期望断言（`NodeExpectation`）。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 校验不通过、子 SOP 恢复失败、工作区恢复失败或持久化失败时抛出错误。
 */
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
  this.resumePaused(runID, humanContext, ...expected);
};

/**
 * 列出运行内所有节点引用的非空子 SOP 运行 ID，并按字典序排序。
 * 使用场景：`Cancel` / `Pause` 级联操作子 SOP 时枚举子运行。
 *
 * @param {object} r - 运行对象（`domain.Run`）。
 * @returns {string[]} 排序后的子运行 ID 数组。
 */
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

/**
 * 执行恢复暂停运行的核心状态更新：确认远端 Runner 任务已退出、收集暂停节点（含切回 SOP 检查点或无打断节点的图）、注入补充上下文并重新调度。
 * 使用场景：由 `ResumePausedContext` 在内部调用。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {string} humanContext - 操作员补充的上下文。
 * @param {...object} expected - 可选节点期望断言（`NodeExpectation`）。
 * @returns {void} 无返回值。
 * @throws {Error} 运行未处于暂停态、工作区被阻塞、远端任务仍在退出、无可恢复节点或持久化失败时抛出错误。
 */
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
  let activeRunnerTasks;
  try {
    activeRunnerTasks = this.repo.ActiveRunnerTasksForRun(runID);
  } catch (err) {
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
    this.persistControlDecision(runID, r, ...expected);
    return;
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
  this.persistControlDecision(runID, r, ...expected);
};

/**
 * 将已停止运行中冻结的工作流快照更新为最新发布的 SOP 定义：同 ID 已完成节点保留结果、新节点初始化为 `pending`，原有沙箱配置保持冻结。
 * 使用场景：SOP 修复后操作员在不新建运行的前提下刷新已停止运行的流程定义。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 运行不存在、运行仍在活动中、工作流不存在、预览构建装配失败或持久化失败时抛出错误。
 */
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
    return;
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
  this.repo.PutRun(r);
  this.publish(runID);
};

/**
 * 判断节点是否因操作员主动暂停而停在 `waiting_approval` 状态。
 * 使用场景：区分用户暂停节点与普通人工审批门禁节点。
 *
 * @param {object|null} nr - 节点运行状态对象（`domain.NodeRun`）。
 * @returns {boolean} 处于等待审批且活动文案包含“用户暂停”时返回 `true`，否则返回 `false`。
 */
function isUserPausedNode(nr) {
  return nr != null && nr.Status === "waiting_approval" && nr.Activity.includes("用户暂停");
}

/**
 * 清除未实际打断任何节点的暂停状态：若存在普通人工审批门禁则拒绝恢复；否则将运行恢复为 `running`（或空闲自由协作保持 `waiting`）。
 * 使用场景：暂停落在步骤刚完成或群组空闲时由 `resumePaused` 调用。
 *
 * @param {object|null} r - 待恢复的运行对象（`domain.Run`，会被就地修改）。
 * @returns {boolean} 成功恢复返回 `true`，存在阻塞门禁或无法推进返回 `false`。
 * @throws {Error} 传入运行对象为空时抛出错误。
 */
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

/**
 * 判断工作流节点定义是否为脚本或命令节点。
 * 使用场景：`pass`、`retryContext`、`resumePaused` 区分脚本节点与 Agent 节点。
 *
 * @param {object|null} node - 工作流节点定义对象（`domain.WorkflowNode`）。
 * @returns {boolean} 节点类型为 `"script"` 或 `"command"` 时返回 `true`，否则返回 `false`。
 */
function isScriptNode(node) {
  if (node == null) {
    return false;
  }
  return node.Type === "script" || node.Type === "command";
}

/**
 * 将运行关联的需求（若未完成/未关闭）和任务状态同步更新回进行中/运行中。
 * 使用场景：人工通过或恢复暂停使运行重新进入 `running` 状态时同步外部关联状态。
 *
 * @param {object} st - 仓储 Store 实例。
 * @param {object} r - 运行对象（`domain.Run`）。
 * @returns {void} 无返回值。
 */
function markRunRelationsRunning(st, r) {
  const issueID = r.ExecutionContext.IssueID;
  if (issueID !== "") {
    const [issue, found] = st.Issue(issueID);
    if (found && issue.Status !== "done" && issue.Status !== "closed") {
      issue.Status = "in_progress";
      issue.UpdatedAt = new Date();
      try {
        st.PutIssue(issue);
      } catch {}
    }
  }
  const taskID = r.ExecutionContext.TaskID;
  if (taskID !== "") {
    const [task, found] = st.Task(taskID);
    if (found) {
      task.Status = "running";
      task.UpdatedAt = new Date();
      try {
        st.PutTask(task);
      } catch {}
    }
  }
}

/**
 * 在对话轮次耗尽等待确认时由人工选择不重试：将对应节点及整个运行标记为 `failed` 并持久化。
 * 使用场景：操作员在交互确认卡片上点击“不重试”按钮。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {string} nodeID - 处于 `waiting_approval` 的节点 ID。
 * @param {...object} expected - 可选节点期望断言（`NodeExpectation`）。
 * @returns {void} 无返回值。
 * @throws {Error} 运行不存在、断言不匹配、节点未等待确认或持久化失败时抛出错误。
 */
Engine.prototype.DeclineRetry = function (runID, nodeID, ...expected) {
  const [r, ok] = this.repo.RunState(runID);
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
  if (expected.length > 0) {
    this.repo.PutRunAtRevision(r, r.Revision);
  } else {
    this.repo.PutRun(r);
  }
  this.publish(runID);
};

/**
 * 在打回或重试重置节点集合时，用当前最新工作流定义覆盖这些待重跑节点的 Agent/执行器/产物/重试配置，同时同步提升快照版本号。
 * 使用场景：由 `Reject` 与 `retryContext` 调用，使重跑节点生效最新绑定配置而不影响已完成节点。
 *
 * @param {object|null} st - 仓储 Store 实例。
 * @param {object|null} r - 运行对象（`domain.Run`，其 `WorkflowSnapshot` 会被就地更新）。
 * @param {Object<string, boolean>} nodeIDs - 待覆盖的节点 ID 集合（普通对象）。
 * @returns {void} 无返回值。
 */
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

/**
 * 自动推断未指定节点时的续跑目标节点 ID：优先选首个已取消或失败的节点，其次选首个就绪节点，最后兜底选首个未成功节点。
 * 使用场景：`pass` 与 `retryContext` 在调用方传入空 `nodeID` 时定位续跑起点。
 *
 * @param {object} r - 运行对象（`domain.Run`）。
 * @returns {string} 推断出的节点 ID；所有节点均已成功或无节点时返回 `""`。
 */
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
