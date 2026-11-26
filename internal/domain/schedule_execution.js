/**
 * @file internal/domain/schedule_execution.js
 * @description 对应 Go 文件：internal/domain/schedule_execution.go
 * 职责与边界：定义定时任务单次执行记录、执行统计窗口与 token 汇总类型，
 * 实现 AI 定时任务执行用量计价、搜索匹配、超时与会话保留数量校验，
 * 以及挂载在 `ScheduleJob` 上的执行超时与会话策略方法。
 * 语法差异说明：
 * - Go 切片零值初始化为 `[]`，指针与 `time.Time` 初始化为 `null`，`time.Duration` 译为毫秒数。
 * - Go 多返回值 `(T, error)` 译为成功返回 `T`、失败 `throw Error`。
 * - `ScheduleJob` 定义在 `sync.js`，本文件通过 `ScheduleJob.prototype` 挂载同包跨文件方法。
 */

"use strict";

const { randomBytes } = require("node:crypto");
const { IsAgentCLIKind } = require("./agent.js");
const { ScheduleJob } = require("./sync.js");
const { AnalyticsPricedUsage, AnalyticsUSDToCNY, pricingModel } = require("./token_pricing.js");

/**
 * 表示定时任务的单次执行历史记录，用于在执行看板展示状态、链路 TraceID、启动的 SOP 运行与费用统计。
 */
class ScheduleJobExecution {
  /**
   * 构造定时任务执行记录实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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
    this.Runs = init.Runs ?? [];
    this.StartedAt = init.StartedAt ?? null;
    this.FinishedAt = init.FinishedAt ?? null;
    this.DurationMs = init.DurationMs ?? 0;
    this.Model = init.Model ?? "";
    this.Usage = init.Usage ?? null;
    this.CostCNY = init.CostCNY ?? null;
  }

  /**
   * 将本次 AI 定时任务生成的模型标识、token 用量与估算人民币成本写入当前执行记录；空用量不记录。
   * 在定时 AI 任务完成或失败前上报用量时调用。
   * @param {string} model - 本次调用的模型字符串（可带 CLI 路由前缀）。
   * @param {Object|null} usage - 本次调用的 `TokenUsage` 对象；为 `null` 或全零时直接跳过。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回本次执行记录的计费总 token 数；未记录用量时返回 `0`。
   * 在看板聚合统计单次执行的 token 消耗时调用。
   * @returns {number} 计费总 token 数。
   */
  ExecutionTotalTokens() {
    if (this.Usage == null) {
      return 0;
    }
    return usageTotalTokens(this.Usage);
  }

  /**
   * 判断本次执行是否已经结束（状态非空且不是 `"running"`）。
   * 在窗口汇总区分已完成与运行中任务时调用。
   * @returns {boolean} 已有明确终态或等待态结果时返回 `true`，否则返回 `false`。
   */
  Finished() {
    return this.Status !== "" && this.Status !== "running";
  }

