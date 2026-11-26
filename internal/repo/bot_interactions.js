/**
 * @file internal/repo/bot_interactions.js
 * 对应 Go 源文件：internal/repo/bot_interactions.go
 *
 * 作用与职责边界：
 * 定义 `BotInteractionsRepo` 领域仓储并实现外部 Bot 的连接租约抢占/续期/释放/状态查询、
 * 聊天消息幂等入队与带租约校验的串行认领、进程重启中断恢复、回复保存与发送确认、
 * 对话重置、卡片过期/重试与任务 ID 绑定，以及跨项目注册同一外部 Bot 时的连接行锁。
 * 不负责外部 IM 长连接协议编解码与大模型推理执行。
 *
 * 语法差异说明：
 * - `BotInteractionsRepo` 单嵌入 `*deps`，在 JS 中通过 `extends deps` 继承 `DB`、`locking` 等基础能力。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；`db.Transaction` 回调同样失败抛错、成功正常返回。
 * - Go 的 `errors.Is` 译为 `===`；`time.Second` 等时长换算为毫秒；`panic(err)` 对应直接抛出错误。
 */

"use strict";

const { randomBytes } = require("node:crypto");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { BotConnection, BotConversation, BotInteraction } = require("../domain/bot_interaction.js"); // 对应 Go 的 domain.BotConnection 等，bot_interaction.js 已翻译
const { deps } = require("./repo.js"); // 对应 Go 同包基类，repo.js 待翻译
const { hexSHA256 } = require("./hash.js"); // 对应 Go 同包函数，hash.js 已翻译
const { timeBefore } = require("./analytics.js"); // 对应 Go 的时间比较，analytics.js 已翻译

/**
 * 外部 Bot 交互与连接租约领域仓储，对应 Go 的 `BotInteractionsRepo`（嵌入 `*deps`）。
 * 负责管理 `bot_connections`、`bot_conversations` 与 `bot_interactions` 三张核心表。
 */
