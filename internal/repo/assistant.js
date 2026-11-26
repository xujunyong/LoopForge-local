// assistant.js —— 对应 Go 文件：internal/repo/assistant.go
// 作用：助手会话与定时任务的读写：会话存取、标题回填、任务启停。
// gorm 链式调用按原样保留，gorm/clause 只做 require，不做实现；errors.Is 译为 ===，errors.As 译为 instanceof。
// Go 的 json.Unmarshal 按 tag（驼峰）填充字段；JS 构造器认 Go 字段名，此处直接以解析结果构造。
// atomic.Bool 译为普通布尔值；select + time.After 译为 async + sleepOrAbort。

"use strict";

const path = require("node:path");
const { Buffer } = require("node:buffer");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause
const mysqldriver = require("github.com/go-sql-driver/mysql"); // Go 第三方包 github.com/go-sql-driver/mysql

const { AssistantSession, AssistantTask, AssistantExecutionTarget, AssistantSourceSOP, AssistantSourceChat, AssistantModePlatform } = require("../domain/assistant.js"); // 对应 Go 同包类型与常量，assistant.js 已翻译
const { ExecutionModeCloud } = require("../domain/observability.js"); // 对应 Go 同包常量，observability.js 已翻译
const { CloneNotificationBindings } = require("../domain/notification_template.js"); // 对应 Go 同包函数，notification_template.js 已翻译
const { assistantSessionRow, assistantTaskRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON, upsert, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译
const { assistantDiagnosticsRow } = require("./assistant_diagnostics.js"); // 对应 Go 同包类型，assistant_diagnostics.js 本次一同翻译
const { deriveAssistantParticipants, summaryProjectionUnsupported } = require("./assistant_context.js"); // 对应 Go 同包函数，assistant_context.js 本次一同翻译
const { ErrAssistantSessionProjectChanged, ErrAssistantExecutionLocked } = require("./assistant_execution.js"); // 对应 Go 同包变量，assistant_execution.js 本次一同翻译
const { inferredAssistantSessionSource } = require("./assistant_session_cleanup.js"); // 对应 Go 同包函数，assistant_session_cleanup.js 本次一同翻译

const ErrAssistantPersonalWorkspaceProject = new Error("此会话已有个人工作区，请在项目中新建对话");

function assistantRecordID(id) {
  id = path.basename(id.trim());
  if (id === "" || id === "." || id === "..") {
    return "";
  }
  return id;
}

AssistantRepo.prototype.AssistantSession = function (userID, id) {
  id = assistantRecordID(id);
  if (userID <= 0 || id === "") {
    return [new AssistantSession(), false];
  }
  const row = new assistantSessionRow();
  const err = this.DB.Table("assistant_sessions").Where("id = ? AND user_id = ?", id, userID).Take(row).Error;
  if (err != null) {
    return [new AssistantSession(), false];
  }
  return [decodeAssistantSession(row), true];
};

AssistantRepo.prototype.ListAssistantSessions = function (userID) {
  if (userID <= 0) {
    return [];
  }
  const [rows, err] = this.findAssistantSessionSummaries("user_id = ?", userID);
  if (err != null) {
    console.log(`assistant session list failed user=${userID}: ${err}`);
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

// Remove transcripts in SQL so list and permission checks never transfer or
// decode chat history. Retain all other metadata, including legacy fallbacks.
AssistantRepo.prototype.assistantSessionSummaries = function () {
  let summary = "json(" + this.assistantParticipantSummarySQL() + ")";
  if (this.DB.Dialector.Name() !== "sqlite") {
    summary = "CAST((" + this.assistantParticipantSummarySQL() + ") AS JSON)";
  }
  return this.DB.Table("assistant_sessions").Select("id, user_id, project_id, title, model, source, task_id, created_at, updated_at, JSON_SET(JSON_REMOVE(payload, '$.messages'), '$.executionMessageCount', " + this.assistantExecutionMessageCountSQL() + ", '$.participantSummaryMessages', " + summary + ") AS payload");
};

AssistantRepo.prototype.assistantExecutionMessageCountSQL = function () {
  if (this.DB.Dialector.Name() === "sqlite") {
    return "COALESCE(JSON_ARRAY_LENGTH(payload, '$.messages'), 0)";
  }
  return "COALESCE(JSON_LENGTH(JSON_EXTRACT(payload, '$.messages')), 0)";
};

// noSummaryProjection is process-wide: production has a single datasource.
let noSummaryProjection = false;

// The legacy participant projection relies on newer JSON functions. If the
// database rejects it, keep the history list available with cached metadata.
// A syntax/function error means the server lacks JSON_TABLE (MySQL 5.7,
// TDSQL-C 5.7): remember it and stop sending the query, so every history list
// does not log the same failure.
// Rows are ordered in Go: MySQL 8 may run out of sort memory when filesorting
// rows that carry large JSON payloads.
AssistantRepo.prototype.findAssistantSessionSummaries = function (where, ...args) {
  let rows = [];
  if (!noSummaryProjection) {
    const err = this.assistantSessionSummaries().Where(where, ...args).Find(rows).Error;
    if (err == null) {
      sortAssistantSessionRows(rows);
      this.backfillAssistantTitles(rows);
      return [rows, null];
    }
    if (summaryProjectionUnsupported(err)) {
      if (!noSummaryProjection) {
        noSummaryProjection = true;
        console.log(`assistant session summary projection unsupported by this database, using metadata fallback from now on: ${err}`);
      }
    } else {
      console.log(`assistant session summary projection failed, using metadata fallback: ${err}`);
    }
  }
  const fallback = () => {
    const out = [];
    const err = this.DB.Table("assistant_sessions").Select("id, user_id, project_id, title, model, source, task_id, created_at, updated_at, JSON_SET(JSON_REMOVE(payload, '$.messages'), '$.executionMessageCount', " + this.assistantExecutionMessageCountSQL() + ") AS payload").Where(where, ...args).Find(out).Error;
    sortAssistantSessionRows(out);
    return [out, err];
  };
  let err = null;
  [rows, err] = fallback();
  if (err != null) {
    return [rows, err];
  }
  if (this.backfillAssistantParticipants(rows) > 0) {
    [rows, err] = fallback();
    if (err != null) {
      return [rows, err];
    }
  }
  this.backfillAssistantTitles(rows);
  return [rows, null];
};

// AssistantTitleFromMessages names a conversation after its first user message.
function AssistantTitleFromMessages(messages) {
  for (const m of messages) {
    if (m.Role !== "user") {
      continue;
    }
    const title = [...m.Content.trim()];
    if (title.length > 0) {
      if (title.length > 36) {
        return title.slice(0, 36).join("") + "…";
      }
      return title.join("");
    }
  }
  return "";
}

// Project conversation replies once blanked their stored title, so the history
// list showed "新对话". Name those rows after their first user message, once.
// SOP run sessions are always titled by their workflow and are left alone.
AssistantRepo.prototype.backfillAssistantTitles = function (rows) {
  const index = {};
  const ids = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.Title.trim() === "" && !row.ID.startsWith("sop-")) {
      index[row.ID] = i;
      ids.push(row.ID);
    }
  }
  for (let start = 0; start < ids.length; start += 50) {
    const end = Math.min(start + 50, ids.length);
    const full = [];
    const err = this.DB.Table("assistant_sessions").Where("id IN ?", ids.slice(start, end)).Find(full).Error;
    if (err != null) {
      console.log(`assistant title backfill read failed: ${err}`);
      return;
    }
    for (const row of full) {
      const item = decodeAssistantSession(row);
      let title = item.Title.trim();
      if (title === "") {
        title = AssistantTitleFromMessages(item.Messages);
      }
      if (title === "") {
        title = "新对话";
      }
      const writeErr = this.DB.Exec("UPDATE assistant_sessions SET title = ? WHERE id = ? AND (title = '' OR title IS NULL)", title, row.ID).Error;
      if (writeErr != null) {
        console.log(`assistant title backfill write failed id=${row.ID}: ${writeErr}`);
        continue;
      }
      rows[index[row.ID]].Title = title;
    }
  }
};

function sortAssistantSessionRows(rows) {
  const at = (row) => (row.Updated == null ? 0 : row.Updated.getTime());
  rows.sort((a, b) => at(b) - at(a));
}

// Persist the participant summary for rows written before it was cached, so
// later list requests need neither JSON_TABLE nor transcript transfer.
AssistantRepo.prototype.backfillAssistantParticipants = function (rows) {
  const ids = [];
  for (const row of rows) {
    let meta = null;
    try {
      meta = JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8"));
    } catch (err) {
      meta = null;
    }
    if (meta != null && meta.participantsVersion !== 1) {
      ids.push(row.ID);
    }
  }
  let jsonArg = "CAST(? AS JSON)";
  if (this.DB.Dialector.Name() === "sqlite") {
    jsonArg = "json(?)";
  }
  let updated = 0;
  for (let start = 0; start < ids.length; start += 50) {
    const end = Math.min(start + 50, ids.length);
    const full = [];
    const err = this.DB.Table("assistant_sessions").Where("id IN ?", ids.slice(start, end)).Find(full).Error;
    if (err != null) {
      console.log(`assistant participant backfill read failed: ${err}`);
      return updated;
    }
    for (const row of full) {
      const item = decodeAssistantSession(row);
      let unknown = "false";
      if (item.UnknownParticipants) {
        unknown = "true";
      }
      const res = this.DB.Exec("UPDATE assistant_sessions SET payload = JSON_SET(payload, '$.participants', " + jsonArg + ", '$.participantsVersion', 1, '$.unknownParticipants', " + jsonArg + ") WHERE id = ? AND updated_at = ?",
        mustJSON(item.Participants).toString("utf8"), unknown, row.ID, row.Updated);
      if (res.Error != null) {
        console.log(`assistant participant backfill write failed id=${row.ID}: ${res.Error}`);
        continue;
      }
      updated += res.RowsAffected;
    }
  }
  return updated;
};

AssistantRepo.prototype.PutAssistantSession = async function (userID, v) {
  return this.retryAssistantDeadlock(() => this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ?", assistantRecordID(v.ID)).Take(row).Error;
    if (err != null && err !== gorm.ErrRecordNotFound) {
      return err;
    }
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    scoped.DB = tx;
    const base = { ...this.deps, DB: tx };
    scoped.deps = base;
    return scoped.putAssistantSession(userID, v);
  }));
};

