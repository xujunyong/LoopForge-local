/**
 * @file internal/domain/analytics.js
 * 对应 Go 源文件：internal/domain/analytics.go
 *
 * 作用与职责边界：
 * 定义平台运营分析模块所需的全部领域数据结构，包括分析筛选条件、总览汇总指标、
 * 时间趋势点、星期×小时热力格、MR 合并证据、多维度拆解、失败分类、观测覆盖度、
 * 需求交付明细与汇总、工作流版本对比、用户/项目用量、演示指标、追踪摘要、会话活跃度及完整分析快照。
 * 不负责数据库聚合查询或 HTTP 参数解析。
 *
 * 语法差异说明：
 * - Go 结构体匿名嵌入（如 `AnalyticsActivityPoint` 嵌入 `AnalyticsActivity`）转写为类继承（`extends`）。
 * - Go 指针字段和 `time.Time` 字段零值统一初始化为 `null`；切片字段初始化为 `[]`；映射字段初始化为 `{}`。
 */

"use strict";

/**
 * 表示平台运营分析的查询筛选条件，使数据访问层不与 HTTP 请求结构耦合。
 * 用于限定数据来源、项目范围、时间窗口、统计粒度、时区及需求口径。
 */
class AnalyticsFilter {
  /**
   * 构造并初始化分析筛选条件实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Origin = init.Origin ?? "";
    // 切片字段按零值规则初始化为空数组；在 Go 中 nil 表示不限项目、空切片表示无可见项目，
    // 调用方如需表示“不限项目”可显式传入 ProjectIDs: null。
    this.ProjectIDs = init.ProjectIDs ?? [];
    this.ProjectID = init.ProjectID ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.From = init.From ?? null;
    this.To = init.To ?? null;
    this.Scope = init.Scope ?? "";
    this.UserID = init.UserID ?? "";
    this.IssueSource = init.IssueSource ?? "";
    this.RequirementsOnly = init.RequirementsOnly ?? false;
    this.Grain = init.Grain ?? "";
    this.TimeZone = init.TimeZone ?? "";
  }

  /**
   * 判断给定项目 ID 是否命中当前筛选条件。
   * 在聚合或过滤运行、需求与交付数据时调用；当 `ProjectIDs` 为非空（非 `null`/`undefined`）的空数组时，
   * 视为没有任何允许访问的项目，绝不回退为全部项目。
   *
   * @param {string} id - 待匹配的项目 ID。
   * @returns {boolean} 项目符合筛选范围时返回 `true`，否则返回 `false`。
   */
  MatchesProject(id) {
    if (this.ProjectID !== "" && this.ProjectID !== id) {
      return false;
    }
    if (this.ProjectIDs == null) {
      return true;
    }
    return this.ProjectIDs.includes(id);
  }
}

/**
 * 表示平台运营分析的核心总览指标。
 * 涵盖 SOP 运行计数与成功率、墙钟与纯执行耗时分位数、Token 四分项与缓存命中率、
 * 成本覆盖率与金额、会话直改代码工作区统计、需求吞吐与合并 MR 计数。
 */
