/**
 * @file internal/repo/git_https_hosts.js
 * @description 对应 Go 文件：internal/repo/git_https_hosts.go
 * 职责与边界：定义平台级 Git HTTPS 端点授权仓库 `HTTPSHostTrustRepo` 及表模型 `PlatformGitHTTPSHost`、
 * 选项结构 `GitHTTPSHostChoice`，负责精确 HTTPS 端点授权记录的增删改查（含乐观锁修订号校验）与拨号目标地址解析。
 * 语法差异说明：
 * - Go 的 `(值, error)` 译为成功直接返回值、失败 `throw err`；仅 `error` 译为成功无返回值、失败 `throw err`。
 * - Go 的 `rand.Text()` 译为 `randomBytes(24).toString("base64url")` 生成随机修订号文本。
 * - Go 结构体中嵌入的 `*deps` 在 JS 中以 `this.DB` 属性承载，避免与 `repo.js` 产生顶层循环依赖。
 * - Go 切片字段 `PlatformGitHTTPSHost.Addresses` 按规则以空数组 `[]` 作为零值。
 */

"use strict";

const { randomBytes } = require("node:crypto"); // Go crypto/rand

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { HTTPSHostScope } = require("../gitwork/https_host.js"); // 对应 Go 的 gitwork 包，gitwork 未翻译
const { platformGitHostRevisionWhere } = require("./ssh_host_trust.js"); // 对应 Go 同包常量

/**
 * 平台级 Git HTTPS 端点授权数据仓库，管理精确 `host[:port]` 端点的允许拨号 IP 列表。
 * 对应 Go 中嵌入 `*deps` 的 `HTTPSHostTrustRepo`。
 */
class HTTPSHostTrustRepo {
  /**
   * 构造 HTTPS 端点授权仓库实例。
   * 使用场景：由 `repo.js` 的 `newStore` 装配存储层时创建。
   *
   * @param {Object} [init={}] - 初始化依赖映射。
   * @param {Object | null} [init.DB=null] - gorm 数据库句柄。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.DB = init.DB ?? null;
  }

  /**
   * 按主机名升序查询全部平台授权的 Git HTTPS 端点记录。
   * 使用场景：管理后台展示平台已登记的 HTTPS Git 端点授权列表时调用。
   *
   * @param {AbortSignal | null} ctx - 可选取消信号，透传至 gorm 上下文。
   * @returns {PlatformGitHTTPSHost[]} 平台 Git HTTPS 端点授权记录列表；查询失败时抛出错误。
   */
  ListPlatformGitHTTPSHosts(ctx) {
    const hosts = [];
    const err = this.DB.WithContext(ctx).Order("host").Find(hosts).Error;
    if (err != null) {
      throw err;
    }
    return hosts;
  }

  /**
   * 按主机名升序查询全部已授权 HTTPS 端点的精简下拉选项（仅含 `host` 与 `platform`）。
   * 使用场景：用户配置个人 HTTPS 凭据时加载平台可选主机列表。
   *
   * @param {AbortSignal | null} ctx - 可选取消信号，透传至 gorm 上下文。
   * @returns {GitHTTPSHostChoice[]} HTTPS 端点精简选项列表；查询失败时抛出错误。
   */
  GitHTTPSHostChoices(ctx) {
    const hosts = [];
    const err = this.DB.WithContext(ctx).Model(new PlatformGitHTTPSHost()).Select("host", "platform").Order("host").Find(hosts).Error;
    if (err != null) {
      throw err;
    }
    return hosts;
  }

  /**
   * 新增一条平台 Git HTTPS 端点授权记录，并生成初始随机修订号写回 `entry.Revision`。
   * 使用场景：管理员在平台信任设置中登记新的 Git HTTPS 端点时调用。
   *
   * @param {AbortSignal | null} ctx - 可选取消信号，透传至 gorm 上下文。
   * @param {PlatformGitHTTPSHost} entry - 待创建的端点授权记录对象（会就地回填 `Revision`）。
   * @returns {void} 无返回值；写入失败时抛出错误。
   */
  CreatePlatformGitHTTPSHost(ctx, entry) {
    entry.Revision = randomBytes(24).toString("base64url"); // Go 的 rand.Text 译为随机 base64url 文本。
    const err = this.DB.WithContext(ctx).Create(entry).Error;
    if (err != null) {
      throw err;
    }
  }

  /**
   * 基于乐观锁修订号更新指定 HTTPS 端点的平台类型与授权 IP 列表，成功后将新修订号回写到 `entry.Revision`。
   * 使用场景：管理员修改已登记的 Git HTTPS 端点配置时调用，防止并发覆盖。
   *
   * @param {AbortSignal | null} ctx - 可选取消信号，透传至 gorm 上下文。
   * @param {PlatformGitHTTPSHost} entry - 包含目标 `Host` 及新 `Platform`/`Addresses` 的记录对象。
   * @param {string} expected - 调用方期望匹配的当前修订号。
   * @returns {void} 无返回值；修订号不匹配时抛出 `ErrGitHTTPSHostChanged`，数据库错误时原样抛出。
   */
  UpdatePlatformGitHTTPSHost(ctx, entry, expected) {
    const next = randomBytes(24).toString("base64url");
    const result = this.DB.WithContext(ctx).Model(new PlatformGitHTTPSHost())
      .Where(platformGitHostRevisionWhere, entry.Host, entry.Host, expected)
      .Select("platform", "addresses", "revision")
      .Updates(new PlatformGitHTTPSHost({ Platform: entry.Platform, Addresses: entry.Addresses, Revision: next }));
    if (result.Error != null) {
      throw result.Error;
    }
    if (result.RowsAffected === 0) {
      throw ErrGitHTTPSHostChanged;
    }
    entry.Revision = next;
  }

