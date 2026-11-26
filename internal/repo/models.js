// models.js —— 对应 Go 文件：internal/repo/models.go
// 作用：gorm 行模型：MySQL 与 sqlite 测试库共用的物理表结构，领域实体只存 JSON payload 列。
// 时间字段特意命名为 Created/Updated（不用 CreatedAt/UpdatedAt），gorm 不自动填充，由写入方显式设置。

"use strict";

const { BotUserBinding, BotBindingChallenge } = require("../domain/bot_identity.js"); // 对应 Go 的 domain.*，bot_identity.js 已翻译
const { BotConnection, BotConversation, BotInteraction } = require("../domain/bot_interaction.js"); // 对应 Go 的 domain.*，bot_interaction.js 已翻译
const { NotificationDelivery } = require("../domain/notification.js"); // 对应 Go 的 domain.NotificationDelivery，notification.js 已翻译
const { notificationBotRow } = require("./notifications.js"); // 对应 Go 同包类型，notifications.js 待翻译
const { botCredentialRow } = require("./bot_credentials.js"); // 对应 Go 同包类型，bot_credentials.js 已翻译
const { localAccountRow } = require("./local_accounts.js"); // 对应 Go 同包类型，local_accounts.js 待翻译
const { authIntegrationRow } = require("./auth_integration.js"); // 对应 Go 同包类型，auth_integration.js 已翻译
const { platformCodeBuddyKeyRow } = require("./codebuddy_sponsor.js"); // 对应 Go 同包类型，codebuddy_sponsor.js 已翻译
const { insightSourceRow, insightExecutionRow } = require("./insights.js"); // 对应 Go 同包类型，insights.js 已翻译
const { businessDomainRow, businessDomainAssignmentRow } = require("./business_domains.js"); // 对应 Go 同包类型，business_domains.js 已翻译
const { runAdmissionLockRow } = require("./run_admission.js"); // 对应 Go 同包类型，run_admission.js 待翻译
const { WorkspaceCheckpoint } = require("./workspace_checkpoints.js"); // 对应 Go 同包类型，workspace_checkpoints.js 待翻译
const { workspaceCheckpointChunk } = require("./workspace_checkpoint_chunks.js"); // 对应 Go 同包类型，workspace_checkpoint_chunks.js 待翻译
const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 已翻译
const { assistantSessionReadRow } = require("./assistant_session_reads.js"); // 对应 Go 同包类型，assistant_session_reads.js 已翻译
const { assistantDiagnosticsRow } = require("./assistant_diagnostics.js"); // 对应 Go 同包类型，assistant_diagnostics.js 已翻译
const { PlatformGitSSHHost } = require("./ssh_host_trust.js"); // 对应 Go 同包类型，ssh_host_trust.js 待翻译
const { PlatformGitHTTPSHost } = require("./git_https_hosts.js"); // 对应 Go 同包类型，git_https_hosts.js 已翻译

const mysqlSyncConfigID = "default";
const mysqlSeedMarkerID = -1;

class userRow {
  constructor(init = {}) {
    this.ID = init.ID ?? 0;
    this.StaffID = init.StaffID ?? 0;
    this.LoginName = init.LoginName ?? "";
    this.ChineseName = init.ChineseName ?? "";
    this.DeptID = init.DeptID ?? 0;
    this.DeptName = init.DeptName ?? "";
    this.PlatformRole = init.PlatformRole ?? "";
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "users";
  }
}

class userConfigRow {
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.GitToken = init.GitToken ?? null;
    this.GongfengRefreshToken = init.GongfengRefreshToken ?? null;
    this.GongfengTokenExpiresAt = init.GongfengTokenExpiresAt ?? null;
    this.CodeBuddyAPIKey = init.CodeBuddyAPIKey ?? null;
    this.CodeBuddyBaseURL = init.CodeBuddyBaseURL ?? null;
    this.CodeBuddyInternetEnvironment = init.CodeBuddyInternetEnvironment ?? "";
    this.CodeBuddyModels = init.CodeBuddyModels ?? null;
    this.CodexAPIKey = init.CodexAPIKey ?? null;
    this.CodexBaseURL = init.CodexBaseURL ?? null;
    this.CodexModels = init.CodexModels ?? null;
    this.ClaudeCodeAPIKey = init.ClaudeCodeAPIKey ?? null;
    this.ClaudeCodeBaseURL = init.ClaudeCodeBaseURL ?? null;
    this.ClaudeCodeModels = init.ClaudeCodeModels ?? null;
    this.AgentCLICredentials = init.AgentCLICredentials ?? null;
    this.AssistantDefaults = init.AssistantDefaults ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "user_configs";
  }
}

