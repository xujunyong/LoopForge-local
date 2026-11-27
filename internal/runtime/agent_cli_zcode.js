/**
 * @file internal/runtime/agent_cli_zcode.js
 * @description 对应 Go 源文件：internal/runtime/agent_cli_zcode.go
 *
 * 职责与边界：
 * 负责 ZCode Agent CLI 的专属配置常量、MCP 条目渲染、一次性密钥文件凭据绑定、
 * `SessionStart` 密钥清理钩子合并，以及 `zcode --output-format stream-json` 流式事件翻译。
 * 通用 Agent CLI 框架位于 `agent_cli.js`，流式输出框架位于 `agent_cli_stream.js`。
 *
 * 语法差异说明：
 * - 为避免与 `agent_cli.js` 和 `agent_cli_stream.js` 产生顶层循环依赖，对二者的引用均在函数内延迟 `require`。
 * - Go 的 `(值1, 值2, error)` 译为成功返回 `[值1, 值2]`、失败抛出 `Error`；仅 `error` 译为成功返回 `undefined`、失败抛出 `Error`。
 * - Go `reflect.ValueOf` 判空逻辑在 `nonEmpty` 中按 JS 类型等价实现。
 */

"use strict";

const { ValidateAgentEffort } = require("../domain/agent.js"); // 对应 Go 的 domain.ValidateAgentEffort，domain 已翻译
const { stringValue, int64Value } = require("./protocol.js"); // 对应 Go 同包函数，protocol.js 待翻译
const { newAgentCLISessionID } = require("./provider_agentcli.js"); // 对应 Go 同包函数，provider_agentcli.js 待翻译

const zcodeConfigPath = ".zcode/cli/config.json";
const zcodeProviderDir = ".zcode/v2";
const zcodePersonalFileEnv = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE";
// zcodeDefaultBaseURL：BigModel 的 Anthropic 兼容端点。
const zcodeDefaultBaseURL = "https://open.bigmodel.cn/api/anthropic";
const zcodeDefaultModel = "glm-5.3";
const zcodeRemoveKeyFile = `rm -f "$` + zcodePersonalFileEnv + `"`;

// zcodeSOPDisallowedTools：等待人工的工具。
const zcodeSOPDisallowedTools = "AskUserQuestion EnterPlanMode ExitPlanMode";
// zcodeChatDisallowedTools：再加对话 MCP 网关之外的操作：shell、编辑、web、子代理、后台任务与 JS REPL。
const zcodeChatDisallowedTools = zcodeSOPDisallowedTools + " Bash Edit Write WebFetch Agent SendMessage TaskOutput TaskStop mcp__node_repl__js";

// zcodeHostEnv：会重定向 ZCode provider 或数据的宿主设置；ZCode 把空值也当作已设置而报错，故包装器直接 unset。
const zcodeHostEnv = [
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", "ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE", "ZCODE_STORAGE_DIR", "ZCODE_SESSION_DB_PATH",
  "ZCODE_BASE_URL", "ZCODE_ENDPOINT_ORIGIN", "ZCODE_OFFICIAL_ENDPOINT", "ZCODE_OFFICIAL_ENDPOINT_TOKEN", "ZCODE_API_KEY", "ZCODE_MODEL",
];

// zcodeCleanupScript：用 "$@" 运行 CLI；ZCode 读取密钥文件后 hook 删除它，trap 覆盖提前退出的运行并删除 ZCode 重建的空文件。
const zcodeCleanupScript = "unset " + zcodeHostEnv.join(" ") + "; trap '" + zcodeRemoveKeyFile + "' EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; \"$@\"";

/**
 * 为 ZCode 渲染单条 MCP 服务器配置。
 * ZCode 遇到未知字段或 null 字段会丢弃该服务器，因此仅复制非空字段。
 *
 * @param {Object} entry - 通用 MCP 条目对象。
 * @returns {Object} 符合 ZCode 格式的 MCP 服务器对象。
 */
function zcodeMCPServer(entry) {
  const url = typeof entry["url"] === "string" ? entry["url"] : "";
  if (url !== "") {
    const server = { type: "http", url };
    if (nonEmpty(entry["headers"])) {
      server["headers"] = entry["headers"];
    }
    return server;
  }
  const server = { type: "stdio", command: entry["command"], timeoutMs: 600000, enabled: true };
  for (const key of ["args", "cwd", "env"]) {
    if (nonEmpty(entry[key])) {
      server[key] = entry[key];
    }
  }
  return server;
}

/**
 * 判断字段值是否非空（对应 Go `reflect.ValueOf` 判空逻辑）。
 * `null`/`undefined` 为空；字符串、数组、普通对象按长度或键数判断；其余原始类型视为非空。
 *
 * @param {*} value - 待检查字段值。
 * @returns {boolean} 非空返回 `true`，否则返回 `false`。
 */
