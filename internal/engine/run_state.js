// run_state.js —— 对应 Go 文件：internal/engine/run_state.go
// 作用：运行状态写路径与订阅推送：带租约校验的更新、快照订阅与轮询。
// context.Context 译为 AbortSignal；goroutine 译为不 await 的异步函数；sync.Mutex 在单线程 JS 里不需要；(值, error) 译为成功返回值、失败 throw；(值, bool) 译为 [值, bool]；Go channel 译为 runChannel（容量满时丢旧值）；map[chan]struct{} 译为 Set；log.Printf 译为 console.log。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译

Engine.prototype.updateRun = function (id, mutate) {
  this.updateRunAt(id, false, mutate);
};

// updateRunErr：updateRun 的需感知写失败版，如产物交接未落库的 SOP 节点。
Engine.prototype.updateRunErr = function (id, mutate) {
  const [, err] = this.updateRunAtErr(id, false, mutate);
  if (err != null) {
    throw err;
  }
};

Engine.prototype.updateRunSettling = function (id, mutate) {
  return this.updateRunAt(id, true, mutate);
};

Engine.prototype.updateRunAt = function (id, allowExpiredLease, mutate) {
  const [updated] = this.updateRunAtErr(id, allowExpiredLease, mutate);
  return updated;
};

// updateRunAtErr：报告运行是否已落库，store 拒绝写入时报告该错误；跳过的更新（运行不存在或租约在别处）不是错误。
Engine.prototype.updateRunAtErr = function (id, allowExpiredLease, mutate) {
  const [r, ok] = this.repo.RunState(id);
  if (!ok) {
    this.takePendingObservations(id);
    return [false, null];
  }
  if (isLiveStatus(r.Status) && r.OwnerInstanceID !== "" && !this.ownsRun(r) && !allowExpiredLease) {
    this.takePendingObservations(id);
    return [false, null];
  }
  const pending = this.takePendingObservations(id);
  if (mutate == null && pending.length === 0) {
    return [true, null];
  }
  for (const item of pending) {
    this.applyObservation(r, item.nodeID, item.event);
  }
  if (mutate != null) {
    mutate(r);
  }
  const putErr = this.repo.PutRun(r);
  if (putErr != null) {
    console.log(`put run ${id}: ${putErr}`);
    return [false, putErr];
  }
  const [current, currentOk] = this.repo.RunStreamView(id);
  if (currentOk) {
    this.publishRun(current);
  }
  return [true, null];
};

// Subscribe：提供与提供方无关的运行快照直播；慢客户端收到最新状态而不阻塞执行 worker。
Engine.prototype.Subscribe = function (runID) {
  const [current, ok] = this.repo.RunStreamView(runID);
  if (!ok) {
    throw new Error("run not found");
  }
  const ch = new runChannel(1);
  if (this.subs[runID] == null) {
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

Engine.prototype.StartClaimLoop = function (ctx) {
  // Go 的 context.Background() 无 JS 对应写法，nil ctx 传 null。
  this.ResumeInterruptedRuns();
  (async () => {
    for (;;) {
      try {
        await sleepOrAbort(ctx, 2000);
      } catch {
        return;
      }
      if (!this.executes()) {
        return;
      }
      const resumed = this.ResumeInterruptedRuns();
      if (resumed.length > 0) {
        console.log(`claimed ${resumed.length} run(s): ${resumed}`);
      }
    }
  })();
};

Engine.prototype.publish = function (runID) {
  const [current, ok] = this.repo.RunState(runID);
  if (!ok) {
    return;
  }
  this.publishRun(current);
};

Engine.prototype.publishRun = function (current) {
  for (const ch of this.subs[current.ID] ?? []) {
    ch.send(current);
  }
};

// runChannel：Go 带缓冲 channel 的 JS 对应物；send 满时丢弃最旧值再入队，对应 publishRun 的非阻塞发送。
class runChannel {
  constructor(capacity) {
    this.capacity = capacity;
    this.values = [];
    this.waiters = [];
    this.closed = false;
  }

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

  close() {
    this.closed = true;
    for (const resolve of this.waiters.splice(0)) {
      resolve(null);
    }
  }
}

// sleepOrAbort：等满毫秒或等到 ctx 取消，对应 Go 的 time.NewTicker + select。
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
