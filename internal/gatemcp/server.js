/**
 * 对应 Go 文件：internal/gatemcp/server.go
 * 作用：提供基于 stdin/stdout 的轻量级 JSON-RPC 2.0 MCP 服务，向执行节点暴露
 *       submit_gate_result 工具以接收一次终态关卡裁决并原子独占写入结果文件。
 * 职责边界：仅负责协议报文读取、参数 schema 校验与结果文件独占落盘，
 *           不负责工作流节点调度、状态流转或后续审批处理。
 * 语法差异说明：
 * - Go 的 bufio.Scanner 逐行读取译为 Node.js readline 异步迭代器（for await），因此 Run 为 async 函数；
 * - Go 的 json.Encoder（SetEscapeHTML(false)）译为 JSON.stringify（JS 默认不转义 HTML 字符）加换行写出；
 * - Go 的 defer 文件关闭与失败清理译为 try / catch / finally；
 * - Go 的 (gateResult, string) 双返回值译为 [gateResult, string] 元组，普通错误路径使用 throw Error。
 */

"use strict";

const readline = require("node:readline"); // 对应 Go bufio.Scanner，按行读取 stdin
const fs = require("node:fs"); // 对应 Go os，独占创建并同步写入裁决结果文件
const path = require("node:path"); // 对应 Go path/filepath，解析结果文件父目录

/** 关卡 MCP 服务端协议实现版本号。 */
const Version = "1.0.0";

/**
 * JSON-RPC 2.0 请求消息体（对应 Go 未导出结构体 request）。
 */
class request {
  /**
   * 构造 JSON-RPC 请求对象，未提供字段按 Go 零值初始化（缺失的 id 记为 null 以与 Go json.RawMessage 一致）。
   * 使用场景：Run 逐行解析 stdin JSON 请求时使用。
   *
   * @param {Partial<request>} [init={}] - 初始化字段对象（jsonrpc、id、method、params）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.jsonrpc = init.jsonrpc ?? "";
    this.id = init.id !== undefined ? init.id : null;
    this.method = init.method ?? "";
    this.params = init.params;
  }
}

/**
 * 关卡裁决中的单条问题发现记录（对应 Go 未导出结构体 finding）。
 */
class finding {
  /**
   * 构造单条发现记录，未提供字段按 Go 结构体零值初始化。
   * 使用场景：decodeResult 组装 gateResult.findings 列表元素时使用。
   *
   * @param {Partial<finding>} [init={}] - 初始化字段对象（severity、title、evidence）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.severity = init.severity ?? "";
    this.title = init.title ?? "";
    this.evidence = init.evidence ?? "";
  }
}

/**
 * 关卡裁决结果结构体（对应 Go 未导出结构体 gateResult）。
 */
class gateResult {
  /**
   * 构造关卡裁决结果对象，未提供字段按 Go 结构体零值初始化。
   * 使用场景：decodeResult 校验并组装终态裁决数据时使用。
   *
   * @param {Partial<gateResult>} [init={}] - 初始化字段对象（decision、reason、actionRequired、summary、findings）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.decision = init.decision ?? "";
    this.reason = init.reason ?? "";
    this.actionRequired = init.actionRequired ?? "";
    this.summary = init.summary ?? "";
    this.findings = (init.findings ?? []).map((f) => new finding(f ?? {}));
  }
}

/** submit_gate_result 工具对外声明的 JSON Schema 参数约束。 */
const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "reason"],
  properties: {
    decision: { type: "string", enum: ["pass", "rework", "fail", "human"] },
    reason: { type: "string", minLength: 1, maxLength: 4000 },
    actionRequired: { type: "string", maxLength: 4000 },
    summary: { type: "string", maxLength: 4000 },
    findings: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          severity: { type: "string", maxLength: 64 },
          title: { type: "string", minLength: 1, maxLength: 500 },
          evidence: { type: "string", maxLength: 4000 },
        },
      },
    },
  },
};

/**
 * 在给定的输入流与输出流上运行小型 JSON-RPC MCP 服务，直到输入流结束。
 * 使用场景：作为关卡 MCP 子进程入口运行，接收 Agent 提交的唯一一次关卡裁决并写入 resultPath。
 *
 * @param {import("node:stream").Readable} stdin - JSON-RPC 请求输入流（按行分隔）。
 * @param {import("node:stream").Writable} stdout - JSON-RPC 响应输出流（按行写出）。
 * @param {string} resultPath - 裁决结果落盘目标路径（不可为空）。
 * @returns {Promise<void>} 输入流读取完毕后正常返回；缺少路径或读写发生异常时抛出 Error。
 */
