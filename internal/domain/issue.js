/**
 * 对应 Go 文件：internal/domain/issue.go
 * 作用：定义工作项（需求/缺陷）及其澄清评估、外部跟踪器引用、操作审计、评论与人工决策等核心数据结构，
 *       并提供工作项状态判断、仓库与分支解析、权威身份块生成与执行阻塞原因判定方法。
 * 职责边界：仅负责工作项领域实体与纯业务规则判断，不涉及数据库读写或外部系统同步。
 * 语法差异说明：
 * - Go 的 time.Time 与指针零值均为 null，切片零值为 []，映射零值为 {}；
 * - Go 中 nil 映射与空映射可区分，JS 中 RepositoryBranches 默认零值为 {}，调用方显式传 null 时才走单仓回退逻辑；
 * - EffectiveRepositoryIDs 中 Go 的 map[string]bool 译为普通对象 {}。
 */

"use strict";

/**
 * 工作项（需求或问题）领域实体，承载状态流转、SOP 绑定、关联仓库/分支、交付 MR、澄清记录与操作审计。
 */
class Issue {
  /**
   * 构造工作项对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<Issue>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
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
    this.SOPBindings = init.SOPBindings ?? [];
    this.SOPMode = init.SOPMode ?? "";
    this.RepositoryID = init.RepositoryID ?? "";
    this.RepositoryIDs = init.RepositoryIDs ?? [];
    this.BaseBranch = init.BaseBranch ?? "";
    this.RepositoryBranches = init.RepositoryBranches ?? {};
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

  /**
   * 判断工作项当前本地状态是否属于已完成态（done、closed 或 completed）。
   *
   * @returns {boolean} 处于已完成状态返回 true，否则返回 false。
   */
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

  /**
   * 获取用于指标分析的权威 TAPD 需求 ID。
   * 同步自 TAPD 的工作项返回其外部追踪 ID；其他外部同步项（如工蜂）返回空串；
   * 平台自建工作项返回手动填写的统计关联 TapdID。
   *
   * @returns {string} 权威 TAPD 标识；无关联时返回空字符串。
   */
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

  /**
   * 向工作项操作审计列表追加一条用户可见操作，并只保留最新的 200 条记录。
   * 若操作动作名称为空则忽略；若未指定操作时间则自动填入当前时间。
   *
   * @param {IssueOperation} op - 待追加的操作审计条目。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回工作项绑定的去重非空仓库 ID 列表。
   * 以多仓库字段 RepositoryIDs 为权威顺序，并将旧版单仓库字段 RepositoryID 作为兜底追加在后。
   *
   * @returns {string[]} 去重且去除空白后的有效仓库 ID 数组。
   */
  EffectiveRepositoryIDs() {
    const seen = {};
    const out = [];
    for (const raw of [...(this.RepositoryIDs ?? []), this.RepositoryID]) {
      const id = raw.trim();
      if (id === "" || Object.prototype.hasOwnProperty.call(seen, id)) {
        continue;
      }
      seen[id] = true;
      out.push(id);
    }
    return out;
  }

  /**
   * 解析指定仓库应继续使用的既有工作分支名。
   * 若配置了按仓库分支映射（RepositoryBranches 非 null），则直接取映射值；
   * 否则仅在单仓库或未显式指定仓库（沿用项目默认仓库）时回退到旧版 BaseBranch 字段。
   *
   * @param {string} repositoryID - 目标仓库 ID。
   * @returns {string} 选定的既有工作分支名；返回空字符串表示从主分支新建分支。
   */
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

  /**
   * 判断工作项是否为已在工蜂侧关闭的工蜂工作项。
   * 因同步失败可能导致本地 Status 滞后，派发前必须以 ExternalRef.ExternalState 为准。
   *
   * @returns {boolean} 来源为工蜂且外部状态为 closed 时返回 true，否则返回 false。
   */
  GongfengClosed() {
    if (this.Source.trim().toLowerCase() !== "gongfeng") {
      return false;
    }
    if (this.ExternalRef == null) {
      return false;
    }
    return this.ExternalRef.ExternalState.trim().toLowerCase() === "closed";
  }

  /**
   * 判断工作项是否由人工在本地显式关闭，以区分于外部跟踪器同步导致的关闭。
   * 在 CloseSource 引入前，只有手动关闭会将本地 Status 置为 closed。
   *
   * @returns {boolean} 本地状态为 closed 且关闭来源不是 external 时返回 true，否则返回 false。
   */
  ManuallyClosed() {
    return this.Status.trim().toLowerCase() === "closed" &&
      this.CloseSource.trim().toLowerCase() !== "external";
  }

  /**
   * 读取外部跟踪器（工蜂、TAPD、GitHub）的原始关闭状态，防止滞后的本地状态误放行已关闭工作项。
   *
   * @returns {boolean} 外部状态为 closed 或“已关闭”时返回 true，否则返回 false。
   */
  TrackerClosed() {
    if (this.ExternalRef == null || (this.Source !== "gongfeng" && this.Source !== "tapd" && this.Source !== "github")) {
      return false;
    }
    const state = this.ExternalRef.ExternalState.toLowerCase().trim();
    return state === "closed" || state === "已关闭";
  }

  /**
   * 判断工作项是否因 MR 合入或交付完成而处于交付锁定状态。
   * 用户可显式重新打开工作项以允许后续继续触发运行。
   *
   * @returns {boolean} DeliveryState 忽略大小写等于 "merged" 时返回 true，否则返回 false。
   */
  DeliveryLocked() {
    return this.DeliveryState.trim().toLowerCase() === "merged";
  }

