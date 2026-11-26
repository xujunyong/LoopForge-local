/**
 * @file internal/auth/types.js
 * @description 对应 Go 文件：internal/auth/types.go
 * 职责与边界：定义登录员工会话身份结构（User）、企业 SSO AccessToken 响应与票据结构（IOAAuthResponse、IOAAuthData），
 * 以及基于 HMAC-SHA256 的会话字符串签名（SignUser）与验签解析（ParseSignedUser）函数。
 * 语法差异说明：
 * - Go 的 `time.Time` 译为 JS `Date`（零值为 `null`）；反序列化 RFC3339/ISO 时间字符串时还原为 `Date`。
 * - Go 的 `(值, error)` 多返回值译为成功时直接返回值、失败时 `throw Error`。
 * - Go 的结构体 JSON 标签序列化规则通过 `User.prototype.toJSON` 1:1 保持字段名及 `omitempty` 行为。
 */

"use strict";

const { createHmac, timingSafeEqual } = require("node:crypto");
const { User: DomainUser } = require("../domain/user.js"); // 对应 Go 的 domain.User

/**
 * 表示当前登录或优雅降级后的员工身份信息。
 */
class User {
  /**
   * 构造员工认证身份实例，未提供的字段按 Go 零值初始化；同时兼容 Go 大写字段名与 JSON 小写字段名。
   * 在创建登录会话、构造访客身份或反序列化签名会话串时调用。
   * @param {Object} [init={}] - 可选初始字段对象（支持 Go 字段名或 JSON 小写字段名）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? init.id ?? 0;
    this.StaffID = init.StaffID ?? init.staffId ?? 0;
    this.LoginName = init.LoginName ?? init.loginName ?? "";
    this.ChineseName = init.ChineseName ?? init.chineseName ?? "";
    this.DeptID = init.DeptID ?? init.deptId ?? 0;
    this.DeptName = init.DeptName ?? init.deptName ?? "";
    this.IsGuest = init.IsGuest ?? init.isGuest ?? false;
    this.IsPlatformAdmin = init.IsPlatformAdmin ?? init.isPlatformAdmin ?? false;
    const rawAuthTime = init.AuthTime ?? init.authTime ?? null;
    if (rawAuthTime instanceof Date) {
      this.AuthTime = rawAuthTime;
    } else if (typeof rawAuthTime === "string" && rawAuthTime !== "") {
      this.AuthTime = new Date(rawAuthTime);
    } else {
      this.AuthTime = null;
    }
    this.AvatarURL = init.AvatarURL ?? init.avatarUrl ?? "";
  }

  /**
   * 将当前认证用户实例按 Go JSON 标签规则转换为可序列化的普通对象，并遵循 `omitempty` 省略空字段。
   * 在 `JSON.stringify`（如 `SignUser` 生成签名载荷）时由运行时自动调用。
   * @returns {Object} 与 Go `json.Marshal(User)` 输出字段一致的普通对象。
   */
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

  /**
   * 将认证层员工身份 `auth.User` 转换为持久化层领域实体 `domain.User`。
   * 在登录回调后同步员工基础资料到数据库前调用。
   * @returns {DomainUser} 包含基础身份字段的持久化层用户实体；接收者为空时返回零值实例。
   */
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

/**
 * 表示企业 SSO AccessToken 接口返回的外层响应结构。
 */
class IOAAuthResponse {
  /**
   * 构造企业 SSO 认证响应实例，未提供的字段按 Go 零值初始化。
   * 在解析 `ExchangeCode` 接口返回的 JSON 响应体时调用。
   * @param {Object} [init={}] - 可选初始字段对象（含 `Ret`、`ErrCode`、`ErrMsg`、`StackTrace`、`Data`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Ret = init.Ret ?? 0;
    this.ErrCode = init.ErrCode ?? 0;
    this.ErrMsg = init.ErrMsg ?? "";
    this.StackTrace = init.StackTrace ?? "";
    this.Data = init.Data != null ? new IOAAuthData(init.Data) : null;
  }
}

/**
 * 表示企业 SSO 认证接口 `Data` 字段中的票据与员工核心资料。
 */
class IOAAuthData {
  /**
   * 构造 SSO 票据与员工核心资料实例，未提供的字段按 Go 零值初始化。
   * 在构造 `IOAAuthResponse` 嵌套的 `Data` 字段时调用。
   * @param {Object} [init={}] - 可选初始字段对象（含票据、员工号、登录名、中文名与部门信息）。
   * @returns {void} 无返回值。
   */
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

/**
 * 使用指定密钥为员工身份对象生成带 HMAC-SHA256 签名的会话字符串（`<base64url载荷>.<hex签名>`）。
 * 在用户登录成功后写入认证 Cookie 前调用。
 * @param {User|null} u - 待签名的员工身份对象；为空时抛出错误。
 * @param {string} secret - 用于计算 HMAC-SHA256 签名的会话密钥。
 * @returns {string} 由 Base64URL 载荷与十六进制 HMAC 签名拼接而成的会话令牌字符串。
 */
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

/**
 * 校验由 `SignUser` 生成的会话令牌签名，并将其中的载荷反序列化为 `User` 实例。
 * 在请求鉴权中间件从 Cookie 读取并恢复当前登录用户信息时调用。
 * @param {string} tokenStr - 形如 `<base64url载荷>.<hex签名>` 的签名会话字符串。
 * @param {string} secret - 用于校验 HMAC-SHA256 签名的会话密钥。
 * @returns {User} 验签通过并反序列化后的员工身份实例；格式非法、验签失败或 JSON 无效时抛出错误。
 */
function ParseSignedUser(tokenStr, secret) {
  const parts = tokenStr.split(".");
  if (parts.length !== 2) {
    throw new Error("invalid token format");
  }
  const [b64Payload, sig] = parts;
  const mac = createHmac("sha256", secret);
  mac.update(b64Payload);
  const expectedSig = mac.digest("hex");
  // 按 UTF-8 字节长度比对后再调用 timingSafeEqual，避免多字节字符触发 RangeError。
  const sigBuf = Buffer.from(sig, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error("invalid token signature");
  }

  const raw = Buffer.from(b64Payload, "base64url");
  return new User(JSON.parse(raw.toString("utf8")));
}

module.exports = { User, IOAAuthResponse, IOAAuthData, SignUser, ParseSignedUser };
