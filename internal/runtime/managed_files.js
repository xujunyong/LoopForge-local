// managed_files.js —— 对应 Go 文件：internal/runtime/managed_files.go
//
// 文件作用与职责边界：
// 提供受工作区根目录约束的安全路径打开、逐级符号链接拒绝、受管文件读取与原子写入（临时文件 +
// 重命名，避免截断可能被沙箱硬链接的既有 inode）。
//
// Go 与 JS 语法差异说明：
// - Go 的 `(*os.Root, string, error)` 译为成功返回 `[root, rel]`、失败 `throw Error`；
// - Node.js 无原生 `os.OpenRoot`，`openWorkspacePath` 返回封装 `fs.*Sync` 的目录根句柄对象，提供与 `*os.Root` 对应的方法；
// - Go 的 `crypto/rand.Text()` 译为 `crypto.randomBytes(16).toString("hex")`；`defer` 译为 `try ... finally`。

"use strict";

const crypto = require("node:crypto"); // 对应 Go 标准库 crypto/rand
const fs = require("node:fs"); // 对应 Go 标准库 os
const path = require("node:path"); // 对应 Go 标准库 path/filepath

/**
 * 在解析任何不可信路径分量之前将操作锚定到工作区根目录，拒绝越界路径及任意层级的符号链接，
 * 并返回锚定工作区的根操作对象与规范化相对路径。工作区根目录本身视为可信根。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {string} target 目标文件或目录路径。
 * @returns {[Object, string]} 返回 `[root, rel]`，`root` 为受限根操作对象，`rel` 为相对工作区的路径；路径非法或含符号链接时抛出 `Error`。
 */
function openWorkspacePath(workspace, target) {
  const base = path.resolve(workspace);
  target = path.resolve(target);
  const rel = path.relative(base, target);
  const isLocal = rel !== "" && !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep);
  if (!isLocal || rel === ".") {
    throw new Error(`invalid workspace file path ${JSON.stringify(target)}`);
  }
  const baseStat = fs.statSync(base);
  if (!baseStat.isDirectory()) {
    throw new Error(`workspace root is not a directory: ${base}`);
  }
  // 对应 Go 的 os.OpenRoot(base)：将相对路径操作限定在 base 目录内。
  const root = {
    base,
    Lstat(sub) {
      return fs.lstatSync(path.join(base, sub));
    },
    Stat(sub) {
      return fs.statSync(path.join(base, sub));
    },
    ReadFile(sub) {
      return fs.readFileSync(path.join(base, sub));
    },
    Mkdir(sub, mode) {
      fs.mkdirSync(path.join(base, sub), { mode });
    },
    MkdirAll(sub, mode) {
      fs.mkdirSync(path.join(base, sub), { recursive: true, mode });
    },
    OpenFile(sub, flags, mode) {
      const fd = fs.openSync(path.join(base, sub), flags, mode);
      let closed = false;
      return {
        Write(buf) {
          fs.writeSync(fd, buf);
        },
        WriteString(str) {
          fs.writeSync(fd, str, null, "utf8");
        },
        Close() {
          if (!closed) {
            closed = true;
            fs.closeSync(fd);
          }
        },
      };
    },
    Remove(sub) {
      fs.unlinkSync(path.join(base, sub));
    },
    RemoveAll(sub) {
      fs.rmSync(path.join(base, sub), { recursive: true, force: true });
    },
    Rename(oldSub, newSub) {
      fs.renameSync(path.join(base, oldSub), path.join(base, newSub));
    },
    Close() {},
  };
  try {
    rejectWorkspaceSymlinks(root, rel);
  } catch (err) {
    root.Close();
    throw err;
  }
  return [root, rel];
}

/**
 * 沿相对路径逐级执行 `Lstat`，遇到不存在的分量即停止检查，一旦发现任一分量是符号链接则立即抛错拒绝。
 *
 * @param {Object} root 锚定工作区的根操作对象。
 * @param {string} rel 相对工作区根目录的路径。
 * @returns {void} 无返回值；发现符号链接或 `Lstat` 发生非 ENOENT 错误时抛出 `Error`。
 */
function rejectWorkspaceSymlinks(root, rel) {
  let current = "";
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    let info;
    try {
      info = root.Lstat(current);
    } catch (err) {
      if (err.code === "ENOENT") {
        return;
      }
      throw err;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`workspace path is a symlink: ${current}`);
    }
  }
}

/**
 * 在工作区根目录与符号链接校验约束下安全读取目标文件字节内容。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {string} target 目标文件路径。
 * @returns {Buffer} 文件的原始字节内容；校验或读取失败时抛出 `Error`。
 */
function readWorkspaceFile(workspace, target) {
  const [root, rel] = openWorkspacePath(workspace, target);
  try {
    return root.ReadFile(rel);
  } finally {
    root.Close();
  }
}

/**
 * 将字节内容或字符串安全写入工作区受管文件，底层通过临时文件原子替换实现。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {string} target 目标受管文件路径。
 * @param {Buffer | string} content 要写入的文件内容。
 * @param {number} mode 目标文件权限位（如 `0o600`、`0o700`）。
 * @returns {void} 无返回值；校验或写盘失败时抛出 `Error`。
 */
function writeManagedFile(workspace, target, content, mode) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content ?? "", "utf8");
  writeManagedReader(workspace, target, buf, mode);
}

/**
 * 将内容源以新创建临时文件再原子重命名的方式写入工作区受管文件：
 * 绝不直接截断既有 inode（防止沙箱将其硬链接到其他文件），同时确保新 inode 生效目标权限位。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {string} target 目标受管文件路径。
 * @param {Buffer | string | { read?: Function }} content 待写入的字节内容、字符串或可读源。
 * @param {number} mode 目标文件权限位。
 * @returns {void} 无返回值；目标为非普通文件或 I/O 失败时抛出 `Error`。
 */
function writeManagedReader(workspace, target, content, mode) {
  const [root, rel] = openWorkspacePath(workspace, target);
  try {
    try {
      const info = root.Lstat(rel);
      if (!info.isFile()) {
        throw new Error(`managed path is not a regular file: ${target}`);
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
    // 绝不截断已有 inode：沙箱可能已将其硬链接到其他文件；新 inode 也能在复用路径时正确应用权限。
    const temp = path.join(path.dirname(rel), ".agentflow-write-" + crypto.randomBytes(16).toString("hex"));
    const file = root.OpenFile(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
    try {
      let writeErr = null;
      let closeErr = null;
      try {
        if (Buffer.isBuffer(content)) {
          file.Write(content);
        } else if (typeof content === "string") {
          file.WriteString(content);
        } else if (content != null && typeof content.read === "function") {
          let chunk;
          while ((chunk = content.read()) !== null) {
            file.Write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
        }
      } catch (err) {
        writeErr = err;
      }
      try {
        file.Close();
      } catch (err) {
        closeErr = err;
      }
      if (writeErr != null) {
        throw writeErr;
      }
      if (closeErr != null) {
        throw closeErr;
      }
      root.Rename(temp, rel);
    } finally {
      try {
        root.Remove(temp);
      } catch {
        // 已重命名成功时临时文件不再存在，忽略删除错误。
      }
    }
  } finally {
    root.Close();
  }
}

module.exports = {
  openWorkspacePath,
  rejectWorkspaceSymlinks,
  readWorkspaceFile,
  writeManagedFile,
  writeManagedReader,
};
