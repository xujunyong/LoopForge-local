// coordinator_unsupported.js —— 对应 Go 文件：internal/managedcli/coordinator_unsupported.go
// 作用：非 Linux/macOS 平台的锁文件打开与 flock：直接报错。
// Go 的 //go:build !linux && !darwin 译为本文件与 coordinator_unix.js 二选一；
// JS 无构建标签，两个文件同时存在时以后加载的为准，见 index.js 的说明。

"use strict";

function openCoordinatorLock(root, name) {
  throw new Error("managed CLI coordination is supported only on Linux and macOS");
}

function tryCoordinatorLock(file, exclusive) {
  throw new Error("managed CLI coordination is unsupported on this platform");
}

module.exports = { openCoordinatorLock, tryCoordinatorLock };
