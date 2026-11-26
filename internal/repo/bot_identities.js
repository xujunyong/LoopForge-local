// bot_identities.js —— 对应 Go 文件：internal/repo/bot_identities.go
// 作用：企业微信 Bot 用户绑定的挑战发放、认领、确认与解绑。

"use strict";

const { Buffer } = require("node:buffer");
const { randomBytes, timingSafeEqual } = require("node:crypto");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { BotUserBinding, BotBindingChallenge } = require("../domain/bot_identity.js"); // 对应 Go 同包类型，bot_identity.js 已翻译
const { BotMessageID } = require("./bot_interactions.js"); // 对应 Go 同包函数，bot_interactions.js 待翻译
const { hexSHA256 } = require("./hash.js"); // 对应 Go 同包函数，hash.js 待翻译
const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

const ErrBotBindingChallenge = new Error("绑定请求已失效，请回到企业微信重新发送消息获取链接");
const ErrBotBindingCode = new Error("确认码无效、已过期或不属于当前发送者，请重新确认");

function botIdentityID(bot, sender) { return BotMessageID(bot, sender); }

function botBindingNonce(n) {
  const b = randomBytes(n);
  return [b.toString("hex"), null];
}

UsersRepo.prototype.BotUserBinding = function (bot, sender) {
  const out = new BotUserBinding();
  const err = this.DB.Where("id = ? AND user_id > 0", botIdentityID(bot, sender)).First(out).Error;
  return [out, err];
};

// Serialize all challenge creation/claim/confirmation/revocation on the same
// stable binding row, including while the user has not yet completed binding.
UsersRepo.prototype.botBindingRow = function (tx, id) {
  const row = new BotUserBinding();
  const err = this.locking(tx).First(row, "id = ?", id).Error;
  return [row, err];
};

UsersRepo.prototype.NewBotBindingChallenge = function (bot, sender, now) {
  if (bot === "" || sender === "") {
    return ["", ErrBotBindingChallenge];
  }
  const [token, nonceErr] = botBindingNonce(32);
  if (nonceErr != null) {
    return ["", nonceErr];
  }
  const id = botIdentityID(bot, sender);
  const err = this.DB.Transaction((tx) => {
    const row = new BotUserBinding({ ID: id, BotID: bot, SenderID: sender, CreatedAt: now, UpdatedAt: now });
    const createErr = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
    if (createErr != null) {
      return createErr;
    }
    const [existing, existingErr] = this.botBindingRow(tx, id);
    if (existingErr != null) {
      return existingErr;
    }
    if (existing.UserID > 0) {
      return new Error("当前企业微信账号已绑定，请在个人配置解除后重新绑定");
    }
    const expireErr = tx.Model(new BotBindingChallenge()).Where("binding_id = ? AND status IN ?", id, ["pending", "claimed"]).Update("status", "expired").Error;
    if (expireErr != null) {
      return expireErr;
    }
    return tx.Create(new BotBindingChallenge({ ID: hexSHA256(token), BindingID: id, Status: "pending", ExpiresAt: new Date(now.getTime() + 15 * 60 * 1000), CreatedAt: now })).Error;
  });
  return [token, err];
};

UsersRepo.prototype.BotBindingChallengeStatus = function (token, userID, now) {
  const out = new BotBindingChallenge();
  if (this.DB.First(out, "id = ?", hexSHA256(token)).Error != null) {
    return ["", ErrBotBindingChallenge];
  }
  const expiresMs = out.ExpiresAt == null ? 0 : out.ExpiresAt.getTime();
  const nowMs = now == null ? 0 : now.getTime();
  if (!(expiresMs > nowMs) || out.Status === "expired") {
    return ["", ErrBotBindingChallenge];
  }
  if (out.UserID !== 0 && out.UserID !== userID) {
    return ["", new Error("链接已由其他平台账号确认，请回企业微信重新获取绑定链接")];
  }
  return [out.Status, null];
};

UsersRepo.prototype.ClaimBotBindingChallenge = function (token, userID, now) {
  if (userID <= 0) {
    return ["", ErrBotBindingChallenge];
  }
  // Derive a stable 80-bit code from the browser-only random nonce and account.
  // Only its hash is stored; reopening a request does not rotate the code.
  const code = hexSHA256(token + "\x00" + String(userID)).slice(0, 20);
  const err = this.DB.Transaction((tx) => {
    const challenge = new BotBindingChallenge();
    if (tx.First(challenge, "id = ?", hexSHA256(token)).Error != null) {
      return ErrBotBindingChallenge;
    }
    const [binding, bindingErr] = this.botBindingRow(tx, challenge.BindingID);
    if (bindingErr != null) {
      return bindingErr;
    }
    const relockErr = this.locking(tx).First(challenge, "id = ?", challenge.ID).Error;
    if (relockErr != null) {
      return relockErr;
    }
    const expiresMs = challenge.ExpiresAt == null ? 0 : challenge.ExpiresAt.getTime();
    const nowMs = now == null ? 0 : now.getTime();
    if (binding.UserID > 0 || !(expiresMs > nowMs) || challenge.Status === "expired" || challenge.Status === "confirmed") {
      return ErrBotBindingChallenge;
    }
    if (challenge.UserID !== 0 && challenge.UserID !== userID) {
      return new Error("链接已由其他平台账号确认，请回企业微信重新获取绑定链接");
    }
    if (challenge.Status === "claimed") {
      return null;
    }
    return tx.Model(challenge).Updates({ user_id: userID, code_hash: hexSHA256(code), status: "claimed", attempts: 0 }).Error;
  });
  return [code.toUpperCase(), err];
};

