/**
 * @file internal/runtime/cursor_install.js
 * @description 对应 Go 源文件：internal/runtime/cursor_install.go
 *
 * 职责与边界：
 * 负责在共享运行时 CLI 目录中发布 Cursor CLI（`cursor-agent`）发行包，供 Docker 沙箱只读挂载复用；
 * 优先复制宿主机已安装的官方版本目录，必要时按需下载安装并原子切换。
 * 不负责通用的按需脚本安装器实现或 Docker 容器挂载编排。
 *
 * 语法差异说明：
 * - `context.Context` 译为 `AbortSignal`；`(值, error)` 译为成功返回值、失败抛出 `Error`。
 * - `sync.Mutex`（`cursorInstallMu`）在单线程 JS 中不需要，略去；`defer os.RemoveAll(stage)` 译为 `try/finally`。
 * - `runtime.GOOS`/`runtime.GOARCH` 译为 `process.platform`/`process.arch` 的 Go 命名映射。
 * - 与 `cli_ondemand.js` 存在同包循环依赖，调用 `onDemandCLICatalog`/`installScriptCLI` 时在函数内延迟 `require("./cli_ondemand.js")`。
 */

"use strict";

const fs = require("node:fs"); // Go os
const os = require("node:os"); // Go os
const path = require("node:path"); // Go path/filepath

const { RuntimeCLIDir, fileIsExecutable } = require("./claude_install.js"); // 对应 Go 同包函数，claude_install.js 已翻译
const { AgentCLICursor } = require("./agent_cli.js"); // 对应 Go 同包常量，agent_cli.js 已翻译
const { copyPreserving } = require("./toolchain.js"); // 对应 Go 同包函数，toolchain.js 待翻译

const cursorCLIBinary = "cursor-agent";

/**
 * 将 Node.js 的 `process.platform` 映射为 Go `runtime.GOOS` 名称。
 * 用于拼装跨平台共享 CLI 目录路径。
 *
 * @returns {string} Go 风格的操作系统标识（如 `"linux"`、`"darwin"`、`"windows"`）。
 */
function goos() {
  if (process.platform === "win32") {
    return "windows";
  }
  return process.platform;
}

/**
 * 将 Node.js 的 `process.arch` 映射为 Go `runtime.GOARCH` 名称。
 * 用于拼装跨平台共享 CLI 目录路径。
 *
 * @returns {string} Go 风格的 CPU 架构标识（如 `"amd64"`、`"arm64"`、`"386"`）。
 */
function goarch() {
  if (process.arch === "x64") {
    return "amd64";
  }
  if (process.arch === "ia32") {
    return "386";
  }
  return process.arch;
}

/**
 * 计算共享目录中当前平台对应的 Cursor CLI 可执行文件绝对路径。
 * 在探测或发布共享 Cursor CLI 安装包时调用。
 *
 * @returns {string} 共享目录中的 `cursor-agent` 绝对路径；若运行时 CLI 根目录非绝对路径则返回空字符串 `""`。
 */
function sharedCursorCLIPath() {
  const root = RuntimeCLIDir();
  if (!path.isAbsolute(root)) {
    return "";
  }
  return path.join(root, "cursor", goos() + "-" + goarch(), "current", cursorCLIBinary);
}

/**
 * 在共享目录中准备只含发行包内容的 Cursor CLI（不复制安装器 HOME 或用户个人配置）。
 * 优先复用宿主机已安装的发行目录；未安装且 `download` 为 `true` 时在临时目录执行官方安装脚本后原子发布。
 *
 * @param {AbortSignal|null} ctx 取消信号。
 * @param {boolean} download 宿主机未安装时是否允许自动下载安装。
 * @returns {string} 共享目录中可用的 `cursor-agent` 绝对路径；不允许下载且本机无现成包（或未配置共享根目录）时返回空字符串 `""`。
 */
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
      // 延迟 require 打破与 cli_ondemand.js 的同包循环依赖。
      const { onDemandCLICatalog, installScriptCLI } = require("./cli_ondemand.js");
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

/**
 * 定位指定家目录下官方 Cursor CLI 实际指向的版本目录（因为启动器是指向版本目录的符号链接，必须整体复制）。
 * 由 `prepareSharedCursorCLI` 在复用本机安装或校验临时安装产物时调用。
 *
 * @param {string} home 用户家目录或临时安装家目录路径。
 * @returns {string} 官方 Cursor CLI 版本目录的绝对路径；未找到或路径不符合预期结构时返回空字符串 `""`。
 */
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
