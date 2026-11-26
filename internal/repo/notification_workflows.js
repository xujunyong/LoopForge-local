// notification_workflows.js —— 对应 Go 文件：internal/repo/notification_workflows.go
// 作用：校验 SOP 与节点上的通知绑定是否合规。

"use strict";

const { WorkflowDefinition } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition，workflow.js 已翻译
const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

CatalogRepo.prototype.validateWorkflowNotifications = function (w) {
  const runBots = {};
  if (w.Notifications.length > 1) {
    return new Error("每个 SOP 只配置一个通知 Bot");
  }
  if (w.Notifications.length > 0) {
    if (w.ProjectID === "" || w.Shared || w.Generic) {
      return new Error("通知绑定只能保存在本项目流程中，请先复制共享模板");
    }
    const err = this.notifications.ValidateNotificationBindings(w.ProjectID, w.Notifications, false);
    if (err != null) {
      return err;
    }
    for (const b of w.Notifications) {
      if (b.Scope !== "run" || b.Events.length !== 1 || b.Events[0] !== "succeeded") {
        return new Error("SOP 通知只支持整个 SOP 完成");
      }
      runBots[b.BotID] = true;
    }
  }
  for (const node of w.Nodes) {
    if (node.Notifications.length === 0) {
      continue;
    }
    if (node.Type !== "agent") {
      return new Error("只有 Agent 节点可以配置通知");
    }
    if (w.ProjectID === "" || w.Shared || w.Generic) {
      return new Error("通知绑定只能保存在本项目流程中，请先复制共享模板");
    }
    const err = this.notifications.ValidateNotificationBindings(w.ProjectID, node.Notifications, false);
    if (err != null) {
      return err;
    }
    for (const binding of node.Notifications) {
      if (binding.Scope === "run") {
        if (runBots[binding.BotID]) {
          return new Error("同一 Bot 的流程范围通知只能配置一次");
        }
        runBots[binding.BotID] = true;
      }
    }
  }
  return null;
};
