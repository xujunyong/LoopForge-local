/**
 * @file internal/engine/run_recovery.js
 * 对应 Go 源文件：internal/engine/run_recovery.go
 *
 * 作用与职责边界：
 * 实现引擎的中断恢复与租约生命周期管理，包括运行归属判定、跨宿主机工作区绑定检查与丢失识别、
 * 分布式执行租约认领/续期、进程重启或租约过期后的中断运行接管与排队运行晋升、
 * 优雅排空（Drain）以及调度器槽位占领/释放与延迟重建。
 * 不负责节点内部执行循环与运行状态持久化写入细节（见 `run_state.js` 等文件）。
 *
 * 语法差异说明：
 * - `Engine` 定义于 `engine.js`，本文件通过 `Engine.prototype` 挂载各恢复与租约方法。
 * - Go 的 `context.Context` 译为 `AbortSignal`；`goroutine` 译为不 `await` 的异步函数调用；
 *   单线程 JS 不需要 `sync.Mutex`，相关加解锁语句直接略去。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；
 *   Go 中用 `_ = ...` 显式忽略的错误在 JS 中以 `try { ... } catch {}` 吸收；`(值, bool)` 译为 `[值, boolean]`。
 * - Go 的 `time.Duration` 换算为毫秒数；`errors.Is` 译为 `===`；`log.Printf` 译为 `console.log`。
 */

"use strict";

const { TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TelemetryEvent，run.js 已翻译
const { ErrRunLeaseLost, ErrRunLeaseHeld } = require("../repo/repo.js"); // 对应 Go 的 repo.ErrRunLeaseLost/ErrRunLeaseHeld，repo.js 已翻译
const { Engine, ErrExecutionDisabled } = require("./engine.js"); // 对应 Go 同包的 Engine/ErrExecutionDisabled，engine.js 已翻译
const { hasCodeWorkspace, sharesWorkspace } = require("./workspace_owner.js"); // 对应 Go 同包函数，workspace_owner.js 已翻译
const { alignRunWaitingApproval, autoSucceedAlignApprovals } = require("./align.js"); // 对应 Go 同包函数，align.js 已翻译
const { settleStatusForCompletedGraph, scheduledIntegratePending, resetInFlightNodesForResume } = require("./lifecycle.js"); // 对应 Go 同包函数，lifecycle.js 已翻译
const { workflowForRun } = require("./workflow_graph.js"); // 对应 Go 同包函数，workflow_graph.js 已翻译

/**
 * 判断当前引擎实例是否持有指定运行的未过期执行租约。
 * 用于状态写入前校验与调度器启动前的归属检查。
 *
 * @param {import("../domain/run.js").Run} r - 待检查的运行快照对象。
 * @returns {boolean} 当前实例已启用执行、归属一致、代次大于 0 且租约未过期时返回 `true`，否则返回 `false`。
 */
Engine.prototype.ownsRun = function (r) {
  const instanceID = this.instanceID;
  const enabled = this.executeRuns;
  return enabled && r.OwnerInstanceID === instanceID && r.Generation > 0 && r.LeaseUntil != null && r.LeaseUntil.getTime() > Date.now();
};

/**
 * 判断运行是否已绑定到当前引擎实例无法服务的 `(宿主机, 工作区根目录)` 组合。
 * 只要原宿主机仍存活，该运行就留在原处，避免丢弃在途节点尚未推送到远端分支的代码改动。
 *
 * @param {import("../domain/run.js").Run} r - 待检查的运行快照对象。
 * @returns {boolean} 已绑定且工作区根目录或宿主机与当前实例不一致时返回 `true`，否则返回 `false`。
 */
Engine.prototype.foreignWorkspaceBind = function (r) {
  const [host, root] = this.workspaceBind(r);
  const boundRoot = root.trim();
  if (boundRoot === "") {
    return false;
  }
  return boundRoot !== this.sandboxes.Root() || host !== this.workspaceHost;
};

/**
 * 判断跨实例工作区绑定当前是否仍须保留而不能被本实例接管。
 * 当绑定宿主机是本机（不同工作区根目录的另一进程）、绑定宿主机上仍有存活 worker，或运行绑定了默认执行机时返回 `true`。
 *
 * @param {import("../domain/run.js").Run} r - 待检查的运行快照对象。
 * @returns {boolean} 外部工作区绑定仍受保护、禁止接管时返回 `true`，否则返回 `false`。
 */
Engine.prototype.workspaceBlocked = function (r) {
  if (!this.foreignWorkspaceBind(r)) {
    return false;
  }
  const [host] = this.workspaceBind(r);
  if (host === this.workspaceHost || this.repo.WorkspaceHostAlive(host)) {
    return true;
  }
  return this.defaultExecutionRunner(r) !== "";
};

/**
 * 判断运行是否处于“绑定宿主机已下线且本地工作区存有代码改动”的不可恢复丢失状态。
 * 节点不会推送中间提交，因此宿主机下线会导致代码改动丢失；不含代码仓库的运行仍可接管。
 *
 * @param {import("../domain/run.js").Run} r - 待检查的运行快照对象。
 * @returns {boolean} 外部绑定宿主机已失联且运行持有代码工作区时返回 `true`，否则返回 `false`。
 */
Engine.prototype.workspaceLost = function (r) {
  return this.foreignWorkspaceBind(r) && !this.workspaceBlocked(r) && hasCodeWorkspace(r);
};

/**
 * 构造工作区宿主机下线导致的孤儿运行结算提示文案。
 * 根据运行是否与父流程共享工作区区分主流程与子流程提示。
 *
 * @param {import("../domain/run.js").Run} r - 工作区已丢失的运行快照对象。
 * @returns {string} 包含原宿主机与工作区路径的中文错误提示文案。
 */
Engine.prototype.workspaceLostMessage = function (r) {
  const [host, root] = this.workspaceBind(r);
  if (sharesWorkspace(r)) {
    return `父流程工作区所在机器 ${host}:${root} 已下线，之前节点的代码改动随之丢失，请从头重跑父流程`;
  }
  return `工作区所在机器 ${host}:${root} 已下线，之前节点的代码改动随之丢失，请从头重跑`;
};

/**
 * 为当前引擎实例原子抢占指定运行的执行租约，并返回抢占后落库的最新运行状态。
 * 用于恢复中断运行、处理跨进程取消/暂停以及工作区调度器重新接管。
 *
 * @param {import("../domain/run.js").Run} r - 拟抢占租约的运行快照对象（需包含 `ID` 与期望 `Generation`）。
 * @returns {import("../domain/run.js").Run} 抢占成功后从仓储重新读取的最新运行状态。
 * @throws {Error} 引擎禁用执行/正在排空（`ErrExecutionDisabled`）、租约已被占用或运行不存在时抛出错误。
 */
Engine.prototype.acquireLease = function (r) {
  const instanceID = this.instanceID;
  const ttl = this.leaseTTL;
  const enabled = this.executeRuns;
  const draining = this.draining;
  if (!enabled || draining) {
    throw ErrExecutionDisabled;
  }
  this.repo.TryAcquireRunLease(r.ID, instanceID, r.Generation, ttl);
  const [current, ok] = this.repo.RunState(r.ID);
  if (!ok) {
    throw new Error("run not found");
  }
  return current;
};

/**
 * 为正在执行的运行续期分布式租约，遇到瞬时错误时最多重试 3 次（间隔 1 秒）。
 * 若仓储明确返回租约丢失或被其他实例持有，则立即停止重试并抛出该错误。
 *
 * @param {string} runID - 运行唯一标识。
 * @param {number} generation - 当前持有的租约代次。
 * @returns {Promise<void>} 续期成功时正常返回，无返回值。
 * @throws {Error} 租约丢失/被占或 3 次重试均失败时抛出最后一次错误。
 */
Engine.prototype.renewRunLease = async function (runID, generation) {
  const instanceID = this.instanceID;
  const ttl = this.leaseTTL;
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(1000);
    }
    try {
      this.repo.RenewRunLease(runID, instanceID, generation, ttl);
      return;
    } catch (err) {
      last = err;
    }
    if (last === ErrRunLeaseLost || last === ErrRunLeaseHeld) {
      throw last;
    }
  }
  throw last;
};