async function Run(stdin, stdout, resultPath) {
  resultPath = (resultPath ?? "").trim();
  if (resultPath === "") {
    throw new Error("AGENTFLOW_GATE_RESULT_PATH is required");
  }
  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    let req;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
        throw new Error("json: cannot unmarshal into request");
      }
      if (parsed != null) {
        if (parsed.jsonrpc != null && typeof parsed.jsonrpc !== "string") {
          throw new Error("json: cannot unmarshal request.jsonrpc");
        }
        if (parsed.method != null && typeof parsed.method !== "string") {
          throw new Error("json: cannot unmarshal request.method");
        }
      }
      req = new request(parsed ?? {});
    } catch (err) {
      writeResponse(stdout, null, null, err.message);
      continue;
    }
    if (req.method.startsWith("notifications/")) {
      continue;
    }
    handleRequest(stdout, req, resultPath);
  }
}

/**
 * 按 JSON-RPC method 分发单条 MCP 请求，并将结果或错误写回 stdout。
 * 使用场景：Run 成功解析单行请求且非通知消息后内部调用。
 *
 * @param {import("node:stream").Writable} stdout - JSON-RPC 响应输出流。
 * @param {request} req - 已解析的 JSON-RPC 请求对象。
 * @param {string} resultPath - 裁决结果落盘目标路径。
 * @returns {void} 无返回值；写出失败时抛出 Error。
 */
function handleRequest(stdout, req, resultPath) {
  switch (req.method) {
    case "initialize": {
      let protocolVersion = "";
      if (
        req.params != null &&
        typeof req.params === "object" &&
        !Array.isArray(req.params) &&
        typeof req.params.protocolVersion === "string"
      ) {
        protocolVersion = req.params.protocolVersion;
      }
      if (protocolVersion === "") {
        protocolVersion = "2025-06-18";
      }
      writeResponse(stdout, req.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agentflow-gate", version: Version },
        instructions: "Call submit_gate_result exactly once to finish this node.",
      }, "");
      return;
    }
    case "ping":
      writeResponse(stdout, req.id, {}, "");
      return;
    case "tools/list":
      writeResponse(stdout, req.id, {
        tools: [{
          name: "submit_gate_result",
          description: "Submit exactly one terminal node decision. reason explains why. human also requires actionRequired to state exactly what a person must confirm.",
          inputSchema,
        }],
      }, "");
      return;
    case "tools/call": {
      if (
        req.params === undefined ||
        (req.params !== null && (typeof req.params !== "object" || Array.isArray(req.params))) ||
        (req.params != null && req.params.name != null && typeof req.params.name !== "string")
      ) {
        writeResponse(stdout, req.id, null, "invalid tool parameters");
        return;
      }
      const params = req.params ?? {};
      if (params.name !== "submit_gate_result") {
        writeResponse(stdout, req.id, null, "unknown tool");
        return;
      }
      const [result, problem] = decodeResult(params.arguments);
      if (problem !== "") {
        writeResponse(stdout, req.id, null, problem);
        return;
      }
      try {
        writeResultExclusive(resultPath, result);
      } catch (err) {
        if (err.code === "EEXIST") {
          writeResponse(stdout, req.id, null, "gate result already submitted");
        } else {
          writeResponse(stdout, req.id, null, err.message);
        }
        return;
      }
      writeResponse(stdout, req.id, {
        content: [{ type: "text", text: "Gate result submitted. Stop now; this node has reached its terminal decision." }],
        isError: false,
      }, "");
      return;
    }
    default:
      writeResponse(stdout, req.id, null, "method not found");
  }
}

/**
 * 校验并反序列化 submit_gate_result 工具的入参，检查字段白名单、类型、枚举值与长度限制。
 * 使用场景：handleRequest 处理 tools/call（submit_gate_result）时内部调用。
 *
 * @param {any} raw - JSON-RPC params.arguments 原始值。
 * @returns {[gateResult, string]} 元组 [裁决结果对象, 校验错误描述]；校验通过时第二个元素为空字符串 ""。
 */