function nonEmpty(value) {
  // Go reflect：nil 为空；切片、映射、字符串按长度；其余类型非空。
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string" || Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

/**
 * 为 ZCode 生成一次性个人 provider 配置文件、注册密钥清理钩子，并包装启动命令与环境变量。
 * 由 `ApplyAgentCLICredential` 在处理 ZCode 时调用。
 *
 * @param {Object} home - 宿主侧私有 HOME 描述对象（`AgentCLIHome`）。
 * @param {string} homeEnv - 子进程视角 HOME 路径。
 * @param {string} key - API 密钥。
 * @param {string} baseURL - 自定义网关地址（为空时使用 BigModel 默认端点）。
 * @param {string} protocol - 规范化后的协议标识。
 * @param {string} model - 指定模型名（默认端点下为空或 `"default"` 时回落到 `zcodeDefaultModel`）。
 * @param {string} effort - 推理强度等级。
 * @param {string[]} argv - 原始命令行参数数组。
 * @returns {[string[], Object<string, string>]} 二元组 `[包装后的 sh -c 启动参数, 环境变量映射]`；校验或写文件失败时抛出 `Error`。
 */
function applyZCodeCredential(home, homeEnv, key, baseURL, protocol, model, effort, argv) {
  // 私有 provider 自身没有模型，"CLI 默认"（以 "default" 传入）必须指明一个真实模型：默认端点用 BigModel 的编码模型，自定义端点则无从猜测。
  const { AgentCLILabel, AgentCLIProtocolChat, AgentCLIProtocolResponses, AgentCLIProtocolMessages, AgentCLIZCode, writeAgentCLIFile } = require("./agent_cli.js"); // 循环引用：调用时现取
  if (model === "" || model === "default") {
    if (baseURL !== "") {
      throw new Error(`${AgentCLILabel(AgentCLIZCode)} 需要指定模型`);
    }
    model = zcodeDefaultModel;
  }
  let apiType = { [AgentCLIProtocolChat]: "openai-chat-completions", [AgentCLIProtocolResponses]: "openai-responses", [AgentCLIProtocolMessages]: "anthropic-messages" }[protocol];
  if (baseURL === "") {
    baseURL = zcodeDefaultBaseURL;
    apiType = "anthropic-messages";
  }
  const modelRules = [];
  if (effort !== "") {
    ValidateAgentEffort(effort, AgentCLIZCode);
    // 续跑会话保持原选择；覆盖模型的单次调用映射，让本轮使用所选强度，删除规则即恢复该会话的原生默认。
    const wire = {};
    switch (apiType) {
      case "anthropic-messages":
        wire["thinking"] = { type: "enabled" };
        wire["output_config"] = { effort };
        break;
      case "openai-chat-completions":
        wire["thinking"] = { type: "enabled" };
        wire["reasoning_effort"] = effort;
        wire["reasoning"] = { effort };
        break;
      case "openai-responses":
        wire["reasoning"] = { effort };
        break;
    }
    const mapping = JSON.stringify(wire);
    modelRules.push({
      providerId: "agentflow", modelId: model,
      config: { optionSpecs: { reasoningLevel: { map: mapping } } },
    });
  }
  const providerConfig = JSON.stringify({ schemaVersion: 1, config: {
    providerConfigRules: { providerRules: [{ providerId: "agentflow", config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: key },
      api: { type: apiType, baseUrl: baseURL },
      personalModelIds: [model],
    } }] },
    modelConfigRules: { providerModelRules: modelRules, manualProviderModelRules: [] },
    defaultModelSelection: { providerId: "agentflow", modelId: model },
  } }, null, 2);
  // 每次调用一个文件：同一 HOME 的并发调用不得删除彼此的密钥。
  const keyFile = zcodeProviderDir + "/provider_config." + newAgentCLISessionID() + ".json";
  writeAgentCLIFile(home, keyFile, providerConfig);
  addZCodeKeyCleanupHook(home);
  const env = {
    [zcodePersonalFileEnv]: homeEnv + "/" + keyFile,
    ZCODE_DATA_BASE_DIR: homeEnv,
    USERPROFILE: homeEnv,
  };
  return [["sh", "-c", zcodeCleanupScript, "zcode", ...argv], env];
}

/**
 * 将删除临时密钥文件的 `SessionStart` 钩子合并写入 ZCode 配置文件，同时保留已有 MCP 配置。
 * 由 `applyZCodeCredential` 在写出密钥文件后调用。
 *
 * @param {Object} home - 宿主侧私有 HOME 描述对象（`AgentCLIHome`）。
 * @returns {void} 成功无返回值；读取（非文件不存在错误）、解析或写文件失败时抛出 `Error`。
 */
