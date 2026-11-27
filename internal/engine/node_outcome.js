// node_outcome.js —— 对应 Go 文件：internal/engine/node_outcome.go
// 作用：节点与运行的终态收敛处理，包括人工门禁等待、失败重试与自动打回、中断挂起与恢复、用户暂停/取消以及运行收尾清理。
// 职责边界：仅负责节点与运行状态向终态或挂起态的写栅栏判断、状态更新与清理编排；不负责具体节点命令或 Agent 执行过程。
// 语法差异说明：sync.Mutex 在单线程 JS 中省略；仅返回 error 的函数译为成功返回 undefined、失败 throw Error；(值, bool) 译为 [值, boolean]；Go 的 `_ =` 忽略错误译为 try/catch 空吞。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TelemetryEvent，run.js 已翻译
const { RejectRequest } = require("../domain/issue.js"); // 对应 Go 的 domain.RejectRequest，issue.js 已翻译
const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { ErrMaxTurns } = require("../runtime/runner.js"); // 对应 Go 的 runtime.ErrMaxTurns，runtime 待翻译
const { IsCwdMountFailure } = require("../runtime/sandbox_docker.js"); // 对应 Go 的 runtime.IsCwdMountFailure，runtime 待翻译
const { ErrWorkspaceControlConfiguration } = require("./workspace_checkpoint_transport.js"); // 对应 Go 同包错误，workspace_checkpoint_transport.js 已翻译
const { errSOPArtifactWrite } = require("./sop_node.js"); // 对应 Go 同包错误，sop_node.js 已翻译
const { isScriptNode } = require("./run_ops.js"); // 对应 Go 同包函数，run_ops.js 已翻译
const { settleStatusForCompletedGraph, resetInFlightNodesForResume, resetNodeForResume, pipelineFailedMessage, canSettleUnowned } = require("./lifecycle.js"); // 对应 Go 同包符号，lifecycle.js 已翻译
const { workflowForRun, hasFailed } = require("./workflow_graph.js"); // 对应 Go 同包函数，workflow_graph.js 已翻译
const { scheduledIntegratePending } = require("./lifecycle.js"); // 对应 Go 同包函数，lifecycle.js 已翻译

/**
 * 将指定节点置为等待人工批准状态并记录门禁等待事件。
 * 在审批节点到达或需要人工介入确认时调用。
 *
 * @param {string} runID - 运行 ID。
 * @param {Object} node - 工作流节点定义（domain.WorkflowNode）。
 * @param {string} msg - 写入运行事件的等待原因说明。
 * @returns {void} 无返回值。
 */
Engine.prototype.waitApproval = function (runID, node, msg) {
  this.updateRun(runID, (r) => {
    const nr = r.Nodes[node.ID];
    nr.Status = "waiting_approval";
    nr.FinishedAt = new Date();
    this.event(r, node.ID, "gate.waiting", msg);
  });
};

/**
 * 以当前持久化状态中的尝试次数与租约代次标记指定节点失败。
 * 在外部调用方尚未缓存具体 attempt 与 generation 时作为 nodeFailedAt 的便捷入口。
 *
 * @param {string} runID - 运行 ID。
 * @param {Object} node - 工作流节点定义（domain.WorkflowNode）。
 * @param {Error} err - 导致节点失败的错误对象。
 * @param {boolean} allowReject - 是否允许在失败后自动打回上游节点。
 * @returns {void} 无返回值。
 */
Engine.prototype.nodeFailed = function (runID, node, err, allowReject) {
  const [r, ok] = this.repo.RunState(runID);
  if (!ok || r.Nodes[node.ID] == null) {
    return;
  }
  this.nodeFailedAt(runID, node, r.Nodes[node.ID].Attempt, r.Generation, err, allowReject);
};

