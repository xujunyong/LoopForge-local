/**
 * 对应 Go 文件：internal/gongfeng/oauth.go
 * 作用：封装与工蜂（Gongfeng）OAuth 端点的交互，用于生成授权跳转地址、用授权码换取访问令牌、
 *       用刷新令牌续期以及通过访问令牌查询绑定的工蜂登录名。
 * 职责边界：仅负责工蜂 OAuth 配置解析与 HTTP 协议调用，不负责令牌持久化存储、刷新锁或 Git 凭据装配。
 * 语法差异说明：
 * - Go 的 time.Duration 统一译为毫秒数；
 * - Go 的 context.Context 译为可空的 AbortSignal，并与 15 秒默认请求超时通过 AbortSignal.any 合并生效；
 * - Go 的 url.Values 译为 URLSearchParams，并在编码前调用 sort() 与 Go 按键排序行为对齐；
 * - Go 的 (值, error) 译为成功返回值、失败 throw Error；(status, body, error) 译为成功返回 [status, body]、失败 throw Error；
 * - 原 Go 函数名 do 命中 JS 保留字，局部改名为 doReq。
 */

"use strict";

const { GongfengHost } = require("../config/integration_hosts.js"); // 对应 Go 的 config.GongfengHost

/** 仓库克隆与推送所需的工蜂 OAuth 权限范围，对应应用必须开通这两个 scope。 */
const RepositoryScope = "read_repository write_repository";

/** 响应未返回有效 expires_in 时采用的默认访问令牌有效期（2 小时，毫秒）。 */
const defaultTTL = 2 * 60 * 60 * 1000;

/** 单次读取工蜂 HTTP 响应体的最大字节上限（64 KiB）。 */
const maxResponseBytes = 64 << 10;

/** 约束所有工蜂 OAuth HTTP 调用超时的客户端配置（15 秒，避免持锁刷新时阻塞挂死）。 */
const httpClient = { Timeout: 15 * 1000 };

/**
 * 部署环境中注册的工蜂 OAuth 应用配置（对应 Go 导出结构体 Config）。
 */
class Config {
  /**
   * 构造工蜂 OAuth 配置对象，未提供字段按 Go 结构体零值初始化。
   * 使用场景：由 ConfigFromEnv 从环境变量构造，或由调用方显式实例化。
   *
   * @param {Partial<Config>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ClientID = init.ClientID ?? "";
    this.ClientSecret = init.ClientSecret ?? "";
    this.RedirectURI = init.RedirectURI ?? "";
    this.AuthorizeURL = init.AuthorizeURL ?? "";
    this.TokenURL = init.TokenURL ?? "";
    this.APIBase = init.APIBase ?? "";
  }

  /**
   * 判断当前配置是否足以发起完整的 OAuth 授权流程。
   * 使用场景：前端能力探测或启动浏览器 OAuth 授权跳转前调用。
   *
   * @returns {boolean} 配置完整可发起授权返回 true，否则返回 false。
   */
  Enabled() {
    return this.RefreshEnabled() && this.AuthorizeURL !== "" && this.APIBase !== "";
  }

  /**
   * 判断当前配置是否足以调用令牌接口（换取或刷新令牌）。
   * 使用场景：后台刷新用户 OAuth 令牌或请求 token 端点前调用。
   *
   * @returns {boolean} 客户端凭据与 TokenURL 均已配置返回 true，否则返回 false。
   */
  RefreshEnabled() {
    return this.clientConfigured() && this.TokenURL !== "";
  }

  /**
   * 检查 ClientID、ClientSecret 与 RedirectURI 三项基础客户端参数是否均非空白。
   * 使用场景：RefreshEnabled 与 AuthorizeURL 内部校验配置完整性时调用。
   *
   * @returns {boolean} 三项参数均非空白返回 true，否则返回 false。
   */
  clientConfigured() {
    return this.ClientID.trim() !== "" && this.ClientSecret.trim() !== "" && this.RedirectURI.trim() !== "";
  }
}

/**
 * 从环境变量读取工蜂 OAuth 配置；未显式覆盖的端点会基于配置的主机名自动推导。
 * 使用场景：服务启动或每次需要构造工蜂 OAuth 客户端配置时调用。
 *
 * @returns {Config} 解析并规范化后的 Config 实例。
 */
