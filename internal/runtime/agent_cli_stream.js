// agent_cli_stream.js —— 对应 Go 文件：internal/runtime/agent_cli_stream.go
// 作用：把各 Agent CLI 的原生 headless 输出翻译为 Claude 风格 stream-json 行。

"use strict";

const { AgentCLIOpenCode, AgentCLICursor, AgentCLIAntigravity, AgentCLIKimi, AgentCLIPi, AgentCLIDeepSeek, AgentCLIZCode } = require("./agent_cli.js"); // 对应 Go 同包常量，agent_cli.js 已翻译
const { stringValue, sliceValue, int64Value } = require("./protocol.js"); // 对应 Go 同包函数，protocol.js 待翻译
const { zcodeStream } = require("./agent_cli_zcode.js"); // 对应 Go 同包类型，agent_cli_zcode.js 待翻译

// ClaudeStream：SOP 协议适配器与 AI 对话解析的 Claude 风格 stream-json 行。
class ClaudeStream {
  constructor() {
    this.SessionID = "";
    // LastText：最新的已完成助手文本；CLI 未报告时即本轮答案。
    this.LastText = "";
    this.block = "";
    this.started = null;
    this.usage = null;
    this.done = false;
  }

  line(v) {
    if (this.SessionID !== "") {
      v["session_id"] = this.SessionID;
    }
    return JSON.stringify(v);
  }

  // Init：宣告会话；model 可为空。
  Init(sessionID, model) {
    sessionID = sessionID.trim();
    if (sessionID !== "") {
      this.SessionID = sessionID;
    }
    const event = { type: "system", subtype: "init" };
    if (model !== "") {
      event["model"] = model;
    }
    return [this.line(event)];
  }

  // Delta：把文本流式写入内容块 key（kind 为 "text" 或 "thinking"），先打开块。
  Delta(key, kind, text) {
    if (text === "") {
      return [];
    }
    let out = [];
    if (this.block !== key) {
      out = [...this.CloseBlock(), this.line({ type: "stream_event", event: { type: "content_block_start", content_block: { type: kind } } })];
      this.block = key;
    }
    let delta = { type: "text_delta", text };
    if (kind === "thinking") {
      delta = { type: "thinking_delta", thinking: text };
    }
    return [...out, this.line({ type: "stream_event", event: { type: "content_block_delta", delta } })];
  }

  CloseBlock() {
    if (this.block === "") {
      return [];
    }
    this.block = "";
    return [this.line({ type: "stream_event", event: { type: "content_block_stop" } })];
  }

  assistant(block) {
    return [...this.CloseBlock(), this.line({ type: "assistant", message: { role: "assistant", content: [block] } })];
  }

  // Text：记录一段已完成的助手文本块。
  Text(text) {
    if (text.trim() === "") {
      return this.CloseBlock();
    }
    this.LastText = text;
    return this.assistant({ type: "text", text });
  }

  // Thinking：记录一段已完成的推理块。
  Thinking(text) {
    if (text.trim() === "") {
      return this.CloseBlock();
    }
    return this.assistant({ type: "thinking", thinking: text });
  }

  // ToolUse：每个 id 只记录一次工具调用。
  ToolUse(id, name, input) {
    if (id === "" || name === "") {
      return [];
    }
    if (this.started === null) {
      this.started = {};
    }
    if (this.started[id]) {
      return [];
    }
    this.started[id] = true;
    if (input === null || input === undefined) {
      input = {};
    }
    return this.assistant({ type: "tool_use", id, name, input });
  }

