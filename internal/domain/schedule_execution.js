// schedule_execution.js —— 对应 Go 文件：internal/domain/schedule_execution.go
// 作用：定时任务单次执行的记录、用量计价与超时、会话保留规则。

"use strict";

const { randomBytes } = require("node:crypto");
// ScheduleJob 与计价函数定义在同包的其它文件，本批次已翻译，直接引用。
const { ScheduleJob } = require("./sync");
const { AnalyticsPricedUsage, AnalyticsUSDToCNY, pricingModel } = require("./token_pricing");

// ScheduleJobExecution：一次定时任务执行。
class ScheduleJobExecution {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.JobID = init.JobID ?? "";
    this.JobName = init.JobName ?? "";
    this.JobKind = init.JobKind ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.TraceID = init.TraceID ?? "";
    this.TriggerOrigin = init.TriggerOrigin ?? "";
    this.Status = init.Status ?? "";
    this.Error = init.Error ?? "";
    this.Pulled = init.Pulled ?? 0;
    this.Dispatched = init.Dispatched ?? 0;
    this.AssistantMessage = init.AssistantMessage ?? "";
    this.SessionID = init.SessionID ?? "";
    this.Runs = init.Runs ?? null;
    this.StartedAt = init.StartedAt ?? null;
    this.FinishedAt = init.FinishedAt ?? null;
    this.DurationMs = init.DurationMs ?? 0;
    this.Model = init.Model ?? "";
    this.Usage = init.Usage ?? null;
    this.CostCNY = init.CostCNY ?? null;
  }

  // RecordUsage：把本次提示词的模型与用量记到执行记录上。
  RecordUsage(model, usage) {
    if (usage == null || (usageTotalTokens(usage) === 0 && usage.InputTokens === 0 && usage.OutputTokens === 0 && usage.CacheReadTokens === 0 && usage.CacheWriteTokens === 0 && usage.ReasoningTokens === 0 && usage.CostUSD === 0)) {
      return;
    }
    const priced = PriceScheduleExecutionUsage(model, usage);
    this.Model = model.trim();
    this.Usage = priced;
    this.CostCNY = null;
    if (priced.CostStatus === "estimated") {
      this.CostCNY = priced.CostUSD * AnalyticsUSDToCNY;
    }
  }

  // ExecutionTotalTokens：本次执行用量的计费总量。
  ExecutionTotalTokens() {
    if (this.Usage == null) {
      return 0;
    }
    return usageTotalTokens(this.Usage);
  }

  // Finished：执行是否已有结果。
  Finished() {
    return this.Status !== "" && this.Status !== "running";
  }

  // MatchesSearch：小写查询词是否出现在执行看板可搜索的内容里。
  MatchesSearch(query) {
    if (query === "") {
      return true;
    }
    const fields = [this.JobName, this.JobID, this.TraceID, this.Error, this.AssistantMessage];
    for (const r of this.Runs ?? []) {
      fields.push(r.IssueTitle, r.IssueID, r.RunID);
    }
    for (const f of fields) {
      if (f.toLowerCase().includes(query)) {
        return true;
      }
    }
    return false;
  }
}

// PriceScheduleExecutionUsage：先解析 CLI 路由前缀，再查价目计价。
function PriceScheduleExecutionUsage(model, usage) {
  model = model.toLowerCase().trim();
  let engine = "";
  const colon = model.indexOf(":");
  if (colon >= 0) {
    const prefix = model.slice(0, colon);
    if (prefix === "codex" || prefix === "claude-code" || prefix === "codebuddy" || IsAgentCLIKind(prefix)) {
      engine = prefix;
      model = model.slice(colon + 1).trim();
    }
  }
  const inclusive = engine === "codex" || (engine !== "claude-code" && pricingModel(model).startsWith("gpt-"));
  return AnalyticsPricedUsage(model, usage, inclusive);
}

// usageTotalTokens：计费总量，缺省时用输入加输出。
function usageTotalTokens(u) {
  if (u.TotalTokens > 0) {
    return u.TotalTokens;
  }
  return u.InputTokens + u.OutputTokens;
}

// ScheduleJobExecutionRun：一次执行启动的 SOP 运行。
class ScheduleJobExecutionRun {
  constructor(init = {}) {
    this.IssueID = init.IssueID ?? "";
    this.IssueTitle = init.IssueTitle ?? "";
    this.RunID = init.RunID ?? "";
  }
}

// ScheduleJobExecutionID：由 trace 派生执行主键。
function ScheduleJobExecutionID(traceID) {
  return "sjx-" + traceID;
}

