// git_preparation_fallback.js —— 对应 Go 文件：internal/engine/git_preparation_fallback.go
// 作用：判断某 Agent 节点是否为首个可替平台准备代码的节点。

"use strict";

// firstRepositoryAgent：只有初始 Agent 能替平台准备代码；脚本节点开工前需要检出、不能只凭提示词行动；审批与环境准备节点不占这个首位名额。
function firstRepositoryAgent(wf, node) {
  if (node.Type !== "agent" || node.RunOnWorkspaceRebuild) {
    return false;
  }
  const byID = new Map();
  for (const n of wf.Nodes) {
    byID.set(n.ID, n);
  }
  const seen = new Set();
  const initial = (id) => {
    if (seen.has(id)) {
      return true;
    }
    seen.add(id);
    for (const edge of wf.Edges) {
      if (edge.Target !== id) {
        continue;
      }
      const parent = byID.get(edge.Source);
      if (parent === undefined) {
        continue;
      }
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
