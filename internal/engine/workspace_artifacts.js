// workspace_artifacts.js —— 对应 Go 文件：internal/engine/workspace_artifacts.go
// 作用：归档产物回填：从已保存产物中按路径取最新版，恢复缺失的工作区文件。
// context.Context 译为 AbortSignal；(值, error) 译为 [值, error]；Go 的 map[string]bool 译为 Map/Set；nil 切片译为 []。

"use strict";

const path = require("node:path");

const { RunnerWorkspaceRequest, RunnerWorkspaceOperationArtifacts, WorkspaceArtifactFile } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspaceRequest/RunnerWorkspaceOperationArtifacts/WorkspaceArtifactFile，runner_workspace.js 已翻译
const { WorkspaceContentSHA, RestoreMissingWorkspaceArtifacts } = require("../runtime/workspace_artifacts.js"); // 对应 Go 的 runtime.WorkspaceContentSHA/RestoreMissingWorkspaceArtifacts，runtime 待翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { runnerWorkspaceBusy } = require("./workspace_busy.js"); // 对应 Go 同包函数，workspace_busy.js 本次一同翻译

function archivedWorkspaceFiles(run, executingNode) {
  let excluded = new Map();
  if (executingNode !== "") {
    excluded = descendants(run.WorkflowSnapshot, executingNode);
    excluded.set(executingNode, true);
  }
  const syntheticResults = new Map();
  for (const n of run.WorkflowSnapshot.Nodes ?? []) {
    syntheticResults.set(n.ID, (n.ArtifactOutputs ?? []).length === 0);
  }
  const excludedPaths = new Set();
  for (const n of run.WorkflowSnapshot.Nodes ?? []) {
    if (!excluded.get(n.ID)) {
      continue;
    }
    for (const p of artifactOutputFiles(run, n)) {
      excludedPaths.add(p);
    }
  }
  const latest = new Map();
  for (const a of run.Artifacts ?? []) {
    if (a.Name === "repository-patch" || excluded.get(a.NodeID) || (syntheticResults.get(a.NodeID) && a.Name === "result" && a.Path === "result.md")) {
      continue;
    }
    if (executingNode !== "" && run.WorkflowSnapshot.CollaborationMode !== "group") {
      const n = run.Nodes[a.NodeID];
      if (n == null || n.Status !== "succeeded") {
        continue;
      }
    }
    const [rel, valid] = artifactRelPath(a.RepositoryDir, a.Path);
    if (!valid) {
      continue;
    }
    if (excludedPaths.has(rel)) {
      continue;
    }
    if (rel === "." || path.isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
      continue;
    }
    if (hasHiddenPathSegment(rel)) {
      continue;
    }
    const old = latest.get(rel);
    if (old === undefined || a.CreatedAt.getTime() > old.CreatedAt.getTime() || (a.CreatedAt.getTime() === old.CreatedAt.getTime() && (a.Attempt > old.Attempt || (a.Attempt === old.Attempt && a.ID > old.ID)))) {
      latest.set(rel, a);
    }
  }
  const paths = [...latest.keys()].sort();
  const files = [];
  for (const p of paths) {
    const a = latest.get(p);
    let sha = a.SHA256;
    if (sha === "") {
      sha = WorkspaceContentSHA(a.Content);
    } // 旧行没有存摘要
    files.push(new WorkspaceArtifactFile({ Path: p, Content: a.Content, SHA256: sha }));
  }
  return files;
}

function hasHiddenPathSegment(rel) {
  return rel.split("/").some((part) => part.startsWith("."));
}

Engine.prototype.restoreArchivedWorkspaceFiles = async function (ctx, run) {
  return this.restoreWorkspaceFiles(ctx, run, archivedWorkspaceFiles(run, ""));
};

Engine.prototype.restoreWorkspaceFiles = async function (ctx, run, files) {
  if (files.length === 0) {
    return [[], null];
  }
  if (this.defaultExecutionRunner(run) !== "" || this.foreignWorkspaceBind(run)) {
    const [result, err] = await this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({ RunID: run.ID, RunStatus: run.Status, RunKind: run.Kind, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationArtifacts, ArtifactFiles: files }));
    if (err != null) {
      return [null, err];
    }
    if (result.Error !== "") {
      // 终端或快照持有围栏时只补缺失文件，等下次使用，不让当次保存失败。
      if (runnerWorkspaceBusy(result)) {
        return [[], null];
      }
      return [null, new Error(`补回归档产物失败（执行机器需支持 restore_artifacts）：${result.Error}`)];
    }
    let report;
    try {
      report = JSON.parse(result.Payload.toString("utf8"));
    } catch (parseErr) {
      return [null, parseErr];
    }
    return [report.restoredArtifacts ?? [], null];
  }
  const [root, reason] = this.LocalRunWorkspace(run);
  if (reason !== "") {
    return [null, new Error(reason)];
  }
  return RestoreMissingWorkspaceArtifacts(root, files);
};

Engine.prototype.legacyArchivedWorkspaceFiles = function (run, nodeID) {
  const [meta, ok] = this.repo.WorkspaceCheckpoint(workspaceRunID(run));
  if (ok && meta.SavedAt != null) {
    return [];
  }
  return archivedWorkspaceFiles(run, nodeID);
};

module.exports = { archivedWorkspaceFiles, hasHiddenPathSegment };
