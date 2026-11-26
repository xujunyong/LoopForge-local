// engine_observe.js —— 对应 Go 文件：internal/engine/engine_observe.go
// 作用：遥测观察队列：入队、定时刷盘并把事件合并进运行记录。
// context.Context 译为 AbortSignal；sync.Mutex 在单线程 JS 里不需要；time.Time 零值译为 null；(值, bool) 译为 [值, bool]。

"use strict";

const { TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TelemetryEvent，run.js 已翻译
const { ObservabilitySpecVersion, TelemetrySource, LogRecord } = require("../domain/observability.js"); // 对应 Go 的 domain.ObservabilitySpecVersion/TelemetrySource/LogRecord，observability.js 已翻译
const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { AdapterHooks, AdapterOTEL } = require("../observability/hooks.js"); // 对应 Go 的 observability.AdapterHooks/AdapterOTEL，observability 待翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译

class pendingObservation {
  constructor(init = {}) {
    this.runID = init.runID ?? "";
    this.nodeID = init.nodeID ?? "";
    this.event = init.event ?? null;
  }
}

const observationFlushInterval = 50;
const observationFlushKickSize = 32;

Engine.prototype.enqueueObservation = function (runID, nodeID, observation) {
  if (this == null) {
    return;
  }
  this.obsPending.push(new pendingObservation({ runID: runID, nodeID: nodeID, event: observation }));
  const n = this.obsPending.length;
  if (n >= observationFlushKickSize) {
    this.signalObservationFlush();
  }
};

Engine.prototype.signalObservationFlush = function () {
  if (this == null || this.obsKick == null) {
    return;
  }
  if (this.obsKick.pending) {
    return;
  }
  this.obsKick.pending = true;
  const waiter = this.obsKick.waiters.shift();
  if (waiter != null) {
    waiter();
  }
};

Engine.prototype.observationFlushLoop = async function (ctx) {
  if (this == null || this.obsKick == null) {
    return;
  }
  for (;;) {
    if (ctx instanceof AbortSignal && ctx.aborted) {
      this.flushAllObservations();
      return;
    }
    let outcome;
    if (this.obsKick.pending) {
      this.obsKick.pending = false;
      outcome = "kick";
    } else {
      outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve("tick"), observationFlushInterval);
        const onAbort = () => {
          clearTimeout(timer);
          resolve("done");
        };
        if (ctx instanceof AbortSignal) {
          ctx.addEventListener("abort", onAbort, { once: true });
        }
        this.obsKick.waiters.push(() => {
          this.obsKick.pending = false;
          clearTimeout(timer);
          if (ctx instanceof AbortSignal) {
            ctx.removeEventListener("abort", onAbort);
          }
          resolve("kick");
        });
      });
    }
    if (outcome === "done") {
      this.flushAllObservations();
      return;
    }
    this.flushAllObservations();
  }
};

Engine.prototype.flushAllObservations = function () {
  if (this == null) {
    return;
  }
  for (const runID of this.pendingObservationRunIDs()) {
    this.updateRun(runID, null);
  }
};

Engine.prototype.pendingObservationRunIDs = function () {
  const seen = new Set();
  const ids = [];
  for (const item of this.obsPending) {
    if (seen.has(item.runID)) {
      continue;
    }
    seen.add(item.runID);
    ids.push(item.runID);
  }
  return ids;
};

Engine.prototype.takePendingObservations = function (runID) {
  if (this.obsPending.length === 0) {
    return null;
  }
  const taken = [];
  const kept = [];
  for (const item of this.obsPending) {
    if (item.runID === runID) {
      taken.push(item);
      continue;
    }
    kept.push(item);
  }
  this.obsPending = kept;
  return taken;
};

