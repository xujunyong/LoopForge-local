/**
 * @file internal/auth/client.js
 * @description 对应 Go 文件：internal/auth/client.go
 * 职责与边界：实现与企业 SSO 认证网关交互的客户端（Client）及配置（Config），涵盖环境变量装配、
 * 登录跳转链接构造、RIO 网关签名头生成、会话令牌签发/验签，以及通过授权码（code）换取员工身份与访客降级逻辑。
 * 语法差异说明：
 * - Go 的 `time.Duration` 译为毫秒数；`context.Context` 译为 `AbortSignal`（可为空）。
 * - Go 的 `http.Client.Do` 对应 Node 原生 `fetch`（封装在 `doRequest` 中），因 `fetch` 返回 Promise，
 *   `doRequest` 与 `Client.prototype.ExchangeCode` 使用 `async/await` 表达。
 * - Go 中方法定义在 `Client` 指针上的成员统一挂载至 `Client.prototype`，与同包 `photo.js` 中的扩展方法保持一致。
 */

"use strict";

const { randomBytes, randomInt, createHash } = require("node:crypto");
const { SignUser, ParseSignedUser, User, IOAAuthResponse } = require("./types.js"); // 对应 Go 同包函数与类型

// 进程级随机兜底会话密钥：测试环境安全可用，正式部署应通过配置提供固定密钥。
const processSessionSecret = (() => {
  const b = randomBytes(32);
  return b.toString("hex");
})();

// 默认配置常量
const DefaultAuthHost = "";
const DefaultAuthURI = "";
const DefaultPhotoURI = "";
const DefaultAppDomain = "";
const DefaultPaaSID = "";
const DefaultTimeout = 5 * 1000;

/**
 * 执行一次 HTTP 请求，对应 Go 中 `http.Client.Do(req)` 的底层发送行为。
 * 在 `ExchangeCode` 与 `photo.js` 的 `FetchPhoto` 向企业 SSO 网关发起签名请求时调用。
 * @param {{ timeout?: number, Do?: Function }} client - HTTP 客户端对象（支持配置 `timeout` 毫秒超时，或单测注入的自定义 `Do` 方法）。
 * @param {{ method: string, url: string, headers: Headers, body: any, ctx: AbortSignal|null }} req - 由 `newSignedGet` 构造的请求描述对象。
 * @returns {Promise<Response>} 异步返回 Fetch `Response` 对象；请求超时或网络异常时拒绝并抛出错误。
 */
async function doRequest(client, req) {
  if (client != null && typeof client.Do === "function") {
    return client.Do(req);
  }
  const signal = req.ctx instanceof AbortSignal ? req.ctx : AbortSignal.timeout(client.timeout);
  return fetch(req.url, { method: req.method, headers: req.headers, body: req.body ?? undefined, signal });
}

/**
 * 表示企业 SSO 认证客户端的全部配置项。
 */
