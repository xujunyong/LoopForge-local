// analytics_business_domains.js —— 对应 Go 文件：internal/repo/analytics_business_domains.go
// 作用：业务域报表：按业务域汇总项目用量与交付数。

"use strict";

const { AnalyticsFilter, AnalyticsProjectUsage } = require("../domain/analytics.js"); // 对应 Go 的 domain.AnalyticsFilter/AnalyticsProjectUsage，domain 已翻译
const { BusinessDomainReport, BusinessDomainProjectUsage, BusinessDomainUsage } = require("../domain/business_domain.js"); // 对应 Go 的 domain.BusinessDomainReport 等，domain 已翻译
const { AnalyticsRepo } = require("./analytics.js"); // 对应 Go 同包类型，analytics.js 已翻译

// BusinessDomainReport reuses the underlying samples for rates and percentiles.
// It returns aggregates only; domain access does not grant run/log/user detail access.
AnalyticsRepo.prototype.BusinessDomainReport = function (filter, projects, domains) {
  // 概览聚合与交付指标都基于同一批 run/issue。这里只取一次全量 run 摘要
  //（不按时间窗裁剪），交给下面两条路径共用，避免同一份数据被完整扫描两遍。
  // 时间窗仍由各路径在 Go 侧过滤，口径与各自取数时完全一致。
  let prefetchedRuns = null;
  let prefetchedEvents = null;
  if ((filter.ProjectIDs ?? []).length > 0 && filter.ProjectID === "" && filter.WorkflowID === "") {
    [prefetchedRuns, prefetchedEvents] = this.runs.RunSummariesWithEventsFor(new AnalyticsFilter({ ProjectIDs: filter.ProjectIDs }), "");
  }
  const snap = this.analyticsWithRuns(filter, prefetchedRuns);
  if (snap.DataErrors.length > 0) {
    throw new Error(snap.DataErrors[0]);
  }
  const out = new BusinessDomainReport({ Attribution: "current", GeneratedAt: snap.Summary.GeneratedAt, From: filter.From, To: filter.To, Summary: snap.Summary, Delivery: snap.Delivery, Trend: snap.Trend, Projects: [], BusinessDomains: [] });
  const [groups, order] = newBusinessDomainGroups(domains);
  const usage = {};
  for (const u of snap.ProjectUsage) {
    usage[u.ProjectID] = u;
  }
  const projectDomains = {};
  for (const p of projects ?? []) {
    if (!filter.MatchesProject(p.ID)) {
      continue;
    }
    projectDomains[p.ID] = p.BusinessDomainID;
    let u = usage[p.ID] ?? null;
    if (u == null) {
      u = new AnalyticsProjectUsage({ ProjectID: p.ID, CostKnown: true });
    }
    const projectUsage = new BusinessDomainProjectUsage(u);
    projectUsage.Name = p.Name;
    projectUsage.BusinessDomainID = p.BusinessDomainID;
    out.Projects.push(projectUsage);
    const g = groups[p.BusinessDomainID] ?? null;
    if (g == null) {
      continue;
    }
    addBusinessDomainProjectUsage(g, u);
  }
  this.addBusinessDeliveryCounts(snap.Deliveries, projectDomains, groups);
  for (const id of order) {
    const g = groups[id];
    if (g.ProjectCount > 0) {
      out.BusinessDomains.push(g);
    }
  }
  this.populateBusinessDeliveryMetrics(out, filter, prefetchedRuns, prefetchedEvents);
  return out;
};

// newBusinessDomainGroups builds one usage group per business domain in the
// given order, followed by the "未分类" group (empty ID) for projects without a
// domain. The returned order is the output order of the report.
function newBusinessDomainGroups(domains) {
  const groups = {};
  const order = [];
  for (const d of domains ?? []) {
    groups[d.ID] = new BusinessDomainUsage({ ID: d.ID, Name: d.Name, Active: d.Active, CostKnown: true });
    order.push(d.ID);
  }
  groups[""] = new BusinessDomainUsage({ ID: "", Name: "未分类", Active: true, CostKnown: true });
  order.push("");
  return [groups, order];
}

// addBusinessDomainProjectUsage adds one project's usage to its business domain group.
function addBusinessDomainProjectUsage(g, u) {
  g.ProjectCount++;
  g.Runs += u.Runs;
  g.Success += u.Success;
  g.Failed += u.Failed;
  g.Tokens += u.Tokens;
  g.CostUSD += u.CostUSD;
  g.CostCNY += u.CostCNY;
  g.UniqueIssues += u.UniqueIssues;
  g.CostKnown = g.CostKnown && u.CostKnown;
}

// Resolve only delivered issues, then attribute each delivery once across all query batches.
AnalyticsRepo.prototype.addBusinessDeliveryCounts = function (deliveries, projectDomains, groups) {
  const ids = [];
  const seen = {};
  for (const d of deliveries ?? []) {
    if (d.Delivered && d.IssueID !== "" && !seen[d.IssueID]) {
      seen[d.IssueID] = true;
      ids.push(d.IssueID);
    }
  }
  const byIssue = {};
  for (let start = 0; start < ids.length; start += 500) {
    const rows = []; // Go: var rows []issueRow（models.go 待翻译）
    const err = this.DB.Select(["id", "project_id"]).Where("id IN ?", ids.slice(start, Math.min(start + 500, ids.length))).Find(rows).Error;
    if (err != null) {
      throw err;
    }
    for (const row of rows) {
      byIssue[row.ID] = row.ProjectID;
    }
  }
  for (const d of deliveries ?? []) {
    if (!d.Delivered) {
      continue;
    }
    const projectID = byIssue[d.IssueID] ?? null;
    if (projectID == null) {
      continue;
    }
    const id = projectDomains[projectID];
    const allowed = id !== undefined;
    if (allowed && groups[id] != null) {
      groups[id].Delivered++;
    }
  }
};

module.exports = { newBusinessDomainGroups, addBusinessDomainProjectUsage };
