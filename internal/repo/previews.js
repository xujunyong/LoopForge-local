/**
 * @file internal/repo/previews.js
 * 对应 Go 源文件：internal/repo/previews.go
 *
 * 作用与职责边界：
 * 实现运行预览（`run_previews`）、预览访问会话（`preview_sessions`）与预览归档包体（`preview_blobs`）的
 * 持久化读写、归档租约原子认领、状态流转、工作区清理延后标记及过期回收查询；
 * 方法通过 `PreviewsRepo.prototype` 挂载（`PreviewsRepo` 类定义在 `repo.js` 中，继承 `deps`），不负责对象存储 I/O 或 HTTP 代理。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)`、`(值1, 值2, error)` 与仅 `error` 返回统一按成功返回值/元组（或 `undefined`）、失败 `throw err` 处理；
 *   `db.Transaction(tx => ...)` 回调同样失败抛错、成功正常返回。
 * - Go 的 `(值, bool)` 与 `([]byte, int64, bool)` 译为二元组/三元组返回；`gorm` 的 `Count(&n)` 用出参对象 `{ value: 0 }` 表达。
 * - Go 的 `time.Time` 对应 `Date`（零值 `null`），`crypto/rand` 对应 `node:crypto` 的 `randomBytes`。
 */

"use strict";

