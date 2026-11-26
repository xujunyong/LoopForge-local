// node_outcome.js —— 对应 Go 文件：internal/engine/node_outcome.go
// 作用：节点终态：失败重试与打回、人工门禁、运行收尾与挂起恢复。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TelemetryEvent，run.js 已翻译
const { RejectRequest } = require("../domain/issue.js"); // 对应 Go 的 domain.RejectRequest，issue.js 已翻译
const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { Store } = require("../repo/repo.js"); // 对应 Go 的 repo.Store，repo.js 已翻译
const { ErrMaxTurns } = require("../runtime/runner.js"); // 对应 Go 的 runtime.ErrMaxTurns，runtime 待翻译
const { IsCwdMountFailure } = require("../runtime/sandbox_docker.js"); // 对应 Go 的 runtime.IsCwdMountFailure，runtime 待翻译

Engine.prototype.waitApproval = function (runID, node, msg) {
  this.updateRun(runID, (r) => {
    const nr = r.Nodes[node.ID];
    nr.Status = "waiting_approval";
    nr.FinishedAt = new Date();
    this.event(r, node.ID, "gate.waiting", msg);
  });
};

Engine.prototype.nodeFailed = function (runID, node, err, allowReject) {
  const [r, ok] = this.repo.RunState(runID);
  if (!ok || r.Nodes[node.ID] == null) {
    return;
  }
  this.nodeFailedAt(runID, node, r.Nodes[node.ID].Attempt, r.Generation, err, allowReject);
};

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

Engine.prototype.nodeFailedAt = function (runID, node, attempt, generation, err, allowReject) {
  let shouldReject = false;
  const configurationFailure = err === ErrWorkspaceControlConfiguration;
  this.updateRun(runID, (r) => {
    const nr = r.Nodes[node.ID];
    if (!shouldCommitNodeOutcome(r, nr, generation, attempt, false)) {
      return;
    }
    nr.Error = err.message;
    nr.FinishedAt = new Date();
    const reworkBudget = node.RejectTo !== "" && r.Nodes[node.RejectTo] != null && r.Nodes[node.RejectTo].ReworkCount >= Math.max(1, node.MaxReworks);
    if (shouldRetryFailedAttempt(node, nr.Attempt, err) && !gateReworkReject(allowReject, nr)) {
      nr.Feedback = err.message;
      nr.Status = "pending";
      nr.ChildRunID = "";
      this.event(r, node.ID, "node.retry", "执行失败，准备重试：" + err.message);
    } else if (!configurationFailure && gateReworkReject(allowReject, nr) && reworkBudget) {
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

function shouldRetryFailedAttempt(node, attempt, err) {
  if (err === ErrWorkspaceControlConfiguration || err === errSOPArtifactWrite) {
    return false;
  }
  if (err != null && (isMaxTurnsErr(err) || err.message.includes("verification ") || IsCwdMountFailure(err))) {
    return false;
  }
  return attempt < Math.max(1, node.MaxAttempts);
}

function gateReworkReject(allowReject, nr) {
  return allowReject && nr != null && nr.GateResult != null && nr.GateResult.Decision.trim().toLowerCase() === "rework";
}

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

function isMaxTurnsErr(err) {
  if (err == null) {
    return false;
  }
  if (err === ErrMaxTurns) {
    return true;
  }
  const msg = err.message.toLowerCase();
  return msg.includes("max turns") || msg.includes("executor reached max turns");
}

const errGongfengIssueClosed = new Error("工蜂 Issue 已关闭，不能触发 SOP");

function forbidClosedGongfengIssue(st, r) {
  const id = r.ExecutionContext.IssueID.trim();
  if (id === "") {
    return null;
  }
  const [issue, ok] = st.Issue(id);
  if (ok && issue.GongfengClosed()) {
    return errGongfengIssueClosed;
  }
  return null;
}

function nodeRejects(node) {
  return node.RejectTo !== "" && (node.OnFailure === "" || node.OnFailure === "reject");
}

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

Engine.prototype.finish = function (id, status, msg) {
  const [r, ok] = this.repo.RunState(id);
  if (!ok) {
    return;
  }
  this.finishAt(id, r.Generation, status, msg);
};

Engine.prototype.stalePipelineFailure = function (id, status, msg) {
  if (status !== "failed" || msg !== pipelineFailedMessage) {
    return false;
  }
  this.stateMu.Lock();
  try {
    const [current, ok] = this.repo.RunState(id);
    if (!ok) {
      return false;
    }
    return !hasFailed(workflowForRun(this.repo, current), current);
  } finally {
    this.stateMu.Unlock();
  }
};

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
    if (status === "succeeded" && r.ExecutionContext.IssueID !== "" && r.ExecutionContext.ParentRunID === "") {
      const snapshot = { ...r };
      delivered = snapshot;
      deliveredAt = new Date();
    }
  }) || ignored) {
    return;
  }
  if (delivered != null) {
    // Go 的 `_ =` 丢弃返回值与错误。
    try {
      this.repo.MarkIssueDeliveredFromSOPMRs(delivered.ExecutionContext.IssueID, this.deliveryMRsFromRun(delivered), deliveredAt);
    } catch {}
  }
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

function hasActiveNode(r) {
  for (const nr of Object.values(r.Nodes)) {
    if (nr != null && (nr.Status === "running" || nr.Status === "waiting_approval" || nr.Status === "pending_input")) {
      return true;
    }
  }
  return false;
}

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
