// shared_schedule_assets.js —— 对应 Go 文件：internal/engine/shared_schedule_assets.go
// 作用：共享定时任务准入时校验 SOP、沙箱与角色是否属于当前项目或已共享。
// 只返回 error 的函数译为失败 throw，成功不返回值。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { IsPreviewBuildAgent } = require("../domain/preview.js"); // 对应 Go 的 domain.IsPreviewBuildAgent，preview.js 已翻译
const { workflowAgent } = require("./assets.js"); // 对应 Go 同包函数，assets.js 已翻译

Engine.prototype.validateSharedScheduleWorkflow = function (wf, projectID, profile) {
  sharedScheduleAssetVisible(projectID, "SOP", wf.ProjectID, wf.Shared || wf.Generic);
  sharedScheduleAssetVisible(projectID, "沙箱", profile.ProjectID, profile.Shared);
  for (const node of wf.Nodes) {
    if (node.Type !== "agent" || IsPreviewBuildAgent(node.AgentID)) {
      continue;
    }
    const [agent, ok] = workflowAgent(this.repo, wf, node.AgentID);
    if (!ok) {
      throw new Error("共享任务使用的角色不存在");
    }
    sharedScheduleAssetVisible(projectID, "角色", agent.ProjectID, agent.Shared);
  }
};

function sharedScheduleAssetVisible(projectID, kind, owner, shared) {
  projectID = projectID.trim();
  owner = owner.trim();
  if (shared || (projectID !== "" && owner === projectID)) {
    return;
  }
  throw new Error(`共享任务使用的${kind}不属于当前项目且尚未共享`);
}

module.exports = { sharedScheduleAssetVisible };
