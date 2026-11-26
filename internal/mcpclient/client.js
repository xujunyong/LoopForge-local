/**
 * 对应 Go 文件：internal/mcpclient/client.go
 * 作用：提供最小化的 Streamable HTTP MCP 客户端，用于向 MCP 网关发送 JSON-RPC 2.0
 *       初始化握手、工具列表查询（tools/list）与工具调用（tools/call）请求，并解析普通 JSON 或 SSE 响应。
 * 职责边界：仅负责单客户端的 HTTP/SSE 通信、初始化状态维护与 JSON-RPC 编解码，
 *           不负责上游 MCP 服务发现、凭据管理或工具结果缓存。
 * 语法差异说明：
 * - Go 的 sync.Mutex 在单线程 JS 中省略；
 * - Go 的 context.Context 译为可空的 AbortSignal，并与客户端超时通过 AbortSignal.any 合并生效；
 * - Go 的 time.Duration 统一译为毫秒数；
 * - Go 的 (值, error) 译为成功返回值、失败 throw Error；
 * - 内部 JSON-RPC 线协议结构体（rpcRequest、rpcResponse、rpcError、toolCallResult）直接使用 JSON 字段名，
 *   以便与 JSON.stringify / JSON.parse 保持 1:1 对应；导出类型 Tool 保留 Go 导出字段大小写，同时兼容从 JSON 线格式初始化。
 */

"use strict";

/**
 * 最小化的 Streamable HTTP MCP 客户端，负责向 MCP 网关发送 JSON-RPC 2.0 请求并解析响应。
 */