/**
 * 单节点排他执行结果的写栅栏判断：校验租约代次、节点在途状态及失败路径的尝试次数。
 * 在提交节点成功、失败或中断回队前调用，防止过期实例或并行分支被重置后的迟到结果覆盖最新状态。
 *
 * @param {Object} r - 当前运行对象（domain.Run）。
 * @param {Object|null} nr - 当前节点运行态对象（domain.NodeRun）。
 * @param {number} generation - 发起该次执行时的运行租约代次。
 * @param {number} attempt - 发起该次执行时的节点尝试次数。
 * @param {boolean} success - 本次待提交的是否为成功结果（成功结果允许跨 attempt 落地，失败结果严格绑定 attempt）。
 * @returns {boolean} 允许提交返回 true，否则返回 false。
 */
function shouldCommitNodeOutcome(r, nr, generation, attempt, success) {
  if (r.Generation !== generation || nr == null) {
    return false;
  }
  if (nr.Status !== "running" && nr.Status !== "pending_input") {
    return false;
  }
  if (success) {
    return true;
  }
  return nr.Attempt === attempt;
}

/**
 * 按指定的尝试次数与租约代次处理节点失败：根据配置决定本地重试、因返工预算耗尽转人工确认、或标记失败并按需自动打回上游。
 * 在节点执行过程发生不可恢复错误或门禁未通过时调用。
 *
 * @param {string} runID - 运行 ID。
 * @param {Object} node - 工作流节点定义（domain.WorkflowNode）。
 * @param {number} attempt - 本次执行的尝试次数。
 * @param {number} generation - 本次执行的租约代次。
 * @param {Error} err - 失败错误对象。
 * @param {boolean} allowReject - 是否允许触发向 RejectTo 上游节点的自动打回。
 * @returns {void} 无返回值。
 */
Engine.prototype.nodeFailedAt = function (runID, node, attempt, generation, err, allowReject) {
  let shouldReject = false;
  const configurationFailure = err === ErrWorkspaceControlConfiguration || err?.cause === ErrWorkspaceControlConfiguration;
  this.updateRun(runID, (r) => {
    const nr = r.Nodes[node.ID];
    if (!shouldCommitNodeOutcome(r, nr, generation, attempt, false)) {
      return;
    }
    nr.Error = err.message;
    nr.FinishedAt = new Date();
    const reworkBudget = node.RejectTo !== "" && r.Nodes[node.RejectTo] != null && r.Nodes[node.RejectTo].ReworkCount >= Math.max(1, node.MaxReworks);
    if (shouldRetryFailedAttempt(node, nr.Attempt, err) && !gateReworkReject(allowReject, nr)) {
      // 重试会获得干净的工作区，因此把具体失败原因带入 {{feedback}}，避免下一轮重新排查。
      nr.Feedback = err.message;
      nr.Status = "pending";
      nr.ChildRunID = "";
      this.event(r, node.ID, "node.retry", "执行失败，准备重试：" + err.message);
    } else if (!configurationFailure && gateReworkReject(allowReject, nr) && reworkBudget) {
      // Agent 持续请求打回上游，但 RejectTo 节点已耗尽 MaxReworks 预算；停在人工门禁让操作员决策。
      nr.Status = "waiting_approval";
      nr.Activity = "返工预算耗尽，等待人工决策";
      nr.Error = `上游节点 ${node.RejectTo} 返工次数已用尽（MaxReworks=${Math.max(1, node.MaxReworks)}），无法再次打回，等待人工决策（批准=接受当前结果继续下游）。Agent 理由：${err.message}`;
      this.event(r, node.ID, "gate.waiting", "返工预算耗尽，等待人工决策：" + err.message);
    } else {
      nr.Status = "failed";
      this.event(r, node.ID, "node.failed", err.message);
    }
    shouldReject = !configurationFailure && allowReject && nr.Status === "failed" && node.RejectTo !== "" && r.Nodes[node.RejectTo] != null && r.Nodes[node.RejectTo].ReworkCount < Math.max(1, node.MaxReworks);
  });
  if (shouldReject) {
    // Go 的 `_ =` 丢弃返回值与错误。
    try {
      this.Reject(runID, new RejectRequest({ NodeID: node.ID, TargetID: node.RejectTo, Reason: "节点失败自动打回：" + err.message }));
    } catch {}
  }
};

