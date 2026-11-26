// browser_devserver.js —— 对应 Go 文件：internal/runtime/browser_devserver.go
// 作用：开发服务器预览：把浏览器请求转发到运行沙箱内的 localhost 端口。
// Go 的 net/http 客户端译为 node:http（Transport.DialContext 译为 createConnection）；
// context.Context 译为 AbortSignal；sync.Mutex 译为空操作对象，JS 单线程；
// time.Duration 译为毫秒数；errors.Is 译为 ===，errors.As 译为 instanceof；
// (值, error) 译为返回值、失败 throw，(值, bool) 译为 [值, bool]。

"use strict";

const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { Duplex } = require("node:stream");

const { BrowserState, BrowserHTTPResponse } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.BrowserState/BrowserHTTPResponse，domain 已翻译
const { lookupBrowserEndpoint } = require("./browser.js"); // 对应 Go 同包函数，browser.js 待翻译

// Dev server access: the user's own browser renders a dev server that runs
// in the run sandbox, and this side forwards each HTTP request to
// localhost:port in the sandbox's network namespace. Docker sandboxes are
// reached through the browser sidecar (it shares that namespace and ships
// node); host drivers reach the port directly.

// DevServerBodyLimit keeps a response, base64 encoded, inside the runner
// socket's 20 MiB message limit.
const DevServerBodyLimit = 12 << 20;
const devServerEndpointTTL = 15 * 1000;
const devServerClientIdle = 10 * 60 * 1000;

// ErrDevServerUnreachable means nothing accepted a connection on the port.
const ErrDevServerUnreachable = new Error("dev server unreachable");

// http.ErrUseLastResponse：CheckRedirect 返回它表示不跟随重定向；Node 默认不跟随。
const errUseLastResponse = new Error("net/http: use last response");

const devServerClients = {
  Lock() {},
  Unlock() {},
  items: new Map(),
};

// devServerDial is swapped in tests.
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

// devServerLookup is swapped in tests.
let devServerLookup = lookupBrowserEndpoint;

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
  // Dev servers check Host against their allow list (Vite allowedHosts).
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
  // io.ReadAll(io.LimitReader(res.Body, DevServerBodyLimit+1))：最多收这么多字节。
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

function devServerHopHeader(name) { return devServerHop[name.toLowerCase()] ?? false; }

async function devServerClientFor(ctx, runID) {
  const now = Date.now();
  devServerClients.Lock();
  for (const [id, c] of devServerClients.items) {
    if (now - c.used > devServerClientIdle) {
      c.client.closeIdleConnections();
      devServerClients.items.delete(id);
    }
  }
  let cached = devServerClients.items.get(runID);
  if (cached != null && now - cached.checked < devServerEndpointTTL) {
    cached.used = now;
    devServerClients.Unlock();
    return [cached.client, cached.endpoint, true];
  }
  devServerClients.Unlock();
  const [endpoint, ok] = devServerLookup(ctx, runID);
  if (!ok) {
    return [null, { Kind: "", Container: "", WebSocket: "", Workspace: "" }, false];
  }
  devServerClients.Lock();
  try {
    cached = devServerClients.items.get(runID);
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
      // Each docker connection is a process; keep a few warm per run so a
      // page load does not pay a docker exec per request.
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
      // http.Client.Do 的 JS 实现：node:http 发请求，Transport.DialContext 译为 createConnection。
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
    devServerClients.items.set(runID, { endpoint, checked: now, used: now, client });
    return [client, endpoint, true];
  } finally {
    devServerClients.Unlock();
  }
}

function forgetDevServerEndpoint(runID, endpoint) {
  devServerClients.Lock();
  try {
    const c = devServerClients.items.get(runID);
    if (c != null && c.endpoint.Kind === endpoint.Kind && c.endpoint.Container === endpoint.Container && c.endpoint.WebSocket === endpoint.WebSocket && c.endpoint.Workspace === endpoint.Workspace) {
      c.checked = 0;
    }
  } finally {
    devServerClients.Unlock();
  }
}

// devServerRefused tells a port nobody listens on from a relay that could
// not reach the sandbox at all: only refusals (and a loopback family the
// sandbox lacks) mean the dev server is not up.
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

class devServerDialError extends Error {
  constructor(err) {
    super(err.message);
    this.err = err;
  }
  Unwrap() { return ErrDevServerUnreachable; }
}

// devServerPipeScript connects stdio to localhost:port inside the sidecar.
// It prints one 0x01 byte once connected, so a refused port fails the dial
// instead of surfacing later as an empty response. Vite and friends may bind
// either loopback family, so ::1 is tried after 127.0.0.1; a failure
// reports each attempt's error code, comma separated.
const devServerPipeScript = String.raw`const net=require("net");const port=+process.argv[1];const hosts=["127.0.0.1","::1"];const codes=[];` +
  String.raw`(function go(){const s=net.connect({port,host:hosts.shift()});let up=false;` +
  String.raw`s.once("connect",()=>{up=true;process.stdout.write("\x01");process.stdin.pipe(s);s.on("data",d=>process.stdout.write(d));s.on("close",()=>process.stdout.write("",()=>process.exit(0)));});` +
  String.raw`s.on("error",e=>{if(up)return;codes.push(String(e.code||e));if(hosts.length)return go();process.stderr.write(codes.join(","));process.exit(2);});})();`;

async function dialDockerPort(ctx, container, port) {
  return dialExecPort(ctx, "docker", "exec", "-i", container, "node", "-e", devServerPipeScript, String(port));
}

// dialExecPort runs a command that relays its stdio to a TCP port.
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

// execConn：子进程 stdio 上的 net.Conn；Node 里译为 Duplex 流，这样它能直接
// 作为 node:http 的 socket 用，Go 的 Read/Write 对应 _read/_write。
class execConn extends Duplex {
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
  _read() {
    this.stdout.resume();
  }
  _write(chunk, encoding, callback) {
    this.stdin.write(chunk, encoding, callback);
  }
  _final(callback) {
    this.stdin.end();
    callback();
  }
  _destroy(err, callback) {
    this.Close();
    callback(err);
  }
  Close() {
    if (this.onceDone) {
      return null;
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
    return null;
  }
  LocalAddr() { return new execAddr(); }
  RemoteAddr() { return new execAddr(); }
  SetDeadline() { return null; }
  SetReadDeadline() { return null; }
  SetWriteDeadline() { return null; }
  // Node 的 http 客户端会把 socket 当作 net.Socket 用到这几个方法；
  // 对应 Go 里 execConn 上返回 nil 的 deadline 方法，这里同样为空操作。
  setTimeout() { return this; }
  ref() { return this; }
  unref() { return this; }
}

class execAddr {
  Network() { return "exec"; }
  String() { return "docker-exec"; }
}

module.exports = {
  DevServerBodyLimit,
  ErrDevServerUnreachable,
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
