// run_issue_latest.js —— 对应 Go 文件：internal/repo/run_issue_latest.go
// 作用：取某个需求最新的一条顶层 SOP 运行。

"use strict";

const { Run, RunKindWorkspace } = require("../domain/run.js"); // 对应 Go 的 domain.Run/RunKindWorkspace，run.js 已翻译
const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译

RunsRepo.prototype.LatestIssueSOPRun = function (issueID) {
  const expr = this.sqlExecutionContextJSONText("issueId");
  const ids = [];
  if (this.DB.Model(new runRow()).
    Where(expr + " = ? AND (kind IS NULL OR kind <> ?)", issueID, RunKindWorkspace).
    Order("created_at DESC, id DESC").Limit(20).Pluck("id", ids).Error != null) {
    return [new Run(), false];
  }
  for (const id of ids) {
    const [run, ok] = this.RunState(id);
    if (ok && run.ExecutionContext.IssueID === issueID && run.ExecutionContext.ParentRunID === "" && !run.IsWorkspace() && !run.HistoricalGroup()) {
      return [run, true];
    }
  }
  return [new Run(), false];
};

module.exports = {};
