/**
 * @file internal/repo/mcp_files.js
 * 对应 Go 源文件：internal/repo/mcp_files.go
 *
 * 作用与职责边界：
 * 为目录仓储 `CatalogRepo` 提供上传的 stdio MCP 源码树二进制文件的持久化存取能力：
 * 查询文件元数据引用清单、读取单文件或全量文件内容、在事务内整树替换上传文件、删除单文件，
 * 以及同步刷新 `mcp_servers` 载荷中的 `FileRefs` 清单。
 * 不负责 MCP 服务器定义本身的创建或运行时目录物化。
 *
 * 语法差异说明：
 * - `CatalogRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `CatalogRepo.prototype` 挂载各 MCP 文件方法。
 * - Go 的 `error`-only 函数与 `db.Transaction` 回调统一遵循成功返回 `undefined`、失败抛出 `Error` 的约定；`(值, bool)` 译为 `[值, boolean]` 元组。
 * - Go 的 `crypto/sha256` 与 `encoding/hex` 译为 Node.js `node:crypto` 的 `createHash("sha256").update(...).digest("hex")`。
 * - Go 的 `map[string][]byte` 译为普通对象 `{}`。
 */

"use strict";

const { createHash } = require("node:crypto"); // Go crypto/sha256 与 encoding/hex：计算摘要并转十六进制

const { MCPFileRef, MCPServerDefinition, ValidateRelativeFilePath, MCPFileMaxBytes, NormalizeSkillFileMode } = require("../domain/assets.js"); // 对应 Go 的 domain.*，assets.js 已翻译
const { mcpFileRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { payloadOne, upsert, mustJSON, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译

/**
 * 按文件路径升序查询指定 MCP 服务器已上传的全部文件元数据引用（不含二进制正文）。
 * 用于前端展示 MCP 源码树文件列表或构建元数据快照。
 *
 * @param {string} mcpID - MCP 服务器唯一标识。
 * @returns {MCPFileRef[] | null} 文件元数据引用数组；查询失败时返回 `null`。
 */
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

/**
 * 按 MCP ID 与相对路径读取单个上传文件的二进制内容。
 * 用于查看或下载 MCP 源码树中的单个文件。
 *
 * @param {string} mcpID - MCP 服务器唯一标识。
 * @param {string} filePath - 文件在 MCP 源码树中的相对路径。
 * @returns {[Buffer | null, boolean]} 返回 `[文件内容字节缓冲, 是否找到]`；未找到时返回 `[null, false]`。
 */
CatalogRepo.prototype.MCPFileContent = function (mcpID, filePath) {
  const row = new mcpFileRow();
  const err = this.DB.Where("mcp_id = ? AND path = ?", mcpID, filePath).Take(row).Error;
  if (err != null) {
    return [null, false];
  }
  return [row.Content, true];
};

/**
 * 读取指定 MCP 服务器的全部上传文件内容，组装为「相对路径 → 二进制内容」映射。
 * 供执行运行时将 stdio MCP 源码树物化到沙箱目录时调用。
 *
 * @param {string} mcpID - MCP 服务器唯一标识。
 * @returns {Object<string, Buffer> | null} 以相对路径为键、文件字节内容为值的普通对象；查询失败时返回 `null`。
 */
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

/**
 * 在数据库事务内整树替换保存一套上传的 stdio MCP 源码文件，并刷新 `mcp_servers` 载荷中的文件引用清单。
 * 写入前逐个校验相对路径合法性与 1MB 单文件大小上限，并计算 SHA-256 摘要与规范化 Unix 权限位。
 *
 * @param {string} mcpID - 目标 MCP 服务器唯一标识。
 * @param {import("./skill_files.js").SkillFileInput[]} files - 待保存的文件输入列表（不可为空）。
 * @returns {void} 无返回值。
 * @throws {Error} 参数为空、MCP 不存在、路径非法、文件超限或数据库事务写入失败时抛出错误。
 */
CatalogRepo.prototype.PutMCPFiles = function (mcpID, files) {
  if (mcpID === "") {
    throw new Error("MCP id is required");
  }
  if (files.length === 0) {
    throw new Error("no MCP files to store");
  }
  const now = new Date();
  this.DB.Transaction((tx) => {
    const [, ok] = payloadOne(MCPServerDefinition, tx, "mcp_servers", mcpID);
    if (!ok) {
      throw new Error(`MCP ${mcpID} not found`);
    }
    const deleteErr = tx.Where("mcp_id = ?", mcpID).Delete(new mcpFileRow()).Error;
    if (deleteErr != null) {
      throw deleteErr;
    }
    for (const file of files) {
      ValidateRelativeFilePath(file.Path);
      if (file.Content.length > MCPFileMaxBytes) {
        throw new Error(`MCP 文件 ${file.Path} 超过 1MB 限制`);
      }
      const sum = createHash("sha256").update(file.Content).digest("hex");
      upsert(tx, "mcp_files", {
        mcp_id: mcpID, path: file.Path, content: file.Content,
        size: file.Content.length, sha256: sum,
        unix_mode: NormalizeSkillFileMode(file.Mode), updated_at: now,
      });
    }
    refreshMCPFileRefs(tx, mcpID, now);
  });
};

/**
 * 在数据库事务内删除指定 MCP 服务器下的单个源码文件，并同步刷新其 `FileRefs` 元数据清单。
 *
 * @param {string} mcpID - 目标 MCP 服务器唯一标识。
 * @param {string} filePath - 待删除文件的相对路径。
 * @returns {void} 无返回值。
 * @throws {Error} 参数为空、数据库删除失败或刷新文件引用清单失败时抛出错误。
 */
CatalogRepo.prototype.DeleteMCPFile = function (mcpID, filePath) {
  if (mcpID === "" || filePath === "") {
    throw new Error("MCP id and path are required");
  }
  const now = new Date();
  this.DB.Transaction((tx) => {
    const err = tx.Where("mcp_id = ? AND path = ?", mcpID, filePath).Delete(new mcpFileRow()).Error;
    if (err != null) {
      throw err;
    }
    refreshMCPFileRefs(tx, mcpID, now);
  });
};

/**
 * 在事务内重新扫描 `mcp_files` 表并更新 `mcp_servers` 载荷中的 `FileRefs` 与 `UpdatedAt` 字段。
 * 供 `PutMCPFiles` 与 `DeleteMCPFile` 在文件变更后保持主表元数据一致。
 *
 * @param {object} tx - 当前事务的 `gorm.DB` 句柄。
 * @param {string} mcpID - 目标 MCP 服务器唯一标识。
 * @param {Date} now - 本次刷新写入的更新时间。
 * @returns {void} 无返回值。
 * @throws {Error} MCP 定义不存在、文件列表查询失败或主表 Upsert 失败时抛出错误。
 */
function refreshMCPFileRefs(tx, mcpID, now) {
  const [server, ok] = payloadOne(MCPServerDefinition, tx, "mcp_servers", mcpID);
  if (!ok) {
    throw new Error(`MCP ${mcpID} not found`);
  }
  const rows = [];
  const err = tx.Where("mcp_id = ?", mcpID).Order("path").Find(rows).Error;
  if (err != null) {
    throw err;
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
  upsert(tx, "mcp_servers", { id: server.ID, name: server.Name, payload: mustJSON(server), updated_at: timePtr(now) });
}

module.exports = { refreshMCPFileRefs };
