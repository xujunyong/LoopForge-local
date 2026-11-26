// assistant_cli_notice.js —— 对应 Go 文件：internal/repo/assistant_cli_notice.go
// 作用：CLI 装好后，改写会话里残留的“未安装”失败文案。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { decodeAssistantSession } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 本次一同翻译
const { decodeGeneration, assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包函数与类型，assistant_generations.js 本次一同翻译
const { assistantSessionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// ReplaceInstalledCLIFailure rewrites the failure a conversation kept while a
// CLI was absent. The install keeps running after the browser leaves, so the
// stored "not installed" or generic generation failure has to change with it.
// missing is the sentence for this engine. generic is replaced only when the
// conversation was using that engine.
AssistantRepo.prototype.ReplaceInstalledCLIFailure = function (engine, missing, generic, next) {
  engine = engine.trim();
  missing = missing.trim();
  next = next.trim();
  if (this == null || this.DB == null || engine === "" || missing === "" || next === "") {
    return null;
  }
  const err = this.replaceGenerationCLIFailure(engine, missing, generic, next);
  if (err != null) {
    return err;
  }
  return this.replaceSessionCLIFailure(engine, missing, generic, next);
};

// Both rewrites only use the first query to find candidates. Each row is then
// re-read under a row lock in its own transaction and only the stored failure
// is changed, so a message, rename or sandbox switch that landed while the
// install ran is kept instead of being overwritten by a stale snapshot.
AssistantRepo.prototype.replaceGenerationCLIFailure = function (engine, missing, generic, next) {
  const rows = [];
  const query = wherePayloadHas(this.DB.Select("session_id", "generation_id").Where("status <> ?", "running"), this.DB, missing, generic);
  const err = query.Find(rows).Error;
  if (err != null) {
    return err;
  }
  for (const candidate of rows) {
    const sameEngine = this.sessionUsesEngine(candidate.SessionID, engine);
    const txErr = this.DB.Transaction((tx) => {
      const row = new assistantGenerationRow();
      let err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ? AND generation_id = ? AND status <> ?", candidate.SessionID, candidate.GenerationID, "running").Take(row).Error;
      if (err === gorm.ErrRecordNotFound) {
        return null;
      }
      if (err != null) {
        return err;
      }
      const g = decodeGeneration(row);
      let msg = g.Error;
      if (msg === "" && g.Failure != null) {
        msg = g.Failure.Message;
      }
      if (!cliFailureMatches(msg, missing, generic, sameEngine) && !(sameEngine && g.Failure != null && g.Failure.Code === "GENERATION_FAILED")) {
        return null;
      }
      g.Error = next;
      g.Failure = null;
      return tx.Model(new assistantGenerationRow()).Where("session_id = ? AND generation_id = ?", row.SessionID, row.GenerationID).Update("payload", mustJSON(g)).Error;
    });
    if (txErr != null) {
      return txErr;
    }
  }
  return null;
};

AssistantRepo.prototype.replaceSessionCLIFailure = function (engine, missing, generic, next) {
  const rows = [];
  const query = wherePayloadHas(this.DB.Table("assistant_sessions").Select("id"), this.DB, missing, generic);
  const err = query.Find(rows).Error;
  if (err != null) {
    return err;
  }
  for (const candidate of rows) {
    const txErr = this.DB.Transaction((tx) => {
      const row = new assistantSessionRow();
      let err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ?", candidate.ID).Take(row).Error;
      if (err === gorm.ErrRecordNotFound) {
        return null;
      }
      if (err != null) {
        return err;
      }
      const item = decodeAssistantSession(row);
      if (!rewriteCLIFailureMessages(item, missing, generic, next, sessionUsesEngine(item, engine))) {
        return null;
      }
      return tx.Model(new assistantSessionRow()).Where("id = ? AND user_id = ?", row.ID, row.UserID).Update("payload", mustJSON(item)).Error;
    });
    if (txErr != null) {
      return txErr;
    }
  }
  return null;
};

// wherePayloadHas matches JSON payloads that contain the failure text.
// LIKE does not see the sqlite JSON blob, so both drivers search the cast text.
function wherePayloadHas(query, db, missing, generic) {
  let expr = "instr(CAST(payload AS TEXT), ?) > 0";
  if (db.Dialector.Name() === "mysql") {
    expr = "INSTR(CAST(payload AS CHAR), ?) > 0";
  }
  if (generic.trim() === "") {
    return query.Where(expr, missing);
  }
  return query.Where(expr + " OR " + expr, missing, generic);
}

AssistantRepo.prototype.sessionUsesEngine = function (sessionID, engine) {
  const row = new assistantSessionRow();
  const err = this.DB.Table("assistant_sessions").Where("id = ?", sessionID).Take(row).Error;
  if (err != null) {
    return false;
  }
  return sessionUsesEngine(decodeAssistantSession(row), engine);
};

function sessionUsesEngine(item, engine) {
  if (item.Executor.trim() === engine) {
    return true;
  }
  const model = item.Model.trim();
  return model === engine || model.startsWith(engine + ":");
}

function cliFailureMatches(text, missing, generic, sameEngine) {
  text = text.trim();
  if (text === "") {
    return false;
  }
  if (text === missing) {
    return true;
  }
  return sameEngine && generic !== "" && text === generic;
}

function rewriteCLIFailureMessages(item, missing, generic, next, sameEngine) {
  let changed = false;
  for (let i = 0; i < item.Messages.length; i++) {
    const m = item.Messages[i];
    const matched = cliFailureMatches(m.Unfinished, missing, generic, sameEngine) ||
      (m.Failure != null && (cliFailureMatches(m.Failure.Message, missing, generic, sameEngine) || (sameEngine && m.Failure.Code === "GENERATION_FAILED")));
    if (!matched) {
      continue;
    }
    m.Unfinished = next;
    m.Failure = null;
    changed = true;
  }
  return changed;
}

module.exports = { wherePayloadHas, sessionUsesEngine, cliFailureMatches, rewriteCLIFailureMessages };
