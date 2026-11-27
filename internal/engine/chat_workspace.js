/**
 * @file chat_workspace.js
 * 对应 Go 源文件：internal/engine/chat_workspace.go
 * 作用与职责边界：提供对话工作区的创建入口，校验目标、归属项目/用户与对话沙箱后，
 * 通过标准工作流启动流程分配空闲工作区并冻结 Docker 定义。
 * 语法差异说明：
 * - Go 的 `(domain.Run, error)` 返回值译为成功返回运行实例、失败 `throw Error`。
 * - `this.repo.ConversationSandbox` 校验失败时直接抛出错误，无需元组解构。
 * - 属于 `Engine` 的方法挂载在 `Engine.prototype` 上。
 */

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 待翻译
const { WorkflowDefinition } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition，domain 已翻译
const { ConversationWorkspaceWorkflowID } = require("../domain/run.js"); // 对应 Go 的 domain.ConversationWorkspaceWorkflowID，domain 已翻译

/**
 * 分配并启动一个空闲的对话工作区运行实例（不包含 SOP 节点编排或角色任务组）。
 * 使用场景：用户在对话界面新建项目级或个人级工作区时调用，由标准运行构建器负责冻结沙箱与 Docker 配置。
 *
 * @param {string} input - 用户填写的工作区目标说明（去除空白后不能为空）。
 * @param {object} actor - 触发者遥测上下文（domain.TelemetryContext），包含 `ProjectID` 与 `ResponsibleUserID`。
 * @param {string} sandboxID - 选中的对话沙箱配置 ID。
 * @returns {object} 创建并启动后的运行实例对象（domain.Run）。
 * @throws {Error} 目标为空、个人工作区未登录、项目不存在、沙箱校验不通过或启动失败时抛出错误。
 */
Engine.prototype.StartConversationWorkspace = function (input, actor, sandboxID) {
  if (input.trim() === "") {
    throw new Error("请填写工作区目标");
  }
  actor.ProjectID = actor.ProjectID.trim();
  if (actor.ProjectID === "") {
    if (actor.ResponsibleUserID <= 0) {
      throw new Error("个人工作区需要登录用户");
    }
  } else {
    const [, ok] = this.repo.Project(actor.ProjectID);
    if (!ok) {
      throw new Error("项目不存在");
    }
  }
  this.repo.ConversationSandbox(actor.ProjectID, sandboxID);
  const wf = new WorkflowDefinition({ ID: ConversationWorkspaceWorkflowID, Name: "对话工作区", Version: 1, ProjectID: actor.ProjectID, SandboxProfileID: sandboxID, Nodes: [], Edges: [] });
  return this.startWorkflowDefinition(wf, input, null, actor, true);
};
