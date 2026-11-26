/**
 * @file internal/managedcli/command_other.js
 * @description 对应 Go 文件：internal/managedcli/command_other.go（构建标签 `!linux && !darwin`）。
 * 作用与职责边界：提供非 Linux/macOS 平台的命令进程组配置实现，直接报错拒绝执行托管 CLI 更新。
 * 语法差异说明：
 * - Go 通过构建标签在编译期二选一；JS 由 `command_capture.js` 在加载时按 `process.platform` 决定引用本文件或 `command_unix.js`；
 * - 仅返回 `error` 的函数译为直接 `throw new Error(...)`。
 */

"use strict";

/**
 * 配置外部命令的进程组属性（非 Linux/macOS 平台不支持，直接抛出错误）。
 * 使用场景：在非 Linux/macOS 环境下由 `command_capture.js` 的 `executeCommand` 调用，用于快速拒绝托管 CLI 更新。
 *
 * @param {object} cmd 命令上下文对象（对应 Go 的 `*exec.Cmd`，本平台未使用）。
 * @returns {void} 无返回值；本平台始终抛出不支持错误。
 */
function configureCommandGroup(cmd) {
  throw new Error("managed CLI updates are supported only on Linux and macOS");
}

module.exports = { configureCommandGroup };
