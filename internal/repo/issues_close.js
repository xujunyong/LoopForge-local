/**
 * @file internal/repo/issues_close.js
 * 对应 Go 源文件：internal/repo/issues_close.go
 *
 * 作用与职责边界：
 * 实现需求领域仓储 `IssuesRepo` 的手动关闭能力：关闭前校验该需求当前不存在进行中的澄清或 SOP 执行，
 * 校验通过后将需求状态置为 `"closed"`、关闭来源置为 `"manual"` 且自动化状态置为 `"ignored"`。
 * 不负责需求删除清理（见 `issues_delete.js`）或基础读写（见 `issues.js`）。
 *
 * 语法差异说明：
 * - `IssuesRepo` 定义于 `repo.js`，本文件通过 `IssuesRepo.prototype` 挂载 `CloseIssue` 方法。
 * - Go 的 `(domain.Issue, error)` 译为成功返回 `Issue`、失败抛出 `Error`；传给 `PatchIssue` 的补丁回调同样遵循失败抛错、成功无返回值的统一约定。
 */

"use strict";

const { IssuesRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译

/** 需求存在正在进行的澄清或 SOP 执行时禁止关闭所抛出的错误。 */
const ErrIssueCloseBusy = new Error("需求正在澄清或执行 SOP，请先停止后再关闭");

/**
 * 手动关闭指定需求；若该需求存在进行中的澄清或未结束的执行记录，则拒绝关闭并抛出 `ErrIssueCloseBusy`。
 * 通过 `PatchIssue` 在统一写路径中完成状态校验与更新。
 *
 * @param {string} issueID - 待关闭的需求 ID。
 * @returns {import("../domain/issue.js").Issue} 关闭并持久化后的最新需求对象。
 * @throws {Error} 需求不存在、关闭准入校验失败（`ErrIssueCloseBusy`）或数据库更新失败时抛出错误。
 */
IssuesRepo.prototype.CloseIssue = function (issueID) {
  return this.PatchIssue(issueID.trim(), (issue) => {
    const allowed = this.IssueClosureAllowed([issue]);
    if (!allowed[issue.ID]) {
      throw ErrIssueCloseBusy;
    }
    issue.Status = "closed";
    issue.CloseSource = "manual";
    issue.AutomationState = "ignored";
  });
};

module.exports = { ErrIssueCloseBusy };
