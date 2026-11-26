// run_events.js —— 对应 Go 文件：internal/engine/run_events.go
// 作用：运行事件与遥测摄入：记事件、接 OTLP/Worker 信封、过滤写入日志。
// time.Time 零值译为 null；fmt.Sprintf 的 %q 译为 JSON.stringify；Go 的字节长度（len）在 JS 里按字符长度计。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { RunEvent, TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.RunEvent/TelemetryEvent，run.js 已翻译
const { ObservabilitySpecVersion, LogRecord, WorkerEnvelope } = require("../domain/observability.js"); // 对应 Go 的 domain.ObservabilitySpecVersion/LogRecord/WorkerEnvelope，observability.js 已翻译
const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { AdapterHooks, AdapterOTEL } = require("../observability/hooks.js"); // 对应 Go 的 observability.AdapterHooks/AdapterOTEL，observability 待翻译

Engine.prototype.AppendRunEvent = function (runID, typ, msg) {
  this.updateRun(runID, (r) => {
    this.event(r, "", typ, msg);
  });
};

Engine.prototype.event = function (r, nodeID, t, msg) {
  r.Events.push(new RunEvent({ ID: `evt-${BigInt(Date.now()) * 1000000n}`, RunID: r.ID, NodeID: nodeID, Type: t, Message: msg, Timestamp: new Date() }));
};

Engine.prototype.observe = function (runID, nodeID, observation) {
  const [current, ok] = this.repo.RunState(runID);
  if (ok && TerminalRunStatus(current.Status) && observation.Name !== "sandbox.closed") {
    return;
  }
  this.enqueueObservation(runID, nodeID, observation);
};

Engine.prototype.IngestOTLPTraces = function (events) {
  let accepted = 0;
  for (const event of events) {
    let runID = event.RunID.trim();
    if (runID === "") {
      runID = event.Context.RunID.trim();
    }
    if (runID === "") {
      continue;
    }
    const [run, ok] = this.repo.RunState(runID);
    if (!ok) {
      continue;
    }
    let nodeID = event.NodeID.trim();
    if (nodeID === "") {
      nodeID = event.Context.NodeID.trim();
    }
    const node = run.Nodes[nodeID];
    if (node != null && node.Provider !== "") {
      event.Provider = node.Provider;
      event.Source.Provider = node.Provider;
    }
    this.observe(runID, nodeID, event);
    accepted++;
  }
  this.flushAllObservations();
  return accepted;
};

// IngestWorkerEnvelope 是本地适配器与远程 worker 共用的、与执行器无关的入口。原生供应商载荷必须在此之前规范化。
Engine.prototype.IngestWorkerEnvelope = function (runID, envelope) {
  if (envelope.SpecVersion !== ObservabilitySpecVersion) {
    throw new Error(`unsupported observability spec ${JSON.stringify(envelope.SpecVersion)}`);
  }
  const [run, ok] = this.repo.RunState(runID);
  if (!ok) {
    throw new Error("run not found");
  }
  switch (envelope.Type) {
    case "observation": {
      if (envelope.Observation == null) {
        throw new Error("observation is required");
      }
      if (envelope.Observation.Source.Layer === "" || envelope.Observation.Source.Adapter === "") {
        throw new Error("observation source.layer and source.adapter are required");
      }
      let nodeID = envelope.Observation.Context.NodeID;
      if (nodeID === "") {
        nodeID = envelope.Observation.NodeID;
      }
      if (nodeID !== "") {
        if (run.Nodes[nodeID] == null) {
          throw new Error("node not found in run");
        }
      }
      this.observe(runID, nodeID, envelope.Observation);
      this.flushAllObservations();
      return null;
    }
    case "log": {
      if (envelope.Log == null) {
        throw new Error("log is required");
      }
      const log = { ...envelope.Log, Context: { ...envelope.Log.Context } };
      if (log.Source.Layer === "" || log.Source.Adapter === "") {
        throw new Error("log source.layer and source.adapter are required");
      }
      if (log.Body === "") {
        throw new Error("log body is required");
      }
      if (log.Body.length > 64 * 1024) {
        throw new Error("log body exceeds 65536 bytes");
      }
      if (log.Context.NodeID !== "") {
        if (run.Nodes[log.Context.NodeID] == null) {
          throw new Error("node not found in run");
        }
      }
      this.updateRun(runID, (r) => {
        const now = new Date();
        r.LogSequence++;
        log.SpecVersion = ObservabilitySpecVersion;
        log.ID = `log-${BigInt(now.getTime()) * 1000000n}`;
        log.Sequence = r.LogSequence;
        if (log.Timestamp == null) {
          log.Timestamp = now;
        }
        log.Context.RunID = runID;
        log.Context.TraceID = runID;
        if (log.Level === "") {
          log.Level = "info";
        }
        if (log.Stream === "") {
          log.Stream = "worker";
        }
        r.Logs.push(log);
        if (r.Logs.length > 8000) {
          r.Logs = r.Logs.slice(r.Logs.length - 8000);
        }
      });
      return null;
    }
    default:
      throw new Error("type must be observation or log");
  }
};