/**
 * 判断失败的节点尝试是否应当在本地重新排队重试。
 * 配置错误、子 SOP 产物写入错误、轮次耗尽、门禁验证失败与工作目录挂载失败均不自动重试。
 *
 * @param {Object} node - 工作流节点定义（domain.WorkflowNode）。
 * @param {number} attempt - 当前已执行的尝试次数。
 * @param {Error|null} err - 本次失败的错误对象。
 * @returns {boolean} 满足重试条件且未达到 MaxAttempts 上限时返回 true，否则返回 false。
 */
function shouldRetryFailedAttempt(node, attempt, err) {
  if (err === ErrWorkspaceControlConfiguration || err?.cause === ErrWorkspaceControlConfiguration || err === errSOPArtifactWrite || err?.cause === errSOPArtifactWrite) {
    return false;
  }
  if (err != null && (isMaxTurnsErr(err) || err.message.includes("verification ") || IsCwdMountFailure(err))) {
    return false;
  }
  return attempt < Math.max(1, node.MaxAttempts);
}

/**
 * 判断本次失败是否来自 Agent 显式提交的 submit_gate_result "rework" 裁决且允许打回上游。
 * 用于避免对已经明确归因到上游节点的返工裁决在本地白白消耗重试次数。
 *
 * @param {boolean} allowReject - 本次失败路径是否允许打回上游。
 * @param {Object|null} nr - 当前节点运行态对象（domain.NodeRun）。
 * @returns {boolean} 是显式 rework 裁决且允许打回时返回 true，否则返回 false。
 */
function gateReworkReject(allowReject, nr) {
  return allowReject && nr != null && nr.GateResult != null && nr.GateResult.Decision.trim().toLowerCase() === "rework";
}

/**
 * 解析验证门禁的失败处理策略，依次检查门禁配置与兜底策略，默认回退为 "fail"。
 * 在装配节点验证门禁列表或判断是否开启自修正循环时调用。
 *
 * @param {string} gateOnFailure - 门禁自身配置的 onFailure 策略。
 * @param {string} fallback - 节点级别的兜底策略。
 * @returns {string} 合法策略之一（"loop"、"reject"、"fail" 或 "human"）。
 */
function resolveGateOnFailure(gateOnFailure, fallback) {
  for (const candidate of [gateOnFailure, fallback]) {
    switch (candidate.trim().toLowerCase()) {
      case "loop":
      case "reject":
      case "fail":
      case "human":
        return candidate.trim().toLowerCase();
    }
  }
  return "fail";
}

/**
 * 判断错误是否表示执行器达到最大对话轮次上限（max turns）。
 * 在决定是否跳过自动重试或转人工确认重试时调用。
 *
 * @param {Error|null} err - 待检查的错误对象。
 * @returns {boolean} 命中 ErrMaxTurns 或错误文本包含 max turns 关键词时返回 true，否则返回 false。
 */
function isMaxTurnsErr(err) {
  if (err == null) {
    return false;
  }
  if (err === ErrMaxTurns || err.cause === ErrMaxTurns) {
    return true;
  }
  const msg = err.message.toLowerCase();
  return msg.includes("max turns") || msg.includes("executor reached max turns");
}

/** 当关联的工蜂 Issue 已关闭时禁止触发或继续 SOP 的哨兵错误。 */
const errGongfengIssueClosed = new Error("工蜂 Issue 已关闭，不能触发 SOP");

/**
 * 检查运行绑定的工蜂 Issue 是否已关闭，若已关闭则抛出 errGongfengIssueClosed 阻止继续执行。
 * 在启动、恢复或操作 SOP 运行前调用。
 *
 * @param {Object} st - 数据仓库实例（repo.Store）。
 * @param {Object} r - 当前运行对象（domain.Run）。
 * @returns {void} Issue 未绑定或未关闭时无返回值。
 * @throws {Error} 关联的工蜂 Issue 已关闭时抛出 errGongfengIssueClosed。
 */
