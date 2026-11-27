/**
 * @file human_context.js
 * 对应 Go 源文件：internal/engine/human_context.go
 * 作用与职责边界：负责人工补充上下文的拼装、写入运行状态与产物列表、原子落盘 `human-context.md`，
 * 以及产物路径段清洗与媒体类型扩展名映射。
 * 语法差异说明：
 * - Go 的 `os.CreateTemp` 译为使用 `crypto.randomBytes` 生成临时文件名并以 `"wx"` 独占创建。
 * - Go 的 `defer os.Remove(temp.Name())` 译为 `try ... finally` 中的容错删除。
 * - 同包函数 `appendArtifact` 采用函数内延迟 `require`，避免与 `artifacts.js` 循环依赖。
 */

"use strict";

const crypto = require("node:crypto"); // Go os.CreateTemp 的随机后缀
const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath

// maxHumanContextBytes：单次人工补充上下文允许保留的最大长度上限。
const maxHumanContextBytes = 8000;

/**
 * 将审批/驳回原因与人工补充上下文拼装为统一反馈文本，并在超长时截断上下文。
 * 使用场景：人工介入审批、驳回或继续运行时，构造注入给下游节点的反馈说明。
 *
 * @param {string} reason - 人工填写的原因或操作说明。
 * @param {string} context - 人工补充的上下文正文。
 * @returns {string} 拼装后的反馈文本；两者皆空时返回空字符串。
 */
function composeHumanFeedback(reason, context) {
  reason = reason.trim();
  context = context.trim();
  if (context !== "" && context.length > maxHumanContextBytes) {
    context = context.slice(0, maxHumanContextBytes);
  }
  if (context === "") {
    return reason;
  }
  if (reason === "") {
    return "人工补充上下文：\n" + context;
  }
  return reason + "\n\n人工补充上下文：\n" + context;
}

/**
 * 将人工补充上下文追加记入运行对象 `r.HumanContext`，同时生成 `human-context.md` 产物并返回完整反馈文本。
 * 使用场景：处理人工审批、人工输入或干预指令时持久化上下文供后续节点读取。
 *
 * @param {object} r - 运行对象（domain.Run），会被原地更新 `HumanContext` 与 `Artifacts`。
 * @param {string} nodeID - 触发本次人工补充的节点 ID。
 * @param {string} reason - 人工原因说明。
 * @param {string} context - 人工补充的上下文正文。
 * @returns {string} 经 `composeHumanFeedback` 拼装后的完整反馈文本。
 */
function recordHumanContext(r, nodeID, reason, context) {
  const { appendArtifact } = require("./artifacts.js");
  const note = composeHumanFeedback(reason, context);
  let ctx = context.trim();
  if (ctx === "") {
    return note;
  }
  if (ctx.length > maxHumanContextBytes) {
    ctx = ctx.slice(0, maxHumanContextBytes);
  }
  const prev = r.HumanContext.trim();
  if (prev !== "" && prev !== ctx) {
    r.HumanContext = prev + "\n\n---\n" + ctx;
  } else {
    r.HumanContext = ctx;
  }
  let attempt = 0;
  const nr = r.Nodes[nodeID];
  if (nr != null) {
    attempt = nr.Attempt;
  }
  appendArtifact(r, nodeID, attempt, "human-context", "human-context.md", "text/markdown", Buffer.from("# 人工补充上下文\n\n" + ctx + "\n", "utf8"));
  return note;
}

/**
 * 通过写临时文件再原子重命名的方式，将人工补充上下文写入工作区根目录的 `human-context.md`。
 * 使用场景：节点执行前同步最新人工上下文到工作区，避免并行分支的 CLI 读到半截或截断文件。
 *
 * @param {string} workspace - 工作区根目录路径。
 * @param {string} note - 要写入的人工补充上下文内容。
 * @returns {void} 无返回值。
 * @throws {Error} 创建临时文件、写入、修改权限或重命名失败时抛出错误。
 */
function writeHumanContextFile(workspace, note) {
  note = note.trim();
  if (note === "" || workspace.trim() === "") {
    return;
  }
  // 经改名替换：并行分支的 CLI 可能正在读该文件，绝不能看到截断后的内容。
  const target = path.join(workspace, "human-context.md");
  const content = Buffer.from("# 人工补充上下文\n\n" + note + "\n", "utf8");
  try {
    const existing = fs.readFileSync(target);
    if (existing.equals(content)) {
      return;
    }
  } catch {}
  const temp = path.join(workspace, ".human-context-" + crypto.randomBytes(8).toString("hex") + ".md");
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeSync(fd, content);
    fs.fchmodSync(fd, 0o644);
    fs.closeSync(fd);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
    throw err;
  }
  try {
    fs.renameSync(temp, target);
  } finally {
    // Go 的 defer os.Remove：改名后临时路径已不存在，删除忽略错误。
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
  }
}

/**
 * 过滤字符串中的非安全字符，仅保留 ASCII 字母、数字、连字符与下划线；结果为空时回退为 `"artifact"`。
 * 使用场景：构造产物或交接输入文件的相对路径片段，防止路径穿越或非法文件名。
 *
 * @param {string} value - 原始路径片段字符串。
 * @returns {string} 清洗后的安全路径片段。
 */
function safePathSegment(value) {
  let b = "";
  for (const r of value) {
    if ((r >= "a" && r <= "z") || (r >= "A" && r <= "Z") || (r >= "0" && r <= "9") || r === "-" || r === "_") {
      b += r;
    }
  }
  if (b === "") {
    return "artifact";
  }
  return b;
}

/**
 * 根据产物的媒体类型返回对应的文件扩展名。
 * 使用场景：为产物落盘生成默认文件名后缀。
 *
 * @param {string} mediaType - MIME 媒体类型（如 `"text/markdown"`、`"application/json"`）。
 * @returns {string} 对应的扩展名（`".md"`、`".json"` 或 `".txt"`）。
 */
function extensionFor(mediaType) {
  if (mediaType === "text/markdown" || mediaType === "") {
    return ".md";
  }
  if (mediaType === "application/json") {
    return ".json";
  }
  return ".txt";
}

module.exports = { maxHumanContextBytes, composeHumanFeedback, recordHumanContext, writeHumanContextFile, safePathSegment, extensionFor };