/**
 * 重新接管上一个进程遗留在活跃状态的运行，并先尝试晋升排队中的运行。
 * 进行中的节点会被重置为 `pending` 以便从最近持久化检查点继续执行；停在人工审批门禁的运行保持不动（除自动通过的基线对齐或已请求取消的运行）。
 *
 * @returns {string[]|null} 本轮成功恢复调度执行的运行 ID 列表；引擎未启用执行或正在排空时返回 `null`。
 */
Engine.prototype.ResumeInterruptedRuns = function () {
  if (!this.executes()) {
    return null;
  }
  const resumed = [];
  let promoted = [];
  try {
    promoted = this.repo.PromoteQueuedRuns() ?? [];
  } catch (err) {
    console.log(`promote queued runs: ${err}`);
  }
  for (const id of promoted) {
    this.publish(id);
  }
  for (const listed of this.repo.Runs()) {
    if (listed.IsWorkspace() || listed.HistoricalGroup()) {
      continue;
    }
    if (listed.Status === "waiting" && !listed.CancelRequested && alignRunWaitingApproval(listed)) {
      const [r, ok] = this.repo.RunState(listed.ID);
      if (!ok || r.Status !== "waiting" || r.CancelRequested || !alignRunWaitingApproval(r)) {
        continue;
      }
      if (r.OwnerInstanceID !== "" && r.LeaseUntil != null && r.LeaseUntil.getTime() > Date.now()) {
        continue;
      }
      try {
        this.acquireLease(r);
      } catch {
        continue;
      }
      this.updateRun(r.ID, (current) => {
        if (autoSucceedAlignApprovals(current, new Date())) {
          this.event(current, "", "gate.auto_approved", "基线对齐无需人工确认，已自动通过");
        }
      });
      this.resume(r.ID);
      resumed.push(r.ID);
      continue;
    }
    if (listed.Status === "waiting" && listed.CancelRequested) {
      const [r, ok] = this.repo.RunState(listed.ID);
      if (!ok || r.Status !== "waiting" || !r.CancelRequested) {
        continue;
      }
      if (r.OwnerInstanceID !== "" && r.LeaseUntil != null && r.LeaseUntil.getTime() > Date.now()) {
        continue;
      }
      let acquired;
      try {
        acquired = this.acquireLease(r);
      } catch {
        continue;
      }
      try {
        this.cancelRunnerTasksForRun(r.ID);
      } catch {}
      this.settleOrphan(r.ID, "运行已被手动终止");
      try {
        this.repo.ReleaseRunLease(r.ID, this.instanceID, acquired.Generation);
      } catch {}
      continue;
    }
    if (listed.Status === "running") {
      const [fresh, ok] = this.repo.RunState(listed.ID);
      if (!ok || fresh.Status !== "running") {
        continue;
      }
      const [status, msg, done] = settleStatusForCompletedGraph(workflowForRun(this.repo, fresh), fresh);
      if (done && !(status === "succeeded" && scheduledIntegratePending(fresh))) {
        this.finishAt(fresh.ID, fresh.Generation, status, msg);
        continue;
      }
    }
    if (listed.Status !== "running") {
      continue;
    }
    const [r, ok] = this.repo.RunState(listed.ID);
    if (!ok || r.Status !== "running") {
      continue;
    }
    if (r.OwnerInstanceID !== "" && r.LeaseUntil != null && r.LeaseUntil.getTime() > Date.now()) {
      continue;
    }
    const live = this.running[r.ID] !== undefined;
    if (live) {
      continue;
    }
    const blocked = this.workspaceBlocked(r);
    if (blocked && !r.CancelRequested && !r.PauseRequested) {
      continue;
    }
    const previousOwner = r.OwnerInstanceID;
    let acquired;
    try {
      acquired = this.acquireLease(r);
    } catch {
      continue;
    }
    if (r.CancelRequested || acquired.CancelRequested) {
      try {
        this.cancelRunnerTasksForRun(r.ID);
      } catch {}
      this.settleOrphan(r.ID, "运行已被手动终止");
      try {
        this.repo.ReleaseRunLease(r.ID, this.instanceID, acquired.Generation);
      } catch {}
      continue;
    }
    if (r.PauseRequested || acquired.PauseRequested) {
      try {
        this.cancelRunnerTasksForRun(r.ID);
      } catch {}
      this.pauseAt(r.ID, acquired.Generation, "运行已由用户暂停");
      try {
        this.repo.ReleaseRunLease(r.ID, this.instanceID, acquired.Generation);
      } catch {}
      continue;
    }
    if (blocked) {
      try {
        this.repo.ReleaseRunLease(r.ID, this.instanceID, acquired.Generation);
      } catch {}
      continue;
    }
    if (this.workspaceLost(acquired)) {
      const message = this.workspaceLostMessage(acquired);
      if (!sharesWorkspace(acquired)) {
        try {
          this.rebindWorkspaceHere(acquired, true);
        } catch (err) {
          console.log(`rebind lost workspace ${r.ID}: ${err}`);
        }
      }
      this.settleOrphan(r.ID, message);
      try {
        this.repo.ReleaseRunLease(r.ID, this.instanceID, acquired.Generation);
      } catch {}
      continue;
    }
    this.updateRun(r.ID, (current) => {
      resetInFlightNodesForResume(current, "执行实例退出，等待恢复");
      current.Status = "running";
      this.event(current, "", "run.resumed", `服务恢复后继续执行（generation=${acquired.Generation}, previousOwner=${previousOwner}）`);
    });
    this.observe(r.ID, "", new TelemetryEvent({ Category: "orchestration", Name: "run.resumed", Phase: "start", Message: "过期执行租约已接管", Attributes: { generation: acquired.Generation, previousOwner: previousOwner } }));
    this.resume(r.ID);
    resumed.push(r.ID);
  }
  return resumed;
};

