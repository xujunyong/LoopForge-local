/**
 * @file internal/domain/preview.js
 * @description 对应 Go 源文件：internal/domain/preview.go
 * 职责边界：定义前端静态预览的交付合约、预览记录元数据、预览短期访问会话、执行机归档载荷以及相关的校验与规范化方法。
 * 语法差异说明：
 * - Go 的 `time.Duration` 译为毫秒数（`number`）；`time.Time` 译为 `Date | null`（零值为 `null`）。
 * - Go 的 `(string, error)` 返回译为成功返回字符串、失败 `throw`。
 * - Go 的 `net/url` 解析译为全局 WHATWG `URL`。
 */

"use strict";

/**
 * 根据运行 ID 生成稳定的前端预览唯一 ID（每次运行对应一个预览）。
 *
 * @param {string} runID - 运行记录 ID。
 * @returns {string} 预览 ID；若 `runID` 去除空白后为空则返回 `"preview"`，否则返回 `"preview-" + runID`。
 */
function PreviewID(runID) {
  runID = runID.trim();
  if (runID === "") {
    return "preview";
  }
  return "preview-" + runID;
}

// 预览会话后端地址不是无凭据 http(s) URL 时抛出的哨兵错误。
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

/**
 * 冻结进 WorkflowSnapshot 的运行级前端预览交付合约。
 * 启用后引擎会注入静态站点构建节点，并在该节点成功时归档静态资源，使审核方在运行结束前即可预览页面。
 */
class PreviewContract {
  /**
   * 构造前端预览合约实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {boolean} [init.Enabled=false] - 是否启用前端预览。
   * @param {string} [init.Kind=""] - 预览类型（目前支持 static）。
   * @param {string} [init.ExecutorID=""] - 构建节点使用的执行器 ID（为空时跟随运行负责人配置）。
   * @param {string} [init.Model=""] - 构建节点选用的模型 ID。
   * @param {string} [init.SourcePath=""] - 静态产物相对运行工作区的目录路径（默认 dist）。
   * @param {string} [init.IndexFile=""] - 静态站点入口文件名（默认 index.html）。
   * @param {boolean} [init.SPAFallback=false] - 是否开启单页应用路由回退到入口文件。
   * @param {boolean} [init.Required=false] - 预览构建失败是否必须阻断运行。
   * @param {boolean} [init.CaptureShot=false] - 是否捕获预览页面截图。
   * @param {number} [init.RetentionSec=0] - 预览资源保留时长（秒）。
   */
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

  /**
   * 判断该预览合约是否启用且要求执行静态站点构建与归档。
   *
   * @returns {boolean} 启用且类型为默认或 `"static"` 时返回 `true`，否则返回 `false`。
   */
  Static() {
    if (this == null || !this.Enabled) {
      return false;
    }
    const kind = this.Kind.trim();
    return kind === "" || kind.toLowerCase() === PreviewKindStatic;
  }

  /**
   * 返回规范化后的静态站点入口文件名，未配置时回退为 `"index.html"`。
   *
   * @returns {string} 入口文件名。
   */
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

  /**
   * 返回预览类型，未配置时回退为 `"static"`。
   *
   * @returns {string} 预览类型字符串。
   */
  KindOrStatic() {
    if (this == null || this.Kind.trim() === "") {
      return PreviewKindStatic;
    }
    return this.Kind.trim();
  }

  /**
   * 返回统一转为正斜杠且去除首尾斜杠的产物源目录路径，未配置时回退为 `"dist"`。
   *
   * @returns {string} 相对工作区的静态产物目录路径。
   */
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

  /**
   * 返回构建节点最终选定的执行器 ID。
   * 若未显式指定执行器但指定了非默认模型，则兼容旧版合约回退到默认构建执行器 `"codebuddy"`。
   *
   * @returns {string} 执行器 ID；未固定执行器时返回空字符串 `""`。
   */
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

