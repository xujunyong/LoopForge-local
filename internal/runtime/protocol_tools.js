"use strict";

/**
 * @file internal/runtime/protocol_tools.js
 * @description 对应 Go 源文件 `internal/runtime/protocol_tools.go`。
 * 负责协议适配器的令牌用量解析、安全原生属性白名单过滤、工具调用流式参数累积与摘要格式化。
 *
 * Go -> JS 语法与结构差异说明：
 * - 属于 `protocolAdapter` 的跨文件方法按规范挂载在 `protocolAdapter.prototype` 上。
 * - 单线程 JS 略去 `a.mu` 互斥锁。
 * - `clipToolMsg` 使用 `Buffer.byteLength` 对齐 Go 的 UTF-8 字节长度判定，并调用 `clipOnRuneBoundary` 避免截断多字节字符。
 */

const { TelemetryEvent, TokenUsage } = require("../domain/run.js");
const { ToolObservation } = require("../domain/observability.js");
const { protocolAdapter, toolUseBuf, stringValue, int64Value, float64Value } = require("./protocol.js");
const { clipOnRuneBoundary } = require("./runner.js"); // 待翻译

/**
 * 从原生 JSON 事件中筛选允许暴露的安全元数据字段。
 * 用于通用 JSON 协议适配器的属性脱敏。
 *
 * @param {Record<string, any>} raw - 原始事件对象。
 * @returns {Record<string, any>} 仅包含白名单键的新对象。
 */
function safeNativeAttributes(raw) {
  const out = {};
  for (const key of ["type", "status", "subtype", "duration_ms", "num_turns", "exit_code", "finish_reason"]) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      out[key] = raw[key];
    }
  }
  return out;
}

/**
 * 按运行时适配器统一字段规则解析各家 Provider 上报的令牌用量对象（如 stream-json 的 `result.usage`）。
 *
 * @param {any} value - 原始用量对象。
 * @returns {TokenUsage} 归一化后的令牌用量结构。
 */
function ParseTokenUsage(value) {
  return tokenUsage(value);
}

/**
 * 内部实现：从兼容多种命名风格（snake_case / camelCase）的用量对象中提取令牌与费用统计。
 *
 * @param {any} value - 原始用量对象。
 * @returns {TokenUsage} 归一化后的令牌用量结构。
 */
function tokenUsage(value) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const first = (...keys) => {
    for (const key of keys) {
      const n = int64Value(v[key]);
      if (n !== 0) {
        return n;
      }
    }
    return 0;
  };
  const usage = new TokenUsage({
    InputTokens: first("input_tokens", "prompt_tokens", "inputTokens"),
    OutputTokens: first("output_tokens", "completion_tokens", "outputTokens"),
    CacheReadTokens: first("cache_read_input_tokens", "cached_input_tokens", "cache_read_tokens"),
    CacheWriteTokens: first("cache_creation_input_tokens", "cache_write_tokens"),
    ReasoningTokens: first("reasoning_tokens"),
    ContextWindow: first("context_window", "contextWindow"),
  });
  // 适配器显式上报成本（即使为 0）标记 reported，用于区分"真实零成本"与"成本未识别"。
  if (Object.prototype.hasOwnProperty.call(v, "total_cost_usd")) {
    usage.CostUSD = float64Value(v["total_cost_usd"]);
    usage.CostStatus = "reported";
  }
  usage.TotalTokens = first("total_tokens", "totalTokens");
  if (usage.TotalTokens === 0) {
    usage.TotalTokens = usage.InputTokens + usage.OutputTokens;
  }
  return usage;
}

/**
 * 登记一次新的流式工具调用并设为当前活跃工具，用于后续接收 `input_json_delta` 增量片段。
 *
 * @param {string} id - 工具调用 ID。
 * @param {string} name - 工具名称。
 * @param {string} sessionID - 所属会话 ID。
 * @param {string} parentID - 父级工具调用 ID。
 * @returns {void} 无返回值。
 */
