/**
 * @file bot_control.js
 * 对应 Go 源文件：internal/engine/bot_control.go
 * 作用与职责边界：定义聊天卡片交互操作所绑定的节点状态期望结构体，并提供状态一致性校验，
 * 防止用户点击过期通知卡片时误操作已变更的节点。
 * 语法差异说明：
 * - Go 的 `error` 返回值译为校验通过时正常返回 `undefined`，状态不匹配时 `throw Error`。
 */

"use strict";

/**
 * 节点状态期望模型，将聊天卡片上的操作按钮绑定到展示时对应的精确节点尝试与返工次数。
 * 使用场景：机器人回调处理审批、重试等操作前作为乐观并发条件传入。
 */
class NodeExpectation {
  /**
   * 创建节点状态期望实例，并按 Go 零值规则初始化字段。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.NodeID=""] - 目标节点 ID。
   * @param {string} [init.Status=""] - 期望的节点状态。
   * @param {number} [init.Attempt=0] - 期望的节点尝试次数。
   * @param {number} [init.ReworkCount=0] - 期望的节点返工次数。
   */
  constructor(init = {}) {
    this.NodeID = init.NodeID ?? "";
    this.Status = init.Status ?? "";
    this.Attempt = init.Attempt ?? 0;
    this.ReworkCount = init.ReworkCount ?? 0;
  }
}

/**
 * 校验运行实例中的目标节点是否仍与卡片期望状态完全一致。
 * 使用场景：执行来自聊天卡片的节点控制动作前调用，避免过期卡片触发重复或错位操作。
 *
 * @param {object} run - 当前运行实例对象（domain.Run）。
 * @param {NodeExpectation[]} expected - 可选的状态期望列表；为空时跳过校验，非空时仅校验首项。
 * @returns {void} 无返回值。
 * @throws {Error} 目标节点不存在或状态、尝试次数、返工次数任一不一致时抛出中文提示错误。
 */
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
