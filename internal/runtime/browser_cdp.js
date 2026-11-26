// browser_cdp.js —— 对应 Go 文件：internal/runtime/browser_cdp.go
// 作用：CDP 客户端：请求分发、管道传输与 WebSocket 传输。
// context.Context 译为 AbortSignal；(值, error) 译为成功返回值、失败 throw；
// goroutine 译为不 await 的异步函数；channel 译为 Promise；sync.Mutex 在单线程 JS 里不需要，略去；
// atomic.Int64 译为普通数字；gorilla/websocket 译为 Node 内置 WebSocket；bufio.Reader 译为行缓冲。

"use strict";

const { spawn } = require("node:child_process");

// cdpTransport：接口，JS 里用带 read/write/close 方法的对象表示，对应 Go 的 cdpTransport。

// cdpMessage：CDP 消息；Go 字段名为 ID/Method/SessionID/Params/Result/Error，JSON 键名见此处。
class cdpMessage {
  constructor(init = {}) {
    this.id = init.id ?? 0;
    this.method = init.method ?? "";
    this.sessionId = init.sessionId ?? "";
    this.params = init.params ?? null;
    this.result = init.result ?? null;
    this.error = init.error ?? null;
  }
}

// capitalize：wireToGo 的一部分，见 assignWireJSON。
function capitalize(key) {
  return key[0].toUpperCase() + key.slice(1);
}

// mapWireValue：把解析出的 JSON 值里所有对象键按首字母大写转换，对应 Go 按 json tag 解码。
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

// assignWireJSON：把 CDP 返回的 JSON（小写键）填进 out，对应 Go 的 json.Unmarshal。
// 键按全小写比对 out 已有字段；没有对应字段时按首字母大写新建；out 是数组时表示 Go 的 *string/*bool 等标量 out，填进 out[0]。
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

class cdpClient {
  constructor(transport, onEvent) {
    this.transport = transport;
    this.nextID = 0;
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

function newCDPClient(transport, onEvent) {
  return new cdpClient(transport, onEvent);
}

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

cdpClient.prototype.closed = function () {
  return this.doneFlag;
};

cdpClient.prototype.close = function () {
  if (this.closeOnce) {
    return;
  }
  this.closeOnce = true;
  this.doneFlag = true;
  this._resolveDone();
  this.transport.close().catch(() => {});
};

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

// pipeTransport：与 cdp-relay.mjs 讲换行分隔的 JSON，对应 Go 的 pipeTransport。
class pipeTransport {
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

pipeTransport.prototype.write = async function (body) {
  const data = Buffer.concat([Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from("\n")]);
  await new Promise((resolve, reject) => {
    this.stdin.write(data, (err) => (err ? reject(err) : resolve()));
  });
};

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

// wsTransport：WebSocket 传输，对应 Go 的 wsTransport。
class wsTransport {
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

wsTransport.prototype.write = async function (body) {
  this.conn.send(body);
};

wsTransport.prototype.close = async function () {
  this.conn.close();
};

module.exports = { cdpMessage, cdpClient, newCDPClient, pipeTransport, dialDockerCDP, wsTransport, dialWebSocketCDP, assignWireJSON };
