// run_workspace_edit.js —— 对应 Go 文件：internal/repo/run_workspace_edit.go
// 作用：工作区编辑的兼容入口：接管标记、编辑回调与释放。

"use strict";

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause
// Go 的 gorm.Expr 在 JS 里用 clause.Expr。

const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { runFromRow } = require("./runs.js"); // 对应 Go 同包函数，runs.js 待翻译

const WorkspaceEditTTL = 15 * 60 * 1000; // Go 的 15*time.Minute，JS 里以毫秒计。

function workspacePaused(row) {
  return ((row.Status === "waiting" && row.PauseRequested && !row.CancelRequested) || row.Status === "succeeded" || row.Status === "failed" || row.Status === "cancelled") && row.WorkspaceCleaned == null;
}

RunsRepo.prototype.AcquireWorkspaceEditor = function (runID, userID) {
  if (userID <= 0) {
    return new Error("请先登录");
  }
  return this.DB.Transaction((tx) => {
    const row = this.takeRunForUpdate(tx, runID);
    if (!runFromRow(row).HumanEditable()) {
      return new Error("工作区已清理或正在取消，无法编辑");
    }
    return tx.Model(new runRow()).Where("id = ?", runID).Updates({
      workspace_editor_id: 0, workspace_edit_until: null, revision: new clause.Expr({ SQL: "revision + 1" }),
    }).Error;
  });
};

RunsRepo.prototype.WithWorkspaceEditor = function (runID, userID, fn) {
  return this.withWorkspaceWriter(runID, userID, false, fn);
};

RunsRepo.prototype.WithMainBotWorkspace = function (runID, userID, fn) {
  return this.withWorkspaceWriter(runID, userID, true, fn);
};

RunsRepo.prototype.withWorkspaceWriter = function (runID, userID, mainBot, fn) {
  if (userID <= 0) {
    return new Error("请先登录");
  }
  return this.DB.Transaction((tx) => {
    const row = this.takeRunForUpdate(tx, runID);
    const run = runFromRow(row);
    let allowed = run.HumanEditable();
    if (mainBot) {
      allowed = workspacePaused(row) || run.LiveWorkspace();
    }
    if (!allowed) {
      return new Error("请先停止 SOP 执行后再编辑工作区");
    }
    return fn(run);
  });
};

RunsRepo.prototype.ReleaseWorkspaceEditor = function (runID, userID, ...beforeRelease) {
  return this.DB.Transaction((tx) => {
    const row = this.takeRunForUpdate(tx, runID);
    for (const close of beforeRelease) {
      const err = close(runFromRow(row));
      if (err != null) {
        return err;
      }
    }
    if (row.WorkspaceEditorID === 0 && row.WorkspaceEditUntil == null) {
      return null;
    }
    return tx.Model(new runRow()).Where("id = ?", runID).Updates({
      workspace_editor_id: 0, workspace_edit_until: null, revision: new clause.Expr({ SQL: "revision + 1" }),
    }).Error;
  });
};

module.exports = { WorkspaceEditTTL, workspacePaused };
