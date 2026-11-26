/**
 * @file internal/repo/analytics_pricing.js
 * 对应 Go 源文件：internal/repo/analytics_pricing.go
 *
 * 作用与职责边界：
 * 负责运营分析场景下的运行副本重定价、洞察用量重定价，以及将分析快照中的美元费用按汇率换算为人民币（CNY）。
 * 仅对分析用副本与输出快照做费用重算，不修改底层持久化的运行记录与节点原始计费字段。
 *
 * 语法差异说明：
 * - Go 函数按值接收 `domain.Run`（修改副本不影响调用方原值），JS 中通过保留原型的浅拷贝复制 `run` 与 `run.Usage` 来保持值语义一致。
 * - Go 遍历 `nil` 映射安全无副作用，JS 中通过 `run.Nodes ?? {}` 保持同等行为。
 */

"use strict";

const { TokenUsage } = require("../domain/run.js"); // 对应 Go 的 domain.TokenUsage，domain 已翻译
const { AnalyticsPricedUsage, AnalyticsUSDToCNY, AnalyticsPricingVersion } = require("../domain/token_pricing.js"); // 对应 Go 的 domain.AnalyticsPricedUsage 等，domain 已翻译
const { usageCostKnown } = require("./analytics.js"); // 对应 Go 同包函数，analytics.js 已翻译

/**
 * 为运营分析生成一份重新计价后的运行副本，保留原始适配器金额与持久化的运行/节点数据不变。
 * 当节点、模型或 Token 拆分与汇总不一致时，将计价状态标记为 `"unknown"`，否则标记为 `"estimated"`。
 *
 * @param {object} run - 待重定价的运行对象（`domain.Run` 实例）。
 * @returns {object} 重定价后的运行对象副本；若为对话工作区则直接原样返回。
 */
function analyticsPricedRun(run) {
  if (run.IsWorkspace()) {
    // 对话工作区没有子节点；AddConversationRunUsage 会在记录每轮用量时按对应模型直接计价。
    return run;
  }
  const priced = Object.assign(Object.create(Object.getPrototypeOf(run)), run);
  priced.Usage = Object.assign(Object.create(Object.getPrototypeOf(run.Usage)), run.Usage);
  const nodes = {};
  let input = 0;
  let output = 0;
  let read = 0;
  let write = 0;
  let total = 0;
  let cost = 0;
  let known = true;
  for (const [id, original] of Object.entries(priced.Nodes ?? {})) {
    if (original == null) {
      continue;
    }
    const node = Object.assign(Object.create(Object.getPrototypeOf(original)), original);
    const model = node.Model.trim().toLowerCase();
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
  const u = priced.Usage;
  if (input !== u.InputTokens || output !== u.OutputTokens || read !== u.CacheReadTokens || write !== u.CacheWriteTokens || total !== u.TotalTokens) {
    known = false;
  }
  if (Object.keys(nodes).length === 0 && (u.CostUSD !== 0 || u.ReasoningTokens !== 0)) {
    known = false;
  }
  priced.Nodes = nodes;
  priced.Usage.CostUSD = cost;
  priced.Usage.CostStatus = "unknown";
  if (known) {
    priced.Usage.CostStatus = "estimated";
  }
  return priced;
}

/**
 * 将单条洞察用量记录转换为按分析口径重定价后的 `TokenUsage` 对象。
 * 用于运营分析聚合洞察执行记录的 Token 与费用时统一计价标准。
 *
 * @param {object} u - 洞察执行用量记录（`domain.InsightUsage` 实例）。
 * @returns {TokenUsage} 按分析定价表重新计算后的 Token 与费用汇总对象。
 */
function analyticsInsightPricedUsage(u) {
  const usage = new TokenUsage({ InputTokens: u.InputTokens, OutputTokens: u.OutputTokens, TotalTokens: u.InputTokens + u.OutputTokens, CacheReadTokens: u.CacheReadTokens, CacheWriteTokens: u.CacheWriteTokens, ReasoningTokens: u.ReasoningTokens, CostStatus: u.CostStatus });
  if (u.CostUSD != null) {
    usage.CostUSD = u.CostUSD;
  }
  return AnalyticsPricedUsage(u.Model, usage, true);
}

/**
 * 按平台分析汇率将分析快照中所有维度的美元费用折算并写入对应人民币字段。
 * 原有 USD 字段保持美元等值不变，同时将报表币种标记为 `"CNY"` 并记录汇率与定价版本号。
 *
 * @param {object} out - 待原地填充人民币费用字段的运营分析快照对象（`domain.AnalyticsSnapshot` 实例）。
 * @returns {void} 无返回值。
 */
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