class gitSSHKeyRow {
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Host = init.Host ?? "";
    this.PrivateKey = init.PrivateKey ?? "";
  }

  TableName() {
    return "user_git_ssh_keys";
  }
}

class gitHTTPCredentialRow {
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Platform = init.Platform ?? "";
    this.Host = init.Host ?? "";
    this.Username = init.Username ?? "";
    this.Token = init.Token ?? "";
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "user_git_http_credentials";
  }
}

class apiTokenRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Name = init.Name ?? "";
    this.Prefix = init.Prefix ?? "";
    this.TokenHash = init.TokenHash ?? "";
    this.LastUsedAt = init.LastUsedAt ?? null;
    this.ExpiresAt = init.ExpiresAt ?? null;
    this.Created = init.Created ?? null;
    this.RevokedAt = init.RevokedAt ?? null;
  }

  TableName() {
    return "api_tokens";
  }
}

class projectRow {
  constructor(init = {}) {
    this.BusinessDomainID = init.BusinessDomainID ?? "";
    this.ID = init.ID ?? "";
    this.ProjectKey = init.ProjectKey ?? "";
    this.Name = init.Name ?? "";
    this.OwnerUserID = init.OwnerUserID ?? null;
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "projects";
  }
}

class projectMemberRow {
  constructor(init = {}) {
    this.ProjectID = init.ProjectID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Role = init.Role ?? "";
    this.Created = init.Created ?? null;
  }

  TableName() {
    return "project_members";
  }
}

class repositoryRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "repositories";
  }
}

class agentRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "agents";
  }
}

class ruleRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "rules";
  }
}

class skillRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "skills";
  }
}

// skillFileRow：单个二进制技能文件，内容存 MEDIUMBLOB 列，不进 skills payload JSON。
class skillFileRow {
  constructor(init = {}) {
    this.SkillID = init.SkillID ?? "";
    this.Path = init.Path ?? "";
    this.Content = init.Content ?? null;
    this.Size = init.Size ?? 0;
    this.SHA256 = init.SHA256 ?? "";
    this.UnixMode = init.UnixMode ?? 0;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "skill_files";
  }
}

class mcpFileRow {
  constructor(init = {}) {
    this.MCPID = init.MCPID ?? "";
    this.Path = init.Path ?? "";
    this.Content = init.Content ?? null;
    this.Size = init.Size ?? 0;
    this.SHA256 = init.SHA256 ?? "";
    this.UnixMode = init.UnixMode ?? 0;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "mcp_files";
  }
}

class mcpServerRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "mcp_servers";
  }
}

class executorRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Kind = init.Kind ?? "";
    this.Payload = init.Payload ?? null;
  }

  TableName() {
    return "executors";
  }
}

class sandboxRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
  }

  TableName() {
    return "sandboxes";
  }
}

class workflowRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Version = init.Version ?? 0;
    this.Revision = init.Revision ?? 0;
    this.Status = init.Status ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "workflows";
  }
}

class syncConfigRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Payload = init.Payload ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "sync_config";
  }
}

class scheduleJobRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Enabled = init.Enabled ?? 0;
    this.Payload = init.Payload ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "schedule_jobs";
  }
}

// scheduleJobExecutionRow：一次定时任务执行，索引列与 payload 镜像，便于过滤。
class scheduleJobExecutionRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.JobID = init.JobID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.TraceID = init.TraceID ?? "";
    this.Status = init.Status ?? "";
    this.Payload = init.Payload ?? null;
    this.Started = init.Started ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "schedule_job_executions";
  }
}