function forbidClosedGongfengIssue(st, r) {
  const id = r.ExecutionContext.IssueID.trim();
  if (id === "") {
    return;
  }
  const [issue, ok] = st.Issue(id);
  if (ok && issue.GongfengClosed()) {
    throw errGongfengIssueClosed;
  }
}

/**
 * 判断节点是否配置了失败打回上游（设置了 RejectTo 且 OnFailure 为空或 "reject"）。
 * 在确定默认失败策略与自动打回资格时调用。
 *
 * @param {Object} node - 工作流节点定义（domain.WorkflowNode）。
 * @returns {boolean} 配置了失败打回时返回 true，否则返回 false。
 */
function nodeRejects(node) {
  return node.RejectTo !== "" && (node.OnFailure === "" || node.OnFailure === "reject");
}

/**
 * 根据节点类型、错误性质与门禁打回标志，判断本次失败是否允许自动打回上游。
 * 脚本/命令节点失败与门禁验证失败可打回，协议中断（without a terminal result）与轮次耗尽不打回。
 *
 * @param {Object} node - 工作流节点定义（domain.WorkflowNode）。
 * @param {Error|null} err - 节点失败错误对象。
 * @param {boolean} gateRejected - 是否已由门禁策略明确指定打回。
 * @returns {boolean} 允许自动打回时返回 true，否则返回 false。
 */
function allowRejectOnFailure(node, err, gateRejected) {
  if (gateRejected) {
    return true;
  }
  if (!nodeRejects(node) || err == null) {
    return false;
  }
  if (node.Type === "script" || node.Type === "command") {
    return true;
  }
  const msg = err.message;
  if (msg.includes("without a terminal result")) {
    return false;
  }
  if (isMaxTurnsErr(err)) {
    return false;
  }
  return msg.includes("verification ");
}

/**
 * 合并角色级与节点级的产物契约列表，按名称（无名时按路径）去重，节点级契约覆盖同名角色契约。
 * 在执行 Agent 节点前构造有效产物契约列表时调用。
 *
 * @param {Object[]} agentContracts - 角色定义的产物契约数组（domain.ArtifactContract[]）。
 * @param {Object[]} nodeContracts - 节点定义的产物契约数组（domain.ArtifactContract[]）。
 * @returns {Object[]} 合并后的产物契约数组。
 */
function mergeArtifactContracts(agentContracts, nodeContracts) {
  const merged = [];
  const index = {};
  // Go 对 nil 切片 append 为空操作，JS 用 ?? [] 补空数组。
  for (const contract of [...(agentContracts ?? []), ...(nodeContracts ?? [])]) {
    let key = contract.Name.trim();
    if (key === "") {
      key = contract.Path.trim();
    }
    if (Object.hasOwn(index, key)) {
      merged[index[key]] = contract;
      continue;
    }
    index[key] = merged.length;
    merged.push(contract);
  }
  return merged;
}

/**
 * 在节点被用户暂停或取消时更新节点终态与活动说明，并写入对应运行事件。
 * 在节点响应取消信号退出时调用。
 *
 * @param {string} runID - 运行 ID。
 * @param {Object} node - 工作流节点定义（domain.WorkflowNode）。
 * @returns {void} 无返回值。
 */
Engine.prototype.nodeCancelled = function (runID, node) {
  this.updateRun(runID, (r) => {
    const nr = r.Nodes[node.ID];
    if (r.PauseRequested) {
      nr.Status = "waiting_approval";
      nr.Error = "";
      nr.Activity = "已由用户暂停，等待补充信息";
      if (isScriptNode(node)) {
        nr.Activity = "已由用户暂停，继续后脚本将从头执行";
      }
    } else {
      nr.Status = "cancelled";
      nr.Error = "";
      nr.Activity = "已由用户取消";
    }
    nr.FinishedAt = new Date();
    if (r.PauseRequested) {
      this.event(r, node.ID, "node.paused", node.Name + " 已暂停");
    } else {
      this.event(r, node.ID, "node.cancelled", node.Name + " 已取消");
    }
  });
};

