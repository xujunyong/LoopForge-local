// run_admission.js —— 对应 Go 文件：internal/repo/run_admission.go
// 作用：运行名额准入：按项目或执行机分桶限流、排队与按序放行。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { Run, RunKindWorkspace, RunEvent } = require("../domain/run.js"); // 对应 Go 的 domain.Run/RunKindWorkspace/RunEvent，run.js 已翻译
const { FreeCollaborationWorkflowID } = require("../domain/group_plan.js"); // 对应 Go 的 domain.FreeCollaborationWorkflowID，group_plan.js 已翻译
const { deps, RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runRow, runEventRow, runnerRow, issueRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { jsonBytes } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { runFromRow } = require("./runs.js"); // 对应 Go 同包函数，runs.js 待翻译

// ProjectRunLimit caps concurrently admitted top-level SOP runs per project on
// platform (cloud) execution. Personal machines are counted per machine
// against their optional user-configured Runner.RunLimit instead.
const ProjectRunLimit = 10;

// Slot accounting is partitioned into buckets: "project:<id>" for platform
// execution (the empty id is the shared bucket of unassigned runs) and
// "runner:<id>" for a personal machine. Each bucket has its own lock row, so
// different projects and machines never wait on each other.
//
// Lock rule: a transaction that takes a bucket lock takes it FIRST, before any
// run row lock, and holds at most one bucket. Only transactions that claim a
// slot (insert a running run, restart a succeeded/unstarted run, promote the
// queue) or change a machine limit take it. Writes that keep or release a
// slot never do: a release that races an admission decision can only make it
// over-count and queue a little longer, never exceed the limit, and the next
// promotion pass corrects it.
class runAdmissionLockRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
  }

  TableName() {
    return "run_admission_locks";
  }
}

// lockAdmissionGate locks one bucket. The row is runtime lock bookkeeping
// created on first use, not seed data.
function lockAdmissionGate(d, tx, key) {
  const row = new runAdmissionLockRow({ ID: key });
  const err = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
  if (err != null) {
    return err;
  }
  return d.locking(tx.Where("id = ?", row.ID)).Take(row).Error;
}

// admissionTxOptions makes plain reads inside a bucket-locked transaction see
// every commit up to the lock (MySQL defaults to REPEATABLE READ snapshots).
// sqlite serializes writers on its single test connection already.
deps.prototype.admissionTxOptions = function () {
  if (this.isMySQL()) {
    // Go 的 *sql.TxOptions 无 JS 对应类型，用同名隔离级别字段的普通对象代替。
    return [{ Isolation: "LevelReadCommitted" }];
  }
  return null;
};

// admissionLockRequired aborts a write attempt that turned out to claim a
// slot without holding its bucket lock; writeRun retries with the lock.
class admissionLockRequired extends Error {
  constructor(key) {
    super("admission lock required for " + key);
    this.key = key;
  }
}

function admissionBucketKey(project, runnerID, exempt) {
  if (exempt) {
    return "runner:" + runnerID.trim();
  }
  return "project:" + project.trim();
}

// runAdmissionBucketKey is the persisted bucket of a run whose project and
// exemption are already frozen on it.
function runAdmissionBucketKey(run) {
  return admissionBucketKey(run.ExecutionContext.ProjectID, run.ExecutionContext.ExecutionRunnerID, run.ConcurrencyExempt);
}

class runnerAdmissionInfo {
  constructor(init = {}) {
    this.personal = init.personal ?? false;
    this.limit = init.limit ?? 0;
  }
}

// admissionScope caches per-transaction lookups so legacy rows without
// persisted quota metadata do not issue one runner/issue query each.
class admissionScope {
  constructor(init = {}) {
    this.tx = init.tx ?? null;
    this.runners = init.runners ?? {};
    this.issues = init.issues ?? {};
  }

  runner(id) {
    id = id.trim();
    if (id === "") {
      return new runnerAdmissionInfo();
    }
    if (this.runners[id] != null) {
      return this.runners[id];
    }
    const row = new runnerRow();
    const info = new runnerAdmissionInfo();
    const err = this.tx.Select("id", "owner_user_id", "run_limit").Where("id = ?", id).Take(row).Error;
    if (err == null) {
      info.personal = row.OwnerUserID != null && row.OwnerUserID > 0;
      if (row.RunLimit != null && row.RunLimit > 0) {
        info.limit = row.RunLimit;
      }
    } else if (err !== gorm.ErrRecordNotFound) {
      throw err;
    }
    this.runners[id] = info;
    return info;
  }

