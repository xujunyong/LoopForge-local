/**
 * @file internal/domain/run.js
 * @description 对应 Go 源文件：internal/domain/run.go
 * 职责边界：定义工作流运行实例（Run）、节点运行记录（NodeRun）、门禁结构化决定（GateResult/GateFinding）、Token 用量、遥测事件、运行事件及产物快照模型。
 * 语法差异说明：
 * - Go 的 `time.Time` 对应 JS 的 `Date | null`（零值为 `null`）。
 * - Go 的 `map[string]*NodeRun` 与 `map[string]any` 统一译为普通对象 `{}`。
 * - Go 的 `UnmarshalJSON` 接收 `[]byte` 并返回 `error`，JS 中接受 `string | Buffer | Uint8Array`，解析或校验冲突时 `throw new Error(...)`。
 * - 为避免与 `project.js` 发生循环引用，`Run` 构造函数内延迟引入 `RepositoryContext`。
 */

"use strict";

const { WorkflowDefinition } = require("./workflow.js");
const { TelemetryContext, TelemetrySource } = require("./observability.js");

/**
 * 一次工作流运行或按需对话工作区实例。
 * 聚合冻结的工作流快照、执行租约与工作区生命周期、代码仓库上下文、节点运行表、事件日志、遥测、Token 统计与产物。
 */
