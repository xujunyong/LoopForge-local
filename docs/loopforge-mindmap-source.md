# LoopForge-local 思维导图 · 文件级详细梳理（v2）

> 基线：`main @ 074b7836410bdf905e3a938ef5cfc0f18ebf3381`，本地克隆 144 MB、3564 个文件、Go 文件 1485 个。
> 来源：直接读本地完整代码（`internal/`、`cmd/`、`web/`、`chatbot/`、`local/`、`migrations/`、`scripts/`、`docs/`），不是只读某一个 doc。
> 用途：本文件是思维导图的唯一事实源。思维导图必须把本文件所有节点都展开，深度至少 4 层，节点总数不少于 200 个。
> 规则：每个叶节点必须包含三样东西——（1）具体实现讲什么、（2）涉及的关键文件（带路径）、（3）关键函数/类型/API/配置。点击任何节点都必须打开一个详细面板，面板里有上面三样东西，绝不能只跳回分支标题。

## 规模总览（先记住这组数）

- 总体：4182 条 Git 树条目，blob 约 110 MB；本地浅克隆 3564 文件、144 MB。
- Go：1485 个文件；非测试 Go 文件：`internal/httpapi` 168、`internal/repo` 95、`internal/runtime` 83、`internal/engine` 56、`internal/domain` 56、`internal/runner` 24（68 含测试）、`internal/gitwork` 18、`internal/managedcli` 17、`internal/tracker` 10、`internal/preview` 10、`cmd/` 7。
- 前端：`web/` 89 MB、1098 文件，核心仅 `web/app/` 69 文件约 2.1 MB + 根目录约 124 文件；其余是 `web/vscode-web/` 59 MB + `web/monaco/` 24 MB。`chatbot/` 2.4 MB，React 19 + Vite 6。
- HTTP 路由：`internal/httpapi/server.go` 内 360 条（GET 159、POST 133），`/api/runs` 51、`/api/assistant` 33、`/api/spaces` 28、`/api/runners` 27、`/api/auth` 22、`/api/platform` 19。
- 数据库迁移：`migrations/` 47 个 SQL 文件（001–041，含同号多文件），seed 在 `migrations/seed/001/002`。
- 测试：Go test（覆盖率要求 85%）、`webtest/` 56 个、`e2e/api/` 21 个、`e2e/ui/` 7 个 Playwright、`e2e/public/` 9 个、`chatbot/tests/` 60+ 个。

---

## 分支 1 · 产品定位与两种工作方式

### 1.1 一句话定位
- 实现：自托管、多人共享的 coding-agent 交付工作台；不替代 CLI，而是把 CLI 包进“角色—沙箱—流程—审批—交付证据”。
- 文件：`README.md`、`README.zh-CN.md`、`docs/architecture.md`（21 行）、`AGENTS.md`。
- 关键点：源头 `Tencent/LoopForge`，本仓保留 Go 模块名 `agentflow` 与 `AGENTFLOW_` 环境变量前缀；MIT 许可。

### 1.2 痛点：一次调用 ≠ 一次交付（P0 必读）
- 实现：直接让 agent 修 bug 会跳过计划、忘记测试、自己审自己、中途停了没人知道；LoopForge 用角色分工 + SOP + 人工关卡 + 沙箱 + 可观测来治。
- 文件：`README.md`（Why LoopForge 一节）。

### 1.3 Chat with Main Bot（聊天，P0）
- 实现：Main Bot 按需开对话工作区（Docker 沙箱 + 仓库），角色作子 Agent；消息可排队、Steer 可打断立即发送；可暂停/恢复/接管运行中的 SOP；交付 PR/MR 或 `mode=direct` 直接合入共享分支。
- 文件：`internal/httpapi/assistant*.go`（约 80 个非测试文件）、`internal/engine/conversation_workspace.go`、`internal/runtime/conversation_process.go`、`chatbot/src/App.jsx`、`chatbot/src/useChat.js`。
- 接口：`POST /api/assistant/sessions|messages`、`POST /api/assistant/chat`、`GET/POST /api/assistant/sessions/:id/generation[/cancel|/steer]`。

### 1.4 Run an SOP（跑流程，P0）
- 实现：引擎按依赖图执行节点，就绪分支可并行；人工关卡批准/打回；失败可重试、从任意节点重跑；每节点产物与日志。
- 文件：`internal/engine/run_start.go`、`workflow_graph.go`、`node_execute.go`、`node_outcome.go`、`run_ops.go`、`docs/api/orchestration.md`。
- 内置流程：需求 → 澄清 → 设计 → 实现 → 评审（Agent）→ 测试（Script）→ 验收（人工）→ 发起 MR → 交付；内置模板后端/前端/修 Bug/产品四种，只读蓝图，需复制进项目。

### 1.5 Local（Legacy，无服务端，按需）
- 实现：`loopforge-cli@0.2.3`，无平台/MySQL/Docker，直接把 DevFlow 写进目标项目，跑在宿主 CLI 内；产物在 `artifacts/<task-slug>/`，状态 `workflow-state.json`。
- 文件：`local/package.json`、`local/bin/loopforge.mjs`、`local/src/devflow_cli/cli.py`、`local/AGENTS.md`、`docs/local/*.md`。
- 流程：small `SOLO→SUMMARY`；medium/large `REQUIREMENT→DESIGN→IMPLEMENT→REVIEW→TEST→[KNOWLEDGE]→SUMMARY`，REQUIREMENT 须用户确认才能进 DESIGN。

### 1.6 共用追踪：同一个 Issue（P1 核心）
- 实现：聊天与 SOP 共用同一 Issue/Requirement，改动都挂同一需求，计入交付与成本统计；澄清已是可选，不再阻塞触发 SOP。
- 文件：`internal/domain/issue.go`、`internal/domain/requirement.go`、`internal/repo/issues.go`、`internal/repo/requirement.go`。
- 模型：`Issue{ID, ProjectID, Number, Title, Status(backlog/todo/in_progress/in_review/done/closed/blocked/cancelled), WorkflowID, SOPBindings, RepositoryIDs}`。

---

## 分支 2 · 后端 Go：入口与启动链

### 2.1 cmd/agentflow（主服务，P0）
- 实现：`main()` 在 `cmd/agentflow/main.go:77`。链：`loadDotEnv:36` → 校验 `AGENTFLOW_SESSION_SECRET`（必填）、`AGENTFLOW_AUTH_REQUIRED` 默认 true → `resolveRole`（api/worker/all）→ `resolveWorkspaceRoot` → `repo.Open(mysqlDSN)` → `engine.New(s, runtime.NewManagerWithLimit(root, workerConcurrency=8))` → `ConfigureExecution(instanceID, host, leaseTTL=30s, executeRuns)` + `ConfigureCloudRunnerPool` → `config.LoadEndpoints` → `httpapi.NewWithNotificationsAndBackground`（api/all；worker 只起 workerHandler + 心跳）→ `e.StartMaintenance` → `executeRuns` 时 `e.StartClaimLoop` → `startManagedCLIUpdates` → 信号处理 SIGINT/SIGTERM 停认领排空，SIGHUP 经 `handover.go` 交接监听器。
- 文件：`cmd/agentflow/main.go`、`cmd/agentflow/cli.go`（`runCLI`，`--cli-action status/update/rollback`）、`cmd/agentflow/handover.go`。
- 配置：`AGENTFLOW_HTTP_PORT=8090`、`AGENTFLOW_MYSQL_DSN`、`AGENTFLOW_SESSION_SECRET`、`AGENTFLOW_RUN_LEASE_TTL`（默认 30s）、`AGENTFLOW_INSTANCE_ID`（默认 `<role>-<host>-<pid>`）。

### 2.2 其他 cmd 入口
- `cmd/agentflow-runner/main.go`：Runner 守护进程入口，只出站 HTTPS，本地执行 Agent CLI。
- `cmd/agentflow-mcp/main.go`：远程 MCP（stdio，调平台 API）。
- `cmd/agentflow-gate-mcp/main.go`：门控结果回写入口，`gatemcp/server.go:Run(stdin, stdout, resultPath)`。
- `cmd/loopforge-account/main.go`：从 stdin 读密码创建本地账号（可设管理员）。

### 2.3 go.mod 依赖（P1）
- 实现：模块 `agentflow`，Go 1.26.11。直接依赖 Gin 1.12、GORM + MySQL 驱动、`gorilla/websocket`、`goccy/go-yaml`、`creack/pty`、`mvdan.cc/sh`、`zalando/go-keyring`、`x/crypto`；无 Redis/消息队列，调度靠 MySQL + 租约。
- 文件：`go.mod`、`go.sum`。

---

## 分支 3 · 后端 Go：领域模型 domain（56 个文件）

### 3.1 Run 与 NodeRun（P0）
- 实现：`internal/domain/run.go:10`。`Run{Kind, ID, WorkflowID, WorkflowSnapshot, SandboxID, OwnerInstanceID, LeaseUntil, Generation, WorkspaceHost, WorkspaceRoot, Status, AdmissionState, QueueEnteredAt, CancelRequested, PauseRequested, Input, Repositories[], ExecutionContext, Nodes map[string]*NodeRun, Events, Telemetry, Logs, Usage, ToolCalls, Artifacts, HumanContext, Timing, Revision}`。`RunKindWorkspace="workspace"`，`IsWorkspace/LiveWorkspace/HumanEditable:80-130`。`NodeRun:146{NodeID, Status, Attempt, ReworkCount, SandboxID, Output, Error, Provider, Model, SessionID, ResumeSessionID, Activity, Feedback, Usage, GateResult}`。
- 文件：`internal/domain/run.go`、`run_eval.go`（`RunEvalDimension/Policy`）、`run_timing.go`（`RunTiming/ComputeRunTiming`）。

### 3.2 WorkflowDefinition 与节点（P0）
- 实现：`internal/domain/workflow.go:146`。`WorkflowDefinition{ID, Name, Version, Revision, Status(draft/published/archived), ProjectID, SandboxProfileID, MetricCategory, SOPLane, Requirements[], SandboxSnapshot, Preview, ExecutorDefaults, Nodes[], Edges[]}`。`WorkflowNode:39{Type(agent/script/approval/sop), AgentID, ScriptLanguage, Command, OnFailure(fail/reject), RetryStrategy(targeted_fix/full_redo), MaxAttempts, MaxReworks, RejectTo, CarryOver, ArtifactContracts, VerificationGate}`。`VerificationGate:10{Mode(command/manual/mr), Stage, OnFailure(loop/reject/fail/human)}`。
- 文件：`internal/domain/workflow.go`、`sop_lane.go`、`verification.go`。

### 3.3 Agent 与 Executor（P0）
- 实现：`internal/domain/agent.go:64`。`AgentDefinition{ID, Name, Version, ProjectID, Prompt, Rules, Skills, MCPServers, PlatformMCP, KnowledgeBase, Hooks, ExecutorID}`。`ExecutorDefinition:137{ID, Kind(mock/claude-code/codex/codebuddy), Binary, Args, Protocol, Model, Effort}`。
- 文件：`internal/domain/agent.go`、`assets.go`（`Rule/Skill/MCPServerDefinition`）。

### 3.4 其他 domain 文件（按需展开）
- `issue.go`（Issue，见 1.6）、`issue_sop.go`（`IssueSOPBinding/EffectiveSOPBindings/SOPPlaybook`）、`requirement.go`（`RequirementSnapshot/Lane/Stage`）、`assistant.go:181`（`AssistantSession{ExecutionTarget, ExecutionTargetLocked, RuntimeMode, Source, TaskID, WorkflowID, IssueID, Participants}`、`AssistantMessage/ActivityEvent`）、`assistant_generation.go`、`assistant_preferences.go`（审批评审模式）、`assistant_proposal.go`、`runner.go:170`（`Runner{ID, Name, OS, Arch, RunnerVersion, Labels, MaxConcurrency, NativeSandboxAvailable, RunLimit, Status, Runtimes, OwnerUserID, SessionTokenHash}`）、`runner_workspace.go`、`project.go`（`Project/Member/Repository`）、`delivery_mr.go`、`mr_delivery.go`、`mr.go`（MR URL 解析 GitHub/工蜂）、`user.go`（`User/GitSSHKey/GitHTTPCredential`）、`token_pricing.go`（`TokenPrice/IsHYModel`）、`space.go`（`RequirementSpace/ArtifactRef`）、`room.go`（`ChatRoom/Member/Message`）、`schedule_execution.go`、`shared_schedule.go`、`sync.go`、`task.go`、`knowledge.go`、`notification.go`、`bot_identity.go`、`bot_interaction.go`、`business_domain.go`、`catalog.go`、`clarification.go`、`clone_url.go`、`conflict_blocks.go`、`group_completion.go`、`group_plan.go`、`https_host.go`、`insights.go`、`mcp_masking.go`、`notification_template.go`、`notification_workflow.go`、`observability.go`、`preview.go`、`preview_build.go`、`preview_detect.go`、`public_repository.go`、`work_branch.go`、`workspace_preparation.go`、`analytics.go`、`approval_reason.go`、`assistant_diagnostic_analysis.go`、`assistant_diagnostics.go`。

