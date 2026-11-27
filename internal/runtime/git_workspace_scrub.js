// git_workspace_scrub.js —— 对应 Go 文件：internal/runtime/git_workspace_scrub.go
//
// 文件作用与职责边界：
// 清理 Agent 在工作区执行回合中手动写入的 Git 凭据文件，以及各 HOME 目录和工作区子检出目录的
// Git 配置文件中的 HTTPS userinfo 与 Authorization 请求头，防止平台下发的令牌随工作区快照泄漏。
//
// Go 与 JS 语法差异说明：
// - Go 的 `context.Context` 译为 `AbortSignal`，`context.WithTimeout` 用 `AbortController` + `setTimeout` 并在 `finally` 中清理定时器实现；
// - Go 的 `(值, error)` 译为成功返回值、失败 `throw`；`os.OpenRoot` 在本文件内以锚定目录路径的 `fs.*Sync` 包装对象表达；
// - Go 的 `map[string]bool` 译为普通对象 `{}`；`os/exec.CommandContext` 译为 `child_process.spawnSync`。

"use strict";

const fs = require("node:fs"); // 对应 Go 标准库 os
const os = require("node:os"); // 对应 Go 标准库 os.DevNull
const path = require("node:path"); // 对应 Go 标准库 path / path/filepath
const { spawnSync } = require("node:child_process"); // 对应 Go 标准库 os/exec

const { Checkouts } = require("../gitwork/checkouts.js"); // 对应 Go 的 gitwork.Checkouts，checkouts.js 待翻译
const { openWorkspacePath } = require("./managed_files.js"); // 对应 Go 同包函数

// workspaceGitCredentialFiles 天然存放凭据。Git 在工作区回合中不会主动写入这些文件
// （其 credential helper 列表已被重置），因此出现这些文件说明由 Agent 写入，可能包含平台下发的令牌。
const workspaceGitCredentialFiles = [
  ".git-credentials",
  ".netrc",
  "_netrc",
  ".config/gh",
  ".config/glab-cli",
  ".config/tea",
];

// 匹配 Git 配置中携带 userinfo 的 HTTP/HTTPS URL 前缀。
const gitConfigUserinfoURL = /\bhttps?:\/\/[^/\s@]+@/i;

/**
 * 清理 Agent 在工作区回合中手动写入的 Git 凭据：
 * 删除各 HOME 目录下的凭据文件，并清除各 HOME 的 Git 配置以及工作区内所有检出仓库 `.git/config` 中的
 * HTTPS userinfo 或 Authorization 请求头。返回已清理项的脱敏描述列表（不含具体密钥值）。
 *
 * @param {AbortSignal | null} ctx 用于取消子进程的上下文信号。
 * @param {string[]} homes 需要检查并清理的 HOME 目录路径列表。
 * @param {string} workspace 工作区根目录路径，用于枚举其下所有 Git 检出目录。
 * @returns {string[]} 已清理项的描述列表（不含敏感值）。
 */
function ScrubWorkspaceGitSecrets(ctx, homes, workspace) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(ctx.reason);
  if (ctx instanceof AbortSignal) {
    if (ctx.aborted) {
      controller.abort(ctx.reason);
    } else {
      ctx.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), 30 * 1000);
  const scrubCtx = controller.signal;
  try {
    const cleaned = [];
    for (const home of homes ?? []) {
      if ((home ?? "").trim() === "") {
        continue;
      }
      // 对应 Go 的 os.OpenRoot(home)：先验证目录存在，防止符号链接父目录将删除操作导向外部路径。
      let homeRoot = null;
      try {
        const baseAbs = path.resolve(home);
        const st = fs.statSync(baseAbs);
        if (!st.isDirectory()) {
          continue;
        }
        homeRoot = {
          base: baseAbs,
          Lstat(rel) {
            return fs.lstatSync(path.join(baseAbs, rel));
          },
          RemoveAll(rel) {
            fs.rmSync(path.join(baseAbs, rel), { recursive: true, force: true });
          },
          Close() {},
        };
      } catch {
        continue;
      }
      for (const name of workspaceGitCredentialFiles) {
        const rel = name.split("/").join(path.sep);
        try {
          homeRoot.Lstat(rel);
          homeRoot.RemoveAll(rel);
          cleaned.push("HOME/" + name);
        } catch {
          // 文件不存在或删除失败时按 Go 原文跳过。
        }
      }
      homeRoot.Close();
      for (const name of [".gitconfig", ".config/git/config"]) {
        for (const key of scrubGitConfigFile(scrubCtx, home, path.join(home, name.split("/").join(path.sep))) ?? []) {
          cleaned.push("HOME/" + name + " " + key);
        }
      }
    }
    if ((workspace ?? "").trim() !== "") {
      for (const checkout of Checkouts(scrubCtx, workspace) ?? []) {
        const config = path.join(workspace, checkout.Dir.split("/").join(path.sep), ".git", "config");
        for (const key of scrubGitConfigFile(scrubCtx, workspace, config) ?? []) {
          cleaned.push(path.posix.join(checkout.Dir, ".git/config") + " " + key);
        }
      }
    }
    return cleaned;
  } finally {
    clearTimeout(timer);
    if (ctx instanceof AbortSignal) {
      ctx.removeEventListener("abort", onParentAbort);
    }
  }
}

