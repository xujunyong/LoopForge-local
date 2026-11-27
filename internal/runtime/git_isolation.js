// git_isolation.js —— 对应 Go 文件：internal/runtime/git_isolation.go
// 作用与职责边界：清理旧版 Agent 配置在私有克隆中留下的 Git exclude 与 skip-worktree 掩码，为 `.agentflow/` 写入 Git 排除规则，并安全处理 `.git/index.lock` 锁冲突。
// 语法差异说明：
// - Go 的 (值, error) 译为成功返回值、失败 throw；(值1, 值2, error) 译为成功返回 [值1, 值2]、失败 throw；
// - context.Context 译为 AbortSignal；sync.Mutex 在单线程 JS 中略去；defer 译为 try ... finally；
// - Go 的 map[string]bool 译为普通对象 {}；time.Duration 译为毫秒数；轮询等待用 Atomics.wait 保持同步结构。

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process"); // Go os/exec
const { openWorkspacePath, writeManagedFile } = require("./managed_files.js"); // 对应 Go 同包函数，managed_files.js 待翻译

const legacyProjectAgentGitExcludeBlock = `# AgentFlow managed sandbox: repository Agent configuration
AGENTS.md
AGENTS.override.md
CLAUDE.md
CLAUDE.local.md
CODEBUDDY.md
.mcp.json
.agents/
.codex/
.claude/
.codebuddy/
`;

const agentFlowGitExcludeBlock = `# AgentFlow managed runtime (hooks, bindings, invocation state)
.agentflow/
`;

/**
 * 清理整个工作区（含根目录旧版检出及各子仓库目录）中由旧版指令掩码写入的 Git 配置。
 *
 * @param {AbortSignal|null} ctx 用于取消子进程的上下文信号。
 * @param {string} workspace 工作区根目录路径。
 * @param {Array<{ WorkspaceDir?: string }>} repositories 工作区内的仓库上下文列表。
 * @returns {void} 无返回值；遇到非 ENOENT 错误时抛出异常。
 */
function RestoreLegacyWorkspaceAgentConfig(ctx, workspace, repositories) {
  RestoreLegacyProjectAgentConfig(ctx, workspace);
  for (const repo of repositories ?? []) {
    const dir = (repo.WorkspaceDir ?? "").trim();
    if (dir === "" || dir === ".") {
      continue;
    }
    // Go 的 filepath.IsLocal：相对路径且不含 .. 元素。
    const isLocal = dir !== "" && !path.isAbsolute(dir) && !dir.split(path.sep).includes("..");
    if (!isLocal || path.basename(dir) !== dir) {
      continue;
    }
    const target = path.join(workspace, dir);
    let info = null;
    let statErr = null;
    try {
      info = fs.lstatSync(target);
    } catch (err) {
      statErr = err;
    }
    if (statErr == null && info.isDirectory()) {
      RestoreLegacyProjectAgentConfig(ctx, target);
    } else if (statErr != null && statErr.code !== "ENOENT") {
      throw statErr;
    }
  }
}

/**
 * 仅对带有旧版掩码标记的私有仓库目录解除 skip-worktree 索引位并移除 `.git/info/exclude` 中的旧版排除块，未标记的仓库保持不动。
 *
 * @param {AbortSignal|null} ctx 用于取消子进程的上下文信号。
 * @param {string} workspace 单个仓库的工作目录路径。
 * @returns {void} 无返回值；读写或索引更新失败时抛出异常。
 */
function RestoreLegacyProjectAgentConfig(ctx, workspace) {
  let git = null;
  let statErr = null;
  try {
    git = fs.lstatSync(path.join(workspace, ".git"));
  } catch (err) {
    statErr = err;
  }
  if ((statErr != null && statErr.code === "ENOENT") || (statErr == null && !git.isDirectory())) {
    return;
  }
  if (statErr != null) {
    throw statErr;
  }
  const target = path.join(workspace, ".git", "info", "exclude");
  const [root, rel] = openWorkspacePath(workspace, target);
  try {
    let info = null;
    let lstatErr = null;
    try {
      info = root.Lstat(rel);
    } catch (err) {
      lstatErr = err;
    }
    if ((lstatErr != null && lstatErr.code === "ENOENT") || (lstatErr == null && !info.isFile())) {
      return;
    }
    if (lstatErr != null) {
      throw lstatErr;
    }
    const content = root.ReadFile(rel);
    const block = Buffer.from(legacyProjectAgentGitExcludeBlock, "utf8");
    if (!content.includes(block)) {
      return;
    }
    clearLegacyProjectAgentGitIndex(ctx, workspace);
    let cleaned = content;
    let at = cleaned.indexOf(block);
    while (at !== -1) {
      cleaned = Buffer.concat([cleaned.subarray(0, at), cleaned.subarray(at + block.length)]);
      at = cleaned.indexOf(block);
    }
    writeManagedFile(workspace, target, cleaned, info.mode & 0o777);
  } finally {
    root.Close();
  }
}

