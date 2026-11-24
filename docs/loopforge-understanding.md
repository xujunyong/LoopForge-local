# LoopForge-local 项目完整理解

> 分支：`docs/loopforge-understanding-20261124`
> 基线：`main @ 074b7836410bdf905e3a938ef5cfc0f18ebf3381`（`074b783 feat: xinzeng daima`）
> 整理时间：2026-11-24
> 整理方式：本地浅克隆后通读结构 + 分四路只读调研（后端 / 前端 / 本地与部署 / 产品与架构文档），未运行、未构建仓库代码。
> 定位：这是一份“读代码 + 读文档”的理解笔记，不是官方架构文档。凡文档与代码不一致处，以代码为准；文末第 19 节列出了未完全核对的疑点。

---

## 1. 一句话定位

**LoopForge 是一个自托管、多人共享的 coding-agent 交付工作台。**

它不替代 coding-agent CLI，而是把 CLI 包进一套可重复、可审批、可追溯的交付流程里：

> 用户在聊天里向 Main Bot 提需求 → 平台在 Docker 沙箱里检出仓库、派发角色子 Agent 干活 → 按 SOP（标准作业流程）走设计、实现、评审、测试、人工验收 → 发起 MR/PR、落盘产物、日志与成本。

源头是腾讯开源的 `Tencent/LoopForge`，本仓库保留上游 Go 模块名 `agentflow` 与 `AGENTFLOW_` 环境变量前缀，方便与上游同步。许可证 MIT。

**它解决的核心痛点**（README 原意）：直接让 coding agent“修个 bug”，结果不可重复——可能跳过计划、忘记测试、自己审自己的代码、中途停了没人知道。LoopForge 用“角色分工 + SOP + 人工关卡 + 沙箱 + 可观测”把一次性的 agent 调用变成团队可交付、可复现的流程。

---

## 2. 两种工作方式 + 一个 Legacy 模式

| | Chat with Main Bot（聊天） | Run an SOP（跑 SOP） | Local（Legacy，无服务端） |
|---|---|---|---|
| 适用 | 探索、快速修复、边聊边改 | 可重复交付、固定评审与签收 | 单人在 IDE/CLI 内跑结构化流程 |
| 怎么跑 | Main Bot 按需开对话工作区（Docker 沙箱 + 仓库），角色作子 Agent | 引擎按依赖图执行节点，就绪分支可并行 | `loopforge-cli` 把 DevFlow 写进目标项目，直接跑在宿主 CLI 内 |
| 人怎么控 | 消息可排队、Steer 可打断立即发送；可暂停/恢复/接管运行中的 SOP | 人工关卡处批准、加上下文重跑、或打回指定上游节点；失败可重试、从任意节点重跑 | 需求确认后才能进设计；产物在项目内 `artifacts/<task-slug>/` |
| 交付物 | PR/MR，或 `mode=direct` 直接合入共享分支 | 文档、代码或 PR，另有每节点产物与日志 | 项目内产物 + `workflow-state.json`，无平台历史 |
| 证据 | 平台内运行详情、审批记录、用量统计 | 同左 | 本地仪表盘（可选） |

**关键设计：两种工作方式共用同一套“需求”追踪。** 无论聊天还是 SOP 改了代码，都挂在同一个 Issue/Requirement 上，计入交付与成本统计。澄清在当前版本已是可选，`待澄清`不再阻塞触发 SOP。

内置 SOP 模板（只读蓝图，需复制进项目才能用）：后端、前端、修 Bug、产品四种。典型内置流程：

```
需求 → 澄清 → 设计 → 实现 → 评审（Agent）→ 测试（Script）→ 验收（人工）→ 发起 MR → 交付
```

---

## 3. 仓库全景：目录地图

本地克隆实测：3564 个文件（浅克隆）、144 MB；GitHub 文件树 4182 条、约 110 MB blob。Go 文件 1485 个。

| 目录 | 规模 | 是什么 |
|---|---|---|
| `internal/` | 14 MB，1416 个 Go 文件（含测试） | Go 后端全部业务：领域模型、HTTP API、持久化、SOP 引擎、沙箱与执行器 |
| `cmd/` | 10 个 Go 文件，5 个入口 | `agentflow`（主服务）、`agentflow-runner`、`agentflow-mcp`、`agentflow-gate-mcp`、`loopforge-account` |
| `web/` | 89 MB，1098 个文件 | 平台前端：原生 ES JS 单页应用 + 内嵌 VS Code Web / Monaco（占大头，约 83 MB） |
| `chatbot/` | 2.4 MB，216 条 | 聊天前端：React 19 + Vite 6，构建产物供 Go 内嵌 |
| `local/` | 3.9 MB，650 条 | Legacy 本地工作流：npm 包 `loopforge-cli@0.2.3`，Classic / Portable 双实现 |
| `docs/` | 2.6 MB，30 篇文档 | 部署、对话工作区、编排 API、成本、验证、提案等 |
| `migrations/` | 40 余个 SQL | MySQL 基线迁移 001–041 + seed |
| `skills/` | 9 条 | 根目录仅一个 Skill：`report-workflow-usage/` |
| `deploy/` | 6 条 | `deploy.go` + `bind-cli.sh`（把本机绑为平台执行器） |
| `scripts/` | 30 条 | 安装、构建、部署、测试脚本 |
| `e2e/`、`webtest/` | 各约 70 个文件 | 端到端测试与前端单元/逻辑测试 |
| `design.md` | 72 KB | 前端设计约定（仅前端，非后端架构） |
| `compose.yaml`、`Dockerfile`、`Makefile`、`start.sh`、`.env.example` | — | 部署与启动入口，见第 14 节 |

**第一印象：这是一个“平台 + 遗留本地 CLI + 大前端资产”三合一的仓库。** 平台是主线，`local/` 是历史遗留但仍在维护的另一条线，`web/vscode-web` 与 `web/monaco` 是体积大户，读代码时应先跳过它们。

---

## 4. 技术栈

