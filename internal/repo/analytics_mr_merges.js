/**
 * @file internal/repo/analytics_mr_merges.js
 * 对应 Go 源文件：internal/repo/analytics_mr_merges.go
 *
 * 作用与职责边界：
 * 按 MR 实际合并时间（独立于 Run 创建时间窗口）统计已合并的交付 MR 明细与缺失合并时间计数。
 * 主键 `(mr_project, mr_iid)` 保证每条 MR 仅统计一次，同一需求跨多仓库时分别计数，并排除无工作需求的基线提升 MR。
 *
 * 语法差异说明：
 * - Go 方法接收者 `func (r *AnalyticsRepo) mrMergeAnalytics(...)` 挂载至 `AnalyticsRepo.prototype`。
 * - Go 的多返回值 `([]domain.AnalyticsMRMerge, int)` 译为二元组 `[items, missingTime]`。
 * - 复制 `filter` 时通过 `new AnalyticsFilter(filter)` 保留原型方法，并显式回填 `ProjectIDs` 以保留 `null`（不限项目）与 `[]`（无可见项目）的语义差异。
 */

"use strict";

const { Run } = require("../domain/run.js"); // 对应 Go 的 domain.Run，domain 已翻译
const { Issue } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue，domain 已翻译
const { AnalyticsFilter, AnalyticsMRMerge } = require("../domain/analytics.js"); // 对应 Go 的 domain.AnalyticsFilter/AnalyticsMRMerge，domain 已翻译
const { GongfengMRURL } = require("../domain/delivery_mr.js"); // 对应 Go 的 domain.GongfengMRURL，domain 已翻译
const { BaselinePromoteIssueID } = require("../domain/mr.js"); // 对应 Go 的 domain.BaselinePromoteIssueID，domain 已翻译
const { AnalyticsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { analyticsRunMatchesUser, analyticsIssueMatchesSource, analyticsIsRequirementIssue, isZeroTime } = require("./analytics.js"); // 对应 Go 同包函数，analytics.js 已翻译

/**
 * 按 MR 合并时间窗口查询并过滤已合并的 MR 明细列表，同时统计缺失合并时间的已合并 MR 条数。
 * 在生成运营分析快照时调用；当指定 `WorkflowID` 或 `UserID` 时先跨全时间段反查匹配运行关联的需求，再结合需求归属与来源筛选 MR。
 *
 * @param {AnalyticsFilter} filter - 分析查询筛选条件（项目、工作流、用户、来源、仅需求与合并时间窗等）。
 * @param {Object<string, Issue>} issues - 按需求 ID 索引的需求映射，用于关联项目、标题、来源与责任人。
 * @returns {[AnalyticsMRMerge[], number]} 二元组 `[已合并 MR 明细数组, 缺失合并时间的已合并 MR 数量]`。
 */
AnalyticsRepo.prototype.mrMergeAnalytics = function (filter, issues) {
  const items = [];
  if (filter.ProjectIDs != null && filter.ProjectIDs.length === 0) {
    return [items, 0];
  }
  const matchingRuns = {};
  if (filter.WorkflowID !== "" || filter.UserID !== "") {
    const runFilter = new AnalyticsFilter(filter);
    runFilter.ProjectIDs = filter.ProjectIDs;
    runFilter.From = null;
    runFilter.To = null;
    let runs;
    try {
      runs = this.runs.RunSummariesFor(runFilter, "");
    } catch {
      return [items, 0];
    }
    for (const run of runs) {
      const issueID = run.ExecutionContext.IssueID;
      if (analyticsRunMatchesUser(run, filter.UserID, issues[issueID] ?? new Issue())) {
        matchingRuns[issueID] = true;
      }
    }
  }

  let q = this.DB.Where("state = ? AND issue_id <> '' AND issue_id <> ?", "merged", BaselinePromoteIssueID);
  if (!isZeroTime(filter.From)) {
    q = q.Where("merged_at IS NULL OR merged_at >= ?", filter.From);
  }
  if (!isZeroTime(filter.To)) {
    q = q.Where("merged_at IS NULL OR merged_at <= ?", filter.To);
  }
  const rows = []; // Go: var rows []mrDeliveryStateRow（models.go 待翻译）
  const err = q.Order("merged_at DESC, mr_project ASC, mr_iid ASC").Find(rows).Error;
  if (err != null) {
    return [items, 0];
  }
  let missingTime = 0;
  for (const row of rows) {
    const issue = issues[row.IssueID] ?? null;
    if (issue == null || !filter.MatchesProject(issue.ProjectID) ||
      !analyticsIssueMatchesSource(issue, filter.IssueSource) ||
      (filter.RequirementsOnly && !analyticsIsRequirementIssue(issue))) {
      continue;
    }
    if (filter.WorkflowID !== "" || filter.UserID !== "") {
      if (!matchingRuns[issue.ID] && !(filter.WorkflowID === "" && analyticsRunMatchesUser(new Run(), filter.UserID, issue))) {
        continue;
      }
    }
    if (row.MergedAt == null || isZeroTime(row.MergedAt)) {
      missingTime++;
      continue;
    }
    let url = row.MRURL;
    if (url === "") {
      url = GongfengMRURL(row.MRProject, row.MRIID);
    }
    items.push(new AnalyticsMRMerge({
      MRProject: row.MRProject, MRIID: row.MRIID, MRURL: url,
      TargetBranch: row.TargetBranch, IssueID: issue.ID, Title: issue.Title,
      MergedAt: row.MergedAt,
    }));
  }
  return [items, missingTime];
};

module.exports = {};