class Run {
  /**
   * 构造运行实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.Kind=""] - 运行类型（空为普通 SOP 运行，`"workspace"` 为对话工作区）。
   * @param {string} [init.ID=""] - 运行主键 ID。
   * @param {string} [init.WorkflowID=""] - 所属工作流 ID。
   * @param {WorkflowDefinition} [init.WorkflowSnapshot] - 启动时冻结的工作流定义快照。
   * @param {string} [init.SandboxID=""] - 运行级共享沙箱 ID。
   * @param {string} [init.OwnerInstanceID=""] - 当前持有运行租约的引擎实例 ID。
   * @param {Date|null} [init.LeaseUntil=null] - 运行租约到期时间。
   * @param {number} [init.Generation=0] - 执行代次编号（防脑裂）。
   * @param {string} [init.WorkspaceHost=""] - 承载工作区文件的主机标识。
   * @param {number} [init.WorkspaceEditorID=0] - 当前在 IDE 编辑工作区的用户 ID。
   * @param {Date|null} [init.WorkspaceEditUntil=null] - 工作区编辑租约到期时间。
   * @param {string} [init.WorkspaceRoot=""] - 工作区磁盘根目录路径。
   * @param {Date|null} [init.WorkspaceCleanedAt=null] - 工作区被清理删除的时间。
   * @param {Date|null} [init.WorkspaceCleanupNotBefore=null] - 允许清理终态工作区的最早时间（供预览归档占位）。
   * @param {string} [init.Status=""] - 运行状态（running、waiting、succeeded、failed、cancelled 等）。
   * @param {string} [init.AdmissionState=""] - 准入排队状态。
   * @param {Date|null} [init.QueueEnteredAt=null] - 进入调度队列的时间。
   * @param {boolean} [init.ConcurrencyExempt=false] - 是否豁免并发上限控制。
   * @param {boolean} [init.CancelRequested=false] - 是否已请求取消运行。
   * @param {boolean} [init.PauseRequested=false] - 是否已请求暂停运行。
   * @param {string} [init.Input=""] - 运行初始输入文本。
   * @param {object} [init.Repository] - 兼容旧读者的单仓库上下文（RepositoryContext）。
   * @param {object[]} [init.Repositories=[]] - 冻结进本次运行的全部仓库上下文列表（RepositoryContext[]）。
   * @param {TelemetryContext} [init.ExecutionContext] - 运行关联的遥测执行上下文。
   * @param {Object.<string, NodeRun|null>} [init.Nodes={}] - 按节点 ID 索引的节点运行状态映射。
   * @param {RunEvent[]} [init.Events=[]] - 运行生命周期事件日志列表。
   * @param {TelemetryEvent[]} [init.Telemetry=[]] - 归一化遥测事件列表。
   * @param {number} [init.TelemetrySequence=0] - 最新遥测事件序号。
   * @param {object[]} [init.Logs=[]] - 诊断日志记录列表（LogRecord[]）。
   * @param {number} [init.LogSequence=0] - 最新日志序号。
   * @param {TokenUsage} [init.Usage] - 累计 Token 与成本用量。
   * @param {number} [init.ToolCalls=0] - 累计工具调用次数。
   * @param {Artifact[]} [init.Artifacts=[]] - 收集的产物快照列表。
   * @param {number} [init.ArtifactCount=0] - 产物总数。
   * @param {string} [init.HumanContext=""] - 人工补充的上下文说明。
   * @param {object|null} [init.Timing=null] - 运行计时汇总（RunTiming）。
   * @param {Date|null} [init.CreatedAt=null] - 创建时间。
   * @param {Date|null} [init.UpdatedAt=null] - 最近更新时间。
   * @param {number} [init.Revision=0] - 乐观锁修订版本号。
   */
  constructor(init = {}) {
    const { RepositoryContext } = require("./project.js");
    this.Kind = init.Kind ?? "";
    this.ID = init.ID ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.WorkflowSnapshot = init.WorkflowSnapshot ?? new WorkflowDefinition();
    this.SandboxID = init.SandboxID ?? "";
    this.OwnerInstanceID = init.OwnerInstanceID ?? "";
    this.LeaseUntil = init.LeaseUntil ?? null;
    this.Generation = init.Generation ?? 0;
    this.WorkspaceHost = init.WorkspaceHost ?? "";
    this.WorkspaceEditorID = init.WorkspaceEditorID ?? 0;
    this.WorkspaceEditUntil = init.WorkspaceEditUntil ?? null;
    this.WorkspaceRoot = init.WorkspaceRoot ?? "";
    this.WorkspaceCleanedAt = init.WorkspaceCleanedAt ?? null;
    // WorkspaceCleanupNotBefore 推迟终态工作区的删除，预览终结器仍需运行目录时用；零值表示不保留。
    this.WorkspaceCleanupNotBefore = init.WorkspaceCleanupNotBefore ?? null;
    this.Status = init.Status ?? "";
    this.AdmissionState = init.AdmissionState ?? "";
    this.QueueEnteredAt = init.QueueEnteredAt ?? null;
    this.ConcurrencyExempt = init.ConcurrencyExempt ?? false;
    this.CancelRequested = init.CancelRequested ?? false;
    this.PauseRequested = init.PauseRequested ?? false;
    this.Input = init.Input ?? "";
    this.Repository = init.Repository ?? new RepositoryContext();
    // Repositories 列出冻结进本次运行的全部仓库；Repository 镜像第一项，旧读者（界面卡片、任务）继续可用；执行逻辑必须遍历 Repositories，把各项同等对待；旧运行只有 Repository。
    this.Repositories = init.Repositories ?? [];
    this.ExecutionContext = init.ExecutionContext ?? new TelemetryContext();
    this.Nodes = init.Nodes ?? {};
    this.Events = init.Events ?? [];
    this.Telemetry = init.Telemetry ?? [];
    this.TelemetrySequence = init.TelemetrySequence ?? 0;
    this.Logs = init.Logs ?? [];
    this.LogSequence = init.LogSequence ?? 0;
    this.Usage = init.Usage ?? new TokenUsage();
    this.ToolCalls = init.ToolCalls ?? 0;
    this.Artifacts = init.Artifacts ?? [];
    this.ArtifactCount = init.ArtifactCount ?? 0;
    this.HumanContext = init.HumanContext ?? "";
    this.Timing = init.Timing ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
    this.Revision = init.Revision ?? 0;
  }