  /**
   * 基于乐观锁修订号删除一条平台 Git HTTPS 端点授权记录。
   * 使用场景：管理员移除不再信任的 Git HTTPS 端点授权时调用。
   *
   * @param {AbortSignal | null} ctx - 可选取消信号，透传至 gorm 上下文。
   * @param {string} host - 待删除的规范化主机名。
   * @param {string} expected - 调用方期望匹配的当前修订号。
   * @returns {void} 无返回值；修订号不匹配或记录不存在时抛出 `ErrGitHTTPSHostChanged`，数据库错误时原样抛出。
   */
  DeletePlatformGitHTTPSHost(ctx, host, expected) {
    const result = this.DB.WithContext(ctx).Where(platformGitHostRevisionWhere, host, host, expected).Delete(new PlatformGitHTTPSHost());
    if (result.Error != null) {
      throw result.Error;
    }
    if (result.RowsAffected === 0) {
      throw ErrGitHTTPSHostChanged;
    }
  }

  /**
   * 查询实际拨号目标对应的平台 HTTPS 授权 IP 地址列表。
   * 仅当数据库中不存在该主机的授权记录时返回 `null`（允许客户端回退到部署级默认策略）；
   * 若存在记录但地址列表为空则抛出错误拒绝拨号。
   * 使用场景：受控 HTTP 客户端建立连接前校验目标端点是否在平台授权名单中。
   *
   * @param {AbortSignal | null} ctx - 可选取消信号，透传至 gorm 上下文。
   * @param {string} target - 实际拨号目标主机或 URL。
   * @returns {string[] | null} 授权 IP 地址数组；无匹配记录时返回 `null`；主机非法、记录无地址或查询出错时抛出错误。
   */
  PlatformGitHTTPSAddresses(ctx, target) {
    const host = HTTPSHostScope(target);
    const entry = new PlatformGitHTTPSHost();
    const takeErr = this.DB.WithContext(ctx).Select("host", "addresses").Where("host = ?", host).Take(entry).Error;
    if (takeErr === gorm.ErrRecordNotFound || (takeErr == null && entry.Host !== host)) {
      return null;
    }
    if (takeErr != null) {
      throw takeErr;
    }
    if ((entry.Addresses ?? []).length === 0) {
      throw new Error("Git HTTPS host authorization has no addresses");
    }
    return entry.Addresses;
  }
}

/** 乐观锁更新或删除平台 Git HTTPS 端点授权时修订号不匹配抛出的错误。 */
const ErrGitHTTPSHostChanged = new Error("platform Git HTTPS host authorization changed");

/**
 * 对应数据库表 `platform_git_https_hosts` 的平台授权 Git HTTPS 端点记录模型。
 */
class PlatformGitHTTPSHost {
  /**
   * 构造平台 Git HTTPS 端点记录实例，未提供字段严格按 Go 零值初始化。
   * 使用场景：数据库查询扫描、创建或更新端点授权记录时调用。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.Host=""] - 规范化后的精确 `host[:port]` 主键。
   * @param {string} [init.Platform=""] - 托管平台标识（如 `github`、`gitlab`、`other`）。
   * @param {string[]} [init.Addresses=[]] - 授权允许拨号的 IP 地址列表（对应 Go `[]netip.Addr`）。
   * @param {string} [init.Revision=""] - 用于乐观并发控制的随机修订号。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Host = init.Host ?? "";
    this.Platform = init.Platform ?? "";
    this.Addresses = init.Addresses ?? [];
    this.Revision = init.Revision ?? "";
  }

  /**
   * 返回 gorm 映射使用的物理表名。
   * 使用场景：由 gorm 模型解析与增量迁移调用。
   *
   * @returns {string} 物理表名 `"platform_git_https_hosts"`。
   */
  TableName() {
    return "platform_git_https_hosts";
  }
}

/**
 * 供前端展示可选平台 HTTPS Git 主机的精简结构（仅包含主机与平台标识）。
 */
class GitHTTPSHostChoice {
  /**
   * 构造 HTTPS 端点精简选项实例，未提供字段按 Go 零值初始化。
   * 使用场景：由 `GitHTTPSHostChoices` 查询投影构造返回项。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.Host=""] - 规范化主机名。
   * @param {string} [init.Platform=""] - 对应托管平台标识。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Host = init.Host ?? "";
    this.Platform = init.Platform ?? "";
  }
}

module.exports = { HTTPSHostTrustRepo, ErrGitHTTPSHostChanged, PlatformGitHTTPSHost, GitHTTPSHostChoice };
