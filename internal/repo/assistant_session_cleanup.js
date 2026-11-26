/**
 * @file internal/repo/assistant_session_cleanup.js
 * 对应 Go 源文件：internal/repo/assistant_session_cleanup.go
 *
 * 作用与职责边界：
 * 提供面向会话清理与来源归类场景的查询和推断能力：按来源或关联任务列出会话元数据、
 * 列出全部会话 ID，以及在历史行缺少 `source` 列时为单条重写会话推断其原始来源。
 * 不负责实际的删除执行或启动期批量数据回填。
 *
 * 语法差异说明：
 * - Go `([]string, error)` 译为成功返回数组、失败 `throw err`；调用 `findAssistantSessionSummaries` 通过 `try / catch` 捕获错误并降级返回空数组。
 * - 为避免与 `assistant.js` 的模块循环引用，`decodeAssistantSession` 在函数体内延迟 `require`。
 */

"use strict";

const { AssistantSourceSOP, AssistantSourceScheduled, AssistantSourceChat } = require("../domain/assistant.js"); // 对应 Go 同包常量，assistant.js 已翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// 在引入 `source` 列之前，定时任务创建的会话标题所使用的固定前缀。
const scheduledAssistantTitlePrefix = "定时 · ";

/**
 * 按会话来源（如 `chat`、`sop`、`scheduled`）返回对应会话的元数据列表。
 * 对话正文留在数据库中，返回结果的 `Messages` 均置为 `null`。
 *
 * @param {string} source - 会话来源标识。
 * @returns {Array<Object>} 符合来源条件的会话元数据列表（`AssistantSession[]`）；来源为空时返回空数组。
 */
AssistantRepo.prototype.ListAssistantSessionsBySource = function (source) {
  source = source.trim();
  if (source === "") {
    return [];
  }
  return this.assistantSessionsBy("source = ?", source);
};

/**
 * 列出数据库中全部已存储的助手会话 ID。
 * 常用于离线清理任务扫描孤立工作区或附件引用。
 *
 * @returns {Array<string>} 全部会话 ID 列表。
 * @throws {Error} 当数据库查询出错时抛出错误。
 */
AssistantRepo.prototype.AssistantSessionIDs = function () {
  const ids = [];
  const err = this.DB.Table("assistant_sessions").Pluck("id", ids).Error;
  if (err != null) {
    throw err;
  }
  return ids;
};

/**
 * 按来源与任务 ID 列出由某定时任务或助手任务生成的全部会话元数据。
 * 供新一轮任务执行后保留自身会话并清理历史旧会话时使用。
 *
 * @param {string} source - 会话来源标识。
 * @param {string} taskID - 关联的任务 ID。
 * @returns {Array<Object>} 符合条件的会话元数据列表（`AssistantSession[]`）；任一参数为空时返回空数组。
 */
AssistantRepo.prototype.ListAssistantSessionsByTask = function (source, taskID) {
  source = source.trim();
  taskID = taskID.trim();
  if (source === "" || taskID === "") {
    return [];
  }
  return this.assistantSessionsBy("source = ? AND task_id = ?", source, taskID);
};

/**
 * 按自定义 SQL 条件查询会话摘要行并解码为不含消息正文的 `AssistantSession` 列表。
 * 查询失败时记录日志并降级返回空数组。
 *
 * @param {string} where - GORM `Where` 条件模板字符串。
 * @param {...*} args - 绑定到 `where` 占位符的查询参数列表。
 * @returns {Array<Object>} 解码后的会话元数据列表（每项 `Messages` 为 `null`）。
 */
AssistantRepo.prototype.assistantSessionsBy = function (where, ...args) {
  const { decodeAssistantSession } = require("./assistant.js"); // 循环引用：调用时现取，不缓存
  let rows;
  try {
    rows = this.findAssistantSessionSummaries(where, ...args);
  } catch (err) {
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

/**
 * 为尚未写入 `source` 列的历史单条会话推断原始来源，防止续写旧对话时将其误重置为普通对话。
 * 仅在单行写入路径使用；历史存量行的批量回填由独立 SQL 迁移脚本人工执行，不在代码中自动迁移。
 *
 * @param {Object} item - 已解码的会话领域对象（`AssistantSession`）。
 * @returns {string} 推断得到的会话来源常量（原 `Source`、`AssistantSourceSOP`、`AssistantSourceScheduled` 或 `AssistantSourceChat`）。
 */
function inferredAssistantSessionSource(item) {
  const source = item.Source.trim();
  if (source !== "") {
    return source;
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
