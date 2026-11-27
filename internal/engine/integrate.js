/**
 * @file integrate.js
 * 对应 Go 源文件：internal/engine/integrate.go
 * 作用与职责边界：负责定时运行成功后的代码集成合入流程，包括仓库级集成锁、在控制面或执行机器上合并最新集成分支、
 * 冲突回炉重修调度、经工蜂 MR 或直推合入集成分支、补丁新增文件提取与交付完整性校验。
 * 语法差异说明：
 * - Go 的 `context.Context` 译为 `ctx` 参数（`context.Background()` 传 `null`）。
 * - Go 的 `sync.Mutex` 在单线程 JS 中省略；`sync.Map`（`integrationLocks`）保留为 `Map`；
 *   普通 `map[string]V` 与 `map[string]bool` 统一译为普通对象 `{}`。
 * - Go 的 `time.Duration` 换算为毫秒数；`time.Time{}` 零值译为 `null`。
 * - Go 的 `(值, error)` / `error` 译为成功直接返回值、失败 `throw Error`；`(值, bool)` 译为 `[值, boolean]`。
 * - 同包辅助函数按需在函数内延迟 `require`，避免循环依赖。
 */

"use strict";

const { RepositoryProviderSSH, RepositoryContext } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryProviderSSH/RepositoryContext，project.js 已翻译
const { RunnerWorkspaceLayoutShared } = require("../domain/observability.js"); // 对应 Go 的 domain.RunnerWorkspaceLayoutShared，observability.js 已翻译
const { Runner } = require("../domain/runner.js"); // 对应 Go 的 domain.Runner，runner.js 已翻译
const { MergeLatestIntegration, MergeLatestRemoteBranch, EnsureIdentity } = require("../gitwork/integrate.js"); // 对应 Go 的 gitwork.MergeLatestIntegration/MergeLatestRemoteBranch/EnsureIdentity，gitwork 未翻译
const { WithSSHKeys } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork.WithSSHKeys，gitwork 未翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译

// maxIntegrationReworks：集成分支合入冲突允许自动回炉修复的最大次数。
const maxIntegrationReworks = 3;

// integrationLocks：无跨实例锁时使用的进程内仓库锁表（对应 Go 的 sync.Map）。
const integrationLocks = new Map();

/**
 * 判断指定分支名是否与仓库配置的集成分支一致，用于决定是否需要初始化集成分支。
 * 使用场景：工作区准备阶段检出分支时，判断是否正在检出或初始化目标集成分支。
 *
 * @param {object} r - 仓库上下文对象（domain.RepositoryContext）。
 * @param {string} b - 待检查的分支名。
 * @returns {boolean} 仓库配置了集成分支且与 `b` 去空白后相等时返回 `true`。
 */
function shouldSeedIntegrateBranch(r, b) {
  return r.IntegrateBranch.trim() !== "" && r.IntegrateBranch.trim() === b.trim();
}

/**
 * 在指定工作区强制创建/切换到目标集成分支并推送至远端 origin。
 * 使用场景：远端尚未存在集成分支时，以当前基线提交初始化并发布该集成分支。
 *
 * @param {object|null} ctx - 上下文对象。
 * @param {string} w - Git 工作区目录路径。
 * @param {string} b - 要发布的集成分支名。
 * @returns {void} 无返回值。
 * @throws {Error} 切换分支或推送远端失败时抛出错误。
 */
function publishIntegrateBranch(ctx, w, b) {
  const { gitC } = require("./repository_workspace.js");
  ensureGitIdentity(ctx, w);
  gitC(ctx, w, "checkout", "-B", b);
  gitC(ctx, w, "push", "-u", "origin", b);
}

/**
 * 确保工作区已配置有效的 Git 提交身份。
 * 使用场景：执行合并、创建分支或提交前，调用 `gitwork.EnsureIdentity` 补齐身份配置。
 *
 * @param {object|null} ctx - 上下文对象。
 * @param {string} w - Git 工作区目录路径。
 * @returns {void} 无返回值。
 */
function ensureGitIdentity(ctx, w) {
  EnsureIdentity(ctx, w);
}

// IntegrationLocker：把合入某仓库集成分支的操作串行化；repo.DeliveryRepo 跨控制面实例实现它。
// JS 里不声明接口，调用方须提供 LockIntegration(ctx, repositoryID, wait)。

// integrationLockWait：等待跨实例仓库集成锁的最长时间（10 分钟，单位毫秒）。
const integrationLockWait = 10 * 60 * 1000;

