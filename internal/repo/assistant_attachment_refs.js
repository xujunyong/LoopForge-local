// assistant_attachment_refs.js —— 对应 Go 文件：internal/repo/assistant_attachment_refs.go
// 作用：会话与生成记录里仍在用的附件 id、已存在的会话 id。

"use strict";

const { payloadMentions } = require("./payload_mentions.js"); // 对应 Go 同包函数，payload_mentions.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// AssistantAttachmentsInUse reports which attachment ids a conversation still
// lists, in its transcript or in a pending turn. Forks inherit the attachment
// ids of the messages before the fork point. One call scans each table once
// per 64 ids, so callers batch the ids of many deleted conversations.
AssistantRepo.prototype.AssistantAttachmentsInUse = function (ids) {
  const inUse = payloadMentions(this.DB, "assistant_sessions", ids);
  const pending = payloadMentions(this.DB, "assistant_generations", ids);
  for (const id of Object.keys(pending)) {
    inUse[id] = true;
  }
  return inUse;
};

// ExistingAssistantSessionIDs reports which of ids still name a conversation.
// Conversation ids are unique across owners.
AssistantRepo.prototype.ExistingAssistantSessionIDs = function (ids) {
  const out = {};
  const clean = [];
  for (let id of ids) {
    id = id.trim();
    if (id !== "" && !Object.prototype.hasOwnProperty.call(out, id)) {
      out[id] = false;
      clean.push(id);
    }
  }
  for (let start = 0; start < clean.length; start += 500) {
    const chunk = clean.slice(start, Math.min(start + 500, clean.length));
    const found = [];
    const err = this.DB.Table("assistant_sessions").Where("id IN ?", chunk).Pluck("id", found).Error;
    if (err != null) {
      // Unknown is not gone: keep offering the link.
      for (const id of chunk) {
        out[id] = true;
      }
      continue;
    }
    for (const id of found) {
      out[id] = true;
    }
  }
  return out;
};

module.exports = {};
