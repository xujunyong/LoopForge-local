/**
 * @file git_preparation_fallback.js
 * 对应 Go 源文件：internal/engine/git_preparation_fallback.go
 * 作用与职责边界：判断工作流中的某个 Agent 节点是否为首个可替平台准备代码仓库的节点。
 * 语法差异说明：
 * - Go 的 `map[string]domain.WorkflowNode` 与 `map[string]bool` 统一译为普通对象 `{}`。
 */

"use strict";

/**
 * 判断指定节点是否为首个可替平台准备代码的初始 Agent 节点。
 * 只有普通初始 Agent 可以替平台准备代码；脚本节点在启动前必须已有检出目录且无法按提示词行动；
 * 审批节点与工作区重建节点不占用该首位 Agent 名额。
 * 使用场景：工作区代码准备失败需要回退给 Agent 处理时，判断当前节点是否具备承接资格。
 *
 * @param {object} wf - 工作流定义对象（domain.WorkflowDefinition），包含 `Nodes` 与 `Edges`。
 * @param {object} node - 待判断的工作流节点定义（domain.WorkflowNode）。
 * @returns {boolean} 若该节点为初始可准备代码的 Agent 节点返回 `true`，否则返回 `false`。
 */
function firstRepositoryAgent(wf, node) {
  if (node.Type !== "agent" || node.RunOnWorkspaceRebuild) {
    return false;
  }
  const byID = {};
  for (const n of wf.Nodes) {
    byID[n.ID] = n;
  }
  const seen = {};
  const initial = (id) => {
    if (seen[id]) {
      return true;
    }
    seen[id] = true;
    for (const edge of wf.Edges) {
      if (edge.Target !== id) {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(byID, edge.Source)) {
        continue;
      }
      const parent = byID[edge.Source];
      if (!parent.RunOnWorkspaceRebuild && parent.Type !== "approval") {
        return false;
      }
      if (!initial(parent.ID)) {
        return false;
      }
    }
    return true;
  };
  return initial(node.ID);
}

module.exports = { firstRepositoryAgent };
