// repository_workspace.js —— 对应 Go 文件：internal/engine/repository_workspace.go
// 作用：运行仓库工作区：多仓库规整、克隆 / 恢复 / 快照、工作分支检出与基线记录。
// context.Context 译为 AbortSignal；仅返回 error 的函数译为失败 throw；(值, error) 译为 [值, error]，(值, bool) 译为 [值, bool]；time.Duration 译为毫秒数。

"use strict";

const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath
const { randomBytes } = require("node:crypto"); // Go crypto/rand
const { spawnSync } = require("node:child_process"); // Go os/exec
const { SafeGitRefSegment } = require("../domain/work_branch.js"); // 对应 Go 的 domain.SafeGitRefSegment，work_branch.js 已翻译
const { ValidateRemoteURL } = require("../gitwork/remote.js"); // 对应 Go 的 gitwork.ValidateRemoteURL，gitwork 待翻译
const { UsesSSH } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork.UsesSSH，gitwork 待翻译
const { Watch, Run, C, RevParse, CloneStallEnv, CloneTimeoutEnv } = require("../gitwork/git.js"); // 对应 Go 的 gitwork.Watch/Run/C/RevParse/CloneStallEnv/CloneTimeoutEnv，gitwork 待翻译
const { BaselinePath, RecordBaseline } = require("../gitwork/patch.js"); // 对应 Go 的 gitwork.BaselinePath/RecordBaseline，gitwork 待翻译
const { Stopped, DurationEnv } = require("../procwatch/procwatch.js"); // 对应 Go 的 procwatch.Stopped/DurationEnv，procwatch 待翻译
const { RestoreLegacyWorkspaceAgentConfig } = require("../runtime/git_isolation.js"); // 对应 Go 的 runtime.RestoreLegacyWorkspaceAgentConfig，runtime 待翻译
const { cloneFromRepositoryCache } = require("./repository_cache.js"); // 对应 Go 同包函数，repository_cache.js 本批翻译
const { withRepositoryGit, cloneRemoteForGit, applyWorkspaceGitAuth, applyWorkspaceGitIdentity } = require("./git_auth.js"); // 对应 Go 同包函数，git_auth.js 待翻译
const { shouldSeedIntegrateBranch, publishIntegrateBranch, ensureGitIdentity } = require("./integrate.js"); // 对应 Go 同包函数，integrate.js 待翻译

// normalizeRepositories：去掉空的 / 重复的仓库条目，保持顺序。
function normalizeRepositories(repositories) {
  const seen = new Set();
  const out = [];
  for (const rc of repositories) {
    if (rc.RepositoryID.trim() === "" || seen.has(rc.RepositoryID)) {
      continue;
    }
    seen.add(rc.RepositoryID);
    out.push(rc);
  }
  return out;
}

// repositoryWorkspacePath：返回 rc 在运行工作区里的检出目录。新运行总会指定 WorkspaceDir；空 WorkspaceDir 是沿用旧布局、直接检出在工作区根目录的持久化数据。
function repositoryWorkspacePath(workspace, rc) {
  const dir = rc.WorkspaceDir.trim();
  if (dir !== "") {
    return path.join(workspace, dir.split("/").join(path.sep));
  }
  return workspace;
}

// repositoryWorkspaceDirs：列出一次运行的全部 git 检出目录：每个绑定仓库一个，未绑定仓库时返回工作区根目录。
function repositoryWorkspaceDirs(workspace, repositories) {
  if (repositories.length === 0) {
    return [workspace];
  }
  const dirs = [];
  for (const rc of repositories) {
    dirs.push(repositoryWorkspacePath(workspace, rc));
  }
  return dirs;
}

