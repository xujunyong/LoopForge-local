/**
 * @file internal/engine/run_start.js
 * 对应 Go 源文件：internal/engine/run_start.go
 *
 * 作用与职责边界：
 * 实现工作流运行的启动入口与初始化流程，负责共享定时任务权限校验、通用模板项目校验、
 * 工作流定义快照规范化（沙箱配置、基线对齐 CLI、预览构建挂载、DAG 校验与执行器规划）、
 * 多仓库工作分支分配、执行目标（本地执行机 / 云池 / 云端）选择、运行记录落库与调度循环启动。
 * 不负责运行中节点调度与状态推进。
 *
 * 语法差异说明：
 * - `Engine` 定义于 `engine.js`，本文件通过 `Engine.prototype` 挂载各启动方法。
 * - Go 的 `context.Context` 译为 `AbortSignal`；`goroutine` 译为不 `await` 的异步调用；
 *   单线程 JS 不需要 `sync.Mutex`，相关加解锁语句直接略去。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；
 *   `(值, bool)` 译为 `[值, boolean]`。
 * - Go 的 `fmt.Sprintf` `%q` 格式化译为 `JSON.stringify`；`now.UnixNano()` 译为 `BigInt(now.getTime()) * 1000000n`。
 */

"use strict";

const { Run, RunKindWorkspace, NodeRun } = require("../domain/run.js"); // 对应 Go 的 domain.Run/RunKindWorkspace/NodeRun，run.js 已翻译
const { RepositoryContext, AssignRepositoryDirs } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryContext/AssignRepositoryDirs，project.js 已翻译
const { DefaultWorkBranch } = require("../domain/work_branch.js"); // 对应 Go 的 domain.DefaultWorkBranch，work_branch.js 已翻译
const { AttachPreviewBuild } = require("../domain/preview_build.js"); // 对应 Go 的 domain.AttachPreviewBuild，preview_build.js 已翻译
const { TelemetryContext, ExecutionModeCloud, ExecutionModeRunner, RunnerWorkspaceLayoutShared } = require("../domain/observability.js"); // 对应 Go 的 domain.TelemetryContext/ExecutionModeCloud/ExecutionModeRunner/RunnerWorkspaceLayoutShared，observability.js 已翻译
const { Engine, ErrExecutionDisabled } = require("./engine.js"); // 对应 Go 同包的 Engine/ErrExecutionDisabled，engine.js 已翻译
const { normalizeRepositories, defaultWorkBranch } = require("./repository_workspace.js"); // 对应 Go 同包函数，repository_workspace.js 已翻译
const { defaultWorkflowSandboxProfile, validate } = require("./workflow_graph.js"); // 对应 Go 同包函数，workflow_graph.js 已翻译
const { configureBaselineAlignCLI } = require("./align.js"); // 对应 Go 同包函数，align.js 已翻译
const { resolveSandbox } = require("./run_environment.js"); // 对应 Go 同包函数，run_environment.js 已翻译
const { workflowSandboxRequirements } = require("./node_execute.js"); // 对应 Go 同包函数，node_execute.js 已翻译
const { inheritSOPHandoff } = require("./legacy_handoff.js"); // 对应 Go 同包函数，legacy_handoff.js 已翻译

/**
 * 为尚未指定工作分支的仓库统一分配分支名。
 * 优先沿用第一个非只读、非显式续用/新建分支仓库的 `WorkBranch`，否则调用 `generate` 生成一个新分支名；
 * 只读检出仓库的 `WorkBranch` 会被清空。
 *
 * @param {RepositoryContext[]} repositories - 待分配工作分支的仓库上下文列表（就地修改）。
 * @param {function(): string} generate - 需要新建默认工作分支名时调用的生成函数。
 * @returns {void} 无返回值。
 */
function assignWorkBranches(repositories, generate) {
  if (repositories.length === 0) {
    return;
  }
  let workBranch = "";
  const first = repositories[0];
  if (!first.RequireExistingWorkBranch && !first.CreateNewWorkBranch && !first.ReadOnly) {
    workBranch = first.WorkBranch.trim();
  }
  for (let i = 0; i < repositories.length; i++) {
    if (repositories[i].ReadOnly) {
      repositories[i].WorkBranch = "";
      continue;
    }
    if (repositories[i].WorkBranch.trim() === "") {
      if (workBranch === "") {
        workBranch = generate();
      }
      repositories[i].WorkBranch = workBranch;
    }
  }
}

