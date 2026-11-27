/**
 * @file internal/engine/run_state.js
 * 对应 Go 源文件：internal/engine/run_state.go
 *
 * 作用与职责边界：
 * 实现引擎的运行状态写路径与实时快照订阅推送机制，包括带租约校验的状态更新（普通更新、
 * 需感知失败的更新与结算期允许过期租约的更新）、合并待刷观测事件后落库、SSE/实时快照订阅通道管理、
 * 修订号轮询检测以及后台中断运行认领循环。
 *
 * 语法差异说明：
 * - `Engine` 定义于 `engine.js`，本文件通过 `Engine.prototype` 挂载各状态写入与订阅方法。
 * - Go 的 `context.Context` 译为 `AbortSignal`；`goroutine` 译为不 `await` 的异步调用；
 *   单线程 JS 不需要 `sync.Mutex`，相关加解锁语句直接略去。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；
 *   `(值1, 值2, error)` 成功返回 `[值1, 值2]`、失败 `throw err`；`(值, bool)` 译为 `[值, boolean]`。
 * - Go 的带缓冲 `chan domain.Run` 译为 `runChannel` 类（容量满时丢弃最旧快照以防阻塞执行 worker）；
 *   `map[chan domain.Run]struct{}` 存储非字符串的订阅通道对象引用，因此在 JS 中以 `Set` 表达。
 * - Go 的 `log.Printf` 译为 `console.log`。
 */

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { isLiveStatus } = require("./workspace_cleanup.js"); // 对应 Go 同包函数，workspace_cleanup.js 已翻译

/**
 * 读取最新运行状态、应用待刷观测事件与变更回调并持久化，忽略写入错误与跳过结果。
 * 适用于常规执行过程中的状态推进与事件追加。
 *
 * @param {string} id - 运行唯一标识。
 * @param {function(import("../domain/run.js").Run): void|null} mutate - 修改运行对象的回调函数，可为 `null`。
 * @returns {void} 无返回值。
 */
Engine.prototype.updateRun = function (id, mutate) {
  this.updateRunAt(id, false, mutate);
};

/**
 * `updateRun` 的需感知写入失败版本，当持久化被拒绝时向调用方抛出错误。
 * 适用于必须确认写入落库的场景，例如 SOP 节点产物交接写回。
 *
 * @param {string} id - 运行唯一标识。
 * @param {function(import("../domain/run.js").Run): void|null} mutate - 修改运行对象的回调函数，可为 `null`。
 * @returns {void} 无返回值。
 * @throws {Error} 仓储持久化写入失败时抛出错误。
 */
Engine.prototype.updateRunErr = function (id, mutate) {
  this.updateRunAtErr(id, false, mutate);
};

/**
 * 结算期的运行状态更新，允许在租约已过期时继续写入终态。
 * 用于运行收尾、孤儿结算与暂停落盘。
 *
 * @param {string} id - 运行唯一标识。
 * @param {function(import("../domain/run.js").Run): void|null} mutate - 修改运行对象的回调函数，可为 `null`。
 * @returns {boolean} 运行状态成功更新（或无需变更）返回 `true`，被跳过或写库失败返回 `false`。
 */
Engine.prototype.updateRunSettling = function (id, mutate) {
  return this.updateRunAt(id, true, mutate);
};

/**
 * 带可选过期租约放行标志的状态更新辅助方法，吞掉写入错误并返回是否更新成功。
 *
 * @param {string} id - 运行唯一标识。
 * @param {boolean} allowExpiredLease - 为 `true` 时允许在租约过期后仍写入。
 * @param {function(import("../domain/run.js").Run): void|null} mutate - 修改运行对象的回调函数，可为 `null`。
 * @returns {boolean} 成功更新返回 `true`；运行不存在、租约归属他处或写库失败返回 `false`。
 */
Engine.prototype.updateRunAt = function (id, allowExpiredLease, mutate) {
  try {
    return this.updateRunAtErr(id, allowExpiredLease, mutate);
  } catch {
    return false;
  }
};

