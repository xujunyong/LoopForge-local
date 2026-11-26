// agent_cli.js —— 对应 Go 文件：internal/runtime/agent_cli.go
// 作用：Agent CLI 的凭据绑定、MCP 配置渲染与私有 HOME 管理。

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { AgentCLIExecutorKinds, IsAgentCLIKind, NormalizeAgentCLIProtocol, ValidateAgentEffort } = require("../domain/agent.js"); // 对应 Go 的 domain，domain 已翻译
const domainUser = require("../domain/user.js"); // 对应 Go 的 domain，domain 已翻译
const { AutoUpdateEnvironment } = require("../managedcli/providers.js"); // 对应 Go 的 managedcli.AutoUpdateEnvironment，managedcli 已翻译
const { ensureRootDirectory } = require("./materialize.js"); // 对应 Go 同包函数，materialize.js 待翻译
const { runnerLoginSpec, prepareRunnerLogin } = require("./conversation_runner_login.js"); // 对应 Go 同包函数，conversation_runner_login.js 待翻译
const { CursorModelID } = require("./cursor_models.js"); // 对应 Go 同包函数，cursor_models.js 待翻译
const zcode = require("./agent_cli_zcode.js"); // 对应 Go 同包常量，agent_cli_zcode.js 待翻译；本文件加载时读取其常量，zcode 文件顶层不引用本文件，故无循环加载问题

// CodeBuddy / Codex / Claude Code 之外的 Agent CLI。
const AgentCLIOpenCode = "opencode";
const AgentCLICursor = "cursor";
const AgentCLIAntigravity = "agy";
const AgentCLIKimi = "kimi";
const AgentCLIPi = "pi";
const AgentCLIDeepSeek = "dsh";
const AgentCLIZCode = "zcode";

// AgentCLIKinds：Agent CLI 的展示顺序。
const AgentCLIKinds = AgentCLIExecutorKinds;

function IsAgentCLI(kind) { return IsAgentCLIKind(kind); }

const AgentCLIProtocolChat = domainUser.AgentCLIProtocolChat;
const AgentCLIProtocolResponses = domainUser.AgentCLIProtocolResponses;
const AgentCLIProtocolMessages = domainUser.AgentCLIProtocolMessages;
const AgentCLIProtocolGemini = domainUser.AgentCLIProtocolGemini;
const AgentCLIProtocolOptions = domainUser.AgentCLIProtocolOptions;

function AgentCLIProtocols(kind) { return AgentCLIProtocolOptions[kind]; }

// AgentCLIProtocol：规范化存储的协议选择，未知值回落到该 CLI 的默认值。
function AgentCLIProtocol(kind, protocol) {
  return NormalizeAgentCLIProtocol(kind, protocol);
}

// AgentCLINeedsBaseURL：凭据缺 Base URL 是否不可用。
function AgentCLINeedsBaseURL(kind, protocol) {
  switch (kind) {
    case AgentCLIOpenCode:
    case AgentCLIPi:
      return true;
    case AgentCLIAntigravity:
      return AgentCLIProtocol(kind, protocol) === AgentCLIProtocolChat;
  }
  return false;
}

// agentCLIModelOptional：执行器与对话均未指定模型时 CLI 是否自选模型。
function agentCLIModelOptional(kind, baseURL) {
  switch (kind) {
    case AgentCLICursor:
    case AgentCLIZCode:
      // ZCode 自行解析未设置的模型（applyZCodeCredential）。
      return true;
    case AgentCLIAntigravity:
    case AgentCLIDeepSeek:
      return baseURL === "";
  }
  return false;
}

// AgentCLIOptions：凭据绑定渲染 CLI 模型配置所需的单次调用事实。
class AgentCLIOptions {
  constructor(init = {}) {
    this.ApprovalCommand = init.ApprovalCommand ?? "";
    this.Model = init.Model ?? "";
    // Effort：为 Model 选择的推理强度。
    this.Effort = init.Effort ?? "";
    // SystemPromptFile：进程视角的系统提示路径。
    this.SystemPromptFile = init.SystemPromptFile ?? "";
    // ReadOnly：AgentCLICommandOptions.Chat。
    this.ReadOnly = init.ReadOnly ?? false;
    // ImageInput：为自定义 provider 启用多模态序列化。
    this.ImageInput = init.ImageInput ?? false;
  }
}