  // ToolResult：记录一次已完成的工具调用。
  ToolResult(id, failed, content) {
    if (id === "") {
      return [];
    }
    return [...this.CloseBlock(), this.line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: failed, content }] } })];
  }

  // AddUsage：累加每步报告的 token 数。
  AddUsage(input, output, cacheRead, cacheWrite, reasoning) {
    if (this.usage === null) {
      this.usage = {};
    }
    // Go 读缺失的 map 键得零值。
    this.usage["input_tokens"] = (this.usage["input_tokens"] ?? 0) + input;
    this.usage["output_tokens"] = (this.usage["output_tokens"] ?? 0) + output;
    this.usage["cache_read_input_tokens"] = (this.usage["cache_read_input_tokens"] ?? 0) + cacheRead;
    this.usage["cache_creation_input_tokens"] = (this.usage["cache_creation_input_tokens"] ?? 0) + cacheWrite;
    this.usage["reasoning_tokens"] = (this.usage["reasoning_tokens"] ?? 0) + reasoning;
  }

  // SetUsage：用一轮总量替换累计用量。
  SetUsage(input, output, cacheRead, cacheWrite, reasoning) {
    this.usage = null;
    this.AddUsage(input, output, cacheRead, cacheWrite, reasoning);
  }

  // Result：只结束一轮；空文本回落到 LastText。
  Result(text, failed) {
    if (this.done) {
      return [];
    }
    this.done = true;
    if (text.trim() === "" && !failed) {
      text = this.LastText;
    }
    let subtype = "success";
    if (failed) {
      subtype = "error";
    }
    const event = { type: "result", subtype, is_error: failed, result: text };
    if (this.usage !== null) {
      event["usage"] = this.usage;
    }
    return [...this.CloseBlock(), this.line(event)];
  }

  // Finished：报告 Result 是否已发出。
  Finished() { return this.done; }
}

// NewAgentCLITranslator：返回把 Agent CLI 原生 headless 输出（每行一个 JSON 对象）翻译为 ClaudeStream 行的函数。
function NewAgentCLITranslator(kind) {
  let translate;
  switch (kind) {
    case AgentCLIOpenCode: {
      const inst = new openCodeStream();
      translate = inst.translate.bind(inst);
      break;
    }
    case AgentCLICursor: {
      const inst = new cursorStream();
      translate = inst.translate.bind(inst);
      break;
    }
    case AgentCLIAntigravity: {
      const inst = new antigravityStream();
      translate = inst.translate.bind(inst);
      break;
    }
    case AgentCLIKimi: {
      const inst = new kimiStream();
      translate = inst.translate.bind(inst);
      break;
    }
    case AgentCLIPi: {
      const inst = new piStream();
      translate = inst.translate.bind(inst);
      break;
    }
    case AgentCLIDeepSeek: {
      const inst = new dshStream();
      translate = inst.translate.bind(inst);
      break;
    }
    case AgentCLIZCode: {
      const inst = new zcodeStream();
      translate = inst.translate.bind(inst);
      break;
    }
    default:
      return null;
  }
  const stream = new ClaudeStream();
  return function (line) {
    line = line.trim();
    if (line === "" || line[0] !== "{") {
      return [];
    }
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      return [];
    }
    return translate(stream, raw);
  };
}

function jsonText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

// contentText：拼接 MCP / 对话内容值的文本部分。
function contentText(value) {
  if (typeof value === "string") {
    return value;
  }
  const parts = [];
  for (const item of sliceValue(value) ?? []) {
    const part = item ?? {};
    const text = stringValue(part["text"]);
    if (text !== "") {
      parts.push(text);
    }
  }
  if (parts.length === 0 && value !== null && value !== undefined) {
    return jsonText(value);
  }
  return parts.join("\n");
}

function errorText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["message", "error"]) {
      const text = errorText(value[key]);
      if (text !== "") {
        return text;
      }
    }
    const data = value["data"];
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      const text = errorText(data);
      if (text !== "") {
        return text;
      }
    }
    const name = stringValue(value["name"]);
    if (name !== "") {
      return name;
    }
  }
  return "";
}

// openCodeStream：`opencode run --format json` 报告已完成的部分。
class openCodeStream {
  constructor() {
    this.started = false;
    this.failure = "";
  }

