// run_start.js —— 对应 Go 文件：internal/engine/run_start.go
// 作用：启动运行：建运行记录、冻结工作流快照并交给执行循环。
// context.Context 译为 AbortSignal；goroutine 译为不 await 的异步函数；sync.Mutex 在单线程 JS 里不需要；(值, error) 译为成功返回值、失败 throw；(值, bool) 译为 [值, bool]；fmt.Sprintf 的 %q 译为 JSON.stringify。

"use strict";

const { Run, RunKindWorkspace, NodeRun } = require("../domain/run.js"); // 对应 Go 的 domain.Run/RunKindWorkspace/NodeRun，run.js 已翻译
const { RepositoryContext, AssignRepositoryDirs } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryContext/AssignRepositoryDirs，project.js 已翻译
const { DefaultWorkBranch } = require("../domain/work_branch.js"); // 对应 Go 的 domain.DefaultWorkBranch，work_branch.js 已翻译
const { AttachPreviewBuild } = require("../domain/preview_build.js"); // 对应 Go 的 domain.AttachPreviewBuild，preview_build.js 已翻译
const { TelemetryContext, ExecutionModeCloud, ExecutionModeRunner, RunnerWorkspaceLayoutShared } = require("../domain/observability.js"); // 对应 Go 的 domain.TelemetryContext/ExecutionModeCloud/ExecutionModeRunner/RunnerWorkspaceLayoutShared，observability.js 已翻译
const { Engine, ErrExecutionDisabled } = require("./engine.js"); // 对应 Go 同包的 Engine/ErrExecutionDisabled，engine.js 已翻译

// assignWorkBranches：没有分支的仓库共用第一个仓库的工作分支，否则生成一个；显式续用或新建的分支归属各自仓库，只读检出没有工作分支。
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

Engine.prototype.Start = function (workflowID, input) {
  return this.StartWithContext(workflowID, input, new RepositoryContext());
};

Engine.prototype.StartWithContext = function (workflowID, input, repository) {
  return this.StartWithRepositoriesContext(workflowID, input, [repository], new TelemetryContext());
};

Engine.prototype.StartWithExecutionContext = function (workflowID, input, repository, executionContext) {
  return this.StartWithRepositoriesContext(workflowID, input, [repository], executionContext);
};

// StartWithRepositoriesContext：用一个或多个仓库启动运行；各仓库平等：各检出到一级子目录、共用同一工作分支，定时运行各自合入与提 MR；SOP 交付物留在运行工作区根目录。
Engine.prototype.StartWithRepositoriesContext = function (workflowID, input, repositories, executionContext) {
  return this.startWorkflow(workflowID, input, repositories, executionContext, false);
};

Engine.prototype.startWorkflow = function (workflowID, input, repositories, executionContext, workspace) {
  const [wf, ok] = this.repo.Workflow(workflowID);
  if (!ok) {
    throw new Error("workflow not found");
  }
  if (executionContext.SharedScheduleID !== "") {
    const [version, versionErr] = this.repo.SharedScheduleVersion(executionContext.SharedScheduleID, executionContext.SharedScheduleVersion);
    if (versionErr != null) {
      throw versionErr;
    }
    const assetsErr = this.repo.ValidateSharedScheduleAssets(version);
    if (assetsErr != null) {
      throw assetsErr;
    }
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

// startWorkflowDefinition：也接受仅运行一次的对话工作区定义，不向目录写模板。
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
    const [, convErr] = this.repo.ConversationSandbox(executionContext.ProjectID, profile.ID);
    if (convErr != null) {
      throw convErr;
    }
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
  const putErr = this.repo.PutRun(r);
  if (putErr != null) {
    throw putErr;
  }
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

Engine.prototype.executes = function () {
  return this.executeRuns && !this.draining;
};

module.exports = { assignWorkBranches };