function ConfigFromEnv() {
  const host = GongfengHost();
  const endpoint = (endpointPath) => {
    if (host === "") {
      return "";
    }
    return "https://" + host + endpointPath;
  };
  return new Config({
    ClientID: (process.env.AGENTFLOW_GONGFENG_OAUTH_CLIENT_ID ?? "").trim(),
    ClientSecret: (process.env.AGENTFLOW_GONGFENG_OAUTH_CLIENT_SECRET ?? "").trim(),
    RedirectURI: (process.env.AGENTFLOW_GONGFENG_OAUTH_REDIRECT_URI ?? "").trim(),
    AuthorizeURL: envOr("AGENTFLOW_GONGFENG_OAUTH_AUTHORIZE_URL", endpoint("/oauth/authorize")),
    TokenURL: envOr("AGENTFLOW_GONGFENG_OAUTH_TOKEN_URL", endpoint("/oauth/token")),
    APIBase: envOr("AGENTFLOW_GONGFENG_OAUTH_API_BASE", endpoint("/api/v3")).replace(/\/+$/, ""),
  });
}

/**
 * 按 Go strconv.ParseBool 规则读取布尔型环境变量；未设置或无法解析时返回 false。
 * 使用场景：包内读取开关类环境变量时调用。
 *
 * @param {string} key - 环境变量名。
 * @returns {boolean} 解析为真时返回 true，否则返回 false。
 */
function envBool(key) {
  const raw = (process.env[key] ?? "").trim();
  return raw === "1" || raw === "t" || raw === "T" || raw === "true" || raw === "TRUE" || raw === "True";
}

/**
 * 读取指定环境变量并去除首尾空白；若为空则返回兜底默认值。
 * 使用场景：ConfigFromEnv 解析可覆盖的 OAuth 端点 URL 时调用。
 *
 * @param {string} key - 环境变量名。
 * @param {string} fallback - 环境变量为空时使用的默认值。
 * @returns {string} 生效的配置字符串。
 */
function envOr(key, fallback) {
  const value = (process.env[key] ?? "").trim();
  if (value !== "") {
    return value;
  }
  return fallback;
}

/**
 * 工蜂 OAuth 访问令牌结果（对应 Go 导出结构体 Token）。
 * 当应用未签发刷新令牌时 RefreshToken 可能为空，ExpiresIn 单位为秒。
 */
class Token {
  /**
   * 构造令牌对象，未提供字段按 Go 结构体零值初始化。
   * 使用场景：requestToken 解析工蜂令牌接口响应后构造返回值。
   *
   * @param {Partial<Token>} [init={}] - 初始化字段对象（AccessToken、RefreshToken、ExpiresIn）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.AccessToken = init.AccessToken ?? "";
    this.RefreshToken = init.RefreshToken ?? "";
    this.ExpiresIn = init.ExpiresIn ?? 0;
  }

  /**
   * 计算访问令牌的过期时间点；若 ExpiresIn 缺失或非正则回退为默认 2 小时。
   * 使用场景：保存 OAuth 授权凭据时计算过期时间戳以便提前刷新。
   *
   * @param {Date} now - 作为起算基准的当前时间。
   * @returns {Date} 令牌应被视为过期的目标时间点。
   */
  Expiry(now) {
    let ttl = this.ExpiresIn * 1000;
    if (ttl <= 0) {
      ttl = defaultTTL;
    }
    return new Date(now.getTime() + ttl);
  }
}

/**
 * 构造引导用户在浏览器中确认工蜂 OAuth 授权的跳转地址。
 * 使用场景：用户点击“连接工蜂”发起 OAuth 登录授权时调用。
 *
 * @param {Config} cfg - 工蜂 OAuth 应用配置。
 * @param {string} state - 防 CSRF 的随机状态参数。
 * @returns {string} 附带完整查询参数的授权页面 URL；未配置或地址非法时抛出 Error。
 */