/**
 * 确保私有克隆的 `.git/info/exclude` 中包含 `.agentflow/` 排除块，防止 `git stash -u` 误删运行时 hook 与状态文件。
 *
 * @param {string} workspace 仓库工作目录路径。
 * @returns {void} 无返回值；非 Git 目录时静默返回，I/O 失败时抛出异常。
 */
function EnsureAgentFlowGitExcludes(workspace) {
  const [root, excludePath] = openWorkspacePath(workspace, path.join(workspace, ".git", "info", "exclude"));
  try {
    let gitErr = null;
    try {
      root.Stat(".git");
    } catch (err) {
      gitErr = err;
    }
    if (gitErr != null) {
      if (gitErr.code === "ENOENT") {
        return;
      }
      throw gitErr;
    }
    let existing;
    try {
      existing = root.ReadFile(excludePath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
      existing = Buffer.alloc(0);
    }
    if (existing.includes(Buffer.from(agentFlowGitExcludeBlock, "utf8"))) {
      return;
    }
    root.MkdirAll(path.dirname(excludePath), 0o700);
    const file = root.OpenFile(excludePath, fs.constants.O_CREATE | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
    try {
      if (existing.length > 0 && existing[existing.length - 1] !== 10) {
        file.WriteString("\n");
      }
      try {
        file.WriteString(agentFlowGitExcludeBlock);
      } catch (err) {
        throw new Error(`write AgentFlow runtime excludes: ${err.message}`);
      }
    } finally {
      file.Close();
    }
  } finally {
    root.Close();
  }
}

/**
 * 对仓库内被标记了 skip-worktree 的旧版 Agent 配置文件执行 `git update-index --no-skip-worktree`；遇到 `.git/index.lock` 冲突时轮询等待活进程释放，仅在确认锁已陈旧无主时清理重试。
 *
 * @param {AbortSignal|null} ctx 用于取消子进程与等待循环的上下文信号。
 * @param {string} workspace 仓库工作目录路径。
 * @returns {void} 无返回值；命令失败或锁无法安全解除时抛出异常。
 */
function clearLegacyProjectAgentGitIndex(ctx, workspace) {
  const mode = "--no-skip-worktree";
  const paths = trackedSkippedProjectAgentConfigPaths(ctx, workspace);
  if (paths.length === 0) {
    return;
  }
  const input = Buffer.concat(paths.map((p) => Buffer.from(p + "\0", "utf8")));
  const run = () => {
    const result = spawnSync("git", ["-C", workspace, "update-index", mode, "-z", "--stdin"], {
      input,
      encoding: "buffer",
      signal: ctx instanceof AbortSignal ? ctx : undefined,
    });
    const output = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]);
    let err = result.error;
    if (err == null && result.status !== 0) {
      err = new Error(result.status == null ? `signal: ${result.signal}` : `exit status ${result.status}`);
    }
    if (err != null) {
      err.output = output;
      throw err;
    }
    return output;
  };
  let output = Buffer.alloc(0);
  let err = null;
  try {
    output = run();
  } catch (e) {
    err = e;
    output = e.output ?? Buffer.alloc(0);
  }
  if (ctx instanceof AbortSignal && ctx.aborted) {
    throw ctx.reason ?? new Error("context canceled");
  }
  if (err == null) {
    return;
  }
  if (!isGitIndexLockConflict(output)) {
    throw new Error(`git update-index ${mode}: ${err.message}: ${output.toString("utf8").trim()}`);
  }
  let lockPath;
  try {
    lockPath = gitIndexLockPath(ctx, workspace);
  } catch (lockErr) {
    throw new Error(`git update-index ${mode}: ${err.message}: ${output.toString("utf8").trim()} (resolve index lock: ${lockErr.message})`);
  }
  let inUse = false;
  let confirmed = false;
  let inspectErr = null;
  try {
    [inUse, confirmed] = gitIndexLockInUse(ctx, lockPath);
  } catch (e) {
    inspectErr = e;
  }
  const deadline = Date.now() + gitIndexLockWait;
  while (inspectErr == null && confirmed && inUse && Date.now() < deadline) {
    if (ctx instanceof AbortSignal && ctx.aborted) {
      throw ctx.reason ?? new Error("context canceled");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, gitIndexLockPoll);
    let statErr = null;
    try {
      fs.statSync(lockPath);
    } catch (e) {
      statErr = e;
    }
    if (statErr != null && statErr.code === "ENOENT") {
      try {
        run();
        return;
      } catch (e) {
        err = e;
        output = e.output ?? Buffer.alloc(0);
      }
      if (!isGitIndexLockConflict(output)) {
        throw new Error(`git update-index ${mode}: ${err.message}: ${output.toString("utf8").trim()}`);
      }
    }
    inUse = false;
    confirmed = false;
    inspectErr = null;
    try {
      [inUse, confirmed] = gitIndexLockInUse(ctx, lockPath);
    } catch (e) {
      inspectErr = e;
    }
  }
  if (ctx instanceof AbortSignal && ctx.aborted) {
    throw ctx.reason ?? new Error("context canceled");
  }
  if (inspectErr != null || !confirmed) {
    throw new Error(`git update-index ${mode}: ${err.message}: ${output.toString("utf8").trim()} (cannot safely inspect index lock: ${inspectErr != null ? inspectErr.message : "<nil>"})`);
  }
  if (inUse) {
    throw new Error(`git update-index ${mode}: ${err.message}: ${output.toString("utf8").trim()} (index lock is held by a live process)`);
  }
  try {
    fs.unlinkSync(lockPath);
  } catch (removeErr) {
    if (removeErr.code !== "ENOENT") {
      throw new Error(`git update-index ${mode}: ${err.message}: ${output.toString("utf8").trim()} (remove stale index lock: ${removeErr.message})`);
    }
  }
  try {
    run();
  } catch (e) {
    const retryOutput = e.output ?? Buffer.alloc(0);
    throw new Error(`git update-index ${mode} after stale index lock cleanup: ${e.message}: ${retryOutput.toString("utf8").trim()}`);
  }
}