/**
 * 获取指定仓库的集成分支串行化锁并返回对应的解锁函数。
 * 使用场景：合入工作分支到集成分支前防止同一仓库的并发集成互相覆盖；无外部锁实现时退化为进程内占位锁。
 *
 * @param {object|null} locks - 实现了 `LockIntegration(ctx, repositoryID, wait)` 的锁对象（如 `repo.DeliveryRepo`），可为 `null`。
 * @param {string} id - 仓库 ID。
 * @returns {Function} 释放本次集成锁的 `unlock()` 回调函数。
 * @throws {Error} 外部跨实例锁获取失败或超时时抛出错误。
 */
function lockIntegration(locks, id) {
  if (locks == null) {
    // Go 的 sync.Mutex 省略，JS 单线程无需加锁；unlock 为空操作。
    let m = integrationLocks.get(id.trim());
    if (m === undefined) {
      m = { Lock() {}, Unlock() {} };
      integrationLocks.set(id.trim(), m);
    }
    m.Lock();
    return m.Unlock;
  }
  return locks.LockIntegration(null, id, integrationLockWait);
}

/**
 * 在定时运行所有节点执行成功后，依次将各仓库的工作分支合入其集成分支。
 * 若合并产生 Git 冲突，则将运行重新入队到修复节点并返回 `true`；全部合入成功或无需合入时返回 `false`。
 * 使用场景：调度器在定时任务整图执行完成后、最终结算为 `succeeded` 之前调用。
 *
 * @param {string} id - 运行 ID。
 * @returns {boolean} 因合并冲突触发回炉修复返回 `true`，否则返回 `false`。
 * @throws {Error} 沙箱缺失、执行机器不存在、锁获取失败、合并/推送或 MR 自动合并失败时抛出错误。
 */
Engine.prototype.integrateScheduledRun = function (id) {
  const { withGitIdentity, withRunGitCredentials, withRepositoryGit } = require("./git_auth.js");
  const { gitC, repositoryWorkspacePath } = require("./repository_workspace.js");
  const [r, ok] = this.repo.RunState(id);
  if (!ok || r.ExecutionContext.ScheduleJobID.trim() === "") {
    return false;
  }
  const repositories = r.RepositoryContexts();
  if (repositories.length === 0) {
    return false;
  }
  // Go 的 e.runEnvMu 省略，JS 单线程无需加锁。
  const env = this.runEnvs[id];
  if (env == null) {
    throw new Error("run sandbox missing");
  }
  const credentials = env.credentialSnapshot();
  let ctx = withGitIdentity(null, credentials.GitUserName, credentials.GitUserEmail);
  ctx = withRunGitCredentials(ctx, credentials);
  ctx = WithSSHKeys(this.withSSHKnownHosts(ctx), credentials.GitSSHKeys);
  const [runner, onRunner] = this.integrationRunner(r);
  if (!onRunner) {
    const missing = this.verifyDeliveryCompleteness(r, env.Workspace());
    if (missing.length > 0) {
      this.updateRun(id, (c) => {
        this.event(c, "", "delivery.incomplete", `交付完整性警告: 以下文件在上游节点产物中产出但未进入交付工作区（可能因跨实例接管丢失），请人工核对 MR 是否包含全部交付物: ${missing.join(", ")}`);
      });
    }
  }
  for (const rc of repositories) {
    const repoCtx = withRepositoryGit(ctx, rc);
    const b = rc.IntegrateBranch.trim();
    const w = rc.WorkBranch.trim();
    if (b === "" || w === "") {
      continue;
    }
    const unlock = lockIntegration(this.repo, rc.RepositoryID);
    try {
      let conflicts;
      let pushDirect;
      if (onRunner) {
        conflicts = this.integrateOnRunner(repoCtx, runner, r, rc, false);
        pushDirect = () => {
          this.integrateOnRunner(repoCtx, runner, r, rc, true);
        };
      } else {
        const workspace = repositoryWorkspacePath(env.Workspace(), rc);
        conflicts = integrateLocally(repoCtx, r, workspace, rc);
        pushDirect = () => {
          gitC(repoCtx, workspace, "push", "origin", "HEAD:refs/heads/" + b);
        };
      }
      if (conflicts != null && conflicts.length > 0) {
        this.requeueIntegrationConflict(id, rc.IntegrateBranch, conflicts);
        return true;
      }
      this.mergeWorkBranchIntoIntegrate(id, r, rc, w, b, pushDirect);
    } finally {
      unlock();
    }
  }
  return false;
};

