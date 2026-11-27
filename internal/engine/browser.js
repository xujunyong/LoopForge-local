/**
 * @file browser.js
 * 对应 Go 源文件：internal/engine/browser.go
 * 作用与职责边界：负责运行期 Agent 浏览器的请求处理与调度，包括本地沙箱浏览器按需拉起、
 * Runner 执行模式下通过工作区通道转发浏览器请求、跨实例转发以及浏览器工作区请求构造。
 * 语法差异说明：
 * - Go 的 `defer` 释放对话工作区占用通过 `try ... finally` 实现。
 * - Go 的 `context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)` 在 JS 中直接复用原 `ctx`。
 * - 属于 `Engine` 的方法统一挂载在 `Engine.prototype` 上。
 */

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 待翻译
const { RunnerWorkspaceResponse, RunnerWorkspaceRequest, RunnerWorkspaceOperationBrowser, BrowserState } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspaceResponse/RunnerWorkspaceRequest/RunnerWorkspaceOperationBrowser/BrowserState，domain 已翻译
const { BrowserRunning, BrowserEnabled, EnsureSandboxBrowser } = require("../runtime/browser.js"); // 对应 Go 的 runtime.BrowserRunning/BrowserEnabled/EnsureSandboxBrowser，runtime 待翻译
const { HandleBrowser } = require("../runtime/browser_view.js"); // 对应 Go 的 runtime.HandleBrowser，runtime 待翻译

/**
 * 处理运行实例的 Agent 浏览器操作请求：Runner 模式经传输通道转发，本地模式按需拉起沙箱浏览器后直接执行。
 * 使用场景：HTTP API 或控制台面板查看、点击、截图或启动运行期 Agent 浏览器时调用。
 *
 * @param {object|null} ctx - 请求上下文对象（Go context.Context）。
 * @param {object} run - 运行实例对象（domain.Run）。
 * @param {object|null} req - 浏览器请求对象（domain.BrowserRequest）。
 * @returns {RunnerWorkspaceResponse} 包含序列化 `BrowserState` 载荷及状态码/错误信息的响应对象。
 */
Engine.prototype.HandleBrowserRequest = function (ctx, run, req) {
  if (req == null) {
    return new RunnerWorkspaceResponse({ Status: 400, Error: "invalid browser request" });
  }
  if (this.defaultExecutionRunner(run) !== "") {
    if (this.WorkspaceCheckpointTransport == null) {
      return new RunnerWorkspaceResponse({ Status: 503, Error: "runner transport unavailable" });
    }
    let request;
    try {
      request = this.BrowserWorkspaceRequest(run, req);
    } catch (err) {
      const payload = Buffer.from(JSON.stringify(new BrowserState({ Reason: err.message })), "utf8");
      return new RunnerWorkspaceResponse({ Payload: payload });
    }
    let response;
    try {
      response = this.WorkspaceCheckpointTransport(ctx, run, request);
    } catch (err) {
      return new RunnerWorkspaceResponse({ Status: 503, Error: err.message });
    }
    return response;
  }
  if (req.Ensure && !BrowserRunning(ctx, run.ID)) {
    try {
      this.ensureRunBrowser(ctx, run);
    } catch (err) {
      const payload = Buffer.from(JSON.stringify(new BrowserState({ Reason: err.message })), "utf8");
      return new RunnerWorkspaceResponse({ Payload: payload });
    }
  }
  let state;
  let browserErr = null;
  try {
    state = HandleBrowser(ctx, run.ID, req);
  } catch (err) {
    // Go 的 HandleBrowser 出错时仍返回当时的 state；JS 的 throw 约定取不回该 state，用空 state 代替。
    browserErr = err;
    state = new BrowserState({});
  }
  const payload = Buffer.from(JSON.stringify(state), "utf8");
  const response = new RunnerWorkspaceResponse({ Payload: payload });
  if (browserErr !== null) {
    response.Error = browserErr.message;
    response.Status = 409;
  }
  return response;
};

