// analytics.js —— 对应 Go 文件：internal/domain/analytics.go
// 作用：平台运营分析的筛选条件、汇总、趋势与交付等数据结构。

"use strict";

// AnalyticsFilter：平台分析的筛选范围，不与 HTTP 耦合。
class AnalyticsFilter {
  constructor(init = {}) {
    this.Origin = init.Origin ?? "";
    this.ProjectIDs = init.ProjectIDs ?? null;
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

  // MatchesProject：非空空范围表示没有项目，绝不表示全部项目。
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

class AnalyticsSummary {
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

class AnalyticsTrendPoint {
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

// AnalyticsWeekHourCell：请求时区内一个非空的星期 × 小时格。
class AnalyticsWeekHourCell {
  constructor(init = {}) {
    this.Weekday = init.Weekday ?? 0;
    this.Hour = init.Hour ?? 0;
    this.Runs = init.Runs ?? 0;
    this.Tokens = init.Tokens ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.CostCNY = init.CostCNY ?? 0;
  }
}

// AnalyticsMRMerge：保留 MR 计数所用的时间戳证据。
class AnalyticsMRMerge {
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

class AnalyticsBreakdown {
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

class AnalyticsFailure {
  constructor(init = {}) {
    this.Code = init.Code ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Count = init.Count ?? 0;
  }
}

class AnalyticsCoverage {
  constructor(init = {}) {
    this.RunsWithTelemetry = init.RunsWithTelemetry ?? 0;
    this.RunsWithLogs = init.RunsWithLogs ?? 0;
    this.AdapterEvents = init.AdapterEvents ?? {};
    this.LogLevels = init.LogLevels ?? {};
  }
}

class AnalyticsDelivery {
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

class AnalyticsPhaseSamples {
  constructor(init = {}) {
    this.Clarification = init.Clarification ?? 0;
    this.Development = init.Development ?? 0;
    this.Testing = init.Testing ?? 0;
    this.Inferred = init.Inferred ?? 0;
  }
}

class AnalyticsPhaseEvidence {
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

class AnalyticsDeliverySummary {
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

// AnalyticsWorkflowVersion：对比同一 SOP 不同版本的执行效果。
class AnalyticsWorkflowVersion {
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

// AnalyticsUserUsage：每用户每日用量。
class AnalyticsUserUsage {
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

// AnalyticsProjectUsage：按项目汇总用量。
class AnalyticsProjectUsage {
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

// AnalyticsDemoSummary：首个 Loop 演示指标，分母明确可审计。
class AnalyticsDemoSummary {
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

// AnalyticsRunTrace：TAPD -> workflow task -> Run -> trace 的精简行。
class AnalyticsRunTrace {
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

// AnalyticsActivity：独立统计会话、需求与顶层需求 SOP 执行。
class AnalyticsActivity {
  constructor(init = {}) {
    this.Sessions = init.Sessions ?? 0;
    this.CollaborativeSessions = init.CollaborativeSessions ?? 0;
    this.Requirements = init.Requirements ?? 0;
    this.SOPRuns = init.SOPRuns ?? 0;
    this.SessionUsage = init.SessionUsage ?? new AnalyticsSessionUsage();
    this.CollaborativeUsage = init.CollaborativeUsage ?? new AnalyticsSessionUsage();
  }
}

// CollaborativeUsage 是 SessionUsage 的子集，不是额外计费。
class AnalyticsSessionUsage {
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

// Go 嵌入 AnalyticsActivity 译为继承。
class AnalyticsActivityPoint extends AnalyticsActivity {
  constructor(init = {}) {
    super(init);
    this.Date = init.Date ?? "";
  }
}

class AnalyticsSnapshot {
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
