/**
 * @file internal/domain/approval_reason.js
 * 对应 Go 源文件：internal/domain/approval_reason.go
 *
 * 作用与职责边界：
 * 生成审批（人工门禁）节点暂停运行时的中文原因说明，涵盖已完成的上下游节点、
 * 确认后的流向、驳回打回目标以及节点配置的确认要求。
 * 仅做纯文本拼装，不触发任何审批状态变更；逻辑与前端 `chatbot/src/runs.js` 保持一致。
 *
 * 语法差异说明：
 * - Go 的 `strings.Builder` 转写为字符串拼接。
 * - Go 的双返回值 `(upstream, downstream []string)` 转写为二元数组 `[upstream, downstream]`。
 */

"use strict";

/**
 * 根据运行快照中的工作流定义，生成指定审批节点暂停运行的可读原因说明。
 * 在展示待审批提醒、通知卡片或运行暂停详情时调用；节点不存在时返回空字符串。
 *
 * @param {Object} run - 运行对象（`Run`），需包含 `WorkflowSnapshot`。
 * @param {string} nodeID - 当前停住的人工门禁节点 ID。
 * @returns {string} 拼装好的人工门禁等待说明；找不到节点时返回 `""`。
 */
function ApprovalWaitReason(run, nodeID) {
  const wf = run.WorkflowSnapshot;
  let index = -1;
  for (let i = 0; i < wf.Nodes.length; i++) {
    if (wf.Nodes[i].ID === nodeID) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    return "";
  }
  const node = wf.Nodes[index];
  const [upstream, downstream] = approvalNeighbors(wf, index);
  let b = approvalSOPLabel(wf.Name) + "在这一步设置了人工门禁";
  if (upstream.length > 0) {
    b += "：" + upstream.join("、") + "已完成，需要有权限的成员检查结果后确认";
  } else {
    b += "，需要有权限的成员确认";
  }
  if (downstream.length > 0) {
    b += "，确认后继续" + downstream.join("、");
  } else {
    b += "，确认后运行结束";
  }
  if (node.RejectTo !== "") {
    b += "；不通过可打回到" + approvalNodeLabel(wf, node.RejectTo) + "重做";
  }
  b += "。";
  const instructions = node.TaskPrompt.trim();
  if (instructions !== "") {
    b += "确认要求：" + instructions;
  }
  return b;
}

/**
 * 计算工作流中指定索引位置节点的上游前置步骤标签和下游后续步骤标签。
 * 当工作流未显式配置连线（`Edges` 为空）时，按节点列表顺序取相邻前后节点。
 *
 * @param {Object} wf - 工作流定义对象（`WorkflowDefinition`）。
 * @param {number} index - 目标节点在 `wf.Nodes` 中的下标。
 * @returns {[string[], string[]]} 二元数组 `[upstream, downstream]`，分别为上游与下游节点标签列表。
 */
function approvalNeighbors(wf, index) {
  const nodeID = wf.Nodes[index].ID;
  let upstream = [];
  let downstream = [];
  for (const edge of wf.Edges) {
    if (edge.Target === nodeID && edge.Source !== "") {
      upstream.push(approvalNodeLabel(wf, edge.Source));
    }
    if (edge.Source === nodeID && edge.Target !== "") {
      downstream.push(approvalNodeLabel(wf, edge.Target));
    }
  }
  if (wf.Edges.length === 0) {
    if (index > 0) {
      upstream = [approvalNodeLabel(wf, wf.Nodes[index - 1].ID)];
    }
    if (index + 1 < wf.Nodes.length) {
      downstream = [approvalNodeLabel(wf, wf.Nodes[index + 1].ID)];
    }
  }
  return [upstream, downstream];
}

/**
 * 获取用书名号包裹的节点展示名称。
 * 当节点未命名或快照中找不到该节点时，回退使用节点 ID。
 *
 * @param {Object} wf - 工作流定义对象（`WorkflowDefinition`）。
 * @param {string} id - 待查找的节点 ID。
 * @returns {string} 形如 `「节点名」` 或 `「节点ID」` 的展示标签。
 */
function approvalNodeLabel(wf, id) {
  for (const n of wf.Nodes) {
    if (n.ID === id) {
      if (n.Name.trim() !== "") {
        return "「" + n.Name + "」";
      }
      break;
    }
  }
  return "「" + id + "」";
}

/**
 * 格式化等待原因开头所用的工作流名称。
 * 当工作流名称为空白时，回退为通用的“该 SOP”。
 *
 * @param {string} name - 工作流名称。
 * @returns {string} 形如 `SOP「名称」` 或 `该 SOP` 的前缀文本。
 */
function approvalSOPLabel(name) {
  name = name.trim();
  if (name !== "") {
    return "SOP「" + name + "」";
  }
  return "该 SOP";
}

module.exports = { ApprovalWaitReason, approvalNeighbors, approvalNodeLabel, approvalSOPLabel };
