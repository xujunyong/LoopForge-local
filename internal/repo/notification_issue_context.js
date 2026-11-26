/**
 * @file internal/repo/notification_issue_context.js
 * 对应 Go 源文件：internal/repo/notification_issue_context.go
 *
 * 作用与职责边界：
 * 为 `IssuesRepo` 提供在外部数据库事务内按主键读取单个 `domain.Issue` 载荷的辅助方法，
 * 供通知入队流程在同一个写事务中填充需求标题与需求 ID 上下文。
 * 不负责需求的写操作、权限校验或跨表关联加载。
 *
 * 语法差异说明：
 * - Go 的泛型调用 `payloadOne[domain.Issue](tx, "issues", id)` 在 JS 中通过显式传入构造函数 `Issue` 表达。
 * - Go 的 `(domain.Issue, bool)` 多返回值在 JS 中译为二元组 `[Issue, boolean]`。
 */

"use strict";

const { Issue } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue，issue.js 已翻译
const { payloadOne } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { IssuesRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译

/**
 * 在指定数据库事务中按主键读取一条需求记录，供通知渲染补充关联需求上下文。
 * 使用场景：在 `NotificationsRepo.enqueueRunNotifications` 拼装运行通知模板变量时调用。
 *
 * @param {object} tx - 当前事务的 `gorm.DB` 句柄。
 * @param {string} id - 需求记录主键 ID。
 * @returns {[Issue, boolean]} 二元组 `[需求实体, 是否存在并解码成功]`；未找到或解码失败时返回 `[new Issue(), false]`。
 */
IssuesRepo.prototype.issueInTx = function (tx, id) {
  return payloadOne(Issue, tx, "issues", id);
};