// sleepOrAbort：等满毫秒或等到 ctx 取消，对应 Go 的 time.NewTimer + select。
function sleepOrAbort(ctx, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(ctx.reason);
    };
    const cleanup = () => {
      if (ctx instanceof AbortSignal) {
        ctx.removeEventListener("abort", onAbort);
      }
    };
    if (ctx instanceof AbortSignal) {
      if (ctx.aborted) {
        onAbort();
        return;
      }
      ctx.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// retryAssistantDeadlock runs a transaction that locks a possibly missing
// session row. Locking two missing IDs can deadlock their shared InnoDB index
// gap. MySQL has rolled back the entire victim transaction, so retry only that
// explicit error; unknown commit/connection failures are not replayed.
AssistantRepo.prototype.retryAssistantDeadlock = async function (transaction) {
  let err = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    err = await transaction();
    const sqlErr = err instanceof mysqldriver.MySQLError ? err : null;
    if (sqlErr == null || sqlErr.Number !== 1213 || attempt === 5) {
      return err;
    }
    try {
      await sleepOrAbort(this.DB.Statement.Context, (2 ** attempt) * 5);
    } catch (e) {
      return e; // Go：return ctx.Err()
    }
  }
  return err;
};

// SetAssistantSessionGeneratedTitle replaces a new session's prompt title
// with a model summary. A user rename, a fork, or an earlier summary wins.
AssistantRepo.prototype.SetAssistantSessionGeneratedTitle = function (userID, id, title) {
  title = title.trim();
  id = assistantRecordID(id);
  if (userID <= 0 || id === "") {
    return new Error("assistant session id is required");
  }
  const runes = [...title];
  if (runes.length === 0 || runes.length > 36) {
    return new Error("assistant title is invalid");
  }
  return this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ?", id).Take(row).Error;
    if (err != null) {
      return err;
    }
    if (row.UserID !== userID) {
      return new Error("assistant session belongs to another user");
    }
    const item = decodeAssistantSession(row);
    if (item.TitleEdited || item.TitleGenerated || item.ParentSessionID !== "") {
      return null;
    }
    item.Title = title;
    item.TitleGenerated = true;
    item.UpdatedAt = null;
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    scoped.DB = tx;
    const base = { ...this.deps, DB: tx };
    scoped.deps = base;
    return scoped.putAssistantSession(userID, item);
  });
};

