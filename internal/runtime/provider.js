"use strict";

/**
 * @file internal/runtime/provider.js
 * @description 对应 Go 源文件 `internal/runtime/provider.go`。
 * 定义各执行器 Provider 的公共基类、沙箱需求声明与合并逻辑、命令行参数与超长提示词处理
 * （`PromptFitsArgv` / `PromptOnStdin`），以及按执行器类型查找 Provider 的注册表。
 *
 * Go -> JS 语法与结构差异说明：
 * - `in` 为 JS 关键字，方法参数 `in providerInvocation` 局部改名为 `inv`。
 * - Go 多返回值 `(string, bool, error)` 按规范译为成功返回 `[string, boolean]`、失败抛出 `Error`。
 * - 为避免与继承 `baseProvider` 的各具体 Provider 文件产生加载期循环依赖，`providers` 注册表在 `providerForKind` 首次调用时延迟初始化。
 */

const { Readable } = require("stream");
const { CommandSpec, InvocationOptions } = require("./runtime.js"); // 待翻译
const { compiledConfig } = require("./materialize.js"); // 待翻译
const { hasArg } = require("./runner.js"); // 待翻译
const { makeProtocolAdapter, protocolGeneric } = require("./protocol.js");
const { AgentCLIKinds } = require("./agent_cli.js");

/**
 * 描述某个 Provider 在创建 Run 沙箱前所需的宿主机状态目录与运行时特性。
 */
class SandboxRequirements {
  /**
   * 构造沙箱需求声明对象。
   *
   * @param {object} [init={}] - 初始化字段。
   * @param {string} [init.ConversationRoot=""] - 原生 CLI 私有持久化状态目录。
   * @param {CLIStateRequirement[]} [init.CLIStates=[]] - 需要挂载或同步的 CLI 状态目录列表。
   * @param {boolean} [init.PrivateHome=false] - 是否需要为执行器分配独立私有 HOME 目录。
   * @param {boolean} [init.BunFS=false] - 是否需要 Bun 文件系统支持。
   * @param {boolean} [init.RunnerLoginRelay=false] - 是否允许 Docker 内 Codex 账号登录中继到宿主机刷新监听。
   */
  constructor(init = {}) {
    this.ConversationRoot = init.ConversationRoot ?? "";
    this.CLIStates = init.CLIStates ?? [];
    this.PrivateHome = init.PrivateHome ?? false;
    this.BunFS = init.BunFS ?? false;
    this.RunnerLoginRelay = init.RunnerLoginRelay ?? false;
  }
}

/**
 * 描述单个 CLI 工具需要保留或挂载的状态目录及其文件列表。
 */
class CLIStateRequirement {
  /**
   * 构造 CLI 状态需求对象。
   *
   * @param {object} [init={}] - 初始化字段。
   * @param {string} [init.Directory=""] - 状态目录相对路径。
   * @param {string[]} [init.Files=[]] - 需关注的状态文件名列表。
   */
  constructor(init = {}) {
    this.Directory = init.Directory ?? "";
    this.Files = init.Files ?? [];
  }
}

/**
 * Provider 物化配置阶段所需的上下文信息。
 * 对应 Go `providerMaterializeContext`。
 */
class providerMaterializeContext {
  /**
   * 构造物化上下文对象。
   *
   * @param {object} [init={}] - 初始化字段。
   */
  constructor(init = {}) {
    this.Workspace = init.Workspace ?? "";
    this.AgentID = init.AgentID ?? "";
    this.AgentRel = init.AgentRel ?? "";
    this.RuntimeRel = init.RuntimeRel ?? "";
    this.ConfigRoot = init.ConfigRoot ?? "";
    this.AgentRoot = init.AgentRoot ?? "";
    this.Content = init.Content ?? null;
    this.SkillPaths = init.SkillPaths ?? [];
    this.MCPServers = init.MCPServers ?? [];
    this.Assets = init.Assets ?? null;
    this.Compiled = init.Compiled ?? null;
  }
}

