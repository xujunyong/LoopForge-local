// operations.js —— 对应 Go 文件：internal/application/operations.go
// 作用与职责边界：定义对外公开的 HTTP 与 MCP 能力描述结构（Operation）及标准能力清单
// （PublicOperations），供能力发现端点和 MCP 工具注册复用；有意排除内部 worker 信号、
// OTLP 上报、租约与沙箱维护等内部端点。

"use strict";

/**
 * 对外暴露给 HTTP 与 MCP 的单个用户可见能力定义（对应 Go 的 application.Operation）。
 * 路径参数采用 {name} 占位形式，独立于查询参数与 JSON 请求体传入。
 */
class Operation {
  /**
   * 构造操作定义实例，字段按 Go 零值初始化。
   * 使用场景：PublicOperations 构建公开能力清单时使用。
   * @param {{
   *   Name?: string,
   *   Description?: string,
   *   Method?: string,
   *   Path?: string,
   *   ReadOnly?: boolean
   * }} [init={}] - 初始化字段对象（Name 操作标识、Description 说明、Method HTTP 方法、Path 路由路径、ReadOnly 是否只读）。
   */
  constructor(init = {}) {
    this.Name = init.Name ?? "";
    this.Description = init.Description ?? "";
    this.Method = init.Method ?? "";
    this.Path = init.Path ?? "";
    this.ReadOnly = init.ReadOnly ?? false;
  }
}

/**
 * 返回平台标准对外公开的 HTTP / MCP 能力清单（共 111 项）。
 * 使用场景：/api/capabilities 能力接口与 MCP Server 生成公开工具列表时调用。
 * @returns {Operation[]} 公开能力定义对象数组。
 */
