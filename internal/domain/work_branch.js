/**
 * @file internal/domain/work_branch.js
 * @description 对应 Go 文件：internal/domain/work_branch.go
 * 职责与边界：根据需求/缺陷的来源（TAPD、工蜂或平台本地）和当前本地时间生成规范的默认 Git 工作分支名，
 * 并提供将任意标识清洗为合法单个 Git 引用片段的工具函数。
 * 语法差异说明：
 * - Go 的 `now.In(time.Local).Format("20060102-1504")` 译为 `Date` 本地时间分量拼接。
 */

"use strict";

/**
 * 按工作项来源和类型生成本次运行的默认 Git 工作分支名，末尾附带本地时间分钟级后缀以区分不同时间发起的派发。
 * 工蜂缺陷采用 `feature/fix-issue-{iid}-{suffix}`，TAPD 需求采用 `feature/story-{tapdId}-{suffix}`，平台需求采用 `feature/requirement-{number}-{suffix}`。
 * @param {Object} issue - `Issue` 需求或缺陷对象。
 * @param {Date} now - 用于生成时间后缀的当前时间对象。
 * @returns {string} 生成的默认 Git 工作分支名。
 */
function DefaultWorkBranch(issue, now) {
  // Go 的 now.In(time.Local).Format("20060102-1504")，JS 用本地时间取值。
  const pad = (n) => String(n).padStart(2, "0");
  const suffix = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const source = issue.Source.trim().toLowerCase();
  const kind = issue.Kind.trim().toLowerCase();

  if (source === "tapd" || issue.ID.trim().startsWith("tapd-")) {
    const id = tapdStoryID(issue);
    if (id !== "") {
      return "feature/story-" + SafeGitRefSegment(id) + "-" + suffix;
    }
  }
  if (source === "gongfeng" || kind === "issue") {
    const n = gongfengIssueNumber(issue);
    if (n > 0) {
      return `feature/fix-issue-${n}-${suffix}`;
    }
  }
  if (kind === "requirement" || source === "" || source === "local") {
    if (issue.Number > 0) {
      return `feature/requirement-${issue.Number}-${suffix}`;
    }
  }
  if (issue.Number > 0) {
    return `feature/fix-issue-${issue.Number}-${suffix}`;
  }
  if (issue.ID !== "") {
    return "feature/" + SafeGitRefSegment(issue.ID) + "-" + suffix;
  }
  return "feature/fix-" + suffix;
}

/**
 * 提取工蜂缺陷的外部编号（`ExternalRef.ExternalIID`）；未关联外部编号时回退到本地 `issue.Number`。
 * 供 `DefaultWorkBranch` 内部调用。
 * @param {Object} issue - `Issue` 缺陷对象。
 * @returns {number} 缺陷编号。
 */
function gongfengIssueNumber(issue) {
  if (issue.ExternalRef != null && issue.ExternalRef.ExternalIID > 0) {
    return issue.ExternalRef.ExternalIID;
  }
  return issue.Number;
}

/**
 * 提取 TAPD 需求 ID：优先读取 `ExternalRef.ExternalID`，为空时剥离本地 `issue.ID` 的 `"tapd-"` 前缀。
 * 供 `DefaultWorkBranch` 内部调用。
 * @param {Object} issue - `Issue` 需求对象。
 * @returns {string} 提取出的 TAPD 需求 ID 字符串。
 */
function tapdStoryID(issue) {
  if (issue.ExternalRef != null) {
    const id = issue.ExternalRef.ExternalID.trim();
    if (id !== "") {
      return id;
    }
  }
  const id = issue.ID.trim();
  return id.startsWith("tapd-") ? id.slice("tapd-".length) : id;
}

/**
 * 将任意字符串清洗为单个安全的 Git 引用路径片段：仅保留小写字母、数字、`-` 与 `_`，
 * 其余字符替换为 `-`，截断至 64 字符并去除首尾的 `-` 和 `.`；清洗为空时回退为 `"run"`。
 * 在构造工作分支名或其他 Git ref 名称时调用。
 * @param {string} value - 待清洗的原始字符串。
 * @returns {string} 可安全用于 Git 分支名片段的非空字符串。
 */
function SafeGitRefSegment(value) {
  let b = "";
  for (const r of value.toLowerCase()) {
    if ((r >= "a" && r <= "z") || (r >= "0" && r <= "9") || r === "-" || r === "_") {
      b += r;
    } else if (b.length > 0) {
      b += "-";
    }
    if (b.length >= 64) {
      break;
    }
  }
  const result = b.replace(/^[-.]+|[-.]+$/g, "");
  if (result === "") {
    return "run";
  }
  return result;
}

module.exports = { DefaultWorkBranch, SafeGitRefSegment };
