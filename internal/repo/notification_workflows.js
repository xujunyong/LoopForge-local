/**
 * @file internal/repo/notification_workflows.js
 * 对应 Go 源文件：internal/repo/notification_workflows.go
 *
 * 作用与职责边界：
 * 为 `CatalogRepo` 提供工作流（SOP）保存前的通知绑定合法性校验方法，
 * 负责检查 SOP 级与节点级通知的数量上限、项目归属限制、节点类型约束、事件范围及同一 Bot 的流程级去重。
 * 不负责通知 Bot 的 CRUD 或单条通知绑定模板的底层校验（委托 `NotificationsRepo.ValidateNotificationBindings`）。
 *
 * 语法差异说明：
 * - Go 仅返回 `error` 的方法在 JS 中统一译为校验通过返回 `undefined`、校验失败 `throw new Error(...)`。
 * - Go 的 `map[string]bool` 译为普通对象 `{}`。
 */

"use strict";

const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译

/**
 * 校验工作流定义上配置的所有 SOP 级与节点级通知绑定是否符合平台规则。
 * 使用场景：在 `CatalogRepo.PutWorkflow` 保存或更新工作流定义之前调用。
 *
 * @param {object} w - 待校验的工作流定义（`domain.WorkflowDefinition`）。
 * @returns {void} 无返回值。
 * @throws {Error} 绑定数量超限、在共享/通用/无项目流程上绑定通知、非 Agent 节点配置通知、事件范围非法、底层 Bot 校验失败或同一 Bot 重复配置流程级通知时抛出错误。
 */
CatalogRepo.prototype.validateWorkflowNotifications = function (w) {
  const runBots = {};
  if (w.Notifications.length > 1) {
    throw new Error("每个 SOP 只配置一个通知 Bot");
  }
  if (w.Notifications.length > 0) {
    if (w.ProjectID === "" || w.Shared || w.Generic) {
      throw new Error("通知绑定只能保存在本项目流程中，请先复制共享模板");
    }
    this.notifications.ValidateNotificationBindings(w.ProjectID, w.Notifications, false);
    for (const b of w.Notifications) {
      if (b.Scope !== "run" || b.Events.length !== 1 || b.Events[0] !== "succeeded") {
        throw new Error("SOP 通知只支持整个 SOP 完成");
      }
      runBots[b.BotID] = true;
    }
  }
  for (const node of w.Nodes) {
    if (node.Notifications.length === 0) {
      continue;
    }
    if (node.Type !== "agent") {
      throw new Error("只有 Agent 节点可以配置通知");
    }
    if (w.ProjectID === "" || w.Shared || w.Generic) {
      throw new Error("通知绑定只能保存在本项目流程中，请先复制共享模板");
    }
    this.notifications.ValidateNotificationBindings(w.ProjectID, node.Notifications, false);
    for (const binding of node.Notifications) {
      if (binding.Scope === "run") {
        if (runBots[binding.BotID]) {
          throw new Error("同一 Bot 的流程范围通知只能配置一次");
        }
        runBots[binding.BotID] = true;
      }
    }
  }
};
