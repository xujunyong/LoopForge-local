// room.js —— 对应 Go 文件：internal/domain/room.go
// 作用：项目群聊房间与消息类型。

"use strict";

// ChatRoom：项目群聊；项目里的任何人都能读写，房间里展示的成员就是项目成员列表。
class ChatRoom {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Name = init.Name ?? "";
    this.CreatedBy = init.CreatedBy ?? 0;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

// ChatMember：房间旁展示的项目成员。
class ChatMember {
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.Name = init.Name ?? "";
    this.Role = init.Role ?? "";
  }
}

// ChatRoomView：房间与其可见成员。
class ChatRoomView extends ChatRoom {
  constructor(init = {}) {
    super(init);
    this.Members = init.Members ?? [];
  }
}

// ChatMessage：一次群聊发言；kind "text" 是对话；"dispatch" 记录房间里创建并交给 SOP 的需求；"progress" 是失败或运行的最终结果，已完成步骤留在派单卡片上；"approval" 是等人的步骤，"decision" 记录成员批准或打回；TargetType "role" / "both" 与 AgentID 留在旧消息上，那时房间无需启动 SOP 就能指派角色。
class ChatMessage {
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

    // 派单卡片上的运行进度；运行未完成时实时填充，RunTotal / RunCompleted 与 RunFinal 一起持久化， settled 的卡片永不重载运行。
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

// ChatMessage 的 kind。
const ChatKindText = "text";
const ChatKindDispatch = "dispatch";
const ChatKindProgress = "progress";
const ChatKindApproval = "approval";
const ChatKindDecision = "decision";

module.exports = { ChatRoom, ChatMember, ChatRoomView, ChatMessage, ChatKindText, ChatKindDispatch, ChatKindProgress, ChatKindApproval, ChatKindDecision };
