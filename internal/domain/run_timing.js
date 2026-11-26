/**
 * @file internal/domain/run_timing.js
 * @description 对应 Go 源文件：internal/domain/run_timing.go
 * 职责边界：依据运行事件日志与节点起止时间，计算运行的实际节点执行耗时、墙钟总耗时、等待耗时以及合并后的非重叠执行区间。
 * 语法差异说明：
 * - Go 的 `time.Time` 对应 JS 的 `Date | null`（零值为 `null`）；`time.Duration` 对应毫秒数（`number`）。
 * - Go 的 `map[string]time.Time`（进行中的节点启动时刻表 `open`）与 `map[string]bool` 均使用普通对象 `{}`。
 * - Go 的多返回值 `(RunTiming, []RunExecutionInterval, bool)` 等译为对应长度的数组元组。
 */

"use strict";

const { TerminalRunStatus } = require("./run_eval.js");

/**
 * 运行耗时拆分汇总结构。
 * 将运行实际执行节点的并集时长与自创建起的墙钟时长（含失败、暂停、停放及人工审批等待）分离展示。
 */
class RunTiming {
  /**
   * 构造运行耗时汇总实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {number} [init.ExecutionMs=0] - 全部尝试节点执行区间的并集耗时（毫秒；重试计入、并行不重复计）。
   * @param {number} [init.WallMs=0] - 从运行创建到终态事件（未结束时到 `AsOf`）的墙钟耗时（毫秒）。
   * @param {number} [init.WaitingMs=0] - 墙钟耗时减去实际执行耗时得到的等待耗时（毫秒）。
   * @param {boolean} [init.Executing=false] - 在 `AsOf` 时刻是否仍有节点在执行，供前端在刷新间隙本地推进计时。
   * @param {Date|null} [init.AsOf=null] - 本次计时快照的参考时间点。
   */
  constructor(init = {}) {
    // ExecutionMs 是全部尝试的节点执行区间的并集，重试计入，并行节点不重复计。
    this.ExecutionMs = init.ExecutionMs ?? 0;
    // WallMs 从创建跑到终态运行事件，运行未结束时跑到 AsOf。
    this.WallMs = init.WallMs ?? 0;
    this.WaitingMs = init.WaitingMs ?? 0;
    // Executing 报告 AsOf 时有节点在运行，客户端可在两次刷新之间本地继续推进 ExecutionMs。
    this.Executing = init.Executing ?? false;
    this.AsOf = init.AsOf ?? null;
  }
}

// `ComputeRunTiming` 消费的事件类型清单；仅用于计时的查询可据此过滤事件日志。
const RunTimingEventTypes = [
  "node.started", "node.succeeded", "node.failed", "node.paused", "node.cancelled",
  "node.interrupted", "node.passed", "gate.waiting", "gate.auto_approved",
  "run.parked", "run.paused", "run.failed", "run.cancelled", "run.succeeded",
];

const nodeIntervalClosers = {
  "node.succeeded": true, "node.failed": true, "node.paused": true, "node.cancelled": true,
  "node.interrupted": true, "node.passed": true, "gate.waiting": true, "gate.auto_approved": true,
};

const runIntervalClosers = {
  "run.parked": true, "run.paused": true, "run.failed": true, "run.cancelled": true, "run.succeeded": true,
};

const runTerminalEvents = { "run.failed": true, "run.cancelled": true, "run.succeeded": true };

/**
 * 根据运行事件日志推导运行耗时汇总（执行耗时、墙钟耗时、等待耗时及活跃标志）。
 * 由于节点行仅保留最新一次尝试且审批等待会拉长 `FinishedAt`，事件日志是覆盖全部尝试的唯一准确来源；无 `node.started` 事件时自动回退到节点行。
 *
 * @param {object} run - 运行实例（Run）。
 * @param {object[]} events - 运行事件列表（RunEvent[]）。
 * @param {Date} now - 当前计算基准时间。
 * @returns {RunTiming} 计算得到的运行耗时汇总对象。
 */
function ComputeRunTiming(run, events, now) {
  const [timing] = computeRunTiming(run, events, now);
  return timing;
}

/**
 * 一段观测到的节点执行起止时间区间（不含等待期）。
 */
class RunExecutionInterval {
  /**
   * 构造执行区间实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {Date|null} [init.StartedAt=null] - 区间开始时间。
   * @param {Date|null} [init.FinishedAt=null] - 区间结束时间。
   */
  constructor(init = {}) {
    this.StartedAt = init.StartedAt ?? null;
    this.FinishedAt = init.FinishedAt ?? null;
  }
}

/**
 * 提取合并后的运行节点执行时间区间列表，并与 `ComputeRunTiming` 共享同一套计算逻辑。
 * 返回的布尔值用于区分“观测到零执行时长”和“缺失计时证据”。
 *
 * @param {object} run - 运行实例（Run）。
 * @param {object[]} events - 运行事件列表（RunEvent[]）。
 * @param {Date} now - 当前计算基准时间。
 * @returns {[RunExecutionInterval[], boolean]} 二元组 `[合并后的执行区间数组, 是否存在有效计时证据]`。
 */
function RunExecutionIntervals(run, events, now) {
  const [, intervals, known] = computeRunTiming(run, events, now);
  return [intervals, known];
}

/**
 * 核心计时计算过程：按事件时间稳定排序，追踪节点执行区间的开启与闭合，必要时回退至节点表，并调用区间裁剪合并。
 *
 * @param {object} run - 运行实例（Run）。
 * @param {object[]|null|undefined} events - 运行事件列表（RunEvent[]）。
 * @param {Date} now - 当前计算基准时间。
 * @returns {[RunTiming, RunExecutionInterval[], boolean]} 三元组 `[运行耗时汇总, 合并后的执行区间数组, 是否存在有效计时证据]`。
 */
