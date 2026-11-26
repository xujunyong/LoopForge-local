// workflow_graph.js —— 对应 Go 文件：internal/engine/workflow_graph.go
// 作用：工作流图操作：就绪节点、上游/下游集合、运行状态查询与图结构校验。
// (值, bool) 译为 [值, bool]，(值, error) 译为成功返回值、失败 throw；Go 的 map[string]bool 译为普通对象；Go 的 path/filepath 译为 node:path。

"use strict";

const path = require("node:path"); // Go path/filepath
const { WorkflowDefinition, WorkflowNode } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition/WorkflowNode，workflow.js 已翻译
const { ExecutionScopeRun, ExecutionScopeRepositories } = require("../domain/observability.js"); // 对应 Go 的 domain.ExecutionScopeRun/ExecutionScopeRepositories，observability.js 已翻译
const { ValidateWorkflowPreparation } = require("../domain/workspace_preparation.js"); // 对应 Go 的 domain.ValidateWorkflowPreparation，workspace_preparation.js 已翻译
const { DefaultSandboxProfileID } = require("../repo/sandbox_defaults.js"); // 对应 Go 的 repo.DefaultSandboxProfileID，sandbox_defaults.js 已翻译

function readyNodes(wf, r) {
  const deps = {};
  for (const e of wf.Edges) {
    if (deps[e.Target] === undefined) {
      deps[e.Target] = [];
    }
    deps[e.Target].push(e.Source);
  }
  const out = [];
  for (const n of wf.Nodes) {
    if (r.Nodes[n.ID].Status !== "pending") {
      continue;
    }
    let ready = true;
    for (const d of deps[n.ID] ?? []) {
      if (r.Nodes[d].Status !== "succeeded") {
        ready = false;
      }
    }
    if (ready) {
      out.push(n);
    }
  }
  return out;
}

function latestWorkflowDefinition(st, id) {
  if (st == null || id.trim() === "") {
    return [new WorkflowDefinition(), false];
  }
  return st.Workflow(id);
}

function workflowForRun(s, run) {
  if (run.WorkflowSnapshot.ID !== "") {
    // 兼容：沙箱归属移到工作流之前创建的运行，冻结快照里没有 sandboxProfileId。保留冻结的图，用默认沙箱跑重试与审批，不依赖之后的工作流修改。
    return defaultWorkflowSandboxProfile(run.WorkflowSnapshot);
  }
  const [wf] = latestWorkflowDefinition(s, run.WorkflowID);
  return defaultWorkflowSandboxProfile(wf);
}

function defaultWorkflowSandboxProfile(wf) {
  // Go 结构体按值传递，JS 用展开复制。
  wf = { ...wf };
  if (wf.SandboxProfileID.trim() === "") {
    wf.SandboxProfileID = DefaultSandboxProfileID;
  }
  return wf;
}

function ancestors(wf, start) {
  const incoming = {};
  for (const edge of wf.Edges) {
    if (incoming[edge.Target] === undefined) {
      incoming[edge.Target] = [];
    }
    incoming[edge.Target].push(edge.Source);
  }
  const out = {};
  const walk = (id) => {
    for (const src of incoming[id] ?? []) {
      if (!out[src]) {
        out[src] = true;
        walk(src);
      }
    }
  };
  walk(start);
  return out;
}

function descendants(wf, start) {
  const out = {};
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of wf.Edges) {
      if (e.Source === start || out[e.Source]) {
        if (!out[e.Target]) {
          out[e.Target] = true;
          changed = true;
        }
      }
    }
  }
  return out;
}

function replayUpstreamSucceeded(run, nodeID) {
  const seen = { [nodeID]: true };
  const queue = [nodeID];
  while (queue.length > 0) {
    const target = queue.shift();
    for (const edge of run.WorkflowSnapshot.Edges) {
      if (edge.Target !== target || seen[edge.Source]) {
        continue;
      }
      const upstream = run.Nodes[edge.Source];
      if (upstream == null || upstream.Status !== "succeeded") {
        return false;
      }
      seen[edge.Source] = true;
      queue.push(edge.Source);
    }
  }
  return true;
}

function allSucceeded(wf, r) {
  for (const definition of wf.Nodes) {
    const n = r.Nodes[definition.ID];
    if (n == null || n.Status !== "succeeded") {
      return false;
    }
  }
  return true;
}

// firstNodeWithStatus：按工作流定义顺序，返回第一个处于给定状态的节点；定义里没有的运行节点忽略。
function firstNodeWithStatus(wf, r, status) {
  for (const definition of wf.Nodes) {
    const n = r.Nodes[definition.ID];
    if (n != null && n.Status === status) {
      return [definition, true];
    }
  }
  return [new WorkflowNode(), false];
}

function hasWaiting(wf, r) {
  const [, ok] = firstNodeWithStatus(wf, r, "waiting_approval");
  return ok;
}

// cancelledNode：返回一个被取消后不再运行的节点，除非操作员恢复它。
function cancelledNode(wf, r) {
  return firstNodeWithStatus(wf, r, "cancelled");
}

