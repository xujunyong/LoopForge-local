/**
 * @file internal/repo/skill_files.js
 * 对应 Go 源文件：internal/repo/skill_files.go
 *
 * 作用与职责边界：
 * 为目录仓储 `CatalogRepo` 提供技能（Skill）关联二进制文件的持久化存取能力：
 * 查询文件元数据清单、读取单个或全部文件内容、统计总字节数、在单事务内整套替换文件或写入技能快照
 * （含市场安装防冲突 `create` 模式）、删除单个或全部文件，以及从 `skill_files` 事实表刷新 `skills` 载荷中的 `FileRefs` 清单。
 * 不负责技能运行时目录物化或市场下载解包。
 *
 * 语法差异说明：
 * - `CatalogRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `CatalogRepo.prototype` 挂载技能文件方法。
 * - Go 的仅 `error` 返回与 `db.Transaction(tx => ...)` 回调统一按成功返回 `undefined`、失败 `throw err` 处理；
 *   Go 的 `([]byte, bool)` 译为二元组 `[Buffer | null, boolean]`。
 * - Go 的 `crypto/sha256` 与 `encoding/hex` 译为 Node.js `node:crypto` 的 `createHash("sha256").update(...).digest("hex")`。
 * - Go 的 `map[string][]byte` 译为普通对象 `{}`；`Scan(&total)`/`Count(&count)` 出参以 `{ value: 0 }` 承载。
 */

"use strict";

const { createHash } = require("node:crypto"); // Go crypto/sha256