/**
 * `ResumeInterruptedRuns` 的历史别名，供仍引用旧方法名的调用方与测试使用。
 *
 * @returns {string[]|null} 本轮成功恢复的运行 ID 列表；引擎未启用执行时返回 `null`。
 */
Engine.prototype.RecoverInterruptedRuns = function () {
  return this.ResumeInterruptedRuns();
};

/**
 * 返回当前引擎进程内正在调度的活跃运行数量。
 * 用于优雅排空等待与监控指标查询。
 *
 * @returns {number} 活跃运行数量。
 */
Engine.prototype.ActiveRunCount = function () {
  return Object.keys(this.running).length;
};

/**
 * 停止认领新任务并主动取消当前进程内的在途运行，使其在租约释放后由替换 worker 接管。
 * 轮询等待所有活跃运行退出或 `ctx` 超时/取消，结束前分离全部运行环境。
 *
 * @param {AbortSignal|null} ctx - 控制排空等待上限的取消信号。
 * @returns {Promise<void>} 全部活跃运行退出后正常返回，无返回值。
 * @throws {Error} 等待期间 `ctx` 触发中止时抛出 `ctx.reason`。
 */
Engine.prototype.Drain = async function (ctx) {
  this.draining = true;
  const instanceID = this.instanceID;
  const cancels = [];
  for (const cancel of Object.values(this.running)) {
    if (cancel != null) {
      cancels.push(cancel);
    }
  }
  try {
    this.repo.DeleteEngineInstance(instanceID);
  } catch {}
  for (const cancel of cancels) {
    cancel();
  }
  for (;;) {
    if (this.ActiveRunCount() === 0) {
      this.detachAllRunEnvironments();
      return;
    }
    try {
      await sleepOrAbort(ctx, 100);
    } catch {
      this.detachAllRunEnvironments();
      throw ctx.reason;
    }
  }
};

