"use strict";

/**
 * @file internal/runtime/protocol.js
 * @description 对应 Go 源文件 `internal/runtime/protocol.go`。
 * 负责将不同执行器（Claude/CodeBuddy stream-json、Codex JSONL、通用 Agent CLI 转换流及通用 JSON）
 * 的进程标准输出解析并归一化为平台统一的可观测遥测事件（`TelemetryEvent`）。
 *
 * Go -> JS 语法与结构差异说明：
 * - 单线程 JS 略去 `sync.Mutex`；`done chan struct{}` 与 `sync.Once` 使用 `Promise` 加幂等状态标记表达。
 * - `ObservabilitySpec` 函数与领域类型 `domain.ObservabilitySpec` 同名，导入类型局部命名为 `DomainObservabilitySpec` 以避免冲突。
 * - 与 `provider.js`、`protocol_tools.js` 存在同包循环引用，按规范在函数内使用延迟 `require`。
 */

const { TelemetryEvent } = require("../domain/run.js");
const {
  ObservabilitySpec: DomainObservabilitySpec,
  ObservabilitySpecVersion,
  AdapterDescriptor,
  TelemetrySource,
  ToolObservation,
  ModelObservation,
  MetricPoint,
  ErrorObservation,
} = require("../domain/observability.js");
const { AgentCLIKinds } = require("./agent_cli.js");
const { NewAgentCLITranslator } = require("./agent_cli_stream.js");

/**
 * 记录一次工具调用在流式增量传输过程中的元数据与 JSON 参数片段缓冲。
 * 对应 Go `toolUseBuf`。
 */
class toolUseBuf {
  /**
   * 构造工具调用缓冲对象。
   *
   * @param {object} [init={}] - 初始化字段。
   * @param {string} [init.id=""] - 工具调用唯一标识。
   * @param {string} [init.name=""] - 工具名称。
   * @param {string} [init.sessionID=""] - 所属会话 ID。
   * @param {string} [init.parentID=""] - 父级工具调用 ID。
   * @param {string} [init.json=""] - 累积的工具输入 JSON 片段。
   * @param {boolean} [init.emitted=false] - 是否已发送过 `tool.call` 开始事件。
   */
  constructor(init = {}) {
    this.id = init.id ?? "";
    this.name = init.name ?? "";
    this.sessionID = init.sessionID ?? "";
    this.parentID = init.parentID ?? "";
    this.json = init.json ?? "";
    this.emitted = init.emitted ?? false;
  }
}

/** 协议解析器类型常量：通用 JSON 行解析。 */
const protocolGeneric = 0;
/** 协议解析器类型常量：Anthropic/Claude stream-json 解析。 */
const protocolAnthropic = 1;
/** 协议解析器类型常量：Codex JSONL 解析。 */
const protocolCodex = 2;
/** 协议解析器类型常量：先经 `NewAgentCLITranslator` 改写为 Claude stream-json 再解析。 */
const protocolTranslated = 3;

/**
 * 协议适配器：维护单次执行过程中的解析状态、推理缓冲、工具调用表与终态结果。
 * 对应 Go `protocolAdapter`（单线程 JS 略去 `mu`）。
 */
class protocolAdapter {
  /**
   * 构造协议适配器实例。
   *
   * @param {object} [init={}] - 初始化字段。
   * @param {object | null} [init.ex=null] - 执行器定义（`domain.ExecutorDefinition`）。
   * @param {((event: TelemetryEvent) => void) | null} [init.sink=null] - 下游遥测事件接收回调。
   * @param {number} [init.parser=0] - 协议解析器类型常量。
   * @param {string} [init.adapterID=""] - 适配器标识（如 `anthropic-stream-v1`）。
   */
  constructor(init = {}) {
    this.ex = init.ex ?? {};
    this.sink = init.sink ?? null;
    this.parser = init.parser ?? protocolGeneric;
    this.adapterID = init.adapterID ?? "";
    this.result = init.result ?? "";
    this.lastOutput = init.lastOutput ?? "";
    this.failed = init.failed ?? false;
    this.reasoningBuf = init.reasoningBuf ?? "";
    this._doneClosed = false;
    this._resolveDone = null;
    this.done = new Promise((resolve) => {
      this._resolveDone = resolve;
    });
    this.tools = init.tools ?? {};
    this.currentToolID = init.currentToolID ?? "";
    this.translate = init.translate ?? null;
  }

