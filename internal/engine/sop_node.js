// sop_node.js —— 对应 Go 文件：internal/engine/sop_node.go
// 作用：SOP 节点执行：启动或接上子 SOP、等它结束、把产物交接回父流程。
// context.Context 译为 AbortSignal；time.Ticker + select 译为 sleepOrAbort 循环；(值, error) 译为成功返回值、失败 throw；fmt.Sprintf 的 %q 译为 JSON.stringify。

"use strict";

const { createHash } = require("node:crypto"); // Go crypto/sha256
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { Run, TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.Run/TelemetryEvent，run.js 已翻译
const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { ancestors } = require("./workflow_graph.js"); // 对应 Go 同包函数，workflow_graph.js 本批翻译
const { groupSOPHandoffNode } = require("./legacy_handoff.js"); // 对应 Go 同包常量，legacy_handoff.js 已翻译
const { nodeRejects, shouldCommitNodeOutcome } = require("./node_outcome.js"); // 对应 Go 同包函数，node_outcome.js 已翻译

const maxSOPNesting = 6;

const errSOPArtifactWrite = new Error("保存子 SOP 产物失败");

Engine.prototype.executeSOPNode = async function (ctx, runID, wf, node, attempt, generation) {
  const fail = (err) => {
    if (err == null) {
      return;
    }
    if (ctx instanceof AbortSignal && ctx.aborted) {
      return;
    }
    this.nodeFailedAt(runID, node, attempt, generation, err, nodeRejects(node));
  };
  let [parent, ok] = this.repo.RunState(runID);
  if (!ok) {
    fail(new Error("parent run disappeared"));
    return;
  }
  const childID = node.SOPWorkflowID.trim();
  if (childID === "") {
    fail(new Error("SOP 节点未选择要跑的流程"));
    return;
  }
  try {
    this.guardSOPCycle(parent, childID);
  } catch (err) {
    fail(err);
    return;
  }
  const [, found] = this.repo.Workflow(childID);
  if (!found) {
    fail(new Error(`SOP 流程 ${JSON.stringify(childID)} 不存在`));
    return;
  }
  let child = new Run();
  const nr = parent.Nodes[node.ID];
  if (nr != null && nr.ChildRunID !== "") {
    // 部署、暂停或租约接管打断了父流程而子流程还在跑（或已跑完）；继续跟进该子流程，包括它的结果，而不是重跑 SOP。想走全新子流程的重置路径会先清掉 ChildRunID。
    const [prev, okPrev] = this.repo.RunState(nr.ChildRunID);
    if (okPrev) {
      if (prev.WorkflowID === childID) {
        child = prev;
      } else if (isLiveStatus(prev.Status)) {
        // 节点被重新指向另一个 SOP（RefreshRunSOP）；旧子流程的工作不再属于该节点。
        this.Cancel(prev.ID);
      }
    }
  }
  if (child.ID === "") {
    // 池化运行在第一个非 SOP 节点绑定执行机器。现在就绑定，让子流程继承持有共享检出的机器，而不是自己另选一台。
    let bound;
    try {
      bound = await this.bindPoolRunner(ctx, parent, node.ID);
    } catch (err) {
      fail(err);
      return;
    }
    parent = bound;
    const childInput = sopChildInput(parent, node);
    // Go 结构体赋值是值复制，JS 用展开复制。
    const exec = { ...parent.ExecutionContext };
    exec.ParentRunID = parent.ID;
    exec.ParentNodeID = node.ID;
    // 子流程用父流程的检出工作，它的改动都在父流程继续时能看到的地方；不经过远端。
    exec.WorkspaceRunID = workspaceRunID(parent);
    exec.RunID = "";
    exec.TraceID = parent.ExecutionContext.TraceID;
    let started;
    try {
      started = await this.StartWithRepositoriesContext(childID, childInput, parent.RepositoryContexts(), exec);
    } catch (err) {
      fail(new Error(`启动子 SOP：${err.message}`));
      return;
    }
    child = started;
    this.updateRun(runID, (r) => {
      const nr = r.Nodes[node.ID];
      if (nr != null) {
        nr.ChildRunID = child.ID;
        nr.Activity = "正在执行子 SOP " + childID;
      }
      this.event(r, node.ID, "sop.started", node.Name + " 启动子流程 " + childID);
    });
    this.observe(runID, node.ID, new TelemetryEvent({
      Category: "orchestration", Name: "sop.child.started", Phase: "start",
      Message: "子 SOP 已启动",
      Attributes: { childRunId: child.ID, sopWorkflowId: childID },
    }));
  } else {
    this.updateRun(runID, (r) => {
      const nr = r.Nodes[node.ID];
      if (nr != null) {
        nr.Activity = "正在执行子 SOP " + childID;
      }
    });
    this.observe(runID, node.ID, new TelemetryEvent({
      Category: "orchestration", Name: "sop.child.reattached", Phase: "start",
      Message: "重新接上仍在运行的子 SOP",
      Attributes: { childRunId: child.ID, sopWorkflowId: childID },
    }));
  }
  let finished;
  try {
    finished = await this.waitChildRun(ctx, runID, child.ID);
  } catch (err) {
    fail(err);
    return;
  }
  if (finished.Status !== "succeeded") {
    fail(new Error(`子 SOP ${childID} ${finished.Status}`));
    return;
  }
  let imported;
  try {
    imported = importChildArtifacts(parent.ID, node, attempt, finished);
  } catch (err) {
    fail(err);
    return;
  }
  let applied = false;
  let err = null;
  try {
    this.updateRunErr(runID, (r) => {
      const nr = r.Nodes[node.ID];
      if (!shouldCommitNodeOutcome(r, nr, generation, attempt, true)) {
        return;
      }
      applied = true;
      nr.ChildRunID = finished.ID;
      r.Artifacts = [...r.Artifacts, ...imported];
      nr.Output = `子 SOP ${childID} 已完成，交接 ${imported.length} 个产物`;
      nr.Error = "";
      nr.Status = "succeeded";
      nr.FinishedAt = new Date();
      this.event(r, node.ID, "node.succeeded", node.Name + " 已完成");
    });
  } catch (e) {
    err = e;
  }
  if (!applied) {
    return;
  }
  if (err != null) {
    if (!(ctx instanceof AbortSignal && ctx.aborted)) {
      this.nodeFailedAt(runID, node, attempt, generation, new Error(`${errSOPArtifactWrite.message}：${err.message}`), false);
    }
    return;
  }
  for (const artifact of imported) {
    this.observe(runID, node.ID, new TelemetryEvent({
      Category: "artifact", Name: "artifact.published", Phase: "finish",
      Message: artifact.Name, Attributes: { artifactId: artifact.ID, path: artifact.Path, childRunId: finished.ID },
    }));
  }
};

Engine.prototype.guardSOPCycle = function (parent, childWorkflowID) {
  childWorkflowID = childWorkflowID.trim();
  const seen = {};
  let depth = 0;
  let current = parent;
  for (;;) {
    const wfID = current.WorkflowID.trim();
    if (wfID !== "") {
      if (wfID === childWorkflowID) {
        throw new Error(`SOP 节点不能循环引用流程 ${JSON.stringify(childWorkflowID)}`);
      }
      if (seen[wfID]) {
        throw new Error("SOP 嵌套链出现循环");
      }
      seen[wfID] = true;
    }
    depth++;
    if (depth >= maxSOPNesting) {
      throw new Error(`SOP 嵌套超过 ${maxSOPNesting} 层`);
    }
    const parentID = current.ExecutionContext.ParentRunID.trim();
    if (parentID === "") {
      return;
    }
    const [next, ok] = this.repo.RunState(parentID);
    if (!ok) {
      return;
    }
    current = next;
  }
};

function sopChildInput(parent, node) {
  let input = parent.Input.trim();
  const prior = ancestors(parent.WorkflowSnapshot, node.ID);
  const names = [];
  const seen = {};
  for (const art of parent.Artifacts) {
    if (art.Name === "" || art.Name === "repository-patch" || seen[art.Name]) {
      continue;
    }
    if (Object.keys(prior).length > 0 && !prior[art.NodeID]) {
      continue;
    }
    seen[art.Name] = true;
    names.push(art.Name);
  }
  if (node.ArtifactOutputs.length > 0) {
    input += "\n\nThis SOP node will publish these artifacts to the next parent step: " + joinArtifactNames(node.ArtifactOutputs);
  }
  if (names.length === 0) {
    return input;
  }
  input += "\n\nHandoff from previous nodes in the parent flow:";
  for (const name of names) {
    input += "\n- " + name;
  }
  input += "\nContinue from those deliverables; do not redo the previous SOP.";
  return input;
}

function joinArtifactNames(contracts) {
  const names = [];
  for (const c of contracts) {
    const name = c.Name.trim();
    if (name !== "") {
      names.push(name);
    }
  }
  return names.join(", ");
}

Engine.prototype.waitChildRun = async function (ctx, parentID, childID) {
  for (;;) {
    try {
      // Go：select { case <-ctx.Done(): case <-ticker.C: }，ticker 每 200 毫秒一跳。
      await sleepOrAbort(ctx, 200);
    } catch (err) {
      // 排空、暂停或租约丢失：子流程自己恢复，父流程再接上它；只有父流程显式取消才会停掉子流程。
      const [parent, ok] = this.repo.RunState(parentID);
      if (ok && (parent.CancelRequested || parent.Status === "cancelled")) {
        this.Cancel(childID);
      }
      throw err;
    }
    const [parent, ok] = this.repo.RunState(parentID);
    if (ok && (parent.CancelRequested || parent.Status === "cancelled")) {
      this.Cancel(childID);
      throw new Error("父流程已取消");
    }
    const [child, okChild] = this.repo.RunState(childID);
    if (!okChild) {
      throw new Error("子 SOP 运行消失");
    }
    if (TerminalRunStatus(child.Status)) {
      return child;
    }
  }
};

function importChildArtifacts(parentID, node, attempt, child) {
  const want = {};
  for (const contract of node.ArtifactOutputs) {
    const name = contract.Name.trim();
    if (name !== "") {
      want[name] = true;
    }
  }
  const now = new Date();
  // 改过的子节点会用同一个名字再次发布；交接最新的那份。
  const latest = {};
  const order = [];
  for (const art of child.Artifacts) {
    const ref = child.WorkflowSnapshot.GroupSOPHandoff;
    if (ref != null && art.NodeID === groupSOPHandoffNode && (art.ID === ref.SummaryArtifactID || art.ID === ref.TranscriptArtifactID)) {
      continue; // 继承来的上下文不是子流程的交付物
    }
    const name = art.Name.trim();
    if (name === "" || name === "repository-patch") {
      continue;
    }
    if (Object.keys(want).length > 0 && !want[name]) {
      continue;
    }
    const prev = latest[name];
    if (prev === undefined) {
      order.push(name);
    }
    if (prev === undefined || art.CreatedAt > prev.CreatedAt) {
      latest[name] = art;
    }
  }
  const imported = [];
  const have = {};
  for (const name of order) {
    // Go 从 map 取结构体是值复制，改 ID 不影响子流程的产物；JS 用展开复制。
    const art = { ...latest[name] };
    have[name] = true;
    // 键在本次交接内保持稳定，且控制在 run_artifacts.id 的 64 字符内；Go fmt %q 译为 JSON.stringify。
    const key = `${JSON.stringify(parentID)}/${JSON.stringify(node.ID)}/${attempt}/${JSON.stringify(child.ID)}/${JSON.stringify(name)}`;
    const sum = createHash("sha256").update(key).digest("hex");
    art.ID = `art-${sum.slice(0, 40)}`;
    art.RunID = parentID;
    art.NodeID = node.ID;
    art.Attempt = attempt;
    art.CreatedAt = now;
    imported.push(art);
  }
  for (const name of Object.keys(want)) {
    if (!have[name]) {
      throw new Error(`子 SOP 没有交出产物 ${JSON.stringify(name)}`);
    }
  }
  return imported;
}

// sleepOrAbort：等满毫秒或等到 ctx 取消，对应 Go 的 time.NewTimer + select。
function sleepOrAbort(ctx, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(ctx.reason);
    };
    const cleanup = () => {
      if (ctx instanceof AbortSignal) {
        ctx.removeEventListener("abort", onAbort);
      }
    };
    if (ctx instanceof AbortSignal) {
      if (ctx.aborted) {
        onAbort();
        return;
      }
      ctx.addEventListener("abort", onAbort, { once: true });
    }
  });
}

module.exports = { maxSOPNesting, errSOPArtifactWrite, sopChildInput, joinArtifactNames, importChildArtifacts };
