// runs.js —— 对应 Go 文件：internal/repo/runs.go
// 作用：运行读写：运行头映射、列表摘要、租约、工作区绑定、指标与日志/遥测分页。

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

// Go 的 time.Time 零值译为 null；timeMs 把 null 换算为 Go 零值时间的毫秒数。
function timeMs(t) {
  return t == null ? -62135596800000 : t.getTime();
}

// 与 run_admission.js、analytics.js 循环引用，调用时现取。
function runAdmissionBucketKey(run) {
  return require("./run_admission.js").runAdmissionBucketKey(run);
}
function lockAdmissionGate(d, tx, key) {
  return require("./run_admission.js").lockAdmissionGate(d, tx, key);
}
function admissionLockRequired() {
  return require("./run_admission.js").admissionLockRequired;
}
function analyticsRunInWindow(run, filter) {
  return require("./analytics.js").analyticsRunInWindow(run, filter);
}
function analyticsRunMatchesUser(run, userID, issue) {
  return require("./analytics.js").analyticsRunMatchesUser(run, userID, issue);
}

// keepConversationRunFields 在 runs_conversation.js 中定义，该文件尚未翻译，调用时现取。
function keepConversationRunFields(run, current) {
  return require("./runs_conversation.js").keepConversationRunFields(run, current);
}

// observability 尚未翻译，调用时现取。
function observabilityHooks() {
  return require("../observability/hooks.js");
}

// ---------- Run header mapping ----------

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
  jsonUnmarshal(row.Repository, run.Repository);
  if (row.Repositories != null && row.Repositories.length > 0) {
    jsonUnmarshal(row.Repositories, run.Repositories);
  }
  jsonUnmarshal(row.Snapshot, run.WorkflowSnapshot);
  jsonUnmarshal(row.ExecutionContext, run.ExecutionContext);
  jsonUnmarshal(row.UsageJSON, run.Usage);
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

