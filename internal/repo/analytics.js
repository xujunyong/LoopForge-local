// analytics.js —— 对应 Go 文件：internal/repo/analytics.go
// 作用：运营分析只读视图：汇总、趋势、维度拆解与交付明细。

"use strict";

const { AnalyticsBreakdown, AnalyticsWorkflowVersion, AnalyticsUserUsage, AnalyticsProjectUsage, AnalyticsFailure, AnalyticsSummary, AnalyticsCoverage, AnalyticsSnapshot, AnalyticsTrendPoint, AnalyticsRunTrace, AnalyticsWeekHourCell } = require("../domain/analytics.js"); // 对应 Go 的 domain.Analytics*，domain 已翻译
const { WorkflowDefinition, WorkflowNode } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition/WorkflowNode，domain 已翻译
const { ExecutorDefinition } = require("../domain/agent.js"); // 对应 Go 的 domain.ExecutorDefinition，domain 已翻译
const { Issue } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue，domain 已翻译
const { RunProjectID } = require("../domain/catalog.js"); // 对应 Go 的 domain.RunProjectID，domain 已翻译
const { IsRequirementWorkItem } = require("../domain/sop_lane.js"); // 对应 Go 的 domain.IsRequirementWorkItem，domain 已翻译
const { SummarizeDeliveries } = require("../domain/mr.js"); // 对应 Go 的 domain.SummarizeDeliveries，domain 已翻译
require("../domain/delivery_mr.js"); // Issue.prototype.DeliveryMRList 的原型方法，domain 已翻译
const { parallel, runDuration, runExecutionDuration, runWaitDuration, runEndedAt, runArtifactCount, queryAnalyticsWorkflowSnapshots } = require("./runs.js"); // 对应 Go 同包函数，runs.js 待翻译
const { countDeliveryGroups } = require("./delivery.js"); // 对应 Go 同包函数，delivery.js 待翻译

// applyAnalyticsCNY、analyticsPricedRun 在 analytics_pricing.js 中定义，
// accumulateInsightModels 在 analytics_insights.js 中定义；三处与本文件循环引用，调用时现取。
function applyAnalyticsCNY(out) {
  require("./analytics_pricing.js").applyAnalyticsCNY(out);
}
function analyticsPricedRun(run) {
  return require("./analytics_pricing.js").analyticsPricedRun(run);
}
function accumulateInsightModels(models, execution) {
  require("./analytics_insights.js").accumulateInsightModels(models, execution);
}

// Go 的 time.Time 零值译为 null；timeMs 把 null 换算为 Go 零值时间的毫秒数。
function isZeroTime(t) {
  return t == null;
}
function timeMs(t) {
  return t == null ? -62135596800000 : t.getTime();
}
function timeBefore(a, b) {
  return timeMs(a) < timeMs(b);
}
function timeAfter(a, b) {
  return timeMs(a) > timeMs(b);
}
function timeEqual(a, b) {
  return timeMs(a) === timeMs(b);
}

// zeroTimeDate：Go 的 time.Time{}，即公元 1 年 1 月 1 日。
function zeroTimeDate() {
  const d = new Date(0);
  d.setUTCFullYear(1, 0, 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// formatDayUTC：Go 的 t.Format("2006-01-02")，用 UTC 取值；零值译为 0001-01-01。
function formatDayUTC(t) {
  if (t == null) {
    return "0001-01-01";
  }
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}

// formatMonthUTC：Go 的 t.Format("2006-01")，用 UTC 取值；零值译为 0001-01。
function formatMonthUTC(t) {
  if (t == null) {
    return "0001-01";
  }
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  return `${t.getUTCFullYear()}-${mm}`;
}

// isoWeek：Go 的 t.ISOWeek()，入参用 UTC 取值，返回 [年, 周]。
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return [year, week];
}

// loadTimeLocation：Go 的 time.LoadLocation；无效时区名抛错，空名取 UTC。
function loadTimeLocation(name) {
  if (name == null || name === "") {
    return { name: "UTC" };
  }
  if (name === "Local") {
    return { name: "Local" };
  }
  new Intl.DateTimeFormat("en-US", { timeZone: name });
  return { name };
}

// inLocation：Go 的 t.In(loc)，返回墙钟字段与 UTC 取值相等的平移后 Date；零值返回零值日期。
function inLocation(date, loc) {
  if (date == null) {
    return zeroTimeDate();
  }
  if (loc == null || loc.name === "UTC") {
    return new Date(date.getTime());
  }
  if (loc.offsetMs != null) {
    return new Date(date.getTime() + loc.offsetMs);
  }
  if (loc.name === "Local") {
    return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()));
  }
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: loc.name, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"), date.getMilliseconds()));
}

class analyticsAccumulator {
  constructor(init = {}) {
    this.item = init.item ?? new AnalyticsBreakdown();
    this.durations = init.durations ?? [];
    this.duration = init.duration ?? 0;
    this.execDurations = init.execDurations ?? [];
    this.execDuration = init.execDuration ?? 0;
    this.inputTokens = init.inputTokens ?? 0;
    this.outputTokens = init.outputTokens ?? 0;
    this.cacheReadTokens = init.cacheReadTokens ?? 0;
    this.cacheWriteTokens = init.cacheWriteTokens ?? 0;
    this.toolCalls = init.toolCalls ?? 0;
    this.nodeRuns = init.nodeRuns ?? 0;
    this.retriedNodes = init.retriedNodes ?? 0;
    this.reworkNodes = init.reworkNodes ?? 0;
    this.models = init.models ?? null;
    this.nodeTypes = init.nodeTypes ?? null;
    this.nodeCount = init.nodeCount ?? 0;
    this.issueIDs = init.issueIDs ?? null;
  }
}

class analyticsVersionAccumulator {
  constructor(init = {}) {
    this.item = init.item ?? new AnalyticsWorkflowVersion();
    this.durations = init.durations ?? [];
    this.duration = init.duration ?? 0;
    this.execDurations = init.execDurations ?? [];
    this.execDuration = init.execDuration ?? 0;
  }
}

class analyticsUserAccumulator {
  constructor(init = {}) {
    this.item = init.item ?? new AnalyticsUserUsage();
  }
}

class analyticsProjectAccumulator {
  constructor(init = {}) {
    this.item = init.item ?? new AnalyticsProjectUsage();
    this.issues = init.issues ?? null;
  }
}

class analyticsRunSignals {
  constructor(init = {}) {
    this.toolSucceeded = init.toolSucceeded ?? 0;
    this.toolFailed = init.toolFailed ?? 0;
    this.interventions = init.interventions ?? 0;
  }
}

// AnalyticsRepo：只读运营分析视图，对应 Go 的 repo.go 中的同名类型（repo.js 待翻译）。
// Go 的 *deps 嵌入提供 DB 与 isMySQL、sqlPayloadJSONText，JS 里随 repo.js 补齐。
class AnalyticsRepo {
  constructor(init = {}) {
    this.DB = init.DB ?? null;
    this.runs = init.runs ?? null;
    this.catalog = init.catalog ?? null;
    this.delivery = init.delivery ?? null;
    this.issues = init.issues ?? null;
    this.tasks = init.tasks ?? null;
    this.projects = init.projects ?? null;
    this.insights = init.insights ?? null;
  }

  // Analytics returns a read-only, vendor-neutral operational view across runs.
  Analytics(filter) {
    return this.analyticsWithRuns(filter, null);
  }

