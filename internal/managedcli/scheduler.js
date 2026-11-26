/**
 * @file internal/managedcli/scheduler.js
 * @description 对应 Go 文件：internal/managedcli/scheduler.go。
 * 作用与职责边界：在后台按北京时间每日 04:00 起 0~600 秒确定性抖动窗口调度托管 CLI 日检，
 * 启动时不阻塞主进程网络访问，提供幂等停止函数用于取消等待并汇合后台循环。
 * 语法差异说明：
 * - `time.FixedZone("Asia/Shanghai", 8*60*60)` 译为固定 +8 小时毫秒偏移 `beijingOffsetMs`；
 * - Go 后台协程译为不 `await` 的异步 IIFE，返回 `done` Promise 供停止函数等待；
 * - `context.Context` 译为 `AbortSignal`，`time.NewTimer` + `select` 译为 `setTimeout` + `AbortSignal` 监听；
 * - `log.Printf` 译为 `console.log`；
 * - 与 `updater.js` 存在同包循环引用，在 `Start` 回调内延迟 `require("./updater.js")`。
 */

"use strict";

const { createHash } = require("node:crypto");

// 固定 UTC+08 偏移量（毫秒），即使运行环境缺少时区数据库也能准确计算北京时间日期。
const beijingOffsetMs = 8 * 60 * 60 * 1000;

/**
 * 启动托管 CLI 每日自动检查后台循环；不阻塞调用方启动，并返回幂等的停止函数。
 * 使用场景：Worker 启动阶段调用，用于在后台定期触发 `Manager.Check`，进程退出时调用返回的 `stop` 函数。
 *
 * @param {AbortSignal|null|undefined} ctx 上级取消信号，触发时中止锁等待、子命令与调度循环。
 * @param {string} root 托管 CLI 根目录绝对路径。
 * @returns {() => Promise<void>} 停止函数：取消后台循环并返回等待循环退出的 Promise，可安全重复或并发调用。
 */
function Start(ctx, root) {
  return start(ctx, () => require("./updater.js").NewManager(root));
}

/**
 * 使用指定管理器工厂函数启动日检调度循环（内部入口，便于测试注入自定义 `Manager`）。
 * 使用场景：由 `Start` 或单元测试调用。
 *
 * @param {AbortSignal|null|undefined} ctx 上级取消信号。
 * @param {() => import("./updater.js").Manager} factory 创建并返回 `Manager` 实例的工厂函数，失败时抛出错误。
 * @returns {() => Promise<void>} 停止函数：触发内部取消信号并返回后台循环的完成 Promise。
 */
function start(ctx, factory) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(ctx.reason);
  if (ctx instanceof AbortSignal) {
    if (ctx.aborted) {
      controller.abort(ctx.reason);
    } else {
      ctx.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  const signal = controller.signal;
  const done = (async () => {
    try {
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
      // 已过今日窗口时立即触发启动补跑；先计算目标时间再等待，避免跨边界漏掉当天。
      let next = scheduledAt(m.Root, m.Now());
      while (!signal.aborted) {
        const waitMs = next.getTime() - m.Now().getTime();
        // 对应 Go 的 time.NewTimer(next.Sub(m.Now())) + select { case <-ctx.Done(): ... case <-timer.C: }。
        const fired = await new Promise((resolve) => {
          if (signal.aborted) {
            resolve(false);
            return;
          }
          if (waitMs <= 0) {
            resolve(true);
            return;
          }
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve(true);
          }, waitMs);
          const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            resolve(false);
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
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
        // 以本次检查完成时间计算下一窗口，耗时较长的更新不会补跑错过的天数。
        next = nextScheduledAt(m.Root, m.Now());
      }
    } finally {
      if (ctx instanceof AbortSignal) {
        ctx.removeEventListener("abort", onParentAbort);
      }
    }
  })();
  return () => {
    controller.abort();
    return done;
  };
}

/**
 * 计算 `now` 所在北京时间当天的日检计划时间：当日 04:00:00 加上按 `root + "\x00" + 日期` 哈希得到的 0~600 秒抖动。
 * 使用场景：由 `start`、`nextScheduledAt` 以及 `updater.js` 判断当前是否已到达今日检查窗口时调用。
 *
 * @param {string} root 托管 CLI 根目录绝对路径，用于分散多台主机的检查时间。
 * @param {Date} now 当前时间点。
 * @returns {Date} 北京时间当日的目标检查时间。
 */
function scheduledAt(root, now) {
  const bj = new Date(now.getTime() + beijingOffsetMs);
  const mm = String(bj.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(bj.getUTCDate()).padStart(2, "0");
  const dateStr = `${bj.getUTCFullYear()}-${mm}-${dd}`;
  const sum = createHash("sha256").update(root + "\x00" + dateStr).digest();
  const jitter = Number(sum.readBigUInt64BE(0) % 601n) * 1000;
  const at = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), 4, 0, 0, 0) - beijingOffsetMs + jitter;
  return new Date(at);
}

/**
 * 计算严格晚于 `now` 的下一次日检时间（含正好落在今日窗口边界时推至次日）。
 * 使用场景：每次日检完成后由 `start` 调用，确定下一轮等待的目标时刻。
 *
 * @param {string} root 托管 CLI 根目录绝对路径。
 * @param {Date} now 当前完成时间点。
 * @returns {Date} 严格大于 `now` 的下一次计划检查时间。
 */
function nextScheduledAt(root, now) {
  let at = scheduledAt(root, now);
  if (!(at > now)) {
    at = scheduledAt(root, new Date(now.getTime() + 24 * 60 * 60 * 1000));
  }
  return at;
}

module.exports = { beijingOffsetMs, Start, start, scheduledAt, nextScheduledAt };
