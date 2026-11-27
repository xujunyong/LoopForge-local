/**
 * @file internal/engine/run_control.js
 * 对应 Go 源文件：internal/engine/run_control.go
 *
 * 作用与职责边界：
 * 实现多实例 API/Worker 之间的运行中断控制平面，包括控制配置注入、实例心跳上报、
 * 控制令牌常量时间校验、本地调度器中断唤醒、HTTP 中断入口处理与跨进程中断通知发送。
 *
 * 语法差异说明：
 * - Go 的 `sync.Mutex` 在单线程 JS 中省略；`time.Duration` 译为毫秒数；`context.Context` 译为 `AbortSignal`（或 `null`）。
 * - Go 的 `map[string]struct{}` 译为普通对象 `{}`（值为 `true`）；`log.Printf` 译为 `console.log`。
 * - Go 的 `net/http` 客户端调用译为异步 `fetch`，`sync.WaitGroup` 并发通知在 JS 中以即发即忘（fire-and-forget）方式发出。
 * - Go 的 `repo.HeartbeatEngineInstance` 按统一错误约定失败时 `throw err`，调用处以 `try ... catch` 捕获并记录日志。
 */

"use strict";

const { timingSafeEqual } = require("node:crypto"); // Go crypto/subtle
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { EngineInstance } = require("../repo/engine_instances.js"); // 对应 Go 的 repo.EngineInstance，engine_instances.js 已翻译

const controlTokenHeader = "X-Agentflow-Control-Token";

/**
 * 描述 API/Worker 进程宣告及鉴权运行中断请求所需的控制配置。
 * 使用场景：进程启动时构造并传给 `Engine.prototype.ConfigureControl`。
 */