class Client {
  /**
   * 构造 MCP 客户端实例，未提供字段按 Go 结构体零值初始化。
   * 使用场景：通常由 New 工厂函数构造，也可按零值直接实例化。
   *
   * @param {Partial<Client>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.url = init.url ?? "";
    this.hdrs = init.hdrs !== undefined ? init.hdrs : {};
    this.http = init.http ?? null;
    this.nextID = init.nextID ?? 0;
    this.init = init.init ?? false;
  }
}

/**
 * 创建一个指向指定 MCP 网关地址的新客户端，默认 HTTP 超时为 60 秒。
 * 使用场景：调用远程 MCP 服务的 tools/list 或 tools/call 之前构造客户端。
 *
 * @param {string} url - MCP 网关基础 URL（末尾多余的 "/" 会被去除）。
 * @param {Record<string, string> | null} [headers] - 每次请求附带的 HTTP 请求头映射（可为 null）。
 * @returns {Client} 新创建的 Client 实例。
 */
function New(url, headers) {
  return new Client({
    url: (url ?? "").replace(/\/+$/, ""),
    hdrs: headers !== undefined ? headers : null,
    http: { Timeout: 60 * 1000 },
  });
}

/**
 * 在运行时替换客户端的 HTTP 请求头映射（例如更新鉴权令牌）。
 * 使用场景：复用现有客户端但需要刷新鉴权头或自定义请求头时调用。
 *
 * @param {Record<string, string> | null} headers - 新的 HTTP 请求头映射。
 * @returns {void} 无返回值。
 */
Client.prototype.SetHeaders = function (headers) {
  this.hdrs = headers;
};

/**
 * 按不区分大小写的键名读取单个请求头的值；若客户端为空或未命中则返回空字符串。
 * 使用场景：检查客户端当前是否已配置特定请求头（如 Authorization）时调用。
 *
 * @param {string} key - 要查询的 HTTP 请求头名称（不区分大小写）。
 * @returns {string} 匹配到的请求头值；未命中或客户端为空时返回 ""。
 */
Client.prototype.Header = function (key) {
  if (this == null || this.hdrs == null) {
    return "";
  }
  const target = key.toLowerCase();
  for (const [k, v] of Object.entries(this.hdrs)) {
    if (k.toLowerCase() === target) {
      return v;
    }
  }
  return "";
};

/**
 * 克隆当前客户端，复制相同的网关 URL 与请求头并应用可选超时，不修改原客户端。
 * 使用场景：需要针对单次调用调整超时时间且避免影响共享客户端时调用。
 *
 * @param {number} timeout - 新客户端的 HTTP 超时时长（毫秒）；小于等于 0 时保留默认 60 秒。
 * @returns {Client | null} 新的 Client 副本；若当前接收者为空则返回 null。
 */
Client.prototype.Clone = function (timeout) {
  if (this == null) {
    return null;
  }
  return New(this.url, cloneHeaders(this.hdrs)).WithTimeout(timeout);
};

/**
 * 设置当前客户端的 HTTP 请求超时时长并返回自身，便于链式调用。
 * 使用场景：构造客户端后立即指定超时时间（如 New(...).WithTimeout(20000)）。
 *
 * @param {number} timeout - 超时时长（毫秒）；仅当大于 0 时生效。
 * @returns {Client} 当前 Client 实例本身。
 */
Client.prototype.WithTimeout = function (timeout) {
  if (this != null && timeout > 0) {
    this.http.Timeout = timeout;
  }
  return this;
};

/**
 * JSON-RPC 2.0 请求消息体（对应 Go 未导出结构体 rpcRequest）。
 */
class rpcRequest {
  /**
   * 构造 JSON-RPC 请求对象。
   * 使用场景：发送 initialize、notifications/initialized、tools/list、tools/call 请求前构造请求体。
   *
   * @param {Partial<rpcRequest>} [init={}] - 初始化字段对象（jsonrpc、id、method、params）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.jsonrpc = init.jsonrpc ?? "";
    this.id = init.id ?? 0;
    this.method = init.method ?? "";
    this.params = init.params;
  }
}

/**
 * JSON-RPC 2.0 响应消息体（对应 Go 未导出结构体 rpcResponse）。
 */
class rpcResponse {
  /**
   * 构造 JSON-RPC 响应对象。
   * 使用场景：反序列化 MCP 网关返回的普通 JSON 或 SSE 事件数据时使用。
   *
   * @param {Partial<rpcResponse>} [init={}] - 初始化字段对象（jsonrpc、id、result、error）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.jsonrpc = init.jsonrpc ?? "";
    this.id = init.id ?? 0;
    this.result = init.result;
    this.error = init.error != null ? new rpcError(init.error) : null;
  }
}

/**
 * JSON-RPC 2.0 错误对象（对应 Go 未导出结构体 rpcError）。
 */
class rpcError {
  /**
   * 构造 JSON-RPC 错误对象。
   * 使用场景：解析 rpcResponse 中的 error 字段时使用。
   *
   * @param {Partial<rpcError>} [init={}] - 初始化字段对象（code、message）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.code = init.code ?? 0;
    this.message = init.message ?? "";
  }
}

/**
 * MCP tools/call 返回的结果载荷（对应 Go 未导出结构体 toolCallResult）。
 */
class toolCallResult {
  /**
   * 构造工具调用结果对象，将 content 块规范化为 { type, text } 数组。
   * 使用场景：解析 CallToolContext 返回的 JSON-RPC result 字段时使用。
   *
   * @param {Partial<toolCallResult>} [init={}] - 初始化字段对象（content、isError）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.content = (init.content ?? []).map((block) => ({
      type: block?.type ?? "",
      text: block?.text ?? "",
    }));
    this.isError = init.isError ?? false;
  }
}

/**
 * 使用默认上下文调用指定名称的 MCP 工具，并返回结果中的文本内容。
 * 使用场景：调用方无需自定义取消信号或截止时间时调用。
 *
 * @param {string} name - 要调用的 MCP 工具名称。
 * @param {Record<string, any>} args - 传递给工具的参数对象。
 * @returns {Promise<string>} 拼接后的工具返回文本内容；失败时抛出 Error。
 */
Client.prototype.CallTool = async function (name, args) {
  return this.CallToolContext(null, name, args);
};

/**
 * 使用调用方提供的取消信号调用指定名称的 MCP 工具，并返回结果中的所有文本块拼接结果。
 * 使用场景：需要支持超时或外部取消的远程 MCP 工具调用。
 *
 * @param {AbortSignal | null} ctx - 可选取消信号；为 null 时仅受客户端自身超时限制。
 * @param {string} name - 要调用的 MCP 工具名称。
 * @param {Record<string, any>} args - 传递给工具的参数对象。
 * @returns {Promise<string>} 工具返回的文本内容（多块以换行拼接，非标准结果对象时返回原始 JSON 文本）；失败时抛出 Error。
 */
Client.prototype.CallToolContext = async function (ctx, name, args) {
  try {
    await this.ensureInit(ctx);
  } catch (err) {
    throw new Error(`mcp init: ${err.message}`, { cause: err });
  }
  this.nextID++;
  const id = this.nextID;

  const req = new rpcRequest({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
    },
  });