function runRowValues(run) {
  return {
    id: run.ID, kind: run.Kind, workflow_id: run.WorkflowID, status: run.Status, revision: run.Revision,
    input: run.Input, human_context: run.HumanContext,
    quota_project_id: run.ExecutionContext.ProjectID.trim(), quota_parent_run_id: run.ExecutionContext.ParentRunID.trim(),
    quota_exempt: run.ConcurrencyExempt, admission_state: run.AdmissionState, queue_entered_at: timePtr(run.QueueEnteredAt),
    quota_bucket: runAdmissionBucketKey(run),
    cancel_requested: run.CancelRequested, pause_requested: run.PauseRequested, sandbox_id: run.SandboxID,
    repository: jsonBytes(run.Repository),
    // master 的 repositoriesJSON：空集合写 SQL NULL 而不是 '[]'。
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

function takeRun(db, id) {
  const row = new runRow();
  if (db.Where("id = ?", id).Take(row).Error != null) {
    return [new runRow(), false];
  }
  return [row, true];
}

// ---------- Reads ----------

RunsRepo.prototype.Runs = function () {
  const rows = [];
  if (this.DB.Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const run = runFromRow(row);
    if (this.loadRunNodes(run) != null) {
      continue;
    }
    if (this.loadArtifactMeta(run) != null) {
      continue;
    }
    out.push(run);
  }
  out.sort((a, b) => timeMs(b.CreatedAt) - timeMs(a.CreatedAt));
  return out;
};

// RunSummaries returns list-safe Run data. The database removes large node
// output and workflow snapshots before transfer instead of loading them just to
// discard them in the HTTP layer.
RunsRepo.prototype.RunSummaries = function () {
  return this.RunSummariesFor(new AnalyticsFilter(), "");
};

// RunSummariesFor filters headers before loading child rows. Project fallback
// uses the same Go normalization as legacy runs, without hydrating issue payloads.
RunsRepo.prototype.RunSummariesFor = function (filter, issueID) {
  const [runs, , err] = this.runSummariesFor(filter, issueID);
  return [runs, err];
};

// RunSummariesWithEventsFor returns list-safe summaries together with the timing
// events already read to compute each Run.Timing. Callers that need both (the
// business-domain report) can therefore scan runs, run_nodes and run_events once
// instead of twice; the rows and projections are identical to RunSummariesFor.
RunsRepo.prototype.RunSummariesWithEventsFor = function (filter, issueID) {
  return this.runSummariesFor(filter, issueID);
};

RunsRepo.prototype.runSummariesFor = function (filter, issueID) {
  if (filter.ProjectIDs != null && filter.ProjectIDs.length === 0) {
    return [[], null, null];
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
    // Keep legacy rows with an empty project stamp; FilterRunsByProject
    // still resolves those through the linked issue.
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
  // 与 master 的 runSummaryHeaderColumns 一致：列表携带控制位与
  // human_context、多仓 repositories，且 input 在 SQL 层截断到 500 字符
  //（master 用 LEFT(input, 500)，使 handler 的 clip 不再追加省略号）。
  // List rows only need the frozen SOP identity and whether it is a free
  // collaboration task (待我确认 and status badges depend on it). The graph,
  // scripts, and commands stay in the snapshot column and are not transferred.
  let snapshotExpr = "json_object('id', json_extract(snapshot, '$.id'), 'name', json_extract(snapshot, '$.name'), 'collaborationMode', json_extract(snapshot, '$.collaborationMode')) AS snapshot";
  if (this.isMySQL()) {
    snapshotExpr = "JSON_OBJECT('id', JSON_UNQUOTE(JSON_EXTRACT(snapshot, '$.id')), 'name', JSON_UNQUOTE(JSON_EXTRACT(snapshot, '$.name')), 'collaborationMode', JSON_UNQUOTE(JSON_EXTRACT(snapshot, '$.collaborationMode'))) AS snapshot";
  }
  const findErr = q.Select("id", "kind", "workflow_id", "status", "admission_state", "queue_entered_at", "quota_exempt", "cancel_requested", "pause_requested", "human_context", "revision", "SUBSTR(input, 1, 500) AS input", "repository", "repositories", snapshotExpr, "execution_context", "usage_json", "tool_calls", "telemetry_sequence", "log_sequence", "owner_instance_id", "lease_until", "execution_generation", "workspace_host", "workspace_root", "workspace_cleaned_at", "created_at", "updated_at").
    Order("created_at DESC, id DESC").
    Find(rows).Error;
  if (findErr != null) {
    return [null, null, findErr];
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
      return [[], null, null];
    }
    return [null, null, null];
  }
  const [nodes, nodesErr] = this.runNodeSummaries(ids);
  if (nodesErr != null) {
    return [null, null, nodesErr];
  }
  const [artifactCounts, countsErr] = this.artifactCounts(ids);
  if (countsErr != null) {
    return [null, null, countsErr];
  }
  const [timingEvents, timingErr] = this.runTimingEvents(ids);
  if (timingErr != null) {
    return [null, null, timingErr];
  }
  const now = new Date();
  const out = [];
  for (const run of candidates) {
    // Keep only the summary fields of each node (drop heavy output).
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
    // 与 master 的 database/sql 实现保持同一 wire 行为：空结果序列化为
    // null 而非 []（nil slice 语义）。
    return [null, null, null];
  }
  return [out, timingEvents, null];
};

// RunStatuses returns only the fields needed to reconcile task state. It keeps
// list endpoints away from Run events, telemetry, logs, artifacts and nodes.
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

// ReadRunStatus reads a single run without loading its graph or event history.
RunsRepo.prototype.ReadRunStatus = function (ctx, id) {
  const row = new runRow();
  const err = this.DB.WithContext(ctx).Select("status").Where("id = ?", id).Take(row).Error;
  if (err === gorm.ErrRecordNotFound) {
    return ["", false, null];
  }
  return [row.Status, err == null, err];
};

// RunsWithActiveNodes reports runs that still have running or pending_input nodes.
// Used by task reconciliation without hydrating full run views.
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

RunsRepo.prototype.Run = function (id) {
  const [row, ok] = takeRun(this.DB, id);
  if (!ok) {
    return [new Run(), false];
  }
  const run = runFromRow(row);
  if (this.loadRunNodes(run) != null) {
    return [new Run(), false];
  }
  if (this.loadRunHeavy(run) != null) {
    return [new Run(), false];
  }
  return [run, true];
};

// RunHeader reads identity and execution scope without loading the snapshot,
// nodes, events or artifacts. A missing run is returned as an empty header.
RunsRepo.prototype.RunHeader = function (id) {
  const row = new runRow();
  const err = this.DB.Select("id", "kind", "workflow_id", "execution_context").Where("id = ?", id).Take(row).Error;
  if (err === gorm.ErrRecordNotFound) {
    return [new Run(), null];
  }
  return [runFromRow(row), err];
};

// RunWorkflowProjectID reads the frozen project association without loading
// the workflow graph or execution data.
RunsRepo.prototype.RunWorkflowProjectID = function (id) {
  let project = "JSON_EXTRACT(snapshot, '$.projectId')";
  if (this.isMySQL()) {
    project = "JSON_UNQUOTE(" + project + ")";
  }
  const row = { ProjectID: "" };
  const err = this.DB.Table("runs").Select(project + " AS project_id").Where("id = ?", id).Scan(row).Error;
  return [row.ProjectID.trim(), err];
};

// RunState returns the durable aggregate needed by the execution engine.
// Worker logs are append-only and are never read by engine decisions, so
// loading the entire log history on every state transition only makes long
// runs progressively slower.
RunsRepo.prototype.RunState = function (id) {
  const [row, ok] = takeRun(this.DB, id);
  if (!ok) {
    return [new Run(), false];
  }
  const run = runFromRow(row);
  if (this.loadRunNodes(run) != null) {
    return [new Run(), false];
  }
  // Engine decisions only need nodes, events and artifacts. Loading thousands
  // of historical telemetry rows on every lease/heartbeat-adjacent state read
  // made long SOP runs miss their 30s lease: finishAt then refused to persist
  // succeeded, and ResumeInterruptedRuns parked a completed graph forever.
  // Live telemetry still lands through the observation queue (sequence comes
  // from the header); the paginated API keeps the history.
  const eventRows = [];
  if (this.DB.Where("run_id = ?", run.ID).Order("seq").Find(eventRows).Error != null) {
    return [new Run(), false];
  }
  for (const eventRow of eventRows) {
    const ev = new RunEvent();
    if (jsonUnmarshal(eventRow.Payload, ev) == null) {
      run.Events.push(ev);
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

// RunView returns header/nodes/artifacts for the UI without hydrating logs.
RunsRepo.prototype.RunView = function (id) {
  const [row, ok] = takeRun(this.DB, id);
  if (!ok) {
    return [new Run(), false];
  }
  const run = runFromRow(row);
  if (this.loadRunNodesFrom(this.runViewNodesQuery(), run) != null) {
    return [new Run(), false];
  }
  if (this.loadArtifactMeta(run) != null) {
    return [new Run(), false];
  }
  const [events, err] = this.runTimingEvents([run.ID]);
  if (err != null) {
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
      if (jsonUnmarshal(rows[i].Payload, event) == null) {
        run.Events.push(event);
      }
    }
  }
  return [run, true];
};

// RunStreamView matches the SSE contract, which delivers only the latest 80
// log/telemetry records and artifact metadata, never the historical bodies.
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
    if (jsonUnmarshal(logs[i].Payload, record) == null) {
      run.Logs.push(record);
    }
  }
  const events = [];
  if (this.DB.Where("run_id = ?", id).Order("seq DESC").Limit(80).Find(events).Error != null) {
    return [new Run(), false];
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = new TelemetryEvent();
    if (jsonUnmarshal(events[i].Payload, event) == null) {
      run.Telemetry.push(event);
    }
  }
  return [run, true];
};

// RunRevisions returns the current revision of every existing run in ids in
// one query; missing ids are absent from the map. nil means the query failed.
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

RunsRepo.prototype.RunRevision = function (id) {
  const row = new runRow();
  const err = this.DB.Select("revision").Where("id = ?", id).Take(row).Error;
  return [row.Revision, err == null];
};

// LiveSandboxRunIDs returns every run whose workspace has not been cleaned.
// Failed and active runs remain live; successful and cancelled workspaces are
// removed explicitly before being excluded here.
// SupersededIssueRunIDs lists settled runs of an issue that a newer dispatch
// has replaced. A failed run keeps its workspace and container only so it can
// be retried; starting the issue over withdraws that reason, and nothing else
// would ever release them.
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

RunsRepo.prototype.LiveSandboxRunIDs = function () {
  const ids = [];
  if (this.DB.Model(new runRow()).Select("id").Where("workspace_cleaned_at IS NULL").Pluck("id", ids).Error != null) {
    return null;
  }
  return ids;
};

// LiveSandboxDockerfiles returns the Dockerfiles frozen into runs that still
// own a workspace. Their images must outlive catalog edits: once an idle
// container is discarded, the retry recreates it from the same image.
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
    if (jsonUnmarshal(raw, dockerfile) == null && dockerfile.Content.trim() !== "") {
      out.push(dockerfile);
    }
  }
  return out;
};

