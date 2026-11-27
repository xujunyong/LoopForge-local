/**
 * @file internal/runtime/agent_cli.js
 * @description 对应 Go 源文件：internal/runtime/agent_cli.go
 *
 * 职责与边界：
 * 负责 CodeBuddy / Codex / Claude Code 之外的扩展 Agent CLI（OpenCode、Cursor CLI、Antigravity、
 * Kimi Code、Pi、DeepSeek Harness、ZCode）的常量定义、协议规范化、MCP 配置渲染、
 * 私有 HOME 路径安全打开与凭据/模型配置绑定。
 * 不负责进程启动与流式输出解析（流式解析见 `agent_cli_stream.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 译为成功返回值、失败抛出 `Error`；仅 `error` 译为成功返回 `undefined`、失败抛出 `Error`。
 * - Go 的 `(值1, 值2, error)` 译为成功返回二元组 `[值1, 值2]`、失败抛出 `Error`。
 * - Go `struct` 译为带 `constructor(init = {})` 的类，字段严格按 Go 零值初始化。
 * - Go 标准库 `os.Root` 在 JS 中无内置对应物，以 `Root` 类配合基路径边界校验进行对照实现。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { AgentCLIExecutorKinds, IsAgentCLIKind, ValidateAgentEffort } = require("../domain/agent.js"); // 对应 Go 的 domain，domain 已翻译
const domainUser = require("../domain/user.js"); // 对应 Go 的 domain，domain 已翻译
const { AutoUpdateEnvironment } = require("../managedcli/providers.js"); // 对应 Go 的 managedcli.AutoUpdateEnvironment，managedcli 已翻译
const { ensureRootDirectory } = require("./materialize.js"); // 对应 Go 同包函数，materialize.js 待翻译
const { runnerLoginSpec, prepareRunnerLogin } = require("./conversation_runner_login.js"); // 对应 Go 同包函数，conversation_runner_login.js 待翻译
const { CursorModelID } = require("./cursor_models.js"); // 对应 Go 同包函数，cursor_models.js 待翻译
const zcode = require("./agent_cli_zcode.js"); // 对应 Go 同包常量，agent_cli_zcode.js 待翻译；本文件加载时读取其常量，zcode 文件顶层不引用本文件，故无循环加载问题

// CodeBuddy / Codex / Claude Code 之外的 Agent CLI 标识常量。
const AgentCLIOpenCode = "opencode";
const AgentCLICursor = "cursor";
const AgentCLIAntigravity = "agy";
const AgentCLIKimi = "kimi";
const AgentCLIPi = "pi";
const AgentCLIDeepSeek = "dsh";
const AgentCLIZCode = "zcode";

// AgentCLIKinds：Agent CLI 的展示顺序。
const AgentCLIKinds = AgentCLIExecutorKinds;

/**
 * 判断执行器种类是否属于扩展 Agent CLI。
 * 在凭据绑定、命令构造与配置渲染分支判定时调用。
 *
 * @param {string} kind - 执行器种类标识。
 * @returns {boolean} 属于扩展 Agent CLI 返回 `true`，否则返回 `false`。
 */
function IsAgentCLI(kind) { return IsAgentCLIKind(kind); }

const AgentCLIProtocolChat = domainUser.AgentCLIProtocolChat;
const AgentCLIProtocolResponses = domainUser.AgentCLIProtocolResponses;
const AgentCLIProtocolMessages = domainUser.AgentCLIProtocolMessages;
const AgentCLIProtocolGemini = domainUser.AgentCLIProtocolGemini;
const AgentCLIProtocolOptions = domainUser.AgentCLIProtocolOptions;

/**
 * 获取指定 Agent CLI 支持的协议列表。
 * 在表单展示或协议校验场景下调用。
 *
 * @param {string} kind - Agent CLI 种类标识。
 * @returns {string[] | undefined} 支持的协议数组；未知种类返回 `undefined`。
 */
function AgentCLIProtocols(kind) { return AgentCLIProtocolOptions[kind]; }

/**
 * 规范化已保存的协议选择；未知取值回落到该 CLI 的默认协议。
 * 在绑定凭据或判断是否需要 Base URL 前调用。
 *
 * @param {string} kind - Agent CLI 种类标识。
 * @param {string} protocol - 待规范化的协议字符串。
 * @returns {string} 规范化后的协议标识或空字符串 `""`。
 */