---

## 分支 4 · 后端 Go：SOP 引擎 engine（56 个文件，P0 必读）

### 4.1 Run 创建 run_start.go
- 实现：`Start:37` / `StartWithContext:41` / `StartWithExecutionContext:45` / `StartWithRepositoriesContext:53` → `startWorkflow:57` → `startWorkflowDefinition:91`。冻结 `WorkflowSnapshot`、分配工作分支 `assignWorkBranches:15`、置 `OwnerInstanceID, Generation=1, LeaseUntil=now+TTL`（`run_start.go:210`）。`selectSOPExecutionTarget:234` 决定本机/Runner/云池。`executes():256` 为角色门。
- 文件：`internal/engine/run_start.go`、`engine.go`（`Engine/New/StartMaintenance/ConfigureExecution`）。

### 4.2 认领循环 run_state.go（无 Redis 的关键设计）
- 实现：`StartClaimLoop:130`，每 2 秒 tick，先 `ResumeInterruptedRuns()` 再循环；`!executes()` 则退出。靠 MySQL + 租约：`Run.OwnerInstanceID/LeaseUntil/Generation`，租约默认 30s。`updateRun/updateRunAt:11-34` 做带租约校验的写；`Subscribe/pollRun:68-102` 供 SSE 推送；`run_recovery.go: ResumeInterruptedRuns/RecoverInterruptedRuns` 认领中断 Run，`run_ops.go:41-42` 释放租约。`run_control.go:116 StartInstanceHeartbeat` 多实例心跳，`Interrupt:163` 跨实例中断。
- 文件：`internal/engine/run_state.go`、`run_recovery.go`、`run_control.go`、`run_events.go`（`AppendRunEvent/IngestOTLPTraces/IngestWorkerEnvelope`）。

### 4.3 DAG 调度与节点执行
- 实现：`workflow_graph.go`：`readyNodes:11`（依赖全部成功才就绪）、`ancestors/descendants:60-79`、`allSucceeded:117`、`validate/validateDAG:155-242`。`node_execute.go:16 execute()`：跳过 workspace/历史组/queued，500ms 轮询 + wake 通道，`integrateScheduledRun` 后重排；`executeNode:319` 分发 agent/script/approval/sop/preview，`resolveNodeExecutor:189` 选执行器，`workflowSandboxRequirements:226` 合并沙箱需求，`bindDockerWorkspace:283` 绑工作区。`parallel_exec.go` 并行分支。`execution_scope.go`：执行域 `run/repositories`。
- 文件：`internal/engine/workflow_graph.go`、`node_execute.go`、`parallel_exec.go`、`execution_scope.go`、`node_outputs.go`（节点产物收集）、`sop_node.go`（`executeSOPNode` 子 SOP、防循环、子 Run 等待/产物导入）、`sop_executors.go`。

### 4.4 审批 / 重试 / 回退
- 实现：`node_outcome.go`：`waitApproval:13` 挂起等人工；`nodeFailed/nodeFailedAt:22-50`：`shouldRetryFailedAttempt:89`（`Attempt < MaxAttempts`）、`gateReworkReject:105`（`GateResult.Decision=="rework"`）→ 自动 `Reject` 到 `RejectTo`，`ReworkCount >= MaxReworks` 则转人工（`60-82`）。`run_ops.go`：`Cancel:47`、`Pause:109`、`Approve:140`、`Pass:186`（失败/暂停节点标成功放行）、`Reject:271`（`ReworkCount>=MaxReworks` 报错 `rework limit reached`）、`Retry/RetryContext:359-364`（从指定节点重开，`MaxAttempts` 自动+1，`530`）、`ResumePaused:637`、`DeclineRetry:927`、`RefreshRunSOP:818`。`gate_submit.go` 提交门结果，`gate_mr.go: verifyRunMRs` 校验 MR 含最新 tip，`gate_bind.go` 绑定验证命令。
- 文件：`internal/engine/node_outcome.go`、`run_ops.go`、`gate_submit.go`、`gate_mr.go`、`gate_bind.go`、`human_context.go`。

### 4.5 integrate 合并与交付
- 实现：`integrate.go`：`integrateScheduledRun:53` → `integrationRunner:129` 选 Runner → `integrateLocally:143` 本地合并 → `mergeWorkBranchIntoIntegrate:161`（`IntegrationLocker:34` 串行化）→ `mergeLatestIntegration:234` / `mergeLatestRemoteBranch:238`；`verifyDeliveryCompleteness:354`；冲突 `requeueIntegrationConflict:242` 回工作分支；`shouldSeedIntegrateBranch:18`。`MergeIntoBranch/FindBranchMR` 为 engine 可注入回调（工蜂 MR 合并），无回调则直接 push。
- 文件：`internal/engine/integrate.go`、`runner_integrate.go`、`runner_dispatch.go`、`runner_align.go`、`align.go`。

### 4.6 对话工作区与检查点
- 实现：`conversation_workspace.go` 对话工作区租约 `Begin/Renew/Release`；`conversation_workspace_save.go` 后台保存 `EndConversationWorkspaceUseAsync`；`workspace_checkpoint_stream.go` / `workspace_checkpoint_transport.go`（`HandleWorkspaceCheckpoint`）；`workspace_restore.go`（`StartWorkspaceRestore`）；`workspace_cleanup.go` 清理/回收；`chat_workspace.go`（`StartConversationWorkspace`）；`clarify_workspace.go`；`conversation_push.go`（`PushConversationWorkspace` 推工作分支）；`conversation_cli.go`（`AcquireConversationCLI`）。
- 状态机：按轮次持租约，轮次结束或切换前保存快照（`run_workspace_checkpoints`，`released_at` 标记解绑）；空闲回收先补存快照再回收；SOP 执行/暂停中不回收；删除对话删自有工作区，不删借用的 SOP 工作区；SOP 执行中其工作区对 Main Bot 只读，需先 `runs_pause` / `runs_cancel`。
- 文件：`internal/engine/conversation_*.go`、`workspace_*.go`、`lifecycle.go`、`workspace_busy.go`、`workspace_owner.go`、`workspace_preparation.go`、`workspace_artifacts.go`。

### 4.7 engine 其余文件
- `prompt.go`（Prompt 组装）、`artifacts.go`（产物输入物化/收集）、`assets.go`（`platformMCPServer/knowledgeMCPServer` 资产注入）、`bot_control.go`、`browser.go`、`cloud_pool.go`（`CloudRunnerPool` 云池）、`codebuddy_auth.go`（CodeBuddy 凭证，用户→平台共享 key 回退）、`engine_observe.go`、`git_auth.go`、`git_preparation_fallback.go`、`legacy_handoff.go`、`observability.go`、`repository_cache.go`、`repository_patch.go`、`repository_workspace.go`、`run_environment.go`、`shared_schedule_assets.go`。

---

## 分支 5 · 后端 Go：沙箱与执行器 runtime（83 个文件，P0）

### 5.1 Provider 接口
- 实现：`runtime/provider.go:52`。`type Provider interface { Kind() string; Materialize(*providerMaterializeContext) error; Prepare(providerInvocation) (CommandSpec, error); Protocol(domain.ExecutorDefinition, EventSink) *protocolAdapter; SandboxRequirements() SandboxRequirements; RunBuiltin(context.Context, domain.AgentDefinition, string, EventSink) (string,bool,error); StartObservation(...); SystemHooks() []domain.AgentHook }`。`baseProvider:65` 默认实现；`providerForKind:167` 查表，`init:161` 将 `AgentCLIKinds` 全注册为 `agentCLIProvider`。`PrepareProviderCommand:198` 供非节点调用点复用。
- 文件：`internal/runtime/provider.go`、`runtime.go`（`EventSink/RunCredentials/CommandSpec:110/Sandbox` 接口：`ID()/Workspace()/Exec(ctx,CommandSpec,sink)/Close()`）。

### 5.2 专属 Provider 与通用 agentcli
- 实现：专属 `provider_codebuddy.go:11 codeBuddyProvider`、`provider_codex.go:12 codexProvider`（隔离 env/MCP）、`provider_claude.go:12 claudeProvider`（插件物化）、`provider_mock.go:13 mockProvider`（仅 `RunBuiltin`）。通用 `provider_agentcli.go:18 agentCLIProvider` 覆盖 opencode / cursor / agy（Antigravity）/ kimi / pi / dsh（DeepSeek Harness）/ zcode，共 10 种 CLI。`agent_cli.go:24-30` 常量，`AgentCLIKinds` 展示序。`agent_cli_stream.go` 流式解析（Claude 事件）；`agent_cli_zcode.go` zcode 适配；`agy_models.go` Antigravity 模型/努力值。
- 执行流程：拼 Prompt → 注入 MCP/技能/凭证 → 沙箱内起 CLI 子进程 → 流式解析事件（`agent_cli_stream`）→ 写 Run 事件/日志/用量。
- 文件：`internal/runtime/provider_*.go`、`agent_cli*.go`、`protocol.go`、`protocol_tools.go`（`ParseTokenUsage`）。

### 5.3 沙箱 Manager 与三种驱动
- 实现：`sandbox_manager.go:14 Manager`，`NewManagerWithLimit(root,8)`，`Create:44` / `AcquirePersistent:51` / `AcquireRun:59` / `AcquireRunIn:66` / `open:73`，`createDriverSandbox:448` 按 kind 分发。`sandbox_docker.go:22 dockerSandbox`（`docker exec`、镜像缓存 `cachedDockerImageName/dockerImageExists:590-623`、回收 `ReclaimDockerSandboxes:177`）、`sandbox_process.go:95 processSandbox`（Linux `bwrap`、macOS `seatbelt/sandbox-exec`）、`sandbox_local.go:12 localSandbox`（直跑宿主进程，无隔离）。`SandboxProfile` 冻结 Dockerfile/环境。
- 文件：`internal/runtime/sandbox_*.go`、`sandbox_environment.go`、`process.go`（`runCommand` 进程执行/脱敏）、`materialize.go`。

### 5.4 会话进程与 Runner 登录
- 实现：`conversation_process.go:94 ConversationProcessPool`（`Handle:175` / `start:440`，资产锁、超时回收）、`conversation_sandbox.go:21 ConfigureConversationSandbox`、`conversation_docker_process.go`、`conversation_approval.go`、`conversation_assets.go`、`conversation_login_models.go`（`DiscoverRunnerLoginModels`）、`conversation_network.go`、`conversation_runner_login.go`、`runner.go`（`ExecutorRunner/NewExecutorRunner/PrepareRemote`）、`runner_login_manager.go` 及 `runner_login_{antigravity,antigravity_identity,claude,lease}.go`、、`remote_sandbox.go`（`OpenRemoteSandbox`）。
- 文件：见上，另 `workspace_terminal.go`（`TerminalPool`）、`workspace_terminal_sandbox.go`、`workspace_lock.go` / `workspace_locks.go`、`workspace_checkpoint.go`、`workspace_checkpoint_transfer.go`、`workspace_edit.go`、`workspace_artifacts.go`、`workspace_preparation.go`。

### 5.5 Git / MCP / 凭证注入
- 实现：`run_git_credentials.go`（`RunGitEnvironment`）、`git_credential_helper.go`（`RunGitHelperCLI`）、`git_isolation.go`、`git_ssh.go`（`BindGitSSH`）、`git_workspace_scrub.go`（工作区密钥清理）、`github_mcp.go`、`mcp_call.go`（`PrepareMCPCall/RunMCPCallCLI`）、`mcp_credentials.go`、`mcp_provision.go`、`platform_mcp.go`、`gate_mcp.go`、`skill_md.go`、`skill_tree.go`（`WriteSkillTree`）、`hooks.go`、`browser.go` / `browser_agent.go` / `browser_cdp.go` / `browser_devserver.go` / `browser_file.go` / `browser_inspect.go` / `browser_view.go`（`HandleBrowser`）、`claude_endpoint.go`、`claude_install.go`（`EnsureClaudeCode`）、`cursor_install.go`、`cursor_models.go`、`docker_build_progress.go`、`managed_cli.go`、`managed_files.go`、`toolchain.go`（`EnsureToolchainCLI`）、`cli_live_config.go`、`cli_ondemand.go`、`cli_version.go`、`command_binding.go`、`identifier.go`、`inert_text.go`。
- 注意：DSH 的 agy 插件需要另外安装 Antigravity CLI（`agy.exe`），IDE 本身不等于 CLI。

---

## 分支 6 · 后端 Go：HTTP API httpapi（168 个非测试文件，360 条路由）

