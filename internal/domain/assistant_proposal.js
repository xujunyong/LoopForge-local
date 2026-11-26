/**
 * @file internal/domain/assistant_proposal.js
 * 对应 Go 源文件：internal/domain/assistant_proposal.go
 *
 * 作用与职责边界：
 * 定义助手主动提议与“帮我批准”写操作草稿的处置结果状态常量，
 * 供会话提议交互、审批决策持久化与前端展示复用。
 * 仅包含状态常量，不包含提议状态流转逻辑。
 */

"use strict";

// 用户或评审已接受该提议。
const AssistantProposalAccepted = "accepted";
// 用户拒绝该提议，但后续仍允许继续提出新提议。
const AssistantProposalDeclined = "declined";
// 用户拒绝并在当前会话剩余时间内关闭同类提议。
const AssistantProposalMuted = "muted";
// 阻塞型提议在超时时间内无人应答，主助手自行继续完成工作。
const AssistantProposalExpired = "expired";
// 在“帮我批准”模式下，独立 AI 评审员或快通道策略直接拒绝了写操作草稿，未询问人工。
const AssistantDraftRejected = "rejected";

module.exports = { AssistantProposalAccepted, AssistantProposalDeclined, AssistantProposalMuted, AssistantProposalExpired, AssistantDraftRejected };