function AgentCLIProtocol(kind, protocol) {
  return domainUser.NormalizeAgentCLIProtocol(kind, protocol);
}

/**
 * 判断指定 Agent CLI 在给定协议下是否必须填写 Base URL 才能使用。
 * OpenCode 与 Pi 无官方端点，Antigravity 仅在 OpenAI Chat 兼容协议下需要网关地址。
 *
 * @param {string} kind - Agent CLI 种类标识。
 * @param {string} protocol - 协议字符串。
 * @returns {boolean} 必须提供 Base URL 返回 `true`，否则返回 `false`。
 */
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

/**
 * 判断执行器与对话均未指定模型时，CLI 是否允许自行选择默认模型。
 * Cursor 与 ZCode 始终允许；Antigravity 与 DeepSeek 仅在使用官方默认端点时允许。
 *
 * @param {string} kind - Agent CLI 种类标识。
 * @param {string} baseURL - 去除首尾空白和末尾斜杠后的 Base URL。
 * @returns {boolean} 允许省略模型名返回 `true`，否则返回 `false`。
 */
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

/**
 * 单次 Agent CLI 调用的凭据绑定选项，用于渲染模型、推理强度、系统提示与只读权限配置。
 */
class AgentCLIOptions {
  /**
   * 构造 AgentCLIOptions 实例，未传入字段按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段对象。
   * @param {string} [init.ApprovalCommand=""] - 工具审批钩子命令。
   * @param {string} [init.Model=""] - 指定模型标识。
   * @param {string} [init.Effort=""] - 推理强度等级。
   * @param {string} [init.SystemPromptFile=""] - 进程视角的系统提示词文件路径。
   * @param {boolean} [init.ReadOnly=false] - 是否处于只读对话模式。
   * @param {boolean} [init.ImageInput=false] - 是否启用多模态图片输入。
   * @returns {void} 无返回值。
   */
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

// agentCLIKeyEnv：以变量名而非密钥本身配置的 CLI 所用的用户密钥环境变量名。
const agentCLIKeyEnv = "AGENTFLOW_CLI_API_KEY";
const kimiThinkingEffortEnv = "KIMI_MODEL_THINKING_EFFORT";

// agentCLIHostEnv：每个子进程都要清除的宿主环境变量列表，避免继承宿主登录态、密钥或配置目录。
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

// agentCLIMCPPaths：各 Agent CLI 读取 MCP 服务器配置的 HOME 相对文件路径映射。
const agentCLIMCPPaths = {
  [AgentCLIOpenCode]: ".config/opencode/opencode.json",
  [AgentCLICursor]: ".cursor/mcp.json",
  [AgentCLIAntigravity]: ".gemini/config/mcp_config.json",
  [AgentCLIKimi]: ".kimi-code/mcp.json",
  [AgentCLIPi]: ".pi/agent/mcp.json",
  [AgentCLIDeepSeek]: ".dsh/agentflow-mcp.json",
  [AgentCLIZCode]: zcode.zcodeConfigPath,
};

/**
 * 一次调用的 MCP 配置渲染选项。
 */
class AgentCLIMCPOptions {
  /**
   * 构造 AgentCLIMCPOptions 实例。
   *
   * @param {Object} [init={}] - 可选初始字段对象。
   * @param {boolean} [init.ReadOnly=false] - 是否禁用 CLI 自身的 shell、编辑与 web 工具（仅保留 MCP 工具）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    // ReadOnly：禁用 CLI 自身的 shell、编辑与 web 工具。
    this.ReadOnly = init.ReadOnly ?? false;
  }
}

const dshServerNameRe = /[^A-Za-z0-9_-]/g;

/**
 * 按目标 Agent CLI 的原生格式把 MCP 条目渲染并写入指定 HOME 目录，覆盖上次调用的残留配置。
 * 在启动 Agent CLI 之前装配 MCP 服务器列表时调用。
 *
 * @param {string} kind - Agent CLI 种类标识。
 * @param {AgentCLIHome} home - 目标私有 HOME 描述对象。
 * @param {Object<string, Object>} entries - MCP 条目映射（键为服务 ID，值为含 `url`/`headers` 或 `command`/`args`/`cwd`/`env` 的对象）。
 * @param {AgentCLIMCPOptions} options - MCP 配置选项（如是否只读）。
 * @returns {void} 成功无返回值；未知 CLI 类型或写文件失败时抛出 `Error`。
 */
function WriteAgentCLIMCPConfig(kind, home, entries, options) {
  const rel = agentCLIMCPPaths[kind];
  if (rel === undefined) {
    throw new Error(`unknown agent CLI ${JSON.stringify(kind)}`);
  }
  const ids = Object.keys(entries ?? {});
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

/**
 * 为 OpenCode 渲染单条 MCP 服务器配置（远程 URL 模式或本地命令行 argv 模式）。
 * 由 `WriteAgentCLIMCPConfig` 在处理 OpenCode 时调用。
 *
 * @param {Object} entry - 通用 MCP 条目对象。
 * @returns {Object} 符合 OpenCode 配置格式的 MCP 服务器对象。
 */
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

/**
 * 将单条 MCP 条目渲染为 DeepSeek Harness 的 `dsh-mcp-client` 插件 insert 配置，
 * 服务器名由消毒并截断到 32 字符的 `id` 构成。
 * 由 `WriteAgentCLIMCPConfig` 在处理 DeepSeek Harness 时调用。
 *
 * @param {string} id - MCP 服务标识。
 * @param {Object} entry - 通用 MCP 条目对象。
 * @returns {Object} `dsh-mcp-client` 插件插入对象。
 */
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

// agyChatPermissions：AI 对话模式下 Antigravity 的工具拒绝规则。
const agyChatPermissions = { allow: ["mcp(*)"], deny: ["command(*)", "write_file(*)", "read_url(*)"] };

/**
 * 将数据安全写入指定 Agent CLI HOME 下的相对路径文件（权限 0o600，自动创建父目录）。
 * 在写入 MCP 配置或模型/凭据配置文件时调用。
 *
 * @param {AgentCLIHome} home - 目标私有 HOME 描述对象。
 * @param {string} rel - 相对于 HOME 的文件路径。
 * @param {string | Buffer} data - 待写入的文件内容。
 * @returns {void} 成功无返回值；路径非法或文件操作失败时抛出 `Error`。
 */
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

/**
 * 描述位于受信基目录下的 Agent CLI HOME 位置。
 * 用于在工作区可能被沙箱篡改为符号链接的场景下安全定位并校验 HOME 目录。
 */
class AgentCLIHome {
  /**
   * 构造 AgentCLIHome 实例。
   *
   * @param {Object} [init={}] - 可选初始字段对象。
   * @param {string} [init.Base=""] - 控制面拥有的受信基目录路径。
   * @param {string} [init.Rel=""] - 基目录下的本地相对路径，每一级都必须是真实目录。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    // Base 受信，可按原样打开；Rel 是 Base 下的本地路径。
    this.Base = init.Base ?? "";
    this.Rel = init.Rel ?? "";
  }

  /**
   * 返回该 HOME 在宿主文件系统上的完整路径。
   *
   * @returns {string} 拼接后的宿主路径。
   */
  Path() { return path.join(this.Base, this.Rel); }
}

/**
 * 构造控制面自身选定的宿主 HOME 描述对象（其父目录受信，HOME 本身仍须为真实目录）。
 *
 * @param {string} home - 宿主 HOME 绝对或相对路径。
 * @returns {AgentCLIHome} 对应的 `AgentCLIHome` 实例。
 */
function HostAgentCLIHome(home) {
  home = path.normalize(home);
  return new AgentCLIHome({ Base: path.dirname(home), Rel: path.basename(home) });
}

/**
 * 构造位于 `<workspace>/.agentflow/private-home/<name>` 下的工作区私有 HOME 描述对象。
 *
 * @param {string} workspace - 工作区根目录路径。
 * @param {string} name - 私有 HOME 名称。
 * @returns {AgentCLIHome} 对应的 `AgentCLIHome` 实例。
 */
function WorkspaceAgentCLIHome(workspace, name) {
  return new AgentCLIHome({ Base: workspace, Rel: path.join(".agentflow", "private-home", name) });
}

/**
 * 对照 Go `os.Root` 的基路径边界封装类，确保所有文件与目录操作限定在 `base` 目录内。
 */
class Root {
  /**
   * 构造 Root 实例。
   *
   * @param {string} base - 根目录绝对路径。
   * @returns {void} 无返回值。
   */
  constructor(base) {
    this.base = base;
  }

  /**
   * 关闭根目录句柄（JS 对照实现为空操作）。
   *
   * @returns {void} 无返回值。
   */
  Close() {}

  /**
   * 将相对路径解析为绝对路径并校验其未越出 `this.base` 边界。
   *
   * @param {string} rel - 相对于根目录的路径。
   * @returns {string} 校验通过的绝对路径；越界时抛出 `Error`。
   */
  resolve(rel) {
    const full = path.resolve(this.base, rel);
    if (full !== this.base && !full.startsWith(this.base + path.sep)) {
      throw new Error(`path escapes root: ${JSON.stringify(rel)}`);
    }
    return full;
  }

  /**
   * 在根目录下递归创建目录。
   *
   * @param {string} rel - 相对目录路径。
   * @param {number} mode - 目录权限位。
   * @returns {void} 无返回值。
   */
  MkdirAll(rel, mode) {
    fs.mkdirSync(this.resolve(rel), { recursive: true, mode });
  }

  /**
   * 向根目录下的相对路径写入文件。
   *
   * @param {string} rel - 相对文件路径。
   * @param {string | Buffer} data - 文件内容。
   * @param {number} mode - 文件权限位。
   * @returns {void} 无返回值。
   */
  WriteFile(rel, data, mode) {
    fs.writeFileSync(this.resolve(rel), data, { mode });
  }

  /**
   * 读取根目录下的相对路径文件内容。
   *
   * @param {string} rel - 相对文件路径。
   * @returns {Buffer} 文件字节内容。
   */
  ReadFile(rel) {
    return fs.readFileSync(this.resolve(rel));
  }

  /**
   * 获取根目录下相对路径的 `fs.Stats`（跟随符号链接）。
   *
   * @param {string} rel - 相对路径。
   * @returns {fs.Stats} 文件状态对象。
   */
  Stat(rel) {
    return fs.statSync(this.resolve(rel));
  }

  /**
   * 获取根目录下相对路径的 `fs.Stats`（不跟随符号链接）。
   *
   * @param {string} rel - 相对路径。
   * @returns {fs.Stats} 文件状态对象。
   */
  Lstat(rel) {
    return fs.lstatSync(this.resolve(rel));
  }

  /**
   * 以根目录下某个子目录作为新的 `Root` 打开。
   *
   * @param {string} rel - 子目录相对路径。
   * @returns {Root} 新的子目录 `Root` 实例。
   */
  OpenRoot(rel) {
    return new Root(this.resolve(rel));
  }
}

/**
 * 判断路径是否为本地相对路径（对应 Go `filepath.IsLocal`）。
 *
 * @param {string} p - 待检查路径。
 * @returns {boolean} 非绝对路径且不指向父目录时返回 `true`，否则返回 `false`。
 */
function isLocalPath(p) {
  const clean = path.normalize(p);
  return !path.isAbsolute(p) && clean !== ".." && !clean.startsWith(".." + path.sep);
}

/**
 * 判断两个 `fs.Stats` 是否指向同一底层文件（对应 Go `os.SameFile`）。
 *
 * @param {fs.Stats} a - 第一个文件状态对象。
 * @param {fs.Stats} b - 第二个文件状态对象。
 * @returns {boolean} 设备号与 inode 均一致返回 `true`，否则返回 `false`。
 */
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * 将 `AgentCLIHome` 作为安全 `Root` 打开：逐级创建缺失目录并校验每级均为真实目录，
 * 打开后再次核对 `SameFile` 防止并发符号链接替换。
 *
 * @param {AgentCLIHome} home - 目标私有 HOME 描述对象。
 * @returns {Root} 打开后的 HOME 根目录句柄；路径非法或目录校验失败时抛出 `Error`。
 */
function openAgentCLIHome(home) {
  const rel = path.normalize(home.Rel);
  if (home.Base.trim() === "" || rel === "." || !isLocalPath(rel)) {
    throw new Error(`invalid agent CLI home: ${home.Path()}`);
  }
  fs.mkdirSync(home.Base, { recursive: true, mode: 0o700 });
  const base = new Root(home.Base);
  let info;
  let root;
  try {
    let current = "";
    for (const element of rel.split(path.sep)) {
      current = path.join(current, element);
      try {
        ensureRootDirectory(base, current);
      } catch (err) {
        throw new Error(`agent CLI home is not a real directory: ${home.Path()}: ${err.message}`);
      }
    }
    info = base.Lstat(rel);
    root = base.OpenRoot(rel);
  } finally {
    base.Close();
  }
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

/**
 * 将 Agent CLI 凭据相关的模型配置写入 `home`，并返回运行所需的命令参数与环境变量映射。
 * API Key 本身只写入环境变量，配置文件仅引用环境变量名（ZCode 除外，由专用清理钩子保障）。
 *
 * @param {string} kind - Agent CLI 种类标识。
 * @param {Object} cred - 供应商凭据对象（含 `APIKey`、`BaseURL`、`Protocol`、`Models`）。
 * @param {AgentCLIOptions} options - 单次调用选项（模型、推理强度、系统提示、只读、图片输入等）。
 * @param {AgentCLIHome} home - 宿主侧私有 HOME 描述对象。
 * @param {string} homeEnv - 子进程视角看到的 HOME 路径。
 * @param {string[]} argv - 原始命令行参数数组。
 * @returns {[string[], Object<string, string>]} 二元组 `[更新后的 argv, 环境变量映射]`；配置校验或写文件失败时抛出 `Error`。
 */
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

/**
 * 将线路协议映射为 Pi 与 DeepSeek Harness 共用的 `pi-ai` API 类型名称。
 *
 * @param {string} protocol - 规范化后的协议常量。
 * @returns {string | undefined} 对应的 `pi-ai` API 名称。
 */
function agentCLIPiAPI(protocol) {
  return { [AgentCLIProtocolChat]: "openai-completions", [AgentCLIProtocolResponses]: "openai-responses", [AgentCLIProtocolMessages]: "anthropic-messages" }[protocol];
}

/**
 * 写入 DeepSeek Harness 模型补丁文件，并将启动器 `--patch` 参数插入到 profile 参数之前。
 * 由 `ApplyAgentCLICredential` 在处理 DeepSeek Harness 时调用。
 *
 * @param {AgentCLIHome} home - 宿主侧私有 HOME 描述对象。
 * @param {string} homeEnv - 进程视角 HOME 路径。
 * @param {string} key - API 密钥。
 * @param {string} baseURL - 自定义网关地址（为空表示官方端点）。
 * @param {string} protocol - 规范化后的协议标识。
 * @param {string} model - 目标模型名称。
 * @param {string} effort - 推理强度等级。
 * @param {boolean} imageInput - 是否启用多模态图片输入。
 * @param {string[]} argv - 原始命令行参数数组。
 * @returns {[string[], Object<string, string>]} 二元组 `[带 --patch 的 argv, 环境变量映射]`；校验或写入失败时抛出 `Error`。
 */
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

/**
 * 在参数数组中最后一次出现 `flag` 的位置之前插入若干参数；若 `flag` 不存在则追加到末尾。
 *
 * @param {string[]} argv - 原始参数数组（不就地修改）。
 * @param {string} flag - 目标标志参数名。
 * @param {...string} values - 待插入的参数列表。
 * @returns {string[]} 插入后的新参数数组。
 */
function insertBeforeFlag(argv, flag, ...values) {
  for (let i = argv.length - 1; i > 0; i--) {
    if (argv[i] === flag) {
      const out = [...argv.slice(0, i), ...values];
      return [...out, ...argv.slice(i)];
    }
  }
  return [...argv, ...values];
}

/**
 * 将用户保存的扩展 Agent CLI 凭据映射为命令绑定阶段使用的供应商凭据字典。
 *
 * @param {Object} user - 领域用户对象（含 `AgentCLICredentials`）。
 * @returns {Object<string, Object> | null} 按 CLI 种类索引的凭据对象；用户未配置任何凭据时返回 `null`。
 */
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

/**
 * 返回用于错误提示与设置界面展示的 Agent CLI 产品名称。
 *
 * @param {string} kind - Agent CLI 种类标识。
 * @returns {string} 展示名称；未知种类原样返回 `kind`。
 */
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

/**
 * 返回各 Agent CLI 安装的可执行文件名。
 *
 * @param {string} kind - Agent CLI 种类标识。
 * @returns {string} 可执行文件名（如 Cursor 对应 `"cursor-agent"`，其余同 `kind`）。
 */
function AgentCLIBinary(kind) {
  switch (kind) {
    case AgentCLICursor:
      return "cursor-agent";
  }
  return kind;
}

/**
 * 替换命令行参数中首个 `--model` 选项对应的模型值，返回新数组（不就地修改输入）。
 *
 * @param {string[]} argv - 原始参数数组。
 * @param {string} id - 新的模型标识。
 * @returns {string[]} 替换后的参数数组；若未找到 `--model` 或值相同则直接返回原数组。
 */
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
