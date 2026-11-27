// gate_bind.js —— 对应 Go 文件：internal/engine/gate_bind.go
// 作用：验证门禁命令重写与绑定：锚定结论正则、为 git diff --quiet 补齐产物与补丁排除路径、为缺少文件参数的裸 grep/rg 自动补齐节点产物文件。
// 职责边界：仅做验证命令字符串的纯文本改写，不执行任何命令或文件系统检查。
// 语法差异说明：Go 的 map[string]bool 集合统一译为普通对象 {}；filepath.ToSlash 译为反斜杠替换。

"use strict";

const path = require("node:path");

const { ArtifactContract } = require("../domain/workflow.js"); // 对应 Go 的 domain.ArtifactContract，workflow.js 已翻译
const { PatchExcludeBasenames } = require("../gitwork/exclude.js"); // 对应 Go 的 gitwork.PatchExcludeBasenames，gitwork 待翻译

/**
 * 按顺序对验证门禁命令应用结论锚定、裸 grep 补产物文件与 git diff 排除项重写。
 * 在执行命令型验证门禁前调用。
 * @param {string} cmd - 原始验证命令字符串。
 * @param {ArtifactContract[]} artifacts - 当前节点声明的产物契约列表。
 * @returns {string} 重写后的最终验证命令。
 */
function bindVerificationCommand(cmd, artifacts) {
  return bindGitDiffQuietExcludes(bindGrepToArtifacts(anchorVerdictGrep(cmd), artifacts), artifacts);
}

/**
 * 为命令中的 ALL_GREEN / NEED_HUMAN 匹配模式加上行首行尾锚点，使其仅匹配独立结论行。
 * 防止报告正文引用这些关键字进行说明时被非锚定 grep 误判为门禁结论。
 * @param {string} cmd - 原始验证命令字符串。
 * @returns {string} 锚定结论匹配模式后的命令字符串。
 */
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

/**
 * 为 `git diff --quiet`（或 `-q`）干净度检查命令追加节点产物与默认补丁排除路径。
 * 避免分析类节点覆写已跟踪的交付物（例如历史提交在集成分支上的 fix-plan.md）时误触发干净度门禁失败。
 * @param {string} cmd - 验证命令字符串。
 * @param {ArtifactContract[]} artifacts - 当前节点声明的产物契约列表。
 * @returns {string} 追加 `:(exclude)` 路径后的命令；非目标 git diff 命令或已含排除项时原样返回。
 */
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
  const excludes = {};
  for (const a of artifacts) {
    const p = (a.Path ?? "").trim().replace(/\\/g, "/");
    if (p !== "" && p !== "." && !path.isAbsolute(p) && !p.startsWith("..")) {
      excludes[p] = true;
    }
  }
  for (const name of Object.keys(PatchExcludeBasenames)) {
    excludes[name] = true;
  }
  const paths = Object.keys(excludes);
  if (paths.length === 0) {
    return cmd;
  }
  paths.sort();
  let out = cmd.trim();
  if (!out.includes(" -- ")) {
    out += " -- .";
  }
  for (const p of paths) {
    out += " ':(exclude)" + p + "'";
  }
  return out;
}

/**
 * 当裸 grep/egrep/fgrep/rg 命令未指定目标文件时，自动在末尾追加当前节点声明的产物文件路径。
 * 避免无文件参数的 grep 读取空标准输入导致门禁必然失败。
 * @param {string} cmd - 验证命令字符串。
 * @param {ArtifactContract[]} artifacts - 当前节点声明的产物契约列表。
 * @returns {string} 补齐产物文件后的命令；非 grep 命令、已包含文件路径或无产物时原样返回。
 */
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
  const seen = {};
  for (const a of artifacts) {
    const p = (a.Path ?? "").trim();
    if (p === "" || seen[p]) {
      continue;
    }
    seen[p] = true;
    files.push(p);
  }
  if (files.length === 0) {
    return cmd;
  }
  return cmd.trim() + " " + files.join(" ");
}

module.exports = { bindVerificationCommand, anchorVerdictGrep, bindGitDiffQuietExcludes, bindGrepToArtifacts };