  project(run) {
    const id = run.ExecutionContext.ProjectID.trim();
    if (id !== "") {
      return id;
    }
    const issueID = run.ExecutionContext.IssueID.trim();
    if (issueID === "") {
      return "";
    }
    if (this.issues[issueID] != null) {
      return this.issues[issueID];
    }
    const row = new issueRow();
    let project = "";
    const err = this.tx.Select("id", "project_id").Where("id = ?", issueID).Take(row).Error;
    if (err == null) {
      project = row.ProjectID;
    } else if (err !== gorm.ErrRecordNotFound) {
      throw err;
    }
    this.issues[issueID] = project;
    return project;
  }

  exempt(run) {
    const info = this.runner(run.ExecutionContext.ExecutionRunnerID);
    return info.personal;
  }

  // limit returns the bucket's slot count; 0 means unlimited.
  limit(key) {
    // Go 的 strings.CutPrefix 返回剥离后的串与是否匹配。
    if (key.startsWith("runner:")) {
      const info = this.runner(key.slice("runner:".length));
      return info.limit;
    }
    return ProjectRunLimit;
  }

  // rowBucketKey reads the persisted bucket, falling back to execution_context,
  // the linked issue, and current runner ownership for legacy rows that the
  // 010 backfill has not populated (written by the previous binary).
  rowBucketKey(row) {
    if (row.QuotaBucket != null && row.QuotaBucket !== "") {
      return row.QuotaBucket;
    }
    const run = runFromRow(row);
    let project = "";
    if (row.QuotaProjectID != null) {
      project = row.QuotaProjectID;
    } else {
      project = this.project(run);
    }
    let exempt = row.QuotaExempt != null && row.QuotaExempt;
    if (row.QuotaExempt == null) {
      exempt = this.exempt(run);
    }
    return admissionBucketKey(project, run.ExecutionContext.ExecutionRunnerID, exempt);
  }

  // occupied counts admitted top-level runs in one bucket through
  // idx_runs_quota_bucket. Rows with a NULL bucket are legacy rows not yet
  // backfilled; they are resolved in Go so they still count.
  //
  // Conversation workspaces and retired template-free groups do not execute SOPs
  // and never reserve SOP capacity. Nested SOPs share their top-level SOP slot.
  occupied(key, exclude) {
    const rows = [];
    let q = this.tx.Select("id", "kind", "workflow_id", "status", "quota_bucket", "quota_project_id", "quota_parent_run_id", "quota_exempt", "admission_state", "execution_context").
      Where("(quota_bucket = ? OR quota_bucket IS NULL) AND status NOT IN ? AND (admission_state IS NULL OR admission_state <> ?)",
        key, ["succeeded", "queued"], "unstarted");
    if (exclude !== "") {
      q = q.Where("id <> ?", exclude);
    }
    const err = q.Find(rows).Error;
    if (err != null) {
      throw err;
    }
    let n = 0;
    for (const row of rows) {
      let parent = "";
      if (row.QuotaParentRunID != null) {
        parent = row.QuotaParentRunID;
      } else {
        parent = runFromRow(row).ExecutionContext.ParentRunID;
      }
      if (parent.trim() !== "") {
        continue;
      }
      if (row.Kind === RunKindWorkspace || row.WorkflowID === FreeCollaborationWorkflowID) {
        continue;
      }
      const bucket = this.rowBucketKey(row);
      if (bucket === key) {
        n++;
      }
    }
    return n;
  }

  // hasQueued reports whether a run already waits in the bucket; a new request
  // must not overtake it. Queued rows always carry a persisted bucket.
  hasQueued(key, exclude) {
    const ids = [];
    const err = this.tx.Model(new runRow()).Where("quota_bucket = ? AND status = ? AND id <> ?", key, "queued", exclude).Limit(1).Pluck("id", ids).Error;
    if (err != null) {
      throw err;
    }
    return ids.length > 0;
  }
}

