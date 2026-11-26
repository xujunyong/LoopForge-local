/**
 * @file internal/repo/platform_admin.js
 * 对应 Go 源文件：internal/repo/platform_admin.go
 *
 * 作用与职责边界：
 * 实现平台管理员的白名单判定、角色授予与撤销以及设置页管理员列表聚合，
 * 支持代码内置（`builtin`）、环境变量 `AGENTFLOW_PLATFORM_ADMINS`（`env`）与数据库授权（`granted`）三种来源；
 * 领域方法以原型方式挂载在 `UsersRepo` 上，不负责 HTTP 鉴权中间件逻辑。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；`(值, bool)` 译为二元组。
 * - Go 的 `strings.FieldsFunc` 按 `,; \n\t` 拆分译为正则 `split(/[,; \n\t]+/)`；`strings.EqualFold` 译为转小写比较。
 * - Go 的 `map[string]bool`、`map[string]PlatformAdminRecord` 统一译为普通对象 `{}`；`struct` 字段按 Go 零值初始化。
 */

"use strict";

const { User, PlatformRoleAdmin, IsPlatformAdmin } = require("../domain/user.js"); // 对应 Go 的 domain.User 等，user.js 已翻译
const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译

// 环境变量名：配置额外允许的平台管理员登录名列表。
const platformAdminsEnv = "AGENTFLOW_PLATFORM_ADMINS";

// 默认始终持有平台管理员角色的内置登录名列表；额外成员可通过环境变量或接口授权添加。
const BuiltinPlatformAdmins = [];

/**
 * 从环境变量 `AGENTFLOW_PLATFORM_ADMINS` 解析额外允许的平台管理员登录名列表。
 * 支持逗号、分号、空格、换行与制表符分隔，统一转小写并去重；未配置时返回 `null`。
 *
 * @returns {string[] | null} 规范化且去重后的登录名数组；环境变量为空时返回 `null`。
 */
function EnvPlatformAdmins() {
  const raw = (process.env[platformAdminsEnv] ?? "").trim();
  if (raw === "") {
    return null;
  }
  const parts = raw.split(/[,; \n\t]+/).filter((p) => p !== "");
  const out = [];
  const seen = {};
  for (const part of parts) {
    const login = part.trim().toLowerCase();
    if (login === "" || seen[login]) {
      continue;
    }
    seen[login] = true;
    out.push(login);
  }
  return out;
}

/**
 * 判断指定登录名是否位于代码硬编码的内置平台管理员白名单中（不区分大小写）。
 * 用于区分不可通过界面撤销的内置管理员。
 *
 * @param {string} loginName - 待检查的用户登录名。
 * @returns {boolean} 命中内置白名单时返回 `true`，否则返回 `false`。
 */
function IsBuiltinPlatformAdmin(loginName) {
  return loginInFold(loginName, BuiltinPlatformAdmins);
}

/**
 * 判断指定登录名是否由代码内置白名单或环境变量白名单固定授予平台管理员身份。
 * 用于在用户行尚未落库或尝试撤销权限时执行白名单优先校验。
 *
 * @param {string} loginName - 待检查的用户登录名。
 * @returns {boolean} 命中内置或环境变量白名单时返回 `true`，否则返回 `false`。
 */
function IsAllowlistedPlatformAdmin(loginName) {
  return IsBuiltinPlatformAdmin(loginName) || loginInFold(loginName, EnvPlatformAdmins());
}

/**
 * 在不区分大小写且忽略首尾空白的条件下，检查登录名是否出现在候选名称列表中。
 * 供内置与环境变量白名单判定函数复用。
 *
 * @param {string} loginName - 待匹配的登录名。
 * @param {string[] | null} names - 候选登录名列表。
 * @returns {boolean} 匹配到任一项时返回 `true`，输入为空或未命中时返回 `false`。
 */
function loginInFold(loginName, names) {
  const login = loginName.trim().toLowerCase();
  if (login === "") {
    return false;
  }
  for (const name of names ?? []) {
    if (login === name.trim().toLowerCase()) {
      return true;
    }
  }
  return false;
}

/**
 * 判断指定登录名是否拥有平台管理员权限（如编辑通用模板等平台级操作）。
 * 白名单优先于数据库记录，即使对应用户行尚未创建也能生效。
 *
 * @param {string} loginName - 待鉴权的用户登录名。
 * @returns {boolean} 具有平台管理员权限时返回 `true`，否则返回 `false`。
 */
UsersRepo.prototype.IsPlatformAdmin = function (loginName) {
  if (IsAllowlistedPlatformAdmin(loginName)) {
    return true;
  }
  const [user, ok] = this.UserByLoginName(loginName);
  return ok && IsPlatformAdmin(user);
};

/**
 * 仅更新指定用户的平台级角色字段，不改动其已保存的各类凭据。
 * 供授予或撤销平台管理员权限时写入 `users` 表使用。
 *
 * @param {number} id - 用户主键 ID。
 * @param {string} role - 目标平台角色（授予管理员时为 `"admin"`，撤销时为空串 `""`）。
 * @returns {void} 无返回值。
 * @throws {Error} 用户不存在或数据库写入失败时抛出错误。
 */
UsersRepo.prototype.SetUserPlatformRole = function (id, role) {
  const [user, ok] = this.User(id);
  if (!ok) {
    throw new Error("user not found");
  }
  user.PlatformRole = role.trim();
  user.UpdatedAt = new Date();
  this.writeUser(user);
};

/**
 * 设置页展示的单个已配置平台管理员记录。
 * 对应 Go 的 `PlatformAdminRecord`，按来源区分是否允许在界面撤销。
 */