  /**
   * 返回在收到终态结果帧后兑现的 Promise，对应 Go `Completed() <-chan struct{}`。
   *
   * @returns {Promise<void>} 适配器完成信号。
   */
  Completed() {
    return this.done;
  }

  /**
   * 非阻塞检查适配器是否已收到终态结果帧。
   *
   * @returns {boolean} 已完成返回 `true`，否则返回 `false`。
   */
  Finished() {
    return this._doneClosed;
  }

  /**
   * 返回终态结果帧是否标记为失败。
   *
   * @returns {boolean} 失败返回 `true`，否则返回 `false`。
   */
  Failed() {
    return this.failed;
  }

  /**
   * 返回终态结果帧携带的结果文本。
   *
   * @returns {string} 终态结果文本。
   */
  Result() {
    return this.result;
  }

  /**
   * 返回适合展示在节点检查器中的可见输出文本。
   * 优先返回终态结果帧文本；若缺失则回退到最近一条助手输出，避免裸露原始 stream-json 封包。
   *
   * @returns {string} 可见输出文本。
   */
  VisibleOutput() {
    if (this.result.trim() !== "") {
      return this.result;
    }
    return this.lastOutput;
  }

  /**
   * 记录最近一条非空助手输出文本，供缺少终态结果帧时回退展示。
   *
   * @param {string} text - 助手输出文本。
   * @returns {void} 无返回值。
   */
  noteOutput(text) {
    text = text.trim();
    if (text === "") {
      return;
    }
    this.lastOutput = text;
  }

  /**
   * 补齐可观测规范版本、来源信息、指标与工具/模型观测对象后，向事件接收器发射遥测事件。
   *
   * @param {TelemetryEvent} event - 待发射的遥测事件。
   * @returns {void} 无返回值。
   */
  emit(event) {
    if (event.Provider === "") {
      event.Provider = this.ex.Kind;
    }
    if (event.Model === "") {
      event.Model = this.ex.Model;
    }
    event.SpecVersion = ObservabilitySpecVersion;
    event.Source = new TelemetrySource({
      Layer: "executor",
      Adapter: this.adapterID,
      Provider: event.Provider,
      Protocol: this.ex.Protocol,
    });
    event.Context.SessionID = event.SessionID;
    if (event.Usage !== null) {
      event.Metrics = usageMetrics(event.Usage);
    }
    if (event.Category === "tool" && event.Tool === null) {
      event.Tool = new ToolObservation({
        Name: event.Message,
        Operation: event.Name,
        CallID: event.ToolCallID,
      });
    }
    if (event.Category === "model") {
      event.ModelOperation = new ModelObservation({
        Provider: event.Provider,
        Model: event.Model,
        Operation: event.Name,
      });
    }
    if (this.sink != null) {
      this.sink(event);
    }
  }

