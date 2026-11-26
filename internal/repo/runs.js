/**
 * @file internal/repo/runs.js
 * 对应 Go 源文件：internal/repo/runs.go
 *
 * 作用与职责边界：
 * 实现 `RunsRepo` 的核心运行持久化与查询能力，涵盖运行头与数据库行之间的映射、全量/轻量摘要/引擎态/UI 视图/SSE 流视图读取、
 * 运行控制位（取消/暂停）与修订号乐观锁写入、分布式执行租约与工作区宿主机绑定、工作流指标与耗时统计、
 * 沙箱与工作区清理筛选，以及日志与遥测事件的游标分页查询。
 * 准入限流逻辑由 `run_admission.js` 实现，对话工作区增量写由 `runs_conversation.js` 实现。
 *
 * 语法差异说明：
 * - `RunsRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `RunsRepo.prototype` 挂载方法。
 * - Go 的 `(值, error)`、`(值1, 值2, error)` 与仅 `error` 返回统一按成功返回值（或二元组 / `undefined`）、失败 `throw err` 处理；
 *   `db.Transaction(tx => ...)` 回调同样遵循失败抛错、成功正常返回；`(值, bool)` 译为 `[值, boolean]` 二元组。
 * - Go 的 `time.Time` 对应 `Date`（零值 `null`），`time.Duration` 换算为毫秒数；`timeMs` 用于与 Go 零值时间对齐比较。
 * - Go 的 `map[string]V` 与 `map[string]struct{}` 统一译为普通对象 `{}`；`gorm.Expr` 译为 `new clause.Expr({ SQL: ... })`。
 * - `parallel` 在单线程 JS 中按序执行全部回调、收集首个异常并在所有回调完成后抛出，保持与 Go `WaitGroup` 相同的失败传播语义。
 * - 与 `run_admission.js`、`analytics.js`、`runs_conversation.js`、`../observability/hooks.js` 采用函数内延迟 `require` 避免循环引用。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { Run, NodeRun, RunEvent, TelemetryEvent, Artifact } = require("../domain/run.js"); // 对应 Go 的 domain.Run/NodeRun/RunEvent/TelemetryEvent/Artifact，run.js 已翻译
const { LogRecord } = require("../domain/observability.js"); // 对应 Go 的 domain.LogRecord，observability.js 已翻译
const { WorkflowDefinition, WorkflowMetrics, RunSummary, WorkflowNodeMetric } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition/WorkflowMetrics/RunSummary/WorkflowNodeMetric，workflow.js 已翻译
const { DockerfileDefinition } = require("../domain/assets.js"); // 对应 Go 的 domain.DockerfileDefinition，assets.js 已翻译
const { PreviewBuildNodeID } = require("../domain/preview.js"); // 对应 Go 的 domain.PreviewBuildNodeID，preview.js 已翻译
const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { ComputeRunTiming, RunTimingEventTypes } = require("../domain/run_timing.js"); // 对应 Go 的 domain.ComputeRunTiming/RunTimingEventTypes，run_timing.js 已翻译
const { RunProjectID } = require("../domain/catalog.js"); // 对应 Go 的 domain.RunProjectID，catalog.js 已翻译
const { Issue } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue，issue.js 已翻译
const { AnalyticsFilter } = require("../domain/analytics.js"); // 对应 Go 的 domain.AnalyticsFilter，analytics.js 已翻译
const { RunsRepo, ErrRunDecisionStale, ErrRunLeaseHeld, ErrRunLeaseLost, ErrRunWorkspaceBound } = require("./repo.js"); // 对应 Go 同包类型与变量，repo.js 已翻译
const { runRow, runArtifactRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { jsonBytes, jsonUnmarshal, mustJSON, timePtr, upsert, upsertColumns } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译

/**
 * 将 `Date` 或 Go 零值时间（`null`）换算为可比较的毫秒时间戳（零值对应公元 0001-01-01 UTC）。
 *
 * @param {Date|null|undefined} t - 待换算的时间值。
 * @returns {number} 对应的毫秒时间戳。
 */
function timeMs(t) {
  return t == null ? -62135596800000 : t.getTime();
}

/**
 * 延迟调用 `run_admission.js` 中的 `runAdmissionBucketKey`，避免同包循环引用。
 *
 * @param {Run} run - 运行领域对象。
 * @returns {string} 该运行所属的准入分桶键。
 */
function runAdmissionBucketKey(run) {
  return require("./run_admission.js").runAdmissionBucketKey(run);
}

/**
 * 延迟调用 `run_admission.js` 中的 `lockAdmissionGate`，在事务内对指定准入分桶加排他锁。
 *
 * @param {object} d - 共享依赖对象（含 `locking` 方法）。
 * @param {object} tx - 当前活跃的 `gorm.DB` 事务句柄。
 * @param {string} key - 准入分桶键。
 * @returns {void} 无返回值。
 * @throws {Error} 锁行创建或加锁失败时抛出错误。
 */
function lockAdmissionGate(d, tx, key) {
  require("./run_admission.js").lockAdmissionGate(d, tx, key);
}

/**
 * 延迟获取 `run_admission.js` 中的 `admissionLockRequired` 错误类，用于 `instanceof` 判定。
 *
 * @returns {typeof Error} `admissionLockRequired` 构造函数。
 */
function admissionLockRequired() {
  return require("./run_admission.js").admissionLockRequired;
}

/**
 * 延迟调用 `analytics.js` 中的 `analyticsRunInWindow`，判断运行是否落在分析时间窗口内。
 *
 * @param {Run} run - 运行领域对象。
 * @param {AnalyticsFilter} filter - 分析过滤条件。
 * @returns {boolean} 落在窗口内时返回 `true`，否则返回 `false`。
 */
function analyticsRunInWindow(run, filter) {
  return require("./analytics.js").analyticsRunInWindow(run, filter);
}

/**
 * 延迟调用 `analytics.js` 中的 `analyticsRunMatchesUser`，判断运行是否匹配指定责任用户。
 *
 * @param {Run} run - 运行领域对象。
 * @param {string} userID - 目标用户 ID 字符串。
 * @param {Issue} issue - 仅携带负责人信息的关联需求对象。
 * @returns {boolean} 匹配时返回 `true`，否则返回 `false`。
 */
function analyticsRunMatchesUser(run, userID, issue) {
  return require("./analytics.js").analyticsRunMatchesUser(run, userID, issue);
}

/**
 * 延迟调用 `runs_conversation.js` 中的 `keepConversationRunFields`，防止旧副本写入覆盖对话工作区的增量用量与需求关联。
 *
 * @param {Run} run - 待写入的运行领域对象（会被就地合并保留字段）。
 * @param {runRow} current - 数据库中当前已存在的运行行。
 * @returns {void} 无返回值。
 */
function keepConversationRunFields(run, current) {
  require("./runs_conversation.js").keepConversationRunFields(run, current);
}

/**
 * 延迟加载 `../observability/hooks.js`，供遥测适配器过滤逻辑读取常量与匹配函数。
 *
 * @returns {object} `observability/hooks.js` 导出模块对象。
 */
function observabilityHooks() {
  return require("../observability/hooks.js");
}

// ---------- Run header mapping ----------

/**
 * 将数据库 `runs` 表行模型映射为 `domain.Run` 运行头领域对象，解码嵌入式 JSON 字段并回填时间戳。
 * JSON 列缺失或解码失败时按 Go 原文语义静默保留字段零值。
 *
 * @param {runRow} row - 数据库 `runs` 表行模型。
 * @returns {Run} 映射后的运行领域对象（不含子表节点/事件/产物）。
 */
function runFromRow(row) {
  const run = new Run({
    ID: row.ID, Kind: row.Kind, WorkflowID: row.WorkflowID, Status: row.Status, Revision: row.Revision,
    Input: row.Input, ToolCalls: row.ToolCalls,
    TelemetrySequence: row.TelemetrySequence, LogSequence: row.LogSequence,
    OwnerInstanceID: row.OwnerInstanceID, Generation: row.Generation,
    WorkspaceHost: row.WorkspaceHost, WorkspaceRoot: row.WorkspaceRoot, WorkspaceEditorID: row.WorkspaceEditorID,
    HumanContext: row.HumanContext, CancelRequested: row.CancelRequested, PauseRequested: row.PauseRequested,
    SandboxID: row.SandboxID, AdmissionState: row.AdmissionState,
    ConcurrencyExempt: row.QuotaExempt != null && row.QuotaExempt,
  });
  if (row.QueueEntered != null) {
    run.QueueEnteredAt = row.QueueEntered;
  }
  try {
    jsonUnmarshal(row.Repository, run.Repository);
  } catch {
    // Go 原文忽略解码错误。
  }
  if (row.Repositories != null && row.Repositories.length > 0) {
    try {
      jsonUnmarshal(row.Repositories, run.Repositories);
    } catch {
      // Go 原文忽略解码错误。
    }
  }
  try {
    jsonUnmarshal(row.Snapshot, run.WorkflowSnapshot);
  } catch {
    // Go 原文忽略解码错误。
  }
  try {
    jsonUnmarshal(row.ExecutionContext, run.ExecutionContext);
  } catch {
    // Go 原文忽略解码错误。
  }
  try {
    jsonUnmarshal(row.UsageJSON, run.Usage);
  } catch {
    // Go 原文忽略解码错误。
  }
  if (row.Created != null) {
    run.CreatedAt = row.Created;
  }
  if (row.Updated != null) {
    run.UpdatedAt = row.Updated;
  }
  if (row.WorkspaceEditUntil != null) {
    run.WorkspaceEditUntil = row.WorkspaceEditUntil;
  }
  if (row.LeaseUntil != null) {
    run.LeaseUntil = row.LeaseUntil;
  }
  if (row.WorkspaceCleaned != null) {
    run.WorkspaceCleanedAt = row.WorkspaceCleaned;
  }
  if (row.CleanupNotBefore != null) {
    run.WorkspaceCleanupNotBefore = row.CleanupNotBefore;
  }
  return run;
}

/**
 * 将 `domain.Run` 领域对象转换为写入 `runs` 表所需的列名到列值映射。
 * 多仓列表为空时写入 `null`（SQL NULL）而非 `"[]"`，以保持按 `IS NULL` 过滤的查询语义一致。
 *
 * @param {Run} run - 待持久化的运行领域对象。
 * @returns {Object.<string, *>} `runs` 表列名到列值的普通对象映射。
 */
function runRowValues(run) {
  return {
    id: run.ID, kind: run.Kind, workflow_id: run.WorkflowID, status: run.Status, revision: run.Revision,
    input: run.Input, human_context: run.HumanContext,
    quota_project_id: run.ExecutionContext.ProjectID.trim(), quota_parent_run_id: run.ExecutionContext.ParentRunID.trim(),
    quota_exempt: run.ConcurrencyExempt, admission_state: run.AdmissionState, queue_entered_at: timePtr(run.QueueEnteredAt),
    quota_bucket: runAdmissionBucketKey(run),
    cancel_requested: run.CancelRequested, pause_requested: run.PauseRequested, sandbox_id: run.SandboxID,
    repository: jsonBytes(run.Repository),
    // 空多仓集合写 SQL NULL 而不是 '[]'。
    repositories: repositoriesJSONValue(run.Repositories), snapshot: jsonBytes(run.WorkflowSnapshot),
    execution_context: jsonBytes(run.ExecutionContext), usage_json: jsonBytes(run.Usage),
    tool_calls: run.ToolCalls, telemetry_sequence: run.TelemetrySequence, log_sequence: run.LogSequence,
    owner_instance_id: run.OwnerInstanceID, lease_until: timePtr(run.LeaseUntil),
    execution_generation: run.Generation, workspace_host: run.WorkspaceHost, workspace_root: run.WorkspaceRoot,
    workspace_cleaned_at: timePtr(run.WorkspaceCleanedAt),
    workspace_cleanup_not_before: timePtr(run.WorkspaceCleanupNotBefore),
    workspace_editor_id: run.WorkspaceEditorID, workspace_edit_until: timePtr(run.WorkspaceEditUntil),
    created_at: timePtr(run.CreatedAt), updated_at: timePtr(run.UpdatedAt),
  };
}

/**
 * 按主键 ID 从 `runs` 表读取单条原始运行行。
 * 使用场景：供 `Run`、`RunState`、`RunView` 与控制位更新方法内部读取运行头。
 *
 * @param {object} db - `gorm.DB` 数据库或事务句柄。
 * @param {string} id - 运行主键 ID。
 * @returns {[runRow, boolean]} 二元组 `[运行行, 是否读取成功]`；不存在或查询失败时返回 `[new runRow(), false]`。
 */
function takeRun(db, id) {
  const row = new runRow();
  if (db.Where("id = ?", id).Take(row).Error != null) {
    return [new runRow(), false];
  }
  return [row, true];
}

// ---------- Reads ----------

/**
 * 读取全部运行记录（含节点与产物元数据，不含日志与遥测），按创建时间倒序排列。
 * 单个运行的子表加载失败时会跳过该条记录。
 *
 * @returns {Run[]} 按创建时间倒序排列的运行对象数组；查询失败时返回空数组 `[]`。
 */
RunsRepo.prototype.Runs = function () {
  const rows = [];
  if (this.DB.Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const run = runFromRow(row);
    try {
      this.loadRunNodes(run);
      this.loadArtifactMeta(run);
    } catch {
      continue;
    }
    out.push(run);
  }
  out.sort((a, b) => timeMs(b.CreatedAt) - timeMs(a.CreatedAt));
  return out;
};

/**
 * 返回适合列表展示的轻量运行摘要列表。
 * 在数据库层即裁剪掉庞大的节点输出与工作流图快照，避免无谓传输到 HTTP 层后再丢弃。
 *
 * @returns {Run[] | null} 轻量运行摘要数组（空结果按空切片语义可能返回 `null`）。
 * @throws {Error} 数据库查询或子表聚合失败时抛出错误。
 */
RunsRepo.prototype.RunSummaries = function () {
  return this.RunSummariesFor(new AnalyticsFilter(), "");
};

/**
 * 按分析过滤条件与可选需求 ID 返回轻量运行摘要列表。
 * 在加载子表前先过滤运行头，并保留历史运行经关联需求回退解析项目的语义。
 *
 * @param {AnalyticsFilter} filter - 项目、工作流、时间窗口与责任人过滤条件。
 * @param {string} issueID - 可选需求 ID 过滤；为空字符串时不按需求过滤。
 * @returns {Run[] | null} 轻量运行摘要数组（按筛选条件无结果时返回 `[]` 或 `null`）。
 * @throws {Error} 数据库查询或子表聚合失败时抛出错误。
 */
