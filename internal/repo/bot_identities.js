/**
 * @file internal/repo/bot_identities.js
 * 对应 Go 源文件：internal/repo/bot_identities.go
 *
 * 作用与职责边界：
 * 实现企业微信等外部 Bot 发送者与平台账号之间的身份绑定全流程持久化逻辑：
 * 包括生成绑定挑战令牌、查询挑战状态、浏览器侧认领并派生确认码、Bot 侧校验确认码完成绑定、
 * 查询已绑定列表、解绑以及过期挑战记录的有界批量清理。
 * 不负责外部 Bot 消息收发协议与前端页面渲染。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；`db.Transaction` 回调同样失败抛错、成功正常返回。
 * - Go 的 `subtle.ConstantTimeCompare` 在长度不等时返回 `0`，Node.js 的 `timingSafeEqual` 在长度不等时会抛错，因此先核对字节长度再调用 `timingSafeEqual`。
 * - Go 的 `time.Time` 零值译为 `null`，比较时间先后时按 Go 零值毫秒数 `-62135596800000` 折算。
 * - `ConfirmBotUserBinding` 在确认码校验失败时需在事务内正常提交尝试次数递增后再于事务外抛出 `ErrBotBindingCode`，避免事务回滚丢失失败计数。
 */

"use strict";

const { Buffer } = require("node:buffer");
const { randomBytes, timingSafeEqual } = require("node:crypto");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { BotUserBinding, BotBindingChallenge } = require("../domain/bot_identity.js"); // 对应 Go 同包类型，bot_identity.js 已翻译
const { BotMessageID } = require("./bot_interactions.js"); // 对应 Go 同包函数，bot_interactions.js 已翻译
const { hexSHA256 } = require("./hash.js"); // 对应 Go 同包函数，hash.js 已翻译
const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// 绑定挑战链接不存在、已过期或不再可用时抛出的领域错误。
const ErrBotBindingChallenge = new Error("绑定请求已失效，请回到企业微信重新发送消息获取链接");
// Bot 侧回填的确认码无效、过期或已超出尝试次数时抛出的领域错误。
const ErrBotBindingCode = new Error("确认码无效、已过期或不属于当前发送者，请重新确认");

/**
 * 根据 Bot ID 与外部发送者 ID 计算稳定的绑定记录主键。
 * 复用 `BotMessageID` 的双段哈希规则确保同一发送者始终映射到同一条绑定行。
 *
 * @param {string} bot - 外部 Bot 唯一标识。
 * @param {string} sender - 外部平台发送者唯一标识。
 * @returns {string} 绑定记录主键哈希字符串。
 */
function botIdentityID(bot, sender) {
  return BotMessageID(bot, sender);
}

/**
 * 生成指定字节长度的密码学安全随机十六进制字符串。
 * 用于签发绑定挑战的一次性浏览器令牌。
 *
 * @param {number} n - 需要生成的随机字节数。
 * @returns {string} 小写十六进制编码的随机令牌字符串。
 * @throws {Error} 系统随机源读取失败时抛出错误。
 */
function botBindingNonce(n) {
  const b = randomBytes(n);
  return b.toString("hex");
}

/**
 * 查询外部 Bot 发送者当前已生效的平台用户绑定记录（`user_id > 0`）。
 * 用于收到 Bot 消息时解析对应的平台用户身份。
 *
 * @param {string} bot - 外部 Bot 唯一标识。
 * @param {string} sender - 外部平台发送者唯一标识。
 * @returns {BotUserBinding} 已生效的用户绑定对象。
 * @throws {Error} 未绑定（`gorm.ErrRecordNotFound`）或查询失败时抛出错误。
 */
UsersRepo.prototype.BotUserBinding = function (bot, sender) {
  const out = new BotUserBinding();
  const err = this.DB.Where("id = ? AND user_id > 0", botIdentityID(bot, sender)).First(out).Error;
  if (err != null) {
    throw err;
  }
  return out;
};