// IdleSandboxRunIDs returns runs that keep their workspace for a retry or a
// human decision but have not changed since the given cutoffs.
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

// TerminalWorkspaceCleanupRuns returns every successful and cancelled run for
// immediate cleanup or cleanup reconciliation.
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

// RunsAwaitingBuiltPreview returns runs whose static-site build already
// succeeded and whose workspace is still on disk, but which have no preview
// row yet. The run may still be waiting on a later gate.
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

// ClaimRunWorkspaceCleanup atomically makes an expired terminal workspace
// unavailable before cleanup starts. This prevents a concurrent retry from
// reusing a directory while a local deletion or durable Runner cleanup is in
// flight.
RunsRepo.prototype.ClaimRunWorkspaceCleanup = function (runID, now) {
  const result = this.DB.Model(new runRow()).
    Where("id = ? AND status IN ? AND workspace_cleaned_at IS NULL AND (workspace_cleanup_not_before IS NULL OR workspace_cleanup_not_before <= ?)",
      runID, ["succeeded", "cancelled"], now).
    Updates({ workspace_cleaned_at: now, sandbox_id: "" });
  return [result.RowsAffected === 1, result.Error];
};

// ResetRunWorkspaceCleanup makes a claimed workspace eligible for a later
// sweep when cleanup could not be safely scheduled or completed.
RunsRepo.prototype.ResetRunWorkspaceCleanup = function (runID) {
  return this.DB.Model(new runRow()).Where("id = ?", runID).Update("workspace_cleaned_at", null).Error;
};

RunsRepo.prototype.loadRunNodes = function (run) {
  return this.loadRunNodesFrom(this.DB, run);
};

// Keep one extra character beyond each HTTP byte limit so the existing
// clipRunText still decides whether to append an ellipsis, including UTF-8.
// Engine state reads retain the complete payload through loadRunNodes.
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

RunsRepo.prototype.loadRunNodesFrom = function (q, run) {
  const rows = [];
  const err = q.Where("run_id = ?", run.ID).Find(rows).Error;
  if (err != null) {
    return err;
  }
  run.Nodes = {};
  for (const row of rows) {
    const node = new NodeRun();
    if (jsonUnmarshal(row.Payload, node) != null) {
      continue;
    }
    run.Nodes[row.NodeID] = node;
  }
  return null;
};

// runNodeSummaries projects a whitelist in SQL: worker output, feedback and
// session state never cross the database connection on a summary path.
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
      return [null, err];
    }
    for (const row of rows) {
      const node = new NodeRun();
      if (jsonUnmarshal(row.Payload, node) != null) {
        continue;
      }
      const summary = summarizeNode(node, row.NodeID, row.Status, row.Attempt);
      if (byRun[row.RunID] == null) {
        byRun[row.RunID] = {};
      }
      byRun[row.RunID][row.NodeID] = summary;
    }
  }
  return [byRun, null];
};

// summarizeNode keeps only the fields a list view needs, matching the previous
// MySQL JSON_OBJECT projection (error text truncated, no worker output).
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

RunsRepo.prototype.loadRunHeavy = function (run) {
  run.Events = null;
  run.Telemetry = null;
  run.Logs = null;
  run.Artifacts = null;
  const eventRows = [];
  const eventErr = this.DB.Where("run_id = ?", run.ID).Order("seq").Find(eventRows).Error;
  if (eventErr != null) {
    return eventErr;
  }
  for (const eventRow of eventRows) {
    const ev = new RunEvent();
    if (jsonUnmarshal(eventRow.Payload, ev) == null) {
      run.Events = [...(run.Events ?? []), ev];
    }
  }
  const telemetryRows = [];
  const telemetryErr = this.DB.Where("run_id = ?", run.ID).Order("seq").Find(telemetryRows).Error;
  if (telemetryErr != null) {
    return telemetryErr;
  }
  for (const telemetryRow of telemetryRows) {
    const ev = new TelemetryEvent();
    if (jsonUnmarshal(telemetryRow.Payload, ev) == null) {
      run.Telemetry = [...(run.Telemetry ?? []), ev];
    }
  }
  const logRows = [];
  const logErr = this.DB.Where("run_id = ?", run.ID).Order("seq").Find(logRows).Error;
  if (logErr != null) {
    return logErr;
  }
  for (const logRow of logRows) {
    const rec = new LogRecord();
    if (jsonUnmarshal(logRow.Payload, rec) == null) {
      run.Logs = [...(run.Logs ?? []), rec];
    }
  }
  const artifactRows = [];
  const artifactErr = this.DB.Where("run_id = ?", run.ID).Find(artifactRows).Error;
  if (artifactErr != null) {
    return artifactErr;
  }
  for (const artifactRow of artifactRows) {
    run.Artifacts = [...(run.Artifacts ?? []), artifactFromRow(artifactRow, true)];
  }
  return null;
};

