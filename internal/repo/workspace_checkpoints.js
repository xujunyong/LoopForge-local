// workspace_checkpoints.js —— 对应 Go 文件：internal/repo/workspace_checkpoints.go
// 作用：工作区快照与租约：保存、恢复绑定、使用租约、跟进标记与回收清理。
// (值, error) 译为返回值、失败 throw，(值, bool) 译为 [值, bool]；errors.Is 译为 ===；time.Duration 换算为毫秒。
// Go 的 io 没有同步的 JS 对应写法：io.ReadAll 调用按原文保留作对照，见 workspace_checkpoint_chunks.js。

"use strict";

const { randomBytes, createHash } = require("node:crypto");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runRow, runNodeRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { assistantHeartbeatTimeout } = require("./assistant_generations.js"); // 对应 Go 同包常量，assistant_generations.js 已翻译
const { workspaceCheckpointChunk, workspaceCheckpointInlineBytes } = require("./workspace_checkpoint_chunks.js"); // 对应 Go 同包类型与常量，workspace_checkpoint_chunks.js 本次一同翻译
const { WorkspaceRestoreInterrupted } = require("./workspace_restore.js"); // 对应 Go 同包常量，workspace_restore.js 本次一同翻译

class WorkspaceCheckpoint {
  constructor(init = {}) {
    this.ArchiveID = init.ArchiveID ?? "";
    this.ArchiveBytes = init.ArchiveBytes ?? 0;
    this.ArchiveChunks = init.ArchiveChunks ?? 0;
    this.SaveFailures = init.SaveFailures ?? 0;
    this.SaveRetryAt = init.SaveRetryAt ?? null;
    this.RunID = init.RunID ?? "";
    this.Archive = init.Archive ?? null;
    this.SHA256 = init.SHA256 ?? "";
    this.LastUsedAt = init.LastUsedAt ?? null;
    this.SavedAt = init.SavedAt ?? null;
    this.FollowUp = init.FollowUp ?? false;
    this.Error = init.Error ?? "";
    this.LeaseHandoffID = init.LeaseHandoffID ?? "";
    this.LeaseToken = init.LeaseToken ?? "";
    this.LeaseUntil = init.LeaseUntil ?? null;
    // LeaseRenewedAt is when the lease was last taken or renewed, on the
    // database clock on MySQL (see leaseRenewalClock). LeaseUntil is written
    // by the holder's own clock, so it cannot tell another replica how long
    // ago the holder renewed.
    this.LeaseRenewedAt = init.LeaseRenewedAt ?? null;
    this.RestoreStatus = init.RestoreStatus ?? "";
    this.RestoreStarted = init.RestoreStarted ?? null;
    this.RestoreError = init.RestoreError ?? "";
    // ReleasedAt is when a conversation switched away from the workspace; until
    // it is used again it is reclaimed without waiting out the idle hour.
    this.ReleasedAt = init.ReleasedAt ?? null;
  }

  TableName() {
    return "run_workspace_checkpoints";
  }

  // Released reports whether the workspace was released after its last use.
  Released() {
    return this.ReleasedAt != null && !(this.LastUsedAt.getTime() > this.ReleasedAt.getTime());
  }
}

const ErrWorkspaceInUse = new Error("工作区正在使用或保存，请稍后重试");
const ErrWorkspaceCheckpointBackoff = new Error("workspace checkpoint save is backing off");

const workspaceBackgroundSavePrefix = "save:";

// workspaceUseTerm is how long a workspace lease lasts from its last renewal.
const workspaceUseTerm = 15 * 60 * 1000;

RunsRepo.prototype.WorkspaceCheckpoint = function (runID) {
  const item = new WorkspaceCheckpoint();
  const err = this.DB.Omit("archive").Where("run_id = ?", runID).Take(item).Error;
  return [item, err == null];
};

RunsRepo.prototype.WorkspaceCheckpointArchive = function (runID) {
  const source = this.OpenWorkspaceCheckpointArchive(runID);
  try {
    const [data, err] = io.ReadAll(source);
    if (err != null) {
      throw err;
    }
    return data;
  } finally {
    source.Close();
  }
};

RunsRepo.prototype.BeginWorkspaceUse = function (runID, now) {
  const [token] = this.BeginWorkspaceUsePreemptingSave(runID, now);
  return token;
};

