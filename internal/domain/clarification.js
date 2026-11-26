/**
 * 对应 Go 文件：internal/domain/clarification.go
 * 作用：定义需求澄清轮次的状态常量、开场提示语，以及是否恢复中断澄清轮次的判定函数。
 * 职责边界：仅负责澄清状态枚举与服务端恢复判定，不涉及具体会话执行或持久化。
 */

"use strict";

/** 澄清进行中状态。 */
const ClarificationInProgress = "in_progress";
/** 澄清已完成、信息就绪状态。 */
const ClarificationReady = "ready";
/** 澄清需要用户补充信息状态。 */
const ClarificationNeedsUser = "needs_user";
/** 澄清正在由 AI 分析中的状态。 */
const ClarificationAnalyzing = "analyzing";
/** 澄清首轮发送给 AI 的默认开场提示语。 */
const ClarificationKickoff = "请先检查这张工作项的描述和相关代码，告诉我还缺哪些关键信息。";

/**
 * 判断服务端是否应在无浏览器参与的情况下恢复一轮 AI 澄清分析。
 * 澄清始终由用户发起，仅当分析中途崩溃（状态仍停留在 analyzing）时才由服务端续跑。
 *
 * @param {import("./issue.js").Issue} issue - 待检查的工作项对象，需包含 ID 与 Clarification.Status 字段。
 * @returns {boolean} 若工作项 ID 非空且澄清状态为 analyzing 返回 true，否则返回 false。
 */
function ShouldResumeClarification(issue) {
  return issue.ID.trim() !== "" && issue.Clarification.Status === ClarificationAnalyzing;
}

module.exports = {
  ClarificationInProgress,
  ClarificationReady,
  ClarificationNeedsUser,
  ClarificationAnalyzing,
  ClarificationKickoff,
  ShouldResumeClarification,
};
