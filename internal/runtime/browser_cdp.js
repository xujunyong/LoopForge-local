/**
 * @file internal/runtime/browser_cdp.js
 * @description 对应 Go 文件：internal/runtime/browser_cdp.go。
 * 负责 Chrome DevTools Protocol (CDP) 客户端封装，包括请求-响应关联与事件分发、
 * 面向 Docker 边车的标准输入输出管道传输（`pipeTransport`），以及面向宿主浏览器的 WebSocket 传输（`wsTransport`）。
 *
 * Go → JS 语法差异说明：
 * - `context.Context` 译为 `AbortSignal`；
 * - `(值, error)` 译为成功返回值、失败 `throw err`；仅 `error` 译为成功返回 `undefined`、失败 `throw err`；
 * - `goroutine` 译为不 `await` 的异步函数；`channel` / `select` 译为 `Promise`；
 * - `sync.Mutex` 在单线程 JS 中省略；`atomic.Int64` 译为普通数字自增；
 * - `cdpClient.pending` 对应 Go 的 `map[int64]chan cdpMessage`，因键为数字（非字符串键），按规则使用 `Map`；
 * - `gorilla/websocket` 译为 Node 内置 `WebSocket`；`bufio.Reader` 译为行缓冲队列。
 */

"use strict";

const { spawn } = require("node:child_process");

// cdpTransport：接口约定，JS 中由实现 read/write/close 方法的对象表示，对应 Go 的 cdpTransport。

/**
 * 表示一条 CDP JSON 协议消息，对应 Go 的 `cdpMessage`。
 * 为兼容同包事件消费者与线上 JSON 键名，字段采用 CDP 协议小写键名（Go 对应字段为 ID/Method/SessionID/Params/Result/Error）。
 */
class cdpMessage {
  /**
   * 构造 CDP 消息对象，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] 解析后的 JSON 字段对象。
   * @param {number} [init.id=0] 请求/响应序号（事件消息为 0）。
   * @param {string} [init.method=""] CDP 方法名或事件名。
   * @param {string} [init.sessionId=""] 目标标签页会话 ID。
   * @param {any} [init.params=null] 请求参数或事件负载。
   * @param {any} [init.result=null] 响应结果负载。
   * @param {{ message: string } | null} [init.error=null] CDP 协议错误对象。
   */
  constructor(init = {}) {
    this.id = init.id ?? 0;
    this.method = init.method ?? "";
    this.sessionId = init.sessionId ?? "";
    this.params = init.params ?? null;
    this.result = init.result ?? null;
    this.error = init.error ?? null;
  }
}

/**
 * 将字符串首字母转为大写，用于把 CDP 小写 JSON 键映射为 Go 导出字段风格。
 *
 * @param {string} key 原始 JSON 键名。
 * @returns {string} 首字母大写后的键名。
 */
function capitalize(key) {
  return key[0].toUpperCase() + key.slice(1);
}

/**
 * 递归将 JSON 对象中的键转为首字母大写形式，模拟 Go 按 json tag 反序列化到匿名/具名结构体。
 *
 * @param {any} value 任意已解析的 JSON 值。
 * @returns {any} 键名转换后的值。
 */
function mapWireValue(value) {
  if (Array.isArray(value)) {
    return value.map(mapWireValue);
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[capitalize(key)] = mapWireValue(val);
    }
    return out;
  }
  return value;
}

/**
 * 将 CDP 返回的线协议 JSON 值（小写键）填充到目标对象 `out`，对应 Go 的 `json.Unmarshal`。
 * 优先按忽略大小写匹配 `out` 已有字段；若 `out` 为单元素数组则表示标量出参指针，结果写入 `out[0]`。
 *
 * @param {object | any[] | null | undefined} out 目标接收对象或单元素数组。
 * @param {any} value 解析后的 CDP 响应 JSON 值。
 * @returns {void} 无返回值。
 */