  translate(s, raw) {
    let out = [];
    if (!this.started) {
      const session = stringValue(raw["sessionID"]);
      if (session !== "") {
        this.started = true;
        out = s.Init(session, "");
      }
    }
    const part = raw["part"] ?? {};
    switch (stringValue(raw["type"])) {
      case "reasoning":
        out = [...out, ...s.Thinking(stringValue(part["text"]))];
        break;
      case "text":
        out = [...out, ...s.Text(stringValue(part["text"]))];
        break;
      case "tool_use": {
        const state = part["state"] ?? {};
        const id = stringValue(part["callID"]);
        out = [...out, ...s.ToolUse(id, stringValue(part["tool"]), state["input"])];
        switch (stringValue(state["status"])) {
          case "completed":
            out = [...out, ...s.ToolResult(id, false, jsonText(state["output"]))];
            break;
          case "error":
            out = [...out, ...s.ToolResult(id, true, jsonText(state["error"]))];
            break;
        }
        break;
      }
      case "step_finish": {
        const tokens = part["tokens"] ?? {};
        const cache = tokens["cache"] ?? {};
        s.AddUsage(int64Value(tokens["input"]), int64Value(tokens["output"]), int64Value(cache["read"]), int64Value(cache["write"]), int64Value(tokens["reasoning"]));
        const reason = stringValue(part["reason"]);
        if (reason !== "tool-calls" && reason !== "") {
          out = [...out, ...s.Result("", this.failure !== "" && s.LastText === "")];
        }
        break;
      }
      case "error":
        this.failure = errorText(raw["error"]);
        if (this.failure === "") {
          this.failure = "OpenCode 运行失败";
        }
        out = [...out, ...s.Result(this.failure, true)];
        break;
    }
    return out;
  }
}

// cursorStream：`cursor-agent -p --output-format stream-json --stream-partial-output`。
class cursorStream {
  constructor() {
    this.segment = 0;
    this.partial = "";
    this.thinking = "";
    // hold：与已流式输出文本完全相同的带时间戳助手块，下一事件决定其归属。
    this.hold = "";
    this.held = false;
    this.routes = new cursorRouteFilter();
  }

  flushText(s) {
    const text = stripCursorAutoRoute(this.partial);
    this.resetPartial();
    return s.Text(text);
  }

  resetPartial() {
    this.partial = "";
    this.routes = new cursorRouteFilter();
    this.segment++;
  }

  // releaseHold：提交或丢弃 acceptPartial 保存的相同块；工具调用说明它是 CLI 重发的缓冲，故丢弃。
  releaseHold(discard) {
    if (!this.held) {
      return "";
    }
    const text = this.hold;
    this.hold = "";
    this.held = false;
    if (discard) {
      return "";
    }
    return this.appendPartial(text);
  }

  // acceptPartial：返回新可见的文本；与缓冲相同的块先暂存，下一事件再定。
  acceptPartial(text) {
    const accumulated = this.partial;
    if (accumulated !== "" && text === accumulated) {
      this.hold = text;
      this.held = true;
      return "";
    }
    return this.appendPartial(text);
  }

  appendPartial(text) {
    this.partial += text;
    return this.routes.feed(text);
  }

  flushThinking(s) {
    const text = this.thinking;
    this.thinking = "";
    if (text === "") {
      return [];
    }
    this.segment++;
    return s.Thinking(text);
  }

  translate(s, raw) {
    const kind = stringValue(raw["type"]);
    let prelude = [];
    const text = this.releaseHold(kind === "tool_call");
    if (text !== "") {
      prelude = s.Delta(`text#${this.segment}`, "text", text);
    }
    return [...prelude, ...this.translateEvent(s, raw)];
  }

