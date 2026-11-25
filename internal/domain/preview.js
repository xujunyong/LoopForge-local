// preview.js —— 对应 Go 文件：internal/domain/preview.go
// 作用：前端预览合约、预览记录与会话。

"use strict";

// PreviewID：一次运行的稳定预览 ID：每个运行一个预览。
function PreviewID(runID) {
  runID = runID.trim();
  if (runID === "") {
    return "preview";
  }
  return "preview-" + runID;
}

// ErrInvalidPreviewBackendURL：预览会话后端 URL 不是无凭据的 http(s) 源时返回。
const ErrInvalidPreviewBackendURL = new Error("preview backendUrl must be an http(s) URL without credentials");

const PreviewKindStatic = "static";

const PreviewPending = "pending";
const PreviewArchiving = "archiving";
const PreviewReady = "ready";
const PreviewSkipped = "skipped";
const PreviewFailed = "failed";
const PreviewExpired = "expired";
const PreviewDeleting = "deleting";
const PreviewDeleted = "deleted";

const PreviewBuildNodeID = "af-preview-build";
const PreviewBuildAgentID = "af-preview-builder";
const PreviewBuildExecutor = "codebuddy";
const PreviewDefaultModel = "default";
const PreviewDefaultSource = "dist";
const PreviewBuildEdgeID = "af-preview-build-edge";
const PreviewMaxRetentionSec = 30 * 24 * 3600;

// PreviewContract：冻结进 WorkflowSnapshot 的运行级交付合约；启用后注入构建节点；该节点成功时归档静态站点，之后确认即可在运行结束前打开预览。
class PreviewContract {
  constructor(init = {}) {
    this.Enabled = init.Enabled ?? false;
    this.Kind = init.Kind ?? "";
    this.ExecutorID = init.ExecutorID ?? "";
    this.Model = init.Model ?? "";
    this.SourcePath = init.SourcePath ?? "";
    this.IndexFile = init.IndexFile ?? "";
    this.SPAFallback = init.SPAFallback ?? false;
    this.Required = init.Required ?? false;
    this.CaptureShot = init.CaptureShot ?? false;
    this.RetentionSec = init.RetentionSec ?? 0;
  }

  // Static：该合约是否要求运行 MVP 静态终结器。
  Static() {
    if (this == null || !this.Enabled) {
      return false;
    }
    const kind = this.Kind.trim();
    return kind === "" || kind.toLowerCase() === PreviewKindStatic;
  }

  Index() {
    if (this == null) {
      return "index.html";
    }
    const name = this.IndexFile.trim();
    if (name !== "") {
      return name;
    }
    return "index.html";
  }

  KindOrStatic() {
    if (this == null || this.Kind.trim() === "") {
      return PreviewKindStatic;
    }
    return this.Kind.trim();
  }

  SourceOrDist() {
    if (this == null) {
      return PreviewDefaultSource;
    }
    const path = this.SourcePath.trim();
    if (path !== "") {
      return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    }
    return PreviewDefaultSource;
  }

  SelectedExecutorID() {
    if (this == null) {
      return "";
    }
    const id = this.ExecutorID.trim();
    if (id !== "") {
      return id;
    }
    const model = this.Model.trim();
    if (model !== "" && model !== PreviewDefaultModel && model !== "default-model") {
      // 旧版预览合约可能只钉了一个 CodeBuddy 模型，未指定执行机。
      return PreviewBuildExecutor;
    }
    return "";
  }

  ModelOrDefault() {
    if (this == null) {
      return PreviewDefaultModel;
    }
    const model = this.Model.trim();
    if (model !== "") {
      return model;
    }
    return PreviewDefaultModel;
  }

  // Retention：保留期；time.Duration 译为毫秒数。
  Retention() {
    if (this == null) {
      return PreviewMaxRetentionSec * 1000;
    }
    let sec = this.RetentionSec;
    if (sec <= 0 || sec > PreviewMaxRetentionSec) {
      sec = PreviewMaxRetentionSec;
    }
    return sec * 1000;
  }

  EntryRel() {
    return (this.SourceOrDist() + "/" + this.Index()).replace(/^\/+|\/+$/g, "");
  }

  Normalize() {
    if (this == null || !this.Enabled) {
      return;
    }
    this.Kind = this.KindOrStatic();
    this.ExecutorID = this.SelectedExecutorID();
    if (this.ExecutorID === "") {
      this.Model = "";
    } else {
      this.Model = this.ModelOrDefault();
    }
    this.SourcePath = this.SourceOrDist();
    this.IndexFile = this.Index();
    if (this.RetentionSec <= 0 || this.RetentionSec > PreviewMaxRetentionSec) {
      this.RetentionSec = PreviewMaxRetentionSec;
    }
  }

