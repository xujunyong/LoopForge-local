/**
 * @file internal/repo/models.js
 * 对应 Go 源文件：internal/repo/models.go
 *
 * 作用与职责边界：
 * 集中定义平台数据库物理表的 GORM 行模型（MySQL 生产库与 SQLite 测试库 AutoMigrate 共用），
 * 以及汇总全部物理表模型的 `allModels()` 函数。领域实体通常保存在 `payload` JSON 列中，
 * 仅用于查询过滤、排序或行锁的字段才提升为独立物理列；时间字段特意命名为 `Created`/`Updated`
 * （而非 `CreatedAt`/`UpdatedAt`），避免 GORM 自动填充，全部由写入方显式设置。
 * 不负责具体业务读写查询或增量迁移执行（见 `automigrate.js`）。
 *
 * 语法差异说明：
 * - GORM `struct` 标签直接略去；每个行结构体译为带 `constructor(init = {})` 与 `TableName()` 的类。
 * - 字段严格按 Go 零值初始化：字符串 `""`、数字 `0`、布尔 `false`、指针/`time.Time`/`[]byte` 载荷列 `null`。
 * - `allModels()` 引用的同包其他文件行模型采用函数内延迟 `require`，消除与 `run_admission.js`、`workspace_checkpoints.js`、`assistant_generations.js` 等文件的顶层循环依赖。
 */

"use strict";

const { BotUserBinding, BotBindingChallenge } = require("../domain/bot_identity.js"); // 对应 Go 的 domain.*，bot_identity.js 已翻译
const { BotConnection, BotConversation, BotInteraction } = require("../domain/bot_interaction.js"); // 对应 Go 的 domain.*，bot_interaction.js 已翻译
const { NotificationDelivery } = require("../domain/notification.js"); // 对应 Go 的 domain.NotificationDelivery，notification.js 已翻译

/** `sync_config` 表默认全局配置行主键 ID。 */
const mysqlSyncConfigID = "default";
/** MySQL 历史初始化标记行使用的保留整数 ID。 */
const mysqlSeedMarkerID = -1;

/**
 * 对应物理表 `users` 的平台用户行模型。
 */
class userRow {
  /**
   * 构造用户表行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"users"`。
   */
  TableName() {
    return "users";
  }
}

/**
 * 对应物理表 `user_configs` 的用户凭据与个人默认配置行模型。
 */
class userConfigRow {
  /**
   * 构造用户配置表行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"user_configs"`。
   */
  TableName() {
    return "user_configs";
  }
}

/**
 * 对应物理表 `user_git_ssh_keys` 的用户 Git SSH 私钥行模型。
 */
class gitSSHKeyRow {
  /**
   * 构造用户 Git SSH 密钥行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Host = init.Host ?? "";
    this.PrivateKey = init.PrivateKey ?? "";
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"user_git_ssh_keys"`。
   */
  TableName() {
    return "user_git_ssh_keys";
  }
}

/**
 * 对应物理表 `user_git_http_credentials` 的用户 Git HTTP/HTTPS 凭据行模型。
 */
class gitHTTPCredentialRow {
  /**
   * 构造用户 Git HTTP 凭据行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"user_git_http_credentials"`。
   */
  TableName() {
    return "user_git_http_credentials";
  }
}

/**
 * 对应物理表 `api_tokens` 的用户 API 访问令牌行模型。
 */
class apiTokenRow {
  /**
   * 构造 API 令牌行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"api_tokens"`。
   */
  TableName() {
    return "api_tokens";
  }
}

/**
 * 对应物理表 `projects` 的项目行模型。
 */
class projectRow {
  /**
   * 构造项目行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"projects"`。
   */
  TableName() {
    return "projects";
  }
}

/**
 * 对应物理表 `project_members` 的项目成员关联行模型。
 */
class projectMemberRow {
  /**
   * 构造项目成员行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ProjectID = init.ProjectID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Role = init.Role ?? "";
    this.Created = init.Created ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"project_members"`。
   */
  TableName() {
    return "project_members";
  }
}

/**
 * 对应物理表 `repositories` 的代码仓库行模型。
 */
class repositoryRow {
  /**
   * 构造代码仓库行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"repositories"`。
   */
  TableName() {
    return "repositories";
  }
}

/**
 * 对应物理表 `agents` 的角色（Agent）定义行模型。
 */
class agentRow {
  /**
   * 构造角色定义行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"agents"`。
   */
  TableName() {
    return "agents";
  }
}

/**
 * 对应物理表 `rules` 的规则定义行模型。
 */
