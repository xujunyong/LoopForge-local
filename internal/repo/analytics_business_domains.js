/**
 * @file internal/repo/analytics_business_domains.js
 * 对应 Go 源文件：internal/repo/analytics_business_domains.go
 *
 * 作用与职责边界：
 * 提供业务域维度的只读管理报表聚合，复用底层运营分析样本与交付指标逻辑，
 * 按业务域汇总所辖项目的运行量、成败数、Token 与成本、已交付需求数及交付周期指标。
 * 仅输出聚合结果，不向业务域视图暴露单条运行、日志或用户级明细。
 *
 * 语法差异说明：
 * - Go 方法接收者 `func (r *AnalyticsRepo) ...` 挂载至 `AnalyticsRepo.prototype`。
 * - Go 的 `(值, error)` 与仅 `error` 返回在成功时直接返回值或 `undefined`，失败时抛出错误。
 * - Go 的 `v, ok := m[k]` 键存在性判断在需要区分空字符串值与缺失键时使用 `Object.hasOwn(m, k)`。
 */

"use strict";

const { AnalyticsFilter, AnalyticsProjectUsage } = require("../domain/analytics.js"); // 对应 Go 的 domain.AnalyticsFilter/AnalyticsProjectUsage，domain 已翻译
const { BusinessDomainReport, BusinessDomainProjectUsage, BusinessDomainUsage } = require("../domain/business_domain.js"); // 对应 Go 的 domain.BusinessDomainReport 等，domain 已翻译
const { AnalyticsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译

/**
 * 生成业务域维度的只读运营与交付聚合报表。
 * 在管理视图查询业务域总览时调用；当仅按项目集筛选时先预取一次全量运行摘要与计时事件，
 * 供概览聚合与交付指标计算两条路径共用，避免对同一批运行数据做两次全量扫描。
 *
 * @param {AnalyticsFilter} filter - 分析查询筛选条件（项目范围、时间窗、粒度、时区等）。
 * @param {import("../domain/project.js").Project[]} projects - 当前可见的项目列表。
 * @param {import("../domain/business_domain.js").BusinessDomain[]} domains - 按展示顺序排列的业务域列表。
 * @returns {BusinessDomainReport} 包含总览、趋势、项目明细、业务域明细与交付指标的报表对象；底层查询失败时抛出错误。
 */
AnalyticsRepo.prototype.BusinessDomainReport = function (filter, projects, domains) {
  // 概览聚合与交付指标都基于同一批 run/issue。这里只取一次全量 run 摘要
  //（不按时间窗裁剪），交给下面两条路径共用，避免同一份数据被完整扫描两遍。
  // 时间窗仍由各路径在本地过滤，口径与各自取数时完全一致。
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

/**
 * 按给定顺序为每个业务域初始化汇总分组，并在末尾追加空 ID 的“未分类”分组以承接未归属业务域的项目。
 * 在构造业务域报表时调用，返回的 `order` 决定最终报表中业务域的输出顺序。
 *
 * @param {import("../domain/business_domain.js").BusinessDomain[]} domains - 业务域定义列表。
 * @returns {[Object<string, BusinessDomainUsage>, string[]]} 二元组 `[按业务域 ID 索引的汇总分组映射, 业务域输出顺序列表]`。
 */
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

/**
 * 将单个项目的运行、成败、Token、成本与唯一需求数累加到其所属业务域分组中。
 * 在业务域报表按项目归组时调用。
 *
 * @param {BusinessDomainUsage} g - 目标业务域汇总对象（就地修改）。
 * @param {AnalyticsProjectUsage} u - 单个项目的用量汇总对象。
 * @returns {void} 无返回值。
 */
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

/**
 * 批量反查已交付需求所属的项目，并将每条已交付记录归属并累加到对应业务域分组的 `Delivered` 计数中。
 * 在业务域报表汇总交付数时调用；按每批 500 个需求 ID 分批查询，避免跨批次重复归因。
 *
 * @param {import("../domain/analytics.js").AnalyticsDelivery[]} deliveries - 分析快照中的交付明细列表。
 * @param {Object<string, string>} projectDomains - 允许统计的项目 ID 到业务域 ID 的映射。
 * @param {Object<string, BusinessDomainUsage>} groups - 按业务域 ID 索引的汇总分组映射（就地累加 `Delivered`）。
 * @returns {void} 无返回值；数据库查询失败时抛出错误。
 */
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
    if (!Object.hasOwn(byIssue, d.IssueID)) {
      continue;
    }
    const projectID = byIssue[d.IssueID];
    const allowed = Object.hasOwn(projectDomains, projectID);
    const id = projectDomains[projectID];
    if (allowed && groups[id] != null) {
      groups[id].Delivered++;
    }
  }
};

module.exports = { newBusinessDomainGroups, addBusinessDomainProjectUsage };