  /**
   * 处理单条原始进程遥测事件，对符合协议的标准输出行进行 JSON 解析与归一化分发。
   *
   * @param {TelemetryEvent} event - 来自子进程的原始遥测事件。
   * @returns {void} 无返回值。
   */
  Handle(event) {
    if (event.Name !== "process.stdout" || (this.ex.Protocol !== "stream-json" && this.ex.Protocol !== "jsonl")) {
      this.emit(event);
      return;
    }
    if (this.parser === protocolTranslated) {
      if (this.translate === null) {
        this.translate = NewAgentCLITranslator(this.ex.Kind);
      }
      for (const line of this.translate(event.Message)) {
        try {
          const raw = JSON.parse(line);
          if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
            this.handleClaudeStream(raw);
          }
        } catch (_) {
          // 忽略非合法 JSON 的转换行。
        }
      }
      return;
    }
    let raw;
    try {
      raw = JSON.parse(event.Message);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        this.emit(event);
        return;
      }
    } catch (_) {
      this.emit(event);
      return;
    }
    switch (this.parser) {
      case protocolAnthropic:
        this.handleClaudeStream(raw);
        break;
      case protocolCodex:
        this.handleCodexJSON(raw);
        break;
      default:
        this.handleGenericJSON(raw);
        break;
    }
  }

  /**
   * 解析并分发单帧 Claude/Anthropic stream-json 事件对象。
   *
   * @param {Record<string, any>} raw - 解析后的 JSON 对象。
   * @returns {void} 无返回值。
   */
  handleClaudeStream(raw) {
    // 延迟 require 打破与 protocol_tools.js 的同包循环依赖，同时确保原型工具方法已挂载。
    const { tokenUsage, summarizeToolResult } = require("./protocol_tools.js");
    const typ = stringValue(raw["type"]);
    const sessionID = stringValue(raw["session_id"]);
    switch (typ) {
      case "system":
        if (stringValue(raw["subtype"]) !== "init") {
          return;
        }
        this.emit(
          new TelemetryEvent({
            Category: "lifecycle",
            Name: "agent.initialized",
            Phase: "start",
            Message: "agent session initialized",
            Model: stringValue(raw["model"]),
            SessionID: sessionID,
            Attributes: { permissionMode: raw["permissionMode"] },
          })
        );
        break;
      case "stream_event": {
        const inner = raw["event"] && typeof raw["event"] === "object" && !Array.isArray(raw["event"]) ? raw["event"] : {};
        this.handleAnthropicEvent(inner, sessionID, stringValue(raw["parent_tool_use_id"]));
        break;
      }
      case "assistant": {
        const message = raw["message"] && typeof raw["message"] === "object" && !Array.isArray(raw["message"]) ? raw["message"] : {};
        const parts = [];
        for (const block of sliceValue(message["content"])) {
          const content = block && typeof block === "object" && !Array.isArray(block) ? block : {};
          switch (stringValue(content["type"])) {
            case "text": {
              const text = stringValue(content["text"]);
              if (text !== "") {
                parts.push(text);
                this.emit(
                  new TelemetryEvent({
                    Category: "output",
                    Name: "agent.output",
                    Phase: "progress",
                    Message: text,
                    Model: stringValue(message["model"]),
                    SessionID: sessionID,
                  })
                );
              }
              break;
            }
            case "tool_use":
              this.emitToolStart(stringValue(content["id"]), stringValue(content["name"]), sessionID, "", content["input"]);
              break;
          }
        }
        if (parts.length > 0) {
          this.noteOutput(parts.join("\n"));
        }
        break;
      }
      case "user": {
        const message = raw["message"] && typeof raw["message"] === "object" && !Array.isArray(raw["message"]) ? raw["message"] : {};
        for (const value of sliceValue(message["content"])) {
          const content = value && typeof value === "object" && !Array.isArray(value) ? value : {};
          if (stringValue(content["type"]) !== "tool_result") {
            continue;
          }
          const failed = content["is_error"] === true;
          const success = !failed;
          const id = stringValue(content["tool_use_id"]);
          const name = this.toolName(id);
          const msg = summarizeToolResult(name, failed, content["content"]);
          this.emit(
            new TelemetryEvent({
              Category: "tool",
              Name: "tool.call",
              Phase: "finish",
              Level: failed ? "error" : "info",
              Message: msg,
              SessionID: sessionID,
              ToolCallID: id,
              Tool: new ToolObservation({
                Name: name,
                Operation: "tool.result",
                CallID: id,
                Success: success,
              }),
            })
          );
        }
        break;
      }
      case "result": {
        const result = stringValue(raw["result"]);
        const failed = raw["is_error"] === true;
        this.result = result;
        this.failed = failed;
        if (!this._doneClosed) {
          this._doneClosed = true;
          if (this._resolveDone !== null) {
            this._resolveDone();
          }
        }
        const usage = tokenUsage(raw["usage"]);
        usage.CostUSD = float64Value(raw["total_cost_usd"]);
        // 适配器显式上报成本时标记 reported，用于区分"真实零成本"与"成本未识别"。
        if (Object.prototype.hasOwnProperty.call(raw, "total_cost_usd")) {
          usage.CostStatus = "reported";
        }
        this.emit(
          new TelemetryEvent({
            Category: "usage",
            Name: "usage.final",
            Phase: "finish",
            Message: "final model usage",
            SessionID: sessionID,
            Usage: usage,
            Attributes: {
              durationMs: raw["duration_ms"],
              turns: raw["num_turns"],
              isError: raw["is_error"],
            },
          })
        );
        this.emit(
          new TelemetryEvent({
            Category: "lifecycle",
            Name: "agent.completed",
            Phase: "finish",
            Message: result,
            SessionID: sessionID,
          })
        );
        break;
      }
      default:
        // 文件快照及厂商内部维护事件不暴露到可移植视图中。
        break;
    }
  }

  /**
   * 处理 Anthropic `stream_event` 内层事件（消息起止、内容块增量、思考文本与工具入参累积、用量更新）。
   *
   * @param {Record<string, any>} event - 内层事件对象。
   * @param {string} sessionID - 会话 ID。
   * @param {string} parentID - 父级工具调用 ID。
   * @returns {void} 无返回值。
   */
  handleAnthropicEvent(event, sessionID, parentID) {
    // 延迟 require 打破与 protocol_tools.js 的同包循环依赖。
    const { tokenUsage, toolInputReady } = require("./protocol_tools.js");
    const typ = stringValue(event["type"]);
    switch (typ) {
      case "message_start": {
        const message = event["message"] && typeof event["message"] === "object" && !Array.isArray(event["message"]) ? event["message"] : {};
        this.emit(
          new TelemetryEvent({
            Category: "model",
            Name: "model.request",
            Phase: "start",
            Message: "model generation started",
            Model: stringValue(message["model"]),
            SessionID: sessionID,
            ParentID: parentID,
          })
        );
        break;
      }
      case "content_block_start": {
        const block = event["content_block"] && typeof event["content_block"] === "object" && !Array.isArray(event["content_block"]) ? event["content_block"] : {};
        if (stringValue(block["type"]) === "tool_use") {
          const id = stringValue(block["id"]);
          const name = stringValue(block["name"]);
          this.beginToolUse(id, name, sessionID, parentID);
          if (toolInputReady(block["input"])) {
            this.emitToolStart(id, name, sessionID, parentID, block["input"]);
          }
        } else {
          this.currentToolID = "";
        }
        break;
      }
      case "content_block_delta": {
        const delta = event["delta"] && typeof event["delta"] === "object" && !Array.isArray(event["delta"]) ? event["delta"] : {};
        switch (stringValue(delta["type"])) {
          case "thinking_delta":
            this.reasoningBuf += stringValue(delta["thinking"]);
            break;
          case "input_json_delta":
            this.appendToolJSON(stringValue(delta["partial_json"]));
            // 仅在内存中累积，待 content_block_stop 时一次性发射。
            break;
        }
        break;
      }
      case "content_block_stop":
        this.flushCurrentTool();
        break;
      case "message_stop": {
        const reasoning = this.reasoningBuf;
        if (reasoning !== "") {
          this.emit(
            new TelemetryEvent({
              Category: "reasoning",
              Name: "agent.reasoning",
              Phase: "progress",
              Message: reasoning,
              SessionID: sessionID,
              ParentID: parentID,
            })
          );
          this.reasoningBuf = "";
        }
        this.emit(
          new TelemetryEvent({
            Category: "model",
            Name: "model.request",
            Phase: "finish",
            Message: "model generation finished",
            SessionID: sessionID,
            ParentID: parentID,
          })
        );
        break;
      }
      case "message_delta": {
        const usage = tokenUsage(event["usage"]);
        if (usage.InputTokens + usage.OutputTokens + usage.CacheReadTokens + usage.CacheWriteTokens > 0) {
          this.emit(
            new TelemetryEvent({
              Category: "usage",
              Name: "usage.update",
              Phase: "progress",
              SessionID: sessionID,
              ParentID: parentID,
              Usage: usage,
            })
          );
        }
        break;
      }
    }
  }

  /**
   * 解析并分发单帧 Codex JSONL 事件对象。
   *
   * @param {Record<string, any>} raw - 解析后的 JSON 对象。
   * @returns {void} 无返回值。
   */
  handleCodexJSON(raw) {
    // 延迟 require 打破与 protocol_tools.js 的同包循环依赖。
    const { tokenUsage, summarizeToolCall, summarizeToolResult, firstNonEmpty } = require("./protocol_tools.js");
    const typ = stringValue(raw["type"]);
    let session = stringValue(raw["thread_id"]);
    if (session === "") {
      session = stringValue(raw["threadId"]);
    }
    switch (typ) {
      case "thread.started":
        this.emit(
          new TelemetryEvent({
            Category: "lifecycle",
            Name: "agent.initialized",
            Phase: "start",
            Message: "codex thread initialized",
            SessionID: session,
          })
        );
        break;
      case "turn.started":
        this.emit(
          new TelemetryEvent({
            Category: "model",
            Name: "model.request",
            Phase: "start",
            Message: "model generation started",
            SessionID: session,
          })
        );
        break;
      case "turn.completed": {
        const usage = tokenUsage(raw["usage"]);
        this.emit(
          new TelemetryEvent({
            Category: "usage",
            Name: "usage.final",
            Phase: "finish",
            Message: "final model usage",
            SessionID: session,
            Usage: usage,
          })
        );
        this.emit(
          new TelemetryEvent({
            Category: "model",
            Name: "model.request",
            Phase: "finish",
            Message: "model generation finished",
            SessionID: session,
          })
        );
        break;
      }
      case "turn.failed": {
        let message = stringValue(raw["message"]);
        if (message === "") {
          message = "codex turn failed";
        }
        this.emit(
          new TelemetryEvent({
            Category: "error",
            Name: "model.error",
            Phase: "finish",
            Level: "error",
            Message: message,
            SessionID: session,
            Error: new ErrorObservation({ Type: "provider", Message: message }),
          })
        );
        break;
      }
      case "item.started":
      case "item.completed":
      case "item.updated": {
        const item = raw["item"] && typeof raw["item"] === "object" && !Array.isArray(raw["item"]) ? raw["item"] : {};
        const itemType = stringValue(item["type"]);
        let phase = "progress";
        if (typ === "item.started") {
          phase = "start";
        } else if (typ === "item.completed") {
          phase = "finish";
        }
        const id = stringValue(item["id"]);
        switch (itemType) {
          case "command_execution":
          case "mcp_tool_call":
          case "tool_call": {
            let name = stringValue(item["command"]);
            if (name === "") {
              name = stringValue(item["name"]);
            }
            let msg = summarizeToolCall(name, item);
            const success = int64Value(item["exit_code"]) === 0 && stringValue(item["status"]) !== "failed";
            if (phase === "finish") {
              const out = firstNonEmpty(
                stringValue(item["aggregated_output"]),
                stringValue(item["output"]),
                stringValue(item["text"])
              );
              msg = summarizeToolResult(name, !success, out);
            }
            const e = new TelemetryEvent({
              Category: "tool",
              Name: "tool.call",
              Phase: phase,
              Message: msg,
              SessionID: session,
              ToolCallID: id,
              Attributes: { status: item["status"], exitCode: item["exit_code"] },
            });
            if (phase === "finish") {
              e.Tool = new ToolObservation({
                Name: name,
                Operation: itemType,
                CallID: id,
                Success: success,
              });
            }
            this.emit(e);
            break;
          }
          case "agent_message": {
            const text = stringValue(item["text"]);
            if (text.trim() !== "") {
              this.noteOutput(text);
            }
            this.emit(
              new TelemetryEvent({
                Category: "output",
                Name: "agent.output",
                Phase: phase,
                Message: stringValue(item["text"]),
                SessionID: session,
              })
            );
            break;
          }
          case "reasoning":
            this.emit(
              new TelemetryEvent({
                Category: "reasoning",
                Name: "agent.reasoning",
                Phase: phase,
                Message: stringValue(item["text"]),
                SessionID: session,
              })
            );
            break;
        }
        break;
      }
      default:
        this.handleGenericJSON(raw);
        break;
    }
  }

  /**
   * 按通用规则解析未知或自定义执行器的 JSON 事件并映射为可观测类别。
   *
   * @param {Record<string, any>} raw - 解析后的 JSON 对象。
   * @returns {void} 无返回值。
   */
  handleGenericJSON(raw) {
    // 延迟 require 打破与 protocol_tools.js 的同包循环依赖。
    const { safeNativeAttributes, tokenUsage } = require("./protocol_tools.js");
    const typ = stringValue(raw["type"]);
    let message = stringValue(raw["message"]);
    if (message === "") {
      message = stringValue(raw["text"]);
    }
    let category = "lifecycle";
    if (typ.includes("tool")) {
      category = "tool";
    } else if (typ.includes("reason") || typ.includes("thought")) {
      category = "reasoning";
    } else if (typ.includes("usage")) {
      category = "usage";
    }
    let phase = stringValue(raw["phase"]);
    if (phase === "") {
      phase = "progress";
    }
    const event = new TelemetryEvent({
      Category: category,
      Name: typ,
      Phase: phase,
      Message: message,
      SessionID: stringValue(raw["session_id"]),
      ToolCallID: stringValue(raw["tool_call_id"]),
      Attributes: safeNativeAttributes(raw),
    });
    if (category === "usage") {
      let usage = tokenUsage(raw["usage"]);
      if (usage.TotalTokens === 0) {
        usage = tokenUsage(raw);
      }
      event.Usage = usage;
    }
    this.emit(event);
  }
}