  const body = JSON.stringify(req);
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json, text/event-stream");
  if (this.hdrs != null) {
    for (const [k, v] of Object.entries(this.hdrs)) {
      headers.set(k, v);
    }
  }
  const timeoutMs = this.http != null ? this.http.Timeout : 0;
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const signal = ctx instanceof AbortSignal && timeoutSignal != null
    ? AbortSignal.any([ctx, timeoutSignal])
    : (ctx instanceof AbortSignal ? ctx : timeoutSignal ?? undefined);

  let resp;
  try {
    resp = await fetch(this.url, { method: "POST", headers, body, signal });
  } catch (err) {
    throw new Error(`mcp request ${name}: ${err.message}`, { cause: err });
  }
  if (resp.status < 200 || resp.status >= 300) {
    const errBody = Buffer.from(await resp.arrayBuffer()).subarray(0, 8 * 1024);
    throw new Error(`gateway HTTP ${resp.status}: ${errBody.toString("utf8").trim()}`);
  }

  let raw;
  try {
    raw = await this.readResponse(resp);
  } catch (err) {
    throw new Error(`mcp response ${name}: ${err.message}`, { cause: err });
  }

  // 检查网关直接返回的非 JSON-RPC 错误格式（包含字符串型 error 且不含 result 与 id）。
  let gatewayErr = null;
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.error === "string") {
      gatewayErr = parsed;
    }
  } catch {
    gatewayErr = null;
  }
  if (gatewayErr != null && gatewayErr.error !== "") {
    if (!("result" in gatewayErr) && !("id" in gatewayErr)) {
      throw new Error(`mcp gateway error: ${gatewayErr.error}`);
    }
  }

  let rpcResp;
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
      throw new Error("json: cannot unmarshal into rpcResponse");
    }
    if (parsed != null && parsed.error != null && (typeof parsed.error !== "object" || Array.isArray(parsed.error))) {
      throw new Error("json: cannot unmarshal rpcResponse.error");
    }
    rpcResp = new rpcResponse(parsed ?? {});
  } catch (err) {
    throw new Error(`mcp decode ${name}: ${err.message} (body: ${raw.toString("utf8")})`, { cause: err });
  }
  if (rpcResp.error != null) {
    throw new Error(`mcp tool ${name} error [${rpcResp.error.code}]: ${rpcResp.error.message}`);
  }