/**
 * 将浏览器请求转发给持有远端工作区绑定的工作节点。
 * 使用场景：当前实例不直接持有运行工作区时，经工作区检查点通道路由到目标实例。
 *
 * @param {object|null} ctx - 请求上下文对象（Go context.Context）。
 * @param {object} run - 运行实例对象（domain.Run）。
 * @param {object} req - 浏览器请求对象（domain.BrowserRequest）。
 * @returns {RunnerWorkspaceResponse} 远端工作节点返回的响应对象。
 * @throws {Error} 转发通道失败时抛出错误。
 */
Engine.prototype.ForwardBrowserRequest = function (ctx, run, req) {
  return this.requestWorkspaceCheckpoint(ctx, run, browserWorkspaceRequest(run, req));
};

/**
 * 构造基础的浏览器工作区操作请求对象。
 * 使用场景：供 `ForwardBrowserRequest` 与 `BrowserWorkspaceRequest` 组装通用请求头与载荷。
 *
 * @param {object} run - 运行实例对象（domain.Run）。
 * @param {object} req - 浏览器请求对象（domain.BrowserRequest）。
 * @returns {RunnerWorkspaceRequest} 标记为浏览器操作的工作区请求对象。
 */
function browserWorkspaceRequest(run, req) {
  return new RunnerWorkspaceRequest({ RunID: run.ID, RunStatus: run.Status, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationBrowser, Browser: req });
}

/**
 * 构造发往 Runner 的浏览器工作区请求；若请求要求启动浏览器（`Ensure`），则附加冻结的运行沙箱准备信息。
 * 使用场景：Runner 模式下发浏览器指令前调用，确保浏览器与该运行的 Agent 启动在同一沙箱内。
 *
 * @param {object} run - 运行实例对象（domain.Run）。
 * @param {object} req - 浏览器请求对象（domain.BrowserRequest）。
 * @returns {RunnerWorkspaceRequest} 完整的工作区浏览器请求对象。
 * @throws {Error} 准备沙箱上下文信息失败时抛出错误。
 */
Engine.prototype.BrowserWorkspaceRequest = function (run, req) {
  const request = browserWorkspaceRequest(run, req);
  if (!req.Ensure) {
    return request;
  }
  return this.preparedWorkspaceRequest(run, request);
};

/**
 * 在运行实例共享的沙箱中确保 Agent 浏览器已启动，必要时自动恢复已被回收的对话工作区。
 * 使用场景：本地执行模式收到 `Ensure: true` 的浏览器请求且浏览器尚未运行时调用。
 *
 * @param {object|null} ctx - 请求上下文对象（Go context.Context）。
 * @param {object} run - 运行实例对象（domain.Run）。
 * @returns {void} 无返回值。
 * @throws {Error} 平台未开启浏览器、工作区准备失败或沙箱内 Chromium 启动失败时抛出错误。
 */
Engine.prototype.ensureRunBrowser = function (ctx, run) {
  if (!BrowserEnabled()) {
    throw new Error("平台已关闭 Agent 浏览器");
  }
  // Go 的 defer 在函数返回时执行：token 只在新取时才需释放。
  let token = "";
  try {
    if (ConversationWorkspaceToken(ctx, run.ID) === "") {
      token = this.BeginConversationWorkspaceUse(run.ID);
      this.PrepareConversationWorkspace(ctx, run.ID, token);
      const [latest, ok] = this.repo.RunState(run.ID);
      if (ok) {
        run = latest;
      }
      ctx = WithConversationWorkspaceToken(ctx, token, run.ID);
    }
    const env = this.acquireConversationEnvironment(ctx, run);
    if (EnsureSandboxBrowser(ctx, env.sandbox, env.Workspace(), run.ID, null) == null) {
      throw new Error("Agent 浏览器启动失败：当前运行环境不支持，或 Chromium 不可用");
    }
  } finally {
    if (token !== "") {
      // Go 的 context.WithTimeout 无 JS 对应写法，直接用原 ctx。
      const saveCtx = ctx;
      try {
        this.EndConversationWorkspaceUse(saveCtx, run.ID, token);
      } catch {}
    }
  }
};

module.exports = { browserWorkspaceRequest };
