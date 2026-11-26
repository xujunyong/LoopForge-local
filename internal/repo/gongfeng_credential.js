/**
 * @file internal/repo/gongfeng_credential.js
 * @description 对应 Go 文件：internal/repo/gongfeng_credential.go
 * 职责与边界：负责内部适配器（工蜂）OAuth 访问令牌的过期判断、按用户节流刷新与持久化保存，
 * 以及将 `user_configs` 中的托管令牌格式化为 `oauth2:` 或 `private:` 前缀凭据；不处理个人主机凭据表读写。
 * 语法差异说明：
 * - Go 的 `time.Duration` 统一译为毫秒数，`time.Time` 零值译为 `null`。
 * - Go 的 `sync.Mutex` 在单线程 JS 中省略；`sync.Map` 译为 `Map`。
 * - 因 `internal/gongfeng/oauth.js` 中的 `Refresh` 使用异步 `fetch`，`managedGitCredential` 保留 `async` 标记，
 *   并通过 `AbortSignal.timeout(gongfengRefreshTimeout)` 对应 Go 的 `context.WithTimeout`。
 */

"use strict";

const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型
const { ConfigFromEnv, Refresh } = require("../gongfeng/oauth.js"); // 对应 Go 的 gongfeng.ConfigFromEnv/Refresh，gongfeng 已翻译

/** 在访问令牌正式过期前提前触发刷新的时间窗口（10 分钟，毫秒）。 */
const gongfengRefreshLead = 10 * 60 * 1000;

/** 单次工蜂 OAuth 刷新请求的超时上限（20 秒，毫秒）；用 `let` 声明以便测试缩短。 */
let gongfengRefreshTimeout = 20 * 1000;

/**
 * 单个用户的工蜂 OAuth 刷新退避状态，用于记录刷新失败后的冷却截止时间。
 * Go 原结构体中的 `sync.Mutex` 在单线程 JS 中略去。
 */
class gongfengRefreshGate {
  /**
   * 构造刷新冷却门控实例，初始无冷却截止时间。
   * 使用场景：由 `gongfengRefreshGateFor` 按用户 ID 惰性创建。
   *
   * @returns {void} 无返回值。
   */
  constructor() {
    this.failUntil = null;
  }
}

/** 按用户 ID 缓存刷新门控实例的映射（对应 Go 的 `sync.Map`）。 */
const gongfengRefreshGates = new Map();

/**
 * 获取并在即将过期时自动刷新用户的内部适配器（工蜂）OAuth 托管凭据。
 * 若刷新失败则设置 1 分钟退避窗口并回退返回当前凭据；若保存新令牌失败则直接返回本次刷新得到的 `oauth2:` 令牌。
 * 纯个人粘贴令牌只从主机凭据表读取，不经过此方法。
 * 使用场景：执行派发、按主机拉取凭据或校验托管凭据前由 `refreshedManagedGitHTTPCredential` 调用。
 *
 * @param {AbortSignal | null} ctx - 可选外部取消信号，与 `gongfengRefreshTimeout` 合并控制刷新超时。
 * @param {number} id - 用户主键 ID。
 * @returns {Promise<string>} 格式化后的托管凭据字符串（`oauth2:<token>` 或 `private:<token>`）；无可用托管凭据时返回空字符串 `""`。
 */
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
  // 对应 Go 的 context.WithTimeout(ctx, gongfengRefreshTimeout)，避免调用方未设超时导致长期阻塞。
  const timeoutSignal = AbortSignal.timeout(gongfengRefreshTimeout);
  const refreshCtx = ctx instanceof AbortSignal ? AbortSignal.any([ctx, timeoutSignal]) : timeoutSignal;
  let tok;
  try {
    tok = await Refresh(refreshCtx, cfg, user.GongfengRefreshToken);
  } catch (err) {
    gate.failUntil = new Date(Date.now() + 60 * 1000);
    console.log(`gongfeng oauth refresh for user ${id} failed: ${err}`);
    return formatManagedGitCredential(user);
  }
  let updated;
  try {
    updated = this.SaveGongfengOAuth(id, tok.AccessToken, tok.RefreshToken, tok.Expiry(new Date()));
  } catch (saveErr) {
    console.log(`gongfeng oauth refresh for user ${id} could not be saved: ${saveErr}`);
    return "oauth2:" + tok.AccessToken.trim();
  }
  return formatManagedGitCredential(updated);
};

/**
 * 将用户记录中的 `GitToken` 格式化为带认证前缀的托管凭据字符串（`oauth2:` 或 `private:`）。
 * 若仅存普通无前缀令牌且无刷新令牌，则返回空字符串（视为非托管凭据）。
 * 使用场景：在展示只读托管凭据或刷新完成后统一格式化返回凭据时调用。
 *
 * @param {import("../domain/user.js").User} user - 用户领域对象。
 * @returns {string} 带 `oauth2:` 或 `private:` 前缀的凭据字符串；不符合托管凭据条件时返回 `""`。
 */
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

/**
 * 判断用户的工蜂 OAuth 访问令牌是否已到期或进入提前刷新窗口（距过期不足 10 分钟）。
 * 使用场景：由 `managedGitCredential` 在决定是否发起 OAuth 续期请求前调用。
 *
 * @param {import("../domain/user.js").User} user - 用户领域对象。
 * @param {Date} now - 当前基准时间。
 * @returns {boolean} 需要立即刷新令牌时返回 `true`，否则返回 `false`。
 */
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

/**
 * 获取或创建指定用户对应的工蜂 OAuth 刷新门控对象。
 * 使用场景：由 `managedGitCredential` 读写该用户的失败退避时间。
 *
 * @param {number} id - 用户主键 ID。
 * @returns {gongfengRefreshGate} 该用户专属的刷新门控实例。
 */
function gongfengRefreshGateFor(id) {
  // Go 的 sync.Map.LoadOrStore：取不到就存一个新建的。
  let gate = gongfengRefreshGates.get(id);
  if (gate == null) {
    gate = new gongfengRefreshGate();
    gongfengRefreshGates.set(id, gate);
  }
  return gate;
}

module.exports = {
  gongfengRefreshLead,
  gongfengRefreshTimeout,
  gongfengRefreshGate,
  gongfengRefreshGates,
  formatManagedGitCredential,
  gongfengTokenDue,
  gongfengRefreshGateFor,
};
