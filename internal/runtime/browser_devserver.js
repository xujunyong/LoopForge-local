/**
 * @file internal/runtime/browser_devserver.js
 * @description 对应 Go 文件：internal/runtime/browser_devserver.go。
 * 负责开发服务器预览请求的 HTTP 转发：将用户浏览器发往运行沙箱内 `localhost:port` 的请求
 * 经由 Docker 边车进程管道（`docker exec`）或宿主机直连 TCP 转发，并维护按运行 ID 缓存的 HTTP 客户端连接池。
 *
 * Go → JS 语法差异说明：
 * - `net/http` 客户端译为 `node:http`（`Transport.DialContext` 译为 `createConnection`）；
 * - `context.Context` 译为 `AbortSignal`；`sync.Mutex` 在单线程 JS 中省略；
 * - `time.Duration` 译为毫秒数；`errors.Is` 译为 `===`；`errors.As` 译为 `instanceof`；
 * - `(值, error)` 译为成功返回值、失败 `throw err`；仅 `error` 译为成功返回 `undefined`、失败 `throw err`；`(值, bool)` 译为 `[值, boolean]`；
 * - `map[string]*devServerClient` 与 `map[string]bool` 译为普通对象 `{}`；
 * - `execConn` 继承 `Duplex` 以便直接作为 `node:http` 的 socket，同时保留与 Go 同名的 `Read`/`Write`/`Close` 等方法。
 */

"use strict";

const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { Duplex } = require("node:stream");

const { BrowserState, BrowserHTTPResponse } = require("../domain/runner_workspace.js");
const { browserEndpoint, lookupBrowserEndpoint } = require("./browser.js");

// 开发服务器响应体上限（12 MiB），确保 base64 编码后仍在 runner 套接字 20 MiB 消息上限内。
const DevServerBodyLimit = 12 << 20;
const devServerEndpointTTL = 15 * 1000;
const devServerClientIdle = 10 * 60 * 1000;

// 表示目标端口上没有任何进程接受连接，对应 Go 的 ErrDevServerUnreachable。
const ErrDevServerUnreachable = new Error("dev server unreachable");

// 对应 Go 的 http.ErrUseLastResponse，表示不自动跟随重定向；Node 默认不跟随。
const errUseLastResponse = new Error("net/http: use last response");

/**
 * 缓存单个运行实例的开发服务器 HTTP 客户端及其最近探测/使用时间戳，对应 Go 的 `devServerClient`。
 */
class devServerClient {
  /**
   * 构造开发服务器客户端缓存条目，字段按 Go 零值初始化。
   *
   * @param {object} [init={}] 初始字段对象。
   * @param {browserEndpoint | null} [init.endpoint=null] 关联的浏览器端点信息。
   * @param {number} [init.checked=0] 最近一次确认端点有效的时间戳（毫秒，0 表示已失效）。
   * @param {number} [init.used=0] 最近一次使用该客户端的时间戳（毫秒）。
   * @param {object | null} [init.client=null] 封装了 `Do` 与 `closeIdleConnections` 的 HTTP 客户端对象。
   */
  constructor(init = {}) {
    this.endpoint = init.endpoint ?? null;
    this.checked = init.checked ?? 0;
    this.used = init.used ?? 0;
    this.client = init.client ?? null;
  }
}

// 对应 Go 的 map[string]*devServerClient，字符串键使用普通对象 {}；sync.Mutex 在单线程 JS 中省略。
const devServerClients = {
  items: {},
};

/**
 * 拨号连接到指定运行沙箱网络命名空间中的 `localhost:port`，可在测试中替换。
 * Docker 端点通过边车容器管道中继，宿主端点直接 TCP 连接本地端口。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {browserEndpoint} endpoint 已发现的浏览器端点。
 * @param {number} port 目标开发服务器端口号。
 * @returns {Promise<import("node:stream").Duplex>} 已连通的流式连接对象（`execConn` 或 `net.Socket`）。
 */
