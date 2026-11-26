// run_knowledge.js —— 对应 Go 文件：internal/repo/run_knowledge.go
// 作用：取最新名为 knowledge.md 的运行产物（仅元数据）作知识候选。

"use strict";

const { KnowledgeCandidate, KnowledgeArtifactBasename } = require("../domain/knowledge.js"); // 对应 Go 的 domain.KnowledgeCandidate/KnowledgeArtifactBasename，knowledge.js 已翻译
const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runArtifactRow, runRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { runFromRow, artifactFromRow } = require("./runs.js"); // 对应 Go 同包函数，runs.js 待翻译

RunsRepo.prototype.KnowledgeArtifacts = function (projectID, limit) {
  const out = [];
  if (limit <= 0 || limit > 500) {
    limit = 100;
  }
  const base = KnowledgeArtifactBasename;
  const rows = [];
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