  /**
   * 返回构建节点使用的模型标识，未配置时回退为 `"default"`。
   *
   * @returns {string} 模型标识。
   */
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

  /**
   * 计算有效的预览保留时长（毫秒）。
   * 超出上限或非正值时统一使用最大保留期 `PreviewMaxRetentionSec`。
   *
   * @returns {number} 保留时长（毫秒数，对应 Go 的 `time.Duration`）。
   */
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

  /**
   * 返回静态站点入口文件相对工作区根目录的路径（如 `"dist/index.html"`）。
   *
   * @returns {string} 入口文件相对路径。
   */
  EntryRel() {
    return (this.SourceOrDist() + "/" + this.Index()).replace(/^\/+|\/+$/g, "");
  }

  /**
   * 就地规范化预览合约的类型、执行器、模型、产物目录、入口文件与保留时长。
   * 未启用合约时不执行修改。
   *
   * @returns {void} 无返回值。
   */
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

  /**
   * 规范化并校验预览合约是否合法（目前仅支持静态站点且产物目录不得含路径穿越或绝对路径前缀）。
   *
   * @returns {void} 无返回值；合约不合法时抛出 Error。
   */
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

/**
 * 判断给定节点 ID 是否为系统合成的前端预览构建节点 ID。
 *
 * @param {string} id - 节点 ID。
 * @returns {boolean} 匹配 `PreviewBuildNodeID` 时返回 `true`，否则返回 `false`。
 */
function IsPreviewBuildNode(id) {
  return id.trim() === PreviewBuildNodeID;
}

/**
 * 判断给定 ID 是否属于系统内置的前端预览构建 Agent 或构建节点。
 *
 * @param {string} id - Agent ID 或节点 ID。
 * @returns {boolean} 匹配 `PreviewBuildAgentID` 或 `PreviewBuildNodeID` 时返回 `true`，否则返回 `false`。
 */
function IsPreviewBuildAgent(id) {
  id = id.trim();
  return id === PreviewBuildAgentID || id === PreviewBuildNodeID;
}

/**
 * 校验并规范化打开前端预览时指定的后端代理 URL。
 * 允许空字符串，否则必须是无用户名/密码凭据的 `http://` 或 `https://` 地址，且会清除 URL Fragment。
 *
 * @param {string} raw - 用户输入的原始后端地址。
 * @returns {string} 规范化后的 URL 字符串或空字符串；格式不合法时抛出 `ErrInvalidPreviewBackendURL`。
 */
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

/**
 * 已交付前端预览的持久化元数据记录。
 * 静态资源二进制压缩包存放在独立的 PreviewStore 中，不写入 `run_artifacts.content`。
 */
class RunPreview {
  /**
   * 构造运行预览记录实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - 预览记录主键 ID。
   * @param {string} [init.RunID=""] - 关联运行 ID。
   * @param {string} [init.ProjectID=""] - 所属项目 ID。
   * @param {string} [init.Kind=""] - 预览类型（如 static）。
   * @param {string} [init.Status=""] - 预览当前状态（如 pending、archiving、ready、failed）。
   * @param {string} [init.SourcePath=""] - 静态产物相对路径。
   * @param {string} [init.StorageKey=""] - 对象存储或文件库中的归档存储键。
   * @param {string} [init.ContentSHA256=""] - 归档内容的 SHA-256 摘要。
   * @param {number} [init.CompressedSize=0] - 压缩包字节大小。
   * @param {number} [init.ExpandedSize=0] - 解压后的总字节大小。
   * @param {number} [init.FileCount=0] - 归档包含的文件总数。
   * @param {string} [init.EntryFile=""] - 站点入口文件名。
   * @param {boolean} [init.SPAFallback=false] - 是否启用单页应用路由回退。
   * @param {string} [init.BackendURL=""] - 关联的后端代理地址。
   * @param {string} [init.OwnerRunnerID=""] - 负责归档上传的执行机 ID。
   * @param {string} [init.ScreenshotKey=""] - 预览页面截图存储键。
   * @param {string} [init.ErrorText=""] - 归档或构建失败原因。
   * @param {string} [init.UploadTokenHash=""] - 上传令牌哈希值。
   * @param {number} [init.UploadMaxBytes=0] - 允许上传的最大字节数。
   * @param {Date|null} [init.UploadExpiresAt=null] - 上传令牌过期时间。
   * @param {Date|null} [init.ArchiveLeaseUntil=null] - 归档租约到期时间。
   * @param {Date|null} [init.LastAccessedAt=null] - 最近一次访问预览的时间。
   * @param {Date|null} [init.ExpiresAt=null] - 预览过期时间。
   * @param {Date|null} [init.CreatedAt=null] - 创建时间。
   * @param {Date|null} [init.UpdatedAt=null] - 最近更新时间。
   */
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