// 供测试缩短的等待时长：Go 的 time.Duration 译为毫秒数。
let gitIndexLockWait = 15 * 1000;
let gitIndexLockPoll = 200;

/**
 * 判断 `git update-index` 的合并输出是否属于 `.git/index.lock` 文件已存在的锁冲突错误。
 *
 * @param {Buffer} output Git 命令的标准输出与标准错误合并缓冲。
 * @returns {boolean} 属于 index.lock 冲突时返回 true，否则返回 false。
 */
function isGitIndexLockConflict(output) {
  const message = output.toString("utf8").toLowerCase();
  return message.includes("index.lock") && message.includes("file exists");
}

/**
 * 通过 `git rev-parse --git-path index.lock` 解析仓库对应的 index.lock 绝对路径。
 *
 * @param {AbortSignal|null} ctx 上下文取消信号。
 * @param {string} workspace 仓库工作目录路径。
 * @returns {string} 规范化后的 index.lock 绝对路径；解析失败或为空时抛出异常。
 */
function gitIndexLockPath(ctx, workspace) {
  const result = spawnSync("git", ["-C", workspace, "rev-parse", "--git-path", "index.lock"], {
    encoding: "utf8",
    signal: ctx instanceof AbortSignal ? ctx : undefined,
  });
  if (result.error != null) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.status == null ? `signal: ${result.signal}` : `exit status ${result.status}`);
  }
  const lockPath = (result.stdout ?? "").trim();
  if (lockPath === "") {
    throw new Error("git returned an empty index lock path");
  }
  if (!path.isAbsolute(lockPath)) {
    return path.normalize(path.join(workspace, lockPath));
  }
  return path.normalize(lockPath);
}

/**
 * 检测是否有存活进程正持有指定的 Git index.lock 文件（Linux 扫描 `/proc`，其他平台调用 `lsof`）。
 *
 * @param {AbortSignal|null} ctx 上下文取消信号。
 * @param {string} lockPath index.lock 文件路径。
 * @returns {[boolean, boolean]} 返回 `[inUse, confirmed]`：`inUse` 表示是否被占用，`confirmed` 为 false 时表示无法确认占用状态，调用方必须保留锁文件；检测本身出错时抛出异常。
 */
