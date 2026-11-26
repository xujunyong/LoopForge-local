// align.js —— 对应 Go 文件：internal/engine/align.go
// 作用：基线对齐：把默认分支合入集成分支，冲突时暂停定时派发并返回冲突内容。

"use strict";

const fs = require("node:fs"); // Go os
const os = require("node:os"); // Go os.TempDir
const path = require("node:path"); // Go path/filepath
const { BaselineAlignAgentID } = require("../domain/agent.js"); // 对应 Go 的 domain.BaselineAlignAgentID，domain 已翻译；同时是本文件的同名常量
const { NormalizeBranchName, SameGitBranch } = require("../domain/mr.js"); // 对应 Go 的 domain.NormalizeBranchName/SameGitBranch，domain 已翻译
const { NormalizeIntegrateBranch } = require("../domain/sync.js"); // 对应 Go 的 domain.NormalizeIntegrateBranch，domain 已翻译
const { ExtractConflictBlocks, ParseConflictMarkers } = require("../domain/conflict_blocks.js"); // 对应 Go 的 domain.ExtractConflictBlocks/ParseConflictMarkers，domain 已翻译
const { BuiltInExecutor } = require("../repo/catalog.js"); // 对应 Go 的 repo.BuiltInExecutor，repo 已翻译
require("../runtime/runtime.js"); // 对应 Go 的 runtime.RunCredentials，runtime.js 待翻译

// BaselineAlignWorkflowID：内置 SOP，先解决默认分支到集成分支的冲突再派发定时任务。
const BaselineAlignWorkflowID = "scheduled-baseline-align";

function configureBaselineAlignCLI(wf) {
  if (wf.ID !== BaselineAlignWorkflowID) {
    return wf;
  }
  const executorID = (process.env.AGENTFLOW_BASELINE_ALIGN_EXECUTOR ?? "").trim();
  if (executorID === "") {
    return wf;
  }
  const [, ok] = BuiltInExecutor(executorID);
  if (!ok) {
    throw new Error(`AGENTFLOW_BASELINE_ALIGN_EXECUTOR: unsupported executor ${JSON.stringify(executorID)}`);
  }
  wf.Nodes = [...wf.Nodes];
  for (let i = 0; i < wf.Nodes.length; i++) {
    const node = wf.Nodes[i];
    if (node.Type === "agent" && node.AgentID === BaselineAlignAgentID) {
      wf.Nodes[i].ExecutorID = executorID;
    }
  }
  return wf;
}

// AlignConflictError：集成分支与默认分支分叉，该仓库的定时派发须等待。
class AlignConflictError extends Error {
  constructor(init = {}) {
    super();
    this.Integrate = init.Integrate ?? "";
    this.Default = init.Default ?? "";
    this.Files = init.Files ?? [];
    this.Blocks = init.Blocks ?? [];
    this.message = this.Error();
  }

  // Error：Go 的 Error() 方法。
  Error() {
    let files = this.Files.join(", ");
    if (files === "") {
      files = "unknown";
    }
    return `集成分支 ${this.Integrate} 与默认分支 ${this.Default} 存在冲突（${files}）。已暂停该仓库的定时派发；对齐 Agent 正在自动解决并合入基线，完成后定时任务会继续`;
  }

  // RenderBlocks：把冲突块渲染为带标注的 markdown 片段，供对齐 Agent 提示词与平台界面使用。
  RenderBlocks() {
    if (this.Blocks.length === 0) {
      return "";
    }
    // Go strings.Builder 译为字符串拼接。
    let b = "";
    for (const blk of this.Blocks) {
      b += `\n### 冲突文件 ${blk.File}\n\`\`\`text\n<<<<<<< ours（集成分支 ${this.Integrate}）\n${blk.Ours}\n=======\n${blk.Theirs}\n>>>>>>> theirs（默认分支 ${this.Default}）\n\`\`\`\n`;
    }
    return b;
  }
}