const { randomBytes } = require("node:crypto");

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { RunPreview, PreviewSession, PreviewID, PreviewPending, PreviewArchiving, PreviewReady, PreviewFailed } = require("../domain/preview.js"); // 对应 Go 的 domain.RunPreview 等，preview.js 已翻译
const { PreviewsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runPreviewRow, previewSessionRow, previewBlobRow, runRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { upsert, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译

// PreviewsRepo 的类型在 repo.js 里定义（继承 deps 提供 DB），方法在本文件以 prototype 挂载。

/**
 * 将数据库行模型 `runPreviewRow` 转换为领域对象 `RunPreview`。
 * 供所有预览查询方法组装领域返回结果时调用。
 *
 * @param {runPreviewRow} row - 从 `run_previews` 表读出的持久化行对象。
 * @returns {RunPreview} 映射后的运行预览领域对象。
 */
function previewFromRow(row) {
  const p = new RunPreview({
    ID: row.ID, RunID: row.RunID, ProjectID: row.ProjectID, Kind: row.Kind, Status: row.Status,
    SourcePath: row.SourcePath, StorageKey: row.StorageKey, ContentSHA256: row.ContentSHA256,
    CompressedSize: row.CompressedSize, ExpandedSize: row.ExpandedSize, FileCount: row.FileCount,
    EntryFile: row.EntryFile, SPAFallback: row.SPAFallback, BackendURL: row.BackendURL, OwnerRunnerID: row.OwnerRunnerID,
    ScreenshotKey: row.ScreenshotKey, ErrorText: row.ErrorText, UploadTokenHash: row.UploadTokenHash,
    UploadMaxBytes: row.UploadMaxBytes,
  });
  if (row.UploadExpiresAt != null) {
    p.UploadExpiresAt = row.UploadExpiresAt;
  }
  if (row.ArchiveLeaseUntil != null) {
    p.ArchiveLeaseUntil = row.ArchiveLeaseUntil;
  }
  if (row.LastAccessedAt != null) {
    p.LastAccessedAt = row.LastAccessedAt;
  }
  if (row.ExpiresAt != null) {
    p.ExpiresAt = row.ExpiresAt;
  }
  if (row.Created != null) {
    p.CreatedAt = row.Created;
  }
  if (row.Updated != null) {
    p.UpdatedAt = row.Updated;
  }
  return p;
}

/**
 * 将 `RunPreview` 领域对象展开为 `run_previews` 表的列名到字段值的映射对象。
 * 供 `PutPreview` 与 `MarkPreviewReadyIfArchiving` 写入或更新表行使用。
 *
 * @param {RunPreview} p - 运行预览领域对象。
 * @returns {Object<string, any>} 物理表列名到列值的映射对象。
 */
function previewRowValues(p) {
  return {
    id: p.ID, run_id: p.RunID, project_id: p.ProjectID, kind: p.Kind, status: p.Status,
    source_path: p.SourcePath, storage_key: p.StorageKey, content_sha256: p.ContentSHA256,
    compressed_size: p.CompressedSize, expanded_size: p.ExpandedSize, file_count: p.FileCount,
    entry_file: p.EntryFile, spa_fallback: p.SPAFallback, backend_url: p.BackendURL, owner_runner_id: p.OwnerRunnerID,
    screenshot_key: p.ScreenshotKey, error_text: p.ErrorText, upload_token_hash: p.UploadTokenHash,
    upload_max_bytes: p.UploadMaxBytes, upload_expires_at: timePtr(p.UploadExpiresAt),
    archive_lease_until: timePtr(p.ArchiveLeaseUntil),
    last_accessed_at: timePtr(p.LastAccessedAt), expires_at: timePtr(p.ExpiresAt),
    created_at: timePtr(p.CreatedAt), updated_at: timePtr(p.UpdatedAt),
  };
}

/**
 * 创建或覆盖写入一条运行预览记录。
 * 当 `p.ID` 为空时自动按 `p.RunID` 推导主键，并在首次写入时补全 `CreatedAt` 与 `UpdatedAt`。
 *
 * @param {RunPreview} p - 待保存的运行预览对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
PreviewsRepo.prototype.PutPreview = function (p) {
  if (p.ID.trim() === "") {
    p.ID = NewPreviewID(p.RunID);
  }
  const now = new Date();
  if (p.CreatedAt == null) {
    p.CreatedAt = now;
  }
  p.UpdatedAt = now;
  upsert(this.DB, "run_previews", previewRowValues(p));
};

/**
 * 原子抢占指定预览的本地或对账归档租约。
 * 仅允许从 `pending` 状态或租约已过期的 `archiving` 状态抢占，保证同一时刻仅有一个归档持有者。
 *
 * @param {string} id - 运行预览主键 ID。
 * @param {Date} now - 当前 UTC 时间，用于校验旧归档租约是否已过期。
 * @param {Date} until - 本次申请的新归档租约截止时间。
 * @returns {[RunPreview, boolean]} 二元组 `[preview, claimed]`；成功抢占并回读记录时为 `[preview, true]`，否则为 `[空 RunPreview, false]`。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
PreviewsRepo.prototype.ClaimPreviewArchive = function (id, now, until) {
  id = id.trim();
  if (id === "") {
    return [new RunPreview(), false];
  }
  now = new Date(now.getTime());
  until = new Date(until.getTime());
  const result = this.DB.Model(new runPreviewRow()).
    Where("id = ? AND (status = ? OR (status = ? AND (archive_lease_until IS NULL OR archive_lease_until <= ?)))",
      id, PreviewPending, PreviewArchiving, now).
    Updates({
      status: PreviewArchiving,
      error_text: "",
      archive_lease_until: timePtr(until),
      updated_at: now,
    });
  if (result.Error != null) {
    throw result.Error;
  }
  if (result.RowsAffected !== 1) {
    return [new RunPreview(), false];
  }
  return this.Preview(id);
};

/**
 * 仅当预览当前处于 `archiving` 状态时写入就绪元数据并将状态切换为 `ready`。
 * 可防止迟到的成功回调覆盖已经并发发生的失败或删除操作。
 *
 * @param {RunPreview} p - 包含存储键、校验和、入口文件等就绪信息的预览对象。
 * @returns {boolean} 成功将行从 `archiving` 推进到 `ready` 时返回 `true`，否则返回 `false`。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
PreviewsRepo.prototype.MarkPreviewReadyIfArchiving = function (p) {
  const now = new Date();
  p.Status = PreviewReady;
  p.UpdatedAt = now;
  p.ArchiveLeaseUntil = null;
  p.ErrorText = "";
  p.UploadTokenHash = "";
  const values = previewRowValues(p);
  delete values["id"];
  delete values["run_id"];
  delete values["created_at"];
  const result = this.DB.Model(new runPreviewRow()).
    Where("id = ? AND status = ?", p.ID, PreviewArchiving).
    Updates(values);
  if (result.Error != null) {
    throw result.Error;
  }
  return result.RowsAffected === 1;
};

/**
 * 仅当预览仍处于 `pending` 或 `archiving` 状态时记录失败原因并清理上传令牌与租约。
 * 已就绪、已过期或已删除的预览行不会被改动。
 *
 * @param {string} id - 运行预览主键 ID。
 * @param {string} errText - 失败说明文本。
 * @param {Date} now - 记录失败时的当前 UTC 时间。
 * @returns {boolean} 命中开放状态并成功标记失败时返回 `true`，否则返回 `false`。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
PreviewsRepo.prototype.FailPreviewIfOpen = function (id, errText, now) {
  id = id.trim();
  if (id === "") {
    return false;
  }
  now = new Date(now.getTime());
  const result = this.DB.Model(new runPreviewRow()).
    Where("id = ? AND status IN ?", id, [PreviewPending, PreviewArchiving]).
    Updates({
      status: PreviewFailed,
      error_text: errText,
      upload_token_hash: "",
      archive_lease_until: null,
      updated_at: now,
    });
  if (result.Error != null) {
    throw result.Error;
  }
  return result.RowsAffected === 1;
};

/**
 * 按预览主键 ID 查询单条运行预览记录。
 *
 * @param {string} id - 运行预览主键 ID。
 * @returns {[RunPreview, boolean]} 找到时返回 `[preview, true]`，未找到或查询失败时返回 `[空 RunPreview, false]`。
 */
PreviewsRepo.prototype.Preview = function (id) {
  const row = new runPreviewRow();
  if (this.DB.Where("id = ?", id).Take(row).Error != null) {
    return [new RunPreview(), false];
  }
  return [previewFromRow(row), true];
};

/**
 * 按所属运行 ID 查询对应的运行预览记录。
 *
 * @param {string} runID - 运行记录 ID。
 * @returns {[RunPreview, boolean]} 找到时返回 `[preview, true]`，未找到或查询失败时返回 `[空 RunPreview, false]`。
 */
PreviewsRepo.prototype.PreviewByRun = function (runID) {
  const row = new runPreviewRow();
  if (this.DB.Where("run_id = ?", runID).Take(row).Error != null) {
    return [new RunPreview(), false];
  }
  return [previewFromRow(row), true];
};

/**
 * 查询指定状态下的全部运行预览记录。
 * 常用于后台对账与巡检 `pending`/`archiving` 等状态的预览。
 *
 * @param {string} status - 目标预览状态常量。
 * @returns {RunPreview[] | null} 匹配的预览数组；查询出错时返回 `null`。
 */
PreviewsRepo.prototype.PreviewsByStatus = function (status) {
  const rows = [];
  if (this.DB.Where("status = ?", status).Find(rows).Error != null) {
    return null;
  }
  const out = [];
  for (const row of rows) {
    out.push(previewFromRow(row));
  }
  return out;
};

/**
 * 查询所有处于 `ready` 状态且已到过期时间的预览记录。
 * 供后台预览过期清理任务批量回收资源时使用。
 *
 * @param {Date} now - 判定过期所依据的当前时间。
 * @returns {RunPreview[] | null} 已过期的就绪预览数组；查询出错时返回 `null`。
 */
PreviewsRepo.prototype.ExpiredReadyPreviews = function (now) {
  const rows = [];
  if (this.DB.Where("status = ? AND expires_at IS NOT NULL AND expires_at <= ?", PreviewReady, now).
    Find(rows).Error != null) {
    return null;
  }
  const out = [];
  for (const row of rows) {
    out.push(previewFromRow(row));
  }
  return out;
};

/**
 * 查询引用同一对象存储键（`storage_key`）且处于 `ready` 状态的全部预览记录。
 * 用于去重存储引用检查。
 *
 * @param {string} key - 预览归档的存储键。
 * @returns {RunPreview[] | null} 匹配的就绪预览数组；查询出错时返回 `null`。
 */
PreviewsRepo.prototype.ReadyPreviewsByStorageKey = function (key) {
  const rows = [];
  if (this.DB.Where("storage_key = ? AND status = ?", key, PreviewReady).Find(rows).Error != null) {
    return null;
  }
  const out = [];
  for (const row of rows) {
    out.push(previewFromRow(row));
  }
  return out;
};

/**
 * 更新指定预览的最近访问时间与更新时间。
 * 在用户打开或刷新预览页面时调用，用于活跃度追踪与过期续期参考。
 *
 * @param {string} id - 运行预览主键 ID。
 * @param {Date} now - 本次访问时间。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
PreviewsRepo.prototype.MarkPreviewAccessed = function (id, now) {
  const err = this.DB.Model(new runPreviewRow()).Where("id = ?", id).Updates({
    last_accessed_at: now, updated_at: now,
  }).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 在同一事务中同步更新预览及其所有未撤销会话的后端代理地址（`backend_url`）。
 * 用于预览关联的后端服务地址发生变更或重新拉起时保持会话一致。
 *
 * @param {string} id - 运行预览主键 ID。
 * @param {string} backendURL - 新的后端代理 URL（首尾空白会被裁去）。
 * @returns {void} 无返回值。
 * @throws {Error} 预览 ID 为空或事务内任一更新失败时抛出错误。
 */
PreviewsRepo.prototype.UpdatePreviewBackendURL = function (id, backendURL) {
  id = id.trim();
  if (id === "") {
    throw new Error("empty preview id");
  }
  backendURL = backendURL.trim();
  const now = new Date();
  this.DB.Transaction((tx) => {
    const err = tx.Model(new runPreviewRow()).
      Where("id = ?", id).
      Updates({
        backend_url: backendURL,
        updated_at: now,
      }).Error;
    if (err != null) {
      throw err;
    }
    const sessionErr = tx.Model(new previewSessionRow()).
      Where("preview_id = ? AND revoked_at IS NULL", id).
      Update("backend_url", backendURL).Error;
    if (sessionErr != null) {
      throw sessionErr;
    }
  });
};

/**
 * 为指定运行设置工作区清理保护截止时间（`workspace_cleanup_not_before`）。
 * 在实时预览依赖运行工作区时防止后台清理任务提前删除目录。
 *
 * @param {string} runID - 运行记录 ID。
 * @param {Date} until - 最早允许清理工作区的截止时间。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
PreviewsRepo.prototype.SetRunWorkspaceCleanupHold = function (runID, until) {
  const err = this.DB.Model(new runRow()).Where("id = ?", runID).Update("workspace_cleanup_not_before", timePtr(until)).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 清除指定运行的工作区清理保护标记，恢复正常清理策略。
 * 在预览停止或归档完成后调用。
 *
 * @param {string} runID - 运行记录 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
PreviewsRepo.prototype.ClearRunWorkspaceCleanupHold = function (runID) {
  const err = this.DB.Model(new runRow()).Where("id = ?", runID).Update("workspace_cleanup_not_before", null).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 将数据库行模型 `previewSessionRow` 转换为领域对象 `PreviewSession`。
 * 供预览会话查询方法使用。
 *
 * @param {previewSessionRow} row - 从 `preview_sessions` 表读出的持久化行对象。
 * @returns {PreviewSession} 映射后的预览会话领域对象。
 */
function sessionFromRow(row) {
  const s = new PreviewSession({ ID: row.ID, PreviewID: row.PreviewID, TokenHash: row.TokenHash, BackendURL: row.BackendURL });
  if (row.ExpiresAt != null) {
    s.ExpiresAt = row.ExpiresAt;
  }
  if (row.Created != null) {
    s.CreatedAt = row.Created;
  }
  if (row.LastAccessedAt != null) {
    s.LastAccessedAt = row.LastAccessedAt;
  }
  if (row.RevokedAt != null) {
    s.RevokedAt = row.RevokedAt;
  }
  return s;
}

/**
 * 创建或覆盖写入一条预览访问会话记录。
 * 当 `s.ID` 为空时生成 `"ps-<16位十六进制>"` 随机主键，并在首次写入时补全 `CreatedAt`。
 *
 * @param {PreviewSession} s - 待保存的预览会话对象。
 * @returns {void} 无返回值。
 * @throws {Error} 随机字节生成失败或数据库写入失败时抛出错误。
 */
PreviewsRepo.prototype.PutPreviewSession = function (s) {
  if (s.ID.trim() === "") {
    const raw = randomBytes(8);
    s.ID = "ps-" + raw.toString("hex");
  }
  const now = new Date();
  if (s.CreatedAt == null) {
    s.CreatedAt = now;
  }
  upsert(this.DB, "preview_sessions", {
    id: s.ID, preview_id: s.PreviewID, token_hash: s.TokenHash, backend_url: s.BackendURL,
    expires_at: timePtr(s.ExpiresAt), created_at: timePtr(s.CreatedAt),
    last_accessed_at: timePtr(s.LastAccessedAt), revoked_at: timePtr(s.RevokedAt),
  });
};

/**
 * 按会话令牌哈希查询单条预览访问会话。
 * 用于预览网关校验 Cookie/Token 合法性。
 *
 * @param {string} hash - 会话令牌哈希值。
 * @returns {[PreviewSession, boolean]} 找到时返回 `[session, true]`，否则返回 `[空 PreviewSession, false]`。
 */
PreviewsRepo.prototype.PreviewSessionByTokenHash = function (hash) {
  const row = new previewSessionRow();
  if (this.DB.Where("token_hash = ?", hash).Take(row).Error != null) {
    return [new PreviewSession(), false];
  }
  return [sessionFromRow(row), true];
};

/**
 * 按主键 ID 查询单条预览访问会话。
 *
 * @param {string} id - 预览会话主键 ID。
 * @returns {[PreviewSession, boolean]} 找到时返回 `[session, true]`，否则返回 `[空 PreviewSession, false]`。
 */
PreviewsRepo.prototype.PreviewSession = function (id) {
  const row = new previewSessionRow();
  if (this.DB.Where("id = ?", id).Take(row).Error != null) {
    return [new PreviewSession(), false];
  }
  return [sessionFromRow(row), true];
};

/**
 * 将指定预览访问会话标记为已撤销，写入撤销时间戳。
 *
 * @param {string} id - 预览会话主键 ID。
 * @param {Date} now - 撤销时间。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
PreviewsRepo.prototype.RevokePreviewSession = function (id, now) {
  const err = this.DB.Model(new previewSessionRow()).Where("id = ?", id).Updates({
    revoked_at: now,
  }).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 刷新指定预览访问会话的过期时间与最近访问时间。
 * 在滑动过期续期场景下调用。
 *
 * @param {string} id - 预览会话主键 ID。
 * @param {Date} expiresAt - 新的过期时间。
 * @param {Date} accessedAt - 本次访问时间。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
PreviewsRepo.prototype.TouchPreviewSession = function (id, expiresAt, accessedAt) {
  const err = this.DB.Model(new previewSessionRow()).Where("id = ?", id).Updates({
    expires_at: timePtr(expiresAt), last_accessed_at: timePtr(accessedAt),
  }).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 在同一事务中级联删除指定预览关联的全部会话记录与预览主记录。
 * 用于手动删除预览或过期回收。
 *
 * @param {string} id - 待删除的运行预览主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 事务内删除会话或预览行失败时抛出错误。
 */
PreviewsRepo.prototype.DeletePreview = function (id) {
  this.DB.Transaction((tx) => {
    const err = tx.Where("preview_id = ?", id).Delete(new previewSessionRow()).Error;
    if (err != null) {
      throw err;
    }
    const previewErr = tx.Where("id = ?", id).Delete(new runPreviewRow()).Error;
    if (previewErr != null) {
      throw previewErr;
    }
  });
};

/**
 * 根据运行 ID 生成对应的确定性预览 ID。
 * 委托 `domain.PreviewID` 保持全仓库一致的命名规则。
 *
 * @param {string} runID - 运行记录 ID。
 * @returns {string} 对应的预览主键 ID。
 */
function NewPreviewID(runID) {
  return PreviewID(runID);
}

/**
 * 统计当前引用指定存储键（`storage_key`）且状态为 `ready` 的预览记录数量。
 * 用于删除共享归档包体前确认是否仍有活跃预览引用。
 *
 * @param {string} key - 预览归档存储键。
 * @returns {number} 处于 `ready` 状态的引用计数。
 * @throws {Error} 数据库统计查询失败时抛出错误。
 */
PreviewsRepo.prototype.CountReadyStorageKey = function (key) {
  // Go 的 Count(&n) 在 JS 中通过出参对象承接计数结果。
  const n = { value: 0 };
  const err = this.DB.Model(new runPreviewRow()).Where("storage_key = ? AND status = ?", key, PreviewReady).Count(n).Error;
  if (err != null) {
    throw err;
  }
  return n.value;
};

/**
 * 按内容 SHA-256 哈希幂等存入一份预览归档二进制包体（主键冲突时忽略写入）。
 * 供数据库存储后端保存压缩预览产物使用。
 *
 * @param {string} sha256Hex - 64 位十六进制 SHA-256 摘要。
 * @param {Buffer | Uint8Array} content - 预览归档二进制内容。
 * @returns {void} 无返回值。
 * @throws {Error} 摘要长度不是 64 或数据库写入失败时抛出错误。
 */
PreviewsRepo.prototype.PutPreviewBlob = function (sha256Hex, content) {
  sha256Hex = sha256Hex.toLowerCase().trim();
  if (sha256Hex.length !== 64) {
    throw new Error("invalid preview blob sha256");
  }
  const now = new Date();
  const row = new previewBlobRow({ SHA256: sha256Hex, Content: content, Size: content.length, Created: now });
  const err = this.DB.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 按内容 SHA-256 哈希读取已存储的预览归档二进制包体及其字节大小。
 *
 * @param {string} sha256Hex - 64 位十六进制 SHA-256 摘要。
 * @returns {[Buffer | Uint8Array | null, number, boolean]} 三元组 `[content, size, found]`；未找到时返回 `[null, 0, false]`。
 */
PreviewsRepo.prototype.PreviewBlob = function (sha256Hex) {
  const row = new previewBlobRow();
  if (this.DB.Where("sha256 = ?", sha256Hex.toLowerCase().trim()).Take(row).Error != null) {
    return [null, 0, false];
  }
  return [row.Content, row.Size, true];
};

/**
 * 按内容 SHA-256 哈希删除已存储的预览归档二进制包体。
 *
 * @param {string} sha256Hex - 64 位十六进制 SHA-256 摘要。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库删除失败时抛出错误。
 */
PreviewsRepo.prototype.DeletePreviewBlob = function (sha256Hex) {
  const err = this.DB.Where("sha256 = ?", sha256Hex.toLowerCase().trim()).Delete(new previewBlobRow()).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 构造表示指定运行尚未生成预览的错误对象。
 * 供上层接口在按运行查找预览失败时返回统一错误文案。
 *
 * @param {string} runID - 运行记录 ID。
 * @returns {Error} 描述对应运行预览不存在的错误实例。
 */
function PreviewNotFound(runID) {
  return new Error(`preview for run ${runID} not found`);
}

module.exports = { previewFromRow, previewRowValues, sessionFromRow, NewPreviewID, PreviewNotFound };
