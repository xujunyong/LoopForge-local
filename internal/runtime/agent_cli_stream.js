/**
 * @file internal/runtime/agent_cli_stream.js
 * @description 对应 Go 源文件：internal/runtime/agent_cli_stream.go
 *
 * 职责与边界：
 * 将各扩展 Agent CLI（OpenCode、Cursor CLI、Antigravity、Kimi Code、Pi、DeepSeek Harness、ZCode）
 * 的原生 headless JSON 行输出统一翻译为 Claude 风格的 stream-json 行，供 SOP 协议适配器与 AI 对话解析。
 * 不负责进程调度或 ZCode 专属实现（ZCode 翻译器位于 `agent_cli_zcode.js`）。
 *
 * 语法差异说明：
 * - Go `struct` 译为带 `constructor(init = {})` 的类，字段严格按 Go 零值初始化（`started`/`usage` 初始为 `null` 以区分是否已记录）。
 * - Go `strings.Builder` 译为普通字符串累加或数组拼接。
 * - Go 多返回值 `(string, bool)`、`(... )` 译为元组数组；Go `defer` 译为 `try ... finally`。
 * - 正则 `FindStringSubmatchIndex` 使用 JS `/d`（indices）标志实现。
 */

"use strict";

const { AgentCLIOpenCode, AgentCLICursor, AgentCLIAntigravity, AgentCLIKimi, AgentCLIPi, AgentCLIDeepSeek, AgentCLIZCode } = require("./agent_cli.js"); // 对应 Go 同包常量，agent_cli.js 已翻译
const { stringValue, sliceValue, int64Value } = require("./protocol.js"); // 对应 Go 同包函数，protocol.js 待翻译
const { zcodeStream } = require("./agent_cli_zcode.js"); // 对应 Go 同包类型，agent_cli_zcode.js 待翻译

/**
 * 渲染 Claude 风格的 stream-json 行，供 SOP 协议适配器与 AI 对话消费。
 * 增量输出转为 `stream_event` 内容块，完成文本/思考/工具调用转为 `assistant` 块，
 * 工具输出转为 `user` `tool_result` 块，轮次结束时发出 `result` 行，并在得知 `SessionID` 后附带到每一行。
 */
class ClaudeStream {
  /**
   * 构造 ClaudeStream 状态机实例，字段按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.SessionID = init.SessionID ?? "";
    // LastText：最新的已完成助手文本；CLI 未报告时即本轮答案。
    this.LastText = init.LastText ?? "";
    this.block = init.block ?? "";
    this.started = init.started ?? null;
    this.usage = init.usage ?? null;
    this.done = init.done ?? false;
  }

  /**
   * 将事件对象序列化为单行 JSON，若已知 `SessionID` 则自动注入 `session_id`。
   *
   * @param {Object} v - 待序列化的事件对象。
   * @returns {string} JSON 字符串。
   */
  line(v) {
    if (this.SessionID !== "") {
      v["session_id"] = this.SessionID;
    }
    return JSON.stringify(v);
  }

  /**
   * 宣告会话初始化事件；若 `sessionID` 非空则记录到流状态中。
   *
   * @param {string} sessionID - 会话标识。
   * @param {string} model - 模型名称（可为空字符串）。
   * @returns {string[]} 包含一条 `system/init` JSON 行的数组。
   */
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

  /**
   * 将文本增量流式写入内容块 `key`（`kind` 为 `"text"` 或 `"thinking"`）；切换块时先关闭旧块并打开新块。
   *
   * @param {string} key - 内容块唯一标识。
   * @param {string} kind - 内容块类型（`"text"` 或 `"thinking"`）。
   * @param {string} text - 增量文本内容。
   * @returns {string[]} 生成的 stream-json 行数组；`text` 为空时返回空数组。
   */
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

  /**
   * 若当前存在打开中的流式内容块，则发出 `content_block_stop` 事件并复位块标识。
   *
   * @returns {string[]} 关闭事件行数组；无活动块时返回空数组。
   */
  CloseBlock() {
    if (this.block === "") {
      return [];
    }
    this.block = "";
    return [this.line({ type: "stream_event", event: { type: "content_block_stop" } })];
  }

  /**
   * 关闭当前增量块并发出一条包含单个内容块的 `assistant` 消息行。
   *
   * @param {Object} block - 内容块对象（文本、思考或工具调用）。
   * @returns {string[]} 生成的 stream-json 行数组。
   */
  assistant(block) {
    return [...this.CloseBlock(), this.line({ type: "assistant", message: { role: "assistant", content: [block] } })];
  }