  // analyticsWithRuns is Analytics with an optional pre-fetched run list. Prefetched
  // runs must cover filter.ProjectIDs without a created_at window; the time window is
  // still applied in Go by the same predicates, so every aggregate is identical to
  // the self-fetching path. Nil keeps the original behavior.
  analyticsWithRuns(filter, prefetched) {
    const overview = filter.Scope === "overview";
    const now = new Date();
    const out = new AnalyticsSnapshot({
      Filter: filter,
      Summary: new AnalyticsSummary({ GeneratedAt: now }),
      Coverage: new AnalyticsCoverage({ AdapterEvents: {}, LogLevels: {} }),
    });
    // Go 用 defer applyAnalyticsCNY(&out)；JS 在每个返回点前显式调用。
    const trends = {};
    const trendIssues = {};
    const weekHourZone = analyticsWeekHourLocation(filter.TimeZone);
    const weekHour = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => new AnalyticsWeekHourCell()));
    const workflows = {};
    const agents = {};
    const executors = {};
    const models = {};
    const nodes = {};
    const categories = {};
    const sources = {};
    const versions = {};
    const users = {};
    const projects = {};
    const failures = {};
    let terminalDurations = [];
    let terminalExecDurations = [];
    let terminalDuration = 0;
    let terminalExecDuration = 0;
    let terminalWaitDuration = 0;
    let terminal = 0;
    let firstPassSucceeded = 0;
    // 需求维度：每个需求的执行次数/失败次数/节点求和耗时。
    const issueRuns = {};
    const issueFailures = {};
    const issueExec = {};
    // 成本识别与缓存命中率的累计基数。
    let costKnownRuns = 0;
    let cacheReadTotal = 0;
    let cacheDenominator = 0;
    let includedRunIDs = [];
    const runTraceIndex = {};
    let agentList = [];
    let executorList = [];
    let workflowList = [];
    let issueList = [];
    let runList = [];
    if (overview) {
      // 概览用轻量需求列 + 当前 SOP 目录，避免拉全量 payload / 每条 Run 的冻结快照。
      parallel(
        () => { runList = this.runs.RunSummariesFor(filter, ""); return null; },
        () => { issueList = this.issues.IssueAnalyticsViews(); return null; },
        () => { workflowList = this.catalog.Workflows(); return null; },
      );
    } else {
      parallel(
        () => { agentList = this.catalog.Agents(); return null; },
        () => { executorList = this.catalog.Executors(); return null; },
        () => { workflowList = this.catalog.Workflows(); return null; },
        () => { issueList = this.issues.Issues(); return null; },
        () => {
          if (prefetched != null) {
            // Runs are priced and given snapshots in place below; copy so a
            // list shared across several reports is not modified.
            runList = [...prefetched];
            return null;
          }
          runList = this.runs.RunSummariesFor(filter, "");
          return null;
        },
      );
    }

    const agentDefs = {};
    for (const agent of agentList) {
      agentDefs[agent.ID] = agent;
    }
    const executorDefs = {};
    for (const executor of executorList) {
      executorDefs[executor.ID] = executor;
    }
    const workflowDefs = {};
    for (const workflow of workflowList) {
      workflowDefs[workflow.ID] = workflow;
    }
    const issuesByID = {};
    for (const issue of issueList) {
      issuesByID[issue.ID] = issue;
    }
    // RunSummaries intentionally omits workflow snapshots on MySQL list paths.
    // Full scans need the frozen name/version/category/node bindings; overview
    // uses the live workflow catalog instead so the page does not hydrate every snapshot.
    if (this.DB != null && !overview) {
      const runIDs = [];
      for (const run of runList) {
        if (filter.WorkflowID !== "" && run.WorkflowID !== filter.WorkflowID) {
          continue;
        }
        if (!analyticsRunInWindow(run, filter) || (filter.UserID !== "" && !analyticsRunMatchesUser(run, filter.UserID, issuesByID[run.ExecutionContext.IssueID.trim()] ?? new Issue()))) {
          continue;
        }
        const issueID = run.ExecutionContext.IssueID.trim();
        if (filter.IssueSource !== "" && !analyticsIssueMatchesSource(issuesByID[issueID] ?? new Issue(), filter.IssueSource)) {
          continue;
        }
        if (filter.RequirementsOnly && !analyticsIsRequirementIssue(issuesByID[issueID] ?? new Issue())) {
          continue;
        }
        runIDs.push(run.ID);
      }
      let snapshots = null;
      try {
        snapshots = queryAnalyticsWorkflowSnapshots(this.DB, runIDs);
      } catch {
        snapshots = null;
      }
      if (snapshots != null) {
        for (let i = 0; i < runList.length; i++) {
          const snapshot = snapshots[runList[i].ID];
          if (snapshot != null) {
            runList[i].WorkflowSnapshot = snapshot;
          }
        }
      }
    }

    for (let i = 0; i < runList.length; i++) {
      runList[i] = analyticsPricedRun(runList[i]);
    }
    let platformRuns = runList;
    try {
      this.analyticsActivity(filter, issueList, platformRuns, out);
    } catch {
      out.DataErrors = ["会话统计读取失败"];
      applyAnalyticsCNY(out);
      return out;
    }
    if (filter.Origin === "external") {
      runList = null;
      platformRuns = null;
      issueList = null;
    }
    let externalRuns;
    let externalMetadata;
    try {
      [externalRuns, externalMetadata] = this.analyticsInsightRuns(filter);
    } catch {
      out.DataErrors = ["外部用量读取失败"];
      applyAnalyticsCNY(out);
      return out;
    }
    runList = [...(runList ?? []), ...externalRuns];
    let qualityTerminal = 0;
    let executionMeasured = 0;
    const conversationIssues = {};
    const conversationTrendIssues = {};

    for (const run of runList) {
      const external = externalMetadata[run.ID] ?? null;
      const isExternal = external != null;
      if (filter.WorkflowID !== "" && run.WorkflowID !== filter.WorkflowID) {
        continue;
      }
      if (!isExternal && !analyticsRunInWindow(run, filter)) {
        continue;
      }
      const issueID = run.ExecutionContext.IssueID.trim();
      if (filter.UserID !== "" && !analyticsRunMatchesUser(run, filter.UserID, issuesByID[issueID] ?? new Issue())) {
        continue;
      }
      if (filter.IssueSource !== "" && !analyticsIssueMatchesSource(issuesByID[issueID] ?? new Issue(), filter.IssueSource)) {
        continue;
      }
      if (filter.RequirementsOnly && !analyticsIsRequirementIssue(issuesByID[issueID] ?? new Issue())) {
        continue;
      }
      if (!isExternal && run.IsWorkspace()) {
        accumulateConversationRun(out.Summary, conversationIssues, trends, conversationTrendIssues, users, projects, sources, run, issuesByID[issueID] ?? new Issue(), filter.Grain);
        continue;
      }
      if (!isExternal) {
        includedRunIDs.push(run.ID);
        out.Summary.QualityRuns++;
        out.Demo.CoveredRuns++;
      } else {
        out.Summary.ExternalRuns++;
      }

      out.Summary.TotalRuns++;
      out.Summary.TotalTokens += run.Usage.TotalTokens;
      out.Summary.TotalCostUSD += run.Usage.CostUSD;
      out.Summary.InputTokens += run.Usage.InputTokens;
      out.Summary.OutputTokens += run.Usage.OutputTokens;
      out.Summary.CacheReadTokens += run.Usage.CacheReadTokens;
      out.Summary.CacheWriteTokens += run.Usage.CacheWriteTokens;
      out.Summary.ReasoningTokens += run.Usage.ReasoningTokens;
      cacheReadTotal += run.Usage.CacheReadTokens;
      cacheDenominator += run.Usage.InputTokens;
      if (!isExternal) {
        cacheDenominator += run.Usage.CacheReadTokens;
      }
      out.Summary.CostReportedUSD += run.Usage.CostUSD;
      if (usageCostKnown(run.Usage)) {
        costKnownRuns++;
      } else {
        out.Summary.CostUnknownRuns++;
      }
      out.Summary.ToolCalls += run.ToolCalls;
      out.Summary.Artifacts += runArtifactCount(run);
      out.Summary.TelemetryEvents += run.TelemetrySequence;
      if ((run.Telemetry ?? []).length > run.TelemetrySequence) {
        out.Summary.TelemetryEvents += (run.Telemetry ?? []).length - run.TelemetrySequence;
      }
      out.Summary.LogRecords += run.LogSequence;
      if ((run.Logs ?? []).length > run.LogSequence) {
        out.Summary.LogRecords += (run.Logs ?? []).length - run.LogSequence;
      }
      if (run.TelemetrySequence > 0 || (run.Telemetry ?? []).length > 0) {
        out.Coverage.RunsWithTelemetry++;
      }
      if (run.LogSequence > 0 || (run.Logs ?? []).length > 0) {
        out.Coverage.RunsWithLogs++;
      }

      const reworks = runReworks(run);
      out.Summary.TotalReworks += reworks;
      if (reworks > 0) {
        out.Summary.ReworkedRuns++;
      }
      let [duration, complete] = analyticsRunDuration(run, now);
      // 执行耗时为 SOP 节点耗时之和，不含审批/排队/恢复等待。
      let execDuration = runExecutionDuration(run);
      const execKnown = !isExternal || external.execution.ExecutionDurationMs != null;
      if (isExternal) {
        duration = timeMs(external.execution.FinishedAt) - timeMs(external.execution.StartedAt);
        if (execKnown) {
          execDuration = external.execution.ExecutionDurationMs;
        }
      }
      if (complete) {
        terminal++;
        terminalDuration += duration;
        terminalDurations.push(duration);
        if (execKnown) {
          executionMeasured++;
          terminalExecDuration += execDuration;
          terminalExecDurations.push(execDuration);
        }
        if (!isExternal) {
          qualityTerminal++;
          terminalWaitDuration += runWaitDuration(run, now);
        }
      }
      switch (run.Status) {
        case "running":
          out.Summary.ActiveRuns++;
          break;
        case "waiting":
          out.Summary.WaitingRuns++;
          break;
        case "succeeded":
          out.Summary.SucceededRuns++;
          if (!isExternal) {
            out.Demo.CoveredSucceededRuns++;
          }
          if (!isExternal && reworks === 0) {
            firstPassSucceeded++;
          }
          break;
        case "failed":
          out.Summary.FailedRuns++;
          if (issueID !== "") {
            issueFailures[issueID] = (issueFailures[issueID] ?? 0) + 1;
          }
          break;
        case "cancelled":
          out.Summary.CancelledRuns++;
          break;
        default:
          break;
      }
      const issue = issuesByID[issueID] ?? new Issue();
      let traceID = run.ExecutionContext.TraceID.trim();
      if (traceID === "") {
        traceID = run.ID;
      }
      const projectID = RunProjectID(run, issue.ProjectID);
      const [errorNodeID, errorMessage] = analyticsRunError(run);
      const trace = new AnalyticsRunTrace({
        ProjectID: projectID, IssueID: issueID, IssueSource: analyticsIssueSource(issue), WorkflowTaskID: run.ExecutionContext.TaskID,
        RunID: run.ID, TraceID: traceID, Status: run.Status, DurationMs: duration,
        Tokens: run.Usage.TotalTokens, CostUSD: run.Usage.CostUSD, CostKnown: usageCostKnown(run.Usage),
        ToolCalls: run.ToolCalls, ErrorNodeID: errorNodeID, ErrorMessage: errorMessage,
        CreatedAt: run.CreatedAt,
      });
      const tapdID = issue.RequirementTAPDID();
      if (tapdID !== "") {
        trace.ExternalID = tapdID;
      }
      if (issue.ExternalRef != null) {
        trace.ExternalURL = issue.ExternalRef.ExternalURL;
      }
      if (complete) {
        trace.FinishedAt = runEndedAt(run, now);
      }
      if (isExternal) {
        trace.ExecutionDurationMs = external.execution.ExecutionDurationMs;
        trace.Origin = "external";
        trace.SourceID = external.sourceID;
        trace.WorkflowName = external.execution.Workflow.Name;
        trace.ExternalID = external.execution.ExternalExecutionID;
        trace.ExternalURL = external.execution.URL;
        trace.IssueSource = "";
        trace.FinishedAt = external.execution.FinishedAt;
      }
      runTraceIndex[run.ID] = out.RunTraces.length;
      out.RunTraces.push(trace);
      if (issueID !== "") {
        issueRuns[issueID] = (issueRuns[issueID] ?? 0) + 1;
        issueExec[issueID] = (issueExec[issueID] ?? 0) + execDuration;
        accumulateIssueSource(sources, analyticsIssueSource(issuesByID[issueID] ?? new Issue()), run, execDuration);
      }

      let workflow = run.WorkflowSnapshot;
      if (workflow.ID === "") {
        workflow = workflowDefs[run.WorkflowID] ?? new WorkflowDefinition();
      }
      let workflowName = workflow.Name;
      if (workflowName === "") {
        workflowName = run.WorkflowID;
      }
      const category = analyticsWorkflowCategory(workflow, workflowDefs[run.WorkflowID] ?? new WorkflowDefinition());
      accumulateBreakdown(workflows, run.WorkflowID, workflowName, run, reworks, duration, complete, execDuration);
      const workflowAcc = workflows[run.WorkflowID];
      if (workflowAcc != null) {
        workflowAcc.item.Category = category;
        workflowAcc.nodeCount = (workflow.Nodes ?? []).length;
        workflowAcc.nodeTypes = analyticsNodeTypes(workflow.Nodes);
      }
      if (!isExternal) {
        accumulateVersion(versions, run.WorkflowID, workflowName, workflow.Version, (workflowDefs[run.WorkflowID] ?? new WorkflowDefinition()).Version, run, duration, complete, execDuration);
        accumulateBreakdown(categories, category, "", run, reworks, duration, complete, execDuration);
        const categoryAcc = categories[category];
        if (categoryAcc != null && issueID !== "") {
          if (categoryAcc.issueIDs == null) {
            categoryAcc.issueIDs = {};
          }
          if (run.Status === "succeeded") {
            categoryAcc.issueIDs[issueID] = true;
          }
        }
      } else {
        const acc = workflows[run.WorkflowID];
        acc.item.QualityUnknownRuns++;
        if (!execKnown) {
          acc.execDurations = acc.execDurations.slice(0, acc.execDurations.length - 1);
        }
      }
      // 趋势与每用户每日用量在概览态同样输出，节点级拆解仍只在完整扫描时计算。
      let eventAt = run.CreatedAt;
      if (complete) {
        eventAt = runEndedAt(run, now);
      }
      if (isExternal) {
        eventAt = external.execution.FinishedAt;
      }
      const day = formatDayUTC(eventAt);
      const bucket = analyticsTrendBucket(eventAt, filter.Grain);
      const point = analyticsTrendEntry(trends, bucket);
      point.Runs++;
      if (!usageCostKnown(run.Usage)) {
        point.CostUnknownRuns++;
      }
      point.Reworks += reworks;
      point.Tokens += run.Usage.TotalTokens;
      point.CostUSD += run.Usage.CostUSD;
      point.InputTokens += run.Usage.InputTokens;
      point.OutputTokens += run.Usage.OutputTokens;
      point.CacheReadTokens += run.Usage.CacheReadTokens;
      point.CacheWriteTokens += run.Usage.CacheWriteTokens;
      point.ExecutionDurationMs += execDuration;
      if (complete) {
        point.DurationMs += duration;
      }
      if (run.Status === "succeeded") {
        point.Succeeded++;
      }
      if (run.Status === "failed") {
        point.Failed++;
      }
      const local = inLocation(eventAt, weekHourZone);
      const cell = weekHour[(local.getUTCDay() + 6) % 7][local.getUTCHours()];
      cell.Runs++;
      cell.Tokens += run.Usage.TotalTokens;
      cell.CostUSD += run.Usage.CostUSD;
      addAnalyticsTrendIssue(trendIssues, bucket, issueID);
      accumulateUserUsage(users, analyticsRunUserID(run, issuesByID[issueID] ?? new Issue()), day, run, duration, complete, execDuration);
      accumulateProjectUsage(projects, RunProjectID(run, (issuesByID[issueID] ?? new Issue()).ProjectID), issueID, run);
      if (isExternal) {
        accumulateInsightModels(models, external.execution);
        continue;
      }
      const definition = {};
      for (const node of workflow.Nodes ?? []) {
        definition[node.ID] = node;
      }
      for (const [nodeID, nodeRun] of Object.entries(run.Nodes ?? {})) {
        if (nodeRun == null) {
          continue;
        }
        const node = definition[nodeID] ?? new WorkflowNode();
        let nodeDuration = 0;
        const nodeComplete = !isZeroTime(nodeRun.StartedAt) && !isZeroTime(nodeRun.FinishedAt);
        if (nodeComplete) {
          nodeDuration = nodeRun.FinishedAt.getTime() - nodeRun.StartedAt.getTime();
        }
        const key = run.WorkflowID + "/" + nodeID;
        let name = node.Name;
        if (name === "") {
          name = nodeID;
        }
        accumulateNode(nodes, key, name, nodeRun, nodeDuration, nodeComplete);
        let model = nodeRun.Model;
        if (model === "" && node.ExecutorID !== "") {
          model = (executorDefs[node.ExecutorID] ?? new ExecutorDefinition()).Model;
        }
        if (model !== "") {
          accumulateNode(models, model, model, nodeRun, nodeDuration, nodeComplete);
        }
        if (nodeRun.Error !== "") {
          const code = normalizeFailure(nodeRun.Error);
          const failureKey = nodeID + "\x00" + code;
          if (failures[failureKey] == null) {
            failures[failureKey] = new AnalyticsFailure({ Code: code, NodeID: nodeID });
          }
          failures[failureKey].Count++;
        }
        if (!overview) {
          if (node.AgentID !== "") {
            accumulateNode(agents, node.AgentID, agentName(agentDefs, node.AgentID), nodeRun, nodeDuration, nodeComplete);
          }
          if (node.ExecutorID !== "") {
            accumulateNode(executors, node.ExecutorID, executorName(executorDefs, node.ExecutorID), nodeRun, nodeDuration, nodeComplete);
          }
        }
      }
    }

    // Tool outcome and human-decision facts live in append-only event tables,
    // not in Run summary columns. Load only matching tool-finish telemetry and
    // compact control events, then join them back to each auditable Run row.
    const signals = this.analyticsRunSignals(includedRunIDs);
    for (const [runID, signal] of Object.entries(signals)) {
      const index = runTraceIndex[runID];
      if (index == null) {
        continue;
      }
      const trace = out.RunTraces[index];
      trace.ToolCallsSucceeded = signal.toolSucceeded;
      trace.ToolCallsFailed = signal.toolFailed;
      trace.HumanInterventions = signal.interventions;
      out.Demo.ToolCallsSucceeded += signal.toolSucceeded;
      out.Demo.ToolCallsFailed += signal.toolFailed;
      out.Demo.HumanInterventions += signal.interventions;
    }
    out.Demo.ToolCallsObserved = out.Demo.ToolCallsSucceeded + out.Demo.ToolCallsFailed;
    if (out.Demo.ToolCallsObserved > 0) {
      out.Demo.ToolSuccessRate = (out.Demo.ToolCallsSucceeded * 100) / out.Demo.ToolCallsObserved;
    }
    for (const trace of out.RunTraces) {
      if (trace.Origin !== "external" && trace.Status === "succeeded" && trace.HumanInterventions === 0) {
        out.Demo.AutomatedSucceededRuns++;
      }
    }
    out.Summary.ConversationIssues = Object.keys(conversationIssues).length;
    for (const id of Object.keys(conversationIssues)) {
      const issue = issuesByID[id] ?? new Issue();
      if ((issue.DeliveryMRList() ?? []).length > 0) {
        out.Summary.ConversationIssuesWithMR++;
      }
      if (issue.DeliveryState === "merged") {
        out.Summary.ConversationIssuesDelivered++;
      }
    }
    if (out.Summary.TotalRuns > 0) {
      out.Demo.AverageTokensPerRun = (out.Summary.TotalTokens - out.Summary.ConversationTokens) / out.Summary.TotalRuns;
      if (out.Demo.CoveredRuns > 0) {
        out.Demo.AverageHumanInterventions = out.Demo.HumanInterventions / out.Demo.CoveredRuns;
      }
    }
    if (out.Demo.CoveredSucceededRuns > 0) {
      out.Demo.AutomationRate = (out.Demo.AutomatedSucceededRuns * 100) / out.Demo.CoveredSucceededRuns;
    }
    out.RunTraces.sort((a, b) => {
      if (timeEqual(a.CreatedAt, b.CreatedAt)) {
        return a.RunID > b.RunID ? -1 : a.RunID < b.RunID ? 1 : 0;
      }
      return timeAfter(a.CreatedAt, b.CreatedAt) ? -1 : 1;
    });
    // Coverage counts adapter/level distributions over the included runs. On
    // MySQL the generated columns make this an indexed GROUP BY; other
    // dialects (tests) compute the same numbers from the payloads.
    if (!overview && includedRunIDs.length > 0) {
      if (this.isMySQL()) {
        let coverageResult = null;
        try {
          coverageResult = queryAnalyticsCoverage(this.DB, includedRunIDs);
        } catch {
          coverageResult = null;
        }
        if (coverageResult != null) {
          const [adapters, levels] = coverageResult;
          out.Coverage.AdapterEvents = adapters;
          out.Coverage.LogLevels = levels;
        }
      } else {
        this.computeAnalyticsCoverage(includedRunIDs, out.Coverage);
      }
    }

    if (terminal > 0) {
      out.Summary.CompletionRate = (out.Summary.SucceededRuns * 100) / terminal;
      if (qualityTerminal > 0) {
        out.Summary.FirstPassRate = (firstPassSucceeded * 100) / qualityTerminal;
      }
      out.Summary.AverageDurationMs = Math.trunc(terminalDuration / terminal);
      out.Summary.CancelRate = (out.Summary.CancelledRuns * 100) / terminal;
      if (executionMeasured > 0) {
        out.Summary.ExecutionAverageDurationMs = Math.trunc(terminalExecDuration / executionMeasured);
      }
    }
    const attempts = out.Summary.SucceededRuns + out.Summary.FailedRuns;
    if (attempts > 0) {
      // 成功率排除取消的执行，取消率单独成列，避免"取消"污染成功率分母。
      out.Summary.SuccessRate = (out.Summary.SucceededRuns * 100) / attempts;
    }
    if (cacheDenominator > 0) {
      out.Summary.CacheHitRate = (cacheReadTotal * 100) / cacheDenominator;
    }
    if (out.Summary.TotalRuns > 0) {
      out.Summary.CostCoveragePct = (costKnownRuns * 100) / out.Summary.TotalRuns;
    }
    if (qualityTerminal > 0) {
      out.Summary.WaitAverageDurationMs = Math.trunc(terminalWaitDuration / qualityTerminal);
    }
    const issueCount = Object.keys(issueRuns).length;
    if (issueCount > 0) {
      out.Summary.UniqueIssues = issueCount;
      out.Summary.RunsPerIssue = sumIssueCounts(issueRuns) / issueCount;
      out.Summary.FailuresPerIssue = sumIssueCounts(issueFailures) / issueCount;
    }
    out.Summary.P50DurationMs = percentile(terminalDurations, 50);
    out.Summary.P95DurationMs = percentile(terminalDurations, 95);
    out.Summary.P99DurationMs = percentile(terminalDurations, 99);
    out.Summary.ExecutionP50DurationMs = percentile(terminalExecDurations, 50);
    out.Summary.ExecutionP95DurationMs = percentile(terminalExecDurations, 95);
    out.Summary.ExecutionP99DurationMs = percentile(terminalExecDurations, 99);
    const execValues = issueExecValues(issueExec);
    if (execValues.length > 0) {
      out.Summary.IssueP50ExecutionDurationMs = percentile(execValues, 50);
      out.Summary.IssueP95ExecutionDurationMs = percentile(execValues, 95);
    }
    // 轻量维度（SOP、模型、失败原因、用户每日用量）在概览态同样输出，
    // Agent/CLI 与交付明细仍只在完整扫描时计算。
    out.Workflows = finalizeBreakdowns(workflows);
    out.Categories = finalizeBreakdowns(categories);
    out.WorkflowVersions = finalizeWorkflowVersions(versions);
    out.IssueSources = finalizeBreakdowns(sources);
    out.UserUsage = finalizeUserUsage(users);
    out.ProjectUsage = finalizeProjectUsage(projects);
    out.Models = finalizeBreakdowns(models);
    out.Nodes = finalizeBreakdowns(nodes);
    applyBreakdownShares(out.Workflows, out.Summary.TotalTokens, out.Summary.TotalCostUSD);
    applyBreakdownShares(out.Categories, out.Summary.TotalTokens, out.Summary.TotalCostUSD);
    applyBreakdownShares(out.IssueSources, out.Summary.TotalTokens, out.Summary.TotalCostUSD);
    applyBreakdownShares(out.Models, out.Summary.TotalTokens, out.Summary.TotalCostUSD);
    applyBreakdownShares(out.Nodes, out.Summary.TotalTokens, out.Summary.TotalCostUSD);
    for (const failure of Object.values(failures)) {
      out.Failures.push(failure);
    }
    out.Failures.sort((a, b) => (a.Count > b.Count ? -1 : a.Count < b.Count ? 1 : 0));
    const [mrMerges, mergedMRsMissingTime] = this.mrMergeAnalytics(filter, issuesByID);
    out.MRMerges = mrMerges;
    out.Summary.MergedMRsMissingTime = mergedMRsMissingTime;
    out.Summary.MergedMRs = out.MRMerges.length;
    for (const mr of out.MRMerges) {
      analyticsTrendEntry(trends, analyticsTrendBucket(mr.MergedAt, filter.Grain)).MergedMRs++;
    }
    for (const point of Object.values(trends)) {
      const ids = trendIssues[point.Date];
      if (ids != null) {
        point.Issues = Object.keys(ids).length;
      }
      point.ConversationIssues = Object.keys(conversationTrendIssues[point.Date] ?? {}).length;
      out.Trend.push(point);
    }
    out.Trend.sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : 0));
    for (let weekday = 0; weekday < weekHour.length; weekday++) {
      for (let hour = 0; hour < weekHour[weekday].length; hour++) {
        const cell = weekHour[weekday][hour];
        if (cell.Runs === 0) {
          continue;
        }
        cell.Weekday = weekday;
        cell.Hour = hour;
        out.WeekHour.push(cell);
      }
    }
    if (overview) {
      if (filter.Origin !== "external") {
        out.Delivery.Issues = countDeliveryGroups(filter, platformRuns, issuesByID);
      }
      out.Summary.InProgressIssues = countInProgressIssues(issueList, filter);
      applyAnalyticsCNY(out);
      return out;
    }
    out.Agents = finalizeBreakdowns(agents);
    out.Executors = finalizeBreakdowns(executors);
    applyBreakdownShares(out.Agents, out.Summary.TotalTokens, out.Summary.TotalCostUSD);
    applyBreakdownShares(out.Executors, out.Summary.TotalTokens, out.Summary.TotalCostUSD);
    if (filter.Origin !== "external") {
      out.Deliveries = this.delivery.buildDeliveries(filter, now, platformRuns, workflowDefs, issuesByID);
    }
    out.Delivery = SummarizeDeliveries(out.Deliveries);
    applyWeeklyThroughput(out.Summary, out.Deliveries, now);
    out.Summary.InProgressIssues = countInProgressIssues(issueList, filter);
    applyAnalyticsCNY(out);
    return out;
  }

  // analyticsHumanEventTypes are explicit human decisions. run.paused / run.resumed
  // are excluded: they fire on user pause, but also on lease takeover and service
  // recovery, and a single approval often emits pause+resume+gate together.
  // （常量定义在类外，见 analyticsHumanEventTypes。）

  // analyticsRunSignals reads only the append-only facts needed by the Loop
  // demo. It deliberately avoids hydrating logs, output, artifacts, and ordinary
  // progress telemetry into the analytics request.
  analyticsRunSignals(runIDs) {
    const out = {};
    for (let start = 0; start < runIDs.length; start += 500) {
      const batch = runIDs.slice(start, Math.min(start + 500, runIDs.length));
      this.accumulateToolSignals(out, batch);

      const eventRows = []; // Go: var eventRows []runEventRow（models.go 待翻译）
      const err = this.DB.Select("run_id", "type").Where("run_id IN ? AND type IN ?", batch, analyticsHumanEventTypes).Find(eventRows).Error;
      if (err == null) {
        for (const row of eventRows) {
          const signal = out[row.RunID] ?? new analyticsRunSignals();
          signal.interventions++;
          out[row.RunID] = signal;
        }
      }
    }
    return out;
  }

  accumulateToolSignals(out, batch) {
    if (batch.length === 0 || this.DB == null) {
      return;
    }
    let successExpr = "CASE WHEN json_extract(payload, '$.tool.success') IS NOT NULL THEN json_extract(payload, '$.tool.success') ELSE (CASE WHEN lower(coalesce(json_extract(payload, '$.level'), '')) = 'error' THEN 0 ELSE 1 END) END";
    let filter = "json_extract(payload, '$.category') = ? AND json_extract(payload, '$.name') = ? AND json_extract(payload, '$.phase') = ?";
    if (this.isMySQL()) {
      successExpr = "CASE WHEN JSON_EXTRACT(payload, '$.tool.success') IS NOT NULL THEN JSON_EXTRACT(payload, '$.tool.success') ELSE (LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.level')), '')) <> 'error') END";
      filter = "JSON_UNQUOTE(JSON_EXTRACT(payload, '$.category')) = ? AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.name')) = ? AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.phase')) = ?";
    }
    const rows = []; // Go: var rows []toolRow（本函数内定义的行类型）
    const err = this.DB.Table("run_telemetry")
      .Select("run_id, SUM(" + successExpr + ") AS succeeded, SUM(1-(" + successExpr + ")) AS failed")
      .Where("run_id IN ? AND " + filter, batch, "tool", "tool.call", "finish")
      .Group("run_id")
      .Scan(rows).Error;
    if (err != null) {
      return;
    }
    for (const row of rows) {
      const signal = out[row.RunID] ?? new analyticsRunSignals();
      signal.toolSucceeded += row.Succeeded;
      signal.toolFailed += row.Failed;
      out[row.RunID] = signal;
    }
  }

  // computeAnalyticsCoverage derives adapter/level coverage from raw payloads
  // for dialects without the generated columns (test sqlite databases).
  computeAnalyticsCoverage(runIDs, coverage) {
    for (const runID of runIDs) {
      let telemetry;
      try {
        telemetry = this.runs.loadRunTelemetryAll(runID);
      } catch {
        continue;
      }
      for (const event of telemetry) {
        let adapter = event.Source.Adapter;
        if (adapter === "") {
          adapter = "unknown";
        }
        coverage.AdapterEvents[adapter] = (coverage.AdapterEvents[adapter] ?? 0) + 1;
      }
      let logs;
      try {
        logs = this.runs.loadRunLogsAll(runID);
      } catch {
        continue;
      }
      for (const record of logs) {
        let level = record.Level;
        if (level === "") {
          level = "info";
        }
        coverage.LogLevels[level] = (coverage.LogLevels[level] ?? 0) + 1;
      }
    }
  }
}

