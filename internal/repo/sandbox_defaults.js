// sandbox_defaults.js —— 对应 Go 文件：internal/repo/sandbox_defaults.go
// 作用：默认沙箱画像：未指定时工作流运行的内置通用 Docker 沙箱。

"use strict";

const { GenericDockerSandboxID } = require("./generic_workflows.js"); // 对应 Go 同包常量，generic_workflows.js 已翻译

const DefaultSandboxProfileID = GenericDockerSandboxID;

module.exports = { DefaultSandboxProfileID };
