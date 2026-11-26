/**
 * @file internal/repo/requirement.js
 * 对应 Go 源文件：internal/repo/requirement.go
 *
 * 作用与职责边界：
 * 在只读分析仓储 `AnalyticsRepo` 上提供需求进度快照（`RequirementSnapshot`）聚合逻辑，
 * 将单个 Issue 及其关联的顶层/嵌套运行、任务、项目与 SOP 工作流绑定整合为多泳道、节点阶段树、
 * 生命周期步骤、对话工作区分支与总体统计视图；不修改任何持久化状态。
 *
 * 语法差异说明：
 * - `AnalyticsRepo` 定义于 `repo.js`，本文件通过 `AnalyticsRepo.prototype` 挂载 `RequirementSnapshot`。
 * - Go 的 `(值, bool)` 与 `(值1, 值2)` 均译为二元组返回；Go 忽略的错误（`runs, _`、`if snapshots, err := ...; err == nil`）用 `try ... catch` 对应处理。
 * - Go 的 `time.Time` 零值译为 `null`，复用 `analytics.js` 提供的 `isZeroTime`/`timeMs`/`timeBefore`/`timeAfter` 保持零值时间比较语义一致。
 * - Go 的 `map[string]V` 统一译为普通对象 `{}`；切片遍历对可能为 `null` 的嵌套子阶段做空数组兜底以匹配 Go 的 `range nil`。
 */

"use strict";

const { RequirementSnapshot, RequirementConversation, RequirementBranch, RequirementLane, RequirementNodeStage, RequirementStage, RequirementOverall } = require("../domain/requirement.js"); // 对应 Go 的 domain.Requirement*，requirement.js 已翻译
const { WorkflowDefinition, WorkflowNode } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition/WorkflowNode，workflow.js 已翻译
const { Run } = require("../domain/run.js"); // 对应 Go 的 domain.Run，run.js 已翻译
const { AnalyticsFilter } = require("../domain/analytics.js"); // 对应 Go 的 domain.AnalyticsFilter，analytics.js 已翻译
const { InferSOPLane, SOPLaneLabel } = require("../domain/sop_lane.js"); // 对应 Go 的 domain.InferSOPLane/SOPLaneLabel，sop_lane.js 已翻译
const { ResolveSOPBindings } = require("../domain/issue_sop.js"); // 对应 Go 的 domain.ResolveSOPBindings，issue_sop.js 已翻译
const { StripURLCredentials } = require("../domain/clone_url.js"); // 对应 Go 的 domain.StripURLCredentials，clone_url.js 已翻译
const { AnalyticsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runExecutionDuration, runEndedAt, queryAnalyticsWorkflowSnapshots } = require("./runs.js"); // 对应 Go 同包函数，runs.js 待翻译
const { usageCostKnown, isZeroTime, timeMs, timeBefore, timeAfter } = require("./analytics.js"); // 对应 Go 同包函数与时间比较，analytics.js 已翻译

/**
 * 聚合指定需求的 Issue、运行摘要、工作流快照、关联任务与绑定 SOP，生成只读需求进度快照。
 * 归属于只读跨领域分析层 `AnalyticsRepo`，而非 `Store`。
 *
 * @param {string} issueID - 目标需求（Issue）的主键 ID。
 * @returns {[RequirementSnapshot, boolean]} 找到对应 Issue 时返回 `[snapshot, true]`，否则返回 `[空 RequirementSnapshot, false]`。
 */
AnalyticsRepo.prototype.RequirementSnapshot = function (issueID) {
  const [issue, ok] = this.issues.Issue(issueID.trim());
  if (!ok) {
    return [new RequirementSnapshot(), false];
  }
  let runs = [];
  try {
    runs = this.runs.RunSummariesFor(new AnalyticsFilter(), issue.ID) ?? [];
  } catch {
    runs = [];
  }
  if (this.DB != null && runs.length > 0) {
    const ids = [];
    for (const run of runs) {
      ids.push(run.ID);
    }
    let snapshots = null;
    try {
      snapshots = queryAnalyticsWorkflowSnapshots(this.DB, ids);
    } catch {
      snapshots = null;
    }
    if (snapshots != null) {
      for (let i = 0; i < runs.length; i++) {
        const snapshot = snapshots[runs[i].ID];
        if (snapshot != null) {
          runs[i].WorkflowSnapshot = snapshot;
        }
      }
    }
  }
  const workflows = {};
  for (const workflow of this.catalog.Workflows()) {
    workflows[workflow.ID] = workflow;
  }
  const tasks = [];
  for (const task of this.tasks.Tasks()) {
    if (task.IssueID === issue.ID) {
      tasks.push(task);
    }
  }
  const [project] = this.projects.Project(issue.ProjectID);
  return [BuildRequirementSnapshot(issue, project, runs, tasks, workflows, new Date()), true];
};

