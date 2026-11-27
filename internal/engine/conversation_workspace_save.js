/**
 * @file internal/engine/conversation_workspace_save.js
 * 对应 Go 源文件：internal/engine/conversation_workspace_save.go
 *
 * 作用与职责边界：
 * 实现对话工作区前台使用结束后的后台异步快照保存：
 * 包括前台路径上的租约交接、后台异步压缩上传与租约抢占监听协程，
 * 以及新前台操作抢占后台保存时探测远端 Runner 只读门是否释放的短暂等待逻辑；
 * 领域方法挂载于 `Engine.prototype`（`Engine` 定义于 `engine.js`）。
 *
 * 语法差异说明：
 * - Go 的仅 `error` 返回函数（`saveConversationWorkspaceAfterUse`、`waitForBackgroundWorkspaceSave`）译为成功返回 `undefined`、失败 `throw err`。
 * - Go 的 `(<-chan error, error)`（`EndConversationWorkspaceUseAsync`）译为成功返回 `Promise<Error | null>`（对应只读错误通道 `<-chan error`）、同步交接失败时直接 `throw err`。
 * - Go 的 `goroutine` 译为不等待立即执行的异步 IIFE；`context.WithoutCancel` + `WithTimeout` 译为独立新建的 `AbortController` + 5 分钟定时器。
 * - Go 的 `errors.Is` 译为 `===`；`os.IsNotExist(err)` 译为 `err.code === "ENOENT"`。
 * - 为避免与 `conversation_workspace.js` 循环依赖，在函数内延迟引用 `WithConversationWorkspaceToken`。
 */

"use strict";

const { RunnerWorkspaceRequest, RunnerWorkspaceOperationCheckpointStatus } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspaceRequest/RunnerWorkspaceOperationCheckpointStatus，runner_workspace.js 已翻译
const { ErrWorkspaceInUse } = require("../repo/workspace_checkpoints.js"); // 对应 Go 的 repo.ErrWorkspaceInUse，workspace_checkpoints.js 已翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { runnerWorkspaceBusy } = require("./workspace_busy.js"); // 对应 Go 同包函数，workspace_busy.js 已翻译

/**
 * 在前台对话使用结束后尝试为仍然空闲且未清理的运行保存工作区快照；
 * 若本地工作区目录尚未实体化（`ENOENT`），则视为正常无操作直接返回。
 * 使用场景：由 `EndConversationWorkspaceUse`（同步路径）与 `EndConversationWorkspaceUseAsync`（后台路径）调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号。
 * @param {string} id - 运行（工作区）ID。
 * @param {string} token - 当前持有的工作区租约令牌（前台或后台保存令牌）。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 保存快照过程中发生非 `ENOENT` 错误时抛出错误。
 */
Engine.prototype.saveConversationWorkspaceAfterUse = async function (ctx, id, token) {
  const [run, ok] = this.repo.RunState(id);
  if (!ok || run.WorkspaceCleanedAt != null || !this.conversationWorkspaceIdle(run)) {
    return;
  }
  try {
    await this.saveConversationWorkspace(ctx, run, token);
  } catch (err) {
    if (err != null && err.code === "ENOENT") {
      return; // 新创建的任务可能尚未实体化本地文件
    }
    throw err;
  }
};

/**
 * 异步结束对话工作区使用：在前台路径上仅原子交接租约为后台保存令牌，
 * 随后在独立后台协程中执行压缩、上传与发布，同时以 100 毫秒周期监听租约是否被新前台操作（含跨实例）抢占。
 * 使用场景：对话轮次结束时不阻塞响应，将快照归档卸载到后台执行。
 *
 * @param {AbortSignal | null} ctx - 外层上下文（后台保存通过独立 `AbortController` 脱离其取消传播，对应 `context.WithoutCancel`）。
 * @param {string} id - 运行（工作区）ID。
 * @param {string} token - 当前持有的前台使用租约令牌。
 * @returns {Promise<Error | null>} 对应 Go 的 `<-chan error`：后台保存完成时解析为 `null`（成功或被抢占）或最终错误对象。
 * @throws {Error} 前台租约交接给后台保存失败时同步抛出错误。
 */
