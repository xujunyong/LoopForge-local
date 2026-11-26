// git_https_hosts.js —— 对应 Go 文件：internal/repo/git_https_hosts.go
// 作用：平台授权的 Git HTTPS 端点：增删改查与拨号目标地址。

"use strict";

const { randomBytes } = require("node:crypto"); // Go crypto/rand

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { HTTPSHostScope } = require("../gitwork/https_host.js"); // 对应 Go 的 gitwork 包，gitwork 未翻译
const { platformGitHostRevisionWhere } = require("./ssh_host_trust.js"); // 对应 Go 同包常量，ssh_host_trust.js 待翻译

// HTTPSHostTrustRepo：平台授权的精确 HTTPS 端点，对应 Go 的 git_https_hosts.go 中的同名类型。
// Go 的 *deps 嵌入提供 DB，JS 里随 repo.js 补齐。
class HTTPSHostTrustRepo {
  constructor(init = {}) {
    this.DB = init.DB ?? null;
  }

  ListPlatformGitHTTPSHosts(ctx) {
    const hosts = [];
    const err = this.DB.WithContext(ctx).Order("host").Find(hosts).Error;
    return [hosts, err];
  }

  GitHTTPSHostChoices(ctx) {
    const hosts = [];
    const err = this.DB.WithContext(ctx).Model(new PlatformGitHTTPSHost()).Select("host", "platform").Order("host").Find(hosts).Error;
    return [hosts, err];
  }

  CreatePlatformGitHTTPSHost(ctx, entry) {
    entry.Revision = randomBytes(24).toString("base64url"); // Go 的 rand.Text 译为随机 base64url 文本。
    return this.DB.WithContext(ctx).Create(entry).Error;
  }

  UpdatePlatformGitHTTPSHost(ctx, entry, expected) {
    const next = randomBytes(24).toString("base64url");
    const result = this.DB.WithContext(ctx).Model(new PlatformGitHTTPSHost()).
      Where(platformGitHostRevisionWhere, entry.Host, entry.Host, expected).
      Select("platform", "addresses", "revision").
      Updates(new PlatformGitHTTPSHost({ Platform: entry.Platform, Addresses: entry.Addresses, Revision: next }));
    if (result.Error != null) {
      return result.Error;
    }
    if (result.RowsAffected === 0) {
      return ErrGitHTTPSHostChanged;
    }
    entry.Revision = next;
    return null;
  }

  DeletePlatformGitHTTPSHost(ctx, host, expected) {
    const result = this.DB.WithContext(ctx).Where(platformGitHostRevisionWhere, host, host, expected).Delete(new PlatformGitHTTPSHost());
    if (result.Error != null) {
      return result.Error;
    }
    if (result.RowsAffected === 0) {
      return ErrGitHTTPSHostChanged;
    }
    return null;
  }

  // PlatformGitHTTPSAddresses：查拨号目标的授权记录；只有缺记录时才允许按部署策略回退。
  PlatformGitHTTPSAddresses(ctx, target) {
    const [host, err] = HTTPSHostScope(target);
    if (err != null) {
      return [null, err];
    }
    const entry = new PlatformGitHTTPSHost();
    const takeErr = this.DB.WithContext(ctx).Select("host", "addresses").Where("host = ?", host).Take(entry).Error;
    if (takeErr === gorm.ErrRecordNotFound || (takeErr == null && entry.Host !== host)) {
      return [null, null];
    }
    if (takeErr != null) {
      return [null, takeErr];
    }
    if ((entry.Addresses ?? []).length === 0) {
      return [null, new Error("Git HTTPS host authorization has no addresses")];
    }
    return [entry.Addresses, null];
  }
}

const ErrGitHTTPSHostChanged = new Error("platform Git HTTPS host authorization changed");

class PlatformGitHTTPSHost {
  constructor(init = {}) {
    this.Host = init.Host ?? "";
    this.Platform = init.Platform ?? "";
    this.Addresses = init.Addresses ?? null;
    this.Revision = init.Revision ?? "";
  }

  TableName() {
    return "platform_git_https_hosts";
  }
}

class GitHTTPSHostChoice {
  constructor(init = {}) {
    this.Host = init.Host ?? "";
    this.Platform = init.Platform ?? "";
  }
}

module.exports = { HTTPSHostTrustRepo, ErrGitHTTPSHostChanged, PlatformGitHTTPSHost, GitHTTPSHostChoice };