function assignWireJSON(out, value) {
  if (out == null || value == null) {
    return;
  }
  if (Array.isArray(out)) {
    out[0] = mapWireValue(value);
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  for (const [key, val] of Object.entries(value)) {
    const targetKey = Object.keys(out).find((k) => k.toLowerCase() === key.toLowerCase()) ?? capitalize(key);
    const existing = out[targetKey];
    if (val !== null && typeof val === "object" && !Array.isArray(val) && existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
      assignWireJSON(existing, val);
    } else if (Array.isArray(val)) {
      out[targetKey] = val.map((item) => (item !== null && typeof item === "object" && !Array.isArray(item) ? mapWireValue(item) : item));
    } else if (val !== null && typeof val === "object") {
      out[targetKey] = mapWireValue(val);
    } else {
      out[targetKey] = val;
    }
  }
}

/**
 * CDP 协议客户端，负责维护请求序号、等待响应映射以及后台读循环事件分发。
 * 对应 Go 的 `cdpClient`。
 */
class cdpClient {
  /**
   * 构造 CDP 客户端并立即启动后台读循环。
   *
   * @param {object} transport 实现 `read`/`write`/`close` 方法的底层传输对象。
   * @param {((msg: cdpMessage) => void) | null | undefined} onEvent 收到 CDP 推送事件时的回调函数。
   */
  constructor(transport, onEvent) {
    this.transport = transport;
    this.nextID = 0;
    // 对应 Go 的 map[int64]chan cdpMessage，键为数字（非字符串键），按规则使用 Map。
    this.pending = new Map();
    this.onEvent = onEvent ?? null;
    this.doneFlag = false;
    this._resolveDone = null;
    this.donePromise = new Promise((resolve) => {
      this._resolveDone = resolve;
    });
    this.closeOnce = false;
    this.readLoop();
  }
}

/**
 * 创建并启动一个新的 CDP 客户端实例，对应 Go 的 `newCDPClient`。
 *
 * @param {object} transport 底层 CDP 传输对象。
 * @param {((msg: cdpMessage) => void) | null | undefined} onEvent 事件回调函数。
 * @returns {cdpClient} 新建的 CDP 客户端实例。
 */
function newCDPClient(transport, onEvent) {
  return new cdpClient(transport, onEvent);
}

/**
 * 持续从底层传输读取完整 CDP 消息并路由到等待中的请求或事件回调，传输断开时自动关闭客户端。
 *
 * @returns {Promise<void>} 无返回值。
 */
cdpClient.prototype.readLoop = async function () {
  try {
    for (;;) {
      const raw = await this.transport.read();
      let msg;
      try {
        msg = new cdpMessage(JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw));
      } catch {
        continue;
      }
      if (msg.id !== 0) {
        const ch = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (ch != null) {
          ch(msg);
        }
        continue;
      }
      if (msg.method !== "" && this.onEvent != null) {
        this.onEvent(msg);
      }
    }
  } finally {
    this.close();
  }
};

/**
 * 判断客户端是否已关闭。
 *
 * @returns {boolean} 已关闭返回 `true`，否则返回 `false`。
 */
cdpClient.prototype.closed = function () {
  return this.doneFlag;
};

/**
 * 幂等关闭 CDP 客户端，触发等待中的调用解除阻塞并关闭底层传输。
 *
 * @returns {void} 无返回值。
 */
cdpClient.prototype.close = function () {
  if (this.closeOnce) {
    return;
  }
  this.closeOnce = true;
  this.doneFlag = true;
  this._resolveDone();
  this.transport.close().catch(() => {});
};

/**
 * 发送一条 CDP 请求并等待对应响应；支持按 `session` 定向标签页，并监听连接断开与 `ctx` 取消。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} session 目标会话 ID，浏览器级调用传空字符串 `""`。
 * @param {string} method CDP 方法名（如 `"Page.navigate"`）。
 * @param {object | null | undefined} params 请求参数对象，无参数时传 `null`。
 * @param {object | any[] | null | undefined} out 响应结果接收对象，不关心返回值时传 `null`。
 * @returns {Promise<void>} 无返回值；写入失败、连接断开、取消或服务端返回错误时抛出错误。
 */