UsersRepo.prototype.ConfirmBotUserBinding = function (bot, sender, code, now) {
  let binding = new BotUserBinding();
  let denied = false;
  const err = this.DB.Transaction((tx) => {
    const [row, rowErr] = this.botBindingRow(tx, botIdentityID(bot, sender));
    if (rowErr != null) {
      return ErrBotBindingCode;
    }
    binding = row;
    if (binding.UserID > 0) {
      return new Error("当前账号已经绑定，请在个人配置查看");
    }
    const challenge = new BotBindingChallenge();
    if (tx.Where("binding_id = ? AND status = ?", binding.ID, "claimed").Order("created_at DESC").First(challenge).Error != null) {
      return ErrBotBindingCode;
    }
    const expiresMs = challenge.ExpiresAt == null ? 0 : challenge.ExpiresAt.getTime();
    const nowMs = now == null ? 0 : now.getTime();
    if (!(expiresMs > nowMs) || challenge.Attempts >= 5) {
      return ErrBotBindingCode;
    }
    // Go 的 ConstantTimeCompare 长度不等返回 0，JS 的 timingSafeEqual 会抛错；此处两侧均为 64 位十六进制摘要，长度相同。
    if (!timingSafeEqual(Buffer.from(challenge.CodeHash, "utf8"), Buffer.from(hexSHA256(code.toLowerCase().trim()), "utf8"))) {
      denied = true;
      const updates = { attempts: challenge.Attempts + 1 };
      if (challenge.Attempts + 1 >= 5) {
        updates.status = "expired";
      }
      return tx.Model(challenge).Updates(updates).Error;
    }
    const updateErr = tx.Model(binding).Updates({ user_id: challenge.UserID, updated_at: now }).Error;
    if (updateErr != null) {
      return updateErr;
    }
    binding.UserID = challenge.UserID;
    binding.UpdatedAt = now;
    return tx.Model(new BotBindingChallenge()).Where("binding_id = ? AND status IN ?", binding.ID, ["pending", "claimed"]).Updates({ status: "confirmed", code_hash: "" }).Error;
  });
  if (denied) {
    return [binding, ErrBotBindingCode];
  }
  return [binding, err];
};

UsersRepo.prototype.BotUserBindings = function (userID) {
  const out = [];
  const err = this.DB.Where("user_id = ?", userID).Order("updated_at DESC").Find(out).Error;
  return [out, err];
};

UsersRepo.prototype.RevokeBotUserBinding = function (id, userID, now) {
  return this.DB.Transaction((tx) => {
    const [row, rowErr] = this.botBindingRow(tx, id);
    if (rowErr != null) {
      return rowErr;
    }
    if (row.UserID !== userID || userID <= 0) {
      return gorm.ErrRecordNotFound;
    }
    const updateErr = tx.Model(row).Updates({ user_id: 0, updated_at: now }).Error;
    if (updateErr != null) {
      return updateErr;
    }
    return tx.Model(new BotBindingChallenge()).Where("binding_id = ?", id).Updates({ status: "expired", code_hash: "" }).Error;
  });
};

// DeleteExpiredBotBindingChallenges removes a bounded batch after one day of
// retention. Binding rows are permanent and never removed by this cleanup.
// Expiry is immutable, so concurrent cleanup instances can safely select the
// same IDs: DELETE is idempotent and active requests cannot enter this batch.
UsersRepo.prototype.DeleteExpiredBotBindingChallenges = function (ctx, now) {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const db = this.DB.WithContext(ctx);
  let ids = [];
  const pluckErr = db.Model(new BotBindingChallenge()).Where("expires_at <= ?", cutoff).Order("expires_at ASC").Limit(1000).Pluck("id", ids).Error;
  if (pluckErr != null) {
    return [0, pluckErr];
  }
  if (ids.length === 0) {
    return [0, null];
  }
  const result = db.Where("id IN ? AND expires_at <= ?", ids, cutoff).Delete(new BotBindingChallenge());
  return [result.RowsAffected, result.Error];
};

module.exports = { ErrBotBindingChallenge, ErrBotBindingCode };