  /**
   * 记录一段已完成的助手文本块，并更新 `LastText`。
   *
   * @param {string} text - 完整文本内容。
   * @returns {string[]} 生成的 stream-json 行数组；空白文本仅关闭当前增量块。
   */
  Text(text) {
    if (text.trim() === "") {
      return this.CloseBlock();
    }
    this.LastText = text;
    return this.assistant({ type: "text", text });
  }

  /**
   * 记录一段已完成的思考/推理块。
   *
   * @param {string} text - 完整思考文本。
   * @returns {string[]} 生成的 stream-json 行数组；空白文本仅关闭当前增量块。
   */
  Thinking(text) {
    if (text.trim() === "") {
      return this.CloseBlock();
    }
    return this.assistant({ type: "thinking", thinking: text });
  }

  /**
   * 记录一次工具调用；同一个 `id` 仅记录一次，重复调用将被忽略。
   *
   * @param {string} id - 工具调用唯一标识。
   * @param {string} name - 工具名称。
   * @param {*} input - 工具入参对象（为空时默认 `{}`）。
   * @returns {string[]} 生成的 stream-json 行数组；参数无效或重复时返回空数组。
   */
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

  /**
   * 记录一次已完成工具调用的返回结果。
   *
   * @param {string} id - 对应的工具调用 ID。
   * @param {boolean} failed - 工具执行是否失败。
   * @param {string} content - 工具输出或错误信息文本。
   * @returns {string[]} 生成的 stream-json 行数组；`id` 为空时返回空数组。
   */
  ToolResult(id, failed, content) {
    if (id === "") {
      return [];
    }
    return [...this.CloseBlock(), this.line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: failed, content }] } })];
  }

  /**
   * 累加单步报告的各类 Token 用量。
   *
   * @param {number} input - 输入 Token 数。
   * @param {number} output - 输出 Token 数。
   * @param {number} cacheRead - 缓存读取 Token 数。
   * @param {number} cacheWrite - 缓存写入 Token 数。
   * @param {number} reasoning - 推理 Token 数。
   * @returns {void} 无返回值。
   */
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

  /**
   * 用整轮汇总的 Token 用量替换已累计的用量。
   *
   * @param {number} input - 总输入 Token 数。
   * @param {number} output - 总输出 Token 数。
   * @param {number} cacheRead - 总缓存读取 Token 数。
   * @param {number} cacheWrite - 总缓存写入 Token 数。
   * @param {number} reasoning - 总推理 Token 数。
   * @returns {void} 无返回值。
   */
  SetUsage(input, output, cacheRead, cacheWrite, reasoning) {
    this.usage = null;
    this.AddUsage(input, output, cacheRead, cacheWrite, reasoning);
  }

  /**
   * 结束本轮输出并生成 `result` 事件行（整轮仅发出一次）；成功且文本为空时回落到 `LastText`。
   *
   * @param {string} text - 最终结果或错误文本。
   * @param {boolean} failed - 本轮是否以失败结束。
   * @returns {string[]} 生成的 stream-json 行数组；若已结束则返回空数组。
   */
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

  /**
   * 报告本轮是否已经发出过 `result` 终态事件。
   *
   * @returns {boolean} 已结束返回 `true`，否则返回 `false`。
   */
  Finished() { return this.done; }
}

/**
 * 为指定 Agent CLI 创建行级输出翻译函数，将每行原生 JSON 事件转换为 `ClaudeStream` 行数组。
 * 在协议适配器初始化时调用。
 *
 * @param {string} kind - Agent CLI 种类标识。
 * @returns {((line: string) => string[]) | null} 翻译函数；不支持的种类返回 `null`。
 */
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

/**
 * 将任意值转换为展示用文本：空值返回 `""`，字符串原样返回，其他值序列化为 JSON。
 *
 * @param {*} value - 待转换值。
 * @returns {string} 文本表示。
 */
function jsonText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * 提取并拼接 MCP 或对话消息 `content` 字段中的文本段落；若无文本段且值非空则回退为 JSON 字符串。
 *
 * @param {*} value - 字符串或内容块数组。
 * @returns {string} 拼接后的文本内容。
 */
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

/**
 * 从字符串或嵌套错误对象（`message`、`error`、`data`、`name`）中递归提取可读错误消息。
 *
 * @param {*} value - 原始错误字段值。
 * @returns {string} 提取出的错误文本；无法提取时返回 `""`。
 */
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

