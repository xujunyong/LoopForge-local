// analytics_activity.js —— 对应 Go 文件：internal/repo/analytics_activity.go
// 作用：会话、需求与顶层需求 SOP 执行的独立统计。

"use strict";

const { AnalyticsActivityPoint } = require("../domain/analytics.js"); // 对应 Go 的 domain.AnalyticsActivityPoint，domain 已翻译
const { AssistantSession } = require("../domain/assistant.js"); // 对应 Go 的 domain.AssistantSession，domain 已翻译
const { Issue } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue，domain 已翻译
const { AnalyticsRepo, analyticsTrendBucket, analyticsIssueMatchesSource, analyticsIsRequirementIssue, analyticsRunMatchesUser, isZeroTime, timeBefore, timeAfter } = require("./analytics.js"); // 对应 Go 同包类型与函数，analytics.js 已翻译
const { accumulateSessionUsage } = require("./analytics_activity_usage.js"); // 对应 Go 同包函数，analytics_activity_usage.js 已翻译
const { decodeAssistantSession } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 待翻译
const { assistantSessionMetadataColumns } = require("./assistant_shared.js"); // 对应 Go 同包常量，assistant_shared.js 待翻译

// analyticsActivity is read-only, including its legacy participant fallback.
// Do not use the history-list helpers here: they may backfill stored metadata.
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
  // SQL removes transcripts for modern rows. Legacy rows are read in bounded
  // batches below so older conversations are counted without writing backfills.
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
    const participants = {};
    for (const p of session.Participants ?? []) {
      if (p.ID > 0) {
        participants[p.ID] = true;
      }
    }
    if (filter.UserID !== "") {
      const id = Number.parseInt(filter.UserID, 10);
      if (Number.isNaN(id) || (session.UserID !== id && participants[id] == null)) {
        continue;
      }
    }
    add(session.CreatedAt, (a) => {
      a.Sessions++;
      if (Object.keys(participants).length >= 2) {
        a.CollaborativeSessions++;
      }
    });
    usageIDs.push(session.ID);
    usageSessions[session.ID] = session;
    collaborative[session.ID] = Object.keys(participants).length >= 2;
  }
  this.analyticsSessionUsage(usageIDs, (id, messages) => {
    const session = usageSessions[id];
    for (const message of messages) {
      // A fork copies the prefix, which was already charged to its source.
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

function analyticsActivityInWindow(at, filter) {
  return !isZeroTime(at) && (isZeroTime(filter.From) || !timeBefore(at, filter.From)) && (isZeroTime(filter.To) || !timeAfter(at, filter.To));
}

module.exports = { analyticsActivityInWindow };
