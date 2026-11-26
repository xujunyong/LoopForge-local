/**
 * @file internal/repo/tokens.js
 * 对应 Go 源文件：internal/repo/tokens.go
 *
 * 作用与职责边界：
 * 实现用户个人 API 令牌（`api_tokens`）的列表审计查询、创建写入、按哈希校验（带 5 分钟节流的最近使用时间更新）
 * 与吊销操作，以及数据库行模型 `apiTokenRow` 到领域模型 `APIToken` 的转换；
 * 方法按领域归属挂载于 `TokensRepo.prototype`（`TokensRepo` 定义于 `repo.js`），不负责明文令牌生成与哈希计算。
 *
 * 语法差异说明：
 * - Go 的仅 `error` 返回统一按成功返回 `undefined`、失败 `throw err` 处理；`(值, bool)` 译为二元组 `[值, boolean]`。
 * - Go 的 `5 * time.Minute` 换算为毫秒数 `5 * 60000`。
 * - Go 中通过 `*r.LastUsedAt` 解引用复制 `time.Time` 指针值，JS 中以 `new Date(ts.getTime())` 保持独立副本。
 */

"use strict";

const { APIToken } = require("../domain/user.js"); // 对应 Go 的 domain.APIToken，user.js 已翻译
const { TokensRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { apiTokenRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { isZeroTime } = require("./analytics.js"); // 对应 Go 同包函数，analytics.js 已翻译

/**
 * 按创建时间倒序返回指定用户拥有的全部 API 令牌（包含已吊销记录，便于用户审计历史凭证）。
 * 当用户尚无令牌或查询失败时始终返回空数组 `[]` 而非 `null`。
 *
 * @param {number} userID - 用户数字 ID；小于等于 0 时直接返回空数组。
 * @returns {APIToken[]} 用户的 API 令牌领域对象数组。
 */
TokensRepo.prototype.APITokens = function (userID) {
  const out = [];
  if (userID <= 0) {
    return out;
  }
  const rows = [];
  if (this.DB.Where("user_id = ?", userID).Order("created_at DESC").Find(rows).Error != null) {
    return out;
  }
  for (const row of rows) {
    out.push(row.toDomain());
  }
  return out;
};

/**
 * 持久化一条新建的用户 API 令牌记录；若未提供 `CreatedAt` 则自动补全当前 UTC 时间。
 * 使用场景：用户在个人设置中生成新的 API 令牌后落库保存其哈希与元数据。
 *
 * @param {APIToken} token - 待创建的 API 令牌领域对象（`ID`、`UserID`、`TokenHash` 为必填项）。
 * @returns {void} 无返回值。
 * @throws {Error} 缺少必填字段或数据库插入失败时抛出错误。
 */
TokensRepo.prototype.PutAPIToken = function (token) {
  if (token.ID.trim() === "" || token.UserID <= 0 || token.TokenHash.trim() === "") {
    throw new Error("api token id, userId, and tokenHash are required");
  }
  if (isZeroTime(token.CreatedAt)) {
    token.CreatedAt = new Date();
  }
  const err = this.DB.Create(new apiTokenRow({
    ID: token.ID, UserID: token.UserID, Name: token.Name, Prefix: token.Prefix,
    TokenHash: token.TokenHash, LastUsedAt: token.LastUsedAt, ExpiresAt: token.ExpiresAt,
    Created: token.CreatedAt, RevokedAt: token.RevokedAt,
  })).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 按令牌哈希查找尚未吊销且未过期的有效 API 令牌，并按最多每 5 分钟一次的频率节流刷新 `last_used_at`，
 * 避免每次 API 请求都触发数据库写操作。
 *
 * @param {string} hash - 经过摘要计算后的 API 令牌哈希字符串。
 * @param {Date} now - 当前请求校验时刻，用于过期判断与更新最近使用时间。
 * @returns {[APIToken, boolean]} 令牌有效时返回 `[token, true]`，否则返回 `[空 APIToken, false]`。
 */
TokensRepo.prototype.ActiveAPITokenByHash = function (hash, now) {
  hash = hash.trim();
  if (hash === "") {
    return [new APIToken(), false];
  }
  const row = new apiTokenRow();
  if (this.DB.Where("token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)", hash, now).Take(row).Error != null) {
    return [new APIToken(), false];
  }
  const token = row.toDomain();
  if (token.LastUsedAt == null || now.getTime() - token.LastUsedAt.getTime() >= 5 * 60000) {
    const updateErr = this.DB.Model(new apiTokenRow()).
      Where("id = ? AND (last_used_at IS NULL OR last_used_at < ?)", token.ID, new Date(now.getTime() - 5 * 60000)).
      Update("last_used_at", now).Error;
    if (updateErr == null) {
      token.LastUsedAt = new Date(now.getTime());
    }
  }
  return [token, true];
};

/**
 * 吊销指定用户名下尚未吊销的一条 API 令牌，写入 `revoked_at` 时间戳。
 * 使用场景：用户在个人设置中手动废止某个 API 令牌。
 *
 * @param {string} id - 待吊销的 API 令牌主键 ID。
 * @param {number} userID - 令牌所属用户数字 ID（用于归属隔离）。
 * @param {Date} now - 记录的吊销时间。
 * @returns {boolean} 成功吊销了 1 条有效记录时返回 `true`，参数无效、记录不存在/已吊销或数据库出错时返回 `false`。
 */
TokensRepo.prototype.RevokeAPIToken = function (id, userID, now) {
  if (id.trim() === "" || userID <= 0) {
    return false;
  }
  const res = this.DB.Model(new apiTokenRow()).
    Where("id = ? AND user_id = ? AND revoked_at IS NULL", id, userID).
    Update("revoked_at", now);
  if (res.Error != null) {
    return false;
  }
  return res.RowsAffected > 0;
};

/**
 * 将 `apiTokenRow` 数据库行对象转换为 `APIToken` 领域模型，并对可选时间字段拷贝独立的 `Date` 实例。
 * 使用场景：从 `api_tokens` 表读取行记录后映射返回给上层业务。
 *
 * @returns {APIToken} 转换后的 API 令牌领域对象。
 */
apiTokenRow.prototype.toDomain = function () {
  const token = new APIToken({ ID: this.ID, UserID: this.UserID, Name: this.Name, Prefix: this.Prefix, TokenHash: this.TokenHash, CreatedAt: this.Created });
  if (this.LastUsedAt != null) {
    token.LastUsedAt = new Date(this.LastUsedAt.getTime());
  }
  if (this.ExpiresAt != null) {
    token.ExpiresAt = new Date(this.ExpiresAt.getTime());
  }
  if (this.RevokedAt != null) {
    token.RevokedAt = new Date(this.RevokedAt.getTime());
  }
  return token;
};
