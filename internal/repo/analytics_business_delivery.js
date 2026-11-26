// analytics_business_delivery.js —— 对应 Go 文件：internal/repo/analytics_business_delivery.go
// 作用：业务域交付指标：完成周期、执行耗时与合入延迟。

"use strict";

const { AnalyticsFilter } = require("../domain/analytics.js"); // 对应 Go 的 domain.AnalyticsFilter，domain 已翻译
const { Issue, IssueOperation } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue/IssueOperation，domain 已翻译
const { Run } = require("../domain/run.js"); // 对应 Go 的 domain.Run，domain 已翻译
const { BusinessDeliveryMetrics, BusinessDeliveryTrendPoint } = require("../domain/business_domain.js"); // 对应 Go 的 domain.BusinessDeliveryMetrics/BusinessDeliveryTrendPoint，domain 已翻译
const { MRDeliveryKey } = require("../domain/mr_delivery.js"); // 对应 Go 的 domain.MRDeliveryKey，domain 已翻译
const { BaselinePromoteIssueID } = require("../domain/mr.js"); // 对应 Go 的 domain.BaselinePromoteIssueID，domain 已翻译
const { RunProjectID } = require("../domain/catalog.js"); // 对应 Go 的 domain.RunProjectID，domain 已翻译
const { RunExecutionIntervals } = require("../domain/run_timing.js"); // 对应 Go 的 domain.RunExecutionIntervals，domain 已翻译
const { AnalyticsRepo, percentile, analyticsTrendBucket, isZeroTime, timeBefore, timeAfter, timeEqual, loadTimeLocation, inLocation } = require("./analytics.js"); // 对应 Go 同包类型与函数，analytics.js 已翻译
const { runEndedAt } = require("./runs.js"); // 对应 Go 同包函数，runs.js 待翻译
const { businessCompletionToMerge } = require("./analytics_business_merge.js"); // 对应 Go 同包函数，analytics_business_merge.js 已翻译

class businessDeliveryAccumulator {
  constructor(init = {}) {
    this.metrics = init.metrics ?? new BusinessDeliveryMetrics();
    this.cycles = init.cycles ?? [];
    this.executions = init.executions ?? [];
    this.mergeLatencies = init.mergeLatencies ?? [];
  }

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

  result() {
    const out = { ...this.metrics };
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

class businessIssueTiming {
  constructor(init = {}) {
    this.issue = init.issue ?? new Issue();
    this.start = init.start ?? null;
    this.latest = init.latest ?? new Run();
    this.runs = init.runs ?? [];
  }
}

class lifecycleRow {
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

// parseTime：Go 的 time.Parse(time.RFC3339Nano, s)；解析失败时返回零值（null），错误忽略。
function parseTime(s) {
  if (s == null || s === "") {
    return null;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// businessIssueCompletion never uses UpdatedAt or DeliveryUpdatedAt: both can
// move on edits / MR polling. The last successful top-level Run is an explicitly
// estimated fallback for older completed issues, never for open or failed work.
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

// businessDeliveryIssues projects only lifecycle evidence. The response remains
// aggregate-only, and SQL is restricted to the already authorized project IDs.
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

function businessTimeInWindow(at, filter) {
  return !isZeroTime(at) && (isZeroTime(filter.From) || !timeBefore(at, filter.From)) && (isZeroTime(filter.To) || !timeAfter(at, filter.To));
}

// businessExecutionDuration unions actual execution spans across all attempts
// and parallel Runs. SOP wrapper nodes are replaced by their child Run evidence
// so the child's approval/queue waits do not become parent execution time.
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
          return null; // incomplete child timing is not zero execution
        }
        wrappers[id] = true;
      } else {
        nodes[id] = node;
      }
    }
    // Go 按值遍历 runs，run.Nodes 的替换只影响副本。
    const run = { ...original, Nodes: nodes };
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
      // Legacy node rows retain only their last attempt and can include
      // approval waits. They cannot establish a wait-free duration.
      return null;
    }
    const [spans, known] = RunExecutionIntervals(run, filtered, completedAt);
    if (!known) {
      if (Object.keys(wrappers).length > 0 && Object.keys(nodes).length === 0) {
        continue; // a pure SOP wrapper contributes only its children
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

// unionDuration returns the total length of the union of intervals: spans
// that overlap or touch are counted once. intervals is sorted in place.
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

// populateBusinessDeliveryMetrics 计算业务域交付指标。prefetchedRuns/prefetchedEvents
// 可复用调用方已经取回的同一批 run 摘要与计时事件（业务域报表路径），传 nil 则
// 自行查询，两种方式的入参与结果完全一致。
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
  for (const issue of issues) {
    items[issue.ID] = new businessIssueTiming({ issue, start: issue.Clarification.StartedAt });
  }
  // The completion window must not truncate earlier attempts or their tokens.
  // RunSummariesFor omits heavy outputs/logs and retains legacy issue -> project
  // fallback. It also supplies terminal event timing for the historical fallback.
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
