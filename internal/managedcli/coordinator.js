/**
 * @file internal/managedcli/coordinator.js
 * @description 对应 Go 文件：internal/managedcli/coordinator.go。
 * 作用与职责边界：基于跨进程文件锁协调托管 CLI 的任务认领、版本维护与更新串行化：
 * 维护流程先关闭入口闸门（`maintenance-intent.lock` 排他锁）再排空现有认领（`usage.lock` 排他锁），
 * 完整更新流程仅通过 `updater.lock` 彼此串行化而不阻塞任务认领。
 * 语法差异说明：
 * - `*os.File` 译为包含 `{ fd, name, close }` 的锁文件对象；
 * - 单线程 JS 不需要 `sync.Mutex`，故省略结构体内的互斥锁字段；
 * - `context.Context` 译为 `AbortSignal`；
 * - 锁轮询中的 `time.NewTimer` + `select` 译为 `Promise` + `setTimeout` + `AbortSignal` 监听；
 * - `(值, error)` 译为成功返回值、失败抛出 `Error`；仅 `error` 译为成功返回 `undefined`、失败抛出 `Error`。
 */

"use strict";

const path = require("node:path");

const { prepareDirectory } = require("./manifest.js"); // 对应 Go 同包函数，manifest.js 已翻译

// Go 用 //go:build 按平台二选一；JS 在加载时按 process.platform 选择对应实现。
const { openCoordinatorLock, tryCoordinatorLock } =
  process.platform === "linux" || process.platform === "darwin"
    ? require("./coordinator_unix.js")
    : require("./coordinator_unsupported.js");

const maintenanceIntentLockName = "maintenance-intent.lock";
const usageLockName = "usage.lock";
const lockPollInterval = 25;

/**
 * 托管 CLI 认领与维护租约对象，持有底层的入口锁与使用锁文件句柄。
 * 使用场景：由 `BeginClaim`（共享使用锁）或 `WithMaintenance`（排他入口锁与使用锁）创建，
 * 在整个 HTTP 认领、清单固定、任务执行与结果上报期间保持持有，结束后调用 `Close` 释放。
 */
class ClaimLease {
  /**
   * 构造 `ClaimLease` 实例，按 Go 零值规则初始化锁文件句柄字段。
   * 使用场景：由 `acquireLease` 内部构造，也可在测试中传入初始字段。
   *
   * @param {{ intent?: { fd: number, name: string, close: () => void }|null, usage?: { fd: number, name: string, close: () => void }|null }} [init={}] 初始字段对象。
   */
  constructor(init = {}) {
    const src = init ?? {};
    this.intent = src.intent ?? null; // 仅维护模式在获锁后继续持有 intent 锁。
    this.usage = src.usage ?? null;
  }

  /**
   * 幂等地释放租约持有的文件锁，先释放 `usage` 锁，最后释放 `intent` 锁。
   * 使用场景：任务认领结束或维护回调完成后的清理阶段调用。
   *
   * @returns {void} 无返回值；任一锁句柄关闭失败时汇总抛出错误（对应 Go 的 `errors.Join`）。
   */
  Close() {
    const errs = [];
    for (const key of ["usage", "intent"]) {
      try {
        closeLock(this, key);
      } catch (err) {
        errs.push(err);
      }
    }
    if (errs.length > 0) {
      throw new Error(errs.map((e) => e.message).join("\n")); // Go：errors.Join
    }
  }
}

/**
 * 获取任务认领租约（共享模式），防止在任务执行期间发布新版本导致状态不一致。
 * 使用场景：Worker 发起任务认领请求前调用，并在认领及任务全部完成后调用返回租约的 `Close`。
 *
 * @param {AbortSignal|null|undefined} ctx 取消信号，用于中断等待锁的过程。
 * @param {string} root 托管 CLI 根目录绝对路径。
 * @returns {Promise<ClaimLease>} 已获取使用锁的租约实例；获取失败或取消时抛出错误。
 */
async function BeginClaim(ctx, root) {
  return acquireLease(ctx, root, false);
}

/**
 * 关闭租约上的单个锁文件句柄并将对应字段置空，保证幂等。
 * 使用场景：供 `ClaimLease.prototype.Close` 与 `acquireLease` 在释放单个锁句柄时调用。
 *
 * @param {ClaimLease} lease 持有锁句柄的租约对象（对应 Go 的 `**os.File` 指针回写）。
 * @param {"usage"|"intent"} key 要关闭并置空的句柄字段名。
 * @returns {void} 无返回值；底层关闭失败时抛出错误，但字段仍会被置为 `null`。
 */
function closeLock(lease, key) {
  // Go 的 closeLock(file **os.File) 无论关闭是否出错都会把指针置 nil；JS 先清字段再关闭以保持一致。
  const file = lease[key];
  if (file == null) {
    return;
  }
  lease[key] = null;
  file.close();
}

/**
 * 在排他维护锁保护下执行回调：先获取入口排他锁阻断新认领，再等待现有认领排空后获取使用排他锁。
 * 使用场景：更新器发布或回滚 `Current` 清单时调用，确保没有并发任务正在认领或读取切换中的状态。
 *
 * @param {AbortSignal|null|undefined} ctx 取消信号，仅用于中断等待锁；回调开始执行后不会因取消提前释放锁。
 * @param {string} root 托管 CLI 根目录绝对路径。
 * @param {() => (void|Promise<void>)} fn 获锁后执行的维护回调函数。
 * @returns {Promise<void>} 无返回值；获锁失败或回调失败时抛出错误。
 */
async function WithMaintenance(ctx, root, fn) {
  const lease = await acquireLease(ctx, root, true);
  try {
    return await fn();
  } finally {
    try {
      lease.Close();
    } catch {
      // 对应 Go 的 defer lease.Close()，忽略释放锁时的错误以免覆盖回调错误。
    }
  }
}