### 6.1 server.go 装配与中间件
- 实现：`internal/httpapi/server.go`：`type Server struct`、`New()` / `NewWithNotifications()` / `NewWithNotificationsAndBackground()`。装配 `deps{Store, Engine, tracker}`，注入各领域 handler，`schedule.New()`、`api.runners.startRunnerSweeper()`、`stream.recoverClarifyJobs`。中间件顺序（`211-229`）：`previews.previewHost()`、`browser.devServerHost()` → `logging(), securityHeaders(), cors(), gzipMaybe()` → `tokens.userAccessAuth()` → 可选 `basicAuth()` → `runWriteGuard(), assetWriteGuard()`。`NoMethod` 返回 405、`masterTrailingSlashCompat()` 处理尾斜杠，`health/capabilities/openAPI/bootstrap/observabilitySpec/otel` 在 `Server` 上。
- 路由按前缀：`/api/runs` 51、`/api/assistant` 33、`/api/spaces` 28、`/api/runners` 27、`/api/auth` 22、`/api/platform` 19、`/api/knowledge` 15、`/api/workflows` 12、`/api/users` 11、`/api/skillhub` 9、`/api/projects` 8、`/api/rooms` 8、`/api/agents` 8、`/api/mcp-servers` 8、`/api/sync` 7、`/api/issues` 6、`/api/skills` 6、`/api/schedule-jobs` 6、`/runners/tasks` 6。

### 6.2 认证 auth（文件级）
- 实现：`auth.go`（`authHandlers`，网关身份头信任、会话过期）、`auth_password.go`（`POST /api/auth/password`，IP 限流 `passwordLimiter.allow`）、`auth_register.go`（`GET /api/auth/setup`、`POST /api/auth/register`、`joinWelcomeProject`）、`auth_tokens.go`（`tokenHandlers`，`GET/POST/DELETE /api/auth/tokens[/:id]`）、`auth_interactive.go`、`auth_avatar.go`、`github_auth.go`（`GET /api/auth/github`、`PUT …/config`、`POST …/device|poll`：`start()` 调 `POST https://github.com/login/device/code`（`client_id` + `scope=repo`，须管理员先配 OAuth App Client ID 并启用 Device Flow，否则 503），返回 `flowId/userCode/verificationUri/expiresIn/interval`；`poll()` 调 `POST https://github.com/login/oauth/access_token` 换 token；`repositories()` 列仓库；无 PAT 路径）、`gongfeng_oauth.go`（`GET /api/auth/gongfeng[/start|/callback]`）。
- 模型：`internal/auth/client.go`（`NewClient/NewClientFromEnv/SignUser/ParseSignedUser`）、`types.go`、`photo.go`。

### 6.3 issues / dispatch / tasks
- 文件：`issues.go` / `issue_routes.go` / `issue_base_branch.go` / `issue_deletion_view.go`（`issues/issueDetail/addIssueComment/issueRuns/submitIssueClarification/importTAPD`，`GET/PUT/POST /api/issues`、`POST /api/issues/import-tapd`、`GET /api/issues/:id/clarify-models`）、`dispatch.go`（`dispatchIssue/primaryTaskID/appendSOPHandoff`，`POST /api/issues/:id/dispatch` 的后端）、`tasks.go`（`GET /api/tasks[/:id]`）、`project_write_access.go`（`requireProjectWriter`）、`projects.go`（`GET/PUT/POST /api/projects`、`GET/DELETE /api/projects/:id`、`POST …/restore`）。

### 6.4 runs 控制与工作区
- 文件：`runs.go`（`GET/POST /api/runs`、`GET/DELETE /api/runs/:id`、`/api/workflow-metrics`、`/api/analytics`）、`run_control.go`（`GET /api/runs/:id/control`；`POST …/approve|reject|retry|decline-retry|cancel|pause|resume|refresh-sop|pass`）、`run_wait.go`（`GET /api/runs/:id/wait`）、`run_eval.go`（`GET/POST /api/runs/:id/eval[/stream|/apply]`）、`run_workspace.go` / `run_workspace_edit.go` / `workspace_preparation.go` / `workspace_restore.go`（`GET/PUT/POST /api/runs/:id/workspace[/tree|/file|/log|/commit|/diff|/search|/takeover|/release|/restore|/preparation|/terminal]`）、`run_preview.go`（`GET /api/runs/:id/preview[/download]`、`POST …/preview/session`、`PUT …/preview/backend`）、`stream.go`（`GET /api/runs/:id/stream` SSE）、`browser.go` / `browser_stream.go`（`POST /api/runs/:id/browser`）。

### 6.5 assistant 子包（约 80 个文件，按主题）
- 入口/会话：`assistant.go`、`assistant_session.go`、`assistant_session_runs.go`、`assistant_session_cleanup.go`、`assistant_session_origin.go`、`assistant_tasks.go`、`assistant_live.go`、`assistant_stream.go`（`POST /api/assistant/chat`、`GET/POST /api/assistant/sessions[/:id|/archive|/read|/fork]`）。
- 生成/执行：`assistant_generation.go`、`assistant_generation_recorder.go`、`assistant_direct_generation.go`、`assistant_execution.go`、`assistant_engine_*.go`（`assistant_engines.go`、`assistant_engine_cli.go`、`assistant_engine_codex.go`、`assistant_engine_agentcli.go`）、`assistant_process.go`、`assistant_provider.go`、`assistant_models.go`、`assistant_effort.go`（`POST /api/assistant/generations`、`/sessions/:id/generation[/cancel|/steer]`、`/api/assistant/models`）。
- 审批：`assistant_approval.go`、`assistant_approval_fastpath.go`、`assistant_approval_http.go`、`assistant_approval_review.go`、`assistant_native_approval.go`、`assistant_mcp_approval.go`、`assistant_acceptance.go`（`POST /api/assistant/sessions/:id/native-approvals/:approvalId`、`/api/assistant/approval-review/probe`）。
- 工作区：`assistant_workspace*.go`（`workspace/build/mode/mr/open/sop_notice/turn`）、`assistant_sandbox.go`、`assistant_workspace_mr.go`。
- 其他：`assistant_context.go`、`assistant_conversation_*.go`、`assistant_cron.go`、`assistant_diagnostics*.go`、`assistant_failure.go`、`assistant_fork.go`、`assistant_mcp.go`、`assistant_proposals.go`、`assistant_sop_designer*.go`、`assistant_subagents.go`、`assistant_unfinished.go`、`assistant_workbench.go`、`assistant_cli_install.go`、`assistant_cli_usage.go`、`assistant_codex_usage.go`、`assistant_attachment_sweep.go`。

### 6.6 catalog / MCP / knowledge / runners / schedule / rooms / spaces
- `catalog.go`（`GET /api/repositories`、`/api/agents|rules|skills|sandboxes|executors`、`/api/workflows[/:id|/revisions|/publish|/clone]`）、`generic_workflows.go`（内置 SOP 模板复制进项目）、`executor_models.go` / `feature_model.go`（`GET /api/executor-models`）、`skill_files.go` / `skillhub_client.go` / `skillhub_market.go`（`/api/skills`、`/api/skillhub`）、`mcp.go` / `mcp_files.go` / `mcp_market.go`（`GET/PUT/DELETE /api/mcp-servers`、`POST …/import|/files`、`/api/mcp-market[/install]`）、`knowledge.go` / `knowledge_proxy.go`（`GET /api/knowledge` 15 条）、`runners.go`（`GET /api/runners`、`POST /api/runners/register|deregister|disconnect|heartbeat|tasks/claim`、`GET/POST /api/runners/tasks/:id[/events|/complete|/control]`）、`runner_ws.go`（Runner 控制通道 WebSocket 中继）、`runner_binary.go` / `gate_mcp_binary.go`（`/runners/agentflow-runner|/runners/agentflow-gate-mcp|/runners/install.sh`）、`schedule.go` / `schedule_executions.go` / `shared_schedules.go`（`GET/PUT/POST /api/schedule-jobs`、`POST …/:id/run|enabled|publish`）、`rooms.go` / `room_runs.go`（`GET/POST /api/rooms[/:id/messages|issues|decisions]`）、`spaces.go` / `space_lanes.go` / `space_artifacts.go` / `space_ai.go`（`GET /api/spaces` 28 条，需求空间）、`sync.go`（`GET /api/sync` 7 条）、`notifications.go` / `bot_identities.go` / `bot_interaction_records.go`、、`clarify_jobs.go` / `clarify_mcp.go` / `clarify_session.go` / `clarify_source.go`（`/api/chat-clarify` 3 条）、`conversation_sop.go`（聊天借用 SOP 工作区）、`agent_tool_*.go`（7 个，`/internal/agent-tools` 沙箱内 Agent 工具回调 MCP/终端/Git 凭证/原生审批）、`insights.go` / `studio.go` / `inflight.go`、、`git_ssh_keys.go` / `git_http_credentials.go` / `git_token_verify.go` / `git_https_hosts.go` / `ssh_host_trust.go`、、`cli_models_probe.go`（`POST /api/users/:id/cli-models/probe`）、`users.go`、`platform_settings.go`、`business_domains.go` / `business_permissions.go`。

---

## 分支 7 · 后端 Go：持久化 repo（95 个文件）与数据层

### 7.1 Store 装配
- 实现：`internal/repo/repo.go:82-169,229`。`Store` 匿名嵌入 22 个 Repo：Catalog/Projects/BusinessDomains/Issues/Tasks/Users/Tokens/Assistant/Runs/Runners/Delivery/Analytics/Insights/Previews/EngineInstances/Rooms/Spaces/Knowledge/SSHHostTrust/HTTPSHostTrust/Notifications/BotInteractions。`newStore` 显式指针注入跨域依赖（RunsRepo 持 assistant/issues/catalog/notifications 等），禁循环依赖。`Open:229`：只接 MySQL，空 DSN 拒绝启动，补 `charset=utf8mb4/parseTime/loc=UTC`，池 32/8，`autoMigrateIncremental` 仅增量 DDL。
- 规则（`AGENTS.md`）：禁止在 `Store` 上新增领域方法；新实体先找所属领域 Repo；领域 Repo 共享依赖只有 gorm 句柄；代码不做迁移/seed。

### 7.2 各领域 Repo 文件
- `catalog.go`（CatalogRepo：agents/rules/skills/MCP/executors/sandboxes/workflows）、`catalog_sharing.go`、`generic_docker.go`、`generic_store.go`、`generic_workflows.go`、`projects.go`、`project_business_domain.go`、`business_domains.go`、`issues.go`（`PutIssue/ReserveIssueDispatch`）、`issues_close.go`、`issues_delete.go`、`requirement.go`（`BuildRequirementSnapshot`）、`tasks.go`、`users.go`、`local_accounts.go`、`platform_admin.go`、`tokens.go`、`auth_integration.go`、`bot_credentials.go` / `bot_identities.go` / `bot_interactions.go`、`runs.go`、`run_admission.go`（入队/排队 `PromoteQueuedRuns`）、`run_evals.go`、`run_issue_latest.go`、`run_knowledge.go`、`run_workspace_edit.go`、`runs_conversation.go`、`assistant.go` 及 `assistant_*.go`（会话 CRUD、诊断、生成租约、原生审批、提案、共享会话、任务结果）、`runners.go`、`delivery.go`、`engine_instances.go`（心跳/控制 URL）、`analytics.go` 及 `analytics_{activity,activity_usage,business_delivery,business_domains,business_merge,insights,mr_merges,pricing}.go`、`insights.go`、`previews.go`、`rooms.go`、`spaces.go`、`knowledge.go`、`notifications.go` 及 `notification_{issue_context,project_context,reports,workflows}.go`、`mcp_files.go` / `skill_files.go`、`git_http_credentials.go` / `git_https_hosts.go` / `git_ssh_credentials.go` / `ssh_host_trust.go`、`gongfeng_credential.go`、`codebuddy_sponsor.go`、`conversation_sandbox.go`、`schedule_job_executions.go` / `schedule_job_results.go` / `schedule_trigger_config.go`、`shared_schedules.go` / `shared_schedule_assets.go`、`sandbox_defaults.go`、`workspace_checkpoints.go` / `workspace_checkpoint_chunks.go` / `workspace_restore.go`、`integration_lock.go`（`LockIntegration`）、`automigrate.go`、`models.go`、`hash.go`、`payload.go`。