function AuthorizeURL(cfg, state) {
  if (!cfg.clientConfigured() || cfg.AuthorizeURL === "") {
    throw new Error("工蜂 OAuth 未配置");
  }
  const u = new URL(cfg.AuthorizeURL);
  u.searchParams.set("client_id", cfg.ClientID);
  u.searchParams.set("redirect_uri", cfg.RedirectURI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  u.searchParams.set("scope", RepositoryScope);
  // 按键名排序，与 Go url.Values.Encode 的确定性输出保持一致。
  u.searchParams.sort();
  return u.toString();
}

/**
 * 使用回调收到的授权码（authorization code）向工蜂换取访问令牌。
 * 使用场景：处理工蜂 OAuth 回调请求时调用。
 *
 * @param {AbortSignal | null} ctx - 可选取消信号。
 * @param {Config} cfg - 工蜂 OAuth 应用配置。
 * @param {string} code - 工蜂回调返回的授权码。
 * @returns {Promise<Token>} 换取到的 Token 实例；失败时抛出 Error。
 */
async function Exchange(ctx, cfg, code) {
  const form = new URLSearchParams();
  form.set("client_id", cfg.ClientID);
  form.set("client_secret", cfg.ClientSecret);
  form.set("code", code.trim());
  form.set("grant_type", "authorization_code");
  form.set("redirect_uri", cfg.RedirectURI);
  return requestToken(ctx, cfg, form);
}

/**
 * 使用已保存的刷新令牌向工蜂换取新的访问令牌；若响应未返回新刷新令牌则保留旧值。
 * 使用场景：访问令牌即将过期时后台自动续期调用。
 *
 * @param {AbortSignal | null} ctx - 可选取消信号。
 * @param {Config} cfg - 工蜂 OAuth 应用配置。
 * @param {string} refreshToken - 当前持有的刷新令牌。
 * @returns {Promise<Token>} 刷新后的 Token 实例；失败时抛出 Error。
 */
async function Refresh(ctx, cfg, refreshToken) {
  const form = new URLSearchParams();
  form.set("client_id", cfg.ClientID);
  form.set("client_secret", cfg.ClientSecret);
  form.set("refresh_token", refreshToken.trim());
  form.set("grant_type", "refresh_token");
  form.set("redirect_uri", cfg.RedirectURI);
  const tok = await requestToken(ctx, cfg, form);
  if (tok.RefreshToken === "") {
    tok.RefreshToken = refreshToken.trim();
  }
  return tok;
}

/**
 * 使用访问令牌查询工蜂当前用户信息并返回绑定的登录用户名。
 * 使用场景：OAuth 授权成功后校验令牌并关联工蜂账号用户名时调用。
 *
 * @param {AbortSignal | null} ctx - 可选取消信号。
 * @param {Config} cfg - 工蜂 OAuth 应用配置（需提供 APIBase）。
 * @param {string} accessToken - 工蜂 OAuth 访问令牌。
 * @returns {Promise<string>} 工蜂用户名；请求失败、状态非 200 或响应无法解析时抛出 Error。
 */
async function Username(ctx, cfg, accessToken) {
  const targetURL = new URL(cfg.APIBase + "/user").toString();
  const req = {
    method: "GET",
    url: targetURL,
    headers: new Headers({ Authorization: "Bearer " + accessToken.trim() }),
    body: null,
    ctx,
  };
  const [status, body] = await doReq(req);
  if (status !== 200) {
    throw new Error(`工蜂用户信息返回 HTTP ${status}`);
  }
  let user;
  try {
    user = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("工蜂用户信息无法解析");
  }
  if (
    user == null ||
    typeof user !== "object" ||
    Array.isArray(user) ||
    typeof user.username !== "string" ||
    user.username.trim() === ""
  ) {
    throw new Error("工蜂用户信息无法解析");
  }
  return user.username;
}

/**
 * 向工蜂 TokenURL 发送表单 POST 请求并解析返回的令牌 JSON。
 * 使用场景：Exchange 与 Refresh 共用的内部令牌请求实现。
 *
 * @param {AbortSignal | null} ctx - 可选取消信号。
 * @param {Config} cfg - 工蜂 OAuth 应用配置。
 * @param {URLSearchParams} form - 表单参数集合。
 * @returns {Promise<Token>} 解析得到的 Token 实例；配置缺失、网络错误、状态异常或响应非法时抛出 Error。
 */
async function requestToken(ctx, cfg, form) {
  if (!cfg.RefreshEnabled()) {
    throw new Error("工蜂 OAuth 未配置");
  }
  const targetURL = new URL(cfg.TokenURL).toString();
  form.sort();
  const req = {
    method: "POST",
    url: targetURL,
    headers: new Headers({
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    }),
    body: form.toString(),
    ctx,
  };
  const [status, body] = await doReq(req);
  if (status !== 200) {
    throw new Error(`工蜂令牌接口返回 HTTP ${status}：${redact(cfg, truncate(body.toString("utf8"), 180))}`);
  }
  let raw;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
      throw new Error("invalid token payload");
    }
    raw = parsed ?? {};
    if (
      (raw.access_token != null && typeof raw.access_token !== "string") ||
      (raw.refresh_token != null && typeof raw.refresh_token !== "string") ||
      (raw.expires_in != null && !Number.isInteger(raw.expires_in)) ||
      (raw.error != null && typeof raw.error !== "string") ||
      (raw.error_description != null && typeof raw.error_description !== "string")
    ) {
      throw new Error("invalid token fields");
    }
  } catch {
    throw new Error("工蜂令牌响应无法解析");
  }
  if ((raw.access_token ?? "") === "") {
    let msg = raw.error_description ?? "";
    if (msg === "") {
      msg = raw.error ?? "";
    }
    if (msg === "") {
      msg = "响应里没有 access_token";
    }
    throw new Error(`工蜂没有返回访问令牌：${redact(cfg, msg)}`);
  }
  return new Token({
    AccessToken: raw.access_token,
    RefreshToken: raw.refresh_token,
    ExpiresIn: raw.expires_in,
  });
}