protocolAdapter.prototype.beginToolUse = function (id, name, sessionID, parentID) {
  if (id === "") {
    return;
  }
  if (this.tools === null) {
    this.tools = {};
  }
  let buf = this.tools[id] ?? null;
  if (buf === null) {
    buf = new toolUseBuf({ id, name, sessionID, parentID });
    this.tools[id] = buf;
  }
  if (name !== "") {
    buf.name = name;
  }
  if (sessionID !== "") {
    buf.sessionID = sessionID;
  }
  if (parentID !== "") {
    buf.parentID = parentID;
  }
  this.currentToolID = id;
};

/**
 * 向当前活跃工具调用缓冲区追加一段流式 JSON 入参片段。
 *
 * @param {string} partial - 部分 JSON 文本。
 * @returns {void} 无返回值。
 */
protocolAdapter.prototype.appendToolJSON = function (partial) {
  if (partial === "") {
    return;
  }
  const buf = this.tools[this.currentToolID] ?? null;
  if (buf === null) {
    return;
  }
  buf.json += partial;
};

/**
 * 在内容块结束（`content_block_stop`）时解析当前活跃工具已累积的 JSON 参数，并发射工具开始事件。
 *
 * @returns {void} 无返回值。
 */
protocolAdapter.prototype.flushCurrentTool = function () {
  const id = this.currentToolID;
  const buf = this.tools[id] ?? null;
  let raw = "";
  let name = "";
  let sessionID = "";
  let parentID = "";
  if (buf !== null) {
    raw = buf.json;
    name = buf.name;
    sessionID = buf.sessionID;
    parentID = buf.parentID;
  }
  if (id === "" || buf === null) {
    return;
  }
  let input = null;
  if (raw.trim() !== "") {
    try {
      input = JSON.parse(raw);
    } catch (_) {
      input = raw;
    }
  }
  this.emitToolStart(id, name, sessionID, parentID, input);
};

/**
 * 幂等发射一次 `tool.call` 开始事件，并附上精简后的工具入参摘要。
 *
 * @param {string} id - 工具调用 ID。
 * @param {string} name - 工具名称。
 * @param {string} sessionID - 所属会话 ID。
 * @param {string} parentID - 父级工具调用 ID。
 * @param {any} input - 工具调用参数对象或原始文本。
 * @returns {void} 无返回值。
 */
protocolAdapter.prototype.emitToolStart = function (id, name, sessionID, parentID, input) {
  if (id === "" && name === "") {
    return;
  }
  if (this.tools === null) {
    this.tools = {};
  }
  let buf = this.tools[id] ?? null;
  if (buf === null && id !== "") {
    buf = new toolUseBuf({ id, name, sessionID, parentID });
    this.tools[id] = buf;
  }
  if (buf !== null && buf.emitted) {
    return;
  }
  if (buf !== null) {
    buf.emitted = true;
    if (name === "") {
      name = buf.name;
    }
    if (sessionID === "") {
      sessionID = buf.sessionID;
    }
    if (parentID === "") {
      parentID = buf.parentID;
    }
  }
  const msg = summarizeToolCall(name, input);
  this.emit(
    new TelemetryEvent({
      Category: "tool",
      Name: "tool.call",
      Phase: "start",
      Message: msg,
      SessionID: sessionID,
      ParentID: parentID,
      ToolCallID: id,
      Attributes: slimToolInput(input),
      Tool: new ToolObservation({ Name: name, Operation: "tool.use", CallID: id }),
    })
  );
};

/**
 * 根据工具调用 ID 查找已登记的工具名称。
 *
 * @param {string} id - 工具调用 ID。
 * @returns {string} 工具名称，未登记时返回空字符串。
 */
protocolAdapter.prototype.toolName = function (id) {
  const buf = this.tools[id] ?? null;
  if (buf !== null) {
    return buf.name;
  }
  return "";
};