  /**
   * 判断该运行是否为按需创建的对话工作区（而非 SOP 工作流运行）。
   *
   * @returns {boolean} `Kind === RunKindWorkspace` 时返回 `true`，否则返回 `false`。
   */
  IsWorkspace() {
    return this.Kind === RunKindWorkspace;
  }

  /**
   * 判断该运行是否为仅归属个人的对话工作区（无关联项目 ID）。
   *
   * @returns {boolean} 是工作区且 `ExecutionContext.ProjectID` 为空时返回 `true`，否则返回 `false`。
   */
  IsPersonalWorkspace() {
    return this.IsWorkspace() && this.ExecutionContext.ProjectID === "";
  }

  /**
   * 判断该对话工作区当前是否处于可实时编辑状态。
   * 对话工作区没有可暂停的 SOP 图，主助手与人在 IDE 中并行编辑并通过 `expectedSha256` 捕获写入冲突。
   *
   * @returns {boolean} 为未取消、未清理且状态为 `running` 或 `waiting` 的对话工作区时返回 `true`。
   */
  LiveWorkspace() {
    return this.IsWorkspace() && !this.CancelRequested && this.WorkspaceCleanedAt == null && (this.Status === "running" || this.Status === "waiting");
  }

  /**
   * 判断人工当前是否可以在 IDE 中编辑该运行的工作区。
   * 只要工作区未被清理，在终态以及未取消的运行/等待状态下均允许随时编辑。
   *
   * @returns {boolean} 允许人工编辑工作区时返回 `true`，否则返回 `false`。
   */
  HumanEditable() {
    if (this.WorkspaceCleanedAt != null) {
      return false;
    }
    switch (this.Status) {
      case "succeeded":
      case "failed":
      case "cancelled":
        return true;
      case "running":
      case "waiting":
        return !this.CancelRequested;
    }
    return false;
  }

  /**
   * 判断该运行是否为已退役角色组协作模式的历史记录（无可供恢复或重试的 SOP 图）。
   *
   * @returns {boolean} 非工作区且快照协作模式为 `"group"` 时返回 `true`，否则返回 `false`。
   */
  HistoricalGroup() {
    return !this.IsWorkspace() && this.WorkflowSnapshot.CollaborationMode === "group";
  }

  /**
   * 判断该运行中是否仍有节点正在执行（状态为 `running` 或等待中途补充输入的 `pending_input`）。
   *
   * @returns {boolean} 存在活跃节点时返回 `true`，否则返回 `false`。
   */
  HasActiveNode() {
    for (const nr of Object.values(this.Nodes ?? {})) {
      if (nr != null && (nr.Status === "running" || nr.Status === "pending_input")) {
        return true;
      }
    }
    return false;
  }

  /**
   * 返回冻结进本次运行的仓库上下文列表。
   * 优先返回 `Repositories`；兼容仅携带单个 `Repository` 的历史运行记录。
   *
   * @returns {object[]|null} 仓库上下文数组（RepositoryContext[]）；若无任何绑定仓库则返回 `null`。
   */
  RepositoryContexts() {
    if ((this.Repositories ?? []).length > 0) {
      return this.Repositories;
    }
    if (!this.Repository.IsZero()) {
      return [this.Repository];
    }
    return null;
  }