AssistantRepo.prototype.putAssistantSession = function (userID, v, ...acceptedRequest) {
  if (userID <= 0) {
    return new Error("assistant session user is required");
  }
  v.ID = assistantRecordID(v.ID);
  if (v.ID === "") {
    return new Error("assistant session id is required");
  }
  const [existing, existingOK] = this.sessionByID(v.ID);
  if (existingOK && existing.UserID !== userID) {
    return new Error("assistant session belongs to another user");
  }
  const [old, exists] = this.AssistantSession(userID, v.ID);
  if (exists) {
    if (old.ProjectID === "" && v.ProjectID.trim() !== "" && (old.WorkspaceRunID !== "" || old.OwnWorkspaceRunIDs.length !== 0)) {
      return ErrAssistantPersonalWorkspaceProject;
    }
    const target = old.Execution();
    if (old.ExecutionLocked() && v.ExecutionTarget != null && (v.ExecutionTarget.Pool !== target.Pool || v.ExecutionTarget.RunnerID !== target.RunnerID)) {
      return ErrAssistantExecutionLocked;
    }
    if (old.ExecutionLocked() || v.ExecutionTarget == null) {
      v.ExecutionTarget = target;
    }
    v.ExecutionTargetLocked = old.ExecutionLocked() || v.ExecutionTargetLocked;
    v.RuntimeMode = old.Mode();
  } else {
    if (v.ExecutionTarget == null) {
      v.ExecutionTarget = new AssistantExecutionTarget({ Pool: ExecutionModeCloud });
    }
    v.RuntimeMode = AssistantModePlatform;
  }

  let now = new Date();
  const [oldAgain, okAgain] = this.AssistantSession(userID, v.ID);
  if (okAgain && oldAgain.CreatedAt != null) {
    v.CreatedAt = oldAgain.CreatedAt;
    const oldUpdatedMs = oldAgain.UpdatedAt == null ? 0 : oldAgain.UpdatedAt.getTime();
    if (!(now.getTime() > oldUpdatedMs)) {
      now = new Date(oldUpdatedMs + 1);
    }
    // Shared project replies are written without a title; keep the
    // one set when the conversation started instead of blanking it.
    if ((oldAgain.TitleEdited && !v.TitleEdited) || v.Title.trim() === "") {
      v.Title = oldAgain.Title;
    }
    // A background summary is not a user rename. Later saves that still
    // carry the original prompt must not put that prompt back.
    if (oldAgain.TitleGenerated && !v.TitleGenerated && !v.TitleEdited) {
      v.Title = oldAgain.Title;
    }
    v.TitleEdited = oldAgain.TitleEdited || v.TitleEdited;
    if (v.TitleEdited) {
      v.TitleGenerated = false;
    } else {
      v.TitleGenerated = oldAgain.TitleGenerated || v.TitleGenerated;
    }
    v.HistoryRevision = oldAgain.HistoryRevision;
    v.ParentSessionID = oldAgain.ParentSessionID;
    v.RootSessionID = oldAgain.RootSessionID;
    v.ForkMessageIndex = oldAgain.ForkMessageIndex;
    if (oldAgain.ParentSessionID !== "" && !v.TitleEdited) {
      v.Title = oldAgain.Title;
    }
    v.IssueID = oldAgain.IssueID;
    v.Archived = oldAgain.Archived;
    v.Shared = oldAgain.Shared;
    // Environment preferences are changed only by the dedicated, locked setter.
    v.SandboxProfileID = oldAgain.SandboxProfileID;
    if (v.WorkspaceRunID === "") {
      v.WorkspaceRunID = oldAgain.WorkspaceRunID;
    }
    v.OwnWorkspaceRunIDs = oldAgain.OwnWorkspaceRunIDs;
    if (v.Source === "") {
      v.Source = oldAgain.Source;
      if (v.Source === "") {
        v.Source = inferredAssistantSessionSource(oldAgain);
      }
    }
    if (v.TaskID === "") {
      v.TaskID = oldAgain.TaskID;
    }
    if (v.WorkflowID === "") {
      v.WorkflowID = oldAgain.WorkflowID;
    }
    if (oldAgain.Shared) {
      v.RunID = oldAgain.RunID;
      v.ProjectID = oldAgain.ProjectID;
      // The first generated title may replace a shared SOP label.
      // Every other write keeps the title already stored.
      if (!(v.TitleGenerated && !oldAgain.TitleGenerated && !oldAgain.TitleEdited)) {
        v.Title = oldAgain.Title;
      }
    }
  } else {
    v.OwnWorkspaceRunIDs = null;
    if (v.CreatedAt == null) {
      v.CreatedAt = now;
    }
  }
  if (v.UpdatedAt == null) {
    v.UpdatedAt = now;
  }
  if (v.Source === "") {
    if (v.Shared && v.RunID !== "") {
      v.Source = AssistantSourceSOP;
    } else {
      v.Source = AssistantSourceChat;
    }
  }
  // Admission receipts are server-owned and survive later transcript writes.
  v.RecentClientRequestIDs = old.RecentClientRequestIDs;
  if (acceptedRequest.length > 0 && acceptedRequest[0] !== "") {
    const maxReceipts = 32;
    let receipts = v.RecentClientRequestIDs;
    if (receipts.length >= maxReceipts) {
      receipts = receipts.slice(receipts.length - maxReceipts + 1);
    }
    v.RecentClientRequestIDs = [...receipts, acceptedRequest[0]];
  }
  v.UserID = userID;
  // The latest reply and its read state are projections for the history
  // list, recomputed on every listing; a saved transcript never stores them.
  v.GenerationID = "";
  v.Unread = false;
  v.ExecutionTargetLocked = v.ExecutionLocked();
  deriveAssistantParticipants(v, v.Messages);
  return upsert(this.DB, "assistant_sessions", {
    id: v.ID,
    user_id: userID,
    project_id: v.ProjectID.trim(),
    title: v.Title.trim(),
    model: v.Model.trim(),
    source: v.Source.trim(),
    task_id: v.TaskID.trim(),
    payload: mustJSON(v),
    created_at: timePtr(v.CreatedAt),
    updated_at: timePtr(v.UpdatedAt),
  });
};