/**
 * 判断 `content_block_start` 中携带的工具入参是否已经非空就绪，可直接发射开始事件。
 *
 * @param {any} input - 工具入参值。
 * @returns {boolean} 入参已就绪时返回 `true`，否则返回 `false`。
 */
function toolInputReady(input) {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return Object.keys(input).length > 0;
  }
  if (typeof input === "string") {
    return input.trim() !== "";
  }
  return input !== null && input !== undefined;
}

/**
 * 提取工具入参中的关键摘要字段并截断过长内容，生成用于遥测属性的精简入参对象。
 *
 * @param {any} input - 原始工具入参。
 * @returns {Record<string, any> | null} 精简后的属性对象；无有效内容时返回 `null`。
 */
function slimToolInput(input) {
  const fields = {};
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    for (const k of [
      "command",
      "cmd",
      "path",
      "file_path",
      "filePath",
      "pattern",
      "glob",
      "query",
      "url",
      "target",
      "skill",
      "skill_name",
      "name",
    ]) {
      const s = stringValue(input[k]).trim();
      if (s !== "") {
        fields[k] = clipToolMsg(s);
      }
    }
  }
  if (Object.keys(fields).length === 0) {
    const s = clipToolMsg(toolResultText(input));
    if (s !== "") {
      return { input: s };
    }
    return null;
  }
  return { input: fields };
}

/**
 * 将任意形态的工具结果内容（字符串、内容块数组、对象或其他 JSON 值）提取为纯文本。
 *
 * @param {any} value - 工具结果内容。
 * @returns {string} 提取并去除首尾空白后的文本。
 */
function toolResultText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      const s = toolResultText(item);
      if (s !== "") {
        parts.push(s);
      }
    }
    return parts.join("\n");
  }
  if (typeof value === "object") {
    return firstNonEmpty(
      stringValue(value["text"]),
      stringValue(value["content"]),
      stringValue(value["stdout"]),
      stringValue(value["output"])
    );
  }
  try {
    return JSON.stringify(value).trim();
  } catch (_) {
    return "";
  }
}

/**
 * 提取文本中的第一行日志内容（标准化 `\r\n` 后取首行并去除首尾空白）。
 *
 * @param {string} s - 原始多行文本。
 * @returns {string} 首行文本，输入为空时返回空字符串。
 */
function firstLogLine(s) {
  s = s.trim().replaceAll("\r\n", "\n");
  if (s === "") {
    return "";
  }
  const idx = s.indexOf("\n");
  const line = idx >= 0 ? s.slice(0, idx) : s;
  return line.trim();
}

/**
 * 判断文本是否像源码片段（多行或包含典型 Go 代码关键字），用于避免在工具完成摘要中刷出大段代码。
 *
 * @param {string} s - 待检测文本。
 * @returns {boolean} 疑似源码返回 `true`，否则返回 `false`。
 */
function looksLikeSource(s) {
  if (s.split("\n").length - 1 > 2) {
    return true;
  }
  return (
    s.includes("t.Fatalf") ||
    s.includes("func ") ||
    s.includes("package ") ||
    s.includes(" := ") ||
    s.includes("import (")
  );
}

/**
 * 生成面向界面展示的工具执行结果摘要（区分失败、读写检索类工具与命令行单行输出）。
 *
 * @param {string} name - 工具名称。
 * @param {boolean} failed - 工具调用是否失败。
 * @param {any} content - 工具返回的原始内容。
 * @returns {string} 简短中文结果摘要。
 */
function summarizeToolResult(name, failed, content) {
  let label = name.trim();
  if (label === "") {
    label = "工具";
  }
  const text = toolResultText(content).trim();
  const line = firstLogLine(text);
  if (failed) {
    if (line === "") {
      return label + " 失败";
    }
    return clipToolMsg(label + " 失败: " + line);
  }
  const lower = label.toLowerCase();
  const dump =
    lower.includes("read") ||
    lower.includes("write") ||
    lower.includes("edit") ||
    lower.includes("grep") ||
    lower.includes("glob") ||
    lower.includes("notebook");
  if (dump || looksLikeSource(text) || line === "") {
    return label + " 完成";
  }
  if (lower.includes("bash") || lower.includes("shell") || !text.includes("\n")) {
    return clipToolMsg(label + " 完成: " + line);
  }
  return label + " 完成";
}

