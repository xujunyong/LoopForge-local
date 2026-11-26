// bot_interactions.js —— 对应 Go 文件：internal/repo/bot_interactions.go
// 作用：外部 Bot 的连接租约、消息入队与认领、回复落盘与会话管理。
// gorm 链式调用按原样保留；errors.Is 译为 ===；Go 的 time.Second 换算为毫秒。

"use strict";

const { randomBytes } = require("node:crypto");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { BotConnection, BotConversation, BotInteraction } = require("../domain/bot_interaction.js"); // 对应 Go 的 domain.BotConnection 等，bot_interaction.js 已翻译
const { hexSHA256 } = require("./hash.js"); // 对应 Go 同包函数，hash.js 待翻译
const { timeBefore } = require("./analytics.js"); // 对应 Go 的时间比较，analytics.js 已翻译

// BotInteractionsRepo：对应 Go 的 bot_interactions.go 中的同名类型。
// Go 的 *deps 嵌入提供 DB 与 locking，JS 里随 repo.js 补齐。
class BotInteractionsRepo {
  constructor(init = {}) {
    this.DB = init.DB ?? null;
  }
}

function BotConversationID(botID, kind, chatID) {
  return hexSHA256(botID + "\0" + kind + "\0" + chatID);
}

function BotMessageID(botID, msgID) {
  return hexSHA256(botID + "\0" + msgID);
}

function newBotSessionID() {
  let raw;
  try {
    raw = randomBytes(16);
  } catch (err) {
    throw err;
  }
  return "bot-" + raw.toString("hex");
}

BotInteractionsRepo.prototype.ClaimBotConnection = function (botID, owner, now) {
  const row = new BotConnection({ BotID: botID, State: "connecting", LeaseUntil: new Date(now.getTime() - 1000) });
  const err = this.DB.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
  if (err != null) {
    return [false, err];
  }
  const result = this.DB.Model(row).Where("bot_id = ? AND (owner = ? OR lease_until < ?)", botID, owner, now).Updates({ owner: owner, lease_until: new Date(now.getTime() + 45 * 1000), updated_at: now });
  return [result.RowsAffected === 1, result.Error];
};

BotInteractionsRepo.prototype.RenewBotConnection = function (botID, owner, state, detail, now) {
  const updates = { lease_until: new Date(now.getTime() + 45 * 1000), updated_at: now };
  if (state !== "") {
    updates.state = state;
    updates.last_error = detail;
  }
  const result = this.DB.Model(new BotConnection()).Where("bot_id = ? AND owner = ? AND lease_until > ?", botID, owner, now).Updates(updates);
  return [result.RowsAffected === 1, result.Error];
};

BotInteractionsRepo.prototype.ReleaseBotConnection = function (botID, owner) {
  return this.DB.Model(new BotConnection()).Where("bot_id = ? AND owner = ?", botID, owner).Updates({ owner: "", lease_until: new Date(Date.now() - 1000), state: "offline" }).Error;
};

BotInteractionsRepo.prototype.BotConnectionState = function (botID) {
  const out = new BotConnection();
  const err = this.DB.First(out, "bot_id = ?", botID).Error;
  if (timeBefore(out.LeaseUntil, new Date())) {
    out.State = "offline";
  }
  return [out, err];
};

BotInteractionsRepo.prototype.EnqueueBotInteraction = function (item, kind, chat) {
  let inserted = false;
  const err = this.DB.Transaction((tx) => {
    const conversation = new BotConversation({ ID: BotConversationID(item.BotID, kind, chat), BotID: item.BotID, ChatID: chat, ChatType: kind, SessionID: newBotSessionID(), UpdatedAt: new Date() });
    const convErr = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(conversation).Error;
    if (convErr != null) {
      return convErr;
    }
    item.ConversationID = conversation.ID;
    item.Status = "queued";
    item.CreatedAt = new Date();
    item.UpdatedAt = item.CreatedAt;
    const result = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(item);
    inserted = result.RowsAffected === 1;
    if (result.Error != null) {
      return result.Error;
    }
    if (inserted) {
      return tx.Model(conversation).Update("updated_at", item.CreatedAt).Error;
    }
    return null;
  });
  return [inserted, err];
};

BotInteractionsRepo.prototype.ClaimBotInteraction = function (botID, leaseBotID, owner) {
  const item = new BotInteraction();
  const err = this.DB.Transaction((tx) => {
    const lease = new BotConnection();
    const leaseErr = this.locking(tx).Where("bot_id = ? AND owner = ? AND lease_until > ?", leaseBotID, owner, new Date()).First(lease).Error;
    if (leaseErr != null) {
      return leaseErr;
    }
    const itemErr = this.locking(tx).Where("bot_id = ? AND status IN ?", botID, ["queued", "ready"]).Order("created_at, id").First(item).Error;
    if (itemErr != null) {
      return itemErr;
    }
    if (item.Status === "ready") {
      return null;
    }
    const conv = new BotConversation();
    const convErr = tx.First(conv, "id = ?", item.ConversationID).Error;
    if (convErr != null) {
      return convErr;
    }
    item.SessionID = conv.SessionID;
    item.Status = "running";
    return tx.Model(item).Updates({ session_id: item.SessionID, status: "running", updated_at: new Date() }).Error;
  });
  if (err === gorm.ErrRecordNotFound) {
    return [null, null];
  }
  if (err != null) {
    return [null, err];
  }
  return [item, null];
};