// agentCLIKeyEnv：以变量名而非密钥本身配置的 CLI 所用的用户密钥变量。
const agentCLIKeyEnv = "AGENTFLOW_CLI_API_KEY";
const kimiThinkingEffortEnv = "KIMI_MODEL_THINKING_EFFORT";

// agentCLIHostEnv：每个子进程都要清除的宿主环境变量。
const agentCLIHostEnv = [
  agentCLIKeyEnv, "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GEMINI_BASE_URL",
  "AGY_ADC_AUTH", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI", "GEMINI_HOME", "AGY_ACP_FORCE_FILE_STORAGE",
  "AGY_LLM_GATEWAY_URL", "AGY_LLM_GATEWAY_API_KEY", "AGY_LLM_GATEWAY_WIRE_PROTOCOL", "AGY_LLM_GATEWAY_MODELS",
  "DEEPSEEK_API_KEY", "DSH_HOME", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_BASE_URL", "KIMI_CODE_HOME",
  "KIMI_MODEL_NAME", "KIMI_MODEL_API_KEY", "KIMI_MODEL_BASE_URL", "KIMI_MODEL_PROVIDER_TYPE", kimiThinkingEffortEnv,
  "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "PI_CODING_AGENT_DIR",
  "ZCODE_DATA_BASE_DIR", zcode.zcodePersonalFileEnv,
  ...zcode.zcodeHostEnv,
];

// agentCLIMCPPaths：Agent CLI 读取 MCP 服务器的 HOME 相对文件。
const agentCLIMCPPaths = {
  [AgentCLIOpenCode]: ".config/opencode/opencode.json",
  [AgentCLICursor]: ".cursor/mcp.json",
  [AgentCLIAntigravity]: ".gemini/config/mcp_config.json",
  [AgentCLIKimi]: ".kimi-code/mcp.json",
  [AgentCLIPi]: ".pi/agent/mcp.json",
  [AgentCLIDeepSeek]: ".dsh/agentflow-mcp.json",
  [AgentCLIZCode]: zcode.zcodeConfigPath,
};

// AgentCLIMCPOptions：一次调用的 MCP 配置形态。
class AgentCLIMCPOptions {
  constructor(init = {}) {
    // ReadOnly：禁用 CLI 自身的 shell、编辑与 web 工具。
    this.ReadOnly = init.ReadOnly ?? false;
  }
}

const dshServerNameRe = /[^A-Za-z0-9_-]/g;

