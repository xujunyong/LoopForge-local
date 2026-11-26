/**
 * @file internal/repo/run_workspace_edit.js
 * 对应 Go 源文件：internal/repo/run_workspace_edit.go
 *
 * 作用与职责边界：
 * 为 `RunsRepo` 提供运行工作区人工与主助手编辑的事务保护及兼容入口，包括接管标记清理
 * （`AcquireWorkspaceEditor`）、IDE 人工编辑回调（`WithWorkspaceEditor`）、主助手工作区编辑回调
 * （`WithMainBotWorkspace`）与释放编辑标记（`ReleaseWorkspaceEditor`）。
 * 不负责具体磁盘文件读写或工作区快照持久化。
 *
 * 语法差异说明：
 * - `RunsRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `RunsRepo.prototype` 挂载相关方法。
 * - Go 的 `time.Duration` 常量 `15 * time.Minute` 译为毫秒数 `15 * 60 * 1000`。
 * - Go 的 `gorm.Expr("revision + 1")` 在 JS 中使用 `new clause.Expr({ SQL: "revision + 1" })` 表达。
 * - Go 的仅 `error` 返回函数及 `db.Transaction(tx => ...)` 回调统一按成功返回 `undefined`、失败 `throw err` 处理。
 */

"use strict";

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { runFromRow } = require("./runs.js"); // 对应 Go 同包函数，runs.js 已翻译

// 保留用于 API 兼容的工作区编辑租期常量（毫秒）；当前已不再采用排他编辑租约。
const WorkspaceEditTTL = 15 * 60 * 1000;

/**
 * 判断运行行对应的工作区是否处于已暂停或已终结且尚未清理磁盘目录的可安全写入状态。
 * 使用场景：供 `withWorkspaceWriter` 在主助手借用 SOP 工作区时校验是否已停止执行。
 *
 * @param {runRow} row - 数据库 `runs` 表行模型。
 * @returns {boolean} 工作区已暂停/终结且未被清理时返回 `true`，否则返回 `false`。
 */
function workspacePaused(row) {
  return ((row.Status === "waiting" && row.PauseRequested && !row.CancelRequested) || row.Status === "succeeded" || row.Status === "failed" || row.Status === "cancelled") && row.WorkspaceCleaned == null;
}

/**
 * 兼容旧版 `/workspace/takeover` 调用方的接管入口。
 * 当前不再授予排他编辑租约或暂停运行——只要运行处于 `HumanEditable` 状态，任意项目写权限成员均可编辑；
 * 本方法仅校验可编辑性并清理可能残留的历史编辑租约列，保持恢复路径干净。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {number} userID - 当前操作用户 ID（须大于 `0`）。
 * @returns {void} 无返回值。
 * @throws {Error} 用户未登录、运行不存在、工作区不可编辑或数据库更新失败时抛出错误。
 */
RunsRepo.prototype.AcquireWorkspaceEditor = function (runID, userID) {
  if (userID <= 0) {
    throw new Error("请先登录");
  }
  this.DB.Transaction((tx) => {
    const row = this.takeRunForUpdate(tx, runID);
    // 允许人工与运行中的智能体并行编辑，因此不阻断正在运行的节点。
    if (!runFromRow(row).HumanEditable()) {
      throw new Error("工作区已清理或正在取消，无法编辑");
    }
    // 清理可能遗留的旧版编辑租约字段，避免影响后续恢复路径。
    const err = tx.Model(new runRow()).Where("id = ?", runID).Updates({
      workspace_editor_id: 0, workspace_edit_until: null, revision: new clause.Expr({ SQL: "revision + 1" }),
    }).Error;
    if (err != null) {
      throw err;
    }
  });
};