function logAttributes(event) {
  const attrs = { eventName: event.Name, category: event.Category, phase: event.Phase };
  if (event.Attributes == null) {
    return attrs;
  }
  for (const key of ["input", "status", "exitCode", "repositoryId", "repositoryName", "repositoryDir"]) {
    if (key in event.Attributes && event.Attributes[key] != null) {
      attrs[key] = event.Attributes[key];
    }
  }
  return attrs;
}

function shouldRecordLog(event) {
  if (event.Source.Adapter === AdapterHooks || event.Source.Adapter === AdapterOTEL) {
    return false;
  }
  if (event.Category === "reasoning" || event.Category === "usage" || (event.Category === "output" && event.Name.endsWith(".delta"))) {
    return false;
  }
  if (event.Category === "model" && event.Name === "model.request") {
    return false;
  }
  if (isNoisyWorkerLog(event)) {
    return false;
  }
  return event.Message !== "";
}

// isNoisyWorkerLog 丢掉工具生命周期心跳。Worker 日志是给人看的：保留“Bash git status”/“Read foo.go”，不要“Bash 完成”/“工具完成”。
function isNoisyWorkerLog(event) {
  if (event.Level === "error") {
    return false;
  }
  if (event.Category === "tool" && event.Phase === "finish") {
    return true;
  }
  return toolCompletionMessage(event.Message);
}

function toolCompletionMessage(msg) {
  const s = msg.trim();
  if (s === "") {
    return false;
  }
  switch (s) {
    case "工具完成":
    case "tool result":
    case "工具返回结果":
    case "工具结果":
      return true;
  }
  if (s.startsWith("工具完成 ")) {
    return true;
  }
  const idx = s.indexOf(" ");
  if (idx === -1) {
    return false;
  }
  const name = s.slice(0, idx);
  const rest = s.slice(idx + 1);
  if (!looksLikeToolName(name)) {
    return false;
  }
  return rest === "完成" || rest.startsWith("完成:") || rest.startsWith("完成：") || rest === "结果" || rest.startsWith("结果");
}

function looksLikeToolName(name) {
  if (name === "" || name.length > 64) {
    return false;
  }
  for (const r of name) {
    if ((r >= "a" && r <= "z") || (r >= "A" && r <= "Z") || (r >= "0" && r <= "9") || r === "_" || r === "-" || r === "." || r === "/") {
      continue;
    }
    return false;
  }
  return true;
}

function boundedLogBody(value) {
  const limit = 64 * 1024;
  if (value.length <= limit) {
    return value;
  }
  return value.slice(0, limit) + " … [log truncated]";
}

