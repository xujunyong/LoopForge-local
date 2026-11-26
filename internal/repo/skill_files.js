// skill_files.js —— 对应 Go 文件：internal/repo/skill_files.go
// 作用：技能二进制文件的存取：整套替换、快照写入与清单刷新。

"use strict";

const { createHash } = require("node:crypto"); // Go crypto/sha256

const { SkillDefinition, SkillFileRef, SkillFileMaxBytes, NormalizeSkillFileMode, ValidateRelativeFilePath } = require("../domain/assets.js"); // 对应 Go 的 domain.*，assets.js 已翻译
const { payloadOne, upsert, mustJSON, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { skillFileRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译

// SkillFileInput：待持久化的一个技能二进制文件。
class SkillFileInput {
  constructor(init = {}) {
    this.Path = init.Path ?? "";
    this.Content = init.Content ?? null;
    this.Mode = init.Mode ?? 0;
  }
}

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

CatalogRepo.prototype.SkillFileContent = function (skillID, path) {
  const row = new skillFileRow();
  if (this.DB.Where("skill_id = ? AND path = ?", skillID, path).Take(row).Error != null) {
    return [null, false];
  }
  return [row.Content, true];
};

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

CatalogRepo.prototype.SkillFileTotalBytes = function (skillID) {
  const total = { value: 0 }; // Go 的 Scan(&total) 用对象接出参。
  if (this.DB.Table("skill_files").Where("skill_id = ?", skillID).Select("COALESCE(SUM(size),0)").Scan(total).Error != null) {
    return 0;
  }
  return total.value;
};

CatalogRepo.prototype.PutSkillFiles = function (skillID, files) {
  if (skillID === "") {
    return new Error("skill id is required");
  }
  if (files.length === 0) {
    return new Error("no skill files to store");
  }
  const now = new Date();
  return this.DB.Transaction((tx) => {
    const deleteErr = tx.Where("skill_id = ?", skillID).Delete(new skillFileRow()).Error;
    if (deleteErr != null) {
      return deleteErr;
    }
    for (const file of files) {
      const writeErr = writeSkillFileRow(tx, skillID, file, now);
      if (writeErr != null) {
        return writeErr;
      }
    }
    return refreshSkillFileRefs(tx, skillID, now);
  });
};

// PutSkillSnapshot 以 create 方式请求已存在 id 时返回该错误。
const ErrSkillExists = new Error("skill id already exists");

CatalogRepo.prototype.PutSkillSnapshot = function (v, files, create) {
  if (v.ID === "" || v.Name === "") {
    return new Error("skill id and name are required");
  }
  if (files.length === 0) {
    return new Error("no skill files to store");
  }
  const now = new Date();
  v.UpdatedAt = now;
  return this.DB.Transaction((tx) => {
    if (create) {
      const count = { value: 0 }; // Go 的 Count(&count) 用对象接出参。
      const countErr = tx.Table("skills").Where("id = ?", v.ID).Count(count).Error;
      if (countErr != null) {
        return countErr;
      }
      if (count.value > 0) {
        return ErrSkillExists;
      }
    }
    const upsertErr = upsert(tx, "skills", {
      id: v.ID, name: v.Name, payload: mustJSON(v), updated_at: timePtr(now),
    });
    if (upsertErr != null) {
      return upsertErr;
    }
    const deleteErr = tx.Where("skill_id = ?", v.ID).Delete(new skillFileRow()).Error;
    if (deleteErr != null) {
      return deleteErr;
    }
    for (const file of files) {
      const writeErr = writeSkillFileRow(tx, v.ID, file, now);
      if (writeErr != null) {
        return writeErr;
      }
    }
    return refreshSkillFileRefs(tx, v.ID, now);
  });
};

function writeSkillFileRow(tx, skillID, file, now) {
  try {
    ValidateRelativeFilePath(file.Path);
  } catch (err) {
    return err;
  }
  if (file.Content.length > SkillFileMaxBytes) {
    return new Error(`skill 文件 ${file.Path} 超过 1MB 限制`);
  }
  const sum = createHash("sha256").update(file.Content).digest("hex");
  return upsert(tx, "skill_files", {
    skill_id: skillID,
    path: file.Path,
    content: file.Content,
    size: file.Content.length,
    sha256: sum,
    unix_mode: NormalizeSkillFileMode(file.Mode),
    updated_at: now,
  });
}

CatalogRepo.prototype.DeleteSkillFile = function (skillID, path) {
  if (skillID === "" || path === "") {
    return new Error("skill id and path are required");
  }
  const now = new Date();
  return this.DB.Transaction((tx) => {
    const deleteErr = tx.Where("skill_id = ? AND path = ?", skillID, path).Delete(new skillFileRow()).Error;
    if (deleteErr != null) {
      return deleteErr;
    }
    return refreshSkillFileRefs(tx, skillID, now);
  });
};

CatalogRepo.prototype.DeleteSkillFiles = function (skillID) {
  return this.DB.Where("skill_id = ?", skillID).Delete(new skillFileRow()).Error;
};

function refreshSkillFileRefs(tx, skillID, now) {
  const [skill, ok] = payloadOne(SkillDefinition, tx, "skills", skillID);
  if (!ok) {
    return new Error(`skill ${skillID} not found`);
  }
  const rows = [];
  const findErr = tx.Where("skill_id = ?", skillID).Order("path").Find(rows).Error;
  if (findErr != null) {
    return findErr;
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
  return upsert(tx, "skills", {
    id: skill.ID, name: skill.Name, payload: mustJSON(skill), updated_at: timePtr(now),
  });
}

module.exports = { SkillFileInput, ErrSkillExists, writeSkillFileRow, refreshSkillFileRefs };
