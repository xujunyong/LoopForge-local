// workspace_cleanup.js —— 对应 Go 文件：internal/engine/workspace_cleanup.go
// 作用：工作区清理：运行工作区查询、终态清理、沙箱回收与孤儿结算。
// (值, error) 译为成功返回值、失败 throw，(值, bool) 译为 [值, bool]；time.Time 零值译为 null；time.Duration 译为毫秒数；sync.Mutex 省略；ticker 译为 sleepOrAbort 循环；defer 译为 try/finally；log.Printf 译为 console.log；context.Background() 译为 null；map[string]bool 译为普通对象。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { RunnerWorkspaceFacts, RunnerTaskFailed, RunnerTaskCanceled, RunnerTaskActionArchivePreview } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerWorkspaceFacts/RunnerTaskFailed/RunnerTaskCanceled/RunnerTaskActionArchivePreview，runner.js 已翻译
const { RunnerWorkspaceRequest, RunnerWorkspaceOperationReclaim } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspaceRequest/RunnerWorkspaceOperationReclaim，runner_workspace.js 已翻译
const { RunnerSandbox } = require("../domain/assets.js"); // 对应 Go 的 domain.RunnerSandbox，assets.js 已翻译

Engine.prototype.RunWorkspace = function (runID) {
  if (this.sandboxes == null) {
    return "";
  }
  const [run, ok] = this.repo.RunState(runID);
  if (ok) {
    return this.sandboxes.RunWorkspace(workspaceRunID(run));
  }
  return this.sandboxes.RunWorkspace(runID);
};

// WorkspaceRunID 返回 run 执行所在的工作区所属运行；子 SOP 共享启动其 SOP 链的运行的检出。
function WorkspaceRunID(run) {
  return workspaceRunID(run);
}

// RunWorkspaceFacts 返回执行机最后上报的运行工作区事实；ok 为 false 时引擎须自行检查 RunWorkspace。
Engine.prototype.RunWorkspaceFacts = function (runID) {
  const facts = this.workspaceFacts[runID];
  if (facts == null) {
    return [new RunnerWorkspaceFacts(), false];
  }
  return [facts, true];
};

Engine.prototype.recordWorkspaceFacts = function (runID, outputs) {
  if (outputs == null || outputs.Facts == null) {
    return;
  }
  this.workspaceFacts[runID] = outputs.Facts;
};

Engine.prototype.QueuePreviewArchive = function (run, spec) {
  this.queueRunnerPreviewArchive(run, spec);
  return null;
};

Engine.prototype.CancelPreviewArchive = function (runID) {
  const [tasks, err] = this.repo.ActiveRunnerTasksForRun(runID);
  if (err != null) {
    console.log(`list preview archive tasks ${runID}: ${err}`);
    return;
  }
  const now = new Date();
  for (const task of tasks) {
    if (task.Action !== RunnerTaskActionArchivePreview) {
      continue;
    }
    const cancelErr = this.repo.CancelRunnerTask(task.ID, now);
    if (cancelErr != null) {
      console.log(`cancel preview archive ${task.ID}: ${cancelErr}`);
      continue;
    }
    this.NotifyRunnerTaskChanged(task.ID);
    const [updated, ok] = this.repo.RunnerTask(task.ID);
    if (ok) {
      this.notifyRunnerControl(updated.LeaseOwner, updated.ID, updated.DesiredState);
    }
  }
};

Engine.prototype.ReleaseWorkspace = function (runID) {
  this.cleanupRunWorkspace(runID);
};

Engine.prototype.sandboxSweep = async function (ctx) {
  for (;;) {
    try {
      await sleepOrAbort(ctx, 20 * 1000);
    } catch {
      this.checkpointTransfers.Close();
      return;
    }
    this.checkpointTransfers.Sweep(new Date());
    if (this.preview != null) {
      this.recoverBuiltPreviewArchives();
      this.recoverMissingPreviewFinalizers();
      this.preview.Reconcile();
    }
    this.reconcileTerminalWorkspaceCleanup();
    this.reclaimSandboxes();
  }
};

Engine.prototype.reconcileTerminalWorkspaceCleanup = function () {
  const now = new Date();
  const seen = {};
  for (const run of this.repo.TerminalWorkspaceCleanupRuns()) {
    seen[run.ID] = true;
    this.cleanupWorkspace(run, now);
  }
  for (const id of this.repo.CheckpointWorkspaceRunIDs()) {
    if (!seen[id]) {
      const [run, ok] = this.repo.RunState(id);
      if (ok) {
        this.cleanupWorkspace(run, now);
      }
    }
  }
};