/**
 * 核心运行状态写入路径：校验运行存在性与租约归属，合并缓冲观测事件、执行 `mutate` 并落库，随后推送最新流视图。
 * 运行不存在或租约由其他实例持有时静默跳过并返回 `false`（不算错误）；仅仓储拒绝写入时才抛出错误。
 *
 * @param {string} id - 运行唯一标识。
 * @param {boolean} allowExpiredLease - 为 `true` 时跳过租约过期拦截。
 * @param {function(import("../domain/run.js").Run): void|null} mutate - 修改运行对象的回调函数，可为 `null`。
 * @returns {boolean} 状态已写入或无变更需求返回 `true`；因运行缺失或租约不归属当前实例而跳过时返回 `false`。
 * @throws {Error} `repo.PutRun` 持久化失败时记录日志并抛出该错误。
 */
Engine.prototype.updateRunAtErr = function (id, allowExpiredLease, mutate) {
  const [r, ok] = this.repo.RunState(id);
  if (!ok) {
    this.takePendingObservations(id);
    return false;
  }
  if (isLiveStatus(r.Status) && r.OwnerInstanceID !== "" && !this.ownsRun(r) && !allowExpiredLease) {
    this.takePendingObservations(id);
    return false;
  }
  const pending = this.takePendingObservations(id);
  if (mutate == null && pending.length === 0) {
    return true;
  }
  for (const item of pending) {
    this.applyObservation(r, item.nodeID, item.event);
  }
  if (mutate != null) {
    mutate(r);
  }
  try {
    this.repo.PutRun(r);
  } catch (err) {
    console.log(`put run ${id}: ${err}`);
    throw err;
  }
  const [current, currentOk] = this.repo.RunStreamView(id);
  if (currentOk) {
    this.publishRun(current);
  }
  return true;
};

/**
 * 订阅指定运行的实时快照流，提供与执行提供方无关的运行状态更新。
 * 慢客户端只会收到最新快照而不会阻塞执行 worker；返回的取消函数用于停止后台轮询并释放通道资源。
 *
 * @param {string} runID - 待订阅的运行唯一标识。
 * @returns {[runChannel, function(): void]} 成功时返回 `[快照接收通道, 取消订阅函数]` 二元组。
 * @throws {Error} 目标运行不存在时抛出错误。
 */
Engine.prototype.Subscribe = function (runID) {
  const [current, ok] = this.repo.RunStreamView(runID);
  if (!ok) {
    throw new Error("run not found");
  }
  const ch = new runChannel(1);
  if (this.subs[runID] == null) {
    // 对应 Go 的 map[chan domain.Run]struct{}：元素为非字符串的 runChannel 对象，使用 Set 存储。
    this.subs[runID] = new Set();
  }
  this.subs[runID].add(ch);
  ch.send(current);
  const stopController = new AbortController();
  this.pollRun(runID, stopController.signal, current.Revision);
  const cancel = () => {
    if (!stopController.signal.aborted) {
      stopController.abort();
    }
    if (this.subs[runID] != null && this.subs[runID].has(ch)) {
      this.subs[runID].delete(ch);
      ch.close();
    }
    if (this.subs[runID] != null && this.subs[runID].size === 0) {
      delete this.subs[runID];
    }
  };
  return [ch, cancel];
};

/**
 * 按 500 毫秒周期轮询指定运行的修订号，当跨进程写入导致修订号变化时读取流视图并推送给订阅者。
 * 收到 `stop` 信号或运行被删除时退出循环。
 *
 * @param {string} runID - 运行唯一标识。
 * @param {AbortSignal} stop - 取消订阅时触发的停止信号。
 * @param {number} revision - 订阅初始化时已推送的最新修订号。
 * @returns {Promise<void>} 轮询停止时结束，无返回值。
 */
Engine.prototype.pollRun = async function (runID, stop, revision) {
  for (;;) {
    try {
      await sleepOrAbort(stop, 500);
    } catch {
      return;
    }
    const [latestRevision, ok] = this.repo.RunRevision(runID);
    if (!ok) {
      return;
    }
    if (latestRevision === revision) {
      continue;
    }
    const [current, currentOk] = this.repo.RunStreamView(runID);
    if (!currentOk) {
      return;
    }
    if (current.Revision === revision) {
      continue;
    }
    revision = current.Revision;
    this.publishRun(current);
  }
};