| 层 | 技术 | 备注 |
|---|---|---|
| 后端语言 | Go 1.26.11，模块名 `agentflow` | `go.mod` 直接依赖见下 |
| HTTP | Gin 1.12 + `gorilla/websocket` | SSE 推运行流；Runner 用长轮询 + 心跳 |
| 数据库 | MySQL 8.4（唯一数据源）+ GORM | `glebarez/sqlite` 也在依赖里，疑似仅测试/兼容，`repo.Open` 注释称 MySQL 是唯一数据源 |
| 前端（平台） | **无框架、无构建**：原生 ES JS + 手写 CSS，`index.html` 按固定顺序串联约 50 个脚本 | 状态是 `app.js` 里一个全局 `state` 单例；无路由库、无状态库 |
| 前端（聊天） | React 19 + Vite 6（`chatbot/`，私有包） | 构建产物输出到 `web/native-chat`，供 Go 内嵌 |
| 沙箱 | Docker（默认）/ native（Linux bwrap / macOS seatbelt） | Unreleased 已移除 `local` 沙箱类型 |
| 执行器 | 10 种 coding-agent CLI（见第 9 节） | 平台镜像预装 Codex / DSH / CodeBuddy / WeCom CLI；Claude Code 首次使用时装 |
| 部署 | Docker Compose、MySQL 8.4 | 平台 `:8090`、MySQL 仅回环 `:33315` |
| 测试 | Go test（覆盖率要求 85%）、Node 原生 `node:test` + jsdom、Playwright | e2e 直接调真实后端 |

Go 直接依赖（`go.mod`）：`gin`、`gorm + mysql 驱动`、`gorilla/websocket`、`goccy/go-yaml`、`creack/pty`、`mvdan.cc/sh`、`zalando/go-keyring`、`x/crypto`。**没有 Redis、消息队列等外部中间件依赖**——任务调度靠数据库 + 认领租约循环实现，这是理解引擎时最关键的一点。

---

## 5. 架构总览

```
用户浏览器 ── :8090 ──► platform 容器（Go agentflow，:8080）
   │  web/ 原生单页 + chatbot/ React（/chatbot/ 内嵌）
   │  HTTP / MCP API（internal/httpapi，按领域分 handler）
   ▼
平台进程 cmd/agentflow（-role=api | worker | all，默认 all）
   ├─ MySQL 8.4（internal/repo：每领域一个 Repo，组合为 Store）
   ├─ SOP 引擎（internal/engine：图、租约、调度、沙箱生命周期、交付）
   ├─ 沙箱 / 执行器（internal/runtime：Docker / native 沙箱 + 10 种 CLI）
   ├─ Runner（cmd/agentflow-runner：个人/池化执行机，只出站 HTTPS）
   └─ 观测：run_logs / run_telemetry / 产物快照 / SSE 流
        ▼
执行层：Docker 沙箱 / native 沙箱 ── coding CLI ── Git 仓库 / GitHub
        └─ 外部同步：Gongfeng / TAPD / GitHub（internal/tracker）
```

**分层规则（`AGENTS.md`，读代码的地图）：**

- `Store` 只组合领域 Repo 与连接生命周期，禁止在上面加领域方法。
- handler 与 Repo 一一对应、显式指针注入、禁止循环依赖。
- 代码不做迁移/seed：基线与数据迁移一律 `migrations/NNN_*.sql` 手动执行；`repo.Open()` 只做连接 + GORM AutoMigrate 补表/列/索引。

---

## 6. 后端分层：`internal/` 与 `cmd/`

### 6.1 入口（`cmd/`）

| 入口 | 作用 |
|---|---|
| `cmd/agentflow` | 主服务。启动链：`loadDotEnv → repo.Open(MySQL) → engine.New(Store, runtime.Manager) → httpapi.NewWithNotificationsAndBackground`，再启动认领循环、维护、ManagedCLI 更新；支持 SIGHUP 监听器交接（handover）。角色 `-role=api\|worker\|all` |
| `cmd/agentflow-runner` | 用户机/CVM 上的 Runner：只出站 HTTPS 连控制面，本地执行 Agent CLI，凭证不出本机；长轮询、心跳、自动更新 |
| `cmd/agentflow-mcp` | 远程 MCP（stdio，调平台 API） |
| `cmd/agentflow-gate-mcp` | 门控结果回写 |
| `cmd/loopforge-account` | 从 stdin 读密码创建本地账号（可设管理员） |

关键配置：`AGENTFLOW_HTTP_PORT=8090`、`AGENTFLOW_MYSQL_DSN`（唯一数据源）、`AGENTFLOW_SESSION_SECRET`（必填）、`AGENTFLOW_AUTH_REQUIRED`（默认 true）、`AGENTFLOW_PLATFORM_MCP_URL`、`AGENTFLOW_MCP_TOKEN`，可选 Basic Auth / TLS。

### 6.2 `internal/` 分包（按规模与职责）

| 包 | 规模 | 职责 |
|---|---|---|
| `httpapi` | 465 个 Go 文件，最大包 | Gin 路由与 Handler：assistant、issues/runs/tasks、projects、auth、runners、schedule、MCP、知识库、通知等 |
| `repo` | 206 | GORM 持久化层，按领域分 Repo，组合为 `Store` |
| `domain` | 106 | 纯模型与规则，无持久化/执行：Run、Workflow、Agent、Issue、Project、Assistant、Runner、Requirement 等 |
| `engine` | 143 | SOP/工作流引擎：建 Run、认领、节点调度、暂停/重试/审批、人机门控、集成与 MR 交付 |
| `runtime` | 83 | 沙箱与 Agent 执行器：Provider、Docker/本地沙箱、会话进程、Git 凭证、MCP 注入 |
| `runner` | 68 | 远程 Runner 守护进程：注册、心跳、长轮询认领、本地执行、上报事件/产物 |
| `gitwork` | 35 | Git 操作：clone/checkout、工作分支、SSH/HTTP 凭证、远端、补丁 |
| `managedcli` | 31 | Agent CLI 的安装/更新/回滚与版本管理 |
| `tracker` | 34 | 外部需求同步：Gongfeng、TAPD、GitHub MR 状态与交付同步 |
| `preview` | 24 | 前端预览：构建、归档、上传、会话与网关 |
| `botinteraction`（12）、`notification`（10）、`knowledge`（10） | — | 通知机器人交互、通知投递、知识库检索 |
| `auth`（9） | — | 签名用户、OAuth 交换、头像 |
| `mcpserver` / `mcpclient` / `gatemcp` | — | MCP 服务端/客户端与门控 MCP |
| `observability`（6）、`runeval`（9）、`schedule`（6）、`config`（4） | — | Hook 与 OTLP、运行评估、定时任务、启动端点解析 |
| `apperr`、`application`、`cronexpr`、`gitegress`、`gongfeng`、`procwatch` 等 | 小包 | 错误、应用装配、Cron 表达式、Git 出口、工蜂集成、进程看护 |

