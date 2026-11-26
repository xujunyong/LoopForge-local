/**
 * @file internal/domain/sync.js
 * @description 对应 Go 文件：internal/domain/sync.go
 * 职责与边界：定义平台级外部同步配置（SyncConfig）、集成基线冲突块、定时任务阻塞项、
 * 定时任务定义（ScheduleJob）及其触发筛选/派发解析方法，以及同步执行日志（SyncLog）。
 * 语法差异说明：
 * - Go 切片零值初始化为 `[]`，普通映射 `map[string]V` 与集合 `map[string]bool` 译为 `{}`，`time.Time` 初始化为 `null`。
 * - Go 多返回值 `(string, error)` 译为成功返回 `string`、失败 `throw Error`。
 */

"use strict";

/**
 * 表示平台级的外部系统同步设置（工蜂、TAPD 与自动同步状态）。
 */
class SyncConfig {
  /**
   * 构造同步配置实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

/**
 * 去除配置的集成基线分支名首尾空白；返回空字符串表示该仓库不启用集成基线流程。
 * 在仓库配置保存与定时任务读取基线分支时调用。
 * @param {string} name - 原始集成基线分支名。
 * @returns {string} 去除首尾空白后的分支名。
 */
function NormalizeIntegrateBranch(name) {
  return name.trim();
}

/**
 * 描述默认分支向集成基线分支合并失败时提取的单个冲突代码片段（包含我方集成分支与对方默认分支内容）。
 */
class ConflictBlock {
  /**
   * 构造冲突块实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.File = init.File ?? "";
    this.Ours = init.Ours ?? "";
    this.Theirs = init.Theirs ?? "";
  }
}

/**
 * 结构化记录定时任务遇到的仓库级阻塞（例如默认分支与集成分支的基线合并冲突），
 * 随 `ScheduleJob.Blockers` 持久化，供前端警示卡直达基线对齐运行。
 */
class ScheduleJobBlocker {
  /**
   * 构造定时任务阻塞项实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.RepositoryID = init.RepositoryID ?? "";
    this.RepositoryName = init.RepositoryName ?? "";
    this.IntegrateBranch = init.IntegrateBranch ?? "";
    this.DefaultBranch = init.DefaultBranch ?? "";
    this.ConflictFiles = init.ConflictFiles ?? [];
    this.ConflictBlocks = init.ConflictBlocks ?? [];
    this.Reason = init.Reason ?? "";
    this.AlignRunID = init.AlignRunID ?? "";
    this.ResponsibleUserID = init.ResponsibleUserID ?? 0;
    this.Since = init.Since ?? null;
  }
}

/**
 * 表示一条项目定时任务配置（包括扫描需求派发 SOP 的触发类任务，以及执行提示词的 AI 定时任务）。
 */
class ScheduleJob {
  /**
   * 构造定时任务实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.SharedTaskID = init.SharedTaskID ?? "";
    this.SharedTaskVersion = init.SharedTaskVersion ?? 0;
    this.ParameterValues = init.ParameterValues ?? {};
    this.Notifications = init.Notifications ?? [];
    this.NotificationSnapshot = init.NotificationSnapshot ?? [];
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
    this.IssueStatuses = init.IssueStatuses ?? [];
    this.MaxDispatch = init.MaxDispatch ?? 0;
    this.IntervalSec = init.IntervalSec ?? 0;
    this.Cron = init.Cron ?? "";
    this.AssistantPrompt = init.AssistantPrompt ?? "";
    this.References = init.References ?? [];
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
    this.Blockers = init.Blockers ?? [];
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  /**
   * 为定时派发解析应使用的 SOP 工作流 ID：若启用 `UseIssueWorkflow` 且需求自身绑定了工作流则优先使用，否则使用任务默认工作流。
   * 在定时触发器为单个需求启动 SOP 前调用。
   * @param {Object} issue - `Issue` 需求或缺陷对象。
   * @returns {string} 解析出的工作流 ID 字符串。
   */
  ResolveWorkflow(issue) {
    if (this.UseIssueWorkflow) {
      const id = issue.WorkflowID.trim();
      if (id !== "") {
        return id;
      }
    }
    return this.WorkflowID.trim();
  }