const analyticsHumanEventTypes = [
  "gate.approved",
  "node.passed",
  "gate.rejected",
  "node.retry_requested",
  "agent.turns.declined",
];

// queryAnalyticsCoverage groups telemetry adapters and log levels using the
// MySQL generated columns.
function queryAnalyticsCoverage(db, runIDs) {
  const adapters = {};
  const levels = {};
  const placeholders = runIDs.map(() => "?").join(",");
  const args = [...runIDs];
  const coverageArgs = [...args, ...args];
  const rows = []; // Go: var rows []coverageRow（本函数内定义的行类型）
  const err = db.Raw(`
		SELECT 'adapter' AS kind, adapter AS value, COUNT(*) AS count
		FROM run_telemetry WHERE run_id IN (${placeholders}) GROUP BY value
		UNION ALL
		SELECT 'level' AS kind, level AS value, COUNT(*) AS count
		FROM run_logs WHERE run_id IN (${placeholders}) GROUP BY value`, ...coverageArgs).Scan(rows).Error;
  if (err != null) {
    throw err;
  }
  for (const row of rows) {
    if (row.Kind === "adapter") {
      adapters[row.Value] = row.Count;
    } else {
      levels[row.Value] = row.Count;
    }
  }
  return [adapters, levels];
}

function runReworks(run) {
  let total = 0;
  for (const node of Object.values(run.Nodes ?? {})) {
    total += node.ReworkCount;
  }
  return total;
}

