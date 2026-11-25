// run_timing.js —— 对应 Go 文件：internal/domain/run_timing.go
// 作用：按事件日志计算运行的执行与墙钟耗时。

"use strict";

// RunTiming：把运行真正执行节点的耗时与自创建起的墙钟分开；墙钟还包含运行失败、暂停、停放或等人的人工等待，可能长达数天。
// time.Duration 译为毫秒数；time.Time 译为 Date，零值译为 null。
class RunTiming {
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

// RunTimingEventTypes：ComputeRunTiming 读取的事件；只为计时加载事件的调用方可按这些过滤。
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

// ComputeRunTiming：从运行事件日志推导计时；节点行只保留最新尝试，审批等待让 FinishedAt 停在决定时间，事件日志是覆盖全部尝试的唯一来源；没有 node.started 事件的运行回退到节点行。
function ComputeRunTiming(run, events, now) {
  const [timing] = computeRunTiming(run, events, now);
  return timing;
}

// RunExecutionInterval：一段观测到的节点执行区间，不含等待。
class RunExecutionInterval {
  constructor(init = {}) {
    this.StartedAt = init.StartedAt ?? null;
    this.FinishedAt = init.FinishedAt ?? null;
  }
}

// RunExecutionIntervals：与 ComputeRunTiming 共享计时计算；布尔值区分观测到的零与缺失的计时证据。返回 [区间, 是否有证据]。
function RunExecutionIntervals(run, events, now) {
  const [, intervals, known] = computeRunTiming(run, events, now);
  return [intervals, known];
}

function computeRunTiming(run, events, now) {
  let intervals = [];
  let open = new Map();
  let lastEvent = null;
  let terminalAt = null;
  let started = false;
  const closeNode = (nodeID, at) => {
    if (open.has(nodeID)) {
      intervals.push({ start: open.get(nodeID), end: at });
      open.delete(nodeID);
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
      open.set(ev.NodeID, at);
    } else if (nodeIntervalClosers[ev.Type] && ev.NodeID !== "") {
      closeNode(ev.NodeID, at);
    } else if (runIntervalClosers[ev.Type]) {
      for (const nodeID of [...open.keys()]) {
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
    open = new Map();
    for (const [nodeID, node] of Object.entries(run.Nodes ?? {})) {
      if (node == null || node.StartedAt == null) {
        continue;
      }
      if (node.FinishedAt != null) {
        intervals.push({ start: node.StartedAt, end: node.FinishedAt });
      } else if (node.Status === "running") {
        open.set(nodeID, node.StartedAt);
      }
    }
  }
  let openEnd = lastEvent;
  if (run.Status === "running") {
    openEnd = end;
    out.Executing = open.size > 0;
  }
  for (const start of open.values()) {
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

// runTimingEnd：选运行计时的停止时刻：运行未结束时为 now，否则取终态运行事件，回退到最后一个事件、运行的 UpdatedAt，最后是 now。
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

// mergeExecutionIntervals：把区间裁到 [createdAt, end]，合并重叠区间，返回合并后的区间与总时长；
// known 报告是否有区间是有效观测，以便把观测到的零与缺失的计时证据区分开。返回 [合并区间, 总毫秒数, 是否有证据]。
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
