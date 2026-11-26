/**
 * @file internal/repo/sandbox_defaults.js
 * 对应 Go 源文件：internal/repo/sandbox_defaults.go
 *
 * 作用与职责边界：
 * 声明工作流未显式指定沙箱配置时回退使用的默认沙箱画像 ID 常量（指向内置只读通用 Docker 沙箱画像）。
 * 内置画像与 Dockerfile 仅为只读兜底，不属于数据库 seed 行，运维持久化的同名记录具有更高优先级。
 *
 * 语法差异说明：
 * - 与 Go 常量声明 1:1 对应，无特殊语法差异。
 */

"use strict";

const { GenericDockerSandboxID } = require("./generic_workflows.js"); // 对应 Go 同包常量，generic_workflows.js 已翻译

// 工作流未显式选择沙箱时默认使用的沙箱画像 ID。
const DefaultSandboxProfileID = GenericDockerSandboxID;

module.exports = { DefaultSandboxProfileID };