// prepareRepositories：把每个运行仓库检出到各自的 WorkspaceDir（运行工作区下的一级子目录）。
function prepareRepositories(ctx, workspace, repositories) {
  RestoreLegacyWorkspaceAgentConfig(ctx, workspace, repositories);
  for (const rc of repositories) {
    try {
      prepareRepository(ctx, repositoryWorkspacePath(workspace, rc), rc);
    } catch (e) {
      throw new Error(`repository ${rc.Name}: ${e.message}`);
    }
  }
}

function repositoryBaseBranch(repository) {
  let branch = repository.BaseBranch.trim();
  if (branch !== "") {
    return branch;
  }
  branch = repository.DefaultBranch.trim();
  if (branch !== "") {
    return branch;
  }
  return "master";
}

function existingDevelopmentBranch(repository) {
  const branch = repository.WorkBranch.trim();
  if (branch === "" || repository.AlignOnly) {
    return false;
  }
  for (const shared of [repository.BaseBranch, repository.DefaultBranch, repository.IntegrateBranch, "master", "main"]) {
    if (branch === shared.trim()) {
      return false;
    }
  }
  return true;
}

function prepareRepository(ctx, workspace, repository) {
  if (repository.RepositoryID === "") {
    return;
  }
  ctx = withRepositoryGit(ctx, repository);
  if (repository.RequireExistingWorkBranch && !existingDevelopmentBranch(repository)) {
    throw new Error("continuing an existing branch requires a development branch distinct from the main and integration branches");
  }
  if (repository.CreateNewWorkBranch) {
    if (repository.RequireExistingWorkBranch) {
      throw new Error("a work branch cannot both continue an existing branch and be newly created");
    }
    if (!existingDevelopmentBranch(repository)) {
      throw new Error("creating a work branch requires a development branch name distinct from the main and integration branches");
    }
  }
  try {
    fs.mkdirSync(workspace, { recursive: true, mode: 0o755 });
  } catch (e) {
    throw new Error(`create repository directory: ${e.message}`);
  }
  let hasGit = false;
  try {
    fs.statSync(path.join(workspace, ".git"));
    hasGit = true;
  } catch {}
  if (hasGit) {
    resumeRepository(ctx, workspace, repository);
    return;
  }
  let localPath = repository.LocalPath.trim();
  const cloneURL = repository.CloneURL.trim();
  let localIsDir = false;
  let localIsGit = false;
  if (localPath !== "") {
    let info = null;
    try {
      info = fs.statSync(localPath);
    } catch {}
    if (info == null || !info.isDirectory()) {
      if (cloneURL === "") {
        throw new Error(`localPath is not a readable directory: ${localPath}`);
      }
      // localPath 只是克隆缓存（--reference）。新机器上常留着另一台机器的 Studio 路径，退回 cloneUrl。
      localPath = "";
    } else {
      localIsDir = true;
      try {
        fs.statSync(path.join(localPath, ".git"));
        localIsGit = true;
      } catch {}
    }
  }
  if (localIsDir && !localIsGit && cloneURL === "") {
    prepareLocalSnapshotRepository(ctx, workspace, localPath, repository);
    return;
  }
  let remote = cloneURL;
  if (remote === "") {
    remote = localPath;
  }
  if (remote === "") {
    throw new Error("repository has neither localPath nor cloneUrl");
  }
  try {
    ValidateRemoteURL(remote, true);
  } catch (e) {
    throw new Error(`git clone: ${e.message}`);
  }
  const baseBranch = repositoryBaseBranch(repository);
  const clone = (branch, useReference) => {
    if (useReference) {
      const [cloned, err] = cloneFromRepositoryCache(ctx, workspace, repository, branch);
      if (cloned || err != null) {
        if (err != null) {
          throw err;
        }
        return;
      }
    }
    // --progress：没有终端时 git 在结束前什么都不打印，慢克隆看起来和挂起一样。
    const args = ["clone", "--progress", "--no-hardlinks", "--single-branch", "--branch", branch];
    const watch = cloneWatch(repository);
    if (useReference && localIsGit && cloneURL !== "" && localPath !== cloneURL) {
      args.push("--reference", localPath, "--dissociate");
      // --dissociate 在传输后静默 repack，大体积本地缓存可能在那里耗时数分钟且毫无输出。
      watch.Stall = 0;
    }
    // 克隆进已存在的目录（`.`），git 就不能 unlink 再重建 `workspace`。该 inode 是 Docker 绑定挂载源。
    args.push("--", cloneRemoteForGit(ctx, remote), ".");
    const [, err] = Watch(ctx, workspace, watch, ...args);
    if (err != null) {
      throw new Error(`git clone: ${err.message}`);
    }
  };
  // Docker 会绑定挂载这个目录。替换它（RemoveAll + MkdirAll）会改变 inode，runc 随后拒绝 `docker exec -w /workspace`。
  let reset = resetCloneDestination;
  if (liveDockerSandbox(workspace)) {
    reset = () => {};
  }
  reset(workspace);
  let cloneErr = null;
  try {
    clone(baseBranch, true);
  } catch (e) {
    cloneErr = e;
  }
  if (cloneErr != null) {
    const err = cloneErr;
    // 下面的重试能从坏 --reference 缓存或空远端恢复。克隆是停滞、超时或超过调用方等待时间的，重试只会在同一网络上重复同样的等待。
    if (Stopped(err) || (ctx instanceof AbortSignal && ctx.aborted)) {
      throw err;
    }
    if (UsesSSH(ctx) && !localIsGit) {
      throw err;
    }
    reset(workspace);
    let retryErr = null;
    try {
      clone(baseBranch, false);
    } catch (e) {
      retryErr = e;
    }
    if (retryErr != null) {
      if (UsesSSH(ctx)) {
        throw retryErr; // SSH 检出永远不初始化远端分支。
      }
      const [seeded, seedErr] = seedEmptyRepository(ctx, workspace, cloneRemoteForGit(ctx, remote), repository.DefaultBranch, baseBranch, reset);
      if (seeded) {
        if (seedErr != null) {
          throw seedErr;
        }
      } else if (!shouldSeedIntegrateBranch(repository, baseBranch)) {
        throw err;
      } else {
        reset(workspace);
        let seed = repository.DefaultBranch.trim();
        if (seed === "") {
          seed = "master";
        }
        let seedCloneErr = null;
        try {
          clone(seed, false);
        } catch (e) {
          seedCloneErr = e;
        }
        if (seedCloneErr != null) {
          throw err;
        }
        let pub = null;
        try {
          publishIntegrateBranch(ctx, workspace, baseBranch);
        } catch (e) {
          pub = e;
        }
        if (pub != null) {
          reset(workspace);
          let retry = null;
          try {
            clone(baseBranch, false);
          } catch (e) {
            retry = e;
          }
          if (retry != null) {
            throw new Error(`create integration branch ${baseBranch}: ${pub.message}`);
          }
        }
      }
    }
  }
  applyWorkspaceGitAuth(ctx, workspace);
  applyWorkspaceGitIdentity(ctx, workspace);
  const origin = cloneURL.trim();
  if (origin !== "") {
    const [, err] = gitC(ctx, workspace, "remote", "set-url", "--", "origin", origin);
    if (err != null) {
      throw new Error(`set origin url: ${err.message}`);
    }
  }
  if (shouldSeedIntegrateBranch(repository, baseBranch)) {
    fetchRemoteWorkBranch(ctx, workspace, baseBranch);
  }
  for (const gitArgs of [["fetch", "--prune", "origin", baseBranch], ["checkout", "--force", "-B", "agentflow-base", "origin/" + baseBranch], ["reset", "--hard", "origin/" + baseBranch]]) {
    const [, err] = gitC(ctx, workspace, ...gitArgs);
    if (err != null) {
      throw new Error(`refresh base branch ${baseBranch}: ${err.message}`);
    }
  }
  if (repository.WorkBranch !== "") {
    fetchRepositoryWorkBranch(ctx, workspace, repository);
    let checkout = () => checkoutWorkBranch(ctx, workspace, repository.WorkBranch, baseBranch, true);
    if (repository.RequireExistingWorkBranch) {
      checkout = () => checkoutContinuedWorkBranch(ctx, workspace, repository.WorkBranch);
    }
    if (repository.CreateNewWorkBranch) {
      // 刚克隆的工作区是创建命名分支的地方，这里必须拒绝已存在的远端分支。
      checkout = () => checkoutNewWorkBranch(ctx, workspace, repository.WorkBranch);
    }
    checkout();
  }
  recordRepositoryBaseline(workspace, baseBranch);
}