function computeRunTiming(run, events, now) {
  let intervals = [];
  let open = {};
  let lastEvent = null;
  let terminalAt = null;
  let started = false;
  const closeNode = (nodeID, at) => {
    if (Object.prototype.hasOwnProperty.call(open, nodeID)) {
      intervals.push({ start: open[nodeID], end: at });
      delete open[nodeID];
    }
  };
  const sorted = [...(events ?? [])];
  sorted.sort((a, b) => (a.Timestamp?.getTime() ?? 0) - (b.Timestamp?.getTime() ?? 0));
  for (const ev of sorted) {
    const at = ev.Timestamp;
    if (at == null) {
      continue;
    }
    lastEvent = at;
    if (ev.Type === "node.started" && ev.NodeID !== "") {
      started = true;
      closeNode(ev.NodeID, at);
      open[ev.NodeID] = at;
    } else if (nodeIntervalClosers[ev.Type] && ev.NodeID !== "") {
      closeNode(ev.NodeID, at);
    } else if (runIntervalClosers[ev.Type]) {
      for (const nodeID of Object.keys(open)) {
        closeNode(nodeID, at);
      }
    }
    if (runTerminalEvents[ev.Type]) {
      terminalAt = at;
    } else if (ev.Type === "node.started") {
      terminalAt = null;
    }
  }

  const out = new RunTiming({ AsOf: now });
  const end = runTimingEnd(run, terminalAt, lastEvent, now);
  if (!started) {
    intervals = [];
    open = {};
    for (const [nodeID, node] of Object.entries(run.Nodes ?? {})) {
      if (node == null || node.StartedAt == null) {
        continue;
      }
      if (node.FinishedAt != null) {
        intervals.push({ start: node.StartedAt, end: node.FinishedAt });
      } else if (node.Status === "running") {
        open[nodeID] = node.StartedAt;
      }
    }
  }
  let openEnd = lastEvent;
  if (run.Status === "running") {
    openEnd = end;
    out.Executing = Object.keys(open).length > 0;
  }
  for (const start of Object.values(open)) {
    if (openEnd != null && openEnd.getTime() > start.getTime()) {
      intervals.push({ start, end: openEnd });
    }
  }

  const [merged, total, known] = mergeExecutionIntervals(intervals, run.CreatedAt, end);
  out.ExecutionMs = total;
  if (run.CreatedAt != null && end.getTime() > run.CreatedAt.getTime()) {
    out.WallMs = end.getTime() - run.CreatedAt.getTime();
  }
  if (out.WallMs < out.ExecutionMs) {
    out.WallMs = out.ExecutionMs;
  }
  out.WaitingMs = out.WallMs - out.ExecutionMs;
  return [out, merged, known];
}

/**
 * 确定运行计时的截止时间点。
 * 运行未处于终态时返回 `now`；已处于终态时按优先级依次取终态事件时间、最后事件时间、运行 `UpdatedAt`，最终回退到 `now`。
 *
 * @param {object} run - 运行实例（Run）。
 * @param {Date|null} terminalAt - 观测到的终态运行事件时间。
 * @param {Date|null} lastEvent - 日志中最后一个有效事件的时间。
 * @param {Date} now - 当前计算基准时间。
 * @returns {Date} 选定的运行计时截止时间。
 */
function runTimingEnd(run, terminalAt, lastEvent, now) {
  if (!TerminalRunStatus(run.Status)) {
    return now;
  }
  for (const at of [terminalAt, lastEvent, run.UpdatedAt]) {
    if (at != null) {
      return at;
    }
  }
  return now;
}

/**
 * 将原始执行区间裁剪到 `[createdAt, end]` 范围内，并对重叠区间求并集，汇总总执行毫秒数。
 * 返回的 `known` 标志用于区分“观测到有效零时长”和“没有任何有效计时观测”。
 *
 * @param {Array.<{start: Date|null, end: Date|null}>} intervals - 原始节点执行区间列表。
 * @param {Date|null} createdAt - 运行创建时间（裁剪下界）。
 * @param {Date} end - 运行计时截止时间（裁剪上界）。
 * @returns {[RunExecutionInterval[], number, boolean]} 三元组 `[合并后的执行区间数组, 总执行毫秒数, 是否有有效计时观测]`。
 */
function mergeExecutionIntervals(intervals, createdAt, end) {
  const clipped = [];
  let known = false;
  for (let iv of intervals) {
    iv = { ...iv };
    if (createdAt != null && iv.start.getTime() < createdAt.getTime()) {
      iv.start = createdAt;
    }
    if (iv.end.getTime() > end.getTime()) {
      iv.end = end;
    }
    if (iv.start != null && iv.end != null && !(iv.end.getTime() < iv.start.getTime())) {
      known = true;
    }
    if (iv.end.getTime() > iv.start.getTime()) {
      clipped.push(iv);
    }
  }
  clipped.sort((a, b) => a.start.getTime() - b.start.getTime());
  let total = 0;
  const merged = [];
  for (let i = 0; i < clipped.length;) {
    const cur = { ...clipped[i] };
    i++;
    while (i < clipped.length && !(clipped[i].start.getTime() > cur.end.getTime())) {
      if (clipped[i].end.getTime() > cur.end.getTime()) {
        cur.end = clipped[i].end;
      }
      i++;
    }
    total += cur.end.getTime() - cur.start.getTime();
    merged.push(new RunExecutionInterval({ StartedAt: cur.start, FinishedAt: cur.end }));
  }
  return [merged, total, known];
}

module.exports = { RunTiming, RunTimingEventTypes, ComputeRunTiming, RunExecutionInterval, RunExecutionIntervals };