/**
 * 在事务中对指定绑定记录加排他行锁并读取，用于串行化同一发送者的挑战创建、认领、确认与解绑操作。
 * 即使发送者尚未完成首次绑定，也通过先插入占位绑定行来提供稳定的锁锚点。
 *
 * @param {object} tx - 当前事务的 `gorm.DB` 句柄。
 * @param {string} id - 绑定记录主键 ID。
 * @returns {BotUserBinding} 加锁读出的绑定行对象。
 * @throws {Error} 记录不存在或数据库查询失败时抛出错误。
 */
UsersRepo.prototype.botBindingRow = function (tx, id) {
  const row = new BotUserBinding();
  const err = this.locking(tx).First(row, "id = ?", id).Error;
  if (err != null) {
    throw err;
  }
  return row;
};

/**
 * 为尚未绑定的外部 Bot 发送者创建一条有效期 15 分钟的新绑定挑战，并使该发送者之前未完成的挑战全部失效。
 * 供 Bot 收到未绑定用户消息时生成一次性绑定链接令牌。
 *
 * @param {string} bot - 外部 Bot 唯一标识。
 * @param {string} sender - 外部平台发送者唯一标识。
 * @param {Date} now - 当前 UTC 时间。
 * @returns {string} 新生成的原始挑战令牌（数据库仅保存其 SHA-256 摘要）。
 * @throws {Error} 入参为空、该发送者已绑定或数据库事务失败时抛出错误。
 */
UsersRepo.prototype.NewBotBindingChallenge = function (bot, sender, now) {
  if (bot === "" || sender === "") {
    throw ErrBotBindingChallenge;
  }
  const token = botBindingNonce(32);
  const id = botIdentityID(bot, sender);
  this.DB.Transaction((tx) => {
    const row = new BotUserBinding({ ID: id, BotID: bot, SenderID: sender, CreatedAt: now, UpdatedAt: now });
    const createErr = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
    if (createErr != null) {
      throw createErr;
    }
    const existing = this.botBindingRow(tx, id);
    if (existing.UserID > 0) {
      throw new Error("当前企业微信账号已绑定，请在个人配置解除后重新绑定");
    }
    const expireErr = tx.Model(new BotBindingChallenge()).Where("binding_id = ? AND status IN ?", id, ["pending", "claimed"]).Update("status", "expired").Error;
    if (expireErr != null) {
      throw expireErr;
    }
    const insertErr = tx.Create(new BotBindingChallenge({ ID: hexSHA256(token), BindingID: id, Status: "pending", ExpiresAt: new Date(now.getTime() + 15 * 60 * 1000), CreatedAt: now })).Error;
    if (insertErr != null) {
      throw insertErr;
    }
  });
  return token;
};

/**
 * 查询绑定挑战的当前状态并校验有效期与认领归属。
 * 供用户在浏览器打开绑定链接页面时展示当前进度。
 *
 * @param {string} token - 绑定链接中携带的原始挑战令牌。
 * @param {number} userID - 当前登录平台的用户 ID。
 * @param {Date} now - 当前 UTC 时间。
 * @returns {string} 挑战状态字符串（如 `"pending"`、`"claimed"`、`"confirmed"`）。
 * @throws {Error} 挑战不存在、已过期或已被其他平台账号认领时抛出错误。
 */
UsersRepo.prototype.BotBindingChallengeStatus = function (token, userID, now) {
  const out = new BotBindingChallenge();
  if (this.DB.First(out, "id = ?", hexSHA256(token)).Error != null) {
    throw ErrBotBindingChallenge;
  }
  const expiresMs = out.ExpiresAt == null ? -62135596800000 : out.ExpiresAt.getTime();
  const nowMs = now == null ? -62135596800000 : now.getTime();
  if (!(expiresMs > nowMs) || out.Status === "expired") {
    throw ErrBotBindingChallenge;
  }
  if (out.UserID !== 0 && out.UserID !== userID) {
    throw new Error("链接已由其他平台账号确认，请回企业微信重新获取绑定链接");
  }
  return out.Status;
};

/**
 * 由已登录平台用户在浏览器侧认领绑定挑战，并派生返回需回填到 Bot 的 20 位大写确认码。
 * 确认码由随机令牌与用户 ID 确定性派生，重复打开同一有效链接不会轮换确认码，且库中仅保存确认码哈希。
 *
 * @param {string} token - 绑定链接中的原始挑战令牌。
 * @param {number} userID - 执行认领的平台用户 ID。
 * @param {Date} now - 当前 UTC 时间。
 * @returns {string} 20 位大写十六进制确认码。
 * @throws {Error} 用户 ID 非法、挑战失效、已被绑定、被他人认领或数据库更新失败时抛出错误。
 */