// scheduleJobExecutionStatRow：一个任务在一小时内的已完成执行统计；行比单任务保留的 200 次执行活得久，仪表盘总览保持精确。
// Token 用量按每次执行完成时计价（一小时内混用多个模型，事后无法计价）。
class scheduleJobExecutionStatRow {
  constructor(init = {}) {
    this.JobID = init.JobID ?? "";
    this.BucketHour = init.BucketHour ?? null;
    this.ProjectID = init.ProjectID ?? "";
    this.Finished = init.Finished ?? 0;
    this.Success = init.Success ?? 0;
    this.Failed = init.Failed ?? 0;
    this.Timed = init.Timed ?? 0;
    this.DurationMs = init.DurationMs ?? 0;
    this.Metered = init.Metered ?? 0;
    this.TokensTotal = init.TokensTotal ?? 0;
    this.TokensInput = init.TokensInput ?? 0;
    this.TokensOutput = init.TokensOutput ?? 0;
    this.TokensCacheRead = init.TokensCacheRead ?? 0;
    this.TokensCacheWrite = init.TokensCacheWrite ?? 0;
    this.Priced = init.Priced ?? 0;
    this.CostUSD = init.CostUSD ?? 0;
  }

  TableName() {
    return "schedule_job_execution_stats";
  }
}

class sharedScheduleVersionRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.SharedTaskID = init.SharedTaskID ?? "";
    this.Version = init.Version ?? 0;
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
  }

  TableName() {
    return "shared_schedule_versions";
  }
}

class issueRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Number = init.Number ?? 0;
    this.Title = init.Title ?? "";
    this.Status = init.Status ?? "";
    this.Kind = init.Kind ?? "";
    this.Source = init.Source ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.AssigneeUserID = init.AssigneeUserID ?? null;
    this.ExternalID = init.ExternalID ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "issues";
  }
}

class issueCommentRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
  }

  TableName() {
    return "issue_comments";
  }
}

class taskRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.RunID = init.RunID ?? "";
    this.Status = init.Status ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "tasks";
  }
}

class runRow {
  constructor(init = {}) {
    this.Kind = init.Kind ?? "";
    this.ID = init.ID ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.Status = init.Status ?? "";
    this.QuotaBucket = init.QuotaBucket ?? null;
    this.QuotaProjectID = init.QuotaProjectID ?? null;
    this.QuotaParentRunID = init.QuotaParentRunID ?? null;
    this.QuotaExempt = init.QuotaExempt ?? null;
    this.AdmissionState = init.AdmissionState ?? "";
    this.QueueEntered = init.QueueEntered ?? null;
    this.Revision = init.Revision ?? 0;
    this.Input = init.Input ?? "";
    this.HumanContext = init.HumanContext ?? "";
    this.CancelRequested = init.CancelRequested ?? false;
    this.PauseRequested = init.PauseRequested ?? false;
    this.SandboxID = init.SandboxID ?? "";
    this.Repositories = init.Repositories ?? null;
    this.Repository = init.Repository ?? null;
    this.Snapshot = init.Snapshot ?? null;
    this.ExecutionContext = init.ExecutionContext ?? null;
    this.UsageJSON = init.UsageJSON ?? null;
    this.ToolCalls = init.ToolCalls ?? 0;
    this.TelemetrySequence = init.TelemetrySequence ?? 0;
    this.LogSequence = init.LogSequence ?? 0;
    this.OwnerInstanceID = init.OwnerInstanceID ?? "";
    this.LeaseUntil = init.LeaseUntil ?? null;
    this.Generation = init.Generation ?? 0;
    this.WorkspaceHost = init.WorkspaceHost ?? "";
    this.WorkspaceRoot = init.WorkspaceRoot ?? "";
    this.WorkspaceEditorID = init.WorkspaceEditorID ?? 0;
    this.WorkspaceEditUntil = init.WorkspaceEditUntil ?? null;
    this.WorkspaceCleaned = init.WorkspaceCleaned ?? null;
    this.CleanupNotBefore = init.CleanupNotBefore ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "runs";
  }
}

class runNodeRow {
  constructor(init = {}) {
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Status = init.Status ?? "";
    this.Attempt = init.Attempt ?? 0;
    this.Payload = init.Payload ?? null;
  }

  TableName() {
    return "run_nodes";
  }
}