class Config {
  /**
   * 构造认证客户端配置实例，未提供的字段按 Go 零值初始化。
   * 在创建 `Client` 或复制客户端配置快照时调用。
   * @param {Object} [init={}] - 可选配置字段对象（含 `PaaSID`、`AppToken`、`AuthHost`、`AuthURI`、`PhotoURI`、`AppDomain`、`LoginURL`、`SessionSecret`、`Timeout`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.PaaSID = init.PaaSID ?? "";
    this.AppToken = init.AppToken ?? "";
    this.AuthHost = init.AuthHost ?? "";
    this.AuthURI = init.AuthURI ?? "";
    this.PhotoURI = init.PhotoURI ?? "";
    this.AppDomain = init.AppDomain ?? "";
    this.LoginURL = init.LoginURL ?? "";
    this.SessionSecret = init.SessionSecret ?? "";
    this.Timeout = init.Timeout ?? 0;
  }
}

/**
 * 表示与企业 SSO 认证网关及头像服务交互的客户端实例。
 */
class Client {
  /**
   * 构造认证客户端实例，未提供的字段按 Go 零值初始化。
   * 通常由 `NewClient` 内部调用，也可在测试中直接组装。
   * @param {Object} [init={}] - 可选初始字段对象（含 `cfg`、`httpClient`、`photoCache`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.cfg = init.cfg ?? new Config();
    this.httpClient = init.httpClient ?? null;
    this.photoCache = init.photoCache ?? null;
  }
}

/**
 * 根据指定配置规范化地址路径、补齐默认超时与会话密钥，并创建认证客户端实例。
 * 在服务启动初始化认证模块或单元测试构造隔离客户端时调用。
 * @param {Config|Object} cfg - 认证客户端配置对象（按值拷贝，不修改入参原对象）。
 * @returns {Client} 已完成默认值填充并初始化头像内存缓存的 `Client` 实例。
 */
function NewClient(cfg) {
  // Go 的 Config 按值传递且零值字段为 "" / 0，先用 Config 拷贝并补齐零值。
  cfg = new Config(cfg);
  if (cfg.AuthHost === "") {
    cfg.AuthHost = DefaultAuthHost;
  }
  cfg.AuthHost = cfg.AuthHost.replace(/\/+$/, "");
  if (cfg.AuthURI === "") {
    cfg.AuthURI = DefaultAuthURI;
  }
  if (cfg.AuthURI !== "" && !cfg.AuthURI.startsWith("/")) {
    cfg.AuthURI = "/" + cfg.AuthURI;
  }
  if (cfg.PhotoURI === "") {
    cfg.PhotoURI = DefaultPhotoURI;
  }
  if (cfg.PhotoURI !== "" && !cfg.PhotoURI.startsWith("/")) {
    cfg.PhotoURI = "/" + cfg.PhotoURI;
  }
  cfg.PhotoURI = cfg.PhotoURI.replace(/\/+$/, "");
  if (cfg.AppDomain === "") {
    cfg.AppDomain = DefaultAppDomain;
  }
  if (cfg.SessionSecret === "") {
    if (cfg.AppToken !== "") {
      cfg.SessionSecret = cfg.AppToken;
    } else {
      cfg.SessionSecret = processSessionSecret;
    }
  }
  if (cfg.Timeout <= 0) {
    cfg.Timeout = DefaultTimeout;
  }
  // 延迟引入同包 photo.js 的 newPhotoCache，避免与 photo.js 顶部引用 Client 产生循环依赖。
  const { newPhotoCache } = require("./photo.js");
  return new Client({
    cfg,
    httpClient: { timeout: cfg.Timeout },
    photoCache: newPhotoCache(60 * 60 * 1000, 2000),
  });
}

/**
 * 从当前进程环境变量中读取企业 SSO 相关配置并创建认证客户端。
 * 在服务端进程启动装配依赖时调用。
 * @returns {Client} 基于环境变量装配完成的 `Client` 实例。
 */
function NewClientFromEnv() {
  let paasID = getEnvAny("AGENTFLOW_SSO_PAAS_ID");
  if (paasID === "") {
    paasID = DefaultPaaSID;
  }
  const appToken = getEnvAny("AGENTFLOW_SSO_APP_TOKEN");
  const authHost = getEnvAny("AGENTFLOW_SSO_AUTH_HOST");
  const authURI = getEnvAny("AGENTFLOW_SSO_AUTH_URI");
  const photoURI = getEnvAny("AGENTFLOW_SSO_PHOTO_URI");
  const loginURL = getEnvAny("AGENTFLOW_SSO_LOGIN_URL");
  const appDomain = getEnvAny("AGENTFLOW_APP_DOMAIN", "APP_DOMAIN");
  const sessionSecret = getEnvAny("AGENTFLOW_SESSION_SECRET", "SESSION_SECRET");

  return NewClient(new Config({
    PaaSID: paasID,
    AppToken: appToken,
    AuthHost: authHost,
    AuthURI: authURI,
    PhotoURI: photoURI,
    AppDomain: appDomain,
    LoginURL: loginURL,
    SessionSecret: sessionSecret,
  }));
}

/**
 * 返回当前认证客户端配置的值副本，避免调用方修改内部状态。
 * 在调试、检查配置或读取应用域名/网关地址时调用。
 * @returns {Config} 客户端配置对象的浅拷贝副本。
 */
Client.prototype.Config = function () {
  return new Config(this.cfg);
};

/**
 * 替换客户端内部使用的 HTTP 客户端实例（主要用于单元测试注入 Mock）。
 * 在单测需要拦截或模拟 SSO HTTP 请求时调用。
 * @param {Object|null} hc - 自定义 HTTP 客户端对象；为空时忽略不替换。
 * @returns {void} 无返回值。
 */
Client.prototype.SetHTTPClient = function (hc) {
  if (hc != null) {
    this.httpClient = hc;
  }
};

/**
 * 使用客户端配置的 `SessionSecret` 为员工身份生成带 HMAC 签名的会话令牌。
 * 在登录态签发接口生成 Cookie 值时调用。
 * @param {User|null} u - 待签名的员工身份对象。
 * @returns {string} 签名后的会话令牌字符串；入参为空时抛出错误。
 */
Client.prototype.SignUser = function (u) {
  return SignUser(u, this.cfg.SessionSecret);
};

/**
 * 使用客户端配置的 `SessionSecret` 校验并解析签名会话令牌。
 * 在鉴权中间件校验请求 Cookie 并恢复登录态时调用。
 * @param {string} tokenStr - 待校验的签名会话字符串。
 * @returns {User} 解析出的员工身份对象；格式非法或验签失败时抛出错误。
 */
Client.prototype.ParseSignedUser = function (tokenStr) {
  return ParseSignedUser(tokenStr, this.cfg.SessionSecret);
};

/**
 * 构造优雅降级后的默认访客身份对象（`LoginName: "guest"`、`IsGuest: true`）。
 * 在 SSO 未配置、授权码为空或网关调用异常需要降级放行时调用。
 * @returns {User} 标记为访客且记录当前 UTC 认证时间的 `User` 实例。
 */
function FallbackGuestUser() {
  return new User({
    ID: 0,
    StaffID: 0,
    LoginName: "guest",
    ChineseName: "访客",
    DeptID: 0,
    DeptName: "访客",
    IsGuest: true,
    AuthTime: new Date(),
  });
}

/**
 * 构造跳转至企业 SSO 登录页的完整 URL；若未配置企业 SSO 凭证或登录入口则返回本地登录页路径 `"/login.html"`。
 * 在未登录请求触发浏览器重定向至登录页时调用。
 * @param {string} returnURL - 登录成功后期望回跳的目标地址；为空时默认回退到 `http://<AppDomain>/`。
 * @returns {string} 带 `oauth`、`appkey` 与 `url` 参数的企业 SSO 登录地址，或本地登录页路径。
 */
Client.prototype.LoginURL = function (returnURL) {
  const loginURL = this.cfg.LoginURL.trim();
  if (this.cfg.AppToken === "" || loginURL === "") {
    return "/login.html";
  }
  returnURL = returnURL.trim();
  if (returnURL === "") {
    returnURL = `http://${this.cfg.AppDomain}/`;
  }
  let appKey = this.cfg.PaaSID;
  if (appKey === "") {
    appKey = DefaultPaaSID;
  }
  const sep = loginURL.includes("?") ? "&" : "?";
  return `${loginURL}${sep}oauth=true&appkey=${encodeURIComponent(appKey)}&url=${encodeURIComponent(returnURL)}`;
};

/**
 * 根据应用标识、令牌、秒级时间戳与随机数计算 RIO 网关认证签名请求头集合。
 * 签名规则：`SHA256(timestamp + appToken + nonce + timestamp)` 转大写十六进制。
 * 在构造发往 RIO 网关的任意签名请求或单元测试验证签名算法时调用。
 * @param {string} paasID - 平台分配的 PaaS 应用标识。
 * @param {string} appToken - 应用认证密钥令牌。
 * @param {string} timestamp - 秒级 Unix 时间戳字符串。
 * @param {string} nonce - 随机防重放数字字符串。
 * @returns {Object<string, string>} 包含 `x-rio-paasid`、`x-rio-nonce`、`x-rio-timestamp`、`x-rio-signature` 的请求头映射对象。
 */
function GenerateRIOHeaders(paasID, appToken, timestamp, nonce) {
  const signStr = timestamp + appToken + nonce + timestamp;
  const sum = createHash("sha256").update(signStr, "utf8").digest("hex");
  const sig = sum.toUpperCase();
  return {
    "x-rio-paasid": paasID,
    "x-rio-nonce": nonce,
    "x-rio-timestamp": timestamp,
    "x-rio-signature": sig,
  };
}

/**
 * 使用当前客户端配置、当前秒级时间戳及 1000-9999 范围内的随机四位数字生成 RIO 网关签名请求头。
 * 在 `newSignedGet` 构造签名 HTTP 请求时调用。
 * @returns {Object<string, string>} 当前时刻的 RIO 认证请求头映射对象。
 */
Client.prototype.GenerateRIOHeaders = function () {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const n = randomInt(0, 9000);
  const nonce = String(n + 1000).padStart(4, "0");
  return GenerateRIOHeaders(this.cfg.PaaSID, this.cfg.AppToken, timestamp, nonce);
};

/**
 * 构造携带 RIO 网关签名头与指定 `Accept` 请求头的 GET 请求描述对象。
 * 在 `ExchangeCode` 与 `FetchPhoto` 发起上游 SSO HTTP 请求前调用。
 * @param {AbortSignal|null} ctx - 可选的请求取消信号，对应 Go 的 `context.Context`。
 * @param {string} reqURL - 完整的目标请求 URL。
 * @param {string} accept - 请求期望接收的 `Accept` MIME 类型字符串。
 * @returns {{ method: string, url: string, headers: Headers, body: null, ctx: AbortSignal|null }} 可直接传入 `doRequest` 的 GET 请求对象。
 */
Client.prototype.newSignedGet = function (ctx, reqURL, accept) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(this.GenerateRIOHeaders())) {
    headers.set(k, v);
  }
  headers.set("Accept", accept);
  return { method: "GET", url: reqURL, headers, body: null, ctx };
};