  /**
   * 返回交付锁定工作项面向用户展示的阶段标签。
   * 仅当存在真实 MR 链接时才使用 MR 相关措辞，避免把无链接的历史手动关闭误标为 MR 关闭。
   *
   * @returns {string} 阶段展示文案（如 "关闭"、"已关闭"、"MR 已合入"、"已合入基线"、"MR 已关闭"、"交付闭环"）。
   */
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

  /**
   * 生成注入 SOP 输入与任务提示词的权威需求身份文本块。
   * 当存在该身份块时，Agent 必须以其内容为准，不得根据分支名猜测 TAPD/工蜂 ID。
   *
   * @returns {string} 格式化的多行需求身份说明文本；若工作项 ID 为空则返回空字符串。
   */
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

  /**
   * 检查给定文本中是否已包含平台权威需求身份块标记，防止重复注入。
   *
   * @param {string} text - 待检测的输入或提示词文本。
   * @returns {boolean} 包含身份块标题标记返回 true，否则返回 false。
   */
  HasIdentityBlock(text) {
    return text.includes(issueIdentityMarker);
  }

  /**
   * 判断该工作项是否显式选择了“无 SOP 交付”模式（SOPMode 为 none）。
   *
   * @returns {boolean} 处于无 SOP 模式返回 true，否则返回 false。
   */
  WithoutSOP() {
    return this.SOPMode.trim().toLowerCase() === IssueSOPNone;
  }

  /**
   * 判断当前工作项是否被禁止触发 SOP 执行，并返回面向用户的阻塞原因文案。
   * 按本地手动关闭、外部跟踪器关闭、交付锁定顺序检查。
   *
   * @returns {string} 阻塞提示文案；若允许触发 SOP 则返回空字符串。
   */
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

/**
 * 工作项的需求澄清评估状态，包含摘要、对话历史、待确认问题、关联会话与外部回写状态。
 */
class ClarificationAssessment {
  /**
   * 构造澄清评估对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<ClarificationAssessment>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
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

/**
 * 澄清对话历史中的单条消息。
 */
class ClarificationMessage {
  /**
   * 构造澄清消息对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<ClarificationMessage>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Role = init.Role ?? "";
    this.Content = init.Content ?? "";
  }
}

/**
 * 澄清阶段向用户提出的单个结构化问题（支持单选、多选或自由文本）。
 */
class ClarificationQuestion {
  /**
   * 构造澄清问题对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<ClarificationQuestion>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Question = init.Question ?? "";
    this.Options = init.Options ?? [];
    this.MultiSelect = init.MultiSelect ?? false;
    this.FreeText = init.FreeText ?? false;
  }
}

/**
 * 本地工作项与外部系统（工蜂或 TAPD）工作项/需求之间的关联引用信息。
 */
class ExternalRef {
  /**
   * 构造外部跟踪器引用对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<ExternalRef>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
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

/**
 * 记录工作项上发生的一次用户可见操作（如创建、编辑、关闭、重开、派发）。
 */
class IssueOperation {
  /**
   * 构造操作审计记录对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<IssueOperation>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.At = init.At ?? null;
    this.Actor = init.Actor ?? "";
    this.ActorUserID = init.ActorUserID ?? 0;
    this.Action = init.Action ?? "";
    this.Detail = init.Detail ?? "";
  }
}

/**
 * 工作项下的单条评论记录。
 */
class IssueComment {
  /**
   * 构造工作项评论对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<IssueComment>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.AuthorType = init.AuthorType ?? "";
    this.AuthorID = init.AuthorID ?? "";
    this.Body = init.Body ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
  }
}

/**
 * 人工驳回工作流节点时的请求载荷，指定驳回目标节点、原因与补充上下文。
 */
class RejectRequest {
  /**
   * 构造驳回请求对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<RejectRequest>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Expected = init.Expected ?? null;
    this.NodeID = init.NodeID ?? "";
    this.TargetID = init.TargetID ?? "";
    this.Reason = init.Reason ?? "";
    this.Context = init.Context ?? "";
  }
}

/**
 * 人工审批通过或重试节点共用的决策载荷，允许操作员附带额外事实（如失败用例名、链接）供后续节点参考。
 */
class HumanDecision {
  /**
   * 构造人工决策载荷对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<HumanDecision>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Expected = init.Expected ?? null;
    this.NodeID = init.NodeID ?? "";
    this.Reason = init.Reason ?? "";
    this.Context = init.Context ?? "";
  }
}

/**
 * 工作台人工操作对应的乐观并发校验预期，用于把操作绑定到用户正在查看的那次节点尝试。
 */
class NodeDecisionExpectation {
  /**
   * 构造节点决策预期对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<NodeDecisionExpectation>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Status = init.Status ?? "";
    this.Attempt = init.Attempt ?? 0;
    this.ReworkCount = init.ReworkCount ?? 0;
  }
}

/** 需求身份块的固定标题标记，用于生成与查重。 */
const issueIdentityMarker = "需求身份（平台权威，禁止忽略）";

/** 工作项 SOP 模式：不绑定 SOP，直接通过会话交付。 */
const IssueSOPNone = "none";
/** 工作项 SOP 模式：使用 SOP 流程交付（写入时用于清除 none 模式）。 */
const IssueSOPUse = "sop";

module.exports = {
  Issue,
  ClarificationAssessment,
  ClarificationMessage,
  ClarificationQuestion,
  ExternalRef,
  IssueOperation,
  IssueComment,
  RejectRequest,
  HumanDecision,
  NodeDecisionExpectation,
  IssueSOPNone,
  IssueSOPUse,
};
