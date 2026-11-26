// analytics_mr_merges.js —— 对应 Go 文件：internal/repo/analytics_mr_merges.go
// 作用：按 MR 时钟统计已合并 MR，不依赖 Run 创建窗口。

"use strict";

const { Run } = require("../domain/run.js"); // 对应 Go 的 domain.Run，domain 已翻译
const { Issue } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue，domain 已翻译
const { AnalyticsMRMerge } = require("../domain/analytics.js"); // 对应 Go 的 domain.AnalyticsMRMerge，domain 已翻译
const { GongfengMRURL } = require("../domain/delivery_mr.js"); // 对应 Go 的 domain.GongfengMRURL，domain 已翻译
const { BaselinePromoteIssueID } = require("../domain/mr.js"); // 对应 Go 的 domain.BaselinePromoteIssueID，domain 已翻译
const { AnalyticsRepo, analyticsRunMatchesUser, analyticsIssueMatchesSource, analyticsIsRequirementIssue, isZeroTime } = require("./analytics.js"); // 对应 Go 同包类型与函数，analytics.js 已翻译

// mrMergeAnalytics uses the MR clock independently of the Run creation window.
// The primary key (mr_project, mr_iid) counts each MR once, including multiple
// repositories for one requirement. Baseline promotion MRs have no work issue.
AnalyticsRepo.prototype.mrMergeAnalytics = function (filter, issues) {
  const items = [];
  if (filter.ProjectIDs != null && filter.ProjectIDs.length === 0) {
    return [items, 0];
  }
  const matchingRuns = {};
  if (filter.WorkflowID !== "" || filter.UserID !== "") {
    const runFilter = { ...filter };
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