  translateEvent(s, raw) {
    switch (stringValue(raw["type"])) {
      case "system":
        if (stringValue(raw["subtype"]) === "init") {
          return s.Init(stringValue(raw["session_id"]), stringValue(raw["model"]));
        }
        break;
      case "thinking":
        if (stringValue(raw["subtype"]) === "delta") {
          const text = stringValue(raw["text"]);
          this.thinking += text;
          return s.Delta(`thinking#${this.segment}`, "thinking", text);
        }
        return this.flushThinking(s);
      case "assistant": {
        const message = raw["message"] ?? {};
        const text = contentText(message["content"]);
        const out = this.flushThinking(s);
        if ("timestamp_ms" in raw) {
          const visible = this.acceptPartial(text);
          if (visible !== "") {
            return [...out, ...s.Delta(`text#${this.segment}`, "text", visible)];
          }
          return out;
        }
        this.resetPartial();
        return [...out, ...s.Text(stripCursorAutoRoute(text))];
      }
      case "tool_call": {
        let out = [...this.flushThinking(s), ...this.flushText(s)];
        const id = stringValue(raw["call_id"]);
        const [name, input, result] = cursorToolCall(raw);
        out = [...out, ...s.ToolUse(id, name, input)];
        if (stringValue(raw["subtype"]) === "completed") {
          const success = result["success"];
          const ok = "success" in result;
          let failure = result["error"];
          if (!ok && (failure === null || failure === undefined)) {
            failure = result["rejected"];
          }
          if (failure !== null && failure !== undefined) {
            out = [...out, ...s.ToolResult(id, true, jsonText(failure))];
          } else {
            const body = (success !== null && typeof success === "object" && !Array.isArray(success)) ? success : {};
            let content = body["content"];
            if (content === null || content === undefined) {
              content = success;
            }
            out = [...out, ...s.ToolResult(id, false, contentText(content))];
          }
        }
        return out;
      }
      case "result": {
        let out = [...this.flushThinking(s), ...this.flushText(s)];
        const usage = raw["usage"] ?? {};
        s.SetUsage(int64Value(usage["inputTokens"]), int64Value(usage["outputTokens"]), int64Value(usage["cacheReadTokens"]), int64Value(usage["cacheWriteTokens"]), 0);
        const failed = raw["is_error"] === true;
        let text = stripCursorAutoRoute(stringValue(raw["result"]));
        if (failed && text === "") {
          text = errorText(raw["error"]);
        }
        return [...out, ...s.Result(text, failed)];
      }
    }
    return [];
  }
}

function cursorToolCall(raw) {
  const call = raw["tool_call"] ?? {};
  for (const [key, value] of Object.entries(call)) {
    if (!key.endsWith("ToolCall")) {
      continue;
    }
    const body = value ?? {};
    const args = body["args"] ?? {};
    const result = body["result"] ?? {};
    switch (key) {
      case "mcpToolCall": {
        let server = stringValue(args["providerIdentifier"]);
        if (server === "") {
          server = stringValue(args["serverIdentifier"]);
        }
        return ["mcp__" + server + "__" + stringValue(args["toolName"]), args["args"], result];
      }
      case "shellToolCall":
        return ["Bash", { command: args["command"] }, result];
    }
    let name = key.slice(0, -"ToolCall".length);
    if (name !== "") {
      name = name[0].toUpperCase() + name.slice(1);
    }
    delete args["toolCallId"];
    return [name, args, result];
  }
  return ["", null, null];
}

const cursorAutoRoutePrefix = "Auto routed to ";

// 提示位于行尾：整行，或以 ">" 与正文粘连；模型是带版本号的几个 ASCII 词。
const cursorAutoRouteNoticeRe = /(?:^|[ \t]*>)[ \t]*Auto routed to ([A-Za-z][A-Za-z0-9.\-]*(?: [A-Za-z0-9][A-Za-z0-9.\-]*){0,4})[ \t]*$/d;
const cursorAutoRouteModelRe = /^[A-Za-z0-9.\- ]{0,64}$/;

