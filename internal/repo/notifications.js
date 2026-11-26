// notifications.js —— 对应 Go 文件：internal/repo/notifications.go
// 作用：通知 Bot 配置、投递认领与完成，以及运行/任务事件的通知入队。

"use strict";

const { Buffer } = require("node:buffer");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { NotificationBot, NotificationDelivery, NotificationContext, NotificationReportRequest, DefaultNotificationReportModel } = require("../domain/notification.js"); // 对应 Go 的 domain.NotificationBot 等，notification.js 已翻译
const { RenderNotification, ValidateNotificationBinding, NotificationUsesAI } = require("../domain/notification_template.js"); // 对应 Go 的 domain.RenderNotification 等，notification_template.js 已翻译
const { WorkflowNotifications, NodeReminderBindings, BuildWorkflowNotificationResult } = require("../domain/notification_workflow.js"); // 对应 Go 的 domain.WorkflowNotifications 等，notification_workflow.js 已翻译
const { WorkflowNode } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowNode，workflow.js 已翻译
const { NotificationsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { hexSHA256 } = require("./hash.js"); // 对应 Go 同包函数，hash.js 已翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 本次一同翻译

// NotificationsRepo 的类型在 repo.js 里定义（*deps 嵌入提供 DB、locking 与
// isMySQL），方法在这里以 prototype 挂载；users/projects/issues/interactions
// 是 newStore 装配的跨领域指针。

NotificationsRepo.prototype.NotificationBots = function (projectID) {
  const rows = [];
  const err = this.DB.Where("project_id = ?", projectID).Order("id").Find(rows).Error;
  if (err != null) {
    throw err;
  }
  const out = [];
  for (const row of rows) {
    out.push(new NotificationBot(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8"))));
  }
  return out;
};

NotificationsRepo.prototype.NotificationBot = function (id) {
  const row = new notificationBotRow();
  const err = this.DB.Where("id = ?", id).First(row).Error;
  if (err != null) {
    throw err;
  }
  return new NotificationBot(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
};

// SaveNotificationBot：保留创建元数据；传了 secret 时原子替换凭据。
NotificationsRepo.prototype.SaveNotificationBot = function (b, secret) {
  return this.DB.Transaction((tx) => {
    const old = new notificationBotRow();
    const err = this.locking(tx).Where("id = ?", b.ID).First(old).Error;
    if (err == null) {
      let prior;
      try {
        prior = new NotificationBot(JSON.parse(typeof old.Payload === "string" ? old.Payload : Buffer.from(old.Payload).toString("utf8")));
      } catch (e) {
        return e;
      }
      b.CreatedAt = prior.CreatedAt;
      b.OwnerID = prior.OwnerID;
      b.ProjectID = prior.ProjectID;
    } else if (err !== gorm.ErrRecordNotFound) {
      return err;
    }
    if (b.CreatedAt == null) {
      b.CreatedAt = new Date();
    }
    if (b.Enabled && b.InteractionEnabled) {
      const lockErr = this.interactions.lockBotDefinition(tx, b.BotID);
      if (lockErr != null) {
        return lockErr;
      }
      const peers = [];
      const peersErr = tx.Where("id <> ?", b.ID).Find(peers).Error;
      if (peersErr != null) {
        return peersErr;
      }
      for (const peer of peers) {
        let other;
        try {
          other = new NotificationBot(JSON.parse(typeof peer.Payload === "string" ? peer.Payload : Buffer.from(peer.Payload).toString("utf8")));
        } catch (e) {
          return e;
        }
        if (other.Enabled && other.InteractionEnabled && other.BotID === b.BotID) {
          return ErrInteractiveBotAlreadyExists;
        }
      }
    }
    b.UpdatedAt = new Date();
    const createErr = tx.Clauses(new clause.OnConflict({ UpdateAll: true })).Create(new notificationBotRow({ ID: b.ID, ProjectID: b.ProjectID, Payload: mustJSON(b) })).Error;
    if (createErr != null) {
      return createErr;
    }
    if (secret !== "") {
      return this.users.putBotCredential(tx, b.ID, secret);
    }
    return null;
  });
};

NotificationsRepo.prototype.SetNotificationBotHealth = function (id, health) {
  return this.DB.Transaction((tx) => {
    const row = new notificationBotRow();
    const err = this.locking(tx).Where("id = ?", id).First(row).Error;
    if (err != null) {
      return err;
    }
    let b;
    try {
      b = new NotificationBot(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
    } catch (e) {
      return e;
    }
    const now = new Date();
    b.Health = health;
    b.LastCheckedAt = now;
    return tx.Model(row).Update("payload", mustJSON(b)).Error;
  });
};

NotificationsRepo.prototype.DeleteNotificationBot = function (id) {
  return this.DB.Transaction((tx) => {
    const err = tx.Where("id = ?", id).Delete(new notificationBotRow()).Error;
    if (err != null) {
      return err;
    }
    const credErr = this.users.deleteBotCredential(tx, id);
    if (credErr != null) {
      return credErr;
    }
    return tx.Model(new NotificationDelivery()).Where("bot_id = ? AND status <> ?", id, "sent").Updates({ status: "cancelled", lease_token: "", lease_until: null }).Error;
  });
};

NotificationsRepo.prototype.NotificationDeliveries = function (projectID) {
  const rows = [];
  const err = this.DB.Where("project_id = ?", projectID).Order("created_at desc").Limit(100).Find(rows).Error;
  if (err != null) {
    throw err;
  }
  return rows;
};

NotificationsRepo.prototype.ClaimNotification = function (now, token) {
  const row = new NotificationDelivery();
  const err = this.DB.Transaction((tx) => {
    let q = tx.Where("(status = ? AND next_attempt_at <= ?) OR (status = ? AND lease_until < ?)", "pending", now, "sending", now).Order("created_at").Limit(1);
    if (this.isMySQL()) {
      q = q.Clauses(new clause.Locking({ Strength: "UPDATE", Options: "SKIP LOCKED" }));
    }
    const firstErr = q.First(row).Error;
    if (firstErr != null) {
      return firstErr;
    }
    let until = new Date(now.getTime() + 2 * 60 * 1000);
    if (row.ReportState === "pending") {
      until = new Date(now.getTime() + 5 * 60 * 1000);
    }
    const result = tx.Model(new NotificationDelivery()).Where("id = ? AND status = ? AND attempts = ?", row.ID, row.Status, row.Attempts).Updates({ status: "sending", lease_until: until, lease_token: token, attempts: row.Attempts + 1 });
    if (result.Error != null) {
      return result.Error;
    }
    if (result.RowsAffected !== 1) {
      return gorm.ErrRecordNotFound;
    }
    row.Status = "sending";
    row.LeaseToken = token;
    row.LeaseUntil = until;
    row.Attempts++;
    return null;
  });
  if (err === gorm.ErrRecordNotFound) {
    return null;
  }
  if (err != null) {
    throw err;
  }
  return row;
};

NotificationsRepo.prototype.FinishNotification = function (item, status, detail, next) {
  const updates = { status: status, last_error: detail, next_attempt_at: next, lease_until: null, lease_token: "" };
  if (status === "sent") {
    updates["sent_at"] = new Date();
  }
  return this.DB.Model(new NotificationDelivery()).Where("id = ? AND status = ? AND lease_token = ?", item.ID, "sending", item.LeaseToken).Updates(updates).Error;
};

NotificationsRepo.prototype.RetryNotification = function (projectID, id) {
  const result = this.DB.Model(new NotificationDelivery()).Where("id = ? AND project_id = ? AND (content_source IS NULL OR content_source <> 'invalid') AND status IN ?", id, projectID, ["failed", "awaiting_authorization", "target_unavailable"]).Updates({ status: "pending", attempts: 0, next_attempt_at: new Date(), last_error: "" });
  if (result.Error != null) {
    return result.Error;
  }
  if (result.RowsAffected === 0) {
    return gorm.ErrRecordNotFound;
  }
  return null;
};

// enqueueRunNotifications：与运行写事务共享，冻结渲染好的内容。
NotificationsRepo.prototype.enqueueRunNotifications = function (tx, run, event, seq) {
  const projectID = notificationRunProject(run);
  const nodeTrigger = notificationTrigger(event.Type);
  const runTrigger = { "run.succeeded": "succeeded", "run.failed": "failed" }[event.Type] ?? "";
  if (nodeTrigger === "" && runTrigger === "") {
    return null;
  }
  const nodes = [...(run.WorkflowSnapshot.Nodes ?? [])];
  nodes.push(new WorkflowNode({ Type: "agent", Notifications: WorkflowNotifications(run.WorkflowSnapshot) }));
  for (const node of nodes) {
    for (const binding of runNotificationBindings(run, node, runTrigger)) {
      let trigger = nodeTrigger;
      let nodeID = node.ID;
      let labelPrefix = "节点";
      if (binding.Scope === "run") {
        trigger = runTrigger;
        nodeID = "";
        labelPrefix = "SOP";
      } else if (event.NodeID !== node.ID) {
        continue;
      }
      if (trigger === "" || !notificationEventSelected(binding, trigger)) {
        continue;
      }
      const values = { project: this.notificationProjectName(tx, projectID), workflow: run.WorkflowSnapshot.Name, node: node.Name, input: run.Input, status: notificationStatus(trigger, labelPrefix), "issue.title": "未关联需求" };
      if (run.ExecutionContext.IssueID !== "") {
        const [issue, ok] = this.issues.issueInTx(tx, run.ExecutionContext.IssueID);
        if (ok && issue.ProjectID === projectID) {
          values["issue.title"] = issue.Title;
          values["issue.id"] = issue.ID;
        }
      }
      values["error"] = event.Message;
      let result = "";
      let attempt = 0;
      let rework = 0;
      const nr = run.Nodes[node.ID];
      if (nr != null) {
        result = nr.Output;
        if (nr.Error !== "") {
          values["error"] = nr.Error;
        }
        attempt = nr.Attempt;
        rework = nr.ReworkCount;
      }
      let sourceName = node.Name;
      if (binding.Scope === "run") {
        sourceName = run.WorkflowSnapshot.Name;
        result = BuildWorkflowNotificationResult(run);
        values["node"] = "全部节点";
      }
      const item = new NotificationDelivery({ ProjectID: projectID, BotID: binding.BotID, RunID: run.ID, NodeID: nodeID, EventType: trigger, Attempt: attempt, ReworkCount: rework, SourceType: "run", SourceID: run.ID, SourceName: sourceName });
      const key = `run:${run.ID}:${seq}:${binding.BotID}`;
      const context = new NotificationContext({ Values: values, Result: result, Fallback: sourceName + "：" + values["status"] + "。请在平台查看详情。", SourceType: "run" });
      const err = this.enqueueNotification(tx, key, binding, context, item);
      if (err != null) {
        return err;
      }
    }
  }
  return null;
};

NotificationsRepo.prototype.enqueueTaskNotifications = function (tx, sourceType, id, projectID, name, trigger, at, bindings, result, errorText) {
  for (const binding of bindings) {
    if (!notificationEventSelected(binding, trigger)) {
      continue;
    }
    const values = { project: this.notificationProjectName(tx, projectID), "task.name": name, status: notificationStatus(trigger, "任务"), error: errorText, "issue.title": "未关联需求" };
    const item = new NotificationDelivery({ ProjectID: projectID, BotID: binding.BotID, EventType: trigger, SourceType: sourceType, SourceID: id, SourceName: name });
    const key = `${sourceType}:${id}:${at.getTime()}:${trigger}:${binding.BotID}`;
    const context = new NotificationContext({ Values: values, Result: result, Fallback: name + "：" + values["status"] + "。请在平台查看详情。", SourceType: sourceType });
    const err = this.enqueueNotification(tx, key, binding, context, item);
    if (err != null) {
      return err;
    }
  }
  return null;
};

NotificationsRepo.prototype.notificationProjectName = function (tx, id) {
  const [project, ok] = this.projects.projectInTx(tx, id);
  if (ok) {
    return project.Name;
  }
  return id;
};

NotificationsRepo.prototype.enqueueNotification = function (tx, key, binding, context, item) {
  const row = new notificationBotRow();
  const err = tx.Where("id = ?", binding.BotID).First(row).Error;
  if (err === gorm.ErrRecordNotFound) {
    return null;
  } else if (err != null) {
    return err;
  }
  let bot;
  try {
    bot = new NotificationBot(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
  } catch (e) {
    return e;
  }
  if (!bot.Enabled || bot.Target == null || bot.ProjectID !== item.ProjectID) {
    return null;
  }
  item.ID = hexSHA256(key);
  item.TargetID = bot.Target.ID;
  item.TargetName = bot.Target.Name;
  item.TargetType = bot.Target.Type;
  let content;
  let source;
  let renderErr = null;
  try {
    [content, source] = RenderNotification(binding, context);
  } catch (e) {
    renderErr = e;
  }
  item.WaitingPolicy = binding.WaitingPolicy;
  if (item.WaitingPolicy === "") {
    item.WaitingPolicy = "actionable";
  }
  item.Content = content;
  item.ContentSource = source;
  item.Status = "pending";
  if (renderErr != null) {
    item.Status = "failed";
    item.LastError = renderErr.message;
    item.ContentSource = "invalid";
  }
  if (item.Status === "pending" && item.SourceType === "run" && item.NodeID === "" && item.EventType === "succeeded" && NotificationUsesAI(binding)) {
    let request;
    try {
      request = JSON.stringify(new NotificationReportRequest({ Binding: binding, Context: context }));
    } catch (e) {
      return e;
    }
    item.ReportRequest = request;
    item.ReportState = "pending";
    item.ReportModel = bot.Model;
    if (item.ReportModel === "") {
      item.ReportModel = DefaultNotificationReportModel;
    }
  }
  item.CreatedAt = new Date();
  item.NextAttemptAt = item.CreatedAt;
  return tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(item).Error;
};

NotificationsRepo.prototype.ValidateNotificationBindings = function (projectID, bindings, task) {
  return this.validateNotificationBindings(this.DB, projectID, bindings, task);
};

NotificationsRepo.prototype.validateNotificationBindings = function (db, projectID, bindings, task) {
  if (bindings.length > 3) {
    return new Error("最多配置 3 个通知 Bot");
  }
  const seen = {};
  for (const binding of bindings) {
    if (binding.BotID === "" || seen[binding.BotID]) {
      return new Error("通知 Bot 不能为空或重复");
    }
    seen[binding.BotID] = true;
    try {
      ValidateNotificationBinding(binding);
    } catch (e) {
      return e;
    }
    if (task && (binding.Scope === "run" || notificationEventSelected(binding, "waiting"))) {
      return new Error("定时任务通知仅支持成功或失败");
    }
    const row = new notificationBotRow();
    let err = db.Where("id = ?", binding.BotID).First(row).Error;
    let bot = new NotificationBot();
    if (err == null) {
      try {
        bot = new NotificationBot(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
      } catch (e) {
        err = e;
      }
    }
    if (err != null || bot.ProjectID !== projectID) {
      return new Error("通知 Bot 不属于当前项目");
    }
    if (bot.Target == null) {
      return new Error("请先为通知 Bot 绑定接收会话");
    }
  }
  return null;
};

NotificationsRepo.prototype.CreateNotificationDelivery = function (item) {
  return this.DB.Create(item).Error;
};

NotificationsRepo.prototype.InteractiveNotificationBots = function () {
  const rows = [];
  const err = this.DB.Order("id").Find(rows).Error;
  if (err != null) {
    throw err;
  }
  const out = [];
  for (const row of rows) {
    const b = new NotificationBot(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
    if (b.Enabled && b.InteractionEnabled) {
      out.push(b);
    }
  }
  return out;
};

NotificationsRepo.prototype.NotificationDelivery = function (id) {
  const item = new NotificationDelivery();
  const err = this.DB.First(item, "id = ?", id).Error;
  if (err != null) {
    throw err;
  }
  return item;
};

class notificationBotRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Payload = init.Payload ?? null;
  }

  TableName() {
    return "notification_bots";
  }
}

// runNotificationBindings：选出一个运行节点要评估的绑定；SOP 级节点（空 ID）用自己的绑定，运行失败且无节点失败事件时回退到 run 级 failed 提醒。
function runNotificationBindings(run, node, runTrigger) {
  if (node.ID !== "") {
    return NodeReminderBindings(WorkflowNotifications(run.WorkflowSnapshot));
  }
  // 没有节点失败事件的搭建/运行时失败也可能让 SOP 直接结束。
  if (runTrigger !== "failed" || runHasNodeFailureEvent(run.Events)) {
    return node.Notifications;
  }
  const bindings = NodeReminderBindings(node.Notifications);
  for (let i = 0; i < bindings.length; i++) {
    bindings[i].Scope = "run";
    bindings[i].Events = ["failed"];
  }
  return bindings;
}

// runHasNodeFailureEvent：是否有节点级失败事件。
function runHasNodeFailureEvent(events) {
  for (const event of events) {
    if (notificationTrigger(event.Type) === "failed" && event.NodeID !== "") {
      return true;
    }
  }
  return false;
}

function notificationEventSelected(binding, event) {
  return binding.Events.includes(event);
}

function notificationStatus(trigger, scope) {
  switch (trigger) {
    case "succeeded":
      return scope + "已完成";
    case "failed":
      return scope + "失败";
    default:
      return "需要人工处理";
  }
}

function notificationRunProject(run) {
  if (run.ExecutionContext.ProjectID !== "") {
    return run.ExecutionContext.ProjectID;
  }
  return run.WorkflowSnapshot.ProjectID;
}

function notificationTrigger(eventType) {
  switch (eventType) {
    case "node.succeeded":
    case "gate.approved":
      return "succeeded";
    case "node.failed":
    case "agent.turns.declined":
      return "failed";
    case "approval.waiting":
    case "gate.waiting":
    case "agent.turns.exhausted":
    case "agent.loop.exhausted":
    case "node.paused":
      return "waiting";
    default:
      return "";
  }
}

const ErrInteractiveBotAlreadyExists = new Error("同一企业微信 Bot 只能有一个启用的对话配置");

module.exports = { notificationBotRow, runNotificationBindings, runHasNodeFailureEvent, notificationEventSelected, notificationStatus, notificationRunProject, notificationTrigger, ErrInteractiveBotAlreadyExists };
