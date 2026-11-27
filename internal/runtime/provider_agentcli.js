"use strict";

/**
 * @file internal/runtime/provider_agentcli.js
 * @description 对应 Go 源文件 `internal/runtime/provider_agentcli.go`。
 * 实现通用 Agent CLI（OpenCode、Cursor、Antigravity、Kimi、Pi、DeepSeek、ZCode）的 Provider 适配：
 * 包括私有 HOME 目录与 MCP 配置物化、各 CLI 无头模式命令行构造、Antigravity 模型思考力度映射、
 * 以及 Kimi 对话模式 Agent 定义文件写入。
 *
 * Go -> JS 语法与结构差异说明：
 * - `agentCLIProvider` 单嵌入 `baseProvider`，按规范使用 ES 类继承 `extends baseProvider`。
 * - `in` 为 JS 保留字，`Prepare` 参数局部改名为 `inv`；`path` 为已引入的 Node 模块名，写入函数参数改名为 `filePath`。
 * - 与 `agy_models.js`、`agent_cli_zcode.js` 存在同包循环引用，按规范在函数内使用延迟 `require`。
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ExecutorEffortLevels } = require("../domain/agent.js");
const {
  baseProvider,
  SandboxRequirements,
  maxArgvPromptBytes,
  positionalPrompt,
} = require("./provider.js");
const { protocolTranslated } = require("./protocol.js");
const { CommandSpec, BindAgentCLI, BindGit, BindMCP } = require("./runtime.js"); // 待翻译
const { EnsureControlDirectory, mcpConfigEntries } = require("./materialize.js"); // 待翻译
const { AgentCLIPrivateHomeKey } = require("./command_binding.js");
const {
  AgentCLIOpenCode,
  AgentCLICursor,
  AgentCLIAntigravity,
  AgentCLIKimi,
  AgentCLIPi,
  AgentCLIDeepSeek,
  AgentCLIZCode,
  AgentCLIOptions,
  AgentCLIMCPOptions,
  WriteAgentCLIMCPConfig,
  WorkspaceAgentCLIHome,
  AgentCLIBinary,
} = require("./agent_cli.js");
const { CursorModelID } = require("./cursor_models.js");

/**
 * 通用 Agent CLI Provider：以各 CLI 原生无头模式运行，将角色 MCP 配置写入按 Agent 隔离的私有 HOME。
 * 对应 Go `agentCLIProvider`。
 */
class agentCLIProvider extends baseProvider {
  /**
   * 构造通用 Agent CLI Provider 实例。
   *
   * @param {object} [init={}] - 透传给 `baseProvider` 的初始化字段。
   */
  constructor(init = {}) {
    super(init);
  }

  /**
   * 为目标 Agent 准备私有 HOME 控制目录、写入 MCP 配置，并记录编译后的系统提示词正文。
   *
   * @param {object} ctx - 物化上下文（`providerMaterializeContext`）。
   * @returns {void} 无返回值；失败时抛出 `Error`。
   */
  Materialize(ctx) {
    const entries = mcpConfigEntries(ctx.MCPServers);
    const name = AgentCLIPrivateHomeKey(this.kind, ctx.AgentID);
    EnsureControlDirectory(ctx.Workspace, "private-home", name);
    WriteAgentCLIMCPConfig(this.kind, WorkspaceAgentCLIHome(ctx.Workspace, name), entries, new AgentCLIMCPOptions());
    ctx.Compiled.SystemPrompt = Buffer.isBuffer(ctx.Content) ? ctx.Content.toString("utf8") : String(ctx.Content ?? "");
  }

