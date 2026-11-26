// human_context.js —— 对应 Go 文件：internal/engine/human_context.go
// 作用：人工补充上下文：拼装反馈、记入运行、落盘 human-context.md。

"use strict";

const crypto = require("node:crypto"); // Go os.CreateTemp 的随机后缀
const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath

const maxHumanContextBytes = 8000;

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

function recordHumanContext(r, nodeID, reason, context) {
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