RunsRepo.prototype.RunSummariesFor = function (filter, issueID) {
  const [runs] = this.runSummariesFor(filter, issueID);
  return runs;
};

/**
 * 返回轻量运行摘要列表以及计算 `Run.Timing` 时一并读取的计时事件映射。
 * 使用场景：供业务领域分析等同时需要摘要与计时事件的调用方复用单次扫描，避免重复查库。
 *
 * @param {AnalyticsFilter} filter - 项目、工作流、时间窗口与责任人过滤条件。
 * @param {string} issueID - 可选需求 ID 过滤；为空字符串时不按需求过滤。
 * @returns {[Run[] | null, Object.<string, RunEvent[]> | null]} 二元组 `[运行摘要数组, 按运行 ID 索引的计时事件映射]`。
 * @throws {Error} 数据库查询或子表聚合失败时抛出错误。
 */
RunsRepo.prototype.RunSummariesWithEventsFor = function (filter, issueID) {
  return this.runSummariesFor(filter, issueID);
};

/**
 * 轻量运行摘要的内部公共实现：SQL 级裁剪快照与输入长度，按项目/责任人/窗口过滤后批量补齐节点摘要、产物计数与计时数据。
 *
 * @param {AnalyticsFilter} filter - 分析过滤条件。
 * @param {string} issueID - 可选需求 ID 过滤。
 * @returns {[Run[] | null, Object.<string, RunEvent[]> | null]} 二元组 `[运行摘要数组, 计时事件映射]`。
 * @throws {Error} 运行头、节点摘要、产物计数或计时事件查询失败时抛出错误。
 */
RunsRepo.prototype.runSummariesFor = function (filter, issueID) {
  if (filter.ProjectIDs != null && filter.ProjectIDs.length === 0) {
    return [[], null];
  }
  let q = this.DB;
  if (filter.ProjectIDs != null) {
    const expr = this.sqlExecutionContextJSONText("projectId");
    q = q.Where(expr + " IN ? OR " + expr + " IS NULL OR " + expr + " = ''", filter.ProjectIDs);
  }
  if (filter.WorkflowID !== "") {
    q = q.Where("workflow_id = ?", filter.WorkflowID);
  }
  const projectID = filter.ProjectID.trim();
  if (projectID !== "") {
    const expr = this.sqlExecutionContextJSONText("projectId");
    // 保留未写入 projectId 的历史行，后续由 FilterRunsByProject 通过关联需求补全归属。
    q = q.Where(expr + " = ? OR " + expr + " IS NULL OR " + expr + " = ''", projectID);
  }
  if (filter.From != null) {
    q = q.Where("created_at >= ?", filter.From);
  }
  if (filter.To != null) {
    q = q.Where("created_at <= ? OR created_at IS NULL", filter.To);
  }
  if (issueID !== "") {
    const expr = this.sqlExecutionContextJSONText("issueId");
    q = q.Where(expr + " = ?", issueID);
  }
  const rows = [];
  // 列表仅提取冻结 SOP 的标识与协作模式，并将 input 在 SQL 层截断至 500 字符；节点图与脚本保留在快照列中不传输。
  let snapshotExpr = "json_object('id', json_extract(snapshot, '$.id'), 'name', json_extract(snapshot, '$.name'), 'collaborationMode', json_extract(snapshot, '$.collaborationMode')) AS snapshot";
  if (this.isMySQL()) {
    snapshotExpr = "JSON_OBJECT('id', JSON_UNQUOTE(JSON_EXTRACT(snapshot, '$.id')), 'name', JSON_UNQUOTE(JSON_EXTRACT(snapshot, '$.name')), 'collaborationMode', JSON_UNQUOTE(JSON_EXTRACT(snapshot, '$.collaborationMode'))) AS snapshot";
  }
  const findErr = q.Select("id", "kind", "workflow_id", "status", "admission_state", "queue_entered_at", "quota_exempt", "cancel_requested", "pause_requested", "human_context", "revision", "SUBSTR(input, 1, 500) AS input", "repository", "repositories", snapshotExpr, "execution_context", "usage_json", "tool_calls", "telemetry_sequence", "log_sequence", "owner_instance_id", "lease_until", "execution_generation", "workspace_host", "workspace_root", "workspace_cleaned_at", "created_at", "updated_at").
    Order("created_at DESC, id DESC").
    Find(rows).Error;
  if (findErr != null) {
    throw findErr;
  }
  let candidates = [];
  for (const row of rows) {
    const run = runFromRow(row);
    if (issueID !== "" && run.ExecutionContext.IssueID !== issueID) {
      continue;
    }
    if (filter.WorkflowID !== "" && run.WorkflowID !== filter.WorkflowID) {
      continue;
    }
    if (!analyticsRunInWindow(run, filter)) {
      continue;
    }
    candidates.push(run);
  }
  candidates = this.FilterRunsByProject(candidates, filter.ProjectID);
  if (filter.ProjectIDs != null) {
    candidates = this.filterRunsByProjects(candidates, filter.ProjectIDs);
  }
  if (filter.UserID.trim() !== "") {
    candidates = this.filterRunsByResponsibleUser(candidates, filter.UserID);
  }
  const ids = [];
  for (const run of candidates) {
    ids.push(run.ID);
  }
  if (ids.length === 0) {
    if (filter.ProjectID.trim() !== "") {
      return [[], null];
    }
    return [null, null];
  }
  const nodes = this.runNodeSummaries(ids);
  const artifactCounts = this.artifactCounts(ids);
  const timingEvents = this.runTimingEvents(ids);
  const now = new Date();
  const out = [];
  for (const run of candidates) {
    // 仅挂载节点摘要字段（不含大体积执行输出）。
    for (const [nodeID, node] of Object.entries(nodes[run.ID] ?? {})) {
      if (run.Nodes == null) {
        run.Nodes = {};
      }
      run.Nodes[nodeID] = node;
    }
    if (run.Nodes == null) {
      run.Nodes = {};
    }
    run.ArtifactCount = artifactCounts[run.ID] ?? 0;
    const timing = ComputeRunTiming(run, timingEvents[run.ID] ?? [], now);
    run.Timing = timing;
    out.push(run);
  }
  out.sort((a, b) => {
    if (timeMs(a.CreatedAt) === timeMs(b.CreatedAt)) {
      if (a.ID > b.ID) {
        return -1;
      }
      if (a.ID < b.ID) {
        return 1;
      }
      return 0;
    }
    return timeMs(b.CreatedAt) - timeMs(a.CreatedAt);
  });
  if (out.length === 0) {
    // 空结果保持 nil slice 语义，与 Go 原文序列化行为一致。
    return [null, null];
  }
  return [out, timingEvents];
};

/**
 * 批量读取所有运行的 `id -> status` 映射，避免为对账任务状态而加载事件、遥测、日志、产物与节点。
 * 使用场景：任务状态对账（reconcile）及轻量列表状态查询。
 *
 * @returns {Object.<string, string>} 运行 ID 到状态字符串的普通对象映射；查询失败时返回 `{}`。
 */
RunsRepo.prototype.RunStatuses = function () {
  const rows = [];
  if (this.DB.Select("id", "status").Find(rows).Error != null) {
    return {};
  }
  const out = {};
  for (const row of rows) {
    out[row.ID] = row.Status;
  }
  return out;
};

/**
 * 按上下文与主键读取单条运行的状态字段，不加载工作流图或事件历史。
 * 使用场景：后台轮询或等待运行状态变化时的极轻量单点检查。
 *
 * @param {AbortSignal} ctx - 控制查询取消的上下文信号（对应 Go 的 `context.Context`）。
 * @param {string} id - 运行主键 ID。
 * @returns {[string, boolean]} 二元组 `[运行状态, 记录是否存在]`；记录不存在时返回 `["", false]`。
 * @throws {Error} 数据库查询发生非 `ErrRecordNotFound` 错误时抛出错误。
 */
RunsRepo.prototype.ReadRunStatus = function (ctx, id) {
  const row = new runRow();
  const err = this.DB.WithContext(ctx).Select("status").Where("id = ?", id).Take(row).Error;
  if (err === gorm.ErrRecordNotFound) {
    return ["", false];
  }
  if (err != null) {
    throw err;
  }
  return [row.Status, true];
};

/**
 * 查询当前仍包含 `running` 或 `pending_input` 活跃节点的运行 ID 集合。
 * 使用场景：任务对账时识别尚未静止的运行，避免加载完整运行视图。
 *
 * @returns {Object.<string, boolean>} 存在活跃节点的运行 ID 集合（键为运行 ID，值为 `true`）；查询失败时返回 `{}`。
 */
RunsRepo.prototype.RunsWithActiveNodes = function () {
  const ids = [];
  if (this.DB.Table("run_nodes").Distinct().
    Where("status IN ?", ["running", "pending_input"]).
    Pluck("run_id", ids).Error != null) {
    return {};
  }
  const out = {};
  for (const id of ids) {
    out[id] = true;
  }
  return out;
};

/**
 * 按主键读取完整的运行聚合（包含运行头、全部节点、事件、遥测、日志与产物正文）。
 * 使用场景：需要全量运行数据的导出、测试断言或后台深度检查。
 *
 * @param {string} id - 运行主键 ID。
 * @returns {[Run, boolean]} 二元组 `[完整运行对象, 是否存在且加载成功]`；不存在或任一子表失败时返回 `[new Run(), false]`。
 */
RunsRepo.prototype.Run = function (id) {
  const [row, ok] = takeRun(this.DB, id);
  if (!ok) {
    return [new Run(), false];
  }
  const run = runFromRow(row);
  try {
    this.loadRunNodes(run);
    this.loadRunHeavy(run);
  } catch {
    return [new Run(), false];
  }
  return [run, true];
};

/**
 * 仅读取运行的标识、类型、工作流 ID 与执行上下文，不加载快照、节点、事件或产物。
 * 记录不存在时返回零值 `Run` 对象（不抛错）。
 *
 * @param {string} id - 运行主键 ID。
 * @returns {Run} 仅填充头部标识字段的运行对象。
 * @throws {Error} 数据库查询发生非 `ErrRecordNotFound` 错误时抛出错误。
 */
RunsRepo.prototype.RunHeader = function (id) {
  const row = new runRow();
  const err = this.DB.Select("id", "kind", "workflow_id", "execution_context").Where("id = ?", id).Take(row).Error;
  if (err === gorm.ErrRecordNotFound) {
    return new Run();
  }
  if (err != null) {
    throw err;
  }
  return runFromRow(row);
};

/**
 * 从运行冻结的 `snapshot` 列中直接提取所属项目 ID，不加载工作流图或执行子表。
 * 使用场景：鉴权或归属校验时快速定位运行冻结快照上的项目 ID。
 *
 * @param {string} id - 运行主键 ID。
 * @returns {string} 去除首尾空白后的冻结项目 ID（记录不存在或未设置时为空串 `""`）。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
RunsRepo.prototype.RunWorkflowProjectID = function (id) {
  let project = "JSON_EXTRACT(snapshot, '$.projectId')";
  if (this.isMySQL()) {
    project = "JSON_UNQUOTE(" + project + ")";
  }
  const row = { ProjectID: "" };
  const err = this.DB.Table("runs").Select(project + " AS project_id").Where("id = ?", id).Scan(row).Error;
  if (err != null) {
    throw err;
  }
  return row.ProjectID.trim();
};

/**
 * 读取执行引擎调度所需的持久化聚合（运行头、全部节点、事件与含正文的产物，刻意不加载日志与遥测历史）。
 * 日志与遥测是仅追加数据，不参与状态机决策；跳过它们可避免长运行每次状态流转超时丢失租约。
 *
 * @param {string} id - 运行主键 ID。
 * @returns {[Run, boolean]} 二元组 `[引擎态运行聚合, 是否读取成功]`；不存在或子表查询失败时返回 `[new Run(), false]`。
 */
RunsRepo.prototype.RunState = function (id) {
  const [row, ok] = takeRun(this.DB, id);
  if (!ok) {
    return [new Run(), false];
  }
  const run = runFromRow(row);
  try {
    this.loadRunNodes(run);
  } catch {
    return [new Run(), false];
  }
  const eventRows = [];
  if (this.DB.Where("run_id = ?", run.ID).Order("seq").Find(eventRows).Error != null) {
    return [new Run(), false];
  }
  for (const eventRow of eventRows) {
    const ev = new RunEvent();
    try {
      jsonUnmarshal(eventRow.Payload, ev);
      run.Events.push(ev);
    } catch {
      // 跳过损坏的事件 JSON。
    }
  }
  const artifactRows = [];
  if (this.DB.Where("run_id = ?", run.ID).Find(artifactRows).Error != null) {
    return [new Run(), false];
  }
  for (const artifactRow of artifactRows) {
    const art = artifactFromRow(artifactRow, true);
    run.Artifacts.push(art);
  }
  return [run, true];
};

/**
 * 读取面向 UI 详情页的运行视图：包含运行头、截断后的节点数据、产物元数据与耗时统计，不加载日志正文；
 * 若协作模式为 `"group"`，额外补齐最近 80 条按序号正序排列的事件。
 *
 * @param {string} id - 运行主键 ID。
 * @returns {[Run, boolean]} 二元组 `[UI 运行视图, 是否读取成功]`；不存在或子表查询失败时返回 `[new Run(), false]`。
 */
RunsRepo.prototype.RunView = function (id) {
  const [row, ok] = takeRun(this.DB, id);
  if (!ok) {
    return [new Run(), false];
  }
  const run = runFromRow(row);
  let events;
  try {
    this.loadRunNodesFrom(this.runViewNodesQuery(), run);
    this.loadArtifactMeta(run);
    events = this.runTimingEvents([run.ID]);
  } catch {
    return [new Run(), false];
  }
  const timing = ComputeRunTiming(run, events[run.ID] ?? [], new Date());
  run.Timing = timing;
  if (run.WorkflowSnapshot.CollaborationMode === "group") {
    const rows = [];
    if (this.DB.Where("run_id = ?", id).Order("seq DESC").Limit(80).Find(rows).Error != null) {
      return [new Run(), false];
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      const event = new RunEvent();
      try {
        jsonUnmarshal(rows[i].Payload, event);
        run.Events.push(event);
      } catch {
        // 跳过损坏的事件 JSON。
      }
    }
  }
  return [run, true];
};

/**
 * 读取符合 SSE 推送契约的运行流视图：在 `RunView` 基础上仅附带最近 80 条日志与最近 80 条遥测事件，不加载全量历史正文。
 * 使用场景：前端建立 SSE 实时订阅时发送初始快照。
 *
 * @param {string} id - 运行主键 ID。
 * @returns {[Run, boolean]} 二元组 `[SSE 运行视图, 是否读取成功]`；不存在或查询失败时返回 `[new Run(), false]`。
 */