// prepareLocalSnapshotRepository：把非 Git 的本地源目录复制进工作区，并以一次基线提交落到 agentflow-base 上。这类源没有分支，所以继续工作分支或检出自定义基线分支都会被拒绝。
function prepareLocalSnapshotRepository(ctx, workspace, localPath, repository) {
  if (repository.RequireExistingWorkBranch) {
    throw new Error(`cannot continue branch ${JSON.stringify(repository.WorkBranch)}: local source is not a Git repository`);
  }
  const base = repository.BaseBranch.trim();
  const defaultBranch = repository.DefaultBranch.trim();
  const legacyDefault = defaultBranch === "" && (base === "master" || base === "main");
  if (base !== "" && base !== defaultBranch && !legacyDefault) {
    throw new Error(`cannot check out base branch ${JSON.stringify(base)}: local source is not a Git repository`);
  }
  const signal = ctx instanceof AbortSignal ? ctx : undefined;
  const cpResult = spawnSync("cp", ["-a", path.normalize(localPath) + "/.", workspace], { encoding: "utf8", signal });
  if (cpResult.error != null || cpResult.status !== 0) {
    const cause = cpResult.error != null ? cpResult.error.message : `exit status ${cpResult.status}`;
    throw new Error(`copy local source: ${cause}: ${((cpResult.stdout ?? "") + (cpResult.stderr ?? "")).trim()}`);
  }
  for (const args of [["init", "-b", "agentflow-base"], ["config", "user.email", "loopforge@local"], ["config", "user.name", "LoopForge"], ["add", "-A"], ["commit", "-m", "LoopForge baseline", "--quiet"]]) {
    const result = spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8", signal });
    if (result.error != null || result.status !== 0) {
      const cause = result.error != null ? result.error.message : `exit status ${result.status}`;
      throw new Error(`snapshot local source: ${cause}: ${((result.stdout ?? "") + (result.stderr ?? "")).trim()}`);
    }
  }
  applyWorkspaceGitIdentity(ctx, workspace);
  recordRepositoryBaseline(workspace, "");
}