class ruleRow {
  /**
   * 构造规则定义行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"rules"`。
   */
  TableName() {
    return "rules";
  }
}

/**
 * 对应物理表 `skills` 的技能定义行模型。
 */
class skillRow {
  /**
   * 构造技能定义行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"skills"`。
   */
  TableName() {
    return "skills";
  }
}

/**
 * 对应物理表 `skill_files` 的技能二进制文件行模型。
 * 文件正文存放在独立的 MEDIUMBLOB 列，避免二进制数据膨胀 `skills` 表的 JSON 载荷。
 */
class skillFileRow {
  /**
   * 构造技能二进制文件行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.SkillID = init.SkillID ?? "";
    this.Path = init.Path ?? "";
    this.Content = init.Content ?? null;
    this.Size = init.Size ?? 0;
    this.SHA256 = init.SHA256 ?? "";
    this.UnixMode = init.UnixMode ?? 0;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"skill_files"`。
   */
  TableName() {
    return "skill_files";
  }
}

/**
 * 对应物理表 `mcp_files` 的 stdio MCP 源码树二进制文件行模型。
 */
class mcpFileRow {
  /**
   * 构造 MCP 文件行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.MCPID = init.MCPID ?? "";
    this.Path = init.Path ?? "";
    this.Content = init.Content ?? null;
    this.Size = init.Size ?? 0;
    this.SHA256 = init.SHA256 ?? "";
    this.UnixMode = init.UnixMode ?? 0;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"mcp_files"`。
   */
  TableName() {
    return "mcp_files";
  }
}

/**
 * 对应物理表 `mcp_servers` 的 MCP 服务器定义行模型。
 */
class mcpServerRow {
  /**
   * 构造 MCP 服务器行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"mcp_servers"`。
   */
  TableName() {
    return "mcp_servers";
  }
}

/**
 * 对应物理表 `executors` 的执行器定义行模型。
 */
class executorRow {
  /**
   * 构造执行器行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Kind = init.Kind ?? "";
    this.Payload = init.Payload ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"executors"`。
   */
  TableName() {
    return "executors";
  }
}

/**
 * 对应物理表 `sandboxes` 的沙箱配置档案行模型。
 */
class sandboxRow {
  /**
   * 构造沙箱配置行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"sandboxes"`。
   */
  TableName() {
    return "sandboxes";
  }
}

/**
 * 对应物理表 `workflows` 的工作流（SOP）定义行模型。
 */
class workflowRow {
  /**
   * 构造工作流行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"workflows"`。
   */
  TableName() {
    return "workflows";
  }
}

/**
 * 对应物理表 `sync_config` 的外部跟踪器同步配置行模型。
 */
class syncConfigRow {
  /**
   * 构造同步配置行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Payload = init.Payload ?? null;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"sync_config"`。
   */
  TableName() {
    return "sync_config";
  }
}

/**
 * 对应物理表 `schedule_jobs` 的定时任务定义行模型。
 */
class scheduleJobRow {
  /**
   * 构造定时任务定义行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Enabled = init.Enabled ?? 0;
    this.Payload = init.Payload ?? null;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"schedule_jobs"`。
   */
  TableName() {
    return "schedule_jobs";
  }
}

/**
 * 对应物理表 `schedule_job_executions` 的单次定时任务执行记录行模型，索引列与 JSON 载荷镜像便于筛选。
 */
class scheduleJobExecutionRow {
  /**
   * 构造定时任务执行记录行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"schedule_job_executions"`。
   */
  TableName() {
    return "schedule_job_executions";
  }
}

/**
 * 对应物理表 `schedule_job_execution_stats` 的定时任务按 UTC 小时聚合统计行模型。
 * 该统计行生命周期长于单任务仅保留的最近 200 次执行记录，并在每次执行完成时实时计价以保证总览数据准确。
 */
class scheduleJobExecutionStatRow {
  /**
   * 构造定时任务小时统计行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"schedule_job_execution_stats"`。
   */
  TableName() {
    return "schedule_job_execution_stats";
  }
}

/**
 * 对应物理表 `shared_schedule_versions` 的共享定时任务版本快照行模型。
 */
class sharedScheduleVersionRow {
  /**
   * 构造共享定时任务版本行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.SharedTaskID = init.SharedTaskID ?? "";
    this.Version = init.Version ?? 0;
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"shared_schedule_versions"`。
   */
  TableName() {
    return "shared_schedule_versions";
  }
}

