/**
 * @file internal/repo/workspace_restore.js
 * 对应 Go 源文件：internal/repo/workspace_restore.go
 *
 * 作用与职责边界：
 * 实现运行工作区快照恢复流程的跨实例租约发起与恢复结果落库收尾；
 * 领域方法挂载于 `RunsRepo.prototype`（`RunsRepo` 定义于 `repo.js`），不负责快照解包与磁盘文件写入。
 *
 * 语法差异说明：
 * - Go 的 `(string, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；
 *   `db.Transaction(tx => ...)` 回调同样遵循失败抛错、成功正常返回。
 * - Go 的 `now.UTC()` 在 JS 中直接传递 `Date` 实例（JS `Date` 内部恒为 UTC 纪元毫秒）。
 */

"use strict";

const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { WorkspaceCheckpoint, ErrWorkspaceInUse } = require("./workspace_checkpoints.js"); // 对应 Go 同包类型与错误，workspace_checkpoints.js 已翻译

// 当工作区恢复租约在记录最终结果前过期（例如进程意外退出）时写入的恢复中断提示。
const WorkspaceRestoreInterrupted = "工作区恢复已中断，请重新发起重跑";

/**
 * 发起后台工作区快照恢复并在同一运行行锁事务中获取跨实例独占租约。
 * 若工作区当前已绑定且上次恢复既未失败也未中断，则无需恢复并直接返回空字符串 `""`。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {Date} now - 发起恢复的当前时刻。
 * @returns {string} 新签发的恢复租约令牌；若工作区已就绪无需恢复则返回空字符串 `""`。
 * @throws {Error} 工作区被其他租约占用（`ErrWorkspaceInUse`）或数据库事务失败时抛出错误。
 */
RunsRepo.prototype.BeginWorkspaceRestore = function (runID, now) {
  return this.beginWorkspaceLease(runID, now, true, true);
};

/**
 * 结束本次工作区快照恢复并释放恢复租约，同时写入最终的恢复状态（`"ready"` 或 `"failed"`）与错误信息；
 * 恢复的是不可变历史快照，因此收尾时无需重新归档保存工作区。
 * 若恢复流程未报错但运行记录仍处于已清理状态（尚未完成绑定），自动转为失败状态以提示重试。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} token - 当前持有的恢复租约令牌。
 * @param {Date} now - 恢复结束时刻，用于更新 `last_used_at`。
 * @param {string} restoreError - 恢复失败原因；恢复成功时传空字符串 `""`。
 * @returns {void} 无返回值。
 * @throws {Error} 租约已失效或状态不再为 `"restoring"`（`ErrWorkspaceInUse`）、或数据库事务失败时抛出错误。
 */
RunsRepo.prototype.FinishWorkspaceRestore = function (runID, token, now, restoreError) {
  this.DB.Transaction((tx) => {
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
      throw res.Error;
    }
    if (res.RowsAffected !== 1) {
      throw ErrWorkspaceInUse;
    }
  });
};

module.exports = { WorkspaceRestoreInterrupted };