  /**
   * 构建当前 Agent CLI 执行所需的命令规格、凭据绑定及私有 HOME 策略。
   *
   * @param {object} inv - 调用入参（`providerInvocation`，对应 Go 原参数名 `in`）。
   * @returns {CommandSpec} 构建完成的命令规格。
   */
  Prepare(inv) {
    let systemFile = "";
    if (inv.Compiled.AgentRoot !== "") {
      systemFile = path.join(inv.Compiled.AgentRoot, "agent-system.md").replaceAll("\\", "/");
    }
    const command = AgentCLICommand(
      this.kind,
      new AgentCLICommandOptions({
        Binary: inv.Executor.Binary,
        Model: inv.Executor.Model,
        Effort: inv.Executor.Effort,
        Resume: inv.Options.ResumeSessionID,
        Prompt: positionalPrompt(inv),
        SystemPrompt: inv.Compiled.SystemPrompt,
        SystemPromptFile: systemFile,
        Extra: inv.Executor.Args,
        RunnerLogin: inv.Options.RunnerLogin,
      })
    );
    command.CredentialBindings = [BindAgentCLI, BindGit, BindMCP];
    command.PrivateHome = true;
    command.PrivateHomeKey = AgentCLIPrivateHomeKey(this.kind, inv.Compiled.AgentID);
    return command;
  }

  /**
   * 声明通用 Agent CLI 均需要独立私有 HOME 目录。
   *
   * @returns {SandboxRequirements} 沙箱需求对象。
   */
  SandboxRequirements() {
    return new SandboxRequirements({ PrivateHome: true });
  }
}

/**
 * 按指定 Agent CLI 类型构造对应的 `agentCLIProvider` 实例（采用 `protocolTranslated` 解析器）。
 *
 * @param {string} kind - Agent CLI 类型常量。
 * @returns {agentCLIProvider} 新建的 Provider 实例。
 */
function newAgentCLIProvider(kind) {
  return new agentCLIProvider({
    kind,
    parser: protocolTranslated,
    adapter: "agent-cli-stream-v1",
  });
}

/**
 * 判断指定的 Agent CLI 是否原生支持加载系统提示词文件，而非拼接在任务提示词之前。
 *
 * @param {string} kind - Agent CLI 类型常量。
 * @returns {boolean} 原生支持返回 `true`，否则返回 `false`。
 */
function agentCLINativeSystemPrompt(kind) {
  return kind === AgentCLIOpenCode || kind === AgentCLIPi;
}

/**
 * 为不支持独立系统提示词选项的 Agent CLI 将系统指令前置到任务提示词中；
 * 若合并后超过单参数长度上限且提供了系统提示词文件路径，则改为按路径引用。
 *
 * @param {string} system - 系统提示词正文。
 * @param {string} systemFile - 系统提示词文件路径。
 * @param {string} task - 用户或节点任务正文。
 * @returns {string} 合并后的最终任务提示词。
 */
function AgentCLITaskPrompt(system, systemFile, task) {
  system = system.trim();
  if (system === "") {
    return task;
  }
  if (Buffer.byteLength(system, "utf8") + Buffer.byteLength(task, "utf8") > maxArgvPromptBytes && systemFile !== "") {
    return "先完整阅读并严格遵守 `" + systemFile + "` 中的系统指令，然后完成下面的任务。\n\n" + task;
  }
  return "<system_instructions>\n" + system + "\n</system_instructions>\n\n" + task;
}

/**
 * 生成随机 UUID v4 字符串作为 Agent CLI 的新会话 ID。
 *
 * @returns {string} 标准 36 位 UUID v4 字符串。
 */
function newAgentCLISessionID() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20, 32);
}

/**
 * 描述单轮无头 Agent CLI 调用的命令行构造选项。
 */