/**
 * 对应物理表 `issues` 的需求/缺陷工作项行模型。
 */
class issueRow {
  /**
   * 构造需求行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"issues"`。
   */
  TableName() {
    return "issues";
  }
}

/**
 * 对应物理表 `issue_comments` 的需求评论行模型。
 */
class issueCommentRow {
  /**
   * 构造需求评论行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"issue_comments"`。
   */
  TableName() {
    return "issue_comments";
  }
}

/**
 * 对应物理表 `tasks` 的跨实例幂等派发任务行模型。
 */
class taskRow {
  /**
   * 构造任务行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.RunID = init.RunID ?? "";
    this.Status = init.Status ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"tasks"`。
   */
  TableName() {
    return "tasks";
  }
}

/**
 * 对应物理表 `runs` 的工作流运行主表行模型，包含准入配额列、租约列、工作区列与各类 JSON 快照列。
 */
class runRow {
  /**
   * 构造运行主表行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"runs"`。
   */
  TableName() {
    return "runs";
  }
}

/**
 * 对应物理表 `run_nodes` 的运行节点状态行模型。
 */
class runNodeRow {
  /**
   * 构造运行节点行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Status = init.Status ?? "";
    this.Attempt = init.Attempt ?? 0;
    this.Payload = init.Payload ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"run_nodes"`。
   */
  TableName() {
    return "run_nodes";
  }
}

/**
 * 对应物理表 `run_events` 的运行事件流顺序行模型。
 */
class runEventRow {
  /**
   * 构造运行事件行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"run_events"`。
   */
  TableName() {
    return "run_events";
  }
}

/**
 * 对应物理表 `run_telemetry` 的运行遥测事件行模型。
 */
class runTelemetryRow {
  /**
   * 构造运行遥测行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.RunID = init.RunID ?? "";
    this.Seq = init.Seq ?? 0;
    this.Payload = init.Payload ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"run_telemetry"`。
   */
  TableName() {
    return "run_telemetry";
  }
}

/**
 * 对应物理表 `run_logs` 的运行日志流顺序行模型。
 */
class runLogRow {
  /**
   * 构造运行日志行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.RunID = init.RunID ?? "";
    this.Seq = init.Seq ?? 0;
    this.Payload = init.Payload ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"run_logs"`。
   */
  TableName() {
    return "run_logs";
  }
}

/**
 * 对应物理表 `run_artifacts` 的运行产物行模型。
 */
class runArtifactRow {
  /**
   * 构造运行产物行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"run_artifacts"`。
   */
  TableName() {
    return "run_artifacts";
  }
}

/**
 * 对应物理表 `run_evals` 的运行质量评估记录行模型。
 */
class runEvalRow {
  /**
   * 构造运行评估行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"run_evals"`。
   */
  TableName() {
    return "run_evals";
  }
}

/**
 * 对应物理表 `run_previews` 的运行构建产物预览元数据行模型。
 */
class runPreviewRow {
  /**
   * 构造运行预览行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"run_previews"`。
   */
  TableName() {
    return "run_previews";
  }
}

/**
 * 对应物理表 `preview_sessions` 的预览访问会话令牌行模型。
 */
class previewSessionRow {
  /**
   * 构造预览会话行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"preview_sessions"`。
   */
  TableName() {
    return "preview_sessions";
  }
}

/**
 * 对应物理表 `preview_blobs` 的预览压缩包/截图内容寻址二进制块行模型。
 */
class previewBlobRow {
  /**
   * 构造预览二进制块行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.SHA256 = init.SHA256 ?? "";
    this.Content = init.Content ?? null;
    this.Size = init.Size ?? 0;
    this.Created = init.Created ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"preview_blobs"`。
   */
  TableName() {
    return "preview_blobs";
  }
}

/**
 * 对应物理表 `mr_delivery_states` 的 MR 交付追踪状态行模型。
 */
class mrDeliveryStateRow {
  /**
   * 构造 MR 交付状态行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"mr_delivery_states"`。
   */
  TableName() {
    return "mr_delivery_states";
  }
}

/**
 * 对应物理表 `definition_revisions` 的目录资产历史版本快照行模型。
 */
class definitionRevisionRow {
  /**
   * 构造定义修订快照行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"definition_revisions"`。
   */
  TableName() {
    return "definition_revisions";
  }
}

/**
 * 对应物理表 `runners` 的 CLI 执行机注册信息行模型。
 */
class runnerRow {
  /**
   * 构造执行机行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"runners"`。
   */
  TableName() {
    return "runners";
  }
}