function gitIndexLockInUse(ctx, lockPath) {
  if (process.platform === "linux") {
    return gitIndexLockInUseProc(lockPath);
  }
  const result = spawnSync("lsof", ["-t", "--", lockPath], {
    encoding: "buffer",
    signal: ctx instanceof AbortSignal ? ctx : undefined,
  });
  const output = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]);
  if (output.toString("utf8").trim().length > 0) {
    return [true, true];
  }
  if (result.error == null && result.status === 0) {
    return [false, true];
  }
  if (result.error != null) {
    throw result.error;
  }
  if (result.status === 1) {
    return [false, true];
  }
  throw new Error(result.status == null ? `signal: ${result.signal}` : `exit status ${result.status}`);
}

/**
 * 在 Linux 上使用当前进程有效 UID 扫描 `/proc` 判断 index.lock 是否仍被进程打开。
 *
 * @param {string} lockPath index.lock 文件路径。
 * @returns {[boolean, boolean]} 返回 `[inUse, confirmed]`；读取失败时抛出异常。
 */
function gitIndexLockInUseProc(lockPath) {
  return gitIndexLockHeldUnder("/proc", lockPath, typeof process.geteuid === "function" ? process.geteuid() : 0);
}

/**
 * 扫描指定 proc 根目录下所有进程的文件描述符，按路径或 inode 匹配锁文件是否被占用；对跨用户不可读进程保留不确定状态直到锁文件超过陈旧阈值。
 *
 * @param {string} procRoot proc 文件系统根目录（通常为 "/proc"）。
 * @param {string} lockPath 锁文件路径。
 * @param {number} self 当前进程的有效 UID。
 * @returns {[boolean, boolean]} 返回 `[inUse, confirmed]`；锁不存在时返回 `[false, true]`，非普通文件或读取 proc 失败时抛出异常。
 */
function gitIndexLockHeldUnder(procRoot, lockPath, self) {
  const want = path.resolve(lockPath);
  let lock;
  try {
    lock = fs.lstatSync(want);
  } catch (err) {
    if (err.code === "ENOENT") {
      return [false, true];
    }
    throw err;
  }
  if (!lock.isFile()) {
    throw new Error(`index lock ${want} is not a regular file`);
  }
  const entries = fs.readdirSync(procRoot, { withFileTypes: true });
  let uncertain = false;
  const foreignOwner = lock.uid !== self;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!/^[+-]?\d+$/.test(entry.name)) {
      continue;
    }
    let held = false;
    let readErr = null;
    try {
      held = fdDirHoldsFile(path.join(procRoot, entry.name, "fd"), want, lock);
    } catch (err) {
      readErr = err;
    }
    if (readErr != null) {
      if (foreignOwner && readErr.code !== "ENOENT" && procMayOwnFile(path.join(procRoot, entry.name), lock.uid)) {
        uncertain = true;
      }
      continue;
    }
    if (held) {
      return [true, true];
    }
  }
  if (uncertain && Date.now() - lock.mtimeMs >= gitIndexLockForeignStaleAfter) {
    uncertain = false;
  }
  return [false, !uncertain];
}

let gitIndexLockForeignStaleAfter = 30 * 60 * 1000;

/**
 * 检查单个进程的 `fd` 目录中是否存在指向目标锁文件（按路径或 dev/ino 标识匹配）的文件描述符。
 *
 * @param {string} dir 进程的 `/proc/<pid>/fd` 目录路径。
 * @param {string} want 目标锁文件的绝对路径。
 * @param {fs.Stats} lock 目标锁文件的 stat 信息（用于比对 dev 与 ino）。
 * @returns {boolean} 有任意描述符指向该锁文件时返回 true，否则返回 false；无法读取 `fd` 目录本身时抛出异常。
 */
