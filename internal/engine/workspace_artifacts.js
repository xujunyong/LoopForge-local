/**
 * 对应 Go 源文件：internal/engine/workspace_artifacts.go
 *
 * 文件作用与职责边界：
 * 负责归档产物的筛选与工作区缺失文件回填：
 * 从运行已归档的产物记录中按物理路径挑选最新版本（排除当前及下游节点产出、隐藏路径与补丁清单），
 * 并在本地或远程 Runner 工作区中补回缺失的归档产物文件，以兼容尚未保存检查点的旧工作区。
 *
 * Go 与 JS 语法差异说明：
 * - Go 的 `context.Context` 译为 `AbortSignal`。
 * - Go 的 `(值, error)` 译为成功返回值、失败 `throw`。
 * - Go 的 `map[string]bool` 与 `map[string]domain.Artifact` 统一译为普通对象 `{}`。
 * - Go 的 `path/filepath` 译为 Node 内置模块 `node:path`；`nil` 切片译为空数组 `[]`。
 */

"use strict";

const path = require("node:path"); // Go path/filepath
const { RunnerWorkspaceRequest, RunnerWorkspaceOperationArtifacts, WorkspaceArtifactFile } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspaceRequest/RunnerWorkspaceOperationArtifacts/WorkspaceArtifactFile，runner_workspace.js 已翻译
const { WorkspaceContentSHA, RestoreMissingWorkspaceArtifacts } = require("../runtime/workspace_artifacts.js"); // 对应 Go 的 runtime.WorkspaceContentSHA/RestoreMissingWorkspaceArtifacts，runtime 待翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { descendants } = require("./workflow_graph.js"); // 对应 Go 同包函数，workflow_graph.js 已翻译
const { artifactOutputFiles, artifactRelPath } = require("./node_outputs.js"); // 对应 Go 同包函数，node_outputs.js 已翻译
const { workspaceRunID } = require("./workspace_owner.js"); // 对应 Go 同包函数，workspace_owner.js 已翻译
const { runnerWorkspaceBusy } = require("./workspace_busy.js"); // 对应 Go 同包函数，workspace_busy.js 已翻译

/**
 * 从运行已归档的产物中筛选可回填到工作区的文件列表，按物理相对路径去重并挑选最新版本。
 * 执行节点期间绝不回填当前节点及其下游节点的产出路径，避免把缺失的新交付物误判为已成功。
 * 使用场景：恢复旧版无检查点工作区，或在节点执行前准备历史归档文件时调用。
 *
 * @param {object} run - 运行实例（domain.Run）。
 * @param {string} executingNode - 当前正在执行的节点 ID；为空字符串表示非节点执行期（如工作区浏览/终端恢复）。
 * @returns {WorkspaceArtifactFile[]} 按相对路径字典序排列的可回填归档文件数组。
 */