// seedEmptyRepository：处理刚建好的、没有任何提交的 Gongfeng 仓库：克隆没有分支可检出，助手工作区和 SOP 运行都写不进第一个文件（之前要所有者手工做一次初始提交）。它用一次空提交发布基线分支（基线是集成分支时先发布默认分支），并让工作区停在上面。远端不可达或已有分支时 seeded 为 false，由克隆错误继续兜底。
function seedEmptyRepository(ctx, workspace, remote, defaultBranch, baseBranch, reset) {
  const [heads, lsErr] = runGit(ctx, workspace, "ls-remote", "--heads", "--", remote);
  if (lsErr != null || heads.trim() !== "") {
    return [false, null];
  }
  try {
    reset(workspace);
  } catch (e) {
    return [true, e];
  }
  let first = defaultBranch.trim();
  if (first === "") {
    first = "master";
  }
  for (const args of [["init", "-q", "."], ["symbolic-ref", "HEAD", "refs/heads/" + first], ["remote", "add", "--", "origin", remote]]) {
    const [, err] = runGit(ctx, workspace, ...args);
    if (err != null) {
      return [true, new Error(`initialize empty repository: ${err.message}`)];
    }
  }
  ensureGitIdentity(ctx, workspace);
  const [, commitErr] = gitC(ctx, workspace, "commit", "-q", "--allow-empty", "-m", "Initialize repository");
  if (commitErr != null) {
    return [true, new Error(`initialize empty repository: ${commitErr.message}`)];
  }
  const branches = [first];
  if (baseBranch !== first) {
    const [, branchErr] = gitC(ctx, workspace, "branch", baseBranch);
    if (branchErr != null) {
      return [true, new Error(`initialize empty repository: ${branchErr.message}`)];
    }
    branches.push(baseBranch);
  }
  for (const branch of branches) {
    const [, pushErr] = gitC(ctx, workspace, "push", "-u", "origin", branch);
    if (pushErr != null) {
      return [true, new Error(`publish ${branch} to the empty repository: ${pushErr.message}`)];
    }
  }
  return [true, null];
}

