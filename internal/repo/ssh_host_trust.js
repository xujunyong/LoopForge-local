/**
 * @file internal/repo/ssh_host_trust.js
 * 对应 Go 源文件：internal/repo/ssh_host_trust.go
 *
 * 作用与职责边界：
 * 实现平台级 Git SSH 主机公钥信任登记表（`platform_git_ssh_hosts`）的增删改查、乐观锁修订版本控制，
 * 以及面向单次 Git 操作的 `known_hosts` 字节内容生成；
 * 方法按领域归属挂载于 `SSHHostTrustRepo.prototype`（`SSHHostTrustRepo` 定义于 `repo.js`），不负责 SSH 网络探测或前端表单校验。
 *
 * 语法差异说明：
 * - Go 的 `context.Context` 对应 `AbortSignal` 参数（变量名保留 `ctx` 与 Go 一致）；`[]byte` 对应 `Buffer`。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理。
 * - Go 的 `crypto/rand.Text()` 在 JS 中使用 `randomBytes(24).toString("base64url")` 生成随机修订号。
 * - `NormalizeSSHHostPublicKeys` 来自尚未转写的 `internal/gitwork` 包，按 `(string, ..., error)` → 成功返回元组、失败抛错约定调用。
 */

"use strict";

const { Buffer } = require("node:buffer");
const { randomBytes } = require("node:crypto"); // Go crypto/rand

const knownhosts = require("golang.org/x/crypto/ssh/knownhosts"); // Go 第三方包 golang.org/x/crypto/ssh/knownhosts