/**
 * 在内存活跃运行表中登记指定运行的取消函数，防止同一运行并发启动两个调度循环。
 *
 * @param {string} runID - 运行唯一标识。
 * @param {Function} cancel - 用于中止该运行调度上下文的取消回调。
 * @returns {boolean} 登记成功返回 `true`；若该运行已在调度中则返回 `false`。
 */
Engine.prototype.claimRunning = function (runID, cancel) {
  if (this.running[runID] !== undefined) {
    return false;
  }
  this.running[runID] = cancel;
  return true;
};

/**
 * 从内存活跃运行表中移除指定运行的调度槽位。
 * 在调度循环 `execute` 退出清理时调用。
 *
 * @param {string} runID - 运行唯一标识。
 * @returns {void} 无返回值。
 */
Engine.prototype.clearRunning = function (runID) {
  delete this.running[runID];
};

/**
 * 为已处于 `running` 且归属当前实例的运行启动异步调度循环 `execute`。
 * 若旧调度器仍在收尾占槽，则启动后台轮询 `resumeAfterSchedulerRelease` 在槽位释放后重试恢复。
 *
 * @param {string} runID - 运行唯一标识。
 * @returns {void} 无返回值。
 */
Engine.prototype.resume = function (runID) {
  const [current, ok] = this.repo.RunState(runID);
  if (!ok || current.Status !== "running" || !this.ownsRun(current)) {
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (!this.claimRunning(runID, cancel)) {
    cancel();
    this.resumeAfterSchedulerRelease(runID);
    return;
  }
  this.execute(controller.signal, runID);
};

/**
 * 在控制指令紧随取消之后立即重开运行时，轮询等待旧调度器释放内存槽位后再调用 `resume`。
 * 最长等待时间为当前引擎的 `leaseTTL`，避免持久化处于 `running` 状态的运行失去调度器。
 *
 * @param {string} runID - 运行唯一标识。
 * @returns {Promise<void>} 槽位释放完成重调度或超时后结束，无返回值。
 */
Engine.prototype.resumeAfterSchedulerRelease = async function (runID) {
  const deadline = Date.now() + this.leaseTTL;
  for (;;) {
    await sleep(20);
    if (Date.now() >= deadline) {
      return;
    }
    if (this.isRunSchedulerActive(runID)) {
      continue;
    }
    const [current, ok] = this.repo.RunState(runID);
    if (ok && current.Status === "running") {
      if (current.IsWorkspace() && !this.ownsRun(current)) {
        try {
          this.acquireLease(current);
        } catch {
          return;
        }
      }
      if (this.ownsRun(current)) {
        this.resume(runID);
      }
    }
    return;
  }
};

/**
 * 查询仓储中该运行是否收到了取消或暂停控制请求。
 *
 * @param {string} runID - 运行唯一标识。
 * @returns {boolean} 存在未处理的取消或暂停请求时返回 `true`，否则返回 `false`。
 */
Engine.prototype.runControlRequested = function (runID) {
  return this.repo.RunControlRequested(runID);
};

/**
 * 异步等待指定毫秒数，对应 Go 的 `time.Sleep`。
 *
 * @param {number} ms - 等待时长（毫秒）。
 * @returns {Promise<void>} 到时后兑现，无返回值。
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等待指定毫秒数或直到取消信号触发，对应 Go 的 `time.NewTicker` 搭配 `select <-ctx.Done()`。
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
