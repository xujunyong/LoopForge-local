// sync.js —— 对应 Go 文件：internal/domain/sync.go
// 作用：外部同步配置、定时任务定义与同步日志。

"use strict";

// SyncConfig：平台级外部同步设置。
class SyncConfig {
  constructor(init = {}) {
    this.PlaybookSeedRev = init.PlaybookSeedRev ?? 0;
    this.GongfengProjectID = init.GongfengProjectID ?? "";
    this.GongfengMCPURL = init.GongfengMCPURL ?? "";
    this.TAPDWorkspaceID = init.TAPDWorkspaceID ?? "";
    this.TAPDIterationID = init.TAPDIterationID ?? "";
    this.TAPDMCPURL = init.TAPDMCPURL ?? "";
    this.AutoSyncEnabled = init.AutoSyncEnabled ?? false;
    this.AutoSyncIntervalSec = init.AutoSyncIntervalSec ?? 0;
    this.LastSyncAt = init.LastSyncAt ?? null;
    this.LastSyncStatus = init.LastSyncStatus ?? "";
    this.LastSyncError = init.LastSyncError ?? "";
  }
}

const DefaultIntegrateBranch = "agentflow/integration";

// NormalizeIntegrateBranch：去掉集成基线分支名两侧空白。
function NormalizeIntegrateBranch(name) {
  return name.trim();
}

// ConflictBlock：一次失败的默认分支→集成基线合并中抽出的一个冲突块。
class ConflictBlock {
  constructor(init = {}) {
    this.File = init.File ?? "";
    this.Ours = init.Ours ?? "";
    this.Theirs = init.Theirs ?? "";
  }
}

// ScheduleJobBlocker：定时任务的仓库级阻塞（基线冲突等）。
class ScheduleJobBlocker {
  constructor(init = {}) {
    this.RepositoryID = init.RepositoryID ?? "";
    this.RepositoryName = init.RepositoryName ?? "";
    this.IntegrateBranch = init.IntegrateBranch ?? "";
    this.DefaultBranch = init.DefaultBranch ?? "";
    this.ConflictFiles = init.ConflictFiles ?? null;
    this.ConflictBlocks = init.ConflictBlocks ?? null;
    this.Reason = init.Reason ?? "";
    this.AlignRunID = init.AlignRunID ?? "";
    this.ResponsibleUserID = init.ResponsibleUserID ?? 0;
    this.Since = init.Since ?? null;
  }
}