  /**
   * 从原始 JSON 文本或字节流反序列化 `Run` 实例，并将历史节点运行中记录的共享沙箱 ID 提升至运行级 `SandboxID`。
   * 若多个历史节点记录了相互冲突的非空 `SandboxID`，则抛出错误。
   *
   * @param {string|Buffer|Uint8Array} raw - 原始 JSON 字符串或字节数据。
   * @returns {void} 无返回值；JSON 解析失败或历史节点沙箱 ID 冲突时抛出 Error。
   */
  UnmarshalJSON(raw) {
    // Go 用别名类型避免递归；这里按 json tag 逐字段映射，时间字符串译为 Date。
    const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    const value = JSON.parse(text);
    const fieldMap = { kind: "Kind", id: "ID", workflowId: "WorkflowID", workflowSnapshot: "WorkflowSnapshot", sandboxId: "SandboxID", ownerInstanceId: "OwnerInstanceID", leaseUntil: "LeaseUntil", executionGeneration: "Generation", workspaceHost: "WorkspaceHost", workspaceEditorId: "WorkspaceEditorID", workspaceEditUntil: "WorkspaceEditUntil", workspaceRoot: "WorkspaceRoot", workspaceCleanedAt: "WorkspaceCleanedAt", workspaceCleanupNotBefore: "WorkspaceCleanupNotBefore", status: "Status", admissionState: "AdmissionState", queueEnteredAt: "QueueEnteredAt", concurrencyExempt: "ConcurrencyExempt", cancelRequested: "CancelRequested", pauseRequested: "PauseRequested", input: "Input", repository: "Repository", repositories: "Repositories", executionContext: "ExecutionContext", nodes: "Nodes", events: "Events", telemetry: "Telemetry", telemetrySequence: "TelemetrySequence", logs: "Logs", logSequence: "LogSequence", usage: "Usage", toolCalls: "ToolCalls", artifacts: "Artifacts", artifactCount: "ArtifactCount", humanContext: "HumanContext", timing: "Timing", createdAt: "CreatedAt", updatedAt: "UpdatedAt", revision: "Revision" };
    const timeFields = { LeaseUntil: true, WorkspaceEditUntil: true, WorkspaceCleanedAt: true, WorkspaceCleanupNotBefore: true, QueueEnteredAt: true, CreatedAt: true, UpdatedAt: true };
    const mapped = {};
    for (const [key, field] of Object.entries(fieldMap)) {
      if (value[key] === undefined) {
        continue;
      }
      mapped[field] = timeFields[field] && value[key] != null ? new Date(value[key]) : value[key];
    }
    if (value.nodes != null) {
      const nodeFieldMap = { nodeId: "NodeID", status: "Status", attempt: "Attempt", reworkCount: "ReworkCount", sandboxId: "SandboxID", output: "Output", error: "Error", provider: "Provider", model: "Model", sessionId: "SessionID", resumeSessionId: "ResumeSessionID", activity: "Activity", feedback: "Feedback", usage: "Usage", usageSessionId: "UsageSessionID", usageCursor: "UsageCursor", toolCalls: "ToolCalls", gateResult: "GateResult", childRunId: "ChildRunID", startedAt: "StartedAt", finishedAt: "FinishedAt" };
      const nodes = {};
      for (const [nodeID, node] of Object.entries(value.nodes)) {
        if (node == null) {
          nodes[nodeID] = null;
          continue;
        }
        const nodeMapped = {};
        for (const [key, field] of Object.entries(nodeFieldMap)) {
          if (node[key] === undefined) {
            continue;
          }
          nodeMapped[field] = (field === "StartedAt" || field === "FinishedAt") && node[key] != null ? new Date(node[key]) : node[key];
        }
        nodes[nodeID] = new NodeRun(nodeMapped);
      }
      mapped.Nodes = nodes;
    }
    Object.assign(this, new Run(mapped));
    if (this.SandboxID !== "") {
      return;
    }
    for (const node of Object.values(this.Nodes ?? {})) {
      if (node == null || (node.SandboxID ?? "").trim() === "") {
        continue;
      }
      if (this.SandboxID !== "" && this.SandboxID !== node.SandboxID) {
        throw new Error(`run ${JSON.stringify(this.ID)} has conflicting legacy node sandbox ids ${JSON.stringify(this.SandboxID)} and ${JSON.stringify(node.SandboxID)}`);
      }
      this.SandboxID = node.SandboxID;
    }
  }
}

const RunKindWorkspace = "workspace";
const ConversationWorkspaceWorkflowID = "conversation-workspace";

/**
 * 单个工作流节点的最新执行状态记录。
 * 记录节点状态、尝试与返工次数、模型会话、输出/错误、Token 用量游标、门禁结果及起止时间。
 */