// cursorAutoRouteNotice：返回行尾路由提示之前的文本。
function cursorAutoRouteNotice(line) {
  const m = cursorAutoRouteNoticeRe.exec(line);
  if (m === null) {
    return ["", false];
  }
  const model = line.slice(m.indices[1][0], m.indices[1][1]);
  if (!/[0123456789]/.test(model) || model.endsWith(".")) {
    return ["", false];
  }
  return [line.slice(0, m.indices[0][0]), true];
}

// cursorAutoRouteMayStart：报告 rest 是否仍可能长成一条提示。
function cursorAutoRouteMayStart(rest, afterMarker) {
  rest = rest.replace(/^[ \t]+/, "");
  if (rest.length <= cursorAutoRoutePrefix.length) {
    return cursorAutoRoutePrefix.startsWith(rest) && (afterMarker || rest !== "");
  }
  return rest.startsWith(cursorAutoRoutePrefix) && cursorAutoRouteModelRe.test(rest.slice(cursorAutoRoutePrefix.length));
}

// cursorRouteFilter：流式丢弃 Cursor Auto 的路由提示。
class cursorRouteFilter {
  constructor() {
    this.line = ""; // 未完成的行
    this.shown = 0; // 行中已输出的字节数
    this.open = false; // 行已在输出中开始
    this.any = false; // 输出至少有一行
    this.last = ""; // 上一条非空输出行（去空白）
    this.anchor = ""; // 最新提示之前的行
    this.pending = false; // 等待提示后的首条非空行
    this.blanks = []; // 等待期间暂存的空行
  }

  feed(text) {
    const parts = [];
    for (;;) {
      const i = text.indexOf("\n");
      if (i < 0) {
        break;
      }
      this.line += text.slice(0, i);
      text = text.slice(i + 1);
      this.endLine(parts);
    }
    this.line += text;
    const safe = this.safe();
    if (safe > this.shown) {
      this.startLine(parts);
      parts.push(this.line.slice(this.shown, safe));
      this.shown = safe;
      this.pending = false;
    }
    return parts.join("");
  }

  finish() {
    const parts = [];
    this.endLine(parts);
    return parts.join("");
  }

  // safe：未完成的行当前可展示多少。
  safe() {
    const line = this.line;
    if (this.pending && !this.open) {
      const trimmed = line.trim();
      if (trimmed === "" || (this.anchor !== "" && this.anchor.startsWith(trimmed))) {
        return 0;
      }
    }
    if (!this.open && cursorAutoRouteMayStart(line, false)) {
      return 0;
    }
    const limit = line.replace(/[ \t]+$/, "").length;
    for (let i = this.shown; i < limit; i++) {
      if (line[i] === ">" && cursorAutoRouteMayStart(line.slice(i + 1), true)) {
        return Math.min(limit, line.slice(0, i).replace(/[ \t]+$/, "").length);
      }
    }
    return limit;
  }

  startLine(parts) {
    if (this.open) {
      return;
    }
    for (const blank of this.blanks) {
      this.newline(parts);
      parts.push(blank);
    }
    this.blanks = [];
    this.newline(parts);
    this.open = true;
  }

  newline(parts) {
    if (this.any) {
      parts.push("\n");
    }
    this.any = true;
  }

  endLine(parts) {
    const line = this.line;
    try {
      const [before, ok] = cursorAutoRouteNotice(line);
      if (ok) {
        const trimmed = before.trim();
        if (trimmed !== "") {
          this.startLine(parts);
          parts.push(before.slice(this.shown));
          this.last = trimmed;
        }
        this.anchor = this.last;
        this.pending = true;
        this.blanks = [];
        return;
      }
      const trimmed = line.trim();
      if (this.pending && !this.open) {
        if (trimmed === "") {
          this.blanks.push(line);
          return;
        }
        this.pending = false;
        if (this.anchor !== "" && trimmed === this.anchor) {
          this.blanks = [];
          return;
        }
      }
      this.pending = false;
      this.startLine(parts);
      parts.push(line.slice(this.shown));
      if (trimmed !== "") {
        this.last = trimmed;
      }
    } finally {
      // Go 用 defer 在函数返回时复位。
      this.line = "";
      this.shown = 0;
      this.open = false;
    }
  }
}