function analyticsRunDuration(run, now) {
  const complete = run.Status === "succeeded" || run.Status === "failed" || run.Status === "cancelled";
  return [runDuration(run, now), complete];
}

// analyticsWeekHourLocation resolves the heatmap zone; unknown or empty zones fall back to Asia/Shanghai.
function analyticsWeekHourLocation(name) {
  name = (name ?? "").trim();
  if (name === "" || name === "Local") {
    name = "Asia/Shanghai";
  }
  try {
    return loadTimeLocation(name);
  } catch {
    // Go：LoadLocation 失败时回退到 Asia/Shanghai。
  }
  try {
    return loadTimeLocation("Asia/Shanghai");
  } catch {
    // Go：再失败时用固定 +8 小时时区。
  }
  return { name: "Asia/Shanghai", offsetMs: 8 * 3600 * 1000 };
}

function analyticsTrendBucket(at, grain) {
  const d = at ?? zeroTimeDate();
  switch ((grain ?? "").toLowerCase().trim()) {
    case "week": {
      const [year, week] = isoWeek(d);
      return `${year}-W${String(week).padStart(2, "0")}`;
    }
    case "month":
    case "all":
      return formatMonthUTC(d);
    default:
      return formatDayUTC(d);
  }
}

// analyticsTrendEntry 取用 bucket 对应的趋势点，缺失时新建并存回。
function analyticsTrendEntry(trends, bucket) {
  let point = trends[bucket];
  if (point == null) {
    point = new AnalyticsTrendPoint({ Date: bucket });
    trends[bucket] = point;
  }
  return point;
}