/**
 * Provider 构造命令规格（`Prepare`）时的完整调用入参。
 * 对应 Go `providerInvocation`。
 */
class providerInvocation {
  /**
   * 构造调用入参对象。
   *
   * @param {object} [init={}] - 初始化字段。
   */
  constructor(init = {}) {
    this.Executor = init.Executor ?? {};
    this.Compiled = init.Compiled ?? new compiledConfig();
    this.Prompt = init.Prompt ?? "";
    this.PromptFile = init.PromptFile ?? "";
    this.Driver = init.Driver ?? "";
    this.Options = init.Options ?? new InvocationOptions();
  }
}

/**
 * Provider 默认基类，封装按执行器类型差异化行为的公共默认实现。
 * 对应 Go `baseProvider`（同时承载 Go `Provider` 接口的默认方法集）。
 */
class baseProvider {
  /**
   * 构造 Provider 基类实例。
   *
   * @param {object} [init={}] - 初始化字段。
   * @param {string} [init.kind=""] - 执行器类型标识。
   * @param {number} [init.parser=0] - 协议解析器类型常量。
   * @param {string} [init.adapter=""] - 协议适配器 ID。
   */
  constructor(init = {}) {
    this.kind = init.kind ?? "";
    this.parser = init.parser ?? 0;
    this.adapter = init.adapter ?? "";
  }

  /**
   * 返回当前 Provider 对应的执行器类型标识。
   *
   * @returns {string} 执行器类型标识。
   */
  Kind() {
    return this.kind;
  }

  /**
   * 默认物化钩子：不做任何操作直接返回。
   *
   * @param {providerMaterializeContext} _ctx - 物化上下文。
   * @returns {void} 无返回值。
   */
  Materialize(_ctx) {
    return;
  }

  /**
   * 按默认规则构建执行器命令行规格，将提示词作为末尾位置参数传入。
   *
   * @param {providerInvocation} inv - 调用入参（对应 Go 原参数名 `in`）。
   * @returns {CommandSpec} 构建好的命令规格。
   */
  Prepare(inv) {
    return new CommandSpec({
      Argv: [...buildProviderArgs(inv), positionalPrompt(inv)],
      Provider: this.Kind(),
      PrivateHome: this.SandboxRequirements().PrivateHome,
    });
  }

  /**
   * 为指定执行器创建对应的协议适配器。
   *
   * @param {object} ex - 执行器定义（`domain.ExecutorDefinition`）。
   * @param {((event: object) => void) | null} sink - 遥测事件接收回调。
   * @returns {object} 协议适配器实例（`protocolAdapter`）。
   */
  Protocol(ex, sink) {
    return makeProtocolAdapter(ex, sink, this.parser, this.adapter);
  }

  /**
   * 返回默认的空沙箱需求。
   *
   * @returns {SandboxRequirements} 空沙箱需求对象。
   */
  SandboxRequirements() {
    return new SandboxRequirements();
  }

  /**
   * 默认内置执行钩子：表示当前 Provider 不接管内置执行。
   *
   * @param {AbortSignal | null} _signal - 取消信号（对应 Go `context.Context`）。
   * @param {object} _agent - Agent 定义。
   * @param {string} _prompt - 提示词。
   * @param {((event: object) => void) | null} _sink - 遥测事件接收回调。
   * @returns {[string, boolean]} 固定返回 `["", false]`。
   */
  RunBuiltin(_signal, _agent, _prompt, _sink) {
    return ["", false];
  }

  /**
   * 默认观测启动钩子：返回空取消函数。
   *
   * @param {AbortSignal | null} _signal - 取消信号。
   * @param {compiledConfig} _compiled - 编译后的运行配置。
   * @param {((event: object) => void) | null} _sink - 遥测事件接收回调。
   * @returns {() => void} 无操作的取消函数。
   */
  StartObservation(_signal, _compiled, _sink) {
    return () => {};
  }

