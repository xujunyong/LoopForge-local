/**
 * @file internal/domain/notification.js
 * @description 对应 Go 源文件：internal/domain/notification.go
 * 职责边界：定义通知机器人、目标会话、通知绑定规则、通知报告请求与通知投递持久化记录等领域模型。
 * 语法差异说明：
 * - Go 的 `time.Time` / `*time.Time` 对应 JS 的 `Date | null`（零值为 `null`）。
 * - Go 的类型别名 `type NodeNotification = NotificationBinding` 译为常量引用。
 * - 为避免与 `notification_template.js` 发生循环引用，`NotificationReportRequest` 构造函数内延迟引入 `NotificationContext`。
 */

"use strict";

/**
 * 通知机器人绑定的目标会话（群聊或单聊）。
 * 用于保存机器人的目标会话标识与最近一次消息时间。
 */
class BotChat {
  /**
   * 构造目标会话实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - 会话唯一标识。
   * @param {string} [init.Name=""] - 会话展示名称。
   * @param {string} [init.Type=""] - 会话类型。
   * @param {string} [init.LastMessageTime=""] - 最近消息时间文本。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Type = init.Type ?? "";
    this.LastMessageTime = init.LastMessageTime ?? "";
  }
}

/**
 * 项目配置的通知机器人实体。
 * 用于描述机器人的归属、模型配置、启停状态、健康检查状态及绑定的目标会话。
 */
class NotificationBot {
  /**
   * 构造通知机器人实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - 机器人记录 ID。
   * @param {string} [init.ProjectID=""] - 所属项目 ID。
   * @param {number} [init.OwnerID=0] - 所属用户 ID。
   * @param {string} [init.Model=""] - 通知报告生成所使用的模型标识。
   * @param {string} [init.Name=""] - 机器人展示名称。
   * @param {string} [init.BotID=""] - 外部机器人平台 ID。
   * @param {boolean} [init.InteractionEnabled=false] - 是否开启交互式回复能力。
   * @param {boolean} [init.Enabled=false] - 是否启用该机器人。
   * @param {boolean} [init.SecretConfigured=false] - 是否已配置密钥或签名凭据。
   * @param {BotChat|null} [init.Target=null] - 绑定的目标会话。
   * @param {string} [init.Health=""] - 最近健康检查结果。
   * @param {Date|null} [init.LastCheckedAt=null] - 最近健康检查时间。
   * @param {Date|null} [init.CreatedAt=null] - 创建时间。
   * @param {Date|null} [init.UpdatedAt=null] - 最近更新时间。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.OwnerID = init.OwnerID ?? 0;
    this.Model = init.Model ?? "";
    this.Name = init.Name ?? "";
    this.BotID = init.BotID ?? "";
    this.InteractionEnabled = init.InteractionEnabled ?? false;
    this.Enabled = init.Enabled ?? false;
    this.SecretConfigured = init.SecretConfigured ?? false;
    this.Target = init.Target ?? null;
    this.Health = init.Health ?? "";
    this.LastCheckedAt = init.LastCheckedAt ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

/**
 * 机器人与触发事件、模板及 AI 编写指令的绑定配置。
 * 用于流程节点、整条流程或定时任务配置通知策略。
 */
class NotificationBinding {
  /**
   * 构造通知绑定配置实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.BotID=""] - 目标机器人 ID。
   * @param {string[]} [init.Events=[]] - 触发事件列表（如 succeeded、failed、waiting）。
   * @param {string} [init.Template=""] - 自定义通知模板正文。
   * @param {string} [init.Scope=""] - 触发范围（node 默认，或 run）。
   * @param {string} [init.ContentMode=""] - 内容生成方式（template 默认，或 ai）。
   * @param {string} [init.AIInstruction=""] - AI 通知内容的额外编写要求。
   * @param {string} [init.WaitingPolicy=""] - 等待事件的通知策略（如 actionable、event）。
   */
  constructor(init = {}) {
    this.BotID = init.BotID ?? "";
    this.Events = init.Events ?? [];
    this.Template = init.Template ?? "";
    this.Scope = init.Scope ?? "";
    this.ContentMode = init.ContentMode ?? "";
    this.AIInstruction = init.AIInstruction ?? "";
    this.WaitingPolicy = init.WaitingPolicy ?? "";
  }
}

// 节点通知绑定类型，对应 Go 类型别名 `NodeNotification = NotificationBinding`。
const NodeNotification = NotificationBinding;

// 默认通知报告生成模型名称。
const DefaultNotificationReportModel = "default";

/**
 * 一次通知报告生成所需的请求载荷。
 * 包含通知绑定配置与渲染上下文，通常序列化后写入投递记录以便异步生成报告。
 */
class NotificationReportRequest {
  /**
   * 构造通知报告请求实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {NotificationBinding} [init.Binding] - 通知绑定配置。
   * @param {object} [init.Context] - 通知渲染上下文（NotificationContext 实例）。
   */
  constructor(init = {}) {
    const { NotificationContext } = require("./notification_template.js");
    this.Binding = init.Binding ?? new NotificationBinding();
    this.Context = init.Context ?? new NotificationContext();
  }
}

/**
 * 单次通知投递的持久化记录。
 * 用于记录投递状态、重试调度、租约控制、AI 报告生成状态及发送结果。
 */
class NotificationDelivery {
  /**
   * 构造通知投递记录实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ReportRequest=""] - 序列化后的通知报告请求 JSON。
   * @param {string} [init.ReportState=""] - 报告生成状态。
   * @param {string} [init.ReportModel=""] - 报告生成所使用的模型。
   * @param {string} [init.ReportError=""] - 报告生成失败原因。
   * @param {string} [init.WaitingPolicy=""] - 等待通知策略。
   * @param {string} [init.SourceType=""] - 通知来源类型（如 run、schedule_job）。
   * @param {string} [init.SourceID=""] - 通知来源实体 ID。
   * @param {string} [init.SourceName=""] - 通知来源展示名称。
   * @param {string} [init.ContentSource=""] - 正文内容来源（如 template、ai、result_fallback）。
   * @param {string} [init.ID=""] - 投递记录主键 ID。
   * @param {string} [init.ProjectID=""] - 所属项目 ID。
   * @param {string} [init.BotID=""] - 关联机器人 ID。
   * @param {string} [init.RunID=""] - 关联运行 ID。
   * @param {string} [init.NodeID=""] - 关联节点 ID。
   * @param {string} [init.EventType=""] - 触发事件类型。
   * @param {string} [init.TargetID=""] - 投递目标会话 ID。
   * @param {string} [init.TargetType=""] - 投递目标类型。
   * @param {string} [init.TargetName=""] - 投递目标展示名称。
   * @param {string} [init.Content=""] - 最终发送的通知正文。
   * @param {string} [init.Status=""] - 投递状态。
   * @param {number} [init.Attempts=0] - 已投递重试次数。
   * @param {number} [init.Attempt=0] - 触发通知时节点的尝试序号。
   * @param {number} [init.ReworkCount=0] - 触发通知时节点的返工次数。
   * @param {Date|null} [init.NextAttemptAt=null] - 下次允许重试投递的时间。
   * @param {Date|null} [init.LeaseUntil=null] - 当前发送租约到期时间。
   * @param {string} [init.LeaseToken=""] - 发送租约令牌。
   * @param {string} [init.LastError=""] - 最近一次投递失败原因。
   * @param {Date|null} [init.CreatedAt=null] - 记录创建时间。
   * @param {Date|null} [init.SentAt=null] - 实际发送成功时间。
   */
  constructor(init = {}) {
    this.ReportRequest = init.ReportRequest ?? "";
    this.ReportState = init.ReportState ?? "";
    this.ReportModel = init.ReportModel ?? "";
    this.ReportError = init.ReportError ?? "";
    this.WaitingPolicy = init.WaitingPolicy ?? "";
    this.SourceType = init.SourceType ?? "";
    this.SourceID = init.SourceID ?? "";
    this.SourceName = init.SourceName ?? "";
    this.ContentSource = init.ContentSource ?? "";
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.BotID = init.BotID ?? "";
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.EventType = init.EventType ?? "";
    this.TargetID = init.TargetID ?? "";
    this.TargetType = init.TargetType ?? "";
    this.TargetName = init.TargetName ?? "";
    this.Content = init.Content ?? "";
    this.Status = init.Status ?? "";
    this.Attempts = init.Attempts ?? 0;
    this.Attempt = init.Attempt ?? 0;
    this.ReworkCount = init.ReworkCount ?? 0;
    this.NextAttemptAt = init.NextAttemptAt ?? null;
    this.LeaseUntil = init.LeaseUntil ?? null;
    this.LeaseToken = init.LeaseToken ?? "";
    this.LastError = init.LastError ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
    this.SentAt = init.SentAt ?? null;
  }

  /**
   * 返回 GORM 持久化对应的数据库表名。
   *
   * @returns {string} 数据库表名 `"notification_deliveries"`。
   */
  TableName() {
    return "notification_deliveries";
  }
}

module.exports = { BotChat, NotificationBot, NotificationBinding, NodeNotification, DefaultNotificationReportModel, NotificationReportRequest, NotificationDelivery };