class NodeRun {
  /**
   * 构造节点运行记录实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.NodeID=""] - 节点 ID。
   * @param {string} [init.Status=""] - 节点当前状态。
   * @param {number} [init.Attempt=0] - 当前尝试次数。
   * @param {number} [init.ReworkCount=0] - 累计返工次数。
   * @param {string} [init.SandboxID=""] - 节点级沙箱 ID（历史兼容字段）。
   * @param {string} [init.Output=""] - 节点标准输出或结果报告。
   * @param {string} [init.Error=""] - 节点失败错误信息。
   * @param {string} [init.Provider=""] - 执行使用的模型提供方。
   * @param {string} [init.Model=""] - 执行使用的模型名。
   * @param {string} [init.SessionID=""] - 当前底层执行会话 ID。
   * @param {string} [init.ResumeSessionID=""] - 恢复续跑时使用的会话 ID。
   * @param {string} [init.Activity=""] - 实时活动摘要文本。
   * @param {string} [init.Feedback=""] - 人工审批或打回反馈文本。
   * @param {TokenUsage} [init.Usage] - 节点累计 Token 用量。
   * @param {string} [init.UsageSessionID=""] - 用量游标对应的会话 ID。
   * @param {TokenUsage} [init.UsageCursor] - 上次累计时的用量游标快照。
   * @param {number} [init.ToolCalls=0] - 节点工具调用次数。
   * @param {GateResult|null} [init.GateResult=null] - Agent 提交的结构化门禁决定。
   * @param {string} [init.ChildRunID=""] - SOP 节点启动的子运行 ID。
   * @param {Date|null} [init.StartedAt=null] - 节点开始执行时间。
   * @param {Date|null} [init.FinishedAt=null] - 节点结束执行时间。
   */
  constructor(init = {}) {
    this.NodeID = init.NodeID ?? "";
    this.Status = init.Status ?? "";
    this.Attempt = init.Attempt ?? 0;
    this.ReworkCount = init.ReworkCount ?? 0;
    this.SandboxID = init.SandboxID ?? "";
    this.Output = init.Output ?? "";
    this.Error = init.Error ?? "";
    this.Provider = init.Provider ?? "";
    this.Model = init.Model ?? "";
    this.SessionID = init.SessionID ?? "";
    this.ResumeSessionID = init.ResumeSessionID ?? "";
    this.Activity = init.Activity ?? "";
    this.Feedback = init.Feedback ?? "";
    this.Usage = init.Usage ?? new TokenUsage();
    this.UsageSessionID = init.UsageSessionID ?? "";
    this.UsageCursor = init.UsageCursor ?? new TokenUsage();
    this.ToolCalls = init.ToolCalls ?? 0;
    this.GateResult = init.GateResult ?? null;
    this.ChildRunID = init.ChildRunID ?? "";
    this.StartedAt = init.StartedAt ?? null;
    this.FinishedAt = init.FinishedAt ?? null;
  }
}

/**
 * Agent 通过调用期 `submit_gate_result` MCP 工具提交的结构化门禁终态决定。
 */
class GateResult {
  /**
   * 构造门禁决定实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.Decision=""] - 门禁决定（pass、rework、fail 或 human）。
   * @param {string} [init.Reason=""] - 做出该决定的原因说明。
   * @param {string} [init.ActionRequired=""] - 需要下游或人工处理的行动说明。
   * @param {string} [init.Summary=""] - 门禁检查摘要。
   * @param {GateFinding[]} [init.Findings=[]] - 检查发现的问题条目列表。
   */
  constructor(init = {}) {
    this.Decision = init.Decision ?? "";
    this.Reason = init.Reason ?? "";
    this.ActionRequired = init.ActionRequired ?? "";
    this.Summary = init.Summary ?? "";
    this.Findings = init.Findings ?? [];
  }
}

/**
 * 门禁检查报告中的单条具体发现。
 */