AssistantRepo.prototype.SetAssistantSessionArchived = function (userID, id, archived) {
  return this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", assistantRecordID(id), userID).Take(row).Error;
    if (err != null) {
      return new Error("会话不存在");
    }
    const item = decodeAssistantSession(row);
    item.Archived = archived;
    return tx.Model(new assistantSessionRow()).Where("id = ? AND user_id = ?", row.ID, userID).Update("payload", mustJSON(item)).Error;
  });
};

// SetAssistantSessionWorkspaceRun binds the workspace Main Bot chose for an
// ordinary conversation, recording it among the conversation's own when the
// conversation opened it. Like archiving it leaves updated_at alone, so a
// generation that is still writing this session does not see a conflict.
// projectID is checked under the lock to keep a workspace in its own scope.
AssistantRepo.prototype.SetAssistantSessionWorkspaceRun = function (userID, id, projectID, runID, own) {
  return this.updateAssistantSessionWorkspace(userID, id, projectID, (item) => {
    item.WorkspaceRunID = runID.trim();
    if (own && item.WorkspaceRunID !== "" && !item.OwnWorkspaceRunIDs.includes(item.WorkspaceRunID)) {
      item.OwnWorkspaceRunIDs.push(item.WorkspaceRunID);
    }
  });
};

// RollbackAssistantSessionWorkspaceRun restores the previous binding if the
// failed workspace is still active, and removes it from history if it was
// created by this failed attempt. The two changes share one session lock.
AssistantRepo.prototype.RollbackAssistantSessionWorkspaceRun = function (userID, id, projectID, failedRunID, previousRunID, discardFailedRun) {
  let activeRunID = "";
  const err = this.updateAssistantSessionWorkspace(userID, id, projectID, (item) => {
    if (item.WorkspaceRunID === failedRunID) {
      item.WorkspaceRunID = previousRunID;
    }
    if (discardFailedRun) {
      item.OwnWorkspaceRunIDs = item.OwnWorkspaceRunIDs.filter((runID) => runID !== failedRunID);
    }
    activeRunID = item.WorkspaceRunID;
  });
  if (err != null) {
    throw err;
  }
  return activeRunID;
};

