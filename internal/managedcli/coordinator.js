// coordinator.js —— 对应 Go 文件：internal/managedcli/coordinator.go
// 作用：用文件锁协调认领与维护：维护先关入口再排空认领，更新只串行化自身。
// Go 的 *os.File 译为带 fd/name/close 的锁文件对象；sync.Mutex 在单线程 JS 里不需要；
// context.Context 译为 AbortSignal；(值, error) 译为成功返回值、失败 throw。

"use strict";

const path = require("node:path");

const { prepareDirectory } = require("./manifest.js"); // 对应 Go 同包函数，manifest.js 已翻译

// Go 用 //go:build 按平台二选一；JS 在加载时按 process.platform 选一次。
const { openCoordinatorLock, tryCoordinatorLock } =
  process.platform === "linux" || process.platform === "darwin"
    ? require("./coordinator_unix.js")
    : require("./coordinator_unsupported.js");

const maintenanceIntentLockName = "maintenance-intent.lock";
const usageLockName = "usage.lock";
const lockPollInterval = 25;

// ClaimLease holds usage across the entire HTTP claim, inventory pin, task and
// completion report. Close only after all of them finish (including no-work
// responses). Lock files are permanent; process exit also releases flock.
class ClaimLease {
  constructor(init = {}) {
    this.intent = init.intent ?? null; // Only maintenance retains intent after acquisition.
    this.usage = init.usage ?? null;
  }

  // Close is idempotent and nil-safe. Release intent last, after publication.
  async Close() {
    const errs = [];
    for (const key of ["usage", "intent"]) {
      try {
        closeLock(this, key);
      } catch (err) {
        errs.push(err);
      }
    }
    if (errs.length > 0) {
      throw new Error(errs.map((e) => e.message).join(": ")); // Go：errors.Join
    }
  }
}

async function BeginClaim(ctx, root) {
  return acquireLease(ctx, root, false);
}

function closeLock(lease, key) {
  // Go 的 closeLock(file **os.File) 用指针回写 nil；JS 用对象字段名对应。
  const file = lease[key];
  if (file == null) {
    return;
  }
  file.close();
  lease[key] = null;
}

// WithMaintenance closes the entry turnstile (intent EX), then drains existing
// claims/tasks (usage EX). New long polls cannot starve this writer. Cancellation
// never releases locks while fn is running; fn must honor its own context.
async function WithMaintenance(ctx, root, fn) {
  const lease = await acquireLease(ctx, root, true);
  try {
    return await fn();
  } finally {
    await lease.Close();
  }
}

// WithUpdateLock serializes complete updates without blocking claims. Its
// callback may take maintenance only when publishing Current.
async function WithUpdateLock(ctx, root, fn) {
  const file = await lock(ctx, root, "updater.lock", true);
  try {
    return await fn();
  } finally {
    file.close();
  }
}

async function acquireLease(ctx, root, exclusive) {
  const intent = await lock(ctx, root, maintenanceIntentLockName, exclusive);
  const lease = new ClaimLease({ intent });
  let err = null;
  try {
    lease.usage = await lock(ctx, root, usageLockName, exclusive);
    if (!exclusive) {
      // Never retain shared intent across HTTP long polls: exclusive intent
      // must be able to stop new readers while current claims finish.
      closeLock(lease, "intent");
    }
  } catch (e) {
    err = e;
  }
  if (err != null) {
    await lease.Close();
    throw err;
  }
  return lease;
}

async function lock(ctx, root, name, exclusive) {
  if (ctx instanceof AbortSignal && ctx.aborted) {
    throw ctx.reason; // Go：ctx.Err()
  }
  prepareDirectory(root, "");
  const file = openCoordinatorLock(root, name);
  try {
    await waitForLock(ctx, file, exclusive);
  } catch (err) {
    file.close();
    throw err;
  }
  return file;
}

async function waitForLock(ctx, file, exclusive) {
  for (;;) {
    if (ctx instanceof AbortSignal && ctx.aborted) {
      throw ctx.reason; // Go：ctx.Err()
    }
    let locked;
    try {
      locked = tryCoordinatorLock(file, exclusive);
    } catch (err) {
      throw new Error(`lock managed CLI ${path.basename(file.name)}: ${err.message}`);
    }
    if (locked) {
      if (ctx instanceof AbortSignal && ctx.aborted) {
        throw ctx.reason; // Go：return ctx.Err()
      }
      return;
    }
    await sleepOrAbort(ctx, lockPollInterval);
  }
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