/**
 * 判断该运行的集成分支合入是否应在执行机器（Runner）上完成。
 * 仅当运行绑定了默认执行机器、采用共享检出布局且该 Runner 支持 `integrate` 动作时返回 `true`，否则在控制面工作区合入。
 * 使用场景：`integrateScheduledRun` 决定走远程 Runner 集成还是本地控制面集成。
 *
 * @param {object} r - 运行对象（domain.Run）。
 * @returns {[object, boolean]} 二元组 `[runner, onRunner]`，分别为 Runner 对象与是否在 Runner 上执行集成。
 * @throws {Error} 指定的默认执行机器不存在时抛出错误。
 */
Engine.prototype.integrationRunner = function (r) {
  const runnerID = this.defaultExecutionRunner(r);
  if (runnerID === "" || r.ExecutionContext.RunnerWorkspaceLayout !== RunnerWorkspaceLayoutShared) {
    return [new Runner(), false];
  }
  const [runner, ok] = this.repo.Runner(runnerID);
  if (!ok) {
    throw new Error(`执行机器 ${runnerID} 不存在`);
  }
  return [runner, runner.SupportsIntegrate()];
};

/**
 * 在控制面工作区中将最新集成分支合入工作分支，无冲突时推送工作分支到远端。
 * 使用场景：非 Runner 共享工作区模式下，由 `integrateScheduledRun` 调用执行本地合并与推送。
 *
 * @param {object|null} ctx - 包含 Git 凭据与身份的上下文对象。
 * @param {object} r - 运行对象（domain.Run）。
 * @param {string} workspace - 目标仓库对应的控制面工作区目录路径。
 * @param {object} rc - 仓库上下文对象（domain.RepositoryContext）。
 * @returns {string[]} 冲突文件列表；无冲突并推送成功时返回空数组 `[]`。
 * @throws {Error} 清理工作区认证、合并过程异常或推送工作分支失败时抛出错误。
 */
function integrateLocally(ctx, r, workspace, rc) {
  const { applyWorkspaceGitAuth } = require("./git_auth.js");
  const { gitC } = require("./repository_workspace.js");
  applyWorkspaceGitAuth(ctx, workspace);
  ensureGitIdentity(ctx, workspace);
  const conflicts = mergeLatestIntegration(ctx, workspace, rc, integrationCommitLabel(r));
  if (conflicts != null && conflicts.length > 0) {
    return conflicts;
  }
  try {
    gitC(ctx, workspace, "push", "origin", rc.WorkBranch);
  } catch (err) {
    throw new Error(`push work branch ${rc.WorkBranch}: ${err.message}`);
  }
  return [];
}

/**
 * 将已推送的工作分支落到目标集成分支：配置了工蜂项目且非 SSH 协议时创建并自动合并 MR，否则调用 `pushDirect` 直推。
 * 使用场景：工作分支合并最新集成分支并推送成功后，执行最终合入并记录运行事件。
 *
 * @param {string} id - 运行 ID。
 * @param {object} r - 运行对象（domain.Run）。
 * @param {object} rc - 仓库上下文对象（domain.RepositoryContext）。
 * @param {string} work - 工作分支名。
 * @param {string} integrate - 集成分支名。
 * @param {Function} pushDirect - 未配置 MR 合入时使用的直推回调函数。
 * @returns {void} 无返回值。
 * @throws {Error} MR 自动合并失败或直推集成分支失败时抛出错误。
 */
Engine.prototype.mergeWorkBranchIntoIntegrate = function (id, r, rc, work, integrate, pushDirect) {
  if (rc.Provider !== RepositoryProviderSSH && this.MergeIntoBranch != null && rc.GongfengProjectID.trim() !== "") {
    const title = integrateMRTitle(r, rc, work, integrate);
    let ref;
    try {
      ref = this.MergeIntoBranch(rc.GongfengProjectID, work, integrate, title, integrateMRDescription(r, work, integrate));
    } catch (err) {
      this.updateRun(id, (c) => {
        this.event(c, "", "mr.auto_merge_failed", `已推送仓库 ${rc.Name} 的工作分支 ${work}，基线 MR（${work} → ${integrate}）自动合并失败（不会直推基线）: ${err.message}`);
      });
      throw new Error(`merge integrate MR ${work} → ${integrate}: ${err.message}`);
    }
    this.updateRun(id, (c) => {
      this.event(c, "", "integration.succeeded", `仓库 ${rc.Name} 已通过 MR ${ref} 合入 ${integrate}（${title}）`);
    });
    return;
  }
  try {
    pushDirect();
  } catch (err) {
    throw new Error(`push integration branch ${integrate}: ${err.message}`);
  }
  this.updateRun(id, (c) => {
    this.event(c, "", "integration.succeeded", "已直推合入 " + integrate + "（未配置 PR 合入集成）");
  });
};

