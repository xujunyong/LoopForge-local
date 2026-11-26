// gongfeng_credential.js —— 对应 Go 文件：internal/repo/gongfeng_credential.go
// 作用：内部适配器 OAuth 令牌的刷新与托管 Git 凭据格式化。

"use strict";

const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译
const { ConfigFromEnv, Refresh } = require("../gongfeng/oauth.js"); // 对应 Go 的 gongfeng.ConfigFromEnv/Refresh，gongfeng 已翻译

// gongfengRefreshLead：提前刷新的时间，Go 的 time.Duration 是纳秒，JS 用毫秒。
const gongfengRefreshLead = 10 * 60 * 1000;

// gongfengRefreshTimeout：单次刷新的上限，Go 用 var 以便测试改短，JS 同样用 let。
let gongfengRefreshTimeout = 20 * 1000;

// gongfengRefreshGate：Go 的 sync.Mutex 省略，JS 单线程无需加锁。
class gongfengRefreshGate {
  constructor() {
    this.failUntil = null;
  }
}

const gongfengRefreshGates = new Map();

// managedGitCredential：刷新内部适配器 OAuth 授权；纯个人令牌只从主机凭据表读。
UsersRepo.prototype.managedGitCredential = async function (ctx, id) {
  let [user, ok] = this.User(id);
  if (!ok) {
    return "";
  }
  if (!gongfengTokenDue(user, new Date())) {
    return formatManagedGitCredential(user);
  }
  const gate = gongfengRefreshGateFor(id);
  if (gate.failUntil != null && Date.now() < gate.failUntil.getTime()) {
    [user] = this.User(id);
    return formatManagedGitCredential(user);
  }
  [user, ok] = this.User(id);
  if (!ok || !gongfengTokenDue(user, new Date())) {
    if (!ok) {
      return "";
    }
    return formatManagedGitCredential(user);
  }
  const cfg = ConfigFromEnv();
  if (!cfg.RefreshEnabled()) {
    return formatManagedGitCredential(user);
  }
  // Go 的 context.WithTimeout 无 JS 对应物，刷新直接用原 ctx。
  let tok;
  try {
    tok = await Refresh(ctx, cfg, user.GongfengRefreshToken);
  } catch (err) {
    gate.failUntil = new Date(Date.now() + 60 * 1000);
    console.log(`gongfeng oauth refresh for user ${id} failed: ${err}`);
    return formatManagedGitCredential(user);
  }
  const [updated, saveErr] = this.SaveGongfengOAuth(id, tok.AccessToken, tok.RefreshToken, tok.Expiry(new Date()));
  if (saveErr != null) {
    console.log(`gongfeng oauth refresh for user ${id} could not be saved: ${saveErr}`);
    return "oauth2:" + tok.AccessToken.trim();
  }
  return formatManagedGitCredential(updated);
};

function formatManagedGitCredential(user) {
  const tok = user.GitToken.trim();
  if (tok === "") {
    return "";
  }
  if (user.GongfengRefreshToken.trim() !== "" && !tok.toLowerCase().startsWith("oauth2:")) {
    return "oauth2:" + tok;
  }
  if (tok.toLowerCase().startsWith("oauth2:") || tok.toLowerCase().startsWith("private:")) {
    return tok;
  }
  return "";
}

function gongfengTokenDue(user, now) {
  if (user.GongfengRefreshToken.trim() === "") {
    return false;
  }
  // Go 的 time.Time 零值译为 null。
  if (user.GongfengTokenExpiresAt == null) {
    return true;
  }
  return !(user.GongfengTokenExpiresAt.getTime() > now.getTime() + gongfengRefreshLead);
}

function gongfengRefreshGateFor(id) {
  // Go 的 sync.Map.LoadOrStore：取不到就存一个新建的。
  let gate = gongfengRefreshGates.get(id);
  if (gate == null) {
    gate = new gongfengRefreshGate();
    gongfengRefreshGates.set(id, gate);
  }
  return gate;
}

module.exports = { gongfengRefreshLead, gongfengRefreshTimeout, gongfengRefreshGate, gongfengRefreshGates, formatManagedGitCredential, gongfengTokenDue, gongfengRefreshGateFor };
