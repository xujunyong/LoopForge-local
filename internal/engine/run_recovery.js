// run_recovery.js —— 对应 Go 文件：internal/engine/run_recovery.go
// 作用：中断恢复：租约认领、过期运行接管、排空与调度器重建。
// context.Context 译为 AbortSignal；goroutine 译为不 await 的异步函数；sync.Mutex 在单线程 JS 里不需要；time.Duration 换算为毫秒；(值, error) 译为成功返回值、失败 throw；(值, bool) 译为 [值, bool]；errors.Is 译为 ===；log.Printf 译为 console.log。

"use strict";

const { TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TelemetryEvent，run.js 已翻译
const { ErrRunLeaseLost, ErrRunLeaseHeld } = require("../repo/repo.js"); // 对应 Go 的 repo.ErrRunLeaseLost/ErrRunLeaseHeld，repo.js 已翻译
const { Engine, ErrExecutionDisabled } = require("./engine.js"); // 对应 Go 同包的 Engine/ErrExecutionDisabled，engine.js 已翻译

Engine.prototype.ownsRun = function (r) {
  const instanceID = this.instanceID;
  const enabled = this.executeRuns;
  return enabled && r.OwnerInstanceID === instanceID && r.Generation > 0 && r.LeaseUntil != null && r.LeaseUntil.getTime() > Date.now();
};

Engine.prototype.foreignWorkspaceBind = function (r) {
  const [host, root] = this.workspaceBind(r);
  const boundRoot = root.trim();
  if (boundRoot === "") {
    return false;
  }
  return boundRoot !== this.sandboxes.Root() || host !== this.workspaceHost;
};

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

Engine.prototype.workspaceLost = function (r) {
  return this.foreignWorkspaceBind(r) && !this.workspaceBlocked(r) && hasCodeWorkspace(r);
};

Engine.prototype.workspaceLostMessage = function (r) {
  const [host, root] = this.workspaceBind(r);
  if (sharesWorkspace(r)) {
    return `父流程工作区所在机器 ${host}:${root} 已下线，之前节点的代码改动随之丢失，请从头重跑父流程`;
  }
  return `工作区所在机器 ${host}:${root} 已下线，之前节点的代码改动随之丢失，请从头重跑`;
};

Engine.prototype.acquireLease = function (r) {
  const instanceID = this.instanceID;
  const ttl = this.leaseTTL;
  const enabled = this.executeRuns;
  const draining = this.draining;
  if (!enabled || draining) {
    throw ErrExecutionDisabled;
  }
  const leaseErr = this.repo.TryAcquireRunLease(r.ID, instanceID, r.Generation, ttl);
  if (leaseErr != null) {
    throw leaseErr;
  }
  const [current, ok] = this.repo.RunState(r.ID);
  if (!ok) {
    throw new Error("run not found");
  }
  return current;
};

Engine.prototype.renewRunLease = async function (runID, generation) {
  const instanceID = this.instanceID;
  const ttl = this.leaseTTL;
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(1000);
    }
    try {
      last = this.repo.RenewRunLease(runID, instanceID, generation, ttl);
    } catch (err) {
      last = err;
    }
    if (last == null) {
      return;
    }
    if (last === ErrRunLeaseLost || last === ErrRunLeaseHeld) {
      throw last;
    }
  }
  throw last;
};

// ResumeInterruptedRuns：接管上一个进程留在 live 状态的运行；进行中的节点重置为 pending，从最后一个持久检查点继续；停在人工门禁上的运行不动。
Engine.prototype.ResumeInterruptedRuns = function () {
  if (!this.executes()) {
    return null;
  }
  const resumed = [];
  let promoted = [];
  try {
    promoted = this.repo.PromoteQueuedRuns();
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
      this.cancelRunnerTasksForRun(r.ID);
      this.settleOrphan(r.ID, "运行已被手动终止");
      this.repo.ReleaseRunLease(r.ID, this.instanceID, acquired.Generation);
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
      this.cancelRunnerTasksForRun(r.ID);
      this.settleOrphan(r.ID, "运行已被手动终止");
      this.repo.ReleaseRunLease(r.ID, this.instanceID, acquired.Generation);
      continue;
    }
    if (r.PauseRequested || acquired.PauseRequested) {
      this.cancelRunnerTasksForRun(r.ID);
      this.pauseAt(r.ID, acquired.Generation, "运行已由用户暂停");
      this.repo.ReleaseRunLease(r.ID, this.instanceID, acquired.Generation);
      continue;
    }
    if (blocked) {
      this.repo.ReleaseRunLease(r.ID, this.instanceID, acquired.Generation);
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
      this.repo.ReleaseRunLease(r.ID, this.instanceID, acquired.Generation);
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

// RecoverInterruptedRuns：保留旧名，供仍引用它的调用方使用。
Engine.prototype.RecoverInterruptedRuns = function () {
  return this.ResumeInterruptedRuns();
};

Engine.prototype.ActiveRunCount = function () {
  return Object.keys(this.running).length;
};

// Drain：停止认领工作并停放在途运行，等替换 worker 接管；等 CodeBuddy 节点跑完会超过 systemd TimeoutStopSec，被 SIGKILL 中断执行。
Engine.prototype.Drain = async function (ctx) {
  this.draining = true;
  const instanceID = this.instanceID;
  const cancels = [];
  for (const cancel of Object.values(this.running)) {
    if (cancel != null) {
      cancels.push(cancel);
    }
  }
  this.repo.DeleteEngineInstance(instanceID);
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

Engine.prototype.claimRunning = function (runID, cancel) {
  if (this.running[runID] !== undefined) {
    return false;
  }
  this.running[runID] = cancel;
  return true;
};

Engine.prototype.clearRunning = function (runID) {
  delete this.running[runID];
};

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

Engine.prototype.runControlRequested = function (runID) {
  return this.repo.RunControlRequested(runID);
};

// sleep：等满毫秒，对应 Go 的 time.Sleep。
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// sleepOrAbort：等满毫秒或等到 ctx 取消，对应 Go 的 time.NewTicker + select。
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
