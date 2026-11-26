// clarify_workspace.js —— 对应 Go 文件：internal/engine/clarify_workspace.go
// 作用：为需求澄清准备本地仓库检出：已有则刷新到基分支，没有则浅克隆。
// (值, error) 译为返回值、失败 throw；context.Context 译为 AbortSignal。

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { RepositoryProviderSSH } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryProviderSSH，project.js 已翻译
const { ValidateRemoteURL } = require("../gitwork/remote.js"); // 对应 Go 的 gitwork.ValidateRemoteURL，gitwork 未翻译
const { WithSSHRemote } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork.WithSSHRemote，gitwork 未翻译
const { WithHTTPRemote } = require("../gitwork/http_credentials.js"); // 对应 Go 的 gitwork.WithHTTPRemote，gitwork 未翻译
const { RunCredentials } = require("../runtime/runtime.js"); // 对应 Go 的 runtime.RunCredentials，runtime 未翻译

function PrepareClarifyWorkspace(ctx, cacheDir, repo, credentials) {
  return PrepareClarifyWorkspaceAtBranch(ctx, cacheDir, repo, "", credentials);
}

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
  // git clone --branch 也接受 tag；需求必须从实际远端分支起步。
  try {
    gitC(ctx, cacheDir, "rev-parse", "--verify", "refs/remotes/origin/" + baseBranch + "^{commit}");
  } catch (err) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    throw new Error(`clarify base branch "${baseBranch}" is not a remote branch: ${err.message}`);
  }
  return cacheDir;
}

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

function ResolveClarifyGitCredentials(s, responsibleUserID) {
  // Go 的 context.Background() 无 JS 对应写法，传 null。
  return new RunCredentials({ GitHTTPCredentials: s.GitHTTPCredentialSecrets(null, responsibleUserID) });
}

module.exports = { PrepareClarifyWorkspace, PrepareClarifyWorkspaceAtBranch, refreshClarifyWorkspace, ResolveClarifyGitCredentials };
