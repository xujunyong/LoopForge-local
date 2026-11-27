// gate_submit.js —— 对应 Go 文件：internal/engine/gate_submit.go
// 作用：提交式门禁终态管理：生成结果文件路径与产物契约、清理与校验 submit_gate_result 文件、将 Agent 终态决策映射为引擎流转动作并拼接提示词指令。
// 职责边界：仅负责提交式门禁结果文件的读写校验与决策映射；不负责 MCP 工具端点的具体响应处理或节点状态持久化。
// 语法差异说明：(值, error) 统一译为成功返回值、失败 throw Error；仅返回 error 的函数译为成功返回 undefined、失败 throw Error；applyGateResult 的第一个返回值是表示门禁裁决的数据值（非异常），保留 [Error|null, string, boolean] 三元组。

"use strict";

const fs = require("node:fs");
const filepath = require("node:path");

const { GateResult } = require("../domain/run.js"); // 对应 Go 的 domain.GateResult，run.js 已翻译
const { VerificationGate, ArtifactContract } = require("../domain/workflow.js"); // 对应 Go 的 domain.VerificationGate/ArtifactContract，workflow.js 已翻译
const { safeRunnerPath } = require("./runner_dispatch.js"); // 对应 Go 同包函数，runner_dispatch.js 已翻译
const { workspaceOutputs } = require("./node_outputs.js"); // 对应 Go 同包函数，node_outputs.js 已翻译

/** 提交式门禁结果产物在产物契约中的保留名称。 */
const gateResultArtifactName = "__agentflow_gate_result";
/** 标记节点因缺少有效门禁提交而触发重试的内部标记常量。 */
const gateMissingRetryMarker = "__agentflow_missing_gate_result__";

/**
 * 单次待执行的验证门禁及其失败处理策略，对应 Go 的 verificationRun。
 * 用于在节点执行引擎中排队执行多个验证门禁。
 */
class verificationRun {
  /**
   * 按 Go 结构体零值语义初始化 verificationRun 实例。
   * @param {Object} [init={}] - 可选初始字段。
   * @param {VerificationGate} [init.gate] - 验证门禁定义对象。
   * @param {string} [init.onFailure=""] - 门禁失败时的流转策略。
   * @returns {verificationRun} 初始化后的实例。
   */
  constructor(init = {}) {
    this.gate = init.gate ?? new VerificationGate();
    this.onFailure = init.onFailure ?? "";
  }
}

/**
 * 计算指定节点与重试轮次对应的门禁结果文件相对路径（统一使用正斜杠）。
 * 在准备节点执行环境、清理旧结果或读取本轮 submit_gate_result 时调用。
 * @param {string} nodeID - 节点 ID。
 * @param {number} attempt - 当前执行轮次编号。
 * @returns {string} 工作区内的正斜杠相对路径。
 */
function gateResultPath(nodeID, attempt) {
  return filepath.join(".agentflow", "gate-results", safeRunnerPath(nodeID), `attempt-${attempt}.json`).split(filepath.sep).join("/");
}

/**
 * 为提交式门禁结果文件构造非必填产物契约，便于远端执行机器将其回传到控制面。
 * 在装配节点产物列表时调用。
 * @param {string} path - 门禁结果文件相对路径。
 * @returns {ArtifactContract} 构造完成的 JSON 产物契约对象。
 */
function gateResultContract(path) {
  return new ArtifactContract({ Name: gateResultArtifactName, Path: path, MediaType: "application/json", Required: false });
}

/**
 * 删除工作区内指定路径的历史门禁结果文件，防止上一轮残留结果影响本轮判定。
 * 在节点新轮次启动前或重试清理阶段调用；路径为空时直接返回。
 * @param {string} workspace - 工作区根目录绝对路径。
 * @param {string} path - 门禁结果文件相对路径（正斜杠分隔）。
 * @returns {void} 删除成功或路径为空时无返回值。
 * @throws {Error} 文件系统删除失败时抛出 Error。
 */