/**
 * 通过企业 SSO 认证网关使用授权码（code）换取员工身份信息。
 * 遵循优雅降级策略：当 code 为空、网关未配置、网络超时或响应异常时记录日志并降级返回访客身份，不抛出阻断异常。
 * 在 SSO 登录回调接口处理前端带回的授权码时调用。
 * @param {AbortSignal|null} ctx - 可选的请求取消信号，对应 Go 的 `context.Context`。
 * @param {string} code - 企业 SSO 回调携带的一次性授权码。
 * @returns {Promise<User>} 异步返回认证成功后的员工 `User` 实例或降级后的访客 `User` 实例。
 */
Client.prototype.ExchangeCode = async function (ctx, code) {
  code = code.trim();
  if (code === "") {
    return FallbackGuestUser();
  }

  if (this.cfg.PaaSID === "" || this.cfg.AppToken === "" || this.cfg.AuthHost === "" || this.cfg.AuthURI === "") {
    console.log("[auth] SSO gateway is not configured, fallback to guest user");
    return FallbackGuestUser();
  }

  const reqURL = `${this.cfg.AuthHost}${this.cfg.AuthURI}?code=${encodeURIComponent(code)}`;
  let req;
  try {
    req = this.newSignedGet(ctx, reqURL, "application/json");
  } catch (err) {
    console.log(`[auth] create request failed: ${err}, fallback to guest`);
    return FallbackGuestUser();
  }

  let resp;
  try {
    resp = await doRequest(this.httpClient, req);
  } catch (err) {
    console.log(`[auth] request SSO endpoint failed: ${err}, fallback to guest`);
    return FallbackGuestUser();
  }

  let body;
  try {
    body = Buffer.from(await resp.arrayBuffer()).subarray(0, 1 << 20); // 限制 1MB
  } catch (err) {
    console.log(`[auth] read response body failed: ${err}, fallback to guest`);
    return FallbackGuestUser();
  }

  if (resp.status !== 200) {
    console.log(`[auth] unexpected status code ${resp.status} from SSO, body: ${body.toString("utf8")}, fallback to guest`);
    return FallbackGuestUser();
  }

  let authResp;
  try {
    authResp = new IOAAuthResponse(JSON.parse(body.toString("utf8")));
  } catch (err) {
    console.log(`[auth] decode auth response JSON failed: ${err}, body: ${body.toString("utf8")}, fallback to guest`);
    return FallbackGuestUser();
  }

  if (authResp.Ret !== 0 || authResp.Data == null) {
    console.log(`[auth] SSO returned failure: Ret=${authResp.Ret} ErrCode=${authResp.ErrCode} ErrMsg=${authResp.ErrMsg}, fallback to guest`);
    return FallbackGuestUser();
  }

  let chineseName = authResp.Data.ChineseName.trim();
  if (chineseName === "") {
    chineseName = authResp.Data.LoginName.trim();
  }

  const loginName = authResp.Data.LoginName.trim();

  return new User({
    StaffID: authResp.Data.StaffId,
    LoginName: loginName,
    ChineseName: chineseName,
    DeptID: authResp.Data.DeptId,
    DeptName: authResp.Data.DeptName.trim(),
    IsGuest: false,
    AuthTime: new Date(),
  });
};

/**
 * 按顺序读取多个候选环境变量名，返回首个非空且去除首尾空白的值。
 * 在 `NewClientFromEnv` 支持新旧环境变量名回退读取时调用。
 * @param {...string} keys - 按优先级排列的环境变量名列表。
 * @returns {string} 首个非空环境变量值；全部未设置或为空白时返回空字符串 `""`。
 */
function getEnvAny(...keys) {
  for (const k of keys) {
    const v = (process.env[k] ?? "").trim();
    if (v !== "") {
      return v;
    }
  }
  return "";
}

module.exports = {
  DefaultAuthHost, DefaultAuthURI, DefaultPhotoURI, DefaultAppDomain, DefaultPaaSID, DefaultTimeout,
  Config, Client, NewClient, NewClientFromEnv, FallbackGuestUser, GenerateRIOHeaders, doRequest,
};