**读代码的推荐顺序：`domain` → `repo` → `engine` → `httpapi` → `runtime` → `runner`。** 先看模型，再看引擎，最后看接口与执行细节，否则会在 465 个文件的 `httpapi` 里迷路。

---

## 7. 核心领域模型

| 模型 | 要点 |
|---|---|
| `Run` | 一次 SOP/工作区执行。含 `WorkflowSnapshot`（冻结定义）、`Repositories[]`、`Nodes map[string]*NodeRun`、`Events/Telemetry/Logs`、`Artifacts`、`Usage`、`LeaseUntil/OwnerInstanceID`（认领租约）、`Pause/CancelRequested` |
| `WorkflowDefinition` | `Nodes[] + Edges[]`。节点类型 `agent/script/approval/sop`（另有 Preview build）；`MaxAttempts/MaxReworks`、`RetryStrategy=targeted_fix\|full_redo`、`OnFailure=fail\|reject`、`ArtifactOutputs`、`Verification` 门控、`SandboxProfileID` |
| `AgentDefinition` | 角色 Prompt、Rules、Skills、MCP、KnowledgeBase、PlatformMCP、`ExecutorID/Model/Effort` |
| `ExecutorDefinition` | `Kind=mock\|claude-code\|codex\|codebuddy` 等，含 Binary/Args/Protocol |
| `Project / Repository / RepositoryContext` | 项目、仓库与仓库上下文 |
| `Issue` | 需求，含 SOP 绑定、工作分支 |
| `Requirement` | 需求空间/阶段 |
| `AssistantSession / AssistantTask / AssistantMessage` | 聊天会话 |
| `Runner / RunnerTask / RunnerInvocation` | 远程执行 |
| `DeliveryMR` | MR 交付 |

**认证/凭证模型：** `User`、API Token、Git SSH/HTTP 凭证、Agent CLI 凭证，均与明文 Token 分离存放（037 号迁移退役明文 Git Token）。凭据按发言人注入，见第 16 节。

**一个关键心智模型：`Run` 是“快照 + 图 + 租约”。** SOP 定义在启动时被冻结成快照写进 Run，之后改 SOP 不影响已在跑的 Run；多个平台实例靠租约抢 Run，避免重复执行。

---

## 8. SOP 引擎：节点、状态与失败处理

### 8.1 节点语义

| 节点类型 | 语义 |
|---|---|
| Agent | 跑一个角色（一个 coding-agent CLI 会话） |
| Script | 确定性 shell 步骤：构建/测试/lint/报告，无 AI |
| Human gate（人工关卡） | 暂停等人工决策；可通过、加上下文重跑、或打回指定上游节点 |
| Sub-SOP | 嵌套另一 SOP |
| Preview build | 构建静态站并归档，可开沙箱预览会话 |

每个节点声明产物与依赖，依赖完成后启动；就绪分支可并行。

### 8.2 引擎主流程

`engine.Start / StartWithRepositoriesContext` 创建 Run 并冻结快照 → 认领循环按租约抢 Run → 按 DAG 调度节点 → Agent 节点经 `runtime.Provider.Prepare` 生成命令 → `runtime.Manager` 建 Docker 沙箱、`gitwork` 检出仓库 → CLI 子进程流式执行，事件/日志/用量回写 Run → 脚本/审批/子 SOP 节点依次推进 → `engine/integrate` 合并工作分支 → `tracker` 同步/创建 MR，产物归档到 `preview`（如有）。

控制面（`run_control`）：Pause / Cancel / Retry / Resume，多实例心跳与中断通知。

### 8.3 失败与重做

- 节点有 `maxAttempts` / `maxReworks`（如实现节点示例为 2/1），失败边可回退上游；`RetryStrategy` 为 `targeted_fix`（定向修复）或 `full_redo`（整段重做）。
- `mr` 关卡会查宿主确认 MR 是否存在且 head 为最新 tip，否则不放行、重试一次后转人工。
- 取消某分支后重跑，可恢复其被取消的兄弟分支而不重跑上游。

**工作区状态机（文档可确认的部分）：** 对话工作区按轮次持租约，轮次结束或切换前保存快照（`run_workspace_checkpoints`，`released_at` 标记解绑）；空闲回收先补存快照再回收，切回已回收工作区先恢复快照；SOP 执行/暂停中不回收，生命周期归 SOP；删除对话会删其自有工作区，但不删借用的 SOP 工作区。SOP 执行中其工作区对 Main Bot 只读，需先 `runs_pause` / `runs_cancel` 才能进入。

---

## 9. 沙箱与执行器

### 9.1 沙箱

`runtime.Manager.Create / AcquireRun`，驱动分 Docker（`docker exec`、绑定挂载工作区、镜像缓存、按名清理）与本地/进程沙箱；`SandboxProfile` 冻结 Dockerfile/环境；工作区准备、基线对齐、检查点/恢复、清理均在 engine/runtime 协同完成。

### 9.2 Agent 执行器：统一 `Provider` 接口

专属实现：`codebuddy` / `codex` / `claude-code` / `mock`；通用 `agentcli` 覆盖 `opencode` / `cursor` / `agy`（Antigravity）/ `kimi` / `pi` / `dsh`（DeepSeek Harness）/ `zcode`。合计 10 种 CLI。

执行流程：拼 Prompt → 注入 MCP/技能/凭证 → 沙箱内起 CLI 子进程 → 流式解析事件（`agent_cli_stream`）→ 写 Run 事件/日志/用量。

**这里有一个与使用者直接相关的点：** DeepSeek Harness（DSH）是被支持的执行器之一，但它的 `agy` 插件需要另外安装 Antigravity CLI（`agy.exe`），IDE 本身不等于 CLI。这是本仓库使用者在 Windows 上最容易踩的坑之一。

---

## 10. 聊天：Main Bot 与对话工作区

`AssistantSession` 可选执行目标（本机 / Runner / 云池）、模型与权限模式；会话即 `Kind=workspace` 的 Live Run，可中途 steer、暂停/接管、生成提案与审批；消息流走 SSE/WebSocket。

