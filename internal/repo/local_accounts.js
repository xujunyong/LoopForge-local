/**
 * @file internal/repo/local_accounts.js
 * 对应 Go 源文件：internal/repo/local_accounts.go
 *
 * 作用与职责边界：
 * 实现可选的本地密码身份适配器（`local_accounts` 表行模型与 `UsersRepo` 扩展方法），
 * 负责本地账号密码的 bcrypt 哈希设置、抗计时攻击密码校验、本地密码账号计数、
 * 平台成员账号列表查询以及新本地账号注册（复用上游 `UsersRepo` 的用户与角色体系）。
 * 不负责会话签发、OAuth 登录或 API Token 管理。
 *
 * 语法差异说明：
 * - `UsersRepo` 定义于 `repo.js`，本文件通过 `UsersRepo.prototype` 挂载本地账号相关方法。
 * - Go 的 `len(password)` 衡量 UTF-8 字节数（对应 bcrypt 的 72 字节上限），JS 中使用 `Buffer.byteLength(password, "utf8")` 保持严格一致。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理。
 * - Go 的 `Count(&n)` 出参在 JS 中使用 `{ value: 0 }` 对象承接，避免原始值按值传递无法回写。
 */

"use strict";

const { Buffer } = require("node:buffer");

const bcrypt = require("golang.org/x/crypto/bcrypt"); // Go 第三方包 golang.org/x/crypto/bcrypt

const { User, PlatformRoleAdmin, IsPlatformAdmin } = require("../domain/user.js"); // 对应 Go 的 domain.User/PlatformRoleAdmin/IsPlatformAdmin，user.js 已翻译
const { upsert } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { IsAllowlistedPlatformAdmin } = require("./platform_admin.js"); // 对应 Go 同包函数，platform_admin.js 已翻译

/**
 * 对应数据库表 `local_accounts` 的本地密码凭据行模型，以用户 ID 为主键存储 bcrypt 哈希。
 */
class localAccountRow {
  /**
   * 构造本地账号密码行实例，缺省字段按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {number} [init.UserID=0] - 关联的平台用户 ID（主键，不自增）。
   * @param {string} [init.PasswordHash=""] - bcrypt 生成的密码哈希字符串。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.PasswordHash = init.PasswordHash ?? "";
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"local_accounts"`。
   */
  TableName() {
    return "local_accounts";
  }
}

// bcrypt 算法仅使用密码的前 72 字节，据此限定本地密码字节长度范围。
/** 本地密码允许的最小 UTF-8 字节长度。 */
const MinPasswordLength = 6;
/** 本地密码允许的最大 UTF-8 字节长度（与 bcrypt 72 字节截断上限一致）。 */
const MaxPasswordLength = 72;

/** 本地密码字节长度超出允许范围时抛出的错误。 */
const errPasswordLength = new Error(`password must contain ${MinPasswordLength}–${MaxPasswordLength} bytes`);

/**
 * 为已存在的平台用户设置或重置本地登录密码（以 bcrypt 默认代价计算哈希并写入 `local_accounts`）。
 * 用于管理员重置成员密码、成员自助改密或创建本地账号时初始化密码。
 *
 * @param {number} userID - 目标用户的平台 ID。
 * @param {string} password - 明文密码（UTF-8 字节数须介于 6 至 72 之间）。
 * @returns {void} 无返回值。
 * @throws {Error} 用户不存在、密码长度越界、bcrypt 计算失败或数据库写入失败时抛出错误。
 */
UsersRepo.prototype.SetLocalPassword = function (userID, password) {
  const [, ok] = this.User(userID);
  if (!ok) {
    throw new Error("user not found");
  }
  const passwordBytes = Buffer.byteLength(password, "utf8");
  if (passwordBytes < MinPasswordLength || passwordBytes > MaxPasswordLength) {
    throw errPasswordLength;
  }
  const hash = bcrypt.GenerateFromPassword(Buffer.from(password, "utf8"), bcrypt.DefaultCost);
  upsert(this.DB, "local_accounts", { user_id: userID, password_hash: hash.toString() });
};

/** 注册新本地账号时登录名已被占用所抛出的错误。 */
const ErrLoginTaken = new Error("login already exists");

/**
 * 统计当前已配置本地密码的账号总数。
 * 常用于初始化引导判断是否尚未创建任何本地管理员账号。
 *
 * @returns {number} `local_accounts` 表中的记录条数。
 */
UsersRepo.prototype.LocalAccountCount = function () {
  // Go 的 Count(&n) 传入指针接出参；JS 使用包装对象承接计数结果。
  const n = { value: 0 };
  this.DB.Model(new localAccountRow()).Count(n);
  return n.value;
};

/**
 * 表示「平台管理 → 成员账号」列表中展示的单条平台成员账号摘要记录。
 */