/**
 * 对应物理表 `runner_tasks` 的执行机派发任务行模型。
 */
class runnerTaskRow {
  /**
   * 构造执行机任务行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"runner_tasks"`。
   */
  TableName() {
    return "runner_tasks";
  }
}

/**
 * 对应物理表 `runner_task_events` 的执行机任务事件流顺序行模型。
 */
class runnerTaskEventRow {
  /**
   * 构造执行机任务事件行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.TaskID = init.TaskID ?? "";
    this.Seq = init.Seq ?? 0;
    this.Type = init.Type ?? "";
    this.Data = init.Data ?? "";
    this.Ts = init.Ts ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"runner_task_events"`。
   */
  TableName() {
    return "runner_task_events";
  }
}

/**
 * 对应物理表 `user_runner_prefs` 的用户默认执行机偏好行模型。
 */
class userRunnerPrefRow {
  /**
   * 构造用户执行机偏好行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.DefaultRunnerID = init.DefaultRunnerID ?? "";
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"user_runner_prefs"`。
   */
  TableName() {
    return "user_runner_prefs";
  }
}

/**
 * 对应物理表 `assistant_preferences` 的 Studio 助手用户偏好行模型。
 * 缺行表示主动角色/SOP 开关全关、消息按序排队、会话工作区沙箱由助手自动选择。
 */
class assistantPreferenceRow {
  /**
   * 构造助手偏好行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"assistant_preferences"`。
   */
  TableName() {
    return "assistant_preferences";
  }
}

/**
 * 对应物理表 `assistant_sessions` 的 Studio 助手会话行模型。
 */
class assistantSessionRow {
  /**
   * 构造助手会话行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"assistant_sessions"`。
   */
  TableName() {
    return "assistant_sessions";
  }
}

/**
 * 对应物理表 `assistant_tasks` 的 Studio 助手定时提示词任务行模型。
 */
class assistantTaskRow {
  /**
   * 构造助手定时任务行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"assistant_tasks"`。
   */
  TableName() {
    return "assistant_tasks";
  }
}

/**
 * 对应物理表 `engine_instances` 的运行引擎实例心跳与租约行模型。
 */
class engineInstanceRow {
  /**
   * 构造引擎实例行对象，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.InstanceID = init.InstanceID ?? "";
    this.Role = init.Role ?? "";
    this.ControlURL = init.ControlURL ?? "";
    this.WorkspaceHost = init.WorkspaceHost ?? "";
    this.HeartbeatAt = init.HeartbeatAt ?? null;
    this.LeaseUntil = init.LeaseUntil ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"engine_instances"`。
   */
  TableName() {
    return "engine_instances";
  }
}

/**
 * 对应物理表 `generic_templates` 的平台通用工作流模板行模型。
 */
class genericTemplateRow {
  /**
   * 构造通用模板行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Payload = init.Payload ?? null;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"generic_templates"`。
   */
  TableName() {
    return "generic_templates";
  }
}

/**
 * 对应物理表 `chat_rooms` 的项目协作群聊房间行模型。
 */
class chatRoomRow {
  /**
   * 构造群聊房间行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Name = init.Name ?? "";
    this.CreatedBy = init.CreatedBy ?? 0;
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"chat_rooms"`。
   */
  TableName() {
    return "chat_rooms";
  }
}

/**
 * 对应物理表 `chat_messages` 的项目协作群聊消息行模型。
 */
class chatMessageRow {
  /**
   * 构造群聊消息行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.RoomID = init.RoomID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Kind = init.Kind ?? "";
    this.IssueID = init.IssueID ?? "";
    // ThreadID 为空字符串表示属于房间主时间线。
    this.ThreadID = init.ThreadID ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"chat_messages"`。
   */
  TableName() {
    return "chat_messages";
  }
}

/**
 * 对应物理表 `requirement_spaces` 的需求协作空间行模型。
 */
class requirementSpaceRow {
  /**
   * 构造需求空间行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.IssueID = init.IssueID ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"requirement_spaces"`。
   */
  TableName() {
    return "requirement_spaces";
  }
}

/**
 * 对应物理表 `space_members` 的需求空间成员关联行模型。
 */
class spaceMemberRow {
  /**
   * 构造空间成员行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.SpaceID = init.SpaceID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"space_members"`。
   */
  TableName() {
    return "space_members";
  }
}

/**
 * 对应物理表 `space_artifacts` 的需求空间版本化产物行模型。
 */
