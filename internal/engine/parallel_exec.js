// parallel_exec.js —— 对应 Go 文件：internal/engine/parallel_exec.go
// 作用：并行 SOP 分支的细粒度互斥锁与在途节点执行登记表，支持按节点、按 Agent 调用与按运行池绑定加锁，以及对过期在途执行的协调取消。
// 职责边界：仅负责并行执行阶段的键控锁管理与本实例在途节点取消句柄登记；不负责工作流图调度或节点业务逻辑。
// 语法差异说明：context.CancelFunc 译为无参取消函数；sync.Mutex 与 sync.Once 在单线程 JS 中分别省略和用布尔标志表达；(值, bool) 译为 [值, boolean]；map[string]V 译为普通对象 {}。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译

/**
 * 按字符串键分片的引用计数锁表，对应 Go 的 keyedLocks 结构体。
 * 确保同一键下的并发操作串行化，并在引用计数归零时自动清理条目避免内存泄漏。
 */
class keyedLocks {
  /**
   * 按 Go 结构体零值语义初始化 keyedLocks 实例。
   *
   * @param {Object} [init={}] - 可选初始字段。
   * @param {Object.<string, keyedLock>} [init.locks={}] - 键到锁条目的映射表。
   * @returns {keyedLocks} 初始化后的锁表实例。
   */
  constructor(init = {}) {
    this.locks = init.locks ?? {};
  }

  /**
   * 获取指定 key 的互斥锁并返回幂等的释放函数。
   * 在单线程 JS 中省略阻塞互斥锁，仅保留引用计数与单次释放语义以便与 Go 结构对照。
   *
   * @param {string} key - 锁分片键。
   * @returns {function(): void} 释放该锁条目的幂等回调函数。
   */
  lock(key) {
    if (this.locks == null) {
      this.locks = {};
    }
    let entry = this.locks[key];
    if (entry == null) {
      entry = new keyedLock();
      this.locks[key] = entry;
    }
    entry.refs++;
    // 对应 Go 的 sync.Once，保证重复调用释放函数只递减一次引用计数。
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      entry.refs--;
      if (entry.refs === 0) {
        delete this.locks[key];
      }
    };
  }
}

/**
 * keyedLocks 内部的单个锁条目，对应 Go 的 keyedLock 结构体。
 * 记录当前持有或等待该键的引用计数。
 */
class keyedLock {
  /**
   * 按 Go 结构体零值语义初始化 keyedLock 实例。
   *
   * @param {Object} [init={}] - 可选初始字段。
   * @param {number} [init.refs=0] - 当前引用计数。
   * @returns {keyedLock} 初始化后的锁条目实例。
   */
  constructor(init = {}) {
    this.refs = init.refs ?? 0;
  }
}

/**
 * 对同一 (runID, nodeID) 加节点执行锁，防止恢复、返工或租约接管与尚未退出的旧执行交错。
 * 在 Engine.executeNode 入口处调用。
 *
 * @param {string} runID - 运行 ID。
 * @param {string} nodeID - 节点 ID。
 * @returns {function(): void} 释放节点执行锁的回调函数。
 */
Engine.prototype.lockNodeExec = function (runID, nodeID) {
  return this.execLocks.lock("node\x00" + runID + "\x00" + nodeID);
};

/**
 * 对同一 (workspaceOwner, agentID) 加 Agent 调用锁，使共享同一控制目录的同角色节点轮流调用 CLI。
 * 在 Agent 节点的 runOnce 执行前调用。
 *
 * @param {string} workspaceOwner - 工作区归属运行 ID（父子 SOP 共享同一工作区时为根运行 ID）。
 * @param {string} agentID - 角色 ID。
 * @returns {function(): void} 释放 Agent 调用锁的回调函数。
 */
Engine.prototype.lockAgentInvocation = function (workspaceOwner, agentID) {
  return this.execLocks.lock("agent\x00" + workspaceOwner + "\x00" + agentID);
};

/**
 * 对同一 runID 加云端执行池绑定锁，保证并发启动的首批节点只为该运行选定一台执行机器。
 * 在绑定云端 Runner 池时调用。
 *
 * @param {string} runID - 运行 ID。
 * @returns {function(): void} 释放池绑定锁的回调函数。
 */
Engine.prototype.lockPoolBinding = function (runID) {
  return this.execLocks.lock("pool\x00" + runID);
};

/**
 * 本实例正在执行的一次节点尝试记录，对应 Go 的 nodeExecution 结构体。
 * 持有该次尝试的编号与仅作用于该节点的取消函数。
 */