// ScheduleExecutionWindow：一个窗口内启动的执行汇总。
class ScheduleExecutionWindow {
  constructor(init = {}) {
    this.Total = init.Total ?? 0;
    this.Finished = init.Finished ?? 0;
    this.Success = init.Success ?? 0;
    this.Failed = init.Failed ?? 0;
    this.Running = init.Running ?? 0;
    this.AvgMs = init.AvgMs ?? 0;
    this.Metered = init.Metered ?? 0;
    this.Tokens = init.Tokens ?? null;
    this.AvgTokens = init.AvgTokens ?? 0;
    this.Priced = init.Priced ?? 0;
    this.CostCNY = init.CostCNY ?? 0;
  }
}

// ScheduleExecutionTokens：token 用量汇总。
class ScheduleExecutionTokens {
  constructor(init = {}) {
    this.Total = init.Total ?? 0;
    this.Input = init.Input ?? 0;
    this.Output = init.Output ?? 0;
    this.CacheRead = init.CacheRead ?? 0;
    this.CacheWrite = init.CacheWrite ?? 0;
  }
}

const DefaultScheduleTimeoutMinutes = 30;
const MaxScheduleTimeoutMinutes = 240;

// NormalizeScheduleTimeoutMinutes：校验 AI 任务的执行时限。
function NormalizeScheduleTimeoutMinutes(minutes) {
  if (minutes === 0) {
    return DefaultScheduleTimeoutMinutes;
  }
  if (minutes < 1 || minutes > MaxScheduleTimeoutMinutes) {
    throw new Error(`执行超时必须为 1–${MaxScheduleTimeoutMinutes} 分钟`);
  }
  return minutes;
}

// ScheduleJob 的方法写在本文件，是 Go 同包作用域的对应写法。
ScheduleJob.prototype.ExecutionTimeout = function () {
  let minutes;
  try {
    minutes = NormalizeScheduleTimeoutMinutes(this.TimeoutMinutes);
  } catch {
    minutes = DefaultScheduleTimeoutMinutes;
  }
  // Go 返回 time.Duration（纳秒），JS 用毫秒数。
  return minutes * 60 * 1000;
};

// ScheduleSessionFixed：固定会话模式的 AI 任务。
const ScheduleSessionFixed = "fixed";

// UsesFixedSession：AI 任务是否沿用固定会话。
ScheduleJob.prototype.UsesFixedSession = function () {
  return this.SkipDispatch && this.SessionMode === ScheduleSessionFixed;
};

// ScheduleSessionKeepDefault：未设置时的会话保留数。
const ScheduleSessionKeepDefault = 50;
// ScheduleSessionKeepUnlimited：保留该任务的全部会话。
const ScheduleSessionKeepUnlimited = -1;

// ScheduleSessionKeepChoices：AI 任务可选的保留数（不含不限）。
const ScheduleSessionKeepChoices = [10, 50, 100];

// NormalizeScheduleSessionKeep：校验请求的会话保留数，0 取默认值。
function NormalizeScheduleSessionKeep(n) {
  if (n === 0) {
    return ScheduleSessionKeepDefault;
  }
  if (n === ScheduleSessionKeepUnlimited) {
    return n;
  }
  for (const choice of ScheduleSessionKeepChoices) {
    if (n === choice) {
      return n;
    }
  }
  throw new Error("保留会话数只能是 10、50、100 或不限");
}

// SessionKeepLimit：任务保留的最新会话数，0 表示不限数量。
ScheduleJob.prototype.SessionKeepLimit = function () {
  if (!this.SkipDispatch || this.UsesFixedSession() || this.SessionKeep === ScheduleSessionKeepUnlimited) {
    return 0;
  }
  if (this.SessionKeep <= 0) {
    return ScheduleSessionKeepDefault;
  }
  return this.SessionKeep;
};

// ScheduleJobKind：给执行看板标注任务类型。
function ScheduleJobKind(job) {
  if (job.SkipDispatch) {
    return "assistant";
  }
  return "trigger";
}

// NewTraceID：返回与 W3C trace-context 兼容的 32 位十六进制 trace ID。
function NewTraceID() {
  try {
    return randomBytes(16).toString("hex");
  } catch {
    // Go 用 time.Now().UTC().Format("20060102150405.000000") 的十六进制编码取前 32 位。
    const now = new Date();
    const pad = (n, len) => String(n).padStart(len, "0");
    const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}.${pad(now.getUTCMilliseconds() * 1000, 6)}`;
    return Buffer.from(stamp, "utf8").toString("hex").slice(0, 32);
  }
}

module.exports = { ScheduleJobExecution, PriceScheduleExecutionUsage, ScheduleJobExecutionRun, ScheduleJobExecutionID, ScheduleExecutionWindow, ScheduleExecutionTokens, DefaultScheduleTimeoutMinutes, MaxScheduleTimeoutMinutes, NormalizeScheduleTimeoutMinutes, ScheduleSessionFixed, ScheduleSessionKeepDefault, ScheduleSessionKeepUnlimited, ScheduleSessionKeepChoices, NormalizeScheduleSessionKeep, ScheduleJobKind, NewTraceID };
