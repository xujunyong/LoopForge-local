// claude_install.js —— 对应 Go 文件：internal/runtime/claude_install.go
//
// 文件作用与职责边界：
// 管理固定版本 Claude Code CLI 的按需安装与可执行路径解析。
// 已发布的平台镜像不随附 Claude Code，首次使用时从 npm 下载安装到共享 CLI 目录，
// 供平台进程与只读挂载该目录的沙箱共同使用。
//
// Go 与 JS 语法差异说明：
// - Go 的 `os/exec` 译为 `child_process.spawnSync`；`context.Context` 译为 `AbortSignal`；
// - `(值, error)` 译为成功返回值、失败 throw；`sync.Mutex` 在单线程 JS 中不需要，已略去。

"use strict";

const fs = require("node:fs"); // 对应 Go 标准库 os
const path = require("node:path"); // 对应 Go 标准库 path/filepath
const { spawnSync } = require("node:child_process"); // 对应 Go 标准库 os/exec

const { tailOutput } = require("./browser.js"); // 对应 Go 同包函数

// ClaudeCodeVersion：首次使用时从 npm 安装的固定版本号。已发布的平台镜像不随附 Claude Code，
// 每次安装都从 Anthropic 的 npm registry 包自行下载。Fable 5.2 要求 2.1.321 或更高版本。
const ClaudeCodeVersion = "2.1.326";

/**
 * 读取存放按需安装 CLI 的共享根目录（来自环境变量 `AGENTFLOW_RUNTIME_CLI_DIR`）。
 * 平台进程与宿主机 Docker 守护进程必须解析到同一绝对路径，以便沙箱只读 bind-mount。
 * @returns {string} 去除首尾空白后的共享目录路径；未配置时返回空字符串。
 */
function RuntimeCLIDir() {
  return (process.env.AGENTFLOW_RUNTIME_CLI_DIR ?? "").trim();
}

let claudeCodePackageBinary = path.join("node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");

/**
 * 拼装固定版本 Claude Code 在指定共享目录下的二进制绝对路径。
 * 供本文件安装校验以及 cli_ondemand 按需路径查询调用。
 * @param {string} root - 共享 CLI 根目录路径。
 * @returns {string} 固定版本 Claude Code 的二进制文件路径。
 */
function claudeCodeBinary(root) {
  return path.join(root, "claude-code", ClaudeCodeVersion, claudeCodePackageBinary);
}

/**
 * 返回暴露按需安装 `claude` 可执行文件的 npm `.bin` 目录路径。
 * 用于向子进程或沙箱环境补充 PATH。
 * @returns {string} npm `.bin` 目录路径。
 */
function ClaudeCodeBinDir() {
  return path.join(RuntimeCLIDir(), "claude-code", ClaudeCodeVersion, "node_modules", ".bin");
}

/**
 * 为平台进程解析可用的 `claude` 可执行文件路径。
 * 优先使用系统 PATH 中已存在的 `claude`，否则触发固定版本的按需安装。
 * @param {AbortSignal} ctx - 取消信号。
 * @returns {string} 可用的 `claude` 二进制路径；安装失败时抛出 Error。
 */
function ResolveClaudeCode(ctx) {
  const found = lookPath("claude");
  if (found !== null) {
    return found;
  }
  return EnsureClaudeCode(ctx);
}

/**
 * 将固定版本的 Claude Code 一次性安装到 RuntimeCLIDir 并返回其绝对二进制路径。
 * 若目标版本已安装且可执行则直接返回；否则在临时暂存目录执行 npm 安装、校验 `--version` 后原子重命名启用。
 * @param {AbortSignal} ctx - 取消信号。
 * @returns {string} 已安装的 Claude Code 二进制绝对路径；目录未配置、安装或校验失败时抛出 Error。
 */
function EnsureClaudeCode(ctx) {
  const signal = ctx instanceof AbortSignal ? ctx : undefined;
  const root = RuntimeCLIDir();
  if (root === "") {
    throw new Error("claude CLI 未安装");
  }
  const binary = claudeCodeBinary(root);
  if (fileIsExecutable(binary)) {
    return binary;
  }
  const parent = path.join(root, "claude-code");
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
  } catch (err) {
    throw new Error(`prepare Claude Code directory: ${err.message}`);
  }
  let stage;
  try {
    stage = fs.mkdtempSync(path.join(parent, ".install-"));
  } catch (err) {
    throw new Error(`prepare Claude Code install: ${err.message}`);
  }
  try {
    // 沙箱通过只读 bind mount 读取该安装目录。
    fs.chmodSync(stage, 0o755);
    const install = spawnSync(
      "npm",
      ["install", "--prefix", stage, "--no-audit", "--no-fund", "--omit=dev", "--save-exact", "@anthropic-ai/claude-code@" + ClaudeCodeVersion],
      { cwd: stage, signal },
    );
    // Go CombinedOutput 合并 stdout 与 stderr；这里将两者拼接。
    const installOut = Buffer.concat([install.stdout ?? Buffer.alloc(0), install.stderr ?? Buffer.alloc(0)]);
    if (install.error != null || install.status !== 0) {
      const cause = install.error != null ? install.error.message : `exit status ${install.status}`;
      throw new Error(`install Claude Code ${ClaudeCodeVersion} from npm: ${cause}: ${tailOutput(installOut)}`);
    }
    const staged = path.join(stage, claudeCodePackageBinary);
    const version = spawnSync(staged, ["--version"], { signal });
    const versionOut = Buffer.concat([version.stdout ?? Buffer.alloc(0), version.stderr ?? Buffer.alloc(0)]);
    if (version.error != null || version.status !== 0) {
      const cause = version.error != null ? version.error.message : `exit status ${version.status}`;
      throw new Error(`installed Claude Code does not run on this platform: ${cause}: ${tailOutput(versionOut)}`);
    }
    const target = path.join(parent, ClaudeCodeVersion);
    try {
      fs.renameSync(stage, target);
    } catch (err) {
      if (!fileIsExecutable(binary)) {
        throw new Error(`activate Claude Code install: ${err.message}`);
      }
    }
    return binary;
  } finally {
    // 对应 Go：defer os.RemoveAll(stage)。
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * 判断指定路径是否为存在且具有可执行权限位的普通文件。
 * 用于检测按需安装或已缓存的 CLI 二进制是否就绪。
 * @param {string} filePath - 待检查的文件路径。
 * @returns {boolean} 存在且为可执行普通文件时返回 true，否则返回 false。
 */
function fileIsExecutable(filePath) {
  let info;
  try {
    info = fs.statSync(filePath);
  } catch {
    return false;
  }
  return info.isFile() && (info.mode & 0o111) !== 0;
}

/**
 * 按环境变量 PATH 顺序查找可执行文件，对应 Go 的 `exec.LookPath`。
 * 用于判断 `claude`、`npm`、`bash` 等系统命令是否已安装在 PATH 中。
 * @param {string} name - 要查找的可执行文件名。
 * @returns {string|null} 找到时返回完整路径，未找到时返回 null。
 */
function lookPath(name) {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (dir === "") {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 当前目录未命中或不可执行，继续检查下一个目录。
    }
  }
  return null;
}

module.exports = {
  ClaudeCodeVersion,
  RuntimeCLIDir,
  ClaudeCodeBinDir,
  ResolveClaudeCode,
  EnsureClaudeCode,
  claudeCodeBinary,
  fileIsExecutable,
  lookPath,
};
