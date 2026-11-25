// client.js —— 对应 Go 文件：internal/mcpclient/client.go
// 作用：最小的 Streamable HTTP MCP 客户端，发 JSON-RPC 2.0 工具调用。
// Go 的 time.Duration 译为毫秒数；context 译为 AbortSignal（可空）；
// http 请求译为 fetch；Go 的 struct 用类对应，JSON 字段名见各类的注释。

"use strict";

// rpcRequest：Go 的 rpcRequest，JSON 字段名是 Go 的 json tag（JSONRPC→jsonrpc，ID→id）。
class RpcRequest {
  constructor(init = {}) {
    this.jsonrpc = init.jsonrpc ?? "";
    this.id = init.id ?? 0;
    this.method = init.method ?? "";
    this.params = init.params;
  }
}

// rpcResponse：Go 的 rpcResponse；Result 是原始 JSON（Go 的 json.RawMessage），保持原样。
class RpcResponse {
  constructor(init = {}) {
    this.jsonrpc = init.jsonrpc ?? "";
    this.id = init.id ?? 0;
    this.result = init.result;
    this.error = init.error != null ? new RpcError(init.error) : null;
  }
}

// rpcError：Go 的 rpcError。
class RpcError {
  constructor(init = {}) {
    this.code = init.code ?? 0;
    this.message = init.message ?? "";
  }
}

// toolCallResult：Go 的 toolCallResult，Content 是 {type, text} 的数组。
class ToolCallResult {
  constructor(init = {}) {
    this.content = (init.content ?? []).map((block) => ({ type: block.type ?? "", text: block.text ?? "" }));
    this.isError = init.isError ?? false;
  }
}

// Client is a minimal Streamable HTTP MCP client that sends JSON-RPC 2.0
// tool-call requests to an MCP gateway and parses the response.
class Client {
  constructor(url, headers, httpTimeout) {
    this.url = url;
    this.hdrs = headers;
    this.httpTimeout = httpTimeout;
    this.nextID = 0;
    this.init = false;
  }
}

function New(url, headers) {
  return new Client(url.replace(/\/+$/, ""), headers, 60 * 1000);
}

// SetHeaders updates the HTTP headers (e.g., auth tokens) at runtime.
Client.prototype.SetHeaders = function (headers) {
  this.hdrs = headers;
};

// Header returns one request header, or empty if the client is nil.
Client.prototype.Header = function (key) {
  if (this == null) {
    return "";
  }
  for (const [k, v] of Object.entries(this.hdrs)) {
    if (k.toLowerCase() === key.toLowerCase()) {
      return v;
    }
  }
  return "";
};

// Clone returns a client that shares the same URL and headers with an optional
// request timeout. The original client is not mutated.
Client.prototype.Clone = function (timeout) {
  if (this == null) {
    return null;
  }
  return New(this.url, cloneHeaders(this.hdrs)).WithTimeout(timeout);
};

// WithTimeout sets the HTTP timeout on this client and returns it.
Client.prototype.WithTimeout = function (timeout) {
  if (this != null && timeout > 0) {
    this.httpTimeout = timeout;
  }
  return this;
};

// postJSON：CallTool / ListTools / ensureInit 三处共用的发 POST 请求部分在 Go 里各写了一遍，
// 这里只抽出发请求一步，状态判断与读响应仍按 Go 的样子写在各调用处。
Client.prototype.postJSON = async function (ctx, req) {
  const body = JSON.stringify(req);
  const signal = ctx instanceof AbortSignal ? ctx : AbortSignal.timeout(this.httpTimeout);
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json, text/event-stream");
  for (const [k, v] of Object.entries(this.hdrs)) {
    headers.set(k, v);
  }
  return fetch(this.url, { method: "POST", headers, body, signal });
};

// CallTool invokes a named MCP tool with the given arguments and returns the
// text content of the first result block.
Client.prototype.CallTool = async function (name, args) {
  return this.CallToolContext(null, name, args);
};

