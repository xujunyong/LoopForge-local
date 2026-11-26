// analytics_pricing.js —— 对应 Go 文件：internal/repo/analytics_pricing.go
// 作用：分析用重定价与美元转人民币换算。

"use strict";

const { TokenUsage } = require("../domain/run.js"); // 对应 Go 的 domain.TokenUsage，domain 已翻译
const { AnalyticsPricedUsage, AnalyticsUSDToCNY, AnalyticsPricingVersion } = require("../domain/token_pricing.js"); // 对应 Go 的 domain.AnalyticsPricedUsage 等，domain 已翻译
const { usageCostKnown } = require("./analytics.js"); // 对应 Go 同包函数，analytics.js 已翻译

// Reprice a copy for analytics; raw adapter amounts and persisted Run/Node rows
// remain intact. A missing node/model/token split makes coverage incomplete.
function analyticsPricedRun(run) {
  if (run.IsWorkspace()) {
    // Conversation workspaces have no nodes; AddConversationRunUsage
    // prices each turn with its model when it is recorded.
    return run;
  }
  const nodes = {};
  let input = 0;
  let output = 0;
  let read = 0;
  let write = 0;
  let total = 0;
  let cost = 0;
  let known = true;
  for (const [id, original] of Object.entries(run.Nodes ?? {})) {
    if (original == null) {
      continue;
    }
    const node = { ...original };
    const model = node.Model.toLowerCase().trim();
    const inclusive = node.Provider === "codex" || node.Provider === "openai" || model.startsWith("gpt-");
    node.Usage = AnalyticsPricedUsage(node.Model, node.Usage, inclusive);
    nodes[id] = node;
    input += node.Usage.InputTokens;
    output += node.Usage.OutputTokens;
    read += node.Usage.CacheReadTokens;
    write += node.Usage.CacheWriteTokens;
    total += node.Usage.TotalTokens;
    cost += node.Usage.CostUSD;
    known = known && usageCostKnown(node.Usage);
  }
  const u = run.Usage;
  if (input !== u.InputTokens || output !== u.OutputTokens || read !== u.CacheReadTokens || write !== u.CacheWriteTokens || total !== u.TotalTokens) {
    known = false;
  }
  if (Object.keys(nodes).length === 0 && (u.CostUSD !== 0 || u.ReasoningTokens !== 0)) {
    known = false;
  }
  run.Nodes = nodes;
  run.Usage.CostUSD = cost;
  run.Usage.CostStatus = "unknown";
  if (known) {
    run.Usage.CostStatus = "estimated";
  }
  return run;
}

function analyticsInsightPricedUsage(u) {
  const usage = new TokenUsage({ InputTokens: u.InputTokens, OutputTokens: u.OutputTokens, TotalTokens: u.InputTokens + u.OutputTokens, CacheReadTokens: u.CacheReadTokens, CacheWriteTokens: u.CacheWriteTokens, ReasoningTokens: u.ReasoningTokens, CostStatus: u.CostStatus });
  if (u.CostUSD != null) {
    usage.CostUSD = u.CostUSD;
  }
  return AnalyticsPricedUsage(u.Model, usage, true);
}

// The legacy USD fields remain USD equivalents; CNY is the reporting currency.
function applyAnalyticsCNY(out) {
  const fx = AnalyticsUSDToCNY;
  out.Summary.CostCurrency = "CNY";
  out.Summary.USDToCNY = fx;
  out.Summary.CostPricingVersion = AnalyticsPricingVersion;
  out.Summary.TotalCostCNY = out.Summary.TotalCostUSD * fx;
  out.Summary.CostReportedCNY = out.Summary.CostReportedUSD * fx;
  out.Summary.ConversationCostCNY = out.Summary.ConversationCostUSD * fx;
  out.Delivery.TotalCostCNY = out.Delivery.TotalCostUSD * fx;
  for (let i = 0; i < out.Trend.length; i++) {
    out.Trend[i].CostCNY = out.Trend[i].CostUSD * fx;
    out.Trend[i].ConversationCostCNY = out.Trend[i].ConversationCostUSD * fx;
  }
  for (let i = 0; i < out.WeekHour.length; i++) {
    out.WeekHour[i].CostCNY = out.WeekHour[i].CostUSD * fx;
  }
  for (const list of [out.Workflows, out.Agents, out.Executors, out.Models, out.Nodes, out.IssueSources, out.Categories]) {
    for (let i = 0; i < list.length; i++) {
      list[i].CostCNY = list[i].CostUSD * fx;
    }
  }
  for (let i = 0; i < out.Deliveries.length; i++) {
    out.Deliveries[i].CostCNY = out.Deliveries[i].CostUSD * fx;
  }
  for (let i = 0; i < out.WorkflowVersions.length; i++) {
    out.WorkflowVersions[i].CostCNY = out.WorkflowVersions[i].CostUSD * fx;
  }
  for (let i = 0; i < out.UserUsage.length; i++) {
    out.UserUsage[i].CostCNY = out.UserUsage[i].CostUSD * fx;
  }
  for (let i = 0; i < out.ProjectUsage.length; i++) {
    out.ProjectUsage[i].CostCNY = out.ProjectUsage[i].CostUSD * fx;
  }
  for (let i = 0; i < out.RunTraces.length; i++) {
    out.RunTraces[i].CostCNY = out.RunTraces[i].CostUSD * fx;
  }
}

module.exports = { analyticsPricedRun, analyticsInsightPricedUsage, applyAnalyticsCNY };