AssistantRepo.prototype.updateAssistantSessionWorkspace = function (userID, id, projectID, update) {
  return this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", assistantRecordID(id), userID).Take(row).Error;
    if (err != null) {
      return new Error("会话不存在");
    }
    const item = decodeAssistantSession(row);
    if (item.ProjectID !== projectID) {
      return ErrAssistantSessionProjectChanged;
    }
    if (item.RunID !== "") {
      return new Error("任务会话直接使用任务工作区");
    }
    update(item);
    return tx.Model(new assistantSessionRow()).Where("id = ? AND user_id = ?", row.ID, userID).Update("payload", mustJSON(item)).Error;
  });
};

AssistantRepo.prototype.DeleteAssistantSession = function (userID, id) {
  const { assistantGenerationRow } = require("./assistant_generations.js"); // 循环引用：调用时现取，不缓存
  const { assistantSessionReadRow } = require("./assistant_session_reads.js"); // 循环引用：调用时现取，不缓存
  id = assistantRecordID(id);
  if (userID <= 0 || id === "") {
    return new Error("assistant session not found");
  }
  return this.DB.Transaction((tx) => {
    const job = new assistantGenerationRow();
    const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ? AND user_id = ?", id, userID).Take(job).Error;
    if (err != null && err !== gorm.ErrRecordNotFound) {
      return err;
    }
    if (err == null && job.Status === "running") {
      return new Error("请先停止生成再删除会话");
    }
    const res = tx.Table("assistant_sessions").Where("id = ? AND user_id = ?", id, userID).Delete(null);
    if (res.Error != null) {
      return res.Error;
    }
    if (res.RowsAffected === 0) {
      return new Error("assistant session not found");
    }
    let deleteErr = tx.Where("session_id = ?", id).Delete(new assistantSessionReadRow()).Error;
    if (deleteErr != null) {
      return deleteErr;
    }
    deleteErr = tx.Where("session_id = ? AND user_id = ?", id, userID).Delete(new assistantDiagnosticsRow()).Error;
    if (deleteErr != null) {
      return deleteErr;
    }
    return tx.Where("session_id = ? AND user_id = ?", id, userID).Delete(new assistantGenerationRow()).Error;
  });
};