function decodeResult(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return [new gateResult(), "arguments must be an object"];
  }
  const fields = raw;
  const allowed = { decision: true, reason: true, actionRequired: true, summary: true, findings: true };
  const unknown = [];
  for (const key of Object.keys(fields)) {
    if (!allowed[key]) {
      unknown.push(key);
    }
  }
  if (unknown.length > 0) {
    unknown.sort();
    return [new gateResult(), "unknown fields: " + unknown.join(", ")];
  }
  if ("findings" in fields) {
    const rawFindings = fields.findings;
    if (rawFindings === null || !Array.isArray(rawFindings)) {
      return [new gateResult(), "findings must be an array with at most 50 items"];
    }
    for (const item of rawFindings) {
      if (item !== null && (typeof item !== "object" || Array.isArray(item))) {
        return [new gateResult(), "findings must be an array with at most 50 items"];
      }
    }
    const allowedFinding = { severity: true, title: true, evidence: true };
    for (const item of rawFindings) {
      if (item == null) {
        continue;
      }
      for (const key of Object.keys(item)) {
        if (!allowedFinding[key]) {
          return [new gateResult(), "finding contains unknown fields"];
        }
      }
    }
  }
  // 严格校验各字段类型，与 Go json.Unmarshal(raw, &result) 行为保持一致。
  if (
    (fields.decision != null && typeof fields.decision !== "string") ||
    (fields.reason != null && typeof fields.reason !== "string") ||
    (fields.actionRequired != null && typeof fields.actionRequired !== "string") ||
    (fields.summary != null && typeof fields.summary !== "string")
  ) {
    return [new gateResult(), "arguments must match the submit_gate_result schema"];
  }
  if (Array.isArray(fields.findings)) {
    for (const item of fields.findings) {
      if (item == null) {
        continue;
      }
      if (
        (item.severity != null && typeof item.severity !== "string") ||
        (item.title != null && typeof item.title !== "string") ||
        (item.evidence != null && typeof item.evidence !== "string")
      ) {
        return [new gateResult(), "arguments must match the submit_gate_result schema"];
      }
    }
  }
  const result = new gateResult(fields);
  if (result.findings == null) {
    result.findings = [];
  }
  switch (result.decision) {
    case "pass":
    case "rework":
    case "fail":
    case "human":
      break;
    default:
      return [new gateResult(), "decision must be pass, rework, fail, or human"];
  }
  result.reason = result.reason.trim();
  if (result.reason === "") {
    return [new gateResult(), "reason is required"];
  }
  if (result.reason.length > 4000) {
    return [new gateResult(), "reason is too long"];
  }
  result.actionRequired = result.actionRequired.trim();
  if (result.actionRequired.length > 4000) {
    return [new gateResult(), "actionRequired must be a string with at most 4000 characters"];
  }
  if (result.decision === "human" && result.actionRequired === "") {
    return [new gateResult(), "actionRequired is required when decision is human"];
  }
  result.summary = result.summary.trim();
  if (result.summary.length > 4000) {
    return [new gateResult(), "summary must be a string with at most 4000 characters"];
  }
  if (result.findings.length > 50) {
    return [new gateResult(), "findings must be an array with at most 50 items"];
  }
  for (let i = 0; i < result.findings.length; i++) {
    result.findings[i].title = result.findings[i].title.trim();
    if (result.findings[i].title === "") {
      return [new gateResult(), "each finding requires a title"];
    }
    if (result.findings[i].title.length > 500) {
      return [new gateResult(), "finding title is too long"];
    }
    if (result.findings[i].severity.length > 64) {
      return [new gateResult(), "finding severity is invalid"];
    }
    if (result.findings[i].evidence.length > 4000) {
      return [new gateResult(), "finding evidence is invalid"];
    }
  }
  return [result, ""];
}

/**
 * 以独占方式创建目标文件并将裁决结果编码为 JSON 落盘并刷盘；若中途失败则删除未完成文件。
 * 使用场景：handleRequest 校验通过后保存唯一一次关卡裁决，文件已存在时抛出 EEXIST 错误。
 *
 * @param {string} filePath - 目标结果文件路径（父目录不存在时自动以 0o700 创建）。
 * @param {gateResult} result - 已校验的关卡裁决结果对象。
 * @returns {void} 无返回值；目录创建、独占打开、写入或刷盘失败时抛出 Error。
 */
function writeResultExclusive(filePath, result) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(filePath, "wx", 0o600);
  // 按 Go finding 的 omitempty 标签，仅在非空时序列化 severity 与 evidence 字段。
  const payload = {
    decision: result.decision,
    reason: result.reason,
    actionRequired: result.actionRequired,
    summary: result.summary,
    findings: result.findings.map((f) => {
      const item = {};
      if (f.severity !== "") {
        item.severity = f.severity;
      }
      item.title = f.title;
      if (f.evidence !== "") {
        item.evidence = f.evidence;
      }
      return item;
    }),
  };
  let writeErr = null;
  let ok = false;
  try {
    fs.writeSync(fd, JSON.stringify(payload) + "\n", null, "utf8");
    fs.fsyncSync(fd);
    ok = true;
  } catch (err) {
    writeErr = err;
    throw err;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (closeErr) {
      if (writeErr == null) {
        throw closeErr;
      }
    }
    if (!ok) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // 清理未完成文件时忽略删除错误，与 Go defer 行为一致。
      }
    }
  }
}

/**
 * 将单条 JSON-RPC 2.0 成功或错误响应编码为单行 JSON 并写入 stdout。
 * 使用场景：Run 与 handleRequest 返回协议响应时内部调用。
 *
 * @param {import("node:stream").Writable} stdout - JSON-RPC 响应输出流。
 * @param {any} id - 对应请求的 JSON-RPC id（无 id 时输出 null）。
 * @param {any} result - 成功时的 result 载荷（仅在 problem 为空时写入）。
 * @param {string} problem - 错误消息；非空时以错误码 -32602 写入 error 字段。
 * @returns {void} 无返回值。
 */
function writeResponse(stdout, id, result, problem) {
  const response = { jsonrpc: "2.0", id: id !== undefined ? id : null };
  if (problem !== "") {
    response.error = { code: -32602, message: problem };
  } else {
    response.result = result;
  }
  stdout.write(JSON.stringify(response) + "\n");
}

module.exports = { Version, Run };
