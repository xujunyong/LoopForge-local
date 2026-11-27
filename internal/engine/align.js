/**
 * @file align.js
 * 对应 Go 源文件：internal/engine/align.go
 * 作用与职责边界：负责仓库基线对齐逻辑，包括对齐工作流执行器覆写、集成分支与默认分支冲突错误定义及渲染、
 * 仅对齐运行的审批自动通过判断，以及在临时工作区中将默认分支合并到集成分支并推送。
 * 语法差异说明：
 * - Go 的 `(T, error)` / `error` 返回值统一转为直接返回值与失败 `throw Error`。
 * - Go 的 `context.Context` 参数以 `ctx` 透传，`context.Background()` 传 `null`。
 * - Go 的 `defer` 清理动作通过 `try ... finally` 实现。
 */

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

// BaselineAlignWorkflowID：内置 SOP，在派发定时需求任务前先解决默认分支到集成分支的合并冲突。
const BaselineAlignWorkflowID = "scheduled-baseline-align";

/**
 * 根据环境变量为内置基线对齐工作流配置解析角色的执行器。
 * 使用场景：启动基线对齐工作流前，若配置了 `AGENTFLOW_BASELINE_ALIGN_EXECUTOR`，则覆写对齐 Agent 节点的执行器。
 *
 * @param {object} wf - 工作流定义对象（domain.WorkflowDefinition）。
 * @returns {object} 处理后的工作流定义对象。
 * @throws {Error} 环境变量指定的执行器不在内置执行器列表中时抛出错误。
 */
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

/**
 * 基线对齐冲突错误，表示共享集成分支与仓库默认分支已分叉，该仓库的定时需求派发必须等待冲突解决。
 * 使用场景：基线对齐合并产生冲突并中止合并后抛出，供调度器暂停派发并向对齐 Agent 与界面展示冲突详情。
 */
class AlignConflictError extends Error {
  /**
   * 创建基线对齐冲突错误实例，并按 Go 零值规则初始化字段。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.Integrate=""] - 集成分支名称。
   * @param {string} [init.Default=""] - 仓库默认分支名称。
   * @param {string[]} [init.Files=[]] - 发生冲突的文件路径列表。
   * @param {object[]} [init.Blocks=[]] - 提取出的冲突代码块列表（domain.ConflictBlock[]）。
   */
  constructor(init = {}) {
    super();
    this.Integrate = init.Integrate ?? "";
    this.Default = init.Default ?? "";
    this.Files = init.Files ?? [];
    this.Blocks = init.Blocks ?? [];
    this.message = this.Error();
  }

  /**
   * 格式化冲突错误消息，对应 Go 的 `Error()` 方法。
   * 使用场景：构造错误提示文案或供调用方获取人类可读的冲突说明。
   *
   * @returns {string} 包含集成分支、默认分支与冲突文件列表的中文错误说明。
   */
  Error() {
    let files = this.Files.join(", ");
    if (files === "") {
      files = "unknown";
    }
    return `集成分支 ${this.Integrate} 与默认分支 ${this.Default} 存在冲突（${files}）。已暂停该仓库的定时派发；对齐 Agent 正在自动解决并合入基线，完成后定时任务会继续`;
  }