class runEventRow {
  constructor(init = {}) {
    this.RunID = init.RunID ?? "";
    this.Seq = init.Seq ?? 0;
    this.EventID = init.EventID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Type = init.Type ?? "";
    this.Message = init.Message ?? "";
    this.Payload = init.Payload ?? null;
    this.Ts = init.Ts ?? null;
  }

  TableName() {
    return "run_events";
  }
}

class runTelemetryRow {
  constructor(init = {}) {
    this.RunID = init.RunID ?? "";
    this.Seq = init.Seq ?? 0;
    this.Payload = init.Payload ?? null;
  }

  TableName() {
    return "run_telemetry";
  }
}

class runLogRow {
  constructor(init = {}) {
    this.RunID = init.RunID ?? "";
    this.Seq = init.Seq ?? 0;
    this.Payload = init.Payload ?? null;
  }

  TableName() {
    return "run_logs";
  }
}

class runArtifactRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Attempt = init.Attempt ?? 0;
    this.Name = init.Name ?? "";
    this.Path = init.Path ?? "";
    this.MediaType = init.MediaType ?? "";
    this.SizeBytes = init.SizeBytes ?? 0;
    this.SHA256 = init.SHA256 ?? "";
    this.RepositoryDir = init.RepositoryDir ?? "";
    this.Content = init.Content ?? "";
    this.Created = init.Created ?? null;
  }

  TableName() {
    return "run_artifacts";
  }
}

class runEvalRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.RunID = init.RunID ?? "";
    this.Status = init.Status ?? "";
    this.Score = init.Score ?? 0;
    this.Passed = init.Passed ?? false;
    this.Model = init.Model ?? "";
    this.CreatedBy = init.CreatedBy ?? 0;
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Finished = init.Finished ?? null;
  }

  TableName() {
    return "run_evals";
  }
}

class runPreviewRow {
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
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "run_previews";
  }
}

class previewSessionRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.PreviewID = init.PreviewID ?? "";
    this.TokenHash = init.TokenHash ?? "";
    this.BackendURL = init.BackendURL ?? "";
    this.ExpiresAt = init.ExpiresAt ?? null;
    this.Created = init.Created ?? null;
    this.LastAccessedAt = init.LastAccessedAt ?? null;
    this.RevokedAt = init.RevokedAt ?? null;
  }

  TableName() {
    return "preview_sessions";
  }
}

class previewBlobRow {
  constructor(init = {}) {
    this.SHA256 = init.SHA256 ?? "";
    this.Content = init.Content ?? null;
    this.Size = init.Size ?? 0;
    this.Created = init.Created ?? null;
  }

  TableName() {
    return "preview_blobs";
  }
}

class mrDeliveryStateRow {
  constructor(init = {}) {
    this.MRProject = init.MRProject ?? "";
    this.MRIID = init.MRIID ?? 0;
    this.MRURL = init.MRURL ?? "";
    this.State = init.State ?? "";
    this.TargetBranch = init.TargetBranch ?? "";
    this.IssueID = init.IssueID ?? "";
    this.MergedAt = init.MergedAt ?? null;
    this.CheckedAt = init.CheckedAt ?? null;
    this.RegisteredBy = init.RegisteredBy ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "mr_delivery_states";
  }
}

class definitionRevisionRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Kind = init.Kind ?? "";
    this.EntityID = init.EntityID ?? "";
    this.Version = init.Version ?? 0;
    this.Revision = init.Revision ?? 0;
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
  }

  TableName() {
    return "definition_revisions";
  }
}

class runnerRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Status = init.Status ?? "";
    this.OS = init.OS ?? "";
    this.Arch = init.Arch ?? "";
    this.RunnerVersion = init.RunnerVersion ?? "";
    this.NativeSandboxAvailable = init.NativeSandboxAvailable ?? false;
    this.Labels = init.Labels ?? null;
    this.MaxConcurrency = init.MaxConcurrency ?? 0;
    this.RunLimit = init.RunLimit ?? null;
    this.OwnerUserID = init.OwnerUserID ?? null;
    this.SessionTokenHash = init.SessionTokenHash ?? "";
    this.SessionExpiresAt = init.SessionExpiresAt ?? null;
    this.Runtimes = init.Runtimes ?? null;
    this.LastSeenAt = init.LastSeenAt ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "runners";
  }
}

class runnerTaskRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.RunnerID = init.RunnerID ?? "";
    this.Provider = init.Provider ?? "";
    this.Status = init.Status ?? "";
    this.LeaseOwner = init.LeaseOwner ?? "";
    this.LeaseUntil = init.LeaseUntil ?? null;
    this.DesiredState = init.DesiredState ?? "";
    this.Attempt = init.Attempt ?? 0;
    this.MaxAttempts = init.MaxAttempts ?? 0;
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "runner_tasks";
  }
}

class runnerTaskEventRow {
  constructor(init = {}) {
    this.TaskID = init.TaskID ?? "";
    this.Seq = init.Seq ?? 0;
    this.Type = init.Type ?? "";
    this.Data = init.Data ?? "";
    this.Ts = init.Ts ?? null;
  }

  TableName() {
    return "runner_task_events";
  }
}

class userRunnerPrefRow {
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.DefaultRunnerID = init.DefaultRunnerID ?? "";
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "user_runner_prefs";
  }
}

// assistantPreferenceRow：缺行表示开关全关、消息排队、会话工作区沙箱由 agent 自选。
class assistantPreferenceRow {
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.ProactiveRoles = init.ProactiveRoles ?? false;
    this.ProactiveSOPs = init.ProactiveSOPs ?? false;
    this.SteerOnSend = init.SteerOnSend ?? false;
    this.WorkspaceDriver = init.WorkspaceDriver ?? "";
    this.Instructions = init.Instructions ?? "";
    this.ApprovalReviewMode = init.ApprovalReviewMode ?? "";
    this.ApprovalReviewModel = init.ApprovalReviewModel ?? "";
    this.ApprovalReviewAPI = init.ApprovalReviewAPI ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  TableName() {
    return "assistant_preferences";
  }
}

class assistantSessionRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.UserID = init.UserID ?? 0;
    this.ProjectID = init.ProjectID ?? "";
    this.Title = init.Title ?? "";
    this.Model = init.Model ?? "";
    this.Source = init.Source ?? "";
    this.TaskID = init.TaskID ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "assistant_sessions";
  }
}

class assistantTaskRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.UserID = init.UserID ?? 0;
    this.ProjectID = init.ProjectID ?? "";
    this.Name = init.Name ?? "";
    this.Enabled = init.Enabled ?? 0;
    this.IntervalSec = init.IntervalSec ?? 0;
    this.LastRunAt = init.LastRunAt ?? null;
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "assistant_tasks";
  }
}

class engineInstanceRow {
  constructor(init = {}) {
    this.InstanceID = init.InstanceID ?? "";
    this.Role = init.Role ?? "";
    this.ControlURL = init.ControlURL ?? "";
    this.WorkspaceHost = init.WorkspaceHost ?? "";
    this.HeartbeatAt = init.HeartbeatAt ?? null;
    this.LeaseUntil = init.LeaseUntil ?? null;
  }

  TableName() {
    return "engine_instances";
  }
}

class genericTemplateRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "generic_templates";
  }
}

class chatRoomRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Name = init.Name ?? "";
    this.CreatedBy = init.CreatedBy ?? 0;
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "chat_rooms";
  }
}

class chatMessageRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.RoomID = init.RoomID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Kind = init.Kind ?? "";
    this.IssueID = init.IssueID ?? "";
    // ThreadID 为空表示主时间线。
    this.ThreadID = init.ThreadID ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
  }

  TableName() {
    return "chat_messages";
  }
}

class requirementSpaceRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "requirement_spaces";
  }
}

class spaceMemberRow {
  constructor(init = {}) {
    this.SpaceID = init.SpaceID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
  }

  TableName() {
    return "space_members";
  }
}

class spaceArtifactRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.SpaceID = init.SpaceID ?? "";
    this.Kind = init.Kind ?? "";
    this.Version = init.Version ?? 0;
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "space_artifacts";
  }
}

class spaceArtifactRevisionRow {
  constructor(init = {}) {
    this.ArtifactID = init.ArtifactID ?? "";
    this.Version = init.Version ?? 0;
    this.SpaceID = init.SpaceID ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
  }

  TableName() {
    return "space_artifact_revisions";
  }
}

class spaceThreadRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.SpaceID = init.SpaceID ?? "";
    this.RunID = init.RunID ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
  }

  TableName() {
    return "space_threads";
  }
}

// knowledgeSettingsRow：上游 token 单独成列，payload 可记日志、做 diff 而不泄漏凭据。
class knowledgeSettingsRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Payload = init.Payload ?? null;
    this.Token = init.Token ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "knowledge_settings";
  }
}

class knowledgeSubmissionRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.RunID = init.RunID ?? "";
    this.ArtifactID = init.ArtifactID ?? "";
    this.Status = init.Status ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "knowledge_submissions";
  }
}

// allModels lists every table for the sqlite test schema (AutoMigrate).
function allModels() {
  return [new BotUserBinding(), new BotBindingChallenge(), new BotConnection(), new BotConversation(), new BotInteraction(), new notificationBotRow(), new botCredentialRow(), new NotificationDelivery(),
    new userRow(), new localAccountRow(), new userConfigRow(), new gitSSHKeyRow(), new gitHTTPCredentialRow(), new authIntegrationRow(), new platformCodeBuddyKeyRow(), new apiTokenRow(), new genericTemplateRow(),
    new insightSourceRow(), new insightExecutionRow(),
    new projectRow(), new projectMemberRow(), new repositoryRow(), new businessDomainRow(), new businessDomainAssignmentRow(),
    new agentRow(), new ruleRow(), new skillRow(), new skillFileRow(), new mcpServerRow(), new mcpFileRow(), new executorRow(),
    new sandboxRow(),
    new workflowRow(), new syncConfigRow(), new scheduleJobRow(), new scheduleJobExecutionRow(), new scheduleJobExecutionStatRow(), new sharedScheduleVersionRow(),
    new issueRow(), new issueCommentRow(), new taskRow(),
    new runAdmissionLockRow(), new runRow(), new runNodeRow(), new runEventRow(), new runTelemetryRow(), new runLogRow(), new runArtifactRow(), new runEvalRow(),
    new runPreviewRow(), new previewSessionRow(), new previewBlobRow(), new WorkspaceCheckpoint(), new workspaceCheckpointChunk(),
    new mrDeliveryStateRow(), new definitionRevisionRow(),
    new runnerRow(), new runnerTaskRow(), new runnerTaskEventRow(), new userRunnerPrefRow(),
    new assistantSessionRow(), new assistantTaskRow(), new assistantGenerationRow(), new assistantSessionReadRow(), new assistantPreferenceRow(), new assistantDiagnosticsRow(),
    new chatRoomRow(), new chatMessageRow(),
    new requirementSpaceRow(), new spaceMemberRow(), new spaceArtifactRow(), new spaceArtifactRevisionRow(), new spaceThreadRow(),
    new engineInstanceRow(),
    new knowledgeSettingsRow(), new knowledgeSubmissionRow(),
    new PlatformGitSSHHost(), new PlatformGitHTTPSHost(),
  ];
}

module.exports = { mysqlSyncConfigID, mysqlSeedMarkerID, userRow, userConfigRow, gitSSHKeyRow, gitHTTPCredentialRow, apiTokenRow, projectRow, projectMemberRow, repositoryRow, agentRow, ruleRow, skillRow, skillFileRow, mcpFileRow, mcpServerRow, executorRow, sandboxRow, workflowRow, syncConfigRow, scheduleJobRow, scheduleJobExecutionRow, scheduleJobExecutionStatRow, sharedScheduleVersionRow, issueRow, issueCommentRow, taskRow, runRow, runNodeRow, runEventRow, runTelemetryRow, runLogRow, runArtifactRow, runEvalRow, runPreviewRow, previewSessionRow, previewBlobRow, mrDeliveryStateRow, definitionRevisionRow, runnerRow, runnerTaskRow, runnerTaskEventRow, userRunnerPrefRow, assistantPreferenceRow, assistantSessionRow, assistantTaskRow, engineInstanceRow, genericTemplateRow, chatRoomRow, chatMessageRow, requirementSpaceRow, spaceMemberRow, spaceArtifactRow, spaceArtifactRevisionRow, spaceThreadRow, knowledgeSettingsRow, knowledgeSubmissionRow, allModels };
