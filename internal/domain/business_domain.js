// business_domain.js —— 对应 Go 文件：internal/domain/business_domain.go
// 作用：业务域（管理型汇报维度）及其用量与交付报表结构。

"use strict";

const { AnalyticsProjectUsage, AnalyticsSummary, AnalyticsDeliverySummary, AnalyticsTrendPoint } = require("./analytics.js"); // 对应 Go 同包类型，analytics.js 已翻译

// BusinessDomain：管理型汇报维度，与项目执行权限无关。
class BusinessDomain {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Description = init.Description ?? "";
    this.Active = init.Active ?? false;
    this.ManagerIDs = init.ManagerIDs ?? [];
    this.ViewerIDs = init.ViewerIDs ?? [];
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

class BusinessDomainAssignment {
  constructor(init = {}) {
    this.ID = init.ID ?? 0;
    this.ProjectID = init.ProjectID ?? "";
    this.FromDomainID = init.FromDomainID ?? "";
    this.ToDomainID = init.ToDomainID ?? "";
    this.ActorID = init.ActorID ?? 0;
    this.Reason = init.Reason ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
  }
}

// Go 嵌入 AnalyticsProjectUsage 译为继承。
class BusinessDomainProjectUsage extends AnalyticsProjectUsage {
  constructor(init = {}) {
    super(init);
    this.Name = init.Name ?? "";
    this.BusinessDomainID = init.BusinessDomainID ?? "";
    this.DeliveryMetrics = init.DeliveryMetrics ?? new BusinessDeliveryMetrics();
  }
}

class BusinessDomainUsage {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Active = init.Active ?? false;
    this.ProjectCount = init.ProjectCount ?? 0;
    this.Runs = init.Runs ?? 0;
    this.Success = init.Success ?? 0;
    this.Failed = init.Failed ?? 0;
    this.Tokens = init.Tokens ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.CostCNY = init.CostCNY ?? 0;
    this.CostKnown = init.CostKnown ?? false;
    this.UniqueIssues = init.UniqueIssues ?? 0;
    this.Delivered = init.Delivered ?? 0;
    this.DeliveryMetrics = init.DeliveryMetrics ?? new BusinessDeliveryMetrics();
  }
}

// BusinessDeliveryMetrics：完成与合并时钟相互独立，分位数按单个已完成工作项计算。
class BusinessDeliveryMetrics {
  constructor(init = {}) {
    this.CompletionToMergeSamples = init.CompletionToMergeSamples ?? 0;
    this.AverageCompletionToMergeMs = init.AverageCompletionToMergeMs ?? 0;
    this.CompletionToMergeMissingIssues = init.CompletionToMergeMissingIssues ?? 0;
    this.MergedBeforeCompletionIssues = init.MergedBeforeCompletionIssues ?? 0;
    this.CompletionToMergeMissingMRs = init.CompletionToMergeMissingMRs ?? 0;
    this.MergedBeforeCompletionMRs = init.MergedBeforeCompletionMRs ?? 0;
    this.CompletedIssues = init.CompletedIssues ?? 0;
    this.MergedMRs = init.MergedMRs ?? 0;
    this.MergedMRsMissingTime = init.MergedMRsMissingTime ?? 0;
    this.CompletionTimeMissingIssues = init.CompletionTimeMissingIssues ?? 0;
    this.EstimatedCompletionIssues = init.EstimatedCompletionIssues ?? 0;
    this.CycleSamples = init.CycleSamples ?? 0;
    this.AverageCycleDurationMs = init.AverageCycleDurationMs ?? 0;
    this.ExecutionSamples = init.ExecutionSamples ?? 0;
    this.AverageExecutionDurationMs = init.AverageExecutionDurationMs ?? 0;
    this.P50CycleDurationMs = init.P50CycleDurationMs ?? 0;
    this.P95CycleDurationMs = init.P95CycleDurationMs ?? 0;
    this.CompletedTokens = init.CompletedTokens ?? 0;
    this.AverageTokensPerCompletedIssue = init.AverageTokensPerCompletedIssue ?? 0;
    this.LatestCompletedAt = init.LatestCompletedAt ?? null;
  }
}

class BusinessDeliveryTrendPoint {
  constructor(init = {}) {
    this.Date = init.Date ?? "";
    this.CompletedIssues = init.CompletedIssues ?? 0;
    this.MergedMRs = init.MergedMRs ?? 0;
    this.CycleSamples = init.CycleSamples ?? 0;
    this.AverageCycleDurationMs = init.AverageCycleDurationMs ?? 0;
    this.ExecutionSamples = init.ExecutionSamples ?? 0;
    this.AverageExecutionDurationMs = init.AverageExecutionDurationMs ?? 0;
  }
}

class BusinessDomainReport {
  constructor(init = {}) {
    this.Attribution = init.Attribution ?? "";
    this.GeneratedAt = init.GeneratedAt ?? null;
    this.From = init.From ?? null;
    this.To = init.To ?? null;
    this.Summary = init.Summary ?? new AnalyticsSummary();
    this.Delivery = init.Delivery ?? new AnalyticsDeliverySummary();
    this.Trend = init.Trend ?? [];
    this.Projects = init.Projects ?? [];
    this.BusinessDomains = init.BusinessDomains ?? [];
    this.DeliveryMetrics = init.DeliveryMetrics ?? new BusinessDeliveryMetrics();
    this.DeliveryTrend = init.DeliveryTrend ?? [];
    this.TimeZone = init.TimeZone ?? "";
    this.Grain = init.Grain ?? "";
  }
}

module.exports = { BusinessDomain, BusinessDomainAssignment, BusinessDomainProjectUsage, BusinessDomainUsage, BusinessDeliveryMetrics, BusinessDeliveryTrendPoint, BusinessDomainReport };
