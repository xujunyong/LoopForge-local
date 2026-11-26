/**
 * @file internal/repo/payload_mentions.js
 * 对应 Go 源文件：internal/repo/payload_mentions.go
 *
 * 作用与职责边界：
 * 提供跨数据库方言（SQLite / MySQL）的通用引用扫描工具 `payloadMentions`，
 * 分批检查一组目标 ID 是否出现在指定表的 JSON `payload` 列中，供附件垃圾回收或删除前的引用保护使用。
 * 不负责附件物理删除或具体业务表的清理决策。
 *
 * 语法差异说明：
 * - Go 的 `(map[string]bool, error)` 返回值在 JS 中译为成功返回普通对象 `{}`、失败 `throw err`。
 * - Go 的 `sql.NullInt64` 在 JS 中以 `{ Valid: false, Int64: 0 }` 结构体对象表达，通过对象引用传入 `Scan`。
 */

"use strict";

// 单次 payloadMentions 聚合查询包含的最大标志列数；每批对应对目标表的一次扫描。
const payloadMentionsChunk = 64;

/**
 * 扫描指定表的 `payload` 列，报告 `ids` 中哪些 ID 至少在任意一行载荷里出现过。
 * 每批次（最多 64 个 ID）执行一次单行聚合查询以换取较低的表扫描次数。
 * 使用场景：附件清理或孤立资源回收前做引用探测；若本函数抛出错误则表示引用结果未知，调用方必须保留全部候选资源避免误删。
 *
 * @param {object} db - `gorm.DB` 数据库或事务句柄。
 * @param {string} table - 待扫描的物理表名（需包含 `payload` 列）。
 * @param {string[]} ids - 待检查是否被引用的目标 ID 列表。
 * @returns {Object.<string, boolean>} 命中引用的 ID 集合映射（命中的键值为 `true`）。
 * @throws {Error} 聚合扫描查询失败时抛出带表名说明的错误。
 */
function payloadMentions(db, table, ids) {
  const found = {};
  let has = "instr(CAST(payload AS TEXT), ?) > 0";
  if (db.Dialector.Name() === "mysql") {
    has = "INSTR(CAST(payload AS CHAR), ?) > 0";
  }
  for (let start = 0; start < ids.length; start += payloadMentionsChunk) {
    const chunk = ids.slice(start, Math.min(start + payloadMentionsChunk, ids.length));
    const cols = new Array(chunk.length);
    const args = new Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      cols[i] = `MAX(CASE WHEN ${has} THEN 1 ELSE 0 END)`;
      args[i] = chunk[i];
    }
    const flags = chunk.map(() => ({ Valid: false, Int64: 0 }));
    const dest = flags.map((f) => f);
    const query = "SELECT " + cols.join(", ") + " FROM " + table;
    const err = db.Raw(query, ...args).Row().Scan(...dest);
    if (err != null) {
      throw new Error(`scan ${table} for attachment references: ${err}`);
    }
    for (let i = 0; i < chunk.length; i++) {
      if (flags[i].Valid && flags[i].Int64 > 0) {
        found[chunk[i]] = true;
      }
    }
  }
  return found;
}

module.exports = { payloadMentionsChunk, payloadMentions };