链路：`POST /api/assistant/sessions|messages`（`httpapi/assistant*.go`）→ 建/取 `AssistantSession` 与 `AssistantTask`，选执行目标与模型 → `engine` 建 Live Run 并准备工作区/仓库 → `runtime` 在沙箱或 Runner 上起 Agent CLI（`conversation_process` / `conversation_sandbox`），流式事件经 SSE/WebSocket 推前端 → 命中原生工具调用时挂起等人工审批（`assistant_native_approval`），通过后继续 → 用户可 steer/暂停/接管，结束时落盘消息、提案与产物，必要时转 SOP 或开 MR。

**执行机器（Runner）规则：** 个人/池化执行机，首条消息时固定，之后不可改。

---

## 11. 数据层：MySQL 与迁移

`repo.Open`：只接 MySQL（DSN 为空拒绝启动），自动补 `charset=utf8mb4/parseTime/loc=UTC`，连接池 32/8；`autoMigrateIncremental` 仅做增量 DDL（补列/表/索引）。

`migrations/001–041` 为人工执行的基线 SQL，覆盖：运行可观测、知识库、通知机器人、Bot 交互、工作区检查点、对话工作区、角色 Prompt、沙箱驱动、CLI/模型目录、Git 凭证、SOP MR 节点、定时执行等；`seed/001` 公共目录、`002` 欢迎项目。

`Store` 由 Catalog / Projects / Issues / Tasks / Users / Tokens / Assistant / Runs / Runners / Delivery / Analytics 等领域 Repo 匿名嵌入组成。

**注意版本风险：** Unreleased 要求升级前手动执行 `migrations/041_native_sandbox_inline_assets.sql`（Docker 沙箱改为自带内联 Dockerfile，`dockerfiles` / `environments` 资产与相关 API/工具删除；native SOP 检出改用执行机私有裸仓缓存，Runner 0.12.0+）。

---

## 12. API 路由（前端视角的对照表）

| 域 | 主要接口 |
|---|---|
| 启动/认证 | `GET /api/bootstrap`、`GET /api/auth/current\|setup\|local`、`POST /api/auth/password\|register\|logout`、`GET /api/auth/exchange?code=` |
| 需求 | `GET/POST/PATCH/DELETE /api/issues[/{id}]`、`POST /api/issues/{id}/dispatch`、`/issues/import-tapd`、`/api/sync/create` |
| SOP/运行 | `GET/POST /api/workflows[/{id}]`、`GET /api/workflow-metrics`、`GET/POST/DELETE /api/runs[/{id}]`、`/runs/{id}/stream\|logs\|telemetry\|preview[/session\|/backend\|/download]\|workspace[/restore]\|logs.txt\|eval[/stream\|/apply]\|artifacts/{aid}` |
| 审批/人工关卡 | `POST /api/runs/{id}/approve\|reject\|pass\|pause\|resume\|cancel\|refresh-sop\|decline-retry`，body 带 `nodeId`、`reason`、`targetId`、人工上下文 `context`；失败节点可重试/手动跳过（`pass`）、打回上游（`reject` 带 `targetId`） |
| 聊天室 | `GET/POST /api/rooms`、`GET/POST /api/rooms/{id}/messages\|issues`、`POST /api/rooms/{id}/decisions`、`PATCH /api/rooms/{id}` |
| 资产/平台 | `/api/agents`、`/api/skills`、`/api/sandboxes`、`/api/runners`、`/api/projects`、`/api/repositories`、`/api/users[/{id}/…credentials\|git-http-credentials\|git-token/verify]`、`/api/platform/*`、`/api/executor-models`、`/api/notification-bots\|notification-deliveries`、`/api/analytics`、`/api/insights/v1/*` |
| 健康/能力 | `/api/health`、`/api/capabilities`、`/api/openapi` |

全局中间件：日志、安全头、CORS、gzip、Token/Basic 鉴权、写保护。

---

## 13. 前端：两个前端，一种“无框架”选择

### 13.1 平台前端 `web/`：无框架、无构建

- **无 `package.json` / Vite / Webpack / TypeScript**（`web/` 下唯一的 `package.json` 属于内嵌件）。原生 ES JS + 多 CSS 文件，`index.html` 按固定顺序用 `<script src>` 串联约 50 个脚本（部分带 `?v=20261121…` 缓存戳）。
- 渲染：字符串模板拼 `innerHTML` + `document.querySelector` 事件绑定；样式手写 CSS（`product-v3/v4.css`、`platform.css`、`workbench.css` 等），主题/语言在 `boot-theme.js` / `boot.js` 首屏前置处理。
- i18n：中文直接写在代码里，英文模式由 `i18n.js` 按 `i18n-en.js`（346 KB）词典重写文本节点；语言存 `localStorage.loopforge.lang`。
- 路由：`location.hash`（如 `#/runs/…`、`#/flow/…`）+ `app.js: switchView(name)`，按 `data-view` 显示对应 section；17 个视图：`collaboration`（聊天首页）、`issues`、`runs`、`approvals`、`sops` 与 SOP 画布、`agents`、`bots`、`mcp`、`sandboxes`、`runners`、`projects`、`observability`、`assistant`、`platform`、`settings`、`guide`、`aiSchedules`。
- 状态：`app.js` 顶部一个大 `state` 对象，无 store，靠各模块直接读写 + 手动 `render*()`；持久化仅少量 `localStorage`。
- 请求层：`app.js: api(path, …)` 是唯一封装——`fetch` + JSON、非静默时显示顶部全局进度条、错误弹 toast；`body.code==='repository_required'` 时给出去绑定仓库的快捷操作。
- 实时：运行详情用 SSE `GET /api/runs/{id}/stream?after=&logsAfter=`，出错/断开降级为 4 s 轮询；聊天室为定时轮询；其余列表靠进入视图/操作后刷新，无全局 WebSocket。
- 聊天工作台：`<iframe #chatNextFrame src=/chatbot/>` + postMessage 互通；SOP 设计器 AI：`<iframe #aiOrchestratorFrame>` + `orchestrate.js` postMessage，草稿图回放到 `flows.js` 画布。
- 认证：独立 `login.html/js`，调 `/api/auth/setup` 判断是否需建管理员、`POST /api/auth/password|register` 登录/注册；另有 SSO `code` 换 token 与工蜂 OAuth 回调页。
- `embed.go` 用 Go `embed.FS` 把 `web/`（含 `monaco`、`vscode-web`、`extensions`）编译进后端直接 serving。
- 核心文件按域分（非按技术分层）：`workbench.js`（174 KB）、`runs.js`（132 KB）、`observability.js`（127 KB）、`flows.js`（110 KB，SOP 画布）、`issues.js`、`issue-drawer.js`、`projects.js`、`sops.js`、`approvals.js`、`assets.js`、`skillhub.js`、`bots.js`、`agents.js`、`mcp.js`、`runners.js`、`composer.js` 等。

