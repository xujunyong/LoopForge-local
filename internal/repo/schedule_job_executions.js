// schedule_job_executions.js —— 对应 Go 文件：internal/repo/schedule_job_executions.go
// 作用：定时任务单次执行的写入、分页查询、总览统计与过期清理。
// gorm 链式调用按原样保留；Go 的 (T, bool)/(T, error) 译为 [值, 布尔/错误]；Go 的 time.Hour 换算为毫秒。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { ScheduleJobExecution, ScheduleJobExecutionID, ScheduleExecutionWindow, ScheduleExecutionTokens } = require("../domain/schedule_execution.js"); // 对应 Go 的 domain.*，schedule_execution.js 已翻译
const { AnalyticsUSDToCNY } = require("../domain/token_pricing.js"); // 对应 Go 的 domain.AnalyticsUSDToCNY，token_pricing.js 已翻译
const { payloadOne, upsert, insertIgnore, mustJSON, timePtr, jsonUnmarshal } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { scheduleJobExecutionRow, scheduleJobExecutionStatRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { isZeroTime } = require("./analytics.js"); // 对应 Go 同包函数，analytics.js 已翻译

const MaxScheduleJobExecutionsPerJob = 200;

class ScheduleJobExecutionQuery {
  constructor(init = {}) {
    this.JobIDs = init.JobIDs ?? null;
    this.ProjectID = init.ProjectID ?? "";
    this.Status = init.Status ?? "";
    this.TraceID = init.TraceID ?? "";
    this.Limit = init.Limit ?? 0;
  }
}

CatalogRepo.prototype.PutScheduleJobExecution = function (e) {
  if (e.ID.trim() === "") {
    e.ID = ScheduleJobExecutionID(e.TraceID);
  }
  return this.DB.Transaction((tx) => {
    // 同一执行由运行它的调度器按序写入，前一状态不会在写入中途变化。
    const prior = [];
    const pluckErr = tx.Model(new scheduleJobExecutionRow()).Where("id = ?", e.ID).Pluck("status", prior).Error;
    if (pluckErr != null) {
      return pluckErr;
    }
    const existing = prior.length > 0;
    const upsertErr = upsert(tx, "schedule_job_executions", {
      id: e.ID,
      job_id: e.JobID,
      project_id: e.ProjectID,
      trace_id: e.TraceID,
      status: e.Status,
      payload: mustJSON(e),
      started_at: timePtr(e.StartedAt),
      updated_at: timePtr(new Date()),
    });
    if (upsertErr != null) {
      return upsertErr;
    }
    if (e.Finished() && !(existing && new ScheduleJobExecution({ Status: prior[0] }).Finished())) {
      const countErr = countScheduleJobExecution(tx, e);
      if (countErr != null) {
        return countErr;
      }
    }
    if (existing) {
      return null;
    }
    const deleteErr = tx.Where("job_id = ? AND bucket_hour < ?", e.JobID, new Date(Date.now() - scheduleExecutionStatsRetention)).Delete(new scheduleJobExecutionStatRow()).Error;
    if (deleteErr != null) {
      return deleteErr;
    }
    // 不用 Offset：MySQL 不接受无 LIMIT 的 OFFSET。
    const ids = [];
    const idsErr = tx.Model(new scheduleJobExecutionRow()).Where("job_id = ?", e.JobID).Order("started_at DESC").Order("id DESC").Pluck("id", ids).Error;
    if (idsErr != null) {
      return idsErr;
    }
    if (ids.length <= MaxScheduleJobExecutionsPerJob) {
      return null;
    }
    return tx.Where("id IN ?", ids.slice(MaxScheduleJobExecutionsPerJob)).Delete(new scheduleJobExecutionRow()).Error;
  });
};

CatalogRepo.prototype.ScheduleJobExecution = function (id) {
  return payloadOne(ScheduleJobExecution, this.DB, "schedule_job_executions", id);
};

const scheduleExecutionStatsRetention = 30 * 24 * 3600000;

function countScheduleJobExecution(tx, e) {
  let started = e.StartedAt;
  if (isZeroTime(started)) {
    started = new Date();
  }
  const hour = new Date(Math.floor(started.getTime() / 3600000) * 3600000); // Go 的 Truncate(time.Hour) 译为向下取整到小时。
  try {
    insertIgnore(tx, "schedule_job_execution_stats", {
      job_id: e.JobID, bucket_hour: hour, project_id: e.ProjectID,
      finished: 0, success: 0, failed: 0, timed: 0, duration_ms: 0,
      metered: 0, tokens_total: 0, tokens_input: 0, tokens_output: 0,
      tokens_cache_read: 0, tokens_cache_write: 0, priced: 0, cost_usd: 0,
    });
  } catch (err) {
    return err;
  }
  const updates = { finished: gorm.Expr("finished + 1") };
  switch (e.Status) {
    case "success":
      updates.success = gorm.Expr("success + 1");
      break;
    case "failed":
      updates.failed = gorm.Expr("failed + 1");
      break;
  }
  if (e.DurationMs > 0) {
    updates.timed = gorm.Expr("timed + 1");
    updates.duration_ms = gorm.Expr("duration_ms + ?", e.DurationMs);
  }
  const u = e.Usage;
  if (u != null) {
    updates.metered = gorm.Expr("metered + 1");
    updates.tokens_total = gorm.Expr("tokens_total + ?", e.ExecutionTotalTokens());
    updates.tokens_input = gorm.Expr("tokens_input + ?", u.InputTokens);
    updates.tokens_output = gorm.Expr("tokens_output + ?", u.OutputTokens);
    updates.tokens_cache_read = gorm.Expr("tokens_cache_read + ?", u.CacheReadTokens);
    updates.tokens_cache_write = gorm.Expr("tokens_cache_write + ?", u.CacheWriteTokens);
    if (e.CostCNY != null) {
      updates.priced = gorm.Expr("priced + 1");
      updates.cost_usd = gorm.Expr("cost_usd + ?", u.CostUSD);
    }
  }
  return tx.Model(new scheduleJobExecutionStatRow()).Where("job_id = ? AND bucket_hour = ?", e.JobID, hour).Updates(updates).Error;
}

CatalogRepo.prototype.ScheduleJobExecutionOverview = function (jobIDs, now) {
  // Go 的零值窗口自带 Tokens 结构体值，JS 里显式补一个。
  const current = new ScheduleExecutionWindow({ Tokens: new ScheduleExecutionTokens() });
  const previous = new ScheduleExecutionWindow({ Tokens: new ScheduleExecutionTokens() });
  if (jobIDs.length === 0) {
    return [current, previous];
  }
  const currentFrom = new Date(Math.floor(now.getTime() / 3600000) * 3600000 - 167 * 3600000);
  const previousFrom = new Date(currentFrom.getTime() - 168 * 3600000);
  const pick = (t) => {
    if (t.getTime() < previousFrom.getTime()) {
      return null;
    }
    if (t.getTime() < currentFrom.getTime()) {
      return previous;
    }
    return current;
  };
  const durations = new Map(); // Go 的 map[指针][2]int64，JS 用 Map。
  const costs = new Map();
  const stats = [];
  if (this.DB.Where("job_id IN ? AND bucket_hour >= ?", jobIDs, previousFrom).Find(stats).Error == null) {
    for (const s of stats) {
      const w = pick(s.BucketHour);
      if (w == null) {
        continue;
      }
      w.Finished += s.Finished;
      w.Success += s.Success;
      w.Failed += s.Failed;
      const d = durations.get(w) ?? [0, 0];
      durations.set(w, [d[0] + s.DurationMs, d[1] + s.Timed]);
      w.Metered += s.Metered;
      w.Tokens.Total += s.TokensTotal;
      w.Tokens.Input += s.TokensInput;
      w.Tokens.Output += s.TokensOutput;
      w.Tokens.CacheRead += s.TokensCacheRead;
      w.Tokens.CacheWrite += s.TokensCacheWrite;
      w.Priced += s.Priced;
      costs.set(w, (costs.get(w) ?? 0) + s.CostUSD);
    }
  }
  const running = [];
  if (this.DB.Model(new scheduleJobExecutionRow()).Where("job_id IN ? AND status = ? AND started_at >= ?", jobIDs, "running", previousFrom).Pluck("started_at", running).Error == null) {
    for (const t of running) {
      if (t == null) {
        continue;
      }
      const w = pick(t);
      if (w != null) {
        w.Running++;
      }
    }
  }
  for (const w of [current, previous]) {
    w.Total = w.Finished + w.Running;
    const d = durations.get(w) ?? [0, 0];
    if (d[1] > 0) {
      w.AvgMs = Math.trunc(d[0] / d[1]);
    }
    if (w.Metered > 0) {
      w.AvgTokens = Math.trunc(w.Tokens.Total / w.Metered);
    }
    w.CostCNY = Math.round((costs.get(w) ?? 0) * AnalyticsUSDToCNY * 100) / 100;
  }
  return [current, previous];
};

class ScheduleJobExecutionPageQuery {
  constructor(init = {}) {
    this.JobIDs = init.JobIDs ?? null;
    this.Status = init.Status ?? "";
    this.Since = init.Since ?? null;
    this.Search = init.Search ?? "";
    this.Offset = init.Offset ?? 0;
    this.Limit = init.Limit ?? 0;
  }
}

CatalogRepo.prototype.ScheduleJobExecutionPage = function (q) {
  const out = [];
  if (q.JobIDs.length === 0) {
    return [out, 0];
  }
  let limit = q.Limit;
  if (limit <= 0 || limit > 100) {
    limit = 20;
  }
  const offset = Math.max(q.Offset, 0);
  let db = this.DB.Model(new scheduleJobExecutionRow()).Where("job_id IN ?", q.JobIDs);
  if (q.Status !== "") {
    db = db.Where("status = ?", q.Status);
  }
  if (!isZeroTime(q.Since)) {
    db = db.Where("started_at >= ?", q.Since);
  }
  const decode = (rows) => {
    const items = [];
    for (const row of rows) {
      const e = new ScheduleJobExecution();
      if (jsonUnmarshal(row.Payload, e) == null) {
        items.push(e);
      }
    }
    return items;
  };
  const search = q.Search.trim().toLowerCase();
  if (search === "") {
    const total = { value: 0 }; // Go 的 Count(&total) 用对象接出参。
    if (db.Session(new gorm.Session()).Count(total).Error != null) {
      return [out, 0];
    }
    const rows = [];
    if (db.Order("started_at DESC").Order("id DESC").Offset(offset).Limit(limit).Find(rows).Error != null) {
      return [decode(rows), total.value];
    }
    return [decode(rows), total.value];
  }
  let cast = "LOWER(CAST(payload AS TEXT))";
  if (this.DB.Dialector.Name() === "mysql") {
    cast = "LOWER(CAST(payload AS CHAR))";
  }
  const rows = [];
  if (db.Where("INSTR(" + cast + ", ?) > 0", search).Order("started_at DESC").Order("id DESC").Find(rows).Error != null) {
    return [out, 0];
  }
  for (const e of decode(rows)) {
    if (e.MatchesSearch(search)) {
      out.push(e);
    }
  }
  const total = out.length;
  if (offset >= total) {
    return [[], total];
  }
  return [out.slice(offset, Math.min(offset + limit, total)), total];
};

CatalogRepo.prototype.CountScheduleJobExecutions = function (jobIDs) {
  if (jobIDs.length === 0) {
    return 0;
  }
  const total = { value: 0 }; // Go 的 Count(&total) 用对象接出参。
  if (this.DB.Model(new scheduleJobExecutionRow()).Where("job_id IN ?", jobIDs).Count(total).Error != null) {
    return 0;
  }
  return total.value;
};

CatalogRepo.prototype.ScheduleJobExecutions = function (q) {
  if (q.JobIDs != null && q.JobIDs.length === 0) {
    return [];
  }
  let db = this.DB.Model(new scheduleJobExecutionRow());
  if (q.JobIDs != null) {
    db = db.Where("job_id IN ?", q.JobIDs);
  }
  if (q.ProjectID !== "") {
    db = db.Where("project_id = ?", q.ProjectID);
  }
  if (q.Status !== "") {
    db = db.Where("status = ?", q.Status);
  }
  if (q.TraceID !== "") {
    db = db.Where("trace_id = ?", q.TraceID);
  }
  let limit = q.Limit;
  if (limit <= 0 || limit > 500) {
    limit = 100;
  }
  const rows = [];
  if (db.Order("started_at DESC").Order("id DESC").Limit(limit).Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const e = new ScheduleJobExecution();
    if (jsonUnmarshal(row.Payload, e) == null) {
      out.push(e);
    }
  }
  return out;
};

CatalogRepo.prototype.FailRunningScheduleJobExecutions = function (cutoff, reason) {
  const rows = [];
  const findErr = this.DB.Where("status = ? AND started_at < ?", "running", cutoff).Find(rows).Error;
  if (findErr != null) {
    return findErr;
  }
  for (const row of rows) {
    const e = new ScheduleJobExecution();
    if (jsonUnmarshal(row.Payload, e) != null) {
      continue;
    }
    const finished = new Date(cutoff.getTime());
    e.Status = "failed";
    if (e.Error === "") {
      e.Error = reason;
    }
    e.FinishedAt = finished;
    if (!isZeroTime(e.StartedAt)) {
      e.DurationMs = finished.getTime() - e.StartedAt.getTime();
    }
    const putErr = this.PutScheduleJobExecution(e);
    if (putErr != null) {
      return putErr;
    }
  }
  return null;
};

module.exports = { MaxScheduleJobExecutionsPerJob, ScheduleJobExecutionQuery, ScheduleJobExecutionPageQuery, scheduleExecutionStatsRetention, countScheduleJobExecution };
