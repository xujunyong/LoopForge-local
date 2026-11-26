/**
 * @file internal/domain/agent.js
 * 对应 Go 源文件：internal/domain/agent.go
 *
 * 作用与职责边界：
 * 定义平台中可复用 Agent 角色、生命周期钩子、循环自纠策略、人工介入检查点及执行器等核心领域模型，
 * 并提供内置 CLI 思考强度（reasoning effort）映射、Agent CLI 类型判断与思考强度合法性校验。
 * 不负责资产持久化或实际 CLI 进程调度。
 *
 * 语法差异说明：
 * - Go 的 `error` 返回值转写为成功正常返回（`undefined`）、校验失败抛出 `Error`。
 * - Go `struct` 转写为带 `constructor(init = {})` 的类，字段严格按 Go 零值初始化。
 */

"use strict";

// 各内置 CLI 支持的思考强度取值列表；为空字符串时表示沿用对应 CLI 的默认配置。
const ExecutorEffortLevels = {
  "claude-code": ["low", "medium", "high", "xhigh", "max", "ultracode"],
  codebuddy: ["low", "medium", "high", "xhigh", "max", "ultracode"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
  opencode: ["low", "medium", "high"],
  cursor: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  agy: ["low", "medium", "high", "xhigh", "max"],
  kimi: ["none", "thinking", "low", "high", "max"],
  pi: ["minimal", "low", "medium", "high", "xhigh", "max"],
  dsh: ["none", "low", "high", "max"],
  zcode: ["low", "high", "max"],
};

// 除 CodeBuddy、Codex、Claude Code 之外的 Agent CLI 执行器类型列表；
// 这类 CLI 的模型与 MCP 配置位于用户私有 HOME 目录中，因此仅使用责任人的个人凭证运行。
const AgentCLIExecutorKinds = ["opencode", "cursor", "agy", "kimi", "pi", "dsh", "zcode"];

/**
 * 判断给定的执行器类型是否属于私有 HOME 配置类 Agent CLI。
 * 在凭证路由与执行器权限判定时调用（忽略首尾空白与大小写差异）。
 *
 * @param {string} kind - 执行器类型名称（如 `"cursor"`、`"codex"`）。
 * @returns {boolean} 属于 `AgentCLIExecutorKinds` 时返回 `true`，否则返回 `false`。
 */
function IsAgentCLIKind(kind) {
  kind = kind.trim();
  return AgentCLIExecutorKinds.some((k) => k.toLowerCase() === kind.toLowerCase());
}

/**
 * 按解析后的执行器类型校验角色配置的思考强度取值是否合法。
 * 在保存或校验 Agent 角色及会话参数时调用；思考强度为空时直接通过校验。
 *
 * @param {string} effort - 待校验的思考强度取值（为空表示使用默认强度）。
 * @param {string} executorKind - 对应的执行器类型名称。
 * @returns {void} 校验通过无返回值；不支持设置思考强度或取值非法时抛出 `Error`。
 */
function ValidateAgentEffort(effort, executorKind) {
  effort = effort.trim();
  if (effort === "") {
    return;
  }
  const levels = ExecutorEffortLevels[executorKind.trim()];
  if (levels === undefined) {
    throw new Error("当前 CLI 不支持设置思考强度");
  }
  if (levels.includes(effort)) {
    return;
  }
  throw new Error("思考强度取值不被当前 CLI 支持");
}

// 平台共享的基线对齐角色 ID，专用于将默认分支合并进集成基线，不得混用项目修 Bug 角色。
const BaselineAlignAgentID = "baseline-align-resolver";

// 平台内置 MCP 服务（Streamable HTTP，路径 /mcp）的保留 ID，运行时动态绑定，不落库。
const PlatformMCPServerID = "agentflow-platform";

/**
 * 表示可复用的 Agent 角色定义。
 * 包含提示词、绑定的规则/技能/MCP 服务、生命周期钩子、执行器配置、循环自纠策略、人工检查点与产物验收契约，
 * 用于目录管理以及工作流节点运行时装配。
 */
class AgentDefinition {
  /**
   * 构造并初始化 Agent 角色定义实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Version = init.Version ?? 0;
    this.ProjectID = init.ProjectID ?? "";
    this.Shared = init.Shared ?? false;
    this.Description = init.Description ?? "";
    this.Prompt = init.Prompt ?? "";
    this.Rules = init.Rules ?? [];
    this.Skills = init.Skills ?? [];
    this.MCPServers = init.MCPServers ?? [];
    this.PlatformMCP = init.PlatformMCP ?? false;
    this.KnowledgeBase = init.KnowledgeBase ?? false;
    this.Hooks = init.Hooks ?? [];
    this.ExecutorID = init.ExecutorID ?? "";
    this.Model = init.Model ?? "";
    this.Effort = init.Effort ?? "";
    this.Loop = init.Loop ?? new AgentLoopPolicy();
    this.Interventions = init.Interventions ?? [];
    this.ArtifactOutputs = init.ArtifactOutputs ?? [];
    this.Verification = init.Verification ?? [];
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

/**
 * 表示角色级别的生命周期钩子脚本。
 * 运行时会将通用事件子集编译为 Claude Code、Codex 或 CodeBuddy 的原生钩子配置，仅在当前角色调用期间生效。
 */
class AgentHook {
  /**
   * 构造并初始化角色生命周期钩子实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Event = init.Event ?? "";
    this.Matcher = init.Matcher ?? "";
    this.Language = init.Language ?? "";
    this.Script = init.Script ?? "";
    this.TimeoutSec = init.TimeoutSec ?? 0;
    this.ExecutionScope = init.ExecutionScope ?? "";
  }
}

/**
 * 表示归属于 Agent 角色的循环自纠策略。
 * 控制单次角色调用在同一个沙箱工作区内的最大迭代次数、退出条件、耗尽后动作与反馈提示词。
 */
class AgentLoopPolicy {
  /**
   * 构造并初始化循环自纠策略实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Enabled = init.Enabled ?? false;
    this.MaxIterations = init.MaxIterations ?? 0;
    this.ExitCondition = init.ExitCondition ?? "";
    this.OnExhausted = init.OnExhausted ?? "";
    this.FeedbackPrompt = init.FeedbackPrompt ?? "";
  }
}

/**
 * 表示归属于 Agent 角色的可复用人工介入检查点声明。
 * 引擎在指定执行阶段（如执行后、发布前）依据该声明决定是否暂停等待人工确认。
 */
class HumanInterventionPoint {
  /**
   * 构造并初始化人工介入检查点实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Stage = init.Stage ?? "";
    this.Required = init.Required ?? false;
    this.Instructions = init.Instructions ?? "";
  }
}

/**
 * 表示底层 CLI 执行器资产定义。
 * 描述执行器种类、可执行程序路径、默认启动参数、通信协议以及默认模型与思考强度。
 */
class ExecutorDefinition {
  /**
   * 构造并初始化执行器定义实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Kind = init.Kind ?? "";
    this.Binary = init.Binary ?? "";
    this.Args = init.Args ?? [];
    this.Protocol = init.Protocol ?? "";
    this.Model = init.Model ?? "";
    this.Effort = init.Effort ?? "";
  }
}

module.exports = { ExecutorEffortLevels, AgentCLIExecutorKinds, IsAgentCLIKind, ValidateAgentEffort, BaselineAlignAgentID, PlatformMCPServerID, AgentDefinition, AgentHook, AgentLoopPolicy, HumanInterventionPoint, ExecutorDefinition };
