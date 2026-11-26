/**
 * @file internal/domain/business_domain.js
 * 对应 Go 源文件：internal/domain/business_domain.go
 *
 * 作用与职责边界：
 * 定义业务域（管理型汇报维度）及其项目归属变更审计、按项目与按业务域聚合的资源用量、
 * 独立于运行创建时间的交付指标与交付趋势点，以及完整业务域运营报表的数据模型。
 * 仅描述领域结构，不负责权限判定或报表查询计算。
 *
 * 语法差异说明：
 * - Go 结构体匿名嵌入（`BusinessDomainProjectUsage` 嵌入 `AnalyticsProjectUsage`）转写为类继承（`extends`）。
 * - Go 指针字段和 `time.Time` 字段零值初始化为 `null`。
 */

"use strict";

const { AnalyticsProjectUsage, AnalyticsSummary, AnalyticsDeliverySummary, AnalyticsTrendPoint } = require("./analytics.js"); // 对应 Go 同包类型，analytics.js 已翻译

/**
 * 表示用于管理汇报的业务域实体，独立于项目的日常执行权限控制。
 * 记录业务域基本信息、启用状态以及管理员和查看者用户 ID 列表。
 */
class BusinessDomain {
  /**
   * 构造并初始化业务域实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示项目在不同业务域之间划转的归属变更审计记录。
 */
class BusinessDomainAssignment {
  /**
   * 构造并初始化项目业务域划转记录实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示业务域报表中的单个项目用量与交付指标行。
 * 对应 Go 中嵌入 `AnalyticsProjectUsage`，通过继承复用项目级运行与成本字段，并补充项目名、所属业务域及交付指标。
 */
class BusinessDomainProjectUsage extends AnalyticsProjectUsage {
  /**
   * 构造并初始化业务域项目用量实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
    this.Name = init.Name ?? "";
    this.BusinessDomainID = init.BusinessDomainID ?? "";
    this.DeliveryMetrics = init.DeliveryMetrics ?? new BusinessDeliveryMetrics();
  }
}

/**
 * 表示按业务域聚合的资源用量、需求交付量及交付周期指标汇总行。
 */
class BusinessDomainUsage {
  /**
   * 构造并初始化业务域汇总用量实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示按需求完成时间与 MR 合并时间独立口径计算的业务交付指标。
 * 周期均值与 P50/P95 分位数均基于单个已完成工作项计算，并记录缺失时间或倒挂样本计数以便审计。
 */
class BusinessDeliveryMetrics {
  /**
   * 构造并初始化业务交付指标实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示业务域交付趋势图中的单个时间桶数据点。
 * 记录该时间桶内的完成需求数、合并 MR 数以及端到端周期与纯执行耗时均值。
 */
class BusinessDeliveryTrendPoint {
  /**
   * 构造并初始化业务交付趋势点实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示一次业务域运营分析查询返回的完整报表载荷。
 * 整合归因口径、统计时间窗、平台总览与交付汇总、运行趋势、项目明细、业务域明细、交付指标及交付趋势。
 */
class BusinessDomainReport {
  /**
   * 构造并初始化业务域报表实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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
