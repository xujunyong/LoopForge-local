/**
 * @file git_auth.js
 * 对应 Go 源文件：internal/engine/git_auth.go
 * 作用与职责边界：负责工作区 Git 身份（user.name / user.email）、SSH/HTTPS 凭据上下文注入、
 * 平台用户 Git 身份与 GitHub Token 解析、Git 认证失败的可读错误解释，以及清理旧版持久化凭据文件。
 * 语法差异说明：
 * - Go 的 `context.WithValue` 译为按上下文对象存取的 `WeakMap`（`ctx` 为 `null` 时使用 `backgroundCtx` 占位）。
 * - Go 的 `(值, error)` / `error` 返回值统一转为直接返回值或无返回值，失败时 `throw Error`；
 *   仅 `explainGitAuthFailure` 属于包装并返回 `Error` 对象的纯函数，直接返回 `Error | null`。
 * - 同包函数 `gitC` 采用函数内延迟 `require`，避免与 `repository_workspace.js` 循环依赖。
 */

"use strict";

const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath
const { RepositoryProviderSSH } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryProviderSSH，project.js 已翻译
const { TokenEnv } = require("../gitwork/auth.js"); // 对应 Go 的 gitwork.TokenEnv，gitwork 未翻译
const { WithSSHKnownHostsLookup } = require("../gitwork/ssh_known_hosts.js"); // 对应 Go 的 gitwork.WithSSHKnownHostsLookup，gitwork 未翻译
const { IsSSHReference } = require("../gitwork/ssh_remote.js"); // 对应 Go 的 gitwork.IsSSHReference，gitwork 未翻译
const { WithSSHRemote } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork.WithSSHRemote，gitwork 未翻译
const { WithHTTPCredentials, WithHTTPRemote } = require("../gitwork/http_credentials.js"); // 对应 Go 的 gitwork.WithHTTPCredentials/WithHTTPRemote，gitwork 未翻译
const { RunCredentials } = require("../runtime/runtime.js"); // 对应 Go 的 runtime.RunCredentials，runtime 未翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译

// gitTokenEnv：Git 令牌环境变量名常量，透传自 gitwork.TokenEnv。
const gitTokenEnv = TokenEnv;

/**
 * Go 的 context 键类型占位；JS 中仅保留类型定义，实际上下文存取通过 `gitIdentityByCtx` 完成。
 */
class gitIdentityCtxKey {}

// gitIdentityByCtx：按 ctx 存放 Git 提交身份，ctx 为 null 时用 backgroundCtx 占位。
const gitIdentityByCtx = new WeakMap();
const backgroundCtx = {};

/**
 * Git 提交者身份信息（姓名与邮箱）。
 * 使用场景：从运行凭据或平台用户解析提交者信息，并在工作区执行 `git config --local` 时写入。
 */
class gitIdentity {
  /**
   * 构造 Git 身份对象，字段按 Go 字符串零值初始化。
   * 使用场景：创建新的 Git 身份或返回空身份零值。
   *
   * @param {object} [init={}] - 可选初始字段对象，包含 `name` 与 `email`。
   * @returns {gitIdentity} 新的 `gitIdentity` 实例。
   */
  constructor(init = {}) {
    this.name = init.name ?? "";
    this.email = init.email ?? "";
  }
}

/**
 * 向上下文注入平台 SSH known_hosts 查询回调。
 * 使用场景：执行需要 SSH 认证的 Git 操作前，让 `gitwork` 可从仓库层读取受信任的主机公钥。
 *
 * @param {object|null} ctx - 上下文对象（对应 Go 的 `context.Context`）。
 * @returns {object} 注入了 SSH known_hosts 查询回调的新上下文。
 */
Engine.prototype.withSSHKnownHosts = function (ctx) {
  return WithSSHKnownHostsLookup(ctx, this.repo.PlatformSSHKnownHosts.bind(this.repo));
};

/**
 * 根据仓库协议类型或克隆地址格式，向上下文绑定 SSH 或 HTTP 远程配置。
 * 使用场景：克隆、拉取、推送特定仓库前，为单次 Git 命令配置对应的远程认证方式。
 *
 * @param {object|null} ctx - 上下文对象。
 * @param {object} repository - 仓库上下文对象（domain.RepositoryContext）。
 * @returns {object} 绑定了远程认证配置的上下文对象。
 */
function withRepositoryGit(ctx, repository) {
  if (repository.Provider === RepositoryProviderSSH || IsSSHReference(repository.CloneURL)) {
    return WithSSHRemote(ctx, repository.CloneURL);
  }
  return WithHTTPRemote(ctx, repository.CloneURL);
}

/**
 * 将运行凭据中的多主机 HTTPS Git 凭据转换为 `gitwork` 格式并注入上下文。
 * 使用场景：定时运行、工作区准备或集成合入前，把当前运行的 HTTPS 令牌映射传入 Git 子进程上下文。
 *
 * @param {object|null} ctx - 上下文对象。
 * @param {object} credentials - 运行凭据快照（runtime.RunCredentials）。
 * @returns {object} 注入了 HTTPS 凭据映射的上下文对象。
 */
function withRunGitCredentials(ctx, credentials) {
  const hosts = {};
  for (const [host, credential] of Object.entries(credentials.GitHTTPCredentials)) {
    hosts[host] = { Username: credential.GitUsername(), Token: credential.Token };
  }
  return WithHTTPCredentials(ctx, hosts);
}