function addZCodeKeyCleanupHook(home) {
  const { openAgentCLIHome, writeAgentCLIFile } = require("./agent_cli.js"); // 循环引用：调用时现取
  let document = {};
  const root = openAgentCLIHome(home);
  let data;
  let err = null;
  try {
    data = root.ReadFile(zcodeConfigPath);
  } catch (e) {
    err = e;
  }
  root.Close();
  if (err === null) {
    try {
      document = JSON.parse(data.toString());
    } catch (e) {
      err = e;
    }
  }
  if (err !== null && err.code !== "ENOENT") {
    throw err;
  }
  let hooks = document["hooks"];
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    hooks = {};
  }
  let events = hooks["events"];
  if (events === null || typeof events !== "object" || Array.isArray(events)) {
    events = {};
  }
  const sessionStart = Array.isArray(events["SessionStart"]) ? events["SessionStart"] : [];
  events["SessionStart"] = [...sessionStart, { hooks: [{ type: "command", command: zcodeRemoveKeyFile }] }];
  hooks["events"] = events;
  hooks["enabled"] = true;
  document["hooks"] = hooks;
  const out = JSON.stringify(document, null, 2);
  writeAgentCLIFile(home, zcodeConfigPath, out);
}

/**
 * ZCode CLI（`zcode --output-format stream-json`）输出流翻译器。
 * 文本与推理内容以增量形式到达，并由不携带文本的 `_end` 事件收尾。
 */
class zcodeStream {
  /**
   * 构造 zcodeStream 实例，字段按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.started = init.started ?? false;
    this.text = init.text ?? "";
    this.reasoning = init.reasoning ?? "";
  }

  /**
   * 将单条 ZCode JSON 事件翻译为 `ClaudeStream` 行数组。
   *
   * @param {Object} s - 目标 `ClaudeStream` 状态机。
   * @param {Object} raw - 解析后的原生 JSON 事件对象。
   * @returns {string[]} 翻译出的 stream-json 行数组。
   */
  translate(s, raw) {
    const { contentText } = require("./agent_cli_stream.js"); // 循环引用：调用时现取
    let out = [];
    if (!this.started) {
      const session = stringValue(raw["sessionId"]);
      if (session !== "") {
        this.started = true;
        out = s.Init(session, "");
      }
    }
    const payload = raw["payload"] ?? {};
    switch (stringValue(raw["type"])) {
      case "model.streaming": {
        const message = stringValue(payload["assistantMessageId"]);
        switch (stringValue(payload["kind"])) {
          case "text_delta": {
            const delta = stringValue(payload["delta"]);
            this.text += delta;
            out = [...out, ...s.Delta(message + "#text", "text", delta)];
            break;
          }
          case "text_end":
            out = [...out, ...s.Text(this.text)];
            this.text = "";
            break;
          case "reasoning_delta": {
            const delta = stringValue(payload["delta"]);
            this.reasoning += delta;
            out = [...out, ...s.Delta(message + "#thinking", "thinking", delta)];
            break;
          }
          case "reasoning_end":
            out = [...out, ...s.Thinking(this.reasoning)];
            this.reasoning = "";
            break;
          case "tool_call":
            out = [...out, ...s.ToolUse(stringValue(payload["toolCallId"]), stringValue(payload["toolName"]), payload["input"])];
            break;
        }
        break;
      }
      case "tool.updated":
        if (stringValue(payload["kind"]) === "result") {
          const result = payload["result"] ?? {};
          const success = result["success"] === true;
          out = [...out, ...s.ToolResult(stringValue(payload["toolCallId"]), !success, contentText(result["content"]))];
        }
        break;
      case "turn.failed": {
        const failure = payload["error"] ?? {};
        let message = stringValue(failure["message"]);
        if (message === "") {
          message = "ZCode 本轮执行失败";
        }
        // assistant_failure.go 靠该措辞识别被拒的密钥。
        const attribution = failure["attribution"] ?? {};
        if (int64Value(attribution["statusCode"]) === 401) {
          message += " (HTTP 401)";
        }
        out = [...out, ...s.Result(message, true)];
        break;
      }
      case "result": {
        const usage = raw["usage"] ?? {};
        s.SetUsage(int64Value(usage["inputTokens"]), int64Value(usage["outputTokens"]), int64Value(usage["cacheReadTokens"]), int64Value(usage["cacheWriteTokens"]), int64Value(usage["reasoningTokens"]));
        out = [...out, ...s.Result(stringValue(raw["response"]), false)];
        break;
      }
    }
    return out;
  }
}

module.exports = {
  zcodeConfigPath, zcodeProviderDir, zcodePersonalFileEnv, zcodeDefaultBaseURL, zcodeDefaultModel, zcodeRemoveKeyFile,
  zcodeSOPDisallowedTools, zcodeChatDisallowedTools, zcodeHostEnv, zcodeCleanupScript,
  zcodeMCPServer, nonEmpty, applyZCodeCredential, addZCodeKeyCleanupHook, zcodeStream,
};
