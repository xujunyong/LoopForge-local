// payload_mentions.js —— 对应 Go 文件：internal/repo/payload_mentions.go
// 作用：查一批 id 是否出现在某张表的 JSON 载荷里，供删除前做引用检查。

"use strict";

// payloadMentionsChunk：一次 payloadMentions 查询的 id 上限；每块扫一次表。
const payloadMentionsChunk = 64;

// payloadMentions：返回 ids 里出现在 table 载荷中的那些；失败时 throw。
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
