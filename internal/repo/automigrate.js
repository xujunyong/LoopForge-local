/**
 * @file internal/repo/automigrate.js
 * 对应 Go 源文件：internal/repo/automigrate.go
 *
 * 作用与职责边界：
 * 在存储初始化时通过 GORM Migrator 执行只增不改的增量 DDL 补齐（补齐缺失的表、列与索引），
 * 并为包含表情符号等补充 Unicode 字符的 Bot 交互表在 MySQL 下显式指定 `utf8mb4` 表选项。
 * 不执行破坏性的列类型改写、数据迁移或 seed 数据写入。
 *
 * 语法差异说明：
 * - Go 仅返回 `error` 的函数在 JS 中成功返回 `undefined`、失败 `throw err`。
 * - Go 的 `fmt.Errorf("... %T ...", model, err)` 在 JS 中用 `model.constructor.name` 代替 `%T`。
 * - Go 的类型断言 `switch model.(type)` 在 JS 中译为 `instanceof` 判断。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { BotInteraction } = require("../domain/bot_interaction.js"); // 对应 Go 同包类型，bot_interaction.js 已翻译
const { allModels } = require("./models.js"); // 对应 Go 同包函数，models.js 待翻译

/**
 * 增量补齐当前运行数据库缺失的表、列与索引。
 * 与全量 `AutoMigrate` 不同，本函数绝不 `ALTER` 已有列，仅创建缺失对象，
 * 避免改写由主版本迁移脚本维护的生产库列类型（如 JSON 列）；在 `repo.Open` 打开数据库连接后调用。
 *
 * @param {object} db - 已连接的 `gorm.DB` 实例。
 * @returns {void} 无返回值。
 * @throws {Error} 建表、解析模型结构、新增列或创建索引失败时抛出携带模型名与原因的错误。
 */
function autoMigrateIncremental(db) {
  const m = db.Migrator();
  for (const model of allModels()) {
    if (!m.HasTable(model)) {
      let create = m;
      // Bot 聊天记录可能包含补充 Unicode 字符（如表情符号），建表时不继承旧库默认的 utf8mb3 字符集。
      if (needsUTF8MB4Table(model) && db.Dialector.Name() === "mysql") {
        create = db.Set("gorm:table_options", "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci").Migrator();
      }
      const createErr = create.CreateTable(model);
      if (createErr != null) {
        // Go 的 %T 无 JS 对应写法，用构造器名代替。
        throw new Error(`create table ${model.constructor.name}: ${createErr}`);
      }
      continue;
    }
    const stmt = new gorm.Statement({ DB: db });
    const parseErr = stmt.Parse(model);
    if (parseErr != null) {
      throw new Error(`parse schema ${model.constructor.name}: ${parseErr}`);
    }
    for (const field of stmt.Schema.Fields) {
      if (field.DBName === "") {
        continue;
      }
      if (!m.HasColumn(model, field.DBName)) {
        const addErr = m.AddColumn(model, field.DBName);
        if (addErr != null) {
          throw new Error(`add column ${model.constructor.name}.${field.DBName}: ${addErr}`);
        }
      }
    }
    for (const index of stmt.Schema.ParseIndexes()) {
      if (!m.HasIndex(model, index.Name)) {
        const indexErr = m.CreateIndex(model, index.Name);
        if (indexErr != null) {
          throw new Error(`create index ${model.constructor.name}.${index.Name}: ${indexErr}`);
        }
      }
    }
  }
}

/**
 * 判断给定模型对应的数据库表在 MySQL 首次建表时是否需要强制指定 `utf8mb4` 字符集。
 * 用于防止历史库默认 `utf8mb3` 导致写入表情符号或扩展汉字失败。
 *
 * @param {object} model - `allModels()` 返回的模型实例。
 * @returns {boolean} 需要显式设置 `utf8mb4` 时返回 `true`，否则返回 `false`。
 */
function needsUTF8MB4Table(model) {
  // Go 的 switch model.(type)，JS 用 instanceof 判断。
  if (model instanceof BotInteraction) {
    return true;
  }
  return false;
}

module.exports = { autoMigrateIncremental, needsUTF8MB4Table };
