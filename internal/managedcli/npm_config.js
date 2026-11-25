// npm_config.js —— 对应 Go 文件：internal/managedcli/npm_config.go
// 作用：给更新器写两份空的私有 npm 配置，隔离宿主机的 npm 凭证。
// (值, error) 译为成功返回值、失败 throw。

"use strict";

const fs = require("node:fs");
const path = require("node:path");

// npm rejects loading the same physical config source twice. Use two private,
// empty files rather than /dev/null for both userconfig and globalconfig.
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
  const tmp = path.join(path.dirname(filePath), `.npmrc-${randomSuffix()}`);
  const f = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(f, "# managed updater: no host npm credentials\n");
    fs.fsyncSync(f);
  } catch (err) {
    fs.closeSync(f);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(f);
  fs.renameSync(tmp, filePath);
}

function randomSuffix() {
  return `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

module.exports = { emptyNPMConfig };
