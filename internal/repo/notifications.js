/**
 * @file internal/repo/notifications.js
 * 对应 Go 源文件：internal/repo/notifications.go
 *
 * 作用与职责边界：
 * 实现 `NotificationsRepo` 的全部核心持久化能力，包括通知 Bot 的增删改查、健康状态更新、
 * 投递队列的租约认领/完成/重试、运行事件与定时任务事件在共享写事务中的通知渲染与幂等入队、
 * 通知绑定合法性校验，以及启用交互能力的 Bot 列表查询。
 * 不负责外部 IM 协议发送、AI 报告正文生成或 HTTP 路由处理。
 *
 * 语法差异说明：
 * - `NotificationsRepo` 类型在 `repo.js` 中定义（继承 `deps`），本文件通过 `NotificationsRepo.prototype` 挂载方法。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；`db.Transaction(tx => ...)` 回调同样遵循失败抛错、成功正常返回。
 * - Go 的 `time.Time` 对应 `Date`（零值 `null`），`time.Minute` 换算为毫秒数（`60 * 1000`）。
 * - Go 的 `map[string]string` / `map[string]bool` / `map[string]any` 均译为普通对象 `{}`；`slices.Contains` 译为 `Array.prototype.includes`。
 */

"use strict";

const { Buffer } = require("node:buffer");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { NotificationBot, NotificationDelivery, NotificationReportRequest, DefaultNotificationReportModel } = require("../domain/notification.js"); // 对应 Go 的 domain.NotificationBot 等，notification.js 已翻译
const { NotificationContext, RenderNotification, ValidateNotificationBinding, NotificationUsesAI } = require("../domain/notification_template.js"); // 对应 Go 的 domain.NotificationContext 等，notification_template.js 已翻译
const { WorkflowNotifications, NodeReminderBindings, BuildWorkflowNotificationResult } = require("../domain/notification_workflow.js"); // 对应 Go 的 domain.WorkflowNotifications 等，notification_workflow.js 已翻译
const { WorkflowNode } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowNode，workflow.js 已翻译
const { NotificationsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { hexSHA256 } = require("./hash.js"); // 对应 Go 同包函数，hash.js 已翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译

// NotificationsRepo 的类型在 repo.js 里定义（*deps 嵌入提供 DB、locking 与
// isMySQL），方法在这里以 prototype 挂载；users/projects/issues/interactions
// 是 newStore 装配的跨领域指针。

/**
 * 对应数据库表 `notification_bots` 的通知机器人行模型。
 * 以机器人 ID 为主键，按项目索引并将完整 `domain.NotificationBot` 序列化在 `Payload` JSON 列中。
 */
class notificationBotRow {
  /**
   * 构造通知机器人数据库行对象，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.ID=""] - 通知 Bot 主键 ID。
   * @param {string} [init.ProjectID=""] - 所属项目 ID。
   * @param {Buffer|string|null} [init.Payload=null] - 序列化后的 JSON 载荷字节。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Payload = init.Payload ?? null;
  }

  /**
   * 返回 GORM 映射的物理数据库表名。
   *
   * @returns {string} 表名 `"notification_bots"`。
   */
  TableName() {
    return "notification_bots";
  }
}

/**
 * 按项目 ID 查询该项目下配置的全部通知机器人，按 ID 升序排列。
 * 使用场景：项目设置页列出已配置机器人以及后台巡检项目通知配置。
 *
 * @param {string} projectID - 项目唯一标识。
 * @returns {NotificationBot[]} 该项目下的通知机器人实体数组。
 * @throws {Error} 数据库查询或 JSON 反序列化失败时抛出错误。
 */
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

/**
 * 按主键 ID 读取单个通知机器人配置。
 * 使用场景：管理端编辑机器人、测试发送或投递器加载机器人配置时调用。
 *
 * @param {string} id - 通知机器人记录主键 ID。
 * @returns {NotificationBot} 反序列化后的通知机器人实体。
 * @throws {Error} 记录不存在、数据库查询或 JSON 反序列化失败时抛出错误。
 */
NotificationsRepo.prototype.NotificationBot = function (id) {
  const row = new notificationBotRow();
  const err = this.DB.Where("id = ?", id).First(row).Error;
  if (err != null) {
    throw err;
  }
  return new NotificationBot(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
};

/**
 * 在事务中保存或更新通知机器人配置：保留既有记录的创建时间、拥有者与项目归属，
 * 校验启用交互的外部 Bot 全局唯一性，并在传入非空密钥时原子替换其加密凭据。
 * 使用场景：新建或编辑项目通知机器人配置接口调用。
 *
 * @param {NotificationBot} b - 待保存的通知机器人实体。
 * @param {string} secret - 可选的新加密凭据；为空字符串时保留既有凭据不变。
 * @returns {void} 无返回值。
 * @throws {Error} 事务内查询、反序列化、交互 Bot 唯一性冲突（`ErrInteractiveBotAlreadyExists`）或写入凭据失败时抛出错误。
 */
NotificationsRepo.prototype.SaveNotificationBot = function (b, secret) {
  this.DB.Transaction((tx) => {
    const old = new notificationBotRow();
    const err = this.locking(tx).Where("id = ?", b.ID).First(old).Error;
    if (err == null) {
      const prior = new NotificationBot(JSON.parse(typeof old.Payload === "string" ? old.Payload : Buffer.from(old.Payload).toString("utf8")));
      b.CreatedAt = prior.CreatedAt;
      b.OwnerID = prior.OwnerID;
      b.ProjectID = prior.ProjectID;
    } else if (err !== gorm.ErrRecordNotFound) {
      throw err;
    }
    if (b.CreatedAt == null) {
      b.CreatedAt = new Date();
    }
    if (b.Enabled && b.InteractionEnabled) {
      this.interactions.lockBotDefinition(tx, b.BotID);
      const peers = [];
      const peersErr = tx.Where("id <> ?", b.ID).Find(peers).Error;
      if (peersErr != null) {
        throw peersErr;
      }
      for (const peer of peers) {
        const other = new NotificationBot(JSON.parse(typeof peer.Payload === "string" ? peer.Payload : Buffer.from(peer.Payload).toString("utf8")));
        if (other.Enabled && other.InteractionEnabled && other.BotID === b.BotID) {
          throw ErrInteractiveBotAlreadyExists;
        }
      }
    }
    b.UpdatedAt = new Date();
    const createErr = tx.Clauses(new clause.OnConflict({ UpdateAll: true })).Create(new notificationBotRow({ ID: b.ID, ProjectID: b.ProjectID, Payload: mustJSON(b) })).Error;
    if (createErr != null) {
      throw createErr;
    }
    if (secret !== "") {
      this.users.putBotCredential(tx, b.ID, secret);
    }
  });
};

/**
 * 在事务中加行锁更新指定通知机器人的最近健康状态与检查时间。
 * 使用场景：通知投递器完成连通性检测或发送反馈后写回机器人健康状态。
 *
 * @param {string} id - 通知机器人记录主键 ID。
 * @param {string} health - 新的健康状态标记文本。
 * @returns {void} 无返回值。
 * @throws {Error} 记录不存在、JSON 反序列化或数据库更新失败时抛出错误。
 */
NotificationsRepo.prototype.SetNotificationBotHealth = function (id, health) {
  this.DB.Transaction((tx) => {
    const row = new notificationBotRow();
    const err = this.locking(tx).Where("id = ?", id).First(row).Error;
    if (err != null) {
      throw err;
    }
    const b = new NotificationBot(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
    const now = new Date();
    b.Health = health;
    b.LastCheckedAt = now;
    const updateErr = tx.Model(row).Update("payload", mustJSON(b)).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
};

/**
 * 在事务中删除通知机器人配置、清理关联加密凭据，并将该机器人所有未发送完成的投递记录标记为 `"cancelled"`。
 * 使用场景：用户在项目设置中删除通知机器人时调用。
 *
 * @param {string} id - 待删除的通知机器人主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 删除机器人行、删除凭据或取消待发投递记录失败时抛出错误。
 */
NotificationsRepo.prototype.DeleteNotificationBot = function (id) {
  this.DB.Transaction((tx) => {
    const err = tx.Where("id = ?", id).Delete(new notificationBotRow()).Error;
    if (err != null) {
      throw err;
    }
    this.users.deleteBotCredential(tx, id);
    const updateErr = tx.Model(new NotificationDelivery()).Where("bot_id = ? AND status <> ?", id, "sent").Updates({ status: "cancelled", lease_token: "", lease_until: null }).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
};

/**
 * 查询指定项目最近 100 条通知投递记录，按创建时间倒序排列。
 * 使用场景：项目通知投递日志页展示近期发送记录与失败原因。
 *
 * @param {string} projectID - 项目唯一标识。
 * @returns {NotificationDelivery[]} 通知投递记录数组（最多 100 条）。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
NotificationsRepo.prototype.NotificationDeliveries = function (projectID) {
  const rows = [];
  const err = this.DB.Where("project_id = ?", projectID).Order("created_at desc").Limit(100).Find(rows).Error;
  if (err != null) {
    throw err;
  }
  return rows;
};

/**
 * 认领一条到期可发送（或租约已过期）的通知投递记录并授予本次发送租约。
 * 在 MySQL 下使用 `FOR UPDATE SKIP LOCKED` 减少并发 worker 竞争；普通投递租约 2 分钟，待生成 AI 报告的投递租约 5 分钟。
 * 使用场景：后台通知投递 worker 轮询消费投递队列时调用。
 *
 * @param {Date} now - 当前 UTC 时间。
 * @param {string} token - 本次认领生成的唯一租约令牌。
 * @returns {NotificationDelivery|null} 成功认领时返回已更新租约字段的投递记录；无待处理记录或被并发抢占时返回 `null`。
 * @throws {Error} 除 `gorm.ErrRecordNotFound` 外的数据库查询或更新错误发生时抛出错误。
 */
NotificationsRepo.prototype.ClaimNotification = function (now, token) {
  const row = new NotificationDelivery();
  try {
    this.DB.Transaction((tx) => {
      let q = tx.Where("(status = ? AND next_attempt_at <= ?) OR (status = ? AND lease_until < ?)", "pending", now, "sending", now).Order("created_at").Limit(1);
      if (this.isMySQL()) {
        q = q.Clauses(new clause.Locking({ Strength: "UPDATE", Options: "SKIP LOCKED" }));
      }
      const firstErr = q.First(row).Error;
      if (firstErr != null) {
        throw firstErr;
      }
      let until = new Date(now.getTime() + 2 * 60 * 1000);
      if (row.ReportState === "pending") {
        until = new Date(now.getTime() + 5 * 60 * 1000);
      }
      const result = tx.Model(new NotificationDelivery()).Where("id = ? AND status = ? AND attempts = ?", row.ID, row.Status, row.Attempts).Updates({ status: "sending", lease_until: until, lease_token: token, attempts: row.Attempts + 1 });
      if (result.Error != null) {
        throw result.Error;
      }
      if (result.RowsAffected !== 1) {
        throw gorm.ErrRecordNotFound;
      }
      row.Status = "sending";
      row.LeaseToken = token;
      row.LeaseUntil = until;
      row.Attempts++;
    });
  } catch (err) {
    if (err === gorm.ErrRecordNotFound) {
      return null;
    }
    throw err;
  }
  return row;
};

/**
 * 结束当前租约下的单次通知投递尝试，更新状态、错误详情与下次重试时间并清空租约；若状态为 `"sent"` 则写入发送完成时间。
 * 使用场景：通知投递 worker 完成一次外部发送调用后回写最终或重试状态。
 *
 * @param {NotificationDelivery} item - 当前持有的投递记录（需包含 `ID` 与 `LeaseToken`）。
 * @param {string} status - 投递结果状态（如 `"sent"`、`"pending"`、`"failed"` 等）。
 * @param {string} detail - 错误或结果详情文本。
 * @param {Date|null} next - 下次允许重试的时间。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
NotificationsRepo.prototype.FinishNotification = function (item, status, detail, next) {
  const updates = { status: status, last_error: detail, next_attempt_at: next, lease_until: null, lease_token: "" };
  if (status === "sent") {
    updates["sent_at"] = new Date();
  }
  const err = this.DB.Model(new NotificationDelivery()).Where("id = ? AND status = ? AND lease_token = ?", item.ID, "sending", item.LeaseToken).Updates(updates).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 将项目下处于可重试失败态且内容非 `"invalid"` 的通知投递记录重置为待发送状态并清零重试计数。
 * 使用场景：用户在通知记录列表手动点击重试失败消息时调用。
 *
 * @param {string} projectID - 所属项目 ID，用于限定操作范围。
 * @param {string} id - 待重试的通知投递记录主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败，或不存在符合重试条件的记录（抛出 `gorm.ErrRecordNotFound`）时抛出错误。
 */
NotificationsRepo.prototype.RetryNotification = function (projectID, id) {
  const result = this.DB.Model(new NotificationDelivery()).Where("id = ? AND project_id = ? AND (content_source IS NULL OR content_source <> 'invalid') AND status IN ?", id, projectID, ["failed", "awaiting_authorization", "target_unavailable"]).Updates({ status: "pending", attempts: 0, next_attempt_at: new Date(), last_error: "" });
  if (result.Error != null) {
    throw result.Error;
  }
  if (result.RowsAffected === 0) {
    throw gorm.ErrRecordNotFound;
  }
};

/**
 * 在运行状态写入的同一数据库事务内，根据刚产生的运行事件评估所有节点与 SOP 级通知绑定，
 * 渲染并冻结通知正文后幂等写入投递队列。
 * 使用场景：在 `RunsRepo` 追加运行事件并持久化运行状态时同步调用。
 *
 * @param {object} tx - 当前运行写入事务的 `gorm.DB` 句柄。
 * @param {object} run - 当前运行记录（`domain.Run`）。
 * @param {object} event - 触发通知评估的运行事件（`domain.RunEvent`）。
 * @param {number} seq - 该运行事件的递增序号，用于构造幂等去重键。
 * @returns {void} 无返回值。
 * @throws {Error} 事务内查询 Bot、序列化报告请求或写入投递记录失败时抛出错误。
 */
NotificationsRepo.prototype.enqueueRunNotifications = function (tx, run, event, seq) {
  const projectID = notificationRunProject(run);
  const nodeTrigger = notificationTrigger(event.Type);
  const runTrigger = { "run.succeeded": "succeeded", "run.failed": "failed" }[event.Type] ?? "";
  if (nodeTrigger === "" && runTrigger === "") {
    return;
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
      this.enqueueNotification(tx, key, binding, context, item);
    }
  }
};

/**
 * 为一次运行中的某个节点筛选待评估的通知绑定列表。
 * 普通工作流节点使用从 SOP 通知派生的节点提醒绑定；合成的 SOP 级虚拟节点（空 ID）使用其自身绑定，
 * 当整个运行失败且历史事件中无任何节点级失败事件时，回退为流程级 `"failed"` 提醒绑定。
 *
 * @param {object} run - 当前运行记录（`domain.Run`）。
 * @param {WorkflowNode} node - 工作流节点或合成的 SOP 级节点（`ID === ""`）。
 * @param {string} runTrigger - 整条运行的触发结果（`"succeeded"`、`"failed"` 或空字符串）。
 * @returns {object[]} 待评估的通知绑定数组（`domain.NotificationBinding[]`）。
 */
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

/**
 * 判断运行事件列表中是否已记录过至少一条节点级失败事件。
 * 使用场景：供 `runNotificationBindings` 决定运行失败时是否需要补发 SOP 级失败兜底提醒。
 *
 * @param {object[]} events - 运行事件数组（`domain.RunEvent[]`）。
 * @returns {boolean} 存在非空 `NodeID` 且映射为 `"failed"` 的事件时返回 `true`，否则返回 `false`。
 */
function runHasNodeFailureEvent(events) {
  for (const event of events) {
    if (notificationTrigger(event.Type) === "failed" && event.NodeID !== "") {
      return true;
    }
  }
  return false;
}

/**
 * 在定时任务或助手任务执行结果写回的同一事务内，按命中的绑定逐条渲染并入队通知投递记录。
 * 使用场景：在 `CatalogRepo`（定时任务）与 `AssistantRepo`（助手定时任务）保存执行结果时调用。
 *
 * @param {object} tx - 当前事务的 `gorm.DB` 句柄。
 * @param {string} sourceType - 通知来源类型（如 `"schedule_job"`、`"assistant_task"`）。
 * @param {string} id - 来源任务唯一标识。
 * @param {string} projectID - 所属项目 ID。
 * @param {string} name - 任务展示名称。
 * @param {string} trigger - 触发事件类型（如 `"succeeded"`、`"failed"`）。
 * @param {Date} at - 本次执行完成时间戳，用于拼接毫秒级幂等去重键。
 * @param {object[]} bindings - 任务快照中记录的通知绑定列表（`domain.NotificationBinding[]`）。
 * @param {string} result - 任务执行输出正文。
 * @param {string} errorText - 任务失败时的错误信息文本。
 * @returns {void} 无返回值。
 * @throws {Error} 事务内入队任一通知失败时抛出错误。
 */
NotificationsRepo.prototype.enqueueTaskNotifications = function (tx, sourceType, id, projectID, name, trigger, at, bindings, result, errorText) {
  for (const binding of bindings) {
    if (!notificationEventSelected(binding, trigger)) {
      continue;
    }
    const values = { project: this.notificationProjectName(tx, projectID), "task.name": name, status: notificationStatus(trigger, "任务"), error: errorText, "issue.title": "未关联需求" };
    const item = new NotificationDelivery({ ProjectID: projectID, BotID: binding.BotID, EventType: trigger, SourceType: sourceType, SourceID: id, SourceName: name });
    const key = `${sourceType}:${id}:${at.getTime()}:${trigger}:${binding.BotID}`;
    const context = new NotificationContext({ Values: values, Result: result, Fallback: name + "：" + values["status"] + "。请在平台查看详情。", SourceType: sourceType });
    this.enqueueNotification(tx, key, binding, context, item);
  }
};

/**
 * 在事务内查询项目展示名称，若项目不存在或读取失败则回退返回项目 ID 本身。
 * 使用场景：运行与任务通知入队时填充 `{{project}}` 模板变量。
 *
 * @param {object} tx - 当前事务的 `gorm.DB` 句柄。
 * @param {string} id - 项目唯一标识。
 * @returns {string} 项目名称；查不到时返回原始 `id`。
 */
NotificationsRepo.prototype.notificationProjectName = function (tx, id) {
  const [project, ok] = this.projects.projectInTx(tx, id);
  if (ok) {
    return project.Name;
  }
  return id;
};

/**
 * 判断通知绑定的触发事件列表中是否包含指定事件名。
 *
 * @param {object} binding - 通知绑定配置（`domain.NotificationBinding`）。
 * @param {string} event - 待检查的事件名（如 `"succeeded"`、`"failed"`、`"waiting"`）。
 * @returns {boolean} 包含该事件返回 `true`，否则返回 `false`。
 */
function notificationEventSelected(binding, event) {
  return binding.Events.includes(event);
}

/**
 * 根据触发结果与范围前缀拼装面向用户的中文状态文案。
 *
 * @param {string} trigger - 归一化后的触发类型（`"succeeded"`、`"failed"` 或 `"waiting"`）。
 * @param {string} scope - 范围中文前缀（如 `"节点"`、`"SOP"`、`"任务"`）。
 * @returns {string} 中文状态描述文本。
 */
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

/**
 * 在指定事务中校验目标 Bot 状态、渲染通知正文（渲染失败时记录为无效失败项而非回滚主事务），
 * 若命中 SOP 完成的 AI 报告条件则附加异步报告请求，最后以去重键哈希作为主键幂等插入投递表。
 * 使用场景：供 `enqueueRunNotifications` 与 `enqueueTaskNotifications` 统一调用。
 *
 * @param {object} tx - 当前事务的 `gorm.DB` 句柄。
 * @param {string} key - 本次通知的确定性去重键字符串，用于计算 SHA-256 主键。
 * @param {object} binding - 通知绑定配置（`domain.NotificationBinding`）。
 * @param {NotificationContext} context - 通知模板渲染上下文。
 * @param {NotificationDelivery} item - 预填来源与归属信息的投递记录对象。
 * @returns {void} 无返回值。
 * @throws {Error} 查询机器人、JSON 编解码或插入投递表失败时抛出错误。
 */
NotificationsRepo.prototype.enqueueNotification = function (tx, key, binding, context, item) {
  const row = new notificationBotRow();
  const err = tx.Where("id = ?", binding.BotID).First(row).Error;
  if (err === gorm.ErrRecordNotFound) {
    return;
  } else if (err != null) {
    throw err;
  }
  const bot = new NotificationBot(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
  if (!bot.Enabled || bot.Target == null || bot.ProjectID !== item.ProjectID) {
    return;
  }
  item.ID = hexSHA256(key);
  item.TargetID = bot.Target.ID;
  item.TargetName = bot.Target.Name;
  item.TargetType = bot.Target.Type;
  let content = "";
  let source = "";
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
    const request = JSON.stringify(new NotificationReportRequest({ Binding: binding, Context: context }));
    item.ReportRequest = request;
    item.ReportState = "pending";
    item.ReportModel = bot.Model;
    if (item.ReportModel === "") {
      item.ReportModel = DefaultNotificationReportModel;
    }
  }
  item.CreatedAt = new Date();
  item.NextAttemptAt = item.CreatedAt;
  const createErr = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(item).Error;
  if (createErr != null) {
    throw createErr;
  }
};

/**
 * 使用默认数据库连接校验一组通知绑定的数量、去重、模板规则、项目归属以及目标会话绑定状态。
 * 使用场景：供 `CatalogRepo.validateWorkflowNotifications` 与接口层校验流程通知配置。
 *
 * @param {string} projectID - 所属项目 ID。
 * @param {object[]} bindings - 待校验的通知绑定数组（`domain.NotificationBinding[]`）。
 * @param {boolean} task - 是否为定时任务场景（为 `true` 时禁止 `"run"` 范围与 `"waiting"` 事件）。
 * @returns {void} 无返回值。
 * @throws {Error} 任一校验规则不满足时抛出错误。
 */
NotificationsRepo.prototype.ValidateNotificationBindings = function (projectID, bindings, task) {
  this.validateNotificationBindings(this.DB, projectID, bindings, task);
};

/**
 * 在指定数据库句柄（主库或事务）上校验一组通知绑定配置是否合法且均指向当前项目已绑定会话的 Bot。
 * 使用场景：供 `ValidateNotificationBindings` 以及定时任务/助手任务写事务内部复用。
 *
 * @param {object} db - 用于查询 `notification_bots` 的 `gorm.DB` 句柄或事务句柄。
 * @param {string} projectID - 所属项目 ID。
 * @param {object[]} bindings - 待校验的通知绑定数组（`domain.NotificationBinding[]`）。
 * @param {boolean} task - 是否为定时任务场景（仅允许成功或失败通知）。
 * @returns {void} 无返回值。
 * @throws {Error} 数量超过 3 个、Bot 为空或重复、绑定规则非法、任务配置了不支持的范围/事件、Bot 不属于当前项目或未绑定接收会话时抛出错误。
 */
NotificationsRepo.prototype.validateNotificationBindings = function (db, projectID, bindings, task) {
  if (bindings.length > 3) {
    throw new Error("最多配置 3 个通知 Bot");
  }
  const seen = {};
  for (const binding of bindings) {
    if (binding.BotID === "" || seen[binding.BotID]) {
      throw new Error("通知 Bot 不能为空或重复");
    }
    seen[binding.BotID] = true;
    ValidateNotificationBinding(binding);
    if (task && (binding.Scope === "run" || notificationEventSelected(binding, "waiting"))) {
      throw new Error("定时任务通知仅支持成功或失败");
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
      throw new Error("通知 Bot 不属于当前项目");
    }
    if (bot.Target == null) {
      throw new Error("请先为通知 Bot 绑定接收会话");
    }
  }
};

/**
 * 解析运行记录归属的项目 ID：优先取执行上下文中的 `ProjectID`，为空时回退至工作流快照中的 `ProjectID`。
 *
 * @param {object} run - 运行记录对象（`domain.Run`）。
 * @returns {string} 归属的项目 ID。
 */
function notificationRunProject(run) {
  if (run.ExecutionContext.ProjectID !== "") {
    return run.ExecutionContext.ProjectID;
  }
  return run.WorkflowSnapshot.ProjectID;
}

/**
 * 直接插入一条通知投递记录到数据库。
 * 使用场景：测试构造投递数据或管理端显式创建单条通知投递记录时调用。
 *
 * @param {NotificationDelivery} item - 待写入的通知投递记录。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
NotificationsRepo.prototype.CreateNotificationDelivery = function (item) {
  const err = this.DB.Create(item).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 将运行事件类型字符串映射为通知触发类别（`"succeeded"`、`"failed"`、`"waiting"` 或空字符串）。
 *
 * @param {string} eventType - 原始运行事件类型（如 `"node.succeeded"`、`"approval.waiting"`）。
 * @returns {string} 归一化后的通知触发类别；不触发节点通知的事件返回 `""`。
 */
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

/**
 * 查询全平台所有已启用且开启了交互式对话能力的通知机器人，按 ID 升序排列。
 * 使用场景：Bot 长连接管理器启动与轮询时加载需要维持连接的交互机器人列表。
 *
 * @returns {NotificationBot[]} 启用且支持交互的通知机器人数组。
 * @throws {Error} 数据库查询或 JSON 反序列化失败时抛出错误。
 */
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

/**
 * 按主键 ID 查询单条通知投递记录。
 * 使用场景：查询投递详情、处理卡片回调或验证投递状态时调用。
 *
 * @param {string} id - 通知投递记录主键 ID。
 * @returns {NotificationDelivery} 查询到的通知投递记录。
 * @throws {Error} 记录不存在或数据库查询失败时抛出错误。
 */
NotificationsRepo.prototype.NotificationDelivery = function (id) {
  const item = new NotificationDelivery();
  const err = this.DB.First(item, "id = ?", id).Error;
  if (err != null) {
    throw err;
  }
  return item;
};

// 当跨项目或同项目试图同时启用多个绑定同一外部 BotID 的交互式机器人时抛出的哨兵错误。
const ErrInteractiveBotAlreadyExists = new Error("同一企业微信 Bot 只能有一个启用的对话配置");

module.exports = { notificationBotRow, runNotificationBindings, runHasNodeFailureEvent, notificationEventSelected, notificationStatus, notificationRunProject, notificationTrigger, ErrInteractiveBotAlreadyExists };
