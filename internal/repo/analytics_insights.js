/**
 * @file internal/repo/analytics_insights.js
 * 对应 Go 源文件：internal/repo/analytics_insights.go
 *
 * 作用与职责边界：
 * 将外部洞察系统上报的执行记录仅在内存中投影为分析用的虚拟 `Run` 与元数据，
 * 使外部用量能够复用统一的运营分析汇总算法路径，同时确保外部记录不会被持久化为平台运行或交给引擎/交付/租约流程。
 *
 * 语法差异说明：
 * - Go 的多值与错误返回 `([]domain.Run, map[string]insightAnalyticsExecution, error)` 在 JS 中成功返回 `[runs, metadata]` 二元组、失败抛出错误。
 * - Go 方法接收者 `func (r *AnalyticsRepo) analyticsInsightRuns(...)` 挂载至 `AnalyticsRepo.prototype`。
 */

"use strict";

const { Run, NodeRun, TokenUsage } = require("../domain/run.js"); // 对应 Go 的 domain.Run/NodeRun/TokenUsage，domain 已翻译
const { WorkflowDefinition } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition，domain 已翻译
const { TelemetryContext } = require("../domain/observability.js"); // 对应 Go 的 domain.TelemetryContext，domain 已翻译
const { InsightExecution } = require("../domain/insights.js"); // 对应 Go 的 domain.InsightExecution，domain 已翻译
const { AnalyticsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { accumulateNode } = require("./analytics.js"); // 对应 Go 同包函数，analytics.js 已翻译
const { analyticsInsightPricedUsage } = require("./analytics_pricing.js"); // 对应 Go 同包函数，analytics_pricing.js 已翻译

/**
 * 外部洞察执行记录的内存附加元数据，用于在分析汇总阶段区分外部来源及读取原始执行字段。
 */
class insightAnalyticsExecution {
  /**
   * 构造外部洞察分析元数据实例，未提供字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {InsightExecution} [init.execution] - 反序列化后的外部洞察执行记录。
   * @param {string} [init.sourceID=""] - 上报来源凭证 ID。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.execution = init.execution ?? new InsightExecution();
    this.sourceID = init.sourceID ?? "";
  }
}

/**
 * 读取外部洞察执行记录并在内存中投影为分析用的 `Run` 列表及对应元数据映射。
 * 在运营分析主流程聚合全量数据时调用；当筛选条件限定为内部来源、仅需求或指定需求来源时直接返回空结果。
 *
 * @param {import("../domain/analytics.js").AnalyticsFilter} filter - 分析查询筛选条件。
 * @returns {[Run[], Object<string, insightAnalyticsExecution>]} 二元组 `[投影后的外部运行数组, 按运行 ID 索引的外部元数据映射]`；查询或 JSON 解析失败时抛出错误。
 */
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

/**
 * 将外部洞察执行记录中的每条模型用量累加到模型维度拆解累加器中。
 * 在分析主流程处理外部运行时调用；由于外部工作流终态不能代表单次模型调用成败，统一递增 `QualityUnknownRuns`。
 *
 * @param {Object<string, import("./analytics.js").analyticsAccumulator>} models - 按模型名索引的维度累加器映射（就地修改）。
 * @param {InsightExecution} v - 单条外部洞察执行记录。
 * @returns {void} 无返回值。
 */
function accumulateInsightModels(models, v) {
  for (const u of v.Usage ?? []) {
    const usage = analyticsInsightPricedUsage(u);
    // 工作流终态不能证明其中各次模型调用的独立成败，计入质量未知运行数。
    accumulateNode(models, u.Model, u.Model, new NodeRun({ Model: u.Model, Usage: usage }), 0, false);
    models[u.Model].item.QualityUnknownRuns++;
  }
}

module.exports = { insightAnalyticsExecution, accumulateInsightModels };