// stripCursorAutoRoute：对已完成文本应用 cursorRouteFilter。
function stripCursorAutoRoute(text) {
  if (!text.includes(cursorAutoRoutePrefix)) {
    return text;
  }
  const f = new cursorRouteFilter();
  return f.feed(text) + f.finish();
}

// antigravityStream：`agy -p --output-format stream-json`。
class antigravityStream {
  constructor() {
    this.text = "";
    this.failure = "";
  }

  translate(s, raw) {
    switch (stringValue(raw["event"])) {
      case "init": {
        const init = raw["init"] ?? {};
        return s.Init(stringValue(raw["conversation_id"]), stringValue(init["model"]));
      }
      case "step_update": {
        const step = raw["step_update"] ?? {};
        return this.translateStep(s, step);
      }
      case "result": {
        const result = raw["result"] ?? {};
        const failed = stringValue(result["status"]) !== "SUCCESS";
        let text = stringValue(result["response"]);
        if (failed) {
          text = errorText(result["error"]);
          if (text === "") {
            text = this.failure;
          }
          if (text === "") {
            text = "Antigravity 运行失败";
          }
        }
        if (result["usage"] !== null && typeof result["usage"] === "object" && !Array.isArray(result["usage"])) {
          const usage = result["usage"];
          s.SetUsage(int64Value(usage["input_tokens"]), int64Value(usage["output_tokens"]), int64Value(usage["cache_read_tokens"]), 0, int64Value(usage["thinking_tokens"]));
        }
        return s.Result(text, failed);
      }
    }
    return [];
  }

  // translateStep：按 step_type 分发一次 `step_update` 负载；error_message 步只记下失败供最终结果使用。
  translateStep(s, step) {
    const index = int64Value(step["step_index"]);
    const done = stringValue(step["state"]) === "DONE";
    switch (stringValue(step["step_type"])) {
      case "agent_response":
        return this.responseStep(s, step, index, done);
      case "tool":
        return antigravityToolStep(s, step, index, done);
      case "error_message": {
        const text = errorText(step["error"]);
        if (text !== "") {
          this.failure = text;
        }
        break;
      }
    }
    return [];
  }

  // responseStep：流式输出文本增量，步骤 DONE 时记录用量并把累计文本作为一块发出。
  responseStep(s, step, index, done) {
    const delta = stringValue(step["text_delta"]);
    this.text += delta;
    let out = s.Delta(`text#${index}`, "text", delta);
    if (done) {
      if (step["usage"] !== null && typeof step["usage"] === "object" && !Array.isArray(step["usage"])) {
        const usage = step["usage"];
        s.AddUsage(int64Value(usage["input_tokens"]), int64Value(usage["output_tokens"]), int64Value(usage["cache_read_tokens"]), 0, int64Value(usage["thinking_tokens"]));
      }
      out = [...out, ...s.Text(this.text)];
      this.text = "";
    }
    return out;
  }
}

// antigravityToolStep：报告工具调用（把 call_mcp_tool 展开为 mcp__<server>__<tool> 名），步骤 DONE 时报告其结果。
function antigravityToolStep(s, step, index, done) {
  const info = step["tool_info"] ?? {};
  const id = `${stringValue(step["conversation_id"])}#${index}`;
  let name = stringValue(info["name"]);
  let input = info["parameters"];
  if (input !== null && typeof input === "object" && !Array.isArray(input) && name === "call_mcp_tool") {
    name = "mcp__" + stringValue(input["ServerName"]) + "__" + stringValue(input["ToolName"]);
    input = input["Arguments"];
  }
  let out = s.ToolUse(id, name, input);
  if (done) {
    const failure = errorText(info["error"]);
    if (failure !== "") {
      out = [...out, ...s.ToolResult(id, true, failure)];
    } else {
      out = [...out, ...s.ToolResult(id, false, jsonText(info["output"]))];
    }
  }
  return out;
}

