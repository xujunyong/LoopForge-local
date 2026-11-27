/**
 * 对应 Go 源文件：internal/engine/workflow_graph.go
 *
 * 文件作用与职责边界：
 * 提供工作流有向无环图（DAG）相关的纯查询与校验函数：
 * 包括就绪节点计算、工作流定义读取与默认沙箱补齐、上游祖先/下游后代节点集合遍历、
 * 运行节点状态汇总查询，以及工作流定义、节点配置与 DAG 无环性校验。
 *
 * Go 与 JS 语法差异说明：
 * - Go 的 `(值, bool)` 译为 `[值, boolean]` 元组；仅返回 `error` 的函数成功返回 `undefined`、失败 `throw`。
 * - Go 的 `map[string]bool`（含 `ancestors`、`descendants` 返回值）统一译为普通对象 `{}`，值为 `true`。
 * - Go 的 `path/filepath` 译为 Node 内置模块 `node:path`。
 * - Go 结构体按值传递时（如 `defaultWorkflowSandboxProfile`），JS 先浅拷贝 `{ ...wf }` 再修改字段。
 */

"use strict";

const path = require("node:path"); // Go path/filepath
const { WorkflowDefinition, WorkflowNode } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition/WorkflowNode，workflow.js 已翻译
const { ExecutionScopeRun, ExecutionScopeRepositories } = require("../domain/observability.js"); // 对应 Go 的 domain.ExecutionScopeRun/ExecutionScopeRepositories，observability.js 已翻译
const { ValidateWorkflowPreparation } = require("../domain/workspace_preparation.js"); // 对应 Go 的 domain.ValidateWorkflowPreparation，workspace_preparation.js 已翻译
const { DefaultSandboxProfileID } = require("../repo/sandbox_defaults.js"); // 对应 Go 的 repo.DefaultSandboxProfileID，sandbox_defaults.js 已翻译

/**
 * 计算当前运行中所有已满足前置依赖、处于 pending 状态的就绪节点列表。
 * 使用场景：调度器在推进工作流时，筛选本轮可并发分派执行的节点。
 *
 * @param {object} wf - 工作流定义（domain.WorkflowDefinition）。
 * @param {object} r - 当前运行状态（domain.Run）。
 * @returns {object[]} 所有前置节点均已成功且自身为 pending 的节点定义数组（domain.WorkflowNode[]）。
 */
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

/**
 * 从存储中读取指定 ID 的最新工作流定义。
 * 使用场景：历史运行缺少冻结快照时，回退读取仓库中最新的工作流定义。
 *
 * @param {object|null} st - 仓库存储实例（repo.Store）。
 * @param {string} id - 工作流 ID。
 * @returns {[object, boolean]} 返回 `[wf, ok]`；当存储为空或 ID 为空时返回 `[零值 WorkflowDefinition, false]`。
 */
function latestWorkflowDefinition(st, id) {
  if (st == null || id.trim() === "") {
    return [new WorkflowDefinition(), false];
  }
  return st.Workflow(id);
}

/**
 * 获取指定运行对应的工作流定义，优先使用运行启动时冻结的快照，并补齐默认沙箱配置 ID。
 * 使用场景：重试、审批或恢复运行时，确保沿用冻结图结构而非受后续编辑影响。
 *
 * @param {object|null} s - 仓库存储实例（repo.Store）。
 * @param {object} run - 运行实例（domain.Run）。
 * @returns {object} 补齐了默认沙箱配置 ID 的工作流定义（domain.WorkflowDefinition）。
 */
function workflowForRun(s, run) {
  if (run.WorkflowSnapshot.ID !== "") {
    // 兼容：沙箱归属移到工作流之前创建的运行，冻结快照里没有 sandboxProfileId。保留冻结的图，用默认沙箱跑重试与审批，不依赖之后的工作流修改。
    return defaultWorkflowSandboxProfile(run.WorkflowSnapshot);
  }
  const [wf] = latestWorkflowDefinition(s, run.WorkflowID);
  return defaultWorkflowSandboxProfile(wf);
}

/**
 * 为未设置 `SandboxProfileID` 的工作流定义填充默认沙箱配置 ID（不修改入参对象）。
 * 使用场景：由 workflowForRun 调用，兼容旧版运行快照。
 *
 * @param {object} wf - 工作流定义（domain.WorkflowDefinition）。
 * @returns {object} 填充好 `SandboxProfileID` 的工作流定义浅拷贝。
 */
function defaultWorkflowSandboxProfile(wf) {
  // Go 结构体按值传递，JS 用展开复制。
  wf = { ...wf };
  if (wf.SandboxProfileID.trim() === "") {
    wf.SandboxProfileID = DefaultSandboxProfileID;
  }
  return wf;
}

/**
 * 计算工作流图中指定起始节点的所有上游祖先节点 ID 集合（不含起始节点本身）。
 * 使用场景：筛选节点可见的上游产物，以及为子 SOP 整理上游交接物清单。
 *
 * @param {object} wf - 工作流定义（domain.WorkflowDefinition）。
 * @param {string} start - 起始节点 ID。
 * @returns {object} 以祖先节点 ID 为键、值为 true 的普通对象集合。
 */
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

/**
 * 计算工作流图中指定起始节点的所有下游后代节点 ID 集合（不含起始节点本身）。
 * 使用场景：节点驳回重做、重跑重置下游状态，以及排除当前与下游节点产物回填时调用。
 *
 * @param {object} wf - 工作流定义（domain.WorkflowDefinition）。
 * @param {string} start - 起始节点 ID。
 * @returns {object} 以后代节点 ID 为键、值为 true 的普通对象集合。
 */
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