/**
 * 清理单个 Git 配置文件中的敏感凭据：剥离 URL 值中的 HTTPS userinfo、移除节名携带 userinfo 的 `url.*` 配置节、
 * 并取消设置包含 `authorization` 的 `*.extraheader` 项。若文件经由符号链接可达则直接跳过，避免读取并写回根目录之外的文件。
 *
 * @param {AbortSignal | null} ctx 用于取消 `git config` 子进程的上下文信号。
 * @param {string} base 允许访问的根目录边界（HOME 或工作区根目录）。
 * @param {string} file 待清理的 Git 配置文件路径。
 * @returns {string[] | null} 本次从该文件中清理出的配置键或脱敏节名列表；文件不可用或非普通文件时返回 `null`。
 */
function scrubGitConfigFile(ctx, base, file) {
  let root;
  let rel;
  try {
    [root, rel] = openWorkspacePath(base, file);
  } catch {
    return null;
  }
  let info;
  try {
    info = root.Lstat(rel);
  } catch {
    root.Close();
    return null;
  }
  root.Close();
  if (!info.isFile()) {
    return null;
  }
  let out;
  try {
    out = scrubGit(ctx, file, "--no-includes", "--null", "--list");
  } catch {
    return null;
  }
  const cleaned = [];
  const removed = {};
  for (const entry of out.toString("utf8").split("\0")) {
    const nl = entry.indexOf("\n");
    const key = nl >= 0 ? entry.slice(0, nl) : entry;
    const value = nl >= 0 ? entry.slice(nl + 1) : "";
    if (key === "") {
      continue;
    }
    const lower = key.toLowerCase();
    const [section] = cutLast(key, ".");
    if (lower.startsWith("url.") && gitConfigUserinfoURL.test(section)) {
      if (removed[section]) {
        continue;
      }
      removed[section] = true;
      try {
        scrubGit(ctx, file, "--remove-section", section);
        cleaned.push("url.<redacted>");
      } catch {
        // 按 Go 原文忽略单条清理失败。
      }
    } else if (lower.endsWith(".extraheader") && value.toLowerCase().includes("authorization")) {
      if (removed[key]) {
        continue;
      }
      removed[key] = true;
      try {
        scrubGit(ctx, file, "--unset-all", key);
        cleaned.push(key);
      } catch {
        // 按 Go 原文忽略单条清理失败。
      }
    } else if (gitConfigUserinfoURL.test(value)) {
      try {
        scrubGit(ctx, file, "--fixed-value", "--replace-all", key, stripURLUserinfo(value), value);
        cleaned.push(key);
      } catch {
        // 按 Go 原文忽略单条清理失败。
      }
    }
  }
  return cleaned;
}

/**
 * 去除字符串中 HTTP/HTTPS URL 的 userinfo 部分。优先使用标准 URL 解析器清除用户名与密码；
 * 若值不是完整单个 URL 或不含标准 userinfo，则回退为按正则逐处剥离。
 *
 * @param {string} value 可能包含凭据的 Git 配置值。
 * @returns {string} 去除 userinfo 后的字符串。
 */
function stripURLUserinfo(value) {
  try {
    const u = new URL(value);
    if (u.username !== "" || u.password !== "") {
      u.username = "";
      u.password = "";
      return u.toString();
    }
  } catch {
    // 非标准 URL 时走下方正则回退。
  }
  return value.replace(new RegExp(gitConfigUserinfoURL.source, "gi"), (match) => {
    const idx = match.indexOf("://");
    const scheme = idx >= 0 ? match.slice(0, idx) : match;
    return scheme + "://";
  });
}

/**
 * 按最后一个分隔符将字符串切分为前后两段，用于从 Git 配置键中分离配置节与键名。
 *
 * @param {string} value 待切分的原始字符串。
 * @param {string} sep 分隔符子串。
 * @returns {[string, string, boolean]} 返回 `[before, after, found]`；未找到分隔符时返回 `[value, "", false]`。
 */
function cutLast(value, sep) {
  const i = value.lastIndexOf(sep);
  if (i < 0) {
    return [value, "", false];
  }
  return [value.slice(0, i), value.slice(i + sep.length), true];
}

/**
 * 在隔离全局/系统配置的环境中执行 `git config --file <file> ...`，确保被清理的配置文件
 * 无法通过 include 或外部配置诱导 git 执行任意程序。
 *
 * @param {AbortSignal | null} ctx 用于取消子进程的上下文信号。
 * @param {string} file 目标 Git 配置文件路径。
 * @param {...string} args 追加传给 `git config --file <file>` 的参数列表。
 * @returns {Buffer} 命令的标准输出字节缓冲；命令执行失败或非零退出时抛出 `Error`。
 */
function scrubGit(ctx, file, ...args) {
  const result = spawnSync("git", ["config", "--file", file, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_COUNT: "0",
    },
    encoding: "buffer",
    signal: ctx instanceof AbortSignal ? ctx : undefined,
  });
  if (result.error != null) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.status == null ? `signal: ${result.signal}` : `exit status ${result.status}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

module.exports = {
  workspaceGitCredentialFiles,
  gitConfigUserinfoURL,
  ScrubWorkspaceGitSecrets,
  scrubGitConfigFile,
  stripURLUserinfo,
  cutLast,
  scrubGit,
};
