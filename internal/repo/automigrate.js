// automigrate.js —— 对应 Go 文件：internal/repo/automigrate.go
// 作用：用 gorm 增量补齐缺失的表、列与索引，只加不改。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { BotInteraction } = require("../domain/bot_interaction.js"); // 对应 Go 同包类型，bot_interaction.js 已翻译
const { allModels } = require("./models.js"); // 对应 Go 同包函数，models.js 待翻译

// autoMigrateIncremental completes every incremental DDL the running database
// is missing (columns, tables, indexes) using gorm's Migrator. Unlike a full
// AutoMigrate — which would also ALTER existing columns to match model
// defaults (e.g. rewriting JSON columns to longblob) — this only ever ADDS
// what is absent, so a production schema migrated by the master binary is
// left untouched except for genuinely missing objects.
//
// The runs.repositories / run_artifacts.repository_dir / runs.pause_requested
// / runs.human_context / runs.cancel_requested / runs.sandbox_id additions
// from the master migrations are all covered here, which removes any
// dependency on schema_migrations marker IDs.
function autoMigrateIncremental(db) {
  const m = db.Migrator();
  for (const model of allModels()) {
    if (!m.HasTable(model)) {
      let create = m;
      // Bot chat may contain supplementary Unicode (emoji).
      // Do not inherit a legacy database utf8mb3 default for these tables.
      if (needsUTF8MB4Table(model) && db.Dialector.Name() === "mysql") {
        create = db.Set("gorm:table_options", "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci").Migrator();
      }
      const createErr = create.CreateTable(model);
      if (createErr != null) {
        // Go 的 %T 无 JS 对应写法，用构造器名代替。
        return new Error(`create table ${model.constructor.name}: ${createErr}`);
      }
      continue;
    }
    const stmt = new gorm.Statement({ DB: db });
    const parseErr = stmt.Parse(model);
    if (parseErr != null) {
      return new Error(`parse schema ${model.constructor.name}: ${parseErr}`);
    }
    for (const field of stmt.Schema.Fields) {
      if (field.DBName === "") {
        continue;
      }
      if (!m.HasColumn(model, field.DBName)) {
        const addErr = m.AddColumn(model, field.DBName);
        if (addErr != null) {
          return new Error(`add column ${model.constructor.name}.${field.DBName}: ${addErr}`);
        }
      }
    }
    for (const index of stmt.Schema.ParseIndexes()) {
      if (!m.HasIndex(model, index.Name)) {
        const indexErr = m.CreateIndex(model, index.Name);
        if (indexErr != null) {
          return new Error(`create index ${model.constructor.name}.${index.Name}: ${indexErr}`);
        }
      }
    }
  }
  return null;
}

function needsUTF8MB4Table(model) {
  // Go 的 switch model.(type)，JS 用 instanceof 判断。
  if (model instanceof BotInteraction) {
    return true;
  }
  return false;
}

module.exports = { autoMigrateIncremental, needsUTF8MB4Table };
