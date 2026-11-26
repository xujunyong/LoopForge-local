// git_isolation.js —— 对应 Go 文件：internal/runtime/git_isolation.go
// 作用：清理旧版 Agent 配置的 Git 掩码、给 .agentflow/ 加 Git 排除、处理 index 锁冲突。
// Go 的 (值, error) 译为成功返回值、失败 throw；(值, bool) 译为 [值, bool]；(值, bool, error) 译为 [值, bool, 错误或 null]；
// context.Context 译为 AbortSignal；sync.Mutex 省略，JS 单线程无需加锁；Go 的 map[string]bool 译为普通对象；
// time.Duration 译为毫秒数；time.Sleep 式的轮询等待译为 Atomics.wait，函数保持同步。

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

function RestoreLegacyWorkspaceAgentConfig(ctx, workspace, repositories) {
  RestoreLegacyProjectAgentConfig(ctx, workspace);
  for (const repo of repositories) {
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
    return [output, err];
  };
  let output;
  let err;
  [output, err] = run();
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
  let inUse;
  let confirmed;
  let inspectErr;
  [inUse, confirmed, inspectErr] = gitIndexLockInUse(ctx, lockPath);
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
      [output, err] = run();
      if (err == null) {
        return;
      }
      if (!isGitIndexLockConflict(output)) {
        throw new Error(`git update-index ${mode}: ${err.message}: ${output.toString("utf8").trim()}`);
      }
    }
    [inUse, confirmed, inspectErr] = gitIndexLockInUse(ctx, lockPath);
  }
  if (ctx instanceof AbortSignal && ctx.aborted) {
    throw ctx.reason ?? new Error("context canceled");
  }
  if (inspectErr != null || !confirmed) {
    throw new Error(`git update-index ${mode}: ${err.message}: ${output.toString("utf8").trim()} (cannot safely inspect index lock: ${inspectErr.message})`);
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
  [output, err] = run();
  if (err != null) {
    throw new Error(`git update-index ${mode} after stale index lock cleanup: ${err.message}: ${output.toString("utf8").trim()}`);
  }
}

// 供测试缩短的等待时长：Go 的 time.Duration 译为毫秒数。
let gitIndexLockWait = 15 * 1000;
let gitIndexLockPoll = 200;

function isGitIndexLockConflict(output) {
  const message = output.toString("utf8").toLowerCase();
  return message.includes("index.lock") && message.includes("file exists");
}

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
    return [true, true, null];
  }
  if (result.error == null && result.status === 0) {
    return [false, true, null];
  }
  if (result.error != null) {
    return [false, false, result.error];
  }
  if (result.status === 1) {
    return [false, true, null];
  }
  return [false, false, new Error(result.status == null ? `signal: ${result.signal}` : `exit status ${result.status}`)];
}

function gitIndexLockInUseProc(lockPath) {
  return gitIndexLockHeldUnder("/proc", lockPath, typeof process.geteuid === "function" ? process.geteuid() : 0);
}

function gitIndexLockHeldUnder(procRoot, lockPath, self) {
  const want = path.resolve(lockPath);
  let lock;
  try {
    lock = fs.lstatSync(want);
  } catch (err) {
    if (err.code === "ENOENT") {
      return [false, true, null];
    }
    return [false, false, err];
  }
  if (!lock.isFile()) {
    return [false, false, new Error(`index lock ${want} is not a regular file`)];
  }
  let entries;
  try {
    entries = fs.readdirSync(procRoot, { withFileTypes: true });
  } catch (err) {
    return [false, false, err];
  }
  let uncertain = false;
  const foreignOwner = lock.uid !== self;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!/^[+-]?\d+$/.test(entry.name)) {
      continue;
    }
    const [held, readErr] = fdDirHoldsFile(path.join(procRoot, entry.name, "fd"), want, lock);
    if (readErr != null) {
      if (foreignOwner && readErr.code !== "ENOENT" && procMayOwnFile(path.join(procRoot, entry.name), lock.uid)) {
        uncertain = true;
      }
      continue;
    }
    if (held) {
      return [true, true, null];
    }
  }
  if (uncertain && Date.now() - lock.mtimeMs >= gitIndexLockForeignStaleAfter) {
    uncertain = false;
  }
  return [false, !uncertain, null];
}

let gitIndexLockForeignStaleAfter = 30 * 60 * 1000;

function fdDirHoldsFile(dir, want, lock) {
  let fds;
  try {
    fds = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return [false, err];
  }
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
      return [true, null];
    }
    try {
      const open = fs.statSync(link);
      if (open.dev === lock.dev && open.ino === lock.ino) {
        return [true, null];
      }
    } catch {
      continue;
    }
  }
  return [false, null];
}

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