// recoverBuiltPreviewArchives 覆盖已完成却未写预览行的预览构建：运行仍在等后续门禁，或进程在归档排队前重启。它在成功运行清扫前运行，避免从空的控制面检出判断执行机工作区后跳过。
Engine.prototype.recoverBuiltPreviewArchives = function () {
  if (this.preview == null) {
    return;
  }
  for (const runID of this.repo.RunsAwaitingBuiltPreview()) {
    const [run, ok] = this.repo.RunState(runID);
    if (!ok || !run.WorkflowSnapshot.Preview.Static() || run.WorkspaceCleanedAt != null) {
      continue;
    }
    const [, previewOk] = this.repo.PreviewByRun(run.ID);
    if (previewOk) {
      continue;
    }
    this.preview.ArchiveBuiltPreview(run);
  }
};

// recoverMissingPreviewFinalizers 覆盖运行已持久化为成功、但 BeginFinalization 写预览行与清理保留前的崩溃窗口。清扫须在终态工作区清理前运行它。
Engine.prototype.recoverMissingPreviewFinalizers = function () {
  if (this.preview == null) {
    return;
  }
  for (const run of this.repo.TerminalWorkspaceCleanupRuns()) {
    if (run.Status !== "succeeded" || run.WorkspaceCleanedAt != null) {
      continue;
    }
    if (!run.WorkflowSnapshot.Preview.Static()) {
      continue;
    }
    const [, previewOk] = this.repo.PreviewByRun(run.ID);
    if (previewOk) {
      continue;
    }
    this.preview.BeginFinalization(run);
  }
};

Engine.prototype.cleanupRunWorkspace = function (runID) {
  const [run, ok] = this.repo.RunState(runID);
  if (!ok) {
    return;
  }
  this.cleanupWorkspace(run, new Date());
};

Engine.prototype.cleanupWorkspace = function (run, now) {
  let managed = false;
  let checkpointClaimed = false;
  let releaseCheckpoint = null;
  let checkpointErr = null;
  try {
    [managed, checkpointClaimed, releaseCheckpoint] = this.claimIdleConversationWorkspace(run, now);
  } catch (e) {
    checkpointErr = e;
  }
  try {
    if (checkpointErr != null) {
      console.log(`preserve workspace ${run.ID}: ${checkpointErr}`);
      return;
    }
    if (managed && !checkpointClaimed) {
      return;
    }
    const runnerID = this.defaultExecutionRunner(run);
    if (run.WorkspaceCleanedAt != null) {
      if (runnerID === "") {
        return;
      }
      const [task, exists] = this.repo.RunnerTask("rt-cleanup-" + safeRunnerPath(run.ID));
      if (!exists) {
        // 已注销的执行机在注销时已清理工作区；否则允许重新排队清理请求。
        const [, runnerExists] = this.repo.Runner(runnerID);
        if (runnerExists) {
          this.repo.ResetRunWorkspaceCleanup(run.ID);
        }
        return;
      }
      if (task.Status === RunnerTaskFailed || task.Status === RunnerTaskCanceled) {
        this.repo.ResetRunWorkspaceCleanup(run.ID);
      }
      return;
    }
    let claimed = checkpointClaimed;
    let claimErr = null;
    if (!managed) {
      [claimed, claimErr] = this.repo.ClaimRunWorkspaceCleanup(run.ID, now);
    }
    if (claimErr != null) {
      console.log(`claim terminal workspace cleanup ${run.ID}: ${claimErr}`);
      return;
    }
    if (!claimed) {
      return;
    }
    const reset = (cleanupErr) => {
      console.log(`cleanup terminal workspace ${run.ID}: ${cleanupErr}`);
      const resetErr = this.repo.ResetRunWorkspaceCleanup(run.ID);
      if (resetErr != null) {
        console.log(`reset terminal workspace cleanup ${run.ID}: ${resetErr}`);
      }
    };
    if (this.foreignWorkspaceBind(run)) {
      if (!checkpointClaimed) {
        reset(new Error(`workspace belongs to ${run.WorkspaceHost}:${run.WorkspaceRoot}`));
        return;
      }
      const [meta] = this.repo.WorkspaceCheckpoint(run.ID);
      const checkpointController = new AbortController();
      const checkpointTimer = setTimeout(() => checkpointController.abort(new Error("context deadline exceeded")), 30 * 1000);
      try {
        const response = this.requestWorkspaceCheckpoint(checkpointController.signal, run, new RunnerWorkspaceRequest({ RunID: run.ID, Operation: RunnerWorkspaceOperationReclaim, CheckpointLease: meta.LeaseToken }));
        if (response.Error !== "") {
          reset(new Error(response.Error));
        }
      } catch (err) {
        reset(err);
      } finally {
        clearTimeout(checkpointTimer);
      }
      return;
    }
    try {
      this.releaseRunEnvironment(run.ID, true);
    } catch (err) {
      reset(err);
      return;
    }
    if (runnerID !== "") {
      try {
        this.queueRunnerRunCleanup(run);
      } catch (err) {
        reset(err);
        return;
      }
    }
    console.log(`cleaned terminal workspace ${run.ID}`);
  } finally {
    if (releaseCheckpoint != null) {
      releaseCheckpoint();
    }
  }
};