function newAdmissionScope(tx) {
  return new admissionScope({ tx: tx, runners: {}, issues: {} });
}

function queuedMessage(key) {
  if (key.startsWith("runner:")) {
    return "等待执行机器可用运行名额";
  }
  return "等待项目可用运行名额";
}

// prepareRunAdmission freezes the run's quota identity and decides whether a
// running write claims a slot. lockedKey is the bucket lock held by the
// caller's transaction ("" for none).
RunsRepo.prototype.prepareRunAdmission = function (tx, run, current, exists, lockedKey) {
  const s = newAdmissionScope(tx);
  if (exists) {
    const cur = runFromRow(current);
    run.AdmissionState = current.AdmissionState;
    if (current.QueueEntered != null) {
      run.QueueEnteredAt = current.QueueEntered;
    }
    run.ExecutionContext.ParentRunID = cur.ExecutionContext.ParentRunID;
    if (current.QuotaProjectID != null) {
      run.ExecutionContext.ProjectID = current.QuotaProjectID;
    } else {
      run.ExecutionContext.ProjectID = s.project(cur);
    }
    if (current.QuotaExempt != null) {
      run.ConcurrencyExempt = current.QuotaExempt;
    } else {
      run.ConcurrencyExempt = s.exempt(cur);
    }
    // A running write based on an earlier snapshot must not bypass a queue.
    if (current.Status === "queued" && run.Status === "running") {
      return new Error("run is queued");
    }
  } else {
    run.ExecutionContext.ProjectID = s.project(run);
    run.ConcurrencyExempt = s.exempt(run);
  }
  if (run.Status === "succeeded") {
    run.AdmissionState = "released";
    return null;
  }
  if (run.Status !== "running") {
    if (exists && current.Status === "queued") {
      if (run.Status !== "cancelled" && run.Status !== "queued") {
        return new Error("run is queued");
      }
      if (run.Status === "cancelled") {
        run.AdmissionState = "unstarted";
      }
    }
    return null;
  }
  if (exists && current.Status !== "succeeded" && current.AdmissionState !== "unstarted") {
    run.AdmissionState = "held";
    return this.checkParentAdmission(tx, run);
  }
  run.AdmissionState = "held";
  if (run.ExecutionContext.ParentRunID.trim() !== "") {
    return this.checkParentAdmission(tx, run);
  }
  const key = runAdmissionBucketKey(run);
  const limit = s.limit(key);
  if (limit <= 0) {
    return null;
  }
  if (key !== lockedKey) {
    return new admissionLockRequired(key);
  }
  const occupied = s.occupied(key, run.ID);
  const queued = s.hasQueued(key, run.ID);
  if (occupied >= limit || queued) {
    run.Status = "queued";
    run.AdmissionState = "queued";
    run.QueueEnteredAt = new Date();
    run.OwnerInstanceID = "";
    run.LeaseUntil = null;
    run.CancelRequested = false;
    run.PauseRequested = false;
    for (let i = 0; i < run.Events.length; i++) {
      if (run.Events[i].Type === "run.started" && !exists) {
        run.Events[i].Type = "run.queued";
        run.Events[i].Message = queuedMessage(key);
      }
    }
  }
  return null;
};

RunsRepo.prototype.checkParentAdmission = function (tx, run) {
  let parentID = run.ExecutionContext.ParentRunID.trim();
  const seen = { [run.ID]: true };
  while (parentID !== "") {
    if (seen[parentID]) {
      return new Error("cyclic parent run");
    }
    seen[parentID] = true;
    const parent = new runRow();
    const err = tx.Where("id = ?", parentID).Take(parent).Error;
    if (err != null) {
      return new Error(`parent run unavailable: ${err}`);
    }
    if (parent.Status === "succeeded" || parent.Status === "queued" || parent.AdmissionState === "unstarted") {
      return new Error("请从顶层 SOP 重新运行，父流程尚未获得运行名额");
    }
    parentID = runFromRow(parent).ExecutionContext.ParentRunID.trim();
  }
  return null;
};