RunsRepo.prototype.loadArtifactMeta = function (run) {
  const rows = [];
  const err = this.DB.Select("id", "run_id", "node_id", "attempt", "name", "path", "media_type", "size_bytes", "sha256", "created_at").
    Where("run_id = ?", run.ID).Find(rows).Error;
  if (err != null) {
    return err;
  }
  for (const row of rows) {
    run.Artifacts.push(artifactFromRow(row, false));
  }
  run.ArtifactCount = run.Artifacts.length;
  return null;
};

RunsRepo.prototype.artifactCounts = function (ids) {
  const counts = {};
  for (let start = 0; start < ids.length; start += 500) {
    const rows = [];
    const err = this.DB.Table("run_artifacts").Select("run_id, COUNT(*) AS count").Where("run_id IN ?", ids.slice(start, Math.min(start + 500, ids.length))).Group("run_id").Scan(rows).Error;
    if (err != null) {
      return [null, err];
    }
    for (const row of rows) {
      counts[row.RunID] = row.Count;
    }
  }
  return [counts, null];
};

// runTimingEvents reads only the columns ComputeRunTiming needs. The payload
// column is skipped; run.resumed heartbeats are excluded by the type filter.
RunsRepo.prototype.runTimingEvents = function (ids) {
  const out = {};
  for (let start = 0; start < ids.length; start += 500) {
    const rows = [];
    const err = this.DB.Select("run_id", "seq", "node_id", "type", "ts").
      Where("run_id IN ? AND type IN ?", ids.slice(start, Math.min(start + 500, ids.length)), RunTimingEventTypes).
      Order("run_id, seq").Find(rows).Error;
    if (err != null) {
      return [null, err];
    }
    for (const row of rows) {
      if (row.Ts == null) {
        continue;
      }
      out[row.RunID] = out[row.RunID] ?? [];
      out[row.RunID].push(new RunEvent({ RunID: row.RunID, NodeID: row.NodeID, Type: row.Type, Timestamp: row.Ts }));
    }
  }
  return [out, null];
};

// RunProjectIDs batches authorization metadata without loading run snapshots,
// nodes, events or artifact content. Missing runs are absent from the map.
RunsRepo.prototype.RunProjectIDs = function (ids) {
  const out = {};
  const project = this.sqlExecutionContextJSONText("projectId");
  for (let start = 0; start < ids.length; start += 500) {
    const rows = [];
    const err = this.DB.Table("runs").Select("id, " + project + " AS project_id").
      Where("id IN ?", ids.slice(start, Math.min(start + 500, ids.length))).Scan(rows).Error;
    if (err != null) {
      return [null, err];
    }
    for (const row of rows) {
      out[row.ID] = row.ProjectID;
    }
  }
  return [out, null];
};

// RunExists performs a primary-key lookup without loading nodes or snapshots.
RunsRepo.prototype.RunExists = function (id) {
  const row = new runRow();
  return this.DB.Select("id").Where("id = ?", id).Take(row).Error == null;
};

// TelemetryEventExists provides the durable half of event-id idempotency.
// RunState intentionally does not hydrate telemetry, so checking only the
// in-memory aggregate would accept the same worker event after a flush.
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

RunsRepo.prototype.Artifact = function (runID, artifactID) {
  const row = new runArtifactRow();
  if (this.DB.Where("run_id = ? AND id = ?", runID, artifactID).Take(row).Error != null) {
    return [new Artifact(), false];
  }
  return [artifactFromRow(row, true), true];
};

// FilterRunsByProject keeps runs stamped with projectID, or legacy runs whose
// linked issue belongs to that project. An empty projectID returns the list
// unchanged.
RunsRepo.prototype.FilterRunsByProject = function (runs, projectID) {
  projectID = projectID.trim();
  if (projectID === "") {
    return runs;
  }
  return this.filterRunsByProjects(runs, [projectID]);
};

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

// filterRunsByResponsibleUser keeps runs whose executor or linked issue assignee matches.
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

// PutRun writes the complete current Run to the database before returning.
// There is no process-local production copy: the next read queries the
// database again.
RunsRepo.prototype.PutRun = function (v) {
  v.UpdatedAt = new Date();
  v.Revision++;
  return this.writeRun(v);
};

// writeRun persists the run header plus whatever telemetry/logs/events arrived
// since the last write. A run is the one entity written on a hot path, so the
// header and its append-only children go in a single transaction.
//
// Most writes keep or release a slot and take no admission lock. A write that
// turns out to claim one (new running run, restart of a succeeded/unstarted
// run) is rolled back and retried with its bucket locked first, so a bucket
// lock is never awaited while a run row is held.
RunsRepo.prototype.writeRun = function (run, ...expectedRevision) {
  let lockKey = "";
  for (let attempt = 0; ; attempt++) {
    const err = this.writeRunOnce(run, lockKey, ...expectedRevision);
    if (err instanceof admissionLockRequired() && attempt < 3) {
      lockKey = err.key;
      continue;
    }
    return err;
  }
};

