// ssh_host_trust.js —— 对应 Go 文件：internal/repo/ssh_host_trust.go
// 作用：平台 Git SSH 主机密钥登记：增删改查与 known_hosts 生成。

"use strict";

const { Buffer } = require("node:buffer");
const { randomBytes } = require("node:crypto"); // Go crypto/rand

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const knownhosts = require("golang.org/x/crypto/ssh/knownhosts"); // Go 第三方包 golang.org/x/crypto/ssh/knownhosts

const { NormalizeSSHHostPublicKeys } = require("../gitwork/ssh_host_public_keys.js"); // 对应 Go 的 gitwork 包，gitwork 未翻译

const ErrPlatformGitSSHHostChanged = new Error("platform Git SSH host trust changed");

// 按主键查找并逐字节比较两个字符串，即使数据库排序规则认为不同的旧值等价。
const platformGitHostRevisionWhere = "host = ? AND HEX(host) = HEX(?) AND HEX(revision) = HEX(?)";

class PlatformGitSSHHost {
  constructor(init = {}) {
    this.Host = init.Host ?? "";
    this.PublicKeys = init.PublicKeys ?? "";
    this.Revision = init.Revision ?? "";
  }

  TableName() {
    return "platform_git_ssh_hosts";
  }
}

SSHHostTrustRepo.prototype.ListPlatformGitSSHHosts = function (ctx) {
  const hosts = [];
  const err = this.DB.WithContext(ctx).Order("host").Find(hosts).Error;
  return [hosts, err];
};

SSHHostTrustRepo.prototype.CreatePlatformGitSSHHost = function (ctx, entry) {
  entry.Revision = randomBytes(24).toString("base64url"); // Go 的 rand.Text 译为随机 base64url 文本。
  return this.DB.WithContext(ctx).Create(entry).Error;
};

SSHHostTrustRepo.prototype.UpdatePlatformGitSSHHost = function (ctx, entry, expectedRevision) {
  const nextRevision = randomBytes(24).toString("base64url"); // Go 的 rand.Text 译为随机 base64url 文本。
  const result = this.DB.WithContext(ctx).Model(new PlatformGitSSHHost()).
    Where(platformGitHostRevisionWhere, entry.Host, entry.Host, expectedRevision).
    Updates({ public_keys: entry.PublicKeys, revision: nextRevision });
  if (result.Error != null) {
    return result.Error;
  }
  if (result.RowsAffected === 0) {
    return ErrPlatformGitSSHHostChanged;
  }
  entry.Revision = nextRevision;
  return null;
};

SSHHostTrustRepo.prototype.DeletePlatformGitSSHHost = function (ctx, host, expectedRevision) {
  const result = this.DB.WithContext(ctx).
    Where(platformGitHostRevisionWhere, host, host, expectedRevision).
    Delete(new PlatformGitSSHHost());
  if (result.Error != null) {
    return result.Error;
  }
  if (result.RowsAffected === 0) {
    return ErrPlatformGitSSHHostChanged;
  }
  return null;
};

SSHHostTrustRepo.prototype.PlatformSSHKnownHosts = function (ctx, scopes) {
  const entries = [];
  const findErr = this.DB.WithContext(ctx).Where("host IN ?", scopes).Find(entries).Error;
  if (findErr != null) {
    return [null, findErr];
  }
  let knownHosts = ""; // Go 的 strings.Builder 译为字符串拼接。
  for (const entry of entries) {
    // 数据库排序规则也可能匹配非规范行，只允许精确端点贡献受信密钥。
    if (!scopes.includes(entry.Host)) {
      continue;
    }
    const [keys, , normalizeErr] = NormalizeSSHHostPublicKeys(entry.PublicKeys);
    if (normalizeErr != null) {
      continue;
    }
    const host = knownhosts.Normalize(entry.Host);
    for (const publicKey of keys.split("\n")) {
      knownHosts += `${host} ${publicKey}\n`;
    }
  }
  return [Buffer.from(knownHosts, "utf8"), null];
};

module.exports = { ErrPlatformGitSSHHostChanged, platformGitHostRevisionWhere, PlatformGitSSHHost };