class spaceArtifactRow {
  /**
   * 构造空间产物行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.SpaceID = init.SpaceID ?? "";
    this.Kind = init.Kind ?? "";
    this.Version = init.Version ?? 0;
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"space_artifacts"`。
   */
  TableName() {
    return "space_artifacts";
  }
}

/**
 * 对应物理表 `space_artifact_revisions` 的需求空间产物历史修订行模型。
 */
class spaceArtifactRevisionRow {
  /**
   * 构造空间产物修订行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ArtifactID = init.ArtifactID ?? "";
    this.Version = init.Version ?? 0;
    this.SpaceID = init.SpaceID ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"space_artifact_revisions"`。
   */
  TableName() {
    return "space_artifact_revisions";
  }
}

/**
 * 对应物理表 `space_threads` 的需求空间会话线程行模型。
 */
class spaceThreadRow {
  /**
   * 构造空间线程行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.SpaceID = init.SpaceID ?? "";
    this.RunID = init.RunID ?? "";
    this.Payload = init.Payload ?? null;
    this.Created = init.Created ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"space_threads"`。
   */
  TableName() {
    return "space_threads";
  }
}

/**
 * 对应物理表 `knowledge_settings` 的平台知识库配置行模型。
 * 上游令牌存放在独立的 `token` 列，使 JSON 载荷可安全记录日志或做差异比对而不泄漏凭据。
 */
class knowledgeSettingsRow {
  /**
   * 构造知识库配置行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Payload = init.Payload ?? null;
    this.Token = init.Token ?? null;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"knowledge_settings"`。
   */
  TableName() {
    return "knowledge_settings";
  }
}

/**
 * 对应物理表 `knowledge_submissions` 的知识蒸馏投稿队列行模型。
 */
class knowledgeSubmissionRow {
  /**
   * 构造知识投稿行实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 返回 GORM 映射使用的物理表名。
   *
   * @returns {string} 物理表名 `"knowledge_submissions"`。
   */
  TableName() {
    return "knowledge_submissions";
  }
}

/**
 * 返回全部物理表对应的模型实例列表，供增量 DDL 迁移（`autoMigrateIncremental`）与 SQLite 测试库初始化使用。
 * 同包其他文件定义的行模型在此处延迟引入，避免与反向引用 `models.js` 的模块产生顶层循环依赖。
 *
 * @returns {Object[]} 全部 78 张物理表对应的模型空实例数组。
 */
function allModels() {
  const { notificationBotRow } = require("./notifications.js"); // 对应 Go 同包类型，notifications.js 已翻译
  const { botCredentialRow } = require("./bot_credentials.js"); // 对应 Go 同包类型，bot_credentials.js 已翻译
  const { localAccountRow } = require("./local_accounts.js"); // 对应 Go 同包类型，local_accounts.js 已翻译
  const { authIntegrationRow } = require("./auth_integration.js"); // 对应 Go 同包类型，auth_integration.js 已翻译
  const { platformCodeBuddyKeyRow } = require("./codebuddy_sponsor.js"); // 对应 Go 同包类型，codebuddy_sponsor.js 已翻译
  const { insightSourceRow, insightExecutionRow } = require("./insights.js"); // 对应 Go 同包类型，insights.js 已翻译
  const { businessDomainRow, businessDomainAssignmentRow } = require("./business_domains.js"); // 对应 Go 同包类型，business_domains.js 已翻译
  const { runAdmissionLockRow } = require("./run_admission.js"); // 对应 Go 同包类型，run_admission.js 已翻译
  const { WorkspaceCheckpoint } = require("./workspace_checkpoints.js"); // 对应 Go 同包类型，workspace_checkpoints.js 已翻译
  const { workspaceCheckpointChunk } = require("./workspace_checkpoint_chunks.js"); // 对应 Go 同包类型，workspace_checkpoint_chunks.js 已翻译
  const { assistantGenerationRow } = require("./assistant_generations.js"); // 对应 Go 同包类型，assistant_generations.js 已翻译
  const { assistantSessionReadRow } = require("./assistant_session_reads.js"); // 对应 Go 同包类型，assistant_session_reads.js 已翻译
  const { assistantDiagnosticsRow } = require("./assistant_diagnostics.js"); // 对应 Go 同包类型，assistant_diagnostics.js 已翻译
  const { PlatformGitSSHHost } = require("./ssh_host_trust.js"); // 对应 Go 同包类型，ssh_host_trust.js 已翻译
  const { PlatformGitHTTPSHost } = require("./git_https_hosts.js"); // 对应 Go 同包类型，git_https_hosts.js 已翻译

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
