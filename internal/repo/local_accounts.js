// local_accounts.js —— 对应 Go 文件：internal/repo/local_accounts.go
// 作用：本地密码账号：密码设置与校验、平台成员账号列表与本地账号注册。

"use strict";

const { Buffer } = require("node:buffer");

const bcrypt = require("golang.org/x/crypto/bcrypt"); // Go 第三方包 golang.org/x/crypto/bcrypt

const { User, PlatformRoleAdmin, IsPlatformAdmin } = require("../domain/user.js"); // 对应 Go 的 domain.User/PlatformRoleAdmin/IsPlatformAdmin，user.js 已翻译
const { upsert } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译
const { IsAllowlistedPlatformAdmin } = require("./platform_admin.js"); // 对应 Go 同包函数，platform_admin.js 待翻译

class localAccountRow {
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.PasswordHash = init.PasswordHash ?? "";
  }

  TableName() {
    return "local_accounts";
  }
}

// bcrypt 只用前 72 字节。
const MinPasswordLength = 6;
const MaxPasswordLength = 72;

const errPasswordLength = new Error(`password must contain ${MinPasswordLength}–${MaxPasswordLength} bytes`);

UsersRepo.prototype.SetLocalPassword = function (userID, password) {
  const [, ok] = this.User(userID);
  if (!ok) {
    return new Error("user not found");
  }
  if (password.length < MinPasswordLength || password.length > MaxPasswordLength) {
    return errPasswordLength;
  }
  let hash;
  try {
    hash = bcrypt.GenerateFromPassword(Buffer.from(password), bcrypt.DefaultCost);
  } catch (e) {
    return e;
  }
  return upsert(this.DB, "local_accounts", { user_id: userID, password_hash: hash.toString() });
};

const ErrLoginTaken = new Error("login already exists");

UsersRepo.prototype.LocalAccountCount = function () {
  let n = 0;
  this.DB.Model(new localAccountRow()).Count(n);
  return n;
};

class PlatformAccount {
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.LoginName = init.LoginName ?? "";
    this.ChineseName = init.ChineseName ?? "";
    this.Admin = init.Admin ?? false;
    // Password 为 false 表示经 GitHub 或网关登录的用户。
    this.Password = init.Password ?? false;
    this.CodeBuddyAPIKey = init.CodeBuddyAPIKey ?? false;
    this.CreatedAt = init.CreatedAt ?? null;
  }
}

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

UsersRepo.prototype.CreateLocalAccount = function (login, password, admin) {
  if (password.length < MinPasswordLength || password.length > MaxPasswordLength) {
    throw errPasswordLength;
  }
  const [, exists] = this.UserByLoginName(login);
  if (exists) {
    throw ErrLoginTaken;
  }
  const putErr = this.PutUser(new User({ LoginName: login, ChineseName: login }));
  if (putErr != null) {
    throw putErr;
  }
  const [u, ok] = this.UserByLoginName(login);
  if (!ok) {
    throw new Error("could not read account");
  }
  const setErr = this.SetLocalPassword(u.ID, password);
  if (setErr != null) {
    throw setErr;
  }
  if (admin) {
    const roleErr = this.SetUserPlatformRole(u.ID, PlatformRoleAdmin);
    if (roleErr != null) {
      throw roleErr;
    }
  }
  return u;
};

// 对未知用户也照常做 bcrypt 计算，避免通过响应时间暴露账号列表。
let dummyPasswordHash = null;
try {
  dummyPasswordHash = bcrypt.GenerateFromPassword(Buffer.from("unused-account-password"), bcrypt.DefaultCost);
} catch {
  // Go 忽略此处的错误。
}

UsersRepo.prototype.CheckLocalPassword = function (userID, password) {
  const row = new localAccountRow();
  const err = this.DB.Where("user_id = ?", userID).First(row).Error;
  let hash = Buffer.from(row.PasswordHash);
  if (err != null) {
    hash = dummyPasswordHash;
  }
  const valid = bcrypt.CompareHashAndPassword(hash, Buffer.from(password)) == null;
  return err == null && valid;
};

module.exports = { localAccountRow, MinPasswordLength, MaxPasswordLength, errPasswordLength, ErrLoginTaken, PlatformAccount, dummyPasswordHash };