Engine.prototype.liveSandboxRunIDs = function () {
  const ids = this.repo.LiveSandboxRunIDs();
  const seen = {};
  for (const id of ids) {
    seen[id] = true;
  }
  // 未回收的受管工作区（含保存失败的）不受下层孤儿目录/容器清扫影响。
  for (const session of this.repo.ListSharedAssistantSessions()) {
    if (seen[session.RunID]) {
      continue;
    }
    const [run, ok] = this.repo.RunState(session.RunID);
    if (ok && run.WorkspaceCleanedAt == null) {
      ids.push(run.ID);
      seen[run.ID] = true;
    }
  }
  for (const id of this.repo.CheckpointWorkspaceRunIDs()) {
    if (!seen[id]) {
      const [run, ok] = this.repo.RunState(id);
      if (ok && run.WorkspaceCleanedAt == null) {
        ids.push(id);
        seen[id] = true;
      }
    }
  }
  return ids;
};

// SupersedeIssueRuns 释放同一议题早前已结算运行的沙箱容器，新分派已取代它们。
// 从头重新分派不是重试：它分配新运行 ID 与新容器，从不碰旧容器。旧运行保持失败，失败运行为重试特意保留工作区——也让容器无限期存活，各自持有已长到 GB 级的可写层。工作区留在原地供检查旧尝试，只回收容器。
Engine.prototype.SupersedeIssueRuns = function (issueID, keepRunID) {
  if (!this.executes()) {
    return;
  }
  const [kept, keptFound] = this.repo.RunState(keepRunID);
  for (const runID of this.repo.SupersededIssueRunIDs(issueID, keepRunID)) {
    const [run, ok] = this.repo.RunState(runID);
    if (!ok || this.foreignWorkspaceBind(run)) {
      continue;
    }
    // 同一议题的另一 SOP 不是取代本运行；它仍可能被重试。
    if (keptFound && run.WorkflowID !== kept.WorkflowID) {
      continue;
    }
    try {
      this.releaseRunEnvironment(runID, false);
    } catch (err) {
      console.log(`supersede run sandbox ${runID}: ${err}`);
    }
    this.sandboxes.DiscardRunContainer(null, runID);
  }
};

Engine.prototype.destroySandbox = function (runID) {
  try {
    this.releaseRunEnvironment(runID, true);
  } catch (err) {
    console.log(`destroy sandbox ${runID}: ${err}`);
  }
};

