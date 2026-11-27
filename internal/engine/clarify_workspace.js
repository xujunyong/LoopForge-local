/**
 * @file internal/engine/clarify_workspace.js
 * 对应 Go 源文件：internal/engine/clarify_workspace.go
 *
 * 作用与职责边界：
 * 为需求澄清阶段准备并维护本地代码仓库检出目录：
 * 若缓存目录已存在 `.git` 检出，则重新应用凭据并拉取强制重置到指定基分支最新提交；
 * 若尚未检出，则从仓库克隆地址执行单分支浅克隆，并校验目标基分支确实为远端分支（而非标签）；
 * 同时提供仅按责任人解析需求澄清所需 Git HTTP 凭据的辅助函数。
 *
 * 语法差异说明：
 * - Go 的 `(string, error)` 译为成功返回字符串、失败 `throw err`；仅返回 `error` 的函数成功返回 `undefined`、失败 `throw err`。
 * - Go 的 `context.Context` 译为 `AbortSignal`（无上下文时传 `null` 对应 `context.Background()`）。
 * - Go 的 `os.Stat` / `os.MkdirAll` / `os.RemoveAll` 译为 Node.js `fs.existsSync` / `fs.mkdirSync` / `fs.rmSync`。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { RepositoryProviderSSH } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryProviderSSH，project.js 已翻译
const { ValidateRemoteURL } = require("../gitwork/remote.js"); // 对应 Go 的 gitwork.ValidateRemoteURL，gitwork 未翻译
const { WithSSHRemote } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork.WithSSHRemote，gitwork 未翻译
const { WithHTTPRemote } = require("../gitwork/http_credentials.js"); // 对应 Go 的 gitwork.WithHTTPRemote，gitwork 未翻译
const { RunCredentials } = require("../runtime/runtime.js"); // 对应 Go 的 runtime.RunCredentials，runtime 未翻译
const { withRunGitCredentials, cloneRemoteForGit, applyWorkspaceGitAuth } = require("./git_auth.js"); // 对应 Go 同包函数，git_auth.js 已翻译
const { runGit, gitC } = require("./repository_workspace.js"); // 对应 Go 同包函数，repository_workspace.js 已翻译

/**
 * 确保给定仓库在本地缓存目录 `cacheDir` 存在最新检出，供需求澄清阶段读取代码。
 * 基分支默认使用仓库配置的默认分支（未配置时回退为 `"master"`）。
 * 使用场景：需求澄清启动前未指定自定义分支时调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号与上下文载体。
 * @param {string} cacheDir - 本地仓库检出缓存目录路径。
 * @param {Object} repo - 目标仓库定义（`domain.Repository`）。
 * @param {Object} credentials - 运行时 Git 凭据集合（`runtime.RunCredentials`）。
 * @returns {string} 准备就绪的本地检出目录路径（即 `cacheDir`）。
 * @throws {Error} 仓库地址非法、克隆失败或刷新分支失败时抛出错误。
 */
function PrepareClarifyWorkspace(ctx, cacheDir, repo, credentials) {
  return PrepareClarifyWorkspaceAtBranch(ctx, cacheDir, repo, "", credentials);
}

/**
 * 在本地缓存目录 `cacheDir` 检出或刷新指定基分支的仓库代码，供需求澄清阶段使用。
 * 若 `baseBranch` 为空，则回退使用仓库默认分支或 `"master"`；若目录已有 `.git` 则执行干净拉取与硬重置，否则执行单分支浅克隆并校验远端分支存在。
 * 使用场景：需求澄清按用户选择的基分支准备代码工作区时调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号与上下文载体。
 * @param {string} cacheDir - 本地仓库检出缓存目录路径。
 * @param {Object} repo - 目标仓库定义（`domain.Repository`）。
 * @param {string} baseBranch - 期望检出的基分支名称；为空时回退至仓库默认分支或 `"master"`。
 * @param {Object} credentials - 运行时 Git 凭据集合（`runtime.RunCredentials`）。
 * @returns {string} 准备就绪的本地检出目录路径（即 `cacheDir`）。
 * @throws {Error} 仓库缺少克隆地址、远端地址不合法、目录创建失败、克隆失败、认证配置失败或目标非远端分支时抛出错误。
 */