// addAnalyticsTrendIssue 把需求 ID 记入 bucket 的需求集合；issueID 为空时不登记。
function addAnalyticsTrendIssue(trendIssues, bucket, issueID) {
  if (issueID === "") {
    return;
  }
  if (trendIssues[bucket] == null) {
    trendIssues[bucket] = {};
  }
  trendIssues[bucket][issueID] = true;
}

// analyticsRunInWindow 保持与既有行为一致：按 Run 创建时间过滤。
function analyticsRunInWindow(run, filter) {
  if (!isZeroTime(filter.From) && timeBefore(run.CreatedAt, filter.From)) {
    return false;
  }
  if (!isZeroTime(filter.To) && timeAfter(run.CreatedAt, filter.To)) {
    return false;
  }
  return true;
}

function analyticsRunMatchesUser(run, userID, issue) {
  const want = (userID ?? "").trim();
  if (want === "") {
    return true;
  }
  if (String(run.ExecutionContext.ResponsibleUserID) === want) {
    return true;
  }
  return issue.AssigneeUserID !== 0 && String(issue.AssigneeUserID) === want;
}

// analyticsRunUserID 返回执行责任人；未写入时回退到需求责任人。
function analyticsRunUserID(run, issue) {
  if (run.ExecutionContext.ResponsibleUserID !== 0) {
    return String(run.ExecutionContext.ResponsibleUserID);
  }
  if (issue.AssigneeUserID !== 0) {
    return String(issue.AssigneeUserID);
  }
  return "";
}

