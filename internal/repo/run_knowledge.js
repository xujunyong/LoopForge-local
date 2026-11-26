/**
 * @file internal/repo/run_knowledge.js
 * 对应 Go 源文件：internal/repo/run_knowledge.go
 *
 * 作用与职责边界：
 * 为 `RunsRepo` 提供知识候选产物查询方法 `KnowledgeArtifacts`，用于从 `run_artifacts` 与 `runs` 表中
 * 检索最新命名为 `knowledge.md` 的产物元数据及其所属运行的项目、需求与工作流上下文，
 * 并自动过滤个人对话工作区以及按 `run/node/path` 去重仅保留最新一次尝试。
 * 不负责读取产物正文内容或沉淀入知识库条目。
 *
 * 语法差异说明：
 * - `RunsRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `RunsRepo.prototype` 挂载该方法。
 * - Go 的 `map[string]bool` 与 `map[string]domain.Run` 统一译为普通对象 `{}`。
 */

"use strict";

const { KnowledgeCandidate, KnowledgeArtifactBasename } = require("../domain/knowledge.js"); // 对应 Go 的 domain.KnowledgeCandidate/KnowledgeArtifactBasename，knowledge.js 已翻译
const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runFromRow, artifactFromRow } = require("./runs.js"); // 对应 Go 同包函数，runs.js 已翻译

/**
 * 返回最新的一批名为 `knowledge.md` 的运行产物元数据及其所属运行的项目、需求、工作流和状态。
 * 当 `projectID` 为空字符串时跨所有项目检索；重试产生的同路径产物仅保留最新一次尝试。
 * 使用场景：知识库候选沉淀列表展示，用于挑选待导入的运行总结文档。
 *
 * @param {string} projectID - 可选项目过滤 ID；为空字符串时不限制项目。
 * @param {number} limit - 返回条数上限；小于等于 `0` 或大于 `500` 时默认重置为 `100`。
 * @returns {KnowledgeCandidate[]} 知识候选对象数组（不含产物正文内容）；查询出错或无匹配时返回空数组 `[]`。
 */
RunsRepo.prototype.KnowledgeArtifacts = function (projectID, limit) {
  const out = [];
  if (limit <= 0 || limit > 500) {
    limit = 100;
  }
  const base = KnowledgeArtifactBasename;
  const rows = [];
  // 按项目过滤时会丢弃其他项目的产物，先放大拉取量以尽量填满当前页。
  let fetch = limit;
  if (projectID.trim() !== "") {
    fetch = limit * 4;
  }
  if (this.DB.Select("id", "run_id", "node_id", "attempt", "name", "path", "media_type", "size_bytes", "sha256", "repository_dir", "created_at").
    Where("name = ? OR path = ? OR path LIKE ?", base, base, "%/" + base).
    Order("created_at DESC").Limit(fetch).Find(rows).Error != null || rows.length === 0) {
    return out;
  }
  const runIDs = [];
  const seen = {};
  for (const row of rows) {
    if (!seen[row.RunID]) {
      seen[row.RunID] = true;
      runIDs.push(row.RunID);
    }
  }
  const runs = [];
  if (this.DB.Select("id", "kind", "workflow_id", "status", "execution_context").Where("id IN ?", runIDs).Find(runs).Error != null) {
    return out;
  }
  const meta = {};
  for (const row of runs) {
    const run = runFromRow(row);
    if (!run.IsPersonalWorkspace()) {
      meta[run.ID] = run;
    }
  }
  // 节点重试会在每次尝试都输出一份产物；同一 run/node/path 仅保留最新一份作为候选。
  const latest = {};
  for (const row of rows) {
    const m = meta[row.RunID];
    if (m == null) {
      continue;
    }
    if (projectID !== "" && m.ExecutionContext.ProjectID !== projectID) {
      continue;
    }
    const key = row.RunID + "\x00" + row.NodeID + "\x00" + row.Path;
    if (latest[key]) {
      continue;
    }
    latest[key] = true;
    out.push(new KnowledgeCandidate({
      Artifact: artifactFromRow(row, false),
      ProjectID: m.ExecutionContext.ProjectID, IssueID: m.ExecutionContext.IssueID,
      WorkflowID: m.WorkflowID, RunStatus: m.Status,
    }));
    if (out.length >= limit) {
      break;
    }
  }
  return out;
};

module.exports = {};
