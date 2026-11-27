/**
 * @file internal/engine/run_events.js
 * 对应 Go 源文件：internal/engine/run_events.go
 *
 * 作用与职责边界：
 * 负责运行事件记录与可观测性遥测/日志摄入，包括追加运行事件、接入 OTLP Trace 与
 * 执行器无关的 Worker 信封（observation/log）、过滤噪音工具心跳日志、构造遥测上下文、
 * 合并并行流式进度文本以及追加控制面验证遥测事件。
 *
 * 语法差异说明：
 * - Go 的仅 `error` 返回（如 `IngestWorkerEnvelope`）按统一约定译为成功无返回值（`undefined`）、失败 `throw err`。
 * - Go 的 `time.Time` 零值译为 `null`；`fmt.Sprintf` 的 `%q` 译为 `JSON.stringify`。
 * - Go 的 `[]rune` 按 Unicode 码点切分在 JS 中以 `[...value]` 展开实现。
 */

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { RunEvent, TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.RunEvent/TelemetryEvent，run.js 已翻译
const { ObservabilitySpecVersion } = require("../domain/observability.js"); // 对应 Go 的 domain.ObservabilitySpecVersion，observability.js 已翻译
const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { AdapterHooks, AdapterOTEL } = require("../observability/hooks.js"); // 对应 Go 的 observability.AdapterHooks/AdapterOTEL，observability 待翻译
const { workflowAgent } = require("./assets.js"); // 对应 Go 同包函数，assets.js 已翻译
const { workflowNodeExecutor } = require("./sop_executors.js"); // 对应 Go 同包函数，sop_executors.js 已翻译

/**
 * 向指定运行持久化追加一条运行级事件（不绑定具体节点）。
 * 使用场景：记录审批、调度、工作区或系统级状态变更事件。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {string} typ - 事件类型标识。
 * @param {string} msg - 面向用户的事件描述文本。
 * @returns {void} 无返回值。
 */
Engine.prototype.AppendRunEvent = function (runID, typ, msg) {
  this.updateRun(runID, (r) => {
    this.event(r, "", typ, msg);
  });
};

/**
 * 在内存运行对象的 `Events` 列表中追加一条新的 `RunEvent`。
 * 使用场景：在 `updateRun` 回调或控制决策事务内记录节点/运行事件。
 *
 * @param {object} r - 待修改的运行对象（`domain.Run`）。
 * @param {string} nodeID - 关联节点 ID，运行级事件传 `""`。
 * @param {string} t - 事件类型标识。
 * @param {string} msg - 事件描述文案。
 * @returns {void} 无返回值。
 */
Engine.prototype.event = function (r, nodeID, t, msg) {
  r.Events.push(new RunEvent({ ID: `evt-${BigInt(Date.now()) * 1000000n}`, RunID: r.ID, NodeID: nodeID, Type: t, Message: msg, Timestamp: new Date() }));
};

/**
 * 将单条遥测观测事件入队等待批处理落盘；若运行已进入终态则忽略除 `sandbox.closed` 外的迟到观测。
 * 使用场景：节点执行流、OTLP 与 Worker 信封接入观测事件的统一入口。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {string} nodeID - 关联节点 ID。
 * @param {TelemetryEvent} observation - 待记录的遥测观测事件。
 * @returns {void} 无返回值。
 */
Engine.prototype.observe = function (runID, nodeID, observation) {
  const [current, ok] = this.repo.RunState(runID);
  if (ok && TerminalRunStatus(current.Status) && observation.Name !== "sandbox.closed") {
    return;
  }
  this.enqueueObservation(runID, nodeID, observation);
};

/**
 * 批量摄入 OTLP Trace 转换后的遥测事件，补齐节点 Provider 后入队并立即刷盘。
 * 使用场景：HTTP API 接收 OpenTelemetry Trace 上报时调用。
 *
 * @param {TelemetryEvent[]} events - 待摄入的遥测事件数组。
 * @returns {number} 实际匹配到有效运行并被接收的事件条数。
 */
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

/**
 * 本地适配器与远程 worker 共用的、与执行器无关的可观测性信封摄入入口。
 * 使用场景：接收已规范化的 `observation` 或 `log` 类型信封，完成字段校验后入队或写入运行日志（单次运行日志上限 8000 条）。
 *
 * @param {string} runID - 目标运行主键 ID。
 * @param {object} envelope - 工作器观测/日志信封（`domain.WorkerEnvelope`）。
 * @returns {void} 无返回值。
 * @throws {Error} 规范版本不支持、运行或节点不存在、载荷缺失/超长或类型非法时抛出错误。
 */
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
      return;
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
      return;
    }
    default:
      throw new Error("type must be observation or log");
  }
};

/**
 * 从遥测事件中提取用于关联日志记录的结构化属性白名单。
 * 使用场景：将观测事件同步投影为运行日志时构建 `LogRecord.Attributes`。
 *
 * @param {TelemetryEvent} event - 源遥测事件。
 * @returns {Object<string, any>} 包含基础事件字段与非空扩展属性的普通对象。
 */
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

/**
 * 判断一条遥测事件是否应当同时写入面向人类阅读的运行日志流。
 * 使用场景：过滤 Hook/OTEL 适配器事件、推理/用量/增量分片、模型请求及工具完成噪音。
 *
 * @param {TelemetryEvent} event - 待判定的遥测事件。
 * @returns {boolean} 应当记录为日志返回 `true`，否则返回 `false`。
 */
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

