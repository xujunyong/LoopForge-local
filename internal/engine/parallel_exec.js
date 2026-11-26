// parallel_exec.js —— 对应 Go 文件：internal/engine/parallel_exec.go
// 作用：并行 SOP 分支的执行锁：按节点、按 Agent 调用、按运行绑定池加锁，登记并协调在途的节点执行。
// context.Context 译为 AbortSignal；context.CancelFunc 译为取消函数；sync.Mutex 在单线程 JS 里不需要；(值, bool) 译为 [值, bool]。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译

// keyedLocks：按 key 加锁的锁表，引用计数，用完的 key 不留锁。
class keyedLocks {
  constructor(init = {}) {
    this.locks = init.locks ?? {};
  }

  // lock：阻塞到 key 空闲后返回释放函数。JS 单线程无需真正阻塞，直接取锁。
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

class keyedLock {
  constructor(init = {}) {
    this.refs = init.refs ?? 0;
  }
}

Engine.prototype.lockNodeExec = function (runID, nodeID) {
  return this.execLocks.lock("node\x00" + runID + "\x00" + nodeID);
};

Engine.prototype.lockAgentInvocation = function (workspaceOwner, agentID) {
  return this.execLocks.lock("agent\x00" + workspaceOwner + "\x00" + agentID);
};

Engine.prototype.lockPoolBinding = function (runID) {
  return this.execLocks.lock("pool\x00" + runID);
};

// nodeExecution：本实例正在跑的一次节点尝试；cancel 只停该节点。
class nodeExecution {
  constructor(init = {}) {
    this.attempt = init.attempt ?? 0;
    this.cancel = init.cancel ?? null;
  }
}

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

// nodeExecutionLive：持久化的节点是否仍属于发起它的那次执行：同一次尝试且仍在途。
function nodeExecutionLive(nr, attempt) {
  return nr != null && nr.Attempt === attempt && (nr.Status === "running" || nr.Status === "pending_input");
}

// reconcileNodeExecutions：取消那些节点已被重置或重开尝试的执行。
// 先复制登记表再读运行状态：在途登记晚于状态提交，复制后才开始的节点不会被误判为过期。
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

// cancelNodeExecutions：停掉本实例正在跑的指定节点的执行。
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