/**
 * OpenCode CLI（`opencode run --format json`）输出流翻译器，处理已完成的内容片段与步骤事件。
 */
class openCodeStream {
  /**
   * 构造 openCodeStream 实例。
   *
   * @param {Object} [init={}] - 可选初始字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.started = init.started ?? false;
    this.failure = init.failure ?? "";
  }

  /**
   * 将单条 OpenCode JSON 事件翻译为 `ClaudeStream` 行数组。
   *
   * @param {ClaudeStream} s - 目标 ClaudeStream 状态机。
   * @param {Object} raw - 解析后的原生 JSON 事件对象。
   * @returns {string[]} 翻译出的 stream-json 行数组。
   */
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

/**
 * Cursor CLI（`cursor-agent -p --output-format stream-json --stream-partial-output`）输出流翻译器。
 * 负责处理增量文本去重、Auto 路由提示过滤、思考增量与工具调用事件。
 */
class cursorStream {
  /**
   * 构造 cursorStream 实例。
   *
   * @param {Object} [init={}] - 可选初始字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.segment = init.segment ?? 0;
    this.partial = init.partial ?? "";
    this.thinking = init.thinking ?? "";
    // hold：与已流式输出文本完全相同的带时间戳助手块，下一事件决定其归属。
    this.hold = init.hold ?? "";
    this.held = init.held ?? false;
    this.routes = init.routes ?? new cursorRouteFilter();
  }

  /**
   * 过滤并提交已累计的增量文本，随后重置局部缓冲。
   *
   * @param {ClaudeStream} s - 目标 ClaudeStream 状态机。
   * @returns {string[]} 生成的 stream-json 行数组。
   */
  flushText(s) {
    const text = stripCursorAutoRoute(this.partial);
    this.resetPartial();
    return s.Text(text);
  }

  /**
   * 清空增量文本缓冲与路由过滤器，并递增文本段编号。
   *
   * @returns {void} 无返回值。
   */
  resetPartial() {
    this.partial = "";
    this.routes = new cursorRouteFilter();
    this.segment++;
  }

  /**
   * 提交或丢弃 `acceptPartial` 暂存的重复文本块；若后续事件是工具调用则丢弃该重发缓冲。
   *
   * @param {boolean} discard - 是否丢弃暂存块。
   * @returns {string} 释放后应展示的增量文本（丢弃或无暂存时返回 `""`）。
   */
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

  /**
   * 接收一段增量文本并返回新可见部分；与当前累计文本完全一致的块先暂存待下一事件判定。
   *
   * @param {string} text - 新到达的增量文本块。
   * @returns {string} 过滤路由提示后可立即输出的增量文本。
   */
  acceptPartial(text) {
    const accumulated = this.partial;
    if (accumulated !== "" && text === accumulated) {
      this.hold = text;
      this.held = true;
      return "";
    }
    return this.appendPartial(text);
  }

  /**
   * 将增量文本追加到缓冲并通过路由过滤器输出安全文本。
   *
   * @param {string} text - 待追加文本。
   * @returns {string} 过滤后可立即展示的文本。
   */
  appendPartial(text) {
    this.partial += text;
    return this.routes.feed(text);
  }

  /**
   * 提交累计的思考文本块并重置思考缓冲。
   *
   * @param {ClaudeStream} s - 目标 ClaudeStream 状态机。
   * @returns {string[]} 生成的 stream-json 行数组；思考缓冲为空时返回空数组。
   */
  flushThinking(s) {
    const text = this.thinking;
    this.thinking = "";
    if (text === "") {
      return [];
    }
    this.segment++;
    return s.Thinking(text);
  }

  /**
   * 翻译单条 Cursor 事件：先根据事件类型释放暂存块，再分发给 `translateEvent`。
   *
   * @param {ClaudeStream} s - 目标 ClaudeStream 状态机。
   * @param {Object} raw - 解析后的原生 JSON 事件对象。
   * @returns {string[]} 翻译出的 stream-json 行数组。
   */
  translate(s, raw) {
    const kind = stringValue(raw["type"]);
    let prelude = [];
    const text = this.releaseHold(kind === "tool_call");
    if (text !== "") {
      prelude = s.Delta(`text#${this.segment}`, "text", text);
    }
    return [...prelude, ...this.translateEvent(s, raw)];
  }