Engine.prototype.applyObservation = function (r, nodeID, observation) {
  if (TerminalRunStatus(r.Status) && observation.Name !== "sandbox.closed") {
    return;
  }
  const trimmedID = (observation.ID ?? "").trim();
  if (trimmedID !== "") {
    if (this.repo.TelemetryEventExists(r.ID, trimmedID)) {
      return;
    }
    for (const existing of r.Telemetry) {
      if (existing.ID === trimmedID) {
        return;
      }
    }
  }
  const now = new Date();
  if (trimmedID === "") {
    observation.ID = `obs-${BigInt(now.getTime()) * 1000000n}`;
  }
  observation.RunID = r.ID;
  observation.NodeID = nodeID;
  r.TelemetrySequence++;
  observation.Sequence = r.TelemetrySequence;
  if (observation.Timestamp == null || (observation.Source.Adapter !== AdapterHooks && observation.Source.Adapter !== AdapterOTEL)) {
    observation.Timestamp = now;
  }
  observation.SpecVersion = ObservabilitySpecVersion;
  if (observation.Level === "") {
    observation.Level = "info";
  }
  clarifyProcessLog(observation);
  const nr = r.Nodes[nodeID] ?? null;
  observation.Context = this.observationContext(r, nodeID, nr, observation);
  if (observation.Source.Layer === "") {
    let layer = "orchestrator";
    if (observation.Category === "sandbox" || observation.Category === "process") {
      layer = "sandbox";
    }
    if (observation.Category === "verification") {
      layer = "verification";
    }
    observation.Source = new TelemetrySource({ Layer: layer, Adapter: "agentflow-control-plane", Provider: observation.Provider });
  }
  if (shouldRecordLog(observation)) {
    r.LogSequence++;
    let stream = "worker";
    if (observation.Name === "process.stdout") {
      stream = "stdout";
    }
    if (observation.Name === "process.stderr") {
      stream = "stderr";
    }
    if (observation.Source.Layer !== "executor" && observation.Category !== "process") {
      stream = "platform";
    }
    r.Logs.push(new LogRecord({ SpecVersion: ObservabilitySpecVersion, ID: `log-${BigInt(now.getTime()) * 1000000n}`, Sequence: r.LogSequence, Timestamp: now, Level: observation.Level, Stream: stream, Body: boundedLogBody(observation.Message), Source: observation.Source, Context: observation.Context, Attributes: logAttributes(observation) }));
    if (r.Logs.length > 8000) {
      r.Logs = r.Logs.slice(r.Logs.length - 8000);
    }
  }
  if (nr != null) {
    if (observation.Provider !== "") {
      nr.Provider = observation.Provider;
    }
    if (observation.Model !== "") {
      nr.Model = observation.Model;
    }
    if (observation.SessionID !== "") {
      nr.SessionID = observation.SessionID;
      nr.ResumeSessionID = "";
    }
    const metricsSideChannel = observation.Source.Adapter === AdapterHooks || observation.Source.Adapter === AdapterOTEL;
    if (!metricsSideChannel) {
      const [activity, ok] = observationActivity(observation);
      if (ok) {
        nr.Activity = activity;
      }
      if (observation.Category === "tool" && observation.Name === "tool.call" && observation.Phase === "finish") {
        nr.ToolCalls++;
        r.ToolCalls++;
      }
      if (observation.Usage != null) {
        applyUsage(r, nr, observation.SessionID, observation.Usage);
      }
    }
  }
  const coalesced = coalesceProgressTelemetry(r.Telemetry, observation);
  if (!coalesced) {
    r.Telemetry.push(observation);
  }
  if (r.Telemetry.length > 4000) {
    r.Telemetry = r.Telemetry.slice(r.Telemetry.length - 4000);
  }
};

function observationActivity(observation) {
  switch (observation.Category) {
    case "reasoning":
      return ["模型正在推理", true];
    case "output":
      return ["模型正在生成输出", true];
    case "tool":
      if (observation.Name === "tool.call" && (observation.Phase !== "finish" || observation.Level === "error")) {
        return ["调用工具：" + observation.Message, true];
      }
      return ["", false];
    case "sandbox":
      if (observation.Name !== "sandbox.closed") {
        return [observation.Message, true];
      }
      return ["", false];
    case "process": {
      if (observation.Name !== "process.started") {
        return [observation.Message, true];
      }
      let label = observation.Provider;
      if (label === "") {
        label = "执行器";
      }
      if (observation.Model !== "") {
        label += " · " + observation.Model;
      }
      return [label + " 已启动", true];
    }
    default:
      if (observation.Message !== "") {
        return [observation.Message, true];
      }
      return [observation.Name, true];
  }
}

module.exports = { pendingObservation, observationFlushInterval, observationFlushKickSize, observationActivity };
