/**
 * @file internal/repo/assistant_attachment_refs.js
 * 对应 Go 源文件：internal/repo/assistant_attachment_refs.go
 *
 * 作用与职责边界：
 * 提供助手附件与会话存在性的批量引用检查方法：查询哪些附件 ID 仍被会话记录或待完成生成记录引用（供垃圾回收使用），
 * 以及批量检查一组会话 ID 中哪些会话仍然存在（供前端展示跳转链接时使用）。
 *
 * 语法差异说明：
 * - Go 的 `map[string]bool` 统一译为普通对象 `{}`。
 * - Go 的 `(map[string]bool, error)` 按成功返回对象、失败 `throw err` 处理。
 */

"use strict";

const { payloadMentions } = require("./payload_mentions.js"); // 对应 Go 同包函数，payload_mentions.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

/**
 * 批量检查给定附件 ID 中哪些仍被任意会话消息历史或进行中的生成记录引用。
 * 分支会话会继承分叉点之前的附件引用；内部每次调用按 64 个 ID 分批扫描两张表，适合删除会话后的批量附件清理。
 *
 * @param {string[]} ids - 待检查的附件 ID 列表。
 * @returns {Object.<string, boolean>} 仍在使用中的附件 ID 集合映射（键为附件 ID，值为 `true`）。
 * @throws {Error} 扫描 `assistant_sessions` 或 `assistant_generations` 表失败时抛出错误。
 */
AssistantRepo.prototype.AssistantAttachmentsInUse = function (ids) {
  const inUse = payloadMentions(this.DB, "assistant_sessions", ids);
  const pending = payloadMentions(this.DB, "assistant_generations", ids);
  for (const id of Object.keys(pending)) {
    inUse[id] = true;
  }
  return inUse;
};

/**
 * 批量检查给定会话 ID 列表中哪些仍对应有效的会话记录（会话 ID 在所有用户之间全局唯一）。
 * 按 500 个 ID 一批查询数据库；若某批查询失败，按保守策略将该批 ID 标记为存在以保留链接入口。
 *
 * @param {string[]} ids - 待核验的会话 ID 列表。
 * @returns {Object.<string, boolean>} 去重且去空白后的会话 ID 存在性映射（存在或查询未知时为 `true`，已删除为 `false`）。
 */
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
      // 查询出错无法确定已删除：保守视为仍存在，继续展示链接。
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
