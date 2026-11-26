/**
 * @file internal/repo/payload.js
 * 对应 Go 源文件：internal/repo/payload.go
 *
 * 作用与职责边界：
 * 提供仓储层通用的 JSON 载荷表读写工具，包括通用投影行模型 `payloadRow`、按主键单行读取（`payloadOne`）、
 * 条件批量读取（`payloadList`）、全列/指定列冲突覆盖（`upsert`/`upsertColumns`）、方言适配的忽略冲突插入（`insertIgnore`），
 * 以及时间指针转换与 JSON 编解码辅助函数（`timePtr`、`jsonBytes`、`jsonUnmarshal`）。
 * 另保留导出 `mustJSON`（Go 原文定义在 `repo.go` 中）供同包各文件统一按 `Buffer` 语义复用。
 *
 * 语法差异说明：
 * - Go 的泛型函数 `payloadOne[T]` / `payloadList[T]` 在 JS 中通过首位参数 `Cls`（目标类构造函数）表达。
 * - Go 的 `(T, bool)` 返回值译为二元组 `[T, boolean]`；`(bool, error)` 译为成功返回布尔值、失败 `throw err`；仅返回 `error` 的函数成功返回 `undefined`、失败 `throw err`。
 * - Go 的 `[]byte` JSON 字节序列在 JS 中使用 `Buffer` 表达；`time.Time` 零值在 JS 中为 `null`。
 */

"use strict";

const { Buffer } = require("node:buffer");

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

/**
 * 读取 JSON 载荷表使用的通用投影行结构，对应表中的公共列（`id`、`name`、`payload`、`created_at`、`updated_at`）。
 */
