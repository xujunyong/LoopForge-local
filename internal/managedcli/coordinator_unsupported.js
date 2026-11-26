/**
 * @file internal/managedcli/coordinator_unsupported.js
 * @description 对应 Go 文件：internal/managedcli/coordinator_unsupported.go（构建标签 `!linux && !darwin`）。
 * 作用与职责边界：提供非 Linux/macOS 平台的协调锁占位实现，打开锁文件与尝试加锁均直接返回不支持错误。
 * 语法差异说明：
 * - Go 通过构建标签在编译期二选一；JS 由 `coordinator.js` 在加载时按 `process.platform` 决定引用本文件或 `coordinator_unix.js`；
 * - `(值, error)` 失败路径译为 `throw new Error(...)`。
 */

"use strict";

/**
 * 打开协调锁文件（非 Linux/macOS 平台不支持，直接抛出错误）。
 * 使用场景：在非 Linux/macOS 环境下由 `coordinator.js` 的 `lock` 函数调用。
 *
 * @param {string} root 托管 CLI 根目录绝对路径（本平台未使用）。
 * @param {string} name 锁文件名（本平台未使用）。
 * @returns {never} 不返回；始终抛出平台不支持错误。
 */
function openCoordinatorLock(root, name) {
  throw new Error("managed CLI coordination is supported only on Linux and macOS");
}

/**
 * 尝试获取协调文件锁（非 Linux/macOS 平台不支持，直接抛出错误）。
 * 使用场景：在非 Linux/macOS 环境下由 `coordinator.js` 的 `waitForLock` 函数调用。
 *
 * @param {object} file 锁文件句柄对象（本平台未使用）。
 * @param {boolean} exclusive 是否获取排他锁（本平台未使用）。
 * @returns {never} 不返回；始终抛出平台不支持错误。
 */
function tryCoordinatorLock(file, exclusive) {
  throw new Error("managed CLI coordination is unsupported on this platform");
}

module.exports = { openCoordinatorLock, tryCoordinatorLock };