class ControlConfig {
  /**
   * 构造并初始化运行控制配置对象，缺省字段严格按 Go 零值填充。
   *
   * @param {object} [init={}] - 可选初始字段映射。
   * @param {string} [init.Role=""] - 当前进程角色（如 `"api"`、`"worker"`、`"all"`）。
   * @param {string} [init.URL=""] - 本进程对外通告的中断回调基础 URL。
   * @param {string} [init.Token=""] - 进程间共享的控制鉴权令牌。
   * @param {string} [init.FallbackURL=""] - 归属实例未注册时的静态兜底 worker URL。
   * @param {string} [init.APIURL=""] - 本进程可达的内部 API 监听地址（用于转发 Runner 工作区操作）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Role = init.Role ?? "";
    this.URL = init.URL ?? "";
    this.Token = init.Token ?? "";
    this.FallbackURL = init.FallbackURL ?? "";
    // APIURL 是本进程可达的 API 监听地址。Runner 工作区操作转发到这里，不走沙箱/公开 MCP 地址。
    this.APIURL = init.APIURL ?? "";
  }
}

/**
 * 配置本引擎实例通告的中断 URL（worker）、共享控制令牌、内部 API 地址及静态兜底 URL。
 * 使用场景：服务启动装配阶段调用，启用跨进程运行中断与实例心跳。
 *
 * @param {ControlConfig} cfg - 运行控制配置对象。
 * @returns {void} 无返回值。
 */
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

/**
 * 注入测试或进程内使用的运行控制唤醒回调。
 * 使用场景：单元测试或单进程部署时替代 HTTP 中断推送；暂停/取消仍会先持久化标志位，缺失监听也不影响租约心跳兜底。
 *
 * @param {function(string): void} fn - 接收 `runID` 的控制唤醒回调函数。
 * @returns {void} 无返回值。
 */
Engine.prototype.SetRunControlNotify = function (fn) {
  this.runControlNotify = fn;
};

/**
 * 向持有指定运行的工作节点发送中断唤醒通知；若配置了进程内回调则直接触发。
 * 使用场景：在 `Cancel` / `Pause` 持久化控制位之后尽快唤醒远端 worker。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @returns {void} 无返回值。
 */
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

/**
 * 解析需要通知中断的目标 worker 控制 URL 列表：优先精确命中运行归属实例，否则广播到全部存活 worker 及静态兜底地址。
 * 使用场景：由 `notifyRunControl` 调用以确定 HTTP 中断目标。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {string} fallback - 静态兜底 worker 基础 URL。
 * @returns {string[]} 去重后的目标控制 URL 数组。
 */
Engine.prototype.runControlURLs = function (runID, fallback) {
  const [r, ok] = this.repo.RunState(runID);
  if (ok) {
    const u = this.repo.EngineInstanceControlURL(r.OwnerInstanceID);
    if (u !== "") {
      return [u];
    }
  }
  const seen = {};
  const urls = [];
  const add = (u) => {
    u = u.trim().replace(/\/+$/, "");
    if (u === "") {
      return;
    }
    if (seen[u]) {
      return;
    }
    seen[u] = true;
    urls.push(u);
  };
  for (const u of this.repo.LiveWorkerControlURLs() ?? []) {
    add(u);
  }
  add(fallback);
  return urls;
};

/**
 * 启动本引擎实例的定期心跳上报，使 API 进程能够寻址到归属 worker；首次心跳同步执行，后续按租约周期的三分之一定时刷新。
 * 使用场景：进程启动后调用，传入的 `ctx` 取消时自动停止定时器。
 *
 * @param {AbortSignal|null} ctx - 生命周期取消信号；传 `null` 表示永不取消。
 * @returns {void} 无返回值。
 */
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

/**
 * 执行单次引擎实例心跳写入，将本进程实例 ID、角色、控制 URL 与工作区宿主机刷新到仓储。
 * 使用场景：由 `StartInstanceHeartbeat` 首次及定时触发。
 *
 * @returns {void} 无返回值。
 */
Engine.prototype.heartbeatInstance = function () {
  const id = this.instanceID;
  let role = this.controlRole;
  const controlURL = this.controlURL;
  const host = this.workspaceHost;
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
  try {
    this.repo.HeartbeatEngineInstance(new EngineInstance({
      InstanceID: id, Role: role, ControlURL: controlURL, WorkspaceHost: host,
    }), ttl);
  } catch (err) {
    console.log(`engine instance heartbeat: ${err.message}`);
  }
};

/**
 * 当数据库中已设置持久化的暂停/取消控制标志时，取消本进程内对应运行的本地调度器；本进程未持有该运行时为空操作。
 * 使用场景：收到本地或远端 HTTP 中断信号时调用。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @returns {boolean} 成功触发本地取消函数返回 `true`，否则返回 `false`。
 */
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

/**
 * 处理 worker 侧的运行中断唤醒 HTTP 请求：`POST /internal/runs/{id}/interrupt`。
 * 使用场景：注册到内部 HTTP 路由器，供控制面 API 进程唤醒正在执行该运行的 worker。
 *
 * @param {object} w - HTTP 响应对象（对应 Go `http.ResponseWriter`）。
 * @param {object} r - HTTP 请求对象（对应 Go `*http.Request`）。
 * @returns {void} 无返回值。
 */
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

/**
 * 使用常量时间比较校验传入的控制令牌是否与配置一致；未配置令牌时默认放行中断入口。
 * 使用场景：由 `HandleRunInterrupt` 和 `ServiceTokenOK` 调用。
 *
 * @param {string} got - 请求头携带的令牌值。
 * @returns {boolean} 校验通过返回 `true`，否则返回 `false`。
 */
Engine.prototype.controlTokenOK = function (got) {
  const want = this.controlToken;
  if (want === "") {
    return true;
  }
  const gotBuf = Buffer.from(got, "utf8");
  const wantBuf = Buffer.from(want, "utf8");
  if (gotBuf.length !== wantBuf.length) {
    return false;
  }
  return timingSafeEqual(gotBuf, wantBuf);
};

// ControlTokenHeader 承载进程间共享的服务凭证。
const ControlTokenHeader = controlTokenHeader;

/**
 * 返回本进程可达的内部 API 基础地址与共享服务令牌，供 API 平面上的进程间调用使用。
 * 使用场景：worker 向 API 进程转发 Runner 工作区操作等内部请求时获取目标地址和凭证。
 *
 * @returns {[string, string]} 返回 `[base, token]` 二元组。
 */
Engine.prototype.InternalAPI = function () {
  return [this.workspaceControlBase, this.controlToken];
};

/**
 * 判断传入令牌是否匹配已配置的共享服务令牌；与中断入口策略不同，未配置令牌时永不授权。
 * 使用场景：保护高权限的内部服务间 API 端点。
 *
 * @param {string} got - 待校验的令牌字符串。
 * @returns {boolean} 已配置令牌且常量时间比对一致时返回 `true`，否则返回 `false`。
 */
Engine.prototype.ServiceTokenOK = function (got) {
  const configured = this.controlToken !== "";
  return configured && this.controlTokenOK(got);
};

/**
 * 向单个目标 worker 发送 `POST /internal/runs/{runID}/interrupt` 中断通知并丢弃响应体。
 * 使用场景：由 `notifyRunControl` 或 `HTTPRunControlNotify` 触发跨进程中断。
 *
 * @param {object|null} client - HTTP 客户端配置对象（含 `Timeout` 毫秒数）。
 * @param {string} baseURL - 目标 worker 基础 URL。
 * @param {string} runID - 目标运行主键 ID。
 * @param {string} token - 可选共享控制令牌。
 * @returns {Promise<void>} 异步请求完成后的无值 Promise。
 */
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

/**
 * 构造一个向单个固定 worker URL 发送 HTTP 中断通知的回调函数。
 * 使用场景：测试环境或静态兜底配置中传入 `SetRunControlNotify`。
 *
 * @param {string} baseURL - 目标 worker 基础 URL。
 * @param {string} token - 共享控制令牌。
 * @returns {function(string): void} 接收 `runID` 并异步发送中断请求的函数。
 */
function HTTPRunControlNotify(baseURL, token) {
  const client = { Timeout: 800 };
  const base = baseURL.trim().replace(/\/+$/, "");
  return function (runID) {
    postRunInterrupt(client, base, runID, token);
  };
}

module.exports = { controlTokenHeader, ControlConfig, ControlTokenHeader, HTTPRunControlNotify };