### 7.3 migrations/001–041（每文件 1 行，P1）
- 001：`run_telemetry.adapter` + `run_logs.level` 生成列及索引。002：建 `knowledge_settings`、`knowledge_submissions`。003：建 `insight_sources`、`insight_executions`。004：建 `notification_bots`、`user_bot_credentials`、`notification_deliveries`。005：`notification_deliveries` 加 `source_type/source_id/source_name/content_source`。006：加 `waiting_policy`。007：加 `target_type`；建 `bot_connections/bot_conversations/bot_interactions`。007（报告）：加 `report_request/report_state/report_model/report_error`。008：建 `bot_user_bindings`、`bot_binding_challenges`。009：`bot_interactions` 转 utf8mb4。010：建 `run_admission_locks`；`runs` 加 `quota_bucket/quota_project_id`。011：`runs` 加 `workspace_editor_id/workspace_edit_until`。012：建 `assistant_generations`。013：建 `run_workspace_checkpoints`。014：建 `assistant_group_followups`。015：建 `sop_handoff_jobs`。016：`mr_delivery_states` 加 `merged_at`；更新内置后端 SOP taskPrompt。017：`sop_handoff_jobs` 加 `complete/reason/source_session_id/...`。018：`chat_messages` 加 `thread_id`；建 `requirement_spaces/space_members/space_artifacts/space_artifact_revisions`；`run_workspace_checkpoints` 加 `restore_status/restore_started/restore_error`。019：建 `page_feedbacks/page_feedback_images`。020：`runs` 加 `kind`；旧自由协作群转为 `kind='workspace'`。021：`assistant_sessions` 加 `source/task_id`。022：建 `auth_integrations`。023：重写内置 SOP 角色 prompt。024：`sandboxes.payload.driver` seatbelt/bwrap 合并为 `native`；建 `platform_codebuddy_keys`。025：`user_configs` 加 `agent_cli_credentials`。026：`assistant_generations` 加 `finished_at`；建 `assistant_session_reads`。027：`user_configs` 加 `codex_models/claude_code_models`。028：建 `user_git_ssh_keys`。029：建 `assistant_diagnostics`。030：`generic-docker` 沙箱标 `shared=true`。031：内置 `generic-backend` Dockerfile 加 `openssh-client`。032：`assistant_generations` 加 `workspace_run_id/workspace_lease`；`run_workspace_checkpoints` 加 `lease_renewed_at`。033：内置后端/前端/修 Bug SOP 加「发起 MR」节点。034：建 `schedule_job_executions/schedule_job_execution_stats`。035：`user_configs` 加 `codebuddy_models`。036：`assistant_preferences` 加 `steer_on_send`；建 `user_git_http_credentials`；`mr_delivery_states` 加 `registered_by`。037：`user_git_http_credentials` 删 `expose_to_workspace`（退役明文 Git Token）。038：替换内置 MR 角色鉴权指令（改用 `git credential fill`）。039：建 `platform_git_ssh_hosts`；清理旧定时统计临时表。040：`assistant_preferences` 加 `approval_review_mode/approval_review_model/approval_review_api_json`。041：沙箱内联 Dockerfile、`local`→`native`、删 `dockerfiles/environments` 旧表（升级前必手动执行）。

---

## 分支 8 · 后端 Go：Runner / ManagedCLI / Gitwork / Tracker / Preview / MCP

### 8.1 internal/runner（68 个文件）
- 实现：`daemon.go`（`Daemon/Config/New/Run/Version`）：`Run()` 起 `ensureRegistered`、`rescanLoop`、`heartbeatLoop`（默认 30s）、`claimLoop`；`client.go`（`Register/Heartbeat/Deregister/Disconnect/WaitForTask/Claim/StartTask/RenewLease/TaskControl/OpenControl/SendEvents/Complete/UploadPreview/CompletePreview`）；`task_lease.go`；`exec.go`（`eventBatcher/execResult`）；`conversation.go`；`control.go`；`workspace*.go`；`repository_checkout.go` / `repository_cache.go` / `work_branch.go`；`run_sandbox.go`；`integrate.go`；`git_http.go`；`managed_cli.go` / `cli_update.go` / `update.go`；`maintenance.go`；`detect.go:DetectRuntimes`；`align.go`；`outputs.go`；`preview_archive.go`；`login_models.go`。服务端对应 `httpapi/runners.go` + `/runners/*`。
- 执行机器规则：首条消息时固定，之后不可改；只出站 HTTPS，不开入站端口；凭证留在本机。

### 8.2 internal/managedcli（31 个文件）
- 实现：`updater.go`（`Manager/NewManager/Check/Update/UpdateProvider/Rollback`）、`manifest.go`（`Inventory.BinaryFor/ReadState/ReadInventory/PinInventory`）、`providers.go`（`EnabledProviders/AutoUpdateEnvironment/Supports`；`providerSpecs`：`agy/cursor/dsh/kimi/opencode/pi/codex` 等，`AGENTFLOW_MANAGED_CLIS` 白名单，npm 注册表 `registry.npmjs.org`，观测窗 24h、维护超时 30min）、`registry.go`、`npm.go` / `npm_config.go`、`scheduler.go:Start`、`coordinator.go`（`BeginClaim/WithMaintenance/WithUpdateLock` 防并发更新）、`vendor.go` / `vendor_archive.go` / `vendor_observation.go`、`argument_probe.go`、`command_*.go`。

### 8.3 internal/gitwork（35 个文件）
- 实现：`git.go`（`Run/Watch/C/RevParse`）、`checkouts.go:Checkouts`、`repository_cache.go`（`WithRepositoryCache/RepositoryCachePath/CloneFromRepositoryCache` 裸仓缓存 clone）、`workbranch.go`（`PushWorkBranch/PushExistingWorkBranch/PullWorkBranch/RequireOnWorkBranch/HasWork`）、`integrate.go`（`MergeLatestIntegration/MergeLatestRemoteBranch/ResolveExcludedMergeConflicts/FinishMergeAfterExcludedConflicts`）、`shared.go:MergeWorkIntoSharedBranch`、`patch.go`（`RecordBaseline/PatchInventory/ParseNameStatusNumstat`）、`remote.go:ValidateRemoteURL`、`https_remote.go`、`auth.go`（`SplitToken/EnvToken/WithToken/SandboxEnv`）、`http_credentials.go`、`https_host.go`、`ssh.go`（`NormalizeSSHPrivateKey/StartSSH/StartSSHHosts/WithSSHKeys`）、`ssh_remote.go`、`ssh_known_hosts.go` / `ssh_host_public_keys.go` / `ssh_host_probe.go:ProbeSSHHostPublicKey`、`exclude.go`（`Excluded/IsCredentialFile/IsDependencyPath`，防凭据/依赖进补丁）。

### 8.4 internal/tracker（34 个文件）
- 实现：`service.go`（`NewService/Configure/StartAutoSync/PullAll/PullScheduleJob`）：`CreateGongfengIssue/WriteBackClarification`、`ImportTAPDStory/ResyncTAPDIssue/CreateTAPDStory`、`tapd_url.go:ParseTAPDStoryURL`。`github.go`、`delivery.go:EnrichDeliveryMRStates`、`merge_mr.go:MergeSourceBranchMR/EnsureAndMergeBranchMR/FindBranchMR(s)`、`mr_delivery_sync.go:StartMRStateSync/SyncMRDeliveryStatesOnce`、`mr_state_lookup.go`、`external_mr.go`、`catalog.go`、`mcp_client.go:NewMCPClient`。接口 `httpapi/sync.go`（`/api/sync` 配置/立即同步/日志/状态）。

### 8.5 internal/preview 与 MCP
- 实现：`preview/service.go`（`NewService/SetHost/Enabled/BeginFinalization`）、`gateway.go:ServeHTTP/StrayNavigationTarget`、`archive.go`（`ArchiveDir/InspectTarZst/ExtractTarZst/ReadTarZstMember`）、`store.go` / `store_db.go`、`download.go:OpenDownload`、`devserver.go`（`RewriteDevServerHTML/Script/CSS/Location`）、`config.go`、`path.go`。`mcpserver/server.go`（`Server/HTTPHandler/ServeStdio/LocalInvoker/RemoteInvoker.Invoke`）、`mcpserver/schema.go`（`ToolInputSchema/ValidateToolInput`）；`mcpclient/client.go`；`gatemcp/server.go:Run(stdin, stdout, resultPath)`。
- 小包：`knowledge/`（`service.go` `NewService/Settings/Check/Sources`、`client.go`、`token.go` `SignProxyToken/VerifyProxyToken`、`rules.go`）、`notification/`（`service.go` `New/Sessions/Send/Start/ProcessOne`、`provider.go`、`report.go`）、`botinteraction/`（`service.go`、`cards.go`、`persistence.go`、`progress.go`、`socket.go`）、`observability/`（`hooks.go` `WriteCodeBuddyHookBridge`、`otlp.go:ParseOTLPTraces`）、`schedule/`（`service.go` `New/SetBaselineGuard/SetAssistantPrep/SetRunDispatcher`）。

---

## 分支 9 · 前端 web/（无框架，P0）

### 9.1 总体与入口链
- 实现：无 `package.json` / Vite / Webpack / TypeScript；原生 ES JS + 手写 CSS，`index.html` 按固定顺序串联 55 个 `<script>`（部分带 `?v=` 缓存戳）；字符串模板拼 `innerHTML` + `querySelector` 绑定；无路由/状态库。入口：`boot-theme.js`（首屏前置主题，读 `agentflow.theme.v3`）→ `boot.js:boot()` → `index.html` → `app.js:boot()` 拉 `/api/bootstrap`、`/api/auth/current` 初始化 `state.data` → `app/start.js:boot().catch` → `switchView(name)` 按 `location.hash` + `data-view` 切视图。
- 文件：`web/index.html` 131K、`web/app.js` 110K（`boot/switchView/api/state/renderAll`，全局状态 + 唯一请求封装 `api()`：fetch+JSON、非静默显顶部进度条、错误 toast，`repository_required` 给绑仓库快捷操作）、`web/boot.js` 819B、`web/boot-theme.js` 833B、`web/app/start.js` 498B。
- 状态：`app.js` 顶部一个大 `state` 对象（`data{runs, issues, tasks, workflows, agents, projects, repositories, users, rules, skills, mcpServers, executors, sandboxes}`、`currentUser`、`selectedRun/Issue`、filter、分页、轮询/`runStream` 句柄）；无 store，靠各模块直接读写 + 手动 `render*()`；持久化仅少量 `localStorage`（活动项目/视图/主题/语言/可观测范围）。
- 实时：运行详情 SSE `GET /api/runs/{id}/stream?after=&logsAfter=`，出错/断开降级 4s 轮询；聊天室定时轮询；其余列表靠进入视图/操作后刷新，无全局 WebSocket。

