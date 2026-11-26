/**
 * @file internal/domain/run_eval.js
 * @description 对应 Go 源文件：internal/domain/run_eval.go
 * 职责边界：定义运行质量评估的策略、默认维度、运行事实摘要、可编辑目录快照、评估发现与改进建议、加权评分算法及终态运行状态判断。
 * 语法差异说明：
 * - Go 的 `(int, map[string]int, error)` 返回译为成功返回 `[score, clean]` 二元数组、失败 `throw`。
 * - Go 的整数除法 `(weighted + totalWeight/2) / totalWeight` 使用 `Math.trunc` 保持一致。
 * - Go 的 `time.Time` / `*time.Time` 对应 JS 的 `Date | null`（零值为 `null`）。
 * - 为避免与 `run.js` 发生循环引用，`RunEvalNodeFact` 与 `RunEvalFacts` 构造函数内延迟引入 `TokenUsage`。
 */

"use strict";

const RunEvalRunning = "running";
const RunEvalSucceeded = "succeeded";
const RunEvalFailed = "failed";

const RunEvalRecPending = "pending";
const RunEvalRecApplied = "applied";

const RunEvalPolicyVersion = 1;

/**
 * 运行质量评估中的单个评分维度定义。
 */
class RunEvalDimension {
  /**
   * 构造评估维度实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - 维度唯一标识（如 control、latency）。
   * @param {string} [init.Name=""] - 维度展示名称。
   * @param {string} [init.Question=""] - 引导评审模型打分的评估问题说明。
   * @param {number} [init.Weight=0] - 维度在加权总分中的权重。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Question = init.Question ?? "";
    this.Weight = init.Weight ?? 0;
  }
}

/**
 * 项目级运行质量评估策略。
 * 控制是否开启自动评估、通过分数线及各评估维度配置。
 */
class RunEvalPolicy {
  /**
   * 构造评估策略实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {boolean} [init.Enabled=false] - 是否启用运行质量评估。
   * @param {number} [init.Version=0] - 策略版本号。
   * @param {number} [init.Threshold=0] - 评估通过的最低总分阈值。
   * @param {RunEvalDimension[]} [init.Dimensions=[]] - 评估维度列表。
   */
  constructor(init = {}) {
    this.Enabled = init.Enabled ?? false;
    this.Version = init.Version ?? 0;
    this.Threshold = init.Threshold ?? 0;
    this.Dimensions = init.Dimensions ?? [];
  }