function fdDirHoldsFile(dir, want, lock) {
  const fds = fs.readdirSync(dir, { withFileTypes: true });
  for (const fd of fds) {
    const link = path.join(dir, fd.name);
    let target;
    try {
      target = fs.readlinkSync(link);
    } catch {
      continue;
    }
    if (!target.startsWith("/")) {
      continue;
    }
    if (target === want) {
      return true;
    }
    try {
      const open = fs.statSync(link);
      if (open.dev === lock.dev && open.ino === lock.ino) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * 读取 `/proc/<pid>/status` 中的 `Uid:` 行判断进程是否可能以目标 UID 运行；无法判断时保守返回 true 以免误删他人锁文件。
 *
 * @param {string} procDir 进程目录路径（`/proc/<pid>`）。
 * @param {number} uid 锁文件所属的 UID。
 * @returns {boolean} 进程可能属于该 UID 时返回 true；进程已退出或确认不属于该 UID 时返回 false。
 */
function procMayOwnFile(procDir, uid) {
  let status;
  try {
    status = fs.readFileSync(path.join(procDir, "status"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return false;
    }
    return true;
  }
  for (const line of status.split("\n")) {
    const fields = line.split(/\s+/).filter((f) => f !== "");
    if (fields.length < 2 || fields[0] !== "Uid:") {
      continue;
    }
    for (const field of fields.slice(1)) {
      if (!/^\d+$/.test(field) || Number(field) > 4294967295 || Number(field) === uid) {
        return true;
      }
    }
    return false;
  }
  return true;
}

/**
 * 通过 `git ls-files -v -z` 列出工作区中已跟踪、处于 skip-worktree 状态（首字符为 S/s）且属于旧版 Agent 配置文件的路径列表。
 *
 * @param {AbortSignal|null} ctx 上下文取消信号。
 * @param {string} workspace 仓库工作目录路径。
 * @returns {string[]} 需要解除 skip-worktree 标记的相对文件路径数组；命令失败时抛出异常。
 */
function trackedSkippedProjectAgentConfigPaths(ctx, workspace) {
  const result = spawnSync("git", ["-C", workspace, "ls-files", "-v", "-z"], {
    encoding: "buffer",
    signal: ctx instanceof AbortSignal ? ctx : undefined,
  });
  if (result.error != null) {
    throw new Error(`list tracked project Agent configuration: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`list tracked project Agent configuration: ${result.status == null ? `signal: ${result.signal}` : `exit status ${result.status}`}`);
  }
  const entries = (result.stdout ?? Buffer.alloc(0)).toString("utf8").split("\0");
  const paths = [];
  for (const entry of entries) {
    if (entry.length === 0) {
      continue;
    }
    if (entry.length < 3 || entry.charCodeAt(1) !== 32) {
      continue;
    }
    const p = entry.slice(2);
    if ((entry[0] === "S" || entry[0] === "s") && isLegacyProjectAgentConfigPath(p)) {
      paths.push(p);
    }
  }
  return paths;
}

const legacyProjectAgentDirNames = { ".agents": true, ".codex": true, ".claude": true, ".codebuddy": true };

const legacyProjectAgentFileNames = {
  "AGENTS.md": true, "AGENTS.override.md": true,
  "CLAUDE.md": true, "CLAUDE.local.md": true,
  "CODEBUDDY.md": true, ".mcp.json": true,
};

/**
 * 判断仓库内相对路径是否命中旧版 Agent 配置目录或文件名清单。
 *
 * @param {string} filePath 仓库内相对路径。
 * @returns {boolean} 命中旧版 Agent 配置路径时返回 true，否则返回 false。
 */
function isLegacyProjectAgentConfigPath(filePath) {
  const clean = path.normalize(filePath).split(path.sep).join("/");
  if (clean === "." || clean === ".." || clean.startsWith("../") || clean.startsWith("/")) {
    return false;
  }
  const parts = clean.split("/");
  for (const part of parts.slice(0, -1)) {
    if (legacyProjectAgentDirNames[part]) {
      return true;
    }
  }
  const last = parts[parts.length - 1];
  return legacyProjectAgentDirNames[last] === true || legacyProjectAgentFileNames[last] === true;
}

module.exports = { legacyProjectAgentGitExcludeBlock, agentFlowGitExcludeBlock, RestoreLegacyWorkspaceAgentConfig, RestoreLegacyProjectAgentConfig, EnsureAgentFlowGitExcludes, clearLegacyProjectAgentGitIndex, gitIndexLockWait, gitIndexLockPoll, isGitIndexLockConflict, gitIndexLockPath, gitIndexLockInUse, gitIndexLockInUseProc, gitIndexLockHeldUnder, gitIndexLockForeignStaleAfter, fdDirHoldsFile, procMayOwnFile, trackedSkippedProjectAgentConfigPaths, legacyProjectAgentDirNames, legacyProjectAgentFileNames, isLegacyProjectAgentConfigPath };