const { NormalizeSSHHostPublicKeys } = require("../gitwork/ssh_host_public_keys.js"); // 对应 Go 的 gitwork 包，gitwork 未翻译
const { SSHHostTrustRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译

// 更新或删除平台 Git SSH 主机信任记录时，修订版本号不匹配（记录已被他人并发修改）抛出的乐观锁错误。
const ErrPlatformGitSSHHostChanged = new Error("platform Git SSH host trust changed");

// 按主键查找并逐字节比较主机名与修订号，防止数据库排序规则把不同的旧值视作等价。
const platformGitHostRevisionWhere = "host = ? AND HEX(host) = HEX(?) AND HEX(revision) = HEX(?)";

/**
 * 平台级 Git SSH 主机公钥信任登记表的实体模型。
 * 对应数据库表 `platform_git_ssh_hosts`。
 */
class PlatformGitSSHHost {
  /**
   * 构造 `PlatformGitSSHHost` 实例，缺省字段按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.Host=""] - 规范化的 `host:port` 主机端点（主键）。
   * @param {string} [init.PublicKeys=""] - 换行分隔的受信任 SSH 主机公钥文本。
   * @param {string} [init.Revision=""] - 用于并发写入乐观锁校验的随机修订版本号。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Host = init.Host ?? "";
    this.PublicKeys = init.PublicKeys ?? "";
    this.Revision = init.Revision ?? "";
  }

  /**
   * 返回当前模型对应的物理数据库表名。
   * 使用场景：供 GORM 映射物理表名称。
   *
   * @returns {string} 固定返回 `"platform_git_ssh_hosts"`。
   */
  TableName() {
    return "platform_git_ssh_hosts";
  }
}

/**
 * 按主机名升序查询平台已登记的全部 Git SSH 主机公钥信任记录。
 * 使用场景：平台管理设置页展示已配置的受信任 Git SSH 主机清单。
 *
 * @param {AbortSignal} ctx - 控制请求取消的上下文信号。
 * @returns {PlatformGitSSHHost[]} 按 `host` 升序排列的主机信任记录数组。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
SSHHostTrustRepo.prototype.ListPlatformGitSSHHosts = function (ctx) {
  const hosts = [];
  const err = this.DB.WithContext(ctx).Order("host").Find(hosts).Error;
  if (err != null) {
    throw err;
  }
  return hosts;
};

/**
 * 新增一条平台 Git SSH 主机公钥信任记录，并自动生成初始随机修订版本号写回 `entry.Revision`。
 * 使用场景：管理员在平台设置页登记新的 Git SSH 主机公钥。
 *
 * @param {AbortSignal} ctx - 控制请求取消的上下文信号。
 * @param {PlatformGitSSHHost} entry - 待插入的主机信任记录对象（插入前会就地写入新 `Revision`）。
 * @returns {void} 无返回值。
 * @throws {Error} 主键冲突或数据库写入失败时抛出错误。
 */
SSHHostTrustRepo.prototype.CreatePlatformGitSSHHost = function (ctx, entry) {
  entry.Revision = randomBytes(24).toString("base64url"); // Go 的 rand.Text 译为随机 base64url 文本。
  const err = this.DB.WithContext(ctx).Create(entry).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 基于期望的修订版本号更新指定 Git SSH 主机的受信任公钥列表，成功后就地刷新 `entry.Revision`。
 * 使用场景：管理员修改已有 SSH 主机公钥配置并防止并发覆盖。
 *
 * @param {AbortSignal} ctx - 控制请求取消的上下文信号。
 * @param {PlatformGitSSHHost} entry - 包含目标 `Host` 与新 `PublicKeys` 的主机信任记录对象。
 * @param {string} expectedRevision - 编辑前读取到的旧修订版本号，用于 CAS 校验。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败，或影响行数为 0（抛出 `ErrPlatformGitSSHHostChanged`）时抛出错误。
 */
SSHHostTrustRepo.prototype.UpdatePlatformGitSSHHost = function (ctx, entry, expectedRevision) {
  const nextRevision = randomBytes(24).toString("base64url"); // Go 的 rand.Text 译为随机 base64url 文本。
  const result = this.DB.WithContext(ctx).Model(new PlatformGitSSHHost()).
    Where(platformGitHostRevisionWhere, entry.Host, entry.Host, expectedRevision).
    Updates({ public_keys: entry.PublicKeys, revision: nextRevision });
  if (result.Error != null) {
    throw result.Error;
  }
  if (result.RowsAffected === 0) {
    throw ErrPlatformGitSSHHostChanged;
  }
  entry.Revision = nextRevision;
};

/**
 * 基于期望的修订版本号删除指定的平台 Git SSH 主机信任记录。
 * 使用场景：管理员移除不再信任的 Git SSH 主机公钥配置。
 *
 * @param {AbortSignal} ctx - 控制请求取消的上下文信号。
 * @param {string} host - 待删除的规范化主机端点。
 * @param {string} expectedRevision - 删除前读取到的旧修订版本号，用于 CAS 校验。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库删除失败，或影响行数为 0（抛出 `ErrPlatformGitSSHHostChanged`）时抛出错误。
 */
SSHHostTrustRepo.prototype.DeletePlatformGitSSHHost = function (ctx, host, expectedRevision) {
  const result = this.DB.WithContext(ctx).
    Where(platformGitHostRevisionWhere, host, host, expectedRevision).
    Delete(new PlatformGitSSHHost());
  if (result.Error != null) {
    throw result.Error;
  }
  if (result.RowsAffected === 0) {
    throw ErrPlatformGitSSHHostChanged;
  }
};

/**
 * 仅查询本次 Git 操作所需的受信任主机记录并拼装标准 OpenSSH `known_hosts` 字节内容。
 * 输入的 `scopes` 采用标准 `host:port` 形式；在内存中二次比对精确主机名以排除数据库排序规则命中的非规范行。
 *
 * @param {AbortSignal} ctx - 控制请求取消的上下文信号。
 * @param {string[]} scopes - 本次 Git 操作涉及的标准 `host:port` 主机端点列表。
 * @returns {Buffer} 组装完成的 UTF-8 编码 `known_hosts` 文本字节缓冲区。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
SSHHostTrustRepo.prototype.PlatformSSHKnownHosts = function (ctx, scopes) {
  const entries = [];
  const findErr = this.DB.WithContext(ctx).Where("host IN ?", scopes).Find(entries).Error;
  if (findErr != null) {
    throw findErr;
  }
  let knownHosts = ""; // Go 的 strings.Builder 译为字符串拼接。
  for (const entry of entries) {
    // 数据库排序规则也可能匹配非规范行，只允许精确端点贡献受信密钥。
    if (!scopes.includes(entry.Host)) {
      continue;
    }
    let keys;
    try {
      [keys] = NormalizeSSHHostPublicKeys(entry.PublicKeys);
    } catch {
      continue;
    }
    const host = knownhosts.Normalize(entry.Host);
    for (const publicKey of keys.split("\n")) {
      knownHosts += `${host} ${publicKey}\n`;
    }
  }
  return Buffer.from(knownHosts, "utf8");
};

module.exports = { ErrPlatformGitSSHHostChanged, platformGitHostRevisionWhere, PlatformGitSSHHost };
