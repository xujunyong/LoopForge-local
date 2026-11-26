// analytics_activity_usage.js —— 对应 Go 文件：internal/repo/analytics_activity_usage.go
// 作用：会话用量投影：只取回复时间戳与用量。

"use strict";

const { AssistantMessage } = require("../domain/assistant.js"); // 对应 Go 的 domain.AssistantMessage，domain 已翻译
const { AnalyticsRepo } = require("./analytics.js"); // 对应 Go 同包类型，analytics.js 已翻译
const { summaryProjectionUnsupported } = require("./assistant_context.js"); // 对应 Go 同包函数，assistant_context.js 待翻译

class analyticsUsageMessage {
  constructor(init = {}) {
    this.Index = init.Index ?? 0;
    this.CreatedAt = init.CreatedAt ?? null;
    this.StartedAt = init.StartedAt ?? null;
    this.Usage = init.Usage ?? null;
  }
}

class analyticsUsageRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Messages = init.Messages ?? null;
  }
}

// Go 的 atomic.Bool 在单线程 JS 里用普通布尔变量。
let noAnalyticsUsageProjection = false;

// Project only reply timestamps and usage, never content or tool output.
// MySQL 5.7 lacks JSON_TABLE; its read-only fallback reads bounded batches.
AnalyticsRepo.prototype.analyticsSessionUsage = function (ids, visit) {
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, Math.min(start + 100, ids.length));
    let rows = [];
    let projected = !noAnalyticsUsageProjection;
    if (projected) {
      let expr = `(SELECT json_group_array(json_object('index',CAST(m.key AS INTEGER),'createdAt',json_extract(m.value,'$.createdAt'),'startedAt',json_extract(m.value,'$.startedAt'),'usage',json_extract(m.value,'$.usage'))) FROM json_each(s.payload,'$.messages') m WHERE json_extract(m.value,'$.role')='assistant')`;
      if (this.isMySQL()) {
        expr = `(SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('index',m.pos-1,'createdAt',JSON_EXTRACT(s.payload,CONCAT('$.messages[',m.pos-1,'].createdAt')),'startedAt',JSON_EXTRACT(s.payload,CONCAT('$.messages[',m.pos-1,'].startedAt')),'usage',JSON_EXTRACT(s.payload,CONCAT('$.messages[',m.pos-1,'].usage')))),JSON_ARRAY()) FROM JSON_TABLE(s.payload,'$.messages[*]' COLUMNS(pos FOR ORDINALITY,role VARCHAR(32) PATH '$.role')) m WHERE m.role='assistant')`;
      }
      const err = this.DB.Table("assistant_sessions s").Select("s.id, " + expr + " AS messages").Where("s.id IN ?", batch).Scan(rows).Error;
      if (err != null) {
        if (!this.isMySQL() || !summaryProjectionUnsupported(err)) {
          throw err;
        }
        noAnalyticsUsageProjection = true;
        projected = false;
      }
    }
    if (!projected) {
      rows = [];
      const err = this.DB.Table("assistant_sessions").Select("id, JSON_EXTRACT(payload,'$.messages') AS messages").Where("id IN ?", batch).Scan(rows).Error;
      if (err != null) {
        throw err;
      }
    }
    for (const row of rows) {
      let messages = [];
      if (row.Messages != null && row.Messages.length > 0) {
        if (projected) {
          messages = JSON.parse(row.Messages.toString("utf8")).map((m) => new analyticsUsageMessage(m));
        } else {
          const full = JSON.parse(row.Messages.toString("utf8")).map((m) => new AssistantMessage(m));
          for (let i = 0; i < full.length; i++) {
            const m = full[i];
            if (m.Role === "assistant") {
              messages.push(new analyticsUsageMessage({ Index: i, CreatedAt: m.CreatedAt, StartedAt: m.StartedAt, Usage: m.Usage }));
            }
          }
        }
      }
      visit(row.ID, messages);
    }
  }
};

function accumulateSessionUsage(out, usage, undated) {
  if (undated) {
    out.UndatedReplies++;
  }
  if (usage == null) {
    out.MissingReplies++;
    return;
  }
  out.ReportedReplies++;
  let total = usage.TotalTokens;
  if (total === 0) {
    total = usage.InputTokens + usage.OutputTokens;
  }
  out.Tokens += total;
  out.InputTokens += usage.InputTokens;
  out.OutputTokens += usage.OutputTokens;
  out.CacheReadTokens += usage.CacheReadTokens;
  out.CacheWriteTokens += usage.CacheWriteTokens;
}

module.exports = { analyticsUsageMessage, analyticsUsageRow, accumulateSessionUsage };