// kimiStream：`kimi -p --output-format stream-json` 打印完整消息；会话 ID 随结尾的 resume 提示才到。
class kimiStream {
  constructor() {
    this.started = false;
  }

  translate(s, raw) {
    let out = [];
    if (!this.started) {
      this.started = true;
      out = s.Init("", "");
    }
    switch (stringValue(raw["role"])) {
      case "assistant": {
        if (typeof raw["content"] === "string") {
          out = [...out, ...s.Text(raw["content"])];
        }
        for (const item of sliceValue(raw["content"]) ?? []) {
          const part = item ?? {};
          switch (stringValue(part["type"])) {
            case "text":
              out = [...out, ...s.Text(stringValue(part["text"]))];
              break;
            case "think":
            case "thinking": {
              let text = stringValue(part["think"]);
              if (text === "") {
                text = stringValue(part["thinking"]);
              }
              out = [...out, ...s.Thinking(text)];
              break;
            }
          }
        }
        for (const item of sliceValue(raw["tool_calls"]) ?? []) {
          const call = item ?? {};
          const fn = call["function"] ?? {};
          let input = {};
          const args = stringValue(fn["arguments"]);
          if (args !== "") {
            try {
              input = JSON.parse(args);
            } catch (err) {
              // Go 忽略解析错误，input 保持原值。
            }
          }
          out = [...out, ...s.ToolUse(stringValue(call["id"]), stringValue(fn["name"]), input)];
        }
        break;
      }
      case "tool":
        out = [...out, ...s.ToolResult(stringValue(raw["tool_call_id"]), false, contentText(raw["content"]))];
        break;
      case "meta":
        if (stringValue(raw["type"]) === "session.resume_hint") {
          s.SessionID = stringValue(raw["session_id"]);
          out = [...out, ...s.Init(s.SessionID, "")];
          out = [...out, ...s.Result("", false)];
        }
        break;
    }
    return out;
  }
}

// piStream：`pi --mode json` 按内容序号流式输出增量，并报告已完成的消息与工具执行。
class piStream {
  constructor() {
    this.turn = 0;
    this.failure = "";
  }

  translate(s, raw) {
    switch (stringValue(raw["type"])) {
      case "session":
        return s.Init(stringValue(raw["id"]), "");
      case "turn_start":
        this.turn++;
        break;
      case "message_update": {
        const event = raw["assistantMessageEvent"] ?? {};
        const key = `${this.turn}#${int64Value(event["contentIndex"])}`;
        switch (stringValue(event["type"])) {
          case "text_delta":
            return s.Delta(key, "text", stringValue(event["delta"]));
          case "thinking_delta":
            return s.Delta(key, "thinking", stringValue(event["delta"]));
        }
        break;
      }
      case "message_end": {
        const message = raw["message"] ?? {};
        if (stringValue(message["role"]) !== "assistant") {
          return [];
        }
        const usage = message["usage"] ?? {};
        s.AddUsage(int64Value(usage["input"]), int64Value(usage["output"]), int64Value(usage["cacheRead"]), int64Value(usage["cacheWrite"]), int64Value(usage["reasoning"]));
        if (stringValue(message["stopReason"]) === "error") {
          this.failure = stringValue(message["errorMessage"]);
        }
        let out = [];
        for (const item of sliceValue(message["content"]) ?? []) {
          const part = item ?? {};
          switch (stringValue(part["type"])) {
            case "text":
              out = [...out, ...s.Text(stringValue(part["text"]))];
              break;
            case "thinking":
              out = [...out, ...s.Thinking(stringValue(part["thinking"]))];
              break;
            case "toolCall":
              out = [...out, ...s.ToolUse(stringValue(part["id"]), stringValue(part["name"]), part["arguments"])];
              break;
          }
        }
        return [...out, ...s.CloseBlock()];
      }
      case "tool_execution_start":
        // 顶层调用由助手消息报告；仅嵌套调用（codemode 内调 MCP 工具）出现在这里。
        if (stringValue(raw["parentToolCallId"]) === "") {
          return [];
        }
        return s.ToolUse(stringValue(raw["toolCallId"]), stringValue(raw["toolName"]), raw["args"]);
      case "tool_execution_end": {
        const result = raw["result"] ?? {};
        const failed = raw["isError"] === true;
        return s.ToolResult(stringValue(raw["toolCallId"]), failed, contentText(result["content"]));
      }
      case "agent_end":
        if (this.failure !== "" && s.LastText === "") {
          return s.Result(this.failure, true);
        }
        return s.Result("", false);
    }
    return [];
  }
}