### 9.2 web/app/ 48 个 JS 文件（每个都要在导图里单列）
- `access.js` 21K：`accessMcpClientSpec/accessPublicBaseURL`，访问密钥/公开地址；`/api/auth/tokens`。
- `agents.js` 39K：`renderAgents/renderAgentsLegacy`，角色列表/删除/配置摘要；`/api/agents,/api/executor-models,/api/mcp-servers,/api/rules,/api/skills`。
- `approvals.js` 44K：`waitingNodeId/waitingActionButtons/withHumanContext`，审批队列/人工关卡批准·拒绝·打回；`/api/bootstrap,/api/issues,/api/runs,/api/runs/{id}/approve,/api/runs/{id}/decline-retry`。
- `assets.js` 56K：`assetScopeKey/assetMatchesQuery`，能力资产作用域/搜索；`/api/${assetType},/api/skills/{id}`。
- `assistant-models.js` 14K：`familyOf/engineOf/modelMeta/paint`；`/api/assistant/models?refresh=1`。
- `assistant-settings.js` 46K：`assistantPrefsForm/assistantReviewModeOf`；`/api/assistant/preferences,/api/assistant/approval-review/probe`。
- `bots.js` 46K：`loadBotModels/filteredBotSessions/canCreateBot`；`/api/notification-bots,/api/notification-deliveries`。
- `composer.js` 19K：`fillReqRepository/selectedReqRepositoryIds`，需求撰写器选项目/仓库/分支；`/api/issues,/api/sync/create`。
- `dashboards.js` 1.2K：`percent/formatTimestamp/metricsIssueSource`，指标小工具；无 API。
- `flow-history.js` 2.5K：`flowHistory:undo/redo/record/restore`，SOP 画布撤销栈。
- `flow-palette.js` 15K：`flowPalette/roleTint/roleDesc`，SOP 节点调色板/角色色。
- `flow-viewport.js` 10K：`flowViewport:zoomAt/toWorld`，画布缩放/坐标换算。
- `flows.js` 108K：SOP 画布主逻辑，`workflowPreviewContract/previewModelOptions`；`/api/workflows,/api/sandboxes`。
- `git-http-credentials.js` 13K：`openGitHTTPCredentials/renderList`；`/api/git-https-hosts,/api/users/{id}/…`。
- `git-ssh-keys.js` 9K：`loadGitSSHKeys/refreshGitSSHWarnings`；`/api/users/{id}/…`。
- `git-ssh.js` 6K：`parseSSHRepository/parseHTTPSRepository`，仓库 URL 解析/归一化。
- `github-connect.js` 9K：`startGitHubConnect/poll/mountGitHubRepoPicker`，GitHub Device Flow + 仓库选择；`/api/auth/github,/api/auth/github/device,/api/auth/github/poll,/api/auth/github/repositories`。
- `harness-motion.js` 58K：`hydrate/play/reset`，Harness 动效编排。
- `hover-ink.js` 7K：`place/expand/retract`，悬停墨水动效。
- `hui-date.js` 15K：`format/parse/addDays`，自研日期控件。
- `hui-select.js` 24K：`claim/closeAll/place/hydrate`，自研下拉控件。
- `hui-tooltip.js` 6K：`position/show/hide`。
- `hui-upload.js` 9K：`el/descriptor`，上传控件。
- `issue-bulk-delete.js` 9K：`setIssueSelectionMode/syncIssueSelection`，需求批量选择/删除。
- `issue-drawer.js` 76K：`openIssueDetail/issueClarifying`，需求抽屉详情/澄清草稿；`/api/issues/{id},/api/runs/{id},/api/tasks/{id}`。
- `issue-model.js` 45K：`issueCanClose/issueDeletionBlock`，需求关闭/删除规则。
- `issues.js` 66K：`setIssueView/renderIssueAssigneeFilter`，需求列表/筛选/派发；`/api/issues,/api/issues/{id}/dispatch,/api/issues/import-tapd,/api/projects`。
- `mcp.js` 21K：`loadMCPMarket/installMarketMCP`；`/api/mcp-market,/api/mcp-market/install,/api/mcp-servers,/api/mcp-servers/custom`。
- `notification-editor.js` 20K：`notificationPayload/normalizeWorkflowNotifications`；`/api/notification-bots,/api/notification-preview`。
- `obs-charts.js` 29K：`obsEnsureECharts/obsChartOpts`，ECharts 封装/主题。
- `observability.js` 125K：`renderObsTabs/obsTrendMetric`，统计/成本/Token 趋势；`/api/analytics,/api/insights/v1/sources,/api/insights/v1/ingest`。
- `platform-https-hosts.js` 9K；`/api/platform/git-https-hosts`。
- `platform-ssh-hosts.js` 10K；`/api/platform/git-ssh-hosts,/api/runners?mine=1`。
- `project-wizard.js` 34K：`openProjectWizard/projectWizardRepos`；`/api/projects,/api/repositories`。
- `projects.js` 55K：`renderProjectSwitcher/renderProjectContext`；`/api/projects,/api/repositories?id=`。
- `repo_drawer.js` 8K：`openRepoDrawer/repoDrawerPayload`。
- `revisions.js` 4K：`openRevisionHistory/showRevisionDiff/restoreSelectedRevision`；`/api/agents/{id},/api/workflows/{id},/api/mcp-servers/import`。
- `run-activation.js` 4K：`requestRunActivation/waitForRunWorkspaceRestore`；`/api/runs/{id}`。
- `runners.js` 30K：`refreshRunners/ensureRunnerBindCode`；`/api/runners,/api/runners/bind-codes,/api/runners/default,/api/runners/runtimes,/api/runners/runtimes/test`。
- `runs.js` 129K：`startRun/stopLiveRun/mergeLiveRun`，运行列表/详情/SSE 流/日志；`/api/runs,/api/runs/{id},/api/tasks,/api/issues,/api/agents`。
- `schedule-executions.js` 32K：`scheduleExecNow/scheduleExecStatusInfo`；`/api/schedule-job-executions/dashboard`。
- `shared-schedules.js` 26K：`refreshSharedScheduleCatalog/renderSharedScheduleMarket`；`/api/schedule-jobs/{id},/api/shared-schedule-tasks`。
- `sidebar-mode-motion.js` 5K：`capture/play`，侧栏模式切换动效。
- `skillhub.js` 45K：`skillhubCardState/skillhubInstalledSkill`；`/api/skillhub/,/api/skillhub/categories,/api/skillhub/install,/api/skillhub/skills`。
- `sliding-tabs.js` 16K：`mount/capture`，滑动标签动效。
- `sops.js` 36K：`renderCatalogScopes/toggleShare`；`/api/workflows,/api/workflow-metrics,/api/agents,/api/skills,/api/runs`。
- `sync-schedule.js` 57K：`renderSync/scheduleJobStatusText`；`/api/schedule-jobs,/api/issues,/api/projects,/api/runs/{id},/api/assistant/models?schedule=1`。
- `workbench.js` 170K：最大杂项，`updateApprovalBadge/codeBuddyEnvironment`，设置/凭据/工作台/审批徽标；`/api/auth/*,/api/assistant/cli-install,/api/anthropic` 等。
- 另约 21 个 CSS：`approvals/assets/assistant-settings/flow-canvas/frame/harness-icons/harness-motion/harness-ui/hover-ink/hui-controls/issue-list/mcp/navigation/observability-harness/requirement-wizard/sliding-tabs/sop-catalog/sops-harness/topbar-harness` 等。

### 9.3 17 个 data-view 视图 → 实现文件
- `collaboration`：AI 工作台，`index.html` + `chatbot/` iframe（`#chatNextFrame src=/chatbot/`，postMessage）+ `app.js:mountNativeChat`。
- `issues`：`issues.js+issue-drawer.js+issue-model.js+composer.js+issue-bulk-delete.js`。
- `runs`：`runs.js+run-activation.js`（SSE `/api/runs/{id}/stream`，断开降级 4s 轮询）。
- `approvals`：`approvals.js`（+ `workbench.js:updateApprovalBadge` 轮询）。
- `sops`：`sops.js`；SOP 画布：`flows.js+flow-canvas/palette/viewport/history.js+orchestrate.js`。
- `agents`：`agents.js`；`bots`：`bots.js`；`mcp`：`mcp.js`；`sandboxes`：`assets.js`；`runners`：`runners.js`；`projects`：`projects.js+project-wizard.js+repo_drawer.js`；`observability`：`observability.js+obs-charts.js`（ECharts）；`assistant`：`assistant-settings.js+assistant-models.js`；`platform`：管理员视图，`platform-*-hosts.js+workbench.js`，非管理员回落 `collaboration`；`settings`：`app/workbench.js` 大部 + `git-ssh-keys/git-http-credentials.js`；`guide`：新手引导（`index.html` 静态）；`aiSchedules`：`sync-schedule.js+shared-schedules.js+schedule-executions.js`。
- 旧名别名：`dashboard→collaboration`、`playbooks→sops`、`assets/dockerfiles/environments→sandboxes`、`management→settings`、`access→guide`。
- 疑点：`web/rooms.js` 33K（聊天室轮询，`/api/rooms`）与根 `web/workbench.js` 52K（页内 Codex 式会话工作台）不在 `index.html` 脚本列表与 `embed.go` 清单中，疑似遗留/未启用；`web/app/workbench.js` ≠ 根 `web/workbench.js`，同名不同内容。

### 9.4 web 根目录其他文件
- `login.html/js`：登录/注册；`/api/auth/setup,/api/auth/password,/api/auth/register`。`bot-bind.html/js`：机器人绑定认领；`/api/bot-bindings/claim,/api/bot-bindings/status,/api/auth/current`。`gongfeng-oauth-done.html/js`：工蜂 OAuth 回调收尾。
- `orchestrate.js` 30K：`layoutAIGraph/normalizeAIWorkflow/aiExtractArray`，SOP 设计器 AI 编排（iframe postMessage `agentflow-sop-designer-*`，草稿回放 `flows.js` 画布）。
- `i18n.js` 11K + `i18n-en.js` 339K：`translate/bindLangSwitch`，中文写代码内、英文按词典重写文本节点，语言存 `localStorage.loopforge.lang`。
- `vscode.html/js/css`：内嵌 VS Code 入口；`/api/runs/{id}`。
- 大 CSS：`platform.css` 230K、`product-v4.css` 160K、`product-v3.css` 20K、`workbench.css` 104K、`styles.css` 20K 等。
- `web/embed.go`（668B）：`//go:embed` 把 `boot.js/i18n.js/i18n-en.js/preferences.css/login.html/login.js/bot-bind.*/boot-theme.js/gongfeng-oauth-done.*/index.html/vscode.html/vscode.js/vscode.css/app.js/app/*.css/orchestrate.js/.../monaco/vendor/vscode-web/extensions/all:native-chat` 编译进后端直接 serving。

### 9.5 内嵌资产
- `web/vscode-web/` 59 MB：Code-OSS 1.91.1 完整版，供 `/vscode.html` 内嵌工作台。
- `web/monaco/` 24 MB：Monaco 编辑器（`vs/` 各语言高亮分包）。
- `web/extensions/agentflow-workspace/` 40K：仅 `extension.js+package.json+package.nls.json`，平台工作区扩展。
- `web/native-chat/`：`chatbot/` 构建产物，Go 内嵌后供 `/chatbot/`。

---

## 分支 10 · 前端 chatbot/（React 19 + Vite 6）

### 10.1 构建与入口
- 实现：`agentflow-native-chat@0.1.0`，React 19.3.1、react-markdown、mermaid、pptxgenjs、dompurify；测试 vitest + Testing Library（`chatbot/tests/` 60+ 文件）。`vite.config.js:base=/chatbot/`，产物 `../web/native-chat`，开发端口 18769，`/api、/mcp、/vscode*` 代理到 `LOOPFORGE_API`（默认 `http://127.0.0.1:8080`）。
- 文件：`chatbot/package.json`、`chatbot/vite.config.js`、`chatbot/src/main.jsx`（挂载）、`chatbot/src/prompt-editor-entry.jsx`（`mountPromptEditor`，第二入口）。

### 10.2 JSX 文件（每个单列）
- `App.jsx` 101K：`App` 总装配，`useChat/useConversationRuns`；`/api/assistant/attachments,/api/issues/{id}`。
- `useChat.js` 68K：`useChat`，会话/消息/SSE/模型/偏好核心 hook；`/api/assistant/sessions,/api/assistant/models,/api/assistant/generations,/api/assistant/preferences,/api/auth/current`。
- `QuickAccessWizard.jsx` 86K：快速上手向导，`parseGongfengRepo`；`/api/agents,/api/auth/gongfeng,/api/projects,/api/repositories,/api/sandboxes`。
- `AgentBrowser.jsx` 42K：Agent 内嵌浏览/元素拾取；`/api/runs/{id}`。
- `ArtifactPanel.jsx` 30K：产物面板；`/api/assistant/attachments`。
- `SidePanel.jsx` 25K：`SidePanel/DraftCard`，侧栏/草稿；`/api/assistant/references,/api/issues,/api/runs`。
- `RichContent.jsx` 24K：`Diagram/CopyButton`，Markdown/Mermaid/富内容渲染。
- `SopDesigner.jsx` 19K：SOP 设计器；`/api/assistant/generations,/api/assistant/models,/api/assistant/sessions`。
- `ui.jsx` 19K：`Menu/Dialog/IconButton/CredentialAction`，通用 UI。
- `SopRunPanel.jsx` 16K：`SopRunPanel/runStatus`；`/api/runs/{id}`。
- `GenerationDiagnostics.jsx` 15K：生成诊断。
- `ActivityTrace.jsx` 14K：`ActivityTrace/ReplyTimeline`，活动时间线。
- `MentionPicker.jsx` 14K：`@` 提及；`/api/assistant/references`。
- `RunAlerts.jsx` 14K：运行告警；`/api/runs/{id}`。
- `ModelPicker.jsx` 10K：模型选择。
- `PermissionPicker.jsx` 10K：`normalizeApprovalMode`，权限/审批模式。
- `HarnessSelect.jsx` 8K：自研下拉。
- `ModelProviderIcon.jsx` 8K：厂商图标（`assets/provider-logos/` 约 35 个 SVG/PNG）。
- `IssueContext.jsx` 6K：需求上下文；`/api/issues/{id},/api/assistant/references`。
- `SubagentSession.jsx` 7K：子 Agent 会话。
- `ReferenceInput.jsx` 7K：引用输入。
- `ExecutionMachinePicker.jsx` 6K：执行机器选择。
- `MessageInfo.jsx` 6K：消息详情。
- `HarnessIcon.jsx` 5K：图标。
- `cli-install.jsx` 6K：CLI 安装提示；`/api/assistant/cli-install`。
- `Participants.jsx` 5K：参与者；`/api/auth/photo`。
- `SessionContextMenu.jsx` 5K：会话右键菜单。
- `NativeApprovalPanel.jsx` 3K：原生审批面板。
- `SandboxPicker.jsx` 4K：沙箱选择。
- `QueuedMessages.jsx` 4K：排队消息。
- `HomeLogo/HomeWelcome.jsx` 3K/3K：首页。
- `WorkspaceIDE.jsx` 2K：`workspaceIDEURL`，工作区 IDE 跳转。
- `ConversationStatusIcon.jsx`、`SidebarPreview.jsx`、`SlidingTabs.jsx`：小组件。

### 10.3 JS 工具文件
- `api.js` 15K：`sessionPath/write`；`/api/assistant/sessions/{id},/api/assistant/attachments/{id}?sessionId=`。
- `activity.js` 24K：`mergeActivity/replyBlocks`。
- `changes.js` 9K：`parseUnifiedDiff/changeState`；`/api/runs/`。
- `useArtifactPanelLayout.js` 10K、`useExecutionMachines.js` 4K（`/api/runners,/api/runners/default`）、`useLocalConversations.js` 15K（本地会话夹具/离线模式）、`useWorkspaceChanges.js` 4K、`usePanelPresence.js` 2K、`runs.js` 7K（`runProblems/isConversationWorkspaceRun`）、`credentials.js` 8K、`engines.js` 5K（`EXECUTORS/defaultEngine`）、`element-context.js` 8K、`operations.js` 5K、`sop-designer.js` 5K、`node-conversation.js` 6K、`session-history/sections/status/unread.js`、`message-queue/message-info.js`、`platform.js` 4K、`mentions.js`、`composer-preferences.js`、`effort.js`、`theme.js`、`local-conversation-fixtures.js` 16K、`agent-browser-links.js`、`harness-select-model.js`、`image-load.js`、`menu-placement.js`、`presentation.js`、`artifact-autoreveal.js`、`local-id.js`、`execution-target.js`、`title-reveal.js`。
- 另约 30 个 CSS（`styles/harness-*/home/composer/*`）与 `harness-icon-definitions.json`。