class PlatformAdminRecord {
  /**
   * 构造平台管理员展示记录，未提供字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.LoginName=""] - 规范化后的小写登录名。
   * @param {string} [init.ChineseName=""] - 用户中文名（若已存在用户行）。
   * @param {number} [init.UserID=0] - 对应的用户主键 ID（未落库时为 `0`）。
   * @param {string} [init.Source=""] - 权限来源：`"builtin"`、`"env"` 或 `"granted"`。
   * @param {boolean} [init.Revocable=false] - 是否允许通过界面撤销（仅 `"granted"` 为 `true`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.LoginName = init.LoginName ?? "";
    this.ChineseName = init.ChineseName ?? "";
    this.UserID = init.UserID ?? 0;
    this.Source = init.Source ?? "";
    this.Revocable = init.Revocable ?? false;
  }
}

/**
 * 汇总内置白名单、环境变量白名单与数据库授权三类来源的平台管理员列表，并按登录名升序返回。
 * 同一登录名同时存在于多处来源时，优先级为 `builtin > env > granted`。
 *
 * @returns {PlatformAdminRecord[]} 按 `LoginName` 升序排列的平台管理员记录数组。
 */
UsersRepo.prototype.ListPlatformAdmins = function () {
  const byLogin = {};
  const add = (login, source) => {
    login = login.trim().toLowerCase();
    if (login === "") {
      return;
    }
    const rec = byLogin[login] ?? new PlatformAdminRecord();
    rec.LoginName = login;
    if (rec.Source === "" || source === "builtin" || (source === "env" && rec.Source !== "builtin")) {
      rec.Source = source;
    }
    rec.Revocable = rec.Source === "granted";
    const [user, ok] = this.UserByLoginName(login);
    if (ok) {
      rec.UserID = user.ID;
      rec.ChineseName = user.ChineseName;
    }
    byLogin[login] = rec;
  };
  for (const login of BuiltinPlatformAdmins) {
    add(login, "builtin");
  }
  for (const login of EnvPlatformAdmins() ?? []) {
    add(login, "env");
  }
  for (const user of this.Users()) {
    if (IsPlatformAdmin(user)) {
      add(user.LoginName, "granted");
    }
  }
  const out = Object.values(byLogin);
  out.sort((a, b) => (a.LoginName < b.LoginName ? -1 : a.LoginName > b.LoginName ? 1 : 0));
  return out;
};

/**
 * 为指定登录名授予平台管理员角色，并返回其最新管理员记录。
 * 若已在白名单中则直接返回现有记录；若用户不存在则创建带管理员角色的新用户行，否则更新已有用户角色。
 *
 * @param {string} loginName - 目标用户登录名。
 * @returns {PlatformAdminRecord} 授权后的平台管理员记录。
 * @throws {Error} 登录名为空或创建/更新用户记录失败时抛出错误。
 */
UsersRepo.prototype.GrantPlatformAdmin = function (loginName) {
  loginName = loginName.trim();
  if (loginName === "") {
    throw new Error("loginName is required");
  }
  if (IsAllowlistedPlatformAdmin(loginName)) {
    return this.platformAdminRecord(loginName);
  }
  const now = new Date();
  const [user, ok] = this.UserByLoginName(loginName);
  if (!ok) {
    this.PutUser(new User({ LoginName: loginName, ChineseName: loginName, PlatformRole: PlatformRoleAdmin, CreatedAt: now, UpdatedAt: now }));
  } else if (!IsPlatformAdmin(user)) {
    this.SetUserPlatformRole(user.ID, PlatformRoleAdmin);
  }
  return this.platformAdminRecord(loginName);
};

/**
 * 撤销指定登录名通过数据库授予的平台管理员角色。
 * 内置白名单或环境变量白名单配置的管理员禁止通过界面撤销，将抛出错误提示修改配置。
 *
 * @param {string} loginName - 待撤销管理员权限的登录名。
 * @returns {void} 无返回值。
 * @throws {Error} 登录名为空、命中白名单禁止撤销、用户不存在或数据库更新失败时抛出错误。
 */
UsersRepo.prototype.RevokePlatformAdmin = function (loginName) {
  loginName = loginName.trim();
  if (loginName === "") {
    throw new Error("loginName is required");
  }
  if (IsAllowlistedPlatformAdmin(loginName)) {
    throw new Error("内置或环境变量配置的平台管理员不能通过界面撤销，请改 AGENTFLOW_PLATFORM_ADMINS 或代码白名单");
  }
  const [user, ok] = this.UserByLoginName(loginName);
  if (!ok) {
    throw new Error("user not found");
  }
  this.SetUserPlatformRole(user.ID, "");
};

/**
 * 从当前管理员汇总列表中查找指定登录名的管理员记录；未找到时返回默认的 `"granted"` 兜底记录。
 * 供 `GrantPlatformAdmin` 返回最新视图使用。
 *
 * @param {string} loginName - 待查找的登录名（不区分大小写）。
 * @returns {PlatformAdminRecord} 匹配到的管理员记录或兜底构造的记录对象。
 */
UsersRepo.prototype.platformAdminRecord = function (loginName) {
  for (const rec of this.ListPlatformAdmins()) {
    if (rec.LoginName.toLowerCase() === loginName.toLowerCase()) {
      return rec;
    }
  }
  return new PlatformAdminRecord({ LoginName: loginName.trim().toLowerCase(), Source: "granted", Revocable: true });
};

module.exports = { platformAdminsEnv, BuiltinPlatformAdmins, EnvPlatformAdmins, IsBuiltinPlatformAdmin, IsAllowlistedPlatformAdmin, PlatformAdminRecord };