  /**
   * 判断该评估策略是否为未配置的零值状态。
   *
   * @returns {boolean} 策略未启用且阈值、版本、维度均为空时返回 `true`，否则返回 `false`。
   */
  IsZero() {
    return !this.Enabled && this.Threshold === 0 && this.Version === 0 && this.Dimensions.length === 0;
  }
}

/**
 * 返回平台内置的默认运行评估策略（6 个核心维度，总权重 100，通过阈值 70）。
 *
 * @returns {RunEvalPolicy} 默认评估策略实例。
 */
function DefaultRunEvalPolicy() {
  return new RunEvalPolicy({
    Enabled: true,
    Version: RunEvalPolicyVersion,
    Threshold: 70,
    Dimensions: [
      new RunEvalDimension({ ID: "control", Name: "控制流健康", Question: "节点是否多次循环、返工或 A→B→A 打回？attempt/rework 是否超过节点上限？", Weight: 25 }),
      new RunEvalDimension({ ID: "latency", Name: "耗时与等待", Question: "单节点是否占了大部分执行时间？墙钟是否远大于实际执行（空转/排队）？", Weight: 20 }),
      new RunEvalDimension({ ID: "tools", Name: "工具浪费", Question: "是否有同工具连续失败、重复 Read/Grep 无进展、或无产物的空转调用？", Weight: 20 }),
      new RunEvalDimension({ ID: "tokens", Name: "Token 效率", Question: "Token 是否集中在单一节点？缓存命中是否过低且输入很大？", Weight: 15 }),
      new RunEvalDimension({ ID: "recovery", Name: "错误恢复", Question: "相同错误是否反复出现？门禁是否多次失败才过？失败后有没有有效变化？", Weight: 10 }),
      new RunEvalDimension({ ID: "delivery", Name: "交付完整", Question: "终态是否成功？预期产物和 verification/delivery 信号是否齐全？", Weight: 10 }),
    ],
  });
}

/**
 * 基于输入策略补全缺省维度、阈值与版本号，并确保 `Enabled` 为 `true`，返回可直接用于评估的有效策略。
 *
 * @param {RunEvalPolicy} p - 原始评估策略。
 * @returns {RunEvalPolicy} 补全默认值后的有效评估策略。
 */
function EffectiveRunEvalPolicy(p) {
  p = new RunEvalPolicy(p);
  if (p.IsZero()) {
    return DefaultRunEvalPolicy();
  }
  if (p.Dimensions.length === 0) {
    p.Dimensions = DefaultRunEvalPolicy().Dimensions;
  }
  if (p.Threshold <= 0) {
    p.Threshold = DefaultRunEvalPolicy().Threshold;
  }
  if (p.Version === 0) {
    p.Version = RunEvalPolicyVersion;
  }
  p.Enabled = true;
  return p;
}

/**
 * 供运行评估模型阅读的单节点执行事实摘要。
 */
class RunEvalNodeFact {
  /**
   * 构造节点评估事实实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.NodeID=""] - 节点 ID。
   * @param {string} [init.Name=""] - 节点名称。
   * @param {string} [init.Type=""] - 节点类型。
   * @param {string} [init.Status=""] - 节点终态。
   * @param {number} [init.Attempt=0] - 实际尝试次数。
   * @param {number} [init.ReworkCount=0] - 实际返工次数。
   * @param {number} [init.MaxAttempts=0] - 节点配置的最大尝试上限。
   * @param {number} [init.MaxReworks=0] - 节点配置的最大返工上限。
   * @param {number} [init.ToolCalls=0] - 工具调用次数。
   * @param {number} [init.DurationMs=0] - 节点执行耗时（毫秒）。
   * @param {object} [init.Usage] - 节点 Token 用量（TokenUsage）。
   * @param {string} [init.Error=""] - 节点错误摘要。
   * @param {number} [init.Lifecycle=0] - 生命周期启动事件计数。
   * @param {number} [init.Artifacts=0] - 产出产物数量。
   * @param {number} [init.Verification=0] - 核查类事件计数。
   * @param {string} [init.AgentID=""] - 绑定的 Agent ID。
   */
  constructor(init = {}) {
    const { TokenUsage } = require("./run.js");
    this.NodeID = init.NodeID ?? "";
    this.Name = init.Name ?? "";
    this.Type = init.Type ?? "";
    this.Status = init.Status ?? "";
    this.Attempt = init.Attempt ?? 0;
    this.ReworkCount = init.ReworkCount ?? 0;
    this.MaxAttempts = init.MaxAttempts ?? 0;
    this.MaxReworks = init.MaxReworks ?? 0;
    this.ToolCalls = init.ToolCalls ?? 0;
    this.DurationMs = init.DurationMs ?? 0;
    this.Usage = init.Usage ?? new TokenUsage();
    this.Error = init.Error ?? "";
    this.Lifecycle = init.Lifecycle ?? 0;
    this.Artifacts = init.Artifacts ?? 0;
    this.Verification = init.Verification ?? 0;
    this.AgentID = init.AgentID ?? "";
  }
}

/**
 * 同一节点上重复调用同一工具的统计事实。
 */
class RunEvalToolRepeat {
  /**
   * 构造工具重复调用事实实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.NodeID=""] - 所属节点 ID。
   * @param {string} [init.Tool=""] - 工具名称。
   * @param {number} [init.Count=0] - 重复调用总次数。
   * @param {number} [init.Failed=0] - 其中失败的次数。
   */
  constructor(init = {}) {
    this.NodeID = init.NodeID ?? "";
    this.Tool = init.Tool ?? "";
    this.Count = init.Count ?? 0;
    this.Failed = init.Failed ?? 0;
  }
}

/**
 * 运行中反复出现的相同错误文本统计事实。
 */
class RunEvalErrorFact {
  /**
   * 构造重复错误事实实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.NodeID=""] - 所属节点 ID。
   * @param {string} [init.Text=""] - 归一化后的错误文本。
   * @param {number} [init.Count=0] - 重复出现次数。
   */
  constructor(init = {}) {
    this.NodeID = init.NodeID ?? "";
    this.Text = init.Text ?? "";
    this.Count = init.Count ?? 0;
  }
}

/**
 * 评估输入摘要中的精简关键事件条目。
 */
class RunEvalDigestEvent {
  /**
   * 构造摘要事件实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {number} [init.Sequence=0] - 原始遥测序号。
   * @param {string} [init.Time=""] - 格式化时间戳字符串。
   * @param {string} [init.NodeID=""] - 关联节点 ID。
   * @param {string} [init.Category=""] - 事件分类。
   * @param {string} [init.Name=""] - 事件名称。
   * @param {string} [init.Phase=""] - 事件阶段。
   * @param {string} [init.Tool=""] - 工具名称（如有）。
   * @param {string} [init.Message=""] - 事件摘要消息。
   * @param {string} [init.Error=""] - 错误信息（如有）。
   */
  constructor(init = {}) {
    this.Sequence = init.Sequence ?? 0;
    this.Time = init.Time ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Category = init.Category ?? "";
    this.Name = init.Name ?? "";
    this.Phase = init.Phase ?? "";
    this.Tool = init.Tool ?? "";
    this.Message = init.Message ?? "";
    this.Error = init.Error ?? "";
  }
}

/**
 * 汇总一次运行全部客观指标、异常模式与可编辑目录的评估事实包。
 */
class RunEvalFacts {
  /**
   * 构造运行评估事实包实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.RunID=""] - 运行 ID。
   * @param {string} [init.WorkflowID=""] - 工作流 ID。
   * @param {string} [init.WorkflowName=""] - 工作流名称。
   * @param {string} [init.Status=""] - 运行终态。
   * @param {string} [init.Input=""] - 运行输入摘要。
   * @param {string} [init.ProjectID=""] - 所属项目 ID。
   * @param {number} [init.WallDurationMs=0] - 墙钟总耗时（毫秒）。
   * @param {number} [init.ExecDurationMs=0] - 实际执行耗时（毫秒）。
   * @param {object} [init.Usage] - 累计 Token 用量（TokenUsage）。
   * @param {number} [init.ToolCalls=0] - 累计工具调用次数。
   * @param {number} [init.ArtifactCount=0] - 产物数量。
   * @param {number} [init.EventCount=0] - 运行事件总数。
   * @param {number} [init.TelemetryCount=0] - 遥测事件总数。
   * @param {RunEvalNodeFact[]} [init.Nodes=[]] - 各节点事实列表。
   * @param {RunEvalToolRepeat[]} [init.ToolRepeats=[]] - 工具重复调用事实列表。
   * @param {RunEvalErrorFact[]} [init.Errors=[]] - 重复错误事实列表。
   * @param {string[]} [init.PingPong=[]] - 检测到的节点往复打回链路描述。
   * @param {Object.<string, number>} [init.EventTypes={}] - 各类事件计数映射。
   * @param {RunEvalDigestEvent[]} [init.Digest=[]] - 关键事件摘要时间线。
   * @param {RunEvalCatalog} [init.EditableCatalog] - 评估建议允许修改的目录快照。
   */
  constructor(init = {}) {
    const { TokenUsage } = require("./run.js");
    this.RunID = init.RunID ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.WorkflowName = init.WorkflowName ?? "";
    this.Status = init.Status ?? "";
    this.Input = init.Input ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.WallDurationMs = init.WallDurationMs ?? 0;
    this.ExecDurationMs = init.ExecDurationMs ?? 0;
    this.Usage = init.Usage ?? new TokenUsage();
    this.ToolCalls = init.ToolCalls ?? 0;
    this.ArtifactCount = init.ArtifactCount ?? 0;
    this.EventCount = init.EventCount ?? 0;
    this.TelemetryCount = init.TelemetryCount ?? 0;
    this.Nodes = init.Nodes ?? [];
    this.ToolRepeats = init.ToolRepeats ?? [];
    this.Errors = init.Errors ?? [];
    this.PingPong = init.PingPong ?? [];
    this.EventTypes = init.EventTypes ?? {};
    this.Digest = init.Digest ?? [];
    this.EditableCatalog = init.EditableCatalog ?? new RunEvalCatalog();
  }
}

/**
 * 允许改进建议作用的工作流与 Agent 目录快照。
 */
class RunEvalCatalog {
  /**
   * 构造评估可编辑目录快照实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.WorkflowID=""] - 工作流 ID。
   * @param {boolean} [init.Generic=false] - 是否为平台通用模板。
   * @param {RunEvalCatalogNode[]} [init.Nodes=[]] - 工作流节点摘要列表。
   * @param {RunEvalCatalogAgent[]} [init.Agents=[]] - 关联 Agent 摘要列表。
   */
  constructor(init = {}) {
    this.WorkflowID = init.WorkflowID ?? "";
    this.Generic = init.Generic ?? false;
    this.Nodes = init.Nodes ?? [];
    this.Agents = init.Agents ?? [];
  }
}

/**
 * 评估可编辑目录中的单个工作流节点摘要。
 */
class RunEvalCatalogNode {
  /**
   * 构造目录节点摘要实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - 节点 ID。
   * @param {string} [init.Name=""] - 节点名称。
   * @param {string} [init.Type=""] - 节点类型。
   * @param {string} [init.AgentID=""] - 绑定的 Agent ID。
   * @param {number} [init.MaxAttempts=0] - 最大尝试次数。
   * @param {number} [init.MaxReworks=0] - 最大返工次数。
   * @param {string} [init.OnFailure=""] - 失败策略。
   * @param {string} [init.RetryStrategy=""] - 重试策略。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Type = init.Type ?? "";
    this.AgentID = init.AgentID ?? "";
    this.MaxAttempts = init.MaxAttempts ?? 0;
    this.MaxReworks = init.MaxReworks ?? 0;
    this.OnFailure = init.OnFailure ?? "";
    this.RetryStrategy = init.RetryStrategy ?? "";
  }
}

/**
 * 评估可编辑目录中的单个 Agent 摘要。
 */
class RunEvalCatalogAgent {
  /**
   * 构造目录 Agent 摘要实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - Agent ID。
   * @param {string} [init.Name=""] - Agent 名称。
   * @param {string} [init.ProjectID=""] - 所属项目 ID。
   * @param {boolean} [init.Shared=false] - 是否为跨项目共享 Agent。
   * @param {string} [init.Prompt=""] - 系统提示词。
   * @param {object[]} [init.Verification=[]] - 核查门列表（VerificationGate[]）。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Shared = init.Shared ?? false;
    this.Prompt = init.Prompt ?? "";
    this.Verification = init.Verification ?? [];
  }
}

/**
 * 运行质量评估发现的单条问题记录。
 */
class RunEvalFinding {
  /**
   * 构造评估发现实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.Severity=""] - 问题严重程度。
   * @param {string} [init.Dimension=""] - 所属评估维度 ID。
   * @param {string} [init.NodeID=""] - 关联节点 ID。
   * @param {string} [init.RuleID=""] - 触发规则标识。
   * @param {string} [init.Message=""] - 问题描述。
   * @param {string} [init.Evidence=""] - 佐证证据摘录。
   */
  constructor(init = {}) {
    this.Severity = init.Severity ?? "";
    this.Dimension = init.Dimension ?? "";
    this.NodeID = init.NodeID ?? "";
    this.RuleID = init.RuleID ?? "";
    this.Message = init.Message ?? "";
    this.Evidence = init.Evidence ?? "";
  }
}

/**
 * 针对工作流节点或 Agent 配置的一条可一键应用改进建议。
 */
class RunEvalRecommendation {
  /**
   * 构造改进建议实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - 建议唯一 ID。
   * @param {string} [init.Title=""] - 建议标题。
   * @param {string} [init.Rationale=""] - 改进理由说明。
   * @param {string} [init.Target=""] - 目标资源类型（workflow 或 agent）。
   * @param {string} [init.TargetID=""] - 目标资源 ID。
   * @param {string} [init.Action=""] - 建议执行的变更动作。
   * @param {string} [init.NodeID=""] - 目标节点 ID。
   * @param {Object.<string, *>} [init.Set={}] - 待更新的字段键值集合。
   * @param {object|null} [init.Gate=null] - 待增改的核查门定义（VerificationGate）。
   * @param {string} [init.Text=""] - 待追加的指令或提示词文本。
   * @param {string} [init.Status=""] - 建议应用状态（pending 或 applied）。
   * @param {Date|null} [init.AppliedAt=null] - 应用时间。
   * @param {string} [init.AppliedTargetID=""] - 实际生效的目标资源 ID。
   * @param {string} [init.ApplyError=""] - 应用失败原因。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Title = init.Title ?? "";
    this.Rationale = init.Rationale ?? "";
    this.Target = init.Target ?? "";
    this.TargetID = init.TargetID ?? "";
    this.Action = init.Action ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Set = init.Set ?? {};
    this.Gate = init.Gate ?? null;
    this.Text = init.Text ?? "";
    this.Status = init.Status ?? "";
    this.AppliedAt = init.AppliedAt ?? null;
    this.AppliedTargetID = init.AppliedTargetID ?? "";
    this.ApplyError = init.ApplyError ?? "";
  }

  /**
   * 判断该条改进建议当前是否允许被自动应用。
   * 仅未应用且动作属于平台支持的白名单类型、并指定了目标资源或节点 ID 时返回 `true`。
   *
   * @returns {boolean} 可应用时返回 `true`，否则返回 `false`。
   */
  Applyable() {
    if (this.Status === RunEvalRecApplied) {
      return false;
    }
    switch (NormalizeRunEvalAction(this.Target, this.Action)) {
      case "workflow.update_node":
      case "agent.upsert_gate":
      case "agent.remove_gate":
      case "agent.append_instructions":
      case "agent.append_task_prompt":
        return this.TargetID.trim() !== "" || this.NodeID.trim() !== "";
      default:
        return false;
    }
  }
}

/**
 * 规范化评估建议的动作名称为 `<target>.<action>` 小写格式。
 * 若 `action` 已包含 `.` 或 `target` 为空，则直接返回规范化后的 `action`。
 *
 * @param {string} target - 目标资源类型名（如 `"workflow"`、`"agent"`）。
 * @param {string} action - 动作名称。
 * @returns {string} 规范化后的小写动作标识；`action` 为空时返回 `""`。
 */
function NormalizeRunEvalAction(target, action) {
  target = target.toLowerCase().trim();
  action = action.toLowerCase().trim();
  if (action === "") {
    return "";
  }
  if (action.includes(".")) {
    return action;
  }
  if (target === "") {
    return action;
  }
  return target + "." + action;
}

/**
 * 一次运行评估产出的打分、发现与建议汇总结果。
 */
class RunEvalResult {
  /**
   * 构造评估结果实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {number} [init.Score=0] - 加权总分（0-100）。
   * @param {boolean} [init.Passed=false] - 是否达到策略通过阈值。
   * @param {Object.<string, number>} [init.Dimensions={}] - 各维度得分映射。
   * @param {RunEvalFinding[]} [init.Findings=[]] - 评估发现列表。
   * @param {string} [init.Summary=""] - 总体评价摘要。
   * @param {RunEvalRecommendation[]} [init.Recommendations=[]] - 改进建议列表。
   */
  constructor(init = {}) {
    this.Score = init.Score ?? 0;
    this.Passed = init.Passed ?? false;
    this.Dimensions = init.Dimensions ?? {};
    this.Findings = init.Findings ?? [];
    this.Summary = init.Summary ?? "";
    this.Recommendations = init.Recommendations ?? [];
  }
}

/**
 * 单次运行质量评估的持久化记录。
 */
class RunEvalRecord {
  /**
   * 构造运行评估记录实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - 评估记录主键 ID。
   * @param {string} [init.RunID=""] - 关联运行 ID。
   * @param {string} [init.Status=""] - 评估执行状态（running、succeeded、failed）。
   * @param {number} [init.Score=0] - 评估总分。
   * @param {boolean} [init.Passed=false] - 是否通过评估。
   * @param {string} [init.Model=""] - 执行评估的模型标识。
   * @param {RunEvalPolicy} [init.Policy] - 本次评估使用的策略快照。
   * @param {RunEvalFacts} [init.Facts] - 本次评估采集的事实包。
   * @param {RunEvalResult} [init.Result] - 本次评估的结果详情。
   * @param {string} [init.Error=""] - 评估失败原因。
   * @param {number} [init.CreatedBy=0] - 触发评估的用户 ID。
   * @param {Date|null} [init.CreatedAt=null] - 评估创建时间。
   * @param {Date|null} [init.FinishedAt=null] - 评估结束时间。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.RunID = init.RunID ?? "";
    this.Status = init.Status ?? "";
    this.Score = init.Score ?? 0;
    this.Passed = init.Passed ?? false;
    this.Model = init.Model ?? "";
    this.Policy = init.Policy ?? new RunEvalPolicy();
    this.Facts = init.Facts ?? new RunEvalFacts();
    this.Result = init.Result ?? new RunEvalResult();
    this.Error = init.Error ?? "";
    this.CreatedBy = init.CreatedBy ?? 0;
    this.CreatedAt = init.CreatedAt ?? null;
    this.FinishedAt = init.FinishedAt ?? null;
  }
}

/**
 * 根据评估策略的维度权重对各维度分数做四舍五入加权求和，返回总分与清洗后的维度分数表。
 * 当策略无维度、缺失任一维度打分、分数不在 `[0, 100]` 范围内或权重总和为 0 时抛出错误。
 *
 * @param {RunEvalPolicy} policy - 评估策略（内部会先经 `EffectiveRunEvalPolicy` 补全默认值）。
 * @param {Object.<string, number>} ratings - 模型输出的各维度打分映射（键为维度 ID，值为 0-100 整数）。
 * @returns {[number, Object.<string, number>]} 二元组 `[加权总分, 清洗后的各维度得分对象]`；校验失败时抛出 Error。
 */
function ScoreRunEvalDimensions(policy, ratings) {
  policy = EffectiveRunEvalPolicy(policy);
  if (policy.Dimensions.length === 0) {
    throw new Error("run eval policy has no dimensions");
  }
  const clean = {};
  let totalWeight = 0;
  let weighted = 0;
  for (const dim of policy.Dimensions) {
    if (!(dim.ID in (ratings ?? {}))) {
      throw new Error(`missing dimension score ${JSON.stringify(dim.ID)}`);
    }
    const score = ratings[dim.ID];
    if (score < 0 || score > 100) {
      throw new Error(`dimension ${JSON.stringify(dim.ID)} score ${score} out of range`);
    }
    let weight = dim.Weight;
    if (weight <= 0) {
      weight = 1;
    }
    clean[dim.ID] = score;
    totalWeight += weight;
    weighted += score * weight;
  }
  if (totalWeight === 0) {
    throw new Error("run eval policy weights sum to 0");
  }
  // Go 为整数除法。
  return [Math.trunc((weighted + Math.trunc(totalWeight / 2)) / totalWeight), clean];
}

/**
 * 判断运行状态字符串是否属于终态（`succeeded`、`failed` 或 `cancelled`）。
 *
 * @param {string} status - 运行状态字符串。
 * @returns {boolean} 属于终态时返回 `true`，否则返回 `false`。
 */
function TerminalRunStatus(status) {
  switch (status.trim()) {
    case "succeeded":
    case "failed":
    case "cancelled":
      return true;
    default:
      return false;
  }
}

module.exports = { RunEvalRunning, RunEvalSucceeded, RunEvalFailed, RunEvalRecPending, RunEvalRecApplied, RunEvalPolicyVersion, RunEvalDimension, RunEvalPolicy, DefaultRunEvalPolicy, EffectiveRunEvalPolicy, RunEvalNodeFact, RunEvalToolRepeat, RunEvalErrorFact, RunEvalDigestEvent, RunEvalFacts, RunEvalCatalog, RunEvalCatalogNode, RunEvalCatalogAgent, RunEvalFinding, RunEvalRecommendation, NormalizeRunEvalAction, RunEvalResult, RunEvalRecord, ScoreRunEvalDimensions, TerminalRunStatus };
