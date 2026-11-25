// work_branch.js —— 对应 Go 文件：internal/domain/work_branch.go
// 作用：按需求来源生成默认 Git 工作分支名，并清洗分支名片段。

"use strict";

// DefaultWorkBranch：按需求来源生成 Git 工作分支名。
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

function gongfengIssueNumber(issue) {
  if (issue.ExternalRef != null && issue.ExternalRef.ExternalIID > 0) {
    return issue.ExternalRef.ExternalIID;
  }
  return issue.Number;
}

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

// SafeGitRefSegment：把任意值转成单个 Git 引用片段。
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