  let result;
  if (rpcResp.result === null) {
    result = new toolCallResult();
  } else if (
    rpcResp.result != null &&
    typeof rpcResp.result === "object" &&
    !Array.isArray(rpcResp.result) &&
    (rpcResp.result.content == null || Array.isArray(rpcResp.result.content)) &&
    (rpcResp.result.isError == null || typeof rpcResp.result.isError === "boolean")
  ) {
    result = new toolCallResult(rpcResp.result);
  } else {
    return rpcResp.result === undefined ? "" : JSON.stringify(rpcResp.result).trim();
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

/**
 * MCP 工具目录中的单个工具定义（对应 Go 导出结构体 Tool）。
 */
class Tool {
  /**
   * 构造工具定义对象，保留 Go 导出字段大小写并兼容从 JSON 线协议字段（小驼峰）初始化。
   * 使用场景：ListToolsContext 反序列化远程工具列表，或调用方手动构造工具元数据时使用。
   *
   * @param {Record<string, any>} [init={}] - 初始化字段对象（支持 Go 字段名或 JSON 字段名）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Name = init.Name ?? init.name ?? "";
    this.Description = init.Description ?? init.description ?? "";
    this.InputSchema = init.InputSchema ?? init.inputSchema ?? null;
    this.OutputSchema = init.OutputSchema ?? init.outputSchema ?? null;
    this.Annotations = init.Annotations ?? init.annotations ?? null;
  }
}

/**
 * 在完成初始化握手后，获取远程 MCP 网关提供的全部工具目录。
 * 使用场景：调用方无需自定义取消信号时查询工具列表。
 *
 * @returns {Promise<Tool[]>} 远程工具定义列表；失败时抛出 Error。
 */
Client.prototype.ListTools = async function () {
  return this.ListToolsContext(null);
};

/**
 * 使用调用方提供的取消信号获取远程 MCP 工具目录。
 * 使用场景：网关发现上游工具能力且需要支持超时或取消控制时调用。
 *
 * @param {AbortSignal | null} ctx - 可选取消信号；为 null 时仅受客户端自身超时限制。
 * @returns {Promise<Tool[]>} 远程工具定义列表；失败时抛出 Error。
 */
Client.prototype.ListToolsContext = async function (ctx) {
  try {
    await this.ensureInit(ctx);
  } catch (err) {
    throw new Error(`mcp init: ${err.message}`, { cause: err });
  }
  this.nextID++;
  const id = this.nextID;
  const req = new rpcRequest({
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    params: {},
  });
  const body = JSON.stringify(req);
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json, text/event-stream");
  if (this.hdrs != null) {
    for (const [k, v] of Object.entries(this.hdrs)) {
      headers.set(k, v);
    }
  }
  const timeoutMs = this.http != null ? this.http.Timeout : 0;
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const signal = ctx instanceof AbortSignal && timeoutSignal != null
    ? AbortSignal.any([ctx, timeoutSignal])
    : (ctx instanceof AbortSignal ? ctx : timeoutSignal ?? undefined);

  let resp;
  try {
    resp = await fetch(this.url, { method: "POST", headers, body, signal });
  } catch (err) {
    throw new Error(`mcp tools/list: ${err.message}`, { cause: err });
  }
  if (resp.status < 200 || resp.status >= 300) {
    const errBody = Buffer.from(await resp.arrayBuffer()).subarray(0, 8 * 1024);
    throw new Error(`gateway HTTP ${resp.status}: ${errBody.toString("utf8").trim()}`);
  }
  let raw;
  try {
    raw = await this.readResponse(resp);
  } catch (err) {
    throw new Error(`mcp tools/list: ${err.message}`, { cause: err });
  }
  let rpcResp;
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
      throw new Error("json: cannot unmarshal into rpcResponse");
    }
    if (parsed != null && parsed.error != null && (typeof parsed.error !== "object" || Array.isArray(parsed.error))) {
      throw new Error("json: cannot unmarshal rpcResponse.error");
    }
    rpcResp = new rpcResponse(parsed ?? {});
  } catch (err) {
    throw new Error(`mcp decode tools/list: ${err.message} (body: ${raw.toString("utf8")})`, { cause: err });
  }
  if (rpcResp.error != null) {
    throw new Error(`mcp tools/list error [${rpcResp.error.code}]: ${rpcResp.error.message}`);
  }
  if (
    rpcResp.result === undefined ||
    (rpcResp.result !== null && (typeof rpcResp.result !== "object" || Array.isArray(rpcResp.result))) ||
    (rpcResp.result != null && rpcResp.result.tools != null && !Array.isArray(rpcResp.result.tools))
  ) {
    throw new Error("mcp tools/list result: invalid tools/list result");
  }
  const rawTools = rpcResp.result != null ? rpcResp.result.tools : null;
  if (rawTools == null) {
    return [];
  }
  return rawTools.map((tool) => new Tool(tool ?? {}));
};

/**
 * 确保客户端已完成一次 MCP initialize 握手与 notifications/initialized 通知。
 * 使用场景：CallToolContext 与 ListToolsContext 发送业务请求前内部调用；非取消类握手失败视为非致命错误。
 *
 * @param {AbortSignal | null} ctx - 可选取消信号；若已取消则立即抛出错误。
 * @returns {Promise<void>} 握手完成或跳过时正常返回；上下文取消时抛出 Error。
 */
Client.prototype.ensureInit = async function (ctx) {
  if (ctx instanceof AbortSignal && ctx.aborted) {
    throw ctx.reason instanceof Error ? ctx.reason : new Error("context canceled");
  }
  if (this.init) {
    return;
  }
  this.nextID++;
  const id = this.nextID;

  const req = new rpcRequest({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "agentflow",
        version: "1.0.0",
      },
    },
  });
  const body = JSON.stringify(req);
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json, text/event-stream");
  if (this.hdrs != null) {
    for (const [k, v] of Object.entries(this.hdrs)) {
      headers.set(k, v);
    }
  }
  const timeoutMs = this.http != null ? this.http.Timeout : 0;
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const signal = ctx instanceof AbortSignal && timeoutSignal != null
    ? AbortSignal.any([ctx, timeoutSignal])
    : (ctx instanceof AbortSignal ? ctx : timeoutSignal ?? undefined);

  let resp;
  try {
    resp = await fetch(this.url, { method: "POST", headers, body, signal });
  } catch {
    if (ctx instanceof AbortSignal && ctx.aborted) {
      throw ctx.reason instanceof Error ? ctx.reason : new Error("context canceled");
    }
    this.init = true;
    return;
  }
  let raw;
  try {
    raw = await this.readResponse(resp);
  } catch {
    if (ctx instanceof AbortSignal && ctx.aborted) {
      throw ctx.reason instanceof Error ? ctx.reason : new Error("context canceled");
    }
    this.init = true;
    return;
  }
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rpcResp = new rpcResponse(parsed);
      if (rpcResp.error != null) {
        // 非致命错误：即使 initialize 返回业务错误也继续后续调用。
      }
    }
  } catch {
    // 非致命错误：忽略 initialize 响应解析失败。
  }

  this.nextID++;
  const notifReq = new rpcRequest({
    jsonrpc: "2.0",
    id: 0,
    method: "notifications/initialized",
  });
  const notifBody = JSON.stringify(notifReq);
  const notifHeaders = new Headers();
  notifHeaders.set("Content-Type", "application/json");
  notifHeaders.set("Accept", "application/json, text/event-stream");
  if (this.hdrs != null) {
    for (const [k, v] of Object.entries(this.hdrs)) {
      notifHeaders.set(k, v);
    }
  }
  const notifTimeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const notifSignal = ctx instanceof AbortSignal && notifTimeoutSignal != null
    ? AbortSignal.any([ctx, notifTimeoutSignal])
    : (ctx instanceof AbortSignal ? ctx : notifTimeoutSignal ?? undefined);
  try {
    const notifResp = await fetch(this.url, {
      method: "POST",
      headers: notifHeaders,
      body: notifBody,
      signal: notifSignal,
    });
    if (notifResp.body != null && typeof notifResp.body.cancel === "function") {
      await notifResp.body.cancel();
    }
  } catch {
    // 非致命错误：通知请求失败不中断初始化。
  }
  if (ctx instanceof AbortSignal && ctx.aborted) {
    throw ctx.reason instanceof Error ? ctx.reason : new Error("context canceled");
  }
  this.init = true;
};

