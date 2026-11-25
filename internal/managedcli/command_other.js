// command_other.js —— 对应 Go 文件：internal/managedcli/command_other.go
// 作用：非 Linux/macOS 平台的命令组配置：托管 CLI 更新仅支持 Linux 与 macOS。
// Go 的 //go:build !linux && !darwin 译为本文件与 command_unix.js 二选一；
// JS 无构建标签，两个文件同时存在时以后加载的为准，见 index.js 的说明。

"use strict";

function configureCommandGroup(cmd) {
  throw new Error("managed CLI updates are supported only on Linux and macOS");
}

module.exports = { configureCommandGroup };
