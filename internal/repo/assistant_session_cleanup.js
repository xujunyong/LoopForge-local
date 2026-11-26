// assistant_session_cleanup.js —— 对应 Go 文件：internal/repo/assistant_session_cleanup.go
// 作用：按来源或任务列会话、列全部会话 id，推断老会话的来源。

"use strict";

const { AssistantSourceSOP, AssistantSourceScheduled, AssistantSourceChat } = require("../domain/assistant.js"); // 对应 Go 同包常量，assistant.js 已翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// scheduledAssistantTitlePrefix is how scheduled conversations were named
// before the source column existed.
const scheduledAssistantTitlePrefix = "定时 · ";

// ListAssistantSessionsBySource returns conversation metadata for one source
// (chat / sop / scheduled). Transcripts stay in the database.
AssistantRepo.prototype.ListAssistantSessionsBySource = function (source) {
  source = source.trim();
  if (source === "") {
    return [];
  }
  return this.assistantSessionsBy("source = ?", source);
};

// AssistantSessionIDs lists every stored conversation id.
AssistantRepo.prototype.AssistantSessionIDs = function () {
  const ids = [];
  const err = this.DB.Table("assistant_sessions").Pluck("id", ids).Error;
  if (err != null) {
    throw err;
  }
  return ids;
};

// ListAssistantSessionsByTask returns the conversations a scheduled task or
// assistant task produced, so a new run can keep only its own.
AssistantRepo.prototype.ListAssistantSessionsByTask = function (source, taskID) {
  source = source.trim();
  taskID = taskID.trim();
  if (source === "" || taskID === "") {
    return [];
  }
  return this.assistantSessionsBy("source = ? AND task_id = ?", source, taskID);
};

AssistantRepo.prototype.assistantSessionsBy = function (where, ...args) {
  const { decodeAssistantSession } = require("./assistant.js"); // 循环引用：调用时现取，不缓存
  const [rows, err] = this.findAssistantSessionSummaries(where, ...args);
  if (err != null) {
    console.log(`assistant session query failed (${where}): ${err}`);
    return [];
  }
  const out = [];
  for (const row of rows) {
    const item = decodeAssistantSession(row);
    item.Messages = null;
    out.push(item);
  }
  return out;
};

// inferredAssistantSessionSource recovers the origin of a conversation whose
// source column predates the marker, for the single row a client is about to
// rewrite: continuing an old conversation must not reset it to chat.
//
// Bulk backfill is deliberately not done from code. Rows written before the
// column existed are marked by migrations/021_assistant_session_sources.sql,
// which the operator applies manually, in line with the repository rule that
// production never migrates data on boot.
function inferredAssistantSessionSource(item) {
  if (item.Source.trim() !== "") {
    return item.Source.trim();
  }
  if (item.Shared && item.RunID.trim() !== "") {
    return AssistantSourceSOP;
  }
  if (!item.TitleEdited && item.Title.trim().startsWith(scheduledAssistantTitlePrefix)) {
    return AssistantSourceScheduled;
  }
  return AssistantSourceChat;
}

module.exports = { scheduledAssistantTitlePrefix, inferredAssistantSessionSource };
