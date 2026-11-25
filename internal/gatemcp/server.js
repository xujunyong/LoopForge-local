// server.js —— 对应 Go 文件：internal/gatemcp/server.go
// 作用：stdin/stdout 上的小型 JSON-RPC MCP 服务，收一次关卡裁决并落盘。
// Go 的 bufio.Scanner 译为 readline 逐行读；json.Encoder（SetEscapeHTML(false)）
// 译为 JSON.stringify（JS 默认不转义 HTML）；Go 的阻塞调用译为 async。

"use strict";

const readline = require("node:readline"); // Go bufio.Scanner：按行读 stdin
const fs = require("node:fs"); // Go os：写裁决文件
const path = require("node:path"); // Go path/filepath

const Version = "1.0.0";

// request：Go 的 request，JSON 字段名是 Go 的 json tag。
class Request {
  constructor(init = {}) {
    this.jsonrpc = init.jsonrpc ?? "";
    this.id = init.id;
    this.method = init.method ?? "";
    this.params = init.params;
  }
}

// finding：Go 的 finding。
class Finding {
  constructor(init = {}) {
    this.severity = init.severity ?? "";
    this.title = init.title ?? "";
    this.evidence = init.evidence ?? "";
  }
}

// gateResult：Go 的 gateResult。
class GateResult {
  constructor(init = {}) {
    this.decision = init.decision ?? "";
    this.reason = init.reason ?? "";
    this.actionRequired = init.actionRequired ?? "";
    this.summary = init.summary ?? "";
    this.findings = (init.findings ?? []).map((f) => new Finding(f));
  }
}

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
      type: "array", maxItems: 50,
      items: {
        type: "object", additionalProperties: false, required: ["title"],
        properties: {
          severity: { type: "string", maxLength: 64 },
          title: { type: "string", minLength: 1, maxLength: 500 },
          evidence: { type: "string", maxLength: 4000 },
        },
      },
    },
  },
};

// writeJSON：Go 的 json.Encoder.Encode，一行 JSON 写到 stdout。
function writeJSON(stdout, value) {
  stdout.write(JSON.stringify(value) + "\n");
}

// Run serves the small JSON-RPC MCP protocol over stdin/stdout.
async function Run(stdin, stdout, resultPath) {
  resultPath = resultPath.trim();
  if (resultPath === "") {
    throw new Error("AGENTFLOW_GATE_RESULT_PATH is required");
  }
  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    let req;
    try {
      req = new Request(JSON.parse(line));
    } catch (err) {
      writeResponse(stdout, null, null, err.message);
      continue;
    }
    if (req.method.startsWith("notifications/")) {
      continue;
    }
    await handleRequest(stdout, req, resultPath);
  }
}

async function handleRequest(stdout, req, resultPath) {
  switch (req.method) {
    case "initialize": {
      const params = req.params ?? {};
      let protocolVersion = params.protocolVersion ?? "";
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
      const params = req.params ?? {};
      if (typeof params !== "object" || params === null || Array.isArray(params)) {
        writeResponse(stdout, req.id, null, "invalid tool parameters");
        return;
      }
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

function decodeResult(raw) {
  let fields;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return [new GateResult(), "arguments must be an object"];
  }
  fields = raw;
  const allowed = { decision: true, reason: true, actionRequired: true, summary: true, findings: true };
  const unknown = [];
  for (const key of Object.keys(fields)) {
    if (!allowed[key]) {
      unknown.push(key);
    }
  }
  if (unknown.length > 0) {
    unknown.sort();
    return [new GateResult(), "unknown fields: " + unknown.join(", ")];
  }
  if (fields.findings !== undefined) {
    const rawFindings = fields.findings;
    if (rawFindings === null || !Array.isArray(rawFindings) || rawFindings.length > 50) {
      return [new GateResult(), "findings must be an array with at most 50 items"];
    }
    const allowedFinding = { severity: true, title: true, evidence: true };
    for (const item of rawFindings) {
      if (item == null || typeof item !== "object" || Array.isArray(item)) {
        return [new GateResult(), "finding contains unknown fields"];
      }
      for (const key of Object.keys(item)) {
        if (!allowedFinding[key]) {
          return [new GateResult(), "finding contains unknown fields"];
        }
      }
    }
  }
  const result = new GateResult(fields);
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
      return [new GateResult(), "decision must be pass, rework, fail, or human"];
  }
  result.reason = result.reason.trim();
  if (result.reason === "") {
    return [new GateResult(), "reason is required"];
  }
  if (result.reason.length > 4000) {
    return [new GateResult(), "reason is too long"];
  }
  result.actionRequired = result.actionRequired.trim();
  if (result.actionRequired.length > 4000) {
    return [new GateResult(), "actionRequired must be a string with at most 4000 characters"];
  }
  if (result.decision === "human" && result.actionRequired === "") {
    return [new GateResult(), "actionRequired is required when decision is human"];
  }
  result.summary = result.summary.trim();
  if (result.summary.length > 4000) {
    return [new GateResult(), "summary must be a string with at most 4000 characters"];
  }
  if (result.findings.length > 50) {
    return [new GateResult(), "findings must be an array with at most 50 items"];
  }
  for (const finding of result.findings) {
    finding.title = finding.title.trim();
    if (finding.title === "") {
      return [new GateResult(), "each finding requires a title"];
    }
    if (finding.title.length > 500) {
      return [new GateResult(), "finding title is too long"];
    }
    if (finding.severity.length > 64) {
      return [new GateResult(), "finding severity is invalid"];
    }
    if (finding.evidence.length > 4000) {
      return [new GateResult(), "finding evidence is invalid"];
    }
  }
  return [result, ""];
}

function writeResultExclusive(filePath, result) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(filePath, "wx", 0o600);
  } catch (err) {
    throw err;
  }
  let ok = false;
  try {
    fs.writeSync(fd, JSON.stringify(result) + "\n", null, "utf8");
    fs.fsyncSync(fd);
    ok = true;
  } finally {
    fs.closeSync(fd);
    if (!ok) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Go 的 defer 里同样忽略删除失败。
      }
    }
  }
}

function writeResponse(stdout, id, result, problem) {
  const response = { jsonrpc: "2.0", id };
  if (problem !== "") {
    response.error = { code: -32602, message: problem };
  } else {
    response.result = result;
  }
  writeJSON(stdout, response);
}

module.exports = { Version, Run };