function liveDockerSandbox(workspace) {
  workspace = path.normalize(workspace);
  if (workspace === "" || workspace === ".") {
    return false;
  }
  const name = "agentflow-" + path.basename(workspace);
  return spawnSync("docker", ["inspect", name]).status === 0;
}

// resetCloneDestination：把工作区清空为一个空目录但不替换它，这样 Docker 对同一路径的绑定挂载保持有效。
function resetCloneDestination(workspace) {
  let info;
  try {
    info = fs.statSync(workspace);
  } catch (e) {
    if (e.code === "ENOENT") {
      // Docker create 会延迟到第一次 Exec，也就是克隆之后。这里缺失的工作区是第一次检出，不是正在使用的绑定挂载。
      try {
        fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
      } catch (e2) {
        throw new Error(`create workspace: ${e2.message}`);
      }
      return;
    }
    throw e;
  }
  if (!info.isDirectory()) {
    throw new Error(`workspace is not a directory: ${workspace}`);
  }
  let entries;
  try {
    entries = fs.readdirSync(workspace, { withFileTypes: true });
  } catch (e) {
    throw e;
  }
  for (const entry of entries) {
    try {
      fs.rmSync(path.join(workspace, entry.name), { recursive: true, force: true });
    } catch (e) {
      throw new Error(`clear workspace ${entry.name}: ${e.message}`);
    }
  }
}

function resumeRepository(ctx, workspace, repository) {
  applyWorkspaceGitAuth(ctx, workspace);
  applyWorkspaceGitIdentity(ctx, workspace);
  const origin = repository.CloneURL.trim();
  if (origin !== "") {
    try {
      ValidateRemoteURL(origin, true);
    } catch (e) {
      throw new Error(`set origin url: ${e.message}`);
    }
    gitC(ctx, workspace, "remote", "set-url", "--", "origin", origin);
  }
  const baseBranch = repositoryBaseBranch(repository);
  if (repository.IntegrateBranch !== "" && repository.WorkBranch !== "") {
    const [branch] = gitC(ctx, workspace, "branch", "--show-current");
    if (branch.trim() === repository.WorkBranch) {
      const [, mergeErr] = gitC(ctx, workspace, "rev-parse", "--verify", "MERGE_HEAD");
      if (mergeErr == null) {
        recordRepositoryBaseline(workspace, baseBranch);
        return;
      }
    }
  }
  const [, getUrlErr] = gitC(ctx, workspace, "remote", "get-url", "origin");
  if (getUrlErr == null) {
    const [, fetchErr] = gitC(ctx, workspace, "fetch", "--prune", "origin", baseBranch);
    if (fetchErr != null) {
      const [, fallbackErr] = gitC(ctx, workspace, "fetch", "--prune", "origin");
      if (fallbackErr != null && UsesSSH(ctx)) {
        throw new Error(`git fetch: ${fallbackErr.message}`);
      }
    }
    if (repository.WorkBranch !== "") {
      fetchRepositoryWorkBranch(ctx, workspace, repository);
    }
  } else if (repository.RequireExistingWorkBranch) {
    throw new Error(`cannot continue branch ${JSON.stringify(repository.WorkBranch)}: workspace has no origin remote`);
  }
  if (repository.WorkBranch !== "") {
    let checkout = () => checkoutWorkBranch(ctx, workspace, repository.WorkBranch, baseBranch, false);
    if (repository.RequireExistingWorkBranch) {
      checkout = () => checkoutContinuedWorkBranch(ctx, workspace, repository.WorkBranch);
    } else if (repository.CreateNewWorkBranch) {
      // 这个缓存工作区里的本地分支就是本次运行创建的（也可能已推送），直接恢复它。没有它时分支还待在这里创建，同名远端分支属于别人：像全新克隆一样拒绝。
      const [, created] = gitRevParse(ctx, workspace, "refs/heads/" + repository.WorkBranch.trim());
      if (!created) {
        checkout = () => checkoutNewWorkBranch(ctx, workspace, repository.WorkBranch);
      }
    }
    checkout();
  }
  recordRepositoryBaseline(workspace, baseBranch);
}

