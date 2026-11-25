// clarification.js —— 对应 Go 文件：internal/domain/clarification.go
// 作用：澄清轮次的状态常量与是否恢复中断澄清的判断。

"use strict";

const ClarificationInProgress = "in_progress";
const ClarificationReady = "ready";
const ClarificationNeedsUser = "needs_user";
const ClarificationAnalyzing = "analyzing";
const ClarificationKickoff = "请先检查这张工作项的描述和相关代码，告诉我还缺哪些关键信息。";

// ShouldResumeClarification：仅恢复分析中途崩溃的澄清轮次。
function ShouldResumeClarification(issue) {
  return issue.ID.trim() !== "" && issue.Clarification.Status === ClarificationAnalyzing;
}

module.exports = { ClarificationInProgress, ClarificationReady, ClarificationNeedsUser, ClarificationAnalyzing, ClarificationKickoff, ShouldResumeClarification };
