/**
 * 对应 Go 源文件：internal/engine/workspace_busy.go
 *
 * 文件作用与职责边界：
 * 负责识别远程执行机器（Runner）返回的工作区忙冲突与终端独占错误，
 * 将错误归一化为标准哨兵错误，并提供带指数退避的限时重试等待，
 * 确保并行分支或群组角色不会因兄弟节点正在准备同一工作区而误判失败。
 *
 * Go 与 JS 语法差异说明：
 * - Go 的 `context.Context` 译为 `AbortSignal`。
 * - Go 的 `(值, error)` 译为成功返回值、失败 `throw`。
 * - Go 的 `fmt.Errorf("%w...", sentinel, ...)` 译为 `new Error(..., { cause: sentinel })`，并用 `err === sentinel || err?.cause === sentinel` 对应 `errors.Is`。
 * - Go 的 `time.Duration` 换算为毫秒数；`select { case <-ctx.Done(): case <-time.After(delay): }` 译为 `await sleepOrAbort(ctx, delay)`。
 */

"use strict";

const { WorkspaceErrorBusy, WorkspaceErrorTerminalActive } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.WorkspaceErrorBusy/WorkspaceErrorTerminalActive，runner_workspace.js 已翻译
const { ErrWorkspaceInUse } = require("../repo/workspace_checkpoints.js"); // 对应 Go 的 repo.ErrWorkspaceInUse，workspace_checkpoints.js 已翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译

/**
 * 判断 Runner 返回的工作区响应是否属于瞬时围栏占用冲突（另一任务、准备过程或快照正持有工作区）。
 * 兼容旧版未携带 `Code` 字段的 Runner，按 409 状态码与固定错误文案识别。
 * 使用场景：工作区准备、恢复或产物回填收到 Runner 错误响应时调用。
 *
 * @param {object} response - Runner 工作区操作响应（domain.RunnerWorkspaceResponse）。
 * @returns {boolean} 属于瞬时忙冲突返回 true，否则返回 false。
 */
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

// 等待无法解决终端独占，必须由用户手动关闭打开的工作区终端。
const errWorkspaceTerminalActive = new Error("工作区终端仍处于打开状态，请先关闭终端再继续");

/**
 * 将失败的 Runner 工作区响应分类包装为对应错误对象。
 * 忙冲突会以 `ErrWorkspaceInUse` 为 `cause` 包装，便于 HTTP 调用方返回“忙，请重试”以及调度器自动等待而非让节点失败。
 * 使用场景：解析远程工作区控制接口的失败响应时调用。
 *
 * @param {object} response - 失败的 Runner 工作区响应（domain.RunnerWorkspaceResponse）。
 * @returns {Error} 分类包装后的 Error 对象。
 */
function runnerWorkspaceResponseError(response) {
  if (response.Code === WorkspaceErrorTerminalActive) {
    return new Error(`${errWorkspaceTerminalActive.message}（${response.Error}）`, { cause: errWorkspaceTerminalActive });
  }
  if (runnerWorkspaceBusy(response)) {
    return new Error(`${ErrWorkspaceInUse.message}（${response.Error}）`, { cause: ErrWorkspaceInUse });
  }
  return new Error(response.Error);
}

// 限制启动节点等待其他工作区持有者的最长时间（16 分钟），覆盖一次完整的 Runner 侧准备（15 分钟）。
const nodePreparationBusyWait = 16 * 60 * 1000;

const nodePreparationBusyRetryMin = 300;
const nodePreparationBusyRetryMax = 3 * 1000;

/**
 * 当 `attempt` 报告工作区正忙（`ErrWorkspaceInUse`）时，以指数退避反复重试直至空闲、超时或上下文中止。
 * 每次重试前会重新读取最新运行状态，使基于成功节点构建的准备计划能看到期间完成的兄弟节点。
 * 使用场景：工作区准备阶段远程调用遇到围栏占用冲突时调用。
 *
 * @param {AbortSignal} ctx - 取消控制信号。
 * @param {object} run - 当前运行实例（domain.Run）。
 * @param {function(object): (object|Promise<object>)} attempt - 单次尝试回调，入参为最新运行实例，成功返回准备状态（runtime.WorkspacePreparationStatus），失败抛出错误。
 * @returns {Promise<object>} 尝试成功后返回的工作区准备状态（runtime.WorkspacePreparationStatus）。
 * @throws {Error} 当 `attempt` 抛出非忙错误、等待超过 16 分钟超时或 `ctx` 被中止时抛出错误。
 */
Engine.prototype.waitWorkspaceNotBusy = async function (ctx, run, attempt) {
  const deadline = new Date(Date.now() + nodePreparationBusyWait);
  let delay = nodePreparationBusyRetryMin;
  for (;;) {
    let err = null;
    try {
      return await attempt(run);
    } catch (e) {
      err = e;
    }
    if (err !== ErrWorkspaceInUse && err?.cause !== ErrWorkspaceInUse) {
      throw err;
    }
    if (Date.now() >= deadline.getTime()) {
      throw new Error(`等待工作区空闲超时（16m0s）：${err.message}`, { cause: err });
    }
    await sleepOrAbort(ctx, delay);
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

/**
 * 等待指定毫秒数或在 AbortSignal 触发中止时立即拒绝 Promise。
 * 使用场景：配合 waitWorkspaceNotBusy 实现与 Go `select { case <-ctx.Done(): case <-time.After(delay): }` 等价的可取消退避等待。
 *
 * @param {AbortSignal} ctx - 取消控制信号。
 * @param {number} ms - 等待的毫秒数。
 * @returns {Promise<void>} 正常到时后 resolve，无返回值；中止时以 `ctx.reason` reject。
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

module.exports = { runnerWorkspaceBusy, runnerWorkspaceResponseError, errWorkspaceTerminalActive, nodePreparationBusyWait, nodePreparationBusyRetryMin, nodePreparationBusyRetryMax };
