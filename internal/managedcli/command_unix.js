/**
 * @file internal/managedcli/command_unix.js
 * @description 对应 Go 文件：internal/managedcli/command_unix.go（构建标签 `linux || darwin`）。
 * 作用与职责边界：为 Linux/macOS 平台的外部命令配置独立进程组与整组强杀回调，防止取消或超时后遗留孙进程。
 * 语法差异说明：
 * - Go 通过构建标签在编译期二选一；JS 由 `command_capture.js` 在加载时按 `process.platform` 决定引用本文件或 `command_other.js`；
 * - `exec.Cmd` 译为命令配置对象，`SysProcAttr.Setpgid` 译为 `cmd.detached = true`，`syscall.Kill(-pid, SIGKILL)` 译为 `process.kill(-pid, "SIGKILL")`；
 * - 仅返回 `error` 的 Go 函数译为成功返回 `undefined`、失败抛出 `Error`。
 */

"use strict";

/**
 * 为命令配置独立进程组标志与整组强杀回调。
 * 使用场景：在 Linux/macOS 环境下由 `command_capture.js` 的 `executeCommand` 在启动子进程前调用。
 *
 * @param {{ detached: boolean, cancel: (() => void)|null, child: import("node:child_process").ChildProcess|null }} cmd 命令配置与运行时句柄对象。
 * @returns {void} 无返回值；直接修改 `cmd.detached` 与 `cmd.cancel`。
 */
function configureCommandGroup(cmd) {
  cmd.detached = true; // Go：cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
  cmd.cancel = () => {
    if (cmd.child == null || cmd.child.pid == null) {
      throw new Error("os: process already finished"); // Go：os.ErrProcessDone
    }
    try {
      process.kill(-cmd.child.pid, "SIGKILL");
    } catch (err) {
      if (err.code === "ESRCH") {
        throw new Error("os: process already finished"); // Go：os.ErrProcessDone
      }
      throw err;
    }
  };
}

module.exports = { configureCommandGroup };