let devServerDial = async (ctx, endpoint, port) => {
  if (endpoint.Kind === "docker") {
    return dialDockerPort(ctx, endpoint.Container, port);
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "localhost");
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => reject(err));
    if (ctx instanceof AbortSignal) {
      if (ctx.aborted) {
        socket.destroy(ctx.reason);
      } else {
        ctx.addEventListener("abort", () => socket.destroy(ctx.reason), { once: true });
      }
    }
  });
};

// 查找运行浏览器端点的函数引用，可在测试中替换。
let devServerLookup = lookupBrowserEndpoint;

/**
 * 处理一次开发服务器预览 HTTP 代理请求，将请求转发到沙箱内的 `localhost:port` 并返回封装后的 `BrowserState`。
 * 校验端口、路径与方法白名单，剥离逐跳请求/响应头，并限制响应体不超过 `DevServerBodyLimit`。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} runID 运行实例 ID。
 * @param {object | null | undefined} req 浏览器 HTTP 请求（`domain.BrowserHTTPRequest`，含 `Port`/`Path`/`Method`/`Header`/`Body`）。
 * @returns {Promise<BrowserState>} 包含 HTTP 响应或可读失败原因的浏览器状态对象；入参非法时抛出错误。
 */
async function handleDevServerHTTP(ctx, runID, req) {
  if (req == null || req.Port <= 0 || req.Port > 65535 || !req.Path.startsWith("/") || /[\r\n]/.test(req.Path)) {
    throw new Error("无效的开发服务器请求");
  }
  const [client, endpoint, ok] = await devServerClientFor(ctx, runID);
  if (!ok) {
    return new BrowserState({ Available: false, Reason: "Agent 浏览器尚未启动：开发服务器预览需要它所在的沙箱网络" });
  }
  let method;
  switch (req.Method.trim().toUpperCase()) {
    case "":
    case "GET":
      method = "GET";
      break;
    case "HEAD":
      method = "HEAD";
      break;
    case "POST":
      method = "POST";
      break;
    case "PUT":
      method = "PUT";
      break;
    case "PATCH":
      method = "PATCH";
      break;
    case "DELETE":
      method = "DELETE";
      break;
    case "OPTIONS":
      method = "OPTIONS";
      break;
    default:
      throw new Error("无效或不支持的 HTTP 请求方法");
  }
  const target = "http://localhost:" + String(req.Port) + req.Path;
  const out = { method, url: target, headers: {}, body: req.Body, ctx };
  for (const [name, values] of Object.entries(req.Header ?? {})) {
    if (devServerHopHeader(name) || name.toLowerCase() === "host") {
      continue;
    }
    for (const v of values) {
      if (out.headers[name] === undefined) {
        out.headers[name] = [];
      }
      out.headers[name].push(v);
    }
  }
  // 开发服务器（如 Vite allowedHosts）会校验 Host 头，统一改写为 localhost:port。
  out.headers.Host = ["localhost:" + String(req.Port)];
  let res;
  try {
    res = await client.Do(out);
  } catch (err) {
    if (err === ErrDevServerUnreachable || err instanceof devServerDialError) {
      forgetDevServerEndpoint(runID, endpoint);
    }
    let unreachable = null;
    if (err instanceof devServerDialError) {
      unreachable = err;
    }
    if (unreachable != null) {
      if (devServerRefused(unreachable.err)) {
        return new BrowserState({ Available: true, Kind: endpoint.Kind, Reason: `端口 ${req.Port} 上没有正在监听的开发服务器` });
      }
      console.log(`browser dev server dial run=${runID} kind=${endpoint.Kind} container=${endpoint.Container} port=${req.Port}: ${unreachable.err.message}`);
      return new BrowserState({ Available: true, Kind: endpoint.Kind, Reason: `连接端口 ${req.Port} 失败：${unreachable.err.message}` });
    }
    if (ctx instanceof AbortSignal && ctx.aborted) {
      return new BrowserState({ Available: true, Kind: endpoint.Kind, Reason: `端口 ${req.Port} 的开发服务器响应超时` });
    }
    return new BrowserState({ Available: true, Kind: endpoint.Kind, Reason: "访问开发服务器失败：" + err.message });
  }
  // 对应 Go 的 io.ReadAll(io.LimitReader(res.Body, DevServerBodyLimit+1))，最多读取上限 + 1 字节用于超限判断。
  let body;
  try {
    body = await new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let done = false;
      const finish = (err) => {
        if (done) {
          return;
        }
        done = true;
        if (err != null) {
          reject(err);
        } else {
          resolve(Buffer.concat(chunks));
        }
      };
      res.Body.on("data", (chunk) => {
        const remaining = DevServerBodyLimit + 1 - total;
        if (remaining <= 0) {
          return;
        }
        const take = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(take);
        total += take.length;
        if (total >= DevServerBodyLimit + 1) {
          res.Body.destroy();
          finish(null);
        }
      });
      res.Body.once("end", () => finish(null));
      res.Body.once("error", (err) => finish(err));
      res.Body.once("close", () => finish(null));
    });
  } catch (err) {
    return new BrowserState({ Available: true, Kind: endpoint.Kind, Reason: "读取开发服务器响应失败：" + err.message });
  } finally {
    res.Body.destroy();
  }
  if (body.length > DevServerBodyLimit) {
    return new BrowserState({ Available: true, Kind: endpoint.Kind, Reason: `响应超过 ${DevServerBodyLimit >> 20} MB，预览暂不支持` });
  }
  const header = {};
  for (const [name, values] of Object.entries(res.Header)) {
    if (devServerHopHeader(name) || name.toLowerCase() === "content-length") {
      continue;
    }
    header[name] = values;
  }
  return new BrowserState({ Available: true, Kind: endpoint.Kind, HTTP: new BrowserHTTPResponse({ Status: res.StatusCode, Header: header, Body: body }) });
}