// PromoteQueuedRuns admits queued runs FIFO within each bucket, one short
// transaction per bucket. A bucket whose limit was raised or cleared releases
// its queue on the next pass. A failing bucket does not block the others.
RunsRepo.prototype.PromoteQueuedRuns = function () {
  const raw = [];
  const err = this.DB.Model(new runRow()).Where("status = ?", "queued").Distinct("quota_bucket").Pluck("quota_bucket", raw).Error;
  if (err != null) {
    throw err;
  }
  const keys = [];
  for (const key of raw) {
    if (key != null && key !== "") {
      keys.push(key);
    }
  }
  keys.sort();
  const promoted = [];
  let firstErr = null;
  for (const key of keys) {
    try {
      const ids = this.promoteBucket(key);
      promoted.push(...ids);
    } catch (err) {
      if (firstErr == null) {
        firstErr = new Error(`promote ${key}: ${err}`);
      }
    }
  }
  if (firstErr != null) {
    throw firstErr;
  }
  return promoted;
};

RunsRepo.prototype.promoteBucket = function (key) {
  let promoted = [];
  const err = this.DB.Transaction((tx) => {
    promoted = [];
    // Go 的 r.deps 即嵌入的 deps，JS 里 RunsRepo 本身继承 deps，直接传 this。
    const gateErr = lockAdmissionGate(this, tx, key);
    if (gateErr != null) {
      return gateErr;
    }
    const s = newAdmissionScope(tx);
    const limit = s.limit(key);
    let occupied = 0;
    if (limit > 0) {
      occupied = s.occupied(key, "");
      if (occupied >= limit) {
        return null;
      }
    }
    const queued = [];
    const queuedErr = tx.Select("id", "queue_entered_at", "created_at").Where("quota_bucket = ? AND status = ?", key, "queued").
      Order("queue_entered_at, created_at, id").Find(queued).Error;
    if (queuedErr != null) {
      return queuedErr;
    }
    for (const row of queued) {
      if (limit > 0 && occupied >= limit) {
        break;
      }
      const now = new Date();
      // A concurrent cancel holds the run row; re-check the status here.
      const res = tx.Model(new runRow()).Where("id = ? AND status = ?", row.ID, "queued").Updates({
        status: "running", admission_state: "held", revision: new clause.Expr({ SQL: "revision + 1" }), updated_at: now,
        cancel_requested: false, pause_requested: false, owner_instance_id: "", lease_until: null,
      });
      if (res.Error != null) {
        return res.Error;
      }
      if (res.RowsAffected === 0) {
        continue;
      }
      const seqHolder = [0];
      const seqErr = tx.Model(new runEventRow()).Select("COALESCE(MAX(seq), -1) + 1").Where("run_id = ?", row.ID).Scan(seqHolder).Error;
      if (seqErr != null) {
        return seqErr;
      }
      const seq = seqHolder[0];
      const ev = new RunEvent({ ID: `adm-${BigInt(now.getTime()) * 1000000n}-${seq}`, RunID: row.ID, Type: "run.started", Message: "获得运行名额，开始执行", Timestamp: now });
      const createErr = tx.Create(new runEventRow({ RunID: row.ID, Seq: seq, EventID: ev.ID, Type: ev.Type, Message: ev.Message, Payload: jsonBytes(ev), Ts: now })).Error;
      if (createErr != null) {
        return createErr;
      }
      occupied++;
      promoted.push(row.ID);
    }
    return null;
  }, ...this.admissionTxOptions());
  if (err != null) {
    throw err;
  }
  return promoted;
};

// CancelQueuedRun settles a queued run as cancelled-before-start. It takes
// only the run row: promotion re-checks the status on that same row.
RunsRepo.prototype.CancelQueuedRun = function (id) {
  let cancelled = false;
  const err = this.DB.Transaction((tx) => {
    const row = this.takeRunForUpdate(tx, id);
    if (row.Status !== "queued") {
      return null;
    }
    cancelled = true;
    return tx.Model(new runRow()).Where("id = ?", id).Updates({ status: "cancelled", admission_state: "unstarted", revision: new clause.Expr({ SQL: "revision + 1" }), updated_at: new Date() }).Error;
  });
  if (err != null) {
    throw err;
  }
  return cancelled;
};

module.exports = { ProjectRunLimit, runAdmissionLockRow, lockAdmissionGate, admissionLockRequired, admissionBucketKey, runAdmissionBucketKey, runnerAdmissionInfo, admissionScope, newAdmissionScope, queuedMessage };
