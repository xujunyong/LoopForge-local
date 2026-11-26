// assistant_shared.js —— 对应 Go 文件：internal/repo/assistant_shared.go
// 作用：SOP 运行共享会话的创建、读取与分支、改写时的乐观锁校验。

"use strict";

const { createHash } = require("node:crypto");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { AssistantSession, AssistantSourceSOP, AssistantSourceSOPDesigner } = require("../domain/assistant.js"); // 对应 Go 同包类型与常量，assistant.js 已翻译
const { decodeAssistantSession, assistantRecordID } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 本次一同翻译
const { deriveAssistantParticipants } = require("./assistant_context.js"); // 对应 Go 同包函数，assistant_context.js 本次一同翻译
const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 本次一同翻译
const { assistantSessionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

function RunAssistantSessionID(runID) {
  const sum = createHash("sha256").update(runID, "utf8").digest();
  return "sop-" + sum.subarray(0, 20).toString("hex");
}

AssistantRepo.prototype.SharedAssistantSession = function (id) {
  const row = new assistantSessionRow();
  if (this.DB.Where("id = ?", id).Take(row).Error != null) {
    return [new AssistantSession(), false];
  }
  const item = decodeAssistantSession(row);
  return [item, validSharedAssistantSession(item)];
};

AssistantRepo.prototype.EnsureRunAssistantSession = function (runID, projectID, title, userID, ...execution) {
  const id = RunAssistantSessionID(runID);
  const [item, ok] = this.SharedAssistantSession(id);
  if (ok) {
    return [item, null];
  }
  const now = new Date();
  // Go 的 AssistantSession{...} 结构体字面量，JS 用构造器传同名字段。
  const session = new AssistantSession({ ID: id, RunID: runID, ProjectID: projectID, Title: title, UserID: userID, Shared: true, Source: AssistantSourceSOP, CreatedAt: now, UpdatedAt: now });
  // Existing task discussions become the initial shared transcript, preserving authors.
  let rows = [];
  const err = this.DB.Where("project_id = ?", projectID).Where(this.sqlJSONText("$.runId") + " = ?", "$.runId", runID).Order("created_at ASC").Find(rows).Error;
  if (err != null) {
    return [session, err];
  }
  for (const row of rows) {
    const old = decodeAssistantSession(row);
    if (old.RunID !== runID || old.Shared) {
      continue;
    }
    for (let message of old.Messages) {
      // Go 的 range 变量是值拷贝，JS 用展开复制保持一致。
      message = { ...message };
      if (message.Role === "user" && message.AuthorID === 0) {
        message.AuthorID = old.UserID;
        message.AuthorName = `用户 ${old.UserID}`;
        const [u, found] = this.users.User(old.UserID);
        if (found) {
          message.AuthorName = u.LoginName;
        }
      }
      session.Messages.push(message);
    }
  }
  // Legacy transcripts keep the cloud binding. Only a newly opened run
  // conversation inherits the already frozen execution target of its run.
  if (rows.length === 0 && execution.length > 0) {
    const target = execution[0];
    session.ExecutionTarget = target;
  }
  deriveAssistantParticipants(session, session.Messages);
  const row = new assistantSessionRow({ ID: id, UserID: userID, ProjectID: projectID, Title: title, Source: session.Source, TaskID: session.TaskID, Payload: mustJSON(session), Created: now, Updated: now });
  const createErr = this.DB.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
  if (createErr != null) {
    return [session, createErr];
  }
  const [saved, savedOk] = this.SharedAssistantSession(id);
  if (!savedOk) {
    return [session, new Error("shared session unavailable")];
  }
  return [saved, null];
};

AssistantRepo.prototype.ListSharedAssistantSessions = function () {
  const [rows, err] = this.findAssistantSessionSummaries("id LIKE ?", "sop-%");
  if (err != null) {
    console.log(`shared assistant session list failed: ${err}`);
    return null;
  }
  const out = [];
  for (const row of rows) {
    const item = decodeAssistantSession(row);
    if (validSharedAssistantSession(item)) {
      item.Messages = null;
      out.push(item);
    }
  }
  return out;
};

// ListCrossUserAssistantSessions returns, in one query, SOP shared sessions
// and project-shared conversations created by other users. The HTTP layer
// filters both by project membership.
AssistantRepo.prototype.ListCrossUserAssistantSessions = function (excludeUserID) {
  const [rows, err] = this.findAssistantSessionSummaries("id LIKE ? OR (user_id <> ? AND project_id <> ?)", "sop-%", excludeUserID, "");
  if (err != null) {
    console.log(`cross-user assistant session list failed: ${err}`);
    return [null, null];
  }
  let shared = [];
  let project = [];
  for (const row of rows) {
    const item = decodeAssistantSession(row);
    item.Messages = null;
    if (item.ID.startsWith("sop-")) {
      if (validSharedAssistantSession(item)) {
        shared.push(item);
      }
    } else if (item.UserID !== excludeUserID && ProjectSharedAssistantSession(item)) {
      project.push(item);
    }
  }
  return [shared, project];
};

AssistantRepo.prototype.PutSharedAssistantReceipt = function (userID, next, expected) {
  return this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const takeErr = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", next.ID, userID).Take(row).Error;
    if (takeErr != null) {
      return takeErr;
    }
    const old = decodeAssistantSession(row);
    const a = JSON.stringify(old.Messages);
    const b = JSON.stringify(expected.Messages);
    const oldMs = old.UpdatedAt == null ? 0 : old.UpdatedAt.getTime();
    const expectedMs = expected.UpdatedAt == null ? 0 : expected.UpdatedAt.getTime();
    if (!(old.Shared || ProjectSharedAssistantSession(old)) || oldMs !== expectedMs || a !== b) {
      return new Error("共享会话已更新，请重新打开");
    }
    let active = 0;
    const countErr = tx.Model(new assistantGenerationRow()).Where("session_id = ? AND status = ?", next.ID, "running").Count(active).Error;
    if (countErr != null) {
      return countErr;
    }
    if (active > 0) {
      return new Error("生成期间不能改写会话");
    }
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    scoped.DB = tx;
    const base = { ...this.deps, DB: tx };
    scoped.deps = base;
    next.UpdatedAt = null;
    return scoped.putAssistantSession(userID, next);
  });
};

