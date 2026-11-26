// integrate.js —— 对应 Go 文件：internal/engine/integrate.go
// 作用：定时运行成功后把工作分支合入集成分支：冲突回炉重修，否则经 MR 或直推合入。
// context.Context 译为 AbortSignal（context.Background() 译为 null）；sync.Mutex 省略，sync.Map 译为 Map；time.Duration 换算为毫秒；(值, error) 译为成功返回值、失败 throw；(值, bool) 译为 [值, bool]。

"use strict";

const { RepositoryProviderSSH, RepositoryContext } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryProviderSSH/RepositoryContext，project.js 已翻译
const { RunnerWorkspaceLayoutShared } = require("../domain/observability.js"); // 对应 Go 的 domain.RunnerWorkspaceLayoutShared，observability.js 已翻译
const { Runner } = require("../domain/runner.js"); // 对应 Go 的 domain.Runner，runner.js 已翻译
const { MergeLatestIntegration, MergeLatestRemoteBranch, EnsureIdentity } = require("../gitwork/integrate.js"); // 对应 Go 的 gitwork.MergeLatestIntegration/MergeLatestRemoteBranch/EnsureIdentity，gitwork 未翻译
const { WithSSHKeys } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork.WithSSHKeys，gitwork 未翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译

const maxIntegrationReworks = 3;

const integrationLocks = new Map();

function shouldSeedIntegrateBranch(r, b) {
  return r.IntegrateBranch.trim() !== "" && r.IntegrateBranch.trim() === b.trim();
}

function publishIntegrateBranch(ctx, w, b) {
  ensureGitIdentity(ctx, w);
  gitC(ctx, w, "checkout", "-B", b);
  gitC(ctx, w, "push", "-u", "origin", b);
}

function ensureGitIdentity(ctx, w) {
  EnsureIdentity(ctx, w);
}

// IntegrationLocker：把合入某仓库集成分支的操作串行化；repo.DeliveryRepo 跨控制面实例实现它。
// JS 里不声明接口，调用方须提供 LockIntegration(ctx, repositoryID, wait)。

const integrationLockWait = 10 * 60 * 1000;

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

// integrateScheduledRun：定时运行成功后把各仓库工作分支合入集成分支；冲突送回修复节点时报告 true。
Engine.prototype.integrateScheduledRun = function (id) {
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
      unlock();
      return true;
    }
    this.mergeWorkBranchIntoIntegrate(id, r, rc, w, b, pushDirect);
    unlock();
  }
  return false;
};

// integrationRunner：报告该运行的合入是否发生在执行机器上：运行在执行机器上、有共享检出且 runner 理解 integrate 动作；否则在控制面工作区合入。
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

// integrateLocally：在控制面工作区把最新集成分支合入工作分支并推送工作分支。
function integrateLocally(ctx, r, workspace, rc) {
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
  return null;
}

// mergeWorkBranchIntoIntegrate：已推送的工作分支经 Gongfeng MR 落到集成分支，未配 Gongfeng 时直推。
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

function mergeLatestIntegration(ctx, w, r, label) {
  return MergeLatestIntegration(ctx, w, r.WorkBranch, r.IntegrateBranch, label);
}

function mergeLatestRemoteBranch(ctx, w, branch) {
  return MergeLatestRemoteBranch(ctx, w, branch);
}

Engine.prototype.requeueIntegrationConflict = function (id, targetBranch, files) {
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
  reset.set(target, true);
  targetBranch = targetBranch.trim();
  if (targetBranch === "") {
    targetBranch = r.Repository.IntegrateBranch;
  }
  const feedback = `合入 ${targetBranch} 时发生冲突（第 ${r.Repository.IntegrationReworks + 1}/${maxIntegrationReworks} 次）：${files.join(",")}。请保留前序需求的有效实现，解决全部 Git 冲突并完成 git add/commit；下游评审、测试和 MR 会重新执行。`;
  let stale = [];
  this.updateRun(id, (c) => {
    stale.length = 0;
    c.Repository.IntegrationReworks++;
    for (const n of reset.keys()) {
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

function integrationRepairNode(w) {
  const by = new Map();
  for (const n of w.Nodes) {
    by.set(n.ID, n);
  }
  for (let i = w.Nodes.length - 1; i >= 0; i--) {
    const n = by.get(w.Nodes[i].RejectTo.trim());
    if (n !== undefined && n.Type === "agent") {
      return n.ID;
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

// patchNewFiles：从统一 git diff 里提取新增文件路径（"new file mode" 条目）；二进制新增也包含，改名与修改忽略。
function patchNewFiles(diff) {
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

// verifyDeliveryCompleteness：上游节点补丁产出的源文件未进入交付工作区时告警；只检查不改动工作区。
Engine.prototype.verifyDeliveryCompleteness = function (r, workspace) {
  // dir -> path -> producing node；RepositoryDir 为空的旧版持久化检出产物仍映射到工作区根。
  const expected = new Map();
  for (const a of r.Artifacts) {
    let body = repositoryPatchApplyBody(a);
    if (body === "") {
      body = a.Content;
    }
    if (a.Name !== "repository-patch" || body.trim() === "") {
      continue;
    }
    const dir = a.RepositoryDir.trim();
    if (!expected.has(dir)) {
      expected.set(dir, new Map());
    }
    for (const path of patchNewFiles(body)) {
      if (!expected.get(dir).has(path) || a.NodeID === "mr") {
        expected.get(dir).set(path, a.NodeID);
      }
    }
  }
  if (expected.size === 0) {
    return null;
  }
  const knownDirs = new Map();
  for (const rc of r.RepositoryContexts()) {
    knownDirs.set(rc.WorkspaceDir, repositoryWorkspacePath(workspace, rc));
  }
  const missing = [];
  for (const [dir, paths] of expected) {
    let repoWorkspace = knownDirs.get(dir);
    if (repoWorkspace === undefined) {
      repoWorkspace = repositoryWorkspacePath(workspace, new RepositoryContext({ WorkspaceDir: dir }));
    }
    let out;
    try {
      out = gitC(null, repoWorkspace, "ls-tree", "-r", "--name-only", "HEAD");
    } catch {
      continue;
    }
    const present = new Set();
    for (let line of out.split("\n")) {
      line = line.trim();
      if (line !== "") {
        present.add(line);
      }
    }
    for (const [path, node] of paths) {
      if (present.has(path)) {
        continue;
      }
      let label = path;
      if (dir !== "") {
        label = dir + "/" + path;
      }
      missing.push(`${label} (produced by ${node})`);
    }
  }
  missing.sort();
  return missing;
};

module.exports = { maxIntegrationReworks, integrationLocks, shouldSeedIntegrateBranch, publishIntegrateBranch, ensureGitIdentity, integrationLockWait, lockIntegration, patchNewFiles, integrateMRTitle, integrateMRDescription, integrationCommitLabel, mergeLatestIntegration, mergeLatestRemoteBranch, integrationRepairNode };