/**
 * 以空仓库上下文启动指定工作流的运行。
 * 适用于无代码仓库依赖的简单工作流触发场景。
 *
 * @param {string} workflowID - 工作流唯一标识。
 * @param {string} input - 用户输入内容或任务描述。
 * @returns {Run} 创建并持久化后的运行对象。
 * @throws {Error} 工作流不存在、校验失败或持久化失败时抛出错误。
 */
Engine.prototype.Start = function (workflowID, input) {
  return this.StartWithContext(workflowID, input, new RepositoryContext());
};

/**
 * 携带单个仓库上下文与默认遥测上下文启动工作流运行。
 *
 * @param {string} workflowID - 工作流唯一标识。
 * @param {string} input - 用户输入内容或任务描述。
 * @param {RepositoryContext} repository - 单个代码仓库上下文。
 * @returns {Run} 创建并持久化后的运行对象。
 * @throws {Error} 工作流不存在、校验失败或持久化失败时抛出错误。
 */
Engine.prototype.StartWithContext = function (workflowID, input, repository) {
  return this.StartWithRepositoriesContext(workflowID, input, [repository], new TelemetryContext());
};

/**
 * 携带单个仓库上下文与自定义执行/遥测上下文启动工作流运行。
 *
 * @param {string} workflowID - 工作流唯一标识。
 * @param {string} input - 用户输入内容或任务描述。
 * @param {RepositoryContext} repository - 单个代码仓库上下文。
 * @param {TelemetryContext} executionContext - 运行执行与遥测上下文（项目、责任人、需求、父运行等）。
 * @returns {Run} 创建并持久化后的运行对象。
 * @throws {Error} 工作流不存在、校验失败或持久化失败时抛出错误。
 */
Engine.prototype.StartWithExecutionContext = function (workflowID, input, repository, executionContext) {
  return this.StartWithRepositoriesContext(workflowID, input, [repository], executionContext);
};

/**
 * 携带一个或多个仓库上下文启动工作流运行。
 * 所有仓库地位平等，各自检出至一级子目录并共享工作分支，定时运行各自执行合入与 MR；SOP 交付物留在运行工作区根目录。
 *
 * @param {string} workflowID - 工作流唯一标识。
 * @param {string} input - 用户输入内容或任务描述。
 * @param {RepositoryContext[]} repositories - 参与本次运行的仓库上下文列表。
 * @param {TelemetryContext} executionContext - 运行执行与遥测上下文。
 * @returns {Run} 创建并持久化后的运行对象。
 * @throws {Error} 工作流不存在、校验失败或持久化失败时抛出错误。
 */
Engine.prototype.StartWithRepositoriesContext = function (workflowID, input, repositories, executionContext) {
  return this.startWorkflow(workflowID, input, repositories, executionContext, false);
};

/**
 * 按工作流 ID 查找定义、校验共享定时任务资产引用范围，并委派给 `startWorkflowDefinition` 创建运行。
 *
 * @param {string} workflowID - 工作流唯一标识。
 * @param {string} input - 用户输入内容或任务描述。
 * @param {RepositoryContext[]} repositories - 仓库上下文列表。
 * @param {TelemetryContext} executionContext - 运行执行与遥测上下文。
 * @param {boolean} workspace - 是否作为对话工作区运行启动。
 * @returns {Run} 创建并持久化后的运行对象。
 * @throws {Error} 工作流不存在、共享定时任务版本/资产校验失败或目标 SOP 不在引用范围内时抛出错误。
 */