AssistantRepo.prototype.AssistantTask = function (userID, id) {
  id = assistantRecordID(id);
  if (userID <= 0 || id === "") {
    return [new AssistantTask(), false];
  }
  const row = new assistantTaskRow();
  const err = this.DB.Table("assistant_tasks").Where("id = ? AND user_id = ?", id, userID).Take(row).Error;
  if (err != null) {
    return [new AssistantTask(), false];
  }
  return [decodeAssistantTask(row), true];
};

AssistantRepo.prototype.ListAssistantTasks = function (userID) {
  if (userID <= 0) {
    return [];
  }
  const rows = [];
  const err = this.DB.Table("assistant_tasks").Where("user_id = ?", userID).Find(rows).Error;
  if (err != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    out.push(decodeAssistantTask(row));
  }
  out.sort((a, b) => (b.UpdatedAt == null ? 0 : b.UpdatedAt.getTime()) - (a.UpdatedAt == null ? 0 : a.UpdatedAt.getTime()));
  return out;
};

AssistantRepo.prototype.EnabledAssistantTasks = function () {
  const rows = [];
  const err = this.DB.Table("assistant_tasks").Where("enabled = ?", 1).Find(rows).Error;
  if (err != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    out.push(decodeAssistantTask(row));
  }
  return out;
};