class payloadRow {
  /**
   * 构造通用载荷投影行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.ID=""] - 记录主键 ID（对应列 `id`）。
   * @param {string} [init.Name=""] - 记录名称（对应列 `name`）。
   * @param {Buffer|string|null} [init.Payload=null] - JSON 载荷字节（对应列 `payload`）。
   * @param {Date|null} [init.Created=null] - 创建时间（对应列 `created_at`）。
   * @param {Date|null} [init.Updated=null] - 更新时间（对应列 `updated_at`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }
}

/**
 * 按主键从指定 JSON 载荷表读取单条记录并解码为目标类型实例。
 * 使用场景：供各领域仓储按 ID 查询项目、需求、目录资产等载荷实体。
 *
 * @template T
 * @param {new (init?: object) => T} Cls - 目标领域模型的类构造函数（对应 Go 泛型类型参数 `T`）。
 * @param {object} db - `gorm.DB` 数据库或事务句柄。
 * @param {string} table - 物理表名。
 * @param {string} id - 主键 ID。
 * @returns {[T, boolean]} 二元组 `[实体实例, 是否读取并解码成功]`；记录不存在或 JSON 解码失败时返回 `[new Cls(), false]`。
 */
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

/**
 * 从指定 JSON 载荷表读取满足可选 `WHERE` 条件的全部记录并逐行解码，解码失败的损坏行会被跳过。
 * 使用场景：供各领域仓储列表查询场景批量读取实体。
 *
 * @template T
 * @param {new (init?: object) => T} Cls - 目标领域模型的类构造函数（对应 Go 泛型类型参数 `T`）。
 * @param {object} db - `gorm.DB` 数据库或事务句柄。
 * @param {string} table - 物理表名。
 * @param {string} query - 可选的 SQL 过滤条件表达式；为空字符串时不附加 `Where` 条件。
 * @param {...*} args - 绑定到 `query` 占位符的参数列表。
 * @returns {T[]} 解码成功的实体实例数组；查询出错时返回空数组 `[]`。
 */
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

/**
 * 向指定表插入一行记录，主键冲突时用传入值替换全部列。
 * 调用方需传入完整的目标行字段；如需保留原有 `CreatedAt`，由调用方在写入前自行复制。
 *
 * @param {object} db - `gorm.DB` 数据库或事务句柄。
 * @param {string} table - 物理表名。
 * @param {Object.<string, *>} values - 列名到列值的映射对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出带表名前缀的错误。
 */
function upsert(db, table, values) {
  const cols = Object.keys(values);
  cols.sort();
  const cl = new clause.OnConflict({ DoUpdates: clause.AssignmentColumns(cols) });
  const err = db.Table(table).Clauses(cl).Create(values).Error;
  if (err != null) {
    throw new Error(`${table} write: ${err}`);
  }
}

/**
 * 向指定表插入一行记录，主键冲突时仅更新 `updateCols` 指定的列子集。
 * 使用场景：需要在覆盖主数据时保留并发状态列（如取消/暂停标记）的更新操作。
 *
 * @param {object} db - `gorm.DB` 数据库或事务句柄。
 * @param {string} table - 物理表名。
 * @param {Object.<string, *>} values - 插入所需的完整列名到列值映射。
 * @param {string[]} updateCols - 发生冲突时允许更新的列名列表。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出带表名前缀的错误。
 */
function upsertColumns(db, table, values, updateCols) {
  const cl = new clause.OnConflict({ DoUpdates: clause.AssignmentColumns(updateCols) });
  const err = db.Table(table).Clauses(cl).Create(values).Error;
  if (err != null) {
    throw new Error(`${table} write: ${err}`);
  }
}

/**
 * 向指定表执行忽略冲突的插入操作，若唯一键或主键已存在则保留既有行。
 * 由于 GORM 的 `OnConflict{DoNothing}` 在 MySQL 上会生成空的 `ON DUPLICATE KEY UPDATE` 子句，
 * 这里按方言显式拼接 `INSERT IGNORE`（MySQL）或 `INSERT OR IGNORE`（SQLite），且全部值通过参数绑定传入。
 *
 * @param {object} db - `gorm.DB` 数据库或事务句柄。
 * @param {string} table - 编译期常量物理表名。
 * @param {Object.<string, *>} values - 编译期常量列名到绑定值的映射。
 * @returns {boolean} 本次调用确实新插入了行时返回 `true`，命中冲突被忽略时返回 `false`。
 * @throws {Error} 原生 SQL 执行失败时抛出数据库错误。
 */
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

/**
 * 将非零时间转为新的 UTC `Date` 拷贝，零值时间（`null`/`undefined`）转为 `null` 以写入可空时间列。
 *
 * @param {Date|null|undefined} t - 待转换的时间值。
 * @returns {Date|null} 非零时间返回拷贝后的 `Date` 实例，否则返回 `null`。
 */
function timePtr(t) {
  if (t == null) {
    return null;
  }
  return new Date(t.getTime());
}

/**
 * 将任意值序列化为 UTF-8 JSON `Buffer`；序列化失败或结果为空时兜底返回 `"{}"` 对应的 `Buffer`。
 *
 * @param {*} v - 待序列化的任意值或领域对象。
 * @returns {Buffer} 序列化后的 JSON 字节缓冲区。
 */
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

/**
 * 将任意值序列化为 UTF-8 JSON `Buffer`（行为等同于 `jsonBytes`）。
 * 说明：Go 原文将 `mustJSON` 定义在 `repo.go` 中；JS 中随 `payload.js` 导出以供同包文件统一引入并保持返回 `Buffer`。
 *
 * @param {*} v - 待序列化的任意值或领域对象。
 * @returns {Buffer} 序列化后的 JSON 字节缓冲区。
 */
function mustJSON(v) {
  return jsonBytes(v);
}

/**
 * 将 JSON 字节缓冲区或字符串反序列化并就地填充到目标对象或数组中。
 * 使用场景：各领域仓储从数据库 `payload` 列恢复领域模型或列表字段。
 *
 * @param {Buffer|string} raw - 原始 JSON 字节缓冲区或字符串。
 * @param {object|Array} v - 接收反序列化字段的目标对象或数组。
 * @returns {void} 无返回值。
 * @throws {Error} 原始数据无法转为合法 JSON 时抛出解析错误。
 */
function jsonUnmarshal(raw, v) {
  const parsed = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
  if (Array.isArray(v) && Array.isArray(parsed)) {
    v.splice(0, v.length, ...parsed);
  } else if (v != null && typeof parsed === "object" && parsed !== null) {
    Object.assign(v, parsed);
  }
}

module.exports = { payloadRow, payloadOne, payloadList, upsert, upsertColumns, insertIgnore, timePtr, jsonBytes, mustJSON, jsonUnmarshal };
