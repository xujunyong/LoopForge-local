// engine_observe.js —— 对应 Go 文件：internal/engine/engine_observe.go
// 作用：遥测观察队列：负责将节点执行产生的遥测事件入队、定时或按阈值刷盘，并合并写入运行记录的遥测与日志列表。
// 职责边界：仅处理观察事件缓冲、去重、日志衍生与活动文案提取；不包含遥测上下文拼装与存储层持久化实现。
// 语法差异说明：context.Context 译为 AbortSignal；sync.Mutex 在单线程 JS 中省略；goroutine/select 循环译为 async/Promise；map[string]struct{} 译为普通对象 {}；(值, bool) 译为 [值, boolean]。

"use strict";

const { TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TelemetryEvent，run.js 已翻译
const { ObservabilitySpecVersion, TelemetrySource, LogRecord } = require("../domain/observability.js"); // 对应 Go 的 domain.ObservabilitySpecVersion/TelemetrySource/LogRecord，observability.js 已翻译
const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { AdapterHooks, AdapterOTEL } = require("../observability/hooks.js"); // 对应 Go 的 observability.AdapterHooks/AdapterOTEL，observability 待翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { clarifyProcessLog, applyUsage } = require("./observability.js"); // 对应 Go 同包函数，observability.js 已翻译
const { shouldRecordLog, boundedLogBody, logAttributes, coalesceProgressTelemetry } = require("./run_events.js"); // 对应 Go 同包函数，run_events.js 已翻译

/**
 * 待刷盘的遥测观察条目，对应 Go 的 pendingObservation。
 * 用于在内存中暂存尚未合并回 Run 记录的遥测事件。
 */
class pendingObservation {
  /**
   * 按 Go 结构体零值语义初始化待刷盘观察条目。
   * @param {Object} [init={}] - 可选初始字段。
   * @param {string} [init.runID=""] - 所属运行 ID。
   * @param {string} [init.nodeID=""] - 所属节点 ID。
   * @param {TelemetryEvent} [init.event] - 遥测事件对象。
   * @returns {pendingObservation} 初始化后的条目实例。
   */
  constructor(init = {}) {
    this.runID = init.runID ?? "";
    this.nodeID = init.nodeID ?? "";
    this.event = init.event ?? new TelemetryEvent();
  }
}

/** 遥测队列定时刷盘间隔（毫秒），对应 50ms。 */
const observationFlushInterval = 50;
/** 触发立即刷盘的队列堆积阈值。 */
const observationFlushKickSize = 32;

/**
 * 将一条遥测观察事件推入引擎内存缓冲队列；当队列长度达到阈值时立即唤醒刷盘循环。
 * 在节点执行、沙箱或外部上报产生遥测事件时调用。
 * @param {string} runID - 运行 ID。
 * @param {string} nodeID - 节点 ID。
 * @param {TelemetryEvent} observation - 遥测事件对象。
 * @returns {void} 无返回值。
 */
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

/**
 * 以非阻塞方式触发一次遥测队列刷盘信号（对应 Go 的带缓冲 channel 非阻塞发送）。
 * 在队列达到阈值或需要尽快落盘时调用。
 * @returns {void} 无返回值。
 */
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

/**
 * 后台遥测刷盘循环，对应 Go 的 goroutine + select（监听取消信号、主动唤醒与 50ms 定时器）。
 * 由 Engine.StartMaintenance 启动，在收到取消信号时做最后一次全量刷盘后退出。
 * @param {AbortSignal} ctx - 取消信号，触发 abort 时退出循环。
 * @returns {Promise<void>} 异步循环结束时 resolve，无返回值。
 */
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

/**
 * 将当前队列中涉及的所有运行 ID 逐一触发 updateRun 以合并落盘。
 * 在定时刷盘、阈值唤醒或引擎退出前调用。
 * @returns {void} 无返回值。
 */
Engine.prototype.flushAllObservations = function () {
  if (this == null) {
    return;
  }
  for (const runID of this.pendingObservationRunIDs()) {
    this.updateRun(runID, null);
  }
};

/**
 * 提取待刷盘队列中去重后的运行 ID 列表（保持首次出现顺序）。
 * 在 flushAllObservations 准备批量更新运行状态时调用。
 * @returns {string[]} 去重后的运行 ID 数组。
 */
Engine.prototype.pendingObservationRunIDs = function () {
  const seen = {};
  const ids = [];
  for (const item of this.obsPending) {
    if (seen[item.runID]) {
      continue;
    }
    seen[item.runID] = true;
    ids.push(item.runID);
  }
  return ids;
};

/**
 * 从待刷盘队列中取出指定运行 ID 的全部观察条目，并保留其余运行的条目。
 * 在 updateRun 合并某个运行的待处理观察事件时调用。
 * @param {string} runID - 目标运行 ID。
 * @returns {pendingObservation[]|null} 取出的观察条目数组；队列为空时返回 null。
 */
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

/**
 * 将单条遥测观察事件幂等合并到指定 Run 记录中，并同步衍生日志、节点状态、工具调用计数与用量统计。
 * 在刷盘或实时写入遥测事件时调用；终态 Run 仅接受 sandbox.closed 事件。
 * @param {Object} r - 目标运行对象（domain.Run）。
 * @param {string} nodeID - 关联节点 ID。
 * @param {TelemetryEvent} observation - 待合并的遥测事件对象。
 * @returns {void} 无返回值。
 */
Engine.prototype.applyObservation = function (r, nodeID, observation) {
  if (TerminalRunStatus(r.Status) && observation.Name !== "sandbox.closed") {
    return;
  }
  // Worker/OTLP 重试必须保持幂等：保留生产者提供的 ID，若该 Run 已接收则忽略；内部观察无 ID 时在此生成。
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

/**
 * 根据遥测事件推导用于界面展示的节点活动文案。
 * 当事件不应覆盖当前活动状态（如成功结束的工具调用或已关闭的沙箱）时，返回 ["", false]。
 * @param {TelemetryEvent} observation - 遥测事件对象。
 * @returns {[string, boolean]} 二元组 [活动文案, 是否需要更新当前活动]。
 */
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