const { SkillDefinition, SkillFileRef, SkillFileMaxBytes, NormalizeSkillFileMode, ValidateRelativeFilePath } = require("../domain/assets.js"); // 对应 Go 的 domain.*，assets.js 已翻译
const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { payloadOne, upsert, mustJSON, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { skillFileRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译

/**
 * 待持久化的单个技能二进制文件输入结构。
 */
class SkillFileInput {
  /**
   * 构造技能文件输入实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.Path=""] - 相对于技能根目录的文件路径。
   * @param {Buffer | Uint8Array | null} [init.Content=null] - 文件原始二进制内容。
   * @param {number} [init.Mode=0] - Unix 文件权限位（为 `0` 时将归一化为默认权限）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Path = init.Path ?? "";
    this.Content = init.Content ?? null;
    this.Mode = init.Mode ?? 0;
  }
}

/**
 * 按文件路径升序返回指定技能的全部二进制文件元数据清单（不含正文）。
 *
 * @param {string} skillID - 技能主键 ID。
 * @returns {SkillFileRef[] | null} 文件元数据引用数组；数据库查询失败时返回 `null`。
 */
CatalogRepo.prototype.SkillFileRefs = function (skillID) {
  const rows = [];
  if (this.DB.Where("skill_id = ?", skillID).Order("path").Find(rows).Error != null) {
    return null;
  }
  const out = [];
  for (const row of rows) {
    const ref = new SkillFileRef({ Path: row.Path, Size: row.Size, SHA256: row.SHA256, Mode: row.UnixMode });
    if (row.Updated != null) {
      ref.UpdatedAt = row.Updated;
    }
    out.push(ref);
  }
  return out;
};

/**
 * 读取指定技能下单个二进制文件的内容字节。
 *
 * @param {string} skillID - 技能主键 ID。
 * @param {string} path - 技能内相对文件路径。
 * @returns {[Buffer | Uint8Array | null, boolean]} 找到时返回 `[文件内容, true]`，否则返回 `[null, false]`。
 */
CatalogRepo.prototype.SkillFileContent = function (skillID, path) {
  const row = new skillFileRow();
  if (this.DB.Where("skill_id = ? AND path = ?", skillID, path).Take(row).Error != null) {
    return [null, false];
  }
  return [row.Content, true];
};

/**
 * 批量加载指定技能的全部二进制文件，返回以相对路径为键、文件内容字节为值的映射对象。
 *
 * @param {string} skillID - 技能主键 ID。
 * @returns {Object.<string, Buffer | Uint8Array> | null} 路径到文件字节的映射对象；查询失败时返回 `null`。
 */
CatalogRepo.prototype.SkillFileContents = function (skillID) {
  const rows = [];
  if (this.DB.Where("skill_id = ?", skillID).Find(rows).Error != null) {
    return null;
  }
  const out = {};
  for (const row of rows) {
    out[row.Path] = row.Content;
  }
  return out;
};

/**
 * 统计指定技能所有已持久化二进制文件的合并总字节数。
 *
 * @param {string} skillID - 技能主键 ID。
 * @returns {number} 文件总字节数；查询失败或无文件时返回 `0`。
 */
CatalogRepo.prototype.SkillFileTotalBytes = function (skillID) {
  const total = { value: 0 }; // Go 的 Scan(&total) 用对象接出参。
  if (this.DB.Table("skill_files").Where("skill_id = ?", skillID).Select("COALESCE(SUM(size),0)").Scan(total).Error != null) {
    return 0;
  }
  return total.value;
};

/**
 * 在单个事务内以整套替换语义持久化技能的二进制文件集合（先删旧行再写新行），
 * 并同步刷新 `skills` 表载荷中的 `FileRefs` 元数据清单。
 *
 * @param {string} skillID - 技能主键 ID。
 * @param {SkillFileInput[]} files - 新的完整文件列表（不得为空）。
 * @returns {void} 无返回值。
 * @throws {Error} 缺少技能 ID、文件列表为空、单文件校验失败或事务写删失败时抛出错误。
 */
CatalogRepo.prototype.PutSkillFiles = function (skillID, files) {
  if (skillID === "") {
    throw new Error("skill id is required");
  }
  if (files.length === 0) {
    throw new Error("no skill files to store");
  }
  const now = new Date();
  this.DB.Transaction((tx) => {
    const deleteErr = tx.Where("skill_id = ?", skillID).Delete(new skillFileRow()).Error;
    if (deleteErr != null) {
      throw deleteErr;
    }
    for (const file of files) {
      writeSkillFileRow(tx, skillID, file, now);
    }
    refreshSkillFileRefs(tx, skillID, now);
  });
};

// 当 `PutSkillSnapshot` 以 `create = true` 写入但技能 ID 已存在时抛出的哨兵错误。
const ErrSkillExists = new Error("skill id already exists");

/**
 * 在单个事务内原子写入技能主记录及其完整二进制文件集合，避免安装或更新中途失败留下残缺技能或半替换文件。
 * 当 `create` 为 `true` 时，会先校验该技能 ID 尚未存在。
 *
 * @param {SkillDefinition} v - 技能定义主对象。
 * @param {SkillFileInput[]} files - 技能包含的完整二进制文件列表（不得为空）。
 * @param {boolean} create - 是否要求技能 ID 必须为新建（已存在时抛出 `ErrSkillExists`）。
 * @returns {void} 无返回值。
 * @throws {Error} 必填字段缺失、文件列表为空、ID 已存在（`ErrSkillExists`）或事务写入失败时抛出错误。
 */
CatalogRepo.prototype.PutSkillSnapshot = function (v, files, create) {
  if (v.ID === "" || v.Name === "") {
    throw new Error("skill id and name are required");
  }
  if (files.length === 0) {
    throw new Error("no skill files to store");
  }
  const now = new Date();
  v.UpdatedAt = now;
  this.DB.Transaction((tx) => {
    if (create) {
      const count = { value: 0 }; // Go 的 Count(&count) 用对象接出参。
      const countErr = tx.Table("skills").Where("id = ?", v.ID).Count(count).Error;
      if (countErr != null) {
        throw countErr;
      }
      if (count.value > 0) {
        throw ErrSkillExists;
      }
    }
    upsert(tx, "skills", {
      id: v.ID, name: v.Name, payload: mustJSON(v), updated_at: timePtr(now),
    });
    const deleteErr = tx.Where("skill_id = ?", v.ID).Delete(new skillFileRow()).Error;
    if (deleteErr != null) {
      throw deleteErr;
    }
    for (const file of files) {
      writeSkillFileRow(tx, v.ID, file, now);
    }
    refreshSkillFileRefs(tx, v.ID, now);
  });
};

/**
 * 校验单个技能文件的相对路径与 1MB 体积上限，计算 SHA-256 摘要并归一化权限位后写入 `skill_files` 表。
 *
 * @param {object} tx - 当前事务 `gorm.DB` 句柄。
 * @param {string} skillID - 技能主键 ID。
 * @param {SkillFileInput} file - 待写入的文件输入对象。
 * @param {Date} now - 写入时间戳。
 * @returns {void} 无返回值。
 * @throws {Error} 路径非法、单文件超过 `SkillFileMaxBytes` 或数据库写入失败时抛出错误。
 */
function writeSkillFileRow(tx, skillID, file, now) {
  ValidateRelativeFilePath(file.Path);
  if (file.Content.length > SkillFileMaxBytes) {
    throw new Error(`skill 文件 ${file.Path} 超过 1MB 限制`);
  }
  const sum = createHash("sha256").update(file.Content).digest("hex");
  upsert(tx, "skill_files", {
    skill_id: skillID,
    path: file.Path,
    content: file.Content,
    size: file.Content.length,
    sha256: sum,
    unix_mode: NormalizeSkillFileMode(file.Mode),
    updated_at: now,
  });
}

/**
 * 在事务内删除指定技能的单个二进制文件，并同步刷新 `skills` 载荷中的 `FileRefs` 清单。
 *
 * @param {string} skillID - 技能主键 ID。
 * @param {string} path - 待删除的相对文件路径。
 * @returns {void} 无返回值。
 * @throws {Error} 参数为空或事务删除/刷新清单失败时抛出错误。
 */
CatalogRepo.prototype.DeleteSkillFile = function (skillID, path) {
  if (skillID === "" || path === "") {
    throw new Error("skill id and path are required");
  }
  const now = new Date();
  this.DB.Transaction((tx) => {
    const deleteErr = tx.Where("skill_id = ? AND path = ?", skillID, path).Delete(new skillFileRow()).Error;
    if (deleteErr != null) {
      throw deleteErr;
    }
    refreshSkillFileRefs(tx, skillID, now);
  });
};

/**
 * 批量删除指定技能下的全部二进制文件行，不改写 `skills` 主表载荷（用于整条技能被删除时的清理）。
 *
 * @param {string} skillID - 技能主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库删除失败时抛出错误。
 */
CatalogRepo.prototype.DeleteSkillFiles = function (skillID) {
  const err = this.DB.Where("skill_id = ?", skillID).Delete(new skillFileRow()).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 以 `skill_files` 物理表为唯一事实源，重算并覆盖写回 `skills` 表对应载荷的 `FileRefs` 与 `UpdatedAt`。
 *
 * @param {object} tx - 当前事务 `gorm.DB` 句柄。
 * @param {string} skillID - 技能主键 ID。
 * @param {Date} now - 刷新时间戳。
 * @returns {void} 无返回值。
 * @throws {Error} 技能记录不存在、查询文件行失败或写回技能载荷失败时抛出错误。
 */
function refreshSkillFileRefs(tx, skillID, now) {
  const [skill, ok] = payloadOne(SkillDefinition, tx, "skills", skillID);
  if (!ok) {
    throw new Error(`skill ${skillID} not found`);
  }
  const rows = [];
  const findErr = tx.Where("skill_id = ?", skillID).Order("path").Find(rows).Error;
  if (findErr != null) {
    throw findErr;
  }
  const refs = [];
  for (const row of rows) {
    const ref = new SkillFileRef({ Path: row.Path, Size: row.Size, SHA256: row.SHA256, Mode: row.UnixMode });
    if (row.Updated != null) {
      ref.UpdatedAt = row.Updated;
    }
    refs.push(ref);
  }
  skill.FileRefs = refs;
  skill.UpdatedAt = now;
  upsert(tx, "skills", {
    id: skill.ID, name: skill.Name, payload: mustJSON(skill), updated_at: timePtr(now),
  });
}

module.exports = { SkillFileInput, ErrSkillExists, writeSkillFileRow, refreshSkillFileRefs };