/**
 * 使用带 15 秒上限的 HTTP 客户端发送请求，返回状态码和最多 maxResponseBytes 字节的响应体。
 * 传输层连接失败统一包装为“无法连接工蜂”错误，便于调用方只处理 HTTP 状态与载荷。
 * 原 Go 函数名为 do，因命中 JS 保留字改名为 doReq。
 * 使用场景：Username 与 requestToken 发送 HTTP 请求时内部调用。
 *
 * @param {{ method: string, url: string, headers: Headers, body: string | null, ctx: AbortSignal | null }} req - 构造好的请求描述对象。
 * @returns {Promise<[number, Buffer]>} 元组 [HTTP 状态码, 截断至最大上限的响应体字节]；连接或读取失败时抛出 Error。
 */
async function doReq(req) {
  const timeoutSignal = httpClient.Timeout > 0 ? AbortSignal.timeout(httpClient.Timeout) : null;
  const signal = req.ctx instanceof AbortSignal && timeoutSignal != null
    ? AbortSignal.any([req.ctx, timeoutSignal])
    : (req.ctx instanceof AbortSignal ? req.ctx : timeoutSignal ?? undefined);
  let resp;
  try {
    resp = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ?? undefined,
      signal,
    });
  } catch (err) {
    throw new Error(`无法连接工蜂：${err.message}`, { cause: err });
  }
  const body = Buffer.from(await resp.arrayBuffer()).subarray(0, maxResponseBytes);
  return [resp.status, body];
}

/**
 * 对错误消息中的 ClientSecret 进行脱敏替换，避免敏感凭据泄露到日志或错误提示中。
 * 使用场景：requestToken 构造错误提示时内部调用。
 *
 * @param {Config} cfg - 包含 ClientSecret 的 OAuth 配置。
 * @param {string} msg - 原始错误文本。
 * @returns {string} 将 ClientSecret 替换为 "***" 后的文本。
 */
function redact(cfg, msg) {
  if (cfg.ClientSecret !== "") {
    msg = msg.split(cfg.ClientSecret).join("***");
  }
  return msg;
}

/**
 * 去除字符串首尾空白并在超过长度上限时截断。
 * 使用场景：requestToken 摘要展示非 200 响应体内容时内部调用。
 *
 * @param {string} s - 原始字符串。
 * @param {number} n - 允许保留的最大字符数。
 * @returns {string} 去空白并按上限截断后的字符串。
 */
function truncate(s, n) {
  s = s.trim();
  if (s.length <= n) {
    return s;
  }
  return s.slice(0, n);
}

module.exports = {
  RepositoryScope,
  Config,
  ConfigFromEnv,
  Token,
  AuthorizeURL,
  Exchange,
  Refresh,
  Username,
};
