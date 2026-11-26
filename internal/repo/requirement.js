// requirement.js —— 对应 Go 文件：internal/repo/requirement.go
// 作用：需求快照：把 Issue、运行、任务与 SOP 绑定聚合成只读进度视图。

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

// RequirementSnapshot aggregates a requirement's issue, runs, tasks and bound
// workflows into the read-only progress view. It lives on AnalyticsRepo (the
// read-only cross-domain analytics plane), not on Store.
AnalyticsRepo.prototype.RequirementSnapshot = function (issueID) {
  const [issue, ok] = this.issues.Issue(issueID.trim());
  if (!ok) {
    return [new RequirementSnapshot(), false];
  }
  const runs = this.runs.RunSummariesFor(new AnalyticsFilter(), issue.ID);
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

// requirementConversation describes the conversation workspaces a requirement
// was worked on in, newest first; nil when it was not worked on in one.
// Whether the conversation still exists is up to the caller.
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

// splitNestedRuns separates runs started by an SOP node from top-level runs.
// A child shares its parent's issue, so without this it would show up as a
// separate lane. The result maps a parent run ID to its child runs.
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

// withSOPBinding copies the binding-owned fields of an issue SOP binding onto
// a requirement lane, leaving every other lane field untouched.
function withSOPBinding(lane, binding) {
  const out = new RequirementLane({ ...lane });
  out.BindingID = binding.ID;
  out.AssigneeUserID = binding.AssigneeUserID;
  out.Order = binding.Order;
  out.DependsOn = binding.DependsOn;
  out.Handoff = binding.Handoff;
  return out;
}

class wfAcc {
  constructor(init = {}) {
    this.lane = init.lane ?? new RequirementLane();
    this.latest = init.latest ?? null;
    this.latestRun = init.latestRun ?? null;
  }
}

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
  // A single binding with one started workflow is one slot. That run's
  // frozen graph is the slot, even when its workflow id differs. Two
  // workflows that both started stay as separate lanes.
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

// resolvedRequirementWorkflow prefers the workflow definition frozen into a run
// snapshot and falls back to the catalog entry when the snapshot is missing, so
// a lane still gets a name and lane after its workflow leaves the catalog.
function resolvedRequirementWorkflow(workflows, workflowID, snapshot) {
  if (snapshot != null && snapshot.ID !== "") {
    return snapshot;
  }
  return workflows[workflowID] ?? new WorkflowDefinition();
}

// requirementLaneName is the lane display name: the workflow name, or the bare
// id when the catalog entry is unknown.
function requirementLaneName(workflow, workflowID) {
  if (workflow != null && workflow.Name !== "") {
    return workflow.Name;
  }
  return workflowID;
}

function laneStatusFromRun(run) {
  if (run.ID === "") {
    return "not_started";
  }
  // Go 遍历 map 顺序随机；JS 按插入序遍历。
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

// orderNodesByEdges returns workflow.Nodes in execution order: a stable
// topological sort over the edges (among nodes whose dependencies are met,
// the original array order wins). The saved nodes array order is whatever the
// Studio editor happened to serialize, so without this the progress view
// lists nodes in a different order than the engine actually runs them.
// Nodes unreachable from the edges (or cyclic graphs) keep array order.
function orderNodesByEdges(workflow) {
  const nodes = workflow.Nodes ?? [];
  const edges = workflow.Edges ?? [];
  if (nodes.length < 2 || edges.length === 0) {
    return nodes;
  }
  const known = {};
  for (const node of nodes) {
    if (node.ID === "") {
      // Degenerate definition; keep the stored order untouched.
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
      // Cycle or dangling dependency: append the rest in array order.
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

const maxNestedStageDepth = 6;

function stagesWaitForHuman(stages) {
  for (const stage of stages) {
    if (stage.Status === "waiting_approval" || stagesWaitForHuman(stage.Children)) {
      return true;
    }
  }
  return false;
}

// nodeChildRun returns the child run the SOP node currently references. A node
// whose link was cleared by a reset shows its planned stages, not an orphaned
// older child. Reset and retry both clear ChildRunID while leaving the node
// "pending", so a pending node never falls back. For any other status a
// missing ChildRunID only means the summary projection dropped the field (or
// the row predates it), so recover via the node's most recent nested run.
function nodeChildRun(parent, runs, nodeID) {
  const nr = (parent.Nodes ?? {})[nodeID];
  if (nr != null && nr.ChildRunID !== "") {
    for (const run of runs) {
      if (run.ID === nr.ChildRunID) {
        return [run, true];
      }
    }
  }
  if (nr != null && nr.Status === "pending") {
    return [new Run(), false];
  }
  return latestNestedRun(runs, nodeID);
}

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

// requirementOverall counts top-level runs only. Child runs add their usage
// but not their time, which already lies inside the parent run.
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
