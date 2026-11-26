// git_auth.js —— 对应 Go 文件：internal/engine/git_auth.go
// 作用：工作区 Git 身份与 HTTPS 凭据：注入上下文、解析用户身份、清理旧凭据文件。
// context.WithValue 译为按 ctx 存取的 WeakMap；(值, error) 译为成功返回值、失败 throw；返回 error 值的函数译为返回 Error 对象。

"use strict";

const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath
const { RepositoryProviderSSH } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryProviderSSH，project.js 已翻译
const { TokenEnv } = require("../gitwork/auth.js"); // 对应 Go 的 gitwork.TokenEnv，gitwork 未翻译
const { WithSSHKnownHostsLookup } = require("../gitwork/ssh_known_hosts.js"); // 对应 Go 的 gitwork.WithSSHKnownHostsLookup，gitwork 未翻译
const { IsSSHReference } = require("../gitwork/ssh_remote.js"); // 对应 Go 的 gitwork.IsSSHReference，gitwork 未翻译
const { WithSSHRemote } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork.WithSSHRemote，gitwork 未翻译
const { WithHTTPCredentials } = require("../gitwork/http_credentials.js"); // 对应 Go 的 gitwork.WithHTTPCredentials，gitwork 未翻译
const { WithHTTPRemote } = require("../gitwork/http_credentials.js"); // 对应 Go 的 gitwork.WithHTTPRemote，gitwork 未翻译
const { RunCredentials } = require("../runtime/runtime.js"); // 对应 Go 的 runtime.RunCredentials，runtime 未翻译

const gitTokenEnv = TokenEnv;

// gitIdentityCtxKey：Go 的 context 键类型，JS 里仅保留类型定义，实际存取走 gitIdentityByCtx。
class gitIdentityCtxKey {}

// gitIdentityByCtx：按 ctx 存放 git 身份，ctx 为 null 时用 backgroundCtx 占位。
const gitIdentityByCtx = new WeakMap();
const backgroundCtx = {};

class gitIdentity {
  constructor(init = {}) {
    this.name = init.name ?? "";
    this.email = init.email ?? "";
  }
}

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译

Engine.prototype.withSSHKnownHosts = function (ctx) {
  return WithSSHKnownHostsLookup(ctx, this.repo.PlatformSSHKnownHosts);
};

function withRepositoryGit(ctx, repository) {
  if (repository.Provider === RepositoryProviderSSH || IsSSHReference(repository.CloneURL)) {
    return WithSSHRemote(ctx, repository.CloneURL);
  }
  return WithHTTPRemote(ctx, repository.CloneURL);
}

function withRunGitCredentials(ctx, credentials) {
  const hosts = {};
  for (const [host, credential] of Object.entries(credentials.GitHTTPCredentials)) {
    hosts[host] = { Username: credential.GitUsername(), Token: credential.Token };
  }
  return WithHTTPCredentials(ctx, hosts);
}

function sshRepositoryURLs(repositories) {
  const urls = [];
  for (const repository of repositories) {
    if (repository.Provider === RepositoryProviderSSH || IsSSHReference(repository.CloneURL)) {
      urls.push(repository.CloneURL);
    }
  }
  return urls;
}

function cloneRemoteForGit(ctx, remote) {
  // 命令级凭据助手负责 HTTPS 认证，令牌不进克隆参数与 origin URL。
  return remote;
}

function withGitIdentity(ctx, name, email) {
  const identity = new gitIdentity({ name: name.trim(), email: email.trim() });
  if (identity.name === "" || identity.email === "") {
    return ctx;
  }
  const key = ctx ?? backgroundCtx;
  gitIdentityByCtx.set(key, identity);
  return key;
}

function gitIdentityFrom(ctx) {
  if (ctx != null) {
    const identity = gitIdentityByCtx.get(ctx);
    if (identity !== undefined) {
      return identity;
    }
  }
  return new gitIdentity();
}