function validSharedAssistantSession(s) {
  const root = RunAssistantSessionID(s.RunID);
  return s.Shared && s.RunID !== "" && (s.ID === root || (s.ParentSessionID !== "" && s.RootSessionID === root && s.ID.startsWith("sop-branch-")));
}

// ProjectSharedAssistantSession reports whether an ordinary conversation is
// shared with its project's members. SOP run sessions keep their own rules;
// legacy per-user run discussions stay private. A SOP designer conversation
// stays private to its author too: it edits one person's unsaved canvas and
// is not a project discussion.
function ProjectSharedAssistantSession(s) {
  return !s.Shared && s.RunID === "" && s.ProjectID.trim() !== "" && !s.ID.startsWith("sop-") && s.Source !== AssistantSourceSOPDesigner;
}

const assistantSessionMetadataColumns = "id, user_id, project_id, title, model, source, task_id, created_at, updated_at, JSON_REMOVE(payload, '$.messages') AS payload";

// ProjectAssistantSession returns the metadata of a project-shared
// conversation regardless of who created it. Callers must authorize the
// project before exposing or writing the conversation.
AssistantRepo.prototype.ProjectAssistantSession = function (id) {
  id = assistantRecordID(id);
  if (id === "" || id.startsWith("sop-")) {
    return [new AssistantSession(), false];
  }
  const row = new assistantSessionRow();
  if (this.DB.Table("assistant_sessions").Select(assistantSessionMetadataColumns).Where("id = ?", id).Take(row).Error != null) {
    return [new AssistantSession(), false];
  }
  const item = decodeAssistantSession(row);
  return [item, ProjectSharedAssistantSession(item)];
};