Engine.prototype.EndConversationWorkspaceUseAsync = function (ctx, id, token) {
  const { WithConversationWorkspaceToken } = require("./conversation_workspace.js"); // 延迟引用避免与 conversation_workspace.js 循环依赖
  const usedAt = new Date();
  const saveToken = this.repo.HandoffWorkspaceUseToSave(id, token, usedAt);
  const saveController = new AbortController();
  const saveTimeout = setTimeout(() => saveController.abort(), 5 * 60 * 1000);
  const cancel = () => {
    clearTimeout(saveTimeout);
    saveController.abort();
  };
  let saveCtx = saveController.signal;
  saveCtx = WithConversationWorkspaceToken(saveCtx, saveToken, id);
  this.conversationSaves.set(saveToken, cancel);
  const done = (async () => {
    let err = null;
    try {
      const watchDone = (async () => {
        for (;;) {
          if (saveCtx.aborted) {
            return;
          }
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 100);
            saveCtx.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
          if (saveCtx.aborted) {
            return;
          }
          const [meta, exists] = this.repo.WorkspaceCheckpoint(id);
          if (!exists || meta.LeaseToken !== saveToken) {
            cancel();
            return;
          }
        }
      })();
      for (;;) {
        try {
          await this.saveConversationWorkspaceAfterUse(saveCtx, id, saveToken);
          err = null;
        } catch (e) {
          err = e;
        }
        const [meta, exists] = this.repo.WorkspaceCheckpoint(id);
        if (!exists || meta.LeaseToken !== saveToken) {
          err = null; // 已被新租约抢占：绝不发布错误或清理新租约
          break;
        }
        if (err === ErrWorkspaceInUse && !saveCtx.aborted) {
          // 前一次导出可能仍在释放 runner 门控。
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 100);
            saveCtx.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
          continue;
        }
        let message = "";
        if (err != null) {
          message = err.message;
        }
        let finishErr = null;
        try {
          this.repo.FinishWorkspaceUse(id, saveToken, usedAt, null, message);
        } catch (e) {
          finishErr = e;
        }
        if (finishErr === ErrWorkspaceInUse) {
          err = null;
        } else if (err == null) {
          err = finishErr;
        } else if (finishErr != null) {
          err = new Error(err.message + ": " + finishErr.message);
        }
        break;
      }
      cancel();
      await watchDone;
      return err;
    } finally {
      this.conversationSaves.delete(saveToken);
      cancel();
    }
  })();
  return done;
};

/**
 * 在新前台租约抢占远端后台保存后，最多等待 2 秒（每 25 毫秒轮询一次只读状态探针），
 * 直到 Runner 或远端实例退出忙碌状态；若连接异常则直接返回，交由常规执行前置检查处理缺失或离线归属方。
 * 使用场景：由 `BeginConversationWorkspaceUse` 在抢占到后台保存租约后调用。
 *
 * @param {string} id - 运行（工作区）ID。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 超过 2 秒远端仍处于忙碌状态时抛出 `ErrWorkspaceInUse`。
 */
Engine.prototype.waitForBackgroundWorkspaceSave = async function (id) {
  const [run, ok] = this.repo.RunState(id);
  if (!ok || (this.defaultExecutionRunner(run) === "" && !this.foreignWorkspaceBind(run))) {
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2 * 1000);
  const ctx = controller.signal;
  try {
    for (;;) {
      let response;
      try {
        response = await this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({ RunID: id, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationCheckpointStatus }));
      } catch (err) {
        return; // 常规执行前置检查会处理缺失或离线的归属实例
      }
      if (!runnerWorkspaceBusy(response)) {
        return;
      }
      if (ctx.aborted) {
        throw ErrWorkspaceInUse;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 25);
        ctx.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      if (ctx.aborted) {
        throw ErrWorkspaceInUse;
      }
    }
  } finally {
    clearTimeout(timeout);
  }
};

module.exports = {};
