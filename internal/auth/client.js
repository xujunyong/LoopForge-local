// client.js —— 对应 Go 文件：internal/auth/client.go
// 作用：与企业 SSO 认证网关交互的客户端，code 换员工信息、签会话串。
// Go 的 time.Duration 译为毫秒数；context 译为 AbortSignal（可空）；
// http.Client.Do 译为本文件的 doRequest（fetch 对应），见下面注释。

"use strict";

const { randomBytes, randomInt, createHash } = require("node:crypto");
const { SignUser, ParseSignedUser, User, IOAAuthResponse } = require("./types.js"); // 对应 Go 同包函数与类型，types.js 已翻译

// A unique process secret is safe for tests; deployments set a stable secret.
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

// doRequest：Go 的 httpClient.Do(req)，用 fetch 对应；fetch 的响应体用完即弃，没有 Body.Close。
// req 是 newSignedGet 造的 {method, url, headers, body, ctx}；ctx 为 AbortSignal 时直接用，否则按客户端超时兜底。
async function doRequest(client, req) {
  const signal = req.ctx instanceof AbortSignal ? req.ctx : AbortSignal.timeout(client.timeout);
  return fetch(req.url, { method: req.method, headers: req.headers, body: req.body ?? undefined, signal });
}

// Config 包含企业 SSO 认证客户端的全部配置。
class Config {
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

// Client 是与企业 SSO 认证网关交互的客户端。
class Client {
  constructor(cfg, httpClient, photoCache) {
    this.cfg = cfg;
    this.httpClient = httpClient;
    this.photoCache = photoCache;
  }
}

// NewClient 根据指定配置创建认证客户端。
function NewClient(cfg) {
  // Go 的 Config 零值字段是 "" / 0，普通对象缺字段时先用 Config 补齐零值。
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
  // newPhotoCache 在 photo.js 里，NewClient 调用时才 require，避免与 photo.js 循环引用。
  const { newPhotoCache } = require("./photo.js");
  return new Client(cfg, { timeout: cfg.Timeout }, newPhotoCache(60 * 60 * 1000, 2000));
}

// NewClientFromEnv 从环境变量中读取配置并创建 Client。
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

// Config 返回客户端配置的副本。
Client.prototype.Config = function () {
  return this.cfg;
};

// SetHTTPClient 允许注入自定义 http.Client（主要用于单测 Mock）。
Client.prototype.SetHTTPClient = function (hc) {
  if (hc != null) {
    this.httpClient = hc;
  }
};

// SignUser 使用客户端配置的 SessionSecret 为 User 生成签名 Token。
Client.prototype.SignUser = function (u) {
  return SignUser(u, this.cfg.SessionSecret);
};

// ParseSignedUser 解析并校验被 SignUser 签名的 Token。
Client.prototype.ParseSignedUser = function (tokenStr) {
  return ParseSignedUser(tokenStr, this.cfg.SessionSecret);
};

// FallbackGuestUser 返回优雅降级后的访客身份。
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

// LoginURL 返回跳转至企业 SSO 登录页的完整 URL；未配置 SSO 时返回本地登录页。
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

// GenerateRIOHeaders 根据时间戳与随机数计算 RIO 网关认证签名头部。
// 签名规则：SHA256(timestamp + appToken + nonce + timestamp).upper()
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

// GenerateRIOHeaders 生成当前时刻的 RIO 头部。
Client.prototype.GenerateRIOHeaders = function () {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const n = randomInt(0, 9000);
  const nonce = String(n + 1000).padStart(4, "0");
  return GenerateRIOHeaders(this.cfg.PaaSID, this.cfg.AppToken, timestamp, nonce);
};

// newSignedGet 构造带 RIO 网关签名头与指定 Accept 头的 GET 请求。
Client.prototype.newSignedGet = function (ctx, reqURL, accept) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(this.GenerateRIOHeaders())) {
    headers.set(k, v);
  }
  headers.set("Accept", accept);
  return { method: "GET", url: reqURL, headers, body: null, ctx };
};

// ExchangeCode 通过企业 SSO 认证网关将 code 换取员工信息。
// 遵循降级设计：当网关不可用、未配置凭证或鉴权出错时，记录日志并优雅降级为访客，不抛出阻断异常。
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
  const req = this.newSignedGet(ctx, reqURL, "application/json");

  let resp;
  try {
    resp = await doRequest(this.httpClient, req);
  } catch (err) {
    console.log(`[auth] request SSO endpoint failed: ${err}, fallback to guest`);
    return FallbackGuestUser();
  }

  const body = Buffer.from(await resp.arrayBuffer()).subarray(0, 1 << 20); // 限制 1MB

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