---

## 分支 11 · 部署与运行

### 11.1 compose.yaml（两个服务）
- `mysql`：镜像 `mysql:8.4`；`MYSQL_DATABASE=loopforge`，`MYSQL_USER=loopforge`，密码来自 `.env` 的 `LOOPFORGE_DB_PASSWORD` / `LOOPFORGE_DB_ROOT_PASSWORD`；启动参数 `--character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci`；端口仅回环 `127.0.0.1:${LOOPFORGE_MYSQL_PORT:-33315}:3306`；卷 `mysql-data:/var/lib/mysql`；健康检查 `mysqladmin ping -h 127.0.0.1 -u loopforge --silent`，间隔 2s、超时 3s、重试 60 次。
- `platform`：镜像 `${LOOPFORGE_IMAGE:-ghcr.io/tencent/loopforge:0.4.2}`；端口 `${LOOPFORGE_BIND:-0.0.0.0}:${AGENTFLOW_HTTP_PORT:-8090}:8080`；`depends_on: mysql`（`service_healthy`）；`restart: unless-stopped`；健康检查 `python3 -c urllib.request.urlopen('http://127.0.0.1:8080/api/health')`，间隔 3s、超时 3s、重试 60 次、启动期 10s；命令 `-workspaces ${LOOPFORGE_DATA_DIR}/workspaces`。卷：`platform-data:/data`、`${LOOPFORGE_DATA_DIR}:${LOOPFORGE_DATA_DIR}`（同绝对路径挂载，供沙箱绑定工作区）、`${LOOPFORGE_DOCKER_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock`。环境变量：`AGENTFLOW_HTTP_PORT=8080`、`AGENTFLOW_MYSQL_DSN=loopforge:<密码>@tcp(mysql:3306)/loopforge`、`AGENTFLOW_SESSION_SECRET`、`AGENTFLOW_AUTH_REQUIRED=true`、`AGENTFLOW_ALLOW_SIGNUP`（默认 true）、`AGENTFLOW_SECURE_COOKIES`（默认 false）、`AGENTFLOW_GITHUB_CLIENT_ID`、`AGENTFLOW_GONGFENG_HOST`、`AGENTFLOW_TAPD_HOST`、`AGENTFLOW_MCP_TOKEN`、`AGENTFLOW_GIT_SSH_KNOWN_HOSTS`、`AGENTFLOW_ASSISTANT_SESSION_DIR=/data/assistant`、`AGENTFLOW_CONVERSATION_DIR=${LOOPFORGE_DATA_DIR}/conversations`、`AGENTFLOW_CLARIFY_SESSION_DIR=/data/clarify`、`AGENTFLOW_BASELINE_ALIGN_EXECUTOR`、`AGENTFLOW_SKIP_CODEBUDDY_INSTALL`、`AGENTFLOW_ASSISTANT_MODEL(S)`、`AGENTFLOW_APPROVAL_EGRESS_ALLOW_CIDRS`、`AGENTFLOW_PREVIEW_PUBLIC_URL`、`AGENTFLOW_PLATFORM_MCP_URL`（默认 `http://platform:8080`）、`AGENTFLOW_DOCKER_NETWORK`、`AGENTFLOW_ISOLATED_IMAGE`、`HOME=${LOOPFORGE_DATA_DIR}/home`、`AGENTFLOW_RUNNER_BINARY=/app/bin/agentflow-runner-{os}-{arch}`、`AGENTFLOW_GATE_MCP_BINARY=/app/bin/agentflow-gate-mcp-{os}-{arch}`、`AGENTFLOW_RUNTIME_CLI_DIR=${LOOPFORGE_DATA_DIR}/cli`。
- `compose.dev.yaml`：叠加层，`platform` 改为源码构建 `loopforge-platform:local`，`AGENTFLOW_ISOLATED_IMAGE` 同步改成本地 tag；用法 `./start.sh dev`，构建参数 `LOOPFORGE_BUILD_JOBS`、`LOOPFORGE_COMMIT`、`CODEBUDDY_PACKAGE=@tencent-ai/codebuddy-code@2.167.0`。

### 11.2 Dockerfile（三阶段）
- `chatbot` 阶段：`--platform=$BUILDPLATFORM node:22-bookworm-slim`；先拷 `chatbot/package.json/package-lock.json` 做 `npm ci --include=dev`，再拷 `chatbot/` 与 `web/app/`，`npm run build`，校验 `web/native-chat/index.html` 存在。
- `build` 阶段：`--platform=$BUILDPLATFORM golang:1.26.11-bookworm`；`go mod download` 后拷源码，`scripts/build-binaries.sh --helpers /out` 先编不嵌 Web UI 的 helper，再拷入 chatbot 产物，`--platform /out` 编服务端；Go 按 `TARGETOS/TARGETARCH` 交叉编译。
- 终态：`node:22-bookworm`；`apt` 装 `ca-certificates git openssh-client bash curl python3 ripgrep`；`npm install -g @openai/codex@0.162.1 @deepseek-ai/dsh@0.2.2-rc.1 @wecom/cli@1.3.4`，再装 `CODEBUDDY_PACKAGE=@tencent-ai/codebuddy-code@2.167.0`；可重定位 Python `cpython-3.12.16+20261110`（按 amd64/arm64 校验 SHA-256，删 `terminfo`）；从 `docker:27-cli` 拷 `docker` 与 `docker-buildx`；拷 `/out/` 到 `/app/bin/`；`PATH=/app/bin`；`scripts/image-commit.sh` 写 `/app/loopforge-commit`；`EXPOSE 8080`；入口 `/app/bin/agentflow`。Claude Code 不预装，首次使用时 npm 安装。

### 11.3 start.sh 与 scripts/
- `start.sh`：默认/`-d`：`bash scripts/install.sh` 后台安装/启动；`dev`：源码构建；`release`：删 `.env` 的 `COMPOSE_FILE` 行切回 GHCR；`pull`：测速选 `ghcr.io` 或南京镜像 `ghcr.nju.edu.cn`，`compose pull` 后 `up -d --wait --wait-timeout 180`，再跑 `scripts/install-schema-extensions.sh`；`migrate-sandboxes`：要求平台已停、MySQL 在跑，在 MySQL 内执行 `migrations/041_native_sandbox_inline_assets.sql`；`logs`、`stop [service]`、`down`、`restart`、`build`（拒绝，提示用 `./start.sh dev`）。
- `scripts/install.sh`（205 行）：一键容器安装，缺 Docker 则装（Linux apt/dnf/yum，macOS Homebrew），需 Python 3+curl；调 `configure.sh` 生成 `.env`、选镜像源、`docker compose --profile platform up -d --wait`；可重复跑。
- `scripts/configure.sh`（22 行，内嵌 Python）：生成 `.env`（0600，`O_EXCL` 防覆盖）：随机 `LOOPFORGE_DB_PASSWORD`、`LOOPFORGE_DB_ROOT_PASSWORD`（24 字节 hex）、`AGENTFLOW_SESSION_SECRET`（32 字节 hex），`LOOPFORGE_DATA_DIR` 默认为绝对路径 `.data`，端口 8090/33315。
- `scripts/dev.sh`（23 行）：本机开发安装：`configure.sh` → 只起 MySQL 容器 → `build-binaries.sh` → 生成 `.local/admin-password`（18 字符）并用 `loopforge-account` 建 admin → 跑 `install-observability-schema.sh` → 导入 `migrations/seed/001/002` → 前台 `exec agentflow -addr :8090 -workspaces .local/workspaces`。
- `scripts/docker-access.sh`（48 行）：判断 Docker 访问方式（直接/sudo/rootless）。
- `scripts/ghcr-mirror.sh`（407 行）：测速 `ghcr.io` 与 `ghcr.nju.edu.cn` 选快的；只在官方 digest 校验通过且镜像返回相同 digest 时才用南京镜像。
- `scripts/install-address.py`（159 行）：探测本机可访问地址。
- `scripts/install-compose.py`（45 行）：下载 pinned、校验 SHA-256 的官方 Linux Compose CLI 插件 v5.6.1。
- `scripts/install-schema-extensions.sh`（20 行）：补 gorm AutoMigrate 建不出的部分：迁移 001 的生成列、迁移 033 内置 SOP 的「发起 MR」节点、迁移 038 的 MR 角色 Git 凭据说明。
- `scripts/install-observability-schema.sh`（34 行）：基表存在后，对 Compose 数据库逐个补迁移中缺失的生成列定义。
- `scripts/build-binaries.sh`（70 行）：用与服务端同一 Go 工具链编二进制，并行度按 CPU/内存自适应（`LOOPFORGE_BUILD_JOBS`）。
- `scripts/build-chatbot.sh`（16 行）：要求 Node≥22，`npm ci` 后并行跑测试与 `vite build`，产物写 `web/native-chat`，必须在 Go 嵌入/构建前完成。
- `scripts/coverage-go.sh`（113 行）：Go 语句覆盖率，排除 `agentflow/cmd/` 与 `agentflow/deploy/`，`--min 85`；`coverage-go.min` 阈值文件（85）。
- `scripts/check-public.py`、`collect-go-notices.py`、`image-commit.sh`、`scan-secrets.sh`（gitleaks 8.30.1）、`test-container.sh`（86 行，临时目录+临时项目名，端口 8093/33317）、`test-install-live.sh`、`test-install.py`（858 行）、`test-runtime-image.sh`、`probe-cli-auth-control.py`（486 行）、`report-workflow-usage.py`、`test-coverage-go.py`、`test-scan-secrets.py`、`workbench-dev.sh`（45 行，隔离预览实例：端口 18765、MySQL 33421、状态 `/tmp/lf-workbench`，免登录）、`workbench-seed.sh`（155 行，项目 `proj-mall`）。
- `Makefile`：`run`（`go run ./cmd/agentflow`，Go≥1.26.11）、`test`（`go test -p=16 ./... -count=1 -timeout=4m`）、`test-mysql`（一次性 MySQL 8.0 容器 `:33306`）、`build`（先 `build-chatbot`，再编 `agentflow/agentflow-mcp/agentflow-runner` 到 `bin/`）、`build-gate-mcp`（交叉编 darwin/linux×amd64/arm64，`CGO_ENABLED=0`）、`coverage` / `coverage-go` / `coverage-chatbot` / `coverage-web` / `coverage-e2e`。
- `.env.example` 关键项：`LOOPFORGE_IMAGE`、`AGENTFLOW_HTTP_PORT=8090`、`AGENTFLOW_MYSQL_DSN`（示例 `REPLACE_ME`）、`AGENTFLOW_SESSION_SECRET`、`AGENTFLOW_AUTH_REQUIRED=true`、`LOOPFORGE_DB_PASSWORD`、`LOOPFORGE_DB_ROOT_PASSWORD`、`LOOPFORGE_MYSQL_PORT=33315`，可选 `AGENTFLOW_PLATFORM_MCP_URL`、`AGENTFLOW_GONGFENG_HOST`、`AGENTFLOW_TAPD_HOST`、`AGENTFLOW_MCP_TOKEN`、`AGENTFLOW_ASSISTANT_MODELS`、`AGENTFLOW_APPROVAL_EGRESS_ALLOW_CIDRS`、`AGENTFLOW_GIT_SSH_KNOWN_HOSTS`；`MIRROR=ghcr.io|ghcr.nju.edu.cn`。

### 11.4 deploy/：把本机绑为执行器
- 实现：`deploy/deploy.go`（17 行）：`//go:embed bind-cli.sh`，`Files embed.FS` + `BindCLIScript()` 返回脚本内容，供服务端经 `/runners/install.sh` 下发。
- `deploy/bind-cli.sh`（1048 行）：流程 0 预检本机 CLI 与宿主 Chromium → 1 安装二进制（默认从平台下载对应 OS/架构的 `agentflow-runner`，同时装 Docker runner 二进制与 Gate MCP helper）→ 2 写配置（`AGENTFLOW_SERVER_URL`、`AGENTFLOW_RUNNER_BOOTSTRAP_TOKEN`、`AGENTFLOW_RUNNER_NAME` 默认主机名、`AGENTFLOW_RUNNER_CONCURRENCY` 默认 1、`AGENTFLOW_GATE_MCP_BINARY` 等）→ 3 注册/启动（`--service` 时 macOS 用 launchd、Linux 用 systemd 用户服务，无 systemd 则后台运行+crontab 重启钩子；`--no-start/--no-auto-update/--upgrade/--uninstall`）。安全点：Runner 只向平台发起出站 HTTPS，不开入站端口；CLI 登录凭证留在本机；未绑定角色仍走云端 API Key；`--strict-https` 禁止 HTTPS 不可达时降级 HTTP。测试：`bind_cli_crontab_test.go`、`bind_cli_docker_runner_test.go`、`bind_cli_runner_pid_test.go`、`deploy_test.go`。

---

## 分支 12 · Local Legacy（文件级）