function hasFailed(wf, r) {
  const [, ok] = firstNodeWithStatus(wf, r, "failed");
  return ok;
}

function validate(wf) {
  ValidateWorkflowPreparation(wf);
  if (wf.SandboxProfileID.trim() === "") {
    throw new Error("workflow sandbox profile is required");
  }
  const ids = {};
  for (const n of wf.Nodes) {
    if (n.ID === "") {
      throw new Error("node id is required");
    }
    if (ids[n.ID]) {
      throw new Error(`duplicate node ${n.ID}`);
    }
    ids[n.ID] = true;
    validateNode(wf.ID, n);
  }
  for (const n of wf.Nodes) {
    if (n.RejectTo !== "" && !ids[n.RejectTo]) {
      throw new Error(`node ${n.ID} reject target not found`);
    }
    if (n.OnFailure === "reject" && n.RejectTo === "") {
      throw new Error(`node ${n.ID} reject target is required`);
    }
  }
  validateDAG(ids, wf.Edges);
}

// validateNode：校验一个节点自身的字段：类型相关配置、onFailure/executionScope/retryStrategy 枚举与产物合约。workflowID 用于防止 SOP 节点引用自己的工作流。
function validateNode(workflowID, n) {
  switch (n.Type) {
    case "agent":
    case "approval":
      break;
    case "sop":
      if (n.SOPWorkflowID.trim() === "") {
        throw new Error(`node ${n.ID} sopWorkflowId is required`);
      }
      if (n.SOPWorkflowID.trim() === workflowID.trim()) {
        throw new Error(`node ${n.ID} cannot reference its own workflow`);
      }
      break;
    case "script":
    case "command": {
      let language = n.ScriptLanguage;
      let script = n.Script;
      if (n.Type === "command") {
        language = "shell";
        script = n.Command;
      }
      if (language === "") {
        language = "shell";
      }
      if (language !== "shell" && language !== "python") {
        throw new Error(`node ${n.ID} has invalid scriptLanguage ${JSON.stringify(language)}`);
      }
      if (script.trim() === "") {
        throw new Error(`node ${n.ID} script is required`);
      }
      break;
    }
    default:
      throw new Error(`node ${n.ID} has invalid type ${JSON.stringify(n.Type)}`);
  }
  if (n.OnFailure !== "" && n.OnFailure !== "fail" && n.OnFailure !== "reject" && n.OnFailure !== "human" && n.OnFailure !== "loop") {
    throw new Error(`node ${n.ID} has invalid onFailure ${JSON.stringify(n.OnFailure)}`);
  }
  if (n.ExecutionScope.trim() !== "" && n.ExecutionScope.trim() !== ExecutionScopeRun && n.ExecutionScope.trim() !== ExecutionScopeRepositories) {
    throw new Error(`node ${n.ID} has invalid executionScope ${JSON.stringify(n.ExecutionScope)}`);
  }
  if (n.RetryStrategy !== "" && n.RetryStrategy !== "targeted_fix" && n.RetryStrategy !== "full_redo") {
    throw new Error(`node ${n.ID} has invalid retryStrategy ${JSON.stringify(n.RetryStrategy)}`);
  }
  const artifactNames = {};
  for (const contract of n.ArtifactOutputs) {
    const clean = path.normalize(contract.Path);
    if (contract.Name === "" || clean === "." || path.isAbsolute(clean) || clean.startsWith("..")) {
      throw new Error(`node ${n.ID} has invalid artifact contract ${JSON.stringify(contract.Name)}`);
    }
    if (artifactNames[contract.Name]) {
      throw new Error(`node ${n.ID} has duplicate artifact ${contract.Name}`);
    }
    artifactNames[contract.Name] = true;
  }
}

// validateDAG：拒绝引用未知节点 id 的边，并用 Kahn 拓扑排序拒绝 ids 间成环的边。
function validateDAG(ids, edges) {
  const indegree = {};
  const adj = {};
  for (const e of edges) {
    if (!ids[e.Source] || !ids[e.Target]) {
      throw new Error("edge references missing node");
    }
    indegree[e.Target] = (indegree[e.Target] ?? 0) + 1;
    if (adj[e.Source] === undefined) {
      adj[e.Source] = [];
    }
    adj[e.Source].push(e.Target);
  }
  const q = [];
  for (const id of Object.keys(ids)) {
    if ((indegree[id] ?? 0) === 0) {
      q.push(id);
    }
  }
  let seen = 0;
  while (q.length > 0) {
    const x = q.shift();
    seen++;
    for (const v of adj[x] ?? []) {
      indegree[v]--;
      if (indegree[v] === 0) {
        q.push(v);
      }
    }
  }
  if (seen !== Object.keys(ids).length) {
    throw new Error("workflow must be a DAG; use rejectTo for controlled rework");
  }
}

module.exports = { readyNodes, latestWorkflowDefinition, workflowForRun, defaultWorkflowSandboxProfile, ancestors, descendants, replayUpstreamSucceeded, allSucceeded, firstNodeWithStatus, hasWaiting, cancelledNode, hasFailed, validate, validateNode, validateDAG };
