// platform_admin.js —— 对应 Go 文件：internal/repo/platform_admin.go
// 作用：平台管理员白名单与授权：内置、环境变量与授予三种来源。

"use strict";

const { User, PlatformRoleAdmin, IsPlatformAdmin } = require("../domain/user.js"); // 对应 Go 的 domain.User 等，user.js 已翻译
const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译

const platformAdminsEnv = "AGENTFLOW_PLATFORM_ADMINS";

// BuiltinPlatformAdmins：默认持有平台管理员角色的登录名；额外名字走环境变量或 API 授予。
const BuiltinPlatformAdmins = [];

// EnvPlatformAdmins：从 AGENTFLOW_PLATFORM_ADMINS 取额外的白名单登录名。
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

// IsBuiltinPlatformAdmin：登录名是否在硬编码的平台管理员白名单里；比较不区分大小写。
function IsBuiltinPlatformAdmin(loginName) {
  return loginInFold(loginName, BuiltinPlatformAdmins);
}

// IsAllowlistedPlatformAdmin：登录名是否由代码或环境变量钉住。
function IsAllowlistedPlatformAdmin(loginName) {
  return IsBuiltinPlatformAdmin(loginName) || loginInFold(loginName, EnvPlatformAdmins());
}

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

// IsPlatformAdmin：登录名能否编辑通用模板；白名单优先，用户行缺失时也生效。
UsersRepo.prototype.IsPlatformAdmin = function (loginName) {
  if (IsAllowlistedPlatformAdmin(loginName)) {
    return true;
  }
  const [user, ok] = this.UserByLoginName(loginName);
  return ok && IsPlatformAdmin(user);
};

// SetUserPlatformRole：只写平台级角色，不动凭据。
UsersRepo.prototype.SetUserPlatformRole = function (id, role) {
  const [user, ok] = this.User(id);
  if (!ok) {
    return new Error("user not found");
  }
  user.PlatformRole = role.trim();
  user.UpdatedAt = new Date();
  this.writeUser(user);
  return null;
};

// PlatformAdminRecord：设置页上的一位已配置平台管理员。
class PlatformAdminRecord {
  constructor(init = {}) {
    this.LoginName = init.LoginName ?? "";
    this.ChineseName = init.ChineseName ?? "";
    this.UserID = init.UserID ?? 0;
    this.Source = init.Source ?? "";
    this.Revocable = init.Revocable ?? false;
  }
}

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
    const err = this.PutUser(new User({ LoginName: loginName, ChineseName: loginName, PlatformRole: PlatformRoleAdmin, CreatedAt: now, UpdatedAt: now }));
    if (err != null) {
      throw err;
    }
  } else if (!IsPlatformAdmin(user)) {
    const err = this.SetUserPlatformRole(user.ID, PlatformRoleAdmin);
    if (err != null) {
      throw err;
    }
  }
  return this.platformAdminRecord(loginName);
};

UsersRepo.prototype.RevokePlatformAdmin = function (loginName) {
  loginName = loginName.trim();
  if (loginName === "") {
    return new Error("loginName is required");
  }
  if (IsAllowlistedPlatformAdmin(loginName)) {
    return new Error("内置或环境变量配置的平台管理员不能通过界面撤销，请改 AGENTFLOW_PLATFORM_ADMINS 或代码白名单");
  }
  const [user, ok] = this.UserByLoginName(loginName);
  if (!ok) {
    return new Error("user not found");
  }
  return this.SetUserPlatformRole(user.ID, "");
};

UsersRepo.prototype.platformAdminRecord = function (loginName) {
  for (const rec of this.ListPlatformAdmins()) {
    if (rec.LoginName.toLowerCase() === loginName.toLowerCase()) {
      return rec;
    }
  }
  return new PlatformAdminRecord({ LoginName: loginName.trim().toLowerCase(), Source: "granted", Revocable: true });
};

module.exports = { platformAdminsEnv, BuiltinPlatformAdmins, EnvPlatformAdmins, IsBuiltinPlatformAdmin, IsAllowlistedPlatformAdmin, PlatformAdminRecord };
