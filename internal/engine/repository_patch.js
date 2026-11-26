// repository_patch.js —— 对应 Go 文件：internal/engine/repository_patch.go
// 作用：仓库补丁：工作区改动清单、diff 解析汇总与补丁落盘应用。
// (值, error) 译为成功返回值、失败 throw。

"use strict";

const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath
const { randomBytes } = require("node:crypto"); // Go crypto/rand
const { spawnSync } = require("node:child_process"); // Go os/exec
const { PatchInventory, RenderPatchInventory } = require("../gitwork/patch.js"); // 对应 Go 的 gitwork.PatchInventory/RenderPatchInventory，gitwork 待翻译

// collectRepositoryPatch：交给下游节点的工作区改动文件名清单；见 gitwork.PatchInventory。
function collectRepositoryPatch(workspace) {
  return PatchInventory(workspace);
}

// patchFileSummary：gitwork.PatchFileSummary 的别名。
class patchFileSummary {
  constructor(init = {}) {
    this.Path = init.Path ?? "";
    this.Status = init.Status ?? "";
    this.RenameFrom = init.RenameFrom ?? "";
    this.Binary = init.Binary ?? false;
    this.Added = init.Added ?? 0;
    this.Deleted = init.Deleted ?? 0;
  }
}

function repositoryPatchApplyBody(artifact) {
  if (looksLikeGitDiff(artifact.Content)) {
    return artifact.Content;
  }
  return "";
}

function repositoryPatchSummary(artifact) {
  const body = artifact.Content.trim();
  if (body !== "" && !looksLikeGitDiff(body)) {
    return body;
  }
  const raw = repositoryPatchApplyBody(artifact);
  if (raw !== "") {
    return summarizeRepositoryPatch(Buffer.from(raw));
  }
  return artifact.Content.trim();
}

function looksLikeGitDiff(patch) {
  const s = patch.replace(/^[\ufeff \t\r\n]+/, "");
  return s.startsWith("diff --git ") || s.startsWith("--- ");
}

function summarizeRepositoryPatch(diff) {
  return RenderPatchInventory(parseUnifiedDiffFiles(diff));
}

function parseUnifiedDiffFiles(diff) {
  const files = [];
  let cur = null;
  const flush = () => {
    if (cur == null || cur.Path === "") {
      cur = null;
      return;
    }
    if (cur.Status === "") {
      cur.Status = "M";
    }
    files.push({ ...cur });
    cur = null;
  };
  for (const line of diff.toString("utf8").split("\n")) {
    switch (true) {
      case line.startsWith("diff --git "): {
        flush();
        const [src, dst] = splitGitDiffHeader(line);
        cur = new patchFileSummary({ Path: dst, Status: "M" });
        if (dst === "") {
          cur.Path = src;
        }
        break;
      }
      case cur == null:
        continue;
      case line.startsWith("new file mode"):
        cur.Status = "A";
        break;
      case line.startsWith("deleted file mode"):
        cur.Status = "D";
        break;
      case line.startsWith("rename from "):
        cur.Status = "R";
        cur.RenameFrom = line.slice("rename from ".length).trim();
        break;
      case line.startsWith("rename to "):
        cur.Status = "R";
        cur.Path = line.slice("rename to ".length).trim();
        break;
      case line.startsWith("GIT binary patch") || line.startsWith("Binary files "):
        cur.Binary = true;
        cur.Status = "B";
        break;
      case line.startsWith("+++ ") || line.startsWith("--- "):
        continue;
      case !cur.Binary && line.startsWith("+"):
        cur.Added++;
        break;
      case !cur.Binary && line.startsWith("-"):
        cur.Deleted++;
        break;
    }
  }
  flush();
  return files;
}

function splitGitDiffHeader(line) {
  const rest = line.trim().slice("diff --git ".length);
  const a = rest.indexOf("a/");
  const b = rest.lastIndexOf(" b/");
  if (a < 0 || b <= a) {
    return ["", ""];
  }
  const src = rest.slice(a + 2, b).replace(/^"+|"+$/g, "");
  const dst = rest.slice(b + 3).trim().replace(/^"+|"+$/g, "");
  return [src, dst];
}

function applyRepositoryPatch(workspace, patch) {
  if (patch.trim() === "" || !looksLikeGitDiff(patch)) {
    return;
  }
  // Go os.CreateTemp 用随机后缀建临时文件；JS 直接拼一个随机名。
  const tmpPath = path.join(workspace, `agentflow-patch-${randomBytes(6).toString("hex")}.diff`);
  fs.writeFileSync(tmpPath, patch);
  try {
    const result = spawnSync("git", ["-C", workspace, "apply", "--whitespace=nowarn", tmpPath], { encoding: "utf8" });
    if (result.error != null || result.status !== 0) {
      const cause = result.error != null ? result.error.message : `exit status ${result.status}`;
      // Go CombinedOutput 合并 stdout 与 stderr；这里把两者拼接。
      throw new Error(`${cause}: ${((result.stdout ?? "") + (result.stderr ?? "")).trim()}`);
    }
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
  }
}

module.exports = { collectRepositoryPatch, patchFileSummary, repositoryPatchApplyBody, repositoryPatchSummary, looksLikeGitDiff, summarizeRepositoryPatch, parseUnifiedDiffFiles, splitGitDiffHeader, applyRepositoryPatch };