RunsRepo.prototype.writeRunOnce = function (run, lockKey, ...expectedRevision) {
  let opts = [];
  if (lockKey !== "") {
    opts = this.admissionTxOptions();
  }
  return this.DB.Transaction((tx) => {
    if (lockKey !== "") {
      const gateErr = lockAdmissionGate(this, tx, lockKey);
      if (gateErr != null) {
        return gateErr;
      }
    }
    const [current, err] = this.takeRunForUpdate(tx, run.ID);
    if (err == null) {
      if (expectedRevision.length > 0 && current.Revision !== expectedRevision[0]) {
        return ErrRunDecisionStale;
      }
      if (run.Generation !== current.Generation) {
        return ErrRunLeaseLost;
      }
      const leaseExpired = current.OwnerInstanceID !== "" && (current.LeaseUntil == null || current.LeaseUntil.getTime() <= Date.now());
      if (leaseExpired && !TerminalRunStatus(run.Status)) {
        return ErrRunLeaseLost;
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
    } else if (err !== gorm.ErrRecordNotFound) {
      return err;
    }
    if (expectedRevision.length > 0) {
      if (err != null) {
        return ErrRunDecisionStale;
      }
      if (run.Status === "running" || (!run.PauseRequested && !run.CancelRequested)) {
        const clearErr = tx.Model(new runRow()).Where("id = ?", run.ID).Updates({ cancel_requested: false, pause_requested: false }).Error;
        if (clearErr != null) {
          return clearErr;
        }
      }
    }
    const admissionErr = this.prepareRunAdmission(tx, run, current, err == null, lockKey);
    if (admissionErr != null) {
      return admissionErr;
    }
    if (run.Status === "queued") {
      const queueErr = tx.Model(new runRow()).Where("id = ?", run.ID).Updates({ owner_instance_id: "", lease_until: null, cancel_requested: false, pause_requested: false }).Error;
      if (queueErr != null) {
        return queueErr;
      }
    }
    const cur = { logs: 0, telemetry: 0, events: 0 };
    const rawErr = tx.Raw(`SELECT
			COALESCE((SELECT MAX(seq) FROM run_logs WHERE run_id=?), 0) AS logs,
			COALESCE((SELECT MAX(seq) FROM run_telemetry WHERE run_id=?), 0) AS telemetry,
			COALESCE((SELECT MAX(seq) FROM run_events WHERE run_id=?), -1) + 1 AS events`,
      run.ID, run.ID, run.ID).Scan(cur).Error;
    if (rawErr != null) {
      return rawErr;
    }
    // On conflict only the run header is refreshed. Lease fields
    // (owner_instance_id, lease_until, execution_generation) and workspace
    // bindings are owned by the lease operations and must survive PutRun.
    // The control flags (cancel_requested/pause_requested) are likewise
    // excluded: they are written exclusively via RequestRunControl/
    // ClearRunControl, so a worker PutRun can never clobber an API-side
    // cancel/pause request (master's writeRun has the same omission).
    const upsertErr = upsertColumns(tx, "runs", runRowValues(run), [
      "kind", "workflow_id", "status", "revision", "input", "human_context", "sandbox_id", "repository", "repositories", "snapshot",
      "execution_context", "usage_json", "tool_calls", "telemetry_sequence",
      "log_sequence", "workspace_cleaned_at", "updated_at", "admission_state", "queue_entered_at", "quota_project_id", "quota_parent_run_id", "quota_exempt", "quota_bucket",
    ]);
    if (upsertErr != null) {
      return new Error(`runs upsert ${run.ID}: ${upsertErr}`);
    }
    // Nodes: upsert every node of the run.
    for (const [id, node] of Object.entries(run.Nodes ?? {})) {
      if (node == null) {
        continue;
      }
      const nodeErr = upsert(tx, "run_nodes", {
        run_id: run.ID, node_id: id, status: node.Status, attempt: node.Attempt, payload: mustJSON(node),
      });
      if (nodeErr != null) {
        return nodeErr;
      }
    }
    // Events: append-only by index.
    const events = run.Events ?? [];
    if (events.length > cur.events) {
      for (let i = cur.events; i < events.length; i++) {
        const ev = events[i];
        const notifyErr = this.notifications.enqueueRunNotifications(tx, run, ev, i);
        if (notifyErr != null) {
          return notifyErr;
        }
        const eventErr = upsert(tx, "run_events", {
          run_id: run.ID, seq: i, event_id: ev.ID, node_id: ev.NodeID,
          type: ev.Type, message: ev.Message, payload: mustJSON(ev), ts: timePtr(ev.Timestamp),
        });
        if (eventErr != null) {
          return eventErr;
        }
      }
    }
    for (const ev of run.Telemetry ?? []) {
      if (ev.Sequence === 0 || ev.Sequence <= cur.telemetry) {
        continue;
      }
      const telemetryErr = upsert(tx, "run_telemetry", {
        run_id: run.ID, seq: ev.Sequence, payload: mustJSON(ev),
      });
      if (telemetryErr != null) {
        return telemetryErr;
      }
    }
    for (const rec of run.Logs ?? []) {
      if (rec.Sequence === 0 || rec.Sequence <= cur.logs) {
        continue;
      }
      const logErr = upsert(tx, "run_logs", {
        run_id: run.ID, seq: rec.Sequence, payload: mustJSON(rec),
      });
      if (logErr != null) {
        return logErr;
      }
    }
    for (const art of run.Artifacts ?? []) {
      let id = art.ID;
      if (id === "") {
        id = `${run.ID}-${art.NodeID}-${art.Attempt}-${art.Name}`;
      }
      const artifactErr = upsert(tx, "run_artifacts", {
        id: id, run_id: run.ID, node_id: art.NodeID, attempt: art.Attempt,
        name: art.Name, path: art.Path, media_type: art.MediaType,
        size_bytes: art.Size, sha256: art.SHA256, repository_dir: art.RepositoryDir,
        content: art.Content, created_at: timePtr(art.CreatedAt),
      });
      if (artifactErr != null) {
        return artifactErr;
      }
    }
    return null;
  }, ...(opts ?? []));
};

// DeleteRun removes a settled run together with all of its children (nodes,
// events, telemetry, logs, artifacts). Live runs (running/waiting) must be
// cancelled first so engine scheduler state stays consistent. Deleting only
// releases a slot, so no admission lock is needed; the row lock and status
// re-check keep a queued run from being promoted mid-delete.
RunsRepo.prototype.DeleteRun = function (id) {
  return this.DB.Transaction((tx) => {
    const [row, err] = this.takeRunForUpdate(tx, id);
    if (err != null) {
      return err;
    }
    if (row.Status === "running" || row.Status === "waiting" || row.Status === "queued") {
      return new Error(`run ${id} is ${row.Status}: cancel it before deleting`);
    }
    for (const table of ["run_nodes", "run_events", "run_telemetry", "run_logs", "run_artifacts", "run_evals", "run_workspace_checkpoint_chunks", "run_workspace_checkpoints"]) {
      const deleteErr = tx.Table(table).Where("run_id = ?", id).Delete(null).Error;
      if (deleteErr != null) {
        return new Error(`runs delete ${id}: ${deleteErr}`);
      }
    }
    return tx.Where("id = ?", id).Delete(new runRow()).Error;
  });
};

// ---------- Run leases ----------

RunsRepo.prototype.takeRunForUpdate = function (tx, id) {
  const row = new runRow();
  const err = this.locking(tx.Where("id = ?", id)).Take(row).Error;
  return [row, err];
};

RunsRepo.prototype.TryAcquireRunLease = function (runID, instanceID, generation, ttl) {
  if (instanceID.trim() === "" || ttl <= 0) {
    return ErrRunLeaseLost;
  }
  return this.DB.Transaction((tx) => {
    const [current, err] = this.takeRunForUpdate(tx, runID);
    if (err != null) {
      if (err === gorm.ErrRecordNotFound) {
        return new Error("run not found");
      }
      return err;
    }
    if (current.Status !== "running" && current.Status !== "waiting" && current.Status !== "failed" && current.Status !== "cancelled" && current.Status !== "succeeded") {
      return new Error("run cannot be leased");
    }
    const now = new Date();
    if (current.OwnerInstanceID !== "" && current.OwnerInstanceID !== instanceID && current.LeaseUntil != null && current.LeaseUntil.getTime() > now.getTime()) {
      return ErrRunLeaseHeld;
    }
    if (generation !== current.Generation && !(current.Generation === 0 && generation === 1)) {
      return ErrRunLeaseLost;
    }
    let newGeneration = current.Generation;
    if (current.OwnerInstanceID === instanceID) {
      if (generation !== current.Generation) {
        return ErrRunLeaseLost;
      }
      if (current.Status !== "running") {
        newGeneration++;
      }
    } else if (current.Generation === 0) {
      newGeneration = 1;
    } else {
      newGeneration++;
    }
    return tx.Model(new runRow()).Where("id = ?", runID).Updates({
      owner_instance_id: instanceID, lease_until: new Date(now.getTime() + ttl), execution_generation: newGeneration,
    }).Error;
  });
};

RunsRepo.prototype.RenewRunLease = function (runID, instanceID, generation, ttl) {
  const res = this.DB.Model(new runRow()).
    Where("id = ? AND owner_instance_id = ? AND execution_generation = ?", runID, instanceID, generation).
    Update("lease_until", new Date(Date.now() + ttl));
  if (res.Error != null) {
    return res.Error;
  }
  if (res.RowsAffected !== 1) {
    return ErrRunLeaseLost;
  }
  return null;
};

RunsRepo.prototype.ReleaseRunLease = function (runID, instanceID, generation) {
  const res = this.DB.Model(new runRow()).
    Where("id = ? AND owner_instance_id = ? AND execution_generation = ?", runID, instanceID, generation).
    Updates({ owner_instance_id: "", lease_until: null });
  if (res.Error != null) {
    return res.Error;
  }
  if (res.RowsAffected !== 1) {
    return ErrRunLeaseLost;
  }
  return null;
};

RunsRepo.prototype.BindRunWorkspace = function (runID, instanceID, generation, host, root) {
  let bound = false;
  const err = this.DB.Transaction((tx) => {
    const [current, takeErr] = this.takeRunForUpdate(tx, runID);
    if (takeErr != null) {
      if (takeErr === gorm.ErrRecordNotFound) {
        return ErrRunLeaseLost;
      }
      return takeErr;
    }
    if (current.OwnerInstanceID !== instanceID || current.Generation !== generation) {
      return ErrRunLeaseLost;
    }
    if (current.WorkspaceRoot.trim() !== "") {
      if (current.WorkspaceHost === host && current.WorkspaceRoot === root) {
        bound = false;
        return null;
      }
      return ErrRunWorkspaceBound;
    }
    bound = true;
    return tx.Model(new runRow()).Where("id = ?", runID).Updates({
      workspace_host: host, workspace_root: root,
    }).Error;
  });
  return [bound, err];
};

// RebindRunWorkspace moves the workspace bind of a run to (host, root). Only
// the current lease holder may do it; callers use it when the previously
// bound host is gone and the checkout has to be rebuilt elsewhere.
RunsRepo.prototype.RebindRunWorkspace = function (runID, instanceID, generation, host, root) {
  return this.DB.Transaction((tx) => {
    const [current, err] = this.takeRunForUpdate(tx, runID);
    if (err != null) {
      if (err === gorm.ErrRecordNotFound) {
        return ErrRunLeaseLost;
      }
      return err;
    }
    if (current.OwnerInstanceID !== instanceID || current.Generation !== generation) {
      return ErrRunLeaseLost;
    }
    return tx.Model(new runRow()).Where("id = ?", runID).Updates({
      workspace_host: host, workspace_root: root,
    }).Error;
  });
};

// ---------- Workflow metrics ----------

RunsRepo.prototype.WorkflowMetrics = function () {
  return this.WorkflowMetricsFor("");
};

RunsRepo.prototype.WorkflowMetricsFor = function (projectID) {
  const metrics = {};
  const nodeDurations = {};
  const workflowDefs = {};
  for (const workflow of this.catalog.Workflows()) {
    workflowDefs[workflow.ID] = workflow;
    metrics[workflow.ID] = new WorkflowMetrics({ WorkflowID: workflow.ID });
    nodeDurations[workflow.ID] = {};
  }
  const [runs] = this.RunSummariesFor(new AnalyticsFilter({ ProjectID: projectID }), "");
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

// accumulateNodeMetrics folds one run's node results into m.NodeMetrics,
// appending a metric (named from def, falling back to the node ID) for nodes
// not seen before, and adds finished node durations to durations by node ID.
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

// parallel waits for a set of concurrent loads and returns the first error.
// Go 用 goroutine 并发执行；JS 单线程，顺序执行并返回第一个错误。
function parallel(...fns) {
  const errs = [];
  for (let i = 0; i < fns.length; i++) {
    errs[i] = fns[i]();
  }
  for (const err of errs) {
    if (err != null) {
      return err;
    }
  }
  return null;
}

function runArtifactCount(run) {
  if (run.ArtifactCount > 0) {
    return run.ArtifactCount;
  }
  return (run.Artifacts ?? []).length;
}

// ---------- duration helpers ----------

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

function runDuration(run, now) {
  const end = runEndedAt(run, now);
  if (run.CreatedAt == null || end.getTime() < run.CreatedAt.getTime()) {
    return 0;
  }
  return end.getTime() - run.CreatedAt.getTime();
}

// runExecutionDuration 统计 SOP 节点真实执行耗时之和：Σ(节点 FinishedAt − StartedAt)。
// 与 runDuration（Run 创建 → 最后结束的墙钟差）不同，它不含审批、排队、恢复等待，
// 因此执行耗时 ≤ 端到端墙钟。起止时间缺失或倒挂的节点跳过。
// 纯聚合层只读计算，不触碰执行链路；既有的 runDuration/runEndedAt 语义保持不变。
// 有事件流算出的 Timing 时以它为准：节点行只保留最近一次尝试，会漏掉重试前的执行。
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

// runActiveDuration returns the union of node execution intervals. Unlike
// runExecutionDuration it does not double-count parallel nodes, so it can be
// subtracted from wall-clock duration when estimating time spent waiting.
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

// runWaitDuration 为等待时长：端到端墙钟 − 节点活跃区间并集，下限 0。
// 节点活跃区间使用并集，避免并行节点被重复扣减。
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

// queryAnalyticsWorkflowSnapshots loads frozen workflow definitions only for
// analytics candidates. RunSummaries stays lightweight for ordinary list/API
// consumers and therefore deliberately does not include the snapshot column.
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
      return [null, err];
    }
    for (const row of rows) {
      const snapshot = new WorkflowDefinition();
      const unmarshalErr = jsonUnmarshal(row.Snapshot, snapshot);
      if (unmarshalErr != null) {
        return [null, unmarshalErr];
      }
      out[row.ID] = snapshot;
    }
  }
  return [out, null];
}

