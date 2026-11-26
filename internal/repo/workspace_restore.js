// workspace_restore.js —— 对应 Go 文件：internal/repo/workspace_restore.go
// 作用：工作区恢复：发起恢复租约与记录恢复结果。
// (值, error) 译为返回值、失败 throw；errors.Is 译为 ===。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { WorkspaceCheckpoint, ErrWorkspaceInUse } = require("./workspace_checkpoints.js"); // 对应 Go 同包类型与错误，workspace_checkpoints.js 本次一同翻译

// WorkspaceRestoreInterrupted is reported for a restore whose lease expired
// before it recorded an outcome, e.g. because its process exited.
const WorkspaceRestoreInterrupted = "工作区恢复已中断，请重新发起重跑";

// BeginWorkspaceRestore publishes the background operation and acquires its
// cross-instance lease in the same run-row transaction as other workspace uses.
// A workspace that is already bound needs no restore, unless the last restore
// failed or was interrupted after binding it; that one is retried so its
// outcome can become ready.
RunsRepo.prototype.BeginWorkspaceRestore = function (runID, now) {
  return this.beginWorkspaceLease(runID, now, true, true);
};

// FinishWorkspaceRestore releases only this restoration's lease. Restoring an
// immutable snapshot does not require saving the same checkout again.
RunsRepo.prototype.FinishWorkspaceRestore = function (runID, token, now, restoreError) {
  return this.DB.Transaction((tx) => {
    const run = this.takeRunForUpdate(tx, runID);
    if (restoreError === "" && run.WorkspaceCleaned != null) {
      restoreError = "工作区恢复尚未完成，请重试";
    }
    let status = "ready";
    if (restoreError !== "") {
      status = "failed";
    }
    const res = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ? AND restore_status = ?", runID, token, "restoring").Updates({
      restore_status: status, restore_error: restoreError,
      lease_token: "", lease_until: null, lease_handoff_id: "", last_used_at: now,
    });
    if (res.Error != null) {
      return res.Error;
    }
    if (res.RowsAffected !== 1) {
      return ErrWorkspaceInUse;
    }
    return null;
  });
};

module.exports = { WorkspaceRestoreInterrupted };
