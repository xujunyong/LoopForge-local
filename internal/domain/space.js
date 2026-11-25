// space.js —— 对应 Go 文件：internal/domain/space.go
// 作用：需求空间（会话）及其成员、版本化产物与侧边讨论串。

"use strict";

// RequirementSpace：叠加在会话之上的需求状态。
class RequirementSpace {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.Summary = init.Summary ?? "";
    this.Pinned = init.Pinned ?? false;
    this.LaneInputs = init.LaneInputs ?? null;
    this.CreatedBy = init.CreatedBy ?? 0;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

// ArtifactRef：锁定一个产物版本。
class ArtifactRef {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Version = init.Version ?? 0;
  }
}

// SpaceMember：空间内的一名成员及其可见职务。
class SpaceMember {
  constructor(init = {}) {
    this.SpaceID = init.SpaceID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Name = init.Name ?? "";
    this.Title = init.Title ?? "";
    this.AddedBy = init.AddedBy ?? 0;
    this.AddedAt = init.AddedAt ?? null;
  }
}

// spaceArtifactKinds：支持的空间产物类型。
const spaceArtifactKinds = {
  doc: true, prototype: true, api: true, diff: true, report: true, ppt: true, sop: true, browser: true, file: true,
};

// ValidSpaceArtifactKind：该类型是否受支持。
function ValidSpaceArtifactKind(kind) { return spaceArtifactKinds[kind] === true; }

// SpaceArtifactBodyLimit：单个产物版本的存储上限。
const SpaceArtifactBodyLimit = 1 << 20;

// SpaceArtifact：空间内的版本化交付物。
class SpaceArtifact {
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

  // Validate：入库前校验产物。
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
    // Go 的 len(Body) 按字节计。
    if (Buffer.byteLength(this.Body, "utf8") > SpaceArtifactBodyLimit) {
      throw new Error("产物内容不能超过 1 MiB");
    }
    const u = this.URL.trim();
    if (u !== "" && !u.startsWith("https://") && !u.startsWith("http://") && !u.startsWith("/")) {
      throw new Error("产物链接必须是 http(s) 地址或站内路径");
    }
  }
}

// SpaceThread：主时间线之外的侧边讨论或单个 SOP 的过程串。
class SpaceThread {
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

// 需求空间用到的额外 ChatMessage 类型。
const ChatKindAI = "ai";
const ChatKindMilestone = "milestone";
const ChatKindArtifact = "artifact";
const ChatKindFlow = "flow";

// ChatKindAI 消息上的 AI 回复状态。
const AIStatusRunning = "running";
const AIStatusCompleted = "completed";
const AIStatusFailed = "failed";

module.exports = { RequirementSpace, ArtifactRef, SpaceMember, ValidSpaceArtifactKind, SpaceArtifactBodyLimit, SpaceArtifact, SpaceThread, ChatKindAI, ChatKindMilestone, ChatKindArtifact, ChatKindFlow, AIStatusRunning, AIStatusCompleted, AIStatusFailed };