class ScheduleJob {
  constructor(init = {}) {
    this.SharedTaskID = init.SharedTaskID ?? "";
    this.SharedTaskVersion = init.SharedTaskVersion ?? 0;
    this.ParameterValues = init.ParameterValues ?? null;
    this.Notifications = init.Notifications ?? null;
    this.NotificationSnapshot = init.NotificationSnapshot ?? null;
    this.NotificationResult = init.NotificationResult ?? "";
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Enabled = init.Enabled ?? false;
    this.ProjectID = init.ProjectID ?? "";
    this.Source = init.Source ?? "";
    this.TAPDWorkspaceID = init.TAPDWorkspaceID ?? "";
    this.TAPDIterationID = init.TAPDIterationID ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.UseIssueWorkflow = init.UseIssueWorkflow ?? false;
    this.SkipDispatch = init.SkipDispatch ?? false;
    this.IssueStatuses = init.IssueStatuses ?? null;
    this.MaxDispatch = init.MaxDispatch ?? 0;
    this.IntervalSec = init.IntervalSec ?? 0;
    this.Cron = init.Cron ?? "";
    this.AssistantPrompt = init.AssistantPrompt ?? "";
    this.References = init.References ?? null;
    this.AssistantModel = init.AssistantModel ?? "";
    this.TimeoutMinutes = init.TimeoutMinutes ?? 0;
    this.SessionMode = init.SessionMode ?? "";
    this.SessionKeep = init.SessionKeep ?? 0;
    this.FixedSessionID = init.FixedSessionID ?? "";
    this.OwnerUserID = init.OwnerUserID ?? 0;
    this.RunAsUserID = init.RunAsUserID ?? 0;
    this.RunAsName = init.RunAsName ?? "";
    this.LastRunAt = init.LastRunAt ?? null;
    this.LastStatus = init.LastStatus ?? "";
    this.LastError = init.LastError ?? "";
    this.LastPulled = init.LastPulled ?? 0;
    this.LastDispatched = init.LastDispatched ?? 0;
    this.LastAssistantMessage = init.LastAssistantMessage ?? "";
    this.LastTraceID = init.LastTraceID ?? "";
    this.LastSessionID = init.LastSessionID ?? "";
    this.Blockers = init.Blockers ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  // ResolveWorkflow：定时派发选用的 SOP，优先取需求绑定的工作流。
  ResolveWorkflow(issue) {
    if (this.UseIssueWorkflow) {
      const id = issue.WorkflowID.trim();
      if (id !== "") {
        return id;
      }
    }
    return this.WorkflowID.trim();
  }

  // DispatchesSOP：触发类任务是否扫描需求并启动 SOP。
  DispatchesSOP() {
    return !this.SkipDispatch && this.WorkflowID.trim() !== "";
  }

  // DispatchLimit：单次执行最多成功派发的 SOP 数。
  DispatchLimit() {
    if (this.MaxDispatch < 1 || this.MaxDispatch > MaxScheduleDispatch) {
      return MaxScheduleDispatch;
    }
    return this.MaxDispatch;
  }

  // TriggerIssueStatuses：触发任务将扫描的状态集合。
  TriggerIssueStatuses() {
    if (this.SkipDispatch) {
      return null;
    }
    const out = NormalizeScheduleIssueStatuses(this.IssueStatuses);
    if (out.length > 0) {
      return out;
    }
    return [...ScheduleIssueStatusOptions];
  }

  // MatchesIssueSource：触发任务是否应启动该来源的需求。
  MatchesIssueSource(source) {
    const want = this.Source.trim().toLowerCase();
    if (want === "" || want === "all" || want === "both") {
      return true;
    }
    return source.trim().toLowerCase() === want;
  }

  // MatchesIssueStatus：触发任务是否应考虑该需求状态。
  MatchesIssueStatus(status) {
    status = status.trim().toLowerCase();
    if (status === "") {
      status = "backlog";
    }
    return (this.TriggerIssueStatuses() ?? []).includes(status);
  }
}

const MaxScheduleDispatch = 10;

// ScheduleIssueStatusOptions：触发任务可扫描的状态。
const ScheduleIssueStatusOptions = ["backlog", "todo", "in_progress", "in_review", "blocked"];

// DefaultScheduleIssueStatuses：新建触发任务未填状态列表时存的默认值。
const DefaultScheduleIssueStatuses = ["backlog", "todo"];

// NormalizeScheduleIssueStatuses：只保留已知可派发状态，按选项顺序排列。
function NormalizeScheduleIssueStatuses(values) {
  const want = new Set();
  for (const raw of values ?? []) {
    const s = raw.trim().toLowerCase();
    if (s !== "") {
      want.add(s);
    }
  }
  const out = [];
  for (const s of ScheduleIssueStatusOptions) {
    if (want.has(s)) {
      out.push(s);
    }
  }
  return out;
}

// NormalizeScheduleSource：校验触发任务的来源过滤条件。
function NormalizeScheduleSource(raw) {
  switch (raw.trim().toLowerCase()) {
    case "":
    case "all":
    case "both":
      return "";
    case "github":
    case "gongfeng":
    case "tapd":
      return raw.trim().toLowerCase();
    default:
      throw new Error("来源只能是工蜂、TAPD，或两边都同步");
  }
}

// SyncLog：一次同步执行的记录。
class SyncLog {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Direction = init.Direction ?? "";
    this.Source = init.Source ?? "";
    this.Action = init.Action ?? "";
    this.Status = init.Status ?? "";
    this.Count = init.Count ?? 0;
    this.ProjectID = init.ProjectID ?? "";
    this.Message = init.Message ?? "";
    this.StartedAt = init.StartedAt ?? null;
    this.FinishedAt = init.FinishedAt ?? null;
  }
}

module.exports = { SyncConfig, DefaultIntegrateBranch, NormalizeIntegrateBranch, ConflictBlock, ScheduleJobBlocker, ScheduleJob, MaxScheduleDispatch, ScheduleIssueStatusOptions, DefaultScheduleIssueStatuses, NormalizeScheduleIssueStatuses, NormalizeScheduleSource, SyncLog };