const devServerHop = {
  connection: true, "keep-alive": true, "proxy-connection": true, "proxy-authenticate": true,
  "proxy-authorization": true, te: true, trailer: true, "transfer-encoding": true, upgrade: true,
};

/**
 * 判断 HTTP 头部名称是否为不应跨代理转发的逐跳头（hop-by-hop header）。
 *
 * @param {string} name HTTP 头部名称。
 * @returns {boolean} 是逐跳头返回 `true`，否则返回 `false`。
 */
function devServerHopHeader(name) {
  return devServerHop[name.toLowerCase()] ?? false;
}

/**
 * 获取或创建指定运行实例对应的开发服务器 HTTP 客户端，并清理空闲超时的旧缓存。
 * 复用长连接池以避免每个资源请求都重新拉起 `docker exec` 进程。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} runID 运行实例 ID。
 * @returns {Promise<[object | null, browserEndpoint, boolean]>} 返回 `[HTTP 客户端或 null, 浏览器端点, 是否可用]` 元组。
 */
async function devServerClientFor(ctx, runID) {
  const now = Date.now();
  // Go 的 devServerClients.Lock/Unlock 在单线程 JS 中省略。
  for (const [id, c] of Object.entries(devServerClients.items)) {
    if (now - c.used > devServerClientIdle) {
      c.client.closeIdleConnections();
      delete devServerClients.items[id];
    }
  }
  let cached = devServerClients.items[runID] ?? null;
  if (cached != null && now - cached.checked < devServerEndpointTTL) {
    cached.used = now;
    return [cached.client, cached.endpoint, true];
  }
  const [endpoint, ok] = await devServerLookup(ctx, runID);
  if (!ok) {
    return [null, new browserEndpoint(), false];
  }
  cached = devServerClients.items[runID] ?? null;
  if (cached != null && cached.endpoint.Kind === endpoint.Kind && cached.endpoint.Container === endpoint.Container && cached.endpoint.WebSocket === endpoint.WebSocket && cached.endpoint.Workspace === endpoint.Workspace) {
    cached.checked = now;
    cached.used = now;
    return [cached.client, endpoint, true];
  }
  if (cached != null) {
    cached.client.closeIdleConnections();
  }
  const transport = {
    dialContext: async (dialCtx, network, addr) => {
      const idx = addr.lastIndexOf(":");
      if (idx === -1) {
        throw new Error("missing port in address");
      }
      const rawPort = addr.slice(idx + 1);
      const port = Number.parseInt(rawPort, 10);
      if (Number.isNaN(port)) {
        throw new Error(`strconv.Atoi: parsing "${rawPort}": invalid syntax`);
      }
      let conn;
      try {
        conn = await devServerDial(dialCtx, endpoint, port);
      } catch (err) {
        throw new devServerDialError(err);
      }
      return conn;
    },
    // Docker 连接对应子进程，每个运行保活少量空闲连接以免每次请求都触发 docker exec。
    maxIdleConnsPerHost: 8,
    idleConnTimeout: 90 * 1000,
    responseHeaderTimeout: 2 * 60 * 1000,
    forceAttemptHTTP2: false,
    agent: new http.Agent({ keepAlive: true, maxSockets: 8 }),
  };
  const client = {
    transport,
    checkRedirect: () => { throw errUseLastResponse; },
    closeIdleConnections: () => { transport.agent.destroy(); },
    // http.Client.Do 的 JS 实现：通过 node:http 发请求，将 Transport.DialContext 映射为 createConnection。
    Do(req) {
      return new Promise((resolve, reject) => {
        const target = new URL(req.url);
        const headers = {};
        for (const [name, values] of Object.entries(req.headers)) {
          headers[name] = values.length === 1 ? values[0] : values;
        }
        const request = http.request({
          method: req.method,
          host: target.hostname,
          port: Number(target.port),
          path: target.pathname + target.search,
          headers,
          agent: transport.agent,
          createConnection: (options, callback) => {
            transport.dialContext(req.ctx, "tcp", options.host + ":" + options.port).then(
              (socket) => callback(null, socket),
              (err) => callback(err),
            );
          },
        });
        const headerTimer = setTimeout(() => {
          request.destroy(new Error("response header timeout"));
        }, transport.responseHeaderTimeout);
        request.once("response", (res) => {
          clearTimeout(headerTimer);
          const header = {};
          for (const [name, value] of Object.entries(res.headers)) {
            header[name] = Array.isArray(value) ? value : [value];
          }
          resolve({ StatusCode: res.statusCode, Header: header, Body: res });
        });
        request.once("error", (err) => {
          clearTimeout(headerTimer);
          reject(err);
        });
        if (req.ctx instanceof AbortSignal) {
          if (req.ctx.aborted) {
            request.destroy(req.ctx.reason);
          } else {
            req.ctx.addEventListener("abort", () => request.destroy(req.ctx.reason), { once: true });
          }
        }
        if (req.body != null && req.body.length > 0) {
          request.write(req.body);
        }
        request.end();
      });
    },
  };
  devServerClients.items[runID] = new devServerClient({ endpoint, checked: now, used: now, client });
  return [client, endpoint, true];
}