AssistantRepo.prototype.PutAssistantTask = function (userID, v) {
  if (userID <= 0) {
    return new Error("assistant task user is required");
  }
  v.ID = assistantRecordID(v.ID);
  if (v.ID === "") {
    return new Error("assistant task id is required");
  }
  const [existing, existingOK] = this.taskByID(v.ID);
  if (existingOK && existing.UserID !== userID) {
    return new Error("assistant task belongs to another user");
  }
  return this.DB.Transaction((tx) => {
    const row = new assistantTaskRow();
    let prior = new AssistantTask();
    const err = this.locking(tx).Where("id = ?", v.ID).First(row).Error;
    if (err == null) {
      prior = decodeAssistantTask(row);
      if (prior.UserID !== userID) {
        return new Error("assistant task belongs to another user");
      }
    } else if (err !== gorm.ErrRecordNotFound) {
      return err;
    }
    if (!(prior.LastStatus === "running" && v.LastStatus !== "running")) {
      const validateErr = this.notifications.validateNotificationBindings(tx, v.ProjectID, v.Notifications, true);
      if (validateErr != null) {
        return validateErr;
      }
    }
    v = stampAssistantTask(v, prior, userID, new Date());
    let enabled = 0;
    if (v.Enabled) {
      enabled = 1;
    }
    const upsertErr = upsert(tx, "assistant_tasks", {
      id: v.ID,
      user_id: userID,
      project_id: v.ProjectID.trim(),
      name: v.Name.trim(),
      enabled: enabled,
      interval_sec: v.IntervalSec,
      last_run_at: timePtr(v.LastRunAt),
      payload: mustJSON(v),
      created_at: timePtr(v.CreatedAt),
      updated_at: timePtr(v.UpdatedAt),
    });
    if (upsertErr != null) {
      return upsertErr;
    }
    const [trigger, result, ok] = assistantTaskCompletion(prior, v);
    if (ok) {
      return this.notifications.enqueueTaskNotifications(tx, "assistant_task", v.ID, v.ProjectID, v.Name, trigger, v.LastRunAt, prior.NotificationSnapshot, result, v.LastError);
    }
    return null;
  });
};

// stampAssistantTask fills the server-owned fields of a task about to be
// written: creation time is inherited from the stored row (or defaulted to
// now), the notification snapshot is carried over and refreshed whenever a
// new run starts, the update time defaults to now and the owner is pinned.
function stampAssistantTask(v, prior, userID, now) {
  if (prior.ID !== "") {
    v.CreatedAt = prior.CreatedAt;
  } else if (v.CreatedAt == null) {
    v.CreatedAt = now;
  }
  v.NotificationSnapshot = CloneNotificationBindings(prior.NotificationSnapshot);
  const priorMs = prior.LastRunAt == null ? 0 : prior.LastRunAt.getTime();
  const vMs = v.LastRunAt == null ? 0 : v.LastRunAt.getTime();
  if (v.LastStatus === "running" && (prior.LastStatus !== "running" || priorMs !== vMs)) {
    v.NotificationSnapshot = CloneNotificationBindings(v.Notifications);
  }
  if (v.UpdatedAt == null) {
    v.UpdatedAt = now;
  }
  v.UserID = userID;
  return v;
}

// assistantTaskCompletion reports whether writing v over prior finishes a
// running task, returning the notification trigger and the result text.
function assistantTaskCompletion(prior, v) {
  const trigger = { ok: "succeeded", error: "failed" }[v.LastStatus] ?? "";
  if (prior.ID === "" || prior.LastStatus !== "running" || trigger === "" || v.LastRunAt == null) {
    return ["", "", false];
  }
  let result = v.NotificationResult;
  if (result === "") {
    result = v.LastMessage;
  }
  return [trigger, result, true];
}

