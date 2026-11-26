// lifecycle.js —— 对应 Go 文件：internal/engine/lifecycle.go
// 作用：运行生命周期收尾：中断恢复、整图结算、强制终止与交付 MR 解析。
// (值, error) 译为成功返回值、失败 throw；(值, 值, bool) 译为 [值, 值, bool]；time.Time 零值译为 null；log.Printf 译为 console.log；sync.Mutex 省略。

"use strict";

const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { DeliveryMR, ResolveRunDeliveryMRs } = require("../domain/delivery_mr.js"); // 对应 Go 的 domain.DeliveryMR/ResolveRunDeliveryMRs，delivery_mr.js 已翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译

function continuingInterruptedAttempt(nr) {
  if (nr == null || nr.Attempt <= 0 || nr.Error.trim() !== "") {
    return false;
  }
  return nr.Activity.includes("等待恢复");
}

function resetNodeForResume(r, nr, activity) {
  if (nr == null) {
    return;
  }
  switch (nr.Status) {
    case "running":
    case "pending_input":
      break;
    default:
      return;
  }
  nr.Status = "pending";
  nr.Error = "";
  nr.Activity = activity;
  let script = false;
  for (const node of r.WorkflowSnapshot.Nodes) {
    if (node.ID === nr.NodeID && isScriptNode(node)) {
      script = true;
      break;
    }
  }
  if (script) {
    nr.ResumeSessionID = "";
    return;
  }
  const sid = nr.SessionID.trim();
  if (sid !== "") {
    nr.ResumeSessionID = sid;
  }
}

function resetInFlightNodesForResume(r, activity) {
  if (r == null) {
    return;
  }
  for (const nr of Object.values(r.Nodes)) {
    resetNodeForResume(r, nr, activity);
  }
}

// settleStatusForCompletedGraph：快照节点全部结束且无在途节点时报告终态；空图不结算，ResumeInterruptedRuns 用它恢复快照从未冻结的孤儿。
function settleStatusForCompletedGraph(wf, r) {
  if (wf.CollaborationMode === "group" || wf.Nodes.length === 0 || r.HasActiveNode()) {
    return ["", "", false];
  }
  if (allSucceeded(wf, r)) {
    return ["succeeded", "流水线执行完成", true];
  }
  if (hasWaiting(wf, r)) {
    return ["", "", false];
  }
  if (hasFailed(wf, r)) {
    return ["failed", pipelineFailedMessage, true];
  }
  return ["", "", false];
}

// pipelineFailedMessage：节点仍失败且无事可做时的结算原因；重做可能在结算写入前清除该失败，调用方此时须丢弃结算。
const pipelineFailedMessage = "流水线执行失败";

// scheduledIntegratePending：定时运行仍须把工作分支合入集成分支；节点成功不是运行终点，integrateScheduledRun 随后才合入，在此窗口把运行标为成功会删掉推送正在用的检出。
function scheduledIntegratePending(r) {
  if (r.ExecutionContext.ScheduleJobID.trim() === "") {
    return false;
  }
  for (const rc of r.RepositoryContexts()) {
    if (rc.IntegrateBranch.trim() !== "" && rc.WorkBranch.trim() !== "") {
      return true;
    }
  }
  return false;
}

function canSettleUnowned(r, status) {
  if (status === "succeeded" && scheduledIntegratePending(r)) {
    return false;
  }
  const [got, , ok] = settleStatusForCompletedGraph(workflowForRun(null, r), r);
  return ok && got === status;
}

Engine.prototype.stopRunScheduler = function (runID) {
  // Go 的 e.mu 省略，JS 单线程无需加锁。
  const cancel = this.running[runID];
  if (cancel != null) {
    cancel();
  }
};

Engine.prototype.isRunSchedulerActive = function (runID) {
  // Go 的 e.mu 省略，JS 单线程无需加锁。
  return this.running[runID] !== undefined;
};

// forceTerminate：聚合状态与在途 worker 不一致时（如部分失败或脑裂恢复后）结算运行。
Engine.prototype.forceTerminate = function (runID, status, msg) {
  this.stopRunScheduler(runID);
  this.updateRun(runID, (r) => {
    const now = new Date();
    for (const nr of Object.values(r.Nodes)) {
      if (nr == null) {
        continue;
      }
      switch (nr.Status) {
        case "running":
        case "pending_input":
        case "waiting_approval":
          if (status === "cancelled") {
            nr.Status = "cancelled";
            nr.Error = "";
            nr.Activity = "已由用户取消";
          } else {
            nr.Status = "failed";
            nr.Error = msg;
          }
          nr.FinishedAt = now;
          break;
      }
    }
    if (status === "cancelled" || !TerminalRunStatus(r.Status)) {
      r.Status = status;
      this.event(r, "", "run." + status, msg);
    }
  });
  if (status === "succeeded" || status === "cancelled") {
    if (status === "succeeded" && this.preview != null) {
      const [current, ok] = this.repo.RunState(runID);
      if (ok && this.preview.BeginFinalization(current)) {
        return;
      }
    }
    this.cleanupRunWorkspace(runID);
  }
};

function orphanSettleStatus(reason) {
  if (reason.includes("手动终止") || reason.includes("取消")) {
    return "cancelled";
  }
  return "failed";
}

// deliveryMRsFromRun：按运行仓库解析交付 MR：先按工作分支查 Gongfeng，再用同项目带 MR 的产物。
Engine.prototype.deliveryMRsFromRun = function (run) {
  let byBranch = null;
  if (this.FindBranchMR != null) {
    byBranch = (rc) => {
      try {
        return this.FindBranchMR(rc.GongfengProjectID, rc.WorkBranch);
      } catch (err) {
        console.log(`resolve delivery MR run=${run.ID} project=${rc.GongfengProjectID} branch=${rc.WorkBranch}: ${err}`);
        return [new DeliveryMR(), false];
      }
    };
  }
  return ResolveRunDeliveryMRs(run, byBranch);
};

module.exports = { continuingInterruptedAttempt, resetNodeForResume, resetInFlightNodesForResume, settleStatusForCompletedGraph, pipelineFailedMessage, scheduledIntegratePending, canSettleUnowned, orphanSettleStatus };
