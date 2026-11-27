/**
 * @file lifecycle.js
 * 对应 Go 源文件：internal/engine/lifecycle.go
 * 作用与职责边界：负责运行生命周期的恢复、整图终态结算判断、调度器停止与活跃检测、
 * 状态不一致时的强制终止清理，以及运行交付 MR 的解析。
 * 语法差异说明：
 * - Go 的 `(status, msg string, ok bool)` 三返回值译为 `[status, msg, ok]` 数组。
 * - Go 的 `sync.Mutex` 在单线程 JS 中省略；`log.Printf` 译为 `console.log`。
 * - Go 的 `FindBranchMR` 返回 `(mr, ok, err)` 译为成功返回 `[mr, ok]`、失败 `throw Error`。
 * - 同包函数（`run_ops.js`、`workflow_graph.js`）按需在函数内延迟 `require`，避免循环依赖。
 */

"use strict";

const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { DeliveryMR, ResolveRunDeliveryMRs } = require("../domain/delivery_mr.js"); // 对应 Go 的 domain.DeliveryMR/ResolveRunDeliveryMRs，delivery_mr.js 已翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译

/**
 * 判断节点当前是否处于“服务中断后等待恢复的同一次尝试”状态。
 * 使用场景：节点重新调度启动时，决定是沿用已有尝试计数还是开启新一次尝试。
 *
 * @param {object|null} nr - 节点运行态对象（domain.NodeRun）。
 * @returns {boolean} 节点已开始尝试、无错误且活动说明包含 `"等待恢复"` 时返回 `true`。
 */
function continuingInterruptedAttempt(nr) {
  if (nr == null || nr.Attempt <= 0 || nr.Error.trim() !== "") {
    return false;
  }
  return nr.Activity.includes("等待恢复");
}

/**
 * 将单个处于 `running` 或 `pending_input` 的节点重置为 `pending` 以便恢复执行。
 * 非脚本节点会保留原 `SessionID` 到 `ResumeSessionID` 以续接会话，脚本节点则清空续接会话。
 * 使用场景：控制面重启恢复中断运行或人工触发恢复时，重置在途节点状态。
 *
 * @param {object} r - 运行对象（domain.Run）。
 * @param {object|null} nr - 待重置的节点运行态对象（domain.NodeRun）。
 * @param {string} activity - 重置后写入节点的活动状态说明。
 * @returns {void} 无返回值。
 */
