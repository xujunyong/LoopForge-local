/**
 * @file internal/domain/room.js
 * @description 对应 Go 源文件：internal/domain/room.go
 * 职责边界：定义项目群聊房间、房间成员、房间视图以及包含文本、派单、进度、审批与决策等类型的群聊消息模型。
 * 语法差异说明：
 * - Go 的匿名嵌入 `type ChatRoomView struct { ChatRoom; ... }` 使用类继承 `extends ChatRoom` 表达。
 * - Go 的 `time.Time` 对应 JS 的 `Date | null`（零值为 `null`）。
 */

"use strict";

/**
 * 项目群聊房间实体。
 * 项目内任意成员均可读取与发言，房间展示成员即该项目成员列表。
 */
class ChatRoom {
  /**
   * 构造群聊房间实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - 房间主键 ID。
   * @param {string} [init.ProjectID=""] - 所属项目 ID。
   * @param {string} [init.Name=""] - 房间名称。
   * @param {number} [init.CreatedBy=0] - 创建人用户 ID。
   * @param {Date|null} [init.CreatedAt=null] - 创建时间。
   * @param {Date|null} [init.UpdatedAt=null] - 最近更新时间。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Name = init.Name ?? "";
    this.CreatedBy = init.CreatedBy ?? 0;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

/**
 * 群聊房间侧边栏展示的项目成员信息。
 */
class ChatMember {
  /**
   * 构造群聊成员实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {number} [init.UserID=0] - 成员用户 ID。
   * @param {string} [init.Name=""] - 成员显示名称。
   * @param {string} [init.Role=""] - 成员在项目中的角色。
   */
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.Name = init.Name ?? "";
    this.Role = init.Role ?? "";
  }
}

/**
 * 群聊房间完整视图，在 `ChatRoom` 基础上附带可见成员列表。
 * 对应 Go 的 `ChatRoomView`（匿名嵌入 `ChatRoom`）。
 */
class ChatRoomView extends ChatRoom {
  /**
   * 构造群聊房间视图实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合（可包含 `ChatRoom` 字段与 `Members`）。
   * @param {ChatMember[]} [init.Members=[]] - 房间可见成员列表。
   */
  constructor(init = {}) {
    super(init);
    this.Members = init.Members ?? [];
  }
}

/**
 * 项目群聊中的单条消息记录。
 * 涵盖普通文本（`text`）、需求派单卡片（`dispatch`）、运行终态/失败进度（`progress`）、人工审批请求（`approval`）与审批决定（`decision`）等多种消息形态。
 */