  /**
   * 返回由 Provider 自身提供的系统级钩子列表（默认无）。
   *
   * @returns {object[] | null} 系统级钩子数组或 `null`。
   */
  SystemHooks() {
    return null;
  }
}

/**
 * 组装执行器基础命令行参数：二进制名、执行器静态参数、编译产物参数，以及未显式指定时的 `--model`。
 *
 * @param {providerInvocation} inv - 调用入参（对应 Go 原参数名 `in`）。
 * @returns {string[]} 组装后的参数数组。
 */
function buildProviderArgs(inv) {
  const argv = [inv.Executor.Binary, ...(inv.Executor.Args ?? []), ...(inv.Compiled.Args ?? [])];
  if (inv.Executor.Model !== "" && !hasArg(argv, "--model")) {
    argv.push("--model", inv.Executor.Model);
  }
  return argv;
}

/**
 * 为 Claude Code 和 CodeBuddy 注入原生 `--effort` 参数（若未已指定且非空）。
 * Codex 在自身 `Prepare` 中通过 `-c` 配置覆盖表达思考力度，因此本函数仅用于 Claude/CodeBuddy。
 *
 * @param {string[]} argv - 现有命令行参数数组。
 * @param {string} effort - 期望的思考力度等级。
 * @returns {string[]} 可能追加了 `--effort` 的参数数组。
 */
function appendEffortArgs(argv, effort) {
  effort = effort.trim();
  if (effort === "" || hasArg(argv, "--effort")) {
    return argv;
  }
  return [...argv, "--effort", effort];
}

/**
 * 单条命令行位置提示词的字节上限（96 KiB），低于 Linux `MAX_ARG_STRLEN`（约 128 KiB）。
 * 常规节点任务书继续走 argv 以保持既有 SOP 行为。
 */
const maxArgvPromptBytes = 96 << 10;

/**
 * 判断给定字节长度的提示词是否安全处于平台单参数长度上限以内。
 *
 * @param {number} bytes - 提示词 UTF-8 字节数。
 * @returns {boolean} 未超出上限返回 `true`，否则返回 `false`。
 */
function PromptFitsArgv(bytes) {
  return bytes <= maxArgvPromptBytes;
}

/**
 * 计算位置参数形式的提示词；当提示词超过上限且存在任务书文件时，改为引导执行器阅读该文件。
 *
 * @param {providerInvocation} inv - 调用入参（对应 Go 原参数名 `in`）。
 * @returns {string} 最终传入位置参数的提示词文本。
 */
function positionalPrompt(inv) {
  const rel = inv.PromptFile.trim();
  if (rel !== "" && Buffer.byteLength(inv.Prompt, "utf8") > maxArgvPromptBytes) {
    return "执行系统提示中的「本次节点任务书」（完整正文也在 `" + rel + "`）。不要等待更多输入。";
  }
  return inv.Prompt;
}

/**
 * 当末尾位置提示词超过 `MAX_ARG_STRLEN` 安全阈值时，将其移至标准输入（`Stdin`）以避免触发 `E2BIG`。
 * 仅改写以 `"--", prompt` 结尾的命令，保留 `"--"` 终止符以便调用方后续追加标志位；短提示词保持原样。
 *
 * @param {CommandSpec} command - 原始命令规格。
 * @param {string} prompt - 提示词正文。
 * @returns {CommandSpec} 可能已改写为经 `Stdin` 传递提示词的命令规格。
 */
function PromptOnStdin(command, prompt) {
  const n = command.Argv.length;
  if (
    PromptFitsArgv(Buffer.byteLength(prompt, "utf8")) ||
    command.Stdin !== null ||
    n < 3 ||
    command.Argv[n - 1] !== prompt ||
    command.Argv[n - 2] !== "--"
  ) {
    return command;
  }
  const updated = new CommandSpec(command);
  updated.Argv = command.Argv.slice(0, n - 1);
  updated.Stdin = Readable.from([prompt]);
  return updated;
}