cdpClient.prototype.call = async function (ctx, session, method, params, out) {
  const id = ++this.nextID;
  let raw = null;
  if (params != null) {
    raw = JSON.parse(JSON.stringify(params));
  }
  const wire = { id, method };
  if (session !== "") {
    wire.sessionId = session;
  }
  if (raw != null) {
    wire.params = raw;
  }
  const body = Buffer.from(JSON.stringify(wire), "utf8");
  let resolveMsg;
  const msgPromise = new Promise((resolve) => {
    resolveMsg = resolve;
  });
  this.pending.set(id, resolveMsg);
  try {
    await this.transport.write(body);
    const result = await new Promise((resolve, reject) => {
      const cleanup = () => {
        if (ctx instanceof AbortSignal) {
          ctx.removeEventListener("abort", onAbort);
        }
      };
      const onAbort = () => {
        cleanup();
        reject(ctx.reason ?? new Error("context canceled"));
      };
      msgPromise.then((msg) => {
        cleanup();
        resolve({ kind: "msg", msg });
      });
      this.donePromise.then(() => {
        cleanup();
        resolve({ kind: "done" });
      });
      if (ctx instanceof AbortSignal) {
        if (ctx.aborted) {
          onAbort();
          return;
        }
        ctx.addEventListener("abort", onAbort, { once: true });
      }
    });
    if (result.kind === "done") {
      throw new Error("浏览器连接已断开");
    }
    const msg = result.msg;
    if (msg.error != null) {
      throw new Error(`${method}: ${msg.error.message}`);
    }
    if (out != null && msg.result != null) {
      assignWireJSON(out, msg.result);
    }
  } finally {
    this.pending.delete(id);
  }
};

/**
 * 基于子进程 stdin/stdout 换行分隔 JSON 的 CDP 传输，用于与容器内 `cdp-relay.mjs` 通信。
 * 对应 Go 的 `pipeTransport`。
 */
class pipeTransport {
  /**
   * 构造管道传输对象并挂载 stdout 行切分监听。
   *
   * @param {import("node:child_process").ChildProcess} cmd 运行 `cdp-relay.mjs` 的子进程对象。
   */
  constructor(cmd) {
    this.cmd = cmd;
    this.stdin = cmd.stdin;
    this.buffer = "";
    this.lines = [];
    this.waiters = [];
    this.ended = false;
    cmd.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (this.waiters.length > 0) {
          this.waiters.shift()(line);
        } else {
          this.lines.push(line);
        }
      }
    });
    const end = () => {
      this.ended = true;
      while (this.waiters.length > 0) {
        this.waiters.shift()(null);
      }
    };
    cmd.stdout.on("end", end);
    cmd.stdout.on("close", end);
    cmd.stdout.on("error", end);
  }
}

/**
 * 通过 `docker exec` 启动容器内 `cdp-relay.mjs` 并校验就绪握手消息（20 秒超时）。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} container 浏览器边车容器名称。
 * @returns {Promise<pipeTransport>} 已完成握手的管道传输实例。
 */