  // Validate：校验合约，失败时 throw。
  Validate() {
    if (this == null || !this.Enabled) {
      return;
    }
    this.Normalize();
    if (!this.Static()) {
      throw new Error("frontend preview currently supports static sites only");
    }
    if (this.SourcePath.includes("..") || this.SourcePath.startsWith("/")) {
      throw new Error(`frontend preview sourcePath ${JSON.stringify(this.SourcePath)} is invalid`);
    }
  }
}

function IsPreviewBuildNode(id) {
  return id.trim() === PreviewBuildNodeID;
}

function IsPreviewBuildAgent(id) {
  id = id.trim();
  return id === PreviewBuildAgentID || id === PreviewBuildNodeID;
}

// NormalizePreviewBackendURL：接受空值或 http(s) URL；打开预览时才选 URL，不存到 SOP 上。
function NormalizePreviewBackendURL(raw) {
  raw = raw.trim();
  if (raw === "") {
    return "";
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw ErrInvalidPreviewBackendURL;
  }
  if (u.host === "" || u.username !== "" || u.password !== "" || (u.protocol !== "http:" && u.protocol !== "https:")) {
    throw ErrInvalidPreviewBackendURL;
  }
  u.hash = "";
  return u.toString();
}

// RunPreview：已交付前端预览的持久元数据；二进制包存在 PreviewStore，永不进 run_artifacts.content。
class RunPreview {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.RunID = init.RunID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Kind = init.Kind ?? "";
    this.Status = init.Status ?? "";
    this.SourcePath = init.SourcePath ?? "";
    this.StorageKey = init.StorageKey ?? "";
    this.ContentSHA256 = init.ContentSHA256 ?? "";
    this.CompressedSize = init.CompressedSize ?? 0;
    this.ExpandedSize = init.ExpandedSize ?? 0;
    this.FileCount = init.FileCount ?? 0;
    this.EntryFile = init.EntryFile ?? "";
    this.SPAFallback = init.SPAFallback ?? false;
    this.BackendURL = init.BackendURL ?? "";
    this.OwnerRunnerID = init.OwnerRunnerID ?? "";
    this.ScreenshotKey = init.ScreenshotKey ?? "";
    this.ErrorText = init.ErrorText ?? "";
    this.UploadTokenHash = init.UploadTokenHash ?? "";
    this.UploadMaxBytes = init.UploadMaxBytes ?? 0;
    this.UploadExpiresAt = init.UploadExpiresAt ?? null;
    this.ArchiveLeaseUntil = init.ArchiveLeaseUntil ?? null;
    this.LastAccessedAt = init.LastAccessedAt ?? null;
    this.ExpiresAt = init.ExpiresAt ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  ActiveHold() {
    switch (this.Status) {
      case PreviewPending:
      case PreviewArchiving:
        return true;
      default:
        return false;
    }
  }

  Serveable() {
    return this.Status === PreviewReady && this.StorageKey.trim() !== "";
  }
}

// PreviewSession：/preview/{token}/ 的短期访问授权；数据库只存 token 哈希；BackendURL 在会话创建时选定，Studio 可据此指向后端，而不必写进 SOP。
class PreviewSession {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.PreviewID = init.PreviewID ?? "";
    this.TokenHash = init.TokenHash ?? "";
    this.BackendURL = init.BackendURL ?? "";
    this.ExpiresAt = init.ExpiresAt ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.LastAccessedAt = init.LastAccessedAt ?? null;
    this.RevokedAt = init.RevokedAt ?? null;
  }

  Live(now) {
    if (this.RevokedAt != null) {
      return false;
    }
    return this.ExpiresAt == null || !(this.ExpiresAt.getTime() < now.getTime());
  }
}

// RunnerPreviewArchiveSpec：内置的执行机动作载荷；包体走专用上传端点流式传输，永不经过任务 JSON。
class RunnerPreviewArchiveSpec {
  constructor(init = {}) {
    this.PreviewID = init.PreviewID ?? "";
    this.RunID = init.RunID ?? "";
    this.SourcePath = init.SourcePath ?? "";
    this.IndexFile = init.IndexFile ?? "";
    this.SPAFallback = init.SPAFallback ?? false;
    this.MaxFiles = init.MaxFiles ?? 0;
    this.MaxBytes = init.MaxBytes ?? 0;
    this.UploadURL = init.UploadURL ?? "";
    this.UploadToken = init.UploadToken ?? "";
  }
}

module.exports = { PreviewID, ErrInvalidPreviewBackendURL, PreviewKindStatic, PreviewPending, PreviewArchiving, PreviewReady, PreviewSkipped, PreviewFailed, PreviewExpired, PreviewDeleting, PreviewDeleted, PreviewBuildNodeID, PreviewBuildAgentID, PreviewBuildExecutor, PreviewDefaultModel, PreviewDefaultSource, PreviewBuildEdgeID, PreviewMaxRetentionSec, PreviewContract, IsPreviewBuildNode, IsPreviewBuildAgent, NormalizePreviewBackendURL, RunPreview, PreviewSession, RunnerPreviewArchiveSpec };