  /**
   * 判断小写查询关键词是否命中执行看板支持检索的字段（任务名、ID、TraceID、错误、AI 回复及关联 SOP 运行）。
   * 在执行记录列表按关键字过滤时调用。
   * @param {string} query - 已转为小写的搜索关键词；为空字符串时直接匹配。
   * @returns {boolean} 任一可搜索字段包含 `query` 时返回 `true`，否则返回 `false`。
   */
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

/**
 * 解析模型字符串中的 CLI 路由前缀，确定输入 token 是否含缓存，再按公开价目表估算用量成本。
 * 供 `ScheduleJobExecution.RecordUsage` 及统计回算调用。
 * @param {string} model - 模型标识（例如 `"codex:gpt-5.4"` 或 `"claude-sonnet-4-6"`）。
 * @param {Object} usage - 原始 `TokenUsage` 对象。
 * @returns {Object} 填充了 `CostUSD` 与 `CostStatus` 的计价结果副本。
 */
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

/**
 * 计算单份 `TokenUsage` 的计费总 token 数；若 `TotalTokens` 未上报则退回 `InputTokens + OutputTokens`。
 * 供本文件内部用量判空与总量读取调用。
 * @param {Object} u - `TokenUsage` 对象。
 * @returns {number} 计费总 token 数。
 */
function usageTotalTokens(u) {
  if (u.TotalTokens > 0) {
    return u.TotalTokens;
  }
  return u.InputTokens + u.OutputTokens;
}

/**
 * 记录一次定时任务执行所触发启动的单个 SOP 运行关联信息。
 */
class ScheduleJobExecutionRun {
  /**
   * 构造执行关联运行实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.IssueID = init.IssueID ?? "";
    this.IssueTitle = init.IssueTitle ?? "";
    this.RunID = init.RunID ?? "";
  }
}

/**
 * 根据执行的 `traceID` 派生定时任务执行记录的主键 ID。
 * 在认领定时任务创建执行记录时调用。
 * @param {string} traceID - 链路追踪 ID。
 * @returns {string} 形如 `"sjx-<traceID>"` 的主键字符串。
 */
function ScheduleJobExecutionID(traceID) {
  return "sjx-" + traceID;
}

/**
 * 表示指定时间窗口内定时任务执行的聚合统计汇总（次数、均值、token 与费用）。
 */
class ScheduleExecutionWindow {
  /**
   * 构造执行统计窗口实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示定时任务执行窗口内的 token 分项累计值。
 */
class ScheduleExecutionTokens {
  /**
   * 构造 token 累计汇总实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

/**
 * 校验并规范化 AI 定时任务的执行超时分钟数；传入 `0` 时采用默认超时值。
 * 在保存定时任务配置及计算执行超时时间时调用。
 * @param {number} minutes - 请求设置的超时分钟数。
 * @returns {number} 合法的超时分钟数；超出 `1..MaxScheduleTimeoutMinutes` 时抛出异常。
 */
function NormalizeScheduleTimeoutMinutes(minutes) {
  if (minutes === 0) {
    return DefaultScheduleTimeoutMinutes;
  }
  if (minutes < 1 || minutes > MaxScheduleTimeoutMinutes) {
    throw new Error(`执行超时必须为 1–${MaxScheduleTimeoutMinutes} 分钟`);
  }
  return minutes;
}

/**
 * 计算该定时任务单次执行允许的超时时长（毫秒）；配置非法时回退到默认值。
 * 对应 Go 同包跨文件方法 `(j ScheduleJob) ExecutionTimeout() time.Duration`。
 * @returns {number} 超时时长（毫秒）。
 */
ScheduleJob.prototype.ExecutionTimeout = function () {
  let minutes;
  try {
    minutes = NormalizeScheduleTimeoutMinutes(this.TimeoutMinutes);
  } catch {
    minutes = DefaultScheduleTimeoutMinutes;
  }
  // Go 返回 time.Duration（纳秒），JS 用毫秒数表示。
  return minutes * 60 * 1000;
};

// 固定会话模式标识：AI 定时任务持续在同一个固定会话中运行。
const ScheduleSessionFixed = "fixed";

/**
 * 判断该定时任务是否为启用了固定会话模式的 AI 定时任务。
 * 对应 Go 同包跨文件方法 `(j ScheduleJob) UsesFixedSession() bool`。
 * @returns {boolean} 为 AI 任务且 `SessionMode === "fixed"` 时返回 `true`，否则返回 `false`。
 */
ScheduleJob.prototype.UsesFixedSession = function () {
  return this.SkipDispatch && this.SessionMode === ScheduleSessionFixed;
};

// 未显式配置时的默认会话保留条数。
const ScheduleSessionKeepDefault = 50;
// 保留该定时任务产生的所有历史会话（不限数量）。
const ScheduleSessionKeepUnlimited = -1;

// 除不限之外，AI 定时任务可选的会话保留数量档位。
const ScheduleSessionKeepChoices = [10, 50, 100];

/**
 * 校验请求的 AI 定时任务历史会话保留数量；传入 `0` 时返回默认值。
 * 在创建或更新定时任务配置时调用。
 * @param {number} n - 请求设置的保留会话数量。
 * @returns {number} 合法的保留数量；不在允许档位或 `-1` 时抛出异常。
 */
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

/**
 * 返回该定时任务最多保留的最新会话条数；返回 `0` 表示不按条数裁剪（非 AI 任务、固定会话或不限）。
 * 对应 Go 同包跨文件方法 `(j ScheduleJob) SessionKeepLimit() int`。
 * @returns {number} 保留条数上限；不需要裁剪时返回 `0`。
 */
ScheduleJob.prototype.SessionKeepLimit = function () {
  if (!this.SkipDispatch || this.UsesFixedSession() || this.SessionKeep === ScheduleSessionKeepUnlimited) {
    return 0;
  }
  if (this.SessionKeep <= 0) {
    return ScheduleSessionKeepDefault;
  }
  return this.SessionKeep;
};

/**
 * 根据定时任务是否跳过 SOP 派发，返回执行看板使用的任务类型标签。
 * 在创建执行记录和看板分类展示时调用。
 * @param {ScheduleJob} job - 定时任务定义对象。
 * @returns {string} AI 助手任务返回 `"assistant"`，触发派发任务返回 `"trigger"`。
 */
function ScheduleJobKind(job) {
  if (job.SkipDispatch) {
    return "assistant";
  }
  return "trigger";
}

/**
 * 生成兼容 W3C trace-context 的 32 位十六进制随机链路追踪 ID；随机源失败时回退到 UTC 时间戳编码。
 * 在定时任务被认领、准备写入执行日志前调用。
 * @returns {string} 32 位十六进制 trace ID 字符串。
 */
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