/**
 * 处理运行主循环因上下文取消而中断时的收尾分流：按当前状态决定暂停、取消、正常结算或挂起等待其他实例接管。
 * 在 Engine.execute 检测到 ctx 取消并排空在途节点后调用。
 *
 * @param {string} runID - 运行 ID。
 * @param {number} generation - 当前实例持有的运行租约代次。
 * @returns {void} 无返回值。
 */
Engine.prototype.finishInterruptedAt = function (runID, generation) {
  const [current, ok] = this.repo.RunState(runID);
  if (ok && current.PauseRequested) {
    this.pauseAt(runID, generation, "运行已由用户暂停");
    return;
  }
  if (ok && current.CancelRequested) {
    this.finishAt(runID, generation, "cancelled", "流水线已取消");
    return;
  }
  if (ok) {
    const [status, msg, done] = settleStatusForCompletedGraph(workflowForRun(this.repo, current), current);
    if (done && !(status === "succeeded" && scheduledIntegratePending(current))) {
      this.finishAt(runID, generation, status, msg);
      return;
    }
  }
  this.parkForResumeAt(runID, generation, "执行实例正在退出，已挂起等待接管");
};

/**
 * 将仍处于运行中的实例安全挂起：停止调度器、重置在途节点等待恢复、分离本地运行环境并发送 run.parked 遥测事件。
 * 在引擎实例优雅退出或失去租约前挂起未完成运行时调用。
 *
 * @param {string} runID - 运行 ID。
 * @param {number} generation - 当前实例持有的运行租约代次。
 * @param {string} message - 挂起原因说明。
 * @returns {void} 无返回值。
 */
Engine.prototype.parkForResumeAt = function (runID, generation, message) {
  this.stopRunScheduler(runID);
  let parked = false;
  this.updateRun(runID, (r) => {
    if (r.Generation !== generation || ((r.OwnerInstanceID !== "" || r.Generation > 0) && !this.ownsRun(r))) {
      return;
    }
    if (TerminalRunStatus(r.Status)) {
      return;
    }
    resetInFlightNodesForResume(r, "执行实例退出，等待恢复");
    r.Status = "running";
    this.event(r, "", "run.parked", message);
    parked = true;
  });
  if (parked) {
    this.detachRunEnvironment(runID);
    this.observe(runID, "", new TelemetryEvent({ Category: "orchestration", Name: "run.parked", Phase: "finish", Message: message }));
  }
};

/**
 * 当单个节点因沙箱中断异常退出时，将其重新放回待执行队列以便后续恢复。
 * 在节点执行捕获到 runtime.IsSandboxInterrupt 错误时调用。
 *
 * @param {string} runID - 运行 ID。
 * @param {string} nodeID - 节点 ID。
 * @param {number} attempt - 本次执行的尝试次数。
 * @param {number} generation - 本次执行的租约代次。
 * @returns {void} 无返回值。
 */
Engine.prototype.requeueInterruptedNode = function (runID, nodeID, attempt, generation) {
  this.updateRun(runID, (r) => {
    const nr = r.Nodes[nodeID];
    if (!shouldCommitNodeOutcome(r, nr, generation, attempt, false)) {
      return;
    }
    if (nr.Status !== "running" && nr.Status !== "pending_input") {
      return;
    }
    resetNodeForResume(r, nr, "沙箱执行中断，等待恢复");
    r.Status = "running";
    this.event(r, nodeID, "node.interrupted", "执行中断，节点已挂起等待恢复");
  });
};

