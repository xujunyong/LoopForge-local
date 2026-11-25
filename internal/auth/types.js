// types.js —— 对应 Go 文件：internal/auth/types.go
// 作用：登录用户身份与 SSO 票据结构，带 HMAC-SHA256 签名的会话串。
// Go 的 time.Time 译为 JS Date；(值, error) 译为成功返回值、失败 throw。

"use strict";

const { createHmac, timingSafeEqual } = require("node:crypto");
const { User: DomainUser } = require("../domain/user.js"); // 对应 Go 的 domain.User，domain 已翻译

// User 表示当前登录或降级后的员工身份。
class User {
  // 构造器同时认 Go 字段名与 JSON tag 名：SignUser 用 toJSON 序列化（小写名），
  // ParseSignedUser 解析回来的就是小写名。
  constructor(init = {}) {
    this.ID = init.ID ?? init.id ?? 0;
    this.StaffID = init.StaffID ?? init.staffId ?? 0;
    this.LoginName = init.LoginName ?? init.loginName ?? "";
    this.ChineseName = init.ChineseName ?? init.chineseName ?? "";
    this.DeptID = init.DeptID ?? init.deptId ?? 0;
    this.DeptName = init.DeptName ?? init.deptName ?? "";
    this.IsGuest = init.IsGuest ?? init.isGuest ?? false;
    this.IsPlatformAdmin = init.IsPlatformAdmin ?? init.isPlatformAdmin ?? false;
    this.AuthTime = init.AuthTime ?? init.authTime ?? null;
    this.AvatarURL = init.AvatarURL ?? init.avatarUrl ?? "";
  }

  // toJSON：Go 的 json.Marshal 按 tag 输出，omitempty 字段为空时省略。
  toJSON() {
    const out = {
      id: this.ID,
      staffId: this.StaffID,
      loginName: this.LoginName,
      chineseName: this.ChineseName,
      deptId: this.DeptID,
      deptName: this.DeptName,
      isGuest: this.IsGuest,
      authTime: this.AuthTime,
    };
    if (this.IsPlatformAdmin) {
      out.isPlatformAdmin = true;
    }
    if (this.AvatarURL !== "") {
      out.avatarUrl = this.AvatarURL;
    }
    return out;
  }

  // ToDomain 将 auth.User 转换为持久化层实体 domain.User。
  ToDomain() {
    if (this === null || this === undefined) {
      return new DomainUser();
    }
    return new DomainUser({
      ID: this.ID,
      StaffID: this.StaffID,
      LoginName: this.LoginName,
      ChineseName: this.ChineseName,
      DeptID: this.DeptID,
      DeptName: this.DeptName,
    });
  }
}

// IOAAuthResponse 是企业 SSO AccessToken 接口的响应结构。
class IOAAuthResponse {
  constructor(init = {}) {
    this.Ret = init.Ret ?? 0;
    this.ErrCode = init.ErrCode ?? 0;
    this.ErrMsg = init.ErrMsg ?? "";
    this.StackTrace = init.StackTrace ?? "";
    this.Data = init.Data != null ? new IOAAuthData(init.Data) : null;
  }
}

// IOAAuthData 包含了 SSO 发放的票据与员工核心信息。
class IOAAuthData {
  constructor(init = {}) {
    this.Key = init.Key ?? "";
    this.Expiration = init.Expiration ?? "";
    this.IsPersistent = init.IsPersistent ?? false;
    this.IssueDate = init.IssueDate ?? "";
    this.StaffId = init.StaffId ?? 0;
    this.LoginName = init.LoginName ?? "";
    this.ChineseName = init.ChineseName ?? "";
    this.DeptId = init.DeptId ?? 0;
    this.DeptName = init.DeptName ?? "";
    this.Version = init.Version ?? 0;
    this.Token = init.Token ?? "";
    this.Ticket = init.Ticket ?? "";
  }
}

// SignUser 生成带 HMAC-SHA256 签名的 User 会话字符串，便于安全地存入 Cookie。
function SignUser(u, secret) {
  if (u == null) {
    throw new Error("user is nil");
  }
  const payload = Buffer.from(JSON.stringify(u), "utf8");
  const b64Payload = payload.toString("base64url");
  const mac = createHmac("sha256", secret);
  mac.update(b64Payload);
  const sig = mac.digest("hex");
  return `${b64Payload}.${sig}`;
}

// ParseSignedUser 解析并校验被 SignUser 签名的会话字符串。
function ParseSignedUser(tokenStr, secret) {
  const parts = tokenStr.split(".");
  if (parts.length !== 2) {
    throw new Error("invalid token format");
  }
  const [b64Payload, sig] = parts;
  const mac = createHmac("sha256", secret);
  mac.update(b64Payload);
  const expectedSig = mac.digest("hex");
  if (sig.length !== expectedSig.length ||
    !timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expectedSig, "utf8"))) {
    throw new Error("invalid token signature");
  }

  let raw;
  try {
    raw = Buffer.from(b64Payload, "base64url");
  } catch (err) {
    throw err;
  }
  return new User(JSON.parse(raw.toString("utf8")));
}

module.exports = { User, IOAAuthResponse, IOAAuthData, SignUser, ParseSignedUser };
