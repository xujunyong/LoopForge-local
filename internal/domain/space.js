/**
 * @file internal/domain/space.js
 * @description 对应 Go 文件：internal/domain/space.go
 * 职责与边界：定义需求空间（叠加在会话之上的协作状态）、产物版本引用、空间成员、
 * 版本化交付产物（含入库前校验）、侧边讨论串以及空间专属聊天消息类型和 AI 回复状态常量。
 * 语法差异说明：
 * - Go 映射 `map[string][]ArtifactRef` 零值初始化为 `{}`，`time.Time` 初始化为 `null`。
 * - Go 的 `len([]rune(s))` 译为 `[...s].length`（按 Unicode 码点计数），`len(s)` 字节数译为 `Buffer.byteLength(s, "utf8")`。
 * - Go 的 `error` 返回译为校验通过无返回值、失败 `throw Error`。
 */

"use strict";

/**
 * 表示叠加在会话（ChatRoom，同 ID）之上的需求空间工作状态，记录关联需求、摘要、置顶及各角色链运行的输入产物版本。
 */
class RequirementSpace {
  /**
   * 构造需求空间实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.Summary = init.Summary ?? "";
    this.Pinned = init.Pinned ?? false;
    this.LaneInputs = init.LaneInputs ?? {};
    this.CreatedBy = init.CreatedBy ?? 0;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

/**
 * 锁定单个空间产物的特定版本号，确保后续编辑产物不会改写历史运行的输入记录。
 */
class ArtifactRef {
  /**
   * 构造产物版本引用实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Version = init.Version ?? 0;
  }
}

/**
 * 表示在需求空间中协作的成员及其对外展示职务。
 */
class SpaceMember {
  /**
   * 构造空间成员实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.SpaceID = init.SpaceID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Name = init.Name ?? "";
    this.Title = init.Title ?? "";
    this.AddedBy = init.AddedBy ?? 0;
    this.AddedAt = init.AddedAt ?? null;
  }
}

// 空间支持存储的交付产物类型集合。
const spaceArtifactKinds = {
  doc: true, prototype: true, api: true, diff: true, report: true, ppt: true, sop: true, browser: true, file: true,
};

/**
 * 判断给定的空间产物类型标识是否在平台允许的集合内。
 * 在创建或更新空间产物校验时调用。
 * @param {string} kind - 产物类型字符串。
 * @returns {boolean} 类型受支持时返回 `true`，否则返回 `false`。
 */
function ValidSpaceArtifactKind(kind) { return spaceArtifactKinds[kind] === true; }

// 单个空间产物版本正文内容的字节上限（1 MiB）。
const SpaceArtifactBodyLimit = 1 << 20;

/**
 * 表示需求空间内的版本化交付产物（如文档、原型、接口、报告、SOP 草稿等）。
 */
class SpaceArtifact {
  /**
   * 构造空间产物实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.SpaceID = init.SpaceID ?? "";
    this.Kind = init.Kind ?? "";
    this.Title = init.Title ?? "";
    this.Version = init.Version ?? 0;
    this.Summary = init.Summary ?? "";
    this.Format = init.Format ?? "";
    this.Body = init.Body ?? "";
    this.URL = init.URL ?? "";
    this.RunID = init.RunID ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.AuthorID = init.AuthorID ?? 0;
    this.AuthorName = init.AuthorName ?? "";
    this.ByAI = init.ByAI ?? false;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  /**
   * 在空间产物持久化入库前校验其类型、标题非空与字数上限、正文大小上限及外部链接协议合法性。
   * 在创建或保存空间产物新版本前调用。
   * @returns {void} 无返回值；校验失败时抛出异常。
   */
  Validate() {
    if (!ValidSpaceArtifactKind(this.Kind)) {
      throw new Error(`不支持的产物类型 ${JSON.stringify(this.Kind)}`);
    }
    if (this.Title.trim() === "") {
      throw new Error("产物标题不能为空");
    }
    // Go 用 []rune 计数，JS 用码点计数。
    if ([...this.Title].length > 120) {
      throw new Error("产物标题不能超过 120 个字");
    }
    // Go 的 len(Body) 按 UTF-8 字节计数。
    if (Buffer.byteLength(this.Body, "utf8") > SpaceArtifactBodyLimit) {
      throw new Error("产物内容不能超过 1 MiB");
    }
    const u = this.URL.trim();
    if (u !== "" && !u.startsWith("https://") && !u.startsWith("http://") && !u.startsWith("/")) {
      throw new Error("产物链接必须是 http(s) 地址或站内路径");
    }
  }
}

/**
 * 表示脱离主聊天时间线的侧边讨论串，或承载单个 SOP 执行过程的独立讨论串。
 */
class SpaceThread {
  /**
   * 构造侧边讨论串实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.SpaceID = init.SpaceID ?? "";
    this.Title = init.Title ?? "";
    this.RunID = init.RunID ?? "";
    this.MessageID = init.MessageID ?? "";
    this.CreatedBy = init.CreatedBy ?? 0;
    this.CreatedAt = init.CreatedAt ?? null;
  }
}

// 需求空间使用的扩展 ChatMessage 消息类型。
const ChatKindAI = "ai";
const ChatKindMilestone = "milestone";
const ChatKindArtifact = "artifact";
const ChatKindFlow = "flow";

// ChatKindAI 消息的生成状态常量。
const AIStatusRunning = "running";
const AIStatusCompleted = "completed";
const AIStatusFailed = "failed";

module.exports = { RequirementSpace, ArtifactRef, SpaceMember, ValidSpaceArtifactKind, SpaceArtifactBodyLimit, SpaceArtifact, SpaceThread, ChatKindAI, ChatKindMilestone, ChatKindArtifact, ChatKindFlow, AIStatusRunning, AIStatusCompleted, AIStatusFailed };