  /**
   * 判断预览记录是否正处于需要保留运行工作区的活跃占位状态（待归档或归档中）。
   *
   * @returns {boolean} 状态为 `pending` 或 `archiving` 时返回 `true`，否则返回 `false`。
   */
  ActiveHold() {
    switch (this.Status) {
      case PreviewPending:
      case PreviewArchiving:
        return true;
      default:
        return false;
    }
  }

  /**
   * 判断预览是否已就绪且具备有效的归档存储键，可以直接对外提供静态资源访问。
   *
   * @returns {boolean} 可对外提供访问时返回 `true`，否则返回 `false`。
   */
  Serveable() {
    return this.Status === PreviewReady && this.StorageKey.trim() !== "";
  }
}

/**
 * `/preview/{token}/` 的短期访问授权会话。
 * 数据库仅保存令牌哈希；`BackendURL` 在创建会话时选定，使工作台可按需指向后端而无需固化进 SOP。
 */
class PreviewSession {
  /**
   * 构造预览会话实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - 会话唯一 ID。
   * @param {string} [init.PreviewID=""] - 关联预览记录 ID。
   * @param {string} [init.TokenHash=""] - 访问令牌的哈希值。
   * @param {string} [init.BackendURL=""] - 该会话绑定的后端代理 URL。
   * @param {Date|null} [init.ExpiresAt=null] - 会话过期时间。
   * @param {Date|null} [init.CreatedAt=null] - 会话创建时间。
   * @param {Date|null} [init.LastAccessedAt=null] - 最近访问时间。
   * @param {Date|null} [init.RevokedAt=null] - 吊销时间（未吊销时为 `null`）。
   */
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

  /**
   * 判断该预览会话在指定时刻是否仍然有效（未被吊销且未过期）。
   *
   * @param {Date} now - 用于比对的当前时间点。
   * @returns {boolean} 会话仍有效时返回 `true`，已吊销或已过期时返回 `false`。
   */
  Live(now) {
    if (this.RevokedAt != null) {
      return false;
    }
    return this.ExpiresAt == null || !(this.ExpiresAt.getTime() < now.getTime());
  }
}

/**
 * 下发给执行机的内置前端预览归档动作规格。
 * 打包后的静态资源直接流式上传到专用上传端点，不通过任务 JSON 传输二进制内容。
 */
class RunnerPreviewArchiveSpec {
  /**
   * 构造执行机预览归档规格实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.PreviewID=""] - 预览记录 ID。
   * @param {string} [init.RunID=""] - 关联运行 ID。
   * @param {string} [init.SourcePath=""] - 待打包静态资源目录相对路径。
   * @param {string} [init.IndexFile=""] - 静态站点入口文件名。
   * @param {boolean} [init.SPAFallback=false] - 是否启用单页应用路由回退。
   * @param {number} [init.MaxFiles=0] - 允许打包的最大文件数量。
   * @param {number} [init.MaxBytes=0] - 允许打包的最大总字节数。
   * @param {string} [init.UploadURL=""] - 专用上传端点 URL。
   * @param {string} [init.UploadToken=""] - 上传鉴权令牌。
   */
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