Engine.prototype.observationContext = function (run, nodeID, nr, event) {
  const ctx = { ...run.ExecutionContext };
  ctx.RunID = run.ID;
  ctx.TraceID = run.ID;
  ctx.WorkflowID = run.WorkflowID;
  ctx.WorkflowVersion = run.WorkflowSnapshot.Version;
  ctx.NodeID = nodeID;
  ctx.SessionID = event.SessionID;
  ctx.ParentSpanID = event.ParentID;
  if (nr != null) {
    ctx.Attempt = nr.Attempt;
    ctx.SandboxID = nr.SandboxID;
    ctx.SpanID = `${run.ID}:${nodeID}:${nr.Attempt}`;
  }
  for (const node of run.WorkflowSnapshot.Nodes) {
    if (node.ID === nodeID) {
      ctx.AgentID = node.AgentID;
      ctx.ExecutorID = node.ExecutorID;
      ctx.MetricStage = node.MetricStage;
      const [agent, ok] = workflowAgent(this.repo, run.WorkflowSnapshot, node.AgentID);
      if (ok) {
        ctx.AgentVersion = agent.Version;
        const [executor, err] = workflowNodeExecutor(this.repo, run.WorkflowSnapshot, node, agent);
        if (err == null) {
          ctx.ExecutorID = executor.ID;
        }
      }
      break;
    }
  }
  for (const task of this.repo.Tasks()) {
    if (task.RunID === run.ID) {
      ctx.TaskID = task.ID;
      ctx.IssueID = task.IssueID;
      const [issue, ok] = this.repo.Issue(task.IssueID);
      if (ok) {
        ctx.ProjectID = issue.ProjectID;
        ctx.TAPDID = issue.RequirementTAPDID();
      }
      break;
    }
  }
  return ctx;
};

const maxTelemetryProgressRunes = 24_000;

// coalesceProgressTelemetry 让并行流式节点保持紧凑。只看全局尾部时，两个模型流逐 token 交错会失效。
function coalesceProgressTelemetry(events, observation) {
  if (observation.Phase !== "progress" || observation.Usage != null || (observation.Category !== "reasoning" && observation.Category !== "output" && observation.Name !== "tool.input")) {
    return false;
  }
  const values = events;
  for (let i = values.length - 1; i >= 0; i--) {
    const candidate = values[i];
    if (candidate.NodeID !== observation.NodeID) {
      continue;
    }
    if (candidate.Phase !== "progress" || candidate.Category !== observation.Category || candidate.Name !== observation.Name) {
      return false;
    }
    candidate.Message = compactProgressText(candidate.Message + observation.Message);
    candidate.Sequence = observation.Sequence;
    candidate.Timestamp = observation.Timestamp;
    candidate.Level = observation.Level;
    values.copyWithin(i, i + 1);
    values[values.length - 1] = candidate;
    return true;
  }
  return false;
}

function compactProgressText(value) {
  const runes = [...value];
  if (runes.length <= maxTelemetryProgressRunes) {
    return value;
  }
  const half = Math.floor(maxTelemetryProgressRunes / 2);
  return runes.slice(0, half).join("") + "\n…[stream truncated]…\n" + runes.slice(runes.length - half).join("");
}

function appendControlTelemetry(r, nodeID, name, message) {
  const now = new Date();
  r.TelemetrySequence++;
  r.Telemetry.push(new TelemetryEvent({ ID: `obs-${BigInt(now.getTime()) * 1000000n}`, RunID: r.ID, NodeID: nodeID, Sequence: r.TelemetrySequence, Timestamp: now, Category: "verification", Name: name, Phase: "finish", Level: "info", Message: message }));
}

module.exports = { maxTelemetryProgressRunes, logAttributes, shouldRecordLog, isNoisyWorkerLog, toolCompletionMessage, looksLikeToolName, boundedLogBody, coalesceProgressTelemetry, compactProgressText, appendControlTelemetry };
