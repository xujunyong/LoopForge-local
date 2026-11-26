// gate_submit.js —— 对应 Go 文件：internal/engine/gate_submit.go
// 作用：提交式门禁终态：读写 gate 结果文件并映射 Agent 的终态决定。

"use strict";

const fs = require("node:fs");
const filepath = require("node:path");

const { GateResult } = require("../domain/run.js"); // 对应 Go 的 domain.GateResult，run.js 已翻译
const { VerificationGate, ArtifactContract } = require("../domain/workflow.js"); // 对应 Go 的 domain.VerificationGate/ArtifactContract，workflow.js 已翻译

const gateResultArtifactName = "__agentflow_gate_result";
const gateMissingRetryMarker = "__agentflow_missing_gate_result__";

class verificationRun {
  constructor(init = {}) {
    this.gate = init.gate ?? null;
    this.onFailure = init.onFailure ?? "";
  }
}

function gateResultPath(nodeID, attempt) {
  return filepath.join(".agentflow", "gate-results", safeRunnerPath(nodeID), `attempt-${attempt}.json`).split(filepath.sep).join("/");
}

function gateResultContract(path) {
  return new ArtifactContract({ Name: gateResultArtifactName, Path: path, MediaType: "application/json", Required: false });
}

function clearGateResult(workspace, path) {
  if ((path ?? "").trim() === "") {
    return null;
  }
  try {
    fs.rmSync(filepath.join(workspace, path.split("/").join(filepath.sep)), { recursive: true, force: true });
    return null;
  } catch (err) {
    return err;
  }
}

function readGateResult(workspace, path) {
  return readGateResultFrom(workspaceOutputs(workspace), path);
}

function readGateResultFrom(outputs, path) {
  const [raw, err] = outputs.readFile(path);
  if (err != null) {
    if (err.code === "ENOENT") {
      return [null, null];
    }
    return [null, err];
  }
  let result;
  try {
    result = Object.assign(new GateResult(), JSON.parse(raw.toString("utf8")));
  } catch (parseErr) {
    return [null, new Error("submit_gate_result payload is invalid: " + parseErr.message)];
  }
  result.Decision = String(result.Decision ?? "").trim().toLowerCase();
  result.Reason = String(result.Reason ?? "").trim();
  result.ActionRequired = String(result.ActionRequired ?? "").trim();
  result.Summary = String(result.Summary ?? "").trim();
  if (result.Findings == null) {
    result.Findings = [];
  }
  switch (result.Decision) {
    case "pass":
    case "rework":
    case "fail":
    case "human":
      break;
    default:
      return [null, new Error(`submit_gate_result decision ${JSON.stringify(result.Decision)} is invalid`)];
  }
  if (result.Reason === "") {
    return [null, new Error("submit_gate_result reason is required")];
  }
  if (result.Decision === "human" && result.ActionRequired === "") {
    return [null, new Error("submit_gate_result actionRequired is required for human decisions")];
  }
  if (Buffer.byteLength(result.Reason, "utf8") > 4000 || Buffer.byteLength(result.ActionRequired, "utf8") > 4000 || Buffer.byteLength(result.Summary, "utf8") > 4000 || result.Findings.length > 50) {
    return [null, new Error("submit_gate_result exceeds size limits")];
  }
  for (const rawFinding of result.Findings) {
    const finding = rawFinding ?? {};
    if (String(finding.Title ?? "").trim() === "" || Buffer.byteLength(String(finding.Title ?? ""), "utf8") > 500 || Buffer.byteLength(String(finding.Severity ?? ""), "utf8") > 64 || Buffer.byteLength(String(finding.Evidence ?? ""), "utf8") > 4000) {
      return [null, new Error("submit_gate_result contains an invalid finding")];
    }
  }
  return [result, null];
}

function applyGateResult(result, rejectTarget) {
  if (result == null) {
    return [null, "", false];
  }
  switch (result.Decision) {
    case "pass":
      return [null, "", false];
    case "rework":
      if ((rejectTarget ?? "").trim() === "") {
        return [new Error(`agent requested rework but this node has no rework target (rejectTo); treated as fail: ${result.Reason}`), "fail", false];
      }
      return [new Error(`agent requested upstream rework: ${result.Reason}`), "reject", true];
    case "fail":
      return [new Error(`agent submitted terminal failure: ${result.Reason}`), "fail", false];
    case "human":
      return [new Error(`agent requested human confirmation: ${result.Reason}`), "human", false];
    default:
      return [new Error(`unsupported agent terminal decision ${JSON.stringify(result.Decision)}`), "fail", false];
  }
}

function appendSubmitGateInstruction(prompt, rejectTarget, retry) {
  if (retry) {
    return "刚才没有收到有效的节点终态。不要重复执行任务，也不要只输出文字；请立刻调用 submit_gate_result，提交 pass、rework、fail 或 human 之一以及具体 reason。选择 human 时还必须填写 actionRequired，明确需要人工确认什么。只有工具调用成功才算完成本节点。";
  }
  let reworkInstruction = "- rework：存在应由上游节点返工的问题；平台会自动打回该节点；";
  if ((rejectTarget ?? "").trim() === "") {
    reworkInstruction = "- rework：本节点没有配置返工目标，不可选择；需要直接终止时请选择 fail；";
  } else {
    reworkInstruction = `- rework：存在应由上游节点「${rejectTarget}」返工的问题；平台会自动打回；`;
  }
  return prompt.replace(/\n+$/, "") + `

# 必须提交节点终态

完成任务后必须调用 MCP 工具 submit_gate_result，提交唯一终态：
- pass：任务正常完成；平台会自动流转到下游节点；
${reworkInstruction}
- fail：本节点无法完成或出现不可恢复错误；平台会直接标记失败，不打回上游；
- human：无法可靠自动判断，或必须由人决策；平台会暂停并等待人工确认，此时 actionRequired 必填，必须明确说明需要人确认或决定什么。

必须根据当前真实情况选择，不要把 fail 当成 rework，也不要用 human 掩盖明确失败。reason 必须解释作出该终态的事实依据；rework 可用 actionRequired 写清返工要求；可附带 findings 和 evidence。不要用报告文本或最终回复代替工具调用。只有该工具调用成功，本节点才算完成。`;
}

module.exports = { gateResultArtifactName, gateMissingRetryMarker, verificationRun, gateResultPath, gateResultContract, clearGateResult, readGateResult, readGateResultFrom, applyGateResult, appendSubmitGateInstruction };