function archivedWorkspaceFiles(run, executingNode) {
  let excluded = {};
  if (executingNode !== "") {
    excluded = descendants(run.WorkflowSnapshot, executingNode);
    excluded[executingNode] = true;
  }
  const syntheticResults = {};
  for (const n of run.WorkflowSnapshot.Nodes ?? []) {
    syntheticResults[n.ID] = (n.ArtifactOutputs ?? []).length === 0;
  }
  const excludedPaths = {};
  for (const n of run.WorkflowSnapshot.Nodes ?? []) {
    if (!excluded[n.ID]) {
      continue;
    }
    for (const p of artifactOutputFiles(run, n)) {
      excludedPaths[p] = true;
    }
  }
  const latest = {};
  for (const a of run.Artifacts ?? []) {
    if (a.Name === "repository-patch" || excluded[a.NodeID] || (syntheticResults[a.NodeID] && a.Name === "result" && a.Path === "result.md")) {
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
    if (excludedPaths[rel]) {
      continue;
    }
    if (rel === "." || path.isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
      continue;
    }
    if (hasHiddenPathSegment(rel)) {
      continue;
    }
    const old = latest[rel];
    if (old === undefined || a.CreatedAt.getTime() > old.CreatedAt.getTime() || (a.CreatedAt.getTime() === old.CreatedAt.getTime() && (a.Attempt > old.Attempt || (a.Attempt === old.Attempt && a.ID > old.ID)))) {
      latest[rel] = a;
    }
  }
  const paths = Object.keys(latest).sort();
  const files = [];
  for (const p of paths) {
    const a = latest[p];
    let sha = a.SHA256;
    if (sha === "") {
      sha = WorkspaceContentSHA(a.Content);
    } // 旧行没有存摘要
    files.push(new WorkspaceArtifactFile({ Path: p, Content: a.Content, SHA256: sha }));
  }
  return files;
}

/**
 * 判断斜杠分隔的相对路径中是否包含以 `.` 开头的隐藏文件或隐藏目录段（点文件/点目录永不回填）。
 * 使用场景：由 archivedWorkspaceFiles 调用，过滤隐藏路径。
 *
 * @param {string} rel - 以 `/` 分隔的相对路径。
 * @returns {boolean} 存在任一以 `.` 开头的路径段时返回 true，否则返回 false。
 */
function hasHiddenPathSegment(rel) {
  return rel.split("/").some((part) => part.startsWith("."));
}

/**
 * 将运行的所有已归档产物文件补回到工作区中缺失的位置。
 * 使用场景：恢复对话工作区或无节点上下文的工作区时调用。
 *
 * @param {AbortSignal} ctx - 取消控制信号。
 * @param {object} run - 运行实例（domain.Run）。
 * @returns {Promise<string[]>} 实际补回的相对路径列表。
 * @throws {Error} 远程控制请求失败、响应解析失败或本地工作区不可用时抛出错误。
 */
Engine.prototype.restoreArchivedWorkspaceFiles = async function (ctx, run) {
  return this.restoreWorkspaceFiles(ctx, run, archivedWorkspaceFiles(run, ""));
};

/**
 * 将给定的归档产物文件列表补回到本地或远程执行机器的工作区中（仅补缺失文件）。
 * 使用场景：由 restoreArchivedWorkspaceFiles 或其他恢复路径调用。
 *
 * @param {AbortSignal} ctx - 取消控制信号。
 * @param {object} run - 运行实例（domain.Run）。
 * @param {WorkspaceArtifactFile[]} files - 待补回的归档产物文件数组。
 * @returns {Promise<string[]>} 实际补回的文件相对路径列表；文件为空或远程工作区正忙时返回空数组。
 * @throws {Error} 远程补回失败（非忙冲突）、载荷 JSON 解析失败或本地工作区不可用时抛出错误。
 */
Engine.prototype.restoreWorkspaceFiles = async function (ctx, run, files) {
  if (files.length === 0) {
    return [];
  }
  if (this.defaultExecutionRunner(run) !== "" || this.foreignWorkspaceBind(run)) {
    const result = await this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({
      RunID: run.ID,
      RunStatus: run.Status,
      RunKind: run.Kind,
      WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout,
      Operation: RunnerWorkspaceOperationArtifacts,
      ArtifactFiles: files,
    }));
    if (result.Error !== "") {
      // 终端或快照持有围栏时只补缺失文件，等下次使用，不让当次保存失败。
      if (runnerWorkspaceBusy(result)) {
        return [];
      }
      throw new Error(`补回归档产物失败（执行机器需支持 restore_artifacts）：${result.Error}`);
    }
    const report = JSON.parse(result.Payload.toString("utf8"));
    return report.restoredArtifacts ?? [];
  }
  const [root, reason] = this.LocalRunWorkspace(run);
  if (reason !== "") {
    throw new Error(reason);
  }
  return RestoreMissingWorkspaceArtifacts(root, files);
};

/**
 * 仅在运行尚未保存过工作区检查点时，返回可用于兼容回填的归档产物文件列表。
 * 使用场景：节点执行前兼容未迁移到检查点机制的旧运行；已有检查点时直接返回空数组。
 *
 * @param {object} run - 运行实例（domain.Run）。
 * @param {string} nodeID - 当前待执行节点 ID，用于排除当前及下游节点产物。
 * @returns {WorkspaceArtifactFile[]} 需回填的归档文件数组；若已存在有效检查点则返回空数组。
 */
Engine.prototype.legacyArchivedWorkspaceFiles = function (run, nodeID) {
  const [meta, ok] = this.repo.WorkspaceCheckpoint(workspaceRunID(run));
  if (ok && meta.SavedAt != null) {
    return [];
  }
  return archivedWorkspaceFiles(run, nodeID);
};

module.exports = { archivedWorkspaceFiles, hasHiddenPathSegment };
