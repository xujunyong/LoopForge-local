// rooms.js —— 对应 Go 文件：internal/repo/rooms.go
// 作用：项目群聊房间、消息与时间线的读写。

"use strict";

const { ChatRoom, ChatMessage, ChatKindDispatch, ChatKindApproval } = require("../domain/room.js"); // 对应 Go 的 domain.ChatRoom/ChatMessage/ChatKind*，room.js 已翻译
const { RoomsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { chatRoomRow, chatMessageRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { jsonUnmarshal, mustJSON, timePtr, upsert, payloadOne } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { payloadMentions } = require("./payload_mentions.js"); // 对应 Go 同包函数，payload_mentions.js 已翻译
const { isZeroTime } = require("./analytics.js"); // 对应 Go 的时间比较，analytics.js 已翻译

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
    if (jsonUnmarshal(row.Payload, item) != null) {
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

RoomsRepo.prototype.Room = function (id) {
  return payloadOne(ChatRoom, this.DB, "chat_rooms", id.trim());
};

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
  return upsert(this.DB, "chat_rooms", {
    id: v.ID, project_id: v.ProjectID, name: v.Name, created_by: v.CreatedBy,
    payload: mustJSON(v), created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  });
};

RoomsRepo.prototype.Messages = function (roomID, limit) {
  roomID = roomID.trim();
  if (roomID === "") {
    return [];
  }
  if (limit <= 0 || limit > 200) {
    limit = 200;
  }
  const rows = [];
  // Newest page first, then flip so the thread reads top-down.
  const err = this.DB.Table("chat_messages").Where("room_id = ?", roomID).Order("created_at desc").Order("id desc").Limit(limit).Find(rows).Error;
  if (err != null) {
    return [];
  }
  return decodeChatMessagesReversed(rows);
};

// DispatchMessage finds the dispatch card in roomID that started runID, even
// when it has scrolled out of the latest Messages page.
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

// TimelineMessages returns the newest page of one timeline: the main one when
// threadID is empty, otherwise that thread.
// MessageWithAttachment finds the room message that carries an attachment.
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
    if (jsonUnmarshal(row.Payload, item) != null) {
      continue;
    }
    for (const a of item.Attachments) {
      if (a.ID === attachmentID) {
        return [item, true];
      }
    }
  }
  return [new ChatMessage(), false];
};

// RoomAttachmentsInUse reports which attachment ids a room message still
// carries; the AI reply to a room message reuses the poster's attachments.
RoomsRepo.prototype.RoomAttachmentsInUse = function (ids) {
  return payloadMentions(this.DB, "chat_messages", ids);
};

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

class threadMessageCountRow {
  constructor(init = {}) {
    this.ThreadID = init.ThreadID ?? "";
    this.N = init.N ?? 0;
  }
}

// ThreadMessageCounts returns how many messages each thread of roomID holds.
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

// DispatchMessages returns every dispatch card of roomID, oldest first.
RoomsRepo.prototype.DispatchMessages = function (roomID) {
  const rows = [];
  const err = this.DB.Table("chat_messages").Where("room_id = ? AND kind = ?", roomID.trim(), ChatKindDispatch).Order("created_at").Order("id").Find(rows).Error;
  if (err != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const item = new ChatMessage();
    if (jsonUnmarshal(row.Payload, item) != null) {
      continue;
    }
    if (item.ID === "") {
      item.ID = row.ID;
    }
    out.push(item);
  }
  return out;
};

// RoomSignal summarises what needs attention in a room.
class RoomSignal {
  constructor(init = {}) {
    this.PendingApprovals = init.PendingApprovals ?? 0;
    this.LiveRuns = init.LiveRuns ?? 0;
    this.Lanes = init.Lanes ?? 0;
  }
}

// RoomSignals counts unresolved approvals and unfinished dispatched runs per
// room.
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
    if (jsonUnmarshal(row.Payload, item) != null) {
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

// Message returns one message of roomID.
RoomsRepo.prototype.Message = function (roomID, id) {
  const row = new chatMessageRow();
  const err = this.DB.Table("chat_messages").Where("id = ? AND room_id = ?", id.trim(), roomID.trim()).Take(row).Error;
  if (err != null) {
    return [new ChatMessage(), false];
  }
  return decodeChatMessage(row);
};

// decodeChatMessage unmarshals a stored message, backfilling ID and RoomID
// from the row when the payload omits them.
function decodeChatMessage(row) {
  const item = new ChatMessage();
  if (jsonUnmarshal(row.Payload, item) != null) {
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

// decodeChatMessagesReversed decodes a newest-first page into oldest-first
// order, skipping rows whose payload does not decode.
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

RoomsRepo.prototype.PutMessage = function (v) {
  if (isZeroTime(v.CreatedAt)) {
    v.CreatedAt = new Date();
  }
  return upsert(this.DB, "chat_messages", {
    id: v.ID, room_id: v.RoomID, user_id: v.UserID, kind: v.Kind, issue_id: v.IssueID,
    thread_id: v.ThreadID, payload: mustJSON(v), created_at: timePtr(v.CreatedAt),
  });
};

module.exports = { RoomSignal, decodeChatMessage, decodeChatMessagesReversed };
