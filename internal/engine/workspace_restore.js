// workspace_restore.js —— 对应 Go 文件：internal/engine/workspace_restore.go
// 作用：工作区恢复：恢复状态查询与后台恢复。
// (值, error) 译为成功返回值、失败 throw；context.Context 译为 AbortSignal；goroutine 译为不 await 的异步函数；errors.Is 译为 ===；time.Time 零值译为 null；log.Printf 译为 console.log。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { WorkspaceRestoreStatus } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.WorkspaceRestoreStatus，runner_workspace.js 已翻译
const { ErrWorkspaceInUse } = require("../repo/workspace_checkpoints.js"); // 对应 Go 的 repo.ErrWorkspaceInUse，workspace_checkpoints.js 已翻译
const { WorkspaceRestoreInterrupted } = require("../repo/workspace_restore.js"); // 对应 Go 的 repo.WorkspaceRestoreInterrupted，workspace_restore.js 已翻译

// WorkspaceRestoreStatus 是持久的，刷新或另一 API 实例看到的是同一个后台恢复，不会启动竞争传输。
Engine.prototype.WorkspaceRestoreStatus = function (id) {
  // 先读租约再读运行。恢复在释放租约前清除运行的清理标记，所以已释放的租约绝不会配上陈旧的清理标记（那会被报成 "idle" 而非 "ready"）。
  const [meta] = this.repo.WorkspaceCheckpoint(id);
  const [run, ok] = this.repo.RunState(id);
  if (!ok) {
    throw new Error("run not found");
  }
  if (sharesWorkspace(run)) {
    return this.WorkspaceRestoreStatus(workspaceRunID(run));
  }
  const state = new WorkspaceRestoreStatus({ Status: "idle", StartedAt: meta.RestoreStarted });
  // 恢复在绑定工作区时清除清理标记，早于剩余工作完成。因此记录的结果优先于绑定：失败或中断的恢复绝不是 "ready"。
  if (meta.RestoreStatus === "restoring" && meta.LeaseUntil != null && meta.LeaseUntil.getTime() > Date.now()) {
    state.Status = "restoring";
  } else if (meta.RestoreStatus === "failed") {
    state.Status = "failed";
    state.Error = meta.RestoreError;
  } else if (meta.RestoreStatus === "restoring") {
    state.Status = "failed";
    state.Error = WorkspaceRestoreInterrupted;
  } else if (run.WorkspaceCleanedAt == null || meta.SavedAt == null) {
    state.Status = "ready";
  }
  return state;
};

// StartWorkspaceRestore 及时确认。有界的后台操作持有 DB 租约，直到恢复与绑定确认完成；关闭 HTTP 请求不能在执行机仍工作时释放它。
Engine.prototype.StartWorkspaceRestore = function (id) {
  const [run, ok] = this.repo.RunState(id);
  if (!ok) {
    throw new Error("run not found");
  }
  if (sharesWorkspace(run)) {
    return this.StartWorkspaceRestore(workspaceRunID(run));
  }
  const state = this.WorkspaceRestoreStatus(id);
  if (state.Status === "restoring" || state.Status === "ready") {
    return state;
  }
  let token;
  try {
    token = this.repo.BeginWorkspaceRestore(id, new Date());
  } catch (err) {
    if (err === ErrWorkspaceInUse) {
      // 另一 API 可能在读取与认领之间抢到了恢复。
      try {
        const reread = this.WorkspaceRestoreStatus(id);
        if (reread.Status === "restoring" || reread.Status === "ready") {
          return reread;
        }
      } catch {
        // Go：重读失败时继续走 err 分支。
      }
    }
    throw err;
  }
  if (token === "") {
    return this.WorkspaceRestoreStatus(id);
  }
  this.restoreWorkspaceInBackground(id, token);
  return this.WorkspaceRestoreStatus(id);
};

Engine.prototype.restoreWorkspaceInBackground = async function (id, token) {
  // 工作区使用租约 15 分钟。整个操作（含旧执行机 RPC 完成前的重试）限制在该 TTL 之下。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), 10 * 60 * 1000);
  const ctx = WithConversationWorkspaceToken(controller.signal, token, id);
  try {
    let err = null;
    for (;;) {
      try {
        this.EnsureConversationWorkspace(ctx, id, token);
        err = null;
      } catch (e) {
        err = e;
      }
      if (err !== ErrWorkspaceInUse) {
        break;
      }
      try {
        await sleepOrAbort(ctx, 1000);
        continue;
      } catch (e) {
        err = e;
        break;
      }
    }
    let message = "";
    if (err != null) {
      message = err.message;
    }
    const finishErr = this.repo.FinishWorkspaceRestore(id, token, new Date(), message);
    if (finishErr != null) {
      console.log(`finish workspace restore ${id}: ${finishErr}`);
    }
  } finally {
    clearTimeout(timer);
  }
};

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

module.exports = {};
