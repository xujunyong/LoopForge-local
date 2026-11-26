// observability.js —— 对应 Go 文件：internal/engine/observability.go
// 作用：执行器遥测加工：进程日志澄清、用量累加与 Loop 复盘产物。
// context.Context 译为 AbortSignal；(值, error) 译为成功返回值、失败 throw，(值, bool) 译为 [值, bool]；strings.Builder 译为字符串数组拼接。

"use strict";

const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath
const { Run, NodeRun, TokenUsage, TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.Run/NodeRun/TokenUsage/TelemetryEvent，run.js 已翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { resolveGateOnFailure } = require("./node_outcome.js"); // 对应 Go 同包函数，node_outcome.js 待翻译
const { appendArtifact } = require("./artifacts.js"); // 对应 Go 同包函数，artifacts.js 已翻译

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

function billedTokens(usage) {
  return usage.InputTokens + usage.OutputTokens;
}

function usageHasValues(usage) {
  return usage.InputTokens > 0 || usage.OutputTokens > 0 || usage.CacheReadTokens > 0 || usage.CacheWriteTokens > 0 || usage.ReasoningTokens > 0 || usage.CostUSD !== 0;
}

function addUsage(dst, src) {
  dst.InputTokens += src.InputTokens;
  dst.OutputTokens += src.OutputTokens;
  dst.CacheReadTokens += src.CacheReadTokens;
  dst.CacheWriteTokens += src.CacheWriteTokens;
  dst.ReasoningTokens += src.ReasoningTokens;
  dst.CostUSD += src.CostUSD;
}

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

function clampNonNeg(v) {
  if (v < 0) {
    return 0;
  }
  return v;
}

function shouldSelfCorrect(onFailure) {
  return resolveGateOnFailure(onFailure, "") === "loop";
}

// loopRetroSignals：统计单个节点的遥测，供 Loop 复盘使用。
class loopRetroSignals {
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
  const body = Buffer.from(buildLoopRetro(live, nodeID, iterations, lastErr, onFailure));
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