### 12.1 总体与安装控制面
- 实现：`loopforge-cli@0.2.3`（`local/package.json`：Node≥20，bin `loopforge`→`bin/loopforge.mjs`），需 Node 20+、Python 3.8+。`local/AGENTS.md` 定死：`.codebuddy` 是 Classic 事实源，`.cursor`/`.claude` 由 `scripts/build-classic-hosts.py --write` 生成、勿直接改；`skills/devflow/` 与 `skills/devflow-clarify-requirements/` 是 Portable 规范；两版运行时资产不可混用；`tools/tcmcp/` 是独立可选工具。
- `src/devflow_cli/cli.py`：`loopforge` 命令行入口：`install/update <host> [--edition classic|portable] [--project-root] [--force]`、`skills install/update/uninstall <host>`、`plan`（只读预览）、`status`、`uninstall`、`doctor`；`--version`。
- `src/devflow_cli/core.py`：安装引擎：`apply_install/build_plan/doctor/status_rows/uninstall/validate_choice`；写 `.devflow/install-state.json`（`STATE_VERSION=1`），SHA-256 校验，排除运行时产物。
- `src/devflow_cli/editions.py`：两版元数据：`HOSTS=(codebuddy,codex,cursor,claude,pi,dsh,hermes)`，默认版 `classic`；Portable 源 `skills/`、入口见下；Classic 源 `.codebuddy/.codex/.cursor/.claude`。
- `src/devflow_cli/targets/__init__.py`（`load(host)` 分发）及 `targets/claude.py` / `codebuddy.py` / `codex.py` / `cursor.py` / `dsh.py` / `hermes.py` / `pi.py`：各宿主一个文件，均含 `describe()` + `materialize(edition, stage)`。
- `local/bin/loopforge.mjs`（npm 入口）、`local/install.sh`（从 GitHub Release 拉 `loopforge-workflow.tar.gz` 直装进项目）、`setup.py` / `pyproject.toml`。

### 12.2 Classic：四宿主目录
- 7 个角色（各宿主同名）：`leader`、`architect`、`developer`、`code-reviewer`、`test-engineer`、`knowledge-engineer`、`solo-developer`。9 条规则：`global/architect/developer/code-review/tester/knowledge-engineer/leader/lang-golang/sql-standard`。12 条命令：`start-devflow/resume-devflow/status-devflow/abort-devflow/analyze-requirement/design-solution/develop-code/review-code/run-tests/distill-knowledge/git-commit/git-prepare`。2 份检查清单：`gate-code-review.md`、`gate-task-03.md`。运行时：`runtime/start-workflow.md`、`runtime/workflow-state-spec.md`；资产：`assets/devflow.defaults.yaml`、`assets/sub-developer-prompt.md`、`assets/workflow-state-template.json`。
- `.codebuddy/` 86 文件：事实源；独有 `hooks/approve-safe-commands.py`（放行安全命令）、`hooks/devflow-auto-dispatch.py`（自动分派）、`settings.json`、`settings.local.json`、`devflow.config.yaml.example`；规则为 `.mdc`。
- `.claude/` 81 文件：生成包；角色文件带 `devflow-` 前缀；独有 `workflows/devflow.md`、`.devflow-generated.json`；规则为 `.md`。
- `.cursor/` 81 文件：生成包；与 `.claude/` 结构相同。
- `.codex/` 42 文件：无 `commands/`；角色除 `.md` 外另有 `.toml` 注册（`devflow-*.toml` 7 个）；skills 只有 `devflow-codex`、`knowledge-distillation`、`superpowers/brainstorming`。
- `.agents/` 3 文件：仅 skills 占位/链接层。
- 三宿主共有 skills：`agent-observability`（`SKILL.md` + `config/pricing.json` + `references/quickstart.md`、`schema-v2.md` + `scripts/` 采集/上报/仪表盘 + `tests/` + `templates/settings-hook.json`）、`brainstorming`、`knowledge-distillation`、`tech-design`、`writing-plans`。

### 12.3 Portable：skills/devflow/（规范实现）
- `SKILL.md`：触发条件；硬规则：先 `inspect_context.py` 发现项目约定 → 每阶段读 `rules/core.md` 并由 `build_stage_prompt.py` 按 `rules/manifest.json` 确定性注入规则 → 完整流程读 `references/workflow-contract.md`，medium/large 再读 `agent-execution.md`、`runtime-core.md` 且只加载一个匹配的 adapter → 每阶段 `workflow_state.py prepare --emit-prompt` 再 `start→finish`；REQUIREMENT/SUMMARY 由协调者执行，DESIGN/IMPLEMENT/REVIEW/TEST 用独立 Agent，KNOWLEDGE 有条件创建；REQUIREMENT 用户确认门禁在 auto/manual 下都不可跳过；不自动 stash/commit/push/部署。
- `agents/`：10 个逻辑角色（`devflow-architect/code-explorer/code-reviewer/developer/knowledge-engineer/knowledge-retriever/requirement-owner/solo-developer/summarizer/test-engineer`）+ `manifest.json`（唯一事实源）+ `agents/openai.yaml`。
- `adapters/`：7 个宿主 + `shared`：`claude/codebuddy/codex/cursor/dsh/hermes/pi` 各有 `adapter.md`+`manifest.json`；`codebuddy` 另有 `agents/research-helper.md`、`stage-executor.md`、`cleanup_team.py`、`install.py`；`shared` 有 `research-helper.md`、`stage-executor.md`。入口：codebuddy/cursor/claude/dsh/hermes `/devflow`，codex `$devflow`，pi `/skill:devflow`。
- `commands/devflow.md`：唯一命令 `/devflow`。
- `config/workflow.json`：`max_stage_failures=2`、`max_batch_tasks=3`、`required_approval_gates=[REQUIREMENT]`、`manual_gates=[DESIGN,REVIEW,TEST]`、`optional_stages=[KNOWLEDGE]`。
- `references/`（10 篇）：`workflow-contract.md`、`runtime-core.md`、`agent-execution.md`、`backend-workflow.md`、`frontend-workflow.md`、`design-implementation.md`、`quality.md`、`manual-runtime.md`、`preview-deploy.md`。
- `rules/`：`core.md` + `manifest.json` + `profiles/golang.md`、`profiles/sql.md` + `stages/`（`requirement/design/implement/review/test/knowledge/solo/summary.md`）。
- `scripts/`（14 个）：`workflow_state.py`（状态机核心：`prepare/start/finish/approve/decide-knowledge` 等）、`build_stage_prompt.py`、`build_helper_prompt.py`、`inspect_context.py`、`install_adapter.py`、`adapter_registry.py`、`agent_registry.py`、`rule_registry.py`、`template_registry.py`、`validate_artifacts.py`、`validate_config.py`、`validate_design_artifacts.py`、`validate_plan.py`、`preflight_preview.sh`。
- `templates/`（14 个 + `manifest.json`）：`requirement-report.md`、`tech-design.md`、`design-context-*.md`（3 个）、`execution-plan.md`、`review-report.md`、`test-report.md`、`knowledge-report.md`、`change-report.md`、`api-docs.md`、`solo-report.md`、`workflow-summary.md`、`workflow-state.json`。
- `tests/`：`test_cli_e2e.py`、`test_regressions.py`。
- `skills/devflow-clarify-requirements/`（仅 2 个文件）：`SKILL.md` + `agents/openai.yaml`。流程：复述期望 → 列决策分支（`evidence-resolved`/`safe-default`/`user-decision` 三类）→ 定向检索 → 同轮最多合并问 3 个独立 `user-decision`（每题给推荐答案与 2–3 选项）→ 复述最终范围/排除项/验收场景；输出只写调用方指定路径，不实现、不提交、不写技术方案。

### 12.4 插件与工具
- `dsh-plugin/`（`@tencent/loopforge-dsh@0.1.0`）：`index.js`（Cordis 插件，`inject=['commands','tools']`）、`cordis.patch.yml`、`package.json`、`README.md`。命令 `/loopforge start/status/result/approve [REQUIREMENT|DESIGN|REVIEW|TEST]`；调项目内 `.dsh/skills/devflow/scripts/workflow_state.py`，读 `artifacts/<slug>/workflow-state.json`（slug 只允许字母数字、`-`、`_`，≤128 字符）。
- `hermes-plugin/`（`loopforge@0.1.0`）：`__init__.py`、`plugin.yaml`、`README.md`。同 4 条命令，调项目内 `.hermes/skills/devflow/scripts/workflow_state.py`。
- `local/scripts/`：`build-classic-hosts.py`（从 `.codebuddy` 生成 `.cursor`/`.claude`，`--write/--check`）、`build-release-archive.sh`、`validate.sh`（6 步）、`e2e.sh`（无网络/无 API Key，用 fake host 跑全流程）、`smoke-install.sh` / `smoke-npm.sh` / `smoke-curl-install.sh`、`test-live.sh`、`test-observability.sh`、`test-permission-hook.py`、`prepare-notices.py`、`scan-secrets.sh`。
- `local/tests/`：`test_installer.py`、`test_hermes_plugin.py`、`e2e/`（`harness.py`、`fake_agent.py`、6 个 e2e 测试）、`live/`。
- `local/tools/tcmcp/`：独立可选的腾讯云 MCP 生成器（Python 3.11+，本地 `:8088`，`app/` 含 `cam/catalog/generate/install` 与 `mcp_runtime/handlers/` 的 cdb/cls/cos/dbbrain/redis/tdsqlc/tke 等，不在 `loopforge install` 范围内）。
- 根 `skills/report-workflow-usage/`：`SKILL.md` + `agents/openai.yaml` + `references/contract.md`、`workflow-integration.md` + `scripts/report_usage.py`。把外部工作流已结束执行的真实模型用量上报到平台；输入 `AGENTFLOW_URL`、`AGENTFLOW_INSIGHT_TOKEN`、`AGENTFLOW_USAGE_FILE`；只处理指定那次执行，不估算 Token；`--check` 只校验不联网；网络错/429/5xx 最多重试 5 次，400/401/403/409/413 不自动重试。

---

## 分支 13 · 关键调用链（三条，每条都要在导图里单列，带文件）

### 13.1 链路 A：需求跑 SOP
- `POST /api/issues/:id/dispatch`（`internal/httpapi/dispatch.go:dispatchIssue`：校验阻塞、解析 SOP 绑定/默认工作流、防重复）→ `repo` 建 `Task`（`internal/repo/tasks.go`）→ `engine.StartWithRepositoriesContext`（`internal/engine/run_start.go:53`）建 `Run`（冻结 Workflow/仓库/分支）落库 → 认领循环按租约取 Run（`internal/engine/run_state.go:130 StartClaimLoop`，每 2s）→ 按 DAG 执行节点（`workflow_graph.go:readyNodes`、`node_execute.go:executeNode:319`）→ Agent 节点经 `runtime.Provider.Prepare`（`internal/runtime/provider.go:52`）生成命令 → `runtime.Manager` 建 Docker 沙箱（`sandbox_manager.go:Create`、`sandbox_docker.go`）、`gitwork` 检出仓库（`internal/gitwork/checkouts.go`、`repository_cache.go`）→ CLI 子进程流式执行，事件/日志/用量回写 `Run` → 脚本/审批/子 SOP 节点依次推进 → `engine/integrate` 合并工作分支（`internal/engine/integrate.go:53,161`）→ `tracker` 同步/创建 MR（`internal/tracker/merge_mr.go`、`mr_delivery_sync.go`），产物归档到 `preview`（`internal/preview/service.go`）。

### 13.2 链路 B：聊天 Main Bot
- `POST /api/assistant/sessions|messages`（`internal/httpapi/assistant*.go`）→ 建/取 `AssistantSession` 与 `AssistantTask`，选执行目标与模型 → `engine` 建 `Kind=workspace` 的 Live Run 并准备工作区/仓库（`internal/engine/chat_workspace.go`、`conversation_workspace.go`）→ `runtime` 在沙箱或 Runner 上起 Agent CLI（`internal/runtime/conversation_process.go:94 ConversationProcessPool`、`conversation_sandbox.go:21`），流式事件经 SSE/WebSocket 推前端（`internal/httpapi/stream.go`、`assistant_stream.go`）→ 命中原生工具调用时挂起等人工审批（`assistant_native_approval.go`），通过后继续 → 用户可 steer/暂停/接管，结束时落盘消息、提案与产物，必要时转 SOP 或开 MR。

### 13.3 链路 C：前端看一次运行
- 登录（`web/login.html/js`，`POST /api/auth/password|register`）→ `boot()` 拉 `/api/bootstrap`、`/api/auth/current`（`web/app.js`）→ 落到 `collaboration` 聊天首页（`chatbot/` iframe）→ `runs` 列表（`web/app/runs.js`）→ 运行详情 SSE `GET /api/runs/{id}/stream`（断开降级 4s 轮询 `GET /api/runs/{id}` + `/logs` + `/telemetry`）→ `approvals` 队列或运行详情人工关卡面板（`web/app/approvals.js`）→ 批准/拒绝（可填上下文、选打回目标节点）/暂停/恢复/重试/跳过失败节点 → 需求抽屉/运行详情看产物、PR/MR 链接与交付统计；`observability`（`web/app/observability.js` + `obs-charts.js`）看成本/Token/成功率。