RunsRepo.prototype.RunStreamView = function (id) {
  const [run, ok] = this.RunView(id);
  if (!ok) {
    return [new Run(), false];
  }
  const logs = [];
  if (this.DB.Where("run_id = ?", id).Order("seq DESC").Limit(80).Find(logs).Error != null) {
    return [new Run(), false];
  }
  for (let i = logs.length - 1; i >= 0; i--) {
    const record = new LogRecord();
    try {
      jsonUnmarshal(logs[i].Payload, record);
      run.Logs.push(record);
    } catch {
      // 跳过损坏的日志 JSON。
    }
  }
  const events = [];
  if (this.DB.Where("run_id = ?", id).Order("seq DESC").Limit(80).Find(events).Error != null) {
    return [new Run(), false];
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = new TelemetryEvent();
    try {
      jsonUnmarshal(events[i].Payload, event);
      run.Telemetry.push(event);
    } catch {
      // 跳过损坏的遥测 JSON。
    }
  }
  return [run, true];
};

/**
 * 在单次查询中批量获取给定运行 ID 列表对应的当前修订号；不存在的 ID 不会出现在结果映射中。
 * 使用场景：SSE 轮询或批量变更探测时快速比对 revision。
 *
 * @param {string[]} ids - 待查询的运行 ID 列表。
 * @returns {Object.<string, number> | null} `runID -> revision` 映射对象；数据库查询失败时返回 `null`。
 */
RunsRepo.prototype.RunRevisions = function (ids) {
  const out = {};
  if (ids.length === 0) {
    return out;
  }
  const rows = [];
  if (this.DB.Select("id", "revision").Where("id IN ?", ids).Find(rows).Error != null) {
    return null;
  }
  for (const row of rows) {
    out[row.ID] = row.Revision;
  }
  return out;
};

/**
 * 读取单条运行的当前修订号。
 * 使用场景：轻量轮询检查单条运行是否有新变更。
 *
 * @param {string} id - 运行主键 ID。
 * @returns {[number, boolean]} 二元组 `[当前修订号, 是否查询成功]`。
 */
RunsRepo.prototype.RunRevision = function (id) {
  const row = new runRow();
  const err = this.DB.Select("revision").Where("id = ?", id).Take(row).Error;
  return [row.Revision, err == null];
};

/**
 * 列出同一需求下已被新派发取代、且工作区尚未清理的已结束（`failed`/`cancelled`）运行 ID。
 * 失败运行默认保留工作区与容器以便重试；当需求重新发起新运行时，旧失败运行的容器即可被回收。
 *
 * @param {string} issueID - 目标需求 ID。
 * @param {string} keepRunID - 需要保留不被回收的当前运行 ID（可为空串）。
 * @returns {string[] | null} 可回收的旧运行 ID 列表；入参为空或查询失败时返回 `null`。
 */
RunsRepo.prototype.SupersededIssueRunIDs = function (issueID, keepRunID) {
  issueID = issueID.trim();
  if (issueID === "") {
    return null;
  }
  const expr = this.sqlExecutionContextJSONText("issueId");
  const ids = [];
  let q = this.DB.Model(new runRow()).
    Where(expr + " = ?", issueID).
    Where("status IN ?", ["failed", "cancelled"]).
    Where("workspace_cleaned_at IS NULL");
  const keep = keepRunID.trim();
  if (keep !== "") {
    q = q.Where("id <> ?", keep);
  }
  if (q.Pluck("id", ids).Error != null) {
    return null;
  }
  return ids;
};

/**
 * 返回所有工作区尚未被清理（`workspace_cleaned_at IS NULL`）的运行 ID 列表。
 * 使用场景：容器与磁盘工作区垃圾回收时确认仍受保护的存活运行集合。
 *
 * @returns {string[] | null} 存活工作区对应的运行 ID 数组；查询失败时返回 `null`。
 */
RunsRepo.prototype.LiveSandboxRunIDs = function () {
  const ids = [];
  if (this.DB.Model(new runRow()).Select("id").Where("workspace_cleaned_at IS NULL").Pluck("id", ids).Error != null) {
    return null;
  }
  return ids;
};

/**
 * 返回所有仍持有工作区的运行中冻结保存的 Dockerfile 定义列表。
 * 镜像生命周期须长于目录配置变更：当空闲容器被销毁后，重试仍需用原冻结镜像重建容器。
 *
 * @returns {DockerfileDefinition[] | null} 有效非空的 Dockerfile 定义数组；查询失败时返回 `null`。
 */
RunsRepo.prototype.LiveSandboxDockerfiles = function () {
  let expr = "json_extract(snapshot, '$.sandboxSnapshot.dockerfile')";
  if (this.isMySQL()) {
    expr = "JSON_EXTRACT(snapshot, '$.sandboxSnapshot.dockerfile')";
  }
  const raws = [];
  if (this.DB.Model(new runRow()).Where("workspace_cleaned_at IS NULL").
    Where(expr + " IS NOT NULL").Pluck(expr, raws).Error != null) {
    return null;
  }
  const out = [];
  for (const raw of raws) {
    const dockerfile = new DockerfileDefinition();
    try {
      jsonUnmarshal(raw, dockerfile);
      if (dockerfile.Content.trim() !== "") {
        out.push(dockerfile);
      }
    } catch {
      // 跳过无法解析的 Dockerfile 片段。
    }
  }
  return out;
};

/**
 * 查询长期无变更的空闲沙箱运行 ID（`failed` 早于 `failedBefore`，或 `waiting` 早于 `waitingBefore` 且未清理工作区）。
 * 使用场景：后台空闲容器回收任务筛选待释放容器的运行。
 *
 * @param {Date} failedBefore - 失败状态运行的过期截止时间。
 * @param {Date} waitingBefore - 等待状态运行的过期截止时间。
 * @returns {string[] | null} 命中过期条件的运行 ID 数组；查询失败时返回 `null`。
 */
RunsRepo.prototype.IdleSandboxRunIDs = function (failedBefore, waitingBefore) {
  const ids = [];
  if (this.DB.Model(new runRow()).
    Where("workspace_cleaned_at IS NULL").
    Where("(status = ? AND updated_at < ?) OR (status = ? AND updated_at < ?)", "failed", failedBefore, "waiting", waitingBefore).
    Pluck("id", ids).Error != null) {
    return null;
  }
  return ids;
};

/**
 * 返回全部处于 `succeeded` 或 `cancelled` 终态的运行头列表，供立即清理或对账巡检工作区使用。
 *
 * @returns {Run[] | null} 终态运行头对象数组；查询失败时返回 `null`。
 */
RunsRepo.prototype.TerminalWorkspaceCleanupRuns = function () {
  const rows = [];
  const err = this.DB.Where("status IN ?", ["succeeded", "cancelled"]).Find(rows).Error;
  if (err != null) {
    return null;
  }
  const result = [];
  for (const row of rows) {
    result.push(runFromRow(row));
  }
  return result;
};

/**
 * 查询已完成静态站点构建节点、工作区仍在磁盘上且尚未生成 `run_previews` 记录的非取消运行 ID。
 * 使用场景：后台预览兜底任务补建静态预览。
 *
 * @returns {string[] | null} 待生成预览的运行 ID 数组；查询失败时返回 `null`。
 */
RunsRepo.prototype.RunsAwaitingBuiltPreview = function () {
  const ids = [];
  const err = this.DB.Model(new runRow()).
    Select("DISTINCT runs.id").
    Joins("JOIN run_nodes ON run_nodes.run_id = runs.id AND run_nodes.node_id = ? AND run_nodes.status = ?", PreviewBuildNodeID, "succeeded").
    Joins("LEFT JOIN run_previews ON run_previews.run_id = runs.id").
    Where("runs.workspace_cleaned_at IS NULL AND runs.status <> ? AND run_previews.id IS NULL", "cancelled").
    Pluck("runs.id", ids).Error;
  if (err != null) {
    return null;
  }
  return ids;
};

/**
 * 在开始清理工作区前原子标记到期终态运行为已清理并清空 `sandbox_id`，防止并发重试在删除进行期间复用该目录。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {Date} now - 当前 UTC 时间，用于写入 `workspace_cleaned_at` 并比较冷却截止时间。
 * @returns {boolean} 成功原子认领清理权时返回 `true`，不满足条件或已被其他实例认领时返回 `false`。
 * @throws {Error} 数据库更新出错时抛出错误。
 */
RunsRepo.prototype.ClaimRunWorkspaceCleanup = function (runID, now) {
  const result = this.DB.Model(new runRow()).
    Where("id = ? AND status IN ? AND workspace_cleaned_at IS NULL AND (workspace_cleanup_not_before IS NULL OR workspace_cleanup_not_before <= ?)",
      runID, ["succeeded", "cancelled"], now).
    Updates({ workspace_cleaned_at: now, sandbox_id: "" });
  if (result.Error != null) {
    throw result.Error;
  }
  return result.RowsAffected === 1;
};

/**
 * 撤销已认领的工作区清理标记，使未能安全调度或完成删除的工作区在后续巡检中重新参与清理。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新出错时抛出错误。
 */
