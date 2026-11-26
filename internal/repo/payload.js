// payload.js —— 对应 Go 文件：internal/repo/payload.go
// 作用：JSON 载荷表的通用读写：单行、多行、upsert 与忽略冲突插入。

"use strict";

const { Buffer } = require("node:buffer");

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

// payloadRow：读 JSON 载荷表的通用投影。
class payloadRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }
}

// payloadOne：按主键读一行 JSON 载荷；泛型 T 在 JS 里以类实参传入，返回 [值, 是否找到]。
function payloadOne(Cls, db, table, id) {
  const row = new payloadRow();
  if (db.Table(table).Where("id = ?", id).Take(row).Error != null) {
    return [new Cls(), false];
  }
  let item;
  try {
    item = new Cls(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
  } catch {
    return [new Cls(), false];
  }
  return [item, true];
}

// payloadList：读出全部匹配的 JSON 载荷行；解码失败的行跳过。
function payloadList(Cls, db, table, query, ...args) {
  let q = db.Table(table);
  if (query !== "") {
    q = q.Where(query, ...args);
  }
  const rows = [];
  if (q.Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    try {
      out.push(new Cls(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8"))));
    } catch {
      continue;
    }
  }
  return out;
}

// upsert：主键冲突时替换全部列；CreatedAt 是否保留由调用方负责。
function upsert(db, table, values) {
  const cols = Object.keys(values);
  cols.sort();
  const cl = new clause.OnConflict({ DoUpdates: clause.AssignmentColumns(cols) });
  const err = db.Table(table).Clauses(cl).Create(values).Error;
  if (err != null) {
    return new Error(`${table} write: ${err}`);
  }
  return null;
}

// upsertColumns：主键冲突时只更新指定列。
function upsertColumns(db, table, values, updateCols) {
  const cl = new clause.OnConflict({ DoUpdates: clause.AssignmentColumns(updateCols) });
  const err = db.Table(table).Clauses(cl).Create(values).Error;
  if (err != null) {
    return new Error(`${table} write: ${err}`);
  }
  return null;
}

// insertIgnore：插入一行，冲突时保留旧行；返回是否真的插入，失败时 throw。
function insertIgnore(db, table, values) {
  const names = Object.keys(values);
  names.sort();
  const cols = new Array(names.length);
  const placeholders = new Array(names.length);
  const args = [];
  for (let i = 0; i < names.length; i++) {
    cols[i] = "`" + names[i] + "`";
    placeholders[i] = "?";
    args.push(values[names[i]]);
  }
  let verb = "INSERT OR IGNORE";
  if (db.Dialector.Name() === "mysql") {
    verb = "INSERT IGNORE";
  }
  const stmt = `${verb} INTO ${table} (${cols.join(",")}) VALUES (${placeholders.join(",")})`;
  const res = db.Exec(stmt, ...args);
  if (res.Error != null) {
    throw res.Error;
  }
  return res.RowsAffected > 0;
}

function timePtr(t) {
  if (t == null) {
    return null;
  }
  return new Date(t.getTime());
}

function jsonBytes(v) {
  try {
    const raw = JSON.stringify(v);
    if (raw == null || raw.length === 0) {
      return Buffer.from("{}");
    }
    return Buffer.from(raw, "utf8");
  } catch {
    return Buffer.from("{}");
  }
}

// mustJSON：与 jsonBytes 相同；Go 里定义在 repo.go，JS 里随 payload.js 导出。
function mustJSON(v) {
  return jsonBytes(v);
}

function jsonUnmarshal(raw, v) {
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    if (v != null && typeof parsed === "object" && parsed !== null) {
      Object.assign(v, parsed);
    }
    return null;
  } catch (err) {
    return err;
  }
}

module.exports = { payloadRow, payloadOne, payloadList, upsert, upsertColumns, insertIgnore, timePtr, jsonBytes, mustJSON, jsonUnmarshal };