### 13.2 聊天前端 `chatbot/`

`agentflow-native-chat`，React 19 + Vite 6，私有包。核心文件：`src/App.jsx`（103 KB）、`src/useChat.js`（69 KB）、`src/QuickAccessWizard.jsx`（87 KB）、`AgentBrowser.jsx`、SOP 设计器 `SopDesigner.jsx`、运行面板 `SopRunPanel.jsx`、产物面板 `ArtifactPanel.jsx`、活动追踪 `activity.js`。`src/api.js` 同源 `fetch /api/assistant/sessions/...`，另有 `useLocalConversations.js`（本地会话夹具/离线模式）。

构建：`vite.config.js`，`base: /chatbot/`，产物输出 `../web/native-chat`（供 Go 内嵌）；开发端口 `18769`，`/api`、`/mcp`、`/vscode*` 代理到 `LOOPFORGE_API`（默认 `http://127.0.0.1:8080`）。`scripts/build-chatbot.sh` 要求 Node ≥22。

### 13.3 测试

- `webtest/`（前端单元/逻辑测试，56 个用例文件）：Node 原生 `node:test` + jsdom + `c8` 覆盖率；`lib/load-app.mjs` 用 `vm` + JSDOM 加载真实 `web/app*.js`，以可编排的 mock `fetch` 路由器注入 `/api/*` 假数据，在无后端/浏览器下断言渲染函数与状态逻辑。
- `web/` 根目录内测试：26 个 `*_test.js` + 51 个 `*_test.go`——Go 测试驱动 JS 片段/页面快照做回归。
- `e2e/`（真实部署端到端）：`api/` 21 个 `node:test` 文件，直接调真实后端（Bearer Token + 双用户越权用例），覆盖 smoke、需求、运行（含审批打回/重试/手动跳过/暂停恢复/取消/并行分支/子 SOP）、Runner 模式、云池、模型、平台、工作空间、沙箱预览、权限、助手会话/提案、路由全扫（`90-route-sweep`）；`ui/` 7 个 Playwright 用例，`public/` 9 个，`unit/` 5 个，`layout/` 2 个。

---

## 14. 部署拓扑与启动

### 14.1 Docker 模式（主推）

`compose.yaml` 两个服务：

- `mysql:8.4`，仅 `127.0.0.1:${LOOPFORGE_MYSQL_PORT:-33315}:3306`，卷 `mysql-data`，健康检查 `mysqladmin ping`。
- `platform`，profile `platform`，镜像 `${LOOPFORGE_IMAGE:-ghcr.io/tencent/loopforge:0.4.2}`（发布栈永不本地构建），端口 `${LOOPFORGE_BIND:-0.0.0.0}:${AGENTFLOW_HTTP_PORT:-8090}:8080`，依赖 mysql healthy，健康检查 `GET /api/health`，`restart: unless-stopped`。卷：`platform-data:/data` + `${LOOPFORGE_DATA_DIR}:${LOOPFORGE_DATA_DIR}`（同绝对路径挂载，供沙箱绑定工作区）+ Docker socket。

`compose.dev.yaml` 叠加层：源码构建为 `loopforge-platform:local`。

`Dockerfile` 多阶段：chatbot 阶段 Node 22 构建；Go 1.26.11 交叉编译 `agentflow` / `agentflow-runner` / `agentflow-gate-mcp`；终态 Node 22，预装 Codex 0.162.1、DSH 0.2.2-rc.1、WeCom CLI、CodeBuddy 2.167.0、独立 Python 3.12、Docker CLI 27；Claude Code 不预装，首次使用时 npm 安装。入口 `/app/bin/agentflow`，`EXPOSE 8080`。

`start.sh`：默认后台安装/启动；`dev`（源码构建）、`release`（切回 GHCR）、`pull`（测速后选 `ghcr.io` 或南京镜像 `ghcr.nju.edu.cn`）、`logs/stop/down/restart`、`migrate-sandboxes`（停平台后在 MySQL 执行 `migrations/041_native_sandbox_inline_assets.sql`）。

`.env` 由 `scripts/configure.sh` 生成（0600），随机生成数据库密码与 session secret。关键配置：`LOOPFORGE_DATA_DIR`（默认 `.data`）、`AGENTFLOW_HTTP_PORT=8090`、`LOOPFORGE_MYSQL_PORT=33315`、`AGENTFLOW_AUTH_REQUIRED=true`；可选：`AGENTFLOW_GITHUB_CLIENT_ID`、`AGENTFLOW_GONGFENG_HOST`、`AGENTFLOW_TAPD_HOST`、`AGENTFLOW_MCP_TOKEN`、CodeBuddy 模型 `AGENTFLOW_ASSISTANT_MODEL(S)`、审批出口 CIDR、SSH known_hosts、`AGENTFLOW_SECURE_COOKIES`。

```
用户浏览器 ── :8090 ──► platform 容器（Go agentflow，:8080）
                         │  ├─ 挂载 ${LOOPFORGE_DATA_DIR}：workspaces/、conversations/、cli/、home/
                         │  ├─ 卷 platform-data:/data：assistant/、clarify/
                         │  ├─ 挂载 /var/run/docker.sock：按需起沙箱容器（内装各 CLI）
                         │  └─ /api、/mcp、/chatbot（内嵌 chatbot 构建产物）
                         └─► mysql:8.4 容器（127.0.0.1:33315），卷 mysql-data，库 loopforge
执行器（可选）：本机 bind-cli.sh → agentflow-runner → 出站 HTTPS 回连平台
```

