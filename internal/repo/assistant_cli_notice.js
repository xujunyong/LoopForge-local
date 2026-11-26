/**
 * @file internal/repo/assistant_cli_notice.js
 * 对应 Go 源文件：internal/repo/assistant_cli_notice.go
 *
 * 作用与职责边界：
 * 当某款 CLI 引擎在后台安装完成后，扫描并原地改写历史生成记录（`assistant_generations`）与会话消息（`assistant_sessions`）中残留的
 * “CLI 未安装”或该引擎对应的通用失败提示文案，替换为新的可重试提示。
 *
 * 语法差异说明：
 * - Go 仅返回 `error` 的方法统一按成功无返回值（`undefined`）、失败 `throw err` 处理；`db.Transaction` 回调同样失败抛错、成功正常返回。
 * - Go 的 `errors.Is` 译为 `===`，`gorm` 链式查询按原样保留。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { decodeAssistantSession } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 本次一同翻译
const { decodeGeneration, assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包函数与类型，assistant_generations.js 本次一同翻译
const { assistantSessionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

/**
 * 将因 CLI 尚未安装而留存在生成记录和会话历史中的失败提示统一改写为安装完成后的新提示文案。
 * `missing` 是针对当前引擎的“未安装”提示句；`generic` 仅在会话确实使用该引擎时才会被替换。
 *
 * @param {string} engine - 已完成安装的 CLI 引擎标识（如 `"codex"`、`"claude"`）。
 * @param {string} missing - 对应引擎未安装时的精确提示文案。
 * @param {string} generic - 通用的生成失败兜底文案（可为空）。
 * @param {string} next - 替换后的新提示文案。
 * @returns {void} 无返回值。
 * @throws {Error} 扫描或事务更新生成记录、会话记录失败时抛出错误。
 */
AssistantRepo.prototype.ReplaceInstalledCLIFailure = function (engine, missing, generic, next) {
  engine = engine.trim();
  missing = missing.trim();
  next = next.trim();
  if (this == null || this.DB == null || engine === "" || missing === "" || next === "") {
    return;
  }
  this.replaceGenerationCLIFailure(engine, missing, generic, next);
  this.replaceSessionCLIFailure(engine, missing, generic, next);
};

/**
 * 筛选并逐行加锁更新包含旧失败文案的非运行中生成记录，将其错误文本改写为 `next` 并清空结构化失败详情。
 * 先以轻量查询定位候选行，再在独立事务内加行锁重读后仅修改失败字段，避免覆盖安装期间并发写入的新数据。
 *
 * @param {string} engine - 已安装的 CLI 引擎标识。
 * @param {string} missing - 引擎未安装提示文案。
 * @param {string} generic - 通用生成失败文案。
 * @param {string} next - 替换后的新提示文案。
 * @returns {void} 无返回值。
 * @throws {Error} 候选查询或事务更新失败时抛出错误。
 */
AssistantRepo.prototype.replaceGenerationCLIFailure = function (engine, missing, generic, next) {
  const rows = [];
  const query = wherePayloadHas(this.DB.Select("session_id", "generation_id").Where("status <> ?", "running"), this.DB, missing, generic);
  const err = query.Find(rows).Error;
  if (err != null) {
    throw err;
  }
  for (const candidate of rows) {
    const sameEngine = this.sessionUsesEngine(candidate.SessionID, engine);
    this.DB.Transaction((tx) => {
      const row = new assistantGenerationRow();
      const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ? AND generation_id = ? AND status <> ?", candidate.SessionID, candidate.GenerationID, "running").Take(row).Error;
      if (err === gorm.ErrRecordNotFound) {
        return;
      }
      if (err != null) {
        throw err;
      }
      const g = decodeGeneration(row);
      let msg = g.Error;
      if (msg === "" && g.Failure != null) {
        msg = g.Failure.Message;
      }
      if (!cliFailureMatches(msg, missing, generic, sameEngine) && !(sameEngine && g.Failure != null && g.Failure.Code === "GENERATION_FAILED")) {
        return;
      }
      g.Error = next;
      g.Failure = null;
      const updateErr = tx.Model(new assistantGenerationRow()).Where("session_id = ? AND generation_id = ?", row.SessionID, row.GenerationID).Update("payload", mustJSON(g)).Error;
      if (updateErr != null) {
        throw updateErr;
      }
    });
  }
};

