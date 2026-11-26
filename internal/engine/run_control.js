// run_control.js —— 对应 Go 文件：internal/engine/run_control.go
// 作用：运行中断控制：实例心跳、控制令牌校验与 worker 中断通知。
// log.Printf 译为 console.log；time.Duration 译为毫秒数；context.Context 译为 AbortSignal；net/http 客户端译为 fetch，服务端 http.Error 译为 writeHead/end；sync.WaitGroup 无法同步等待异步 fetch，通知改为即发即忘。

"use strict";

const { timingSafeEqual } = require("node:crypto"); // Go crypto/subtle
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { EngineInstance } = require("../repo/engine_instances.js"); // 对应 Go 的 repo.EngineInstance，engine_instances.js 已翻译

const controlTokenHeader = "X-Agentflow-Control-Token";

// ControlConfig：api/worker 进程宣告并鉴权运行中断的方式。
class ControlConfig {
  constructor(init = {}) {
    this.Role = init.Role ?? "";
    this.URL = init.URL ?? "";
    this.Token = init.Token ?? "";
    this.FallbackURL = init.FallbackURL ?? "";
    // APIURL 是本进程可达的 API 监听地址。Runner 工作区操作转发到这里，不走沙箱/公开 MCP 地址。
    this.APIURL = init.APIURL ?? "";
  }
}

// ConfigureControl 设置宣告的中断 URL（worker）、共享令牌，以及所有者未注册时用的可选静态兜底 URL。
Engine.prototype.ConfigureControl = function (cfg) {
  this.controlRole = cfg.Role.trim();
  this.controlURL = cfg.URL.trim().replace(/\/+$/, "");
  this.controlToken = cfg.Token.trim();
  this.workspaceControlBase = cfg.APIURL.trim().replace(/\/+$/, "");
  this.fallbackWorkerURL = cfg.FallbackURL.trim().replace(/\/+$/, "");
  if (this.controlClient == null) {
    this.controlClient = { Timeout: 800 };
  }
};

// SetRunControlNotify 接入测试/进程内唤醒。Pause/Cancel 仍先持久化标志；监听缺失也无害，因为租约心跳会重读同一批标志位。
Engine.prototype.SetRunControlNotify = function (fn) {
  this.runControlNotify = fn;
};

Engine.prototype.notifyRunControl = function (runID) {
  const fn = this.runControlNotify;
  const fallback = this.fallbackWorkerURL;
  const token = this.controlToken;
  const client = this.controlClient;
  if (runID.trim() === "") {
    return;
  }
  if (fn != null) {
    fn(runID);
    return;
  }
  const urls = this.runControlURLs(runID, fallback);
  if (urls.length === 0) {
    return;
  }
  const c = client ?? { Timeout: 800 };
  for (const u of urls) {
    postRunInterrupt(c, u, runID, token);
  }
};

Engine.prototype.runControlURLs = function (runID, fallback) {
  const [r, ok] = this.repo.RunState(runID);
  if (ok) {
    const u = this.repo.EngineInstanceControlURL(r.OwnerInstanceID);
    if (u !== "") {
      return [u];
    }
  }
  const seen = new Set();
  const urls = [];
  const add = (u) => {
    u = u.trim().replace(/\/+$/, "");
    if (u === "") {
      return;
    }
    if (seen.has(u)) {
      return;
    }
    seen.add(u);
    urls.push(u);
  };
  for (const u of this.repo.LiveWorkerControlURLs()) {
    add(u);
  }
  add(fallback);
  return urls;
};

// StartInstanceHeartbeat 发布本进程的中断 URL，供 API 寻址到归属 worker。第一次心跳是同步的。
Engine.prototype.StartInstanceHeartbeat = function (ctx) {
  if (ctx == null) {
    // context.Background()：永不取消，用 null 表示
    ctx = null;
  }
  this.heartbeatInstance();
  let interval = this.leaseTTL / 3;
  if (interval <= 0) {
    interval = 1000;
  }
  const timer = setInterval(() => {
    this.heartbeatInstance();
  }, interval);
  if (ctx instanceof AbortSignal) {
    ctx.addEventListener("abort", () => clearInterval(timer), { once: true });
  }
};

