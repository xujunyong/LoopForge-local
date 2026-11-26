// claude_install.js —— 对应 Go 文件：internal/runtime/claude_install.go
// 作用：首次使用时从 npm 安装固定版本的 Claude Code，并解析其可执行文件路径。
// Go 的 os/exec 译为 child_process.spawnSync；context.Context 译为 AbortSignal；
// (值, error) 译为成功返回值、失败 throw；sync.Mutex 省略，JS 单线程无需加锁。

"use strict";

const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath
const { spawnSync } = require("node:child_process"); // Go os/exec

const { tailOutput } = require("./browser.js"); // 对应 Go 同包函数，browser.js 待翻译

// ClaudeCodeVersion：首次使用时从 npm 安装。已发布的平台镜像不随附 Claude Code，
// 每次安装都从 Anthropic 的 registry 包自行下载。Fable 5.2 要求 2.1.321 或更高版本。
const ClaudeCodeVersion = "2.1.326";

// RuntimeCLIDir：存放按需安装 CLI 的共享目录（AGENTFLOW_RUNTIME_CLI_DIR）。
// 平台与宿主 Docker 守护进程必须解析到同一个绝对路径，因为沙箱会 bind-mount 它。
function RuntimeCLIDir() {
  return (process.env.AGENTFLOW_RUNTIME_CLI_DIR ?? "").trim();
}

const claudeCodePackageBinary = path.join("node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");

function claudeCodeBinary(root) {
  return path.join(root, "claude-code", ClaudeCodeVersion, claudeCodePackageBinary);
}

// ClaudeCodeBinDir：暴露按需安装的 `claude` 的 npm bin 目录。
function ClaudeCodeBinDir() {
  return path.join(RuntimeCLIDir(), "claude-code", ClaudeCodeVersion, "node_modules", ".bin");
}

// ResolveClaudeCode：返回平台进程可用的 claude 可执行文件：PATH 上已有的优先，否则用固定版本按需安装。
function ResolveClaudeCode(ctx) {
  const found = lookPath("claude");
  if (found !== null) {
    return found;
  }
  return EnsureClaudeCode(ctx);
}

// EnsureClaudeCode：把固定版本的 Claude Code 安装进 RuntimeCLIDir 一次，并返回其绝对二进制路径。
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
    // 沙箱通过只读 bind mount 读取该安装。
    fs.chmodSync(stage, 0o755);
    const install = spawnSync("npm", ["install", "--prefix", stage, "--no-audit", "--no-fund", "--omit=dev", "--save-exact", "@anthropic-ai/claude-code@" + ClaudeCodeVersion], { cwd: stage, signal });
    // Go CombinedOutput 合并 stdout 与 stderr；这里把两者拼接。
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
    // Go：defer os.RemoveAll(stage)。
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function fileIsExecutable(filePath) {
  let info;
  try {
    info = fs.statSync(filePath);
  } catch {
    return false;
  }
  return info.isFile() && (info.mode & 0o111) !== 0;
}

// lookPath：Go 的 exec.LookPath，按 PATH 逐个目录找可执行文件。
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
      // 继续找下一个目录。
    }
  }
  return null;
}

module.exports = { ClaudeCodeVersion, RuntimeCLIDir, ClaudeCodeBinDir, ResolveClaudeCode, EnsureClaudeCode, claudeCodeBinary, fileIsExecutable, lookPath };