// Foreground use can replace a background archive lease. Execution, restore
// and maintenance/delete leases remain exclusive. The old save must still
// publish and finish by token CAS, so it cannot affect the new use.
RunsRepo.prototype.BeginWorkspaceUsePreemptingSave = function (runID, now) {
  // Go 用 *string 接出参，JS 用 { value } 对象接出参。
  const previous = { value: "" };
  const token = this.beginWorkspaceLease(runID, now, true, false, previous);
  return [token, previous.value];
};

// HandoffWorkspaceUseToSave makes the archive interruptible without an unlocked
// gap. SaveRetryAt also lets maintenance recover a crashed background save.
RunsRepo.prototype.HandoffWorkspaceUseToSave = function (runID, token, now) {
  if (token === "" || token.startsWith(workspaceBackgroundSavePrefix)) {
    throw ErrWorkspaceInUse;
  }
  const saveToken = workspaceBackgroundSavePrefix + token;
  const err = this.DB.Transaction((tx) => {
    this.takeRunForUpdate(tx, runID);
    const result = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, now).Updates({
      lease_token: saveToken, lease_handoff_id: "", last_used_at: now, save_retry_at: now,
    });
    if (result.Error != null) {
      return result.Error;
    }
    if (result.RowsAffected !== 1) {
      return ErrWorkspaceInUse;
    }
    return null;
  });
  if (err != null) {
    throw err;
  }
  return saveToken;
};

RunsRepo.prototype.BeginWorkspaceCheckpointSave = function (runID, now) {
  return this.beginWorkspaceLease(runID, now, false, false);
};

RunsRepo.prototype.beginWorkspaceLease = function (runID, now, touch, restoring, ...preempted) {
  const raw = randomBytes(24);
  let token = raw.toString("hex");
  const err = this.DB.Transaction((tx) => {
    const run = this.takeRunForUpdate(tx, runID);
    const checkpoint = new WorkspaceCheckpoint();
    const takeErr = tx.Omit("archive").Where("run_id = ?", runID).Take(checkpoint).Error;
    if (takeErr != null && takeErr !== gorm.ErrRecordNotFound) {
      return takeErr;
    }
    // An unfinished outcome on a bound workspace is retried, never assumed.
    const unfinished = checkpoint.RestoreStatus === "failed" || checkpoint.RestoreStatus === "restoring";
    if (restoring && run.WorkspaceCleaned == null && !unfinished) {
      token = "";
      return null;
    }
    if (!touch && checkpoint.SaveRetryAt != null && now.getTime() < checkpoint.SaveRetryAt.getTime()) {
      return ErrWorkspaceCheckpointBackoff;
    }
    const until = new Date(now.getTime() + workspaceUseTerm);
    let lastUsed = now;
    if (!touch && run.Updated != null) {
      lastUsed = run.Updated;
    }
    const row = new WorkspaceCheckpoint({ RunID: runID, LastUsedAt: lastUsed });
    const createErr = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
    if (createErr != null) {
      return createErr;
    }
    const values = { lease_token: token, lease_until: until, lease_renewed_at: this.leaseRenewalClock(now), lease_handoff_id: "" };
    if (touch) {
      values["last_used_at"] = now;
    }
    if (restoring) {
      values["restore_status"] = "restoring";
      values["restore_started"] = now;
      values["restore_error"] = "";
    } else if (checkpoint.RestoreStatus === "restoring") {
      // Taking over an expired restore lease fences that restore out, so
      // record it as interrupted. A later binding under this lease can
      // then tell a stale outcome from a restore still in progress.
      values["restore_status"] = "failed";
      values["restore_error"] = WorkspaceRestoreInterrupted;
    }
    let query = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ?", runID);
    if (touch && !restoring) {
      const current = new WorkspaceCheckpoint();
      const currentErr = tx.Omit("archive").Where("run_id = ?", runID).Take(current).Error;
      if (currentErr != null) {
        return currentErr;
      }
      if (current.LeaseToken.startsWith(workspaceBackgroundSavePrefix) && preempted.length > 0) {
        preempted[0].value = current.LeaseToken;
      }
      query = query.Where("lease_until IS NULL OR lease_until < ? OR lease_token LIKE ?", now, workspaceBackgroundSavePrefix + "%");
    } else {
      query = query.Where("lease_until IS NULL OR lease_until < ?", now);
    }
    const result = query.Updates(values);
    if (result.Error != null) {
      return result.Error;
    }
    if (result.RowsAffected !== 1) {
      return ErrWorkspaceInUse;
    }
    return null;
  });
  if (err != null) {
    throw err;
  }
  return token;
};