// checkoutContinuedWorkBranch：继续的分支是用户选定的工作。绝不应用旧的同名重置，那会在远端分支推进时丢掉未提交的工作。
function checkoutContinuedWorkBranch(ctx, workspace, branch) {
  const remoteRef = "refs/remotes/origin/" + branch;
  const [, ok] = gitRevParse(ctx, workspace, remoteRef);
  if (!ok) {
    throw new Error(`existing work branch ${JSON.stringify(branch)} is unavailable`);
  }
  const [current] = gitC(ctx, workspace, "branch", "--show-current");
  if (current.trim() !== branch) {
    let args = ["checkout", branch];
    const [, hasLocal] = gitRevParse(ctx, workspace, "refs/heads/" + branch);
    if (!hasLocal) {
      // 主分支克隆的 fetch refspec 很窄。注册这个已有的 head，Git 在建立跟踪时才能认出它。
      const [, configErr] = gitC(ctx, workspace, "config", "--add", "remote.origin.fetch", "+refs/heads/" + branch + ":" + remoteRef);
      if (configErr != null) {
        throw new Error(`configure existing work branch tracking: ${configErr.message}`);
      }
      args = ["checkout", "-b", branch, "--track", remoteRef];
    }
    const [, checkoutErr] = gitC(ctx, workspace, ...args);
    if (checkoutErr != null) {
      throw new Error(`checkout existing work branch ${branch}: ${checkoutErr.message}`);
    }
  }
  const [status, statusErr] = gitC(ctx, workspace, "status", "--porcelain");
  if (statusErr != null) {
    throw statusErr;
  }
  if (status.trim() !== "") {
    return;
  }
  // 只推进干净的检出。已分叉或进行中的工作留给常规同步或修复步骤。
  gitC(ctx, workspace, "merge", "--ff-only", remoteRef);
}

// checkoutNewWorkBranch：创建调用方命名的工作分支。调用方要的是新分支，同名远端（或残留本地）分支就是错误：悄悄检出它会让本次运行落到别人的工作上。
function checkoutNewWorkBranch(ctx, workspace, workBranch) {
  workBranch = workBranch.trim();
  if (workBranch === "") {
    throw new Error("creating a work branch requires its name");
  }
  const [, ok] = gitRevParse(ctx, workspace, "refs/heads/" + workBranch);
  if (ok) {
    throw new Error(`本地已存在分支 ${workBranch}，不能按新建分支处理`);
  }
  const [out, lsErr] = gitC(ctx, workspace, "ls-remote", "--heads", "origin", "refs/heads/" + workBranch);
  if (lsErr != null) {
    throw new Error(`无法确认远端分支 ${workBranch} 是否存在：${lsErr.message}`);
  }
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    const tab = trimmed.indexOf("\t");
    if (tab >= 0) {
      const ref = trimmed.slice(tab + 1);
      if (ref === "refs/heads/" + workBranch) {
        throw new Error(`远端已存在分支 ${workBranch}，不能按新建分支处理；继续该分支请用 branchMode=continue`);
      }
    }
  }
  createWorkBranchFromBase(ctx, workspace, workBranch);
}