/**
 * 生成工作分支合入集成分支的 MR 标题。
 * 使用场景：通过工蜂自动创建集成 MR 时构造可读标题（区分基线对齐与普通定时需求）。
 *
 * @param {object} r - 运行对象（domain.Run）。
 * @param {object} rc - 仓库上下文对象（domain.RepositoryContext）。
 * @param {string} work - 源工作分支名。
 * @param {string} integrate - 目标集成分支名。
 * @returns {string} 生成的 MR 标题字符串。
 */
function integrateMRTitle(r, rc, work, integrate) {
  if (rc.AlignOnly) {
    let def = rc.DefaultBranch.trim();
    if (def === "") {
      def = work;
    }
    return `LoopForge: 对齐 ${def} → ${integrate}`;
  }
  const label = integrationCommitLabel(r);
  if (label === "" || label === "scheduled SOP work") {
    return `LoopForge: ${work} → ${integrate}`;
  }
  return `LoopForge: ${label} → ${integrate}`;
}

/**
 * 生成工作分支合入集成分支的 MR 描述正文。
 * 使用场景：通过工蜂自动创建集成 MR 时提供来源分支、目标分支、运行 ID 与关联 Issue 说明。
 *
 * @param {object} r - 运行对象（domain.Run）。
 * @param {string} work - 源工作分支名。
 * @param {string} integrate - 目标集成分支名。
 * @returns {string} Markdown 格式的 MR 描述文本。
 */
function integrateMRDescription(r, work, integrate) {
  if (r.Repository.AlignOnly) {
    return `Align the configured main branch into the shared integration baseline.\n\n- run: ${r.ID}\n- source: \`${work}\`\n- target: \`${integrate}\`\n`;
  }
  let b = "Scheduled SOP merge of an issue work branch into the integration baseline.\n\n";
  const n = r.ExecutionContext.IssueNumber;
  if (n > 0) {
    b += `- issue: #${n}\n`;
  }
  b += `- run: ${r.ID}\n`;
  b += `- source: \`${work}\`\n`;
  b += `- target: \`${integrate}\`\n`;
  b += "\nSOP report files are excluded from the baseline. The work branch is kept for history.\n";
  return b;
}

/**
 * 从运行上下文中提取用于集成提交信息或 MR 标题的简短标签（按 Unicode 码点截断至最多 72 个字符）。
 * 使用场景：构造合并提交说明与集成 MR 标题。
 *
 * @param {object} r - 运行对象（domain.Run）。
 * @returns {string} 生成的简短标签（优先包含 Issue 编号与首行标题，其次工作分支名，兜底 `"scheduled SOP work"`）。
 */
function integrationCommitLabel(r) {
  const n = r.ExecutionContext.IssueNumber;
  let title = r.Input.split("\n")[0].trim();
  const rs = [...title];
  if (rs.length > 72) {
    title = rs.slice(0, 72).join("");
  }
  const work = r.Repository.WorkBranch.trim();
  if (n > 0 && title !== "") {
    return `issue #${n} ${title}`;
  }
  if (n > 0) {
    return `issue #${n}`;
  }
  if (work !== "") {
    return work;
  }
  return "scheduled SOP work";
}

/**
 * 委托 `gitwork.MergeLatestIntegration` 将最新集成分支合入当前工作分支。
 * 使用场景：本地控制面集成阶段执行实际 Git 合并。
 *
 * @param {object|null} ctx - 上下文对象。
 * @param {string} w - Git 工作区目录路径。
 * @param {object} r - 仓库上下文对象（domain.RepositoryContext）。
 * @param {string} label - 合并提交标签。
 * @returns {string[]} 合并冲突文件路径列表（无冲突时为空数组）。
 * @throws {Error} Git 命令执行失败时抛出错误。
 */
function mergeLatestIntegration(ctx, w, r, label) {
  return MergeLatestIntegration(ctx, w, r.WorkBranch, r.IntegrateBranch, label);
}

