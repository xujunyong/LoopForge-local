/**
 * @file internal/repo/notification_project_context.js
 * 对应 Go 源文件：internal/repo/notification_project_context.go
 *
 * 作用与职责边界：
 * 为 `ProjectsRepo` 提供在外部数据库事务内按主键读取单个 `domain.Project` 载荷的辅助方法，
 * 供通知入队流程在同一个写事务中获取项目名称等上下文信息。
 * 不负责项目成员加载、写操作或权限校验。
 *
 * 语法差异说明：
 * - Go 的泛型调用 `payloadOne[domain.Project](tx, "projects", id)` 在 JS 中通过显式传入构造函数 `Project` 表达。
 * - Go 的 `(domain.Project, bool)` 多返回值在 JS 中译为二元组 `[Project, boolean]`。
 */

"use strict";

const { Project } = require("../domain/project.js"); // 对应 Go 的 domain.Project，project.js 已翻译
const { payloadOne } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { ProjectsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译

/**
 * 在指定数据库事务中按主键读取一条项目记录，供通知渲染补充项目名称上下文。
 * 使用场景：在 `NotificationsRepo.notificationProjectName` 解析项目展示名称时调用。
 *
 * @param {object} tx - 当前事务的 `gorm.DB` 句柄。
 * @param {string} id - 项目记录主键 ID。
 * @returns {[Project, boolean]} 二元组 `[项目实体, 是否存在并解码成功]`；未找到或解码失败时返回 `[new Project(), false]`。
 */
ProjectsRepo.prototype.projectInTx = function (tx, id) {
  return payloadOne(Project, tx, "projects", id);
};
