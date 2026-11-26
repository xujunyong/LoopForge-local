// previews.js —— 对应 Go 文件：internal/repo/previews.go
// 作用：运行预览、预览会话与预览包体的存取、认领与回收。

"use strict";

const { randomBytes } = require("node:crypto");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { RunPreview, PreviewSession, PreviewID, PreviewPending, PreviewArchiving, PreviewReady, PreviewFailed } = require("../domain/preview.js"); // 对应 Go 的 domain.RunPreview 等，preview.js 已翻译
const { PreviewsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runPreviewRow, previewSessionRow, previewBlobRow, runRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { upsert, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 本次一同翻译

// PreviewsRepo 的类型在 repo.js 里定义（*deps 嵌入提供 DB），方法在这里以 prototype 挂载。

PreviewsRepo.prototype.PutPreview = function (p) {
  if (p.ID.trim() === "") {
    p.ID = NewPreviewID(p.RunID);
  }
  const now = new Date();
  if (p.CreatedAt == null) {
    p.CreatedAt = now;
  }
  p.UpdatedAt = now;
  return upsert(this.DB, "run_previews", previewRowValues(p));
};

// ClaimPreviewArchive：原子抢本地/对账归档租约；同一时刻只有一个持有者，过期归档行可被回收。
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

// MarkPreviewReadyIfArchiving：只从归档中写就绪结果；并发的失败或删除不会被迟到的成功覆盖。
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

// FailPreviewIfOpen：只在预览仍为待处理或归档中时记失败；就绪/过期/已删的行不动。
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

PreviewsRepo.prototype.Preview = function (id) {
  const row = new runPreviewRow();
  if (this.DB.Where("id = ?", id).Take(row).Error != null) {
    return [new RunPreview(), false];
  }
  return [previewFromRow(row), true];
};

PreviewsRepo.prototype.PreviewByRun = function (runID) {
  const row = new runPreviewRow();
  if (this.DB.Where("run_id = ?", runID).Take(row).Error != null) {
    return [new RunPreview(), false];
  }
  return [previewFromRow(row), true];
};

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

PreviewsRepo.prototype.MarkPreviewAccessed = function (id, now) {
  return this.DB.Model(new runPreviewRow()).Where("id = ?", id).Updates({
    last_accessed_at: now, updated_at: now,
  }).Error;
};

PreviewsRepo.prototype.UpdatePreviewBackendURL = function (id, backendURL) {
  id = id.trim();
  if (id === "") {
    return new Error("empty preview id");
  }
  backendURL = backendURL.trim();
  const now = new Date();
  return this.DB.Transaction((tx) => {
    const err = tx.Model(new runPreviewRow()).
      Where("id = ?", id).
      Updates({
        backend_url: backendURL,
        updated_at: now,
      }).Error;
    if (err != null) {
      return err;
    }
    return tx.Model(new previewSessionRow()).
      Where("preview_id = ? AND revoked_at IS NULL", id).
      Update("backend_url", backendURL).Error;
  });
};

PreviewsRepo.prototype.SetRunWorkspaceCleanupHold = function (runID, until) {
  return this.DB.Model(new runRow()).Where("id = ?", runID).Update("workspace_cleanup_not_before", timePtr(until)).Error;
};

PreviewsRepo.prototype.ClearRunWorkspaceCleanupHold = function (runID) {
  return this.DB.Model(new runRow()).Where("id = ?", runID).Update("workspace_cleanup_not_before", null).Error;
};

PreviewsRepo.prototype.PutPreviewSession = function (s) {
  if (s.ID.trim() === "") {
    let raw;
    try {
      raw = randomBytes(8);
    } catch (err) {
      return err;
    }
    s.ID = "ps-" + raw.toString("hex");
  }
  const now = new Date();
  if (s.CreatedAt == null) {
    s.CreatedAt = now;
  }
  return upsert(this.DB, "preview_sessions", {
    id: s.ID, preview_id: s.PreviewID, token_hash: s.TokenHash, backend_url: s.BackendURL,
    expires_at: timePtr(s.ExpiresAt), created_at: timePtr(s.CreatedAt),
    last_accessed_at: timePtr(s.LastAccessedAt), revoked_at: timePtr(s.RevokedAt),
  });
};

PreviewsRepo.prototype.PreviewSessionByTokenHash = function (hash) {
  const row = new previewSessionRow();
  if (this.DB.Where("token_hash = ?", hash).Take(row).Error != null) {
    return [new PreviewSession(), false];
  }
  return [sessionFromRow(row), true];
};

PreviewsRepo.prototype.PreviewSession = function (id) {
  const row = new previewSessionRow();
  if (this.DB.Where("id = ?", id).Take(row).Error != null) {
    return [new PreviewSession(), false];
  }
  return [sessionFromRow(row), true];
};

PreviewsRepo.prototype.RevokePreviewSession = function (id, now) {
  return this.DB.Model(new previewSessionRow()).Where("id = ?", id).Updates({
    revoked_at: now,
  }).Error;
};

PreviewsRepo.prototype.TouchPreviewSession = function (id, expiresAt, accessedAt) {
  return this.DB.Model(new previewSessionRow()).Where("id = ?", id).Updates({
    expires_at: timePtr(expiresAt), last_accessed_at: timePtr(accessedAt),
  }).Error;
};

PreviewsRepo.prototype.DeletePreview = function (id) {
  return this.DB.Transaction((tx) => {
    const err = tx.Where("preview_id = ?", id).Delete(new previewSessionRow()).Error;
    if (err != null) {
      return err;
    }
    return tx.Where("id = ?", id).Delete(new runPreviewRow()).Error;
  });
};

PreviewsRepo.prototype.CountReadyStorageKey = function (key) {
  // Go 的 Count(&n) 用对象接出参。
  const n = { value: 0 };
  const err = this.DB.Model(new runPreviewRow()).Where("storage_key = ? AND status = ?", key, PreviewReady).Count(n).Error;
  if (err != null) {
    throw err;
  }
  return n.value;
};

PreviewsRepo.prototype.PutPreviewBlob = function (sha256Hex, content) {
  sha256Hex = sha256Hex.toLowerCase().trim();
  if (sha256Hex.length !== 64) {
    return new Error("invalid preview blob sha256");
  }
  const now = new Date();
  const row = new previewBlobRow({ SHA256: sha256Hex, Content: content, Size: content.length, Created: now });
  return this.DB.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
};

PreviewsRepo.prototype.PreviewBlob = function (sha256Hex) {
  const row = new previewBlobRow();
  if (this.DB.Where("sha256 = ?", sha256Hex.toLowerCase().trim()).Take(row).Error != null) {
    return [null, 0, false];
  }
  return [row.Content, row.Size, true];
};

PreviewsRepo.prototype.DeletePreviewBlob = function (sha256Hex) {
  return this.DB.Where("sha256 = ?", sha256Hex.toLowerCase().trim()).Delete(new previewBlobRow()).Error;
};

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

function NewPreviewID(runID) {
  return PreviewID(runID);
}

function PreviewNotFound(runID) {
  return new Error(`preview for run ${runID} not found`);
}

module.exports = { previewFromRow, previewRowValues, sessionFromRow, NewPreviewID, PreviewNotFound };