function fetchRepositoryWorkBranch(ctx, workspace, repository) {
  let err = null;
  try {
    fetchRemoteWorkBranch(ctx, workspace, repository.WorkBranch);
  } catch (e) {
    err = e;
  }
  if (err != null && repository.RequireExistingWorkBranch) {
    throw new Error(`继续开发的分支 ${JSON.stringify(repository.WorkBranch)} 不存在或无法读取，请确认已有分支名称和权限：${err.message}`);
  }
}

// fetchRemoteWorkBranch：写 refs/remotes/origin/<workBranch>。普通的 `git fetch origin <branch>` 只更新 FETCH_HEAD，--single-branch 克隆永远长不出 origin/<workBranch>，检出会回落到 master。
function fetchRemoteWorkBranch(ctx, workspace, workBranch) {
  workBranch = workBranch.trim();
  if (workBranch === "") {
    return;
  }
  const refspec = "+refs/heads/" + workBranch + ":refs/remotes/origin/" + workBranch;
  const [, err] = gitC(ctx, workspace, "fetch", "origin", refspec);
  if (err != null) {
    throw err;
  }
}

function gitRevParse(ctx, workspace, ref) {
  return RevParse(ctx, workspace, ref);
}

function isWorkBranchNamesakeOfBase(ctx, workspace, localSHA, baseBranch) {
  const refs = ["agentflow-base", "origin/" + baseBranch];
  if (baseBranch !== "master") {
    refs.push("origin/master");
  }
  if (baseBranch !== "main") {
    refs.push("origin/main");
  }
  for (const ref of refs) {
    const [sha, ok] = gitRevParse(ctx, workspace, ref);
    if (ok && sha === localSHA) {
      return true;
    }
  }
  return false;
}

function createWorkBranchFromBase(ctx, workspace, workBranch) {
  let base = "agentflow-base";
  const [, err] = gitC(ctx, workspace, "rev-parse", "--verify", base + "^{commit}");
  if (err != null) {
    base = "HEAD";
  }
  const [, checkoutErr] = gitC(ctx, workspace, "checkout", "-B", workBranch, base);
  if (checkoutErr != null) {
    throw new Error(`create work branch ${workBranch}: ${checkoutErr.message}`);
  }
}

function checkoutWorkBranch(ctx, workspace, workBranch, baseBranch, fromFreshClone) {
  if (workBranch === "") {
    return;
  }
  if (baseBranch === "") {
    baseBranch = "master";
  }
  const originRef = "origin/" + workBranch;
  const [originSHA, originOK] = gitRevParse(ctx, workspace, originRef);
  if (fromFreshClone) {
    if (originOK) {
      const [, err] = gitC(ctx, workspace, "checkout", "--force", "-B", workBranch, originRef);
      if (err != null) {
        throw new Error(`checkout origin/${workBranch}: ${err.message}`);
      }
      return;
    }
    createWorkBranchFromBase(ctx, workspace, workBranch);
    return;
  }
  const [localSHA, localOK] = gitRevParse(ctx, workspace, workBranch);
  if (localOK) {
    const [, err] = gitC(ctx, workspace, "checkout", workBranch);
    if (err != null) {
      throw new Error(`checkout existing work branch ${workBranch}: ${err.message}`);
    }
    if (originOK && localSHA !== originSHA) {
      if (isWorkBranchNamesakeOfBase(ctx, workspace, localSHA, baseBranch)) {
        const [, resetErr] = gitC(ctx, workspace, "checkout", "--force", "-B", workBranch, originRef);
        if (resetErr != null) {
          throw new Error(`reset namesake work branch ${workBranch} to origin: ${resetErr.message}`);
        }
        return;
      }
      gitC(ctx, workspace, "merge", "--ff-only", originRef);
    }
    return;
  }
  if (originOK) {
    const [, err] = gitC(ctx, workspace, "checkout", "-B", workBranch, originRef);
    if (err != null) {
      throw new Error(`checkout origin/${workBranch}: ${err.message}`);
    }
    return;
  }
  createWorkBranchFromBase(ctx, workspace, workBranch);
}

