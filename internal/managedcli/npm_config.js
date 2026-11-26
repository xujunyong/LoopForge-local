// npm_config.js —— 对应 Go 文件：internal/managedcli/npm_config.go
// 作用：为托管 CLI 更新器生成独立的空白私有 npm 配置文件，避免子进程读取宿主机 npm 凭证。
// 职责边界：只负责原子写入单个空白 npmrc 文件，不管理目录创建或环境变量拼装。
// 语法差异说明：
// - Go 的 error 返回译为成功无返回值、失败 throw Error；
// - Go 的 os.CreateTemp + defer os.Remove 译为带随机后缀的独占新建文件配合 try/finally 清理。

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * 原子创建或覆盖一份私有空白 npm 配置文件。
 * 在准备更新器命令目录时分别为 userconfig 与 globalconfig 调用，避免 npm 拒绝重复加载同一物理配置源（如 /dev/null）。
 *
 * @param {string} filePath 目标 npm 配置文件的完整路径。
 * @returns {void} 无返回值；目标为非普通文件或文件写入失败时抛出错误。
 */
function emptyNPMConfig(filePath) {
  let info;
  try {
    info = fs.lstatSync(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
  if (info != null && !info.isFile()) {
    throw new Error("refuse non-regular updater npm config");
  }
  const tmp = path.join(path.dirname(filePath), `.npmrc-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
  const f = fs.openSync(tmp, "wx", 0o600);
  let closed = false;
  try {
    fs.writeSync(f, "# managed updater: no host npm credentials\n");
    fs.fsyncSync(f);
    closed = true;
    fs.closeSync(f);
    fs.renameSync(tmp, filePath);
  } finally {
    if (!closed) {
      try {
        fs.closeSync(f);
      } catch {
        // 关闭临时文件句柄失败时忽略，继续清理临时文件。
      }
    }
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { emptyNPMConfig };