/**
 * 远程执行 Agent CLI 的协议观察器：不持有子进程，仅将远程进程输出归一化为与本地 `ExecutorRunner.Run` 一致的遥测事件。
 * `VisibleOutput` 暴露终态结果文本或最新助手文本，便于 Runner 存储人类可读输出而非原始 stream-json。
 */
class ProtocolObserver {
  /**
   * 构造协议观察器。
   *
   * @param {object} [init={}] - 初始化字段。
   * @param {protocolAdapter | null} [init.adapter=null] - 内部协议适配器实例。
   */
  constructor(init = {}) {
    this.adapter = init.adapter ?? null;
  }

  /**
   * 将远程进程事件交由内部协议适配器解析。
   *
   * @param {TelemetryEvent} event - 原始遥测事件。
   * @returns {void} 无返回值。
   */
  Handle(event) {
    if (this.adapter === null) {
      return;
    }
    this.adapter.Handle(event);
  }

  /**
   * 返回当前可展示的输出文本（终态结果优先，其次为最近一条助手输出）。
   *
   * @returns {string} 可见输出文本。
   */
  VisibleOutput() {
    if (this.adapter === null) {
      return "";
    }
    return this.adapter.VisibleOutput();
  }

  /**
   * 为不带终态结果帧的远程协议（如 Codex JSONL）补发 `agent.completed` 终态生命周期事件。
   * 已发射过终态事件的执行器保持不变。
   *
   * @param {boolean} success - 进程退出是否成功。
   * @returns {void} 无返回值。
   */
  Finalize(success) {
    if (this.adapter === null || this.adapter.Finished()) {
      return;
    }
    let level = "error";
    let message = "executor exited without terminal result";
    if (success) {
      level = "warn";
      message = "executor exited without terminal result; deferring to gate verification";
    }
    this.adapter.emit(
      new TelemetryEvent({
        Category: "lifecycle",
        Name: "agent.completed",
        Phase: "finish",
        Level: level,
        Message: message,
      })
    );
  }
}

