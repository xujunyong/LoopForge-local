// issue.js —— 对应 Go 文件：internal/domain/issue.go
// 作用：工作项（需求）结构、完成与关闭判断、身份块与操作审计。

"use strict";

class Issue {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Number = init.Number ?? 0;
    this.Title = init.Title ?? "";
    this.Description = init.Description ?? "";
    this.Status = init.Status ?? "";
    this.CloseSource = init.CloseSource ?? "";
    this.Priority = init.Priority ?? "";
    this.AssigneeType = init.AssigneeType ?? "";
    this.AssigneeID = init.AssigneeID ?? "";
    this.AssigneeUserID = init.AssigneeUserID ?? 0;
    this.WorkflowID = init.WorkflowID ?? "";
    this.PlaybookID = init.PlaybookID ?? "";
    this.SOPBindings = init.SOPBindings ?? null;
    this.SOPMode = init.SOPMode ?? "";
    this.RepositoryID = init.RepositoryID ?? "";
    this.RepositoryIDs = init.RepositoryIDs ?? [];
    this.BaseBranch = init.BaseBranch ?? "";
    this.RepositoryBranches = init.RepositoryBranches ?? null;
    this.LatestTaskID = init.LatestTaskID ?? "";
    this.AutomationState = init.AutomationState ?? "";
    this.DeliveryState = init.DeliveryState ?? "";
    this.DeliveryMRURL = init.DeliveryMRURL ?? "";
    this.DeliveryMRState = init.DeliveryMRState ?? "";
    this.DeliveryMRs = init.DeliveryMRs ?? [];
    this.DeliveryUpdatedAt = init.DeliveryUpdatedAt ?? null;
    this.Kind = init.Kind ?? "";
    this.Clarification = init.Clarification ?? new ClarificationAssessment();
    this.Source = init.Source ?? "";
    this.TapdID = init.TapdID ?? "";
    this.ExternalRef = init.ExternalRef ?? null;
    this.ConversationSessionID = init.ConversationSessionID ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
    this.CompletedAt = init.CompletedAt ?? null;
    this.Operations = init.Operations ?? [];
  }

  Completed() {
    switch (this.Status.toLowerCase().trim()) {
      case "done":
      case "closed":
      case "completed":
        return true;
      default:
        return false;
    }
  }

  // RequirementTAPDID：分析用的权威 TAPD 键。
  RequirementTAPDID() {
    if (this.ExternalRef != null && (this.Source.toLowerCase() === "tapd" || this.ExternalRef.Source.toLowerCase() === "tapd")) {
      const id = this.ExternalRef.ExternalID.trim();
      if (id !== "") {
        return id;
      }
    }
    if (this.ExternalRef != null || this.Source.toLowerCase() === "gongfeng") {
      return "";
    }
    return this.TapdID.trim();
  }

  // AppendOperation：记一条操作，最多保留最新 200 条。
  AppendOperation(op) {
    op.Action = op.Action.trim();
    if (op.Action === "") {
      return;
    }
    if (op.At == null) {
      op.At = new Date();
    }
    this.Operations.push(op);
    const maxOps = 200;
    if (this.Operations.length > maxOps) {
      this.Operations = this.Operations.slice(this.Operations.length - maxOps);
    }
  }

  // EffectiveRepositoryIDs：去重后的非空绑定仓库列表，RepositoryID 作兜底追加。
  EffectiveRepositoryIDs() {
    const seen = new Set();
    const out = [];
    for (const raw of [...(this.RepositoryIDs ?? []), this.RepositoryID]) {
      const id = raw.trim();
      if (id === "" || seen.has(id)) {
        continue;
      }
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  // WorkBranchForRepository：按仓库解析选定的工作分支，单仓库时回退到旧分支字段。
  WorkBranchForRepository(repositoryID) {
    if (this.RepositoryBranches != null) {
      return (this.RepositoryBranches[repositoryID] ?? "").trim();
    }
    const ids = this.EffectiveRepositoryIDs();
    if (ids.length === 0 || (ids.length === 1 && ids[0] === repositoryID)) {
      return this.BaseBranch.trim();
    }
    return "";
  }

  // GongfengClosed：工蜂上已关闭的工作项，派发须以 ExternalState 而非本地 Status 判断。
  GongfengClosed() {
    if (this.Source.trim().toLowerCase() !== "gongfeng") {
      return false;
    }
    if (this.ExternalRef == null) {
      return false;
    }
    return this.ExternalRef.ExternalState.trim().toLowerCase() === "closed";
  }

  // ManuallyClosed：显式本地关闭，与跟踪器关闭区分。
  ManuallyClosed() {
    return this.Status.trim().toLowerCase() === "closed" &&
      this.CloseSource.trim().toLowerCase() !== "external";
  }

  // TrackerClosed：读跟踪器原始状态，滞后的本地状态不能让已关闭工作项可执行。
  TrackerClosed() {
    if (this.ExternalRef == null || (this.Source !== "gongfeng" && this.Source !== "tapd" && this.Source !== "github")) {
      return false;
    }
    const state = this.ExternalRef.ExternalState.toLowerCase().trim();
    return state === "closed" || state === "已关闭";
  }

  // DeliveryLocked：已合入 MR 或已交付闭环的工作项是否已定稿。
  DeliveryLocked() {
    return this.DeliveryState.trim().toLowerCase() === "merged";
  }

  // DeliveryLockedLabel：交付锁定工作项的面向用户阶段标签。
  DeliveryLockedLabel() {
    if (this.ManuallyClosed()) {
      return "关闭";
    }
    const state = this.DeliveryMRState.toLowerCase().trim();
    if (this.DeliveryMRURL.trim() === "") {
      if (state === "closed") {
        return "已关闭";
      }
      return "交付闭环";
    }
    switch (state) {
      case "merged":
        return "MR 已合入";
      case "integrated":
        return "已合入基线";
      case "closed":
        return "MR 已关闭";
      default:
        return "交付闭环";
    }
  }

  // IdentityBlock：注入 SOP 输入与任务提示的权威跟踪器身份，禁止从分支名猜测 ID。
  IdentityBlock() {
    const id = this.ID.trim();
    if (id === "") {
      return "";
    }
    let source = this.Source.toLowerCase().trim();
    if (source === "") {
      source = "local";
    }
    let b = "";
    b += issueIdentityMarker;
    b += "：\n";
    b += "- 平台工作项：";
    b += id;
    b += "\n- 来源：";
    switch (source) {
      case "tapd":
        b += "TAPD";
        break;
      case "gongfeng":
        b += "工蜂";
        break;
      default:
        b += "本地";
        break;
    }
    b += "\n";
    const ref = this.ExternalRef;
    if (ref == null) {
      const tapdID = this.RequirementTAPDID();
      if (tapdID !== "") {
        b += "- 统计关联 TAPD ID：";
        b += tapdID;
        b += "（仅用于指标归集，不代表 TAPD 同步关系）\n";
      } else {
        b += "- 外部 ID：无\n";
      }
      return b;
    }
    if (ref.ExternalType.trim() !== "") {
      b += "- 类型：";
      b += ref.ExternalType.trim();
      b += "\n";
    }
    if (ref.ExternalID.trim() !== "") {
      b += "- 外部 ID：";
      b += ref.ExternalID.trim();
      b += "\n";
    }
    if (ref.ExternalIID !== 0) {
      b += "- 外部编号：";
      b += String(ref.ExternalIID);
      b += "\n";
    }
    if (ref.ExternalURL.trim() !== "") {
      b += "- 链接：";
      b += ref.ExternalURL.trim();
      b += "\n";
    }
    return b;
  }

  HasIdentityBlock(text) {
    return text.includes(issueIdentityMarker);
  }

  // WithoutSOP：需求是否选择了无 SOP 交付。
  WithoutSOP() {
    return this.SOPMode.trim().toLowerCase() === IssueSOPNone;
  }

  ExecutionBlockedReason() {
    if (this.ManuallyClosed()) {
      return "工作项已关闭，请先重新打开后再触发 SOP";
    }
    if (this.TrackerClosed() || (this.Status === "closed" && this.CloseSource === "external")) {
      return "外部工作项已关闭，请先在外部系统重新打开";
    }
    if (this.DeliveryLocked()) {
      switch (this.DeliveryLockedLabel()) {
        case "已关闭":
          return "工作项已关闭，请先重新打开后再触发 SOP";
        case "MR 已合入":
          return "关联 MR 已合入，请先重新打开工作项再触发 SOP";
        case "已合入基线":
          return "已合入基线，请先重新打开工作项再触发 SOP";
        case "MR 已关闭":
          return "关联 MR 已关闭，请先重新打开工作项再触发 SOP";
        default:
          return "工作项已交付闭环，请先重新打开后再触发 SOP";
      }
    }
    return "";
  }
}

class ClarificationAssessment {
  constructor(init = {}) {
    this.Summary = init.Summary ?? "";
    this.Status = init.Status ?? "";
    this.History = init.History ?? [];
    this.Questions = init.Questions ?? [];
    this.SessionID = init.SessionID ?? "";
    this.SessionUserID = init.SessionUserID ?? 0;
    this.WriteBackStatus = init.WriteBackStatus ?? "";
    this.WriteBackError = init.WriteBackError ?? "";
    this.WriteBackFingerprint = init.WriteBackFingerprint ?? "";
    this.WriteBackAt = init.WriteBackAt ?? null;
    this.StartedAt = init.StartedAt ?? null;
    this.Gated = init.Gated ?? false;
  }
}

class ClarificationMessage {
  constructor(init = {}) {
    this.Role = init.Role ?? "";
    this.Content = init.Content ?? "";
  }
}

class ClarificationQuestion {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Question = init.Question ?? "";
    this.Options = init.Options ?? [];
    this.MultiSelect = init.MultiSelect ?? false;
    this.FreeText = init.FreeText ?? false;
  }
}

