// agent.js —— 对应 Go 文件：internal/domain/agent.go
// 作用：角色、执行器与思考强度等 Agent 资产定义及校验。

"use strict";

// ExecutorEffortLevels：各内置 CLI 可用的思考强度，空值用 CLI 默认。
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

// AgentCLIExecutorKinds：CodeBuddy / Codex / Claude Code 之外的 Agent CLI。
const AgentCLIExecutorKinds = ["opencode", "cursor", "agy", "kimi", "pi", "dsh", "zcode"];

function IsAgentCLIKind(kind) {
  kind = kind.trim();
  return AgentCLIExecutorKinds.some((k) => k.toLowerCase() === kind.toLowerCase());
}

// ValidateAgentEffort：按执行器种类校验角色的思考强度取值。
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

// BaselineAlignAgentID：只把默认分支合并进集成基线的平台共享角色。
const BaselineAlignAgentID = "baseline-align-resolver";

// PlatformMCPServerID：AgentFlow 自身平台 MCP 服务器的保留 id。
const PlatformMCPServerID = "agentflow-platform";

class AgentDefinition {
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

// AgentHook：角色级生命周期脚本。
class AgentHook {
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

// AgentLoopPolicy：归属可复用 Agent 角色的循环自纠策略。
class AgentLoopPolicy {
  constructor(init = {}) {
    this.Enabled = init.Enabled ?? false;
    this.MaxIterations = init.MaxIterations ?? 0;
    this.ExitCondition = init.ExitCondition ?? "";
    this.OnExhausted = init.OnExhausted ?? "";
    this.FeedbackPrompt = init.FeedbackPrompt ?? "";
  }
}

// HumanInterventionPoint：归属 Agent 的可复用检查点声明。
class HumanInterventionPoint {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Stage = init.Stage ?? "";
    this.Required = init.Required ?? false;
    this.Instructions = init.Instructions ?? "";
  }
}

class ExecutorDefinition {
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
