// notification_issue_context.js —— 对应 Go 文件：internal/repo/notification_issue_context.go
// 作用：通知投递在事务内读取 issue 上下文。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { Issue } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue，issue.js 已翻译
const { payloadOne } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { IssuesRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

IssuesRepo.prototype.issueInTx = function (tx, id) {
  return payloadOne(Issue, tx, "issues", id);
};
