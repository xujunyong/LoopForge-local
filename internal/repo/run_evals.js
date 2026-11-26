/**
 * @file internal/repo/run_evals.js
 * 对应 Go 源文件：internal/repo/run_evals.go
 *
 * 作用与职责边界：
 * 实现 `RunsRepo` 对运行质量评估记录（`run_evals` 表）的持久化读写能力，包括保存评估记录、
 * 按 ID 查询单条评估、查询最新评估与进行中评估、按运行 ID 列出评估历史，以及超出上限后的旧记录裁剪。
 * 不负责评估打分计算、LLM 调用或 HTTP 接口组装。
 *
 * 语法差异说明：
 * - `RunsRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `RunsRepo.prototype` 挂载评估相关方法。
 * - Go 的仅 `error` 返回统一译为成功返回 `undefined`、失败 `throw err`；`(RunEvalRecord, bool)` 译为 `[RunEvalRecord, boolean]` 二元组。
 * - Go 的 `math.MaxInt64` 在 JS 的 SQLite `Limit` 占位处以 `Number.MAX_SAFE_INTEGER` 表达；`time.Time` 零值在 JS 中为 `null`。
 */

"use strict";

const { Buffer } = require("node:buffer");

const { RunEvalRecord, RunEvalRunning } = require("../domain/run_eval.js"); // 对应 Go 的 domain.RunEvalRecord/RunEvalRunning，run_eval.js 已翻译
const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runEvalRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { upsert, timePtr, jsonUnmarshal } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译

// 单次运行最多保留的评估历史条数，超出部分在写入后裁剪。
const maxRunEvalsPerRun = 10;

/**
 * 写入或更新一条运行评估记录，并在保存后按单次运行保留上限裁剪过旧的历史记录。
 * 使用场景：评估任务创建、状态流转或完成写入打分结果时调用。
 *
 * @param {RunEvalRecord} v - 待持久化的运行评估记录对象。
 * @returns {void} 无返回值。
 * @throws {Error} 缺少主键或运行 ID、JSON 序列化失败、数据库写入或裁剪失败时抛出错误。
 */
RunsRepo.prototype.PutRunEval = function (v) {
  if (v.ID === "" || v.RunID === "") {
    throw new Error("run eval id and runId are required");
  }
  if (v.CreatedAt == null) {
    v.CreatedAt = new Date();
  }
  const payload = Buffer.from(JSON.stringify(v), "utf8");
  upsert(this.DB, "run_evals", {
    id: v.ID, run_id: v.RunID, status: v.Status, score: v.Score, passed: v.Passed,
    model: v.Model, created_by: v.CreatedBy, payload: payload,
    created_at: timePtr(v.CreatedAt), finished_at: timePtr(v.FinishedAt),
  });
  this.trimRunEvals(v.RunID);
};

/**
 * 按评估记录主键 ID 查询单条运行评估记录。
 * 使用场景：查看某次具体评估详情或对单条评估建议执行应用操作前校验记录存在性。
 *
 * @param {string} id - 评估记录主键 ID。
 * @returns {[RunEvalRecord, boolean]} 二元组 `[评估记录, 是否存在]`；未找到或查询失败时返回 `[new RunEvalRecord(), false]`。
 */
RunsRepo.prototype.RunEval = function (id) {
  const row = new runEvalRow();
  if (this.DB.Where("id = ?", id).Take(row).Error != null) {
    return [new RunEvalRecord(), false];
  }
  return runEvalFromRow(row);
};

/**
 * 查询指定运行最新创建的一条评估记录（按 `created_at DESC, id DESC` 排序）。
 * 使用场景：运行详情页展示最近一次评估结论与状态。
 *
 * @param {string} runID - 运行主键 ID。
 * @returns {[RunEvalRecord, boolean]} 二元组 `[最新评估记录, 是否存在]`；无记录或查询失败时返回 `[new RunEvalRecord(), false]`。
 */
RunsRepo.prototype.LatestRunEval = function (runID) {
  const row = new runEvalRow();
  if (this.DB.Where("run_id = ?", runID).Order("created_at DESC, id DESC").Limit(1).Take(row).Error != null) {
    return [new RunEvalRecord(), false];
  }
  return runEvalFromRow(row);
};