Engine.prototype.startWorkflow = function (workflowID, input, repositories, executionContext, workspace) {
  const [wf, ok] = this.repo.Workflow(workflowID);
  if (!ok) {
    throw new Error("workflow not found");
  }
  if (executionContext.SharedScheduleID !== "") {
    const version = this.repo.SharedScheduleVersion(executionContext.SharedScheduleID, executionContext.SharedScheduleVersion);
    this.repo.ValidateSharedScheduleAssets(version);
    let allowed = version.HasAsset("sop", workflowID);
    if (!allowed && executionContext.ParentRunID !== "") {
      const [parent, parentOk] = this.repo.RunState(executionContext.ParentRunID);
      if (parentOk && parent.ExecutionContext.SharedScheduleID === executionContext.SharedScheduleID && parent.ExecutionContext.SharedScheduleVersion === executionContext.SharedScheduleVersion &&
        parent.ExecutionContext.ProjectID === executionContext.ProjectID && parent.ExecutionContext.ResponsibleUserID === executionContext.ResponsibleUserID) {
        for (const node of parent.WorkflowSnapshot.Nodes) {
          if (node.Type === "sop" && node.SOPWorkflowID === workflowID && node.ID === executionContext.ParentNodeID) {
            allowed = true;
            break;
          }
        }
      }
    }
    if (!allowed) {
      throw new Error("SOP 不在共享任务的引用范围内");
    }
  }
  return this.startWorkflowDefinition(wf, input, repositories, executionContext, workspace);
};

/**
 * 基于给定的工作流定义（含仅用于单次运行的对话工作区定义，不写入目录）完成校验、快照冻结、落库并触发执行循环。
 * 控制面实例在禁用执行时仅落库未认领的运行记录，由 worker 通过恢复循环认领；合体实例直接预置首代租约并立即启动调度器。
 *
 * @param {import("../domain/workflow.js").WorkflowDefinition} wf - 工作流定义对象。
 * @param {string} input - 用户输入内容或任务描述。
 * @param {RepositoryContext[]} repositories - 仓库上下文列表。
 * @param {TelemetryContext} executionContext - 运行执行与遥测上下文。
 * @param {boolean} workspace - 是否为对话工作区运行（`true` 时状态初始化为 `waiting` 且不启动自动执行）。
 * @returns {Run} 创建并持久化后的最新运行对象。
 * @throws {Error} 引擎排空中、模板/沙箱/能力/父运行校验失败或落库失败时抛出错误。
 */
