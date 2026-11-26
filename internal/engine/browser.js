// browser.js —— 对应 Go 文件：internal/engine/browser.go
// 作用：运行期 Agent 浏览器的请求处理与 Runner 转发。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 待翻译
const { RunnerWorkspaceResponse, RunnerWorkspaceRequest, RunnerWorkspaceOperationBrowser, BrowserState } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspaceResponse/RunnerWorkspaceRequest/RunnerWorkspaceOperationBrowser/BrowserState，domain 已翻译
const { BrowserRunning, BrowserEnabled, EnsureSandboxBrowser } = require("../runtime/browser.js"); // 对应 Go 的 runtime.BrowserRunning/BrowserEnabled/EnsureSandboxBrowser，runtime 待翻译
const { HandleBrowser } = require("../runtime/browser_view.js"); // 对应 Go 的 runtime.HandleBrowser，runtime 待翻译

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

Engine.prototype.ForwardBrowserRequest = function (ctx, run, req) {
  return this.requestWorkspaceCheckpoint(ctx, run, browserWorkspaceRequest(run, req));
};

function browserWorkspaceRequest(run, req) {
  return new RunnerWorkspaceRequest({ RunID: run.ID, RunStatus: run.Status, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationBrowser, Browser: req });
}

Engine.prototype.BrowserWorkspaceRequest = function (run, req) {
  const request = browserWorkspaceRequest(run, req);
  if (!req.Ensure) {
    return request;
  }
  return this.preparedWorkspaceRequest(run, request);
};

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