function resolveGitIdentity(s, userID) {
  if (s == null || userID <= 0) {
    return new gitIdentity();
  }
  const [user, ok] = s.User(userID);
  if (!ok) {
    return new gitIdentity();
  }
  const login = user.LoginName.trim();
  if (login === "") {
    return new gitIdentity();
  }
  // 本地平台账号不代表企业或 GitHub 身份，用不可投递地址，不编造企业邮箱。
  return new gitIdentity({ name: login, email: login + "@users.noreply.loopforge.invalid" });
}

function applyWorkspaceGitIdentity(ctx, workspace) {
  const identity = gitIdentityFrom(ctx);
  if (identity.name === "" || identity.email === "") {
    return;
  }
  for (const item of [
    { key: "user.name", value: identity.name },
    { key: "user.email", value: identity.email },
  ]) {
    try {
      gitC(ctx, workspace, "config", "--local", item.key, item.value);
    } catch (err) {
      throw new Error(`configure git ${item.key}: ${err.message}`);
    }
  }
}

function resolveGitHubToken(s, userID) {
  if (s != null && userID > 0) {
    const [credential, ok] = s.GitHTTPCredentialForHost(null, userID, "github.com");
    if (ok) {
      return credential.Token;
    }
  }
  return "";
}

const gitCommandFailure = /repository checkout|git (clone|fetch|pull|push|ls-remote)/i;
const gitAuthFailure = /could not read Username|Authentication failed|HTTP Basic: Access denied|requested URL returned error: 40[13]|Invalid username or password/i;

const gitTokenFixHint = "请责任人到「个人配置 → Git 访问令牌」为仓库的准确主机配置 HTTPS 令牌，并填写该平台要求的用户名、确认仓库权限，然后重试本节点";

// explainGitAuthFailure：说明 Git 拒绝克隆或推送时该怎么修；SOP 用责任人的 Git Token，git 自身报错不会提到它，原始错误保留在后。
function explainGitAuthFailure(err, tokenConfigured) {
  if (err == null) {
    return null;
  }
  const msg = err.message;
  if (msg.includes("Git Token") || !gitCommandFailure.test(msg) || !gitAuthFailure.test(msg)) {
    return err;
  }
  if (!tokenConfigured) {
    return new Error(`运行责任人未配置 Git Token，无法拉取仓库。${gitTokenFixHint}。原始错误：${err.message}`);
  }
  return new Error(`运行责任人的 Git Token 无效、已过期或权限不足，无法拉取仓库。${gitTokenFixHint}；并确认责任人对该仓库有权限。原始错误：${err.message}`);
}

const gitAuthIncludeFile = "agentflow.auth";
const gitAskPassFile = "agentflow-askpass";
const gitAskPassSecretFile = "agentflow-askpass-secret";

// applyWorkspaceGitAuth：清除旧版 AgentFlow 持久化的凭据；Git 认证只供给相关子进程，令牌不进运行工作区。
function applyWorkspaceGitAuth(ctx, workspace) {
  const gitDir = path.join(workspace, ".git");
  let info;
  try {
    info = fs.statSync(gitDir);
  } catch {
    return;
  }
  if (!info.isDirectory()) {
    return;
  }
  for (const name of [gitAuthIncludeFile, gitAskPassFile, gitAskPassSecretFile]) {
    try {
      fs.unlinkSync(path.join(gitDir, name));
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
  }
  let configured = "";
  try {
    configured = gitC(ctx, workspace, "config", "--local", "--get-all", "include.path");
  } catch {}
  try {
    gitC(ctx, workspace, "config", "--local", "--unset-all", "include.path");
  } catch {}
  for (let include of configured.split("\n")) {
    include = include.trim();
    if (include === "" || include === gitAuthIncludeFile) {
      continue;
    }
    gitC(ctx, workspace, "config", "--local", "--add", "include.path", include);
  }
}

module.exports = { gitTokenEnv, gitIdentityCtxKey, gitIdentity, withRepositoryGit, withRunGitCredentials, sshRepositoryURLs, cloneRemoteForGit, withGitIdentity, gitIdentityFrom, resolveGitIdentity, applyWorkspaceGitIdentity, resolveGitHubToken, gitCommandFailure, gitAuthFailure, gitTokenFixHint, explainGitAuthFailure, gitAuthIncludeFile, gitAskPassFile, gitAskPassSecretFile, applyWorkspaceGitAuth };