启动（Docker 模式）：`./start.sh` → `scripts/install.sh`（装依赖 → `configure.sh` 生成 `.env` → 选镜像源 → `docker compose --profile platform up -d --wait`）→ mysql healthy → platform 启动 → `http://localhost:8090`。源码模式：`./start.sh dev`；本机开发模式：`scripts/dev.sh`（平台跑宿主进程，仅 MySQL 在容器）。

`Makefile`：`make run`（`go run ./cmd/agentflow`，Go ≥1.26.11）、`test`、`build`（含多 OS/arch 的 gate-mcp）、`coverage-go`（最低 85%）、`test-mysql`（一次性 MySQL 8.0 容器，端口 33306）。

### 14.2 `scripts/` 与 `deploy/`

- 安装/部署：`install.sh`、`configure.sh`、`install-compose.py`、`install-address.py`、`install-schema-extensions.sh`、`install-observability-schema.sh`、`docker-access.sh`、`ghcr-mirror.sh`。
- 开发：`dev.sh`（本机跑 Go 二进制 + MySQL 容器 + 种子 SQL，建 admin、密码写 `.local/admin-password`）、`workbench-dev.sh`（隔离实例：端口 18765、MySQL 33421、状态 `/tmp/lf-workbench`、免登录）、`workbench-seed.sh`、`build-binaries.sh`、`build-chatbot.sh`。
- 测试/安全：`test-install.py`（46 KB）、`test-install-live.sh`、`test-container.sh`、`test-runtime-image.sh`、`scan-secrets.sh`、`probe-cli-auth-control.py`（25 KB）、`coverage-go.sh`。
- `deploy/`：`deploy.go` 用 `//go:embed` 把 `bind-cli.sh` 嵌进服务端，经 `/runners/install.sh` 下发。`bind-cli.sh`（43 KB）把本机绑为平台执行器：装 `agentflow-runner` + Gate MCP helper，默认 `~/.local/bin`，`--service` 用 launchd/systemd 常驻；Runner 只向平台发起出站 HTTPS，不开入站端口；CLI 登录凭证留在本机，未绑定角色仍走云端 API Key。

---

## 15. Local（Legacy）：无平台服务器的 DevFlow

定位：单人在 IDE/CLI 内跑结构化交付流程；平台项目/SOP 改走 MCP 接入。需 Node.js 20+、Python 3.8+ 及一个 coding assistant。

两版（`local/AGENTS.md` 明确不可混用运行时资产）：

- **Classic**：`.codebuddy/` 为事实源参考实现；`.cursor/`、`.claude/` 由 `scripts/build-classic-hosts.py --write` 生成，勿直接改；`.codex/` 另有 `.toml` 角色注册。入口 `/start-devflow "<需求>"`，另有 `/resume-devflow`、`/status-devflow`、`/abort-devflow` 及分阶段命令。
- **Portable**：`local/skills/devflow/` 为规范实现，`skills/devflow-clarify-requirements/` 专做需求澄清；7 个 adapter（claude/codebuddy/codex/cursor/dsh/hermes/pi + shared），入口多为 `/devflow`，DSH 为 `/devflow`、Pi 为 `/skill:devflow`。

角色与流程：leader、architect、developer、code-reviewer、test-engineer、knowledge-engineer、solo-developer。small：`SOLO→SUMMARY`；medium/large：`REQUIREMENT→DESIGN→IMPLEMENT→REVIEW→TEST→[KNOWLEDGE]→SUMMARY`，REQUIREMENT 须用户明确确认才能进 DESIGN。产物写目标项目 `artifacts/<task-slug>/`，状态在 `workflow-state.json`；安装状态在 `.devflow/install-state.json`。

安装器：`src/devflow_cli/`（`cli.py`/`core.py`/`editions.py`/`targets/`，仅标准库），命令 `loopforge install|update|status|uninstall|doctor`、`loopforge skills install|status|uninstall <host>`、`loopforge plan`（只读预览）。`bin/loopforge.mjs` 为 npm 入口；`local/install.sh` 从 GitHub Release 拉 `loopforge-workflow.tar.gz` 直装进项目。

子件：`.codebuddy/hooks/` 有 `approve-safe-commands.py`（放行安全命令）、`devflow-auto-dispatch.py`（自动分派）；各宿主 `skills/agent-observability/` 做用量/日志采集；`dsh-plugin/`（DSH 0.2.1+，`/loopforge` 任务控制）、`hermes-plugin/`（`/loopforge start/status/result/approve`，调 `workflow_state.py`）；`tools/tcmcp/` 为独立可选工具（Python 3.11+），腾讯云 MCP 生成器，本地 `:8088`，不在 `loopforge install` 安装范围内。

**学习建议：先读平台，再按需读 Local。** Local 是另一套“无服务端”的实现，概念（角色、阶段、确认门）与平台相通，但代码完全不同，混着读最容易晕。

---

## 16. 安全、权限、可观测性与成本

### 16.1 权限模型：可信团队，不做多租户隔离

平台假设可信团队——登录用户可列出全部项目/需求/运行；仅项目 Owner 或平台管理员可改项目设置与仓库；个人凭据仅本人可改；项目只读成员（viewer）不可接入 SOP 工作区。首账号为管理员；`AGENTFLOW_ALLOW_SIGNUP` 默认 true，对外暴露时应关掉并显式建账号。会话内所有有项目访问权的成员共享操作权，但 Git 推送/PR 永远用**本轮发言人**的个人凭据。

### 16.2 安全要点

- 凭据按发言人注入：HTTPS 用 `GIT_ASKPASS` 且仅 `https://github.com` 可得令牌；SSH 用内存 ssh-agent + 受信主机公钥登记；`cloneUrl` 禁含凭据。
- 日志/遥测脱敏 `*_API_KEY/_TOKEN/_SECRET/_PASSWORD`；0.3.8 起信任身份头需网关密钥，否则可伪造登录；HTTPS 前置反代、密钥轮换（0.4.0 曾明文泄露 CLI key，需轮换）均在文档中提示。
- 版本号不一致需注意：平台镜像 `0.4.2`、Local CLI `0.2.3`、tcmcp 提及 `0.2.1`，三者发布节奏与兼容矩阵未在所读文件中说明。

### 16.3 可观测性与成本