function analyticsIssueMatchesSource(issue, source) {
  const want = (source ?? "").toLowerCase().trim();
  if (want === "") {
    return true;
  }
  let got = (issue.Source ?? "").toLowerCase().trim();
  if (got === "") {
    got = "local";
  }
  return got === want;
}

function analyticsIsRequirementIssue(issue) {
  return issue.ID !== "" && IsRequirementWorkItem(issue);
}

// usageCostKnown 区分"成本为 0"与"成本未识别"：显式上报/估算视为已识别，
// 旧数据（无 costStatus）按是否有成本金额判定。
function usageCostKnown(usage) {
  switch ((usage.CostStatus ?? "").toLowerCase().trim()) {
    case "reported":
    case "estimated":
      return true;
    case "unknown":
      return false;
    default:
      break;
  }
  return usage.CostUSD > 0;
}

// analyticsWorkflowCategory 取 SOP 的受控统计标签，优先使用 Run 冻结的快照。
function analyticsWorkflowCategory(snapshot, fallback) {
  const category = (snapshot.MetricCategory ?? "").trim();
  if (category !== "") {
    return category;
  }
  return (fallback.MetricCategory ?? "").trim();
}

function analyticsNodeTypes(nodes) {
  const out = {};
  for (const node of nodes ?? []) {
    let kind = (node.Type ?? "").trim();
    if (kind === "") {
      kind = "unknown";
    }
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

function sumIssueCounts(values) {
  let total = 0;
  for (const count of Object.values(values)) {
    total += count;
  }
  return total;
}

function issueExecValues(values) {
  const out = [];
  for (const value of Object.values(values)) {
    out.push(value);
  }
  return out;
}

// countInProgressIssues 统计仍未闭环的需求数（WIP 快照）。
function countInProgressIssues(issues, filter) {
  let total = 0;
  for (const issue of issues ?? []) {
    if (!filter.MatchesProject(issue.ProjectID)) {
      continue;
    }
    if (filter.WorkflowID !== "" && issue.WorkflowID !== filter.WorkflowID) {
      continue;
    }
    if (filter.IssueSource !== "" && !analyticsIssueMatchesSource(issue, filter.IssueSource)) {
      continue;
    }
    if (filter.RequirementsOnly && !analyticsIsRequirementIssue(issue)) {
      continue;
    }
    if (filter.UserID !== "" && String(issue.AssigneeUserID) !== filter.UserID) {
      continue;
    }
    if (!issueInProgress(issue)) {
      continue;
    }
    total++;
  }
  return total;
}

function issueInProgress(issue) {
  if ((issue.DeliveryState ?? "").trim().toLowerCase() === "merged") {
    return false;
  }
  switch ((issue.Status ?? "").toLowerCase().trim()) {
    case "done":
    case "closed":
    case "cancelled":
    case "canceled":
      return false;
    default:
      break;
  }
  return true;
}

// applyWeeklyThroughput 计算近 7 天的人均吞吐：唯一交付需求数 ÷ 有交付的成员数。
function applyWeeklyThroughput(summary, deliveries, now) {
  const since = new Date(now.getTime());
  since.setUTCDate(since.getUTCDate() - 7);
  const until = new Date(now.getTime() + 60000);
  const issues = {};
  const contributors = {};
  for (const item of deliveries ?? []) {
    if (!item.Delivered || isZeroTime(item.LastRunAt)) {
      continue;
    }
    if (timeBefore(item.LastRunAt, since) || timeAfter(item.LastRunAt, until)) {
      continue;
    }
    issues[item.IssueID] = true;
    if (item.UserID !== "") {
      contributors[item.UserID] = true;
    }
  }
  summary.WeeklyDeliveredIssues = Object.keys(issues).length;
  summary.WeeklyActiveContributors = Object.keys(contributors).length;
  if (Object.keys(contributors).length > 0) {
    summary.WeeklyThroughputPerUser = Object.keys(issues).length / Object.keys(contributors).length;
  }
}

function analyticsRunError(run) {
  const ids = [];
  for (const [id, node] of Object.entries(run.Nodes ?? {})) {
    if (node != null && node.Error.trim() !== "") {
      ids.push(id);
    }
  }
  if (ids.length === 0) {
    return ["", ""];
  }
  ids.sort();
  const node = run.Nodes[ids[0]];
  return [ids[0], normalizeFailure(node.Error)];
}

function accumulateBreakdown(values, key, name, run, reworks, duration, complete, execDuration) {
  let value = values[key];
  if (value == null) {
    value = new analyticsAccumulator({ item: new AnalyticsBreakdown({ Key: key, Name: name }) });
    values[key] = value;
  }
  if (name !== "") {
    value.item.Name = name;
  }
  value.item.Runs++;
  value.item.Reworks += reworks;
  value.item.ToolCalls += run.ToolCalls;
  accumulateBreakdownUsage(value, run.Usage);
  countBreakdownStatus(value.item, run.Status, run.Status === "running" || run.Status === "waiting");
  if (complete) {
    accumulateBreakdownDuration(value, duration, execDuration);
  }
}

// accumulateBreakdownUsage 把单次执行的用量累加到维度累加器：Token/成本总量、
// 成本未识别计数与 Token 四分项。dimension 维度（SOP、节点、模型等）共用。
function accumulateBreakdownUsage(value, usage) {
  if (!usageCostKnown(usage)) {
    value.item.CostUnknownRuns++;
  }
  value.item.Tokens += usage.TotalTokens;
  value.item.CostUSD += usage.CostUSD;
  value.inputTokens += usage.InputTokens;
  value.outputTokens += usage.OutputTokens;
  value.cacheReadTokens += usage.CacheReadTokens;
  value.cacheWriteTokens += usage.CacheWriteTokens;
}

// countBreakdownStatus 按执行状态累加维度终态计数，active 由调用方按各自的状态词表判定。
function countBreakdownStatus(item, status, active) {
  switch (status) {
    case "succeeded":
      item.Succeeded++;
      break;
    case "failed":
      item.Failed++;
      break;
    case "cancelled":
      item.Cancelled++;
      break;
    default:
      break;
  }
  if (active) {
    item.Active++;
  }
}

// accumulateBreakdownDuration 记录一次有效耗时样本，供均值与 P95 使用。
function accumulateBreakdownDuration(value, duration, execDuration) {
  value.duration += duration;
  value.durations.push(duration);
  value.execDuration += execDuration;
  value.execDurations.push(execDuration);
}

function accumulateNode(values, key, name, node, duration, complete) {
  let value = values[key];
  if (value == null) {
    value = new analyticsAccumulator({ item: new AnalyticsBreakdown({ Key: key, Name: name }) });
    values[key] = value;
  }
  if (name !== "") {
    value.item.Name = name;
  }
  value.item.Runs++;
  value.item.Reworks += node.ReworkCount;
  value.item.ToolCalls += node.ToolCalls;
  accumulateBreakdownUsage(value, node.Usage);
  value.nodeRuns++;
  if (node.Attempt > 1) {
    value.retriedNodes++;
  }
  if (node.ReworkCount > 0) {
    value.reworkNodes++;
  }
  if (node.Model !== "") {
    if (value.models == null) {
      value.models = {};
    }
    value.models[node.Model] = (value.models[node.Model] ?? 0) + 1;
  }
  countBreakdownStatus(value.item, node.Status, node.Status === "running" || node.Status === "waiting_approval");
  if (node.Status === "failed") {
    value.item.FailedNodes++;
  }
  if (complete) {
    // 节点耗时本身就是"执行耗时"，与双口径中的执行耗时同源。
    accumulateBreakdownDuration(value, duration, duration);
  }
}

// accumulateVersion 按 SOP 版本聚合，用于版本对比（样本不足时前端标注）。
function accumulateVersion(values, workflowID, workflowName, snapshotVersion, fallbackVersion, run, duration, complete, execDuration) {
  let version = snapshotVersion;
  if (version <= 0) {
    version = fallbackVersion;
  }
  const key = workflowID + "#" + String(version);
  let value = values[key];
  if (value == null) {
    value = new analyticsVersionAccumulator({
      item: new AnalyticsWorkflowVersion({
        WorkflowID: workflowID,
        Name: workflowName,
        Version: version,
        InsufficientSample: true,
      }),
    });
    values[key] = value;
  }
  if (workflowName !== "") {
    value.item.Name = workflowName;
  }
  value.item.Runs++;
  if (!usageCostKnown(run.Usage)) {
    value.item.CostUnknownRuns++;
  }
  value.item.Tokens += run.Usage.TotalTokens;
  value.item.CostUSD += run.Usage.CostUSD;
  if (run.Status === "succeeded") {
    value.item.Succeeded++;
  }
  if (run.Status === "failed") {
    value.item.Failed++;
  }
  if (complete) {
    value.duration += duration;
    value.durations.push(duration);
    value.execDuration += execDuration;
    value.execDurations.push(execDuration);
  }
}

// analyticsUserEntry 返回"责任人 × 自然日"的累加器，不存在时新建；空责任人归为 unassigned。
function analyticsUserEntry(values, userID, day) {
  if (userID === "") {
    userID = "unassigned";
  }
  const key = userID + "\x00" + day;
  let value = values[key];
  if (value == null) {
    value = new analyticsUserAccumulator({ item: new AnalyticsUserUsage({ UserID: userID, Date: day, CostKnown: true }) });
    values[key] = value;
  }
  return value;
}

// accumulateUserUsage 按"责任人 × 自然日"聚合用量。
function accumulateUserUsage(values, userID, day, run, duration, complete, execDuration) {
  const value = analyticsUserEntry(values, userID, day);
  value.item.Runs++;
  value.item.Tokens += run.Usage.TotalTokens;
  value.item.InputTokens += run.Usage.InputTokens;
  value.item.OutputTokens += run.Usage.OutputTokens;
  value.item.CacheReadTokens += run.Usage.CacheReadTokens;
  value.item.CacheWriteTokens += run.Usage.CacheWriteTokens;
  value.item.CostUSD += run.Usage.CostUSD;
  value.item.ExecutionDurationMs += execDuration;
  if (!usageCostKnown(run.Usage)) {
    value.item.CostKnown = false;
  }
  if (run.Status === "succeeded") {
    value.item.Success++;
  }
  if (run.Status === "failed") {
    value.item.Failed++;
  }
  if (complete) {
    value.item.DurationMs += duration;
  }
}

function finalizeBreakdowns(values) {
  const out = [];
  for (const value of Object.values(values)) {
    const terminal = value.item.Succeeded + value.item.Failed;
    if (terminal > 0) {
      value.item.SuccessRate = (value.item.Succeeded * 100) / terminal;
    }
    const all = terminal + value.item.Cancelled;
    if (all > 0) {
      value.item.CancelRate = (value.item.Cancelled * 100) / all;
      value.item.ReworkRate = (value.item.Reworks * 100) / value.item.Runs;
    }
    if (value.durations.length > 0) {
      value.item.AverageDurationMs = Math.trunc(value.duration / value.durations.length);
      value.item.P95DurationMs = percentile(value.durations, 95);
    }
    if (value.execDurations.length > 0) {
      value.item.AverageExecutionDurationMs = Math.trunc(value.execDuration / value.execDurations.length);
      value.item.P95ExecutionDurationMs = percentile(value.execDurations, 95);
    }
    value.item.InputTokens = value.inputTokens;
    value.item.OutputTokens = value.outputTokens;
    value.item.CacheReadTokens = value.cacheReadTokens;
    value.item.CacheWriteTokens = value.cacheWriteTokens;
    value.item.ToolCalls = value.toolCalls;
    value.item.NodeRuns = value.nodeRuns;
    value.item.RetriedNodes = value.retriedNodes;
    value.item.ReworkNodes = value.reworkNodes;
    if (value.nodeRuns > 0) {
      value.item.RetryRate = (value.retriedNodes * 100) / value.nodeRuns;
    }
    if (value.models != null && Object.keys(value.models).length > 0) {
      value.item.ModelMix = value.models;
    }
    if (value.nodeTypes != null && Object.keys(value.nodeTypes).length > 0) {
      value.item.NodeTypes = value.nodeTypes;
      value.item.NodeCount = value.nodeCount;
    }
    if (value.issueIDs != null && Object.keys(value.issueIDs).length > 0) {
      value.item.CompletedIssues = Object.keys(value.issueIDs).length;
    }
    out.push(value.item);
  }
  out.sort((a, b) => {
    if (a.Runs === b.Runs) {
      return a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0;
    }
    return a.Runs > b.Runs ? -1 : 1;
  });
  return out;
}

function finalizeWorkflowVersions(values) {
  const out = [];
  for (const value of Object.values(values)) {
    const terminal = value.item.Succeeded + value.item.Failed;
    if (terminal > 0) {
      value.item.SuccessRate = (value.item.Succeeded * 100) / terminal;
    }
    if (value.durations.length > 0) {
      value.item.AverageDurationMs = Math.trunc(value.duration / value.durations.length);
    }
    if (value.execDurations.length > 0) {
      value.item.AverageExecutionDurationMs = Math.trunc(value.execDuration / value.execDurations.length);
    }
    // 样本量不足时标注，避免版本对比被单次执行误导。
    value.item.InsufficientSample = value.item.Runs < 5;
    out.push(value.item);
  }
  out.sort((a, b) => {
    if (a.WorkflowID === b.WorkflowID) {
      return a.Version > b.Version ? -1 : a.Version < b.Version ? 1 : 0;
    }
    return a.WorkflowID < b.WorkflowID ? -1 : a.WorkflowID > b.WorkflowID ? 1 : 0;
  });
  return out;
}

function finalizeUserUsage(values) {
  const out = [];
  for (const value of Object.values(values)) {
    out.push(value.item);
  }
  out.sort((a, b) => {
    if (a.Date === b.Date) {
      return a.Tokens > b.Tokens ? -1 : a.Tokens < b.Tokens ? 1 : 0;
    }
    return a.Date > b.Date ? -1 : a.Date < b.Date ? 1 : 0;
  });
  return out;
}

// analyticsProjectEntry 返回项目的累加器，不存在时新建；空项目归为 unassigned。
function analyticsProjectEntry(values, projectID) {
  if (projectID === "") {
    projectID = "unassigned";
  }
  let value = values[projectID];
  if (value == null) {
    value = new analyticsProjectAccumulator({ item: new AnalyticsProjectUsage({ ProjectID: projectID, CostKnown: true }), issues: {} });
    values[projectID] = value;
  }
  return value;
}

function accumulateProjectUsage(values, projectID, issueID, run) {
  const value = analyticsProjectEntry(values, projectID);
  value.item.Runs++;
  value.item.Tokens += run.Usage.TotalTokens;
  value.item.CostUSD += run.Usage.CostUSD;
  if (!usageCostKnown(run.Usage)) {
    value.item.CostKnown = false;
  }
  if (run.Status === "succeeded") {
    value.item.Success++;
  }
  if (run.Status === "failed") {
    value.item.Failed++;
  }
  if (issueID !== "") {
    value.issues[issueID] = true;
  }
}

function finalizeProjectUsage(values) {
  const out = [];
  for (const value of Object.values(values)) {
    value.item.UniqueIssues = Object.keys(value.issues ?? {}).length;
    out.push(value.item);
  }
  out.sort((a, b) => {
    if (a.Tokens === b.Tokens) {
      return a.Runs > b.Runs ? -1 : a.Runs < b.Runs ? 1 : 0;
    }
    return a.Tokens > b.Tokens ? -1 : 1;
  });
  return out;
}

// applyBreakdownShares 回填各维度占全局 Token/成本的比例，用于占比结构展示。
function applyBreakdownShares(list, totalTokens, totalCostUSD) {
  for (let i = 0; i < list.length; i++) {
    if (totalTokens > 0) {
      list[i].TokenSharePct = (list[i].Tokens * 100) / totalTokens;
    }
    if (totalCostUSD > 0) {
      list[i].CostSharePct = (list[i].CostUSD * 100) / totalCostUSD;
    }
  }
}

// analyticsIssueSource 归一需求来源，未标注的本地需求归为 local。
function analyticsIssueSource(issue) {
  const source = (issue.Source ?? "").toLowerCase().trim();
  if (source === "") {
    return "local";
  }
  return source;
}

// analyticsSourceEntry 返回需求来源的累加器，不存在时新建；空来源归为 local。
function analyticsSourceEntry(values, source) {
  if (source === "") {
    source = "local";
  }
  let value = values[source];
  if (value == null) {
    value = new analyticsAccumulator({ item: new AnalyticsBreakdown({ Key: source, Name: source }) });
    values[source] = value;
  }
  return value;
}

// accumulateIssueSource 按需求来源聚合执行量、Token、成本与执行耗时。
function accumulateIssueSource(values, source, run, execDuration) {
  const value = analyticsSourceEntry(values, source);
  value.item.Runs++;
  value.item.Tokens += run.Usage.TotalTokens;
  value.item.CostUSD += run.Usage.CostUSD;
  value.inputTokens += run.Usage.InputTokens;
  value.outputTokens += run.Usage.OutputTokens;
  value.cacheReadTokens += run.Usage.CacheReadTokens;
  value.cacheWriteTokens += run.Usage.CacheWriteTokens;
  value.item.ToolCalls += run.ToolCalls;
  if (run.Status === "succeeded") {
    value.item.Succeeded++;
    if (value.issueIDs == null) {
      value.issueIDs = {};
    }
    value.issueIDs[run.ExecutionContext.IssueID.trim()] = true;
  }
  if (run.Status === "failed") {
    value.item.Failed++;
  }
  if (run.Status === "cancelled") {
    value.item.Cancelled++;
  }
  if (execDuration > 0) {
    value.execDuration += execDuration;
    value.execDurations.push(execDuration);
  }
}

function percentile(values, pct) {
  if (values.length === 0) {
    return 0;
  }
  const copyValues = [...values];
  copyValues.sort((a, b) => a - b);
  let index = Math.trunc((copyValues.length * pct + 99) / 100) - 1;
  if (index < 0) {
    index = 0;
  }
  if (index >= copyValues.length) {
    index = copyValues.length - 1;
  }
  return copyValues[index];
}

function normalizeFailure(message) {
  message = message.trim().split("\n")[0];
  if (message.length > 160) {
    message = message.slice(0, 160);
  }
  if (message === "") {
    return "unknown failure";
  }
  return message;
}

function agentName(values, id) {
  const value = values[id];
  if (value != null && value.Name !== "") {
    return value.Name;
  }
  return id;
}
function executorName(values, id) {
  const value = values[id];
  if (value != null && value.Name !== "") {
    return value.Name;
  }
  return id;
}

// accumulateConversationRun counts a conversation workspace: its model usage
// joins the token and cost totals, trend, user, project and requirement-source
// breakdowns, while run counts, statuses, durations and the SOP requirement
// counts stay SOP-only. Its requirements are counted apart, per trend bucket in
// trendIssues.
function accumulateConversationRun(summary, issues, trends, trendIssues, users, projects, sources, run, issue, grain) {
  const usage = run.Usage;
  const issueID = run.ExecutionContext.IssueID.trim();
  summary.ConversationWorkspaces++;
  summary.ConversationTokens += usage.TotalTokens;
  summary.ConversationCostUSD += usage.CostUSD;
  summary.TotalTokens += usage.TotalTokens;
  summary.TotalCostUSD += usage.CostUSD;
  summary.CostReportedUSD += usage.CostUSD;
  summary.InputTokens += usage.InputTokens;
  summary.OutputTokens += usage.OutputTokens;
  summary.CacheReadTokens += usage.CacheReadTokens;
  summary.CacheWriteTokens += usage.CacheWriteTokens;
  summary.ReasoningTokens += usage.ReasoningTokens;
  if (issueID !== "") {
    issues[issueID] = true;
    summary.ConversationLinkedWorkspaces++;
  }
  // Same timestamp the analytics window filters on.
  const at = run.CreatedAt;
  const bucket = analyticsTrendBucket(at, grain);
  const point = analyticsTrendEntry(trends, bucket);
  point.Tokens += usage.TotalTokens;
  point.CostUSD += usage.CostUSD;
  point.ConversationWorkspaces++;
  point.ConversationTokens += usage.TotalTokens;
  point.ConversationCostUSD += usage.CostUSD;
  point.InputTokens += usage.InputTokens;
  point.OutputTokens += usage.OutputTokens;
  point.CacheReadTokens += usage.CacheReadTokens;
  point.CacheWriteTokens += usage.CacheWriteTokens;
  addAnalyticsTrendIssue(trendIssues, bucket, issueID);
  if (usage.TotalTokens === 0 && usage.CostUSD === 0 && issueID === "") {
    return;
  }
  const user = analyticsUserEntry(users, analyticsRunUserID(run, issue), formatDayUTC(at));
  user.item.Tokens += usage.TotalTokens;
  user.item.InputTokens += usage.InputTokens;
  user.item.OutputTokens += usage.OutputTokens;
  user.item.CacheReadTokens += usage.CacheReadTokens;
  user.item.CacheWriteTokens += usage.CacheWriteTokens;
  user.item.CostUSD += usage.CostUSD;
  const project = analyticsProjectEntry(projects, RunProjectID(run, issue.ProjectID));
  project.item.Tokens += usage.TotalTokens;
  project.item.CostUSD += usage.CostUSD;
  if (issueID === "") {
    return;
  }
  project.issues[issueID] = true;
  const value = analyticsSourceEntry(sources, analyticsIssueSource(issue));
  value.item.Tokens += usage.TotalTokens;
  value.item.CostUSD += usage.CostUSD;
  value.inputTokens += usage.InputTokens;
  value.outputTokens += usage.OutputTokens;
  value.cacheReadTokens += usage.CacheReadTokens;
  value.cacheWriteTokens += usage.CacheWriteTokens;
}

module.exports = { AnalyticsRepo, analyticsAccumulator, analyticsVersionAccumulator, analyticsUserAccumulator, analyticsProjectAccumulator, analyticsRunSignals, analyticsHumanEventTypes, queryAnalyticsCoverage, runReworks, analyticsRunDuration, analyticsWeekHourLocation, analyticsTrendBucket, analyticsTrendEntry, addAnalyticsTrendIssue, analyticsRunInWindow, analyticsRunMatchesUser, analyticsRunUserID, analyticsIssueMatchesSource, analyticsIsRequirementIssue, usageCostKnown, analyticsWorkflowCategory, analyticsNodeTypes, sumIssueCounts, issueExecValues, countInProgressIssues, issueInProgress, applyWeeklyThroughput, analyticsRunError, accumulateBreakdown, accumulateBreakdownUsage, countBreakdownStatus, accumulateBreakdownDuration, accumulateNode, accumulateVersion, analyticsUserEntry, accumulateUserUsage, finalizeBreakdowns, finalizeWorkflowVersions, finalizeUserUsage, analyticsProjectEntry, accumulateProjectUsage, finalizeProjectUsage, applyBreakdownShares, analyticsIssueSource, analyticsSourceEntry, accumulateIssueSource, percentile, normalizeFailure, agentName, executorName, accumulateConversationRun, isZeroTime, timeMs, timeBefore, timeAfter, timeEqual, formatDayUTC, formatMonthUTC, loadTimeLocation, inLocation };