/**
 * 为指定执行器创建协议观察器实例。
 *
 * @param {object} ex - 执行器定义（`domain.ExecutorDefinition`）。
 * @param {((event: TelemetryEvent) => void) | null} sink - 遥测事件接收回调。
 * @returns {ProtocolObserver} 新建的协议观察器。
 */
function NewProtocolObserver(ex, sink) {
  return new ProtocolObserver({ adapter: newProtocolAdapter(ex, sink) });
}

/**
 * 按执行器类型查找对应 Provider 并构造协议适配器。
 *
 * @param {object} ex - 执行器定义（`domain.ExecutorDefinition`）。
 * @param {((event: TelemetryEvent) => void) | null} sink - 遥测事件接收回调。
 * @returns {protocolAdapter} 对应的协议适配器实例。
 */
function newProtocolAdapter(ex, sink) {
  // 延迟 require 打破与 provider.js 的同包循环依赖。
  const { providerForKind } = require("./provider.js");
  return providerForKind(ex.Kind).Protocol(ex, sink);
}

/**
 * 使用指定解析器类型与适配器 ID 创建协议适配器，并确保工具调用扩展方法已挂载。
 *
 * @param {object} ex - 执行器定义（`domain.ExecutorDefinition`）。
 * @param {((event: TelemetryEvent) => void) | null} sink - 遥测事件接收回调。
 * @param {number} parser - 协议解析器类型常量。
 * @param {string} adapterID - 适配器标识。
 * @returns {protocolAdapter} 新建的协议适配器实例。
 */