// DeleteRun 仅在本地执行环境已销毁、且执行机侧工作区清理已持久排队后删除已结算运行。失败运行通常为重试保留工作区；显式删除须同时清理两端宿主。
Engine.prototype.DeleteRun = async function (runID) {
  const [run, ok] = this.repo.RunState(runID);
  if (!ok) {
    throw new Error("run not found");
  }
  if (run.Status === "running" || run.Status === "waiting" || run.Status === "queued") {
    throw new Error(`run ${runID} is ${run.Status}: cancel it before deleting`);
  }
  if (run.HasActiveNode()) {
    throw new Error(`运行 ${runID} 仍有未结束的节点，请先停止后再删除`);
  }
  const token = await this.beginWorkspaceUseAfterCleanup(null, runID);
  try {
    if ((this.WorkspaceActive != null && this.WorkspaceActive(run)) || this.conversationGenerationRunning(run)) {
      throw new Error("工作区仍在使用，请先停止");
    }
    const claimErr = this.repo.ClaimWorkspaceDeletion(runID, token, run.Revision, new Date());
    if (claimErr != null) {
      throw claimErr;
    }
    // 先在持久 Task 上保留终态结果再删 Run。否则后续任务同步只能看到悬空 RunID，无法区分已删成功/失败与已删取消。
    this.settleDeletedRunTasks(run);
    if (this.preview != null) {
      const previewErr = this.preview.DeleteForRun(runID);
      if (previewErr != null) {
        throw new Error(`delete run preview: ${previewErr.message}`);
      }
    }
    try {
      this.queueRunnerRunCleanup(run);
    } catch (e) {
      throw new Error(`queue runner workspace cleanup: ${e.message}`);
    }
    try {
      this.releaseRunEnvironment(runID, true);
    } catch (e) {
      throw new Error(`destroy run sandbox: ${e.message}`);
    }
    const deleteErr = this.repo.DeleteRun(runID);
    if (deleteErr != null) {
      throw deleteErr;
    }
    return null;
  } finally {
    this.repo.FinishWorkspaceUse(runID, token, new Date(), null, "");
  }
};

Engine.prototype.settleDeletedRunTasks = function (run) {
  const status = { succeeded: "completed", failed: "failed", cancelled: "cancelled" }[run.Status] ?? "";
  if (status === "") {
    return null;
  }
  const contextTaskID = run.ExecutionContext.TaskID.trim();
  for (const task of this.repo.Tasks()) {
    if (task.RunID !== run.ID && (contextTaskID === "" || task.ID !== contextTaskID)) {
      continue;
    }
    if (task.Status === status) {
      continue;
    }
    const err = this.repo.UpdateTaskStatus(task, status);
    if (err != null) {
      throw new Error(`settle task ${task.ID} before deleting run ${run.ID}: ${err.message}`);
    }
  }
  return null;
};

Engine.prototype.reclaimSandboxes = function () {
  const live = this.liveSandboxRunIDs();
  const [n, err] = this.sandboxes.ReclaimExcept(live);
  if (err != null) {
    console.log(`reclaim sandboxes: ${err}`);
  } else if (n > 0) {
    console.log(`reclaimed ${n} finished sandbox workspace(s)`);
  }
  // 容器比上面的目录清扫活得久：工作区已回收或已彻底删除的运行仍有容器持有 GB 级可写层，只有显式 docker rm 能释放。
  const [containers, containersErr] = this.sandboxes.ReclaimDockerSandboxes(null, live);
  if (containersErr != null) {
    console.log(`reclaim docker sandboxes: ${containersErr}`);
    return;
  }
  if (containers > 0) {
    console.log(`reclaimed ${containers} finished sandbox container(s)`);
  }
  const idle = this.discardIdleRunContainers(null, new Date());
  if (idle > 0) {
    console.log(`discarded ${idle} idle failed/waiting sandbox container(s)`);
  }
  const keep = this.repo.LiveSandboxDockerfiles();
  for (const profile of this.repo.Sandboxes()) {
    const spec = RunnerSandbox(profile);
    if (spec.Dockerfile != null) {
      keep.push(spec.Dockerfile);
    }
  }
  const [images, imagesErr] = this.sandboxes.ReclaimCachedDockerImages(null, keep);
  if (imagesErr != null) {
    console.log(`reclaim cached docker images: ${imagesErr}`);
    return;
  }
  if (images > 0) {
    console.log(`reclaimed ${images} unused docker image cache tag(s)`);
  }
};

// 失败与等待运行为重试或人工决策保留工作区，存活集永不释放它们。容器只挂着 `sleep infinity` 占内存与可写层；闲置满这些时长后容器回收、工作区保留。下次重试、批准或恢复重新获取环境，重建容器并重跑环境安装。
const idleFailedRunContainerTTL = 30 * 60 * 1000;
const idleWaitingRunContainerTTL = 2 * 60 * 60 * 1000;

