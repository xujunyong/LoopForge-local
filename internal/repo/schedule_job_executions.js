/**
 * @file internal/repo/schedule_job_executions.js
 * 对应 Go 源文件：internal/repo/schedule_job_executions.go
 *
 * 作用与职责边界：
 * 为目录仓储 `CatalogRepo` 实现定时任务单次执行历史的持久化与分析能力：
 * 单次执行的写入/按上限裁剪与按小时统计累加、按 ID 查询、近 7 天与前 7 天执行总览对比统计、
 * 支持关键词检索的分页查询与总数统计、历史列表查询，以及进程异常中止后残留运行中执行的批量判败。
 * 不负责定时任务定义本身的调度触发或结果通知入队（见 `schedule_job_results.js`）。
 *
 * 语法差异说明：
 * - `CatalogRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `CatalogRepo.prototype` 挂载定时任务执行相关方法。
 * - Go 的仅 `error` 返回与 `db.Transaction(tx => ...)` 回调统一遵循成功返回 `undefined`、失败 `throw err`；
 *   `(T, bool)` 与非错误双返回值（如 `(current, previous)`、`([]T, int)`）分别译为二元组 `[T, boolean]`、`[current, previous]`、`[T[], number]`。
 * - `ScheduleJobExecutionOverview` 中的 `durations` / `costs` 在 Go 中以指针 `*domain.ScheduleExecutionWindow` 为键，
 *   属于非字符串键映射，依对照规则保留 JS `Map` 并以窗口对象引用为键。
 * - Go 的 `time.Hour` 换算为毫秒数 `3600000`；`gorm.Expr` 保留原调用形态；`Count(&total)` 出参使用 `{ value: 0 }` 承载。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { ScheduleJobExecution, ScheduleJobExecutionID, ScheduleExecutionWindow, ScheduleExecutionTokens } = require("../domain/schedule_execution.js"); // 对应 Go 的 domain.*，schedule_execution.js 已翻译
const { AnalyticsUSDToCNY } = require("../domain/token_pricing.js"); // 对应 Go 的 domain.AnalyticsUSDToCNY，token_pricing.js 已翻译
const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { payloadOne, upsert, insertIgnore, mustJSON, timePtr, jsonUnmarshal } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { scheduleJobExecutionRow, scheduleJobExecutionStatRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { isZeroTime } = require("./analytics.js"); // 对应 Go 同包函数，analytics.js 已翻译

// 每个定时任务最多保留的历史执行记录条数；写入新执行时会自动裁剪超出上限的最旧记录。
const MaxScheduleJobExecutionsPerJob = 200;

/**
 * 定时任务执行历史列表的筛选条件结构体。
 * 对应 Go 约定：调用方显式传入空切片 `[]` 表示无可见任务（不返回任何记录），显式传入 `null` 表示不按任务 ID 过滤。
 */