  /**
   * 判断该定时任务是否为会扫描需求并派发 SOP 运行的触发类任务（AI 定时任务设置 `SkipDispatch` 后永不派发）。
   * 在调度器区分任务执行路径时调用。
   * @returns {boolean} 需要扫描派发 SOP 时返回 `true`，否则返回 `false`。
   */
  DispatchesSOP() {
    return !this.SkipDispatch && this.WorkflowID.trim() !== "";
  }

  /**
   * 返回单次定时执行允许成功派发 SOP 的数量上限；非法或未设置时回退到 `MaxScheduleDispatch`。
   * 在调度器控制单轮派发配额时调用。
   * @returns {number} 单次执行最大派发数（`1..MaxScheduleDispatch`）。
   */
  DispatchLimit() {
    if (this.MaxDispatch < 1 || this.MaxDispatch > MaxScheduleDispatch) {
      return MaxScheduleDispatch;
    }
    return this.MaxDispatch;
  }

  /**
   * 返回该触发类定时任务将要扫描的需求状态列表；AI 任务返回 `null`，未显式配置状态时返回全部开放状态。
   * 在定时扫描筛选待派发需求前调用。
   * @returns {string[]|null} 需求状态数组；若为 `SkipDispatch` 的 AI 任务则返回 `null`。
   */
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

  /**
   * 判断触发类定时任务是否应处理指定来源的需求；来源过滤为空、`"all"` 或 `"both"` 时匹配所有来源。
   * 在定时扫描按来源过滤需求时调用。
   * @param {string} source - 需求的来源标识（如 `"gongfeng"`、`"tapd"`、`"local"`）。
   * @returns {boolean} 匹配任务来源过滤条件时返回 `true`，否则返回 `false`。
   */
  MatchesIssueSource(source) {
    const want = this.Source.trim().toLowerCase();
    if (want === "" || want === "all" || want === "both") {
      return true;
    }
    return source.trim().toLowerCase() === want;
  }

  /**
   * 判断触发类定时任务是否应处理处于指定状态的需求；空状态按 `"backlog"` 处理。
   * 在定时扫描按状态过滤需求时调用。
   * @param {string} status - 需求当前状态字符串。
   * @returns {boolean} 该状态位于任务允许扫描的状态集合内时返回 `true`，否则返回 `false`。
   */
  MatchesIssueStatus(status) {
    status = status.trim().toLowerCase();
    if (status === "") {
      status = "backlog";
    }
    return (this.TriggerIssueStatuses() ?? []).includes(status);
  }
}

const MaxScheduleDispatch = 10;

// 触发类定时任务允许扫描的需求状态全集（按固定展示顺序）。
const ScheduleIssueStatusOptions = ["backlog", "todo", "in_progress", "in_review", "blocked"];

// 新建触发类定时任务未填写状态列表时持久化采用的默认状态列表。
const DefaultScheduleIssueStatuses = ["backlog", "todo"];

/**
 * 过滤并去重需求状态列表，只保留已知可派发状态并按 `ScheduleIssueStatusOptions` 固定顺序返回。
 * 在保存定时任务配置及计算实际扫描状态集时调用。
 * @param {string[]} values - 待规范化的原始状态字符串数组。
 * @returns {string[]} 规范化后的合法状态数组。
 */
function NormalizeScheduleIssueStatuses(values) {
  const want = {};
  for (const raw of values ?? []) {
    const s = raw.trim().toLowerCase();
    if (s !== "") {
      want[s] = true;
    }
  }
  const out = [];
  for (const s of ScheduleIssueStatusOptions) {
    if (want[s] === true) {
      out.push(s);
    }
  }
  return out;
}

/**
 * 校验并规范化触发类定时任务的来源过滤条件；空值、`"all"`、`"both"` 统一规范为空字符串。
 * 在创建或更新定时任务时调用。
 * @param {string} raw - 原始来源过滤字符串。
 * @returns {string} 规范化后的来源标识（`""`、`"github"`、`"gongfeng"` 或 `"tapd"`）；非法值时抛出异常。
 */
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

/**
 * 记录单次外部需求/缺陷同步操作的方向、来源、动作、结果与起止时间。
 */
class SyncLog {
  /**
   * 构造同步日志实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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
