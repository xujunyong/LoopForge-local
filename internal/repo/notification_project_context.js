// notification_project_context.js —— 对应 Go 文件：internal/repo/notification_project_context.go
// 作用：通知投递在事务内读取 project 上下文。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { Project } = require("../domain/project.js"); // 对应 Go 的 domain.Project，project.js 已翻译
const { payloadOne } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { ProjectsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

ProjectsRepo.prototype.projectInTx = function (tx, id) {
  return payloadOne(Project, tx, "projects", id);
};
