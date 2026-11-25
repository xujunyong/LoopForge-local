// oauth.js —— 对应 Go 文件：internal/gongfeng/oauth.go
// 作用：与工蜂 OAuth 端点交互，拿用户维度的仓库访问令牌。
// Go 的 time.Duration 译为毫秒数；context 译为 AbortSignal（可空）；
// url.Values 译为 URLSearchParams；(值, error) 译为成功返回值、失败 throw。

"use strict";

const { GongfengHost } = require("../config/integration_hosts.js"); // 对应 Go 的 config.GongfengHost，config 已翻译

// Repository clone and push need both scopes. The application must allow them.
const RepositoryScope = "read_repository write_repository";
const defaultTTL = 2 * 60 * 60 * 1000;
// maxResponseBytes caps how much of any Gongfeng response body is read.
const maxResponseBytes = 64 << 10;

// httpClient bounds every call to the Gongfeng OAuth endpoints. A refresh runs
// while the caller holds the user's refresh lock, so it must never hang.
const httpClient = { timeout: 15 * 1000 };

// Config describes the OAuth application registered on the deployment's host.
class Config {
  constructor(init = {}) {
    this.ClientID = init.ClientID ?? "";
    this.ClientSecret = init.ClientSecret ?? "";
    this.RedirectURI = init.RedirectURI ?? "";
    this.AuthorizeURL = init.AuthorizeURL ?? "";
    this.TokenURL = init.TokenURL ?? "";
    this.APIBase = init.APIBase ?? "";
  }

  // Enabled reports whether the process has enough configuration to start a grant.
  Enabled() {
    return this.RefreshEnabled() && this.AuthorizeURL !== "" && this.APIBase !== "";
  }

  RefreshEnabled() {
    return this.clientConfigured() && this.TokenURL !== "";
  }

  clientConfigured() {
    return this.ClientID.trim() !== "" && this.ClientSecret.trim() !== "" && this.RedirectURI.trim() !== "";
  }
}

// ConfigFromEnv derives endpoints from the configured host. Explicit OAuth
// endpoint overrides still take precedence.
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

function envBool(key) {
  const on = (process.env[key] ?? "").trim().toLowerCase();
  return on === "1" || on === "t" || on === "true";
}

function envOr(key, fallback) {
  const value = (process.env[key] ?? "").trim();
  if (value !== "") {
    return value;
  }
  return fallback;
}

// Token is an OAuth access grant. RefreshToken may be empty when the
// application does not issue one; ExpiresIn is seconds.
class Token {
  constructor(init = {}) {
    this.AccessToken = init.AccessToken ?? "";
    this.RefreshToken = init.RefreshToken ?? "";
    this.ExpiresIn = init.ExpiresIn ?? 0;
  }

  // Expiry is when the access token should be refreshed. A missing lifetime
  // uses the two-hour default from the Gongfeng OAuth documentation.
  Expiry(now) {
    let ttl = this.ExpiresIn * 1000;
    if (ttl <= 0) {
      ttl = defaultTTL;
    }
    return new Date(now.getTime() + ttl);
  }
}

// AuthorizeURL is the browser location that asks the user to approve the app.
function AuthorizeURL(cfg, state) {
  if (!cfg.clientConfigured() || cfg.AuthorizeURL === "") {
    throw new Error("工蜂 OAuth 未配置");
  }
  const u = new URL(cfg.AuthorizeURL);
  // Go 的 url.Values.Encode 按键名排序，这里按同样顺序设参。
  u.searchParams.set("client_id", cfg.ClientID);
  u.searchParams.set("redirect_uri", cfg.RedirectURI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", RepositoryScope);
  u.searchParams.set("state", state);
  return u.toString();
}

// Exchange trades an authorization code for an access token.
async function Exchange(ctx, cfg, code) {
  const form = new URLSearchParams();
  form.set("client_id", cfg.ClientID);
  form.set("client_secret", cfg.ClientSecret);
  form.set("code", code.trim());
  form.set("grant_type", "authorization_code");
  form.set("redirect_uri", cfg.RedirectURI);
  return requestToken(ctx, cfg, form);
}

// Refresh exchanges a refresh token for a new access token.
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

// Username returns the Gongfeng login bound to an access token.
async function Username(ctx, cfg, accessToken) {
  const req = {
    method: "GET",
    url: cfg.APIBase + "/user",
    headers: new Headers({ Authorization: "Bearer " + accessToken.trim() }),
    body: null,
    ctx,
  };
  const { status, body } = await doReq(req);
  if (status !== 200) {
    throw new Error(`工蜂用户信息返回 HTTP ${status}`);
  }
  let user;
  try {
    user = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("工蜂用户信息无法解析");
  }
  if (user == null || (user.username ?? "").trim() === "") {
    throw new Error("工蜂用户信息无法解析");
  }
  return user.username;
}

async function requestToken(ctx, cfg, form) {
  if (!cfg.RefreshEnabled()) {
    throw new Error("工蜂 OAuth 未配置");
  }
  const req = {
    method: "POST",
    url: cfg.TokenURL,
    headers: new Headers({
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    }),
    body: form.toString(),
    ctx,
  };
  const { status, body } = await doReq(req);
  if (status !== 200) {
    throw new Error(`工蜂令牌接口返回 HTTP ${status}：${redact(cfg, truncate(body.toString("utf8"), 180))}`);
  }
  let raw;
  try {
    raw = JSON.parse(body.toString("utf8"));
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
  return new Token({ AccessToken: raw.access_token, RefreshToken: raw.refresh_token, ExpiresIn: raw.expires_in });
}

// do sends req with the bounded client and returns the status code and at
// most maxResponseBytes of the body. Transport failures are reported as a
// connection error so callers only handle status and payload.
async function doReq(req) {
  const signal = req.ctx instanceof AbortSignal ? req.ctx : AbortSignal.timeout(httpClient.timeout);
  let resp;
  try {
    resp = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body ?? undefined, signal });
  } catch (err) {
    throw new Error(`无法连接工蜂：${err}`);
  }
  const body = Buffer.from(await resp.arrayBuffer()).subarray(0, maxResponseBytes);
  return { status: resp.status, body };
}

function redact(cfg, msg) {
  if (cfg.ClientSecret !== "") {
    msg = msg.split(cfg.ClientSecret).join("***");
  }
  return msg;
}

function truncate(s, n) {
  s = s.trim();
  if (s.length <= n) {
    return s;
  }
  return s.slice(0, n);
}

module.exports = {
  RepositoryScope, Config, ConfigFromEnv, Token, AuthorizeURL, Exchange, Refresh, Username,
};