// dshStream：`dsh --json` 把每个事件字符串截断到 8 KiB 并标记 `truncated`；只有终态 `final` 携带完整答案。截断文本先暂存，待 `final` 替换而非追加。
class dshStream {
  constructor() {
    this.failure = "";
    this.truncatedText = "";
  }

  translate(s, raw) {
    const kind = stringValue(raw["type"]);
    let out = [];
    if (this.truncatedText !== "" && (kind === "thinking" || kind === "text" || kind === "tool_call" || kind === "tool_result")) {
      out = s.Text(this.truncatedText);
      this.truncatedText = "";
    }
    switch (kind) {
      case "session":
        return [...out, ...s.Init(stringValue(raw["sessionId"]), "")];
      case "thinking":
        return [...out, ...s.Thinking(stringValue(raw["text"]))];
      case "text":
        if (raw["truncated"] === true) {
          this.truncatedText = stringValue(raw["text"]);
          return out;
        }
        return [...out, ...s.Text(stringValue(raw["text"]))];
      case "tool_call":
        return [...out, ...s.ToolUse(stringValue(raw["callId"]), stringValue(raw["tool"]), raw["input"])];
      case "tool_result":
        return [...out, ...s.ToolResult(stringValue(raw["callId"]), stringValue(raw["status"]) !== "completed", jsonText(raw["result"]))];
      case "status":
        if (stringValue(raw["phase"]) === "step_end") {
          const usage = raw["usage"] ?? {};
          s.AddUsage(int64Value(usage["inputTokens"]), int64Value(usage["outputTokens"]), int64Value(usage["cacheReadTokens"]), int64Value(usage["cacheWriteTokens"]), int64Value(usage["reasoningTokens"]));
        }
        break;
      case "error":
        this.failure = errorText(raw);
        break;
      case "final": {
        const session = stringValue(raw["sessionId"]);
        if (session !== "") {
          s.SessionID = session;
        }
        const reason = raw["reason"] ?? {};
        const failed = stringValue(reason["kind"]) !== "completed";
        let text = stringValue(raw["text"]);
        const held = this.truncatedText;
        if (held !== "") {
          this.truncatedText = "";
          let heldText = held;
          if (text.startsWith(held)) {
            heldText = text;
          }
          out = [...out, ...s.Text(heldText)];
        }
        if (failed && text === "") {
          text = this.failure;
          if (text === "") {
            text = "DeepSeek Harness 运行结束：" + stringValue(reason["kind"]);
          }
        }
        return [...out, ...s.Result(text, failed)];
      }
    }
    return out;
  }
}

module.exports = {
  ClaudeStream, NewAgentCLITranslator, jsonText, contentText, errorText,
  openCodeStream, cursorStream, cursorToolCall,
  cursorAutoRoutePrefix, cursorAutoRouteNoticeRe, cursorAutoRouteModelRe,
  cursorAutoRouteNotice, cursorAutoRouteMayStart, cursorRouteFilter, stripCursorAutoRoute,
  antigravityStream, antigravityToolStep, kimiStream, piStream, dshStream,
};