/**
 * 将缓存中与指定端点匹配的条目标记为需重新探测（清零 `checked` 时间戳）。
 * 当拨号不可达时调用，避免继续复用已重建或已停止的容器端点。
 *
 * @param {string} runID 运行实例 ID。
 * @param {browserEndpoint} endpoint 发生不可达错误的浏览器端点。
 * @returns {void} 无返回值。
 */
function forgetDevServerEndpoint(runID, endpoint) {
  const c = devServerClients.items[runID] ?? null;
  if (c != null && c.endpoint.Kind === endpoint.Kind && c.endpoint.Container === endpoint.Container && c.endpoint.WebSocket === endpoint.WebSocket && c.endpoint.Workspace === endpoint.Workspace) {
    c.checked = 0;
  }
}

/**
 * 判断拨号错误是否明确表示“端口未监听（连接被拒）”，而非无法连通沙箱中继。
 * 兼容容器内中继脚本逗号分隔的多地址族错误码（如 `ECONNREFUSED,EADDRNOTAVAIL`）。
 *
 * @param {Error & { code?: string }} err 底层拨号错误对象。
 * @returns {boolean} 属于端口拒绝连接返回 `true`，否则返回 `false`。
 */
function devServerRefused(err) {
  if (err.code === "ECONNREFUSED") {
    return true;
  }
  let refused = false;
  for (const code of err.message.trim().split(",")) {
    switch (code.trim()) {
      case "ECONNREFUSED":
        refused = true;
        break;
      case "EADDRNOTAVAIL":
      case "ENETUNREACH":
      case "EAFNOSUPPORT":
        break;
      default:
        return false;
    }
  }
  return refused;
}