function resetNodeForResume(r, nr, activity) {
  const { isScriptNode } = require("./run_ops.js");
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

/**
 * 遍历运行中的所有节点，将全部在途节点重置为待恢复状态。
 * 使用场景：恢复中断运行或重建调度前，批量调用 `resetNodeForResume`。
 *
 * @param {object|null} r - 运行对象（domain.Run）。
 * @param {string} activity - 写入各被重置节点的活动说明。
 * @returns {void} 无返回值。
 */
function resetInFlightNodesForResume(r, activity) {
  if (r == null) {
    return;
  }
  for (const nr of Object.values(r.Nodes)) {
    resetNodeForResume(r, nr, activity);
  }
}

/**
 * 当工作流快照中所有节点均已结束且无在途节点时，计算运行应结算的终态与原因消息。
 * 空图不直接结算，留给 `ResumeInterruptedRuns` 恢复从未冻结工作流快照的孤儿运行。
 * 使用场景：调度循环或孤儿清理判断整图是否可以进入 `succeeded` / `failed` 终态。
 *
 * @param {object} wf - 工作流定义对象（domain.WorkflowDefinition）。
 * @param {object} r - 运行对象（domain.Run）。
 * @returns {[string, string, boolean]} 三元组 `[status, msg, ok]`；不可结算时返回 `["", "", false]`。
 */
function settleStatusForCompletedGraph(wf, r) {
  const { allSucceeded, hasWaiting, hasFailed } = require("./workflow_graph.js");
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

/**
 * 判断定时运行是否仍存在待合入的集成分支与工作分支。
 * 节点全部成功并非定时运行的终点，后续还需 `integrateScheduledRun` 执行合入；提前标为成功会误删推送中的工作区。
 * 使用场景：未持有租约的清理路径判断是否可以安全地直接将运行结算为 `succeeded`。
 *
 * @param {object} r - 运行对象（domain.Run）。
 * @returns {boolean} 属于定时任务且至少一个仓库同时配置了集成分支与工作分支时返回 `true`。
 */
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

/**
 * 判断无调度器持有的运行是否可以被直接结算为指定终态。
 * 使用场景：外部恢复或孤儿结算路径写入终态前的安全校验。
 *
 * @param {object} r - 运行对象（domain.Run）。
 * @param {string} status - 期望结算的目标状态（如 `"succeeded"`、`"failed"`）。
 * @returns {boolean} 允许结算为目标状态时返回 `true`，否则返回 `false`。
 */
function canSettleUnowned(r, status) {
  const { workflowForRun } = require("./workflow_graph.js");
  if (status === "succeeded" && scheduledIntegratePending(r)) {
    return false;
  }
  const [got, , ok] = settleStatusForCompletedGraph(workflowForRun(null, r), r);
  return ok && got === status;
}

/**
 * 停止指定运行在本实例上的调度器循环（若存在取消函数则调用之）。
 * 使用场景：取消运行、强制终止或租约丢失时中止本地调度协程。
 *
 * @param {string} runID - 运行 ID。
 * @returns {void} 无返回值。
 */
Engine.prototype.stopRunScheduler = function (runID) {
  // Go 的 e.mu 省略，JS 单线程无需加锁。
  const cancel = this.running[runID];
  if (cancel != null) {
    cancel();
  }
};

/**
 * 检查指定运行当前是否在本实例的活跃调度器映射中。
 * 使用场景：避免重复启动调度器或判断运行是否由本实例托管。
 *
 * @param {string} runID - 运行 ID。
 * @returns {boolean} 存在活跃调度器时返回 `true`，否则返回 `false`。
 */
Engine.prototype.isRunSchedulerActive = function (runID) {
  // Go 的 e.mu 省略，JS 单线程无需加锁。
  return this.running[runID] !== undefined;
};

/**
 * 强制终止并结算指定运行：停止本地调度器、收敛所有在途节点状态、写入终态事件，并在成功或取消时清理工作区（或移交预览收尾）。
 * 使用场景：部分失败、人工强制取消或脑裂恢复后，聚合运行状态与在途工作节点不一致时调用。
 *
 * @param {string} runID - 运行 ID。
 * @param {string} status - 目标终态（如 `"cancelled"`、`"failed"`、`"succeeded"`）。
 * @param {string} msg - 写入节点错误与运行事件的原因说明。
 * @returns {void} 无返回值。
 */
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

/**
 * 根据孤儿运行的中断原因文案推断结算终态（包含 `"手动终止"` 或 `"取消"` 时归为 `"cancelled"`，否则 `"failed"`）。
 * 使用场景：清理或结算失联孤儿运行时确定最终状态。
 *
 * @param {string} reason - 中断或终止原因文本。
 * @returns {string} 推断出的终态字符串（`"cancelled"` 或 `"failed"`）。
 */
function orphanSettleStatus(reason) {
  if (reason.includes("手动终止") || reason.includes("取消")) {
    return "cancelled";
  }
  return "failed";
}

/**
 * 按运行的各个仓库解析最终交付 MR 列表：优先通过 `FindBranchMR` 按工作分支查询工蜂，查不到时回退到同项目带 MR 信息的产物。
 * 使用场景：运行结束汇总交付物、展示 MR 链接或同步 Issue 交付状态时调用。
 *
 * @param {object} run - 运行对象（domain.Run）。
 * @returns {object[]} 解析得到的交付 MR 对象数组（domain.DeliveryMR[]）。
 */
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
