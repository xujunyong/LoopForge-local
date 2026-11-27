/**
 * @file internal/engine/repository_patch.js
 * 对应 Go 源文件：internal/engine/repository_patch.go
 *
 * 作用与职责边界：
 * 负责仓库补丁相关的工具逻辑，包括采集工作区变更文件清单、识别与解析 unified diff、
 * 生成供下游节点阅读的补丁摘要，以及将补丁落盘并通过 `git apply` 应用到工作区。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 返回译为成功返回值、失败 `throw err`；仅返回 `error` 的函数译为成功无返回值（`undefined`）、失败 `throw err`。
 * - Go 的 `defer os.Remove(tmp.Name())` 译为 `try { ... } finally { fs.rmSync(...); }`。
 * - Go 的 `[]byte` 在 JS 中以 `Buffer` 表示。
 */

"use strict";

const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath
const { randomBytes } = require("node:crypto"); // Go crypto/rand
const { spawnSync } = require("node:child_process"); // Go os/exec
const { PatchInventory, RenderPatchInventory } = require("../gitwork/patch.js"); // 对应 Go 的 gitwork.PatchInventory/RenderPatchInventory，gitwork 待翻译

/**
 * 采集当前工作区变更的文件名清单，供传递给下游工作流节点。
 * 使用场景：节点执行完毕后汇总仓库改动产物，详见 `gitwork.PatchInventory`。
 *
 * @param {string} workspace - Git 工作区目录路径。
 * @returns {Buffer} 渲染后的变更清单字节内容。
 * @throws {Error} 读取工作区状态或生成清单失败时抛出错误。
 */
function collectRepositoryPatch(workspace) {
  return PatchInventory(workspace);
}

/**
 * 单个补丁文件的变更摘要，对应 Go 类型别名 `type patchFileSummary = gitwork.PatchFileSummary`。
 * 使用场景：解析 unified diff 时按文件累计新增/删除行数、重命名与二进制标记。
 */
class patchFileSummary {
  /**
   * 构造并初始化单个补丁文件摘要对象，缺省字段严格按 Go 零值填充。
   *
   * @param {object} [init={}] - 可选初始字段映射。
   * @param {string} [init.Path=""] - 目标文件路径。
   * @param {string} [init.Status=""] - 变更状态码（如 `"M"`、`"A"`、`"D"`、`"R"`、`"B"`）。
   * @param {string} [init.RenameFrom=""] - 重命名前的原文件路径。
   * @param {boolean} [init.Binary=false] - 是否为二进制文件变更。
   * @param {number} [init.Added=0] - 新增行数。
   * @param {number} [init.Deleted=0] - 删除行数。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Path = init.Path ?? "";
    this.Status = init.Status ?? "";
    this.RenameFrom = init.RenameFrom ?? "";
    this.Binary = init.Binary ?? false;
    this.Added = init.Added ?? 0;
    this.Deleted = init.Deleted ?? 0;
  }
}

/**
 * 从产物中提取可直接用于 `git apply` 的补丁正文。
 * 使用场景：判断上游补丁产物是否为原始 Git diff，以便决定是否可应用到工作区。
 *
 * @param {object} artifact - 产物对象（`domain.Artifact`，含 `Content` 字符串）。
 * @returns {string} 若产物内容符合 Git diff 格式则返回原内容，否则返回空字符串 `""`。
 */
function repositoryPatchApplyBody(artifact) {
  if (looksLikeGitDiff(artifact.Content)) {
    return artifact.Content;
  }
  return "";
}

/**
 * 生成仓库补丁产物的可读变更摘要。
 * 使用场景：向下游提示词或界面展示补丁概要；若产物本身已是摘要清单则直接返回，否则解析 diff 并渲染清单。
 *
 * @param {object} artifact - 产物对象（`domain.Artifact`，含 `Content` 字符串）。
 * @returns {string} 去除首尾空白后的补丁摘要文本。
 */
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

/**
 * 判断给定文本是否以标准 Git diff 或 unified diff 头部开头。
 * 使用场景：区分原始补丁正文与已渲染的变更文件清单。
 *
 * @param {string} patch - 待检测的补丁文本。
 * @returns {boolean} 忽略前导 BOM 与空白后以 `"diff --git "` 或 `"--- "` 开头则返回 `true`，否则返回 `false`。
 */
function looksLikeGitDiff(patch) {
  const s = patch.replace(/^[\ufeff \t\r\n]+/, "");
  return s.startsWith("diff --git ") || s.startsWith("--- ");
}

/**
 * 将原始 unified diff 字节内容解析并渲染为可读的文件变更清单。
 * 使用场景：从历史原始 diff 产物生成紧凑的文件级别摘要。
 *
 * @param {Buffer} diff - 原始 diff 字节内容。
 * @returns {string} 渲染后的文件变更清单文本。
 */
function summarizeRepositoryPatch(diff) {
  return RenderPatchInventory(parseUnifiedDiffFiles(diff));
}

/**
 * 逐行解析 unified diff，提取每个变更文件的状态、路径及增删行统计。
 * 使用场景：由 `summarizeRepositoryPatch` 调用，构造 `RenderPatchInventory` 所需的文件摘要列表。
 *
 * @param {Buffer} diff - 原始 diff 字节内容。
 * @returns {patchFileSummary[]} 按出现顺序排列的文件变更摘要数组。
 */
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
    files.push(new patchFileSummary(cur));
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

/**
 * 从 `diff --git a/<src> b/<dst>` 头部行中拆出源路径与目标路径。
 * 使用场景：在 `parseUnifiedDiffFiles` 遇到新文件块时解析文件路径。
 *
 * @param {string} line - 以 `"diff --git "` 开头的 diff 头部行。
 * @returns {[string, string]} 返回 `[src, dst]` 二元组；格式无法解析时返回 `["", ""]`。
 */
function splitGitDiffHeader(line) {
  const trimmed = line.trim();
  const rest = trimmed.startsWith("diff --git ") ? trimmed.slice("diff --git ".length) : trimmed;
  const a = rest.indexOf("a/");
  const b = rest.lastIndexOf(" b/");
  if (a < 0 || b <= a) {
    return ["", ""];
  }
  const src = rest.slice(a + 2, b).replace(/^"+|"+$/g, "");
  const dst = rest.slice(b + 3).trim().replace(/^"+|"+$/g, "");
  return [src, dst];
}

/**
 * 将 Git diff 补丁写入临时文件并通过 `git apply --whitespace=nowarn` 应用到指定工作区，完成后清理临时文件。
 * 使用场景：在重放或恢复工作区变更时将上游补丁产物落盘应用；空内容或非 diff 文本直接跳过。
 *
 * @param {string} workspace - 目标 Git 工作区目录路径。
 * @param {string} patch - 待应用的补丁文本。
 * @returns {void} 无返回值。
 * @throws {Error} 创建临时文件失败或 `git apply` 执行失败时抛出错误。
 */
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
