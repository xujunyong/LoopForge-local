/**
 * @file internal/repo/analytics_activity.js
 * 对应 Go 源文件：internal/repo/analytics_activity.go
 *
 * 作用与职责边界：
 * 提供平台活跃度的只读聚合统计，按时间窗口与筛选条件汇总持久化会话数、协作会话数、
 * 创建需求数、顶层需求 SOP 执行数、会话/协作回复 Token 用量及按时间桶聚合的活跃度趋势。
 * 严格保持只读语义（包含历史旧会话参与人的只读回退），不得触发元数据回填或持久化写入。
 *
 * 语法差异说明：
 * - Go 方法接收者 `func (r *AnalyticsRepo) analyticsActivity(...)` 挂载至 `AnalyticsRepo.prototype`。
 * - Go 仅返回 `error` 的方法在成功时返回 `undefined`、失败时抛出错误。
 * - Go 的 `map[int64]bool`（非字符串键 `participants`）按对照规则使用 `Map`；其余字符串键映射使用普通对象 `{}`。
 * - Go 的 `AnalyticsActivityPoint` 匿名嵌入 `AnalyticsActivity`，JS 中通过类继承直接传入 `points[key]` 累加。
 */

"use strict";

const { AnalyticsActivityPoint } = require("../domain/analytics.js"); // 对应 Go 的 domain.AnalyticsActivityPoint，domain 已翻译
const { AssistantSession } = require("../domain/assistant.js"); // 对应 Go 的 domain.AssistantSession，domain 已翻译
const { Issue } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue，domain 已翻译
const { AnalyticsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { analyticsTrendBucket, analyticsIssueMatchesSource, analyticsIsRequirementIssue, analyticsRunMatchesUser, isZeroTime, timeBefore, timeAfter } = require("./analytics.js"); // 对应 Go 同包函数，analytics.js 已翻译
const { accumulateSessionUsage } = require("./analytics_activity_usage.js"); // 对应 Go 同包函数，analytics_activity_usage.js 已翻译
const { decodeAssistantSession } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 待翻译
const { assistantSessionMetadataColumns } = require("./assistant_shared.js"); // 对应 Go 同包常量，assistant_shared.js 待翻译

/**
 * 统计平台活跃度指标并写入分析快照的 `Activity` 与 `ActivityTrend` 字段。
 * 在生成运营分析快照时调用；包含对历史会话参与人的只读分批补读，绝不调用会回填存储元数据的历史列表辅助函数。
 *
 * @param {import("../domain/analytics.js").AnalyticsFilter} filter - 分析查询筛选条件（来源、项目、时间窗、用户、粒度等）。
 * @param {import("../domain/issue.js").Issue[]} issues - 当前查询范围内的需求列表。
 * @param {import("../domain/run.js").Run[]} runs - 当前查询范围内的平台运行摘要列表。
 * @param {import("../domain/analytics.js").AnalyticsSnapshot} out - 待回填活跃度汇总与趋势数据的分析快照对象。
 * @returns {void} 无返回值；数据库查询或 JSON 解析失败时抛出错误。
 */
AnalyticsRepo.prototype.analyticsActivity = function (filter, issues, runs, out) {
  out.ActivityTrend = [];
  if (filter.Origin === "external") {
    return;
  }
  const points = {};
  const add = (at, count) => {
    if (!analyticsActivityInWindow(at, filter)) {
      return;
    }
    count(out.Activity);
    const key = analyticsTrendBucket(at, filter.Grain);
    if (points[key] == null) {
      points[key] = new AnalyticsActivityPoint({ Date: key });
    }
    count(points[key]);
  };
  const byID = {};
  const matchesIssue = (issue) => {
    return filter.MatchesProject(issue.ProjectID) &&
      (filter.WorkflowID === "" || issue.WorkflowID === filter.WorkflowID) &&
      (filter.IssueSource === "" || analyticsIssueMatchesSource(issue, filter.IssueSource)) &&
      (!filter.RequirementsOnly || analyticsIsRequirementIssue(issue));
  };
  for (const issue of issues ?? []) {
    byID[issue.ID] = issue;
    if (!matchesIssue(issue) || !analyticsIsRequirementIssue(issue)) {
      continue;
    }
    if (filter.UserID !== "" && String(issue.AssigneeUserID) !== filter.UserID) {
      continue;
    }
    add(issue.CreatedAt, (a) => { a.Requirements++; });
  }
  for (const run of runs ?? []) {
    const issue = byID[run.ExecutionContext.IssueID.trim()] ?? new Issue();
    let projectID = run.ExecutionContext.ProjectID.trim();
    if (projectID === "") {
      projectID = issue.ProjectID;
    }
    if (run.IsWorkspace() || run.HistoricalGroup() || run.ExecutionContext.ParentRunID !== "" ||
      !analyticsIsRequirementIssue(issue) || !filter.MatchesProject(projectID) ||
      (filter.WorkflowID !== "" && run.WorkflowID !== filter.WorkflowID) ||
      (filter.IssueSource !== "" && !analyticsIssueMatchesSource(issue, filter.IssueSource)) ||
      !analyticsRunMatchesUser(run, filter.UserID, issue)) {
      continue;
    }
    add(run.CreatedAt, (a) => { a.SOPRuns++; });
  }
  // SQL 查询会剔除新格式记录的对话全文；旧格式记录在下方按有界批次只读补查，以统计历史会话且不写回数据库。
  let q = this.DB.Table("assistant_sessions").Select(assistantSessionMetadataColumns);
  if (filter.ProjectID !== "") {
    q = q.Where("project_id = ?", filter.ProjectID);
  }
  if (filter.ProjectIDs != null) {
    if (filter.ProjectIDs.length === 0) {
      q = q.Where("1 = 0");
    } else {
      q = q.Where("project_id IN ?", filter.ProjectIDs);
    }
  }
  const rows = []; // Go: var rows []assistantSessionRow（models.go 待翻译）
  const err = q.Find(rows).Error;
  if (err != null) {
    throw err;
  }
  const sessions = [];
  const legacy = [];
  for (const row of rows) {
    const session = new AssistantSession(JSON.parse(row.Payload.toString("utf8")));
    session.ID = row.ID;
    session.UserID = row.UserID;
    if (session.ProjectID === "") {
      session.ProjectID = row.ProjectID;
    }
    if (row.Created != null) {
      session.CreatedAt = row.Created;
    }
    if (session.Shared || session.RunID !== "" || session.ID.startsWith("sop-") ||
      !filter.MatchesProject(session.ProjectID)) {
      continue;
    }
    if (filter.WorkflowID !== "" || filter.IssueSource !== "" || filter.RequirementsOnly) {
      const issue = byID[session.IssueID] ?? null;
      if (issue == null || issue.ProjectID !== session.ProjectID || !matchesIssue(issue)) {
        continue;
      }
    }
    sessions.push(session);
    if (session.ParticipantsVersion !== 1) {
      legacy.push(session.ID);
    }
  }
  const legacySessions = {};
  for (let start = 0; start < legacy.length; start += 100) {
    const end = Math.min(start + 100, legacy.length);
    const full = []; // Go: var full []assistantSessionRow（models.go 待翻译）
    const legacyErr = this.DB.Where("id IN ?", legacy.slice(start, end)).Find(full).Error;
    if (legacyErr != null) {
      throw legacyErr;
    }
    for (const row of full) {
      const session = decodeAssistantSession(row);
      session.Messages = null;
      legacySessions[row.ID] = session;
    }
  }
  const usageSessions = {};
  const usageIDs = [];
  const collaborative = {};
  for (const session of sessions) {
    const old = legacySessions[session.ID] ?? null;
    if (old != null) {
      session.Participants = old.Participants;
    }
    // Go 中为 map[int64]bool（非字符串键），按对照规则使用 Map。
    const participants = new Map();
    for (const p of session.Participants ?? []) {
      if (p.ID > 0) {
        participants.set(p.ID, true);
      }
    }
    if (filter.UserID !== "") {
      const id = /^[+-]?\d+$/.test(filter.UserID) ? Number.parseInt(filter.UserID, 10) : Number.NaN;
      if (Number.isNaN(id) || (session.UserID !== id && !participants.get(id))) {
        continue;
      }
    }
    add(session.CreatedAt, (a) => {
      a.Sessions++;
      if (participants.size >= 2) {
        a.CollaborativeSessions++;
      }
    });
    usageIDs.push(session.ID);
    usageSessions[session.ID] = session;
    collaborative[session.ID] = participants.size >= 2;
  }
  this.analyticsSessionUsage(usageIDs, (id, messages) => {
    const session = usageSessions[id];
    for (const message of messages) {
      // 分叉会话复制的前缀消息已计入原会话，此处跳过避免重复统计。
      if (session.ParentSessionID !== "" && message.Index < session.ForkMessageIndex) {
        continue;
      }
      let at = message.CreatedAt;
      if (isZeroTime(at) && message.StartedAt != null) {
        at = message.StartedAt;
      }
      const count = (a) => {
        accumulateSessionUsage(a.SessionUsage, message.Usage, isZeroTime(at));
        if (collaborative[id]) {
          accumulateSessionUsage(a.CollaborativeUsage, message.Usage, isZeroTime(at));
        }
      };
      if (isZeroTime(at) && isZeroTime(filter.From) && isZeroTime(filter.To)) {
        count(out.Activity);
      } else {
        add(at, count);
      }
    }
  });
  for (const point of Object.values(points)) {
    out.ActivityTrend.push(point);
  }
  out.ActivityTrend.sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : 0));
};

/**
 * 判断活跃度事件时间戳是否落在筛选条件指定的时间窗口内（含边界）。
 * 在统计需求创建、SOP 启动、会话创建与消息回复事件时调用；零值时间始终判定为不在窗口内。
 *
 * @param {Date|null} at - 待判断的事件时间。
 * @param {import("../domain/analytics.js").AnalyticsFilter} filter - 包含 `From` 与 `To` 边界的筛选条件。
 * @returns {boolean} 事件时间非零且处于 `[From, To]` 区间内时返回 `true`，否则返回 `false`。
 */
function analyticsActivityInWindow(at, filter) {
  return !isZeroTime(at) && (isZeroTime(filter.From) || !timeBefore(at, filter.From)) && (isZeroTime(filter.To) || !timeAfter(at, filter.To));
}

module.exports = { analyticsActivityInWindow };
