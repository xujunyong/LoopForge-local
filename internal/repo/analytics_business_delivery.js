/**
 * @file internal/repo/analytics_business_delivery.js
 * 对应 Go 源文件：internal/repo/analytics_business_delivery.go
 *
 * 作用与职责边界：
 * 负责业务域报表中的交付指标计算，包括基于需求生命周期证据推导完成时间、
 * 跨多次重试与并行运行计算无等待的纯执行并集时长、统计已完成需求周期与 Token 消耗、
 * 按 MR 合并时间统计合入数与完成到合入延迟，并输出项目/业务域/总计交付指标与交付趋势。
 *
 * 语法差异说明：
 * - Go 的 `time.Time` 对应 `Date`（零值为 `null`）；`time.Duration` 对应毫秒数（`unionDuration` 直接返回毫秒）。
 * - Go 的内层 `map[domain.MRDeliveryKey]domain.MRDeliveryState` 以结构体为键（非字符串键），按对照规则保留 `Map`。
 * - Go 的整数除法在 JS 中使用 `Math.trunc(...)` 保持向零截断语义一致。
 * - Go 的 `(值, error)` 与仅 `error` 返回在成功时直接返回值或 `undefined`，失败时抛出错误。
 */

"use strict";

const { AnalyticsFilter } = require("../domain/analytics.js"); // 对应 Go 的 domain.AnalyticsFilter，domain 已翻译
const { Issue, IssueOperation } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue/IssueOperation，domain 已翻译
const { Run } = require("../domain/run.js"); // 对应 Go 的 domain.Run，domain 已翻译
const { BusinessDeliveryMetrics, BusinessDeliveryTrendPoint } = require("../domain/business_domain.js"); // 对应 Go 的 domain.BusinessDeliveryMetrics/BusinessDeliveryTrendPoint，domain 已翻译
const { MRDeliveryKey } = require("../domain/mr_delivery.js"); // 对应 Go 的 domain.MRDeliveryKey，domain 已翻译
const { BaselinePromoteIssueID } = require("../domain/mr.js"); // 对应 Go 的 domain.BaselinePromoteIssueID，domain 已翻译
const { RunProjectID } = require("../domain/catalog.js"); // 对应 Go 的 domain.RunProjectID，domain 已翻译
const { RunExecutionIntervals } = require("../domain/run_timing.js"); // 对应 Go 的 domain.RunExecutionIntervals，domain 已翻译
const { AnalyticsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { percentile, analyticsTrendBucket, isZeroTime, timeBefore, timeAfter, timeEqual, loadTimeLocation, inLocation } = require("./analytics.js"); // 对应 Go 同包函数，analytics.js 已翻译
const { runEndedAt } = require("./runs.js"); // 对应 Go 同包函数，runs.js 待翻译
const { businessCompletionToMerge } = require("./analytics_business_merge.js"); // 对应 Go 同包函数，analytics_business_merge.js 已翻译

/**
 * 业务交付指标累加器，暂存单个维度（总计、项目、业务域或时间桶）的交付样本数组并汇总为最终指标。
 */
class businessDeliveryAccumulator {
  /**
   * 构造业务交付指标累加器实例，未提供字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {BusinessDeliveryMetrics} [init.metrics] - 基础交付指标对象。
   * @param {number[]} [init.cycles=[]] - 端到端交付周期样本列表（毫秒）。
   * @param {number[]} [init.executions=[]] - 纯执行时长样本列表（毫秒）。
   * @param {number[]} [init.mergeLatencies=[]] - 完成到合并延迟样本列表（毫秒）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.metrics = init.metrics ?? new BusinessDeliveryMetrics();
    this.cycles = init.cycles ?? [];
    this.executions = init.executions ?? [];
    this.mergeLatencies = init.mergeLatencies ?? [];
  }

  /**
   * 向累加器登记一条已完成需求的交付样本，更新完成计数、Token 总量、最近完成时间及耗时样本数组。
   * 在遍历已闭环且命中时间窗口的需求时调用。
   *
   * @param {Date} at - 需求完成时间。
   * @param {boolean} estimated - 完成时间是否为基于最近成功运行的估算值。
   * @param {number|null} cycle - 端到端交付周期（毫秒），缺失时为 `null`。
   * @param {number|null} execution - 纯执行耗时（毫秒），缺失时为 `null`。
   * @param {number} tokens - 截至完成时刻关联运行累计消耗的 Token 总数。
   * @returns {void} 无返回值。
   */
  complete(at, estimated, cycle, execution, tokens) {
    this.metrics.CompletedIssues++;
    if (estimated) {
      this.metrics.EstimatedCompletionIssues++;
    }
    this.metrics.CompletedTokens += tokens;
    if (this.metrics.LatestCompletedAt == null || timeAfter(at, this.metrics.LatestCompletedAt)) {
      this.metrics.LatestCompletedAt = at;
    }
    if (cycle != null) {
      this.cycles.push(cycle);
    }
    if (execution != null) {
      this.executions.push(execution);
    }
  }

  /**
   * 基于已累积的样本计算均值、P50/P95 分位数与单需求平均 Token 消耗，输出最终的业务交付指标副本。
   * 在全部需求与 MR 样本累加结束后调用。
   *
   * @returns {BusinessDeliveryMetrics} 计算完成的业务交付指标实例。
   */
  result() {
    const out = new BusinessDeliveryMetrics(this.metrics);
    out.CycleSamples = this.cycles.length;
    if (out.CycleSamples > 0) {
      let total = 0;
      for (const value of this.cycles) {
        total += value;
      }
      out.AverageCycleDurationMs = Math.trunc(total / out.CycleSamples);
      out.P50CycleDurationMs = percentile(this.cycles, 50);
      out.P95CycleDurationMs = percentile(this.cycles, 95);
    }
    if (out.CompletedIssues > 0) {
      out.AverageTokensPerCompletedIssue = Math.trunc(out.CompletedTokens / out.CompletedIssues);
    }
    out.ExecutionSamples = this.executions.length;
    out.CompletionToMergeSamples = this.mergeLatencies.length;
    if (this.mergeLatencies.length > 0) {
      let total = 0;
      for (const value of this.mergeLatencies) {
        total += value;
      }
      out.AverageCompletionToMergeMs = Math.trunc(total / this.mergeLatencies.length);
    }
    if (out.ExecutionSamples > 0) {
      let total = 0;
      for (const value of this.executions) {
        total += value;
      }
      out.AverageExecutionDurationMs = Math.trunc(total / out.ExecutionSamples);
    }
    return out;
  }
}

/**
 * 单个需求用于交付计时分析的上下文聚合结构，保存需求本体、起始时间、最新顶层运行及全部关联运行。
 */
class businessIssueTiming {
  /**
   * 构造需求交付计时上下文实例，未提供字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {Issue} [init.issue] - 需求轻量领域对象。
   * @param {Date|null} [init.start=null] - 需求起始时间（澄清开始或最早顶层运行创建时间）。
   * @param {Run} [init.latest] - 最新一次顶层运行记录。
   * @param {Run[]} [init.runs=[]] - 与该需求关联的全部运行记录列表。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.issue = init.issue ?? new Issue();
    this.start = init.start ?? null;
    this.latest = init.latest ?? new Run();
    this.runs = init.runs ?? [];
  }
}

/**
 * 查询需求生命周期字段时的轻量数据库投影行结构（对应 Go `businessDeliveryIssues` 内部类型）。
 */
class lifecycleRow {
  /**
   * 构造需求生命周期投影行实例，未提供字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.ID=""] - 需求 ID。
   * @param {string} [init.ProjectID=""] - 所属项目 ID。
   * @param {string} [init.Status=""] - 需求当前状态。
   * @param {string} [init.Kind=""] - 工作项类型。
   * @param {string} [init.Source=""] - 需求来源。
   * @param {string} [init.CompletedAt=""] - JSON 提取出的完成时间字符串。
   * @param {string} [init.ClarificationStartedAt=""] - JSON 提取出的澄清开始时间字符串。
   * @param {string} [init.Operations=""] - JSON 提取出的操作日志数组字符串。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Status = init.Status ?? "";
    this.Kind = init.Kind ?? "";
    this.Source = init.Source ?? "";
    this.CompletedAt = init.CompletedAt ?? "";
    this.ClarificationStartedAt = init.ClarificationStartedAt ?? "";
    this.Operations = init.Operations ?? "";
  }
}

/**
 * 将 RFC3339 时间字符串解析为 `Date` 对象，解析失败或为空时返回 `null`（对应 Go 的 `time.Parse` 忽略错误）。
 * 用于解析从数据库 JSON 字段提取出的时间戳文本。
 *
 * @param {string|null|undefined} s - 待解析的时间字符串。
 * @returns {Date|null} 解析成功时返回对应 `Date`，否则返回 `null`。
 */
function parseTime(s) {
  if (s == null || s === "") {
    return null;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 推导已完成需求的完成时间及其是否为估算值。
 * 在计算业务域交付周期时调用；绝不使用易受编辑或 MR 轮询影响的 `UpdatedAt`/`DeliveryUpdatedAt`，
 * 仅按 `CompletedAt` → 操作日志中的 `complete`/`close`（且不早于 `reopen`）→ 最近一次成功顶层运行结束时间（标记为估算）的顺序判定。
 *
 * @param {businessIssueTiming} item - 需求交付计时上下文。
 * @returns {[Date|null, boolean]} 二元组 `[完成时间（无法确定时为 null）, 是否为估算完成时间]`。
 */
function businessIssueCompletion(item) {
  if (!item.issue.Completed()) {
    return [null, false];
  }
  if (!isZeroTime(item.issue.CompletedAt)) {
    return [item.issue.CompletedAt, false];
  }
  let completedAt = null;
  let reopenedAt = null;
  for (const op of item.issue.Operations ?? []) {
    switch (op.Action) {
      case "complete":
      case "close":
        if (timeAfter(op.At, completedAt)) {
          completedAt = op.At;
        }
        break;
      case "reopen":
        if (timeAfter(op.At, reopenedAt)) {
          reopenedAt = op.At;
        }
        break;
      default:
        break;
    }
  }
  if (!isZeroTime(completedAt) && !timeBefore(completedAt, reopenedAt)) {
    return [completedAt, false];
  }
  const run = item.latest;
  if (run.ID === "" || run.Status !== "succeeded" || isZeroTime(run.CreatedAt) || isZeroTime(run.UpdatedAt)) {
    return [null, false];
  }
  let end = runEndedAt(run, run.UpdatedAt);
  if (run.Timing != null) {
    end = new Date(run.CreatedAt.getTime() + run.Timing.WallMs);
  }
  if (timeBefore(end, run.CreatedAt) || timeBefore(end, reopenedAt)) {
    return [null, false];
  }
  return [end, true];
}

/**
 * 仅投影读取已授权项目下需求的生命周期字段（状态、完成时间、澄清开始时间与操作记录），用于聚合交付指标。
 * 在 `populateBusinessDeliveryMetrics` 中调用，避免拉取需求全文内容。
 *
 * @param {string[]} projectIDs - 已通过权限校验的项目 ID 列表。
 * @returns {Issue[]|null} 项目列表为空时返回 `null`，否则返回仅含生命周期字段的需求列表；查询或反序列化失败时抛出错误。
 */
AnalyticsRepo.prototype.businessDeliveryIssues = function (projectIDs) {
  if (projectIDs.length === 0) {
    return null;
  }
  const rows = []; // Go: var rows []lifecycleRow
  const err = this.DB.Table("issues").Select("id", "project_id", "status", "kind", "source",
    this.sqlPayloadJSONText("completedAt") + " AS completed_at",
    this.sqlPayloadJSONText("clarification.startedAt") + " AS clarification_started_at",
    this.sqlPayloadJSONText("operations") + " AS operations",
  ).Where("project_id IN ?", projectIDs).Find(rows).Error;
  if (err != null) {
    throw err;
  }
  const issues = [];
  for (const row of rows) {
    const issue = new Issue({ ID: row.ID, ProjectID: row.ProjectID, Status: row.Status, Kind: row.Kind, Source: row.Source });
    issue.CompletedAt = parseTime(row.CompletedAt);
    issue.Clarification.StartedAt = parseTime(row.ClarificationStartedAt);
    if (row.Operations !== "" && row.Operations !== "null") {
      issue.Operations = JSON.parse(row.Operations).map((op) => new IssueOperation(op));
    }
    issues.push(issue);
  }
  return issues;
};

/**
 * 判断时间点是否落在业务交付统计筛选窗口 `[From, To]` 内（含边界）。
 * 用于过滤需求完成时间与 MR 合并时间；零值时间返回 `false`。
 *
 * @param {Date|null} at - 待判断的时间点。
 * @param {AnalyticsFilter} filter - 包含 `From` 与 `To` 的筛选条件。
 * @returns {boolean} 命中时间窗口返回 `true`，否则返回 `false`。
 */
function businessTimeInWindow(at, filter) {
  return !isZeroTime(at) && (isZeroTime(filter.From) || !timeBefore(at, filter.From)) && (isZeroTime(filter.To) || !timeAfter(at, filter.To));
}

/**
 * 合并需求在全部重试与并行运行中的实际节点执行区间并计算无等待总执行时长（毫秒）。
 * 在业务域交付统计中调用；子 SOP 包装节点会被其子运行的真实事件替代，防止子运行的审批或排队等待混入父级执行时长。
 * 若任一关联运行缺少 `node.started` 事件或存在不完整的子运行计时证据，则返回 `null` 表示样本缺失。
 *
 * @param {businessIssueTiming} item - 需求交付计时上下文。
 * @param {Date} completedAt - 需求完成时间上限。
 * @param {Object<string, import("../domain/run.js").RunEvent[]>} events - 按运行 ID 索引的运行计时事件映射。
 * @returns {number|null} 并集执行时长（毫秒）；无法确认无等待执行时长时返回 `null`。
 */
function businessExecutionDuration(item, completedAt, events) {
  if (isZeroTime(item.start) || timeBefore(completedAt, item.start)) {
    return null;
  }
  const eligible = {};
  for (const run of item.runs) {
    if (!timeAfter(run.CreatedAt, completedAt)) {
      eligible[run.ID] = true;
    }
  }
  const intervals = [];
  let observed = false;
  for (const original of item.runs) {
    if (!eligible[original.ID]) {
      continue;
    }
    const wrappers = {};
    const nodes = {};
    for (const [id, node] of Object.entries(original.Nodes ?? {})) {
      if (node != null && node.ChildRunID !== "") {
        if (!eligible[node.ChildRunID]) {
          return null; // 子运行计时不完整时不能视为零执行时长
        }
        wrappers[id] = true;
      } else {
        nodes[id] = node;
      }
    }
    // Go 按值遍历 runs，run.Nodes 的替换仅作用于副本，此处构造 Run 副本保持原型方法完整。
    const run = new Run({ ...original, Nodes: nodes });
    const filtered = [];
    let hasExecutionEvents = false;
    for (const event of (events[run.ID] ?? [])) {
      if (!wrappers[event.NodeID]) {
        filtered.push(event);
        if (event.Type === "node.started" && event.NodeID !== "" && !isZeroTime(event.Timestamp)) {
          hasExecutionEvents = true;
        }
      }
    }
    if (!hasExecutionEvents) {
      if (Object.keys(wrappers).length > 0 && Object.keys(nodes).length === 0) {
        continue;
      }
      // 历史节点行仅保留最后一次尝试且可能包含审批等待，无法确立无等待执行耗时。
      return null;
    }
    const [spans, known] = RunExecutionIntervals(run, filtered, completedAt);
    if (!known) {
      if (Object.keys(wrappers).length > 0 && Object.keys(nodes).length === 0) {
        continue; // 纯子 SOP 包装运行仅由其子运行贡献执行时长
      }
      return null;
    }
    observed = true;
    for (const span of spans) {
      if (timeBefore(span.StartedAt, item.start)) {
        span.StartedAt = item.start;
      }
      if (timeAfter(span.FinishedAt, completedAt)) {
        span.FinishedAt = completedAt;
      }
      if (timeAfter(span.FinishedAt, span.StartedAt)) {
        intervals.push(span);
      }
    }
  }
  if (!observed) {
    return null;
  }
  const value = unionDuration(intervals);
  return value;
}

/**
 * 计算多个时间区间并集的总时长（毫秒），重叠或首尾相接的区间仅计算一次。
 * 会就地按 `StartedAt` 对入参数组排序，供 `businessExecutionDuration` 合并并行执行区间。
 *
 * @param {import("../domain/run_timing.js").RunExecutionInterval[]} intervals - 待合并的时间区间列表（将被就地排序）。
 * @returns {number} 区间并集覆盖的总毫秒数。
 */
function unionDuration(intervals) {
  intervals.sort((a, b) => (timeBefore(a.StartedAt, b.StartedAt) ? -1 : timeBefore(b.StartedAt, a.StartedAt) ? 1 : 0));
  let total = 0;
  for (let i = 0; i < intervals.length;) {
    const span = { StartedAt: intervals[i].StartedAt, FinishedAt: intervals[i].FinishedAt };
    i++;
    while (i < intervals.length && !timeAfter(intervals[i].StartedAt, span.FinishedAt)) {
      if (timeAfter(intervals[i].FinishedAt, span.FinishedAt)) {
        span.FinishedAt = intervals[i].FinishedAt;
      }
      i++;
    }
    total += span.FinishedAt.getTime() - span.StartedAt.getTime();
  }
  return total;
}

/**
 * 计算并回填业务域报表的交付指标（总计、按项目、按业务域）及交付趋势序列。
 * 在生成业务域报表时调用；支持复用调用方预取的全量运行摘要与计时事件（传 `null` 时自行查询），保证两种路径统计口径完全一致。
 *
 * @param {import("../domain/business_domain.js").BusinessDomainReport} out - 待回填交付指标与交付趋势的业务域报表对象。
 * @param {AnalyticsFilter} filter - 分析查询筛选条件（时间窗、时区与粒度等）。
 * @param {Run[]|null} prefetchedRuns - 可选预取的全量运行摘要列表；为 `null` 时按项目列表自行查询。
 * @param {Object<string, import("../domain/run.js").RunEvent[]>|null} prefetchedEvents - 可选预取的运行计时事件映射；为 `null` 时自行查询。
 * @returns {void} 无返回值；时区无效或数据库查询失败时抛出错误。
 */
AnalyticsRepo.prototype.populateBusinessDeliveryMetrics = function (out, filter, prefetchedRuns, prefetchedEvents) {
  let location = loadTimeLocation(filter.TimeZone);
  if (filter.TimeZone === "") {
    location = { name: "UTC" };
  }
  out.TimeZone = location.name;
  out.Grain = filter.Grain;
  if (out.Grain === "") {
    out.Grain = "day";
  }
  out.DeliveryTrend = [];
  const projectIDs = [];
  const projects = {};
  const groups = {};
  for (const p of out.Projects) {
    projectIDs.push(p.ProjectID);
    projects[p.ProjectID] = new businessDeliveryAccumulator();
    groups[p.BusinessDomainID] = new businessDeliveryAccumulator();
  }
  if (projectIDs.length === 0) {
    return;
  }
  const issues = this.businessDeliveryIssues(projectIDs);
  const items = {};
  for (const issue of issues ?? []) {
    items[issue.ID] = new businessIssueTiming({ issue, start: issue.Clarification.StartedAt });
  }
  // 完成时间窗口不得截断早期尝试及其 Token 消耗；
  // RunSummariesFor 略去大字段日志/输出并保留历史需求到项目的归属回退，同时提供终态计时信息。
  let runs = prefetchedRuns;
  if (runs == null) {
    runs = this.runs.RunSummariesFor(new AnalyticsFilter({ ProjectIDs: projectIDs }), "");
  }
  let timingEvents = prefetchedEvents;
  if (timingEvents == null) {
    const runIDs = [];
    for (const run of runs) {
      runIDs.push(run.ID);
    }
    timingEvents = this.runs.runTimingEvents(runIDs);
  }
  for (const run of runs) {
    const item = items[run.ExecutionContext.IssueID] ?? null;
    if (item == null || RunProjectID(run, item.issue.ProjectID) !== item.issue.ProjectID) {
      continue;
    }
    item.runs.push(run);
    if (run.ExecutionContext.ParentRunID !== "") {
      continue;
    }
    if (!isZeroTime(run.CreatedAt) && (isZeroTime(item.start) || timeBefore(run.CreatedAt, item.start))) {
      item.start = run.CreatedAt;
    }
    if (item.latest.ID === "" || timeAfter(run.CreatedAt, item.latest.CreatedAt) || (timeEqual(run.CreatedAt, item.latest.CreatedAt) && run.ID > item.latest.ID)) {
      item.latest = run;
    }
  }
  const projectDomains = {};
  for (const p of out.Projects) {
    projectDomains[p.ProjectID] = p.BusinessDomainID;
  }
  const total = new businessDeliveryAccumulator();
  const trends = {};
  const trendAt = (at) => {
    const key = analyticsTrendBucket(inLocation(at, location), filter.Grain);
    if (trends[key] == null) {
      trends[key] = new businessDeliveryAccumulator();
    }
    return trends[key];
  };
  for (const item of Object.values(items)) {
    const p = projects[item.issue.ProjectID];
    const g = groups[projectDomains[item.issue.ProjectID]];
    if (!item.issue.Completed()) {
      continue;
    }
    const [at, estimated] = businessIssueCompletion(item);
    if (isZeroTime(at)) {
      for (const acc of [total, p, g]) {
        acc.metrics.CompletionTimeMissingIssues++;
      }
      continue;
    }
    if (!businessTimeInWindow(at, filter)) {
      continue;
    }
    let cycle = null;
    if (!isZeroTime(item.start) && !timeBefore(at, item.start)) {
      cycle = at.getTime() - item.start.getTime();
    }
    let tokens = 0;
    for (const run of item.runs) {
      if (!timeAfter(run.CreatedAt, at)) {
        tokens += run.Usage.TotalTokens;
      }
    }
    const execution = businessExecutionDuration(item, at, timingEvents);
    for (const acc of [total, p, g, trendAt(at)]) {
      acc.complete(at, estimated, cycle, execution, tokens);
    }
  }
  const mrs = []; // Go: var mrs []mrDeliveryStateRow（models.go 待翻译）
  const q = this.DB.Table("mr_delivery_states AS mr").Select("mr.*").Joins("JOIN issues AS issue ON issue.id = mr.issue_id").
    Where("issue.project_id IN ? AND mr.state = ? AND mr.issue_id <> ?", projectIDs, "merged", BaselinePromoteIssueID);
  const mrsErr = q.Find(mrs).Error;
  if (mrsErr != null) {
    throw mrsErr;
  }
  for (const mr of mrs) {
    const item = items[mr.IssueID] ?? null;
    if (item == null) {
      continue;
    }
    const accs = [total, projects[item.issue.ProjectID], groups[projectDomains[item.issue.ProjectID]]];
    if (mr.MergedAt == null || isZeroTime(mr.MergedAt)) {
      for (const acc of accs) {
        acc.metrics.MergedMRsMissingTime++;
      }
      continue;
    }
    if (businessTimeInWindow(mr.MergedAt, filter)) {
      for (const acc of [...accs, trendAt(mr.MergedAt)]) {
        acc.metrics.MergedMRs++;
      }
    }
  }
  const statesByIssue = {};
  const candidates = {};
  for (const mr of mrs) {
    if (statesByIssue[mr.IssueID] == null) {
      // Go 中内层 map 的键为非字符串结构体 domain.MRDeliveryKey，按对照规则保留 Map。
      statesByIssue[mr.IssueID] = new Map();
    }
    statesByIssue[mr.IssueID].set(new MRDeliveryKey({ Project: mr.MRProject, IID: mr.MRIID }), mr.toDomain());
    if (mr.MergedAt != null && businessTimeInWindow(mr.MergedAt, filter)) {
      candidates[mr.IssueID] = true;
    }
  }
  const candidateRuns = [];
  for (const run of runs) {
    if (candidates[run.ExecutionContext.IssueID]) {
      candidateRuns.push(run);
    }
  }
  const refs = this.businessDeliveryMRs(candidateRuns);
  for (const item of Object.values(items)) {
    if (!candidates[item.issue.ID]) {
      continue;
    }
    const latencies = businessCompletionToMerge(item, refs, statesByIssue[item.issue.ID], timingEvents, filter);
    const accs = [total, projects[item.issue.ProjectID], groups[projectDomains[item.issue.ProjectID]]];
    for (const acc of accs) {
      let missing = false;
      let before = false;
      for (const latency of latencies) {
        if (latency.missing) {
          acc.metrics.CompletionToMergeMissingMRs++;
          missing = true;
        } else if (latency.beforeCompletion) {
          acc.metrics.MergedBeforeCompletionMRs++;
          before = true;
        } else {
          acc.mergeLatencies.push(latency.duration);
        }
      }
      if (missing) {
        acc.metrics.CompletionToMergeMissingIssues++;
      }
      if (before) {
        acc.metrics.MergedBeforeCompletionIssues++;
      }
    }
  }
  out.DeliveryMetrics = total.result();
  for (let i = 0; i < out.Projects.length; i++) {
    out.Projects[i].DeliveryMetrics = projects[out.Projects[i].ProjectID].result();
  }
  for (let i = 0; i < out.BusinessDomains.length; i++) {
    out.BusinessDomains[i].DeliveryMetrics = groups[out.BusinessDomains[i].ID].result();
  }
  for (const [date, acc] of Object.entries(trends)) {
    const metrics = acc.result();
    out.DeliveryTrend.push(new BusinessDeliveryTrendPoint({ Date: date, CompletedIssues: metrics.CompletedIssues, MergedMRs: metrics.MergedMRs, CycleSamples: metrics.CycleSamples, AverageCycleDurationMs: metrics.AverageCycleDurationMs, ExecutionSamples: metrics.ExecutionSamples, AverageExecutionDurationMs: metrics.AverageExecutionDurationMs }));
  }
  out.DeliveryTrend.sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : 0));
};

module.exports = { businessDeliveryAccumulator, businessIssueTiming, lifecycleRow, businessIssueCompletion, businessTimeInWindow, businessExecutionDuration, unionDuration };