/**
 * 包装开发服务器拨号失败的错误类型，对应 Go 的 `devServerDialError`。
 * 解包目标固定为 `ErrDevServerUnreachable`，便于上层区分拨号失败与业务响应失败。
 */
class devServerDialError extends Error {
  /**
   * 构造拨号错误包装实例。
   *
   * @param {Error} err 底层拨号抛出的原始错误。
   */
  constructor(err) {
    super(err.message);
    this.err = err;
  }

  /**
   * 返回底层错误消息，对应 Go 的 `(e devServerDialError) Error() string`。
   *
   * @returns {string} 错误消息字符串。
   */
  Error() {
    return this.err.message;
  }

  /**
   * 返回标准哨兵错误 `ErrDevServerUnreachable`，对应 Go 的 `Unwrap() error`。
   *
   * @returns {Error} `ErrDevServerUnreachable` 哨兵错误。
   */
  Unwrap() {
    return ErrDevServerUnreachable;
  }
}

// 在 Docker 边车容器内运行的端口中继脚本：依次尝试 127.0.0.1 与 ::1，
// 连接成功后先输出 1 字节 0x01 握手信号，再双向透传 stdin/stdout。
const devServerPipeScript = String.raw`const net=require("net");const port=+process.argv[1];const hosts=["127.0.0.1","::1"];const codes=[];` +
  String.raw`(function go(){const s=net.connect({port,host:hosts.shift()});let up=false;` +
  String.raw`s.once("connect",()=>{up=true;process.stdout.write("\x01");process.stdin.pipe(s);s.on("data",d=>process.stdout.write(d));s.on("close",()=>process.stdout.write("",()=>process.exit(0)));});` +
  String.raw`s.on("error",e=>{if(up)return;codes.push(String(e.code||e));if(hosts.length)return go();process.stderr.write(codes.join(","));process.exit(2);});})();`;

/**
 * 通过 `docker exec` 在浏览器边车容器内建立到 `localhost:port` 的管道连接。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} container 浏览器边车容器名称。
 * @param {number} port 容器网络命名空间内监听的端口号。
 * @returns {Promise<execConn>} 握手完成的子进程 stdio 连接对象。
 */
async function dialDockerPort(ctx, container, port) {
  return dialExecPort(ctx, "docker", "exec", "-i", container, "node", "-e", devServerPipeScript, String(port));
}

/**
 * 启动一条将 stdio 中继到 TCP 端口的外部命令，等待 1 字节 `0x01` 握手信号（15 秒超时）。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} name 可执行文件名称。
 * @param {...string} args 命令行参数。
 * @returns {Promise<execConn>} 握手成功后的 `execConn` 实例；失败、取消或超时时关闭连接并抛出错误。
 */