class AgentCLICommandOptions {
  /**
   * 构造命令行选项对象。
   *
   * @param {object} [init={}] - 初始化字段。
   * @param {string} [init.Binary=""] - 可执行文件名或路径。
   * @param {string} [init.Model=""] - 模型标识。
   * @param {string} [init.Effort=""] - 思考力度等级。
   * @param {string} [init.Resume=""] - 待续接的会话 ID，为空表示新建会话。
   * @param {string} [init.Prompt=""] - 本轮提示词正文。
   * @param {string[]} [init.ImagePaths=[]] - 已暂存在对话附件目录的图片路径列表。
   * @param {boolean} [init.ImageInput=false] - 历史轮次是否包含图片输入。
   * @param {string} [init.SystemPrompt=""] - 系统提示词正文。
   * @param {string} [init.SystemPromptFile=""] - 进程可读的系统提示词文件路径。
   * @param {string[]} [init.Extra=[]] - 额外透传的 CLI 参数。
   * @param {boolean} [init.Chat=false] - 是否运行在控制面 AI 对话模式。
   * @param {boolean} [init.Workspace=false] - 对话模式是否启用工作区读写能力。
   * @param {boolean} [init.RunnerLogin=false] - 是否使用 Runner 账号登录模式。
   * @param {string} [init.AgentFile=""] - Kimi Code 对话模式的 Agent 定义文件路径。
   */
  constructor(init = {}) {
    this.Binary = init.Binary ?? "";
    this.Model = init.Model ?? "";
    this.Effort = init.Effort ?? "";
    this.Resume = init.Resume ?? "";
    this.Prompt = init.Prompt ?? "";
    this.ImagePaths = init.ImagePaths ?? [];
    this.ImageInput = init.ImageInput ?? false;
    this.SystemPrompt = init.SystemPrompt ?? "";
    this.SystemPromptFile = init.SystemPromptFile ?? "";
    this.Extra = init.Extra ?? [];
    this.Chat = init.Chat ?? false;
    this.Workspace = init.Workspace ?? false;
    this.RunnerLogin = init.RunnerLogin ?? false;
    this.AgentFile = init.AgentFile ?? "";
  }
}

/**
 * 根据 Agent CLI 类型与调用选项构造无头执行命令行参数（`CommandSpec`）；
 * 凭据绑定与私有 HOME 策略由上层调用方补充。
 *
 * @param {string} kind - Agent CLI 类型常量。
 * @param {AgentCLICommandOptions} o - 命令行构造选项。
 * @returns {CommandSpec} 含 `Argv`、`Provider` 和 `AgentCLI` 选项的命令规格。
 */