class BotInteractionsRepo extends deps {
  /**
   * 构造 `BotInteractionsRepo` 实例，透传共享数据库句柄给父类 `deps`。
   *
   * @param {Object} [init={}] - 可选初始字段映射（通常包含 `DB`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
  }
}

/**
 * 根据 Bot ID、会话类型与外部聊天 ID 确定性计算 Bot 对话记录主键。
 * 用于将同一外部群聊或单聊的消息聚合到同一 `BotConversation` 行。
 *
 * @param {string} botID - 外部 Bot 唯一标识。
 * @param {string} kind - 聊天类型（如单聊、群聊）。
 * @param {string} chatID - 外部平台聊天标识。
 * @returns {string} 64 位小写十六进制 SHA-256 摘要。
 */
function BotConversationID(botID, kind, chatID) {
  return hexSHA256(botID + "\x00" + kind + "\x00" + chatID);
}

/**
 * 根据 Bot ID 与外部消息（或发送者）ID 确定性计算交互消息记录主键。
 * 用于消息入队去重以及用户身份绑定主键推导。
 *
 * @param {string} botID - 外部 Bot 唯一标识。
 * @param {string} msgID - 外部消息 ID 或发送者 ID。
 * @returns {string} 64 位小写十六进制 SHA-256 摘要。
 */
function BotMessageID(botID, msgID) {
  return hexSHA256(botID + "\x00" + msgID);
}

/**
 * 生成新的 Bot 对话会话 ID（形如 `"bot-<32位十六进制>"`）。
 * 用于首次创建 Bot 对话或执行 `/new` 重置上下文时分配新会话轮次。
 *
 * @returns {string} 带 `"bot-"` 前缀的随机十六进制会话 ID。
 * @throws {Error} 随机字节生成失败时抛出错误（对应 Go 的 `panic(err)`）。
 */
function newBotSessionID() {
  const raw = randomBytes(16);
  return "bot-" + raw.toString("hex");
}

/**
 * 为当前实例尝试抢占或续占指定外部 Bot 的 45 秒连接租约。
 * 首次调用时会插入一条已过期的初始连接行，随后仅当原持有者为自己或租约已过期时抢占成功。
 *
 * @param {string} botID - 外部 Bot 唯一标识。
 * @param {string} owner - 当前运行实例标识。
 * @param {Date} now - 当前 UTC 时间。
 * @returns {boolean} 成功抢占或刷新租约时返回 `true`，被其他存活实例持有时返回 `false`。
 * @throws {Error} 数据库插入或更新失败时抛出错误。
 */
BotInteractionsRepo.prototype.ClaimBotConnection = function (botID, owner, now) {
  const row = new BotConnection({ BotID: botID, State: "connecting", LeaseUntil: new Date(now.getTime() - 1000) });
  const err = this.DB.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
  if (err != null) {
    throw err;
  }
  const result = this.DB.Model(row).Where("bot_id = ? AND (owner = ? OR lease_until < ?)", botID, owner, now).Updates({ owner: owner, lease_until: new Date(now.getTime() + 45 * 1000), updated_at: now });
  if (result.Error != null) {
    throw result.Error;
  }
  return result.RowsAffected === 1;
};

/**
 * 为已持有未过期租约的实例续期 45 秒，并按需更新连接状态与最近错误详情。
 * 供连接保活协程周期性调用。
 *
 * @param {string} botID - 外部 Bot 唯一标识。
 * @param {string} owner - 当前持有租约的实例标识。
 * @param {string} state - 可选的新连接状态（传非空字符串时连同 `detail` 一并更新）。
 * @param {string} detail - 与 `state` 配套的错误或状态详情说明。
 * @param {Date} now - 当前 UTC 时间。
 * @returns {boolean} 续期成功（影响 1 行）返回 `true`，租约已丢失或过期返回 `false`。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
BotInteractionsRepo.prototype.RenewBotConnection = function (botID, owner, state, detail, now) {
  const updates = { lease_until: new Date(now.getTime() + 45 * 1000), updated_at: now };
  if (state !== "") {
    updates.state = state;
    updates.last_error = detail;
  }
  const result = this.DB.Model(new BotConnection()).Where("bot_id = ? AND owner = ? AND lease_until > ?", botID, owner, now).Updates(updates);
  if (result.Error != null) {
    throw result.Error;
  }
  return result.RowsAffected === 1;
};

/**
 * 主动释放当前实例持有的外部 Bot 连接租约并将状态置为离线。
 * 在进程优雅停机或关闭 Bot 长连接时调用。
 *
 * @param {string} botID - 外部 Bot 唯一标识。
 * @param {string} owner - 当前持有租约的实例标识。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
BotInteractionsRepo.prototype.ReleaseBotConnection = function (botID, owner) {
  const err = this.DB.Model(new BotConnection()).Where("bot_id = ? AND owner = ?", botID, owner).Updates({ owner: "", lease_until: new Date(Date.now() - 1000), state: "offline" }).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 查询外部 Bot 的当前连接状态；若租约已早于当前时间则对外折叠为 `"offline"`。
 * 用于控制台展示外部 Bot 在线健康状态。
 *
 * @param {string} botID - 外部 Bot 唯一标识。
 * @returns {BotConnection} Bot 连接状态对象。
 * @throws {Error} 记录不存在或数据库查询失败时抛出错误。
 */
BotInteractionsRepo.prototype.BotConnectionState = function (botID) {
  const out = new BotConnection();
  const err = this.DB.First(out, "bot_id = ?", botID).Error;
  if (timeBefore(out.LeaseUntil, new Date())) {
    out.State = "offline";
  }
  if (err != null) {
    throw err;
  }
  return out;
};

/**
 * 在事务中确保所属对话存在并将一条外部 Bot 交互消息幂等入队。
 * 主键冲突时保留已有记录并返回 `false`；新入队成功时同步刷新所属对话的 `updated_at`。
 *
 * @param {BotInteraction} item - 待入队的 Bot 交互记录。
 * @param {string} kind - 聊天类型。
 * @param {string} chat - 外部平台聊天标识。
 * @returns {boolean} 实际插入新交互记录返回 `true`，重复消息被忽略返回 `false`。
 * @throws {Error} 数据库事务中任意读写失败时抛出错误。
 */
BotInteractionsRepo.prototype.EnqueueBotInteraction = function (item, kind, chat) {
  let inserted = false;
  this.DB.Transaction((tx) => {
    const conversation = new BotConversation({ ID: BotConversationID(item.BotID, kind, chat), BotID: item.BotID, ChatID: chat, ChatType: kind, SessionID: newBotSessionID(), UpdatedAt: new Date() });
    const convErr = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(conversation).Error;
    if (convErr != null) {
      throw convErr;
    }
    item.ConversationID = conversation.ID;
    item.Status = "queued";
    item.CreatedAt = new Date();
    item.UpdatedAt = item.CreatedAt;
    const result = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(item);
    inserted = result.RowsAffected === 1;
    if (result.Error != null) {
      throw result.Error;
    }
    if (inserted) {
      const updateErr = tx.Model(conversation).Update("updated_at", item.CreatedAt).Error;
      if (updateErr != null) {
        throw updateErr;
      }
    }
  });
  return inserted;
};

/**
 * 在校验当前实例持有有效连接租约的前提下，按入队顺序认领一条待处理（`"queued"`）或待重发回复（`"ready"`）的交互记录。
 * 若认领到 `"queued"` 记录，则绑定当前对话的 `SessionID` 并推进状态为 `"running"`；无待处理记录或租约无效时返回 `null`。
 *
 * @param {string} botID - 待消费交互记录所属的 Bot ID。
 * @param {string} leaseBotID - 校验连接租约所用的 Bot ID。
 * @param {string} owner - 当前运行实例标识。
 * @returns {BotInteraction|null} 认领到的交互记录；无可用记录或租约不匹配时返回 `null`。
 * @throws {Error} 非 `gorm.ErrRecordNotFound` 的数据库事务错误时抛出错误。
 */
BotInteractionsRepo.prototype.ClaimBotInteraction = function (botID, leaseBotID, owner) {
  const item = new BotInteraction();
  try {
    this.DB.Transaction((tx) => {
      const lease = new BotConnection();
      const leaseErr = this.locking(tx).Where("bot_id = ? AND owner = ? AND lease_until > ?", leaseBotID, owner, new Date()).First(lease).Error;
      if (leaseErr != null) {
        throw leaseErr;
      }
      const itemErr = this.locking(tx).Where("bot_id = ? AND status IN ?", botID, ["queued", "ready"]).Order("created_at, id").First(item).Error;
      if (itemErr != null) {
        throw itemErr;
      }
      if (item.Status === "ready") {
        return;
      }
      const conv = new BotConversation();
      const convErr = tx.First(conv, "id = ?", item.ConversationID).Error;
      if (convErr != null) {
        throw convErr;
      }
      item.SessionID = conv.SessionID;
      item.Status = "running";
      const updateErr = tx.Model(item).Updates({ session_id: item.SessionID, status: "running", updated_at: new Date() }).Error;
      if (updateErr != null) {
        throw updateErr;
      }
    });
  } catch (err) {
    if (err === gorm.ErrRecordNotFound) {
      return null;
    }
    throw err;
  }
  return item;
};

/**
 * 将因进程异常退出而遗留在 `"running"` 状态的交互记录恢复为 `"ready"` 并填入中断提示回复。
 * 被中断的模型轮次绝不自动重放（因为平台工具可能已产生写入副作用），仅允许重试向用户发送提示回复。
 *
 * @param {string} botID - 外部 Bot 唯一标识。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
BotInteractionsRepo.prototype.RecoverBotInteractions = function (botID) {
  const err = this.DB.Model(new BotInteraction()).Where("bot_id = ? AND status = ?", botID, "running").Updates({ status: "ready", reply: "上一轮处理已中断，执行结果可能已保存。请先查询状态，再决定是否继续操作。", last_error: "执行中断", updated_at: new Date() }).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 保存模型执行生成的回复内容并将 `"running"` 状态的交互推进到待发送状态 `"ready"`。
 * 在模型单轮执行完成、准备向外部 IM 发送消息前调用。
 *
 * @param {BotInteraction} item - 当前处理中的交互记录。
 * @param {string} reply - 待发送给外部用户的回复正文。
 * @param {string} detail - 可选的错误或附加详情说明。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
BotInteractionsRepo.prototype.SaveBotReply = function (item, reply, detail) {
  const err = this.DB.Model(new BotInteraction()).Where("id = ? AND status = ?", item.ID, "running").Updates({ status: "ready", reply: reply, last_error: detail, updated_at: new Date() }).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 将已成功向外部 IM 发送回复的 `"ready"` 交互记录标记为终态 `"replied"`。
 *
 * @param {string} id - Bot 交互记录主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
BotInteractionsRepo.prototype.MarkBotReplySent = function (id) {
  const err = this.DB.Model(new BotInteraction()).Where("id = ? AND status = ?", id, "ready").Updates({ status: "replied", updated_at: new Date() }).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 在事务中为对话分配全新的 `SessionID` 并将触发重置的交互记录标记为 `action = "new"`。
 * 供用户在 Bot 中触发开启新对话时清空上下文历史。
 *
 * @param {BotInteraction} item - 触发新对话命令的交互记录。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库事务更新失败时抛出错误。
 */
BotInteractionsRepo.prototype.NewBotConversation = function (item) {
  this.DB.Transaction((tx) => {
    const session = newBotSessionID();
    const convErr = tx.Model(new BotConversation()).Where("id = ?", item.ConversationID).Updates({ session_id: session, updated_at: new Date() }).Error;
    if (convErr != null) {
      throw convErr;
    }
    const interErr = tx.Model(new BotInteraction()).Where("id = ?", item.ID).Updates({ session_id: session, action: "new" }).Error;
    if (interErr != null) {
      throw interErr;
    }
  });
};

/**
 * 按主键 ID 读取单条 Bot 对话记录。
 *
 * @param {string} id - Bot 对话记录主键 ID。
 * @returns {BotConversation} 查得的对话对象。
 * @throws {Error} 记录不存在或查询失败时抛出错误。
 */
BotInteractionsRepo.prototype.BotConversation = function (id) {
  const out = new BotConversation();
  const err = this.DB.First(out, "id = ?", id).Error;
  if (err != null) {
    throw err;
  }
  return out;
};

/**
 * 读取指定会话轮次最近 20 条已回复的普通对话交互记录，并翻转为从旧到新的时间正序返回。
 * 用于组装下一轮模型调用的上下文历史。
 *
 * @param {string} sessionID - 对话会话轮次 ID。
 * @returns {BotInteraction[]} 按时间正序排列的历史交互列表（最多 20 条）。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
BotInteractionsRepo.prototype.BotHistory = function (sessionID) {
  const rows = [];
  const err = this.DB.Where("session_id = ? AND status = ? AND action = ?", sessionID, "replied", "").Order("created_at desc, id desc").Limit(20).Find(rows).Error;
  for (let i = 0, j = rows.length - 1; i < j; i++, j--) {
    const tmp = rows[i];
    rows[i] = rows[j];
    rows[j] = tmp;
  }
  if (err != null) {
    throw err;
  }
  return rows;
};

/**
 * 按创建时间倒序查询指定外部 Bot 最近 50 条交互记录。
 * 用于 Bot 运维诊断与消息记录查看页面。
 *
 * @param {string} botID - 外部 Bot 唯一标识。
 * @returns {BotInteraction[]} 最近 50 条交互记录数组。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
BotInteractionsRepo.prototype.BotInteractionRecords = function (botID) {
  const rows = [];
  const err = this.DB.Where("bot_id = ?", botID).Order("created_at desc, id desc").Limit(50).Find(rows).Error;
  if (err != null) {
    throw err;
  }
  return rows;
};

/**
 * 按更新时间倒序查询指定外部 Bot 最近 50 条对话记录。
 * 用于查看外部 Bot 活跃聊天会话列表。
 *
 * @param {string} botID - 外部 Bot 唯一标识。
 * @returns {BotConversation[]} 最近 50 条对话记录数组。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
BotInteractionsRepo.prototype.BotConversations = function (botID) {
  const rows = [];
  const err = this.DB.Where("bot_id = ?", botID).Order("updated_at desc").Limit(50).Find(rows).Error;
  if (err != null) {
    throw err;
  }
  return rows;
};

/**
 * 按主键 ID 读取单条 Bot 交互记录。
 *
 * @param {string} id - Bot 交互记录主键 ID。
 * @returns {BotInteraction} 查得的交互记录对象。
 * @throws {Error} 记录不存在或查询失败时抛出错误。
 */
BotInteractionsRepo.prototype.BotInteraction = function (id) {
  const item = new BotInteraction();
  const err = this.DB.First(item, "id = ?", id).Error;
  if (err != null) {
    throw err;
  }
  return item;
};

/**
 * 将尚未结束的通知卡片交互直接置为已回复状态，并注明对应节点已不再等待操作。
 * 用于审批或人工节点状态变更后使旧交互卡片失效。
 *
 * @param {string} id - 通知卡片对应的交互记录主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
BotInteractionsRepo.prototype.ExpireBotCard = function (id) {
  const err = this.DB.Model(new BotInteraction()).Where("id = ? AND action = ? AND status <> ?", id, "notification", "replied").Updates({ status: "replied", last_error: "该节点已不再等待本次操作", updated_at: new Date() }).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 将处于 `"ready"` 状态但外部发送失败的交互标记为 `"reply_failed"` 并记录失败原因。
 *
 * @param {string} id - Bot 交互记录主键 ID。
 * @param {string} detail - 发送失败的错误详情。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
BotInteractionsRepo.prototype.FailBotReply = function (id, detail) {
  const err = this.DB.Model(new BotInteraction()).Where("id = ? AND status = ?", id, "ready").Updates({ status: "reply_failed", last_error: detail, updated_at: new Date() }).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 将发送失败（`"reply_failed"`）的通知卡片重新放回待发送状态 `"ready"` 并清空错误信息。
 * 用于人工或后台触发通知卡片重发。
 *
 * @param {string} id - 通知卡片对应的交互记录主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
BotInteractionsRepo.prototype.RequeueBotCard = function (id) {
  const err = this.DB.Model(new BotInteraction()).Where("id = ? AND action = ? AND status = ?", id, "notification", "reply_failed").Updates({ status: "ready", last_error: "", updated_at: new Date() }).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 在事务中确保外部 Bot 对应的连接行存在并对其加排他行锁。
 * 供 `NotificationsRepo.SaveNotificationBot` 串行化跨项目注册同一外部 Bot 的唯一性检查，避免建立重复长连接。
 *
 * @param {object} tx - 当前事务的 `gorm.DB` 句柄。
 * @param {string} botID - 外部 Bot 唯一标识。
 * @returns {void} 无返回值。
 * @throws {Error} 插入占位行或加锁查询失败时抛出错误。
 */
BotInteractionsRepo.prototype.lockBotDefinition = function (tx, botID) {
  const row = new BotConnection({ BotID: botID, LeaseUntil: new Date(Date.now() - 1000), State: "offline" });
  const err = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
  if (err != null) {
    throw err;
  }
  const lockErr = this.locking(tx).Where("bot_id = ?", botID).First(row).Error;
  if (lockErr != null) {
    throw lockErr;
  }
};

/**
 * 在发出交互卡片网络请求前记录精确的卡片任务 ID，确保回调只能按精确任务 ID 路由而不受旧卡片干扰。
 *
 * @param {string} id - 通知卡片对应的交互记录主键 ID。
 * @param {string} taskID - 外部平台关联用的卡片任务 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败，或记录已不处于可发送状态（抛出 `gorm.ErrRecordNotFound`）时抛出错误。
 */
BotInteractionsRepo.prototype.SetBotCardTaskID = function (id, taskID) {
  const result = this.DB.Model(new BotInteraction()).Where("id = ? AND action = ? AND status = ?", id, "notification", "ready").Update("card_task_id", taskID);
  if (result.Error != null) {
    throw result.Error;
  }
  if (result.RowsAffected !== 1) {
    throw gorm.ErrRecordNotFound;
  }
};

module.exports = { BotInteractionsRepo, BotConversationID, BotMessageID, newBotSessionID };