class ScheduleJobExecutionQuery {
  /**
   * 构造执行历史查询条件，缺省字段严格按 Go 零值初始化（切片为 `[]`）。
   * 若调用方需要复现 Go 中 `JobIDs == nil`（不按任务 ID 过滤）的语义，可显式传入 `{ JobIDs: null }`。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string[] | null} [init.JobIDs=[]] - 允许查询的定时任务 ID 列表。
   * @param {string} [init.ProjectID=""] - 按所属项目 ID 过滤。
   * @param {string} [init.Status=""] - 按执行状态过滤。
   * @param {string} [init.TraceID=""] - 按链路追踪 ID 过滤。
   * @param {number} [init.Limit=0] - 最大返回条数（`<=0` 或 `>500` 时回退为 `100`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.JobIDs = init.JobIDs === undefined ? [] : init.JobIDs;
    this.ProjectID = init.ProjectID ?? "";
    this.Status = init.Status ?? "";
    this.TraceID = init.TraceID ?? "";
    this.Limit = init.Limit ?? 0;
  }
}

/**
 * 在事务内插入或更新一条定时任务执行记录；首次进入终态时同步累加至对应小时桶统计表，
 * 并在新增执行时清理超过保留期的旧小时统计及超出 `MaxScheduleJobExecutionsPerJob` 的最旧历史行。
 *
 * @param {ScheduleJobExecution} e - 待保存的定时任务执行领域对象。
 * @returns {void} 无返回值。
 * @throws {Error} 事务查询、写入执行记录、累加统计或裁剪旧记录失败时抛出错误。
 */
CatalogRepo.prototype.PutScheduleJobExecution = function (e) {
  if (e.ID.trim() === "") {
    e.ID = ScheduleJobExecutionID(e.TraceID);
  }
  this.DB.Transaction((tx) => {
    // 同一执行由运行它的调度器按序写入，前一状态不会在写入中途变化。
    const prior = [];
    const pluckErr = tx.Model(new scheduleJobExecutionRow()).Where("id = ?", e.ID).Pluck("status", prior).Error;
    if (pluckErr != null) {
      throw pluckErr;
    }
    const existing = prior.length > 0;
    upsert(tx, "schedule_job_executions", {
      id: e.ID,
      job_id: e.JobID,
      project_id: e.ProjectID,
      trace_id: e.TraceID,
      status: e.Status,
      payload: mustJSON(e),
      started_at: timePtr(e.StartedAt),
      updated_at: timePtr(new Date()),
    });
    if (e.Finished() && !(existing && new ScheduleJobExecution({ Status: prior[0] }).Finished())) {
      countScheduleJobExecution(tx, e);
    }
    if (existing) {
      return;
    }
    const deleteErr = tx.Where("job_id = ? AND bucket_hour < ?", e.JobID, new Date(Date.now() - scheduleExecutionStatsRetention)).Delete(new scheduleJobExecutionStatRow()).Error;
    if (deleteErr != null) {
      throw deleteErr;
    }
    // 每次插入时裁剪使任务最多只超出上限 1 行；不用 Offset 是因为 MySQL 不接受无 LIMIT 的 OFFSET。
    const ids = [];
    const idsErr = tx.Model(new scheduleJobExecutionRow()).Where("job_id = ?", e.JobID).Order("started_at DESC").Order("id DESC").Pluck("id", ids).Error;
    if (idsErr != null) {
      throw idsErr;
    }
    if (ids.length <= MaxScheduleJobExecutionsPerJob) {
      return;
    }
    const pruneErr = tx.Where("id IN ?", ids.slice(MaxScheduleJobExecutionsPerJob)).Delete(new scheduleJobExecutionRow()).Error;
    if (pruneErr != null) {
      throw pruneErr;
    }
  });
};

/**
 * 按主键 ID 读取单条定时任务执行记录。
 *
 * @param {string} id - 执行记录主键 ID。
 * @returns {[ScheduleJobExecution, boolean]} 找到且解码成功时返回 `[执行对象, true]`，否则返回 `[空执行对象, false]`。
 */
CatalogRepo.prototype.ScheduleJobExecution = function (id) {
  return payloadOne(ScheduleJobExecution, this.DB, "schedule_job_executions", id);
};

// 小时级统计表的保留时长（30 天，换算为毫秒），足以覆盖看板近 7 天与前 7 天的对比周期。
const scheduleExecutionStatsRetention = 30 * 24 * 3600000;

/**
 * 将一条已结束的定时任务执行累加到其开始时间所属的 UTC 整点小时统计桶中。
 * 供 `PutScheduleJobExecution` 在事务内首次观察到终态时调用。
 *
 * @param {object} tx - 当前活跃的 `gorm.DB` 事务句柄。
 * @param {ScheduleJobExecution} e - 已进入终态的定时任务执行对象。
 * @returns {void} 无返回值。
 * @throws {Error} 幂等初始化小时桶行或执行原子自增更新失败时抛出错误。
 */
function countScheduleJobExecution(tx, e) {
  let started = e.StartedAt;
  if (isZeroTime(started)) {
    started = new Date();
  }
  const hour = new Date(Math.floor(started.getTime() / 3600000) * 3600000); // Go 的 Truncate(time.Hour) 译为向下取整到整点小时。
  insertIgnore(tx, "schedule_job_execution_stats", {
    job_id: e.JobID, bucket_hour: hour, project_id: e.ProjectID,
    finished: 0, success: 0, failed: 0, timed: 0, duration_ms: 0,
    metered: 0, tokens_total: 0, tokens_input: 0, tokens_output: 0,
    tokens_cache_read: 0, tokens_cache_write: 0, priced: 0, cost_usd: 0,
  });
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
  const err = tx.Model(new scheduleJobExecutionStatRow()).Where("job_id = ? AND bucket_hour = ?", e.JobID, hour).Updates(updates).Error;
  if (err != null) {
    throw err;
  }
}

/**
 * 汇总指定任务集合在近 7×24 小时（`current`，含 `now` 所在小时）与前 7×24 小时（`previous`）的执行总览。
 * 已结束执行的数字来自小时统计表，不受历史明细裁剪条数限制；运行中的执行数直接统计执行历史表。
 *
 * @param {string[]} jobIDs - 纳入统计的定时任务 ID 数组。
 * @param {Date} now - 统计基准时间。
 * @returns {[ScheduleExecutionWindow, ScheduleExecutionWindow]} 二元组 `[当前 7 天窗口, 上一 7 天窗口]`。
 */
CatalogRepo.prototype.ScheduleJobExecutionOverview = function (jobIDs, now) {
  // Go 的零值窗口自带 Tokens 结构体值，JS 里显式初始化避免空引用。
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
  // 对应 Go 的 map[*domain.ScheduleExecutionWindow][2]int64 与 map[*domain.ScheduleExecutionWindow]float64；
  // 键为非字符串的窗口指针（对象引用），因此使用 JS Map 存储。
  const durations = new Map();
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

/**
 * 定时任务执行看板的分页查询条件结构体。
 * `Search` 会不区分大小写地匹配 `ScheduleJobExecution.MatchesSearch` 覆盖的业务字段。
 */
class ScheduleJobExecutionPageQuery {
  /**
   * 构造执行分页查询条件，缺省字段严格按 Go 零值初始化（切片为 `[]`，时间为 `null`）。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string[]} [init.JobIDs=[]] - 可见定时任务 ID 列表。
   * @param {string} [init.Status=""] - 按状态筛选。
   * @param {Date | null} [init.Since=null] - 起始时间下界（`started_at >= Since`）。
   * @param {string} [init.Search=""] - 模糊搜索关键词。
   * @param {number} [init.Offset=0] - 分页偏移量。
   * @param {number} [init.Limit=0] - 每页条数（`<=0` 或 `>100` 时回退为 `20`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.JobIDs = init.JobIDs ?? [];
    this.Status = init.Status ?? "";
    this.Since = init.Since ?? null;
    this.Search = init.Search ?? "";
    this.Offset = init.Offset ?? 0;
    this.Limit = init.Limit ?? 0;
  }
}

/**
 * 按开始时间与主键倒序分页查询定时任务执行记录，并返回符合筛选条件的总条数。
 * 无关键词时直接在 SQL 层统计总数并分页；有关键词时先通过 SQL 载荷文本初筛，再调用 `MatchesSearch` 精确过滤后切片。
 *
 * @param {ScheduleJobExecutionPageQuery} q - 分页与筛选查询条件。
 * @returns {[ScheduleJobExecution[], number]} 二元组 `[当前页执行记录数组, 匹配总条数]`。
 */
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
      try {
        jsonUnmarshal(row.Payload, e);
        items.push(e);
      } catch {
        // Go 忽略单行解码失败的记录。
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
      return [out, total.value];
    }
    return [decode(rows), total.value];
  }
  // 先用 SQL 载荷文本缩小候选集，再由领域对象字段精确判定；每任务最多保留上限行，候选集有界。
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

/**
 * 统计指定定时任务集合当前保留的历史执行记录总条数。
 *
 * @param {string[]} jobIDs - 定时任务 ID 数组。
 * @returns {number} 保留的执行记录总条数；数组为空或查询失败时返回 `0`。
 */
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

/**
 * 按开始时间与主键倒序列出满足条件的定时任务执行历史（最多返回 500 条，默认 100 条）。
 *
 * @param {ScheduleJobExecutionQuery} q - 列表筛选条件对象。
 * @returns {ScheduleJobExecution[]} 解码成功的执行历史数组；无可见任务或查询失败时返回空数组。
 */
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
    try {
      jsonUnmarshal(row.Payload, e);
      out.push(e);
    } catch {
      // Go 忽略单行解码失败的记录。
    }
  }
  return out;
};