// repositoriesJSONValue 与 master 的 repositoriesJSON 一致：空集合写 SQL
// NULL 而不是 '[]'，保证按 NULL 过滤的查询语义相同。
function repositoriesJSONValue(repositories) {
  if ((repositories ?? []).length === 0) {
    return null;
  }
  return jsonBytes(repositories);
}

// ---------- Run log/telemetry pages ----------

const defaultLogPageSize = 100;
const maxLogPageSize = 200;

class LogPage {
  constructor(init = {}) {
    this.Logs = init.Logs ?? [];
    this.Sequence = init.Sequence ?? 0;
    this.NextAfter = init.NextAfter ?? 0;
    this.NextBefore = init.NextBefore ?? 0;
    this.HasMore = init.HasMore ?? false;
  }
}

class TelemetryPage {
  constructor(init = {}) {
    this.Events = init.Events ?? [];
    this.Sequence = init.Sequence ?? 0;
    this.NextAfter = init.NextAfter ?? 0;
    this.NextBefore = init.NextBefore ?? 0;
    this.HasMore = init.HasMore ?? false;
  }
}

// ---------- Log pages ----------

RunsRepo.prototype.QueryRunLogs = function (runID, nodeID, after, before, afterSet, beforeSet, limit) {
  limit = clampPageLimit(limit);
  const row = new runRow();
  if (this.DB.Select("log_sequence").Where("id = ?", runID).Take(row).Error != null) {
    return [new LogPage(), new Error("run not found")];
  }
  if (this.isMySQL()) {
    // The generated `level` column plus a JSON path filter keep this a
    // single indexed query in production.
    const [nodeWhere, nodeArgs] = this.nodeIDFilter("$.context.nodeId", nodeID);
    const [raws, hasMore, err] = this.queryJSONSeqPage("run_logs", runID, nodeWhere, nodeArgs, new sqlFilter(), after, before, afterSet, beforeSet, limit);
    if (err != null) {
      return [new LogPage(), err];
    }
    const out = [];
    for (const raw of raws) {
      const rec = new LogRecord();
      if (jsonUnmarshal(raw, rec) == null) {
        out.push(rec);
      }
    }
    return [finishLogPage(out, row.LogSequence, hasMore), null];
  }
  const [logs, err] = this.loadRunLogsAll(runID);
  if (err != null) {
    return [new LogPage(), err];
  }
  return [buildLogPage(logs, row.LogSequence, nodeID, after, before, afterSet, beforeSet, limit), null];
};

