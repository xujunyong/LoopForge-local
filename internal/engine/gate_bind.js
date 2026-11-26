// gate_bind.js —— 对应 Go 文件：internal/engine/gate_bind.go
// 作用：门禁命令绑定：锚定结论 grep、给 git diff 加排除、给裸 grep 补产物文件。

"use strict";

const path = require("node:path");

const { ArtifactContract } = require("../domain/workflow.js"); // 对应 Go 的 domain.ArtifactContract，workflow.js 已翻译
const { PatchExcludeBasenames } = require("../gitwork/exclude.js"); // 对应 Go 的 gitwork.PatchExcludeBasenames，gitwork 待翻译

function bindVerificationCommand(cmd, artifacts) {
  return bindGitDiffQuietExcludes(bindGrepToArtifacts(anchorVerdictGrep(cmd), artifacts), artifacts);
}

function anchorVerdictGrep(cmd) {
  const replacements = [
    { from: "ALL_GREEN[[:space:]]*=[[:space:]]*true", to: "^[[:space:]]*ALL_GREEN[[:space:]]*=[[:space:]]*true[[:space:]]*$" },
    { from: "NEED_HUMAN[[:space:]]*=[[:space:]]*true", to: "^[[:space:]]*NEED_HUMAN[[:space:]]*=[[:space:]]*true[[:space:]]*$" },
  ];
  let out = cmd;
  for (const item of replacements) {
    if (out.includes(item.to)) {
      continue;
    }
    out = out.split(item.from).join(item.to);
  }
  return out;
}

function bindGitDiffQuietExcludes(cmd, artifacts) {
  const fields = (cmd ?? "").trim() === "" ? [] : (cmd ?? "").trim().split(/\s+/);
  if (fields.length < 3 || fields[0] !== "git" || fields[1] !== "diff") {
    return cmd;
  }
  let quiet = false;
  for (const f of fields.slice(2)) {
    if (f === "--quiet" || f === "-q") {
      quiet = true;
      break;
    }
  }
  if (!quiet || cmd.includes(":(exclude)") || cmd.includes(":!")) {
    return cmd;
  }
  const excludes = new Set();
  for (const a of artifacts) {
    const p = (a.Path ?? "").trim().replace(/\\/g, "/");
    if (p !== "" && p !== "." && !path.isAbsolute(p) && !p.startsWith("..")) {
      excludes.add(p);
    }
  }
  for (const name of Object.keys(PatchExcludeBasenames)) {
    excludes.add(name);
  }
  if (excludes.size === 0) {
    return cmd;
  }
  const paths = [...excludes].sort();
  let out = cmd.trim();
  if (!out.includes(" -- ")) {
    out += " -- .";
  }
  for (const p of paths) {
    out += " ':(exclude)" + p + "'";
  }
  return out;
}

function bindGrepToArtifacts(cmd, artifacts) {
  const fields = (cmd ?? "").trim() === "" ? [] : (cmd ?? "").trim().split(/\s+/);
  if (fields.length === 0) {
    return cmd;
  }
  switch (fields[0]) {
    case "grep":
    case "egrep":
    case "fgrep":
    case "rg":
      break;
    default:
      return cmd;
  }
  for (const a of artifacts) {
    const p = (a.Path ?? "").trim();
    if (p !== "" && cmd.includes(p)) {
      return cmd;
    }
  }
  for (const f of fields.slice(1)) {
    if (f.startsWith("-")) {
      continue;
    }
    if (f.includes("/") || f.endsWith(".md") || f.endsWith(".txt") || f.endsWith(".json")) {
      return cmd;
    }
  }
  const files = [];
  const seen = new Set();
  for (const a of artifacts) {
    const p = (a.Path ?? "").trim();
    if (p === "" || seen.has(p)) {
      continue;
    }
    seen.add(p);
    files.push(p);
  }
  if (files.length === 0) {
    return cmd;
  }
  return cmd.trim() + " " + files.join(" ");
}

module.exports = { bindVerificationCommand, anchorVerdictGrep, bindGitDiffQuietExcludes, bindGrepToArtifacts };