RunsRepo.prototype.RenewWorkspaceUse = function (runID, token, now) {
  return this.DB.Transaction((tx) => {
    this.takeRunForUpdate(tx, runID);
    const checkpoint = new WorkspaceCheckpoint();
    const takeErr = tx.Omit("archive").Where("run_id = ? AND lease_token = ?", runID, token).Take(checkpoint).Error;
    if (takeErr != null) {
      if (takeErr === gorm.ErrRecordNotFound) {
        return ErrWorkspaceInUse;
      }
      return takeErr;
    }
    // The row is locked through the run and was just read with this token;
    // an unchanged lease_until (same-millisecond renewal) is still a renewal.
    const until = new Date(now.getTime() + workspaceUseTerm);
    return tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ?", runID, token).Updates({ lease_until: until, lease_renewed_at: this.leaseRenewalClock(now) }).Error;
  });
};

RunsRepo.prototype.FinishWorkspaceUse = function (runID, token, now, archive, saveError) {
  let attemptedAt = new Date();
  if (now.getTime() > attemptedAt.getTime()) {
    attemptedAt = now;
  }
  return this.finishWorkspaceUse(runID, token, now, attemptedAt, archive, saveError);
};

RunsRepo.prototype.FinishWorkspaceCheckpointSave = function (runID, token, idleSince, attemptedAt, saveError) {
  return this.finishWorkspaceUse(runID, token, idleSince, attemptedAt, null, saveError);
};

RunsRepo.prototype.finishWorkspaceUse = function (runID, token, now, attemptedAt, archive, saveError) {
  return this.DB.Transaction((tx) => {
    this.takeRunForUpdate(tx, runID);
    const item = new WorkspaceCheckpoint();
    const takeErr = tx.Omit("archive").Where("run_id = ? AND lease_token = ?", runID, token).Take(item).Error;
    if (takeErr != null) {
      if (takeErr === gorm.ErrRecordNotFound) {
        return ErrWorkspaceInUse;
      }
      return takeErr;
    }
    if (item.LastUsedAt.getTime() > now.getTime()) {
      now = item.LastUsedAt;
    }
    const values = { lease_token: "", lease_until: null, lease_handoff_id: "", last_used_at: now };
    if (archive != null) {
      const sum = createHash("sha256").update(archive).digest();
      values["archive"] = archive;
      values["archive_id"] = "";
      values["archive_bytes"] = archive.length;
      values["archive_chunks"] = 0;
      values["sha256"] = sum.toString("hex");
      values["saved_at"] = now;
      values["error"] = "";
      values["save_failures"] = 0;
      values["save_retry_at"] = null;
    } else if (saveError !== "") {
      const failures = Math.min(item.SaveFailures + 1, 12);
      const delay = Math.min(5 * 60 * 1000 * (1 << (failures - 1)), 6 * 60 * 60 * 1000);
      const next = new Date(attemptedAt.getTime() + delay);
      values["error"] = saveError;
      values["save_failures"] = failures;
      values["save_retry_at"] = next;
    }
    const result = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ?", runID, token).Updates(values);
    if (result.Error != null) {
      return result.Error;
    }
    if (result.RowsAffected !== 1) {
      return ErrWorkspaceInUse;
    }
    if (archive != null) {
      return tx.Where("run_id = ?", runID).Delete(new workspaceCheckpointChunk()).Error;
    }
    return null;
  });
};

RunsRepo.prototype.ClaimCheckpointWorkspaceCleanup = function (runID, token, revision, now) {
  let claimed = false;
  const err = this.DB.Transaction((tx) => {
    const row = this.takeRunForUpdate(tx, runID);
    if (row.Revision !== revision || row.Status === "running" || row.Status === "queued" || row.WorkspaceCleaned != null || row.CleanupNotBefore != null && now.getTime() < row.CleanupNotBefore.getTime()) {
      return null;
    }
    const checkpoint = new WorkspaceCheckpoint();
    const takeErr = tx.Omit("archive").Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, now).Take(checkpoint).Error;
    if (takeErr != null) {
      return takeErr;
    }
    if (checkpoint.SavedAt == null || checkpoint.SHA256 === "" || checkpoint.Error !== "") {
      return new Error("工作区未成功保存，暂缓回收");
    }
    if (checkpoint.FollowUp && !checkpoint.Released() && now.getTime() < checkpoint.LastUsedAt.getTime() + 60 * 60 * 1000) {
      return null;
    }
    // Go 的 Count(&n) 用对象接出参。
    const count = { value: 0 };
    const countErr = tx.Model(new runNodeRow()).Where("run_id = ? AND status = ?", runID, "running").Count(count).Error;
    if (countErr != null) {
      return countErr;
    }
    if (count.value !== 0) {
      return null;
    }
    const result = tx.Model(new runRow()).Where("id = ? AND revision = ?", runID, revision).Updates({ workspace_cleaned_at: now, sandbox_id: "" });
    claimed = result.RowsAffected === 1;
    return result.Error;
  });
  if (err != null) {
    throw err;
  }
  return claimed;
};