  /**
   * 将提取出的冲突块渲染为带标注的 Markdown 片段。
   * 使用场景：拼装对齐 Agent 提示词或在平台界面展示冲突内容；无冲突块（如仅二进制文件冲突）时返回空串。
   *
   * @returns {string} Markdown 格式的冲突块文本；无冲突块时返回空字符串。
   */
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

/**
 * 判断指定运行实例是否属于“仅做基线对齐”的运行。
 * 使用场景：控制基线对齐运行的审批跳过、推进策略及特殊分支行为。
 *
 * @param {object} r - 运行实例对象（domain.Run）。
 * @returns {boolean} 属于基线对齐工作流或任一仓库上下文标记了 `AlignOnly` 时返回 `true`，否则返回 `false`。
 */
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

/**
 * 判断基线对齐运行当前是否有审批节点正处于等待审批状态。
 * 使用场景：引擎巡检或状态恢复时判断是否需要自动通过对齐审批节点。
 *
 * @param {object} r - 运行实例对象（domain.Run）。
 * @returns {boolean} 是仅对齐运行且存在 `waiting_approval` 状态审批节点时返回 `true`，否则返回 `false`。
 */
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

/**
 * 自动将基线对齐运行中处于等待审批状态的审批节点置为成功，并恢复运行状态为 `running`。
 * 使用场景：基线对齐流程无需人工卡点时，推进等待中的审批节点继续执行。
 *
 * @param {object|null} r - 运行实例对象（domain.Run），允许为 `null`。
 * @param {Date} now - 标记审批节点完成所使用的当前时间。
 * @returns {boolean} 至少修改了一个审批节点状态时返回 `true`，否则返回 `false`。
 */
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

/**
 * 判断给定仓库上下文是否需要执行集成分支基线对齐。
 * 使用场景：调度器或合并前检查集成分支与默认分支是否均已配置且指向不同分支。
 *
 * @param {object} r - 仓库上下文对象（domain.RepositoryContext）。
 * @returns {boolean} 集成分支与默认分支均非空且不指向同一分支时返回 `true`，否则返回 `false`。
 */
function ShouldAlignIntegrate(r) {
  const integ = NormalizeBranchName(r.IntegrateBranch);
  const def = NormalizeBranchName(r.DefaultBranch);
  return integ !== "" && def !== "" && !SameGitBranch(integ, def);
}

/**
 * 将仓库默认分支合入共享集成分支；无冲突时直接推送，有冲突时中止合并并抛出 `AlignConflictError`。
 * 使用场景：定时任务派发前对齐集成分支基线，保证远端集成分支在冲突时保持原状。
 *
 * @param {object} repository - 仓库上下文对象（domain.RepositoryContext）。
 * @param {object} credentials - 运行凭据对象（runtime.RunCredentials）。
 * @param {object} locks - 集成锁管理器（IntegrationLocker）。
 * @returns {void} 无返回值。
 * @throws {AlignConflictError|Error} 发生合并冲突时抛出 `AlignConflictError`，其他 Git 或锁异常抛出 `Error`。
 */
function AlignIntegrateBaseline(repository, credentials, locks) {
  // Go 的 context.Background() 无 JS 对应写法，传 null。
  return alignIntegrateBaseline(withRunGitCredentials(null, credentials), repository, locks);
}

/**
 * 基线对齐核心实现：在临时目录检出集成分支，加集成锁后合入远端默认分支并推送。
 * 使用场景：由 `AlignIntegrateBaseline` 及同包内部流程调用。
 *
 * @param {object|null} ctx - 携带 Git 凭据与仓库信息的上下文对象。
 * @param {object} repository - 仓库上下文对象（domain.RepositoryContext）。
 * @param {object} locks - 集成锁管理器（IntegrationLocker）。
 * @returns {void} 无返回值。
 * @throws {AlignConflictError|Error} 合并冲突时中止合并并抛出 `AlignConflictError`，其余失败抛出 `Error`。
 */
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

/**
 * 从工作区冲突文件中提取冲突代码块。
 * 使用场景：基线对齐合并失败后，在中止合并前采集冲突片段。
 *
 * @param {string} dir - 本地 Git 工作区目录路径。
 * @param {string[]} files - 存在合并冲突的相对文件路径列表。
 * @returns {object[]} 提取出的冲突代码块数组（domain.ConflictBlock[]）。
 */
function extractConflictBlocks(dir, files) {
  return ExtractConflictBlocks(dir, files);
}

/**
 * 解析单个文件内容中的 Git 冲突标记。
 * 使用场景：提取指定文件内最多 `max` 个冲突块供展示或提示词组装。
 *
 * @param {string} file - 冲突文件路径标识。
 * @param {Buffer|string} data - 冲突文件的原始内容。
 * @param {number} max - 最多解析的冲突块数量。
 * @returns {object[]} 解析出的冲突代码块数组（domain.ConflictBlock[]）。
 */
function parseConflictMarkers(file, data, max) {
  return ParseConflictMarkers(file, data, max);
}

module.exports = { BaselineAlignWorkflowID, BaselineAlignAgentID, configureBaselineAlignCLI, AlignConflictError, alignOnlyRun, alignRunWaitingApproval, autoSucceedAlignApprovals, ShouldAlignIntegrate, AlignIntegrateBaseline, alignIntegrateBaseline, extractConflictBlocks, parseConflictMarkers };