/**
 * 在运行行锁保护下为 IDE 人工编辑执行回调 `fn`（要求运行处于 `HumanEditable` 状态）。
 * 智能体写入前会重读文件，保存时通过内容哈希防覆盖。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {number} userID - 当前操作用户 ID。
 * @param {function(import("../domain/run.js").Run): void} fn - 校验通过后执行的工作区写入回调；失败时应抛出错误。
 * @returns {void} 无返回值。
 * @throws {Error} 用户未登录、工作区不可编辑、数据库加锁失败或回调 `fn` 抛错时抛出错误。
 */
RunsRepo.prototype.WithWorkspaceEditor = function (runID, userID, fn) {
  this.withWorkspaceWriter(runID, userID, false, fn);
};

/**
 * 在运行行锁保护下为主助手执行工作区写入回调 `fn`。
 * 活跃对话工作区可直接编辑；借用的 SOP 工作区必须先暂停或终止后才允许编辑。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {number} userID - 触发操作的用户 ID。
 * @param {function(import("../domain/run.js").Run): void} fn - 校验通过后执行的工作区写入回调；失败时应抛出错误。
 * @returns {void} 无返回值。
 * @throws {Error} 用户未登录、SOP 尚未停止、数据库加锁失败或回调 `fn` 抛错时抛出错误。
 */
RunsRepo.prototype.WithMainBotWorkspace = function (runID, userID, fn) {
  this.withWorkspaceWriter(runID, userID, true, fn);
};

/**
 * 内部通用的工作区写锁事务封装：校验登录态、对运行行加排他锁、按调用来源校验可编辑条件后执行写入回调。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {number} userID - 当前操作用户 ID。
 * @param {boolean} mainBot - 是否为主助手调用（`true` 时要求暂停/终结或活跃对话工作区，`false` 时按 `HumanEditable` 放行）。
 * @param {function(import("../domain/run.js").Run): void} fn - 校验通过后执行的工作区写入回调；失败时应抛出错误。
 * @returns {void} 无返回值。
 * @throws {Error} 用户未登录、运行不存在、当前不允许编辑或回调 `fn` 抛错时抛出错误。
 */
RunsRepo.prototype.withWorkspaceWriter = function (runID, userID, mainBot, fn) {
  if (userID <= 0) {
    throw new Error("请先登录");
  }
  this.DB.Transaction((tx) => {
    const row = this.takeRunForUpdate(tx, runID);
    const run = runFromRow(row);
    let allowed = run.HumanEditable();
    if (mainBot) {
      allowed = workspacePaused(row) || run.LiveWorkspace();
    }
    if (!allowed) {
      throw new Error("请先停止 SOP 执行后再编辑工作区");
    }
    fn(run);
  });
};

/**
 * 在运行行锁事务中执行释放前的清理钩子，并在存在历史编辑租约列时将其清零并递增修订号。
 * 使用场景：工作区编辑会话结束或兼容旧版释放接口时调用。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {number} userID - 当前操作用户 ID（保留参数以兼容原签名）。
 * @param {...function(import("../domain/run.js").Run): void} beforeRelease - 释放前依次执行的钩子函数列表；任一钩子抛错将回滚事务。
 * @returns {void} 无返回值。
 * @throws {Error} 运行不存在、任一 `beforeRelease` 钩子抛错或数据库更新失败时抛出错误。
 */
RunsRepo.prototype.ReleaseWorkspaceEditor = function (runID, userID, ...beforeRelease) {
  this.DB.Transaction((tx) => {
    const row = this.takeRunForUpdate(tx, runID);
    for (const close of beforeRelease) {
      close(runFromRow(row));
    }
    // 仅当存在历史遗留的编辑租约列时才更新数据库并递增 revision。
    if (row.WorkspaceEditorID === 0 && row.WorkspaceEditUntil == null) {
      return;
    }
    const err = tx.Model(new runRow()).Where("id = ?", runID).Updates({
      workspace_editor_id: 0, workspace_edit_until: null, revision: new clause.Expr({ SQL: "revision + 1" }),
    }).Error;
    if (err != null) {
      throw err;
    }
  });
};

module.exports = { WorkspaceEditTTL, workspacePaused };