RunsRepo.prototype.RestoreCheckpointWorkspaceBinding = function (runID, token, host, root, now) {
  return this.DB.Transaction((tx) => {
    this.takeRunForUpdate(tx, runID);
    // Go 的 Count(&n) 用对象接出参。
    const count = { value: 0 };
    const countErr = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, now).Count(count).Error;
    if (countErr != null) {
      return countErr;
    }
    if (count.value !== 1) {
      return ErrWorkspaceInUse;
    }
    // A restore lease keeps "restoring" until FinishWorkspaceRestore records
    // its outcome. Any other lease that binds the workspace supersedes an
    // earlier failed or interrupted restore.
    const failedErr = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ? AND restore_status = ?", runID, token, "failed").
      Updates({ restore_status: "ready", restore_error: "" }).Error;
    if (failedErr != null) {
      return failedErr;
    }
    const values = { workspace_cleaned_at: null, revision: gorm.Expr("revision + 1") };
    if (host !== "") {
      values["workspace_host"] = host;
      values["workspace_root"] = root;
    }
    return tx.Model(new runRow()).Where("id = ?", runID).Updates(values).Error;
  });
};

RunsRepo.prototype.CheckpointWorkspaceRunIDs = function () {
  const ids = [];
  this.DB.Model(new WorkspaceCheckpoint()).Pluck("run_id", ids);
  return ids;
};

RunsRepo.prototype.SaveWorkspaceCheckpoint = function (runID, token, now, archive) {
  const archiveLen = (archive ?? []).length;
  if (archiveLen === 0 || archiveLen > workspaceCheckpointInlineBytes) {
    return new Error("invalid inline workspace checkpoint size");
  }
  const sum = createHash("sha256").update(archive).digest();
  return this.DB.Transaction((tx) => {
    this.takeRunForUpdate(tx, runID);
    const result = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, new Date()).Updates({ archive: archive, archive_id: "", archive_bytes: archive.length, archive_chunks: 0, sha256: sum.toString("hex"), saved_at: now, error: "", save_failures: 0, save_retry_at: null });
    if (result.Error != null) {
      return result.Error;
    }
    if (result.RowsAffected !== 1) {
      return ErrWorkspaceInUse;
    }
    return tx.Where("run_id = ?", runID).Delete(new workspaceCheckpointChunk()).Error;
  });
};

// MarkWorkspaceFollowUp validates the lease by a read, never by RowsAffected:
// MySQL reports changed rows, so two tools of one turn touching the workspace
// within the same millisecond (DATETIME(3)) would otherwise look like a lost
// lease and fail one of them with ErrWorkspaceInUse.
RunsRepo.prototype.MarkWorkspaceFollowUp = function (runID, token, now) {
  return this.DB.Transaction((tx) => {
    const err = holdsWorkspaceLease(tx, runID, token);
    if (err != null) {
      return err;
    }
    return tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ?", runID, token).Updates({ follow_up: true, last_used_at: now }).Error;
  });
};

function holdsWorkspaceLease(tx, runID, token) {
  if (token === "") {
    return ErrWorkspaceInUse;
  }
  // Go 的 Count(&n) 用对象接出参。
  const count = { value: 0 };
  const err = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ?", runID, token).Count(count).Error;
  if (err != null) {
    return err;
  }
  if (count.value !== 1) {
    return ErrWorkspaceInUse;
  }
  return null;
}