class AnalyticsSummary {
  /**
   * 构造并初始化分析总览汇总实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ExternalRuns = init.ExternalRuns ?? 0;
    this.QualityRuns = init.QualityRuns ?? 0;
    this.TotalRuns = init.TotalRuns ?? 0;
    this.ActiveRuns = init.ActiveRuns ?? 0;
    this.WaitingRuns = init.WaitingRuns ?? 0;
    this.SucceededRuns = init.SucceededRuns ?? 0;
    this.FailedRuns = init.FailedRuns ?? 0;
    this.CancelledRuns = init.CancelledRuns ?? 0;
    this.ReworkedRuns = init.ReworkedRuns ?? 0;
    this.TotalReworks = init.TotalReworks ?? 0;
    this.CompletionRate = init.CompletionRate ?? 0;
    this.FirstPassRate = init.FirstPassRate ?? 0;
    this.AverageDurationMs = init.AverageDurationMs ?? 0;
    this.P50DurationMs = init.P50DurationMs ?? 0;
    this.P95DurationMs = init.P95DurationMs ?? 0;
    this.P99DurationMs = init.P99DurationMs ?? 0;
    this.TotalTokens = init.TotalTokens ?? 0;
    this.TotalCostUSD = init.TotalCostUSD ?? 0;
    this.TotalCostCNY = init.TotalCostCNY ?? 0;
    this.ToolCalls = init.ToolCalls ?? 0;
    this.Artifacts = init.Artifacts ?? 0;
    this.TelemetryEvents = init.TelemetryEvents ?? 0;
    this.LogRecords = init.LogRecords ?? 0;
    this.GeneratedAt = init.GeneratedAt ?? null;
    this.ConversationWorkspaces = init.ConversationWorkspaces ?? 0;
    this.ConversationLinkedWorkspaces = init.ConversationLinkedWorkspaces ?? 0;
    this.ConversationIssues = init.ConversationIssues ?? 0;
    this.ConversationIssuesWithMR = init.ConversationIssuesWithMR ?? 0;
    this.ConversationIssuesDelivered = init.ConversationIssuesDelivered ?? 0;
    this.ConversationTokens = init.ConversationTokens ?? 0;
    this.ConversationCostUSD = init.ConversationCostUSD ?? 0;
    this.ConversationCostCNY = init.ConversationCostCNY ?? 0;
    this.CostCurrency = init.CostCurrency ?? "";
    this.USDToCNY = init.USDToCNY ?? 0;
    this.CostPricingVersion = init.CostPricingVersion ?? "";
    this.InputTokens = init.InputTokens ?? 0;
    this.OutputTokens = init.OutputTokens ?? 0;
    this.CacheReadTokens = init.CacheReadTokens ?? 0;
    this.CacheWriteTokens = init.CacheWriteTokens ?? 0;
    this.ReasoningTokens = init.ReasoningTokens ?? 0;
    this.CacheHitRate = init.CacheHitRate ?? 0;
    this.SuccessRate = init.SuccessRate ?? 0;
    this.CancelRate = init.CancelRate ?? 0;
    this.ExecutionAverageDurationMs = init.ExecutionAverageDurationMs ?? 0;
    this.ExecutionP50DurationMs = init.ExecutionP50DurationMs ?? 0;
    this.ExecutionP95DurationMs = init.ExecutionP95DurationMs ?? 0;
    this.ExecutionP99DurationMs = init.ExecutionP99DurationMs ?? 0;
    this.WaitAverageDurationMs = init.WaitAverageDurationMs ?? 0;
    this.CostCoveragePct = init.CostCoveragePct ?? 0;
    this.CostReportedUSD = init.CostReportedUSD ?? 0;
    this.CostReportedCNY = init.CostReportedCNY ?? 0;
    this.CostUnknownRuns = init.CostUnknownRuns ?? 0;
    this.UniqueIssues = init.UniqueIssues ?? 0;
    this.RunsPerIssue = init.RunsPerIssue ?? 0;
    this.FailuresPerIssue = init.FailuresPerIssue ?? 0;
    this.InProgressIssues = init.InProgressIssues ?? 0;
    this.IssueP50ExecutionDurationMs = init.IssueP50ExecutionDurationMs ?? 0;
    this.IssueP95ExecutionDurationMs = init.IssueP95ExecutionDurationMs ?? 0;
    this.WeeklyDeliveredIssues = init.WeeklyDeliveredIssues ?? 0;
    this.WeeklyActiveContributors = init.WeeklyActiveContributors ?? 0;
    this.WeeklyThroughputPerUser = init.WeeklyThroughputPerUser ?? 0;
    this.MergedMRs = init.MergedMRs ?? 0;
    this.MergedMRsMissingTime = init.MergedMRsMissingTime ?? 0;
  }
}

/**
 * 表示按日/周/月分桶的时间序列趋势数据点。
 * 记录单时间桶内的运行量、成败返工数、耗时、Token 四分项、成本、需求数、合并 MR 数及会话工作区占比。
 */
class AnalyticsTrendPoint {
  /**
   * 构造并初始化趋势数据点实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.CostUnknownRuns = init.CostUnknownRuns ?? 0;
    this.Date = init.Date ?? "";
    this.Runs = init.Runs ?? 0;
    this.Succeeded = init.Succeeded ?? 0;
    this.Failed = init.Failed ?? 0;
    this.Reworks = init.Reworks ?? 0;
    this.DurationMs = init.DurationMs ?? 0;
    this.Tokens = init.Tokens ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.CostCNY = init.CostCNY ?? 0;
    this.ExecutionDurationMs = init.ExecutionDurationMs ?? 0;
    this.InputTokens = init.InputTokens ?? 0;
    this.OutputTokens = init.OutputTokens ?? 0;
    this.CacheReadTokens = init.CacheReadTokens ?? 0;
    this.CacheWriteTokens = init.CacheWriteTokens ?? 0;
    this.Issues = init.Issues ?? 0;
    this.MergedMRs = init.MergedMRs ?? 0;
    this.ConversationWorkspaces = init.ConversationWorkspaces ?? 0;
    this.ConversationIssues = init.ConversationIssues ?? 0;
    this.ConversationTokens = init.ConversationTokens ?? 0;
    this.ConversationCostUSD = init.ConversationCostUSD ?? 0;
    this.ConversationCostCNY = init.ConversationCostCNY ?? 0;
  }
}

/**
 * 表示请求时区下的一个非空“星期 × 小时”热力图单元格。
 * `Weekday` 从周一（0）计到周日（6），用于在运营面板绘制活跃时段分布。
 */
class AnalyticsWeekHourCell {
  /**
   * 构造并初始化星期×小时热力格实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Weekday = init.Weekday ?? 0;
    this.Hour = init.Hour ?? 0;
    this.Runs = init.Runs ?? 0;
    this.Tokens = init.Tokens ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.CostCNY = init.CostCNY ?? 0;
  }
}

/**
 * 表示单条 MR 合并计数所对应的审计时间戳证据。
 * 用于运营看板核验合并 MR 统计口径及跳转具体 MR 与关联需求。
 */
class AnalyticsMRMerge {
  /**
   * 构造并初始化 MR 合并证据实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.MRProject = init.MRProject ?? "";
    this.MRIID = init.MRIID ?? 0;
    this.MRURL = init.MRURL ?? "";
    this.TargetBranch = init.TargetBranch ?? "";
    this.IssueID = init.IssueID ?? "";
    this.Title = init.Title ?? "";
    this.MergedAt = init.MergedAt ?? null;
  }
}

/**
 * 表示按单一维度（工作流、角色、执行器、模型、节点、需求来源或分类）分组的统计拆解项。
 * 包含该维度的运行量、成功率、取消率、返工率、耗时、Token/成本占比以及编排画像信息。
 */
class AnalyticsBreakdown {
  /**
   * 构造并初始化维度统计拆解项实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.CostUnknownRuns = init.CostUnknownRuns ?? 0;
    this.QualityUnknownRuns = init.QualityUnknownRuns ?? 0;
    this.Key = init.Key ?? "";
    this.Name = init.Name ?? "";
    this.Runs = init.Runs ?? 0;
    this.Succeeded = init.Succeeded ?? 0;
    this.Failed = init.Failed ?? 0;
    this.Active = init.Active ?? 0;
    this.Reworks = init.Reworks ?? 0;
    this.SuccessRate = init.SuccessRate ?? 0;
    this.AverageDurationMs = init.AverageDurationMs ?? 0;
    this.P95DurationMs = init.P95DurationMs ?? 0;
    this.Tokens = init.Tokens ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.CostCNY = init.CostCNY ?? 0;
    this.Cancelled = init.Cancelled ?? 0;
    this.CancelRate = init.CancelRate ?? 0;
    this.ReworkRate = init.ReworkRate ?? 0;
    this.InputTokens = init.InputTokens ?? 0;
    this.OutputTokens = init.OutputTokens ?? 0;
    this.CacheReadTokens = init.CacheReadTokens ?? 0;
    this.CacheWriteTokens = init.CacheWriteTokens ?? 0;
    this.AverageExecutionDurationMs = init.AverageExecutionDurationMs ?? 0;
    this.P95ExecutionDurationMs = init.P95ExecutionDurationMs ?? 0;
    this.TokenSharePct = init.TokenSharePct ?? 0;
    this.CostSharePct = init.CostSharePct ?? 0;
    this.ToolCalls = init.ToolCalls ?? 0;
    this.CompletedIssues = init.CompletedIssues ?? 0;
    this.NodeRuns = init.NodeRuns ?? 0;
    this.RetriedNodes = init.RetriedNodes ?? 0;
    this.RetryRate = init.RetryRate ?? 0;
    this.FailedNodes = init.FailedNodes ?? 0;
    this.ReworkNodes = init.ReworkNodes ?? 0;
    this.Model = init.Model ?? "";
    this.ModelMix = init.ModelMix ?? {};
    this.NodeCount = init.NodeCount ?? 0;
    this.NodeTypes = init.NodeTypes ?? {};
    this.Category = init.Category ?? "";
    this.Versions = init.Versions ?? {};
    this.Extra = init.Extra ?? {};
  }
}

/**
 * 表示按错误码与失败节点聚合的失败频次统计项。
 * 用于运营分析中排查高频失败原因。
 */
class AnalyticsFailure {
  /**
   * 构造并初始化失败统计项实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Code = init.Code ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Count = init.Count ?? 0;
  }
}

/**
 * 表示可观测性数据（遥测事件与日志记录）在运行样本中的覆盖统计。
 * 用于评估分析看板指标的数据完整度。
 */
class AnalyticsCoverage {
  /**
   * 构造并初始化观测覆盖度实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.RunsWithTelemetry = init.RunsWithTelemetry ?? 0;
    this.RunsWithLogs = init.RunsWithLogs ?? 0;
    this.AdapterEvents = init.AdapterEvents ?? {};
    this.LogLevels = init.LogLevels ?? {};
  }
}

/**
 * 表示单个需求维度的交付分析明细行。
 * 聚合该需求关联的全部 SOP 运行及会话直改代码工作区，记录 MR 状态、交付结果、
 * 澄清/开发/测试各阶段耗时、证据链路与按角色拆分的泳道信息。
 */
class AnalyticsDelivery {
  /**
   * 构造并初始化需求交付明细实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.IssueID = init.IssueID ?? "";
    this.ExternalID = init.ExternalID ?? "";
    this.ExternalIID = init.ExternalIID ?? 0;
    this.Title = init.Title ?? "";
    this.Source = init.Source ?? "";
    this.IssueURL = init.IssueURL ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.WorkflowName = init.WorkflowName ?? "";
    this.RunID = init.RunID ?? "";
    this.RunStatus = init.RunStatus ?? "";
    this.SOPSucceeded = init.SOPSucceeded ?? false;
    this.DirectDelivery = init.DirectDelivery ?? false;
    this.DurationMs = init.DurationMs ?? 0;
    this.Tokens = init.Tokens ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.CostCNY = init.CostCNY ?? 0;
    this.MRURL = init.MRURL ?? "";
    this.MRProject = init.MRProject ?? "";
    this.MRIID = init.MRIID ?? 0;
    this.MRState = init.MRState ?? "";
    this.MRs = init.MRs ?? [];
    this.Delivered = init.Delivered ?? false;
    this.RunCount = init.RunCount ?? 0;
    this.FailedRuns = init.FailedRuns ?? 0;
    this.Reworks = init.Reworks ?? 0;
    this.ExecutionDurationMs = init.ExecutionDurationMs ?? 0;
    this.CycleDurationMs = init.CycleDurationMs ?? 0;
    this.ClarificationDurationMs = init.ClarificationDurationMs ?? 0;
    this.DevelopmentDurationMs = init.DevelopmentDurationMs ?? 0;
    this.TestDurationMs = init.TestDurationMs ?? 0;
    this.ClarificationStartedAt = init.ClarificationStartedAt ?? null;
    this.DevelopmentStartedAt = init.DevelopmentStartedAt ?? null;
    this.PhaseSamples = init.PhaseSamples ?? new AnalyticsPhaseSamples();
    this.PhaseEvidence = init.PhaseEvidence ?? [];
    this.UnclassifiedPhaseNodes = init.UnclassifiedPhaseNodes ?? 0;
    this.FirstRunAt = init.FirstRunAt ?? null;
    this.LastRunAt = init.LastRunAt ?? null;
    this.UserID = init.UserID ?? "";
    this.Category = init.Category ?? "";
    this.CostKnown = init.CostKnown ?? false;
    this.Lanes = init.Lanes ?? [];
  }
}

/**
 * 表示需求各交付阶段（澄清、开发、测试及推断归类）观测到的样本计数。
 * 用于区分“实际耗时为 0”与“该阶段未采集到样本”。
 */
class AnalyticsPhaseSamples {
  /**
   * 构造并初始化阶段样本计数实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Clarification = init.Clarification ?? 0;
    this.Development = init.Development ?? 0;
    this.Testing = init.Testing ?? 0;
    this.Inferred = init.Inferred ?? 0;
  }
}

/**
 * 表示单条阶段耗时与运行节点之间的溯源证据记录。
 * 用于把澄清边界或开发/测试耗时精确关联到对应的运行 ID 与节点 ID。
 */
class AnalyticsPhaseEvidence {
  /**
   * 构造并初始化阶段耗时证据实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Stage = init.Stage ?? "";
    this.Source = init.Source ?? "";
    this.DurationMs = init.DurationMs ?? 0;
    this.StartedAt = init.StartedAt ?? null;
    this.FinishedAt = init.FinishedAt ?? null;
  }
}

/**
 * 表示筛选窗口内需求交付漏斗与周期的全局汇总统计。
 * 涵盖 SOP 交付、会话直改交付、MR 关联与合入数量、去重完成需求数、节点求和耗时分位数及分类计数。
 */
class AnalyticsDeliverySummary {
  /**
   * 构造并初始化交付汇总实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Issues = init.Issues ?? 0;
    this.SOPSucceeded = init.SOPSucceeded ?? 0;
    this.DirectIssues = init.DirectIssues ?? 0;
    this.DirectWithMR = init.DirectWithMR ?? 0;
    this.DirectDelivered = init.DirectDelivered ?? 0;
    this.WithMR = init.WithMR ?? 0;
    this.TotalMRs = init.TotalMRs ?? 0;
    this.MRMerged = init.MRMerged ?? 0;
    this.MRIntegrated = init.MRIntegrated ?? 0;
    this.IssuesWithMergedMR = init.IssuesWithMergedMR ?? 0;
    this.Delivered = init.Delivered ?? 0;
    this.AverageDurationMs = init.AverageDurationMs ?? 0;
    this.TotalTokens = init.TotalTokens ?? 0;
    this.TotalCostUSD = init.TotalCostUSD ?? 0;
    this.TotalCostCNY = init.TotalCostCNY ?? 0;
    this.CompletedIssues = init.CompletedIssues ?? 0;
    this.AverageExecutionDurationMs = init.AverageExecutionDurationMs ?? 0;
    this.P50ExecutionDurationMs = init.P50ExecutionDurationMs ?? 0;
    this.P95ExecutionDurationMs = init.P95ExecutionDurationMs ?? 0;
    this.RequirementCount = init.RequirementCount ?? 0;
    this.BugFixCount = init.BugFixCount ?? 0;
    this.CostUnknownIssues = init.CostUnknownIssues ?? 0;
  }
}

/**
 * 表示同一 SOP 工作流不同版本号的执行效果对比行。
 * 当运行次数低于样本阈值（< 5）时标记 `InsufficientSample` 为 `true`。
 */
class AnalyticsWorkflowVersion {
  /**
   * 构造并初始化工作流版本对比实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.CostUnknownRuns = init.CostUnknownRuns ?? 0;
    this.WorkflowID = init.WorkflowID ?? "";
    this.Name = init.Name ?? "";
    this.Version = init.Version ?? 0;
    this.Runs = init.Runs ?? 0;
    this.Succeeded = init.Succeeded ?? 0;
    this.Failed = init.Failed ?? 0;
    this.InsufficientSample = init.InsufficientSample ?? false;
    this.SuccessRate = init.SuccessRate ?? 0;
    this.AverageDurationMs = init.AverageDurationMs ?? 0;
    this.AverageExecutionDurationMs = init.AverageExecutionDurationMs ?? 0;
    this.Tokens = init.Tokens ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.CostCNY = init.CostCNY ?? 0;
  }
}

/**
 * 表示“责任人 × 自然日”维度的每用户每日资源与运行用量记录。
 * 用于个人效率与成本明细报表展示。
 */
class AnalyticsUserUsage {
  /**
   * 构造并初始化每用户每日用量实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.UserID = init.UserID ?? "";
    this.Date = init.Date ?? "";
    this.Runs = init.Runs ?? 0;
    this.Success = init.Success ?? 0;
    this.Failed = init.Failed ?? 0;
    this.Tokens = init.Tokens ?? 0;
    this.InputTokens = init.InputTokens ?? 0;
    this.OutputTokens = init.OutputTokens ?? 0;
    this.CacheReadTokens = init.CacheReadTokens ?? 0;
    this.CacheWriteTokens = init.CacheWriteTokens ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.CostCNY = init.CostCNY ?? 0;
    this.CostKnown = init.CostKnown ?? false;
    this.DurationMs = init.DurationMs ?? 0;
    this.ExecutionDurationMs = init.ExecutionDurationMs ?? 0;
  }
}

/**
 * 表示按项目维度汇总的运行、需求与成本用量。
 * 在跨项目查看整体或个人数据时用于拆分各项目贡献，也作为业务域项目用量结构的基类。
 */
class AnalyticsProjectUsage {
  /**
   * 构造并初始化项目用量汇总实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ProjectID = init.ProjectID ?? "";
    this.Runs = init.Runs ?? 0;
    this.Success = init.Success ?? 0;
    this.Failed = init.Failed ?? 0;
    this.Tokens = init.Tokens ?? 0;
    this.UniqueIssues = init.UniqueIssues ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.CostCNY = init.CostCNY ?? 0;
    this.CostKnown = init.CostKnown ?? false;
  }
}

/**
 * 表示最小闭环演示指标汇总，所有分母均显式输出以便审计。
 * 工具成功率仅统计已结束的工具观测；自动化率指无人工决策事件介入的成功运行占比。
 */
class AnalyticsDemoSummary {
  /**
   * 构造并初始化演示指标汇总实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.CoveredRuns = init.CoveredRuns ?? 0;
    this.CoveredSucceededRuns = init.CoveredSucceededRuns ?? 0;
    this.AverageTokensPerRun = init.AverageTokensPerRun ?? 0;
    this.ToolCallsObserved = init.ToolCallsObserved ?? 0;
    this.ToolCallsSucceeded = init.ToolCallsSucceeded ?? 0;
    this.ToolCallsFailed = init.ToolCallsFailed ?? 0;
    this.ToolSuccessRate = init.ToolSuccessRate ?? 0;
    this.HumanInterventions = init.HumanInterventions ?? 0;
    this.AverageHumanInterventions = init.AverageHumanInterventions ?? 0;
    this.AutomatedSucceededRuns = init.AutomatedSucceededRuns ?? 0;
    this.AutomationRate = init.AutomationRate ?? 0;
  }
}

/**
 * 表示看板用于下钻索引的精简链路追踪行（外部需求 → 工作流任务 → 运行 → Trace）。
 * 完整事件流仍通过运行详情端点按游标分页拉取。
 */
class AnalyticsRunTrace {
  /**
   * 构造并初始化运行链路追踪摘要实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ExecutionDurationMs = init.ExecutionDurationMs ?? null;
    this.Origin = init.Origin ?? "";
    this.SourceID = init.SourceID ?? "";
    this.WorkflowName = init.WorkflowName ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.IssueSource = init.IssueSource ?? "";
    this.ExternalID = init.ExternalID ?? "";
    this.ExternalURL = init.ExternalURL ?? "";
    this.WorkflowTaskID = init.WorkflowTaskID ?? "";
    this.RunID = init.RunID ?? "";
    this.TraceID = init.TraceID ?? "";
    this.Status = init.Status ?? "";
    this.DurationMs = init.DurationMs ?? 0;
    this.Tokens = init.Tokens ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.CostCNY = init.CostCNY ?? 0;
    this.CostKnown = init.CostKnown ?? false;
    this.ToolCalls = init.ToolCalls ?? 0;
    this.ToolCallsSucceeded = init.ToolCallsSucceeded ?? 0;
    this.ToolCallsFailed = init.ToolCallsFailed ?? 0;
    this.HumanInterventions = init.HumanInterventions ?? 0;
    this.ErrorNodeID = init.ErrorNodeID ?? "";
    this.ErrorMessage = init.ErrorMessage ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
    this.FinishedAt = init.FinishedAt ?? null;
  }
}

/**
 * 表示独立于运行/Token 覆盖口径的平台活跃度统计。
 * 统计持久化会话数、协作会话数、创建需求数、顶层需求 SOP 执行数及回复 Token 用量。
 */
class AnalyticsActivity {
  /**
   * 构造并初始化平台活跃度统计实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Sessions = init.Sessions ?? 0;
    this.CollaborativeSessions = init.CollaborativeSessions ?? 0;
    this.Requirements = init.Requirements ?? 0;
    this.SOPRuns = init.SOPRuns ?? 0;
    this.SessionUsage = init.SessionUsage ?? new AnalyticsSessionUsage();
    this.CollaborativeUsage = init.CollaborativeUsage ?? new AnalyticsSessionUsage();
  }
}

/**
 * 表示按回复时间统计的会话 Token 用量及上报完整度。
 * 协作会话用量是总会话用量的子集，不构成重复计费。
 */
class AnalyticsSessionUsage {
  /**
   * 构造并初始化会话用量统计实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Tokens = init.Tokens ?? 0;
    this.InputTokens = init.InputTokens ?? 0;
    this.OutputTokens = init.OutputTokens ?? 0;
    this.CacheReadTokens = init.CacheReadTokens ?? 0;
    this.CacheWriteTokens = init.CacheWriteTokens ?? 0;
    this.ReportedReplies = init.ReportedReplies ?? 0;
    this.MissingReplies = init.MissingReplies ?? 0;
    this.UndatedReplies = init.UndatedReplies ?? 0;
  }
}

/**
 * 表示按日期分桶的平台活跃度趋势数据点。
 * 对应 Go 中 `AnalyticsActivityPoint` 嵌入 `AnalyticsActivity`，在 JS 中通过继承复用全部活跃度字段。
 */
class AnalyticsActivityPoint extends AnalyticsActivity {
  /**
   * 构造并初始化活跃度趋势数据点实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
    this.Date = init.Date ?? "";
  }
}

/**
 * 表示一次运营分析查询返回的完整分析快照。
 * 汇总筛选条件、总览、活跃度、趋势、多维拆解、交付明细、版本对比、用户/项目用量及热力图数据。
 */
class AnalyticsSnapshot {
  /**
   * 构造并初始化完整分析快照实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Activity = init.Activity ?? new AnalyticsActivity();
    this.ActivityTrend = init.ActivityTrend ?? [];
    this.DataErrors = init.DataErrors ?? [];
    this.Filter = init.Filter ?? new AnalyticsFilter();
    this.Summary = init.Summary ?? new AnalyticsSummary();
    this.Trend = init.Trend ?? [];
    this.Workflows = init.Workflows ?? [];
    this.Agents = init.Agents ?? [];
    this.Executors = init.Executors ?? [];
    this.Models = init.Models ?? [];
    this.Nodes = init.Nodes ?? [];
    this.Failures = init.Failures ?? [];
    this.Coverage = init.Coverage ?? new AnalyticsCoverage();
    this.Deliveries = init.Deliveries ?? [];
    this.Delivery = init.Delivery ?? new AnalyticsDeliverySummary();
    this.MRMerges = init.MRMerges ?? [];
    this.IssueSources = init.IssueSources ?? [];
    this.Categories = init.Categories ?? [];
    this.WorkflowVersions = init.WorkflowVersions ?? [];
    this.UserUsage = init.UserUsage ?? [];
    this.ProjectUsage = init.ProjectUsage ?? [];
    this.Demo = init.Demo ?? new AnalyticsDemoSummary();
    this.RunTraces = init.RunTraces ?? [];
    this.WeekHour = init.WeekHour ?? [];
  }
}

module.exports = { AnalyticsFilter, AnalyticsSummary, AnalyticsTrendPoint, AnalyticsWeekHourCell, AnalyticsMRMerge, AnalyticsBreakdown, AnalyticsFailure, AnalyticsCoverage, AnalyticsDelivery, AnalyticsPhaseSamples, AnalyticsPhaseEvidence, AnalyticsDeliverySummary, AnalyticsWorkflowVersion, AnalyticsUserUsage, AnalyticsProjectUsage, AnalyticsDemoSummary, AnalyticsRunTrace, AnalyticsActivity, AnalyticsSessionUsage, AnalyticsActivityPoint, AnalyticsSnapshot };