/**
 * 判断事件是否属于无信息量的工具生命周期结束心跳（错误级别事件始终保留）。
 * 使用场景：由 `shouldRecordLog` 调用，保留“Bash git status”等动作日志，过滤“Bash 完成”/“工具完成”。
 *
 * @param {TelemetryEvent} event - 待判定的遥测事件。
 * @returns {boolean} 属于噪音心跳返回 `true`，否则返回 `false`。
 */
function isNoisyWorkerLog(event) {
  if (event.Level === "error") {
    return false;
  }
  if (event.Category === "tool" && event.Phase === "finish") {
    return true;
  }
  return toolCompletionMessage(event.Message);
}

/**
 * 检查日志文案是否为工具完成或工具结果类的模式化短句。
 * 使用场景：由 `isNoisyWorkerLog` 调用，识别文本形式的工具完成提示。
 *
 * @param {string} msg - 事件消息文本。
 * @returns {boolean} 命中工具完成文案模式返回 `true`，否则返回 `false`。
 */
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

/**
 * 判断前缀词是否符合常见工具名格式（1–64 个 ASCII 字母、数字或 `_`/`-`/`.`/`/` 字符）。
 * 使用场景：由 `toolCompletionMessage` 调用，区分“<ToolName> 完成”与普通中文句子。
 *
 * @param {string} name - 待检测的工具名候选词。
 * @returns {boolean} 符合工具名字符规则返回 `true`，否则返回 `false`。
 */
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

/**
 * 将单条日志正文限制在 64 KiB 以内，超长时截断并追加省略标记。
 * 使用场景：从遥测消息生成运行日志正文前防止单条日志过大。
 *
 * @param {string} value - 原始日志正文字符串。
 * @returns {string} 不超过上限的正文字符串。
 */
function boundedLogBody(value) {
  const limit = 64 * 1024;
  if (value.length <= limit) {
    return value;
  }
  return value.slice(0, limit) + " … [log truncated]";
}

/**
 * 为单条遥测观测事件组装完整的 `TelemetryContext`，补齐运行/节点/尝试/Agent/执行器及关联任务与需求元数据。
 * 使用场景：观测事件刷盘写入前补全上下文维度。
 *
 * @param {object} run - 当前运行对象（`domain.Run`）。
 * @param {string} nodeID - 关联节点 ID。
 * @param {object|null} nr - 节点运行状态对象（`domain.NodeRun`），运行级事件可为 `null`。
 * @param {TelemetryEvent} event - 原始遥测事件。
 * @returns {object} 填充完整的遥测上下文对象（`domain.TelemetryContext`）。
 */
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
        try {
          const executor = workflowNodeExecutor(this.repo, run.WorkflowSnapshot, node, agent);
          ctx.ExecutorID = executor.ID;
        } catch {}
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

/**
 * 将同一节点连续产生的流式 `progress` 遥测片段（reasoning/output/tool.input）就地合并并移至队列尾部，避免并行流交错膨胀。
 * 使用场景：观测批处理落盘追加 `r.Telemetry` 前尝试与同节点最近一条进度事件合并。
 *
 * @param {TelemetryEvent[]} events - 当前运行的遥测事件数组（命中合并时会被就地修改）。
 * @param {TelemetryEvent} observation - 新到达的遥测事件。
 * @returns {boolean} 成功合并到已有事件返回 `true`，需作为新事件追加返回 `false`。
 */
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

/**
 * 当合并后的流式进度文本超过最大字符数（24,000 码点）时，保留首尾各半并在中间插入截断标记。
 * 使用场景：由 `coalesceProgressTelemetry` 调用以限制单条进度事件体积。
 *
 * @param {string} value - 合并后的完整文本。
 * @returns {string} 长度受控的文本。
 */
function compactProgressText(value) {
  const runes = [...value];
  if (runes.length <= maxTelemetryProgressRunes) {
    return value;
  }
  const half = Math.floor(maxTelemetryProgressRunes / 2);
  return runes.slice(0, half).join("") + "\n…[stream truncated]…\n" + runes.slice(runes.length - half).join("");
}

/**
 * 向运行对象的遥测列表追加一条控制面操作事件（类别固定为 `verification`、阶段为 `finish`）。
 * 使用场景：人工批准、通过、打回、重试、恢复、刷新 SOP 或拒绝重试时同步写入遥测时间线。
 *
 * @param {object} r - 待修改的运行对象（`domain.Run`）。
 * @param {string} nodeID - 关联节点 ID，运行级操作传 `""`。
 * @param {string} name - 遥测事件名称（如 `"gate.approved"`、`"run.resumed"`）。
 * @param {string} message - 面向用户的中文描述。
 * @returns {void} 无返回值。
 */
function appendControlTelemetry(r, nodeID, name, message) {
  const now = new Date();
  r.TelemetrySequence++;
  r.Telemetry.push(new TelemetryEvent({ ID: `obs-${BigInt(now.getTime()) * 1000000n}`, RunID: r.ID, NodeID: nodeID, Sequence: r.TelemetrySequence, Timestamp: now, Category: "verification", Name: name, Phase: "finish", Level: "info", Message: message }));
}

module.exports = { maxTelemetryProgressRunes, logAttributes, shouldRecordLog, isNoisyWorkerLog, toolCompletionMessage, looksLikeToolName, boundedLogBody, coalesceProgressTelemetry, compactProgressText, appendControlTelemetry };