/**
 * 纯内存计算需求进度快照：拆分嵌套子运行、构建 SOP 泳道、汇总整体统计、推导主生命周期与对话工作区信息。
 * 既由 `AnalyticsRepo.RequirementSnapshot` 调用，也便于单元测试直接传入夹具验证聚合逻辑。
 *
 * @param {import("../domain/issue.js").Issue} issue - 目标需求 Issue。
 * @param {import("../domain/project.js").Project} project - 需求所属项目。
 * @param {Run[]} runs - 与该需求关联的全部运行记录。
 * @param {import("../domain/task.js").Task[]} tasks - 与该需求关联的任务记录。
 * @param {Object<string, WorkflowDefinition>} workflows - 以工作流 ID 为键的工作流定义目录映射。
 * @param {Date | null} now - 计算进行中耗时所依据的当前 UTC 时间；为零值时自动取当前系统时间。
 * @returns {RequirementSnapshot} 完整的需求进度快照领域对象。
 */
function BuildRequirementSnapshot(issue, project, runs, tasks, workflows, now) {
  if (isZeroTime(now)) {
    now = new Date();
  }
  const [top, nested] = splitNestedRuns(runs);
  const lanes = buildRequirementLanes(issue, project, top, nested, tasks, workflows, now);
  const overall = requirementOverall(issue, lanes, top, nested, now);
  return new RequirementSnapshot({
    Issue: issue,
    Overall: overall,
    Lanes: lanes,
    Stages: requirementLifecycle(issue, lanes),
    Conversation: requirementConversation(issue, top),
  });
}

/**
 * 提取需求关联的对话会话 ID 以及在对话工作区运行中触达的去重仓库分支列表（最新在前）。
 * 若需求既未绑定对话会话也没有工作区运行，则返回 `null`；对话是否仍存在由调用方自行判断。
 *
 * @param {import("../domain/issue.js").Issue} issue - 目标需求 Issue。
 * @param {Run[]} runs - 顶层运行记录数组。
 * @returns {RequirementConversation | null} 对话工作区摘要对象，无相关记录时返回 `null`。
 */
function requirementConversation(issue, runs) {
  const conv = new RequirementConversation({ SessionID: issue.ConversationSessionID.trim() });
  let workspaces = 0;
  const seen = {};
  for (const run of runs) {
    if (!run.IsWorkspace()) {
      continue;
    }
    workspaces++;
    for (const rc of run.RepositoryContexts() ?? []) {
      const branch = new RequirementBranch({ Repository: rc.Name, WebURL: StripURLCredentials(rc.WebURL), BaseBranch: rc.BaseBranch, WorkBranch: rc.WorkBranch });
      const key = branch.Repository + "\x00" + branch.WorkBranch;
      if (branch.Repository === "" || seen[key]) {
        continue;
      }
      seen[key] = true;
      conv.Branches.push(branch);
    }
  }
  if (conv.SessionID === "" && workspaces === 0) {
    return null;
  }
  return conv;
}

/**
 * 将由父 SOP 节点拉起的嵌套子运行与顶层运行分离，避免子运行在需求视图中被误展示为独立泳道。
 *
 * @param {Run[]} runs - 需求关联的全部运行记录。
 * @returns {[Run[], Object<string, Run[]>]} 二元组 `[top, nested]`，分别为顶层运行数组及按父运行 ID 索引的子运行映射。
 */
function splitNestedRuns(runs) {
  const ids = {};
  for (const run of runs) {
    ids[run.ID] = true;
  }
  const top = [];
  const nested = {};
  for (const run of runs) {
    const parent = run.ExecutionContext.ParentRunID.trim();
    if (parent !== "" && parent !== run.ID && ids[parent]) {
      nested[parent] = [...(nested[parent] ?? []), run];
      continue;
    }
    top.push(run);
  }
  return [top, nested];
}

/**
 * 递归统计某运行下所有嵌套子运行的累计 Token 用量与美元成本（深度受 `maxNestedStageDepth` 限制）。
 *
 * @param {string} runID - 父运行 ID。
 * @param {Object<string, Run[]>} nested - 按父运行 ID 索引的子运行映射。
 * @param {number} depth - 当前递归深度。
 * @returns {[number, number]} 二元组 `[tokens, costUSD]`。
 */
