/**
 * @file internal/engine/workspace_cleanup.js
 * 对应 Go 源文件：internal/engine/workspace_cleanup.go
 *
 * 作用与职责边界：
 * 实现运行工作区路径与事实查询、预览归档排队与取消、后台沙箱定时清扫（`sandboxSweep`）、
 * 终态工作区清理、空闲容器回收、运行显式删除及孤儿运行结算；
 * `Engine` 相关方法挂载于 `Engine.prototype`（`Engine` 定义于 `engine.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；`(值, bool)` 译为 `[值, boolean]`。
 * - Go 的 `time.Time` 零值译为 `null`；`time.Duration` 换算为毫秒数；`sync.Mutex` 在单线程 JS 中省略。
 * - Go 的 `time.NewTicker` + `select` 译为 `async` 配合 `sleepOrAbort` 定时器循环；`defer` 译为 `try ... finally`。
 * - Go 的 `log.Printf` 译为 `console.log`；`context.Background()` 译为 `null`；`map[string]bool` 与 `map[string]struct{}` 均译为普通对象 `{}`。
 */

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { RunnerWorkspaceFacts, RunnerTaskFailed, RunnerTaskCanceled, RunnerTaskActionArchivePreview } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerWorkspaceFacts/RunnerTaskFailed/RunnerTaskCanceled/RunnerTaskActionArchivePreview，runner.js 已翻译
const { RunnerWorkspaceRequest, RunnerWorkspaceOperationReclaim } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspaceRequest/RunnerWorkspaceOperationReclaim，runner_workspace.js 已翻译
const { RunnerSandbox } = require("../domain/assets.js"); // 对应 Go 的 domain.RunnerSandbox，assets.js 已翻译
const { workspaceRunID } = require("./workspace_owner.js"); // 对应 Go 同包函数，workspace_owner.js 已翻译
const { safeRunnerPath } = require("./runner_dispatch.js"); // 对应 Go 同包函数，runner_dispatch.js 已翻译
const { ConversationWorkspaceIdleTTL } = require("./conversation_workspace.js"); // 对应 Go 同包常量，conversation_workspace.js 已翻译
const { orphanSettleStatus } = require("./lifecycle.js"); // 对应 Go 同包函数，lifecycle.js 已翻译

/**
 * 查询指定运行在本地沙箱管理器中对应的工作区目录路径；若运行存在，优先解析其实际归属的工作区运行 ID（子 SOP 跟随父运行）。
 * 使用场景：本地文件浏览、产物检查或预览构建需要定位运行工作区目录时调用。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @returns {string} 本地工作区根目录路径；沙箱管理器未初始化时返回空字符串 `""`。
 */
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

/**
 * 返回 `run` 实际执行所在的工作区归属运行 ID；子 SOP 共享发起该 SOP 链的父运行检出目录。
 * 使用场景：对外暴露工作区归属查询（委托同包 `workspaceRunID`）。
 *
 * @param {object} run - 运行快照对象（`domain.Run`）。
 * @returns {string} 持有工作区目录的运行 ID。
 */
function WorkspaceRunID(run) {
  return workspaceRunID(run);
}

/**
 * 返回执行机最近一次上报的运行工作区事实信息；当 `ok` 为 `false` 时，引擎需自行检查本地 `RunWorkspace`。
 * 使用场景：读取执行机回传的仓库状态或工作区元信息。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @returns {[RunnerWorkspaceFacts, boolean]} 找到时返回 `[facts, true]`，否则返回 `[空 RunnerWorkspaceFacts, false]`。
 */
Engine.prototype.RunWorkspaceFacts = function (runID) {
  const facts = this.workspaceFacts[runID];
  if (facts == null) {
    return [new RunnerWorkspaceFacts(), false];
  }
  return [facts, true];
};

/**
 * 记录执行机任务输出中附带的工作区事实信息。
 * 使用场景：执行机任务上报或结束回写输出时更新内存缓存。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {object|null} outputs - 执行机任务输出（`domain.RunnerTaskOutputs`）。
 * @returns {void} 无返回值。
 */