const maxLogDump = 20000;

RunsRepo.prototype.DumpRunLogs = function (runID, nodeID) {
  let all = [];
  let after = 0;
  for (;;) {
    const [page, err] = this.QueryRunLogs(runID, nodeID, after, 0, true, false, maxLogPageSize);
    if (err != null) {
      return [null, err];
    }
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
  return [all, null];
};

// ---------- Telemetry pages ----------

RunsRepo.prototype.QueryRunTelemetry = function (runID, nodeID, adapter, after, before, afterSet, beforeSet, limit) {
  limit = clampPageLimit(limit);
  const row = new runRow();
  if (this.DB.Select("telemetry_sequence").Where("id = ?", runID).Take(row).Error != null) {
    return [new TelemetryPage(), new Error("run not found")];
  }
  if (this.isMySQL()) {
    const [nodeWhere, nodeArgs] = this.nodeIDFilter("$.nodeId", nodeID);
    const adapterFilter = adapterSQLFilter(adapter);
    const [raws, hasMore, err] = this.queryJSONSeqPage("run_telemetry", runID, nodeWhere, nodeArgs, adapterFilter, after, before, afterSet, beforeSet, limit);
    if (err != null) {
      return [new TelemetryPage(), err];
    }
    const out = [];
    for (const raw of raws) {
      const rec = new TelemetryEvent();
      if (jsonUnmarshal(raw, rec) == null) {
        out.push(rec);
      }
    }
    return [finishTelemetryPage(out, row.TelemetrySequence, hasMore), null];
  }
  const [events, err] = this.loadRunTelemetryAll(runID);
  if (err != null) {
    return [new TelemetryPage(), err];
  }
  return [buildTelemetryPage(events, row.TelemetrySequence, nodeID, adapter, after, before, afterSet, beforeSet, limit), null];
};

// nodeIDFilter renders the JSON path filter for the current dialect.
RunsRepo.prototype.nodeIDFilter = function (path, nodeID) {
  if (nodeID === "") {
    return ["", null];
  }
  return [this.sqlJSONText(path) + " = ?", [path, nodeID]];
};

class sqlFilter {
  constructor(init = {}) {
    this.clause = init.clause ?? "";
    this.args = init.args ?? [];
  }
}

// adapterSQLFilter filters on the MySQL generated `adapter` column.
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
    return [null, false, err];
  }
  let hasMore = raws.length > limit;
  if (hasMore) {
    raws.length = limit;
  }
  if (order === "DESC") {
    raws.reverse();
  }
  return [raws, hasMore, null];
};