function nestedRunUsage(runID, nested, depth) {
  if (depth > maxNestedStageDepth) {
    return [0, 0];
  }
  let tokens = 0;
  let cost = 0;
  for (const child of nested[runID] ?? []) {
    const [t, c] = nestedRunUsage(child.ID, nested, depth + 1);
    tokens += child.Usage.TotalTokens + t;
    cost += child.Usage.CostUSD + c;
  }
  return [tokens, cost];
}

/**
 * 将 Issue SOP 绑定上的配置字段（绑定 ID、负责人、顺序、依赖与交接信息）复制到需求泳道副本上，其余泳道字段保持不变。
 *
 * @param {RequirementLane} lane - 原始需求泳道对象。
 * @param {import("../domain/issue_sop.js").IssueSOPBinding} binding - SOP 绑定配置。
 * @returns {RequirementLane} 合并了绑定元数据的新泳道对象。
 */
function withSOPBinding(lane, binding) {
  const out = new RequirementLane({ ...lane });
  out.BindingID = binding.ID;
  out.AssigneeUserID = binding.AssigneeUserID;
  out.Order = binding.Order;
  out.DependsOn = binding.DependsOn;
  out.Handoff = binding.Handoff;
  return out;
}

/**
 * 按工作流 ID 聚合泳道运行统计与最近一次运行的临时累加器（对应 Go 函数内局部类型 `wfAcc`）。
 */
