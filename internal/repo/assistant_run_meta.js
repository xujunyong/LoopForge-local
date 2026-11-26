// assistant_run_meta.js —— 对应 Go 文件：internal/repo/assistant_run_meta.go
// 作用：侧边栏用的运行头、需求标识与会话消息数批量读取。

"use strict";

const { Buffer } = require("node:buffer");

const { TelemetryContext } = require("../domain/observability.js"); // 对应 Go 同包类型，observability.js 已翻译
const { RunsRepo, IssuesRepo, AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// SidebarRunMeta is the cheap run header the conversation history needs to
// name and label a shared SOP run session. Decorating the whole list from
// batched reads keeps the history endpoint's query count flat: per-session
// RunState lookups once made long histories slow and transferred node graphs
// the sidebar never shows.
class SidebarRunMeta {
  constructor(init = {}) {
    this.Status = init.Status ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.Kind = init.Kind ?? "";
    this.WorkflowName = init.WorkflowName ?? "";
    this.IssueID = init.IssueID ?? "";
    this.IssueNumber = init.IssueNumber ?? 0;
    this.ResponsibleUserID = init.ResponsibleUserID ?? 0;
    // Input is the head of the task text the run was started with; it names a
    // run that serves no requirement.
    this.Input = init.Input ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
  }
}

// sidebarRunInputChars bounds how much task text the list reads per run.
const sidebarRunInputChars = 300;

// SidebarRunMetas loads those headers for the listed runs.
RunsRepo.prototype.SidebarRunMetas = function (ids) {
  const out = {};
  if (ids.length === 0) {
    return out;
  }
  let nameExpr = "json_extract(snapshot, '$.name')";
  if (this.isMySQL()) {
    nameExpr = "JSON_UNQUOTE(JSON_EXTRACT(snapshot, '$.name'))";
  }
  for (let start = 0; start < ids.length; start += 500) {
    const rows = [];
    const err = this.DB.Table("runs")
      .Select(`id, status, workflow_id, kind, ${nameExpr} AS workflow, execution_context AS context, SUBSTR(input, 1, ${sidebarRunInputChars}) AS input, created_at AS created`)
      .Where("id IN ?", ids.slice(start, Math.min(start + 500, ids.length)))
      .Scan(rows).Error;
    if (err != null) {
      console.log(`sidebar run meta read failed: ${err}`);
      return out;
    }
    for (const row of rows) {
      const meta = new SidebarRunMeta({ Status: row.Status });
      if (row.Workflow != null) {
        meta.WorkflowName = row.Workflow;
      }
      let ctx = new TelemetryContext();
      if (row.Context != null && row.Context.length > 0) {
        try {
          ctx = new TelemetryContext(JSON.parse(typeof row.Context === "string" ? row.Context : Buffer.from(row.Context).toString("utf8")));
        } catch (e) {
          // Go 忽略解码错误。
        }
      }
      meta.IssueID = ctx.IssueID;
      meta.IssueNumber = ctx.IssueNumber;
      meta.ResponsibleUserID = ctx.ResponsibleUserID;
      if (row.WorkflowID != null) {
        meta.WorkflowID = row.WorkflowID;
      }
      if (row.Kind != null) {
        meta.Kind = row.Kind;
      }
      if (row.Input != null) {
        meta.Input = row.Input;
      }
      if (row.Created != null) {
        meta.CreatedAt = row.Created;
      }
      out[row.ID] = meta;
    }
  }
  return out;
};

// SidebarIssue is the requirement identity shown next to a SOP run.
class SidebarIssue {
  constructor(init = {}) {
    this.Number = init.Number ?? 0;
    this.Title = init.Title ?? "";
  }
}

// IssueSidebarIdentities loads only the requirement number and title, never
// the description or the comments.
IssuesRepo.prototype.IssueSidebarIdentities = function (ids) {
  const out = {};
  if (ids.length === 0) {
    return out;
  }
  for (let start = 0; start < ids.length; start += 500) {
    const rows = [];
    const err = this.DB.Table("issues").Select("id, number, title")
      .Where("id IN ?", ids.slice(start, Math.min(start + 500, ids.length))).Scan(rows).Error;
    if (err != null) {
      console.log(`sidebar issue identity read failed: ${err}`);
      return out;
    }
    for (const row of rows) {
      out[row.ID] = new SidebarIssue({ Number: row.Number, Title: row.Title });
    }
  }
  return out;
};

// AssistantSessionMessageCounts reports persisted message counts so the history
// list can tell an unused SOP run conversation from one that already holds a
// discussion, without transferring transcripts. The list projection strips
// messages, so the count has to come from the stored payload.
AssistantRepo.prototype.AssistantSessionMessageCounts = function (ids) {
  const out = {};
  if (ids.length === 0) {
    return out;
  }
  let expr = "COALESCE(json_array_length(payload, '$.messages'), 0)";
  if (this.isMySQL()) {
    expr = "COALESCE(JSON_LENGTH(JSON_EXTRACT(payload, '$.messages')), 0)";
  }
  for (let start = 0; start < ids.length; start += 500) {
    const rows = [];
    const err = this.DB.Table("assistant_sessions").Select("id, " + expr + " AS total")
      .Where("id IN ?", ids.slice(start, Math.min(start + 500, ids.length))).Scan(rows).Error;
    if (err != null) {
      console.log(`assistant message count read failed: ${err}`);
      return out;
    }
    for (const row of rows) {
      out[row.ID] = row.Total;
    }
  }
  return out;
};

module.exports = { SidebarRunMeta, sidebarRunInputChars, SidebarIssue };
