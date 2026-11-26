/**
 * @file internal/domain/workspace_preparation.js
 * @description 对应 Go 文件：internal/domain/workspace_preparation.go
 * 职责与边界：校验工作流节点上可选的 `RunOnWorkspaceRebuild` 重放标记，确保只有脚本/命令节点可在工作区重建时重放。
 * 语法差异说明：
 * - Go 的 `error` 返回译为校验通过无返回值、失败 `throw Error`。
 */

"use strict";

/**
 * 校验工作流中所有启用 `RunOnWorkspaceRebuild` 标记的节点类型是否为 `"script"` 或 `"command"`。
 * 在保存工作流定义或发起工作区重建准备前调用。
 * @param {Object} workflow - `WorkflowDefinition` 工作流定义对象。
 * @returns {void} 无返回值；存在非脚本/命令节点勾选重建重放时抛出异常。
 */
function ValidateWorkflowPreparation(workflow) {
  for (const node of workflow.Nodes ?? []) {
    if (node.RunOnWorkspaceRebuild && node.Type !== "script" && node.Type !== "command") {
      throw new Error(`node ${node.ID}: only script nodes may run on workspace rebuild`);
    }
  }
}

module.exports = { ValidateWorkflowPreparation };
