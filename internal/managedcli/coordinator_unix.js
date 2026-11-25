// coordinator_unix.js —— 对应 Go 文件：internal/managedcli/coordinator_unix.go
// 作用：Linux/macOS 的锁文件打开与 flock：只接受永久常规文件，防符号链接逃逸。
// Go 的 //go:build linux || darwin 译为本文件与 coordinator_unsupported.js 二选一；
// JS 无构建标签，两个文件同时存在时以后加载的为准，见 index.js 的说明。
// golang.org/x/sys/unix 的 Open/Openat 译为 fs.openSync 的同名标志位；
// Node 的打开默认自带 CLOEXEC，故不写 O_CLOEXEC。

"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Permanent regular files only: unlinking a lock creates independent domains.
function openCoordinatorLock(root, name) {
  const C = fs.constants;
  // Go 用 unix.Openat(目录 fd, name) 防目录被替换；Node 无 openat，改用 path.join。
  const fd = fs.openSync(root, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW, 0);
  try {
    // Separate first creation: concurrent O_CREAT|O_NOFOLLOW can return ENOENT
    // on macOS, whereas O_EXCL gives the losing creator an unambiguous EEXIST.
    const flags = C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK;
    let lockFD;
    try {
      lockFD = fs.openSync(path.join(root, name), flags | C.O_CREAT | C.O_EXCL, 0o600);
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
      lockFD = fs.openSync(path.join(root, name), flags, 0);
    }
    const file = {
      fd: lockFD,
      name: path.join(root, name),
      close() {
        fs.closeSync(lockFD);
      },
    };
    let info;
    try {
      info = fs.fstatSync(lockFD);
    } catch (err) {
      file.close();
      throw err;
    }
    if (!info.isFile()) {
      file.close();
      throw new Error("lock must be a regular file");
    }
    return file;
  } finally {
    fs.closeSync(fd);
  }
}

function tryCoordinatorLock(file, exclusive) {
  // Go 的 unix.Flock(fd, LOCK_SH|LOCK_EX|LOCK_NB) 在 Node 标准库无对应，无法直译。
  // 按 Go 语义：EWOULDBLOCK/EAGAIN/EINTR 应返回未锁定（false，无错），
  // 加锁成功返回已锁定（true，无错），其余错误 throw。
  throw new Error("managed CLI file locking (flock) has no Node.js equivalent");
}

module.exports = { openCoordinatorLock, tryCoordinatorLock };