---

## 分支 14 · 安全、权限、可观测、成本

### 14.1 权限模型：可信团队，不做多租户隔离
- 实现：登录用户可列出全部项目/需求/运行；仅项目 Owner 或平台管理员可改项目设置与仓库；个人凭据仅本人可改；项目只读成员（viewer）不可接入 SOP 工作区。首账号为管理员；`AGENTFLOW_ALLOW_SIGNUP` 默认 true，对外暴露时应关掉并显式建账号。会话内所有有项目访问权的成员共享操作权，但 Git 推送/PR 永远用本轮发言人的个人凭据。
- 文件：`internal/httpapi/project_write_access.go`、`internal/repo/platform_admin.go`、`internal/httpapi/auth*.go`。

### 14.2 安全要点
- 凭据按发言人注入：HTTPS 用 `GIT_ASKPASS` 且仅 `https://github.com` 可得令牌；SSH 用内存 ssh-agent + 受信主机公钥登记；`cloneUrl` 禁含凭据。
- 文件：`internal/gitwork/auth.go`、`http_credentials.go`、`ssh.go`、`internal/runtime/git_credential_helper.go`、`internal/runtime/run_git_credentials.go`、`internal/domain/clone_url.go`、`internal/domain/mcp_masking.go`。
- 日志/遥测脱敏 `*_API_KEY/_TOKEN/_SECRET/_PASSWORD`；0.3.8 起信任身份头需网关密钥，否则可伪造登录；HTTPS 前置反代、密钥轮换（0.4.0 曾明文泄露 CLI key，需轮换）。
- 版本号不一致：平台镜像 `0.4.2`、Local CLI `0.2.3`、tcmcp 提及 `0.2.1`，发布节奏与兼容矩阵未在所读文件中说明。

### 14.3 可观测性与成本
- 实现：运行详情含节点状态、工具 trace、worker 日志、每节点产物快照、工作区预览；“待我确认”统一收所有待审批项；SSE 推送运行流；日志/遥测用生成列（`run_telemetry.adapter`、`run_logs.level`，需 `install-schema-extensions.sh` 补齐）。
- 文件：`internal/engine/run_events.go`、`internal/engine/engine_observe.go`、`internal/observability/hooks.go`（`WriteCodeBuddyHookBridge`）、`otlp.go:ParseOTLPTraces`、`internal/repo/analytics*.go`、`web/app/observability.js`。
- 成本（`docs/token-pricing.md`，版本 `public-standard-2026-11-05`）：统一按公开标准价重算（非供应商账单），Hy/Hunyuan 系列一律 0 元，美元价按 1 USD=7 CNY，输入/输出/缓存读/缓存建分别计费，`costCny` 为人民币；未知模型不兜底、只显示覆盖率。外部工作流只上报汇总进 `insight_sources` / `insight_executions`，不建平台 Run。
- 需求列表状态色由 `issueStageTone()` 映射：运行中/排队蓝、待澄清/待确认琥珀、失败红、已合入/已完成绿、已关闭/未开始灰。

---

## 分支 15 · 测试体系

### 15.1 Go 测试
- 实现：`go test -p=16 ./... -count=1 -timeout=4m`（`Makefile:test`）；`coverage-go.sh` 最低 85%，排除 `agentflow/cmd/` 与 `agentflow/deploy/`；`test-mysql` 一次性 MySQL 8.0 容器 `:33306` 跑 `internal/repo/` 集成测试后删除。
- 文件：`Makefile`、`scripts/coverage-go.sh`、`scripts/coverage-go.min`、`internal/repo/opentest.go`（`OpenTest`，仅测试调用）。

### 15.2 webtest/（前端单元/逻辑，56 个）
- 实现：Node 原生 `node:test` + jsdom + `c8` 覆盖率；`lib/load-app.mjs` 用 `vm` + JSDOM 加载真实 `web/app*.js`，以可编排的 mock `fetch` 路由器注入 `/api/*` 假数据，在无后端/浏览器下断言渲染函数与状态逻辑。
- 文件清单：`access-guides、app-common、app-shell、approvals、asset-type-tabs-css、assets-agents、assets-skill-files、bots、collaboration-groups、composer-actions、composer-flow、flow-ai-panel-styles、flow-designer、flow-palette、flows-editor、git-http-credentials、git-ssh-keys、github-connect、hui-controls-and-sops、i18n-navigation、issue-conversation、issue-deletion-feedback、issue-drawer-actions、issue-drawer-detail、issue-model、issue-no-sop、issues-list、loader、mcp-catalog-boot、mcp-sops-runners、model-catalog-efforts、module-logic、motion-controls、obs-charts、observability-details、observability-views、orchestrate-ai、orchestrate-build、pending-mr-metric、platform-admin、project-wizard、projects-repos、revisions-bulk-notifications、run-machine-label、run-machine-label-race、runner-codebuddy-environment、runs-actions、runs-detail、schedule-executions、schedule-references、shared-schedules、skillhub-market、sop-sandbox-selection、sync-schedule、views、workbench-credentials`（均为 `.test.mjs`），另 `scripts/check-coverage.mjs`、`merge-coverage.mjs`。
- `web/` 根目录内测试：26 个 `*_test.js` + 51 个 `*_test.go`（Go 测试驱动 JS 片段/页面快照做回归，如 `syntax_test.go` 135K、`bots_test.go`、`harness_design_system_test.go`）。

### 15.3 e2e/（真实部署端到端）
- `e2e/api/`（21 个，`node:test` 直调真实后端，Bearer + 双用户越权，`lib/api.mjs/env.mjs/fixtures.mjs/version.mjs`）：`00-smoke、05-cleanup-scope、10-catalog、20-issues、30-runs、35-runner-mode、36-cloud-pool、40-model、45-delivery-model、50-platform、55-workspace、56-sandbox-preview、58-permissions、60-assistant-lifecycle、60-spaces、62-integrations、64-auth-permissions、68-workspace-edit、69-assistant-sessions、70-assistant-proposals、90-route-sweep`（路由全扫）。
- `e2e/ui/`（Playwright，7 个）：`01-views、02-interactions、03-workbench-settings、03-workspace、04-skillhub-market`（`.spec.mjs`）+ `fixtures.mjs、global-setup.mjs`。
- `e2e/public/`（9 个）：`00-first-run、composer、executors、github-setup、platform、references、welcome、without-github`（`.spec.mjs`）+ `helpers.mjs`。
- `e2e/unit/`（5 个）：`flow-designer、route-coverage、schedule-metrics-layout、setup-model-keys、version`。`e2e/layout/`（2 个）：`schedule-groups-layout、schedule-metrics-layout`。
- `e2e/run.sh/local.sh` 可起临时平台+MySQL+测试用户全量跑；`coverage/route-coverage.mjs` 统计路由覆盖。
- `chatbot/tests/`（60+，vitest）：`activity、agent-browser、app-render、artifact-autoreveal/preview-toolbar、attachment-retry、changes、chat-data、cli-install、components、composer-operations、conversation-header/navigation/runs、credentials、effort、element-picker、engines、execution-machine(s)、generation-diagnostics、harness-select、hooks、image-load、local-id、main、menu-placement、message-actions/order/queue/info、module-load、native-approval、pickers-and-activity、platform-assets、project-access/picker-options、queued-messages、quick-access-wizard、reference-input、reliability、run-problems、sandbox-picker、scrollbar-width、session-history/sections/status/unread、sop-designer、subagents、theme、title-reveal、workspace-changes-poll、workspace-ide` 等。

---

## 分支 16 · 学习路线（六阶段，每阶段带读什么文件）

1. **产品层（半天）：** `README.md` → `docs/conversation-workspaces.md` → `docs/deployment.md` 的账号/执行器/沙箱三节。目标：能跑起来、开一次对话工作区、跑通无 key 的“脚本+审批”演示 SOP。
2. **流程层：** `README.md#How SOPs work` → `docs/api/orchestration.md` → `docs/api/collaboration.md` → `docs/ai-scheduled-task-capabilities.md`。
3. **架构层：** `docs/architecture.md` → `AGENTS.md` → `docs/deployment.md` 观测 schema 与迁移节 → 再按 `internal/domain` → `internal/repo` → `internal/engine` → `internal/httpapi` → `internal/runtime` → `internal/runner` 的顺序读代码。
4. **前端层：** `design.md`（只看布局/令牌/组件三节）→ `chatbot/src/App.jsx`、`useChat.js` → `web/app.js`、`web/app/runs.js`、`flows.js`、`issues.js`。
5. **遗留层（按需）：** `docs/local/*` → `local/skills/devflow/SKILL.md` → `local/src/devflow_cli/cli.py` → `docs/token-pricing.md`、`docs/external-workflow-usage.md`。
6. **提案与验证最后读：** `docs/proposals/*` 与 `docs/validation.md` 只作“当时状态”参考，凡与 CHANGELOG 冲突以 CHANGELOG 为准。

### 读码避坑清单（9 条）
1. 前端无构建，缓存全靠 `?v=`；`state` 全局可变，SSE 与 4s 轮询交接（如 `runs.js:runStream`）有竞态可能。
2. `web/app/workbench.js` ≠ 根 `web/workbench.js`，同名不同内容；`rooms.js` 与根 `workbench.js` 不在 `embed.go` 清单中，疑似遗留。
3. 认领算法无 Redis，靠 MySQL 租约 + 2s tick，读 `run_state.go:130` 不要找队列。
4. 代码不做迁移/seed，`repo.Open()` 只做连接 + 增量 DDL，迁移一律 `migrations/*.sql` 手动执行，041 升级前必手动执行。
5. `Store` 上禁止新增领域方法，handler 与 Repo 一一对应，禁循环依赖（`AGENTS.md`）。
6. 凭据按发言人注入，Git 推送/PR 永远用本轮发言人个人凭据；`cloneUrl` 禁含凭据。
7. 平台假设可信团队，不做多租户隔离；对外暴露必须关注册、配网关密钥、做 HTTPS 前置。
8. 版本号不一致：平台镜像 `0.4.2`、Local CLI `0.2.3`、tcmcp `0.2.1`。
9. DSH 的 agy 插件需要另外安装 Antigravity CLI（`agy.exe`），IDE 本身不等于 CLI；本机 `agy.exe` 已在 `D:\agy\bin\agy.exe`，但需进 PATH 才能用。

---

## 分支 17 · 文档地图与 CHANGELOG

- 入门：`README.md` / `README.zh-CN.md`。
- 架构：`docs/architecture.md`、`docs/local/architecture.md`、`AGENTS.md`。
- 部署运维：`docs/deployment.md`（282 行，最重要）。
- 对话/工作区：`docs/conversation-workspaces.md`、`docs/conversation-native-cli.md`、`docs/runner-login-refresh.md`。
- 编排/API：`docs/api/README.md`、`orchestration.md`、`collaboration.md`、`registry.md`、`sync.md`、`shared-schedules.md`，另 `docs/api/openapi.yaml`、`docs/api/embed.go`、`docs/api/openapi_test.go`。
- 需求与任务：`docs/ai-scheduled-task-capabilities.md`、`docs/bot-sop-controls.md`（历史记录，已失效部分）。
- 成本/外部：`docs/token-pricing.md`、`docs/external-workflow-usage.md`。
- 验证：`docs/validation.md`、`docs/testing/acceptance-matrix.md`、`docs/release-readiness.md`、`docs/node-activity-validation.md`。
- 提案（未必已实现）：`docs/proposals/*`（4 篇：`cli-execution-diagnostics.md`、`frontend-preview-delivery-lifecycle.md`、`github-sign-in.md`、`runner-login-writeback-verification.md`）。
- 治理：`docs/open-source-scope.md`、`docs/upstream-sync.md`、`SECURITY.md`。
- 前端：`design.md`（496 行，仅前端设计约定）。
- Local：`docs/local/architecture.md`、`compatibility.md`、`editions.md`、`usage.md` / `usage.zh-CN.md`。
- CHANGELOG：Unreleased（破坏性：`local` 沙箱移除、Docker 沙箱内联 Dockerfile、须手动跑 041、native SOP 检出改用执行机私有裸仓缓存 Runner 0.12.0+）；0.4.2（对话可从技能安装残留符号链接恢复；`Assisted` 模式由 AI 评审做最终决定）；0.4.1（按 host 配 HTTPS Git 凭据、对话工作区可恢复、Runner 支持 Antigravity 登录、SOP 编排助手改为独立 `sop-designer` 会话面）；0.4.0（定时任务执行历史与 Token 统计、内置 SOP 增加「发起 MR」节点与 `mr` 关卡、对话工作区支持 native CLI 与执行机绑定、`dsh` 打包进平台镜像、日志脱敏）；0.3.8（信任身份头需网关密钥；GHCR 南京镜像）；0.3.7（腾讯云镜像）；0.3.6（未初始化目录默认沙箱）；0.3.5（ZCode、SOP 并行分支、需求澄清可选）。

---

*本文件仅新增于分支 `docs/loopforge-understanding-20261124`，不改动任何源码。思维导图必须以本文件为准，逐节点展开，不得只摘摘要。*