/**
 * 将因进程异常退出而残留为 `running` 状态且早于 `cutoff` 启动的执行记录批量标记为 `failed`，
 * 补齐失败原因、结束时间与耗时，并复用 `PutScheduleJobExecution` 同步计入小时统计。
 *
 * @param {Date} cutoff - 截止时间（仅处理 `started_at < cutoff` 的运行中执行）。
 * @param {string} reason - 写入空错误字段的默认失败原因说明。
 * @returns {void} 无返回值。
 * @throws {Error} 查询残留执行记录或回写任一执行失败时抛出错误。
 */
CatalogRepo.prototype.FailRunningScheduleJobExecutions = function (cutoff, reason) {
  const rows = [];
  const findErr = this.DB.Where("status = ? AND started_at < ?", "running", cutoff).Find(rows).Error;
  if (findErr != null) {
    throw findErr;
  }
  for (const row of rows) {
    const e = new ScheduleJobExecution();
    try {
      jsonUnmarshal(row.Payload, e);
    } catch {
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
    this.PutScheduleJobExecution(e);
  }
};

module.exports = { MaxScheduleJobExecutionsPerJob, ScheduleJobExecutionQuery, ScheduleJobExecutionPageQuery, scheduleExecutionStatsRetention, countScheduleJobExecution };
