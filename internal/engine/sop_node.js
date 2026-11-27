/**
 * 对应 Go 源文件：internal/engine/sop_node.go
 *
 * 文件作用与职责边界：
 * 负责父工作流中嵌套 SOP 节点的完整执行生命周期：
 * 包括循环嵌套与深度校验、复用或启动子 SOP 运行、轮询等待子运行结束、
 * 响应父运行取消信号以及将子 SOP 产出的交付物按合约导入回父运行。
 *
 * Go 与 JS 语法差异说明：
 * - Go 的 `context.Context` 译为 `AbortSignal`。
 * - Go 的 `time.NewTicker` + `select` 并发等待译为 `async/await` 配合 `sleepOrAbort` 循环。
 * - Go 的 `(值, error)` 译为成功返回值、失败 `throw`；仅返回 `error` 的函数成功返回 `undefined`、失败 `throw`。
 * - Go 的 `fmt.Sprintf` 的 `%q` 译为 `JSON.stringify`；Go 的 `crypto/sha256` 译为 `node:crypto` 的 `createHash("sha256")`。
 * - Go 的结构体值复制在 JS 中通过对象展开 `{ ...obj }` 表达。
 */

"use strict";

const { createHash } = require("node:crypto"); // Go crypto/sha256
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { Run, TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.Run/TelemetryEvent，run.js 已翻译
const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { ancestors } = require("./workflow_graph.js"); // 对应 Go 同包函数，workflow_graph.js 已翻译
const { groupSOPHandoffNode } = require("./legacy_handoff.js"); // 对应 Go 同包常量，legacy_handoff.js 已翻译
const { nodeRejects, shouldCommitNodeOutcome } = require("./node_outcome.js"); // 对应 Go 同包函数，node_outcome.js 已翻译
const { isLiveStatus } = require("./workspace_cleanup.js"); // 对应 Go 同包函数，workspace_cleanup.js 已翻译
const { workspaceRunID } = require("./workspace_owner.js"); // 对应 Go 同包函数，workspace_owner.js 已翻译

const maxSOPNesting = 6;

const errSOPArtifactWrite = new Error("保存子 SOP 产物失败");

/**
 * 执行父工作流中的一个嵌套 SOP 节点：校验嵌套关系、复用或启动子流程、等待结束并交接产物。
 * 使用场景：调度器分派到 `node.Type === "sop"` 的节点时异步调用。
 *
 * @param {AbortSignal} ctx - 取消控制信号，用于响应排空、暂停、租约丢失或父流程取消。
 * @param {string} runID - 父运行 ID。
 * @param {object} wf - 父运行的工作流定义（domain.WorkflowDefinition）。
 * @param {object} node - 当前执行的 SOP 节点定义（domain.WorkflowNode）。
 * @param {number} attempt - 当前节点执行尝试次数。
 * @param {number} generation - 当前运行的调度代次，用于提交结果时防并发覆盖。
 * @returns {Promise<void>} 无返回值；节点成功或失败状态均直接写回运行记录。
 */
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
        try {
          this.Cancel(prev.ID);
        } catch (_) {
          // 对应 Go `_ = e.Cancel(prev.ID)`，忽略取消错误。
        }
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

/**
 * 沿父运行链向上回溯，校验启动目标子 SOP 是否会造成循环引用或超过最大嵌套深度限制。
 * 使用场景：在 executeSOPNode 启动子 SOP 前调用。
 *
 * @param {object} parent - 当前父运行实例（domain.Run）。
 * @param {string} childWorkflowID - 待启动的子工作流 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 检测到循环引用或嵌套层数达到上限（maxSOPNesting）时抛出错误。
 */
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

/**
 * 组装传递给子 SOP 的输入文本，附加本节点声明的期望产出产物以及父流程上游节点已交付的产物清单。
 * 使用场景：启动新的子 SOP 运行前生成子运行输入提示。
 *
 * @param {object} parent - 父运行实例（domain.Run）。
 * @param {object} node - 当前 SOP 节点定义（domain.WorkflowNode）。
 * @returns {string} 拼接好的子 SOP 输入文本。
 */
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

/**
 * 将产物合约列表中的非空产物名用逗号空格拼接为字符串。
 * 使用场景：由 sopChildInput 调用，在输入文本中列出该 SOP 节点需要向父流程交付的产物名。
 *
 * @param {object[]} contracts - 产物合约数组（domain.ArtifactContract[]）。
 * @returns {string} 以 ", " 连接的产物名称列表。
 */
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

/**
 * 每隔 200ms 轮询等待子 SOP 运行到达终态，同时监听父流程取消与上下文中止信号。
 * 使用场景：executeSOPNode 启动或重新接上子 SOP 后调用。
 *
 * @param {AbortSignal} ctx - 取消控制信号。
 * @param {string} parentID - 父运行 ID。
 * @param {string} childID - 子运行 ID。
 * @returns {Promise<object>} 到达终态后的子运行实例（domain.Run）。
 * @throws {Error} 当上下文中止、父流程已取消或子运行记录消失时抛出错误。
 */
Engine.prototype.waitChildRun = async function (ctx, parentID, childID) {
  for (;;) {
    try {
      // Go：select { case <-ctx.Done(): case <-ticker.C: }，ticker 每 200 毫秒一跳。
      await sleepOrAbort(ctx, 200);
    } catch (err) {
      // 排空、暂停或租约丢失：子流程自己恢复，父流程再接上它；只有父流程显式取消才会停掉子流程。
      const [parent, ok] = this.repo.RunState(parentID);
      if (ok && (parent.CancelRequested || parent.Status === "cancelled")) {
        try {
          this.Cancel(childID);
        } catch (_) {
          // 对应 Go `_ = e.Cancel(childID)`，忽略取消错误。
        }
      }
      throw err;
    }
    const [parent, ok] = this.repo.RunState(parentID);
    if (ok && (parent.CancelRequested || parent.Status === "cancelled")) {
      try {
        this.Cancel(childID);
      } catch (_) {
        // 对应 Go `_ = e.Cancel(childID)`，忽略取消错误。
      }
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

/**
 * 从已成功的子 SOP 运行中筛选并导入应交接给父运行的产物列表，同名产物取最新一份并生成稳定 ID。
 * 使用场景：子 SOP 成功后，由 executeSOPNode 调用以校验产出合约并归属到父运行节点。
 *
 * @param {string} parentID - 父运行 ID。
 * @param {object} node - 当前 SOP 节点定义（domain.WorkflowNode）。
 * @param {number} attempt - 当前节点尝试次数。
 * @param {object} child - 已成功的子运行实例（domain.Run）。
 * @returns {object[]} 归属信息已重写为父运行的新产物列表（domain.Artifact[]）。
 * @throws {Error} 当节点声明了必需的产物合约但子 SOP 未交出对应产物时抛出错误。
 */
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

/**
 * 等待指定毫秒数或在 AbortSignal 触发中止时立即拒绝 Promise。
 * 使用场景：配合 waitChildRun 实现与 Go `time.NewTicker` + `select` 等价的可取消轮询等待。
 *
 * @param {AbortSignal} ctx - 取消控制信号。
 * @param {number} ms - 等待的毫秒数。
 * @returns {Promise<void>} 正常到时后 resolve，无返回值；中止时以 `ctx.reason` reject。
 */
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
