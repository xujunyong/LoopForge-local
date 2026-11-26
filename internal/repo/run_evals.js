// run_evals.js —— 对应 Go 文件：internal/repo/run_evals.go
// 作用：运行评估记录的读写：保存、单条、最新、列表、进行中与超量裁剪。

"use strict";

const { Buffer } = require("node:buffer");

const { RunEvalRecord, RunEvalRunning } = require("../domain/run_eval.js"); // 对应 Go 的 domain.RunEvalRecord/RunEvalRunning，run_eval.js 已翻译
const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runEvalRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { upsert, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { isZeroTime } = require("./analytics.js"); // 对应 Go 的时间比较，analytics.js 已翻译

const maxRunEvalsPerRun = 10;

RunsRepo.prototype.PutRunEval = function (v) {
  if (v.ID === "" || v.RunID === "") {
    return new Error("run eval id and runId are required");
  }
  if (isZeroTime(v.CreatedAt)) {
    v.CreatedAt = new Date();
  }
  let payload;
  try {
    payload = Buffer.from(JSON.stringify(v), "utf8");
  } catch (err) {
    return err;
  }
  const err = upsert(this.DB, "run_evals", {
    id: v.ID, run_id: v.RunID, status: v.Status, score: v.Score, passed: v.Passed,
    model: v.Model, created_by: v.CreatedBy, payload: payload,
    created_at: timePtr(v.CreatedAt), finished_at: timePtr(v.FinishedAt),
  });
  if (err != null) {
    return err;
  }
  return this.trimRunEvals(v.RunID);
};

RunsRepo.prototype.RunEval = function (id) {
  const row = new runEvalRow();
  if (this.DB.Where("id = ?", id).Take(row).Error != null) {
    return [new RunEvalRecord(), false];
  }
  return runEvalFromRow(row);
};

RunsRepo.prototype.LatestRunEval = function (runID) {
  const row = new runEvalRow();
  if (this.DB.Where("run_id = ?", runID).Order("created_at DESC, id DESC").Limit(1).Take(row).Error != null) {
    return [new RunEvalRecord(), false];
  }
  return runEvalFromRow(row);
};

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

RunsRepo.prototype.ActiveRunEval = function (runID) {
  const row = new runEvalRow();
  if (this.DB.Where("run_id = ? AND status = ?", runID, RunEvalRunning).Order("created_at DESC").Limit(1).Take(row).Error != null) {
    return [new RunEvalRecord(), false];
  }
  return runEvalFromRow(row);
};

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
    return err;
  }
  if (ids.length === 0) {
    return null;
  }
  return this.DB.Where("id IN ?", ids).Delete(new runEvalRow()).Error;
};

function runEvalFromRow(row) {
  let rec = new RunEvalRecord();
  let parsed = null;
  try {
    parsed = JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8"));
    rec = new RunEvalRecord(parsed ?? {});
  } catch {
    rec = new RunEvalRecord({ ID: row.ID, RunID: row.RunID });
  }
  if (parsed != null && parsed.error != null) {
    rec.Error = parsed.error;
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