/** 已注册的执行器 Provider 映射表，首次查询时按 Go 包初始化顺序延迟填充。 */
const providers = {};
let providersInitialized = false;

/**
 * 根据执行器类型查找已注册的 Provider；未命中时回退到通用 JSON 协议的 `baseProvider`。
 *
 * @param {string} kind - 执行器类型名称。
 * @returns {baseProvider} 匹配的 Provider 实例。
 */
function providerForKind(kind) {
  if (!providersInitialized) {
    // 延迟 require 打破与各具体 provider_*.js 的同包循环依赖。
    const { claudeProvider } = require("./provider_claude.js"); // 待翻译
    const { codeBuddyProvider } = require("./provider_codebuddy.js"); // 待翻译
    const { codexProvider } = require("./provider_codex.js"); // 待翻译
    const { mockProvider } = require("./provider_mock.js"); // 待翻译
    const { newAgentCLIProvider } = require("./provider_agentcli.js");
    providers["claude-code"] = new claudeProvider();
    providers["codebuddy"] = new codeBuddyProvider();
    providers["codex"] = new codexProvider();
    providers["mock"] = new mockProvider();
    for (const agentKind of AgentCLIKinds) {
      providers[agentKind] = newAgentCLIProvider(agentKind);
    }
    providersInitialized = true;
  }
  const provider = providers[kind.trim()] ?? null;
  if (provider !== null) {
    return provider;
  }
  return new baseProvider({ kind, parser: protocolGeneric, adapter: "generic-json-v1" });
}

/**
 * 合并多个沙箱需求声明：布尔特性按逻辑或合并，`CLIStates` 按目录名去重保序。
 *
 * @param {...SandboxRequirements} values - 待合并的沙箱需求列表。
 * @returns {SandboxRequirements} 合并后的沙箱需求对象。
 */
function MergeSandboxRequirements(...values) {
  const merged = new SandboxRequirements();
  const seen = {};
  for (const value of values) {
    merged.BunFS = merged.BunFS || value.BunFS;
    merged.RunnerLoginRelay = merged.RunnerLoginRelay || value.RunnerLoginRelay;
    const states = [...(value.CLIStates ?? [])];
    for (const state of states) {
      if (state.Directory === "" || seen[state.Directory]) {
        continue;
      }
      seen[state.Directory] = true;
      merged.CLIStates.push(state);
    }
  }
  return merged;
}

/**
 * 查询指定执行器类型的沙箱需求声明。
 *
 * @param {string} kind - 执行器类型名称。
 * @returns {SandboxRequirements} 对应的沙箱需求对象。
 */
function ProviderRequirements(kind) {
  return providerForKind(kind).SandboxRequirements();
}

/**
 * 面向控制面非工作流节点调用方，复用相同的 Provider 参数构造与凭据绑定策略生成命令规格。
 *
 * @param {object} executor - 执行器定义（`domain.ExecutorDefinition`）。
 * @param {string} prompt - 提示词正文。
 * @param {string} driver - 沙箱驱动名称。
 * @param {InvocationOptions} options - 调用选项。
 * @returns {CommandSpec} 构建好的命令规格；失败时抛出 `Error`。
 */
function PrepareProviderCommand(executor, prompt, driver, options) {
  const execCopy = { ...executor };
  if (execCopy.Model === "default") {
    execCopy.Model = "";
  }
  return providerForKind(execCopy.Kind).Prepare(
    new providerInvocation({
      Executor: execCopy,
      Prompt: prompt,
      Driver: driver,
      Options: options,
    })
  );
}

module.exports = {
  SandboxRequirements,
  CLIStateRequirement,
  providerMaterializeContext,
  providerInvocation,
  baseProvider,
  buildProviderArgs,
  appendEffortArgs,
  maxArgvPromptBytes,
  PromptFitsArgv,
  positionalPrompt,
  PromptOnStdin,
  providerForKind,
  MergeSandboxRequirements,
  ProviderRequirements,
  PrepareProviderCommand,
};