class nodeExecution {
  /**
   * 按 Go 结构体零值语义初始化 nodeExecution 实例。
   *
   * @param {Object} [init={}] - 可选初始字段。
   * @param {number} [init.attempt=0] - 当前节点尝试次数。
   * @param {function(): void|null} [init.cancel=null] - 取消该次节点执行的回调函数。
   * @returns {nodeExecution} 初始化后的节点执行记录实例。
   */
  constructor(init = {}) {
    this.attempt = init.attempt ?? 0;
    this.cancel = init.cancel ?? null;
  }
}

/**
 * 在本实例在途节点表中登记一次已启动的节点尝试，并返回用于退出时反注册的清理函数。
 * 在 Engine.executeNode 将节点状态提交为 running 后调用。
 *
 * @param {string} runID - 运行 ID。
 * @param {string} nodeID - 节点 ID。
 * @param {number} attempt - 本次节点执行的尝试次数。
 * @param {function(): void} cancel - 取消本次节点执行的回调函数。
 * @returns {function(): void} 节点退出时调用的反注册函数（仅在尝试次数匹配时移除记录）。
 */
Engine.prototype.registerNodeExecution = function (runID, nodeID, attempt, cancel) {
  if (this.nodeExecs == null) {
    this.nodeExecs = {};
  }
  if (this.nodeExecs[runID] == null) {
    this.nodeExecs[runID] = {};
  }
  this.nodeExecs[runID][nodeID] = new nodeExecution({ attempt: attempt, cancel: cancel });
  return () => {
    const current = this.nodeExecs[runID] != null ? this.nodeExecs[runID][nodeID] : undefined;
    if (current != null && current.attempt === attempt) {
      delete this.nodeExecs[runID][nodeID];
      if (Object.keys(this.nodeExecs[runID]).length === 0) {
        delete this.nodeExecs[runID];
      }
    }
  };
};

/**
 * 判断持久化存储中的节点状态是否仍属于发起该次执行的尝试（同一次 attempt 且处于运行或待输入态）。
 * 在 reconcileNodeExecutions 检查在途节点是否已过期时调用。
 *
 * @param {Object|null} nr - 持久化节点运行态对象（domain.NodeRun）。
 * @param {number} attempt - 本地登记的尝试次数。
 * @returns {boolean} 仍属于当前在途执行时返回 true，否则返回 false。
 */
function nodeExecutionLive(nr, attempt) {
  return nr != null && nr.Attempt === attempt && (nr.Status === "running" || nr.Status === "pending_input");
}

/**
 * 核对本实例登记的在途节点执行，取消那些已被返工、重试或跨实例控制决策重置的过期执行。
 * 先复制登记表再读取持久化状态，确保复制之后才启动的新节点不会被误判为过期。
 *
 * @param {string} runID - 运行 ID。
 * @returns {void} 无返回值。
 */
Engine.prototype.reconcileNodeExecutions = function (runID) {
  const registered = {};
  if (this.nodeExecs[runID] != null) {
    for (const [nodeID, execution] of Object.entries(this.nodeExecs[runID])) {
      registered[nodeID] = execution;
    }
  }
  if (Object.keys(registered).length === 0) {
    return;
  }
  const [r, ok] = this.repo.RunState(runID);
  if (!ok) {
    return;
  }
  for (const [nodeID, execution] of Object.entries(registered)) {
    if (!nodeExecutionLive(r.Nodes[nodeID], execution.attempt)) {
      execution.cancel();
    }
  }
};

/**
 * 主动取消本实例上指定运行中命中 nodeIDs 集合的在途节点执行。
 * 在返工打回或批量重置运行中节点时调用，以尽快释放节点锁。
 *
 * @param {string} runID - 运行 ID。
 * @param {Object.<string, boolean>} nodeIDs - 需要取消的节点 ID 集合对象。
 * @returns {void} 无返回值。
 */
Engine.prototype.cancelNodeExecutions = function (runID, nodeIDs) {
  const stale = [];
  if (this.nodeExecs[runID] != null) {
    for (const [nodeID, execution] of Object.entries(this.nodeExecs[runID])) {
      if (nodeIDs[nodeID]) {
        stale.push(execution.cancel);
      }
    }
  }
  for (const cancel of stale) {
    cancel();
  }
};

module.exports = { keyedLocks, keyedLock, nodeExecution, nodeExecutionLive };