RunsRepo.prototype.loadRunLogsAll = function (runID) {
  const rows = [];
  const err = this.DB.Where("run_id = ?", runID).Order("seq").Find(rows).Error;
  if (err != null) {
    return [null, err];
  }
  const out = [];
  for (const row of rows) {
    const rec = new LogRecord();
    if (jsonUnmarshal(row.Payload, rec) == null) {
      out.push(rec);
    }
  }
  return [out, null];
};

RunsRepo.prototype.loadRunTelemetryAll = function (runID) {
  const rows = [];
  const err = this.DB.Where("run_id = ?", runID).Order("seq").Find(rows).Error;
  if (err != null) {
    return [null, err];
  }
  const out = [];
  for (const row of rows) {
    const rec = new TelemetryEvent();
    if (jsonUnmarshal(row.Payload, rec) == null) {
      out.push(rec);
    }
  }
  return [out, null];
};

// ---------- Shared paging helpers ----------

function clampPageLimit(limit) {
  if (limit <= 0) {
    return defaultLogPageSize;
  }
  if (limit > maxLogPageSize) {
    return maxLogPageSize;
  }
  return limit;
}

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

function finishLogPage(logs, seq, hasMore) {
  const page = new LogPage({ Logs: logs, Sequence: seq, HasMore: hasMore });
  if (logs.length > 0) {
    page.NextAfter = logs[logs.length - 1].Sequence;
    page.NextBefore = logs[0].Sequence;
  }
  return page;
}

function finishTelemetryPage(events, seq, hasMore) {
  const page = new TelemetryPage({ Events: events, Sequence: seq, HasMore: hasMore });
  if (events.length > 0) {
    page.NextAfter = events[events.length - 1].Sequence;
    page.NextBefore = events[0].Sequence;
  }
  return page;
}

// RequestRunCancel durably flags a live run (running or waiting) for
// cancellation so any worker observing the heartbeat will settle it.
RunsRepo.prototype.RequestRunCancel = function (id) {
  return this.requestRunControl(id, true, false);
};

// RequestRunPause flags a running or waiting run for an explicit pause.
RunsRepo.prototype.RequestRunPause = function (id) {
  return this.requestRunControl(id, false, true);
};

// RunControlRequested reads only the durable pause/cancel bits. The worker
// uses this as a lease-heartbeat fallback and to ignore stray interrupts.
RunsRepo.prototype.RunControlRequested = function (id) {
  const flags = { CancelRequested: false, PauseRequested: false };
  if (this.DB.Model(new runRow()).Select("cancel_requested", "pause_requested").Where("id = ?", id).Take(flags).Error != null) {
    return false;
  }
  return flags.CancelRequested || flags.PauseRequested;
};

// ClearRunControl clears pending cancel/pause flags once the request has been
// observed by the run's owner instance.
RunsRepo.prototype.ClearRunControl = function (id) {
  return this.DB.Transaction((tx) => {
    const [, err] = this.takeRunForUpdate(tx, id);
    if (err === gorm.ErrRecordNotFound) {
      return new Error("run not found");
    }
    if (err != null) {
      return err;
    }
    return tx.Model(new runRow()).Where("id = ?", id).Updates({
      cancel_requested: false, pause_requested: false,
      workspace_editor_id: 0, workspace_edit_until: null,
    }).Error;
  });
};

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
    return [new Run(), new Error(`request run control: ${res.Error}`)];
  }
  if (res.RowsAffected === 0) {
    const [, ok] = takeRun(this.DB, id);
    if (!ok) {
      return [new Run(), new Error("run not found")];
    }
    return [new Run(), new Error("run is not active")];
  }
  const [row, ok] = takeRun(this.DB, id);
  if (!ok) {
    return [new Run(), new Error("run not found")];
  }
  return [runFromRow(row), null];
};

function sortSliceStable(values, less) {
  for (let i = 1; i < values.length; i++) {
    for (let j = i; j > 0 && less(values[j], values[j - 1]); j--) {
      [values[j], values[j - 1]] = [values[j - 1], values[j]];
    }
  }
}

// PutRunAtRevision fences a chat-card decision against concurrent API/worker
// writes. Control flags are cleared in the same guarded transaction.
RunsRepo.prototype.PutRunAtRevision = function (v, revision) {
  v.UpdatedAt = new Date();
  v.Revision++;
  return this.writeRun(v, revision);
};

module.exports = { defaultLogPageSize, maxLogPageSize, maxLogDump, LogPage, TelemetryPage, sqlFilter, runFromRow, runRowValues, takeRun, accumulateNodeMetrics, parallel, runArtifactCount, runEndedAt, runDuration, runExecutionDuration, runActiveDuration, runWaitDuration, queryAnalyticsWorkflowSnapshots, repositoriesJSONValue, summarizeNode, artifactFromRow, adapterSQLFilter, clampPageLimit, buildLogPage, buildTelemetryPage, pageByCursor, finishLogPage, finishTelemetryPage, sortSliceStable };