// A model turn interrupted by process loss must never be replayed automatically:
// its platform tools may already have committed. Its reply can still be retried.
BotInteractionsRepo.prototype.RecoverBotInteractions = function (botID) {
  return this.DB.Model(new BotInteraction()).Where("bot_id = ? AND status = ?", botID, "running").Updates({ status: "ready", reply: "上一轮处理已中断，执行结果可能已保存。请先查询状态，再决定是否继续操作。", last_error: "执行中断", updated_at: new Date() }).Error;
};

BotInteractionsRepo.prototype.SaveBotReply = function (item, reply, detail) {
  return this.DB.Model(new BotInteraction()).Where("id = ? AND status = ?", item.ID, "running").Updates({ status: "ready", reply: reply, last_error: detail, updated_at: new Date() }).Error;
};

BotInteractionsRepo.prototype.MarkBotReplySent = function (id) {
  return this.DB.Model(new BotInteraction()).Where("id = ? AND status = ?", id, "ready").Updates({ status: "replied", updated_at: new Date() }).Error;
};

BotInteractionsRepo.prototype.NewBotConversation = function (item) {
  return this.DB.Transaction((tx) => {
    const session = newBotSessionID();
    const convErr = tx.Model(new BotConversation()).Where("id = ?", item.ConversationID).Updates({ session_id: session, updated_at: new Date() }).Error;
    if (convErr != null) {
      return convErr;
    }
    return tx.Model(new BotInteraction()).Where("id = ?", item.ID).Updates({ session_id: session, action: "new" }).Error;
  });
};

BotInteractionsRepo.prototype.BotConversation = function (id) {
  const out = new BotConversation();
  const err = this.DB.First(out, "id = ?", id).Error;
  return [out, err];
};

BotInteractionsRepo.prototype.BotHistory = function (sessionID) {
  const rows = [];
  const err = this.DB.Where("session_id = ? AND status = ? AND action = ?", sessionID, "replied", "").Order("created_at desc, id desc").Limit(20).Find(rows).Error;
  for (let i = 0, j = rows.length - 1; i < j; i++, j--) {
    const tmp = rows[i];
    rows[i] = rows[j];
    rows[j] = tmp;
  }
  return [rows, err];
};

BotInteractionsRepo.prototype.BotInteractionRecords = function (botID) {
  const rows = [];
  const err = this.DB.Where("bot_id = ?", botID).Order("created_at desc, id desc").Limit(50).Find(rows).Error;
  return [rows, err];
};

BotInteractionsRepo.prototype.BotConversations = function (botID) {
  const rows = [];
  const err = this.DB.Where("bot_id = ?", botID).Order("updated_at desc").Limit(50).Find(rows).Error;
  return [rows, err];
};

BotInteractionsRepo.prototype.BotInteraction = function (id) {
  const item = new BotInteraction();
  const err = this.DB.First(item, "id = ?", id).Error;
  return [item, err];
};

BotInteractionsRepo.prototype.ExpireBotCard = function (id) {
  return this.DB.Model(new BotInteraction()).Where("id = ? AND action = ? AND status <> ?", id, "notification", "replied").Updates({ status: "replied", last_error: "该节点已不再等待本次操作", updated_at: new Date() }).Error;
};

BotInteractionsRepo.prototype.FailBotReply = function (id, detail) {
  return this.DB.Model(new BotInteraction()).Where("id = ? AND status = ?", id, "ready").Updates({ status: "reply_failed", last_error: detail, updated_at: new Date() }).Error;
};

BotInteractionsRepo.prototype.RequeueBotCard = function (id) {
  return this.DB.Model(new BotInteraction()).Where("id = ? AND action = ? AND status = ?", id, "notification", "reply_failed").Updates({ status: "ready", last_error: "", updated_at: new Date() }).Error;
};

// Serializes registering the same external Bot across project configs. The
// receiver later claims this same connection row, avoiding duplicate sockets.
BotInteractionsRepo.prototype.lockBotDefinition = function (tx, botID) {
  const row = new BotConnection({ BotID: botID, LeaseUntil: new Date(Date.now() - 1000), State: "offline" });
  const err = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
  if (err != null) {
    return err;
  }
  return this.locking(tx).Where("bot_id = ?", botID).First(row).Error;
};

// Store the exact opaque task ID before wire send so callbacks cannot route by
// a guessed delivery prefix or a stale card from an earlier send attempt.
BotInteractionsRepo.prototype.SetBotCardTaskID = function (id, taskID) {
  const result = this.DB.Model(new BotInteraction()).Where("id = ? AND action = ? AND status = ?", id, "notification", "ready").Update("card_task_id", taskID);
  if (result.Error != null) {
    return result.Error;
  }
  if (result.RowsAffected !== 1) {
    return gorm.ErrRecordNotFound;
  }
  return null;
};

module.exports = { BotInteractionsRepo, BotConversationID, BotMessageID, newBotSessionID };