Engine.prototype.recordWorkspaceFacts = function (runID, outputs) {
  if (outputs == null || outputs.Facts == null) {
    return;
  }
  this.workspaceFacts[runID] = outputs.Facts;
};

/**
 * 为指定运行在执行机侧排队一次预览产物归档任务。
 * 使用场景：预览服务需要从远端执行机拉取构建产物时调用。
 *
 * @param {object} run - 运行快照对象（`domain.Run`）。
 * @param {object} spec - 预览归档规格（`domain.RunnerPreviewArchiveSpec`）。
 * @returns {void} 无返回值。
 * @throws {Error} 排队执行机任务失败时抛出错误。
 */
Engine.prototype.QueuePreviewArchive = function (run, spec) {
  this.queueRunnerPreviewArchive(run, spec);
};

/**
 * 取消指定运行下全部仍处于活跃状态的预览归档执行机任务，并通知执行机控制通道。
 * 使用场景：运行取消、删除或预览构建被替代时中止冗余归档任务。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @returns {void} 无返回值。
 */
Engine.prototype.CancelPreviewArchive = function (runID) {
  let tasks;
  try {
    tasks = this.repo.ActiveRunnerTasksForRun(runID);
  } catch (err) {
    console.log(`list preview archive tasks ${runID}: ${err}`);
    return;
  }
  const now = new Date();
  for (const task of tasks) {
    if (task.Action !== RunnerTaskActionArchivePreview) {
      continue;
    }
    try {
      this.repo.CancelRunnerTask(task.ID, now);
    } catch (cancelErr) {
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

/**
 * 触发指定运行的工作区清理流程。
 * 使用场景：外部模块主动请求释放已完成或已取消运行的工作区。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @returns {void} 无返回值。
 */
Engine.prototype.ReleaseWorkspace = function (runID) {
  this.cleanupRunWorkspace(runID);
};

/**
 * 引擎后台定时清扫循环：每 20 秒清理过期分块传输、恢复漏掉的预览归档与终结器、推进终态工作区清理并回收闲置沙箱与镜像缓存；
 * 当 `ctx` 取消时关闭分块传输管理器并退出。
 * 使用场景：由 `Engine.Start` 作为后台守护协程启动。
 *
 * @param {AbortSignal|null} ctx - 引擎生命周期取消信号。
 * @returns {Promise<void>} 无返回值。
 */
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
    await this.reconcileTerminalWorkspaceCleanup();
    this.reclaimSandboxes();
  }
};

/**
 * 扫描所有待清理的终态运行与受快照管理的工作区运行，去重后逐一执行工作区清理。
 * 使用场景：由 `sandboxSweep` 周期性调用。
 *
 * @returns {Promise<void>} 无返回值。
 */
Engine.prototype.reconcileTerminalWorkspaceCleanup = async function () {
  const now = new Date();
  const seen = {};
  for (const run of this.repo.TerminalWorkspaceCleanupRuns()) {
    seen[run.ID] = true;
    await this.cleanupWorkspace(run, now);
  }
  for (const id of this.repo.CheckpointWorkspaceRunIDs()) {
    if (!seen[id]) {
      const [run, ok] = this.repo.RunState(id);
      if (ok) {
        await this.cleanupWorkspace(run, now);
      }
    }
  }
};

/**
 * 补救已完成预览构建却尚未写入预览记录的运行（例如运行仍停在后续审批门禁或进程在排队归档前重启）。
 * 必须在成功运行清理之前执行，避免误从空的控制面目录判断执行机工作区而跳过归档。
 *
 * @returns {void} 无返回值。
 */
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
    try {
      this.preview.ArchiveBuiltPreview(run);
    } catch {}
  }
};

/**
 * 补救运行已持久化为 `succeeded`、但 `BeginFinalization` 尚未写入预览记录和清理保留标记前的崩溃窗口。
 * 清扫循环必须在终态工作区清理之前调用此方法。
 *
 * @returns {void} 无返回值。
 */
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
    try {
      this.preview.BeginFinalization(run);
    } catch {}
  }
};