// Freeze the source under its generation lock; a branch never overwrites it.
AssistantRepo.prototype.CreateAssistantSessionBranch = function (source, branch) {
  return this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const takeErr = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", source.ID, source.UserID).Take(row).Error;
    if (takeErr != null) {
      return takeErr;
    }
    const old = decodeAssistantSession(row);
    const oldMs = old.UpdatedAt == null ? 0 : old.UpdatedAt.getTime();
    const sourceMs = source.UpdatedAt == null ? 0 : source.UpdatedAt.getTime();
    if (oldMs !== sourceMs) {
      return new Error("原会话已更新，请重新打开后编辑");
    }
    let active = 0;
    const countErr = tx.Model(new assistantGenerationRow()).Where("session_id = ? AND status = ?", source.ID, "running").Count(active).Error;
    if (countErr != null) {
      return countErr;
    }
    if (active > 0) {
      return new Error("请先停止原会话的生成，再创建分支");
    }
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    scoped.DB = tx;
    const base = { ...this.deps, DB: tx };
    scoped.deps = base;
    const target = old.Execution();
    branch.ExecutionTarget = target;
    return scoped.putAssistantSession(branch.UserID, branch);
  });
};

// ReplaceAssistantTurn edits a turn under the same lock as generation startup.
// Shared conversations keep their ID and owner; author attribution is per turn.
AssistantRepo.prototype.ReplaceAssistantTurn = function (source, index, edited, ...target) {
  return this.DB.Transaction((tx) => {
    const row = new assistantSessionRow();
    const takeErr = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", source.ID, source.UserID).Take(row).Error;
    if (takeErr != null) {
      return takeErr;
    }
    let old = decodeAssistantSession(row);
    const oldMs = old.UpdatedAt == null ? 0 : old.UpdatedAt.getTime();
    const sourceMs = source.UpdatedAt == null ? 0 : source.UpdatedAt.getTime();
    if (oldMs !== sourceMs) {
      return new Error("会话已更新，请重新打开后编辑");
    }
    if (index < 0 || index >= old.Messages.length || old.Messages[index].Role !== "user") {
      return new Error("请选择用户消息");
    }
    let active = 0;
    const countErr = tx.Model(new assistantGenerationRow()).Where("session_id = ? AND status = ?", source.ID, "running").Count(active).Error;
    if (countErr != null) {
      return countErr;
    }
    if (active > 0) {
      return new Error("请先停止生成再编辑消息");
    }
    if (old.ParentSessionID !== "" && old.Executor === "") {
      old.Executor = source.Executor;
    }
    const prefix = [...old.Messages.slice(0, index)];
    if (target.length > 0) {
      if (!source.Shared || source.RunID !== target[0].RunID || source.RootSessionID !== target[0].ID) {
        return new Error("无权覆盖主会话");
      }
      const main = new assistantSessionRow();
      const mainTakeErr = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ? AND user_id = ?", target[0].ID, target[0].UserID).Take(main).Error;
      if (mainTakeErr != null) {
        return mainTakeErr;
      }
      old = decodeAssistantSession(main);
      const mainOldMs = old.UpdatedAt == null ? 0 : old.UpdatedAt.getTime();
      const targetMs = target[0].UpdatedAt == null ? 0 : target[0].UpdatedAt.getTime();
      if (mainOldMs !== targetMs) {
        return new Error("主会话已更新，请重新打开");
      }
      const mainCountErr = tx.Model(new assistantGenerationRow()).Where("session_id = ? AND status = ?", old.ID, "running").Count(active).Error;
      if (mainCountErr != null) {
        return mainCountErr;
      }
      if (active > 0) {
        return new Error("请先停止主会话生成");
      }
    }
    old.Messages = [...prefix, edited];
    old.UpdatedAt = null;
    const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    scoped.DB = tx;
    const base = { ...this.deps, DB: tx };
    scoped.deps = base;
    const putErr = scoped.putAssistantSession(old.UserID, old);
    if (putErr != null) {
      return putErr;
    }
    const [saved, savedOk] = scoped.AssistantSession(old.UserID, old.ID);
    if (!savedOk) {
      return new Error("无法读取更新后的会话");
    }
    saved.HistoryRevision++;
    return tx.Model(new assistantSessionRow()).Where("id = ? AND user_id = ?", saved.ID, saved.UserID).Update("payload", mustJSON(saved)).Error;
  });
};

module.exports = { RunAssistantSessionID, ProjectSharedAssistantSession };
