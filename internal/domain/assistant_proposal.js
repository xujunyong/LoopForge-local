// assistant_proposal.js —— 对应 Go 文件：internal/domain/assistant_proposal.go
// 作用：助手提议的处置结果常量。

"use strict";

const AssistantProposalAccepted = "accepted";
const AssistantProposalDeclined = "declined";
// AssistantProposalMuted：拒绝并在本会话剩余时间内关闭提议。
const AssistantProposalMuted = "muted";
// AssistantProposalExpired：阻塞提议无人及时应答，Main Bot 自行继续。
const AssistantProposalExpired = "expired";
// AssistantDraftRejected：独立 AI 评审员或快通道策略在“帮我批准”模式下拒写，未问人。
const AssistantDraftRejected = "rejected";

module.exports = { AssistantProposalAccepted, AssistantProposalDeclined, AssistantProposalMuted, AssistantProposalExpired, AssistantDraftRejected };
