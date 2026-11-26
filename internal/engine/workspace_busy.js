// workspace_busy.js —— 对应 Go 文件：internal/engine/workspace_busy.go
// 作用：工作区占用判断与等待：识别 runner 侧忙冲突，限时重试至空闲。
// context.Context 译为 AbortSignal；(值, error) 译为 [值, error]；errors.Is 译为 ===；os.IsNotExist 译为 err.code === "ENOENT"；time.Duration 换算为毫秒。

"use strict";

const { WorkspaceErrorBusy, WorkspaceErrorTerminalActive } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.WorkspaceErrorBusy/WorkspaceErrorTerminalActive，runner_workspace.js 已翻译
const { ErrWorkspaceInUse } = require("../repo/workspace_checkpoints.js"); // 对应 Go 的 repo.ErrWorkspaceInUse，workspace_checkpoints.js 已翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译

function runnerWorkspaceBusy(response) {
  if (response.Code === WorkspaceErrorBusy) {
    return true;
  }
  if (response.Code !== "" || response.Status !== 409) {
    return false;
  }
  switch (response.Error) {
    case "workspace is still in use":
    case "workspace preparation is in progress":
    case "execution is still stopping":
      return true;
    default:
      return response.Error.startsWith("workspace is in use;") ||
        response.Error.startsWith("workspace preparation is in progress;");
  }
}

const errWorkspaceTerminalActive = new Error("工作区终端仍处于打开状态，请先关闭终端再继续");

function runnerWorkspaceResponseError(response) {
  if (response.Code === WorkspaceErrorTerminalActive) {
    return new Error(`${errWorkspaceTerminalActive.message}（${response.Error}）`);
  }
  if (runnerWorkspaceBusy(response)) {
    return new Error(`${ErrWorkspaceInUse.message}（${response.Error}）`);
  }
  return new Error(response.Error);
}

const nodePreparationBusyWait = 16 * 60 * 1000;

const nodePreparationBusyRetryMin = 300;
const nodePreparationBusyRetryMax = 3 * 1000;

Engine.prototype.waitWorkspaceNotBusy = async function (ctx, run, attempt) {
  const deadline = new Date(Date.now() + nodePreparationBusyWait);
  let delay = nodePreparationBusyRetryMin;
  for (;;) {
    const [state, err] = await attempt(run);
    if (err == null || err !== ErrWorkspaceInUse) {
      return [state, err];
    }
    if (Date.now() >= deadline.getTime()) {
      return [state, new Error(`等待工作区空闲超时（16m0s）：${err.message}`)];
    }
    try {
      await sleepOrAbort(ctx, delay);
    } catch (abortErr) {
      return [state, abortErr];
    }
    delay *= 2;
    if (delay > nodePreparationBusyRetryMax) {
      delay = nodePreparationBusyRetryMax;
    }
    const [current, ok] = this.repo.RunState(run.ID);
    if (ok) {
      run = current;
    }
  }
};

module.exports = { runnerWorkspaceBusy, runnerWorkspaceResponseError, errWorkspaceTerminalActive, nodePreparationBusyWait, nodePreparationBusyRetryMin, nodePreparationBusyRetryMax };
