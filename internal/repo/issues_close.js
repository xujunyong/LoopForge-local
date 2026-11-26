// issues_close.js —— 对应 Go 文件：internal/repo/issues_close.go
// 作用：手动关闭需求：仅当无进行中的澄清或 SOP 执行时才允许关闭。

"use strict";

const { IssuesRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

const ErrIssueCloseBusy = new Error("需求正在澄清或执行 SOP，请先停止后再关闭");

IssuesRepo.prototype.CloseIssue = function (issueID) {
  return this.PatchIssue(issueID.trim(), (issue) => {
    const allowed = this.IssueClosureAllowed([issue]);
    if (!allowed[issue.ID]) {
      return ErrIssueCloseBusy;
    }
    issue.Status = "closed";
    issue.CloseSource = "manual";
    issue.AutomationState = "ignored";
    return null;
  });
};

module.exports = { ErrIssueCloseBusy };
