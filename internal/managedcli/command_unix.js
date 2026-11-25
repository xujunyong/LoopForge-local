// command_unix.js —— 对应 Go 文件：internal/managedcli/command_unix.go
// 作用：Linux/macOS 平台的命令组配置：新进程组 + 整组 SIGKILL。
// Go 的 //go:build linux || darwin 译为本文件与 command_other.js 二选一；
// JS 无构建标签，两个文件同时存在时以后加载的为准，见 index.js 的说明。
// os/exec.Cmd 译为 child_process 的 spawn 选项对象，SysProcAttr.setpgid 译为 detached。

"use strict";

function configureCommandGroup(cmd) {
  cmd.detached = true; // Go：cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
  cmd.cancel = () => {
    if (cmd.child == null) {
      throw new Error("process already finished"); // Go：os.ErrProcessDone
    }
    try {
      process.kill(-cmd.child.pid, "SIGKILL");
    } catch (err) {
      if (err.code === "ESRCH") {
        throw new Error("process already finished"); // Go：os.ErrProcessDone
      }
      throw err;
    }
  };
}

module.exports = { configureCommandGroup };