/**
 * 按运行 ID 读取最新状态并以当前时刻触发 `cleanupWorkspace`。
 * 使用场景：孤儿取消结算或外部调用 `ReleaseWorkspace` 时触发单次清理。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @returns {Promise<void>} 无返回值。
 */
Engine.prototype.cleanupRunWorkspace = async function (runID) {
  const [run, ok] = this.repo.RunState(runID);
  if (!ok) {
    return;
  }
  await this.cleanupWorkspace(run, new Date());
};

/**
 * 执行单次运行的工作区清理：先处理受快照管理的对话工作区空闲保存与认领，
 * 再对已标记清理的执行机任务做重试补偿，最后认领清理权并释放跨宿主/本地/执行机三类工作区环境。
 * 使用场景：由 `reconcileTerminalWorkspaceCleanup` 或 `cleanupRunWorkspace` 调用。
 *
 * @param {object} run - 待清理的运行快照（`domain.Run`）。
 * @param {Date} now - 当前清理判定时刻。
 * @returns {Promise<void>} 无返回值。
 */
Engine.prototype.cleanupWorkspace = async function (run, now) {
  let managed = false;
  let checkpointClaimed = false;
  let releaseCheckpoint = null;
  let checkpointErr = null;
  try {
    [managed, checkpointClaimed, releaseCheckpoint] = await this.claimIdleConversationWorkspace(run, now);
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
          try {
            this.repo.ResetRunWorkspaceCleanup(run.ID);
          } catch {}
        }
        return;
      }
      if (task.Status === RunnerTaskFailed || task.Status === RunnerTaskCanceled) {
        try {
          this.repo.ResetRunWorkspaceCleanup(run.ID);
        } catch {}
      }
      return;
    }
    let claimed = checkpointClaimed;
    if (!managed) {
      try {
        claimed = this.repo.ClaimRunWorkspaceCleanup(run.ID, now);
      } catch (claimErr) {
        console.log(`claim terminal workspace cleanup ${run.ID}: ${claimErr}`);
        return;
      }
    }
    if (!claimed) {
      return;
    }
    const reset = (cleanupErr) => {
      console.log(`cleanup terminal workspace ${run.ID}: ${cleanupErr}`);
      try {
        this.repo.ResetRunWorkspaceCleanup(run.ID);
      } catch (resetErr) {
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
        const response = await this.requestWorkspaceCheckpoint(checkpointController.signal, run, new RunnerWorkspaceRequest({ RunID: run.ID, Operation: RunnerWorkspaceOperationReclaim, CheckpointLease: meta.LeaseToken }));
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

/**
 * 汇总当前所有受保护、不可被底层孤儿目录与容器清扫回收的运行 ID 列表，
 * 包含活跃运行、未清理的共享助手会话工作区以及未清理的快照受管工作区。
 * 使用场景：由 `reclaimSandboxes` 在执行目录与 Docker 容器回收前构建白名单。
 *
 * @returns {string[]} 受保护的运行 ID 数组。
 */
Engine.prototype.liveSandboxRunIDs = function () {
  const ids = this.repo.LiveSandboxRunIDs();
  const seen = {};
  for (const id of ids) {
    seen[id] = true;
  }
  // 未回收的受管工作区（包括保存失败的）不受下层孤儿目录/容器清扫影响。
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

/**
 * 当同一议题已有新的同工作流分派取代旧尝试时，释放早前已结算运行的本地沙箱容器（保留工作区目录供排查）。
 * 使用场景：议题重新从头分派工作流后，回收历史失败运行残留的大体积容器可写层。
 *
 * @param {string} issueID - 议题 ID。
 * @param {string} keepRunID - 需要保留的新运行 ID。
 * @returns {void} 无返回值。
 */
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
    // 同一议题的另一条 SOP 不会取代本运行；它仍可能被重试。
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

/**
 * 释放并销毁指定运行的本地沙箱环境及工作区目录，错误仅记日志不向上抛出。
 * 使用场景：需要直接清理单个运行沙箱的内部路径。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @returns {void} 无返回值。
 */
Engine.prototype.destroySandbox = function (runID) {
  try {
    this.releaseRunEnvironment(runID, true);
  } catch (err) {
    console.log(`destroy sandbox ${runID}: ${err}`);
  }
};

/**
 * 显式删除已结算的运行记录：先校验运行及节点均已停止、获取工作区使用租约并声明删除标记，
 * 再将关联任务结算为终态、删除预览、排队执行机清理、销毁本地沙箱，最后删除数据库中的运行记录。
 * 使用场景：用户在界面或 API 主动删除历史运行。
 *
 * @param {string} runID - 待删除的运行记录主键 ID。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 运行不存在、仍处于活跃状态、工作区正在使用或任一清理/删除步骤失败时抛出错误。
 */
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
    this.repo.ClaimWorkspaceDeletion(runID, token, run.Revision, new Date());
    // 先在持久 Task 上保留终态结果再删 Run，避免后续任务同步面对悬空 RunID 无法区分成功/失败与取消。
    this.settleDeletedRunTasks(run);
    if (this.preview != null) {
      try {
        this.preview.DeleteForRun(runID);
      } catch (previewErr) {
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
    this.repo.DeleteRun(runID);
  } finally {
    try {
      this.repo.FinishWorkspaceUse(runID, token, new Date(), null, "");
    } catch {}
  }
};

/**
 * 在删除运行记录前，将所有绑定到该运行（按 `RunID` 或 `ExecutionContext.TaskID` 匹配）的持久任务状态同步为对应终态。
 * 使用场景：由 `DeleteRun` 在删除运行前调用。
 *
 * @param {object} run - 待删除的运行快照（`domain.Run`）。
 * @returns {void} 无返回值。
 * @throws {Error} 更新任务状态失败时抛出错误。
 */
Engine.prototype.settleDeletedRunTasks = function (run) {
  const status = { succeeded: "completed", failed: "failed", cancelled: "cancelled" }[run.Status] ?? "";
  if (status === "") {
    return;
  }
  const contextTaskID = run.ExecutionContext.TaskID.trim();
  for (const task of this.repo.Tasks()) {
    if (task.RunID !== run.ID && (contextTaskID === "" || task.ID !== contextTaskID)) {
      continue;
    }
    if (task.Status === status) {
      continue;
    }
    try {
      this.repo.UpdateTaskStatus(task, status);
    } catch (err) {
      throw new Error(`settle task ${task.ID} before deleting run ${run.ID}: ${err.message}`);
    }
  }
};

/**
 * 按存活运行白名单依次回收孤儿沙箱目录、孤儿 Docker 容器、超期闲置的失败/等待运行容器以及不再使用的 Docker 镜像缓存标签。
 * 使用场景：由 `sandboxSweep` 周期性调用。
 *
 * @returns {void} 无返回值。
 */
Engine.prototype.reclaimSandboxes = function () {
  const live = this.liveSandboxRunIDs();
  try {
    const n = this.sandboxes.ReclaimExcept(live);
    if (n > 0) {
      console.log(`reclaimed ${n} finished sandbox workspace(s)`);
    }
  } catch (err) {
    console.log(`reclaim sandboxes: ${err}`);
  }
  // 容器寿命长于目录清扫：工作区已回收或运行已删除的容器仍持有大体积可写层，需显式 docker rm 释放。
  let containers;
  try {
    containers = this.sandboxes.ReclaimDockerSandboxes(null, live);
  } catch (containersErr) {
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
  let images;
  try {
    images = this.sandboxes.ReclaimCachedDockerImages(null, keep);
  } catch (imagesErr) {
    console.log(`reclaim cached docker images: ${imagesErr}`);
    return;
  }
  if (images > 0) {
    console.log(`reclaimed ${images} unused docker image cache tag(s)`);
  }
};

// 失败与等待运行为重试或人工审批保留工作区目录，但其容器闲置超过以下时长后将被回收以释放内存与可写层（毫秒）。
const idleFailedRunContainerTTL = 30 * 60 * 1000;
const idleWaitingRunContainerTTL = 2 * 60 * 60 * 1000;

/**
 * 扫描并回收已超过闲置阈值的失败/等待运行的本地 Docker 容器（工作区目录保留不变）。
 * 优先释放当前进程内持有句柄的运行，再扫描外部空闲 Docker 容器。
 * 使用场景：由 `reclaimSandboxes` 调用。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {Date} now - 当前判定时刻。
 * @returns {number} 本次实际回收的闲置容器数量。
 */
Engine.prototype.discardIdleRunContainers = function (ctx, now) {
  if (!this.executes() || this.sandboxes == null) {
    return 0;
  }
  const candidates = this.repo.IdleSandboxRunIDs(new Date(now.getTime() - idleFailedRunContainerTTL), new Date(now.getTime() - idleWaitingRunContainerTTL));
  if (candidates.length === 0) {
    return 0;
  }
  const discarded = {};
  // 进程内句柄持有工作区 flock，后续 docker 扫描会视其为忙碌，因此优先释放本进程持有的运行。
  for (const runID of candidates) {
    const held = this.runEnvs[runID] != null;
    if (held && this.discardIdleRunContainer(ctx, runID, now)) {
      discarded[runID] = true;
    }
  }
  let withContainer = [];
  try {
    withContainer = this.sandboxes.RunsWithIdleDockerSandbox(ctx, candidates);
  } catch (err) {
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

/**
 * 运行迁移到执行机池后移除本机残留的沙箱容器（保留本地工作区目录供检查）。
 * 使用场景：池执行机接管运行后清理控制面本地临时容器。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @returns {void} 无返回值。
 */
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

/**
 * 复核单个候选运行是否满足容器闲置回收条件（避开活跃租约、跟进保护期、活跃工作区及跨宿主绑定），
 * 满足时释放内存运行环境并销毁其 Docker 容器。
 * 使用场景：由 `discardIdleRunContainers` 逐个调用。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {string} runID - 运行记录主键 ID。
 * @param {Date} now - 当前判定时刻。
 * @returns {boolean} 实际执行了容器回收返回 `true`，跳过返回 `false`。
 */
Engine.prototype.discardIdleRunContainer = function (ctx, runID, now) {
  const [run, ok] = this.repo.RunState(runID);
  // 保留对迁往执行机运行的本地容器回收，同时保护活跃工作区操作与跟进闲置截止期。
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

/**
 * 判断指定运行的沙箱容器是否已处于可回收的闲置状态：工作区尚未清理、运行处于 `failed` 或 `waiting` 且超过对应 TTL，
 * 并且不存在 `running` 或 `pending_input` 的节点。
 * 使用场景：由 `discardIdleRunContainer` 校验回收前提。
 *
 * @param {object} run - 运行快照对象（`domain.Run`）。
 * @param {Date} now - 当前判定时刻。
 * @returns {boolean} 满足闲置回收条件返回 `true`，否则返回 `false`。
 */
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

/**
 * 将失去调度租约的无主运行及其在途节点结算为失败或已取消状态，并发布运行事件；若结算为已取消，立即触发工作区清理。
 * 使用场景：租约巡检发现孤儿运行或强制停止无主运行时调用。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} reason - 结算原因描述文本。
 * @returns {void} 无返回值。
 */
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

/**
 * 判断运行状态是否仍处于存活调度阶段（`running` 或 `waiting`）。
 * 使用场景：筛选存活运行与状态守卫。
 *
 * @param {string} status - 运行状态字符串。
 * @returns {boolean} 属于存活状态返回 `true`，否则返回 `false`。
 */
function isLiveStatus(status) {
  return status === "running" || status === "waiting";
}

/**
 * 等待指定毫秒数或直至 `ctx` 触发取消信号（对应 Go 的 `time.NewTicker`/`time.After` + `select`）。
 * 使用场景：供 `sandboxSweep` 实现可中断的定时循环。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {number} ms - 等待时长（毫秒）。
 * @returns {Promise<void>} 定时到达时正常兑现。
 * @throws {Error} 等待期间 `ctx` 取消时拒绝并抛出 `ctx.reason`。
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

module.exports = { WorkspaceRunID, runContainerIdle, isLiveStatus, idleFailedRunContainerTTL, idleWaitingRunContainerTTL };