function AgentCLICommand(kind, o) {
  let binary = o.Binary.trim();
  if (binary === "") {
    binary = AgentCLIBinary(kind);
  }
  let model = o.Model.trim();
  let effort = o.Effort.trim();
  const resume = o.Resume.trim();
  let prompt = o.Prompt;
  // 对话会话首轮已写入系统提示词，续接轮次不再重复内联；SOP 每次调用都是独立进程，均需携带。
  const inline = !agentCLINativeSystemPrompt(kind) && !(o.Chat && kind === AgentCLIKimi);
  if (inline && !(o.Chat && resume !== "")) {
    prompt = AgentCLITaskPrompt(o.SystemPrompt, o.SystemPromptFile, prompt);
  }
  const extra = [...(o.Extra ?? [])];
  let argv = [];
  const readOnly = o.Chat && !o.Workspace;
  const options = new AgentCLIOptions({ Model: model, Effort: effort, ReadOnly: readOnly });
  switch (kind) {
    case AgentCLIOpenCode:
    case AgentCLIPi:
    case AgentCLIKimi:
    case AgentCLIDeepSeek:
      options.ImageInput = o.ImageInput || (o.ImagePaths ?? []).length > 0;
      break;
  }
  switch (kind) {
    case AgentCLIOpenCode:
      argv = [binary, "run", "--format", "json", "--thinking"];
      if (model !== "") {
        argv.push("-m", "agentflow/" + model);
      }
      if (resume !== "") {
        argv.push("-s", resume);
      }
      if (effort !== "") {
        argv.push("--variant", effort);
      }
      options.SystemPromptFile = o.SystemPromptFile;
      argv.push(...extra);
      if ((o.ImagePaths ?? []).length > 0) {
        for (const imgPath of o.ImagePaths) {
          argv.push("--file", imgPath);
        }
        // --file 接收数组参数，用 -- 将提示词隔离开。
        argv.push("--");
      }
      argv.push(prompt);
      break;
    case AgentCLICursor:
      // 对话模式依赖 .cursor/cli-config.json 的拒绝规则；--force 仍允许批准 MCP 工具。
      argv = [binary, "-p", "--output-format", "stream-json", "--stream-partial-output", "--trust", "--force", "--approve-mcps"];
      if (model !== "") {
        // ApplyAgentCLICredential 会在运行时根据用户凭据保存的目录重新解析该模型 ID。
        argv.push("--model", CursorModelID(model, effort, null));
      }
      if (resume !== "") {
        argv.push("--resume", resume);
      }
      argv.push(...extra, prompt);
      break;
    case AgentCLIAntigravity: {
      // 延迟 require 打破与 agy_models.js 的同包循环依赖。
      const { agyClaudeFamily, AgyAccountModelEfforts } = require("./agy_models.js");
      // 对话拒绝规则经 --settings 传入，即使启用 --dangerously-skip-permissions 依然生效。
      argv = [binary, "--output-format", "stream-json", "--dangerously-skip-permissions", "--disable-slash-commands"];
      const family = agyClaudeFamily(model);
      if (o.RunnerLogin && family !== "" && (AgyAccountModelEfforts(family) ?? []).includes(effort)) {
        model = family + "-" + effort;
        effort = "";
      }
      if (model !== "" && AgyModelEfforts(model) === null) {
        effort = "";
      }
      if (model !== "") {
        argv.push("--model", agyModelForEffort(model, effort));
      }
      if (effort !== "") {
        argv.push("--effort", effort);
      }
      if (resume !== "") {
        argv.push("--conversation", resume);
      }
      argv.push(...extra, "-p", prompt);
      break;
    }
    case AgentCLIKimi:
      argv = [binary, "--output-format", "stream-json"];
      if (resume !== "") {
        argv.push("-S", resume);
      }
      if (o.AgentFile !== "" && resume === "") {
        // 会话已记录 Agent 定义，续接轮次不能重复传入。
        argv.push("--agent-file", o.AgentFile);
      }
      argv.push(...extra, "-p", prompt);
      break;
    case AgentCLIPi: {
      let session = resume;
      if (session === "") {
        session = newAgentCLISessionID();
      }
      argv = [binary, "--mode", "json", "--session-id", session];
      if (model !== "") {
        argv.push("--model", "agentflow/" + model);
      }
      if (effort !== "") {
        argv.push("--thinking", effort);
      }
      if (o.SystemPromptFile !== "") {
        argv.push("--append-system-prompt", o.SystemPromptFile);
      }
      if (o.Chat) {
        // 省略 --tools 时 Pi 会从日志恢复上次工具集，因此在模式切换时显式重置。
        let tools = "read,codemode";
        if (o.Workspace) {
          tools = "read,bash,edit,write,codemode";
        }
        argv.push("--tools", tools);
      }
      if (readOnly) {
        argv.push("--exclude-tools", "bash,edit,write");
      }
      argv.push(...extra);
      if ((o.ImagePaths ?? []).length > 0) {
        for (const imgPath of o.ImagePaths) {
          argv.push("@" + imgPath);
        }
      }
      argv.push(prompt);
      break;
    }
    case AgentCLIDeepSeek: {
      let mode = "danger-full-access";
      if (readOnly) {
        mode = "read-only";
      }
      argv = [binary, "--profile", "headless", "--json", "--permission-mode", mode, "--approval-policy", "never"];
      if (resume !== "") {
        argv.push("--session-id", resume);
      }
      argv.push(...extra, prompt);
      break;
    }
    case AgentCLIZCode: {
      // 延迟 require 打破与 agent_cli_zcode.js 的同包循环依赖。
      const { zcodeSOPDisallowedTools, zcodeChatDisallowedTools } = require("./agent_cli_zcode.js");
      let disallowed = zcodeSOPDisallowedTools;
      if (readOnly) {
        disallowed = zcodeChatDisallowedTools;
      }
      argv = [binary, "--prompt", prompt, "--output-format", "stream-json", "--mode", "yolo", "--no-color", "--disallowed-tools", disallowed];
      if (resume !== "") {
        argv.push("--resume", resume);
      }
      for (const imgPath of o.ImagePaths ?? []) {
        argv.push("--attach", imgPath);
      }
      argv.push(...extra);
      break;
    }
  }
  return new CommandSpec({ Argv: argv, Provider: kind, AgentCLI: options });
}

/**
 * 返回 Gemini API 模型在 Antigravity 下可选的独立思考力度列表。
 *
 * @param {string} model - 模型 ID（可带或不带力度后缀）。
 * @returns {string[] | null} 支持的力度等级数组，不支持独立力度时返回 `null`。
 */
