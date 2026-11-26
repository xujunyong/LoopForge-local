// bot_control.js —— 对应 Go 文件：internal/engine/bot_control.go
// 作用：聊天卡片操作与节点状态期望的校验。

"use strict";

// NodeExpectation：聊天卡片操作绑定的节点状态期望。
class NodeExpectation {
  constructor(init = {}) {
    this.NodeID = init.NodeID ?? "";
    this.Status = init.Status ?? "";
    this.Attempt = init.Attempt ?? 0;
    this.ReworkCount = init.ReworkCount ?? 0;
  }
}

function checkNodeExpectation(run, expected) {
  if (expected.length === 0) {
    return;
  }
  const want = expected[0];
  const node = run.Nodes[want.NodeID];
  if (node == null || node.Status !== want.Status || node.Attempt !== want.Attempt || node.ReworkCount !== want.ReworkCount) {
    throw new Error("通知对应的节点状态已变化，请查看最新消息");
  }
}

module.exports = { NodeExpectation, checkNodeExpectation };