AssistantRepo.prototype.DeleteAssistantTask = function (userID, id) {
  id = assistantRecordID(id);
  if (userID <= 0 || id === "") {
    return new Error("assistant task not found");
  }
  const res = this.DB.Table("assistant_tasks").Where("id = ? AND user_id = ?", id, userID).Delete(null);
  if (res.Error != null) {
    return res.Error;
  }
  if (res.RowsAffected === 0) {
    return new Error("assistant task not found");
  }
  return null;
};

AssistantRepo.prototype.sessionByID = function (id) {
  const row = new assistantSessionRow();
  const err = this.DB.Table("assistant_sessions").Where("id = ?", id).Take(row).Error;
  if (err != null) {
    return [new AssistantSession(), false];
  }
  return [decodeAssistantSession(row), true];
};

AssistantRepo.prototype.taskByID = function (id) {
  const row = new assistantTaskRow();
  const err = this.DB.Table("assistant_tasks").Where("id = ?", id).Take(row).Error;
  if (err != null) {
    return [new AssistantTask(), false];
  }
  return [decodeAssistantTask(row), true];
};

function decodeAssistantSession(row) {
  let parsed = {};
  try {
    parsed = JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8"));
  } catch (err) {
    // Go 忽略解码错误。
  }
  const item = new AssistantSession(parsed);
  item.ExecutionTargetLocked = item.ExecutionLocked() || (parsed.executionMessageCount ?? 0) > 0;
  item.ID = row.ID;
  item.UserID = row.UserID;
  if (item.ExecutionTarget == null) {
    item.ExecutionTarget = new AssistantExecutionTarget({ Pool: ExecutionModeCloud });
  }
  if (item.RuntimeMode === "") {
    item.RuntimeMode = AssistantModePlatform;
  }
  if (item.ProjectID === "") {
    item.ProjectID = row.ProjectID;
  }
  if (item.Title === "") {
    item.Title = row.Title;
  }
  if (item.Model === "") {
    item.Model = row.Model;
  }
  if (item.Source === "") {
    item.Source = row.Source;
  }
  if (item.TaskID === "") {
    item.TaskID = row.TaskID;
  }
  if (item.CreatedAt == null && row.Created != null) {
    item.CreatedAt = row.Created;
  }
  if (row.Updated != null) {
    item.UpdatedAt = row.Updated;
  }
  if (item.Messages != null) {
    deriveAssistantParticipants(item, item.Messages);
  } else if (item.ParticipantsVersion !== 1) {
    deriveAssistantParticipants(item, parsed.participantSummaryMessages ?? []);
  }
  return item;
}

function decodeAssistantTask(row) {
  let parsed = {};
  try {
    parsed = JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8"));
  } catch (err) {
    // Go 忽略解码错误。
  }
  const item = new AssistantTask(parsed);
  item.ID = row.ID;
  item.UserID = row.UserID;
  if (item.ProjectID === "") {
    item.ProjectID = row.ProjectID;
  }
  if (item.Name === "") {
    item.Name = row.Name;
  }
  if (item.IntervalSec === 0) {
    item.IntervalSec = row.IntervalSec;
  }
  item.Enabled = row.Enabled === 1;
  if (item.LastRunAt == null && row.LastRunAt != null) {
    item.LastRunAt = row.LastRunAt;
  }
  if (item.CreatedAt == null && row.Created != null) {
    item.CreatedAt = row.Created;
  }
  if (row.Updated != null) {
    item.UpdatedAt = row.Updated;
  }
  return item;
}

AssistantRepo.prototype.AssistantTaskExists = function (projectID, id) {
  let count = 0;
  const err = this.DB.Model(new assistantTaskRow()).Where("id = ? AND project_id = ?", id, projectID).Count(count).Error;
  return err == null && count > 0;
};

module.exports = { ErrAssistantPersonalWorkspaceProject, assistantRecordID, AssistantTitleFromMessages, sortAssistantSessionRows, stampAssistantTask, assistantTaskCompletion, decodeAssistantSession, decodeAssistantTask, sleepOrAbort };