RunsRepo.prototype.ResetRunWorkspaceCleanup = function (runID) {
  const err = this.DB.Model(new runRow()).Where("id = ?", runID).Update("workspace_cleaned_at", null).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 加载指定运行的完整节点映射并写入 `run.Nodes`。
 * 使用场景：引擎状态读与全量运行读路径。
 *
 * @param {Run} run - 待填充节点的运行对象（会被就地修改 `run.Nodes`）。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
RunsRepo.prototype.loadRunNodes = function (run) {
  this.loadRunNodesFrom(this.DB, run);
};

/**
 * 构造面向 UI 视图的 `run_nodes` 投影查询，在 SQL 层截断 `output`、`error`、`feedback`、`activity` 字段。
 * 每个字段比 HTTP 展示上限多保留 1 个字符，以便上层裁剪函数准确判断是否追加省略号（含 UTF-8 字符）。
 *
 * @returns {object} 带 `JSON_SET` 截断投影的 `gorm.DB` 查询构建器。
 */
RunsRepo.prototype.runViewNodesQuery = function () {
  const parts = ["payload"];
  for (const field of [{ name: "output", limit: 2501 }, { name: "error", limit: 1201 }, { name: "feedback", limit: 801 }, { name: "activity", limit: 301 }]) {
    const path = "'$." + field.name + "'";
    const extract = "JSON_EXTRACT(payload, " + path + ")";
    let text = extract;
    if (this.isMySQL()) {
      text = "JSON_UNQUOTE(" + extract + ")";
    }
    parts.push(path, `CASE WHEN JSON_TYPE(${extract}) = 'STRING' THEN SUBSTR(${text}, 1, ${field.limit}) ELSE ${extract} END`);
    if (!this.isMySQL()) {
      parts[parts.length - 1] = `CASE WHEN JSON_TYPE(payload, ${path}) = 'text' THEN SUBSTR(${text}, 1, ${field.limit}) ELSE ${extract} END`;
    }
  }
  return this.DB.Select("run_id, node_id, JSON_SET(" + parts.join(", ") + ") AS payload");
};

/**
 * 使用指定查询构建器 `q` 加载运行的所有节点行并解码填充到 `run.Nodes`，跳过损坏的节点 JSON。
 *
 * @param {object} q - `gorm.DB` 查询构建器（全量表或截断投影）。
 * @param {Run} run - 待填充 `Nodes` 映射的目标运行对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
RunsRepo.prototype.loadRunNodesFrom = function (q, run) {
  const rows = [];
  const err = q.Where("run_id = ?", run.ID).Find(rows).Error;
  if (err != null) {
    throw err;
  }
  run.Nodes = {};
  for (const row of rows) {
    const node = new NodeRun();
    try {
      jsonUnmarshal(row.Payload, node);
    } catch {
      continue;
    }
    run.Nodes[row.NodeID] = node;
  }
};

/**
 * 在 SQL 层按白名单投影批量读取多个运行的轻量节点摘要，避免把大体积执行输出、反馈和会话状态传过数据库连接。
 * 按每批 500 条分片查询 `run_nodes`。
 *
 * @param {string[]} ids - 运行主键 ID 列表。
 * @returns {Object.<string, Object.<string, NodeRun>>} 两级映射 `runID -> nodeID -> NodeRun`。
 * @throws {Error} 任一批次数据库查询失败时抛出错误。
 */
RunsRepo.prototype.runNodeSummaries = function (ids) {
  const byRun = {};
  const errorExpr = this.isMySQL() ? "JSON_UNQUOTE(JSON_EXTRACT(payload, '$.error'))" : "json_extract(payload, '$.error')";
  const projection = `JSON_OBJECT(
		'reworkCount', JSON_EXTRACT(payload, '$.reworkCount'),
		'provider', JSON_EXTRACT(payload, '$.provider'),
		'model', JSON_EXTRACT(payload, '$.model'),
		'childRunId', JSON_EXTRACT(payload, '$.childRunId'),
		'usage', JSON_EXTRACT(payload, '$.usage'),
		'toolCalls', JSON_EXTRACT(payload, '$.toolCalls'),
		'startedAt', JSON_EXTRACT(payload, '$.startedAt'),
		'finishedAt', JSON_EXTRACT(payload, '$.finishedAt'),
		'error', SUBSTR(${errorExpr}, 1, 160)) AS payload`;
  for (let start = 0; start < ids.length; start += 500) {
    const batch = ids.slice(start, Math.min(start + 500, ids.length));
    const rows = [];
    const err = this.DB.Select("run_id, node_id, status, attempt, " + projection).Where("run_id IN ?", batch).Find(rows).Error;
    if (err != null) {
      throw err;
    }
    for (const row of rows) {
      const node = new NodeRun();
      try {
        jsonUnmarshal(row.Payload, node);
      } catch {
        continue;
      }
      const summary = summarizeNode(node, row.NodeID, row.Status, row.Attempt);
      if (byRun[row.RunID] == null) {
        byRun[row.RunID] = {};
      }
      byRun[row.RunID][row.NodeID] = summary;
    }
  }
  return byRun;
};

/**
 * 仅保留列表视图所需的节点摘要字段（截断错误文本至 160 字符、丢弃执行输出），与 SQL 白名单投影保持一致。
 *
 * @param {NodeRun} node - 已反序列化的节点对象。
 * @param {string} nodeID - 节点 ID 列值。
 * @param {string} status - 节点状态列值。
 * @param {number} attempt - 节点尝试次数列值。
 * @returns {NodeRun} 精简后的节点摘要对象。
 */
function summarizeNode(node, nodeID, status, attempt) {
  const summary = new NodeRun({
    NodeID: nodeID, Status: status, Attempt: attempt,
    ReworkCount: node.ReworkCount, Provider: node.Provider, Model: node.Model,
    ChildRunID: node.ChildRunID,
    Usage: node.Usage, ToolCalls: node.ToolCalls,
    StartedAt: node.StartedAt, FinishedAt: node.FinishedAt,
  });
  if (node.Error.length > 160) {
    summary.Error = node.Error.slice(0, 160);
  } else {
    summary.Error = node.Error;
  }
  return summary;
}

/**
 * 加载运行的全部重型子表数据（事件、遥测、日志与含正文的产物）并写入 `run`。
 * 使用场景：仅由全量读取方法 `Run(id)` 调用。
 *
 * @param {Run} run - 待填充重型子表字段的运行对象。
 * @returns {void} 无返回值。
 * @throws {Error} 任一子表数据库查询失败时抛出错误。
 */
RunsRepo.prototype.loadRunHeavy = function (run) {
  run.Events = null;
  run.Telemetry = null;
  run.Logs = null;
  run.Artifacts = null;
  const eventRows = [];
  const eventErr = this.DB.Where("run_id = ?", run.ID).Order("seq").Find(eventRows).Error;
  if (eventErr != null) {
    throw eventErr;
  }
  for (const eventRow of eventRows) {
    const ev = new RunEvent();
    try {
      jsonUnmarshal(eventRow.Payload, ev);
      if (run.Events == null) {
        run.Events = [];
      }
      run.Events.push(ev);
    } catch {
      // 跳过损坏的事件 JSON。
    }
  }
  const telemetryRows = [];
  const telemetryErr = this.DB.Where("run_id = ?", run.ID).Order("seq").Find(telemetryRows).Error;
  if (telemetryErr != null) {
    throw telemetryErr;
  }
  for (const telemetryRow of telemetryRows) {
    const ev = new TelemetryEvent();
    try {
      jsonUnmarshal(telemetryRow.Payload, ev);
      if (run.Telemetry == null) {
        run.Telemetry = [];
      }
      run.Telemetry.push(ev);
    } catch {
      // 跳过损坏的遥测 JSON。
    }
  }
  const logRows = [];
  const logErr = this.DB.Where("run_id = ?", run.ID).Order("seq").Find(logRows).Error;
  if (logErr != null) {
    throw logErr;
  }
  for (const logRow of logRows) {
    const rec = new LogRecord();
    try {
      jsonUnmarshal(logRow.Payload, rec);
      if (run.Logs == null) {
        run.Logs = [];
      }
      run.Logs.push(rec);
    } catch {
      // 跳过损坏的日志 JSON。
    }
  }
  const artifactRows = [];
  const artifactErr = this.DB.Where("run_id = ?", run.ID).Find(artifactRows).Error;
  if (artifactErr != null) {
    throw artifactErr;
  }
  for (const artifactRow of artifactRows) {
    if (run.Artifacts == null) {
      run.Artifacts = [];
    }
    run.Artifacts.push(artifactFromRow(artifactRow, true));
  }
};

/**
 * 仅加载指定运行的产物元数据列（跳过 `content` 正文），同时更新 `run.ArtifactCount`。
 * 使用场景：`Runs()` 与 `RunView()` 列表/详情轻量读取。
 *
 * @param {Run} run - 待填充产物元数据的运行对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
RunsRepo.prototype.loadArtifactMeta = function (run) {
  const rows = [];
  const err = this.DB.Select("id", "run_id", "node_id", "attempt", "name", "path", "media_type", "size_bytes", "sha256", "created_at").
    Where("run_id = ?", run.ID).Find(rows).Error;
  if (err != null) {
    throw err;
  }
  for (const row of rows) {
    run.Artifacts.push(artifactFromRow(row, false));
  }
  run.ArtifactCount = run.Artifacts.length;
};

/**
 * 分批统计指定运行 ID 列表各自拥有的产物总数量。
 * 使用场景：供 `runSummariesFor` 填充列表视图上的 `ArtifactCount`。
 *
 * @param {string[]} ids - 运行主键 ID 列表。
 * @returns {Object.<string, number>} `runID -> 产物数量` 的映射对象。
 * @throws {Error} 任一批次聚合查询失败时抛出错误。
 */
RunsRepo.prototype.artifactCounts = function (ids) {
  const counts = {};
  for (let start = 0; start < ids.length; start += 500) {
    const rows = [];
    const err = this.DB.Table("run_artifacts").Select("run_id, COUNT(*) AS count").Where("run_id IN ?", ids.slice(start, Math.min(start + 500, ids.length))).Group("run_id").Scan(rows).Error;
    if (err != null) {
      throw err;
    }
    for (const row of rows) {
      counts[row.RunID] = row.Count;
    }
  }
  return counts;
};

/**
 * 仅读取计算 `ComputeRunTiming` 所需的事件关键列（跳过 `payload` 列，且按事件类型白名单过滤掉高频心跳事件）。
 *
 * @param {string[]} ids - 运行主键 ID 列表。
 * @returns {Object.<string, RunEvent[]>} 按运行 ID 分组、按 `seq` 排序的计时事件数组映射。
 * @throws {Error} 任一批次数据库查询失败时抛出错误。
 */
RunsRepo.prototype.runTimingEvents = function (ids) {
  const out = {};
  for (let start = 0; start < ids.length; start += 500) {
    const rows = [];
    const err = this.DB.Select("run_id", "seq", "node_id", "type", "ts").
      Where("run_id IN ? AND type IN ?", ids.slice(start, Math.min(start + 500, ids.length)), RunTimingEventTypes).
      Order("run_id, seq").Find(rows).Error;
    if (err != null) {
      throw err;
    }
    for (const row of rows) {
      if (row.Ts == null) {
        continue;
      }
      out[row.RunID] = out[row.RunID] ?? [];
      out[row.RunID].push(new RunEvent({ RunID: row.RunID, NodeID: row.NodeID, Type: row.Type, Timestamp: row.Ts }));
    }
  }
  return out;
};

/**
 * 批量读取多个运行的归属项目 ID（用于鉴权元数据查询），不加载快照、节点、事件或产物内容。
 * 不存在的运行不会出现在返回映射中。
 *
 * @param {string[]} ids - 运行主键 ID 列表。
 * @returns {Object.<string, string>} `runID -> projectID` 映射对象。
 * @throws {Error} 任一批次数据库查询失败时抛出错误。
 */
RunsRepo.prototype.RunProjectIDs = function (ids) {
  const out = {};
  const project = this.sqlExecutionContextJSONText("projectId");
  for (let start = 0; start < ids.length; start += 500) {
    const rows = [];
    const err = this.DB.Table("runs").Select("id, " + project + " AS project_id").
      Where("id IN ?", ids.slice(start, Math.min(start + 500, ids.length))).Scan(rows).Error;
    if (err != null) {
      throw err;
    }
    for (const row of rows) {
      out[row.ID] = row.ProjectID;
    }
  }
  return out;
};

/**
 * 按主键检查运行是否存在，不加载节点或快照。
 *
 * @param {string} id - 运行主键 ID。
 * @returns {boolean} 记录存在时返回 `true`，否则返回 `false`。
 */
RunsRepo.prototype.RunExists = function (id) {
  const row = new runRow();
  return this.DB.Select("id").Where("id = ?", id).Take(row).Error == null;
};

/**
 * 检查指定运行下是否已持久化具有给定 `eventID` 的遥测事件，提供事件幂等去重的持久化保障。
 * 由于 `RunState` 不加载遥测历史，仅检查内存聚合会在落盘后重复接收同一事件。
 *
 * @param {string} runID - 运行主键 ID。
 * @param {string} eventID - 遥测事件唯一 ID。
 * @returns {boolean} 数据库中已存在匹配事件时返回 `true`，否则返回 `false`。
 */
RunsRepo.prototype.TelemetryEventExists = function (runID, eventID) {
  runID = runID.trim();
  eventID = eventID.trim();
  if (runID === "" || eventID === "") {
    return false;
  }
  let expr = "json_extract(payload, '$.id')";
  if (this.isMySQL()) {
    expr = "JSON_UNQUOTE(JSON_EXTRACT(payload, '$.id'))";
  }
  let count = 0;
  const err = this.DB.Table("run_telemetry").Where("run_id = ? AND " + expr + " = ?", runID, eventID).Limit(1).Count(count).Error;
  return err == null && count > 0;
};

/**
 * 将数据库 `run_artifacts` 行模型映射为 `domain.Artifact` 对象，可按需控制是否携带正文内容。
 *
 * @param {runArtifactRow} row - 数据库产物行模型。
 * @param {boolean} withContent - 是否拷贝 `row.Content` 产物正文。
 * @returns {Artifact} 映射后的产物领域对象。
 */
function artifactFromRow(row, withContent) {
  const art = new Artifact({
    ID: row.ID, RunID: row.RunID, NodeID: row.NodeID, Attempt: row.Attempt,
    Name: row.Name, Path: row.Path, MediaType: row.MediaType, Size: row.SizeBytes,
    SHA256: row.SHA256, RepositoryDir: row.RepositoryDir,
  });
  if (withContent) {
    art.Content = row.Content;
  }
  if (row.Created != null) {
    art.CreatedAt = row.Created;
  }
  return art;
}

/**
 * 按运行 ID 与产物 ID 读取单条完整产物记录（含正文内容）。
 * 使用场景：前端下载或预览某份运行产物文件时调用。
 *
 * @param {string} runID - 运行主键 ID。
 * @param {string} artifactID - 产物主键 ID。
 * @returns {[Artifact, boolean]} 二元组 `[产物对象, 是否存在]`；未找到或查询出错时返回 `[new Artifact(), false]`。
 */
RunsRepo.prototype.Artifact = function (runID, artifactID) {
  const row = new runArtifactRow();
  if (this.DB.Where("run_id = ? AND id = ?", runID, artifactID).Take(row).Error != null) {
    return [new Artifact(), false];
  }
  return [artifactFromRow(row, true), true];
};

/**
 * 按单个项目 ID 过滤运行列表：保留直接标记该项目的运行，以及关联需求属于该项目的历史运行。
 * 当 `projectID` 为空串时原样返回输入列表。
 *
 * @param {Run[]} runs - 待过滤的运行对象数组。
 * @param {string} projectID - 目标项目 ID。
 * @returns {Run[]} 归属该项目的运行数组。
 */
RunsRepo.prototype.FilterRunsByProject = function (runs, projectID) {
  projectID = projectID.trim();
  if (projectID === "") {
    return runs;
  }
  return this.filterRunsByProjects(runs, [projectID]);
};

/**
 * 按多个允许的项目 ID 集合过滤运行列表；对未标记 `ProjectID` 但关联了需求的运行，分批查库补齐其所属项目后再判定。
 *
 * @param {Run[]} runs - 待过滤的运行对象数组。
 * @param {string[]} projectIDs - 允许的项目 ID 列表。
 * @returns {Run[]} 属于允许项目集合的运行数组。
 */
RunsRepo.prototype.filterRunsByProjects = function (runs, projectIDs) {
  const allowed = {};
  for (const id of projectIDs) {
    allowed[id] = true;
  }

  const issueIDs = {};
  for (const run of runs) {
    if (run.ExecutionContext.ProjectID.trim() === "" && run.ExecutionContext.IssueID !== "") {
      issueIDs[run.ExecutionContext.IssueID] = true;
    }
  }
  const ids = Object.keys(issueIDs);
  const issueProject = {};
  for (let start = 0; start < ids.length; start += 500) {
    const issues = [];
    this.DB.Select("id", "project_id").Where("id IN ?", ids.slice(start, Math.min(start + 500, ids.length))).Find(issues);
    for (const issue of issues) {
      issueProject[issue.ID] = issue.ProjectID;
    }
  }
  const out = [];
  for (const run of runs) {
    if (allowed[RunProjectID(run, issueProject[run.ExecutionContext.IssueID] ?? "")]) {
      out.push(run);
    }
  }
  return out;
};

/**
 * 按责任用户过滤运行列表：保留执行者或关联需求负责人匹配指定用户的运行。
 *
 * @param {Run[]} runs - 待过滤的运行对象数组。
 * @param {string} userID - 目标责任用户 ID 字符串；为空串时原样返回。
 * @returns {Run[]} 匹配指定用户的运行数组。
 */
RunsRepo.prototype.filterRunsByResponsibleUser = function (runs, userID) {
  const want = userID.trim();
  if (want === "") {
    return runs;
  }
  const issueIDs = [];
  const seen = {};
  for (const run of runs) {
    const id = run.ExecutionContext.IssueID.trim();
    if (id === "") {
      continue;
    }
    if (seen[id]) {
      continue;
    }
    seen[id] = true;
    issueIDs.push(id);
  }
  const assignees = {};
  if (this.DB != null && issueIDs.length > 0) {
    for (let start = 0; start < issueIDs.length; start += 500) {
      const issues = [];
      this.DB.Select("id", "assignee_user_id").Where("id IN ?", issueIDs.slice(start, Math.min(start + 500, issueIDs.length))).Find(issues);
      for (const issue of issues) {
        if (issue.AssigneeUserID != null) {
          assignees[issue.ID] = issue.AssigneeUserID;
        }
      }
    }
  }
  const out = [];
  for (const run of runs) {
    const issue = new Issue({ AssigneeUserID: assignees[run.ExecutionContext.IssueID.trim()] });
    if (analyticsRunMatchesUser(run, want, issue)) {
      out.push(run);
    }
  }
  return out;
};

// ---------- Writes ----------

/**
 * 刷新更新时间并递增修订号，将完整的当前运行聚合持久化到数据库。
 * 生产路径不保留进程内缓存副本，后续读取直接查询数据库。
 *
 * @param {Run} v - 待持久化的运行领域对象。
 * @returns {void} 无返回值。
 * @throws {Error} 租约失效、准入拒绝或数据库事务写入失败时抛出错误。
 */
RunsRepo.prototype.PutRun = function (v) {
  v.UpdatedAt = new Date();
  v.Revision++;
  this.writeRun(v);
};

/**
 * 在单事务中持久化运行头及自上次写入以来新增的节点、事件、遥测、日志与产物。
 * 大多数写入不申请新名额，无需获取分桶锁；若 `writeRunOnce` 发现需要占用新名额并抛出 `admissionLockRequired`，
 * 会回滚当前事务并以目标分桶键先锁桶再重试（最多重试 3 次），避免持运行行锁等待桶锁造成死锁。
 *
 * @param {Run} run - 待写入的运行对象。
 * @param {...number} expectedRevision - 可选期望修订号（用于审批决策等乐观锁写入）。
 * @returns {void} 无返回值。
 * @throws {Error} 超过重试次数或遇到其他事务/业务错误时抛出错误。
 */
RunsRepo.prototype.writeRun = function (run, ...expectedRevision) {
  let lockKey = "";
  for (let attempt = 0; ; attempt++) {
    try {
      this.writeRunOnce(run, lockKey, ...expectedRevision);
      return;
    } catch (err) {
      if (err instanceof admissionLockRequired() && attempt < 3) {
        lockKey = err.key;
        continue;
      }
      throw err;
    }
  }
};

/**
 * 执行单次运行持久化事务：按需先获取准入桶锁，再锁定运行行校验修订号、租约代次与有效期，
 * 随后执行准入裁决、更新运行头（保留租约/工作区绑定与控制位列）并增量写入各子表记录。
 *
 * @param {Run} run - 待写入的运行对象。
 * @param {string} lockKey - 本次事务预先锁定的准入分桶键（无需桶锁时为空串 `""`）。
 * @param {...number} expectedRevision - 可选期望修订号。
 * @returns {void} 无返回值。
 * @throws {Error} 修订号过期（`ErrRunDecisionStale`）、租约丢失（`ErrRunLeaseLost`）、缺少桶锁（`admissionLockRequired`）或数据库写入失败时抛出错误。
 */
RunsRepo.prototype.writeRunOnce = function (run, lockKey, ...expectedRevision) {
  let opts = [];
  if (lockKey !== "") {
    opts = this.admissionTxOptions();
  }
  this.DB.Transaction((tx) => {
    if (lockKey !== "") {
      lockAdmissionGate(this, tx, lockKey);
    }
    let current = new runRow();
    let exists = false;
    try {
      current = this.takeRunForUpdate(tx, run.ID);
      exists = true;
    } catch (err) {
      if (err !== gorm.ErrRecordNotFound) {
        throw err;
      }
    }
    if (exists) {
      if (expectedRevision.length > 0 && current.Revision !== expectedRevision[0]) {
        throw ErrRunDecisionStale;
      }
      if (run.Generation !== current.Generation) {
        throw ErrRunLeaseLost;
      }
      const leaseExpired = current.OwnerInstanceID !== "" && (current.LeaseUntil == null || current.LeaseUntil.getTime() <= Date.now());
      if (leaseExpired && !TerminalRunStatus(run.Status)) {
        throw ErrRunLeaseLost;
      }
      if (run.WorkspaceCleanedAt == null && current.WorkspaceCleaned != null) {
        run.WorkspaceCleanedAt = current.WorkspaceCleaned;
      }
      if (run.WorkspaceCleanupNotBefore == null && current.CleanupNotBefore != null) {
        run.WorkspaceCleanupNotBefore = current.CleanupNotBefore;
      }
      if (run.IsWorkspace()) {
        keepConversationRunFields(run, current);
      }
    }
    if (expectedRevision.length > 0) {
      if (!exists) {
        throw ErrRunDecisionStale;
      }
      if (run.Status === "running" || (!run.PauseRequested && !run.CancelRequested)) {
        const clearErr = tx.Model(new runRow()).Where("id = ?", run.ID).Updates({ cancel_requested: false, pause_requested: false }).Error;
        if (clearErr != null) {
          throw clearErr;
        }
      }
    }
    this.prepareRunAdmission(tx, run, current, exists, lockKey);
    if (run.Status === "queued") {
      const queueErr = tx.Model(new runRow()).Where("id = ?", run.ID).Updates({ owner_instance_id: "", lease_until: null, cancel_requested: false, pause_requested: false }).Error;
      if (queueErr != null) {
        throw queueErr;
      }
    }
    const cur = { logs: 0, telemetry: 0, events: 0 };
    const rawErr = tx.Raw(`SELECT
			COALESCE((SELECT MAX(seq) FROM run_logs WHERE run_id=?), 0) AS logs,
			COALESCE((SELECT MAX(seq) FROM run_telemetry WHERE run_id=?), 0) AS telemetry,
			COALESCE((SELECT MAX(seq) FROM run_events WHERE run_id=?), -1) + 1 AS events`,
      run.ID, run.ID, run.ID).Scan(cur).Error;
    if (rawErr != null) {
      throw rawErr;
    }
    // 冲突更新时仅刷新运行头业务列；租约列、工作区绑定列由租约接口独占维护，
    // cancel_requested/pause_requested 控制位由 RequestRunControl/ClearRunControl 独占写入，避免工作线程覆盖 API 下发的取消/暂停请求。
    try {
      upsertColumns(tx, "runs", runRowValues(run), [
        "kind", "workflow_id", "status", "revision", "input", "human_context", "sandbox_id", "repository", "repositories", "snapshot",
        "execution_context", "usage_json", "tool_calls", "telemetry_sequence",
        "log_sequence", "workspace_cleaned_at", "updated_at", "admission_state", "queue_entered_at", "quota_project_id", "quota_parent_run_id", "quota_exempt", "quota_bucket",
      ]);
    } catch (upsertErr) {
      throw new Error(`runs upsert ${run.ID}: ${upsertErr}`);
    }
    // 节点表：逐个 upsert 运行下的全部节点。
    for (const [id, node] of Object.entries(run.Nodes ?? {})) {
      if (node == null) {
        continue;
      }
      upsert(tx, "run_nodes", {
        run_id: run.ID, node_id: id, status: node.Status, attempt: node.Attempt, payload: mustJSON(node),
      });
    }
    // 事件表：按序号仅追加新增事件，并在同一事务中触发通知入队。
    const events = run.Events ?? [];
    if (events.length > cur.events) {
      for (let i = cur.events; i < events.length; i++) {
        const ev = events[i];
        this.notifications.enqueueRunNotifications(tx, run, ev, i);
        upsert(tx, "run_events", {
          run_id: run.ID, seq: i, event_id: ev.ID, node_id: ev.NodeID,
          type: ev.Type, message: ev.Message, payload: mustJSON(ev), ts: timePtr(ev.Timestamp),
        });
      }
    }
    for (const ev of run.Telemetry ?? []) {
      if (ev.Sequence === 0 || ev.Sequence <= cur.telemetry) {
        continue;
      }
      upsert(tx, "run_telemetry", {
        run_id: run.ID, seq: ev.Sequence, payload: mustJSON(ev),
      });
    }
    for (const rec of run.Logs ?? []) {
      if (rec.Sequence === 0 || rec.Sequence <= cur.logs) {
        continue;
      }
      upsert(tx, "run_logs", {
        run_id: run.ID, seq: rec.Sequence, payload: mustJSON(rec),
      });
    }
    for (const art of run.Artifacts ?? []) {
      let id = art.ID;
      if (id === "") {
        id = `${run.ID}-${art.NodeID}-${art.Attempt}-${art.Name}`;
      }
      upsert(tx, "run_artifacts", {
        id: id, run_id: run.ID, node_id: art.NodeID, attempt: art.Attempt,
        name: art.Name, path: art.Path, media_type: art.MediaType,
        size_bytes: art.Size, sha256: art.SHA256, repository_dir: art.RepositoryDir,
        content: art.Content, created_at: timePtr(art.CreatedAt),
      });
    }
  }, ...(opts ?? []));
};

/**
 * 删除已结束的运行及其全部子表记录（节点、事件、遥测、日志、产物、评估与工作区检查点）。
 * 处于 `running`、`waiting` 或 `queued` 状态的活跃运行必须先取消后才允许删除；
 * 删除只会释放名额而不申请名额，因此无需桶锁，仅靠运行行锁与状态复核防止删除中途被放行。
 *
 * @param {string} id - 待删除的运行主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 运行不存在、运行仍处于活跃/排队状态或数据库删除失败时抛出错误。
 */
RunsRepo.prototype.DeleteRun = function (id) {
  this.DB.Transaction((tx) => {
    const row = this.takeRunForUpdate(tx, id);
    if (row.Status === "running" || row.Status === "waiting" || row.Status === "queued") {
      throw new Error(`run ${id} is ${row.Status}: cancel it before deleting`);
    }
    for (const table of ["run_nodes", "run_events", "run_telemetry", "run_logs", "run_artifacts", "run_evals", "run_workspace_checkpoint_chunks", "run_workspace_checkpoints"]) {
      const deleteErr = tx.Table(table).Where("run_id = ?", id).Delete(null).Error;
      if (deleteErr != null) {
        throw new Error(`runs delete ${id}: ${deleteErr}`);
      }
    }
    const err = tx.Where("id = ?", id).Delete(new runRow()).Error;
    if (err != null) {
      throw err;
    }
  });
};

// ---------- Run leases ----------

/**
 * 在事务内对指定运行行加排他写锁（MySQL 下为 `FOR UPDATE`）并读取该行。
 * 使用场景：供 `RunsRepo` 各写事务（写入运行、租约操作、工作区编辑、检查点写入等）串行化对同一运行的并发修改。
 *
 * @param {object} tx - 当前活跃的 `gorm.DB` 事务句柄。
 * @param {string} id - 目标运行主键 ID。
 * @returns {runRow} 加锁读取到的 `runs` 表行模型。
 * @throws {Error} 记录不存在（`gorm.ErrRecordNotFound`）或数据库查询失败时抛出错误。
 */
RunsRepo.prototype.takeRunForUpdate = function (tx, id) {
  const row = new runRow();
  const err = this.locking(tx.Where("id = ?", id)).Take(row).Error;
  if (err != null) {
    throw err;
  }
  return row;
};

/**
 * 尝试为指定引擎实例获取运行的分布式执行租约，并在必要时递增执行代次（`execution_generation`）。
 * 若租约当前正由其他未过期的实例持有，则抛出 `ErrRunLeaseHeld`；代次不匹配则抛出 `ErrRunLeaseLost`。
 *
 * @param {string} runID - 运行主键 ID。
 * @param {string} instanceID - 请求租约的引擎实例 ID。
 * @param {number} generation - 调用方预期的当前执行代次。
 * @param {number} ttl - 租约有效期（毫秒数，须大于 `0`）。
 * @returns {void} 无返回值。
 * @throws {Error} 参数非法、运行不存在、状态不可租用、租约被他机持有（`ErrRunLeaseHeld`）、代次不符（`ErrRunLeaseLost`）或更新失败时抛出错误。
 */
RunsRepo.prototype.TryAcquireRunLease = function (runID, instanceID, generation, ttl) {
  if (instanceID.trim() === "" || ttl <= 0) {
    throw ErrRunLeaseLost;
  }
  this.DB.Transaction((tx) => {
    let current;
    try {
      current = this.takeRunForUpdate(tx, runID);
    } catch (err) {
      if (err === gorm.ErrRecordNotFound) {
        throw new Error("run not found");
      }
      throw err;
    }
    if (current.Status !== "running" && current.Status !== "waiting" && current.Status !== "failed" && current.Status !== "cancelled" && current.Status !== "succeeded") {
      throw new Error("run cannot be leased");
    }
    const now = new Date();
    if (current.OwnerInstanceID !== "" && current.OwnerInstanceID !== instanceID && current.LeaseUntil != null && current.LeaseUntil.getTime() > now.getTime()) {
      throw ErrRunLeaseHeld;
    }
    if (generation !== current.Generation && !(current.Generation === 0 && generation === 1)) {
      throw ErrRunLeaseLost;
    }
    let newGeneration = current.Generation;
    if (current.OwnerInstanceID === instanceID) {
      if (generation !== current.Generation) {
        throw ErrRunLeaseLost;
      }
      if (current.Status !== "running") {
        newGeneration++;
      }
    } else if (current.Generation === 0) {
      newGeneration = 1;
    } else {
      newGeneration++;
    }
    const err = tx.Model(new runRow()).Where("id = ?", runID).Updates({
      owner_instance_id: instanceID, lease_until: new Date(now.getTime() + ttl), execution_generation: newGeneration,
    }).Error;
    if (err != null) {
      throw err;
    }
  });
};

/**
 * 续期当前引擎实例持有的运行租约，要求 `owner_instance_id` 与 `execution_generation` 精确匹配。
 * 使用场景：执行引擎后台心跳定时续租。
 *
 * @param {string} runID - 运行主键 ID。
 * @param {string} instanceID - 当前持租引擎实例 ID。
 * @param {number} generation - 当前执行代次。
 * @param {number} ttl - 新的续期时长（毫秒数）。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库错误或影响行数不为 `1`（租约已丢失 `ErrRunLeaseLost`）时抛出错误。
 */
RunsRepo.prototype.RenewRunLease = function (runID, instanceID, generation, ttl) {
  const res = this.DB.Model(new runRow()).
    Where("id = ? AND owner_instance_id = ? AND execution_generation = ?", runID, instanceID, generation).
    Update("lease_until", new Date(Date.now() + ttl));
  if (res.Error != null) {
    throw res.Error;
  }
  if (res.RowsAffected !== 1) {
    throw ErrRunLeaseLost;
  }
};

/**
 * 释放当前引擎实例持有的运行租约（清空 `owner_instance_id` 与 `lease_until`）。
 * 使用场景：运行正常停机、进入等待或引擎优雅退出时主动归还租约。
 *
 * @param {string} runID - 运行主键 ID。
 * @param {string} instanceID - 当前持租引擎实例 ID。
 * @param {number} generation - 当前执行代次。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库错误或影响行数不为 `1`（租约已丢失 `ErrRunLeaseLost`）时抛出错误。
 */
RunsRepo.prototype.ReleaseRunLease = function (runID, instanceID, generation) {
  const res = this.DB.Model(new runRow()).
    Where("id = ? AND owner_instance_id = ? AND execution_generation = ?", runID, instanceID, generation).
    Updates({ owner_instance_id: "", lease_until: null });
  if (res.Error != null) {
    throw res.Error;
  }
  if (res.RowsAffected !== 1) {
    throw ErrRunLeaseLost;
  }
};

/**
 * 在租约持有者校验下为运行首次绑定工作区宿主机与根目录路径。
 * 若已绑定到相同 `(host, root)` 则幂等返回 `false`；若已绑定到其他路径则抛出 `ErrRunWorkspaceBound`。
 *
 * @param {string} runID - 运行主键 ID。
 * @param {string} instanceID - 当前持租引擎实例 ID。
 * @param {number} generation - 当前执行代次。
 * @param {string} host - 工作区所在宿主机标识。
 * @param {string} root - 工作区磁盘根目录绝对路径。
 * @returns {boolean} 本次调用新完成绑定返回 `true`，已幂等绑定到同一路径返回 `false`。
 * @throws {Error} 租约丢失（`ErrRunLeaseLost`）、工作区已被绑定到其他路径（`ErrRunWorkspaceBound`）或数据库失败时抛出错误。
 */
RunsRepo.prototype.BindRunWorkspace = function (runID, instanceID, generation, host, root) {
  let bound = false;
  this.DB.Transaction((tx) => {
    let current;
    try {
      current = this.takeRunForUpdate(tx, runID);
    } catch (takeErr) {
      if (takeErr === gorm.ErrRecordNotFound) {
        throw ErrRunLeaseLost;
      }
      throw takeErr;
    }
    if (current.OwnerInstanceID !== instanceID || current.Generation !== generation) {
      throw ErrRunLeaseLost;
    }
    if (current.WorkspaceRoot.trim() !== "") {
      if (current.WorkspaceHost === host && current.WorkspaceRoot === root) {
        bound = false;
        return;
      }
      throw ErrRunWorkspaceBound;
    }
    bound = true;
    const err = tx.Model(new runRow()).Where("id = ?", runID).Updates({
      workspace_host: host, workspace_root: root,
    }).Error;
    if (err != null) {
      throw err;
    }
  });
  return bound;
};

/**
 * 将运行的工作区绑定强制迁移至新的 `(host, root)`，仅允许当前租约持有者执行。
 * 使用场景：原绑定宿主机已不可用，需要在新机器重建检出目录并重新绑定工作区时调用。
 *
 * @param {string} runID - 运行主键 ID。
 * @param {string} instanceID - 当前持租引擎实例 ID。
 * @param {number} generation - 当前执行代次。
 * @param {string} host - 新工作区宿主机标识。
 * @param {string} root - 新工作区根目录绝对路径。
 * @returns {void} 无返回值。
 * @throws {Error} 租约丢失（`ErrRunLeaseLost`）或数据库更新失败时抛出错误。
 */
RunsRepo.prototype.RebindRunWorkspace = function (runID, instanceID, generation, host, root) {
  this.DB.Transaction((tx) => {
    let current;
    try {
      current = this.takeRunForUpdate(tx, runID);
    } catch (err) {
      if (err === gorm.ErrRecordNotFound) {
        throw ErrRunLeaseLost;
      }
      throw err;
    }
    if (current.OwnerInstanceID !== instanceID || current.Generation !== generation) {
      throw ErrRunLeaseLost;
    }
    const err = tx.Model(new runRow()).Where("id = ?", runID).Updates({
      workspace_host: host, workspace_root: root,
    }).Error;
    if (err != null) {
      throw err;
    }
  });
};

// ---------- Workflow metrics ----------

/**
 * 统计全局所有工作流的运行指标汇总。
 *
 * @returns {WorkflowMetrics[]} 按最近一次运行时间倒序排列的工作流指标数组。
 */
RunsRepo.prototype.WorkflowMetrics = function () {
  return this.WorkflowMetricsFor("");
};

/**
 * 统计指定项目（为空串时为全局）下各工作流的运行次数、成功率、闭环率、返工率、平均耗时、最近 5 次运行与节点级指标。
 * 超过 4 分钟无更新的 `running` 状态运行视为中断残留，不计入 `ActiveRuns`。
 *
 * @param {string} projectID - 可选项目过滤 ID；为空字符串时汇总全部项目。
 * @returns {WorkflowMetrics[]} 按最近一次运行时间倒序排列的工作流指标数组。
 */
RunsRepo.prototype.WorkflowMetricsFor = function (projectID) {
  const metrics = {};
  const nodeDurations = {};
  const workflowDefs = {};
  for (const workflow of this.catalog.Workflows()) {
    workflowDefs[workflow.ID] = workflow;
    metrics[workflow.ID] = new WorkflowMetrics({ WorkflowID: workflow.ID });
    nodeDurations[workflow.ID] = {};
  }
  let runs = null;
  try {
    runs = this.RunSummariesFor(new AnalyticsFilter({ ProjectID: projectID }), "");
  } catch {
    runs = null;
  }
  const list = runs ?? [];
  list.sort((a, b) => timeMs(b.CreatedAt) - timeMs(a.CreatedAt));
  const durations = {};
  const terminal = {};
  for (const run of list) {
    let m = metrics[run.WorkflowID];
    if (m == null) {
      m = new WorkflowMetrics({ WorkflowID: run.WorkflowID });
      metrics[run.WorkflowID] = m;
      nodeDurations[run.WorkflowID] = {};
    }
    m.TotalRuns++;
    m.TotalTokens += run.Usage.TotalTokens;
    m.TotalToolCalls += run.ToolCalls;
    m.TotalArtifacts += runArtifactCount(run);
    switch (run.Status) {
      case "running":
        // 超过 4 分钟没有任何进度的 running 视为中断残留，不计入「进行中」。
        if (run.UpdatedAt == null || Date.now() - run.UpdatedAt.getTime() > 4 * 60 * 1000) {
          break;
        }
        m.ActiveRuns++;
        break;
      case "waiting":
        m.WaitingRuns++;
        break;
      case "succeeded":
        m.SucceededRuns++;
        terminal[run.WorkflowID] = (terminal[run.WorkflowID] ?? 0) + 1;
        break;
      case "failed":
        m.FailedRuns++;
        terminal[run.WorkflowID] = (terminal[run.WorkflowID] ?? 0) + 1;
        break;
      case "cancelled":
        m.CancelledRuns++;
        break;
    }
    let reworks = 0;
    for (const node of Object.values(run.Nodes ?? {})) {
      reworks += node.ReworkCount;
    }
    if (reworks > 0) {
      m.ReworkedRuns++;
    }
    const duration = runDuration(run, new Date());
    if (duration > 0 && (run.Status === "succeeded" || run.Status === "failed")) {
      durations[run.WorkflowID] = (durations[run.WorkflowID] ?? 0) + duration;
    }
    if ((m.RecentRuns ?? []).length < 5) {
      m.RecentRuns = m.RecentRuns ?? [];
      m.RecentRuns.push(new RunSummary({ ID: run.ID, Status: run.Status, CreatedAt: run.CreatedAt, UpdatedAt: run.UpdatedAt, DurationMs: duration, ReworkCount: reworks, TotalTokens: run.Usage.TotalTokens, ToolCalls: run.ToolCalls, Artifacts: runArtifactCount(run) }));
    }
    if (m.LastRunAt == null) {
      m.LastRunAt = run.CreatedAt;
      m.LastRunStatus = run.Status;
    }
    accumulateNodeMetrics(m, run, workflowDefs[run.WorkflowID] ?? new WorkflowDefinition(), nodeDurations[run.WorkflowID]);
  }
  const out = [];
  for (const [id, m] of Object.entries(metrics)) {
    if (m.TotalRuns > 0) {
      m.ClosureRate = (m.SucceededRuns * 100) / m.TotalRuns;
      m.ReworkRate = (m.ReworkedRuns * 100) / m.TotalRuns;
    }
    if ((terminal[id] ?? 0) > 0) {
      m.SuccessRate = (m.SucceededRuns * 100) / terminal[id];
      m.AverageDuration = Math.trunc((durations[id] ?? 0) / terminal[id]);
    }
    for (let i = 0; i < (m.NodeMetrics ?? []).length; i++) {
      const nm = m.NodeMetrics[i];
      const completed = nm.Succeeded + nm.Failed;
      if (completed > 0) {
        nm.SuccessRate = (nm.Succeeded * 100) / completed;
        nm.AverageDuration = Math.trunc((nodeDurations[id][nm.NodeID] ?? 0) / completed);
      }
    }
    const item = new WorkflowMetrics(m);
    if (item.TotalRuns === 0) {
      item.LastRunAt = null;
      item.LastRunStatus = "";
    }
    out.push(item);
  }
  out.sort((a, b) => timeMs(b.LastRunAt) - timeMs(a.LastRunAt));
  return out;
};

/**
 * 将单次运行中各节点的执行结果累加到工作流指标 `m.NodeMetrics` 中；
 * 首次遇到的节点会按工作流定义查找名称（找不到时回退节点 ID），并按节点 ID 累计已结束节点的耗时（毫秒）。
 *
 * @param {WorkflowMetrics} m - 目标工作流指标对象（会被就地更新 `NodeMetrics`）。
 * @param {Run} run - 当前待汇总的运行记录。
 * @param {WorkflowDefinition} def - 对应的工作流定义，用于解析节点展示名。
 * @param {Object.<string, number>} durations - 按节点 ID 累计的耗时毫秒映射（会被就地累加）。
 * @returns {void} 无返回值。
 */
function accumulateNodeMetrics(m, run, def, durations) {
  const index = {};
  for (let i = 0; i < (m.NodeMetrics ?? []).length; i++) {
    index[m.NodeMetrics[i].NodeID] = i + 1;
  }
  for (const [nodeID, node] of Object.entries(run.Nodes ?? {})) {
    let pos = (index[nodeID] ?? 0) - 1;
    if (pos < 0) {
      let name = nodeID;
      for (const definition of def.Nodes ?? []) {
        if (definition.ID === nodeID) {
          name = definition.Name;
        }
      }
      m.NodeMetrics = m.NodeMetrics ?? [];
      m.NodeMetrics.push(new WorkflowNodeMetric({ NodeID: nodeID, Name: name }));
      pos = m.NodeMetrics.length - 1;
    }
    const nm = m.NodeMetrics[pos];
    if (node.Attempt > 0) {
      nm.Executions += node.Attempt;
    }
    switch (node.Status) {
      case "succeeded":
        nm.Succeeded++;
        break;
      case "failed":
        nm.Failed++;
        break;
      case "waiting_approval":
        nm.Waiting++;
        break;
    }
    nm.Reworks += node.ReworkCount;
    if (node.StartedAt != null && node.FinishedAt != null) {
      durations[nodeID] = (durations[nodeID] ?? 0) + (node.FinishedAt.getTime() - node.StartedAt.getTime());
    }
  }
}

/**
 * 执行一组加载任务并在全部结束后抛出首个遇到的错误。
 * Go 原文通过 `sync.WaitGroup` 与 goroutine 并发执行；JS 单线程环境下按序全部执行并收集错误，保持一致的错误返回顺序。
 *
 * @param {...function(): void} fns - 待执行的无参加载回调列表；失败时抛出错误。
 * @returns {void} 无返回值。
 * @throws {Error} 任一回调抛出错误时，在全部回调执行完后抛出按入参顺序出现的首个错误。
 */
function parallel(...fns) {
  const errs = new Array(fns.length).fill(null);
  for (let i = 0; i < fns.length; i++) {
    try {
      fns[i]();
    } catch (err) {
      errs[i] = err;
    }
  }
  for (const err of errs) {
    if (err != null) {
      throw err;
    }
  }
}

/**
 * 返回运行拥有的产物数量：优先使用轻量列表已填充的 `ArtifactCount`，否则回退 `Artifacts` 数组长度。
 *
 * @param {Run} run - 运行对象。
 * @returns {number} 产物数量。
 */
function runArtifactCount(run) {
  if (run.ArtifactCount > 0) {
    return run.ArtifactCount;
  }
  return (run.Artifacts ?? []).length;
}

// ---------- duration helpers ----------

/**
 * 推导运行的结束时间：终态运行优先取最晚完成的节点结束时间，依次回退 `UpdatedAt` 与当前时间 `now`；非终态直接返回 `now`。
 *
 * @param {Run} run - 运行对象。
 * @param {Date} now - 作为兜底与运行中截止基准的当前时间。
 * @returns {Date} 推导得到的结束时间对象。
 */
function runEndedAt(run, now) {
  switch (run.Status) {
    case "succeeded":
    case "failed":
    case "cancelled": {
      let end = null;
      for (const node of Object.values(run.Nodes ?? {})) {
        if (node == null || node.FinishedAt == null) {
          continue;
        }
        if (end == null || node.FinishedAt.getTime() > end.getTime()) {
          end = node.FinishedAt;
        }
      }
      if (end == null) {
        end = run.UpdatedAt;
      }
      if (end == null) {
        return now;
      }
      return end;
    }
    default:
      return now;
  }
}

/**
 * 计算运行的端到端墙钟总耗时（毫秒）：从 `CreatedAt` 到 `runEndedAt(run, now)`；时间缺失或倒挂时返回 `0`。
 *
 * @param {Run} run - 运行对象。
 * @param {Date} now - 当前基准时间。
 * @returns {number} 端到端墙钟耗时（毫秒）。
 */
function runDuration(run, now) {
  const end = runEndedAt(run, now);
  if (run.CreatedAt == null || end.getTime() < run.CreatedAt.getTime()) {
    return 0;
  }
  return end.getTime() - run.CreatedAt.getTime();
}

/**
 * 统计 SOP 节点真实执行耗时之和（不含审批、排队与恢复等待）。
 * 若运行已附带事件流算出的 `run.Timing` 则直接取 `Timing.ExecutionMs`（可覆盖重试前的历史执行）；
 * 否则对起止时间有效且非负的节点累加 `FinishedAt - StartedAt`。
 *
 * @param {Run} run - 运行对象。
 * @returns {number} 节点执行总耗时（毫秒）。
 */
function runExecutionDuration(run) {
  if (run.Timing != null) {
    return run.Timing.ExecutionMs;
  }
  let total = 0;
  for (const node of Object.values(run.Nodes ?? {})) {
    if (node == null || node.StartedAt == null || node.FinishedAt == null) {
      continue;
    }
    const elapsed = node.FinishedAt.getTime() - node.StartedAt.getTime();
    if (elapsed <= 0) {
      continue;
    }
    total += elapsed;
  }
  return total;
}

/**
 * 计算节点执行时间区间的并集总长度（毫秒），截断在运行墙钟起止范围内。
 * 与 `runExecutionDuration` 不同，并行重叠节点不会被重复计入，因此可从墙钟总耗时中扣减以估算等待时长。
 *
 * @param {Run} run - 运行对象。
 * @param {Date} now - 当前基准时间。
 * @returns {number} 节点活跃区间并集总时长（毫秒）。
 */
function runActiveDuration(run, now) {
  const wallStart = run.CreatedAt;
  const wallEnd = runEndedAt(run, now);
  if (wallStart == null || wallEnd.getTime() <= wallStart.getTime()) {
    return 0;
  }
  const intervals = [];
  for (const node of Object.values(run.Nodes ?? {})) {
    if (node == null || node.StartedAt == null || node.FinishedAt == null || node.FinishedAt.getTime() <= node.StartedAt.getTime()) {
      continue;
    }
    let start = node.StartedAt;
    let end = node.FinishedAt;
    if (start.getTime() < wallStart.getTime()) {
      start = wallStart;
    }
    if (end.getTime() > wallEnd.getTime()) {
      end = wallEnd;
    }
    if (end.getTime() > start.getTime()) {
      intervals.push({ start: start, end: end });
    }
  }
  if (intervals.length === 0) {
    return 0;
  }
  intervals.sort((a, b) => a.start.getTime() - b.start.getTime());
  let current = intervals[0];
  let total = 0;
  for (const next of intervals.slice(1)) {
    if (next.start.getTime() <= current.end.getTime()) {
      if (next.end.getTime() > current.end.getTime()) {
        current.end = next.end;
      }
      continue;
    }
    total += current.end.getTime() - current.start.getTime();
    current = next;
  }
  total += current.end.getTime() - current.start.getTime();
  return total;
}

/**
 * 计算运行处于等待（审批/排队/恢复间隙）的耗时（毫秒），下限为 `0`。
 * 优先取事件流计算的 `run.Timing.WaitingMs`，否则按「端到端墙钟 − 节点活跃区间并集」估算。
 *
 * @param {Run} run - 运行对象。
 * @param {Date} now - 当前基准时间。
 * @returns {number} 等待总耗时（毫秒）。
 */
function runWaitDuration(run, now) {
  if (run.Timing != null) {
    return run.Timing.WaitingMs;
  }
  const wait = runDuration(run, now) - runActiveDuration(run, now);
  if (wait < 0) {
    return 0;
  }
  return wait;
}

/**
 * 仅为运营分析候选运行批量补查冻结的工作流定义快照（每批 500 条）。
 * 普通列表路径 `RunSummaries` 刻意省略大体积 `snapshot` 列，分析视图在需要节点拓扑时再按需补查。
 *
 * @param {object} db - `gorm.DB` 数据库句柄。
 * @param {string[]} runIDs - 待查询的运行 ID 列表。
 * @returns {Object.<string, WorkflowDefinition>} `runID -> WorkflowDefinition` 映射对象。
 * @throws {Error} 数据库查询或工作流快照 JSON 解码失败时抛出错误。
 */
function queryAnalyticsWorkflowSnapshots(db, runIDs) {
  const out = {};
  const batchSize = 500;
  for (let start = 0; start < runIDs.length; start += batchSize) {
    let end = start + batchSize;
    if (end > runIDs.length) {
      end = runIDs.length;
    }
    const batch = runIDs.slice(start, end);
    const rows = [];
    const err = db.Select("id", "snapshot").Where("id IN ?", batch).Find(rows).Error;
    if (err != null) {
      throw err;
    }
    for (const row of rows) {
      const snapshot = new WorkflowDefinition();
      jsonUnmarshal(row.Snapshot, snapshot);
      out[row.ID] = snapshot;
    }
  }
  return out;
}

/**
 * 将多仓上下文列表转为持久化列值：空集合返回 `null`（写入 SQL NULL），非空集合返回 JSON `Buffer`。
 *
 * @param {Array<object> | null | undefined} repositories - 多仓上下文数组。
 * @returns {Buffer | null} 非空时返回 JSON 字节缓冲区，空集合返回 `null`。
 */
function repositoriesJSONValue(repositories) {
  if ((repositories ?? []).length === 0) {
    return null;
  }
  return jsonBytes(repositories);
}

// ---------- Run log/telemetry pages ----------

// 日志与遥测分页默认单页大小。
const defaultLogPageSize = 100;
// 日志与遥测分页允许的最大单页大小。
const maxLogPageSize = 200;

/**
 * 运行日志分页查询结果结构，携带当前页记录、运行最新日志序号与前后翻页游标。
 */
class LogPage {
  /**
   * 构造日志分页结果实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {LogRecord[]} [init.Logs=[]] - 当前页按 `Sequence` 升序排列的日志记录列表。
   * @param {number} [init.Sequence=0] - 运行头当前记录的最大日志序号。
   * @param {number} [init.NextAfter=0] - 向后增量拉取的游标（当前页末条日志序号）。
   * @param {number} [init.NextBefore=0] - 向前翻查历史的游标（当前页首条日志序号）。
   * @param {boolean} [init.HasMore=false] - 当前方向上是否还有更多日志。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Logs = init.Logs ?? [];
    this.Sequence = init.Sequence ?? 0;
    this.NextAfter = init.NextAfter ?? 0;
    this.NextBefore = init.NextBefore ?? 0;
    this.HasMore = init.HasMore ?? false;
  }
}

/**
 * 运行遥测事件分页查询结果结构，携带当前页事件、运行最新遥测序号与前后翻页游标。
 */
class TelemetryPage {
  /**
   * 构造遥测分页结果实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {TelemetryEvent[]} [init.Events=[]] - 当前页按 `Sequence` 升序排列的遥测事件列表。
   * @param {number} [init.Sequence=0] - 运行头当前记录的最大遥测序号。
   * @param {number} [init.NextAfter=0] - 向后增量拉取游标（当前页末条事件序号）。
   * @param {number} [init.NextBefore=0] - 向前翻查历史游标（当前页首条事件序号）。
   * @param {boolean} [init.HasMore=false] - 当前方向上是否还有更多事件。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Events = init.Events ?? [];
    this.Sequence = init.Sequence ?? 0;
    this.NextAfter = init.NextAfter ?? 0;
    this.NextBefore = init.NextBefore ?? 0;
    this.HasMore = init.HasMore ?? false;
  }
}

// ---------- Log pages ----------

/**
 * 按节点过滤与前后游标分页查询指定运行的日志记录。
 * MySQL 下利用生成列与 JSON 路径在数据库单条索引查询完成过滤分页；SQLite 下读全量日志并在内存中分页。
 *
 * @param {string} runID - 运行主键 ID。
 * @param {string} nodeID - 可选节点 ID 过滤；为空字符串时不过滤节点。
 * @param {number} after - 向后拉取的起始序号游标（严格大于 `after`）。
 * @param {number} before - 向前翻页的截止序号游标（严格小于 `before`）。
 * @param {boolean} afterSet - 是否启用 `after` 向后游标模式。
 * @param {boolean} beforeSet - 是否启用 `before` 向前游标模式。
 * @param {number} limit - 单页条数限制（自动约束在 `[defaultLogPageSize, maxLogPageSize]` 合理区间内）。
 * @returns {LogPage} 日志分页结果对象。
 * @throws {Error} 运行不存在或数据库查询失败时抛出错误。
 */
RunsRepo.prototype.QueryRunLogs = function (runID, nodeID, after, before, afterSet, beforeSet, limit) {
  limit = clampPageLimit(limit);
  const row = new runRow();
  if (this.DB.Select("log_sequence").Where("id = ?", runID).Take(row).Error != null) {
    throw new Error("run not found");
  }
  if (this.isMySQL()) {
    // 生产 MySQL 结合生成列与 JSON 路径过滤，保持单条索引查询。
    const [nodeWhere, nodeArgs] = this.nodeIDFilter("$.context.nodeId", nodeID);
    const [raws, hasMore] = this.queryJSONSeqPage("run_logs", runID, nodeWhere, nodeArgs, new sqlFilter(), after, before, afterSet, beforeSet, limit);
    const out = [];
    for (const raw of raws) {
      const rec = new LogRecord();
      try {
        jsonUnmarshal(raw, rec);
        out.push(rec);
      } catch {
        // 跳过损坏的日志 JSON。
      }
    }
    return finishLogPage(out, row.LogSequence, hasMore);
  }
  const logs = this.loadRunLogsAll(runID);
  return buildLogPage(logs, row.LogSequence, nodeID, after, before, afterSet, beforeSet, limit);
};

// 单次导出日志的最大条数上限，避免超大日志占满内存。
const maxLogDump = 20000;

/**
 * 循环翻页拉取指定运行（及可选节点）的日志记录，最多导出 `maxLogDump` 条。
 * 使用场景：日志下载接口或诊断工具导出运行日志。
 *
 * @param {string} runID - 运行主键 ID。
 * @param {string} nodeID - 可选节点 ID 过滤；为空串时导出全部节点日志。
 * @returns {LogRecord[]} 按序号升序排列的日志记录数组（长度不超过 `maxLogDump`）。
 * @throws {Error} 运行不存在或分页查询失败时抛出错误。
 */
RunsRepo.prototype.DumpRunLogs = function (runID, nodeID) {
  let all = [];
  let after = 0;
  for (;;) {
    const page = this.QueryRunLogs(runID, nodeID, after, 0, true, false, maxLogPageSize);
    all.push(...page.Logs);
    if (!page.HasMore || page.Logs.length === 0 || all.length >= maxLogDump) {
      break;
    }
    if (page.NextAfter <= after) {
      break;
    }
    after = page.NextAfter;
  }
  if (all.length > maxLogDump) {
    all = all.slice(0, maxLogDump);
  }
  return all;
};

// ---------- Telemetry pages ----------

/**
 * 按节点、遥测适配器来源与前后游标分页查询指定运行的遥测事件。
 * MySQL 下在数据库层利用 JSON 路径与 `adapter` 生成列完成过滤分页；SQLite 下读全量后在内存过滤分页。
 *
 * @param {string} runID - 运行主键 ID。
 * @param {string} nodeID - 可选节点 ID 过滤；为空串时不过滤。
 * @param {string} adapter - 可选适配器过滤（`""`/`"all"`/`"hooks"`/`"otel"`/`"live"` 或具体适配器名）。
 * @param {number} after - 向后拉取游标（严格大于 `after`）。
 * @param {number} before - 向前翻页游标（严格小于 `before`）。
 * @param {boolean} afterSet - 是否启用 `after` 模式。
 * @param {boolean} beforeSet - 是否启用 `before` 模式。
 * @param {number} limit - 单页条数限制。
 * @returns {TelemetryPage} 遥测分页结果对象。
 * @throws {Error} 运行不存在或数据库查询失败时抛出错误。
 */
RunsRepo.prototype.QueryRunTelemetry = function (runID, nodeID, adapter, after, before, afterSet, beforeSet, limit) {
  limit = clampPageLimit(limit);
  const row = new runRow();
  if (this.DB.Select("telemetry_sequence").Where("id = ?", runID).Take(row).Error != null) {
    throw new Error("run not found");
  }
  if (this.isMySQL()) {
    const [nodeWhere, nodeArgs] = this.nodeIDFilter("$.nodeId", nodeID);
    const adapterFilter = adapterSQLFilter(adapter);
    const [raws, hasMore] = this.queryJSONSeqPage("run_telemetry", runID, nodeWhere, nodeArgs, adapterFilter, after, before, afterSet, beforeSet, limit);
    const out = [];
    for (const raw of raws) {
      const rec = new TelemetryEvent();
      try {
        jsonUnmarshal(raw, rec);
        out.push(rec);
      } catch {
        // 跳过损坏的遥测 JSON。
      }
    }
    return finishTelemetryPage(out, row.TelemetrySequence, hasMore);
  }
  const events = this.loadRunTelemetryAll(runID);
  return buildTelemetryPage(events, row.TelemetrySequence, nodeID, adapter, after, before, afterSet, beforeSet, limit);
};

/**
 * 根据当前数据库方言构造针对 `payload` 指定 JSON 路径匹配 `nodeID` 的 SQL 条件与绑定参数。
 *
 * @param {string} path - JSON 路径（如 `"$.context.nodeId"` 或 `"$.nodeId"`）。
 * @param {string} nodeID - 目标节点 ID；为空串时返回空条件。
 * @returns {[string, Array<*> | null]} 二元组 `[SQL WHERE 片段, 绑定参数数组]`。
 */
RunsRepo.prototype.nodeIDFilter = function (path, nodeID) {
  if (nodeID === "") {
    return ["", null];
  }
  return [this.sqlJSONText(path) + " = ?", [path, nodeID]];
};

/**
 * 封装附加 SQL `WHERE` 子句与对应绑定参数的内部过滤结构。
 */
class sqlFilter {
  /**
   * 构造 SQL 过滤片段对象，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.clause=""] - 以 `" AND ..."` 开头的 SQL 过滤子句。
   * @param {Array<*>} [init.args=[]] - 绑定到子句占位符的参数列表。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.clause = init.clause ?? "";
    this.args = init.args ?? [];
  }
}

/**
 * 根据适配器筛选关键字构造基于 MySQL 生成列 `adapter` 的 SQL 过滤片段。
 *
 * @param {string} adapter - 适配器筛选值（`""`/`"all"`/`"hooks"`/`"otel"`/`"live"` 或具体适配器名）。
 * @returns {sqlFilter} 对应的 SQL 子句与绑定参数对象。
 */
function adapterSQLFilter(adapter) {
  const obs = observabilityHooks();
  const trimmed = adapter.trim();
  switch (trimmed) {
    case "":
    case "all":
      return new sqlFilter();
    case "hooks":
      return new sqlFilter({ clause: " AND adapter IN (?, ?)", args: [obs.AdapterHooks, obs.AdapterLegacyHooks] });
    case "otel":
      return new sqlFilter({ clause: " AND adapter IN (?, ?)", args: [obs.AdapterOTEL, obs.AdapterLegacyOTEL] });
    case "live":
      return new sqlFilter({ clause: " AND adapter NOT IN (?, ?, ?, ?)", args: [obs.AdapterHooks, obs.AdapterLegacyHooks, obs.AdapterOTEL, obs.AdapterLegacyOTEL] });
    default:
      return new sqlFilter({ clause: " AND adapter=?", args: [trimmed] });
  }
}

/**
 * 在 MySQL 下对按 `seq` 排序的 JSON 载荷表执行游标分页查询（多查 1 条判断 `hasMore`，倒序查询结果翻转为升序）。
 *
 * @param {string} table - 物理表名（`"run_logs"` 或 `"run_telemetry"`）。
 * @param {string} runID - 运行主键 ID。
 * @param {string} nodeWhere - 可选节点过滤 SQL 片段。
 * @param {Array<*> | null} nodeArgs - `nodeWhere` 对应的绑定参数。
 * @param {sqlFilter} extra - 附加 SQL 过滤条件（如遥测适配器过滤）。
 * @param {number} after - 向后游标序号。
 * @param {number} before - 向前游标序号。
 * @param {boolean} afterSet - 是否启用 `after` 模式。
 * @param {boolean} beforeSet - 是否启用 `before` 模式。
 * @param {number} limit - 单页返回上限。
 * @returns {[Array<Buffer|string>, boolean]} 二元组 `[按 seq 升序排列的原始载荷数组, 是否还有更多记录]`。
 * @throws {Error} 原生 SQL 查询失败时抛出错误。
 */
RunsRepo.prototype.queryJSONSeqPage = function (table, runID, nodeWhere, nodeArgs, extra, after, before, afterSet, beforeSet, limit) {
  let sql = `SELECT payload FROM ${table} WHERE run_id=?`;
  const args = [runID];
  if (nodeWhere !== "") {
    sql += " AND " + nodeWhere;
    args.push(...nodeArgs);
  }
  if (extra.clause !== "") {
    sql += extra.clause;
    args.push(...extra.args);
  }
  let order = "ASC";
  if (afterSet) {
    sql += " AND seq>?";
    args.push(after);
  } else {
    if (beforeSet && before > 0) {
      sql += " AND seq<?";
      args.push(before);
    }
    order = "DESC";
  }
  sql += ` ORDER BY seq ${order} LIMIT ?`;
  args.push(limit + 1);
  const raws = [];
  const err = this.DB.Raw(sql, ...args).Scan(raws).Error;
  if (err != null) {
    throw err;
  }
  const hasMore = raws.length > limit;
  if (hasMore) {
    raws.length = limit;
  }
  if (order === "DESC") {
    raws.reverse();
  }
  return [raws, hasMore];
};

/**
 * 读取指定运行的全部日志记录并按 `seq` 升序解码返回（供非 MySQL 方言的内存分页路径使用）。
 *
 * @param {string} runID - 运行主键 ID。
 * @returns {LogRecord[]} 日志记录数组。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
RunsRepo.prototype.loadRunLogsAll = function (runID) {
  const rows = [];
  const err = this.DB.Where("run_id = ?", runID).Order("seq").Find(rows).Error;
  if (err != null) {
    throw err;
  }
  const out = [];
  for (const row of rows) {
    const rec = new LogRecord();
    try {
      jsonUnmarshal(row.Payload, rec);
      out.push(rec);
    } catch {
      // 跳过损坏的日志 JSON。
    }
  }
  return out;
};

/**
 * 读取指定运行的全部遥测事件并按 `seq` 升序解码返回（供非 MySQL 方言的内存分页路径使用）。
 *
 * @param {string} runID - 运行主键 ID。
 * @returns {TelemetryEvent[]} 遥测事件数组。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
RunsRepo.prototype.loadRunTelemetryAll = function (runID) {
  const rows = [];
  const err = this.DB.Where("run_id = ?", runID).Order("seq").Find(rows).Error;
  if (err != null) {
    throw err;
  }
  const out = [];
  for (const row of rows) {
    const rec = new TelemetryEvent();
    try {
      jsonUnmarshal(row.Payload, rec);
      out.push(rec);
    } catch {
      // 跳过损坏的遥测 JSON。
    }
  }
  return out;
};

// ---------- Shared paging helpers ----------

/**
 * 将请求的分页条数钳制到合法范围：小于等于 `0` 使用 `defaultLogPageSize`，超过 `maxLogPageSize` 则截断为上限。
 *
 * @param {number} limit - 调用方传入的分页条数。
 * @returns {number} 规范化后的分页条数。
 */
function clampPageLimit(limit) {
  if (limit <= 0) {
    return defaultLogPageSize;
  }
  if (limit > maxLogPageSize) {
    return maxLogPageSize;
  }
  return limit;
}

/**
 * 在内存中对日志列表按节点过滤、按序号稳定排序并应用游标分页，组装为 `LogPage`。
 *
 * @param {LogRecord[]} logs - 全量日志列表。
 * @param {number} seq - 运行头当前最大日志序号。
 * @param {string} nodeID - 可选节点 ID 过滤。
 * @param {number} after - 向后游标序号。
 * @param {number} before - 向前游标序号。
 * @param {boolean} afterSet - 是否启用 `after` 模式。
 * @param {boolean} beforeSet - 是否启用 `before` 模式。
 * @param {number} limit - 单页条数上限。
 * @returns {LogPage} 组装完成的日志分页结果。
 */
function buildLogPage(logs, seq, nodeID, after, before, afterSet, beforeSet, limit) {
  const filtered = [];
  for (const rec of logs) {
    if (nodeID !== "" && rec.Context.NodeID !== nodeID) {
      continue;
    }
    filtered.push(rec);
  }
  sortSliceStable(filtered, (a, b) => a.Sequence < b.Sequence);
  const [page, hasMore] = pageByCursor(filtered.length, after, before, afterSet, beforeSet, limit, (i) => filtered[i].Sequence);
  const out = [];
  for (const i of page ?? []) {
    out.push(filtered[i]);
  }
  return finishLogPage(out, seq, hasMore);
}

/**
 * 在内存中对遥测事件列表按节点与适配器过滤、按序号稳定排序并应用游标分页，组装为 `TelemetryPage`。
 *
 * @param {TelemetryEvent[]} events - 全量遥测事件列表。
 * @param {number} seq - 运行头当前最大遥测序号。
 * @param {string} nodeID - 可选节点 ID 过滤。
 * @param {string} adapter - 可选适配器筛选值。
 * @param {number} after - 向后游标序号。
 * @param {number} before - 向前游标序号。
 * @param {boolean} afterSet - 是否启用 `after` 模式。
 * @param {boolean} beforeSet - 是否启用 `before` 模式。
 * @param {number} limit - 单页条数上限。
 * @returns {TelemetryPage} 组装完成的遥测分页结果。
 */
function buildTelemetryPage(events, seq, nodeID, adapter, after, before, afterSet, beforeSet, limit) {
  const filtered = [];
  for (const rec of events) {
    if (nodeID !== "" && rec.NodeID !== nodeID) {
      continue;
    }
    if (!observabilityHooks().MatchAdapter(rec, adapter)) {
      continue;
    }
    filtered.push(rec);
  }
  sortSliceStable(filtered, (a, b) => a.Sequence < b.Sequence);
  const [page, hasMore] = pageByCursor(filtered.length, after, before, afterSet, beforeSet, limit, (i) => filtered[i].Sequence);
  const out = [];
  for (const i of page ?? []) {
    out.push(filtered[i]);
  }
  return finishTelemetryPage(out, seq, hasMore);
}

/**
 * 通用有序数组游标分页算法：根据 `after`/`before` 模式筛选命中的索引切片并判断是否还有更多数据。
 * 向前翻页模式扫描时从尾部倒扫，返回前翻转回升序。
 *
 * @param {number} n - 已排序序列的总长度。
 * @param {number} after - 向后游标值（严格大于）。
 * @param {number} before - 向前游标值（严格小于）。
 * @param {boolean} afterSet - 是否启用向后拉取模式。
 * @param {boolean} beforeSet - 是否启用向前翻页模式。
 * @param {number} limit - 单页最大条数。
 * @param {function(number): number} seqAt - 按下标读取元素序号的访问器函数。
 * @returns {[number[] | null, boolean]} 二元组 `[命中的升序下标数组, 是否还有更多元素]`；序列为空时返回 `[null, false]`。
 */
function pageByCursor(n, after, before, afterSet, beforeSet, limit, seqAt) {
  if (n === 0) {
    return [null, false];
  }
  if (afterSet) {
    const idx = [];
    for (let i = 0; i < n; i++) {
      if (seqAt(i) <= after) {
        continue;
      }
      idx.push(i);
      if (idx.length === limit + 1) {
        break;
      }
    }
    const hasMore = idx.length > limit;
    if (hasMore) {
      idx.length = limit;
    }
    return [idx, hasMore];
  }
  const idx = [];
  for (let i = n - 1; i >= 0; i--) {
    if (beforeSet && before > 0 && seqAt(i) >= before) {
      continue;
    }
    idx.push(i);
    if (idx.length === limit + 1) {
      break;
    }
  }
  const hasMore = idx.length > limit;
  if (hasMore) {
    idx.length = limit;
  }
  idx.reverse();
  return [idx, hasMore];
}

/**
 * 根据当前页日志列表补全 `NextAfter` 与 `NextBefore` 游标并构建 `LogPage`。
 *
 * @param {LogRecord[]} logs - 当前页日志列表（升序）。
 * @param {number} seq - 运行头当前最大日志序号。
 * @param {boolean} hasMore - 是否还有更多数据。
 * @returns {LogPage} 构建好的日志分页结果。
 */
function finishLogPage(logs, seq, hasMore) {
  const page = new LogPage({ Logs: logs, Sequence: seq, HasMore: hasMore });
  if (logs.length > 0) {
    page.NextAfter = logs[logs.length - 1].Sequence;
    page.NextBefore = logs[0].Sequence;
  }
  return page;
}

/**
 * 根据当前页遥测事件列表补全 `NextAfter` 与 `NextBefore` 游标并构建 `TelemetryPage`。
 *
 * @param {TelemetryEvent[]} events - 当前页遥测事件列表（升序）。
 * @param {number} seq - 运行头当前最大遥测序号。
 * @param {boolean} hasMore - 是否还有更多数据。
 * @returns {TelemetryPage} 构建好的遥测分页结果。
 */
function finishTelemetryPage(events, seq, hasMore) {
  const page = new TelemetryPage({ Events: events, Sequence: seq, HasMore: hasMore });
  if (events.length > 0) {
    page.NextAfter = events[events.length - 1].Sequence;
    page.NextBefore = events[0].Sequence;
  }
  return page;
}

/**
 * 持久化标记活跃运行（`running` 或 `waiting`）请求取消，以便任意观察到心跳的工作实例将其终止结算。
 *
 * @param {string} id - 运行主键 ID。
 * @returns {Run} 更新控制位并递增修订号后的运行头对象。
 * @throws {Error} 运行不存在、运行已非活跃状态或数据库更新失败时抛出错误。
 */
RunsRepo.prototype.RequestRunCancel = function (id) {
  return this.requestRunControl(id, true, false);
};

/**
 * 持久化标记活跃运行（`running` 或 `waiting`）请求暂停。
 *
 * @param {string} id - 运行主键 ID。
 * @returns {Run} 更新控制位并递增修订号后的运行头对象。
 * @throws {Error} 运行不存在、运行已非活跃状态或数据库更新失败时抛出错误。
 */
RunsRepo.prototype.RequestRunPause = function (id) {
  return this.requestRunControl(id, false, true);
};

/**
 * 仅读取运行的持久化取消/暂停控制位。
 * 使用场景：工作线程作为租约心跳兜底检查并过滤无关中断信号。
 *
 * @param {string} id - 运行主键 ID。
 * @returns {boolean} `cancel_requested` 或 `pause_requested` 任一为 `true` 时返回 `true`，否则返回 `false`。
 */
RunsRepo.prototype.RunControlRequested = function (id) {
  const flags = { CancelRequested: false, PauseRequested: false };
  if (this.DB.Model(new runRow()).Select("cancel_requested", "pause_requested").Where("id = ?", id).Take(flags).Error != null) {
    return false;
  }
  return flags.CancelRequested || flags.PauseRequested;
};

/**
 * 在运行行锁事务中清除待处理的取消/暂停标记以及残留的工作区编辑租约列。
 * 使用场景：运行持有实例已感知并处理控制请求后调用。
 *
 * @param {string} id - 运行主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 运行不存在或数据库更新失败时抛出错误。
 */
RunsRepo.prototype.ClearRunControl = function (id) {
  this.DB.Transaction((tx) => {
    try {
      this.takeRunForUpdate(tx, id);
    } catch (err) {
      if (err === gorm.ErrRecordNotFound) {
        throw new Error("run not found");
      }
      throw err;
    }
    const err = tx.Model(new runRow()).Where("id = ?", id).Updates({
      cancel_requested: false, pause_requested: false,
      workspace_editor_id: 0, workspace_edit_until: null,
    }).Error;
    if (err != null) {
      throw err;
    }
  });
};

/**
 * 内部通用的运行控制位写入方法：仅当运行处于 `running` 或 `waiting` 状态时更新取消/暂停标记并递增修订号。
 *
 * @param {string} id - 运行主键 ID。
 * @param {boolean} cancelRequested - 目标取消标记值。
 * @param {boolean} pauseRequested - 目标暂停标记值。
 * @returns {Run} 更新后的运行头对象。
 * @throws {Error} 数据库更新出错、运行不存在或运行不处于活跃状态时抛出错误。
 */
RunsRepo.prototype.requestRunControl = function (id, cancelRequested, pauseRequested) {
  const now = new Date();
  const allowed = "status IN ('running', 'waiting')";
  const res = this.DB.Model(new runRow()).Where("id = ? AND " + allowed, id).Updates({
    cancel_requested: cancelRequested,
    pause_requested: pauseRequested,
    revision: new clause.Expr({ SQL: "revision + 1" }),
    updated_at: now,
  });
  if (res.Error != null) {
    throw new Error(`request run control: ${res.Error}`);
  }
  if (res.RowsAffected === 0) {
    const [, ok] = takeRun(this.DB, id);
    if (!ok) {
      throw new Error("run not found");
    }
    throw new Error("run is not active");
  }
  const [row, ok] = takeRun(this.DB, id);
  if (!ok) {
    throw new Error("run not found");
  }
  return runFromRow(row);
};

/**
 * 对数组执行原地稳定插入排序（与 Go 原文泛型 `sortSliceStable` 保持 1:1 算法实现）。
 *
 * @template T
 * @param {T[]} values - 待排序的数组（会被原地修改）。
 * @param {function(T, T): boolean} less - 严格小于比较函数，返回 `true` 表示前者应排在后者之前。
 * @returns {void} 无返回值。
 */
function sortSliceStable(values, less) {
  for (let i = 1; i < values.length; i++) {
    for (let j = i; j > 0 && less(values[j], values[j - 1]); j--) {
      [values[j], values[j - 1]] = [values[j - 1], values[j]];
    }
  }
}

/**
 * 带期望修订号乐观锁的运行写入方法，保护交互卡片决策提交不被并发 API 或工作线程写入覆盖。
 * 控制位会在同一受保护事务中一并清除。
 *
 * @param {Run} v - 待写入的运行对象。
 * @param {number} revision - 写入前期望的数据库当前修订号。
 * @returns {void} 无返回值。
 * @throws {Error} 修订号已变化（`ErrRunDecisionStale`）、租约丢失或数据库事务失败时抛出错误。
 */
RunsRepo.prototype.PutRunAtRevision = function (v, revision) {
  v.UpdatedAt = new Date();
  v.Revision++;
  this.writeRun(v, revision);
};

module.exports = { defaultLogPageSize, maxLogPageSize, maxLogDump, LogPage, TelemetryPage, sqlFilter, runFromRow, runRowValues, takeRun, accumulateNodeMetrics, parallel, runArtifactCount, runEndedAt, runDuration, runExecutionDuration, runActiveDuration, runWaitDuration, queryAnalyticsWorkflowSnapshots, repositoriesJSONValue, summarizeNode, artifactFromRow, adapterSQLFilter, clampPageLimit, buildLogPage, buildTelemetryPage, pageByCursor, finishLogPage, finishTelemetryPage, sortSliceStable };