async function dialExecPort(ctx, name, ...args) {
  const child = spawn(name, args);
  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk);
  });
  let startErr = null;
  const ready = new Promise((resolve) => {
    child.once("error", (err) => {
      startErr = err;
      resolve(err);
    });
    const onReadable = () => {
      const chunk = stdout.read(1);
      if (chunk == null) {
        stdout.once("readable", onReadable);
        return;
      }
      if (chunk[0] !== 1) {
        resolve(new Error("unexpected handshake"));
      } else {
        resolve(null);
      }
    };
    stdout.once("readable", onReadable);
    stdout.once("end", () => resolve(new Error("EOF")));
    stdout.once("error", (err) => resolve(err));
  });
  const conn = new execConn(child, stdin, stdout);
  const ctxDone = new Promise((resolve) => {
    if (!(ctx instanceof AbortSignal)) {
      return;
    }
    if (ctx.aborted) {
      resolve();
    } else {
      ctx.addEventListener("abort", () => resolve(), { once: true });
    }
  });
  const outcome = await Promise.race([
    ready.then((err) => ({ kind: "ready", err })),
    ctxDone.then(() => ({ kind: "ctx" })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 15 * 1000)),
  ]);
  switch (outcome.kind) {
    case "ready":
      if (outcome.err != null) {
        conn.Close();
        const msg = Buffer.concat(stderrChunks).toString("utf8").trim();
        if (msg !== "") {
          throw new Error(msg);
        }
        throw outcome.err;
      }
      return conn;
    case "ctx":
      conn.Close();
      throw ctx.reason;
    default:
      conn.Close();
      throw new Error("连接开发服务器超时");
  }
}

/**
 * 封装子进程 stdin/stdout 的流式连接对象，对应 Go 的 `execConn`（实现 `net.Conn`）。
 * 继承 Node `Duplex` 以便直接作为 `node:http` 的底层 socket，同时提供 Go 风格的 `Read`/`Write`/`Close` 等方法。
 */
class execConn extends Duplex {
  /**
   * 构造子进程 stdio 连接对象并桥接 stdout 数据流。
   *
   * @param {import("node:child_process").ChildProcess} cmd 中继子进程对象。
   * @param {import("node:stream").Writable} stdin 子进程标准输入流。
   * @param {import("node:stream").Readable} stdout 子进程标准输出流。
   */
  constructor(cmd, stdin, stdout) {
    super();
    this.cmd = cmd;
    this.stdin = stdin;
    this.stdout = stdout;
    this.onceDone = false;
    stdout.on("data", (chunk) => {
      if (!this.push(chunk)) {
        stdout.pause();
      }
    });
    stdout.on("end", () => {
      this.push(null);
    });
    stdout.on("error", (err) => {
      this.destroy(err);
    });
  }

  /**
   * Node `Duplex` 内部拉取回调，恢复子进程 stdout 读取。
   *
   * @returns {void} 无返回值。
   */
  _read() {
    this.stdout.resume();
  }

  /**
   * Node `Duplex` 内部写入回调，将数据写入子进程 stdin。
   *
   * @param {Buffer | string} chunk 待写入数据块。
   * @param {BufferEncoding} encoding 编码方式。
   * @param {(err?: Error | null) => void} callback 写入完成回调。
   * @returns {void} 无返回值。
   */
  _write(chunk, encoding, callback) {
    this.stdin.write(chunk, encoding, callback);
  }

  /**
   * Node `Duplex` 结束写入回调，关闭子进程 stdin。
   *
   * @param {(err?: Error | null) => void} callback 结束回调。
   * @returns {void} 无返回值。
   */
  _final(callback) {
    this.stdin.end();
    callback();
  }

  /**
   * Node `Duplex` 销毁回调，关闭连接与子进程。
   *
   * @param {Error | null} err 销毁错误。
   * @param {(err?: Error | null) => void} callback 销毁完成回调。
   * @returns {void} 无返回值。
   */
  _destroy(err, callback) {
    this.Close();
    callback(err);
  }

  /**
   * 从子进程 stdout 读取数据到目标缓冲区 `p`，对应 Go 的 `(*execConn).Read(p []byte) (int, error)`。
   *
   * @param {Buffer} p 接收读取字节的目标缓冲区。
   * @returns {Promise<number>} 实际读入的字节数；到达 EOF 或读取出错时抛出错误。
   */
  async Read(p) {
    const chunk = await new Promise((resolve, reject) => {
      const immediate = this.stdout.read(p.length);
      if (immediate != null) {
        resolve(immediate);
        return;
      }
      const onReadable = () => {
        const data = this.stdout.read(p.length);
        if (data != null) {
          cleanup();
          resolve(data);
        }
      };
      const onEnd = () => {
        cleanup();
        reject(new Error("EOF"));
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.stdout.removeListener("readable", onReadable);
        this.stdout.removeListener("end", onEnd);
        this.stdout.removeListener("error", onError);
      };
      this.stdout.on("readable", onReadable);
      this.stdout.once("end", onEnd);
      this.stdout.once("error", onError);
    });
    return chunk.copy(p, 0, 0, Math.min(chunk.length, p.length));
  }

