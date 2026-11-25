// run_eval.js —— 对应 Go 文件：internal/domain/run_eval.go
// 作用：运行质量评估的策略、事实与评分。

"use strict";

const RunEvalRunning = "running";
const RunEvalSucceeded = "succeeded";
const RunEvalFailed = "failed";

const RunEvalRecPending = "pending";
const RunEvalRecApplied = "applied";

const RunEvalPolicyVersion = 1;

// RunEvalDimension：评估的一个维度。
class RunEvalDimension {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Question = init.Question ?? "";
    this.Weight = init.Weight ?? 0;
  }
}

// RunEvalPolicy：运行评估策略。
class RunEvalPolicy {
  constructor(init = {}) {
    this.Enabled = init.Enabled ?? false;
    this.Version = init.Version ?? 0;
    this.Threshold = init.Threshold ?? 0;
    this.Dimensions = init.Dimensions ?? [];
  }

  IsZero() {
    return !this.Enabled && this.Threshold === 0 && this.Version === 0 && this.Dimensions.length === 0;
  }
}

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

// RunEvalNodeFact：评估用的单节点事实。
class RunEvalNodeFact {
  constructor(init = {}) {
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

// RunEvalToolRepeat：重复的工具调用事实。
class RunEvalToolRepeat {
  constructor(init = {}) {
    this.NodeID = init.NodeID ?? "";
    this.Tool = init.Tool ?? "";
    this.Count = init.Count ?? 0;
    this.Failed = init.Failed ?? 0;
  }
}

// RunEvalErrorFact：重复出现的错误事实。
class RunEvalErrorFact {
  constructor(init = {}) {
    this.NodeID = init.NodeID ?? "";
    this.Text = init.Text ?? "";
    this.Count = init.Count ?? 0;
  }
}

// RunEvalDigestEvent：评估摘要里的一条事件。
class RunEvalDigestEvent {
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

// RunEvalFacts：一次运行评估的全部事实。
class RunEvalFacts {
  constructor(init = {}) {
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

// RunEvalCatalog：评估建议可改的目录快照。
class RunEvalCatalog {
  constructor(init = {}) {
    this.WorkflowID = init.WorkflowID ?? "";
    this.Generic = init.Generic ?? false;
    this.Nodes = init.Nodes ?? [];
    this.Agents = init.Agents ?? [];
  }
}

// RunEvalCatalogNode：目录里的一个节点。
class RunEvalCatalogNode {
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

// RunEvalCatalogAgent：目录里的一个 Agent。
class RunEvalCatalogAgent {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Shared = init.Shared ?? false;
    this.Prompt = init.Prompt ?? "";
    this.Verification = init.Verification ?? [];
  }
}

// RunEvalFinding：评估的一项发现。
class RunEvalFinding {
  constructor(init = {}) {
    this.Severity = init.Severity ?? "";
    this.Dimension = init.Dimension ?? "";
    this.NodeID = init.NodeID ?? "";
    this.RuleID = init.RuleID ?? "";
    this.Message = init.Message ?? "";
    this.Evidence = init.Evidence ?? "";
  }
}

// RunEvalRecommendation：评估的一条改进建议。
class RunEvalRecommendation {
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

// RunEvalResult：一次运行评估的结果。
class RunEvalResult {
  constructor(init = {}) {
    this.Score = init.Score ?? 0;
    this.Passed = init.Passed ?? false;
    this.Dimensions = init.Dimensions ?? {};
    this.Findings = init.Findings ?? [];
    this.Summary = init.Summary ?? "";
    this.Recommendations = init.Recommendations ?? [];
  }
}

// RunEvalRecord：一次运行评估的记录。
class RunEvalRecord {
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

// ScoreRunEvalDimensions：按策略权重算总分，返回 [总分, 各维度分]，失败时 throw。
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
