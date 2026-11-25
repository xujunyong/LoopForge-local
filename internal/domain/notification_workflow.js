// notification_workflow.js —— 对应 Go 文件：internal/domain/notification_workflow.go
// 作用：SOP 级通知选择与全流程通知正文拼装。

"use strict";

// WorkflowNotifications：选一个 SOP 机器人，兼容旧版节点绑定；显式 SOP 配置优先于全部节点配置。
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

// NodeReminderBindings：节点提醒恒用平台状态，绝不复用 AI 完成报告。
function NodeReminderBindings(bindings) {
  const out = [];
  for (const b of bindings) {
    const events = ["waiting", "failed"];
    out.push(new NotificationBinding({ BotID: b.BotID, Events: events, Scope: "node", WaitingPolicy: "actionable", Template: "### {{status}}\n需求：{{issue.title}}\nSOP：{{workflow}}\n节点：{{node}}\n{{error}}\n查看详情：{{url}}" }));
  }
  return out;
}

// BuildWorkflowNotificationResult：按图顺序合并每个节点的贡献；数据库事务内与通知重试时不发生模型调用。
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