function makeProtocolAdapter(ex, sink, parser, adapterID) {
  // 确保 protocol_tools.js 中挂载在 protocolAdapter.prototype 上的方法可用。
  require("./protocol_tools.js");
  return new protocolAdapter({ ex, sink, parser, adapterID });
}

/**
 * 返回运行时支持的可观测规范元数据，包含类别、阶段、必填上下文、指标约定及已注册适配器列表。
 *
 * @returns {DomainObservabilitySpec} 平台可观测规范对象。
 */
function ObservabilitySpec() {
  return new DomainObservabilitySpec({
    Version: ObservabilitySpecVersion,
    Categories: [
      "lifecycle",
      "model",
      "reasoning",
      "output",
      "tool",
      "usage",
      "process",
      "verification",
      "artifact",
      "delivery",
      "sandbox",
      "error",
    ],
    Phases: ["start", "progress", "finish"],
    RequiredContext: ["runId", "traceId"],
    MetricConventions: { tokens: "count", cost: "USD", duration: "ms", calls: "count" },
    Adapters: [
      new AdapterDescriptor({
        ID: "anthropic-stream-v1",
        SpecVersion: ObservabilitySpecVersion,
        ExecutorKinds: ["claude-code", "codebuddy"],
        NativeProtocols: ["stream-json"],
        Capabilities: [
          "session",
          "model",
          "reasoning",
          "output-delta",
          "tool-lifecycle",
          "token-usage",
          "cache-usage",
          "cost",
          "duration",
        ],
        RawEventPolicy: "discard-after-normalization",
      }),
      new AdapterDescriptor({
        ID: "codex-jsonl-v1",
        SpecVersion: ObservabilitySpecVersion,
        ExecutorKinds: ["codex"],
        NativeProtocols: ["jsonl"],
        Capabilities: ["session", "reasoning", "output", "tool-lifecycle", "token-usage", "cache-usage"],
        RawEventPolicy: "discard-after-normalization",
      }),
      new AdapterDescriptor({
        ID: "agent-cli-stream-v1",
        SpecVersion: ObservabilitySpecVersion,
        ExecutorKinds: [...AgentCLIKinds],
        NativeProtocols: ["stream-json", "jsonl"],
        Capabilities: ["session", "reasoning", "output", "tool-lifecycle", "token-usage", "cache-usage"],
        RawEventPolicy: "discard-after-normalization",
      }),
      new AdapterDescriptor({
        ID: "generic-json-v1",
        SpecVersion: ObservabilitySpecVersion,
        ExecutorKinds: ["custom"],
        NativeProtocols: ["jsonl", "stream-json"],
        Capabilities: ["lifecycle", "message", "extensible-metrics"],
        RawEventPolicy: "sanitized-attributes-only",
      }),
    ],
  });
}