// ReleaseAbandonedWorkspaceUse drops the foreground lease a reaped turn held.
// A dead API process cannot finish the lease it held in memory, and the next
// turn would fail for the rest of the 15 minute term.
//
// Two fences keep a live owner's lease in place. The token must be the one the
// reaped turn recorded, so a lease another turn took after the reap never
// matches. Its last renewal must also be older than the heartbeat timeout:
// every holder renews well within it (generations every 500ms, workspace turns
// every 30s), so a lease still being renewed by a process on any replica is
// kept. A background save token never matches a foreground token.
//
// The renewal age is measured on the clock that stamped lease_renewed_at (the
// database's on MySQL), so a holder whose clock runs behind the reader's does
// not look silent. A lease taken before that column existed has no stamp and
// falls back to its lease_until.
RunsRepo.prototype.ReleaseAbandonedWorkspaceUse = function (runID, token, now) {
  runID = runID.trim();
  token = token.trim();
  if (runID === "" || token === "" || token.startsWith(workspaceBackgroundSavePrefix)) {
    return false;
  }
  let released = false;
  const err = this.DB.Transaction((tx) => {
    try {
      this.takeRunForUpdate(tx, runID);
    } catch (e) {
      if (e === gorm.ErrRecordNotFound) {
        return null;
      }
      return e;
    }
    let silent = tx.Where("lease_renewed_at IS NULL AND lease_until <= ?", new Date(now.getTime() + workspaceUseTerm - assistantHeartbeatTimeout));
    if (this.isMySQL()) {
      silent = silent.Or("lease_renewed_at <= UTC_TIMESTAMP(3) - INTERVAL ? MICROSECOND", assistantHeartbeatTimeout * 1000);
    } else {
      silent = silent.Or("lease_renewed_at <= ?", new Date(now.getTime() - assistantHeartbeatTimeout));
    }
    const result = tx.Model(new WorkspaceCheckpoint()).
      Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, now).
      Where(silent).
      Updates({ lease_token: "", lease_until: null, lease_handoff_id: "" });
    released = result.RowsAffected === 1;
    return result.Error;
  });
  if (err != null) {
    throw err;
  }
  return released;
};

// leaseRenewalClock stamps lease_renewed_at: the database's commit-time clock
// on MySQL, shared by every replica, and the caller's clock elsewhere.
RunsRepo.prototype.leaseRenewalClock = function (now) {
  if (this.isMySQL()) {
    return new clause.Expr({ SQL: "UTC_TIMESTAMP(3)" });
  }
  return now;
};

// ReleaseWorkspace marks a workspace no conversation is bound to any more, so
// the idle sweep saves and reclaims it on its next pass.
RunsRepo.prototype.ReleaseWorkspace = function (runID, now) {
  return this.DB.Transaction((tx) => {
    const row = new WorkspaceCheckpoint({ RunID: runID, LastUsedAt: now });
    const createErr = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
    if (createErr != null) {
      return createErr;
    }
    return tx.Model(new WorkspaceCheckpoint()).Where("run_id = ?", runID).Update("released_at", now).Error;
  });
};

RunsRepo.prototype.TouchWorkspaceUse = function (runID, now) {
  return this.DB.Transaction((tx) => {
    const run = this.takeRunForUpdate(tx, runID);
    if (run.WorkspaceCleaned != null) {
      return ErrWorkspaceInUse;
    }
    const item = new WorkspaceCheckpoint({ RunID: runID, LastUsedAt: now, FollowUp: true });
    const createErr = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(item).Error;
    if (createErr != null) {
      return createErr;
    }
    return tx.Model(new WorkspaceCheckpoint()).Where("run_id = ?", runID).Updates({ last_used_at: now, follow_up: true }).Error;
  });
};

// Explicit deletion uses the same lease and marks the directory unavailable
// before filesystem removal, preventing retry from reusing it during deletion.
RunsRepo.prototype.ClaimWorkspaceDeletion = function (runID, token, revision, now) {
  return this.DB.Transaction((tx) => {
    const row = this.takeRunForUpdate(tx, runID);
    if (row.Revision !== revision || row.Status === "running" || row.Status === "waiting" || row.Status === "queued") {
      return ErrWorkspaceInUse;
    }
    // Go 的 Count(&n) 用对象接出参。
    const count = { value: 0 };
    const countErr = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, now).Count(count).Error;
    if (countErr != null) {
      return countErr;
    }
    if (count.value !== 1) {
      return ErrWorkspaceInUse;
    }
    return tx.Model(new runRow()).Where("id = ?", runID).Update("workspace_cleaned_at", now).Error;
  });
};

module.exports = { WorkspaceCheckpoint, ErrWorkspaceInUse, ErrWorkspaceCheckpointBackoff, workspaceBackgroundSavePrefix, workspaceUseTerm, holdsWorkspaceLease };