async function dialDockerCDP(ctx, container) {
  const cmd = spawn("docker", ["exec", "-i", container, "node", "/opt/agentflow/cdp-relay.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
  let spawnErr = null;
  cmd.on("error", (err) => {
    spawnErr = err;
  });
  await new Promise((resolve) => setImmediate(resolve));
  if (spawnErr != null) {
    throw spawnErr;
  }
  const t = new pipeTransport(cmd);
  const ready = t.read().then((line) => {
    if (line.toString("utf8") !== `{"relay":"ready"}`) {
      throw new Error("unexpected relay handshake");
    }
  });
  ready.catch(() => {});
  const timeoutError = new Error("连接浏览器超时");
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(timeoutError), 20 * 1000);
  });
  const abortPromise = new Promise((_, reject) => {
    if (ctx instanceof AbortSignal) {
      if (ctx.aborted) {
        reject(ctx.reason);
      } else {
        ctx.addEventListener("abort", () => reject(ctx.reason), { once: true });
      }
    }
  });
  abortPromise.catch(() => {});
  try {
    await Promise.race([ready, timeout, abortPromise]);
  } catch (err) {
    await t.close();
    if (err === timeoutError) {
      throw timeoutError;
    }
    if (ctx instanceof AbortSignal && ctx.aborted) {
      throw ctx.reason;
    }
    throw new Error(`连接浏览器失败: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }
  return t;
}

/**
 * 从管道中读取下一行完整 CDP JSON 消息（不含末尾换行符）。
 *
 * @returns {Promise<Buffer>} 消息字节缓冲区；管道已关闭时抛出错误。
 */
pipeTransport.prototype.read = async function () {
  if (this.lines.length > 0) {
    return Buffer.from(this.lines.shift(), "utf8");
  }
  if (this.ended) {
    throw new Error("pipe closed");
  }
  const line = await new Promise((resolve) => this.waiters.push(resolve));
  if (line == null) {
    throw new Error("pipe closed");
  }
  return Buffer.from(line, "utf8");
};

/**
 * 向子进程 stdin 写入一条以换行符结尾的 CDP JSON 消息。
 *
 * @param {Buffer | string} body 序列化后的 JSON 消息体。
 * @returns {Promise<void>} 无返回值；写入失败时抛出错误。
 */
pipeTransport.prototype.write = async function (body) {
  const data = Buffer.concat([Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from("\n")]);
  await new Promise((resolve, reject) => {
    this.stdin.write(data, (err) => (err ? reject(err) : resolve()));
  });
};

/**
 * 关闭 stdin、终止中继子进程并等待其退出。
 *
 * @returns {Promise<void>} 无返回值。
 */
pipeTransport.prototype.close = async function () {
  try {
    this.stdin.end();
  } catch {}
  if (this.cmd != null) {
    try {
      this.cmd.kill("SIGKILL");
    } catch {}
    await new Promise((resolve) => {
      if (this.cmd.exitCode != null) {
        resolve();
      } else {
        this.cmd.on("close", resolve);
      }
    });
  }
};

/**
 * 基于 WebSocket 连接的 CDP 传输，用于连接宿主机本地 Chromium 调试端口。
 * 对应 Go 的 `wsTransport`。
 */
class wsTransport {
  /**
   * 构造 WebSocket 传输对象并注册消息与断开事件队列。
   *
   * @param {WebSocket} conn 已打开的 WebSocket 实例。
   */
  constructor(conn) {
    this.conn = conn;
    this.messages = [];
    this.waiters = [];
    this.closed = false;
    conn.addEventListener("message", (event) => {
      const data = event.data;
      const body = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      if (this.waiters.length > 0) {
        this.waiters.shift()(body);
      } else {
        this.messages.push(body);
      }
    });
    const fail = () => {
      this.closed = true;
      while (this.waiters.length > 0) {
        this.waiters.shift()(null);
      }
    };
    conn.addEventListener("close", fail);
    conn.addEventListener("error", fail);
  }
}

/**
 * 拨号连接宿主 Chromium 的 CDP WebSocket 地址（10 秒握手超时）。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} url CDP WebSocket URL（如 `ws://127.0.0.1:9222/devtools/browser/...`）。
 * @returns {Promise<wsTransport>} 已就绪的 WebSocket 传输实例；连接失败或超时时抛出错误。
 */
async function dialWebSocketCDP(ctx, url) {
  let conn;
  try {
    conn = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("websocket dial timeout")), 10 * 1000);
      const cleanup = () => {
        clearTimeout(timer);
        conn.removeEventListener("open", onOpen);
        conn.removeEventListener("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (event) => {
        cleanup();
        reject(event.error ?? new Error("websocket dial failed"));
      };
      conn.addEventListener("open", onOpen, { once: true });
      conn.addEventListener("error", onError, { once: true });
      if (ctx instanceof AbortSignal) {
        if (ctx.aborted) {
          cleanup();
          reject(ctx.reason);
        } else {
          ctx.addEventListener("abort", () => {
            cleanup();
            try {
              conn.close();
            } catch {}
            reject(ctx.reason);
          }, { once: true });
        }
      }
    });
  } catch (err) {
    throw new Error(`连接浏览器失败: ${err.message}`);
  }
  // Go 的 conn.SetReadLimit(64MB)：Node 内置 WebSocket 无此设置，略去。
  return new wsTransport(conn);
}

/**
 * 读取下一条 WebSocket 文本/二进制消息。
 *
 * @returns {Promise<Buffer>} 消息字节缓冲区；连接已关闭时抛出错误。
 */
wsTransport.prototype.read = async function () {
  if (this.messages.length > 0) {
    return this.messages.shift();
  }
  if (this.closed) {
    throw new Error("websocket closed");
  }
  const body = await new Promise((resolve) => this.waiters.push(resolve));
  if (body == null) {
    throw new Error("websocket closed");
  }
  return body;
};

/**
 * 通过 WebSocket 发送一条 CDP 消息。
 *
 * @param {Buffer | string} body 序列化后的 JSON 消息体。
 * @returns {Promise<void>} 无返回值。
 */
wsTransport.prototype.write = async function (body) {
  this.conn.send(body);
};

/**
 * 关闭底层 WebSocket 连接。
 *
 * @returns {Promise<void>} 无返回值。
 */
wsTransport.prototype.close = async function () {
  this.conn.close();
};

module.exports = { cdpMessage, cdpClient, newCDPClient, pipeTransport, dialDockerCDP, wsTransport, dialWebSocketCDP, assignWireJSON };
