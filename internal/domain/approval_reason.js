// approval_reason.js —— 对应 Go 文件：internal/domain/approval_reason.go
// 作用：解释审批节点为何让运行停下：确认什么、通过后去哪、打回哪。

"use strict";

// ApprovalWaitReason：说明审批节点停住运行的原因。
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
  // Go strings.Builder 译为字符串拼接。
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

// approvalNeighbors：返回接入与后续步骤的标签；无边时按列表顺序。
// Go 多返回值译为数组。
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

// approvalNodeLabel：引用节点显示名，无名或缺失时回退到 ID。
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

// approvalSOPLabel：命名原因中的工作流，无名时称“该 SOP”。
function approvalSOPLabel(name) {
  name = name.trim();
  if (name !== "") {
    return "SOP「" + name + "」";
  }
  return "该 SOP";
}

module.exports = { ApprovalWaitReason, approvalNeighbors, approvalNodeLabel, approvalSOPLabel };