运行详情含节点状态、工具 trace、worker 日志、每节点产物快照、工作区预览；“待我确认”统一收所有待审批项；SSE 推送运行流；日志/遥测用生成列（`run_telemetry.adapter`、`run_logs.level`，需 `install-schema-extensions.sh` 补齐）。

成本（`docs/token-pricing.md`，版本 `public-standard-2026-11-05`）：统一按公开标准价重算（非供应商账单），Hy/Hunyuan 系列一律 0 元，美元价按 1 USD=7 CNY，输入/输出/缓存读/缓存建分别计费，`costCny` 为人民币；未知模型不兜底、只显示覆盖率。外部工作流只上报汇总进 `insight_sources` / `insight_executions`，不建平台 Run。

需求列表状态色由 `issueStageTone()` 映射：运行中/排队蓝、待澄清/待确认琥珀、失败红、已合入/已完成绿、已关闭/未开始灰。

---

## 17. 关键调用链（三条）

### 链路 A：需求跑 SOP

```
POST /api/issues/:id/dispatch（httpapi/dispatch.go：校验阻塞、解析 SOP 绑定/默认工作流、防重复）
  → repo 建 Task
  → engine.StartWithRepositoriesContext 建 Run（冻结 Workflow/仓库/分支）落库
  → 认领循环按租约取 Run
  → 按 DAG 执行节点：Agent 节点经 runtime.Provider.Prepare 生成命令
    → runtime.Manager 建 Docker 沙箱、gitwork 检出仓库
    → CLI 子进程流式执行，事件/日志/用量回写 Run
  → 脚本/审批/子 SOP 节点依次推进
  → engine/integrate 合并工作分支
  → tracker 同步/创建 MR，产物归档到 preview（如有）
```

### 链路 B：聊天 Main Bot

```
POST /api/assistant/sessions|messages
  → 建/取 AssistantSession 与 AssistantTask，选执行目标与模型
  → engine 建 Kind=workspace 的 Live Run 并准备工作区/仓库
  → runtime 在沙箱或 Runner 上起 Agent CLI（conversation_process / conversation_sandbox）
  → 流式事件经 SSE/WebSocket 推前端
  → 命中原生工具调用时挂起等人工审批（assistant_native_approval），通过后继续
  → 用户可 steer/暂停/接管，结束时落盘消息、提案与产物，必要时转 SOP 或开 MR
```

### 链路 C：前端看一次运行

```
登录（login.html）→ boot() 拉 /api/bootstrap、/api/auth/current
  → 落到 collaboration 聊天首页
  → runs 列表 → 运行详情 SSE GET /api/runs/{id}/stream（断开降级 4 s 轮询）
  → approvals 队列或运行详情人工关卡面板 → 批准/拒绝/暂停/恢复/重试/跳过
  → 需求抽屉/运行详情看产物、PR/MR 链接与交付统计；observability 看成本/Token/成功率
```

---

## 18. 资深架构师的学习路线（建议顺序）

1. **产品层（半天）：** `README.md` → `docs/conversation-workspaces.md` → `docs/deployment.md` 的账号/执行器/沙箱三节。目标：能跑起来、开一次对话工作区、跑通无 key 的“脚本+审批”演示 SOP。
2. **流程层：** `README.md#How SOPs work` → `docs/api/orchestration.md`（SOP/run/人工动作/SSE）→ `docs/api/collaboration.md`（需求派发）→ `docs/ai-scheduled-task-capabilities.md`。
3. **架构层：** `docs/architecture.md` → `AGENTS.md`（repo/handler 分层是读代码的地图）→ `docs/deployment.md` 观测 schema 与迁移节 → 再按 `internal/domain` → `internal/repo` → `internal/engine` → `internal/httpapi` → `internal/runtime` → `internal/runner` 的顺序读代码。
4. **前端层：** `design.md`（只看布局/令牌/组件三节即可，余下是逐页约定）→ `chatbot/` 与 `web/` 对照。注意 `web/` 是无框架实现，不要用 React/Vue 的心智模型去读它。
5. **遗留层（按需）：** `docs/local/*`（Classic/Portable 双实现、安装控制面）→ `docs/token-pricing.md`、`docs/external-workflow-usage.md`。
6. **提案与验证最后读：** `docs/proposals/*` 与 `docs/validation.md` 只作“当时状态”参考，凡与 CHANGELOG 冲突以 CHANGELOG 为准。

**配套思维导图：** 另见本任务交付的交互式思维导图（LoopForge 学习地图），与本文一一对应：中心是“从需求到 MR”，六大分支是产品、后端、前端、部署、Local、学习路径。

### CHANGELOG 最近重要变化（读代码前先知道）

- **Unreleased（破坏性）：** `local` 沙箱类型移除，native 沙箱只剩环境变量；Docker 沙箱改为自带内联 Dockerfile；升级前须手动执行 `migrations/041_native_sandbox_inline_assets.sql`；native SOP 检出改用执行机私有裸仓缓存（Runner 0.12.0+）。
- **0.4.2：** 对话可从技能安装残留符号链接中恢复；`Assisted（帮我批准）` 模式由 AI 评审做最终决定，不可用则阻塞。
- **0.4.1：** 按 host 配 HTTPS Git 凭据、MCP 可用已配凭据；对话工作区可恢复、Runner 支持 Antigravity 登录；SOP 编排助手改为独立 `sop-designer` 会话面，只读工具、只产 `workflows_save` 草稿。
- **0.4.0：** 定时任务执行历史与 Token 统计；内置 SOP 增加“发起 MR”节点与 `mr` 关卡；对话工作区支持 native CLI 与执行机绑定；`dsh` 打包进平台镜像；日志脱敏 `_API_KEY` 等。

---

## 19. 架构评价与未确认的疑点

### 优点

- **边界清晰：** 平台不重复造 agent，只做“角色—沙箱—流程—审批—交付证据”这一层，执行层复用 10 种 CLI，演进成本低。
- **可重复性是第一公民：** SOP 快照冻结、节点产物声明、人工关卡、重跑语义，都是围绕“同一流程第二次跑出同一结果”设计的。
- **无外部中间件：** 只依赖 MySQL，部署与运维门槛低；调度靠租约循环，简单但够用。
- **可观测与成本意识强：** 每节点产物快照、工具 trace、Token/成本统计、审批统一收口。

### 短板与风险（读代码时的注意点）