/**
 * 按创建时间倒序查询指定运行的最近若干条评估记录（最多返回 `maxRunEvalsPerRun` 条）。
 * 使用场景：运行评估历史列表展示。
 *
 * @param {string} runID - 运行主键 ID。
 * @returns {RunEvalRecord[] | null} 评估记录数组；数据库查询出错时返回 `null`。
 */
RunsRepo.prototype.ListRunEvals = function (runID) {
  const rows = [];
  if (this.DB.Where("run_id = ?", runID).Order("created_at DESC, id DESC").Limit(maxRunEvalsPerRun).Find(rows).Error != null) {
    return null;
  }
  const out = [];
  for (const row of rows) {
    const [rec, ok] = runEvalFromRow(row);
    if (ok) {
      out.push(rec);
    }
  }
  return out;
};

/**
 * 查询指定运行当前正在执行（状态为 `RunEvalRunning`）的最新一条评估记录。
 * 使用场景：触发新评估前去重，避免同一运行并发重复启动评估任务。
 *
 * @param {string} runID - 运行主键 ID。
 * @returns {[RunEvalRecord, boolean]} 二元组 `[进行中的评估记录, 是否存在]`；无进行中记录或查询失败时返回 `[new RunEvalRecord(), false]`。
 */
RunsRepo.prototype.ActiveRunEval = function (runID) {
  const row = new runEvalRow();
  if (this.DB.Where("run_id = ? AND status = ?", runID, RunEvalRunning).Order("created_at DESC").Limit(1).Take(row).Error != null) {
    return [new RunEvalRecord(), false];
  }
  return runEvalFromRow(row);
};

/**
 * 裁剪指定运行超出保留上限（`maxRunEvalsPerRun`）的较旧评估记录。
 * MySQL 不允许单独使用 `OFFSET`，因此与定义修订裁剪保持一致，显式搭配最大 `LIMIT`。
 *
 * @param {string} runID - 运行主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 查询待删除 ID 或执行删除语句失败时抛出错误。
 */
RunsRepo.prototype.trimRunEvals = function (runID) {
  const ids = [];
  let err = null;
  if (this.isMySQL()) {
    err = this.DB.Raw(
      "SELECT id FROM run_evals WHERE run_id = ? ORDER BY created_at DESC, id DESC LIMIT 18446744073709551615 OFFSET ?",
      runID, maxRunEvalsPerRun).Scan(ids).Error;
  } else {
    err = this.DB.Model(new runEvalRow()).Where("run_id = ?", runID).Order("created_at DESC, id DESC").Limit(Number.MAX_SAFE_INTEGER).Offset(maxRunEvalsPerRun).Pluck("id", ids).Error;
  }
  if (err != null) {
    throw err;
  }
  if (ids.length === 0) {
    return;
  }
  const delErr = this.DB.Where("id IN ?", ids).Delete(new runEvalRow()).Error;
  if (delErr != null) {
    throw delErr;
  }
};

/**
 * 将数据库 `run_evals` 行记录解码并覆盖列字段后组装为 `RunEvalRecord` 领域对象。
 * 当 `Payload` JSON 解析失败时降级仅保留主键与表索引列，保证历史行仍可读取。
 *
 * @param {runEvalRow} row - 数据库评估记录行模型。
 * @returns {[RunEvalRecord, boolean]} 二元组 `[组装后的评估记录, true]`。
 */
function runEvalFromRow(row) {
  let rec = new RunEvalRecord();
  try {
    jsonUnmarshal(row.Payload, rec);
  } catch {
    rec = new RunEvalRecord({ ID: row.ID, RunID: row.RunID });
  }
  rec.ID = row.ID;
  rec.RunID = row.RunID;
  rec.Status = row.Status;
  rec.Score = row.Score;
  rec.Passed = row.Passed;
  rec.Model = row.Model;
  rec.CreatedBy = row.CreatedBy;
  if (row.Created != null) {
    rec.CreatedAt = row.Created;
  }
  if (row.Finished != null) {
    rec.FinishedAt = row.Finished;
  }
  return [rec, true];
}

module.exports = { maxRunEvalsPerRun, runEvalFromRow };