class wfAcc {
  /**
   * 构造工作流泳道累加器，未提供字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {RequirementLane} [init.lane] - 当前累积的泳道统计对象。
   * @param {Date | null} [init.latest=null] - 最近一次运行创建时间。
   * @param {Run} [init.latestRun] - 最近一次运行的完整摘要对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.lane = init.lane ?? new RequirementLane();
    this.latest = init.latest ?? null;
    this.latestRun = init.latestRun ?? new Run();
  }
}

/**
 * 按工作流维度聚合顶层运行、嵌套子运行与任务数据，并与需求/项目解析出的 SOP 绑定合并为有序泳道列表。
 * 未绑定但已启动的工作流运行会作为 `Orphan = true` 的孤立泳道按名称排序追加在尾部（单绑定单启动特例除外）。
 *
 * @param {import("../domain/issue.js").Issue} issue - 目标需求 Issue。
 * @param {import("../domain/project.js").Project} project - 需求所属项目。
 * @param {Run[]} runs - 顶层运行记录数组。
 * @param {Object<string, Run[]>} nested - 嵌套子运行映射。
 * @param {import("../domain/task.js").Task[]} tasks - 需求关联任务数组。
 * @param {Object<string, WorkflowDefinition>} workflows - 工作流定义目录映射。
 * @param {Date} now - 当前 UTC 时间。
 * @returns {RequirementLane[]} 聚合完成的需求泳道数组。
 */
function buildRequirementLanes(issue, project, runs, nested, tasks, workflows, now) {
  const byWF = {};
  const accumulate = (workflowID, workflow) => {
    workflowID = workflowID.trim();
    if (workflowID === "") {
      return null;
    }
    let acc = byWF[workflowID];
    if (acc == null) {
      workflow = resolvedRequirementWorkflow(workflows, workflowID, workflow);
      const lane = InferSOPLane(workflow);
      const name = requirementLaneName(workflow, workflowID);
      acc = new wfAcc({ lane: new RequirementLane({
        Lane: lane, Label: name, WorkflowID: workflowID, WorkflowName: name,
      }) });
      byWF[workflowID] = acc;
    }
    return acc;
  };
  for (const run of runs) {
    const workflow = resolvedRequirementWorkflow(workflows, run.WorkflowID, run.WorkflowSnapshot);
    const acc = accumulate(run.WorkflowID, workflow);
    if (acc == null) {
      continue;
    }
    acc.lane.Started = true;
    acc.lane.RunCount++;
    const [childTokens, childCost] = nestedRunUsage(run.ID, nested, 0);
    acc.lane.Tokens += run.Usage.TotalTokens + childTokens;
    acc.lane.CostUSD += run.Usage.CostUSD + childCost;
    acc.lane.ExecutionDurationMs += runExecutionDuration(run);
    if (run.Status === "failed") {
      acc.lane.FailedRuns++;
    }
    if (isZeroTime(acc.latest) || timeAfter(run.CreatedAt, acc.latest)) {
      acc.latest = run.CreatedAt;
      acc.latestRun = run;
      acc.lane.LatestRunID = run.ID;
      if (acc.lane.WorkflowName === "" || acc.lane.WorkflowName === run.WorkflowID) {
        if (workflow.Name !== "") {
          acc.lane.WorkflowName = workflow.Name;
          acc.lane.Label = workflow.Name;
        }
      }
    }
  }
  for (const task of tasks) {
    const workflow = workflows[task.WorkflowID];
    const acc = accumulate(task.WorkflowID, workflow);
    if (acc == null) {
      continue;
    }
    if (isZeroTime(acc.latest) || timeAfter(task.CreatedAt, acc.latest)) {
      acc.lane.LatestTaskID = task.ID;
    } else if (acc.lane.LatestRunID !== "") {
      for (const runTask of tasks) {
        if (runTask.RunID === acc.lane.LatestRunID) {
          acc.lane.LatestTaskID = runTask.ID;
          break;
        }
      }
    }
  }
  for (const acc of Object.values(byWF)) {
    if (acc.latestRun != null && acc.latestRun.ID !== "") {
      acc.lane.Status = laneStatusFromRun(acc.latestRun);
      acc.lane.Stages = laneNodeStages(acc.latestRun, workflows, nested, now, 0);
      if (acc.lane.Status === "active" && stagesWaitForHuman(acc.lane.Stages)) {
        acc.lane.Status = "waiting";
      }
    } else if (acc.lane.LatestTaskID !== "") {
      acc.lane.Started = true;
      acc.lane.Status = "active";
      if (acc.lane.Stages.length === 0) {
        acc.lane.Stages = plannedNodeStages(workflows[acc.lane.WorkflowID], workflows, 0);
      }
    } else {
      acc.lane.Status = "not_started";
      acc.lane.Stages = plannedNodeStages(workflows[acc.lane.WorkflowID], workflows, 0);
    }
  }
  const bindings = ResolveSOPBindings(issue, project);
  const out = [];
  const bound = {};
  for (const binding of bindings) {
    bound[binding.WorkflowID] = true;
    const lane = withSOPBinding(new RequirementLane({ WorkflowID: binding.WorkflowID, Status: "not_started" }), binding);
    const workflow = workflows[binding.WorkflowID];
    lane.Lane = InferSOPLane(workflow);
    if (workflow == null || workflow.ID === "") {
      lane.Lane = InferSOPLane(new WorkflowDefinition({ ID: binding.WorkflowID }));
    }
    lane.WorkflowName = requirementLaneName(workflow, binding.WorkflowID);
    lane.Label = lane.WorkflowName;
    const acc = byWF[binding.WorkflowID];
    if (acc != null) {
      const copied = withSOPBinding(acc.lane, binding);
      if (copied.Label === "") {
        copied.Label = lane.Label;
      }
      if (copied.Stages.length === 0) {
        copied.Stages = plannedNodeStages(workflow, workflows, 0);
      }
      out.push(copied);
      continue;
    }
    lane.Stages = plannedNodeStages(workflow, workflows, 0);
    out.push(lane);
  }
  // 单个绑定且只有一个已启动工作流时合并为同一槽位，即使其运行快照的工作流 ID 与当前绑定不同；
  // 若有两个及以上工作流均已启动，则保持各自独立泳道。
  if (bindings.length === 1) {
    let started = 0;
    let latest = null;
    for (const acc of Object.values(byWF)) {
      if (!acc.lane.Started) {
        continue;
      }
      started++;
      if (latest == null || timeAfter(acc.latest, latest.latest)) {
        latest = acc;
      }
    }
    if (latest != null && started === 1) {
      if (latest.lane.WorkflowID === bindings[0].WorkflowID) {
        return out;
      }
      const lane = withSOPBinding(latest.lane, bindings[0]);
      lane.Orphan = false;
      return [lane];
    }
  }
  const orphans = [];
  for (const [wf, acc] of Object.entries(byWF)) {
    if (bound[wf] || !acc.lane.Started) {
      continue;
    }
    const orphan = new RequirementLane({ ...acc.lane });
    orphan.Orphan = true;
    orphans.push(orphan);
  }
  orphans.sort((a, b) => (a.WorkflowName < b.WorkflowName ? -1 : a.WorkflowName > b.WorkflowName ? 1 : 0));
  out.push(...orphans);
  return out;
}

/**
 * 优先采用运行快照中冻结的工作流定义，缺失时回退到目录中的当前工作流定义。
 * 保证即使工作流已从目录删除，历史泳道仍能解析出名称与所属分类。
 *
 * @param {Object<string, WorkflowDefinition>} workflows - 工作流目录映射。
 * @param {string} workflowID - 工作流 ID。
 * @param {WorkflowDefinition | null | undefined} snapshot - 运行中冻结的工作流快照。
 * @returns {WorkflowDefinition} 解析出的工作流定义（均缺失时返回空 `WorkflowDefinition`）。
 */
function resolvedRequirementWorkflow(workflows, workflowID, snapshot) {
  if (snapshot != null && snapshot.ID !== "") {
    return snapshot;
  }
  return workflows[workflowID] ?? new WorkflowDefinition();
}

/**
 * 计算需求泳道的展示名称：优先使用工作流名称，未知时回退为工作流 ID。
 *
 * @param {WorkflowDefinition | null | undefined} workflow - 工作流定义对象。
 * @param {string} workflowID - 工作流 ID。
 * @returns {string} 泳道显示名称。
 */
function requirementLaneName(workflow, workflowID) {
  if (workflow != null && workflow.Name !== "") {
    return workflow.Name;
  }
  return workflowID;
}

/**
 * 根据最近一次运行的节点状态与运行总状态推导需求泳道状态。
 * 任一节点失败返回 `"attention"`，等待审批返回 `"waiting"`，否则按运行状态映射。
 *
 * @param {Run} run - 泳道最近一次运行记录。
 * @returns {string} 泳道状态字符串（`"not_started"` / `"attention"` / `"waiting"` / `"active"` / `"succeeded"`）。
 */
function laneStatusFromRun(run) {
  if (run.ID === "") {
    return "not_started";
  }
  // Go 遍历 map 顺序随机；JS 按属性插入序遍历。
  for (const node of Object.values(run.Nodes ?? {})) {
    if (node == null) {
      continue;
    }
    if (node.Status === "failed") {
      return "attention";
    }
    if (node.Status === "waiting_approval") {
      return "waiting";
    }
  }
  switch (run.Status) {
    case "running":
    case "queued":
      return "active";
    case "waiting":
      return "waiting";
    case "succeeded":
      return "succeeded";
    case "failed":
    case "cancelled":
      return "attention";
    default:
      return "active";
  }
}

/**
 * 按工作流有向边对节点列表执行稳定拓扑排序，还原引擎实际执行顺序。
 * 入度均为 0 的并行节点保留原数组顺序；若存在无 ID 退化定义、环或悬空依赖，则剩余节点按原数组顺序追加。
 *
 * @param {WorkflowDefinition} workflow - 工作流定义对象。
 * @returns {WorkflowNode[]} 按执行顺序排列的工作流节点数组。
 */
function orderNodesByEdges(workflow) {
  const nodes = workflow.Nodes ?? [];
  const edges = workflow.Edges ?? [];
  if (nodes.length < 2 || edges.length === 0) {
    return nodes;
  }
  const known = {};
  for (const node of nodes) {
    if (node.ID === "") {
      // 存在空 ID 节点时视为退化定义，原样保留保存顺序。
      return nodes;
    }
    known[node.ID] = true;
  }
  const indegree = {};
  const children = {};
  for (const edge of edges) {
    if (edge.Source === edge.Target || !known[edge.Source] || !known[edge.Target]) {
      continue;
    }
    indegree[edge.Target] = (indegree[edge.Target] ?? 0) + 1;
    children[edge.Source] = [...(children[edge.Source] ?? []), edge.Target];
  }
  const placed = {};
  const out = [];
  while (out.length < nodes.length) {
    let progress = false;
    for (const node of nodes) {
      if (placed[node.ID] || (indegree[node.ID] ?? 0) > 0) {
        continue;
      }
      out.push(node);
      placed[node.ID] = true;
      for (const child of children[node.ID] ?? []) {
        indegree[child]--;
      }
      progress = true;
      break;
    }
    if (!progress) {
      // 遇到环或未解依赖时，将尚未放置的节点按原数组顺序追加。
      for (const node of nodes) {
        if (!placed[node.ID]) {
          out.push(node);
          placed[node.ID] = true;
        }
      }
    }
  }
  return out;
}

/**
 * 为尚未启动的或待执行的子 SOP 生成全部处于 `"pending"` 状态的计划阶段列表。
 *
 * @param {WorkflowDefinition | null | undefined} workflow - 目标工作流定义。
 * @param {Object<string, WorkflowDefinition>} workflows - 工作流目录映射（用于展开嵌套 SOP 节点）。
 * @param {number} depth - 当前嵌套递归深度。
 * @returns {RequirementNodeStage[]} 计划节点阶段数组。
 */
function plannedNodeStages(workflow, workflows, depth) {
  const out = [];
  for (const node of orderNodesByEdges(workflow ?? new WorkflowDefinition())) {
    let name = node.Name;
    if (name === "") {
      name = node.ID;
    }
    if (name === "") {
      continue;
    }
    const item = new RequirementNodeStage({ NodeID: node.ID, Name: name, Status: "pending" });
    item.Children = plannedSOPChildren(node, workflows, depth);
    out.push(item);
  }
  return out;
}

/**
 * 若节点为嵌套 SOP 节点且未超过最大递归深度，则返回其引用子工作流的计划阶段树。
 *
 * @param {WorkflowNode} node - 当前工作流节点。
 * @param {Object<string, WorkflowDefinition>} workflows - 工作流目录映射。
 * @param {number} depth - 当前递归深度。
 * @returns {RequirementNodeStage[] | null} 子阶段数组；非 SOP 节点、超深或未找到子工作流时返回 `null`。
 */
function plannedSOPChildren(node, workflows, depth) {
  const ref = node.SOPWorkflowID.trim();
  if (node.Type !== "sop" || ref === "" || depth >= maxNestedStageDepth) {
    return null;
  }
  const child = workflows[ref];
  if (child == null) {
    return null;
  }
  return plannedNodeStages(child, workflows, depth + 1);
}

// 嵌套 SOP 阶段展开与用量递归的最大深度上限。
const maxNestedStageDepth = 6;

/**
 * 递归检查节点阶段树中是否存在任一节点处于 `"waiting_approval"`（等待人工审批）状态。
 *
 * @param {RequirementNodeStage[] | null | undefined} stages - 节点阶段列表。
 * @returns {boolean} 任意节点或子节点正在等待审批时返回 `true`，否则返回 `false`。
 */
function stagesWaitForHuman(stages) {
  for (const stage of stages ?? []) {
    if (stage.Status === "waiting_approval" || stagesWaitForHuman(stage.Children)) {
      return true;
    }
  }
  return false;
}

/**
 * 查找父运行中指定 SOP 节点当前引用的嵌套子运行。
 * 优先按节点记录的 `ChildRunID` 精确匹配；若节点已被重置为 `"pending"` 则不回退旧子运行，
 * 其他状态在缺少 `ChildRunID` 时回退到该节点最近一次嵌套子运行。
 *
 * @param {Run} parent - 父运行记录。
 * @param {Run[]} runs - 该父运行下的全部直接子运行数组。
 * @param {string} nodeID - 目标 SOP 节点 ID。
 * @returns {[Run, boolean]} 找到对应子运行时返回 `[childRun, true]`，否则返回 `[空 Run, false]`。
 */
function nodeChildRun(parent, runs, nodeID) {
  const nr = (parent.Nodes ?? {})[nodeID];
  if (nr != null && nr.ChildRunID !== "") {
    for (const run of runs ?? []) {
      if (run.ID === nr.ChildRunID) {
        return [run, true];
      }
    }
  }
  if (nr != null && nr.Status === "pending") {
    return [new Run(), false];
  }
  return latestNestedRun(runs ?? [], nodeID);
}

/**
 * 在子运行列表中查找由指定父节点触发的最近一次子运行（按 `CreatedAt` 比较）。
 *
 * @param {Run[]} runs - 候选嵌套子运行数组。
 * @param {string} nodeID - 父节点 ID。
 * @returns {[Run, boolean]} 找到时返回 `[latestRun, true]`，否则返回 `[空 Run, false]`。
 */
function latestNestedRun(runs, nodeID) {
  let latest = null;
  for (const run of runs) {
    if (run.ExecutionContext.ParentNodeID !== nodeID) {
      continue;
    }
    if (latest == null || latest.ID === "" || timeAfter(run.CreatedAt, latest.CreatedAt)) {
      latest = run;
    }
  }
  if (latest == null) {
    return [new Run(), false];
  }
  return [latest, latest.ID !== ""];
}

/**
 * 根据运行的工作流定义与节点执行状态构建节点阶段树，包含已完成/运行中节点的耗时及递归展开的子 SOP 阶段。
 * 当工作流定义缺失节点时，回退为按节点 ID 字典序展示 `run.Nodes` 中的已有节点。
 *
 * @param {Run} run - 当前运行记录。
 * @param {Object<string, WorkflowDefinition>} workflows - 工作流目录映射。
 * @param {Object<string, Run[]>} nested - 按父运行 ID 索引的嵌套子运行映射。
 * @param {Date} now - 计算运行中节点已耗时所依据的当前 UTC 时间。
 * @param {number} depth - 当前递归嵌套深度。
 * @returns {RequirementNodeStage[]} 节点阶段树数组。
 */
function laneNodeStages(run, workflows, nested, now, depth) {
  let workflow = run.WorkflowSnapshot;
  if (workflow == null || workflow.ID === "") {
    workflow = workflows[run.WorkflowID];
  }
  const withChild = (item, node) => {
    if (depth >= maxNestedStageDepth) {
      return item;
    }
    const [child, ok] = nodeChildRun(run, nested[run.ID] ?? [], item.NodeID);
    if (ok) {
      item.ChildRunID = child.ID;
      item.Children = laneNodeStages(child, workflows, nested, now, depth + 1);
    } else {
      item.Children = plannedSOPChildren(node, workflows, depth);
    }
    return item;
  };
  const out = [];
  for (const node of orderNodesByEdges(workflow ?? new WorkflowDefinition())) {
    const item = new RequirementNodeStage({ NodeID: node.ID, Name: node.Name, Status: "pending" });
    if (item.Name === "") {
      item.Name = node.ID;
    }
    const nr = (run.Nodes ?? {})[node.ID];
    if (nr != null) {
      item.Status = nr.Status;
      if (!isZeroTime(nr.StartedAt) && !isZeroTime(nr.FinishedAt) && timeAfter(nr.FinishedAt, nr.StartedAt)) {
        item.DurationMs = timeMs(nr.FinishedAt) - timeMs(nr.StartedAt);
      } else if (!isZeroTime(nr.StartedAt) && nr.Status === "running" && timeAfter(now, nr.StartedAt)) {
        item.DurationMs = timeMs(now) - timeMs(nr.StartedAt);
      }
    }
    out.push(withChild(item, node));
  }
  if (out.length === 0) {
    const ids = Object.keys(run.Nodes ?? {});
    ids.sort();
    for (const id of ids) {
      const nr = run.Nodes[id];
      if (nr == null) {
        continue;
      }
      out.push(withChild(new RequirementNodeStage({ NodeID: id, Name: id, Status: nr.Status }), new WorkflowNode()));
    }
  }
  return out;
}

/**
 * 汇总需求的整体运行统计指标（运行次数、失败次数、Token/成本、执行耗时、周期耗时与泳道状态计数）。
 * 次数与执行耗时仅统计顶层运行，子运行只累加其 Token 与成本以避免时间重复计算。
 *
 * @param {import("../domain/issue.js").Issue} issue - 目标需求 Issue。
 * @param {RequirementLane[]} lanes - 全部需求泳道。
 * @param {Run[]} runs - 顶层运行数组。
 * @param {Object<string, Run[]>} nested - 嵌套子运行映射。
 * @param {Date} now - 当前 UTC 时间。
 * @returns {RequirementOverall} 需求总体统计对象。
 */
function requirementOverall(issue, lanes, runs, nested, now) {
  const out = new RequirementOverall({ Status: "not_started" });
  for (const children of Object.values(nested)) {
    for (const child of children) {
      out.Tokens += child.Usage.TotalTokens;
      out.CostUSD += child.Usage.CostUSD;
      if (usageCostKnown(child.Usage)) {
        out.CostKnown = true;
      }
    }
  }
  let first = null;
  let last = null;
  for (const run of runs) {
    out.RunCount++;
    out.Tokens += run.Usage.TotalTokens;
    out.CostUSD += run.Usage.CostUSD;
    if (usageCostKnown(run.Usage)) {
      out.CostKnown = true;
    }
    out.ExecutionDurationMs += runExecutionDuration(run);
    if (run.Status === "failed") {
      out.FailedRuns++;
    }
    if (isZeroTime(first) || timeBefore(run.CreatedAt, first)) {
      first = run.CreatedAt;
    }
    const ended = runEndedAt(run, now);
    if (timeAfter(ended, last)) {
      last = ended;
    }
  }
  out.FirstRunAt = first;
  out.LastRunAt = last;
  if (!isZeroTime(first) && timeAfter(last, first)) {
    out.CycleDurationMs = timeMs(last) - timeMs(first);
  }
  for (const lane of lanes) {
    switch (lane.Status) {
      case "succeeded":
        out.SucceededLanes++;
        break;
      case "active":
      case "waiting":
        out.ActiveLanes++;
        break;
    }
  }
  out.Status = overallRequirementStatus(issue, lanes);
  return out;
}

/**
 * 按优先级合并全部泳道状态以确定需求整体状态。
 * 已锁定交付的 Issue 恒为 `"closed"`；未有任何已启动泳道时为 `"not_started"`；
 * 否则按 `attention > waiting > active > succeeded > closed > not_started` 优先级取最高状态。
 *
 * @param {import("../domain/issue.js").Issue} issue - 目标需求 Issue。
 * @param {RequirementLane[]} lanes - 全部需求泳道。
 * @returns {string} 需求整体状态字符串。
 */
function overallRequirementStatus(issue, lanes) {
  if (issue.DeliveryLocked()) {
    return "closed";
  }
  const rank = { attention: 0, waiting: 1, active: 2, succeeded: 3, closed: 4, not_started: 5 };
  let best = "not_started";
  let started = 0;
  for (const lane of lanes) {
    if (lane.Started) {
      started++;
    }
    if (rank[lane.Status] != null && rank[lane.Status] < rank[best]) {
      best = lane.Status;
    }
  }
  if (started === 0) {
    return "not_started";
  }
  return best;
}

/**
 * 从主泳道中提取用于需求顶部进度条展示的扁平生命周期阶段列表。
 * 主泳道包含节点阶段时直接映射各节点；否则以主泳道本身构造单阶段条目。
 *
 * @param {import("../domain/issue.js").Issue} issue - 目标需求 Issue。
 * @param {RequirementLane[]} lanes - 全部需求泳道。
 * @returns {RequirementStage[] | null} 生命周期阶段数组；无任何泳道时返回 `null`。
 */
function requirementLifecycle(issue, lanes) {
  const primary = primaryRequirementLane(issue, lanes);
  if (primary == null) {
    return null;
  }
  if (primary.Stages.length > 0) {
    const out = [];
    for (const node of primary.Stages) {
      let label = node.Name;
      if (label === "") {
        label = node.NodeID;
      }
      out.push(new RequirementStage({ Key: node.NodeID, Label: label, Status: node.Status }));
    }
    return out;
  }
  let status = primary.Status;
  if (status === "") {
    status = "not_started";
  }
  let label = primary.Label;
  if (label === "") {
    label = primary.WorkflowName;
  }
  if (label === "") {
    label = SOPLaneLabel(primary.Lane);
  }
  let key = primary.WorkflowID;
  if (key === "") {
    key = primary.BindingID;
  }
  return [new RequirementStage({ Key: key, Label: label, Status: status, Hint: primary.WorkflowName })];
}

/**
 * 选出代表需求主生命周期的主泳道：优先匹配 `issue.WorkflowID` 且非孤立的泳道，
 * 其次取首个非孤立泳道，最后回退为列表首项。
 *
 * @param {import("../domain/issue.js").Issue} issue - 目标需求 Issue。
 * @param {RequirementLane[]} lanes - 全部需求泳道。
 * @returns {RequirementLane | null} 选中的主泳道对象；泳道为空时返回 `null`。
 */
function primaryRequirementLane(issue, lanes) {
  const want = issue.WorkflowID.trim();
  if (want !== "") {
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i].WorkflowID === want && !lanes[i].Orphan) {
        return lanes[i];
      }
    }
  }
  for (let i = 0; i < lanes.length; i++) {
    if (!lanes[i].Orphan) {
      return lanes[i];
    }
  }
  if (lanes.length > 0) {
    return lanes[0];
  }
  return null;
}

module.exports = { BuildRequirementSnapshot, splitNestedRuns, nestedRunUsage, withSOPBinding, buildRequirementLanes, resolvedRequirementWorkflow, requirementLaneName, laneStatusFromRun, orderNodesByEdges, plannedNodeStages, plannedSOPChildren, maxNestedStageDepth, stagesWaitForHuman, nodeChildRun, latestNestedRun, laneNodeStages, requirementOverall, overallRequirementStatus, requirementLifecycle, primaryRequirementLane, requirementConversation };