class GateFinding {
  /**
   * 构造门禁发现实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.Severity=""] - 问题严重级别。
   * @param {string} [init.Title=""] - 问题简述标题。
   * @param {string} [init.Evidence=""] - 支撑该发现的证据摘录。
   */
  constructor(init = {}) {
    this.Severity = init.Severity ?? "";
    this.Title = init.Title ?? "";
    this.Evidence = init.Evidence ?? "";
  }
}

/**
 * 模型调用的 Token 消耗与成本统计结构。
 */
class TokenUsage {
  /**
   * 构造 Token 用量实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {number} [init.InputTokens=0] - 输入 Token 数。
   * @param {number} [init.OutputTokens=0] - 输出 Token 数。
   * @param {number} [init.CacheReadTokens=0] - 缓存命中读取 Token 数。
   * @param {number} [init.CacheWriteTokens=0] - 缓存写入 Token 数。
   * @param {number} [init.TotalTokens=0] - 总 Token 数。
   * @param {number} [init.CostUSD=0] - 费用（美元）。
   * @param {number} [init.ReasoningTokens=0] - 推理思考 Token 数。
   * @param {number} [init.ContextWindow=0] - 当前模型上下文窗口大小。
   * @param {string} [init.CostStatus=""] - 成本状态（reported、estimated 或 unknown；空值兼容视为 unknown）。
   */
  constructor(init = {}) {
    this.InputTokens = init.InputTokens ?? 0;
    this.OutputTokens = init.OutputTokens ?? 0;
    this.CacheReadTokens = init.CacheReadTokens ?? 0;
    this.CacheWriteTokens = init.CacheWriteTokens ?? 0;
    this.TotalTokens = init.TotalTokens ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
    this.ReasoningTokens = init.ReasoningTokens ?? 0;
    this.ContextWindow = init.ContextWindow ?? 0;
    // CostStatus 区分"成本为 0"与"成本未知"：reported（适配器上报）、estimated（按 token 估算）、unknown（未识别，展示为"未识别"而不是 ¥0）。空值视为 unknown，旧数据向后兼容。
    this.CostStatus = init.CostStatus ?? "";
  }
}

/**
 * 归一化后的单条平台遥测事件。
 * 用于统一记录生命周期、模型、推理、输出、工具、用量、进程、核查及沙箱等观测信息。
 */
class TelemetryEvent {
  /**
   * 构造遥测事件实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.SpecVersion=""] - 可观测性规约版本。
   * @param {string} [init.ID=""] - 事件唯一 ID。
   * @param {string} [init.RunID=""] - 所属运行 ID。
   * @param {string} [init.NodeID=""] - 所属节点 ID。
   * @param {number} [init.Sequence=0] - 运行内递增事件序号。
   * @param {Date|null} [init.Timestamp=null] - 事件发生时间。
   * @param {string} [init.Category=""] - 事件分类（lifecycle、model、reasoning、output、tool、usage、process、verification、sandbox）。
   * @param {string} [init.Name=""] - 事件名称。
   * @param {string} [init.Phase=""] - 事件阶段（start、progress、finish）。
   * @param {string} [init.Level=""] - 事件级别。
   * @param {string} [init.Message=""] - 可读事件消息。
   * @param {string} [init.Provider=""] - 模型或服务提供方。
   * @param {string} [init.Model=""] - 模型名称。
   * @param {string} [init.SessionID=""] - 会话 ID。
   * @param {string} [init.ToolCallID=""] - 工具调用 ID。
   * @param {string} [init.ParentID=""] - 父事件 ID。
   * @param {TokenUsage|null} [init.Usage=null] - 关联的 Token 用量。
   * @param {Object.<string, *>} [init.Attributes={}] - 扩展结构化属性。
   * @param {TelemetrySource} [init.Source] - 遥测事件来源。
   * @param {TelemetryContext} [init.Context] - 遥测关联上下文。
   * @param {object[]} [init.Metrics=[]] - 随事件携带的指标点列表（MetricPoint[]）。
   * @param {object|null} [init.Tool=null] - 工具调用观测数据（ToolObservation）。
   * @param {object|null} [init.ModelOperation=null] - 模型调用观测数据（ModelObservation）。
   * @param {object|null} [init.Error=null] - 错误观测数据（ErrorObservation）。
   */
  constructor(init = {}) {
    this.SpecVersion = init.SpecVersion ?? "";
    this.ID = init.ID ?? "";
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Sequence = init.Sequence ?? 0;
    this.Timestamp = init.Timestamp ?? null;
    this.Category = init.Category ?? "";
    this.Name = init.Name ?? "";
    this.Phase = init.Phase ?? "";
    this.Level = init.Level ?? "";
    this.Message = init.Message ?? "";
    this.Provider = init.Provider ?? "";
    this.Model = init.Model ?? "";
    this.SessionID = init.SessionID ?? "";
    this.ToolCallID = init.ToolCallID ?? "";
    this.ParentID = init.ParentID ?? "";
    this.Usage = init.Usage ?? null;
    this.Attributes = init.Attributes ?? {};
    this.Source = init.Source ?? new TelemetrySource();
    this.Context = init.Context ?? new TelemetryContext();
    this.Metrics = init.Metrics ?? [];
    this.Tool = init.Tool ?? null;
    this.ModelOperation = init.ModelOperation ?? null;
    this.Error = init.Error ?? null;
  }
}