Engine.prototype.startWorkflowDefinition = function (wf, input, repositories, executionContext, workspace) {
  const workflowID = wf.ID;
  repositories = normalizeRepositories(repositories);
  AssignRepositoryDirs(repositories);
  const draining = this.draining;
  const executeRuns = this.executeRuns;
  const instanceID = this.instanceID;
  const ttl = this.leaseTTL;
  if (draining) {
    throw ErrExecutionDisabled;
  }
  wf.CollaborationMode = "";
  wf.TaskTitle = "";
  wf.GroupMembers = null;
  wf.SOPCheckpoint = null;
  wf.GroupSOPHandoff = null;
  wf.GroupHistory = null;
  if (wf.Generic) {
    if (executionContext.ProjectID.trim() === "") {
      throw new Error("直接运行通用模板需要先选择项目");
    }
    const [, found] = this.repo.Project(executionContext.ProjectID);
    if (!found) {
      throw new Error(`项目 ${JSON.stringify(executionContext.ProjectID)} 不存在，请刷新后重试`);
    }
  }
  wf = defaultWorkflowSandboxProfile(wf);
  wf = configureBaselineAlignCLI(wf);
  wf = AttachPreviewBuild(wf);
  validate(wf);
  const [profile, ok] = this.repo.Sandbox(wf.SandboxProfileID);
  if (!ok) {
    throw new Error(`sandbox profile ${JSON.stringify(wf.SandboxProfileID)} not found`);
  }
  if (workspace) {
    this.repo.ConversationSandbox(executionContext.ProjectID, profile.ID);
  }
  const sandbox = resolveSandbox(profile);
  if (executionContext.SharedScheduleID !== "") {
    this.validateSharedScheduleWorkflow(wf, executionContext.ProjectID, profile);
  }
  this.selectSOPExecutionTarget(executionContext);
  wf.ExecutorDefaults = null;
  if (executionContext.ResponsibleUserID > 0) {
    const [executorDefaults] = this.planSOPExecutors(wf, executionContext, false);
    wf.ExecutorDefaults = executorDefaults;
  }
  workflowSandboxRequirements(this.repo, wf);
  const now = new Date();
  const id = `run-${BigInt(now.getTime()) * 1000000n}`;
  assignWorkBranches(repositories, () => {
    const issueID = executionContext.IssueID.trim();
    if (issueID !== "") {
      const [issue, issueOk] = this.repo.Issue(issueID);
      if (issueOk) {
        return DefaultWorkBranch(issue, now);
      }
    }
    return defaultWorkBranch(executionContext.IssueNumber, issueID, now);
  });
  let firstRepository = new RepositoryContext();
  if (repositories.length > 0) {
    firstRepository = repositories[0];
  }
  executionContext.RunID = id;
  executionContext.TraceID = id;
  executionContext.WorkflowID = workflowID;
  executionContext.WorkflowVersion = wf.Version;
  this.requireWorkBranchCapabilities(executionContext.ExecutionRunnerID, repositories);
  wf.SandboxSnapshot = sandbox;
  let r = new Run({
    ID: id, WorkflowID: workflowID, WorkflowSnapshot: wf, Status: "running", Input: input,
    Repository: firstRepository, ExecutionContext: executionContext, Nodes: {},
    CreatedAt: now, UpdatedAt: now,
  });
  if (repositories.length > 0) {
    r.Repositories = [...repositories];
  }
  for (const n of wf.Nodes) {
    r.Nodes[n.ID] = new NodeRun({ NodeID: n.ID, Status: "pending" });
  }
  if (executionContext.ParentRunID !== "") {
    const [parent, exists] = this.repo.RunState(executionContext.ParentRunID);
    if (!exists) {
      throw new Error("父 SOP 运行不存在");
    }
    inheritSOPHandoff(parent, r);
  }
  if (workspace) {
    r.Kind = RunKindWorkspace;
    r.Status = "waiting";
  }
  if (workspace) {
    this.event(r, "", "workspace.created", "对话工作区已创建");
  } else {
    this.event(r, "", "run.started", "流水线开始执行");
  }
  if (executeRuns && !workspace) {
    if (instanceID.trim() === "" || ttl <= 0) {
      throw ErrExecutionDisabled;
    }
    r.OwnerInstanceID = instanceID;
    r.Generation = 1;
    r.LeaseUntil = new Date(now.getTime() + ttl);
  }
  this.repo.PutRun(r);
  const [current, currentOk] = this.repo.RunState(r.ID);
  if (currentOk) {
    r = current;
  }
  this.publish(r.ID);
  if (!executeRuns || r.Status === "queued" || workspace) {
    return r;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (!this.claimRunning(id, cancel)) {
    cancel();
    return r;
  }
  this.execute(controller.signal, id);
  return r;
};

/**
 * 根据责任人默认执行机、云执行机池配置及显式固定标记，为 SOP 运行选定并回写执行目标与工作区布局。
 *
 * @param {TelemetryContext} executionContext - 运行执行上下文（就地写入 `ExecutionRunnerID`、`ExecutionPool`、`ExecutionMode`、`RunnerWorkspaceLayout` 等字段）。
 * @returns {void} 无返回值。
 */
Engine.prototype.selectSOPExecutionTarget = function (executionContext) {
  if (executionContext.ParentRunID === "" && !executionContext.ExecutionPinned) {
    executionContext.ExecutionRunnerID = this.repo.DefaultRunner(executionContext.ResponsibleUserID);
    executionContext.WorkspaceRunID = "";
  }
  if (executionContext.ExecutionRunnerID === "" && !executionContext.ExecutionPinned) {
    const [runner, ok] = this.cloudPoolRunner(executionContext.ProjectID);
    if (ok) {
      executionContext.ExecutionRunnerID = runner.ID;
      executionContext.ExecutionPool = ExecutionModeCloud;
    } else if (this.cloudPoolRequired(executionContext.ProjectID)) {
      executionContext.ExecutionPool = ExecutionModeCloud;
    }
  }
  if (executionContext.ExecutionRunnerID !== "" || executionContext.ExecutionPool === ExecutionModeCloud) {
    executionContext.ExecutionMode = ExecutionModeRunner;
    executionContext.RunnerWorkspaceLayout = RunnerWorkspaceLayoutShared;
  } else {
    executionContext.ExecutionMode = ExecutionModeCloud;
  }
};

/**
 * 判断当前引擎实例是否处于允许执行且未开始排空的活跃执行状态。
 *
 * @returns {boolean} 允许执行且未排空时返回 `true`，否则返回 `false`。
 */
Engine.prototype.executes = function () {
  return this.executeRuns && !this.draining;
};

module.exports = { assignWorkBranches };