  /**
   * 按 `type` 字段分发并翻译单条 Cursor 事件。
   *
   * @param {ClaudeStream} s - 目标 ClaudeStream 状态机。
   * @param {Object} raw - 解析后的原生 JSON 事件对象。
   * @returns {string[]} 翻译出的 stream-json 行数组。
   */
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
          const res = result ?? {};
          const success = res["success"];
          const ok = "success" in res;
          let failure = res["error"];
          if (!ok && (failure === null || failure === undefined)) {
            failure = res["rejected"];
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

/**
 * 从 Cursor `tool_call` 事件中解析工具名称、入参对象与执行结果。
 * 将 `mcpToolCall` 展开为 `mcp__<server>__<tool>`，将 `shellToolCall` 映射为 `Bash`。
 *
 * @param {Object} raw - 原始 Cursor `tool_call` 事件对象。
 * @returns {[string, *, Object | null]} 三元组 `[工具名, 入参, 结果对象]`；未匹配到工具调用时返回 `["", null, null]`。
 */
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

/**
 * 检测单行末尾是否带有 Cursor Auto 路由提示，并返回提示之前的正文部分。
 *
 * @param {string} line - 待检测的单行文本。
 * @returns {[string, boolean]} 二元组 `[提示前正文, 是否命中路由提示]`。
 */
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

/**
 * 判断未完成的剩余文本 `rest` 是否仍可能继续拼接成一条 Cursor Auto 路由提示。
 *
 * @param {string} rest - 待判断的剩余文本片段。
 * @param {boolean} afterMarker - 是否位于 `>` 标记之后。
 * @returns {boolean} 仍可能成为路由提示返回 `true`，否则返回 `false`。
 */
function cursorAutoRouteMayStart(rest, afterMarker) {
  rest = rest.replace(/^[ \t]+/, "");
  if (rest.length <= cursorAutoRoutePrefix.length) {
    return cursorAutoRoutePrefix.startsWith(rest) && (afterMarker || rest !== "");
  }
  return rest.startsWith(cursorAutoRoutePrefix) && cursorAutoRouteModelRe.test(rest.slice(cursorAutoRoutePrefix.length));
}

/**
 * 流式丢弃 Cursor Auto 路由提示及其后紧跟的重复进度句的过滤器。
 * 仅暂存尚未确定是否会形成提示或重复句的未完成行部分，降低增量输出延迟。
 */
class cursorRouteFilter {
  /**
   * 构造 cursorRouteFilter 实例，字段按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.line = init.line ?? ""; // 未完成的行
    this.shown = init.shown ?? 0; // 行中已输出的字节数
    this.open = init.open ?? false; // 行已在输出中开始
    this.any = init.any ?? false; // 输出至少有一行
    this.last = init.last ?? ""; // 上一条非空输出行（去空白）
    this.anchor = init.anchor ?? ""; // 最新提示之前的行
    this.pending = init.pending ?? false; // 等待提示后的首条非空行
    this.blanks = init.blanks ?? []; // 等待期间暂存的空行
  }

  /**
   * 喂入一段新文本并返回当前可安全输出的文本。
   *
   * @param {string} text - 新到达的文本片段。
   * @returns {string} 已确认可展示的输出文本。
   */
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

  /**
   * 冲刷未完成的最后一行并返回剩余输出文本。
   *
   * @returns {string} 末尾冲刷出的文本。
   */
  finish() {
    const parts = [];
    this.endLine(parts);
    return parts.join("");
  }

  /**
   * 计算当前未完成行中可以安全立即展示的字符边界位置。
   *
   * @returns {number} 可安全展示的前缀长度。
   */
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

  /**
   * 若当前行尚未在输出中开启，则先冲刷暂存空行并补齐换行符。
   *
   * @param {string[]} parts - 输出片段数组。
   * @returns {void} 无返回值。
   */
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

  /**
   * 若已有输出行则追加换行符，并标记输出非空。
   *
   * @param {string[]} parts - 输出片段数组。
   * @returns {void} 无返回值。
   */
  newline(parts) {
    if (this.any) {
      parts.push("\n");
    }
    this.any = true;
  }

  /**
   * 结算当前完整行：识别路由提示、跳过提示后紧跟的重复行或正常输出，并在结束时复位行状态。
   *
   * @param {string[]} parts - 输出片段数组。
   * @returns {void} 无返回值。
   */
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

/**
 * 对已完成文本一次性应用 `cursorRouteFilter`，移除其中的 Cursor Auto 路由提示。
 *
 * @param {string} text - 待清理的完整文本。
 * @returns {string} 清理后的文本。
 */
function stripCursorAutoRoute(text) {
  if (!text.includes(cursorAutoRoutePrefix)) {
    return text;
  }
  const f = new cursorRouteFilter();
  return f.feed(text) + f.finish();
}

/**
 * Antigravity CLI（`agy -p --output-format stream-json`）输出流翻译器。
 */
class antigravityStream {
  /**
   * 构造 antigravityStream 实例。
   *
   * @param {Object} [init={}] - 可选初始字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.text = init.text ?? "";
    this.failure = init.failure ?? "";
  }

  /**
   * 翻译单条 Antigravity JSON 事件。
   *
   * @param {ClaudeStream} s - 目标 ClaudeStream 状态机。
   * @param {Object} raw - 解析后的原生 JSON 事件对象。
   * @returns {string[]} 翻译出的 stream-json 行数组。
   */
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

  /**
   * 按 `step_type` 分发单条 `step_update` 负载；`error_message` 步骤仅记录错误供最终结果使用。
   *
   * @param {ClaudeStream} s - 目标 ClaudeStream 状态机。
   * @param {Object} step - `step_update` 对象。
   * @returns {string[]} 翻译出的 stream-json 行数组。
   */
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

  /**
   * 处理 `agent_response` 步骤：流式输出文本增量，步骤 DONE 时累加用量并发出完整文本块。
   *
   * @param {ClaudeStream} s - 目标 ClaudeStream 状态机。
   * @param {Object} step - 步骤负载对象。
   * @param {number} index - 步骤序号。
   * @param {boolean} done - 步骤是否已完成。
   * @returns {string[]} 翻译出的 stream-json 行数组。
   */
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

/**
 * 处理 Antigravity `tool` 步骤：记录工具调用（将 `call_mcp_tool` 展开为 `mcp__<server>__<tool>`），
 * 步骤 DONE 时输出工具执行结果或错误。
 *
 * @param {ClaudeStream} s - 目标 ClaudeStream 状态机。
 * @param {Object} step - 步骤负载对象。
 * @param {number} index - 步骤序号。
 * @param {boolean} done - 步骤是否已完成。
 * @returns {string[]} 翻译出的 stream-json 行数组。
 */
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

/**
 * Kimi Code CLI（`kimi -p --output-format stream-json`）输出流翻译器。
 * Kimi 输出完整消息，会话 ID 随末尾 `session.resume_hint` 元事件到达。
 */
class kimiStream {
  /**
   * 构造 kimiStream 实例。
   *
   * @param {Object} [init={}] - 可选初始字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.started = init.started ?? false;
  }

  /**
   * 翻译单条 Kimi JSON 事件。
   *
   * @param {ClaudeStream} s - 目标 ClaudeStream 状态机。
   * @param {Object} raw - 解析后的原生 JSON 事件对象。
   * @returns {string[]} 翻译出的 stream-json 行数组。
   */
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

/**
 * Pi CLI（`pi --mode json`）输出流翻译器，按轮次与内容序号处理增量和已完成消息/工具事件。
 */
class piStream {
  /**
   * 构造 piStream 实例。
   *
   * @param {Object} [init={}] - 可选初始字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.turn = init.turn ?? 0;
    this.failure = init.failure ?? "";
  }

  /**
   * 翻译单条 Pi JSON 事件。
   *
   * @param {ClaudeStream} s - 目标 ClaudeStream 状态机。
   * @param {Object} raw - 解析后的原生 JSON 事件对象。
   * @returns {string[]} 翻译出的 stream-json 行数组。
   */
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

/**
 * DeepSeek Harness（`dsh --profile headless --json`）输出流翻译器。
 * 暂存标记为 `truncated` 的 8 KiB 截断文本，以便在终态 `final` 到达时用完整文本替换而非重复追加。
 */
class dshStream {
  /**
   * 构造 dshStream 实例。
   *
   * @param {Object} [init={}] - 可选初始字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.failure = init.failure ?? "";
    this.truncatedText = init.truncatedText ?? "";
  }

  /**
   * 翻译单条 DeepSeek Harness JSON 事件。
   *
   * @param {ClaudeStream} s - 目标 ClaudeStream 状态机。
   * @param {Object} raw - 解析后的原生 JSON 事件对象。
   * @returns {string[]} 翻译出的 stream-json 行数组。
   */
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
