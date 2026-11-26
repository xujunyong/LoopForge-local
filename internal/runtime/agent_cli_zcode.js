// agent_cli_zcode.js —— 对应 Go 文件：internal/runtime/agent_cli_zcode.go
// 作用：ZCode 凭据绑定、密钥文件清理钩子与流式输出翻译。

"use strict";

const { ValidateAgentEffort } = require("../domain/agent.js"); // 对应 Go 的 domain.ValidateAgentEffort，domain 已翻译
const { stringValue, int64Value, contentText } = require("./protocol.js"); // 对应 Go 同包函数，protocol.js 待翻译
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

// zcodeMCPServer：为 ZCode 渲染一条 MCP 条目；未知或 null 字段会导致服务器被丢弃，故只复制非空字段。
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

// applyZCodeCredential：把密钥以个人 provider 文件交给 ZCode，该文件只在 ZCode 读取前存在：ZCode 只接受字面密钥，且密钥不得留在磁盘上。
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

// addZCodeKeyCleanupHook：把 SessionStart 钩子合并进 ZCode 配置，保留 MCP 配置已写入的内容。
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

// zcodeStream：`zcode --output-format stream-json` 每行打印一个会话事件；文本与推理以增量到达，由不带文本的 _end 事件收尾。
class zcodeStream {
  constructor() {
    this.started = false;
    this.text = "";
    this.reasoning = "";
  }

  translate(s, raw) {
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