class ChatMessage {
  /**
   * 构造群聊消息实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - 消息主键 ID。
   * @param {string} [init.RoomID=""] - 所属房间 ID。
   * @param {number} [init.UserID=0] - 发送者用户 ID。
   * @param {string} [init.Author=""] - 发送者展示名称。
   * @param {string} [init.Kind=""] - 消息类型（见 `ChatKind*` 常量）。
   * @param {string} [init.Body=""] - 消息正文内容。
   * @param {string} [init.IssueID=""] - 关联需求 ID。
   * @param {number} [init.IssueNumber=0] - 关联需求编号。
   * @param {string} [init.IssueTitle=""] - 关联需求标题。
   * @param {string} [init.TargetType=""] - 派单目标类型（sop、role 或 both）。
   * @param {string} [init.TargetID=""] - 派单目标 ID。
   * @param {string} [init.TargetName=""] - 派单目标展示名。
   * @param {string} [init.WorkflowID=""] - 关联工作流 ID。
   * @param {string} [init.AgentID=""] - 关联 Agent ID（兼容旧版角色指派消息）。
   * @param {string} [init.TaskID=""] - 关联任务 ID。
   * @param {string} [init.RunID=""] - 关联运行 ID。
   * @param {string} [init.DispatchError=""] - 派单失败原因。
   * @param {string} [init.WorkflowName=""] - 关联工作流名称。
   * @param {number} [init.Lane=0] - 多 SOP 派单时的通道序号（主需求卡片为 0）。
   * @param {string} [init.RunFinal=""] - 运行终态结果标记（终态收尾消息发出后写入派单消息）。
   * @param {string} [init.NodeID=""] - 进度/审批消息关联的节点 ID。
   * @param {string} [init.NodeName=""] - 进度/审批消息关联的节点名称。
   * @param {string} [init.NodeStatus=""] - 进度/审批消息关联的节点状态。
   * @param {number} [init.Attempt=0] - 节点尝试序号。
   * @param {string} [init.RunStatus=""] - 派单卡片上展示的运行状态。
   * @param {number} [init.RunTotal=0] - 派单卡片上展示的运行总步骤数。
   * @param {number} [init.RunCompleted=0] - 派单卡片上展示的已完成步骤数。
   * @param {string[]} [init.RunCurrent=[]] - 派单卡片上当前正在执行的节点名称列表。
   * @param {boolean} [init.Resolved=false] - 审批消息是否已处理完结。
   * @param {string} [init.ThreadID=""] - 需求空间旁支讨论线程 ID。
   * @param {boolean} [init.ToAI=false] - 该消息是否发往 AI 助手。
   * @param {string} [init.AIStatus=""] - AI 助手回复生成状态。
   * @param {string} [init.AIError=""] - AI 助手回复失败原因。
   * @param {string} [init.AISessionID=""] - 关联的 AI 助手会话 ID。
   * @param {number} [init.AIRequesterID=0] - 触发 AI 回复的请求人用户 ID。
   * @param {string} [init.AIProgress=""] - AI 回复流式进度文案。
   * @param {string} [init.ArtifactID=""] - 关联产物 ID。
   * @param {number} [init.ArtifactVersion=0] - 关联产物版本号。
   * @param {object[]} [init.Attachments=[]] - 随消息上传的附件列表（AssistantAttachment[]）。
   * @param {boolean} [init.CanReject=false] - 仅视图展示：当前等待审批的步骤是否允许打回。
   * @param {Date|null} [init.CreatedAt=null] - 消息创建时间。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.RoomID = init.RoomID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Author = init.Author ?? "";
    this.Kind = init.Kind ?? "";
    this.Body = init.Body ?? "";
    this.IssueID = init.IssueID ?? "";
    this.IssueNumber = init.IssueNumber ?? 0;
    this.IssueTitle = init.IssueTitle ?? "";
    this.TargetType = init.TargetType ?? "";
    this.TargetID = init.TargetID ?? "";
    this.TargetName = init.TargetName ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.AgentID = init.AgentID ?? "";
    this.TaskID = init.TaskID ?? "";
    this.RunID = init.RunID ?? "";
    this.DispatchError = init.DispatchError ?? "";
    this.WorkflowName = init.WorkflowName ?? "";
    // Lane > 0 标记多 SOP 派单里的额外 SOP；需求卡片本身是 lane 0。
    this.Lane = init.Lane ?? 0;
    // RunFinal 在运行到达终态且收尾进度消息发出后，写到派单消息上。
    this.RunFinal = init.RunFinal ?? "";

    // 以下为运行观察器写的进度 / 审批消息。
    this.NodeID = init.NodeID ?? "";
    this.NodeName = init.NodeName ?? "";
    this.NodeStatus = init.NodeStatus ?? "";
    this.Attempt = init.Attempt ?? 0;

    // 派单卡片上的运行进度；运行未完成时实时填充，RunTotal / RunCompleted 与 RunFinal 一起持久化，已落定的卡片永不重载运行。
    this.RunStatus = init.RunStatus ?? "";
    this.RunTotal = init.RunTotal ?? 0;
    this.RunCompleted = init.RunCompleted ?? 0;
    this.RunCurrent = init.RunCurrent ?? [];
    // Resolved 在步骤继续后持久化到审批消息上。
    this.Resolved = init.Resolved ?? false;

    // 需求空间字段；ThreadID 把旁支讨论留在主时间线之外，AI* 跟踪为该空间生成的助手回复。
    this.ThreadID = init.ThreadID ?? "";
    this.ToAI = init.ToAI ?? false;
    this.AIStatus = init.AIStatus ?? "";
    this.AIError = init.AIError ?? "";
    this.AISessionID = init.AISessionID ?? "";
    this.AIRequesterID = init.AIRequesterID ?? 0;
    this.AIProgress = init.AIProgress ?? "";
    this.ArtifactID = init.ArtifactID ?? "";
    this.ArtifactVersion = init.ArtifactVersion ?? 0;
    // Attachments 是作者随文本消息上传的文件；二进制留在作者的助手附件库。
    this.Attachments = init.Attachments ?? [];
    // CanReject 只作展示：等待步骤有可打回的地方。
    this.CanReject = init.CanReject ?? false;

    this.CreatedAt = init.CreatedAt ?? null;
  }
}

// ChatMessage 消息类型常量。
const ChatKindText = "text";
const ChatKindDispatch = "dispatch";
const ChatKindProgress = "progress";
const ChatKindApproval = "approval";
const ChatKindDecision = "decision";

module.exports = { ChatRoom, ChatMember, ChatRoomView, ChatMessage, ChatKindText, ChatKindDispatch, ChatKindProgress, ChatKindApproval, ChatKindDecision };
