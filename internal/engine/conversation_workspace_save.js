// conversation_workspace_save.js —— 对应 Go 文件：internal/engine/conversation_workspace_save.go
// 作用：会话工作区后台保存：前台使用结束后交接租约并异步压缩上传。
// context.Context 译为 AbortSignal；goroutine 译为不 await 的异步函数；channel 译为 Promise；errors.Is 译为 ===；os.IsNotExist 译为 err.code === "ENOENT"。

"use strict";

const { RunnerWorkspaceRequest, RunnerWorkspaceOperationCheckpointStatus } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspaceRequest/RunnerWorkspaceOperationCheckpointStatus，runner_workspace.js 已翻译
const { ErrWorkspaceInUse } = require("../repo/workspace_checkpoints.js"); // 对应 Go 的 repo.ErrWorkspaceInUse，workspace_checkpoints.js 已翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译

Engine.prototype.saveConversationWorkspaceAfterUse = async function (ctx, id, token) {
  const [run, ok] = this.repo.RunState(id);
  if (!ok || run.WorkspaceCleanedAt != null || !this.conversationWorkspaceIdle(run)) {
    return null;
  }
  const err = await this.saveConversationWorkspace(ctx, run, token);
  if (err != null && err.code === "ENOENT") {
    return null;
  }
  return err;
};

Engine.prototype.EndConversationWorkspaceUseAsync = function (ctx, id, token) {
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
  const done = (async () => {
    let err = null;
    try {
      for (;;) {
        err = await this.saveConversationWorkspaceAfterUse(saveCtx, id, saveToken);
        const [meta, exists] = this.repo.WorkspaceCheckpoint(id);
        if (!exists || meta.LeaseToken !== saveToken) {
          err = null;
          break;
        }
        if (err === ErrWorkspaceInUse && !saveCtx.aborted) {
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
        const finishErr = this.repo.FinishWorkspaceUse(id, saveToken, usedAt, null, message);
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

Engine.prototype.waitForBackgroundWorkspaceSave = async function (id) {
  const [run, ok] = this.repo.RunState(id);
  if (!ok || (this.defaultExecutionRunner(run) === "" && !this.foreignWorkspaceBind(run))) {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2 * 1000);
  const ctx = controller.signal;
  try {
    for (;;) {
      const [response, err] = await this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({ RunID: id, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationCheckpointStatus }));
      if (err != null || !runnerWorkspaceBusy(response)) {
        return null;
      }
      if (ctx.aborted) {
        return ErrWorkspaceInUse;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 25);
        ctx.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      if (ctx.aborted) {
        return ErrWorkspaceInUse;
      }
    }
  } finally {
    clearTimeout(timeout);
  }
};

module.exports = {};