UsersRepo.prototype.ClaimBotBindingChallenge = function (token, userID, now) {
  if (userID <= 0) {
    throw ErrBotBindingChallenge;
  }
  // 从仅浏览器持有的随机令牌与平台账号派生稳定的 80 位确认码，仅落盘其哈希，重复打开不会轮换。
  const code = hexSHA256(token + "\x00" + String(userID)).slice(0, 20);
  this.DB.Transaction((tx) => {
    const challenge = new BotBindingChallenge();
    if (tx.First(challenge, "id = ?", hexSHA256(token)).Error != null) {
      throw ErrBotBindingChallenge;
    }
    const binding = this.botBindingRow(tx, challenge.BindingID);
    const relockErr = this.locking(tx).First(challenge, "id = ?", challenge.ID).Error;
    if (relockErr != null) {
      throw relockErr;
    }
    const expiresMs = challenge.ExpiresAt == null ? -62135596800000 : challenge.ExpiresAt.getTime();
    const nowMs = now == null ? -62135596800000 : now.getTime();
    if (binding.UserID > 0 || !(expiresMs > nowMs) || challenge.Status === "expired" || challenge.Status === "confirmed") {
      throw ErrBotBindingChallenge;
    }
    if (challenge.UserID !== 0 && challenge.UserID !== userID) {
      throw new Error("链接已由其他平台账号确认，请回企业微信重新获取绑定链接");
    }
    if (challenge.Status === "claimed") {
      return;
    }
    const updateErr = tx.Model(challenge).Updates({ user_id: userID, code_hash: hexSHA256(code), status: "claimed", attempts: 0 }).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
  return code.toUpperCase();
};

/**
 * 在 Bot 侧核对发送者提交的确认码并在匹配时完成平台用户绑定。
 * 校验失败时在事务内持久化累加失败次数（满 5 次自动置为过期），事务提交后再抛出 `ErrBotBindingCode`。
 *
 * @param {string} bot - 外部 Bot 唯一标识。
 * @param {string} sender - 外部平台发送者唯一标识。
 * @param {string} code - 发送者在 Bot 对话中输入的确认码。
 * @param {Date} now - 当前 UTC 时间。
 * @returns {BotUserBinding} 绑定完成后的用户绑定记录。
 * @throws {Error} 账号已绑定、无已认领挑战、确认码错误/过期或数据库事务失败时抛出错误。
 */
UsersRepo.prototype.ConfirmBotUserBinding = function (bot, sender, code, now) {
  let binding = new BotUserBinding();
  let denied = false;
  this.DB.Transaction((tx) => {
    try {
      binding = this.botBindingRow(tx, botIdentityID(bot, sender));
    } catch {
      throw ErrBotBindingCode;
    }
    if (binding.UserID > 0) {
      throw new Error("当前账号已经绑定，请在个人配置查看");
    }
    const challenge = new BotBindingChallenge();
    if (tx.Where("binding_id = ? AND status = ?", binding.ID, "claimed").Order("created_at DESC").First(challenge).Error != null) {
      throw ErrBotBindingCode;
    }
    const expiresMs = challenge.ExpiresAt == null ? -62135596800000 : challenge.ExpiresAt.getTime();
    const nowMs = now == null ? -62135596800000 : now.getTime();
    if (!(expiresMs > nowMs) || challenge.Attempts >= 5) {
      throw ErrBotBindingCode;
    }
    // Go 的 ConstantTimeCompare 长度不等返回 0，JS 的 timingSafeEqual 会抛错，先核对字节长度保持一致。
    const expectedHash = Buffer.from(challenge.CodeHash, "utf8");
    const actualHash = Buffer.from(hexSHA256(code.toLowerCase().trim()), "utf8");
    if (expectedHash.length !== actualHash.length || !timingSafeEqual(expectedHash, actualHash)) {
      denied = true;
      const updates = { attempts: challenge.Attempts + 1 };
      if (challenge.Attempts + 1 >= 5) {
        updates.status = "expired";
      }
      const attemptErr = tx.Model(challenge).Updates(updates).Error;
      if (attemptErr != null) {
        throw attemptErr;
      }
      return;
    }
    const updateErr = tx.Model(binding).Updates({ user_id: challenge.UserID, updated_at: now }).Error;
    if (updateErr != null) {
      throw updateErr;
    }
    binding.UserID = challenge.UserID;
    binding.UpdatedAt = now;
    const confirmErr = tx.Model(new BotBindingChallenge()).Where("binding_id = ? AND status IN ?", binding.ID, ["pending", "claimed"]).Updates({ status: "confirmed", code_hash: "" }).Error;
    if (confirmErr != null) {
      throw confirmErr;
    }
  });
  if (denied) {
    throw ErrBotBindingCode;
  }
  return binding;
};

/**
 * 查询指定平台用户当前已绑定的全部外部 Bot 账号列表，按更新时间倒序排列。
 * 用于个人配置页面展示已绑定的外部 Bot 身份。
 *
 * @param {number} userID - 平台用户 ID。
 * @returns {BotUserBinding[]} 已绑定的 Bot 身份记录列表。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
UsersRepo.prototype.BotUserBindings = function (userID) {
  const out = [];
  const err = this.DB.Where("user_id = ?", userID).Order("updated_at DESC").Find(out).Error;
  if (err != null) {
    throw err;
  }
  return out;
};

/**
 * 解除指定用户的外部 Bot 账号绑定，并将该绑定行名下的所有挑战记录置为过期并清空确认码哈希。
 * 绑定行本身予以保留（将 `user_id` 重置为 `0`），以维持后续重新绑定的行锁锚点。
 *
 * @param {string} id - 待解除的绑定记录主键 ID。
 * @param {number} userID - 执行解绑的平台用户 ID（必须与当前绑定用户一致）。
 * @param {Date} now - 当前 UTC 时间。
 * @returns {void} 无返回值。
 * @throws {Error} 记录不存在、归属不匹配（`gorm.ErrRecordNotFound`）或数据库更新失败时抛出错误。
 */
UsersRepo.prototype.RevokeBotUserBinding = function (id, userID, now) {
  this.DB.Transaction((tx) => {
    const row = this.botBindingRow(tx, id);
    if (row.UserID !== userID || userID <= 0) {
      throw gorm.ErrRecordNotFound;
    }
    const updateErr = tx.Model(row).Updates({ user_id: 0, updated_at: now }).Error;
    if (updateErr != null) {
      throw updateErr;
    }
    const expireErr = tx.Model(new BotBindingChallenge()).Where("binding_id = ?", id).Updates({ status: "expired", code_hash: "" }).Error;
    if (expireErr != null) {
      throw expireErr;
    }
  });
};

/**
 * 批量清理过期时间超过 24 小时的历史绑定挑战记录（每次最多删除 1000 条）。
 * 绑定行永久保留不受本清理影响；由于过期时间不可变，多实例并发清理具备幂等性且不会误删活跃挑战。
 *
 * @param {AbortSignal} ctx - 控制查询取消的上下文信号。
 * @param {Date} now - 当前 UTC 时间，用于计算 24 小时前的清理截止点。
 * @returns {number} 本批次实际删除的过期挑战行数。
 * @throws {Error} 查询过期 ID 或执行删除失败时抛出错误。
 */
UsersRepo.prototype.DeleteExpiredBotBindingChallenges = function (ctx, now) {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const db = this.DB.WithContext(ctx);
  const ids = [];
  const pluckErr = db.Model(new BotBindingChallenge()).Where("expires_at <= ?", cutoff).Order("expires_at ASC").Limit(1000).Pluck("id", ids).Error;
  if (pluckErr != null) {
    throw pluckErr;
  }
  if (ids.length === 0) {
    return 0;
  }
  const result = db.Where("id IN ? AND expires_at <= ?", ids, cutoff).Delete(new BotBindingChallenge());
  if (result.Error != null) {
    throw result.Error;
  }
  return result.RowsAffected;
};

module.exports = { ErrBotBindingChallenge, ErrBotBindingCode };
