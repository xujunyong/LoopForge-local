// tokens.js —— 对应 Go 文件：internal/repo/tokens.go
// 作用：用户 API token 的创建、校验与吊销。
// Go 的 time.Minute 换算为毫秒。

"use strict";

const { APIToken } = require("../domain/user.js"); // 对应 Go 的 domain.APIToken，user.js 已翻译
const { apiTokenRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { isZeroTime } = require("./analytics.js"); // 对应 Go 同包函数，analytics.js 已翻译

// 返回用户全部 token，含已吊销的，供用户审计旧凭证；无 token 时也返回 [] 而非 null。
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

TokensRepo.prototype.PutAPIToken = function (token) {
  if (token.ID.trim() === "" || token.UserID <= 0 || token.TokenHash.trim() === "") {
    return new Error("api token id, userId, and tokenHash are required");
  }
  if (isZeroTime(token.CreatedAt)) {
    token.CreatedAt = new Date();
  }
  return this.DB.Create(new apiTokenRow({
    ID: token.ID, UserID: token.UserID, Name: token.Name, Prefix: token.Prefix,
    TokenHash: token.TokenHash, LastUsedAt: token.LastUsedAt, ExpiresAt: token.ExpiresAt,
    Created: token.CreatedAt, RevokedAt: token.RevokedAt,
  })).Error;
};

// 校验 token 哈希；last_used_at 最多每 5 分钟更新一次，避免每次 API 调用都写库。
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
      token.LastUsedAt = now;
    }
  }
  return [token, true];
};

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

apiTokenRow.prototype.toDomain = function () {
  const token = new APIToken({ ID: this.ID, UserID: this.UserID, Name: this.Name, Prefix: this.Prefix, TokenHash: this.TokenHash, CreatedAt: this.Created });
  if (this.LastUsedAt != null) {
    token.LastUsedAt = this.LastUsedAt;
  }
  if (this.ExpiresAt != null) {
    token.ExpiresAt = this.ExpiresAt;
  }
  if (this.RevokedAt != null) {
    token.RevokedAt = this.RevokedAt;
  }
  return token;
};