- **前端是“无框架 + 全局可变 state”：** `web/` 无构建、无 store，`state` 为全局可变单例，并发轮询与 SSE 混用时存在竞态可能（如 `runStream` 与 4 s 轮询的交接），未做时序验证。
- **权限假设是可信团队：** 不做多租户隔离，对外暴露必须关注册、配网关密钥、做 HTTPS 前置，否则有越权与伪造登录风险。
- **文档与实现有滞后：** `docs/architecture.md` 仅 21 行；`docs/bot-sop-controls.md` 自标历史记录、部分已失效；`docs/proposals/*` 是方案而非落地清单。
- **版本与端口多套并存：** 平台 8090/8080、`chatbot` 开发 18769、`workbench-dev.sh` 18765、MySQL 33315/33421，文档未集中说明何时用哪一个。

### 未确认的疑点（需逐行读代码核对）

1. `StartClaimLoop` 的具体认领算法（租约续期、失败转移细节）未逐行读，仅从 `main.go` 与 `run_control` 的心跳/中断推断。
2. SQLite 驱动的实际用途（仅测试，还是本地模式兜底）未确认；`repo.Open` 注释称 MySQL 是唯一数据源。
3. `migrations/` 的执行入口未见代码内调用，推断为部署脚本/人工执行，需对照 `scripts/` 与 `compose.yaml` 确认。
4. Run/节点/需求的完整状态枚举与转移表在文档中未集中给出，须以 `internal/engine` 与 `docs/api/orchestration.md` 的实际字段为准。
5. `web/rooms.js` 与 `web/workbench.js` 不在 `index.html` 脚本列表与 `embed.go` 嵌入清单中，疑似遗留/未启用代码；`web/app/workbench.js` 与根目录 `web/workbench.js` 同名但内容不同，需谨慎区分。
6. `runs.js` 中 1 处 `WebSocket` 字面出现未逐行核实；`vscode-web` / `monaco` 是否在常规流程中实际加载、还是仅供 `/vscode.html` 入口使用，未验证。
7. `bind-cli.sh` 的绑定码/token 有效期、吊销方式及 runner 自动更新策略，只读了脚本头部与测试名，未逐行核对。
8. 本仓库与上游 `Tencent/LoopForge` 的差异点（fork 的本地化改动）未在文档中单列，`docs/upstream-sync.md` 只讲同步流程不讲差异清单。
9. `LOOPFORGE_DATA_DIR` 默认值：`configure.sh` 取 `.data` 绝对路径，但 `compose.yaml` 要求该变量已存在，手工写 compose 而不跑 configure 会失败。

---

## 20. 附录：术语表与文档地图

### 术语表

| 中文 | 英文 | 要点 |
|---|---|---|
| 需求 | Requirement / Issue | 交付的追踪单元；聊天与 SOP 共用同一需求 |
| 主 Bot | Main Bot | 聊天入口；按需开工作区、派发角色子 Agent、可暂停/接管 SOP |
| 角色 | Role / Agent | 可复用定义：prompt、执行器、模型、规则、Skills、MCP、产物与关卡 |
| SOP | Standard Operating Procedure / Workflow | 可版本化、可发布的交付流程图 |
| 节点 | Node | Agent、Script、Human gate、Sub-SOP、Preview build 五类 |
| 人工关卡 | Human gate | 暂停等审批；可通过、加上下文重跑、或打回指定上游节点 |
| 运行 | Run | 一次 SOP 执行实例；含节点状态、日志、遥测、产物快照 |
| 对话工作区 | Conversation workspace | 按需开的运行环境（非一次检出）；一个对话同时只绑一个 |
| 沙箱 | Sandbox | Docker（默认 `generic-docker`）或 native（Linux bwrap / macOS seatbelt） |
| 执行机器 | Runner / Execution machine | 个人/池化执行机；首条消息时固定，之后不可改 |
| 能力资产 | Capability assets | Agent/规则/Skill/MCP/执行器/沙箱的注册表 |
| 定时任务 | AI scheduled task / ScheduleJob | 提示词任务或 SOP 自动派发；可发布为共享市场模板 |
| 交付 | Delivery / MR | 内置 SOP 在“人工验收”后有“发起 MR”节点 |

### 文档地图

| 分组 | 文档 | 主旨 |
|---|---|---|
| 入门 | `README.md` / `README.zh-CN.md` | 定位、两种工作方式、SOP、功能表、FAQ |
| 架构 | `docs/architecture.md`、`docs/local/architecture.md`、`AGENTS.md` | 平台目录分工；Local 双工作流；repo/handler 分层规则 |
| 部署运维 | `docs/deployment.md`（282 行，最重要） | 原生开发、执行器选择、容器安装、账号、Runner、观测 schema、迁移、GitHub 凭据 |
| 对话/工作区 | `docs/conversation-workspaces.md`、`docs/conversation-native-cli.md`、`docs/runner-login-refresh.md` | 工作区生命周期、执行机器、native 沙箱、登录续期 |
| 编排/API | `docs/api/README.md`、`orchestration.md`、`collaboration.md`、`registry.md`、`sync.md`、`shared-schedules.md` | SOP/运行/定时任务/协作/能力注册表 API |
| 需求与任务 | `docs/ai-scheduled-task-capabilities.md`、`docs/bot-sop-controls.md`（历史记录，已失效部分） | 定时任务权限；旧 Bot 交接已移除 |
| 成本/外部 | `docs/token-pricing.md`、`docs/external-workflow-usage.md` | 公开价计费口径；外部工作流只上报汇总 |
| 验证 | `docs/validation.md`、`docs/testing/acceptance-matrix.md`、`docs/release-readiness.md`、`docs/node-activity-validation.md` | 验收记录（多为 2026-10-16）、覆盖矩阵 |
| 提案（未必已实现） | `docs/proposals/*`（4 篇） | 方案/验证记录，读时需与 CHANGELOG 交叉核对 |
| 治理 | `docs/open-source-scope.md`、`docs/upstream-sync.md`、`SECURITY.md` | 公开范围、上游同步、漏洞上报 |
| 前端 | `design.md` | 仅前端设计约定，非后端架构 |

---

*本文档仅新增于本分支，不改动任何源码。下一步建议：按第 18 节路线跑通一次 `./start.sh` + 对话工作区 + 演示 SOP，再回头逐包读 `internal/engine` 与 `internal/runtime`。*
