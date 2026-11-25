// workspace_preparation.js —— 对应 Go 文件：internal/domain/workspace_preparation.go
// 作用：校验工作区重建时重放的节点是否合法。

"use strict";

// ValidateWorkflowPreparation：只有 script / command 节点可在工作区重建时重放。
function ValidateWorkflowPreparation(workflow) {
  for (const node of workflow.Nodes ?? []) {
    if (node.RunOnWorkspaceRebuild && node.Type !== "script" && node.Type !== "command") {
      throw new Error(`node ${node.ID}: only script nodes may run on workspace rebuild`);
    }
  }
}

module.exports = { ValidateWorkflowPreparation };
