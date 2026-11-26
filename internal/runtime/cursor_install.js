// cursor_install.js —— 对应 Go 文件：internal/runtime/cursor_install.go
// 作用：发布一份共享的 Cursor CLI，供 Docker 沙箱只读挂载，优先复用本机已装的包。
// context.Context 译为 AbortSignal；(值, error) 译为成功返回值、失败 throw；
// sync.Mutex 在单线程 JS 里不需要，略去；runtime.GOOS/GOARCH 译为 process.platform/arch 的映射。

"use strict";

const fs = require("node:fs"); // Go os
const os = require("node:os"); // Go os
const path = require("node:path"); // Go path/filepath

const { RuntimeCLIDir, fileIsExecutable } = require("./claude_install.js"); // 对应 Go 同包函数，claude_install.js 已翻译
const { onDemandCLICatalog, installScriptCLI } = require("./cli_ondemand.js"); // 对应 Go 同包函数，cli_ondemand.js 已翻译
const { AgentCLICursor } = require("./agent_cli.js"); // 对应 Go 同包常量，agent_cli.js 已翻译
const { copyPreserving } = require("./toolchain.js"); // 对应 Go 同包函数，toolchain.js 待翻译

const cursorCLIBinary = "cursor-agent";

// Go 的 runtime.GOOS/GOARCH 译为 process.platform/arch 的映射。
function goos() {
  if (process.platform === "win32") {
    return "windows";
  }
  return process.platform;
}

function goarch() {
  if (process.arch === "x64") {
    return "amd64";
  }
  return process.arch;
}

function sharedCursorCLIPath() {
  const root = RuntimeCLIDir();
  if (!path.isAbsolute(root)) {
    return "";
  }
  return path.join(root, "cursor", goos() + "-" + goarch(), "current", cursorCLIBinary);
}

function prepareSharedCursorCLI(ctx, download) {
  const binary = sharedCursorCLIPath();
  if (binary === "" || fileIsExecutable(binary)) {
    return binary;
  }
  // Go 的 cursorInstallMu：单线程 JS 不需要，略去。
  if (fileIsExecutable(binary)) {
    return binary;
  }
  let home = "";
  try {
    home = os.homedir();
  } catch {
    // Go：os.UserHomeDir 失败时 home 为空。
  }
  const source = installedCursorPackage(home);
  if (source === "" && !download) {
    return "";
  }
  const target = path.dirname(binary);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
  const stage = fs.mkdtempSync(path.join(parent, ".install-"));
  try {
    let stagedPackage = "";
    if (source !== "") {
      try {
        copyPreserving(stage, source);
      } catch (err) {
        throw new Error(`复制已安装的 Cursor CLI 失败：${err.message}`);
      }
      stagedPackage = path.join(stage, path.basename(source));
    } else {
      const installHome = path.join(stage, "home");
      fs.mkdirSync(installHome, { mode: 0o700 });
      installScriptCLI(ctx, onDemandCLICatalog()[AgentCLICursor], installHome);
      stagedPackage = installedCursorPackage(installHome);
      if (stagedPackage === "") {
        throw new Error("未找到官方 Cursor CLI 安装包");
      }
    }
    fs.chmodSync(stagedPackage, 0o755);
    try {
      fs.renameSync(stagedPackage, target);
    } catch (err) {
      if (!fileIsExecutable(binary)) {
        throw new Error(`启用共享 Cursor CLI 失败：${err.message}`);
      }
    }
    return binary;
  } finally {
    // Go：defer os.RemoveAll(stage)。
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function installedCursorPackage(home) {
  if (home === "") {
    return "";
  }
  let versions = path.join(home, ".local", "share", cursorCLIBinary, "versions");
  let binary;
  try {
    binary = fs.realpathSync(path.join(home, ".local", "bin", cursorCLIBinary));
  } catch {
    return "";
  }
  if (!fileIsExecutable(binary)) {
    return "";
  }
  try {
    versions = fs.realpathSync(versions);
  } catch {
    return "";
  }
  const relative = path.relative(versions, binary);
  // Go 的 strings.Cut：切到第一处分隔符，没有时返回原串与空串。
  const sepIndex = relative.indexOf(path.sep);
  const version = sepIndex === -1 ? relative : relative.slice(0, sepIndex);
  const name = sepIndex === -1 ? "" : relative.slice(sepIndex + 1);
  const ok = sepIndex !== -1;
  if (!ok || version === ".." || name !== cursorCLIBinary) {
    return "";
  }
  return path.dirname(binary);
}

module.exports = { cursorCLIBinary, sharedCursorCLIPath, prepareSharedCursorCLI, installedCursorPackage };