/**
 * 响应用户暂停请求：停止调度器，把所有执行中或待输入节点转为 waiting_approval，并将运行置为 waiting。
 * 在运行主循环检测到 PauseRequested 后调用。
 *
 * @param {string} runID - 运行 ID。
 * @param {number} generation - 当前实例持有的运行租约代次。
 * @param {string} message - 暂停事件说明文本。
 * @returns {void} 无返回值。
 */
Engine.prototype.pauseAt = function (runID, generation, message) {
  this.stopRunScheduler(runID);
  this.updateRun(runID, (r) => {
    if (r.Generation !== generation || ((r.OwnerInstanceID !== "" || r.Generation > 0) && !this.ownsRun(r))) {
      return;
    }
    const now = new Date();
    for (const [nodeID, nr] of Object.entries(r.Nodes)) {
      if (nr == null || (nr.Status !== "running" && nr.Status !== "pending_input")) {
        continue;
      }
      nr.Status = "waiting_approval";
      nr.Error = "";
      nr.Activity = "已由用户暂停，等待补充信息";
      for (const node of r.WorkflowSnapshot.Nodes ?? []) {
        if (node.ID === nodeID && isScriptNode(node)) {
          nr.Activity = "已由用户暂停，继续后脚本将从头执行";
          break;
        }
      }
      nr.FinishedAt = now;
      this.event(r, nodeID, "node.paused", "执行已暂停，等待人工补充信息");
    }
    r.Status = "waiting";
    r.CancelRequested = false;
    r.PauseRequested = true;
    this.event(r, "", "run.paused", message);
  });
};

/**
 * 使用最新持久化代次结束指定运行。
 * 作为 finishAt 的便捷封装，供不持有代次上下文的调用方使用。
 *
 * @param {string} id - 运行 ID。
 * @param {string} status - 目标终态（如 "succeeded"、"failed"、"cancelled"）。
 * @param {string} msg - 终态事件说明。
 * @returns {void} 无返回值。
 */
Engine.prototype.finish = function (id, status, msg) {
  const [r, ok] = this.repo.RunState(id);
  if (!ok) {
    return;
  }
  this.finishAt(id, r.Generation, status, msg);
};

/**
 * 判断一次“流水线执行失败”结算是否已经过期（例如失败节点已被并发打回或重置）。
 * 在 finishAt 停止调度器前调用，避免过期失败结算误杀正在回卷重做的运行；Go 的 stateMu 在单线程 JS 中省略。
 *
 * @param {string} id - 运行 ID。
 * @param {string} status - 拟写入的终态。
 * @param {string} msg - 拟写入的终态说明。
 * @returns {boolean} 若该失败结算已过期返回 true，否则返回 false。
 */
Engine.prototype.stalePipelineFailure = function (id, status, msg) {
  if (status !== "failed" || msg !== pipelineFailedMessage) {
    return false;
  }
  // Go 的 stateMu 在单线程 JS 中省略。
  const [current, ok] = this.repo.RunState(id);
  if (!ok) {
    return false;
  }
  return !hasFailed(workflowForRun(this.repo, current), current);
};

/**
 * 按指定租约代次将运行收敛到终态，并在成功后执行 Issue 交付标记、预览归档与沙箱工作区清理。
 * 在流水线全部成功、失败、取消或图结算完成时调用。
 *
 * @param {string} id - 运行 ID。
 * @param {number} generation - 发起收尾时的运行租约代次。
 * @param {string} status - 目标终态（"succeeded"、"failed" 或 "cancelled"）。
 * @param {string} msg - 写入运行终态事件的说明文本。
 * @returns {void} 无返回值。
 */