/**
 * 运行事件时间线中的单条状态变更记录。
 */
class RunEvent {
  /**
   * 构造运行事件实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - 事件主键 ID。
   * @param {string} [init.RunID=""] - 所属运行 ID。
   * @param {string} [init.NodeID=""] - 关联节点 ID。
   * @param {string} [init.Type=""] - 事件类型（如 `node.started`、`run.succeeded`）。
   * @param {string} [init.Message=""] - 事件说明文本。
   * @param {Date|null} [init.Timestamp=null] - 事件发生时间。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Type = init.Type ?? "";
    this.Message = init.Message ?? "";
    this.Timestamp = init.Timestamp ?? null;
  }
}

/**
 * 不可变的、按节点尝试区分的产物快照。
 * 保留历史尝试产物以便返工审计，下游节点默认消费最新成功版本。
 */
class Artifact {
  /**
   * 构造产物快照实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - 产物主键 ID。
   * @param {string} [init.RunID=""] - 所属运行 ID。
   * @param {string} [init.NodeID=""] - 产出该产物的节点 ID。
   * @param {number} [init.Attempt=0] - 节点尝试序号。
   * @param {string} [init.Name=""] - 产物契约名称。
   * @param {string} [init.Path=""] - 产物相对文件路径。
   * @param {string} [init.MediaType=""] - 媒体类型（MIME）。
   * @param {number} [init.Size=0] - 产物内容字节大小。
   * @param {string} [init.SHA256=""] - 产物内容 SHA-256 哈希。
   * @param {string} [init.Content=""] - 产物文本内容。
   * @param {string} [init.RepositoryDir=""] - 产物来源仓库子目录（空表示来自运行工作区根目录）。
   * @param {Date|null} [init.CreatedAt=null] - 产物收集时间。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Attempt = init.Attempt ?? 0;
    this.Name = init.Name ?? "";
    this.Path = init.Path ?? "";
    this.MediaType = init.MediaType ?? "";
    this.Size = init.Size ?? 0;
    this.SHA256 = init.SHA256 ?? "";
    this.Content = init.Content ?? "";
    // RepositoryDir 记录产物取自哪个运行仓库工作区（空为运行工作区根目录，SOP 交付物所在处）。
    this.RepositoryDir = init.RepositoryDir ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
  }
}

module.exports = { Run, RunKindWorkspace, ConversationWorkspaceWorkflowID, NodeRun, GateResult, GateFinding, TokenUsage, TelemetryEvent, RunEvent, Artifact };