/**
 * 从仓库上下文列表中筛选出所有使用 SSH 协议的克隆地址。
 * 使用场景：预先检查或收集需要 SSH 密钥与 known_hosts 校验的仓库列表。
 *
 * @param {object[]} repositories - 仓库上下文列表（domain.RepositoryContext[]）。
 * @returns {string[]} 所有 SSH 仓库的 `CloneURL` 列表。
 */
function sshRepositoryURLs(repositories) {
  const urls = [];
  for (const repository of repositories) {
    if (repository.Provider === RepositoryProviderSSH || IsSSHReference(repository.CloneURL)) {
      urls.push(repository.CloneURL);
    }
  }
  return urls;
}

/**
 * 返回用于 Git 克隆的远程地址（原样返回，不向 URL 中拼接令牌）。
 * 使用场景：克隆仓库时构造远程地址，HTTPS 认证由命令级凭据助手完成，避免令牌泄漏到参数或 origin URL。
 *
 * @param {object|null} ctx - 上下文对象。
 * @param {string} remote - 原始远程克隆地址。
 * @returns {string} 供 Git 克隆使用的远程地址。
 */
function cloneRemoteForGit(ctx, remote) {
  // 命令级凭据助手负责 HTTPS 认证，令牌不进克隆参数与 origin URL。
  return remote;
}

/**
 * 将去空白后的 Git 姓名与邮箱写入上下文；任一字段为空时原样返回原上下文。
 * 使用场景：为后续工作区初始化或提交操作传递提交者身份。
 *
 * @param {object|null} ctx - 上下文对象。
 * @param {string} name - Git 提交者名称。
 * @param {string} email - Git 提交者邮箱。
 * @returns {object|null} 绑定了 Git 身份的上下文对象（或原上下文）。
 */
function withGitIdentity(ctx, name, email) {
  const identity = new gitIdentity({ name: name.trim(), email: email.trim() });
  if (identity.name === "" || identity.email === "") {
    return ctx;
  }
  const key = ctx ?? backgroundCtx;
  gitIdentityByCtx.set(key, identity);
  return key;
}

/**
 * 从上下文中取出已绑定的 Git 身份；若未绑定则返回空字段的零值对象。
 * 使用场景：在工作区写入本地 Git 配置前读取调用链传递的身份信息。
 *
 * @param {object|null} ctx - 上下文对象。
 * @returns {gitIdentity} 取出的 Git 身份对象（未找到时返回空字段实例）。
 */
function gitIdentityFrom(ctx) {
  if (ctx != null) {
    const identity = gitIdentityByCtx.get(ctx);
    if (identity !== undefined) {
      return identity;
    }
  }
  return new gitIdentity();
}

/**
 * 根据平台用户 ID 解析本地提交者身份，使用不可投递的占位邮箱避免编造企业或 GitHub 邮箱。
 * 使用场景：运行启动时为责任人生成默认的 Git 提交身份。
 *
 * @param {object|null} s - 持久化存储实例（repo.Store）。
 * @param {number} userID - 平台用户 ID。
 * @returns {gitIdentity} 解析出的 Git 身份；存储为空、用户不存在或登录名为空时返回零值实例。
 */
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

/**
 * 将上下文中的 Git 身份（user.name 与 user.email）写入工作区仓库的本地配置。
 * 使用场景：工作区检出或重建完成后，确保后续提交携带正确的作者信息。
 *
 * @param {object|null} ctx - 包含 Git 身份的上下文对象。
 * @param {string} workspace - Git 工作区目录路径。
 * @returns {void} 无返回值。
 * @throws {Error} 执行 `git config --local` 失败时抛出包装后的错误。
 */
function applyWorkspaceGitIdentity(ctx, workspace) {
  const { gitC } = require("./repository_workspace.js");
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

/**
 * 查询指定平台用户为 `github.com` 配置的 HTTPS Git 访问令牌。
 * 使用场景：需要访问 GitHub 仓库或 API 时获取用户的 GitHub Token。
 *
 * @param {object|null} s - 持久化存储实例（repo.Store）。
 * @param {number} userID - 平台用户 ID。
 * @returns {string} 找到的令牌字符串；未配置或入参无效时返回空字符串。
 */
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

/**
 * 当 Git 克隆、拉取或推送因认证失败报错时，附加面向责任人的可操作修复提示，并保留原始错误信息。
 * 使用场景：SOP 运行中 Git 命令失败后，将底层晦涩报错（如 `could not read Username`）转换为清晰的中文指引。
 *
 * @param {Error|null} err - 原始错误对象。
 * @param {boolean} tokenConfigured - 当前运行责任人是否已配置 Git Token。
 * @returns {Error|null} 附加中文提示后的新错误对象；非认证类错误原样返回，入参为空时返回 `null`。
 */
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

/**
 * 清除旧版 AgentFlow 持久化在工作区 `.git` 目录中的认证文件及 `include.path` 配置。
 * 使用场景：复用旧工作区或执行本地集成操作前，确保用户令牌不再残留在工作区磁盘中。
 *
 * @param {object|null} ctx - 上下文对象。
 * @param {string} workspace - Git 工作区目录路径。
 * @returns {void} 无返回值。
 * @throws {Error} 删除残留文件（非文件不存在错误）或重写 `include.path` 失败时抛出错误。
 */
function applyWorkspaceGitAuth(ctx, workspace) {
  const { gitC } = require("./repository_workspace.js");
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