Engine.prototype.finishAt = function (id, generation, status, msg) {
  if (this.stalePipelineFailure(id, status, msg)) {
    return;
  }
  this.stopRunScheduler(id);
  let ignored = false;
  let delivered = null;
  let deliveredAt = null;
  if (!this.updateRunSettling(id, (r) => {
    const unowned = (r.OwnerInstanceID !== "" || r.Generation > 0) && !this.ownsRun(r);
    if ((r.Generation !== generation || unowned) && !canSettleUnowned(r, status)) {
      ignored = true;
      return;
    }
    if (TerminalRunStatus(r.Status)) {
      ignored = true;
      return;
    }
    if (status === "failed" && msg === pipelineFailedMessage && !hasFailed(workflowForRun(this.repo, r), r)) {
      ignored = true;
      this.event(r, "", "run.finish_ignored", "失败节点已被打回，忽略过期的失败收尾");
      return;
    }
    if (status === "failed" && hasActiveNode(r)) {
      ignored = true;
      this.event(r, "", "run.finish_ignored", "仍有活动节点，忽略过期的失败收尾");
      return;
    }
    if (status === "cancelled" || status === "failed") {
      this.cancelRunningNodes(r);
    }
    r.Status = status;
    this.event(r, "", "run." + status, msg);
    // 子 SOP 与父运行共享 Issue，仅顶层运行负责标记交付。
    if (status === "succeeded" && r.ExecutionContext.IssueID !== "" && r.ExecutionContext.ParentRunID === "") {
      const snapshot = { ...r };
      delivered = snapshot;
      deliveredAt = new Date();
    }
  }) || ignored) {
    return;
  }
  // 解析 MR 可能调用外部平台接口，因此放在运行状态更新回调之外执行。
  if (delivered != null) {
    // Go 的 `_ =` 丢弃返回值与错误。
    try {
      this.repo.MarkIssueDeliveredFromSOPMRs(delivered.ExecutionContext.IssueID, this.deliveryMRsFromRun(delivered), deliveredAt);
    } catch {}
  }
  // 失败运行保留工作区以便同工作区重试；成功与取消运行立即释放工作区。
  if (status === "succeeded" || status === "cancelled") {
    this.observe(id, "", new TelemetryEvent({ Category: "sandbox", Name: "sandbox.closed", Phase: "finish", Message: "run sandbox released" }));
    if (status === "succeeded" && this.preview != null) {
      const [current, ok] = this.repo.RunState(id);
      if (ok && this.preview.BeginFinalization(current)) {
        return;
      }
    }
    this.cleanupRunWorkspace(id);
  }
};

/**
 * 检查运行中是否仍有正在执行或等待人工输入的活动节点。
 * 在 finishAt 中用于拦截滞后的失败收尾。
 *
 * @param {Object} r - 当前运行对象（domain.Run）。
 * @returns {boolean} 存在 running、waiting_approval 或 pending_input 节点时返回 true，否则返回 false。
 */
function hasActiveNode(r) {
  for (const nr of Object.values(r.Nodes)) {
    if (nr != null && (nr.Status === "running" || nr.Status === "waiting_approval" || nr.Status === "pending_input")) {
      return true;
    }
  }
  return false;
}

/**
 * 在运行被取消或失败时，将所有仍停留在 running 状态的节点收敛为 cancelled。
 * 防止卡死的执行分支残留 running 状态导致后续重试无法定位可恢复节点。
 *
 * @param {Object} r - 当前运行对象（domain.Run，原地修改）。
 * @returns {void} 无返回值。
 */
Engine.prototype.cancelRunningNodes = function (r) {
  for (const [nodeID, nr] of Object.entries(r.Nodes)) {
    if (nr == null || nr.Status !== "running") {
      continue;
    }
    nr.Status = "cancelled";
    if (nr.FinishedAt == null) {
      nr.FinishedAt = new Date();
    }
    if (nr.Activity.trim() === "") {
      nr.Activity = "运行终止时仍在执行，已收敛为已取消";
    }
    this.event(r, nodeID, "node.cancelled", "运行终止，节点由执行中收敛为已取消");
  }
};

module.exports = { errGongfengIssueClosed, shouldCommitNodeOutcome, shouldRetryFailedAttempt, gateReworkReject, resolveGateOnFailure, isMaxTurnsErr, forbidClosedGongfengIssue, nodeRejects, allowRejectOnFailure, mergeArtifactContracts, hasActiveNode };
