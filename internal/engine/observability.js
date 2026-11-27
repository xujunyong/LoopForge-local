// observability.js —— 对应 Go 文件：internal/engine/observability.go
// 作用：执行器遥测加工，包括进程退出日志文案澄清、会话级与运行级 Token/成本增量累加，以及 Loop 自修正复盘文档生成与产物挂载。
// 职责边界：仅负责遥测事件的加工计算与 loop-retro 复盘产物生成；不负责遥测异步刷盘队列或底层存储读写。
// 语法差异说明：(值, bool) 译为 [值, boolean]；strings.Builder 译为字符串数组拼接；Go 的 `_ =` 忽略文件写入错误译为 try/catch 空吞。

"use strict";

const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath
const { TokenUsage, TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TokenUsage/TelemetryEvent，run.js 已翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { resolveGateOnFailure } = require("./node_outcome.js"); // 对应 Go 同包函数，node_outcome.js 已翻译
const { appendArtifact } = require("./artifacts.js"); // 对应 Go 同包函数，artifacts.js 已翻译

/**
 * 将执行器进程的英文结束日志改写为更易读的中文提示（不影响 verification 门禁日志）。
 * 在引擎接收并落盘进程遥测事件前调用。
 *
 * @param {TelemetryEvent|null} event - 待加工的遥测事件对象（原地修改）。
 * @returns {void} 无返回值。
 */
function clarifyProcessLog(event) {
  if (event == null) {
    return;
  }
  if (event.Category === "verification") {
    return;
  }
  if (event.Category !== "process" || event.Name !== "process.finished") {
    return;
  }
  if (event.Level === "error") {
    event.Message = "执行器失败：" + event.Message;
    return;
  }
  if (event.Message === "process exited successfully") {
    event.Message = "执行器退出 0";
  }
}

/**
 * 将最新一次 Token 用量快照相对游标的增量累加到运行级与节点级汇总上，并同步成本识别状态。
 * 当会话 ID 切换时重置游标；在收到执行器用量事件时调用。
 *
 * @param {Object|null} run - 运行对象（domain.Run，原地更新 Usage）。
 * @param {Object|null} nr - 节点运行态对象（domain.NodeRun，原地更新 Usage 与 UsageCursor）。
 * @param {string} sessionID - 本次用量所属的 CLI 会话 ID（为空时回退到 nr.SessionID）。
 * @param {TokenUsage} snap - 最新上报的累计用量快照。
 * @returns {void} 无返回值。
 */
function applyUsage(run, nr, sessionID, snap) {
  if (run == null || nr == null) {
    return;
  }
  if (sessionID === "") {
    sessionID = nr.SessionID;
  }
  if (sessionID !== "" && nr.UsageSessionID !== sessionID) {
    nr.UsageSessionID = sessionID;
    nr.UsageCursor = new TokenUsage();
  }
  const delta = subUsage(snap, nr.UsageCursor);
  // 成本识别状态与 token 数值变化解耦：跟随最近一次带状态的快照，
  // 让"真实零成本"与"成本未识别"在 run 级汇总上也可区分。
  if (snap.CostStatus !== "") {
    run.Usage.CostStatus = snap.CostStatus;
    nr.Usage.CostStatus = snap.CostStatus;
  }
  if (!usageHasValues(delta)) {
    nr.UsageCursor = snap;
    return;
  }
  addUsage(run.Usage, delta);
  addUsage(nr.Usage, delta);
  nr.UsageCursor = snap;
  run.Usage.TotalTokens = billedTokens(run.Usage);
  nr.Usage.TotalTokens = billedTokens(nr.Usage);
}

/**
 * 计算计费总 Token 数（输入 Token 与输出 Token 之和）。
 * 在更新 run.Usage.TotalTokens 与 nr.Usage.TotalTokens 时调用。
 *
 * @param {TokenUsage} usage - Token 用量对象。
 * @returns {number} 输入与输出 Token 总和。
 */
function billedTokens(usage) {
  return usage.InputTokens + usage.OutputTokens;
}

/**
 * 判断用量对象是否包含任何非零的 Token 或费用数据。
 * 在 applyUsage 中用于跳过无变化的增量快照。
 *
 * @param {TokenUsage} usage - 待检查的增量用量对象。
 * @returns {boolean} 存在任一非零用量字段时返回 true，否则返回 false。
 */
function usageHasValues(usage) {
  return usage.InputTokens > 0 || usage.OutputTokens > 0 || usage.CacheReadTokens > 0 || usage.CacheWriteTokens > 0 || usage.ReasoningTokens > 0 || usage.CostUSD !== 0;
}

/**
 * 将源用量增量原地累加到目标用量对象中。
 * 在 applyUsage 中分别累加到运行级和节点级 Usage 时调用。
 *
 * @param {TokenUsage} dst - 目标用量对象（原地修改）。
 * @param {TokenUsage} src - 增量用量对象。
 * @returns {void} 无返回值。
 */
function addUsage(dst, src) {
  dst.InputTokens += src.InputTokens;
  dst.OutputTokens += src.OutputTokens;
  dst.CacheReadTokens += src.CacheReadTokens;
  dst.CacheWriteTokens += src.CacheWriteTokens;
  dst.ReasoningTokens += src.ReasoningTokens;
  dst.CostUSD += src.CostUSD;
}

/**
 * 计算当前用量快照相对于上一次游标的差值，Token 类差值截断为非负值。
 * 在 applyUsage 中提取增量时调用。
 *
 * @param {TokenUsage} cur - 当前最新用量快照。
 * @param {TokenUsage} prev - 上一次记录的用量游标。
 * @returns {TokenUsage} 计算得到的增量 TokenUsage 对象。
 */
function subUsage(cur, prev) {
  return new TokenUsage({
    InputTokens: clampNonNeg(cur.InputTokens - prev.InputTokens),
    OutputTokens: clampNonNeg(cur.OutputTokens - prev.OutputTokens),
    CacheReadTokens: clampNonNeg(cur.CacheReadTokens - prev.CacheReadTokens),
    CacheWriteTokens: clampNonNeg(cur.CacheWriteTokens - prev.CacheWriteTokens),
    ReasoningTokens: clampNonNeg(cur.ReasoningTokens - prev.ReasoningTokens),
    CostUSD: cur.CostUSD - prev.CostUSD,
  });
}

/**
 * 将数值截断到非负区间（小于 0 时返回 0）。
 * 在 subUsage 计算各 Token 字段增量时调用。
 *
 * @param {number} v - 原始差值。
 * @returns {number} 不小于 0 的结果值。
 */
function clampNonNeg(v) {
  if (v < 0) {
    return 0;
  }
  return v;
}

/**
 * 判断失败策略是否为 "loop"（启用节点内自修正循环）。
 * 在判断门禁失败后是否进入自修正流程时调用。
 *
 * @param {string} onFailure - 门禁失败策略配置值。
 * @returns {boolean} 解析结果为 "loop" 时返回 true，否则返回 false。
 */
function shouldSelfCorrect(onFailure) {
  return resolveGateOnFailure(onFailure, "") === "loop";
}

/**
 * 单个节点在 Loop 复盘期间收集的遥测统计信号，对应 Go 的 loopRetroSignals 结构体。
 */
class loopRetroSignals {
  /**
   * 按 Go 结构体零值语义初始化 loopRetroSignals 实例。
   *
   * @param {Object} [init={}] - 可选初始统计字段。
   * @param {number} [init.completed=0] - agent.completed 事件次数。
   * @param {number} [init.missingResult=0] - 执行器退出 0 但缺少 agent.completed 的次数。
   * @param {number} [init.gatePass=0] - 门禁通过次数。
   * @param {number} [init.gateFail=0] - 门禁失败次数。
   * @param {number} [init.loopStarts=0] - 进入自修正循环的次数。
   * @param {number} [init.toolFinishes=0] - 工具调用完成次数。
   * @param {string[]} [init.loopIssues=[]] - 按时间顺序记录的 "- Loop：..." 问题行。
   * @returns {loopRetroSignals} 初始化后的统计实例。
   */
  constructor(init = {}) {
    this.completed = init.completed ?? 0;
    this.missingResult = init.missingResult ?? 0;
    this.gatePass = init.gatePass ?? 0;
    this.gateFail = init.gateFail ?? 0;
    this.loopStarts = init.loopStarts ?? 0;
    this.toolFinishes = init.toolFinishes ?? 0;
    // loopIssues：每个 agent.loop 事件对应一行 "- Loop："，按顺序排列。
    this.loopIssues = init.loopIssues ?? [];
  }
}

/**
 * 遍历运行的遥测事件流，统计指定节点的完成、门禁、工具调用与自修正信号。
 * 在 buildLoopRetro 生成复盘报告时调用。
 *
 * @param {Object} run - 运行对象（domain.Run）。
 * @param {string} nodeID - 目标节点 ID。
 * @returns {loopRetroSignals} 汇总完成的节点遥测统计对象。
 */
function collectLoopRetroSignals(run, nodeID) {
  const s = new loopRetroSignals();
  for (const event of run.Telemetry) {
    if (event.NodeID !== nodeID) {
      continue;
    }
    switch (true) {
      case event.Name === "agent.completed":
        s.completed++;
        break;
      case event.Category === "process" && event.Name === "process.finished" && event.Source.Layer === "executor" && !event.Message.includes("失败"):
        if (s.completed === 0) {
          s.missingResult++;
        }
        break;
      case event.Category === "verification" && event.Name === "process.finished" && event.Level !== "error":
        s.gatePass++;
        break;
      case event.Category === "verification" && event.Name === "process.finished" && event.Level === "error":
        s.gateFail++;
        break;
      case event.Name === "agent.loop":
        s.loopStarts++;
        s.loopIssues.push("- Loop：" + event.Message);
        break;
      case event.Category === "tool" && event.Name === "tool.call" && event.Phase === "finish":
        s.toolFinishes++;
        break;
    }
  }
  return s;
}

/**
 * 生成指定节点的 Markdown 格式 Loop 自修正复盘文档内容。
 * 在 attachLoopRetro 落盘与登记 loop-retro 产物前调用。
 *
 * @param {Object} run - 运行对象（domain.Run）。
 * @param {string} nodeID - 目标节点 ID。
 * @param {number} iterations - 实际执行的自修正轮次数。
 * @param {Error|null} lastErr - 最后一轮的错误对象（通过时为 null）。
 * @param {string} onFailure - 触发结束时的门禁失败策略。
 * @returns {string} 完整的 Loop 复盘 Markdown 文本。
 */
function buildLoopRetro(run, nodeID, iterations, lastErr, onFailure) {
  const b = [];
  b.push(`# Loop 复盘 — \`${nodeID}\`\n\n`);
  b.push(`- 自修正轮次：${iterations}\n`);
  if (lastErr != null) {
    b.push(`- 最终结果：未通过\n- 最后错误：\`${lastErr.message.replaceAll("\n", " ")}\`\n\n`);
  } else {
    b.push("- 最终结果：通过\n\n");
  }
  const signals = collectLoopRetroSignals(run, nodeID);
  const issues = signals.loopIssues;
  if (signals.missingResult > 0) {
    if (lastErr != null && lastErr.message.includes("without a terminal result")) {
      issues.push("- 执行器退出 0，但 stream-json 没有 `type:result` / `agent.completed`（协议中断，不是门禁失败，也不要先当成 max-turns）");
    } else {
      issues.push("- 执行器有退出 0 但没有 `agent.completed`（可能撞 max-turns / 协议中断）");
    }
  }
  if (lastErr != null && onFailure === "reject") {
    issues.push("- 按门禁 onFailure=reject：打回上游，不在本节点自修正");
  } else if (lastErr != null && onFailure === "fail") {
    issues.push("- 按门禁 onFailure=fail：本节点失败");
  } else if (lastErr != null && onFailure === "human") {
    issues.push("- 按门禁 onFailure=human：转人工确认");
  }
  if (lastErr != null && lastErr.message.includes("without a terminal result")) {
    issues.push("- 沙箱里可能已经写了报告，但节点在登记交付物前就被判失败，所以页面上往往只剩 loop-retro");
  } else if (lastErr != null && lastErr.message.includes("No such file")) {
    issues.push("- 产物未落地或会话提前结束");
  }
  b.push(`## 信号\n\n- agent.completed：${signals.completed}\n- 门禁通过 / 失败：${signals.gatePass} / ${signals.gateFail}\n- 工具调用（finish）：${signals.toolFinishes}\n- 进入自修正：${signals.loopStarts}\n\n`);
  b.push("## 问题\n\n");
  if (issues.length === 0) {
    b.push("- 本节点未发现需要改 Loop 的异常。\n");
  } else {
    b.push(issues.join("\n") + "\n");
  }
  b.push("\n## 建议\n\n");
  switch (true) {
    case lastErr != null && onFailure === "reject":
      b.push("- 按页面配置打回上游，不要再开自修正。\n");
      break;
    case lastErr != null && onFailure === "fail":
      b.push("- 按页面配置结束本节点为失败。\n");
      break;
    case lastErr != null && onFailure === "human":
      b.push("- 按页面配置转人工确认。\n");
      break;
    case lastErr != null && onFailure === "loop":
      b.push("- 自修正轮次已用尽。若应直接打回或失败，到页面改这条门禁的失败策略。\n");
      break;
    case lastErr != null && lastErr.message.includes("without a terminal result"):
      b.push("- 缺 `type:result` 时应交给门禁核对产物，而不是按节点失败整链打回；工具次数远低于 `--max-turns` 时不要写成撞轮次。\n");
      break;
    default:
      b.push("- 失败策略只认门禁 onFailure（loop / reject / fail / human），在 Studio 里改，保存即写库。\n");
      break;
  }
  return b.join("");
}

/**
 * 在节点发生失败或经历了多轮自修正时，生成并保存 loop-retro 复盘文档到工作区与运行产物列表。
 * 在节点执行循环结束后调用；单轮直接通过时不生成复盘文档。
 *
 * @param {string} runID - 运行 ID。
 * @param {string} nodeID - 节点 ID。
 * @param {string} workspace - 控制面工作区根目录（远端上报模式下为空字符串，不写本地文件）。
 * @param {number} iterations - 实际执行的轮次数。
 * @param {Error|null} lastErr - 最后一轮的错误对象（通过时为 null）。
 * @param {string} onFailure - 门禁失败策略。
 * @returns {void} 无返回值。
 */
Engine.prototype.attachLoopRetro = function (runID, nodeID, workspace, iterations, lastErr, onFailure) {
  if (lastErr == null && iterations <= 1) {
    return;
  }
  const [live, ok] = this.repo.Run(runID);
  if (!ok) {
    return;
  }
  let attempt = 0;
  if (live.Nodes[nodeID] != null) {
    attempt = live.Nodes[nodeID].Attempt;
  }
  const body = Buffer.from(buildLoopRetro(live, nodeID, iterations, lastErr, onFailure), "utf8");
  const rel = path.join(".agentflow", "loop-retro-" + nodeID + ".md").replace(/\\/g, "/");
  if (workspace !== "") {
    try {
      fs.mkdirSync(path.join(workspace, ".agentflow"), { recursive: true, mode: 0o755 });
    } catch {}
    try {
      fs.writeFileSync(path.join(workspace, rel), body, { mode: 0o644 });
    } catch {}
  }
  this.updateRun(runID, (r) => {
    appendArtifact(r, nodeID, attempt, "loop-retro", rel, "text/markdown", body);
  });
  this.observe(runID, nodeID, new TelemetryEvent({ Category: "artifact", Name: "artifact.published", Phase: "finish", Message: "loop-retro", Attributes: { path: rel, size: body.length } }));
};

module.exports = { clarifyProcessLog, applyUsage, billedTokens, usageHasValues, addUsage, subUsage, clampNonNeg, shouldSelfCorrect, loopRetroSignals, collectLoopRetroSignals, buildLoopRetro };