/**
 * 委托 `gitwork.MergeLatestRemoteBranch` 将指定远端分支合入当前工作区。
 * 使用场景：需要同步最新远端分支改动时调用。
 *
 * @param {object|null} ctx - 上下文对象。
 * @param {string} w - Git 工作区目录路径。
 * @param {string} branch - 远端分支名。
 * @returns {string[]} 合并冲突文件路径列表（无冲突时为空数组）。
 * @throws {Error} Git 命令执行失败时抛出错误。
 */
function mergeLatestRemoteBranch(ctx, w, branch) {
  return MergeLatestRemoteBranch(ctx, w, branch);
}

/**
 * 在集成合入发生 Git 冲突时，将修复目标节点及其全部下游节点重置为 `pending`，写入冲突反馈并取消旧子运行。
 * 使用场景：由 `integrateScheduledRun` 在检测到冲突文件时调用，推动 Agent 自动解决冲突并重跑下游流程。
 *
 * @param {string} id - 运行 ID。
 * @param {string} targetBranch - 发生冲突的目标集成分支名。
 * @param {string[]} files - 存在合并冲突的文件路径列表。
 * @returns {void} 无返回值。
 * @throws {Error} 运行不存在、冲突重修次数已达上限或工作流中没有可用修复 Agent 节点时抛出错误。
 */
Engine.prototype.requeueIntegrationConflict = function (id, targetBranch, files) {
  const { descendants } = require("./workflow_graph.js");
  const { appendControlTelemetry } = require("./run_events.js");
  const [r, ok] = this.repo.RunState(id);
  if (!ok) {
    throw new Error("run not found");
  }
  if (r.Repository.IntegrationReworks >= maxIntegrationReworks) {
    throw new Error(`integration conflict unresolved after ${maxIntegrationReworks} attempts: ${files.join(",")}`);
  }
  const target = integrationRepairNode(r.WorkflowSnapshot);
  if (target === "" || r.Nodes[target] == null) {
    throw new Error("workflow has no repair agent");
  }
  const reset = descendants(r.WorkflowSnapshot, target);
  reset[target] = true;
  targetBranch = targetBranch.trim();
  if (targetBranch === "") {
    targetBranch = r.Repository.IntegrateBranch;
  }
  const feedback = `合入 ${targetBranch} 时发生冲突（第 ${r.Repository.IntegrationReworks + 1}/${maxIntegrationReworks} 次）：${files.join(",")}。请保留前序需求的有效实现，解决全部 Git 冲突并完成 git add/commit；下游评审、测试和 MR 会重新执行。`;
  let stale = [];
  this.updateRun(id, (c) => {
    stale.length = 0;
    c.Repository.IntegrationReworks++;
    for (const n of Object.keys(reset)) {
      const nr = c.Nodes[n];
      if (nr != null) {
        stale.push(nr.ChildRunID);
        nr.Status = "pending";
        nr.Error = "";
        nr.Output = "";
        nr.ChildRunID = "";
        nr.FinishedAt = null;
        if (n === target) {
          nr.ReworkCount++;
          nr.Feedback = feedback;
        } else {
          nr.Feedback = "";
        }
      }
    }
    c.Status = "running";
    this.event(c, target, "integration.conflict", feedback);
    appendControlTelemetry(c, target, "integration.conflict", feedback);
  });
  this.cancelLiveChildRuns(stale);
};

/**
 * 从工作流定义中挑选承担集成冲突修复职责的 Agent 节点 ID。
 * 优先级：反向查找配置的 `RejectTo` 目标 Agent → ID 包含修复/实现类关键词的 Agent → 首个 Agent 节点。
 * 使用场景：集成冲突回炉重修时确定应该把冲突反馈派发给哪个节点。
 *
 * @param {object} w - 工作流定义对象（domain.WorkflowDefinition）。
 * @returns {string} 选中的修复 Agent 节点 ID；工作流中无 Agent 节点时返回空字符串。
 */
function integrationRepairNode(w) {
  const by = {};
  for (const n of w.Nodes) {
    by[n.ID] = n;
  }
  for (let i = w.Nodes.length - 1; i >= 0; i--) {
    const key = w.Nodes[i].RejectTo.trim();
    if (Object.prototype.hasOwnProperty.call(by, key) && by[key].Type === "agent") {
      return by[key].ID;
    }
  }
  for (const p of ["fix", "implement", "develop", "repair", "code", "change"]) {
    for (const n of w.Nodes) {
      if (n.Type === "agent" && n.ID.toLowerCase().includes(p)) {
        return n.ID;
      }
    }
  }
  for (const n of w.Nodes) {
    if (n.Type === "agent") {
      return n.ID;
    }
  }
  return "";
}