function clearGateResult(workspace, path) {
  if ((path ?? "").trim() === "") {
    return;
  }
  fs.rmSync(filepath.join(workspace, path.split("/").join(filepath.sep)), { recursive: true, force: true });
}

/**
 * 从本地沙箱工作区读取并校验 submit_gate_result 写入的门禁结果文件。
 * 在本地执行模式下读取节点提交终态时调用。
 * @param {string} workspace - 工作区根目录绝对路径。
 * @param {string} path - 门禁结果文件相对路径。
 * @returns {GateResult|null} 校验通过的 GateResult 对象；文件不存在时返回 null。
 * @throws {Error} 读取失败、JSON 非法或字段校验不通过时抛出 Error。
 */
function readGateResult(workspace, path) {
  return readGateResultFrom(workspaceOutputs(workspace), path);
}

/**
 * 从统一的产物读取接口（本地工作区或远端上报产物）读取并校验门禁结果 JSON。
 * 在节点执行完成后核验 Agent 提交的终态时调用。
 * @param {Object} outputs - 实现 readFile(rel) 的产物读取器（nodeOutputs）。
 * @param {string} path - 门禁结果文件相对路径。
 * @returns {GateResult|null} 校验并清洗空白后的 GateResult 对象；文件不存在（ENOENT）时返回 null。
 * @throws {Error} 非 ENOENT 读取错误、JSON 解析失败或字段/长度校验不通过时抛出 Error。
 */
function readGateResultFrom(outputs, path) {
  let raw;
  try {
    raw = outputs.readFile(path);
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  let result;
  try {
    result = Object.assign(new GateResult(), JSON.parse(raw.toString("utf8")));
  } catch (parseErr) {
    const err = new Error("submit_gate_result payload is invalid: " + parseErr.message);
    err.cause = parseErr;
    throw err;
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
      throw new Error(`submit_gate_result decision ${JSON.stringify(result.Decision)} is invalid`);
  }
  if (result.Reason === "") {
    throw new Error("submit_gate_result reason is required");
  }
  if (result.Decision === "human" && result.ActionRequired === "") {
    throw new Error("submit_gate_result actionRequired is required for human decisions");
  }
  if (Buffer.byteLength(result.Reason, "utf8") > 4000 || Buffer.byteLength(result.ActionRequired, "utf8") > 4000 || Buffer.byteLength(result.Summary, "utf8") > 4000 || result.Findings.length > 50) {
    throw new Error("submit_gate_result exceeds size limits");
  }
  for (const rawFinding of result.Findings) {
    const finding = rawFinding ?? {};
    if (String(finding.Title ?? "").trim() === "" || Buffer.byteLength(String(finding.Title ?? ""), "utf8") > 500 || Buffer.byteLength(String(finding.Severity ?? ""), "utf8") > 64 || Buffer.byteLength(String(finding.Evidence ?? ""), "utf8") > 4000) {
      throw new Error("submit_gate_result contains an invalid finding");
    }
  }
  return result;
}

/**
 * 将 Agent 提交的终态决策映射为引擎失败处理管线所需的 (裁决错误, 失败策略, 是否打回上游) 三元组。
 * 若决策为 rework 但节点未配置有效的 rejectTarget，则自动降级为终态 fail，避免误报上游返工错误。
 * @param {GateResult|null} result - 已校验的门禁结果对象，为空时视为无需处理。
 * @param {string} rejectTarget - 节点配置的打回目标节点 ID（RejectTo）。
 * @returns {[Error|null, string, boolean]} 三元组 [裁决错误对象或 null, 失败策略（""/"fail"/"reject"/"human"）, 是否触发上游打回]。
 */
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

/**
 * 为启用提交式门禁的节点提示词追加 submit_gate_result 调用规范说明；
 * 当 retry 为 true 时，直接返回要求补交终态的简短追问提示词。
 * @param {string} prompt - 原始节点提示词文本。
 * @param {string} rejectTarget - 节点配置的打回目标节点 ID，用于生成 rework 选项说明。
 * @param {boolean} retry - 是否为缺失有效终态后的补交重试轮次。
 * @returns {string} 拼接终态提交指令后的完整提示词。
 */
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