/**
 * 筛选并逐行加锁更新包含旧失败文案的会话记录，改写其消息数组中匹配的未完成失败提示。
 * 同样采用“先查候选 ID、再在独立行锁事务中重读并局部修改”的策略以防并发覆盖。
 *
 * @param {string} engine - 已安装的 CLI 引擎标识。
 * @param {string} missing - 引擎未安装提示文案。
 * @param {string} generic - 通用生成失败文案。
 * @param {string} next - 替换后的新提示文案。
 * @returns {void} 无返回值。
 * @throws {Error} 候选查询或事务更新失败时抛出错误。
 */
AssistantRepo.prototype.replaceSessionCLIFailure = function (engine, missing, generic, next) {
  const rows = [];
  const query = wherePayloadHas(this.DB.Table("assistant_sessions").Select("id"), this.DB, missing, generic);
  const err = query.Find(rows).Error;
  if (err != null) {
    throw err;
  }
  for (const candidate of rows) {
    this.DB.Transaction((tx) => {
      const row = new assistantSessionRow();
      const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ?", candidate.ID).Take(row).Error;
      if (err === gorm.ErrRecordNotFound) {
        return;
      }
      if (err != null) {
        throw err;
      }
      const item = decodeAssistantSession(row);
      if (!rewriteCLIFailureMessages(item, missing, generic, next, sessionUsesEngine(item, engine))) {
        return;
      }
      const updateErr = tx.Model(new assistantSessionRow()).Where("id = ? AND user_id = ?", row.ID, row.UserID).Update("payload", mustJSON(item)).Error;
      if (updateErr != null) {
        throw updateErr;
      }
    });
  }
};

/**
 * 为 GORM 查询附加匹配 JSON `payload` 中是否包含指定失败文案的条件。
 * 由于 SQLite 的 `LIKE` 无法直接检索 JSON 二进制块，MySQL 与 SQLite 均先将 `payload` 转为文本后再做子串查找。
 *
 * @param {object} query - 待追加条件的 `gorm.DB` 查询构造器。
 * @param {object} db - 用于判断当前数据库方言的 `gorm.DB` 实例。
 * @param {string} missing - 必选的未安装失败提示文案。
 * @param {string} generic - 可选的通用失败提示文案。
 * @returns {object} 追加 `WHERE` 条件后的 `gorm.DB` 查询构造器。
 */
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

/**
 * 根据会话 ID 读取会话并判断该会话是否使用指定的 CLI 引擎。
 *
 * @param {string} sessionID - 会话 ID。
 * @param {string} engine - 目标 CLI 引擎名称。
 * @returns {boolean} 若会话存在且使用该引擎返回 `true`，否则返回 `false`。
 */
AssistantRepo.prototype.sessionUsesEngine = function (sessionID, engine) {
  const row = new assistantSessionRow();
  const err = this.DB.Table("assistant_sessions").Where("id = ?", sessionID).Take(row).Error;
  if (err != null) {
    return false;
  }
  return sessionUsesEngine(decodeAssistantSession(row), engine);
};

/**
 * 判断给定会话对象配置的执行器或模型前缀是否匹配指定引擎名称。
 *
 * @param {object} item - 解码后的助手会话对象（`domain.AssistantSession` 实例）。
 * @param {string} engine - 目标 CLI 引擎名称。
 * @returns {boolean} 匹配时返回 `true`，否则返回 `false`。
 */
function sessionUsesEngine(item, engine) {
  if (item.Executor.trim() === engine) {
    return true;
  }
  const model = item.Model.trim();
  return model === engine || model.startsWith(engine + ":");
}

/**
 * 判断一条失败文本是否命中“未安装”精确文案，或在同引擎前提下命中通用失败文案。
 *
 * @param {string} text - 待检测的失败文案。
 * @param {string} missing - 引擎未安装提示文案。
 * @param {string} generic - 通用生成失败文案。
 * @param {boolean} sameEngine - 当前记录所属会话是否使用该引擎。
 * @returns {boolean} 命中替换条件返回 `true`，否则返回 `false`。
 */
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

/**
 * 遍历会话的所有消息，将命中旧 CLI 失败条件的未完成提示原地改写为 `next` 并清空 `Failure` 对象。
 *
 * @param {object} item - 待原地修改消息的助手会话对象（`domain.AssistantSession` 实例）。
 * @param {string} missing - 引擎未安装提示文案。
 * @param {string} generic - 通用生成失败文案。
 * @param {string} next - 替换后的新提示文案。
 * @param {boolean} sameEngine - 该会话是否使用本次安装的引擎。
 * @returns {boolean} 若至少改写了一条消息返回 `true`，未发生改动返回 `false`。
 */
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