/**
 * 将 `TokenUsage` 中非零的令牌与费用字段转换为标准计数器指标点数组。
 *
 * @param {object} usage - 令牌用量对象（`domain.TokenUsage`）。
 * @returns {MetricPoint[]} 非零指标点数组。
 */
function usageMetrics(usage) {
  const values = [
    { name: "tokens.input", value: usage.InputTokens, unit: "count" },
    { name: "tokens.output", value: usage.OutputTokens, unit: "count" },
    { name: "tokens.cache_read", value: usage.CacheReadTokens, unit: "count" },
    { name: "tokens.cache_write", value: usage.CacheWriteTokens, unit: "count" },
    { name: "tokens.reasoning", value: usage.ReasoningTokens, unit: "count" },
    { name: "cost", value: usage.CostUSD, unit: "USD" },
  ];
  const out = [];
  for (const v of values) {
    if (v.value !== 0) {
      out.push(new MetricPoint({ Name: v.name, Value: v.value, Unit: v.unit, Kind: "counter" }));
    }
  }
  return out;
}

/**
 * 安全提取字符串值；非字符串时返回空字符串。
 *
 * @param {any} value - 待提取的任意值。
 * @returns {string} 提取出的字符串或空字符串。
 */
function stringValue(value) {
  return typeof value === "string" ? value : "";
}

/**
 * 安全提取数组值；非数组时返回空数组（对应 Go `nil` 切片可安全遍历）。
 *
 * @param {any} value - 待提取的任意值。
 * @returns {any[]} 提取出的数组或空数组。
 */
function sliceValue(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 安全提取 64 位整数值；支持数字与数字字符串，无法解析时返回 `0`。
 *
 * @param {any} value - 待提取的任意值。
 * @returns {number} 截断为整数后的数值或 `0`。
 */
function int64Value(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return 0;
}

/**
 * 安全提取浮点数值；非数字时返回 `0`。
 *
 * @param {any} value - 待提取的任意值。
 * @returns {number} 提取出的浮点数或 `0`。
 */
function float64Value(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

module.exports = {
  toolUseBuf,
  protocolGeneric,
  protocolAnthropic,
  protocolCodex,
  protocolTranslated,
  protocolAdapter,
  ProtocolObserver,
  NewProtocolObserver,
  newProtocolAdapter,
  makeProtocolAdapter,
  ObservabilitySpec,
  usageMetrics,
  stringValue,
  sliceValue,
  int64Value,
  float64Value,
};
