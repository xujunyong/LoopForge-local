// scheduler.js —— 对应 Go 文件：internal/managedcli/scheduler.go
// 作用：每天北京时间 04:00 前后抖动 0~600 秒，跑一次托管 CLI 的日检。
// Go 的 time.FixedZone 译为固定 +8 小时的换算；goroutine 译为不 await 的异步函数；
// log.Printf 译为 console.log；context.Context 译为 AbortSignal。

"use strict";

const { createHash } = require("node:crypto");

// 与 updater.js 循环引用：updater.js 在顶层 require 本文件，顶层缓存的模块对象会是
// 加载中的空对象；故调用时现取 require("./updater.js")，不缓存。

// Fixed UTC+08 works even on images without a timezone database.
const beijingOffsetMs = 8 * 60 * 60 * 1000;

// Start never blocks worker startup on network access. The returned stop
// function cancels lock waits/commands and joins the loop; repeated and
// concurrent calls are safe. No configuration or state is polled while idle.
function Start(ctx, root) {
  return start(ctx, () => require("./updater.js").NewManager(root));
}

function start(ctx, factory) {
  const controller = new AbortController();
  if (ctx instanceof AbortSignal) {
    if (ctx.aborted) {
      controller.abort(ctx.reason);
    } else {
      ctx.addEventListener("abort", () => controller.abort(ctx.reason), { once: true });
    }
  }
  const signal = controller.signal;
  const done = (async () => {
    if (signal.aborted) {
      return;
    }
    let m;
    try {
      m = factory();
    } catch (err) {
      console.log(`managed CLI startup: ${err}`);
      return;
    }
    // Past windows fire immediately for startup catch-up. Calculate the
    // target before waiting so crossing the boundary cannot skip today.
    let next = scheduledAt(m.Root, m.Now());
    while (!signal.aborted) {
      const waitMs = next.getTime() - m.Now().getTime();
      const fired = await sleepOrAbort(signal, waitMs);
      if (!fired) {
        return;
      }
      let report;
      let err = null;
      try {
        report = await m.Check(signal);
      } catch (e) {
        err = e;
      }
      if (report != null && report.Action !== "") {
        console.log(`managed CLI daily check: ${JSON.stringify(report.Results)}`);
      }
      if (err != null && !signal.aborted) {
        console.log(`managed CLI check: ${err}; waiting for next daily window`);
      }
      // Compute from completion time: long updates never replay missed days.
      next = nextScheduledAt(m.Root, m.Now());
    }
  })();
  return () => {
    controller.abort();
    return done;
  };
}

// Only today's window is eligible: startup catches up once, never replays a
// backlog. Hashing root and date spreads hosts over the fixed 0..600s window.
function scheduledAt(root, now) {
  const bj = toBeijing(now);
  const sum = createHash("sha256").update(root + "\x00" + formatDate(bj)).digest();
  const jitter = Number(sum.readBigUInt64BE(0) % 601n) * 1000;
  const at = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), 4, 0, 0, 0) - beijingOffsetMs + jitter;
  return new Date(at);
}

// nextScheduledAt is strictly future, including at the exact window boundary.
function nextScheduledAt(root, now) {
  let at = scheduledAt(root, now);
  if (!(at > now)) {
    at = scheduledAt(root, new Date(now.getTime() + 24 * 60 * 60 * 1000));
  }
  return at;
}

// toBeijing：把 Date 平移 +8 小时，使 UTC 取值等于北京时间墙钟。
function toBeijing(date) {
  return new Date(date.getTime() + beijingOffsetMs);
}

// formatDate：Go 的 now.Format("2006-01-02")，入参已是平移后的 Date，用 UTC 取值。
function formatDate(d) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

// sleepOrAbort：等满毫秒返回 true；ctx 先取消返回 false，对应 Go 的 Timer + select。
function sleepOrAbort(signal, ms) {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

module.exports = { beijingOffsetMs, Start, start, scheduledAt, nextScheduledAt };