/**
 * 根据响应头 Content-Type 自动按 SSE 流或普通响应体读取原始字节。
 * 使用场景：CallToolContext、ListToolsContext 与 ensureInit 收到 HTTP 响应后内部调用。
 *
 * @param {Response} resp - fetch 返回的 HTTP 响应对象。
 * @returns {Promise<Buffer>} 原始响应字节（JSON 载荷）；读取失败时抛出 Error。
 */
Client.prototype.readResponse = async function (resp) {
  const ct = resp.headers.get("Content-Type") ?? "";
  if (ct.includes("text/event-stream")) {
    return this.readSSE(resp);
  }
  return Buffer.from(await resp.arrayBuffer());
};

/**
 * 逐行解析 SSE（text/event-stream）响应体，提取首个携带有效 id 且包含 result 或 error 的 JSON-RPC 响应。
 * 使用场景：readResponse 识别到响应类型为 text/event-stream 时内部调用。
 *
 * @param {Response} resp - 内容类型为 text/event-stream 的 HTTP 响应对象。
 * @returns {Promise<Buffer>} 解析出的 JSON-RPC 响应字节或末尾剩余 data 块；无数据时抛出 Error。
 */
Client.prototype.readSSE = async function (resp) {
  const text = await resp.text();
  const dataLines = [];
  // 按 Go bufio.Scanner 逐行语义拆分，末尾单个换行不生成多余空行。
  const lines = text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n"));
  for (const line of lines) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed === "") {
      if (dataLines.length > 0) {
        const data = dataLines.join("\n");
        dataLines.length = 0;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
          continue;
        }
        if (parsed.error != null && (typeof parsed.error !== "object" || Array.isArray(parsed.error))) {
          continue;
        }
        const rpcResp = new rpcResponse(parsed);
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

/**
 * 浅拷贝 HTTP 请求头映射，避免克隆后的客户端与原客户端共享同一对象引用。
 * 使用场景：Client.prototype.Clone 复制请求头时内部调用。
 *
 * @param {Record<string, string> | null} input - 原始请求头映射（可为 null）。
 * @returns {Record<string, string> | null} 新的请求头浅拷贝对象；输入为空时返回 null。
 */
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