/**
 * 从统一格式的 Git diff 或 `--name-status` 摘要中提取新增文件路径列表（含二进制新增，忽略改名与修改）。
 * 使用场景：`verifyDeliveryCompleteness` 解析上游节点的 `repository-patch` 产物以核对新增文件是否落入 HEAD。
 *
 * @param {string} diff - 补丁文本（标准 unified git diff 或制表符分隔的变更摘要）。
 * @returns {string[]} 提取出的新增文件相对路径列表。
 */
function patchNewFiles(diff) {
  const { looksLikeGitDiff } = require("./repository_patch.js");
  if (!looksLikeGitDiff(diff)) {
    const files = [];
    for (const line of diff.split("\n")) {
      const fields = line.split("\t");
      if (fields.length >= 2 && fields[0] === "A" && fields[1].trim() !== "") {
        files.push(fields[1]);
      }
    }
    return files;
  }
  const files = [];
  let current = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = "";
      const a = line.indexOf(" a/");
      if (a >= 0) {
        const b = line.indexOf(" b/");
        if (b > a) {
          current = line.slice(a + 3, b).trim();
        }
      }
    } else if (current !== "" && line.startsWith("new file mode")) {
      files.push(current);
      current = "";
    }
  }
  return files;
}

/**
 * 只读检查上游节点补丁产物中新增的源文件是否都已存在于交付工作区的 `HEAD` 提交树中。
 * 该检查绝不修改工作区，仅返回缺失文件及产出节点信息，供上层发出交付完整性警告。
 * 使用场景：控制面执行定时运行集成前，排查因跨实例接管导致的未提交上游文件遗漏问题。
 *
 * @param {object} r - 运行对象（domain.Run）。
 * @param {string} workspace - 运行工作区根目录路径。
 * @returns {string[]} 按字典序排序的缺失文件说明列表（格式 `<路径> (produced by <节点ID>)`），无缺失或无补丁产物时返回空数组 `[]`。
 */
Engine.prototype.verifyDeliveryCompleteness = function (r, workspace) {
  const { repositoryPatchApplyBody } = require("./repository_patch.js");
  const { gitC, repositoryWorkspacePath } = require("./repository_workspace.js");
  // dir -> path -> producing node；RepositoryDir 为空的旧版持久化检出产物仍映射到工作区根。
  const expected = {};
  for (const a of r.Artifacts) {
    let body = repositoryPatchApplyBody(a);
    if (body === "") {
      body = a.Content;
    }
    if (a.Name !== "repository-patch" || body.trim() === "") {
      continue;
    }
    const dir = a.RepositoryDir.trim();
    if (!Object.prototype.hasOwnProperty.call(expected, dir)) {
      expected[dir] = {};
    }
    for (const filePath of patchNewFiles(body)) {
      if (!Object.prototype.hasOwnProperty.call(expected[dir], filePath) || a.NodeID === "mr") {
        expected[dir][filePath] = a.NodeID;
      }
    }
  }
  if (Object.keys(expected).length === 0) {
    return [];
  }
  const knownDirs = {};
  for (const rc of r.RepositoryContexts()) {
    knownDirs[rc.WorkspaceDir] = repositoryWorkspacePath(workspace, rc);
  }
  const missing = [];
  for (const [dir, paths] of Object.entries(expected)) {
    let repoWorkspace = knownDirs[dir];
    if (repoWorkspace === undefined) {
      repoWorkspace = repositoryWorkspacePath(workspace, new RepositoryContext({ WorkspaceDir: dir }));
    }
    let out;
    try {
      out = gitC(null, repoWorkspace, "ls-tree", "-r", "--name-only", "HEAD");
    } catch {
      continue;
    }
    const present = {};
    for (let line of out.split("\n")) {
      line = line.trim();
      if (line !== "") {
        present[line] = true;
      }
    }
    for (const [filePath, node] of Object.entries(paths)) {
      if (present[filePath]) {
        continue;
      }
      let label = filePath;
      if (dir !== "") {
        label = dir + "/" + filePath;
      }
      missing.push(`${label} (produced by ${node})`);
    }
  }
  missing.sort();
  return missing;
};

module.exports = { maxIntegrationReworks, integrationLocks, shouldSeedIntegrateBranch, publishIntegrateBranch, ensureGitIdentity, integrationLockWait, lockIntegration, integrateLocally, integrateMRTitle, integrateMRDescription, integrationCommitLabel, mergeLatestIntegration, mergeLatestRemoteBranch, integrationRepairNode, patchNewFiles };