  /**
   * 将缓冲区 `p` 写入子进程 stdin，对应 Go 的 `(*execConn).Write(p []byte) (int, error)`。
   *
   * @param {Buffer | string} p 待写入的字节数据。
   * @returns {Promise<number>} 写入的字节数；写入失败时抛出错误。
   */
  async Write(p) {
    const buf = Buffer.isBuffer(p) ? p : Buffer.from(p);
    await new Promise((resolve, reject) => {
      this.stdin.write(buf, (err) => (err ? reject(err) : resolve()));
    });
    return buf.length;
  }

  /**
   * 幂等关闭连接：结束 stdin 并强制终止子进程，对应 Go 的 `(*execConn).Close() error`。
   *
   * @returns {void} 无返回值。
   */
  Close() {
    if (this.onceDone) {
      return;
    }
    this.onceDone = true;
    try {
      this.stdin.end();
    } catch {}
    if (this.cmd.pid != null) {
      try {
        this.cmd.kill("SIGKILL");
      } catch {}
    }
    // Node 在子进程退出时自动回收，无需像 Go 那样后台 Wait。
  }

  /**
   * 返回本地虚拟地址，对应 Go 的 `LocalAddr() net.Addr`。
   *
   * @returns {execAddr} 虚拟执行地址对象。
   */
  LocalAddr() {
    return new execAddr();
  }

  /**
   * 返回远端虚拟地址，对应 Go 的 `RemoteAddr() net.Addr`。
   *
   * @returns {execAddr} 虚拟执行地址对象。
   */
  RemoteAddr() {
    return new execAddr();
  }

  /**
   * 空操作截止时间设置，对应 Go 的 `SetDeadline(time.Time) error`。
   *
   * @returns {void} 无返回值。
   */
  SetDeadline() {}

  /**
   * 空操作读截止时间设置，对应 Go 的 `SetReadDeadline(time.Time) error`。
   *
   * @returns {void} 无返回值。
   */
  SetReadDeadline() {}

  /**
   * 空操作写截止时间设置，对应 Go 的 `SetWriteDeadline(time.Time) error`。
   *
   * @returns {void} 无返回值。
   */
  SetWriteDeadline() {}

  /**
   * Node `http.ClientRequest` 兼容方法，空操作返回自身。
   *
   * @returns {execConn} 当前连接实例。
   */
  setTimeout() {
    return this;
  }

  /**
   * Node `net.Socket` 兼容方法，空操作返回自身。
   *
   * @returns {execConn} 当前连接实例。
   */
  ref() {
    return this;
  }

  /**
   * Node `net.Socket` 兼容方法，空操作返回自身。
   *
   * @returns {execConn} 当前连接实例。
   */
  unref() {
    return this;
  }
}

/**
 * 表示 `execConn` 的虚拟网络地址，对应 Go 的 `execAddr`（实现 `net.Addr`）。
 */
class execAddr {
  /**
   * 返回虚拟网络协议名称 `"exec"`。
   *
   * @returns {string} 固定返回 `"exec"`。
   */
  Network() {
    return "exec";
  }

  /**
   * 返回虚拟地址字符串 `"docker-exec"`。
   *
   * @returns {string} 固定返回 `"docker-exec"`。
   */
  String() {
    return "docker-exec";
  }
}

module.exports = {
  DevServerBodyLimit,
  ErrDevServerUnreachable,
  devServerClient,
  devServerDial,
  devServerLookup,
  handleDevServerHTTP,
  devServerHop,
  devServerHopHeader,
  devServerClientFor,
  forgetDevServerEndpoint,
  devServerRefused,
  devServerDialError,
  devServerPipeScript,
  dialDockerPort,
  dialExecPort,
  execConn,
  execAddr,
};