// ExternalRef：本地工作项到工蜂或 TAPD 外部工作项的链接。
class ExternalRef {
  constructor(init = {}) {
    this.SourceContentHash = init.SourceContentHash ?? "";
    this.Source = init.Source ?? "";
    this.ExternalID = init.ExternalID ?? "";
    this.ExternalIID = init.ExternalIID ?? 0;
    this.ExternalURL = init.ExternalURL ?? "";
    this.ExternalState = init.ExternalState ?? "";
    this.ExternalType = init.ExternalType ?? "";
    this.SyncedAt = init.SyncedAt ?? null;
    this.Imported = init.Imported ?? false;
  }
}

// IssueOperation：需求上一次用户可见操作。
class IssueOperation {
  constructor(init = {}) {
    this.At = init.At ?? null;
    this.Actor = init.Actor ?? "";
    this.ActorUserID = init.ActorUserID ?? 0;
    this.Action = init.Action ?? "";
    this.Detail = init.Detail ?? "";
  }
}

class IssueComment {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.AuthorType = init.AuthorType ?? "";
    this.AuthorID = init.AuthorID ?? "";
    this.Body = init.Body ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
  }
}

class RejectRequest {
  constructor(init = {}) {
    this.Expected = init.Expected ?? null;
    this.NodeID = init.NodeID ?? "";
    this.TargetID = init.TargetID ?? "";
    this.Reason = init.Reason ?? "";
    this.Context = init.Context ?? "";
  }
}

// HumanDecision：通过 / 重试的共用载荷，可附操作员补充的事实。
class HumanDecision {
  constructor(init = {}) {
    this.Expected = init.Expected ?? null;
    this.NodeID = init.NodeID ?? "";
    this.Reason = init.Reason ?? "";
    this.Context = init.Context ?? "";
  }
}

// NodeDecisionExpectation：把工作台操作绑定到正在查看的尝试。
class NodeDecisionExpectation {
  constructor(init = {}) {
    this.Status = init.Status ?? "";
    this.Attempt = init.Attempt ?? 0;
    this.ReworkCount = init.ReworkCount ?? 0;
  }
}

const issueIdentityMarker = "需求身份（平台权威，禁止忽略）";

const IssueSOPNone = "none";
const IssueSOPUse = "sop";

module.exports = { Issue, ClarificationAssessment, ClarificationMessage, ClarificationQuestion, ExternalRef, IssueOperation, IssueComment, RejectRequest, HumanDecision, NodeDecisionExpectation, IssueSOPNone, IssueSOPUse };