function PublicOperations() {
  return [
    new Operation({ Name: "health_get", Description: "Check LoopForge service health", Method: "GET", Path: "/api/health", ReadOnly: true }),
    new Operation({ Name: "capabilities_get", Description: "List public API and MCP operations", Method: "GET", Path: "/api/capabilities", ReadOnly: true }),
    new Operation({ Name: "openapi_get", Description: "Read the LoopForge OpenAPI 3.1 contract", Method: "GET", Path: "/api/openapi.yaml", ReadOnly: true }),
    new Operation({ Name: "bootstrap_get", Description: "Get the Studio bootstrap catalog", Method: "GET", Path: "/api/bootstrap", ReadOnly: true }),
    new Operation({ Name: "business_domains_list", Description: "List managed business domains with the caller's permissions", Method: "GET", Path: "/api/business-domains", ReadOnly: true }),
    new Operation({ Name: "business_domains_save", Description: "Manage a business domain. Platform admins control lifecycle and managers; domain managers control information and viewers.", Method: "PUT", Path: "/api/business-domains" }),
    new Operation({ Name: "business_domain_report", Description: "Get authorized aggregate reporting by current project attribution. Query: businessDomainId (all/unclassified/domain ID), from, to (RFC3339), grain (day/week/month).", Method: "GET", Path: "/api/business-domain-report", ReadOnly: true }),
    new Operation({ Name: "project_business_domain_assign", Description: "Set a project's main business domain with expectedDomainId and reason. Owners assign unclassified projects; admins may transfer or clear attribution.", Method: "PUT", Path: "/api/projects/{id}/business-domain" }),
    new Operation({ Name: "project_business_domain_history", Description: "Read the last 100 project attribution changes (project owner or platform admin)", Method: "GET", Path: "/api/projects/{id}/business-domain/history", ReadOnly: true }),
    new Operation({ Name: "projects_list", Description: "List projects with secrets redacted", Method: "GET", Path: "/api/projects", ReadOnly: true }),
    new Operation({ Name: "projects_save", Description: "Create or update a project. A new project saved without workflowId is bound to generic-backend-delivery (the generic backend delivery SOP); pass workflowId to choose generic-product-delivery, generic-frontend-delivery or another SOP.", Method: "PUT", Path: "/api/projects" }),
    new Operation({ Name: "projects_get", Description: "Get one project with secrets redacted", Method: "GET", Path: "/api/projects/{id}", ReadOnly: true }),
    new Operation({ Name: "projects_delete", Description: "Delete a project (owner or platform admin). It is archived: hidden from lists, requirements/runs/settings kept, id stays taken, restorable with projects_restore. Fails while it has unfinished runs or enabled schedule jobs.", Method: "DELETE", Path: "/api/projects/{id}" }),
    new Operation({ Name: "projects_restore", Description: "Restore a deleted project (owner or platform admin)", Method: "POST", Path: "/api/projects/{id}/restore" }),
    new Operation({ Name: "repositories_list", Description: "List repositories with secrets redacted", Method: "GET", Path: "/api/repositories", ReadOnly: true }),
    new Operation({ Name: "repositories_save", Description: "Create or update a GitHub repository. Pass projectId and a GitHub web/SSH/clone repoUrl; name and repository identity are derived automatically. integrateBranch is optional; empty skips SOP merge-conflict checks.", Method: "PUT", Path: "/api/repositories" }),
    new Operation({ Name: "repositories_delete", Description: "Delete a repository", Method: "DELETE", Path: "/api/repositories" }),
    new Operation({ Name: "repositories_get", Description: "Get one repository with secrets redacted", Method: "GET", Path: "/api/repositories/{id}", ReadOnly: true }),
    new Operation({ Name: "issues_list", Description: "List issues and requirements. Query: projectId, status, source, q, limit, offset. Omit limit to get Issue[]; with limit returns {items,total,offset,limit,hasMore} (max 200).", Method: "GET", Path: "/api/issues", ReadOnly: true }),
    new Operation({ Name: "issues_save", Description: "Create or update an issue or requirement", Method: "PUT", Path: "/api/issues" }),
    new Operation({ Name: "issues_get", Description: "Get one issue and its comments", Method: "GET", Path: "/api/issues/{id}", ReadOnly: true }),
    new Operation({ Name: "issues_delete", Description: "Delete a local issue. Query force=true also deletes settled execution history, including successful runs, and is required for issues with history or a completed status. Active work blocks deletion.", Method: "DELETE", Path: "/api/issues/{id}" }),
    new Operation({ Name: "issues_comments_add", Description: "Add a comment to an issue", Method: "POST", Path: "/api/issues/{id}/comments" }),
    new Operation({ Name: "issues_runs_list", Description: "List runs belonging to an issue", Method: "GET", Path: "/api/issues/{id}/runs", ReadOnly: true }),
    new Operation({ Name: "issues_chat_clarify", Description: "Run AI clarification for an existing issue. The job keeps running after the client disconnects; GET the same path with Accept: text/event-stream to resume SSE.", Method: "POST", Path: "/api/issues/{id}/chat-clarify" }),
    new Operation({ Name: "issues_chat_clarify_stream", Description: "Attach to an in-flight issue clarification SSE stream", Method: "GET", Path: "/api/issues/{id}/chat-clarify", ReadOnly: true }),
    new Operation({ Name: "issues_chat_clarify_cancel", Description: "Cancel one issue's in-flight AI clarification", Method: "POST", Path: "/api/issues/{id}/chat-clarify/cancel" }),
    new Operation({ Name: "issues_clarification_save", Description: "Save an existing work-item clarification and write it back to its external source", Method: "POST", Path: "/api/issues/{id}/clarification" }),
    new Operation({ Name: "issues_reopen", Description: "Reopen a delivered issue", Method: "POST", Path: "/api/issues/{id}/reopen" }),
    new Operation({ Name: "issues_dispatch", Description: "Dispatch or rerun the issue's SOP", Method: "POST", Path: "/api/issues/{id}/dispatch" }),
    new Operation({ Name: "issues_import_tapd", Description: "Import one TAPD story, bug or task from a URL or shared title and link. Requires repositoryIds; optional workflowId binds SOP; repositoryBranches maps bound repository IDs to existing work branches to continue directly; single-repository clients may use baseBranch. Empty or unlisted branches create new work branches from each configured main branch; continuing branches always target that repository's configured main branch for MRs.", Method: "POST", Path: "/api/issues/import-tapd" }),
    new Operation({ Name: "clarification_chat", Description: "Run AI clarification before an issue exists", Method: "POST", Path: "/api/chat-clarify" }),
    new Operation({ Name: "clarification_cancel", Description: "Cancel an active AI clarification", Method: "POST", Path: "/api/chat-clarify/cancel" }),
    new Operation({ Name: "tasks_list", Description: "List execution tasks", Method: "GET", Path: "/api/tasks", ReadOnly: true }),
    new Operation({ Name: "tasks_get", Description: "Get one execution task", Method: "GET", Path: "/api/tasks/{id}", ReadOnly: true }),
    new Operation({ Name: "agents_list", Description: "List Agent definitions", Method: "GET", Path: "/api/agents", ReadOnly: true }),
    new Operation({ Name: "agents_save", Description: "Create or update an Agent definition", Method: "PUT", Path: "/api/agents" }),
    new Operation({ Name: "agents_get", Description: "Get one Agent definition", Method: "GET", Path: "/api/agents/{id}", ReadOnly: true }),
    new Operation({ Name: "agents_revisions_list", Description: "List Agent definition revisions", Method: "GET", Path: "/api/agents/{id}/revisions", ReadOnly: true }),
    new Operation({ Name: "agents_revision_get", Description: "Get one Agent definition revision", Method: "GET", Path: "/api/agents/{id}/revisions/{revisionId}", ReadOnly: true }),
    new Operation({ Name: "agents_revision_restore", Description: "Restore an Agent definition revision", Method: "POST", Path: "/api/agents/{id}/revisions/{revisionId}/restore" }),
    new Operation({ Name: "agents_delete", Description: "Delete an Agent definition that is not shared and not referenced by any workflow", Method: "DELETE", Path: "/api/agents/{id}" }),
    new Operation({ Name: "rules_list", Description: "List Rule assets", Method: "GET", Path: "/api/rules", ReadOnly: true }),
    new Operation({ Name: "rules_save", Description: "Create or update a Rule asset", Method: "PUT", Path: "/api/rules" }),
    new Operation({ Name: "rules_delete", Description: "Delete a Rule that is not shared and not referenced by any agent", Method: "DELETE", Path: "/api/rules" }),
    new Operation({ Name: "skills_list", Description: "List Skill assets", Method: "GET", Path: "/api/skills", ReadOnly: true }),
    new Operation({ Name: "skills_save", Description: "Create or update a Skill asset", Method: "PUT", Path: "/api/skills" }),
    new Operation({ Name: "skills_delete", Description: "Delete a Skill that is not shared and not referenced by any agent", Method: "DELETE", Path: "/api/skills" }),
    new Operation({ Name: "mcp_servers_list", Description: "List managed external MCP server assets", Method: "GET", Path: "/api/mcp-servers", ReadOnly: true }),
    new Operation({ Name: "mcp_servers_save", Description: "Create or update an external MCP server asset", Method: "PUT", Path: "/api/mcp-servers" }),
    new Operation({ Name: "mcp_servers_import", Description: "Import external MCP server definitions from JSON", Method: "POST", Path: "/api/mcp-servers/import" }),
    new Operation({ Name: "executors_list", Description: "List executor definitions", Method: "GET", Path: "/api/executors", ReadOnly: true }),
    new Operation({ Name: "executor_models_list", Description: "List the selectable model IDs, default model and reasoning-effort levels of each built-in CLI. Use a listed id as an Agent's model.", Method: "GET", Path: "/api/executor-models", ReadOnly: true }),
    new Operation({ Name: "sandboxes_list", Description: "List sandbox profiles with their Dockerfile (docker) or environment variables (native)", Method: "GET", Path: "/api/sandboxes", ReadOnly: true }),
    new Operation({ Name: "sandboxes_save", Description: "Create or update a sandbox profile. A docker sandbox carries dockerfile {content, files}; a native sandbox carries only environment variables", Method: "PUT", Path: "/api/sandboxes" }),
    new Operation({ Name: "sandboxes_delete", Description: "Delete a sandbox profile that is not shared and not referenced by any workflow", Method: "DELETE", Path: "/api/sandboxes" }),
    new Operation({ Name: "workflows_list", Description: "List SOP workflow definitions. Query: projectId (that project's SOPs plus generic templates), q (match id/name/description). Always pass projectId when a project is known.", Method: "GET", Path: "/api/workflows", ReadOnly: true }),
    new Operation({ Name: "workflows_save", Description: "Create or update an SOP workflow", Method: "PUT", Path: "/api/workflows" }),
    new Operation({ Name: "workflows_get", Description: "Get one SOP workflow", Method: "GET", Path: "/api/workflows/{id}", ReadOnly: true }),
    new Operation({ Name: "workflows_delete", Description: "Delete an unused SOP workflow", Method: "DELETE", Path: "/api/workflows/{id}" }),
    new Operation({ Name: "workflows_revisions_list", Description: "List SOP workflow revisions", Method: "GET", Path: "/api/workflows/{id}/revisions", ReadOnly: true }),
    new Operation({ Name: "workflows_revision_get", Description: "Get one SOP workflow revision", Method: "GET", Path: "/api/workflows/{id}/revisions/{revisionId}", ReadOnly: true }),
    new Operation({ Name: "workflows_revision_restore", Description: "Restore an SOP workflow revision", Method: "POST", Path: "/api/workflows/{id}/revisions/{revisionId}/restore" }),
    new Operation({ Name: "workflows_publish", Description: "Publish an SOP workflow version", Method: "POST", Path: "/api/workflows/{id}/publish" }),
    new Operation({ Name: "workflows_clone", Description: "Clone an SOP workflow", Method: "POST", Path: "/api/workflows/{id}/clone" }),
    new Operation({ Name: "workflow_metrics_get", Description: "Get SOP workflow operating metrics", Method: "GET", Path: "/api/workflow-metrics", ReadOnly: true }),
    new Operation({ Name: "analytics_get", Description: "Get usage and delivery analytics", Method: "GET", Path: "/api/analytics", ReadOnly: true }),
    new Operation({ Name: "observability_spec_get", Description: "Get the LoopForge observability contract", Method: "GET", Path: "/api/observability/spec", ReadOnly: true }),
    new Operation({ Name: "runs_list", Description: "List lightweight Run summaries", Method: "GET", Path: "/api/runs", ReadOnly: true }),
    new Operation({ Name: "runs_control_get", Description: "Read the run mode (sop or workspace), waiting reason, allowed control actions and delivery acceptance. Node execution progress is separate from test results and user acceptance. Read this before changing a run's state.", Method: "GET", Path: "/api/runs/{id}/control", ReadOnly: true }),
    new Operation({ Name: "runs_start", Description: "Start an SOP Run", Method: "POST", Path: "/api/runs" }),
    new Operation({ Name: "runs_get", Description: "Get one Run", Method: "GET", Path: "/api/runs/{id}", ReadOnly: true }),
    new Operation({ Name: "runs_wait", Description: "Wait for the SOP with path.id to succeed, fail, be cancelled, or need human action (waiting/paused). One call waits up to 25 seconds. If timedOut is true, the SOP is still active or queued; keep waiting on the same run ID if needed.", Method: "GET", Path: "/api/runs/{id}/wait", ReadOnly: true }),
    new Operation({ Name: "runs_delete", Description: "Delete a finished Run", Method: "DELETE", Path: "/api/runs/{id}" }),
    new Operation({ Name: "runs_eval_start", Description: "Manually start an LLM quality evaluation of a finished SOP run. Body: {model}. Uses the current user's credentials for the selected CLI. Use a CLI-prefixed model ID, or omit model to use a configured CLI default.", Method: "POST", Path: "/api/runs/{id}/eval" }),
    new Operation({ Name: "runs_eval_get", Description: "Get the latest SOP run evaluation", Method: "GET", Path: "/api/runs/{id}/eval", ReadOnly: true }),
    new Operation({ Name: "runs_eval_apply", Description: "Apply selected evaluation recommendations to the current SOP or agent after user confirmation. Body: {evalId, recommendationIds}", Method: "POST", Path: "/api/runs/{id}/eval/apply" }),
    new Operation({ Name: "runs_telemetry_list", Description: "Page through Run telemetry", Method: "GET", Path: "/api/runs/{id}/telemetry", ReadOnly: true }),
    new Operation({ Name: "runs_logs_list", Description: "Page through Run worker logs", Method: "GET", Path: "/api/runs/{id}/logs", ReadOnly: true }),
    new Operation({ Name: "runs_logs_download", Description: "Download complete Run worker logs", Method: "GET", Path: "/api/runs/{id}/logs.txt", ReadOnly: true }),
    new Operation({ Name: "runs_artifact_get", Description: "Read an immutable Run artifact", Method: "GET", Path: "/api/runs/{id}/artifacts/{artifactId}", ReadOnly: true }),
    new Operation({ Name: "runs_approve", Description: "Approve a waiting Run", Method: "POST", Path: "/api/runs/{id}/approve" }),
    new Operation({ Name: "runs_pass", Description: "Manually pass a failed script node and continue downstream", Method: "POST", Path: "/api/runs/{id}/pass" }),
    new Operation({ Name: "runs_reject", Description: "Reject a waiting Run back to a node", Method: "POST", Path: "/api/runs/{id}/reject" }),
    new Operation({ Name: "runs_retry", Description: "Retry a failed or cancelled Run", Method: "POST", Path: "/api/runs/{id}/retry" }),
    new Operation({ Name: "runs_decline_retry", Description: "Decline a requested Run retry", Method: "POST", Path: "/api/runs/{id}/decline-retry" }),
    new Operation({ Name: "runs_cancel", Description: "Cancel an active Run", Method: "POST", Path: "/api/runs/{id}/cancel" }),
    new Operation({ Name: "runs_pause", Description: "Pause an active Run at its current node", Method: "POST", Path: "/api/runs/{id}/pause" }),
    new Operation({ Name: "runs_resume", Description: "Resume a paused Run with optional human context", Method: "POST", Path: "/api/runs/{id}/resume" }),
    new Operation({ Name: "runs_refresh_sop", Description: "Update a stopped Run to the latest SOP definition", Method: "POST", Path: "/api/runs/{id}/refresh-sop" }),
    new Operation({ Name: "sync_config_get", Description: "Get external tracker sync configuration", Method: "GET", Path: "/api/sync/config", ReadOnly: true }),
    new Operation({ Name: "sync_config_save", Description: "Save external tracker sync configuration", Method: "PUT", Path: "/api/sync/config" }),
    new Operation({ Name: "sync_start", Description: "Start an asynchronous external tracker sync", Method: "POST", Path: "/api/sync/now" }),
    new Operation({ Name: "sync_logs_list", Description: "List external tracker sync logs", Method: "GET", Path: "/api/sync/logs", ReadOnly: true }),
    new Operation({ Name: "sync_status_get", Description: "Get external tracker sync status", Method: "GET", Path: "/api/sync/status", ReadOnly: true }),
    new Operation({ Name: "sync_issue_create", Description: "Create an issue through a configured external tracker connector", Method: "POST", Path: "/api/sync/create" }),
    new Operation({ Name: "notification_bots_list", Description: "List configured project notification Bots and bound chat names/types. Requires projectId. Bot ID here is a platform reference; credentials are never returned.", Method: "GET", Path: "/api/notification-bots", ReadOnly: true }),
    new Operation({ Name: "shared_schedule_tasks_list", Description: "List latest immutable shared AI task definitions", Method: "GET", Path: "/api/shared-schedule-tasks", ReadOnly: true }),
    new Operation({ Name: "shared_schedule_versions_list", Description: "List published versions for a shared AI task", Method: "GET", Path: "/api/shared-schedule-tasks/{id}/versions", ReadOnly: true }),
    new Operation({ Name: "schedule_jobs_publish", Description: "Publish a credential-free shared AI task version from an independent task. baseVersion is required for optimistic concurrency.", Method: "POST", Path: "/api/schedule-jobs/{id}/publish" }),
    new Operation({ Name: "schedule_jobs_list", Description: "List scheduled SOP jobs", Method: "GET", Path: "/api/schedule-jobs", ReadOnly: true }),
    new Operation({ Name: "schedule_job_executions_list", Description: "List schedule job executions newest first: status, error, durationMs, AI reply summary and the runs[] (issueId, runId) each execution dispatched. Look up a Trace ID copied from the schedule execution panel or a scheduler log line (trace=...) with query.traceId; filter by jobId or status (running/success/failed/waiting). Follow runs[].runId with runs_get.", Method: "GET", Path: "/api/schedule-job-executions", ReadOnly: true }),
    new Operation({ Name: "schedule_jobs_save", Description: "Create or update a scheduled job. Two exclusive kinds: trigger jobs (skipDispatch=false, require workflowId) scan issues in issueStatuses (backlog/todo/in_progress/in_review/blocked; default backlog+todo), run baseline guard, and dispatch SOP with optional maxDispatch (1-10 successful issue dispatches per execution; omitted or 0 defaults to 10). AI jobs (skipDispatch=true, require assistantPrompt or sharedTaskId+sharedTaskVersion+parameterValues) run a prompt using the executor and model selected by assistantModel (for example codex:<model>). Omit assistantModel to use the execution account's default. Set timeoutMinutes (1-240; omitted or 0 defaults to 30). Timing is intervalSec or 5-field cron (Asia/Shanghai). Optional notifications bind up to 3 configured project Bots (botId, events succeeded/failed, template, contentMode template/ai, aiInstruction). Use notification_bots_list to select an existing Bot. AI content reuses this task output; {{task.name}}, {{result}} and {{ai.summary}} are supported.", Method: "PUT", Path: "/api/schedule-jobs" }),
    new Operation({ Name: "schedule_jobs_delete", Description: "Delete a scheduled SOP job", Method: "DELETE", Path: "/api/schedule-jobs/{id}" }),
    new Operation({ Name: "schedule_jobs_run", Description: "Start a scheduled job on the server and return immediately (lastStatus=running). Closing the client does not cancel it; poll schedule_jobs_list until lastStatus leaves running.", Method: "POST", Path: "/api/schedule-jobs/{id}/run" }),
    new Operation({ Name: "assistant_sessions_list", Description: "List the assistant conversations the caller may read: their own sessions, SOP shared sessions of authorized runs, and conversations of projects they belong to. Use it to resolve a chat session link before reading it.", Method: "GET", Path: "/api/assistant/sessions", ReadOnly: true }),
    new Operation({ Name: "assistant_sessions_get", Description: "Read one assistant conversation transcript by session id (the chatSession value in a Studio conversation link), including messages, title, model, issueId, runId and projectId.", Method: "GET", Path: "/api/assistant/sessions/{id}", ReadOnly: true }),
    new Operation({ Name: "assistant_tasks_list", Description: "List Studio AI assistant scheduled prompts for the current user", Method: "GET", Path: "/api/assistant/tasks", ReadOnly: true }),
    new Operation({ Name: "assistant_tasks_save", Description: "Legacy API to create or update an assistant scheduled prompt, optionally with project Bot notifications using the same notifications schema as schedule_jobs_save. Studio no longer starts a ticker; prefer a skipDispatch schedule_jobs AI task.", Method: "PUT", Path: "/api/assistant/tasks" }),
    new Operation({ Name: "assistant_tasks_delete", Description: "Delete a Studio AI assistant scheduled prompt", Method: "DELETE", Path: "/api/assistant/tasks/{id}" }),
    new Operation({ Name: "assistant_tasks_run", Description: "Run a Studio AI assistant scheduled prompt immediately", Method: "POST", Path: "/api/assistant/tasks/{id}/run" }),
  ];
}

module.exports = { Operation, PublicOperations };