Engine.prototype.discardIdleRunContainers = function (ctx, now) {
  if (!this.executes() || this.sandboxes == null) {
    return 0;
  }
  const candidates = this.repo.IdleSandboxRunIDs(new Date(now.getTime() - idleFailedRunContainerTTL), new Date(now.getTime() - idleWaitingRunContainerTTL));
  if (candidates.length === 0) {
    return 0;
  }
  const discarded = {};
  // 进程内句柄持有工作区 flock，下面的 docker 扫描会视其为忙碌，所以先释放这些运行。
  for (const runID of candidates) {
    const held = this.runEnvs[runID] != null;
    if (held && this.discardIdleRunContainer(ctx, runID, now)) {
      discarded[runID] = true;
    }
  }
  const [withContainer, err] = this.sandboxes.RunsWithIdleDockerSandbox(ctx, candidates);
  if (err != null) {
    console.log(`list idle run sandboxes: ${err}`);
  }
  for (const runID of withContainer) {
    if (discarded[runID]) {
      continue;
    }
    if (this.discardIdleRunContainer(ctx, runID, now)) {
      discarded[runID] = true;
    }
  }
  return Object.keys(discarded).length;
};

// discardIdleRunContainer 在 stateMu 下重读运行，Retry 与 Approve 翻回 running 前都持该锁。
// discardLocalSandbox 在运行迁到池执行机后移除本机沙箱容器；工作区保留供检查。
Engine.prototype.discardLocalSandbox = function (runID) {
  try {
    this.releaseRunEnvironment(runID, false);
  } catch (err) {
    console.log(`release local sandbox ${runID} after pool bind: ${err}`);
  }
  if (this.sandboxes != null) {
    this.sandboxes.DiscardRunContainer(null, runID);
  }
};

Engine.prototype.discardIdleRunContainer = function (ctx, runID, now) {
  const [run, ok] = this.repo.RunState(runID);
  // 保留预览对迁到执行机的运行的本地容器回收，同时保留活跃工作区操作与新的闲置截止期。
  const [meta, managed] = this.repo.WorkspaceCheckpoint(runID);
  if (managed && (meta.Error !== "" || (meta.LeaseUntil != null && meta.LeaseUntil.getTime() > now.getTime()) || (meta.FollowUp && now.getTime() < (meta.LastUsedAt ?? new Date(0)).getTime() + ConversationWorkspaceIdleTTL))) {
    return false;
  }
  if (this.WorkspaceActive != null && this.WorkspaceActive(run)) {
    return false;
  }
  if (!ok || !runContainerIdle(run, now) || this.foreignWorkspaceBind(run)) {
    return false;
  }
  try {
    this.releaseRunEnvironment(runID, false);
  } catch (err) {
    console.log(`release idle run sandbox ${runID}: ${err}`);
  }
  this.sandboxes.DiscardRunContainer(ctx, runID);
  return true;
};

function runContainerIdle(run, now) {
  if (run.WorkspaceCleanedAt != null) {
    return false;
  }
  switch (run.Status) {
    case "failed":
      if (run.UpdatedAt.getTime() > now.getTime() - idleFailedRunContainerTTL) {
        return false;
      }
      break;
    case "waiting":
      if (run.UpdatedAt.getTime() > now.getTime() - idleWaitingRunContainerTTL) {
        return false;
      }
      break;
    default:
      return false;
  }
  for (const node of Object.values(run.Nodes)) {
    if (node != null && (node.Status === "running" || node.Status === "pending_input")) {
      return false;
    }
  }
  return true;
}

// settleOrphan 把无主运行及其在途节点标记为失败。updateRun 已在 stateMu 上串行化并发布新快照。
Engine.prototype.settleOrphan = function (runID, reason) {
  this.stopRunScheduler(runID);
  const status = orphanSettleStatus(reason);
  this.updateRun(runID, (r) => {
    const now = new Date();
    for (const nr of Object.values(r.Nodes)) {
      if (nr.Status === "running" || nr.Status === "pending_input" || (status === "cancelled" && nr.Status === "waiting_approval")) {
        if (status === "cancelled") {
          nr.Status = "cancelled";
          nr.Error = "";
          nr.FinishedAt = now;
          nr.Activity = "已由用户取消";
        } else {
          nr.Status = "failed";
          nr.Error = reason;
          nr.FinishedAt = now;
        }
      }
    }
    r.Status = status;
    this.event(r, "", "run." + status, reason);
  });
  if (status === "cancelled") {
    this.cleanupRunWorkspace(runID);
  }
};

function isLiveStatus(status) {
  return status === "running" || status === "waiting";
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

module.exports = { WorkspaceRunID, runContainerIdle, isLiveStatus, idleFailedRunContainerTTL, idleWaitingRunContainerTTL };