function AgyModelEfforts(model) {
  // 延迟 require 打破与 agy_models.js 的同包循环依赖。
  const { SplitAgyModelEffort } = require("./agy_models.js");
  [model] = SplitAgyModelEffort(model.trim());
  switch (model) {
    case "gemini-4-neon":
    case "gemini-4-hydrogen":
      return ["low", "medium", "high", "xhigh"];
    case "gemini-4-carbon":
    case "gemini-4-argon":
    case "gemini-3.8-flash":
    case "gemini-3.7-flash":
    case "gemini-3.6-flash":
      return ["low", "medium", "high"];
    case "gemini-3.1-pro":
    case "gemini-3.1-pro-preview":
      return ["low", "high"];
  }
  if (model.startsWith("gemini-") && !model.startsWith("gemini-pro-orchestrator")) {
    return ExecutorEffortLevels[AgentCLIAntigravity] ?? null;
  }
  return null;
}

/**
 * 将 Antigravity 模型 ID 尾部已有的思考力度后缀替换为目标力度，避免与 `--effort` 参数冲突而被 agy 拒绝。
 *
 * @param {string} model - 原始模型 ID。
 * @param {string} effort - 目标思考力度。
 * @returns {string} 对齐后缀后的模型 ID。
 */
function agyModelForEffort(model, effort) {
  if (effort === "") {
    return model;
  }
  // 延迟 require 打破与 agy_models.js 的同包循环依赖。
  const { SplitAgyModelEffort } = require("./agy_models.js");
  const [base, existing] = SplitAgyModelEffort(model);
  if (existing !== "") {
    return base + "-" + effort;
  }
  return model;
}

/** Kimi Code 在只读 AI 对话模式下需要禁用的工具列表（避免绕过 MCP 网关或派生子代理）。 */
const kimiChatDisallowedTools = [
  "Bash",
  "Edit",
  "Write",
  "FetchURL",
  "WebSearch",
  "Agent",
  "AgentSwarm",
  "CronCreate",
  "CronDelete",
  "CronList",
  "TaskOutput",
  "TaskStop",
  "WaitFor",
];

/**
 * 写入 Kimi Code 只读 AI 对话模式的 Agent 定义文件（含系统提示词与禁用工具列表）。
 *
 * @param {string} filePath - 目标文件路径（对应 Go 原参数名 `path`）。
 * @param {string} systemPrompt - 系统提示词正文。
 * @returns {void} 无返回值；写入失败时抛出 `Error`。
 */
function WriteKimiChatAgent(filePath, systemPrompt) {
  WriteKimiConversationAgent(filePath, systemPrompt, true);
}

/**
 * 写入 Kimi Code 对话模式的 Agent 定义文件，按 `readOnly` 决定是否限制危险工具。
 *
 * @param {string} filePath - 目标文件路径（对应 Go 原参数名 `path`）。
 * @param {string} systemPrompt - 系统提示词正文，为空时使用默认助手提示。
 * @param {boolean} readOnly - 是否处于只读对话模式。
 * @returns {void} 无返回值；目录创建或文件写入失败时抛出 `Error`。
 */
function WriteKimiConversationAgent(filePath, systemPrompt, readOnly) {
  let body = systemPrompt.trim();
  if (body === "") {
    body = "You are the AgentFlow assistant.";
  }
  let denied = "";
  if (readOnly) {
    denied = kimiChatDisallowedTools.join(", ");
  }
  const content =
    "---\nname: agentflow-chat\ndescription: LoopForge AI 对话\ndisallowedTools: [" +
    denied +
    "]\n---\n" +
    body +
    "\n";
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, Buffer.from(content, "utf8"), { mode: 0o600 });
}

module.exports = {
  agentCLIProvider,
  newAgentCLIProvider,
  agentCLINativeSystemPrompt,
  AgentCLITaskPrompt,
  newAgentCLISessionID,
  AgentCLICommandOptions,
  AgentCLICommand,
  AgyModelEfforts,
  agyModelForEffort,
  kimiChatDisallowedTools,
  WriteKimiChatAgent,
  WriteKimiConversationAgent,
};
