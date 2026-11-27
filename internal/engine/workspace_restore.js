/**
 * @file internal/engine/workspace_restore.js
 * 对应 Go 源文件：internal/engine/workspace_restore.go
 *
 * 作用与职责边界：
 * 实现运行工作区快照的持久恢复状态查询（`WorkspaceRestoreStatus`）、异步发起后台恢复（`StartWorkspaceRestore`）
 * 以及带租约重试与超时收尾的后台恢复协程（`restoreWorkspaceInBackground`）；
 * `Engine` 方法挂载于 `Engine.prototype`（`Engine` 定义于 `engine.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；`(值, bool)` 译为 `[值, boolean]`。
 * - Go 的 `context.Context` 译为 `AbortSignal`；`go e.restoreWorkspaceInBackground(...)` 译为不 `await` 的异步函数调用。
 * - Go 的 `errors.Is` 译为 `===`；`time.Time` 零值译为 `null`；`log.Printf` 译为 `console.log`。
 */

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { WorkspaceRestoreStatus } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.WorkspaceRestoreStatus，runner_workspace.js 已翻译
const { ErrWorkspaceInUse } = require("../repo/workspace_checkpoints.js"); // 对应 Go 的 repo.ErrWorkspaceInUse，workspace_checkpoints.js 已翻译
const { WorkspaceRestoreInterrupted } = require("../repo/workspace_restore.js"); // 对应 Go 的 repo.WorkspaceRestoreInterrupted，workspace_restore.js 已翻译
const { sharesWorkspace, workspaceRunID } = require("./workspace_owner.js"); // 对应 Go 同包函数，workspace_owner.js 已翻译
const { WithConversationWorkspaceToken } = require("./conversation_workspace.js"); // 对应 Go 同包函数，conversation_workspace.js 已翻译

/**
 * 查询指定运行工作区的持久恢复状态（`"idle"` / `"restoring"` / `"failed"` / `"ready"`）；
 * 子 SOP 自动重定向至其共享的父运行；先读快照租约再读运行记录，确保已释放租约不会配上陈旧的清理标记。
 * 使用场景：前端轮询或跨 API 实例检查是否已有后台恢复正在进行。
 *
 * @param {string} id - 运行记录主键 ID。
 * @returns {WorkspaceRestoreStatus} 当前持久化的工作区恢复状态。
 * @throws {Error} 运行不存在时抛出错误。
 */
Engine.prototype.WorkspaceRestoreStatus = function (id) {
  // 先读租约再读运行。恢复在释放租约前清除运行的清理标记，所以已释放的租约绝不会配上陈旧的清理标记（避免误报为 "idle" 而非 "ready"）。
  const [meta] = this.repo.WorkspaceCheckpoint(id);
  const [run, ok] = this.repo.RunState(id);
  if (!ok) {
    throw new Error("run not found");
  }
  if (sharesWorkspace(run)) {
    return this.WorkspaceRestoreStatus(workspaceRunID(run));
  }
  const state = new WorkspaceRestoreStatus({ Status: "idle", StartedAt: meta.RestoreStarted });
  // 恢复在绑定工作区时即清除清理标记（早于剩余工作完成），因此记录的恢复结果优先于绑定状态：失败或中断的恢复绝不视为 "ready"。
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

/**
 * 立即确认并启动有界的后台工作区恢复任务；若工作区已就绪或已有实例正在恢复则直接返回当前状态。
 * 后台操作在数据库租约下独立运行，不会因 HTTP 请求提前断开而中断执行机侧恢复。
 * 使用场景：前端点击恢复已回收工作区或 API 触发异步恢复时调用。
 *
 * @param {string} id - 运行记录主键 ID。
 * @returns {WorkspaceRestoreStatus} 启动或复核后的工作区恢复状态。
 * @throws {Error} 运行不存在、租约被其他独占操作占用或数据库申请恢复失败时抛出错误。
 */
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
      // 另一 API 实例可能在读取与认领之间抢先启动了恢复。
      try {
        const reread = this.WorkspaceRestoreStatus(id);
        if (reread.Status === "restoring" || reread.Status === "ready") {
          return reread;
        }
      } catch {
        // Go：重读失败时继续抛出原始 err。
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

/**
 * 在 10 分钟有界超时内后台执行工作区快照恢复：遇到 `ErrWorkspaceInUse` 时每秒重试直至成功、非忙碌错误或超时，
 * 最终调用 `FinishWorkspaceRestore` 释放租约并写入最终恢复状态。
 * 使用场景：由 `StartWorkspaceRestore` 以后台协程方式启动（不 `await`）。
 *
 * @param {string} id - 运行记录主键 ID。
 * @param {string} token - 本次后台恢复持有的数据库租约令牌。
 * @returns {Promise<void>} 无返回值。
 */
Engine.prototype.restoreWorkspaceInBackground = async function (id, token) {
  // 工作区使用租约有效期为 15 分钟；将完整后台恢复（含等待旧执行机 RPC 结束的重试）限制在 10 分钟内。
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
    try {
      this.repo.FinishWorkspaceRestore(id, token, new Date(), message);
    } catch (finishErr) {
      console.log(`finish workspace restore ${id}: ${finishErr}`);
    }
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 等待指定毫秒数或直至 `ctx` 触发取消信号（对应 Go 的 `time.After` + `select`）。
 * 使用场景：供 `restoreWorkspaceInBackground` 在租约冲突时执行可中断的 1 秒重试等待。
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

module.exports = {};