class PlatformAccount {
  /**
   * 构造平台成员账号摘要实例，缺省字段按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {number} [init.UserID=0] - 用户 ID。
   * @param {string} [init.LoginName=""] - 登录名。
   * @param {string} [init.ChineseName=""] - 中文名/显示名。
   * @param {boolean} [init.Admin=false] - 是否拥有平台管理员权限（含白名单与授予角色）。
   * @param {boolean} [init.Password=false] - 是否已设置本地密码（通过 GitHub 或网关登录的用户为 `false`）。
   * @param {boolean} [init.CodeBuddyAPIKey=false] - 是否已配置个人 CodeBuddy API Key。
   * @param {Date | null} [init.CreatedAt=null] - 账号创建时间。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.LoginName = init.LoginName ?? "";
    this.ChineseName = init.ChineseName ?? "";
    this.Admin = init.Admin ?? false;
    // Password 为 false 表示经 GitHub 或网关登录、未设置本地密码的用户。
    this.Password = init.Password ?? false;
    this.CodeBuddyAPIKey = init.CodeBuddyAPIKey ?? false;
    this.CreatedAt = init.CreatedAt ?? null;
  }
}

/**
 * 按用户 ID 升序（由旧到新）列出平台全部成员账号及其管理员身份、本地密码与 CodeBuddy Key 配置状态。
 * 供「平台管理 → 成员账号」管理页面加载成员列表。
 *
 * @returns {PlatformAccount[]} 平台成员账号摘要数组。
 * @throws {Error} 原生 SQL 联合查询执行失败时抛出错误。
 */
UsersRepo.prototype.ListPlatformAccounts = function () {
  const rows = [];
  const err = this.DB.Raw(`SELECT u.id, u.login_name, u.chinese_name, u.platform_role, u.created_at,
    (l.user_id IS NOT NULL) AS has_password,
    (c.codebuddy_api_key IS NOT NULL AND c.codebuddy_api_key <> '') AS has_key
    FROM users u
    LEFT JOIN local_accounts l ON l.user_id = u.id
    LEFT JOIN user_configs c ON c.user_id = u.id
    ORDER BY u.id ASC`).Scan(rows).Error;
  if (err != null) {
    throw err;
  }
  const out = [];
  for (const row of rows) {
    out.push(new PlatformAccount({
      UserID: row.ID, LoginName: row.LoginName, ChineseName: row.ChineseName,
      Admin: IsAllowlistedPlatformAdmin(row.LoginName) || IsPlatformAdmin(new User({ PlatformRole: row.PlatformRole })),
      Password: row.HasPassword, CodeBuddyAPIKey: row.HasKey, CreatedAt: row.CreatedAt,
    }));
  }
  return out;
};

/**
 * 注册一个新的本地密码账号；绝不接管已存在的同名用户记录。
 * 依次校验密码长度与登录名唯一性、创建用户记录、设置本地密码，并在 `admin` 为 `true` 时授予平台管理员角色。
 *
 * @param {string} login - 新账号登录名。
 * @param {string} password - 新账号明文密码（UTF-8 字节数须介于 6 至 72 之间）。
 * @param {boolean} admin - 是否同时授予平台管理员角色。
 * @returns {User} 新创建的平台用户领域对象。
 * @throws {Error} 密码长度不合法、登录名已存在（`ErrLoginTaken`）或任一持久化步骤失败时抛出错误。
 */
UsersRepo.prototype.CreateLocalAccount = function (login, password, admin) {
  const passwordBytes = Buffer.byteLength(password, "utf8");
  if (passwordBytes < MinPasswordLength || passwordBytes > MaxPasswordLength) {
    throw errPasswordLength;
  }
  const [, exists] = this.UserByLoginName(login);
  if (exists) {
    throw ErrLoginTaken;
  }
  this.PutUser(new User({ LoginName: login, ChineseName: login }));
  const [u, ok] = this.UserByLoginName(login);
  if (!ok) {
    throw new Error("could not read account");
  }
  this.SetLocalPassword(u.ID, password);
  if (admin) {
    this.SetUserPlatformRole(u.ID, PlatformRoleAdmin);
  }
  return u;
};

// 对未知用户也照常执行 bcrypt 校验用的占位哈希，防止通过响应耗时差异枚举有效账号列表。
let dummyPasswordHash = null;
try {
  dummyPasswordHash = bcrypt.GenerateFromPassword(Buffer.from("unused-account-password", "utf8"), bcrypt.DefaultCost);
} catch {
  // Go 忽略初始化占位哈希时的错误。
}

/**
 * 校验指定用户的本地密码是否正确。
 * 即使该用户未设置本地密码或查询出错，仍使用 `dummyPasswordHash` 执行一次完整的 bcrypt 比对以避免计时侧信道暴露账号存在性。
 *
 * @param {number} userID - 待验证用户的平台 ID。
 * @param {string} password - 用户输入的明文密码。
 * @returns {boolean} 记录存在且密码哈希校验通过时返回 `true`，否则返回 `false`。
 */
UsersRepo.prototype.CheckLocalPassword = function (userID, password) {
  const row = new localAccountRow();
  const err = this.DB.Where("user_id = ?", userID).First(row).Error;
  let hash = Buffer.from(row.PasswordHash, "utf8");
  if (err != null) {
    hash = dummyPasswordHash;
  }
  let valid = false;
  try {
    bcrypt.CompareHashAndPassword(hash, Buffer.from(password, "utf8"));
    valid = true;
  } catch {
    valid = false;
  }
  return err == null && valid;
};

module.exports = { localAccountRow, MinPasswordLength, MaxPasswordLength, errPasswordLength, ErrLoginTaken, PlatformAccount, dummyPasswordHash };