/**
 * 启动后台周期性认领循环：先立即执行一次中断运行恢复，随后每 2 秒扫描并接管过期或待恢复运行。
 * 当 `ctx` 取消或引擎停止执行（进入排空）时退出循环。
 *
 * @param {AbortSignal|null} ctx - 控制循环生命周期的取消信号；为 `null` 时等价于永不取消的背景上下文。
 * @returns {void} 无返回值。
 */
Engine.prototype.StartClaimLoop = function (ctx) {
  // Go 的 context.Background() 无 JS 对应写法，nil ctx 传 null。
  (async () => {
    this.ResumeInterruptedRuns();
    for (;;) {
      try {
        await sleepOrAbort(ctx, 2000);
      } catch {
        return;
      }
      if (!this.executes()) {
        return;
      }
      const resumed = this.ResumeInterruptedRuns() ?? [];
      if (resumed.length > 0) {
        console.log(`claimed ${resumed.length} run(s): ${resumed}`);
      }
    }
  })();
};

/**
 * 从仓储读取指定运行的最新状态并广播给当前所有订阅通道。
 *
 * @param {string} runID - 运行唯一标识。
 * @returns {void} 无返回值。
 */
Engine.prototype.publish = function (runID) {
  const [current, ok] = this.repo.RunState(runID);
  if (!ok) {
    return;
  }
  this.publishRun(current);
};

/**
 * 将给定的运行快照非阻塞推送给该运行下的全部订阅通道。
 *
 * @param {import("../domain/run.js").Run} current - 待广播的运行快照对象。
 * @returns {void} 无返回值。
 */
Engine.prototype.publishRun = function (current) {
  for (const ch of this.subs[current.ID] ?? []) {
    ch.send(current);
  }
};

/**
 * Go 带缓冲 `chan domain.Run` 的单线程 JS 等价实现。
 * 当缓冲区已满时丢弃最旧快照再入队新快照，对应 `publishRun` 中的非阻塞覆写发送语义。
 */
class runChannel {
  /**
   * 构造指定容量的运行快照通道。
   *
   * @param {number} capacity - 缓冲区最大容量。
   * @returns {void} 无返回值。
   */
  constructor(capacity) {
    this.capacity = capacity;
    this.values = [];
    this.waiters = [];
    this.closed = false;
  }

  /**
   * 向通道非阻塞投递一条运行快照；若存在等待中的接收方则直接唤醒，若缓冲已满则丢弃最旧值后追加。
   *
   * @param {import("../domain/run.js").Run} value - 待投递的运行快照。
   * @returns {void} 无返回值。
   */
  send(value) {
    if (this.closed) {
      return;
    }
    if (this.waiters.length > 0) {
      this.waiters.shift()(value);
      return;
    }
    if (this.values.length >= this.capacity) {
      this.values.shift();
    }
    this.values.push(value);
  }

  /**
   * 异步读取通道中的下一条运行快照；通道已关闭且缓冲为空时返回 `null`。
   *
   * @returns {Promise<import("../domain/run.js").Run|null>} 下一条运行快照，或关闭后返回 `null`。
   */
  receive() {
    if (this.values.length > 0) {
      return Promise.resolve(this.values.shift());
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * 关闭通道并唤醒所有仍在等待的接收方（以 `null` 结束）。
   *
   * @returns {void} 无返回值。
   */
  close() {
    this.closed = true;
    for (const resolve of this.waiters.splice(0)) {
      resolve(null);
    }
  }
}

/**
 * 等待指定毫秒数或直到取消信号触发，对应 Go 的 `time.NewTicker` 搭配 `select <-ctx.Done()`。
 *
 * @param {AbortSignal|null} ctx - 可选取消信号；为 `null` 时仅按毫秒数等待。
 * @param {number} ms - 等待时长（毫秒）。
 * @returns {Promise<void>} 正常到时后兑现，无返回值。
 * @throws {Error} 等待期间 `ctx` 中止时拒绝并抛出 `ctx.reason`。
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

module.exports = { runChannel };