function alignOnlyRun(r) {
  if (r.WorkflowID === BaselineAlignWorkflowID || r.WorkflowSnapshot.ID === BaselineAlignWorkflowID) {
    return true;
  }
  if (r.Repository.AlignOnly) {
    return true;
  }
  for (const rc of r.RepositoryContexts()) {
    if (rc.AlignOnly) {
      return true;
    }
  }
  return false;
}

function alignRunWaitingApproval(r) {
  if (!alignOnlyRun(r)) {
    return false;
  }
  for (const node of r.WorkflowSnapshot.Nodes) {
    if (node.Type !== "approval") {
      continue;
    }
    const nr = r.Nodes[node.ID];
    if (nr != null && nr.Status === "waiting_approval") {
      return true;
    }
  }
  return false;
}

function autoSucceedAlignApprovals(r, now) {
  if (r == null || !alignOnlyRun(r)) {
    return false;
  }
  let changed = false;
  for (const node of r.WorkflowSnapshot.Nodes) {
    if (node.Type !== "approval") {
      continue;
    }
    const nr = r.Nodes[node.ID];
    if (nr == null || nr.Status !== "waiting_approval") {
      continue;
    }
    nr.Status = "succeeded";
    nr.FinishedAt = now;
    changed = true;
  }
  if (changed) {
    r.Status = "running";
  }
  return changed;
}

function ShouldAlignIntegrate(r) {
  const integ = NormalizeBranchName(r.IntegrateBranch);
  const def = NormalizeBranchName(r.DefaultBranch);
  return integ !== "" && def !== "" && !SameGitBranch(integ, def);
}

function AlignIntegrateBaseline(repository, credentials, locks) {
  // Go 的 context.Background() 无 JS 对应写法，传 null。
  return alignIntegrateBaseline(withRunGitCredentials(null, credentials), repository, locks);
}

function alignIntegrateBaseline(ctx, repository, locks) {
  if (!ShouldAlignIntegrate(repository)) {
    return;
  }
  if (repository.CloneURL.trim() === "" && repository.LocalPath.trim() === "") {
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-align-"));
  try {
    // Go：work := repository，结构体值复制。
    const work = { ...repository };
    work.WorkBranch = "";
    work.IntegrateBranch = NormalizeIntegrateBranch(repository.IntegrateBranch);
    work.BaseBranch = work.IntegrateBranch;
    ctx = withRepositoryGit(ctx, work);
    prepareRepository(ctx, dir, work);
    const unlock = lockIntegration(locks, repository.RepositoryID);
    try {
      ensureGitIdentity(ctx, dir);
      let conflicts;
      try {
        conflicts = mergeLatestRemoteBranch(ctx, dir, work.DefaultBranch);
      } catch (err) {
        throw new Error(`merge ${work.DefaultBranch} into ${work.IntegrateBranch}: ${err.message}`);
      }
      if (conflicts.length > 0) {
        const blocks = extractConflictBlocks(dir, conflicts);
        // Go 的 `_, _ =` 丢弃返回值与错误。
        try {
          gitC(ctx, dir, "merge", "--abort");
        } catch {}
        throw new AlignConflictError({ Integrate: work.IntegrateBranch, Default: work.DefaultBranch, Files: conflicts, Blocks: blocks });
      }
      try {
        gitC(ctx, dir, "push", "origin", "HEAD:refs/heads/" + work.IntegrateBranch);
      } catch (err) {
        throw new Error(`push aligned integration branch ${work.IntegrateBranch}: ${err.message}`);
      }
    } finally {
      unlock();
    }
  } finally {
    // Go 的 defer os.RemoveAll 忽略错误。
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function extractConflictBlocks(dir, files) {
  return ExtractConflictBlocks(dir, files);
}

function parseConflictMarkers(file, data, max) {
  return ParseConflictMarkers(file, data, max);
}

module.exports = { BaselineAlignWorkflowID, BaselineAlignAgentID, configureBaselineAlignCLI, AlignConflictError, alignOnlyRun, alignRunWaitingApproval, autoSucceedAlignApprovals, ShouldAlignIntegrate, AlignIntegrateBaseline, alignIntegrateBaseline, extractConflictBlocks, parseConflictMarkers };