function PrepareClarifyWorkspaceAtBranch(ctx, cacheDir, repo, baseBranch, credentials) {
  const cloneURL = repo.CloneURL.trim();
  if (cloneURL === "") {
    throw new Error(`repository "${repo.ID}" has no cloneUrl`);
  }
  try {
    ValidateRemoteURL(cloneURL, true);
  } catch (err) {
    throw new Error(`repository "${repo.ID}": ${err.message}`);
  }
  baseBranch = baseBranch.trim();
  if (baseBranch === "") {
    baseBranch = repo.DefaultBranch.trim();
  }
  if (baseBranch === "") {
    baseBranch = "master";
  }

  if (repo.Provider === RepositoryProviderSSH) {
    ctx = WithSSHRemote(ctx, cloneURL);
  }
  ctx = withRunGitCredentials(ctx, credentials);
  ctx = WithHTTPRemote(ctx, cloneURL);

  if (fs.existsSync(path.join(cacheDir, ".git"))) {
    // 已有检出：刷新到最新基分支。
    refreshClarifyWorkspace(ctx, cacheDir, cloneURL, baseBranch);
    return cacheDir;
  }

  // 全新检出。
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true, mode: 0o700 });
  // 清掉残留的非 git 内容再克隆。
  fs.rmSync(cacheDir, { recursive: true, force: true });

  const args = [
    "clone", "--no-hardlinks", "--single-branch", "--depth", "1",
    "--branch", baseBranch,
    "--", cloneRemoteForGit(ctx, cloneURL), cacheDir,
  ];
  try {
    runGit(ctx, cacheDir, ...args);
  } catch (err) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    throw new Error(`clone clarify workspace: ${err.message}`);
  }
  applyWorkspaceGitAuth(ctx, cacheDir);
  try {
    gitC(ctx, cacheDir, "remote", "set-url", "--", "origin", cloneURL);
  } catch (err) {
    throw new Error(`set origin url: ${err.message}`);
  }
  // git clone --branch 也接受 tag；需求必须从实际远端分支起步，与显式 refs/heads 刷新路径保持一致。
  try {
    gitC(ctx, cacheDir, "rev-parse", "--verify", "refs/remotes/origin/" + baseBranch + "^{commit}");
  } catch (err) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    throw new Error(`clarify base branch "${baseBranch}" is not a remote branch: ${err.message}`);
  }
  return cacheDir;
}

/**
 * 在已有的本地仓库检出目录上执行干净的基分支更新：重新写入认证配置、重指 `origin` 地址、浅拉取并强制切回重置到远端基分支。
 * 使用场景：由 `PrepareClarifyWorkspaceAtBranch` 在检测到 `cacheDir/.git` 已存在时调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号与上下文载体。
 * @param {string} cacheDir - 已存在的本地仓库目录路径。
 * @param {string} cloneURL - 仓库远端克隆地址。
 * @param {string} baseBranch - 目标基分支名称。
 * @returns {void} 无返回值。
 * @throws {Error} 写入认证、设置远端地址、拉取、检出或硬重置失败时抛出错误。
 */
function refreshClarifyWorkspace(ctx, cacheDir, cloneURL, baseBranch) {
  applyWorkspaceGitAuth(ctx, cacheDir);
  try {
    gitC(ctx, cacheDir, "remote", "set-url", "--", "origin", cloneURL);
  } catch (err) {
    throw new Error(`set origin url: ${err.message}`);
  }
  const steps = [
    ["fetch", "--prune", "--depth", "1", "origin", "+refs/heads/" + baseBranch + ":refs/remotes/origin/" + baseBranch],
    ["checkout", "--force", "-B", baseBranch, "origin/" + baseBranch],
    ["reset", "--hard", "origin/" + baseBranch],
  ];
  for (const args of steps) {
    try {
      gitC(ctx, cacheDir, ...args);
    } catch (err) {
      throw new Error(`refresh clarify workspace (${args.join(" ")}): ${err.message}`);
    }
  }
}

/**
 * 仅解析责任人个人的 Git HTTP 凭据，组装为运行凭据对象供需求澄清阶段使用。
 * 使用场景：调用 `PrepareClarifyWorkspace` / `PrepareClarifyWorkspaceAtBranch` 前获取当前责任人的 Git 凭据。
 *
 * @param {Object} s - 数据仓库存储实例（`repo.Store`）。
 * @param {number} responsibleUserID - 责任人用户 ID。
 * @returns {RunCredentials} 仅包含 `GitHTTPCredentials` 字段的运行凭据实例。
 */
function ResolveClarifyGitCredentials(s, responsibleUserID) {
  // Go 的 context.Background() 无 JS 对应写法，传 null。
  return new RunCredentials({ GitHTTPCredentials: s.GitHTTPCredentialSecrets(null, responsibleUserID) });
}

module.exports = { PrepareClarifyWorkspace, PrepareClarifyWorkspaceAtBranch, refreshClarifyWorkspace, ResolveClarifyGitCredentials };