// cloneWatch：给平台侧克隆加边界。持续打印进度的克隆允许慢；静默超过停滞窗口的按挂起处理。总时限默认关闭，以免大体积 SOP 检出被提前切断。
function cloneWatch(repository) {
  let name = repository.Name.trim();
  if (name === "") {
    name = repository.RepositoryID;
  }
  return {
    Stage: "clone", Label: "克隆仓库 " + name,
    Stall: DurationEnv(CloneStallEnv, 5 * 60 * 1000), StallEnv: CloneStallEnv,
    Timeout: DurationEnv(CloneTimeoutEnv, 0), TimeoutEnv: CloneTimeoutEnv,
  };
}

function runGit(ctx, workspace, ...args) {
  return Run(ctx, workspace, ...args);
}

function gitC(ctx, workspace, ...args) {
  return C(ctx, workspace, ...args);
}

function persistentSandboxID(run) {
  return run.ID;
}

function workspaceHasRepoWork(workspace) {
  let baseline;
  try {
    baseline = fs.readFileSync(BaselinePath(workspace));
  } catch {
    return false;
  }
  const headResult = spawnSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (headResult.error == null && headResult.status === 0 && headResult.stdout.trim() !== baseline.toString("utf8").trim()) {
    return true;
  }
  const statusResult = spawnSync("git", ["-C", workspace, "status", "--porcelain"], { encoding: "utf8" });
  return statusResult.error == null && statusResult.status === 0 && statusResult.stdout.trim().length > 0;
}

function defaultWorkBranch(issueNumber, issueID, now) {
  let branchOwner = "fix";
  if (issueNumber > 0) {
    branchOwner = `fix-issue-${issueNumber}`;
  } else if (issueID !== "") {
    branchOwner = "fix-" + SafeGitRefSegment(issueID);
  }
  const pad2 = (n) => String(n).padStart(2, "0");
  let branch = "feature/" + branchOwner + "-" + `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  if (issueNumber <= 0 && issueID === "") {
    // 这些运行之间没有任何关联（聊天工作区、自由协作），同一分钟启动的两个不能共用分支：它们会互相推入对方的提交和 MR。
    branch += "-" + workBranchNonce();
  }
  return branch;
}

function workBranchNonce() {
  try {
    return randomBytes(3).toString("hex");
  } catch {
    return Number(process.hrtime.bigint() % BigInt(1 << 24)).toString(36);
  }
}

function recordRepositoryBaseline(workspace, baseBranch) {
  RecordBaseline(workspace, baseBranch);
}

module.exports = { normalizeRepositories, repositoryWorkspacePath, repositoryWorkspaceDirs, prepareRepositories, repositoryBaseBranch, existingDevelopmentBranch, prepareRepository, prepareLocalSnapshotRepository, seedEmptyRepository, liveDockerSandbox, resetCloneDestination, resumeRepository, checkoutContinuedWorkBranch, checkoutNewWorkBranch, fetchRepositoryWorkBranch, fetchRemoteWorkBranch, gitRevParse, isWorkBranchNamesakeOfBase, createWorkBranchFromBase, checkoutWorkBranch, cloneWatch, runGit, gitC, persistentSandboxID, workspaceHasRepoWork, defaultWorkBranch, workBranchNonce, recordRepositoryBaseline };