/**
 * 折叠多余空白并将工具摘要截断至 180 字节以内（按 UTF-8 字符边界截断并追加省略号）。
 *
 * @param {string} s - 待截断的摘要文本。
 * @returns {string} 规范化并可能截断后的文本。
 */
function clipToolMsg(s) {
  s = s.trim().split(/\s+/).filter(Boolean).join(" ").trim();
  const n = 180;
  if (Buffer.byteLength(s, "utf8") <= n) {
    return s;
  }
  // 按字符边界截断，避免直接按字节切分导致中文等多字节 UTF-8 字符损坏。
  return clipOnRuneBoundary(s, n) + "…";
}

/**
 * 返回参数列表中第一个去除空白后非空的字符串。
 *
 * @param {...string} values - 候选字符串列表。
 * @returns {string} 首个非空且已去空白的字符串，全为空时返回空字符串。
 */
function firstNonEmpty(...values) {
  for (const v of values) {
    if (v.trim() !== "") {
      return v.trim();
    }
  }
  return "";
}

/**
 * 根据工具名称和入参生成一行简洁的工具调用摘要（如命令、文件路径、搜索模式或技能名）。
 *
 * @param {string} name - 工具名称。
 * @param {any} input - 工具调用参数。
 * @returns {string} 截断后的单行调用摘要。
 */
function summarizeToolCall(name, input) {
  name = name.trim();
  if (name === "") {
    name = "tool";
  }
  const fields = {};
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    for (const k of [
      "command",
      "cmd",
      "path",
      "file_path",
      "filePath",
      "pattern",
      "glob",
      "query",
      "url",
      "target",
      "skill",
      "skill_name",
      "name",
    ]) {
      const s = stringValue(input[k]).trim();
      if (s !== "") {
        fields[k] = s;
      }
    }
  } else if (typeof input === "string") {
    if (input.trim() !== "") {
      return clipToolMsg(name + " " + input.trim().split(/\s+/).filter(Boolean).join(" "));
    }
  }
  const lower = name.toLowerCase();
  let detail = "";
  if (lower.includes("bash") || lower.includes("shell")) {
    detail = firstNonEmpty(fields["command"] ?? "", fields["cmd"] ?? "");
  } else if (lower.includes("write") || lower.includes("edit") || lower.includes("read")) {
    detail = firstNonEmpty(fields["path"] ?? "", fields["file_path"] ?? "", fields["filePath"] ?? "");
  } else if (lower.includes("grep") || lower.includes("glob")) {
    detail = firstNonEmpty(fields["pattern"] ?? "", fields["glob"] ?? "", fields["path"] ?? "");
  } else if (lower.includes("skill")) {
    detail = firstNonEmpty(fields["skill"] ?? "", fields["skill_name"] ?? "", fields["name"] ?? "");
  } else {
    detail = firstNonEmpty(
      fields["command"] ?? "",
      fields["cmd"] ?? "",
      fields["path"] ?? "",
      fields["file_path"] ?? "",
      fields["filePath"] ?? "",
      fields["query"] ?? "",
      fields["url"] ?? "",
      fields["pattern"] ?? "",
      fields["glob"] ?? "",
      fields["skill"] ?? "",
      fields["name"] ?? ""
    );
  }
  if (detail === "") {
    return name;
  }
  return clipToolMsg(name + " " + detail.trim().split(/\s+/).filter(Boolean).join(" "));
}

module.exports = {
  safeNativeAttributes,
  ParseTokenUsage,
  tokenUsage,
  toolInputReady,
  slimToolInput,
  toolResultText,
  firstLogLine,
  looksLikeSource,
  summarizeToolResult,
  clipToolMsg,
  firstNonEmpty,
  summarizeToolCall,
};