// CallToolContext is CallTool with a caller-supplied deadline/cancellation.
Client.prototype.CallToolContext = async function (ctx, name, args) {
  await this.ensureInit(ctx);
  this.nextID++;
  const id = this.nextID;

  const req = new RpcRequest({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

  let resp;
  try {
    resp = await this.postJSON(ctx, req);
  } catch (err) {
    throw new Error(`mcp request ${name}: ${err}`);
  }
  if (resp.status < 200 || resp.status >= 300) {
    const body = Buffer.from(await resp.arrayBuffer()).subarray(0, 8 * 1024);
    throw new Error(`gateway HTTP ${resp.status}: ${body.toString("utf8").trim()}`);
  }
  let raw;
  try {
    raw = await this.readResponse(resp);
  } catch (err) {
    throw new Error(`mcp response ${name}: ${err}`);
  }

  let gatewayErr;
  try {
    gatewayErr = JSON.parse(raw.toString("utf8"));
  } catch {
    gatewayErr = null;
  }
  if (gatewayErr != null && gatewayErr.error !== undefined && gatewayErr.error !== "") {
    const check = JSON.parse(raw.toString("utf8"));
    if (check.result === undefined && check.id === undefined) {
      throw new Error(`mcp gateway error: ${gatewayErr.error}`);
    }
  }

  let rpcResp;
  try {
    rpcResp = new RpcResponse(JSON.parse(raw.toString("utf8")));
  } catch (err) {
    throw new Error(`mcp decode ${name}: ${err} (body: ${raw.toString("utf8")})`);
  }
  if (rpcResp.error != null) {
    throw new Error(`mcp tool ${name} error [${rpcResp.error.code}]: ${rpcResp.error.message}`);
  }

  // Go 的 json.Unmarshal 失败时直接返回 Result 的原始文本。
  let result;
  if (rpcResp.result != null && typeof rpcResp.result === "object") {
    result = new ToolCallResult(rpcResp.result);
  } else {
    return (typeof rpcResp.result === "string" ? rpcResp.result : JSON.stringify(rpcResp.result)).trim();
  }
  if (result.isError && result.content.length > 0) {
    throw new Error(`mcp tool ${name}: ${result.content[0].text}`);
  }
  const textBlocks = [];
  for (const block of result.content) {
    if (block.type === "text" && block.text !== "") {
      textBlocks.push(block.text);
    }
  }
  return textBlocks.join("\n");
};

// Tool：Go 的 Tool，JSON 字段名是 Go 的 json tag。
class Tool {
  constructor(init = {}) {
    this.name = init.name ?? "";
    this.description = init.description ?? "";
    this.inputSchema = init.inputSchema;
    this.outputSchema = init.outputSchema;
    this.annotations = init.annotations;
  }
}

// ListTools returns the remote MCP tool catalog after initialize.
Client.prototype.ListTools = async function () {
  return this.ListToolsContext(null);
};

// ListToolsContext is ListTools with a caller-supplied deadline/cancellation.
Client.prototype.ListToolsContext = async function (ctx) {
  await this.ensureInit(ctx);
  this.nextID++;
  const id = this.nextID;
  const req = new RpcRequest({
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    params: {},
  });
  let resp;
  try {
    resp = await this.postJSON(ctx, req);
  } catch (err) {
    throw new Error(`mcp tools/list: ${err}`);
  }
  if (resp.status < 200 || resp.status >= 300) {
    const body = Buffer.from(await resp.arrayBuffer()).subarray(0, 8 * 1024);
    throw new Error(`gateway HTTP ${resp.status}: ${body.toString("utf8").trim()}`);
  }
  let raw;
  try {
    raw = await this.readResponse(resp);
  } catch (err) {
    throw new Error(`mcp tools/list: ${err}`);
  }
  let rpcResp;
  try {
    rpcResp = new RpcResponse(JSON.parse(raw.toString("utf8")));
  } catch (err) {
    throw new Error(`mcp decode tools/list: ${err} (body: ${raw.toString("utf8")})`);
  }
  if (rpcResp.error != null) {
    throw new Error(`mcp tools/list error [${rpcResp.error.code}]: ${rpcResp.error.message}`);
  }
  const result = rpcResp.result ?? {};
  const tools = (result.tools ?? []).map((tool) => new Tool(tool));
  return tools;
};

Client.prototype.ensureInit = async function (ctx) {
  if (ctx == null) {
    ctx = null;
  }
  if (ctx instanceof AbortSignal && ctx.aborted) {
    throw new Error("context canceled");
  }
  if (this.init) {
    return;
  }
  this.nextID++;
  const id = this.nextID;

  const req = new RpcRequest({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agentflow", version: "1.0.0" },
    },
  });
  let resp;
  try {
    resp = await this.postJSON(ctx, req);
  } catch (err) {
    if (ctx instanceof AbortSignal && ctx.aborted) {
      throw new Error("context canceled");
    }
    this.init = true;
    return;
  }
  let raw;
  try {
    raw = await this.readResponse(resp);
  } catch (err) {
    if (ctx instanceof AbortSignal && ctx.aborted) {
      throw new Error("context canceled");
    }
    this.init = true;
    return;
  }
  try {
    const rpcResp = new RpcResponse(JSON.parse(raw.toString("utf8")));
    if (rpcResp.error != null) {
      // Non-fatal: continue even if init fails.
    }
  } catch {
    // Non-fatal: continue even if init fails.
  }

  this.nextID++;
  const notifReq = new RpcRequest({ jsonrpc: "2.0", id: 0, method: "notifications/initialized" });
  try {
    await this.postJSON(ctx, notifReq);
  } catch {
    // Non-fatal: notification failure is ignored.
  }
  if (ctx instanceof AbortSignal && ctx.aborted) {
    throw new Error("context canceled");
  }
  this.init = true;
};

Client.prototype.readResponse = async function (resp) {
  const ct = resp.headers.get("Content-Type") ?? "";
  if (ct.includes("text/event-stream")) {
    return this.readSSE(resp);
  }
  return Buffer.from(await resp.arrayBuffer());
};

Client.prototype.readSSE = async function (resp) {
  const text = await resp.text();
  const dataLines = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed === "") {
      if (dataLines.length > 0) {
        const data = dataLines.join("\n");
        dataLines.length = 0;
        let rpcResp;
        try {
          rpcResp = new RpcResponse(JSON.parse(data));
        } catch {
          continue;
        }
        if (rpcResp.id > 0) {
          if (rpcResp.result !== undefined) {
            return Buffer.from(JSON.stringify(rpcResp), "utf8");
          }
          if (rpcResp.error != null) {
            return Buffer.from(JSON.stringify(rpcResp), "utf8");
          }
        }
      }
      continue;
    }
    if (trimmed.startsWith("data: ")) {
      dataLines.push(trimmed.slice("data: ".length));
    }
  }
  if (dataLines.length > 0) {
    return Buffer.from(dataLines.join("\n"), "utf8");
  }
  throw new Error("no data in SSE stream");
};

function cloneHeaders(input) {
  if (input == null) {
    return null;
  }
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = v;
  }
  return out;
}

module.exports = { Client, New, Tool };
