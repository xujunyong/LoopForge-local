// mcp_files.js —— 对应 Go 文件：internal/repo/mcp_files.go
// 作用：上传的 stdio MCP 源码树的读写：文件清单、单文件内容与整树落库。

"use strict";

const { createHash } = require("node:crypto"); // Go crypto/sha256 与 encoding/hex：摘要后转十六进制

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { MCPFileRef, MCPServerDefinition, ValidateRelativeFilePath, MCPFileMaxBytes, NormalizeSkillFileMode } = require("../domain/assets.js"); // 对应 Go 的 domain.*，assets.js 已翻译
const { mcpFileRow } = require("./models.js"); // 对应 Go 同包类型，models.js 本次一同翻译
const { payloadOne, upsert, mustJSON, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { SkillFileInput } = require("./skill_files.js"); // 对应 Go 同包类型，skill_files.js 待翻译
const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

CatalogRepo.prototype.MCPFileRefs = function (mcpID) {
  const rows = [];
  const err = this.DB.Where("mcp_id = ?", mcpID).Order("path").Find(rows).Error;
  if (err != null) {
    return null;
  }
  const out = [];
  for (const row of rows) {
    const ref = new MCPFileRef({ Path: row.Path, Size: row.Size, SHA256: row.SHA256, Mode: row.UnixMode });
    if (row.Updated != null) {
      ref.UpdatedAt = row.Updated;
    }
    out.push(ref);
  }
  return out;
};

CatalogRepo.prototype.MCPFileContent = function (mcpID, filePath) {
  const row = new mcpFileRow();
  const err = this.DB.Where("mcp_id = ? AND path = ?", mcpID, filePath).Take(row).Error;
  if (err != null) {
    return [null, false];
  }
  return [row.Content, true];
};

CatalogRepo.prototype.MCPFileContents = function (mcpID) {
  const rows = [];
  const err = this.DB.Where("mcp_id = ?", mcpID).Find(rows).Error;
  if (err != null) {
    return null;
  }
  const out = {};
  for (const row of rows) {
    out[row.Path] = row.Content;
  }
  return out;
};

// PutMCPFiles stores one complete uploaded stdio MCP source tree.
CatalogRepo.prototype.PutMCPFiles = function (mcpID, files) {
  if (mcpID === "") {
    return new Error("MCP id is required");
  }
  if (files.length === 0) {
    return new Error("no MCP files to store");
  }
  const now = new Date();
  return this.DB.Transaction((tx) => {
    const [, ok] = payloadOne(MCPServerDefinition, tx, "mcp_servers", mcpID);
    if (!ok) {
      return new Error(`MCP ${mcpID} not found`);
    }
    const deleteErr = tx.Where("mcp_id = ?", mcpID).Delete(new mcpFileRow()).Error;
    if (deleteErr != null) {
      return deleteErr;
    }
    for (const file of files) {
      const pathErr = ValidateRelativeFilePath(file.Path);
      if (pathErr != null) {
        return pathErr;
      }
      if (file.Content.length > MCPFileMaxBytes) {
        return new Error(`MCP 文件 ${file.Path} 超过 1MB 限制`);
      }
      const sum = createHash("sha256").update(file.Content).digest("hex");
      const err = upsert(tx, "mcp_files", {
        mcp_id: mcpID, path: file.Path, content: file.Content,
        size: file.Content.length, sha256: sum,
        unix_mode: NormalizeSkillFileMode(file.Mode), updated_at: now,
      });
      if (err != null) {
        return err;
      }
    }
    return refreshMCPFileRefs(tx, mcpID, now);
  });
};

CatalogRepo.prototype.DeleteMCPFile = function (mcpID, filePath) {
  if (mcpID === "" || filePath === "") {
    return new Error("MCP id and path are required");
  }
  const now = new Date();
  return this.DB.Transaction((tx) => {
    const err = tx.Where("mcp_id = ? AND path = ?", mcpID, filePath).Delete(new mcpFileRow()).Error;
    if (err != null) {
      return err;
    }
    return refreshMCPFileRefs(tx, mcpID, now);
  });
};

function refreshMCPFileRefs(tx, mcpID, now) {
  const [server, ok] = payloadOne(MCPServerDefinition, tx, "mcp_servers", mcpID);
  if (!ok) {
    return new Error(`MCP ${mcpID} not found`);
  }
  const rows = [];
  const err = tx.Where("mcp_id = ?", mcpID).Order("path").Find(rows).Error;
  if (err != null) {
    return err;
  }
  const refs = [];
  for (const row of rows) {
    const ref = new MCPFileRef({ Path: row.Path, Size: row.Size, SHA256: row.SHA256, Mode: row.UnixMode });
    if (row.Updated != null) {
      ref.UpdatedAt = row.Updated;
    }
    refs.push(ref);
  }
  server.FileRefs = refs;
  server.UpdatedAt = now;
  return upsert(tx, "mcp_servers", { id: server.ID, name: server.Name, payload: mustJSON(server), updated_at: timePtr(now) });
}