/**
 * 检查重放指定节点时，其所有上游依赖节点是否均已处于 `succeeded` 状态。
 * 使用场景：人工触发从某节点重跑（replay）前，校验前置依赖链是否全部完成。
 *
 * @param {object} run - 运行实例（domain.Run）。
 * @param {string} nodeID - 目标重放节点 ID。
 * @returns {boolean} 所有上游节点均已成功返回 true，存在缺失或未成功节点返回 false。
 */
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

/**
 * 判断工作流定义中的所有节点在当前运行中是否均已成功。
 * 使用场景：调度器判断整条运行是否可以流转到 `succeeded` 终态。
 *
 * @param {object} wf - 工作流定义（domain.WorkflowDefinition）。
 * @param {object} r - 运行实例（domain.Run）。
 * @returns {boolean} 全部节点均为 `succeeded` 返回 true，否则返回 false。
 */
function allSucceeded(wf, r) {
  for (const definition of wf.Nodes) {
    const n = r.Nodes[definition.ID];
    if (n == null || n.Status !== "succeeded") {
      return false;
    }
  }
  return true;
}

/**
 * 按工作流定义顺序，查找第一个在运行中处于指定状态的节点；定义中不存在的运行节点会被忽略。
 * 使用场景：由 hasWaiting、cancelledNode、hasFailed 等状态查询函数复用。
 *
 * @param {object} wf - 工作流定义（domain.WorkflowDefinition）。
 * @param {object} r - 运行实例（domain.Run）。
 * @param {string} status - 要匹配的节点状态字符串（如 "waiting_approval"、"cancelled"、"failed"）。
 * @returns {[object, boolean]} 返回 `[node, found]`；找到时返回该节点定义与 true，否则返回 `[零值 WorkflowNode, false]`。
 */
function firstNodeWithStatus(wf, r, status) {
  for (const definition of wf.Nodes) {
    const n = r.Nodes[definition.ID];
    if (n != null && n.Status === status) {
      return [definition, true];
    }
  }
  return [new WorkflowNode(), false];
}

/**
 * 判断运行中是否存在正在等待人工审批（`waiting_approval`）的节点。
 * 使用场景：调度器决定运行整体状态是否为等待审批。
 *
 * @param {object} wf - 工作流定义（domain.WorkflowDefinition）。
 * @param {object} r - 运行实例（domain.Run）。
 * @returns {boolean} 存在等待审批节点返回 true，否则返回 false。
 */
function hasWaiting(wf, r) {
  const [, ok] = firstNodeWithStatus(wf, r, "waiting_approval");
  return ok;
}

/**
 * 查找被取消后停止、除非操作员显式恢复否则不会再次运行的节点。
 * 使用场景：调度器判断运行是否因节点取消而停滞。
 *
 * @param {object} wf - 工作流定义（domain.WorkflowDefinition）。
 * @param {object} r - 运行实例（domain.Run）。
 * @returns {[object, boolean]} 返回 `[node, found]`，即第一个处于 `cancelled` 状态的节点定义及是否找到。
 */
function cancelledNode(wf, r) {
  return firstNodeWithStatus(wf, r, "cancelled");
}

/**
 * 判断运行中是否存在执行失败（`failed`）的节点。
 * 使用场景：调度器判断运行整体是否应标记为失败。
 *
 * @param {object} wf - 工作流定义（domain.WorkflowDefinition）。
 * @param {object} r - 运行实例（domain.Run）。
 * @returns {boolean} 存在失败节点返回 true，否则返回 false。
 */
function hasFailed(wf, r) {
  const [, ok] = firstNodeWithStatus(wf, r, "failed");
  return ok;
}

/**
 * 校验工作流定义的完整性，包括环境准备配置、沙箱 ID、节点定义、驳回目标引用与 DAG 无环性。
 * 使用场景：保存、更新或启动工作流前进行全量静态校验。
 *
 * @param {object} wf - 待校验的工作流定义（domain.WorkflowDefinition）。
 * @returns {void} 无返回值。
 * @throws {Error} 任一校验规则不满足时抛出描述性错误。
 */
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

/**
 * 校验单个工作流节点自身的字段：类型专属配置、`onFailure`/`executionScope`/`retryStrategy` 枚举值以及产物输出合约。
 * 使用场景：由 validate 逐节点调用；`workflowID` 用于防止 SOP 节点引用自身工作流。
 *
 * @param {string} workflowID - 所属工作流 ID。
 * @param {object} n - 待校验的工作流节点（domain.WorkflowNode）。
 * @returns {void} 无返回值。
 * @throws {Error} 节点类型、字段枚举或产物路径合约不合法时抛出错误。
 */
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
  const scope = n.ExecutionScope.trim();
  if (scope !== "" && scope !== ExecutionScopeRun && scope !== ExecutionScopeRepositories) {
    throw new Error(`node ${n.ID} has invalid executionScope ${JSON.stringify(scope)}`);
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

/**
 * 校验工作流边集合：拒绝引用未知节点 ID 的边，并通过 Kahn 拓扑排序拒绝存在环路的图。
 * 使用场景：由 validate 在校验完所有节点后调用。
 *
 * @param {object} ids - 合法节点 ID 集合（以节点 ID 为键、值为 true 的普通对象）。
 * @param {object[]} edges - 工作流有向边数组（domain.WorkflowEdge[]）。
 * @returns {void} 无返回值。
 * @throws {Error} 边引用了不存在的节点或图中存在环路时抛出错误。
 */
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
