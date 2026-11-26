// chat_workspace.js —— 对应 Go 文件：internal/engine/chat_workspace.go
// 作用：对话工作区的创建入口：分配空闲工作区并启动对话工作流。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 待翻译
const { WorkflowDefinition } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition，domain 已翻译
const { ConversationWorkspaceWorkflowID } = require("../domain/run.js"); // 对应 Go 的 domain.ConversationWorkspaceWorkflowID，domain 已翻译

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
  const [, sandboxErr] = this.repo.ConversationSandbox(actor.ProjectID, sandboxID);
  if (sandboxErr != null) {
    throw sandboxErr;
  }
  const wf = new WorkflowDefinition({ ID: ConversationWorkspaceWorkflowID, Name: "对话工作区", Version: 1, ProjectID: actor.ProjectID, SandboxProfileID: sandboxID, Nodes: [], Edges: [] });
  return this.startWorkflowDefinition(wf, input, null, actor, true);
};