Engine.prototype.heartbeatInstance = function () {
  let id = this.instanceID;
  let role = this.controlRole;
  let controlURL = this.controlURL;
  let host = this.workspaceHost;
  let ttl = this.leaseTTL;
  if (controlURL === "" || id === "") {
    return;
  }
  if (role === "") {
    role = "worker";
  }
  if (ttl <= 0) {
    ttl = 30000;
  }
  const err = this.repo.HeartbeatEngineInstance(new EngineInstance({
    InstanceID: id, Role: role, ControlURL: controlURL, WorkspaceHost: host,
  }), ttl);
  if (err != null) {
    console.log(`engine instance heartbeat: ${err.message}`);
  }
};

// Interrupt 在已设置持久化暂停/取消标志时取消 runID 的本地调度器。本进程不拥有该运行时为空操作。
Engine.prototype.Interrupt = function (runID) {
  if (runID.trim() === "" || !this.runControlRequested(runID)) {
    return false;
  }
  const cancel = this.running[runID];
  if (cancel == null) {
    return false;
  }
  cancel();
  return true;
};

// HandleRunInterrupt 是 worker 侧唤醒：POST /internal/runs/{id}/interrupt。
Engine.prototype.HandleRunInterrupt = function (w, r) {
  if (!this.controlTokenOK(r.headers[controlTokenHeader.toLowerCase()] ?? "")) {
    w.writeHead(401);
    w.end("unauthorized");
    return;
  }
  const runID = r.PathValue("id").trim();
  if (runID === "") {
    w.writeHead(400);
    w.end("run id required");
    return;
  }
  w.setHeader("Content-Type", "application/json; charset=utf-8");
  w.end(JSON.stringify({ interrupted: this.Interrupt(runID) }) + "\n");
};

Engine.prototype.controlTokenOK = function (got) {
  const want = this.controlToken;
  if (want === "") {
    return true;
  }
  if (got.length !== want.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(want, "utf8"));
};

// ControlTokenHeader 承载进程间共享的服务凭证。
const ControlTokenHeader = controlTokenHeader;

// InternalAPI 返回本进程可达的 API 监听地址与共享服务令牌，供 API 平面上的进程间调用使用。
Engine.prototype.InternalAPI = function () {
  return [this.workspaceControlBase, this.controlToken];
};

// ServiceTokenOK 报告 got 是否为已配置的服务令牌。与中断策略不同，未配置令牌时永不授权。
Engine.prototype.ServiceTokenOK = function (got) {
  const configured = this.controlToken !== "";
  return configured && this.controlTokenOK(got);
};

async function postRunInterrupt(client, baseURL, runID, token) {
  if (client == null || baseURL.trim() === "" || runID.trim() === "") {
    return;
  }
  const u = baseURL.replace(/\/+$/, "") + "/internal/runs/" + encodeURIComponent(runID) + "/interrupt";
  const headers = {};
  if (token !== "") {
    headers[controlTokenHeader] = token;
  }
  let resp;
  try {
    resp = await fetch(u, { method: "POST", headers, signal: AbortSignal.timeout(client.Timeout ?? 800) });
  } catch (err) {
    console.log(`run control notify ${runID}: ${err.message}`);
    return;
  }
  await resp.text().catch(() => {});
  if (resp.status >= 300) {
    console.log(`run control notify ${runID}: worker returned ${resp.status} ${resp.statusText}`);
  }
}

// HTTPRunControlNotify POST 到单个 worker。测试与静态兜底使用它。
function HTTPRunControlNotify(baseURL, token) {
  const client = { Timeout: 800 };
  const base = baseURL.trim().replace(/\/+$/, "");
  return function (runID) {
    postRunInterrupt(client, base, runID, token);
  };
}

module.exports = { controlTokenHeader, ControlConfig, ControlTokenHeader, HTTPRunControlNotify };