/**
 * 在 `updater.lock` 排他锁保护下串行执行完整更新或回滚流程，不阻塞外部任务认领。
 * 使用场景：由 `Manager.prototype.run` 调用，保证同一根目录下同一时间只有一个更新/回滚流程在运行。
 *
 * @param {AbortSignal|null|undefined} ctx 取消信号，用于中断等待更新锁。
 * @param {string} root 托管 CLI 根目录绝对路径。
 * @param {() => (void|Promise<void>)} fn 获锁后执行的更新回调函数。
 * @returns {Promise<void>} 无返回值；获锁失败或回调失败时抛出错误。
 */
async function WithUpdateLock(ctx, root, fn) {
  const file = await lock(ctx, root, "updater.lock", true);
  try {
    return await fn();
  } finally {
    try {
      file.close();
    } catch {
      // 对应 Go 的 defer file.Close()，忽略关闭错误以免覆盖回调错误。
    }
  }
}

/**
 * 依次获取入口锁与使用锁并组装为 `ClaimLease`；共享模式下获取使用锁后会立即释放入口锁。
 * 使用场景：由 `BeginClaim`（`exclusive=false`）和 `WithMaintenance`（`exclusive=true`）内部调用。
 *
 * @param {AbortSignal|null|undefined} ctx 取消信号。
 * @param {string} root 托管 CLI 根目录绝对路径。
 * @param {boolean} exclusive 是否以排他模式加锁（`true` 为维护模式，`false` 为认领模式）。
 * @returns {Promise<ClaimLease>} 成功获取的租约对象；任一步骤失败时释放已获锁并抛出错误。
 */
async function acquireLease(ctx, root, exclusive) {
  const intent = await lock(ctx, root, maintenanceIntentLockName, exclusive);
  const lease = new ClaimLease({ intent });
  let err = null;
  try {
    lease.usage = await lock(ctx, root, usageLockName, exclusive);
    if (!exclusive) {
      // 不在 HTTP 长轮询期间持有共享入口锁，保证维护方可以通过排他入口锁阻断新读者。
      closeLock(lease, "intent");
    }
  } catch (e) {
    err = e;
  }
  if (err != null) {
    try {
      lease.Close();
    } catch {
      // 对应 Go 的 lease.Close() 忽略清理错误，抛出原始获锁错误。
    }
    throw err;
  }
  return lease;
}

/**
 * 校验并准备根目录、打开指定锁文件并等待获取对应的共享或排他文件锁。
 * 使用场景：由 `WithUpdateLock` 与 `acquireLease` 内部调用。
 *
 * @param {AbortSignal|null|undefined} ctx 取消信号。
 * @param {string} root 托管 CLI 根目录绝对路径。
 * @param {string} name 锁文件名（例如 `updater.lock`、`usage.lock`）。
 * @param {boolean} exclusive 是否获取排他锁。
 * @returns {Promise<{ fd: number, name: string, close: () => void }>} 已加锁的文件句柄对象；失败或取消时抛出错误。
 */
async function lock(ctx, root, name, exclusive) {
  if (ctx instanceof AbortSignal && ctx.aborted) {
    throw ctx.reason; // Go：ctx.Err()
  }
  prepareDirectory(root, "");
  const file = openCoordinatorLock(root, name);
  try {
    await waitForLock(ctx, file, exclusive);
  } catch (err) {
    try {
      file.close();
    } catch {
      // 忽略关闭错误，保留原始加锁错误。
    }
    throw err;
  }
  return file;
}

/**
 * 以固定间隔轮询尝试非阻塞加锁，直至加锁成功、发生不可恢复错误或上下文取消。
 * 使用场景：由 `lock` 在打开锁文件后调用。
 *
 * @param {AbortSignal|null|undefined} ctx 取消信号。
 * @param {{ fd: number, name: string, close: () => void }} file 已打开的锁文件句柄对象。
 * @param {boolean} exclusive 是否尝试排他锁。
 * @returns {Promise<void>} 无返回值；加锁成功时返回，出错或取消时抛出错误。
 */
async function waitForLock(ctx, file, exclusive) {
  for (;;) {
    if (ctx instanceof AbortSignal && ctx.aborted) {
      throw ctx.reason; // Go：ctx.Err()
    }
    let locked;
    try {
      locked = tryCoordinatorLock(file, exclusive);
    } catch (err) {
      throw new Error(`lock managed CLI ${path.basename(file.name)}: ${err.message}`, { cause: err });
    }
    if (locked) {
      if (ctx instanceof AbortSignal && ctx.aborted) {
        throw ctx.reason; // Go：return ctx.Err()
      }
      return;
    }
    // 对应 Go 的 time.NewTimer(lockPollInterval) + select { case <-ctx.Done(): ... case <-timer.C: }。
    await new Promise((resolve, reject) => {
      if (ctx instanceof AbortSignal && ctx.aborted) {
        reject(ctx.reason);
        return;
      }
      const timer = setTimeout(() => {
        if (ctx instanceof AbortSignal) {
          ctx.removeEventListener("abort", onAbort);
        }
        resolve();
      }, lockPollInterval);
      const onAbort = () => {
        clearTimeout(timer);
        if (ctx instanceof AbortSignal) {
          ctx.removeEventListener("abort", onAbort);
        }
        reject(ctx.reason);
      };
      if (ctx instanceof AbortSignal) {
        ctx.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

module.exports = {
  maintenanceIntentLockName,
  usageLockName,
  lockPollInterval,
  ClaimLease,
  BeginClaim,
  closeLock,
  WithMaintenance,
  WithUpdateLock,
  acquireLease,
  lock,
  waitForLock,
};
