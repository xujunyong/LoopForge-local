/**
 * @file internal/repo/run_issue_latest.js
 * 对应 Go 源文件：internal/repo/run_issue_latest.go
 *
 * 作用与职责边界：
 * 为 `RunsRepo` 提供按需求 ID 查询最新顶层 SOP 运行记录的方法 `LatestIssueSOPRun`，
 * 自动排除对话工作区、子运行与历史角色分组记录。
 * 不负责需求的读写、状态流转或运行列表的分页聚合。
 *
 * 语法差异说明：
 * - `RunsRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `RunsRepo.prototype` 挂载该方法。
 * - Go 的 `(domain.Run, bool)` 多返回值译为 `[Run, boolean]` 二元组。
 */

"use strict";

const { Run, RunKindWorkspace } = require("../domain/run.js"); // 对应 Go 的 domain.Run/RunKindWorkspace，run.js 已翻译
const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译

/**
 * 返回指定需求关联的最新一条顶层 SOP 运行记录；角色分组记录与对话工作区不属于 SOP 运行会被跳过。
 * 使用场景：需求详情页、自动续跑或工作区复用判断需要定位该需求最近一次顶层 SOP 执行时调用。
 *
 * @param {string} issueID - 目标需求主键 ID。
 * @returns {[Run, boolean]} 二元组 `[顶层 SOP 运行实例, 是否找到]`；未找到或查询出错时返回 `[new Run(), false]`。
 */
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
