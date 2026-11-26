/**
 * @file internal/domain/notification_workflow.js
 * @description 对应 Go 源文件：internal/domain/notification_workflow.go
 * 职责边界：负责从工作流定义中筛选生效的 SOP 级通知机器人、派生节点异常/等待提醒绑定，以及按节点图顺序汇总整条流程的通知正文。
 * 语法差异说明：
 * - Go 整数除法 `6000 / count` 在 JS 中使用 `Math.trunc(6000 / count)` 保持一致。
 * - Go 的 `json.Marshal(content)` 按 struct json tag 输出小写键并在 `Simulated` 为 `false` 时省略该字段，JS 中按相同字段名显式构造序列化对象。
 */

"use strict";

const { NotificationBinding } = require("./notification.js");
const { AINotificationContent, NotificationText, ParseNotificationResult } = require("./notification_template.js");

/**
 * 从工作流定义中选出唯一生效的 SOP 级通知绑定，并兼容旧版节点级绑定配置。
 * 优先级：显式 SOP 级 `w.Notifications` > 节点上 `Scope === "run"` 的旧版配置 > 首个配置了通知的节点。
 *
 * @param {object} w - 工作流定义对象（WorkflowDefinition）。
 * @returns {object[]|null} 规范化后的单元素通知绑定数组；若未找到有效机器人配置则返回 `null`。
 */
function WorkflowNotifications(w) {
  let selected = null;
  if (w.Notifications.length > 0) {
    const b = { ...w.Notifications[0] };
    selected = b;
  }
  // 旧版 SOP 配置优先于单个节点设置。
  if (selected == null) {
    for (const node of w.Nodes) {
      for (const b of node.Notifications) {
        if (b.Scope === "run") {
          const copy = { ...b };
          selected = copy;
          break;
        }
      }
      if (selected != null) {
        break;
      }
    }
  }
  if (selected == null) {
    for (const node of w.Nodes) {
      if (node.Notifications.length > 0) {
        const b = { ...node.Notifications[0] };
        b.ContentMode = "ai";
        b.Template = "";
        b.AIInstruction = "";
        selected = b;
        break;
      }
    }
  }
  if (selected == null || selected.BotID === "") {
    return null;
  }
  selected.Scope = "run";
  selected.Events = ["succeeded"];
  selected.ContentMode = "ai";
  return [selected];
}

/**
 * 基于 SOP 级通知绑定派生节点级等待与失败提醒绑定。
 * 节点提醒始终使用平台状态固定模板，不复用 AI 完成报告。
 *
 * @param {NotificationBinding[]} bindings - SOP 级通知绑定数组。
 * @returns {NotificationBinding[]} 派生出的节点提醒绑定数组。
 */
function NodeReminderBindings(bindings) {
  const out = [];
  for (const b of bindings) {
    const events = ["waiting", "failed"];
    out.push(new NotificationBinding({ BotID: b.BotID, Events: events, Scope: "node", WaitingPolicy: "actionable", Template: "### {{status}}\n需求：{{issue.title}}\nSOP：{{workflow}}\n节点：{{node}}\n{{error}}\n查看详情：{{url}}" }));
  }
  return out;
}

/**
 * 按工作流快照中的节点顺序汇总各节点状态、输出摘要与失败原因，拼装整条运行的通知结果文本。
 * 该函数为纯文本组装，不触发模型调用，可在数据库事务或通知重试期间安全调用。
 *
 * @param {object} run - 运行记录对象（Run）。
 * @returns {string} 汇总后的 Markdown 正文；若任一节点产出过 AI 通知块，则在末尾附加 `notification` JSON 代码块。
 */
function BuildWorkflowNotificationResult(run) {
  const sections = [];
  let generatedAny = false;
  let simulated = false;
  let budget = 1200;
  if (run.WorkflowSnapshot.Nodes.length > 0) {
    budget = Math.trunc(6000 / run.WorkflowSnapshot.Nodes.length);
    if (budget > 1800) {
      budget = 1800;
    }
  }
  for (const node of run.WorkflowSnapshot.Nodes) {
    let status = "未执行";
    let result = "";
    let errorText = "";
    const nr = run.Nodes[node.ID];
    if (nr != null) {
      status = nr.Status;
      const label = { succeeded: "已完成", failed: "失败", skipped: "已跳过", pending: "未执行", running: "执行中", waiting_approval: "待人工处理" }[status];
      if (label !== undefined) {
        status = label;
      }
      result = nr.Output;
      errorText = nr.Error;
    }
    let [ai, plain, generated] = ParseNotificationResult(result);
    if (generated) {
      generatedAny = true;
      simulated = simulated || ai.Simulated;
      plain = ai.Body;
      if (plain === "") {
        plain = ai.Summary;
      }
    }
    let section = "### " + NotificationText(node.Name, 160) + "（" + status + "）";
    const text = NotificationText(plain, budget);
    if (text !== "") {
      section += "\n" + text;
    }
    if (errorText !== "") {
      section += "\n失败原因：" + NotificationText(errorText, 600);
    }
    sections.push(section);
  }
  const body = sections.join("\n\n");
  if (!generatedAny) {
    return body;
  }
  const content = new AINotificationContent({ Title: run.WorkflowSnapshot.Name + " · SOP 已完成", Summary: body, Body: body, Simulated: simulated });
  // Go 按 json tag 序列化，simulated 为 false 时省略。
  const raw = JSON.stringify({ title: content.Title, summary: content.Summary, body: content.Body, ...(content.Simulated ? { simulated: true } : {}) });
  return body + "\n\n```notification\n" + raw + "\n```";
}

module.exports = { WorkflowNotifications, NodeReminderBindings, BuildWorkflowNotificationResult };
