/**
 * @file internal/repo/rooms.js
 * 对应 Go 源文件：internal/repo/rooms.go
 *
 * 作用与职责边界：
 * 实现项目群聊房间（`chat_rooms`）与群聊消息（`chat_messages`）的持久化读写，
 * 包含房间列表/详情/保存、主时间线与线程消息分页、调度卡片检索、附件引用检查、
 * 线程消息计数及各房间待处理信号（待审批数、活跃运行数、泳道数）聚合；
 * 方法挂载于 `RoomsRepo.prototype`（`RoomsRepo` 定义于 `repo.js`），不负责 WebSocket/SSE 广播。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；`(值, bool)` 译为二元组 `[值, boolean]`。
 * - Go 的 `map[string]V` 统一使用普通对象 `{}`；`struct` 字段严格按 Go 零值初始化。
 * - `jsonUnmarshal` 在解码失败时抛出异常，Go 中 `if json.Unmarshal(...) != nil { continue }` 分支在 JS 中以 `try ... catch` 对应。
 */

"use strict";

const { ChatRoom, ChatMessage, ChatKindDispatch, ChatKindApproval } = require("../domain/room.js"); // 对应 Go 的 domain.ChatRoom/ChatMessage/ChatKind*，room.js 已翻译
const { RoomsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { chatMessageRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { jsonUnmarshal, mustJSON, timePtr, upsert, payloadOne } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { payloadMentions } = require("./payload_mentions.js"); // 对应 Go 同包函数，payload_mentions.js 已翻译
const { isZeroTime } = require("./analytics.js"); // 对应 Go 的时间零值判断，analytics.js 已翻译

// RoomsRepo 的类型定义在 repo.js（继承 deps），本文件以 prototype 方式挂载其领域方法。

/**
 * 按更新时间倒序查询群聊房间列表；传入非空 `projectID` 时按所属项目过滤。
 * 载荷中缺失 `ID`/`ProjectID`/`Name` 时会从物理表列回填，解码失败的行自动跳过。
 *
 * @param {string} projectID - 可选项目 ID 过滤条件（空串表示查询全部房间）。
 * @returns {ChatRoom[]} 群聊房间领域对象数组；数据库查询失败时返回空数组。
 */
RoomsRepo.prototype.Rooms = function (projectID) {
  projectID = projectID.trim();
  let q = this.DB.Table("chat_rooms").Order("updated_at desc");
  if (projectID !== "") {
    q = q.Where("project_id = ?", projectID);
  }
  const rows = [];
  const err = q.Find(rows).Error;
  if (err != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const item = new ChatRoom();
    try {
      jsonUnmarshal(row.Payload, item);
    } catch {
      continue;
    }
    if (item.ID === "") {
      item.ID = row.ID;
    }
    if (item.ProjectID === "") {
      item.ProjectID = row.ProjectID;
    }
    if (item.Name === "") {
      item.Name = row.Name;
    }
    out.push(item);
  }
  return out;
};

/**
 * 按主键 ID 读取单个群聊房间配置。
 *
 * @param {string} id - 群聊房间主键 ID。
 * @returns {[ChatRoom, boolean]} 找到且解码成功时返回 `[room, true]`，否则返回 `[空 ChatRoom, false]`。
 */
RoomsRepo.prototype.Room = function (id) {
  return payloadOne(ChatRoom, this.DB, "chat_rooms", id.trim());
};

/**
 * 创建或更新群聊房间记录。
 * 更新已有房间时自动保留原 `CreatedAt`，并在新值未提供 `CreatedBy` 或 `ProjectID` 时沿用旧值。
 *
 * @param {ChatRoom} v - 待保存的群聊房间领域对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
RoomsRepo.prototype.PutRoom = function (v) {
  const now = new Date();
  const [old, ok] = this.Room(v.ID);
  if (ok) {
    v.CreatedAt = old.CreatedAt;
    if (v.CreatedBy === 0) {
      v.CreatedBy = old.CreatedBy;
    }
    if (v.ProjectID === "") {
      v.ProjectID = old.ProjectID;
    }
  } else if (isZeroTime(v.CreatedAt)) {
    v.CreatedAt = now;
  }
  v.UpdatedAt = now;
  upsert(this.DB, "chat_rooms", {
    id: v.ID, project_id: v.ProjectID, name: v.Name, created_by: v.CreatedBy,
    payload: mustJSON(v), created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  });
};

/**
 * 读取指定群聊房间最近一页消息（最多 200 条），查询最新页后翻转为由旧到新排列便于对话从上至下阅读。
 *
 * @param {string} roomID - 群聊房间 ID。
 * @param {number} limit - 返回条数上限；小于等于 0 或超过 200 时默认按 200 处理。
 * @returns {ChatMessage[]} 由旧到新排列的群聊消息数组。
 */
RoomsRepo.prototype.Messages = function (roomID, limit) {
  roomID = roomID.trim();
  if (roomID === "") {
    return [];
  }
  if (limit <= 0 || limit > 200) {
    limit = 200;
  }
  const rows = [];
  // 先倒序取最新一页，再反转顺序使消息列表按时间自上而下阅读。
  const err = this.DB.Table("chat_messages").Where("room_id = ?", roomID).Order("created_at desc").Order("id desc").Limit(limit).Find(rows).Error;
  if (err != null) {
    return [];
  }
  return decodeChatMessagesReversed(rows);
};

/**
 * 在指定房间中查找触发了目标 `runID` 的调度卡片消息，即使该消息已滚出最新消息页也能定位。
 *
 * @param {string} roomID - 群聊房间 ID。
 * @param {string} runID - 目标运行 ID。
 * @returns {[ChatMessage, boolean]} 找到对应调度卡片时返回 `[message, true]`，否则返回 `[空 ChatMessage, false]`。
 */
RoomsRepo.prototype.DispatchMessage = function (roomID, runID) {
  roomID = roomID.trim();
  runID = runID.trim();
  if (roomID === "" || runID === "") {
    return [new ChatMessage(), false];
  }
  const rows = [];
  const err = this.DB.Table("chat_messages").Where("room_id = ? AND kind = ?", roomID, ChatKindDispatch).Order("created_at desc").Find(rows).Error;
  if (err != null) {
    return [new ChatMessage(), false];
  }
  for (const row of rows) {
    const [item, ok] = decodeChatMessage(row);
    if (ok && item.RunID === runID) {
      return [item, true];
    }
  }
  return [new ChatMessage(), false];
};

/**
 * 在指定房间中查找携带了目标附件 ID 的群聊消息。
 * 会拒绝含通配符或转义字符（`%`、`_`、`\`）的附件 ID，并先用 `LIKE` 粗筛后做 JSON 精确匹配。
 *
 * @param {string} roomID - 群聊房间 ID。
 * @param {string} attachmentID - 目标附件 ID。
 * @returns {[ChatMessage, boolean]} 找到携带该附件的消息时返回 `[message, true]`，否则返回 `[空 ChatMessage, false]`。
 */
RoomsRepo.prototype.MessageWithAttachment = function (roomID, attachmentID) {
  if (this.DB == null || roomID === "" || attachmentID === "" || /[%_\\]/.test(attachmentID)) {
    return [new ChatMessage(), false];
  }
  const rows = [];
  const err = this.DB.Table("chat_messages").Where("room_id = ? AND CAST(payload AS CHAR) LIKE ?", roomID, "%" + attachmentID + "%").Limit(20).Find(rows).Error;
  if (err != null) {
    return [new ChatMessage(), false];
  }
  for (const row of rows) {
    const item = new ChatMessage();
    try {
      jsonUnmarshal(row.Payload, item);
    } catch {
      continue;
    }
    for (const a of item.Attachments ?? []) {
      if (a.ID === attachmentID) {
        return [item, true];
      }
    }
  }
  return [new ChatMessage(), false];
};

/**
 * 批量检查给定附件 ID 列表中哪些仍被群聊消息载荷引用（如 AI 回复复用发帖人附件）。
 * 供附件垃圾回收任务删除前执行引用检查。
 *
 * @param {string[]} ids - 待检查的附件 ID 数组。
 * @returns {Object<string, boolean>} 以仍在被引用的附件 ID 为键、值为 `true` 的映射对象。
 * @throws {Error} 数据库扫描失败时抛出错误。
 */
RoomsRepo.prototype.RoomAttachmentsInUse = function (ids) {
  return payloadMentions(this.DB, "chat_messages", ids);
};

/**
 * 读取指定房间某条时间线的最新一页消息：`threadID` 为空时读主时间线，否则读对应讨论线程，并翻转为由旧到新排列。
 *
 * @param {string} roomID - 群聊房间 ID。
 * @param {string} threadID - 线程 ID（空串表示主时间线）。
 * @param {number} limit - 返回条数上限；小于等于 0 或超过 200 时默认按 200 处理。
 * @returns {ChatMessage[]} 由旧到新排列的时间线消息数组。
 */
RoomsRepo.prototype.TimelineMessages = function (roomID, threadID, limit) {
  roomID = roomID.trim();
  threadID = threadID.trim();
  if (roomID === "") {
    return [];
  }
  if (limit <= 0 || limit > 200) {
    limit = 200;
  }
  let q = this.DB.Table("chat_messages").Where("room_id = ?", roomID);
  if (threadID === "") {
    q = q.Where("(thread_id = '' OR thread_id IS NULL)");
  } else {
    q = q.Where("thread_id = ?", threadID);
  }
  const rows = [];
  const err = q.Order("created_at desc").Order("id desc").Limit(limit).Find(rows).Error;
  if (err != null) {
    return [];
  }
  return decodeChatMessagesReversed(rows);
};

/**
 * 线程消息聚合计数查询的扫描行结构（对应 Go `ThreadMessageCounts` 内的局部 `row` 结构体）。
 */
class threadMessageCountRow {
  /**
   * 构造线程消息计数扫描行，缺省字段按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.ThreadID=""] - 线程 ID。
   * @param {number} [init.N=0] - 该线程下的消息总数。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ThreadID = init.ThreadID ?? "";
    this.N = init.N ?? 0;
  }
}

/**
 * 统计指定群聊房间中每个讨论线程包含的消息数量。
 *
 * @param {string} roomID - 群聊房间 ID。
 * @returns {Object<string, number>} 以 `threadID` 为键、消息数量为值的映射对象。
 */
RoomsRepo.prototype.ThreadMessageCounts = function (roomID) {
  const rows = [];
  const out = {};
  const err = this.DB.Table("chat_messages").Select("thread_id, COUNT(*) AS n").Where("room_id = ? AND thread_id <> ''", roomID.trim()).Group("thread_id").Scan(rows).Error;
  if (err != null) {
    return out;
  }
  for (const item of rows) {
    out[item.ThreadID] = item.N;
  }
  return out;
};

/**
 * 按创建时间升序返回指定房间中的全部调度卡片消息（最旧在前）。
 *
 * @param {string} roomID - 群聊房间 ID。
 * @returns {ChatMessage[]} 调度卡片消息数组；查询失败时返回空数组。
 */
RoomsRepo.prototype.DispatchMessages = function (roomID) {
  const rows = [];
  const err = this.DB.Table("chat_messages").Where("room_id = ? AND kind = ?", roomID.trim(), ChatKindDispatch).Order("created_at").Order("id").Find(rows).Error;
  if (err != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const item = new ChatMessage();
    try {
      jsonUnmarshal(row.Payload, item);
    } catch {
      continue;
    }
    if (item.ID === "") {
      item.ID = row.ID;
    }
    out.push(item);
  }
  return out;
};

/**
 * 群聊房间待关注状态汇总对象（对应 Go 的 `RoomSignal`）。
 * 统计房间内待处理审批数、进行中的调度运行数以及总调度泳道数。
 */
class RoomSignal {
  /**
   * 构造房间状态汇总对象，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {number} [init.PendingApprovals=0] - 未解决的审批卡片数量。
   * @param {number} [init.LiveRuns=0] - 尚未到达终态的已调度运行数量。
   * @param {number} [init.Lanes=0] - 调度卡片（泳道）总数。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.PendingApprovals = init.PendingApprovals ?? 0;
    this.LiveRuns = init.LiveRuns ?? 0;
    this.Lanes = init.Lanes ?? 0;
  }
}

/**
 * 批量统计多个群聊房间中未解决的审批数、未结束的已调度运行数及总调度卡片数。
 * 供群聊侧边栏红点与状态角标展示。
 *
 * @param {string[]} roomIDs - 待统计的群聊房间 ID 数组。
 * @returns {Object<string, RoomSignal>} 以房间 ID 为键、`RoomSignal` 为值的统计映射对象。
 */
RoomsRepo.prototype.RoomSignals = function (roomIDs) {
  const out = {};
  if (roomIDs.length === 0) {
    return out;
  }
  const rows = [];
  const err = this.DB.Table("chat_messages").Where("room_id IN ? AND kind IN ?", roomIDs, [ChatKindApproval, ChatKindDispatch]).Find(rows).Error;
  if (err != null) {
    return out;
  }
  for (const row of rows) {
    const item = new ChatMessage();
    try {
      jsonUnmarshal(row.Payload, item);
    } catch {
      continue;
    }
    const sig = out[row.RoomID] ?? new RoomSignal();
    if (item.Kind === ChatKindDispatch) {
      sig.Lanes++;
    }
    if (item.Kind === ChatKindApproval && !item.Resolved) {
      sig.PendingApprovals++;
    } else if (item.Kind === ChatKindDispatch && item.RunID !== "" && item.RunFinal === "") {
      sig.LiveRuns++;
    }
    out[row.RoomID] = sig;
  }
  return out;
};

/**
 * 按房间 ID 与消息主键 ID 查询单条群聊消息。
 *
 * @param {string} roomID - 群聊房间 ID。
 * @param {string} id - 消息主键 ID。
 * @returns {[ChatMessage, boolean]} 找到且解码成功时返回 `[message, true]`，否则返回 `[空 ChatMessage, false]`。
 */
RoomsRepo.prototype.Message = function (roomID, id) {
  const row = new chatMessageRow();
  const err = this.DB.Table("chat_messages").Where("id = ? AND room_id = ?", id.trim(), roomID.trim()).Take(row).Error;
  if (err != null) {
    return [new ChatMessage(), false];
  }
  return decodeChatMessage(row);
};

/**
 * 反序列化单条持久化的群聊消息行，并在载荷缺失时从物理列回填 `ID` 与 `RoomID`。
 *
 * @param {chatMessageRow} row - 从 `chat_messages` 表读出的消息行。
 * @returns {[ChatMessage, boolean]} 解码成功时返回 `[message, true]`，失败时返回 `[空 ChatMessage, false]`。
 */
function decodeChatMessage(row) {
  const item = new ChatMessage();
  try {
    jsonUnmarshal(row.Payload, item);
  } catch {
    return [new ChatMessage(), false];
  }
  if (item.ID === "") {
    item.ID = row.ID;
  }
  if (item.RoomID === "") {
    item.RoomID = row.RoomID;
  }
  return [item, true];
}

/**
 * 将按最新在前查出的消息行数组倒序解码为由旧到新的消息数组，自动跳过解码失败的行。
 *
 * @param {chatMessageRow[]} rows - 按时间倒序排列的消息行数组。
 * @returns {ChatMessage[]} 按时间正序排列的解码消息数组。
 */
function decodeChatMessagesReversed(rows) {
  const out = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const [item, ok] = decodeChatMessage(rows[i]);
    if (ok) {
      out.push(item);
    }
  }
  return out;
}

/**
 * 创建或覆盖写入一条群聊消息记录；`CreatedAt` 为零值时自动补全为当前 UTC 时间。
 *
 * @param {ChatMessage} v - 待保存的群聊消息领域对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
RoomsRepo.prototype.PutMessage = function (v) {
  if (isZeroTime(v.CreatedAt)) {
    v.CreatedAt = new Date();
  }
  upsert(this.DB, "chat_messages", {
    id: v.ID, room_id: v.RoomID, user_id: v.UserID, kind: v.Kind, issue_id: v.IssueID,
    thread_id: v.ThreadID, payload: mustJSON(v), created_at: timePtr(v.CreatedAt),
  });
};

module.exports = { RoomSignal, decodeChatMessage, decodeChatMessagesReversed };
