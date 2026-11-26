// git_http_credentials.js —— 对应 Go 文件：internal/repo/git_http_credentials.go
// 作用：用户 HTTPS Git 凭据的增删改查、托管凭据与执行派发。

"use strict";

const { createHash } = require("node:crypto"); // Go crypto/sha256：摘要后转十六进制

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { GongfengHost } = require("../config/integration_hosts.js"); // 对应 Go 的 config.GongfengHost，config 已翻译
const { GitHTTPCredential, GitHTTPCredentialSecret, GitHTTPExecutionCredential, GitPlatformGitLab, ManagedGitHTTPCredentialID } = require("../domain/user.js"); // 对应 Go 的 domain.*，domain 已翻译
const { HTTPSHostScope, HTTPSRemoteHost } = require("../gitwork/https_host.js"); // 对应 Go 的 gitwork 包，gitwork 未翻译
const { OAuthHTTPUser, HTTPUser, SplitToken } = require("../gitwork/auth.js"); // 对应 Go 的 gitwork 包，gitwork 未翻译
const { ConfigFromEnv } = require("../gongfeng/oauth.js"); // 对应 Go 的 gongfeng.ConfigFromEnv，gongfeng 已翻译
const { gitHTTPCredentialRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译
const { formatManagedGitCredential } = require("./gongfeng_credential.js"); // 对应 Go 同包函数，gongfeng_credential.js 本次一同翻译

const ErrGitHTTPCredentialExists = new Error("该主机已有访问令牌，请编辑现有凭据");
const ErrGitHTTPTokenRequired = new Error("添加凭据时请填写访问令牌");
const ErrGitHTTPCredentialManaged = new Error("内部托管凭据由平台维护，不能在这里修改或删除");

function gitHTTPCredentialID(host) {
  return createHash("sha256").update(host, "utf8").digest("hex");
}

gitHTTPCredentialRow.prototype.secret = function () {
  return new GitHTTPCredentialSecret({ ID: this.ID, Name: this.Name, Platform: this.Platform, Host: this.Host, Username: this.Username, Token: this.Token });
};

// managedGitHost：内部适配器 Git 服务的 HTTPS 主机。
function managedGitHost() {
  const configured = GongfengHost();
  if (configured !== "") {
    const [normalized] = HTTPSHostScope(configured);
    return normalized;
  }
  const [host] = HTTPSRemoteHost(ConfigFromEnv().APIBase);
  return host;
}

// managedGitHTTPCredential：把 user_configs 里的内部适配器 OAuth 或 private: 令牌
// 呈现为只读凭据，不刷新；纯粘贴令牌属于个人凭据。
function managedGitHTTPCredential(user) {
  const raw = formatManagedGitCredential(user);
  const lower = raw.toLowerCase();
  if (!lower.startsWith(OAuthHTTPUser + ":") && !lower.startsWith(HTTPUser + ":")) {
    return [new GitHTTPCredentialSecret(), false];
  }
  const host = managedGitHost();
  const [username, token] = SplitToken(raw);
  if (host === "" || token === "") {
    return [new GitHTTPCredentialSecret(), false];
  }
  const secret = new GitHTTPCredentialSecret({ ID: ManagedGitHTTPCredentialID, Name: "内部托管凭据", Platform: GitPlatformGitLab, Host: host, Username: username, Managed: true, Token: token });
  if (user.GongfengRefreshToken.trim() !== "") {
    secret.ExpiresAt = user.GongfengTokenExpiresAt;
  }
  return [secret, true];
}

// GitHTTPCredentials：用户 HTTPS Git 凭据描述，末尾附托管凭据；token 从不进描述。
UsersRepo.prototype.GitHTTPCredentials = function (userID) {
  const rows = [];
  const err = this.DB.Select("id", "name", "platform", "host", "username").Where("user_id = ?", userID).Order("name, id").Find(rows).Error;
  if (err != null) {
    return [null, err];
  }
  const out = [];
  const hosts = {};
  for (const row of rows) {
    // Go 取嵌入的 GitHTTPCredential 值；JS 里子类实例即该类型，且 Select 未读 token 列。
    out.push(row.secret());
    hosts[row.Host] = true;
  }
  const [user, ok] = this.User(userID);
  if (ok) {
    const [managed, managedOk] = managedGitHTTPCredential(user);
    if (managedOk && !hosts[managed.Host]) {
      out.push(managed);
    }
  }
  return [out, null];
};

// SaveGitHTTPCredential：existingID 为空时按 input.Host 新建，否则更新该凭据；空 token 保留原值，主机不可改。
UsersRepo.prototype.SaveGitHTTPCredential = function (userID, existingID, input) {
  if (existingID === ManagedGitHTTPCredentialID) {
    return ErrGitHTTPCredentialManaged;
  }
  const [host, err] = HTTPSHostScope(input.Host);
  if (err != null) {
    return err;
  }
  const id = gitHTTPCredentialID(host);
  const now = new Date();
  if (existingID === "") {
    if (input.Token === "") {
      return ErrGitHTTPTokenRequired;
    }
    const row = new gitHTTPCredentialRow({ UserID: userID, ID: id, Name: input.Name, Platform: input.Platform, Host: host, Username: input.Username, Token: input.Token, Created: now, Updated: now });
    const createErr = this.DB.Create(row).Error;
    if (createErr === gorm.ErrDuplicatedKey) {
      return ErrGitHTTPCredentialExists;
    }
    return createErr;
  }
  if (existingID !== id) {
    return gorm.ErrRecordNotFound;
  }
  const row = this.DB.Model(new gitHTTPCredentialRow()).Where("user_id = ? AND id = ?", userID, id);
  const updates = { name: input.Name, platform: input.Platform, username: input.Username, updated_at: now };
  if (input.Token !== "") {
    updates.token = input.Token;
  }
  const result = row.Session(new gorm.Session()).Updates(updates);
  if (result.Error != null || result.RowsAffected !== 0) {
    return result.Error;
  }
  // MySQL can report zero affected rows for an unchanged value.
  // Go 的 Count(&count) 用对象接出参。
  const countOut = { value: 0 };
  const countErr = row.Count(countOut).Error;
  if (countErr != null) {
    return countErr;
  }
  if (countOut.value === 0) {
    return gorm.ErrRecordNotFound;
  }
  return null;
};

UsersRepo.prototype.DeleteGitHTTPCredential = function (userID, id) {
  if (id === ManagedGitHTTPCredentialID) {
    return ErrGitHTTPCredentialManaged;
  }
  return this.DB.Where("user_id = ? AND id = ?", userID, id).Delete(new gitHTTPCredentialRow()).Error;
};

// GitHTTPCredentialForHost：取某一 host[:port] 的凭据，托管 OAuth 令牌先刷新。
UsersRepo.prototype.GitHTTPCredentialForHost = async function (ctx, userID, host) {
  const [scopedHost, scopeErr] = HTTPSHostScope(host);
  if (scopeErr != null || userID <= 0) {
    return [new GitHTTPCredentialSecret(), false];
  }
  host = scopedHost;
  const row = new gitHTTPCredentialRow();
  if (this.DB.Where("user_id = ? AND id = ?", userID, gitHTTPCredentialID(host)).Limit(1).Find(row).Error != null) {
    return [new GitHTTPCredentialSecret(), false];
  }
  if (row.ID !== "" && row.Host === host && row.Token !== "") {
    return [row.secret(), true];
  }
  if (host !== managedGitHost()) {
    return [new GitHTTPCredentialSecret(), false];
  }
  return this.refreshedManagedGitHTTPCredential(ctx, userID);
};

// GitHTTPCredentialSecrets：只供已认证的执行派发；公开设置与运行快照仍用凭据描述。
UsersRepo.prototype.GitHTTPCredentialSecrets = async function (ctx, userID) {
  const out = {};
  const [credentials, err] = this.GitHTTPCredentials(userID);
  if (err != null) {
    return out;
  }
  for (const credential of credentials) {
    const [secret, ok] = await this.GitHTTPCredentialForHost(ctx, userID, credential.Host);
    if (ok) {
      out[credential.Host] = new GitHTTPExecutionCredential({ ID: secret.ID, Name: secret.Name, Platform: secret.Platform, Host: secret.Host, Username: secret.Username, Managed: secret.Managed, Token: secret.Token, ExpiresAt: secret.ExpiresAt });
    }
  }
  return out;
};

// GitHTTPCredentialByID：取一条已列出凭据做校验。
UsersRepo.prototype.GitHTTPCredentialByID = async function (ctx, userID, id) {
  if (id === ManagedGitHTTPCredentialID) {
    return this.refreshedManagedGitHTTPCredential(ctx, userID);
  }
  const row = new gitHTTPCredentialRow();
  const err = this.DB.Where("user_id = ? AND id = ?", userID, id).Limit(1).Find(row).Error;
  if (err != null || row.ID === "") {
    return [new GitHTTPCredentialSecret(), false];
  }
  return [row.secret(), true];
};

UsersRepo.prototype.refreshedManagedGitHTTPCredential = async function (ctx, userID) {
  if ((await this.managedGitCredential(ctx, userID)) === "") {
    return [new GitHTTPCredentialSecret(), false];
  }
  const [user, ok] = this.User(userID);
  if (!ok) {
    return [new GitHTTPCredentialSecret(), false];
  }
  return managedGitHTTPCredential(user);
};

// GitHTTPWorkspaceHosts：把用户交给工作区轮次的各凭据主机映射到平台；不带 token。
UsersRepo.prototype.GitHTTPWorkspaceHosts = function (userID) {
  if (userID <= 0) {
    return null;
  }
  const [creds, err] = this.GitHTTPCredentials(userID);
  if (err != null) {
    return null;
  }
  const hosts = {};
  for (const cred of creds) {
    hosts[cred.Host] = cred.Platform;
  }
  return hosts;
};

module.exports = { ErrGitHTTPCredentialExists, ErrGitHTTPTokenRequired, ErrGitHTTPCredentialManaged, gitHTTPCredentialID, managedGitHost, managedGitHTTPCredential };