// WriteAgentCLIMCPConfig：按 CLI 自身格式把 MCP 条目渲染到 home 下，替换上次调用的残留。
function WriteAgentCLIMCPConfig(kind, home, entries, options) {
  const rel = agentCLIMCPPaths[kind];
  if (rel === undefined) {
    throw new Error(`unknown agent CLI ${JSON.stringify(kind)}`);
  }
  const ids = Object.keys(entries);
  ids.sort();
  const servers = {};
  let dshInserts = [];
  for (const id of ids) {
    const entry = entries[id];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const url = typeof entry["url"] === "string" ? entry["url"] : "";
    const command = typeof entry["command"] === "string" ? entry["command"] : "";
    const headers = entry["headers"];
    if (kind === AgentCLIOpenCode && (url !== "" || command !== "")) {
      servers[id] = openCodeMCPServer(entry);
    } else if (kind === AgentCLIZCode && (url !== "" || command !== "")) {
      servers[id] = zcode.zcodeMCPServer(entry);
    } else if (kind === AgentCLIDeepSeek && (url !== "" || command !== "")) {
      dshInserts = [...dshInserts, deepSeekMCPInsert(id, entry)];
    } else if (url !== "") {
      let key = "url";
      if (kind === AgentCLIAntigravity) {
        key = "serverUrl";
      }
      const server = { [key]: url };
      if (headers !== null && headers !== undefined) {
        server["headers"] = headers;
      }
      servers[id] = server;
    } else if (command !== "") {
      const server = { command };
      for (const key of ["args", "env", "cwd"]) {
        const value = entry[key];
        if (value !== null && value !== undefined && !(key === "cwd" && (kind === AgentCLICursor || kind === AgentCLIAntigravity))) {
          server[key] = value;
        }
      }
      servers[id] = server;
    }
    if (kind === AgentCLIKimi) {
      // Kimi 默认 60s 即放弃 MCP 调用；网关等待写审批最长 9 分钟。
      const server = servers[id];
      if (server !== null && typeof server === "object") {
        server["toolTimeoutMs"] = 600000;
      }
    }
  }
  let document;
  switch (kind) {
    case AgentCLIOpenCode: {
      let permission = { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow", doom_loop: "allow" };
      if (options.ReadOnly) {
        permission = { edit: "deny", bash: "deny", webfetch: "deny", websearch: "deny", external_directory: "deny", task: "deny" };
      }
      document = { $schema: "https://opencode.ai/config.json", mcp: servers, permission, autoupdate: false, share: "disabled" };
      break;
    }
    case AgentCLIDeepSeek:
      if (dshInserts.length === 0) {
        document = [];
      } else {
        document = [{ insert: dshInserts }];
      }
      break;
    case AgentCLIZCode:
      document = { features: { mcp: true }, mcp: { servers } };
      break;
    default:
      document = { mcpServers: servers };
      break;
  }
  const data = JSON.stringify(document, null, 2);
  if (kind === AgentCLICursor) {
    // --force 会批准这些规则未拒绝的一切。
    let deny = [];
    if (options.ReadOnly) {
      deny = ["Shell(**)", "Write(**)", "Delete(**)", "WebFetch(*)"];
    }
    const config = JSON.stringify({ version: 1, permissions: { allow: [], deny } });
    writeAgentCLIFile(home, ".cursor/cli-config.json", config);
  }
  writeAgentCLIFile(home, rel, data);
}

// openCodeMCPServer：为 OpenCode 渲染一条 MCP 条目。
function openCodeMCPServer(entry) {
  const url = typeof entry["url"] === "string" ? entry["url"] : "";
  if (url !== "") {
    const server = { type: "remote", url, enabled: true, timeout: 600000 };
    if (entry["headers"] !== null && entry["headers"] !== undefined) {
      server["headers"] = entry["headers"];
    }
    return server;
  }
  const command = typeof entry["command"] === "string" ? entry["command"] : "";
  const argv = [command];
  const args = entry["args"];
  if (Array.isArray(args) && args.every((arg) => typeof arg === "string")) {
    for (const arg of args) {
      argv.push(arg);
    }
  } else if (Array.isArray(args)) {
    argv.push(...args);
  }
  const server = { type: "local", command: argv, enabled: true, timeout: 600000 };
  if (entry["env"] !== null && entry["env"] !== undefined) {
    server["environment"] = entry["env"];
  }
  return server;
}

// deepSeekMCPInsert：把一条 MCP 条目渲染为 dsh-mcp-client 插件 insert；服务器名是消毒后截断到 32 字符的 id。
function deepSeekMCPInsert(id, entry) {
  let name = id.replace(dshServerNameRe, "_");
  if (name.length > 32) {
    name = name.slice(0, 32);
  }
  const config = { serverName: name, toolCallTimeoutMs: 600000 };
  const url = typeof entry["url"] === "string" ? entry["url"] : "";
  if (url !== "") {
    config["transport"] = "streamable-http";
    config["url"] = url;
    if (entry["headers"] !== null && entry["headers"] !== undefined) {
      config["headers"] = entry["headers"];
    }
  } else {
    const command = typeof entry["command"] === "string" ? entry["command"] : "";
    config["transport"] = "stdio";
    config["command"] = command;
    for (const key of ["args", "env", "cwd"]) {
      const value = entry[key];
      if (value !== null && value !== undefined) {
        config[key] = value;
      }
    }
  }
  return { id: "agentflow-mcp-" + name, name: "@deepseek-ai/dsh-mcp-client", config };
}

// agyChatPermissions：AI 对话的 Antigravity 拒绝规则。
const agyChatPermissions = { allow: ["mcp(*)"], deny: ["command(*)", "write_file(*)", "read_url(*)"] };

function writeAgentCLIFile(home, rel, data) {
  rel = path.normalize(rel);
  if (!isLocalPath(rel) || path.isAbsolute(rel) || rel.startsWith("..")) {
    throw new Error(`invalid agent CLI file path ${JSON.stringify(rel)}`);
  }
  const root = openAgentCLIHome(home);
  try {
    const dir = path.dirname(rel);
    if (dir !== "." && dir !== "") {
      root.MkdirAll(dir, 0o700);
    }
    root.WriteFile(rel, data, 0o600);
  } finally {
    root.Close();
  }
}

// AgentCLIHome：受信基目录下的 Agent CLI HOME 位置。
class AgentCLIHome {
  constructor(init = {}) {
    // Base 受信，可按原样打开；Rel 是 Base 下的本地路径。
    this.Base = init.Base ?? "";
    this.Rel = init.Rel ?? "";
  }

  // Path：HOME 的宿主路径。
  Path() { return path.join(this.Base, this.Rel); }
}

// HostAgentCLIHome：控制面自己选定的 HOME。
function HostAgentCLIHome(home) {
  home = path.normalize(home);
  return new AgentCLIHome({ Base: path.dirname(home), Rel: path.basename(home) });
}

// WorkspaceAgentCLIHome：<workspace>/.agentflow/private-home 下的私有 HOME 名。
function WorkspaceAgentCLIHome(workspace, name) {
  return new AgentCLIHome({ Base: workspace, Rel: path.join(".agentflow", "private-home", name) });
}

// Go os.Root 无 JS 对应物：以基路径加边界校验模拟，操作限定在基路径内。
class Root {
  constructor(base) {
    this.base = base;
  }

  Close() {}

  resolve(rel) {
    const full = path.resolve(this.base, rel);
    if (full !== this.base && !full.startsWith(this.base + path.sep)) {
      throw new Error(`path escapes root: ${JSON.stringify(rel)}`);
    }
    return full;
  }

  MkdirAll(rel, mode) {
    fs.mkdirSync(this.resolve(rel), { recursive: true, mode });
  }

  WriteFile(rel, data, mode) {
    fs.writeFileSync(this.resolve(rel), data, { mode });
  }

  ReadFile(rel) {
    return fs.readFileSync(this.resolve(rel));
  }

  Stat(rel) {
    return fs.statSync(this.resolve(rel));
  }

  Lstat(rel) {
    return fs.lstatSync(this.resolve(rel));
  }

  OpenRoot(rel) {
    return new Root(this.resolve(rel));
  }
}

// isLocalPath：Go filepath.IsLocal 的对照实现。
function isLocalPath(p) {
  const clean = path.normalize(p);
  return !path.isAbsolute(p) && clean !== ".." && !clean.startsWith(".." + path.sep);
}

// sameFile：Go os.SameFile 的对照实现。
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

// openAgentCLIHome：把 home 作为 os.Root 打开，缺失目录逐级创建并校验为真实目录。
function openAgentCLIHome(home) {
  const rel = path.normalize(home.Rel);
  if (home.Base.trim() === "" || rel === "." || !isLocalPath(rel)) {
    throw new Error(`invalid agent CLI home: ${home.Path()}`);
  }
  fs.mkdirSync(home.Base, { recursive: true, mode: 0o700 });
  const base = new Root(home.Base);
  let current = "";
  for (const element of rel.split(path.sep)) {
    current = path.join(current, element);
    try {
      ensureRootDirectory(base, current);
    } catch (err) {
      throw new Error(`agent CLI home is not a real directory: ${home.Path()}: ${err.message}`);
    }
  }
  const info = base.Lstat(rel);
  const root = base.OpenRoot(rel);
  base.Close();
  // 打开后组件可能已被换成符号链接，再核对一次。
  let opened = null;
  let statErr = null;
  try {
    opened = root.Stat(".");
  } catch (err) {
    statErr = err;
  }
  if (statErr !== null || !sameFile(info, opened)) {
    root.Close();
    throw new Error(`agent CLI home changed while opening: ${home.Path()}`);
  }
  return root;
}

// ApplyAgentCLICredential：把 Agent CLI 凭据相关的模型配置写入 home，返回运行用的 argv 与环境变量。密钥本身只进环境变量。
function ApplyAgentCLICredential(kind, cred, options, home, homeEnv, argv) {
  const key = cred.APIKey.trim();
  if (key === "") {
    throw new Error(`需求责任人未配置 ${AgentCLILabel(kind)} API Key，请在个人配置中配置`);
  }
  if (kind === AgentCLIAntigravity) {
    // 崩溃的账号登录调用可能留下凭据副本，API Key 执行不得保留或继承该账号。
    const [login] = runnerLoginSpec(kind);
    prepareRunnerLogin(home, login, false);
  }
  const baseURL = cred.BaseURL.trim().replace(/\/+$/, "");
  const protocol = AgentCLIProtocol(kind, cred.Protocol);
  if (baseURL === "" && AgentCLINeedsBaseURL(kind, protocol)) {
    throw new Error(`${AgentCLILabel(kind)} 需要在个人配置中填写 Base URL`);
  }
  const model = options.Model.trim();
  if (model === "" && !agentCLIModelOptional(kind, baseURL)) {
    throw new Error(`${AgentCLILabel(kind)} 需要指定模型`);
  }
  homeEnv = homeEnv.split(path.sep).join("/");
  let env = AutoUpdateEnvironment(kind);
  if (env === null) {
    env = {};
  }
  switch (kind) {
    case AgentCLIOpenCode: {
      const npm = { [AgentCLIProtocolChat]: "@ai-sdk/openai-compatible", [AgentCLIProtocolResponses]: "@ai-sdk/openai", [AgentCLIProtocolMessages]: "@ai-sdk/anthropic" }[protocol];
      let endpoint = baseURL;
      if (protocol === AgentCLIProtocolMessages && !endpoint.endsWith("/v1")) {
        // Base URL 遵循 Claude Code 约定；AI SDK 要 /v1。
        endpoint += "/v1";
      }
      const modelConfig = { name: model };
      if (options.ImageInput) {
        modelConfig["attachment"] = true;
        modelConfig["modalities"] = { input: ["text", "image"], output: ["text"] };
      }
      const config = {
        provider: { agentflow: {
          npm,
          name: "AgentFlow",
          options: { baseURL: endpoint, apiKey: "{env:" + agentCLIKeyEnv + "}" },
          models: { [model]: modelConfig },
        } },
        model: "agentflow/" + model,
        autoupdate: false,
        share: "disabled",
      };
      const prompt = options.SystemPromptFile.trim();
      if (prompt !== "") {
        config["instructions"] = [prompt];
      }
      const content = JSON.stringify(config);
      env[agentCLIKeyEnv] = key;
      env["OPENCODE_CONFIG_CONTENT"] = content;
      break;
    }
    case AgentCLICursor:
      env["CURSOR_API_KEY"] = key;
      if (model !== "") {
        argv = withCursorModelArg(argv, CursorModelID(model, options.Effort, cred.Models));
      }
      break;
    case AgentCLIAntigravity: {
      const settings = {};
      if (protocol === AgentCLIProtocolChat) {
        env["AGY_LLM_GATEWAY_URL"] = baseURL;
        env["AGY_LLM_GATEWAY_API_KEY"] = key;
        env["AGY_LLM_GATEWAY_WIRE_PROTOCOL"] = "openai";
        env["AGY_LLM_GATEWAY_MODELS"] = model;
      } else {
        settings["modelProvider"] = "gemini";
        env["GEMINI_API_KEY"] = key;
        if (baseURL !== "") {
          env["GOOGLE_GEMINI_BASE_URL"] = baseURL;
          env["GEMINI_BASE_URL"] = baseURL;
        }
      }
      const data = JSON.stringify(settings);
      writeAgentCLIFile(home, ".gemini/antigravity-cli/settings.json", data);
      if (options.ReadOnly) {
        // 内联设置会替换文件的同名字段，故重复写 provider。
        settings["permissions"] = agyChatPermissions;
        const inline = JSON.stringify(settings);
        argv = insertBeforeFlag(argv, "-p", "--settings", inline);
      }
      break;
    }
    case AgentCLIKimi: {
      const providerType = { [AgentCLIProtocolChat]: "openai", [AgentCLIProtocolResponses]: "openai_responses", [AgentCLIProtocolMessages]: "anthropic" }[protocol];
      const lines = [`default_model = "agentflow"`, "", "[providers.agentflow]"];
      if (baseURL === "") {
        lines.push(`type = "kimi"`);
      } else {
        lines.push("type = " + JSON.stringify(providerType), "base_url = " + JSON.stringify(baseURL));
      }
      lines.push("api_key_env = " + JSON.stringify(agentCLIKeyEnv), "",
        "[models.agentflow]", `provider = "agentflow"`, "model = " + JSON.stringify(model),
        "max_context_size = 262144");
      const effort = options.Effort.trim();
      ValidateAgentEffort(effort, kind);
      if (effort !== "") {
        if (baseURL !== "") {
          throw new Error(`${AgentCLILabel(kind)} 的第三方网关使用默认思考强度`);
        }
        // Kimi 原生 provider 每轮都应用该覆盖（含续跑），且不改会话保存的默认值。
        let nativeEffort = effort;
        switch (effort) {
          case "none":
            nativeEffort = "off";
            break;
          case "thinking":
            nativeEffort = "on";
            break;
        }
        env[kimiThinkingEffortEnv] = nativeEffort;
      }
      let capabilities = `["thinking", "tool_use"]`;
      if (options.ImageInput) {
        capabilities = `["thinking", "tool_use", "image_in"]`;
      }
      lines.push("capabilities = " + capabilities, "");
      if (options.ApprovalCommand !== "") {
        // Kimi 校验 1–600 秒，超时放行该工具；hook 自身的重试预算远早于该上限。
        lines.push("[[hooks]]", `event = "PreToolUse"`, "command = " + JSON.stringify(options.ApprovalCommand), "timeout = 600", "");
      }
      writeAgentCLIFile(home, ".kimi-code/config.toml", lines.join("\n"));
      env[agentCLIKeyEnv] = key;
      env["KIMI_CODE_HOME"] = homeEnv + "/.kimi-code";
      env["KIMI_DISABLE_TELEMETRY"] = "1";
      break;
    }
    case AgentCLIPi: {
      const api = agentCLIPiAPI(protocol);
      const modelConfig = { id: model, reasoning: true };
      if (options.ImageInput) {
        modelConfig["input"] = ["text", "image"];
      }
      const models = JSON.stringify({ providers: { agentflow: {
        baseUrl: baseURL, api, apiKey: "$" + agentCLIKeyEnv,
        models: [modelConfig],
      } } }, null, 2);
      writeAgentCLIFile(home, ".pi/agent/models.json", models);
      env[agentCLIKeyEnv] = key;
      env["PI_CODING_AGENT_DIR"] = homeEnv + "/.pi/agent";
      break;
    }
    case AgentCLIDeepSeek:
      return applyDeepSeekCredential(home, homeEnv, key, baseURL, protocol, model, options.Effort.trim(), options.ImageInput, argv);
    case AgentCLIZCode:
      return zcode.applyZCodeCredential(home, homeEnv, key, baseURL, protocol, model, options.Effort.trim(), argv);
    default:
      throw new Error(`unknown agent CLI ${JSON.stringify(kind)}`);
  }
  return [argv, env];
}

// agentCLIPiAPI：把线路协议映射为 Pi 与 DeepSeek Harness provider 配置共用的 pi-ai api 名。
function agentCLIPiAPI(protocol) {
  return { [AgentCLIProtocolChat]: "openai-completions", [AgentCLIProtocolResponses]: "openai-responses", [AgentCLIProtocolMessages]: "anthropic-messages" }[protocol];
}

// applyDeepSeekCredential：写 DeepSeek Harness 模型补丁，并把启动器 --patch 标志放到 profile 自身参数之前。
function applyDeepSeekCredential(home, homeEnv, key, baseURL, protocol, model, effort, imageInput, argv) {
  const env = {};
  let patch = [];
  const selection = {};
  const deepSeekModel = model === "deepseek-flash" || model === "deepseek-v4-pro";
  if (baseURL === "" && (deepSeekModel || model === "") && effort === "") {
    // 无头续跑复用已保存的选择，除非补丁指明强度；空白选择恢复内置路由的默认值。
    effort = "high";
  }
  if (effort !== "") {
    ValidateAgentEffort(effort, AgentCLIDeepSeek);
    if (effort === "none") {
      effort = "off";
    }
    selection["reasoningEffort"] = effort;
  }
  if (baseURL === "" || (deepSeekModel && protocol === AgentCLIProtocolMessages && effort !== "")) {
    env["DEEPSEEK_API_KEY"] = key;
    if (baseURL !== "") {
      patch = [...patch, { id: "llm-deepseek", config: { baseURL } }];
    }
    if (model !== "") {
      selection["provider"] = "deepseek-official";
      selection["model"] = model;
    }
  } else {
    const api = agentCLIPiAPI(protocol);
    env[agentCLIKeyEnv] = key;
    let provider = "agentflow";
    const modelConfig = { id: model };
    // 官方智谱 Flash 端点拒绝 Harness 默认的输出上限；自定义网关保持各自默认值。
    let endpoint = null;
    try {
      endpoint = new URL(baseURL);
    } catch (err) {
      endpoint = null;
    }
    if (endpoint !== null &&
      endpoint.protocol === "https:" && endpoint.hostname.toLowerCase() === "open.bigmodel.cn" &&
      model === "glm-4-flash-250414" && protocol === AgentCLIProtocolChat) {
      modelConfig["maxTokens"] = 16384;
    }
    if (imageInput) {
      modelConfig["input"] = ["text", "image"];
    }
    if (effort !== "") {
      // 让网关未配置的路由保持可区分，续跑回退时不继承显式选择的强度。
      provider = "agentflow-reasoning";
      modelConfig["reasoningEfforts"] = { off: null, low: "low", high: "high", max: "max" };
      if (api === "openai-completions" && deepSeekModel) {
        modelConfig["compat"] = { thinkingFormat: "deepseek" };
      }
    }
    patch = [...patch, { id: "llm-pi-ai", config: { providers: { [provider]: {
      displayName: "AgentFlow", apiKeyEnv: agentCLIKeyEnv, api, baseURL,
      models: [modelConfig],
    } } } }];
    selection["provider"] = provider;
    selection["model"] = model;
  }
  if (Object.keys(selection).length > 0) {
    patch = [...patch, { id: "agent-default-model", config: selection }];
  }
  const data = JSON.stringify(patch, null, 2);
  writeAgentCLIFile(home, ".dsh/agentflow-model.json", data);
  env["DSH_HOME"] = homeEnv + "/.dsh";
  // 启动器标志在 profile 自身参数之前：dsh --profile <name> --patch … app-args。
  if (argv.length < 3) {
    throw new Error("invalid DeepSeek Harness invocation");
  }
  const patches = ["--patch", homeEnv + "/.dsh/agentflow-model.json"];
  const root = openAgentCLIHome(home);
  let statErr = null;
  try {
    root.Stat(path.join(".dsh", "agentflow-mcp.json"));
  } catch (err) {
    statErr = err;
  }
  root.Close();
  if (statErr === null) {
    patches.push("--patch", homeEnv + "/.dsh/agentflow-mcp.json");
  }
  const head = argv.slice(0, 3);
  argv = [...head, ...patches, ...argv.slice(3)];
  return [argv, env];
}

// insertBeforeFlag：在 flag 最后一次出现之前插入值，flag 不存在时追加。
function insertBeforeFlag(argv, flag, ...values) {
  for (let i = argv.length - 1; i > 0; i--) {
    if (argv[i] === flag) {
      const out = [...argv.slice(0, i), ...values];
      return [...out, ...argv.slice(i)];
    }
  }
  return [...argv, ...values];
}

// AgentCLIUserCredentials：把用户保存的 Agent CLI 凭据映射为命令绑定用的表单。
function AgentCLIUserCredentials(user) {
  if (user.AgentCLICredentials === null || user.AgentCLICredentials === undefined || Object.keys(user.AgentCLICredentials).length === 0) {
    return null;
  }
  const out = {};
  for (const [kind, cred] of Object.entries(user.AgentCLICredentials)) {
    out[kind] = { APIKey: cred.APIKey, BaseURL: cred.BaseURL, Protocol: cred.Protocol, Models: cred.Models };
  }
  return out;
}

// AgentCLILabel：错误与设置中展示的产品名。
function AgentCLILabel(kind) {
  switch (kind) {
    case AgentCLIOpenCode:
      return "OpenCode";
    case AgentCLICursor:
      return "Cursor CLI";
    case AgentCLIAntigravity:
      return "Antigravity";
    case AgentCLIKimi:
      return "Kimi Code";
    case AgentCLIPi:
      return "Pi";
    case AgentCLIDeepSeek:
      return "DeepSeek Harness";
    case AgentCLIZCode:
      return "ZCode";
  }
  return kind;
}

// AgentCLIBinary：各 Agent CLI 安装的可执行文件。
function AgentCLIBinary(kind) {
  switch (kind) {
    case AgentCLICursor:
      return "cursor-agent";
  }
  return kind;
}

// withCursorModelArg：替换首个 --model 选项的值。
function withCursorModelArg(argv, id) {
  for (let i = 0; i + 1 < argv.length; i++) {
    if (argv[i] === "--model") {
      if (argv[i + 1] === id) {
        return argv;
      }
      const out = [...argv];
      out[i + 1] = id;
      return out;
    }
  }
  return argv;
}

module.exports = {
  AgentCLIOpenCode, AgentCLICursor, AgentCLIAntigravity, AgentCLIKimi, AgentCLIPi, AgentCLIDeepSeek, AgentCLIZCode,
  AgentCLIKinds, IsAgentCLI,
  AgentCLIProtocolChat, AgentCLIProtocolResponses, AgentCLIProtocolMessages, AgentCLIProtocolGemini, AgentCLIProtocolOptions,
  AgentCLIProtocols, AgentCLIProtocol, AgentCLINeedsBaseURL, agentCLIModelOptional, AgentCLIOptions,
  agentCLIKeyEnv, kimiThinkingEffortEnv, agentCLIHostEnv, agentCLIMCPPaths, AgentCLIMCPOptions, dshServerNameRe,
  WriteAgentCLIMCPConfig, openCodeMCPServer, deepSeekMCPInsert, agyChatPermissions, writeAgentCLIFile,
  AgentCLIHome, HostAgentCLIHome, WorkspaceAgentCLIHome, Root, isLocalPath, sameFile, openAgentCLIHome,
  ApplyAgentCLICredential, agentCLIPiAPI, applyDeepSeekCredential, insertBeforeFlag,
  AgentCLIUserCredentials, AgentCLILabel, AgentCLIBinary, withCursorModelArg,
};
