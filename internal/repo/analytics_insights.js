// analytics_insights.js —— 对应 Go 文件：internal/repo/analytics_insights.go
// 作用：外部洞察执行记录投影为分析用运行。

"use strict";

const { Run, NodeRun, TokenUsage } = require("../domain/run.js"); // 对应 Go 的 domain.Run/NodeRun/TokenUsage，domain 已翻译
const { WorkflowDefinition } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition，domain 已翻译
const { TelemetryContext } = require("../domain/observability.js"); // 对应 Go 的 domain.TelemetryContext，domain 已翻译
const { InsightExecution } = require("../domain/insights.js"); // 对应 Go 的 domain.InsightExecution，domain 已翻译
const { AnalyticsRepo, accumulateNode } = require("./analytics.js"); // 对应 Go 同包类型与函数，analytics.js 已翻译
const { analyticsInsightPricedUsage } = require("./analytics_pricing.js"); // 对应 Go 同包函数，analytics_pricing.js 已翻译

class insightAnalyticsExecution {
  constructor(init = {}) {
    this.execution = init.execution ?? new InsightExecution();
    this.sourceID = init.sourceID ?? "";
  }
}

// analyticsInsightRuns projects external facts only in memory so existing
// aggregation uses one arithmetic path. These values are never persisted as
// Runs or handed to the engine, delivery, leases, or recovery.
AnalyticsRepo.prototype.analyticsInsightRuns = function (filter) {
  const metadata = {};
  if (filter.Origin === "internal" || filter.RequirementsOnly || filter.IssueSource !== "") {
    return [[], metadata];
  }
  const rows = this.insights.insightExecutions(filter);
  const runs = [];
  for (const row of rows) {
    const v = new InsightExecution(JSON.parse(row.Payload.toString("utf8")));
    const workflowID = "external:" + row.SourceID + ":" + v.Workflow.ID;
    if (filter.WorkflowID !== "" && filter.WorkflowID !== workflowID) {
      continue;
    }
    const run = new Run({ ID: "external:" + row.ID, WorkflowID: workflowID, WorkflowSnapshot: new WorkflowDefinition({ ID: workflowID, Name: v.Workflow.Name }), Status: v.Status, CreatedAt: v.StartedAt, UpdatedAt: v.FinishedAt, ExecutionContext: new TelemetryContext({ ProjectID: row.ProjectID, ResponsibleUserID: row.UserID }), Usage: new TokenUsage({ CostStatus: "reported" }) });
    for (const u of v.Usage ?? []) {
      const priced = analyticsInsightPricedUsage(u);
      run.Usage.InputTokens += u.InputTokens;
      run.Usage.OutputTokens += u.OutputTokens;
      run.Usage.CacheReadTokens += u.CacheReadTokens;
      run.Usage.CacheWriteTokens += u.CacheWriteTokens;
      run.Usage.ReasoningTokens += u.ReasoningTokens;
      run.Usage.CostUSD += priced.CostUSD;
      if (priced.CostStatus === "unknown") {
        run.Usage.CostStatus = "unknown";
      } else if (priced.CostStatus === "estimated" && run.Usage.CostStatus !== "unknown") {
        run.Usage.CostStatus = "estimated";
      }
    }
    run.Usage.TotalTokens = run.Usage.InputTokens + run.Usage.OutputTokens;
    metadata[run.ID] = new insightAnalyticsExecution({ execution: v, sourceID: row.SourceID });
    runs.push(run);
  }
  return [runs, metadata];
};

function accumulateInsightModels(models, v) {
  for (const u of v.Usage ?? []) {
    const usage = analyticsInsightPricedUsage(u);
    // A workflow's terminal status does not establish individual model success.
    accumulateNode(models, u.Model, u.Model, new NodeRun({ Model: u.Model, Usage: usage }), 0, false);
    models[u.Model].item.QualityUnknownRuns++;
  }
}

module.exports = { insightAnalyticsExecution, accumulateInsightModels };
