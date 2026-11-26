/**
 * @file internal/managedcli/coordinator_unix.js
 * @description 对应 Go 文件：internal/managedcli/coordinator_unix.go（构建标签 `linux || darwin`）。
 * 作用与职责边界：提供 Linux/macOS 平台的协调锁文件打开与非阻塞 `flock` 接口，
 * 只允许打开永久常规文件，防止符号链接逃逸或删除锁文件导致分裂出独立锁域。
 * 语法差异说明：
 * - Go 通过构建标签在编译期二选一；JS 由 `coordinator.js` 在加载时按 `process.platform` 决定引用本文件或 `coordinator_unsupported.js`；
 * - `golang.org/x/sys/unix` 的 `Open`/`Openat` 标志位译为 `fs.constants` 同名标志位（Node 默认启用 `CLOEXEC`，无 `openat` 故用 `path.join`）；
 * - Node 标准库未暴露 `flock` 系统调用，`tryCoordinatorLock` 显式抛错并在注释中保留与 Go 原文的对应语义。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * 在托管 CLI 根目录下打开或首次创建永久常规锁文件，并校验目标不是符号链接或非常规文件。
 * 使用场景：在 Linux/macOS 环境下由 `coordinator.js` 的 `lock` 函数调用。
 *
 * @param {string} root 托管 CLI 根目录绝对路径。
 * @param {string} name 锁文件名（位于 `root` 目录下）。
 * @returns {{ fd: number, name: string, close: () => void }} 已校验的锁文件句柄对象；打开或校验失败时抛出错误。
 */
function openCoordinatorLock(root, name) {
  const C = fs.constants;
  let fd;
  try {
    // Go 使用 unix.Openat(目录 fd, name) 防目录替换；Node 无 openat，先按目录+不跟随符号链接校验根目录。
    fd = fs.openSync(root, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW, 0);
  } catch (err) {
    throw new Error(`open managed CLI root: ${err.message}`, { cause: err });
  }
  try {
    // 拆分首次创建与已存在打开：macOS 上并发 O_CREAT|O_NOFOLLOW 可能报 ENOENT，而 O_EXCL 会明确返回 EEXIST。
    const flags = C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK;
    const lockPath = path.join(root, name);
    let lockFD;
    try {
      lockFD = fs.openSync(lockPath, flags | C.O_CREAT | C.O_EXCL, 0o600);
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          lockFD = fs.openSync(lockPath, flags, 0);
        } catch (openErr) {
          throw new Error(`open managed CLI lock ${name}: ${openErr.message}`, { cause: openErr });
        }
      } else {
        throw new Error(`open managed CLI lock ${name}: ${err.message}`, { cause: err });
      }
    }
    const file = {
      fd: lockFD,
      name: lockPath,
      close() {
        fs.closeSync(lockFD);
      },
    };
    let info;
    try {
      info = fs.fstatSync(lockFD);
    } catch (err) {
      try {
        file.close();
      } catch {
        // 忽略关闭错误，抛出原始 stat 错误。
      }
      throw err;
    }
    if (!info.isFile()) {
      try {
        file.close();
      } catch {
        // 忽略关闭错误，抛出非常规文件错误。
      }
      throw new Error("lock must be a regular file");
    }
    return file;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 对应 Go 的 defer unix.Close(fd)，忽略关闭错误。
    }
  }
}

/**
 * 对已打开的锁文件尝试执行非阻塞 `flock`（共享锁或排他锁）。
 * 使用场景：在 Linux/macOS 环境下由 `coordinator.js` 的 `waitForLock` 轮询调用。
 *
 * @param {{ fd: number, name: string, close: () => void }} file 已打开的锁文件句柄对象。
 * @param {boolean} exclusive 是否请求排他锁（`true` 对应 `LOCK_EX`，`false` 对应 `LOCK_SH`）。
 * @returns {boolean} 是否成功获取锁；Go 语义下 `EWOULDBLOCK`/`EAGAIN`/`EINTR` 返回 `false`，其余错误抛出。当前 Node 标准库无 `flock`，直接抛出不支持错误。
 */
function tryCoordinatorLock(file, exclusive) {
  // Go 的 unix.Flock(int(file.Fd()), operation|unix.LOCK_NB) 在 Node 标准库无对应接口，无法直译。
  // Go 原语义：EWOULDBLOCK/EAGAIN/EINTR 返回 false（无错），加锁成功返回 true，其余系统错误抛出。
  throw new Error("managed CLI file locking (flock) has no Node.js equivalent");
}

module.exports = { openCoordinatorLock, tryCoordinatorLock };
