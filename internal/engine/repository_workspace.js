/**
 * @file internal/engine/repository_workspace.js
 * 对应 Go 源文件：internal/engine/repository_workspace.go
 *
 * 作用与职责边界：
 * 负责运行工作区内的多仓库准备与生命周期管理，包括仓库列表去重规整、检出目录映射、
 * 首次克隆（含缓存命中、空仓库初始化与集成分支发布）、非 Git 本地目录快照、已有工作区恢复、
 * 开发分支（新建/继续/默认）检出、克隆监控参数构造与基线提交记录。
 *
 * 语法差异说明：
 * - Go 的 `context.Context` 译为 `AbortSignal`（或 `null`）。
 * - Go 的 `(值, error)` 与仅 `error` 返回均按统一约定译为成功返回值（或无返回值 `undefined`）、失败 `throw err`。
 * - Go 的 `(值, bool)`（如 `gitRevParse`）保留为 `[值, boolean]` 二元组。
 * - Go 的 `map[string]bool` 译为普通对象 `{}`；`time.Duration` 译为毫秒数。
 */

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
const { cloneFromRepositoryCache } = require("./repository_cache.js"); // 对应 Go 同包函数，repository_cache.js 已翻译
const { withRepositoryGit, cloneRemoteForGit, applyWorkspaceGitAuth, applyWorkspaceGitIdentity } = require("./git_auth.js"); // 对应 Go 同包函数，git_auth.js 已翻译
const { shouldSeedIntegrateBranch, publishIntegrateBranch, ensureGitIdentity } = require("./integrate.js"); // 对应 Go 同包函数，integrate.js 已翻译

/**
 * 过滤掉 `RepositoryID` 为空或重复的仓库上下文条目，同时保持原有顺序。
 * 使用场景：创建或准备多仓库运行前对仓库列表做规整。
 *
 * @param {object[]} repositories - 原始仓库上下文数组（`domain.RepositoryContext[]`）。
 * @returns {object[]} 去重且去除空项后的仓库上下文数组。
 */
function normalizeRepositories(repositories) {
  const seen = {};
  const out = [];
  for (const rc of repositories) {
    if (rc.RepositoryID.trim() === "" || seen[rc.RepositoryID]) {
      continue;
    }
    seen[rc.RepositoryID] = true;
    out.push(rc);
  }
  return out;
}

/**
 * 计算单个仓库在运行工作区中的检出目录绝对路径。
 * 使用场景：新运行始终指定 `WorkspaceDir` 作为子目录；空 `WorkspaceDir` 兼容直接检出在工作区根目录的旧布局。
 *
 * @param {string} workspace - 运行工作区根目录路径。
 * @param {object} rc - 仓库上下文对象（`domain.RepositoryContext`）。
 * @returns {string} 该仓库对应的检出目录路径。
 */
function repositoryWorkspacePath(workspace, rc) {
  const dir = rc.WorkspaceDir.trim();
  if (dir !== "") {
    return path.join(workspace, dir.split("/").join(path.sep));
  }
  return workspace;
}

/**
 * 列出一次运行中所有 Git 检出目录路径。
 * 使用场景：需要遍历工作区下全部仓库执行状态检查、收集补丁或清理时调用；未绑定仓库时返回工作区根目录。
 *
 * @param {string} workspace - 运行工作区根目录路径。
 * @param {object[]} repositories - 绑定的仓库上下文数组（`domain.RepositoryContext[]`）。
 * @returns {string[]} 检出目录路径数组。
 */
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

/**
 * 依次将本次运行绑定的全部仓库检出到各自对应的工作区子目录。
 * 使用场景：运行环境首次准备代码工作区时调用，先恢复旧版工作区 Agent 配置再逐个准备仓库。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} workspace - 运行工作区根目录路径。
 * @param {object[]} repositories - 待检出的仓库上下文数组（`domain.RepositoryContext[]`）。
 * @returns {void} 无返回值。
 * @throws {Error} 恢复旧配置失败或任意仓库准备失败时抛出错误。
 */
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

/**
 * 解析仓库应当使用的基线分支名。
 * 使用场景：克隆或刷新基线分支时按 `BaseBranch` → `DefaultBranch` → `"master"` 的优先级回退。
 *
 * @param {object} repository - 仓库上下文对象（`domain.RepositoryContext`）。
 * @returns {string} 规整后的基线分支名。
 */
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

/**
 * 判断仓库配置的工作分支是否为独立于主分支与集成分支的开发分支。
 * 使用场景：校验继续已有分支或新建开发分支请求是否合法，防止误操作共享分支。
 *
 * @param {object} repository - 仓库上下文对象（`domain.RepositoryContext`）。
 * @returns {boolean} 非对齐专用模式且工作分支名非空、不与共享分支重名时返回 `true`，否则返回 `false`。
 */
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

/**
 * 在指定目录中准备单个仓库的 Git 工作区：已有 `.git` 时执行恢复，非 Git 本地目录执行快照，否则执行克隆、认证配置、基线刷新与工作分支检出。
 * 使用场景：由 `prepareRepositories` 针对每个绑定仓库调用。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} workspace - 该仓库的目标检出目录路径。
 * @param {object} repository - 仓库上下文对象（`domain.RepositoryContext`）。
 * @returns {void} 无返回值。
 * @throws {Error} 分支模式校验失败、目录创建失败、克隆/认证/检出或基线记录失败时抛出错误。
 */
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
      if (cloneFromRepositoryCache(ctx, workspace, repository, branch)) {
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
    try {
      Watch(ctx, workspace, watch, ...args);
    } catch (err) {
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
      if (!seedEmptyRepository(ctx, workspace, cloneRemoteForGit(ctx, remote), repository.DefaultBranch, baseBranch, reset)) {
        if (!shouldSeedIntegrateBranch(repository, baseBranch)) {
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
  }
  applyWorkspaceGitAuth(ctx, workspace);
  applyWorkspaceGitIdentity(ctx, workspace);
  const origin = cloneURL.trim();
  if (origin !== "") {
    try {
      gitC(ctx, workspace, "remote", "set-url", "--", "origin", origin);
    } catch (err) {
      throw new Error(`set origin url: ${err.message}`);
    }
  }
  if (shouldSeedIntegrateBranch(repository, baseBranch)) {
    fetchRemoteWorkBranch(ctx, workspace, baseBranch);
  }
  for (const gitArgs of [["fetch", "--prune", "origin", baseBranch], ["checkout", "--force", "-B", "agentflow-base", "origin/" + baseBranch], ["reset", "--hard", "origin/" + baseBranch]]) {
    try {
      gitC(ctx, workspace, ...gitArgs);
    } catch (err) {
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

/**
 * 将非 Git 的本地源目录复制到工作区，并初始化为单次基线提交落在 `agentflow-base` 分支上。
 * 使用场景：仓库仅配置了普通本地目录（无 `.git` 且无 `CloneURL`）时使用；此类源无分支概念，拒绝继续分支或检出自定义基线分支。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} workspace - 目标工作区目录路径。
 * @param {string} localPath - 非 Git 本地源目录路径。
 * @param {object} repository - 仓库上下文对象（`domain.RepositoryContext`）。
 * @returns {void} 无返回值。
 * @throws {Error} 请求继续已有分支、指定自定义基线分支、复制文件或初始化基线提交失败时抛出错误。
 */
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

/**
 * 为刚创建且尚无任何提交的远端空仓库发布一次空初始提交，推送默认分支及基线分支。
 * 使用场景：克隆失败后检查远端是否为空仓库；若远端不可达或已有分支则返回 `false`，由外层克隆错误继续处理。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} workspace - 目标工作区目录路径。
 * @param {string} remote - 带认证信息的 Git 远端地址。
 * @param {string} defaultBranch - 仓库默认分支名。
 * @param {string} baseBranch - 本次运行目标基线分支名。
 * @param {function(string): void} reset - 清空工作区目录的重置函数。
 * @returns {boolean} 成功初始化并推送空仓库返回 `true`；远端不可达或已有分支时返回 `false`。
 * @throws {Error} 确认远端为空仓库后，在重置、初始化、提交或推送过程中失败时抛出错误。
 */
function seedEmptyRepository(ctx, workspace, remote, defaultBranch, baseBranch, reset) {
  let heads = "";
  try {
    heads = runGit(ctx, workspace, "ls-remote", "--heads", "--", remote);
  } catch {
    return false;
  }
  if (heads.trim() !== "") {
    return false;
  }
  reset(workspace);
  let first = defaultBranch.trim();
  if (first === "") {
    first = "master";
  }
  for (const args of [["init", "-q", "."], ["symbolic-ref", "HEAD", "refs/heads/" + first], ["remote", "add", "--", "origin", remote]]) {
    try {
      runGit(ctx, workspace, ...args);
    } catch (err) {
      throw new Error(`initialize empty repository: ${err.message}`);
    }
  }
  ensureGitIdentity(ctx, workspace);
  try {
    gitC(ctx, workspace, "commit", "-q", "--allow-empty", "-m", "Initialize repository");
  } catch (commitErr) {
    throw new Error(`initialize empty repository: ${commitErr.message}`);
  }
  const branches = [first];
  if (baseBranch !== first) {
    try {
      gitC(ctx, workspace, "branch", baseBranch);
    } catch (branchErr) {
      throw new Error(`initialize empty repository: ${branchErr.message}`);
    }
    branches.push(baseBranch);
  }
  for (const branch of branches) {
    try {
      gitC(ctx, workspace, "push", "-u", "origin", branch);
    } catch (pushErr) {
      throw new Error(`publish ${branch} to the empty repository: ${pushErr.message}`);
    }
  }
  return true;
}

/**
 * 检查与工作区对应的 Docker 沙箱容器是否已经存在。
 * 使用场景：决定克隆前是否可以清空重设目标目录，避免替换正在绑定挂载的目录 inode。
 *
 * @param {string} workspace - 工作区目录路径。
 * @returns {boolean} 容器存在（`docker inspect` 退出码为 0）时返回 `true`，否则返回 `false`。
 */
function liveDockerSandbox(workspace) {
  workspace = path.normalize(workspace);
  if (workspace === "" || workspace === ".") {
    return false;
  }
  const name = "agentflow-" + path.basename(workspace);
  return spawnSync("docker", ["inspect", name]).status === 0;
}

/**
 * 清空工作区目录内容但不删除目录本身，保持目录 inode 不变以维持 Docker 绑定挂载有效；目录不存在时自动创建。
 * 使用场景：首次克隆或重试克隆前清理目标目录。
 *
 * @param {string} workspace - 目标工作区目录路径。
 * @returns {void} 无返回值。
 * @throws {Error} 路径不是目录、创建目录失败或清理子项失败时抛出错误。
 */
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
  const entries = fs.readdirSync(workspace, { withFileTypes: true });
  for (const entry of entries) {
    try {
      fs.rmSync(path.join(workspace, entry.name), { recursive: true, force: true });
    } catch (e) {
      throw new Error(`clear workspace ${entry.name}: ${e.message}`);
    }
  }
}

/**
 * 恢复已包含 `.git` 目录的现有工作区：刷新认证与身份、更新 `origin`、拉取远端基线与工作分支并检出工作分支。
 * 使用场景：重试、恢复暂停或复用已有工作区时由 `prepareRepository` 调用。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} workspace - 已有 Git 工作区目录路径。
 * @param {object} repository - 仓库上下文对象（`domain.RepositoryContext`）。
 * @returns {void} 无返回值。
 * @throws {Error} 认证/身份配置、远端校验、拉取、检出或记录基线失败时抛出错误。
 */
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
    try {
      gitC(ctx, workspace, "remote", "set-url", "--", "origin", origin);
    } catch {}
  }
  const baseBranch = repositoryBaseBranch(repository);
  if (repository.IntegrateBranch !== "" && repository.WorkBranch !== "") {
    let branch = "";
    try {
      branch = gitC(ctx, workspace, "branch", "--show-current");
    } catch {}
    if (branch.trim() === repository.WorkBranch) {
      let hasMergeHead = false;
      try {
        gitC(ctx, workspace, "rev-parse", "--verify", "MERGE_HEAD");
        hasMergeHead = true;
      } catch {}
      if (hasMergeHead) {
        recordRepositoryBaseline(workspace, baseBranch);
        return;
      }
    }
  }
  let hasOrigin = false;
  try {
    gitC(ctx, workspace, "remote", "get-url", "origin");
    hasOrigin = true;
  } catch {}
  if (hasOrigin) {
    try {
      gitC(ctx, workspace, "fetch", "--prune", "origin", baseBranch);
    } catch {
      try {
        gitC(ctx, workspace, "fetch", "--prune", "origin");
      } catch (fallbackErr) {
        if (UsesSSH(ctx)) {
          throw new Error(`git fetch: ${fallbackErr.message}`);
        }
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

/**
 * 检出并跟进用户指定的已有开发分支；仅在工作树干净时尝试 fast-forward 合并，绝不执行覆盖重置以免丢失未提交改动。
 * 使用场景：`RequireExistingWorkBranch` 为 `true`（`branchMode=continue`）时检出工作分支。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} workspace - Git 工作区目录路径。
 * @param {string} branch - 要继续开发的分支名。
 * @returns {void} 无返回值。
 * @throws {Error} 远端分支不可用、配置跟踪失败、检出失败或查询工作区状态失败时抛出错误。
 */
function checkoutContinuedWorkBranch(ctx, workspace, branch) {
  const remoteRef = "refs/remotes/origin/" + branch;
  const [, ok] = gitRevParse(ctx, workspace, remoteRef);
  if (!ok) {
    throw new Error(`existing work branch ${JSON.stringify(branch)} is unavailable`);
  }
  let current = "";
  try {
    current = gitC(ctx, workspace, "branch", "--show-current");
  } catch {}
  if (current.trim() !== branch) {
    let args = ["checkout", branch];
    const [, hasLocal] = gitRevParse(ctx, workspace, "refs/heads/" + branch);
    if (!hasLocal) {
      // 主分支克隆的 fetch refspec 很窄。注册这个已有的 head，Git 在建立跟踪时才能认出它。
      try {
        gitC(ctx, workspace, "config", "--add", "remote.origin.fetch", "+refs/heads/" + branch + ":" + remoteRef);
      } catch (configErr) {
        throw new Error(`configure existing work branch tracking: ${configErr.message}`);
      }
      args = ["checkout", "-b", branch, "--track", remoteRef];
    }
    try {
      gitC(ctx, workspace, ...args);
    } catch (checkoutErr) {
      throw new Error(`checkout existing work branch ${branch}: ${checkoutErr.message}`);
    }
  }
  const status = gitC(ctx, workspace, "status", "--porcelain");
  if (status.trim() !== "") {
    return;
  }
  // 只推进干净的检出。已分叉或进行中的工作留给常规同步或修复步骤。
  try {
    gitC(ctx, workspace, "merge", "--ff-only", remoteRef);
  } catch {}
}

/**
 * 基于基线分支创建一个全新的命名工作分支；若本地或远端已存在同名分支则拒绝并报错，避免误写入他人分支。
 * 使用场景：`CreateNewWorkBranch` 为 `true` 时检出新分支。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} workspace - Git 工作区目录路径。
 * @param {string} workBranch - 待新建的工作分支名。
 * @returns {void} 无返回值。
 * @throws {Error} 分支名为空、本地或远端已存在同名分支、查询远端失败或建分支失败时抛出错误。
 */
function checkoutNewWorkBranch(ctx, workspace, workBranch) {
  workBranch = workBranch.trim();
  if (workBranch === "") {
    throw new Error("creating a work branch requires its name");
  }
  const [, ok] = gitRevParse(ctx, workspace, "refs/heads/" + workBranch);
  if (ok) {
    throw new Error(`本地已存在分支 ${workBranch}，不能按新建分支处理`);
  }
  let out;
  try {
    out = gitC(ctx, workspace, "ls-remote", "--heads", "origin", "refs/heads/" + workBranch);
  } catch (lsErr) {
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

/**
 * 拉取仓库配置的工作分支远端引用；若要求继续已有分支且拉取失败则返回友好错误。
 * 使用场景：克隆或恢复仓库后同步 `origin/<workBranch>`。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} workspace - Git 工作区目录路径。
 * @param {object} repository - 仓库上下文对象（`domain.RepositoryContext`）。
 * @returns {void} 无返回值。
 * @throws {Error} `RequireExistingWorkBranch` 为 `true` 且拉取远端工作分支失败时抛出错误。
 */
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

/**
 * 显式拉取远端分支并写入 `refs/remotes/origin/<workBranch>`，避免 `--single-branch` 克隆无法生成远端跟踪引用。
 * 使用场景：同步指定工作分支或集成分支的远端提交。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} workspace - Git 工作区目录路径。
 * @param {string} workBranch - 远端分支名。
 * @returns {void} 无返回值。
 * @throws {Error} `git fetch` 执行失败时抛出错误。
 */
function fetchRemoteWorkBranch(ctx, workspace, workBranch) {
  workBranch = workBranch.trim();
  if (workBranch === "") {
    return;
  }
  const refspec = "+refs/heads/" + workBranch + ":refs/remotes/origin/" + workBranch;
  gitC(ctx, workspace, "fetch", "origin", refspec);
}

/**
 * 解析指定 Git 引用的提交哈希。
 * 使用场景：判断本地分支、远端跟踪分支或基线引用是否存在并获取其 SHA。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} workspace - Git 工作区目录路径。
 * @param {string} ref - Git 引用名（如 `refs/heads/main`、`origin/master`）。
 * @returns {[string, boolean]} 解析成功返回 `[sha, true]`，不存在或解析失败返回 `["", false]`。
 */
function gitRevParse(ctx, workspace, ref) {
  return RevParse(ctx, workspace, ref);
}

/**
 * 判断本地工作分支当前指向的提交是否仍停留在基线（或默认主分支）提交上，尚未产生独立开发提交。
 * 使用场景：恢复工作分支时判断本地同名分支是否可安全重置到远端新提交。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} workspace - Git 工作区目录路径。
 * @param {string} localSHA - 本地工作分支当前提交 SHA。
 * @param {string} baseBranch - 基线分支名。
 * @returns {boolean} 本地提交与任一基线引用一致返回 `true`，否则返回 `false`。
 */
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

/**
 * 从 `agentflow-base`（若不存在则回退到 `HEAD`）创建或重置工作分支并检出。
 * 使用场景：新分支或远端尚不存在对应分支时基于基线建分支。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} workspace - Git 工作区目录路径。
 * @param {string} workBranch - 目标工作分支名。
 * @returns {void} 无返回值。
 * @throws {Error} `git checkout -B` 失败时抛出错误。
 */
function createWorkBranchFromBase(ctx, workspace, workBranch) {
  let base = "agentflow-base";
  try {
    gitC(ctx, workspace, "rev-parse", "--verify", base + "^{commit}");
  } catch {
    base = "HEAD";
  }
  try {
    gitC(ctx, workspace, "checkout", "-B", workBranch, base);
  } catch (checkoutErr) {
    throw new Error(`create work branch ${workBranch}: ${checkoutErr.message}`);
  }
}

/**
 * 按默认策略检出工作分支：全新克隆优先检出远端同名分支，恢复时优先保留本地提交并在需要时快进或重置空壳同名分支。
 * 使用场景：常规运行（非强制继续/非强制新建）准备或恢复工作分支。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} workspace - Git 工作区目录路径。
 * @param {string} workBranch - 目标工作分支名。
 * @param {string} baseBranch - 基线分支名。
 * @param {boolean} fromFreshClone - 是否来自本次刚完成的全新克隆。
 * @returns {void} 无返回值。
 * @throws {Error} 检出、重置或新建工作分支失败时抛出错误。
 */
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
      try {
        gitC(ctx, workspace, "checkout", "--force", "-B", workBranch, originRef);
      } catch (err) {
        throw new Error(`checkout origin/${workBranch}: ${err.message}`);
      }
      return;
    }
    createWorkBranchFromBase(ctx, workspace, workBranch);
    return;
  }
  const [localSHA, localOK] = gitRevParse(ctx, workspace, workBranch);
  if (localOK) {
    try {
      gitC(ctx, workspace, "checkout", workBranch);
    } catch (err) {
      throw new Error(`checkout existing work branch ${workBranch}: ${err.message}`);
    }
    if (originOK && localSHA !== originSHA) {
      if (isWorkBranchNamesakeOfBase(ctx, workspace, localSHA, baseBranch)) {
        try {
          gitC(ctx, workspace, "checkout", "--force", "-B", workBranch, originRef);
        } catch (resetErr) {
          throw new Error(`reset namesake work branch ${workBranch} to origin: ${resetErr.message}`);
        }
        return;
      }
      try {
        gitC(ctx, workspace, "merge", "--ff-only", originRef);
      } catch {}
    }
    return;
  }
  if (originOK) {
    try {
      gitC(ctx, workspace, "checkout", "-B", workBranch, originRef);
    } catch (err) {
      throw new Error(`checkout origin/${workBranch}: ${err.message}`);
    }
    return;
  }
  createWorkBranchFromBase(ctx, workspace, workBranch);
}

/**
 * 构造平台侧仓库克隆的进程监控选项：允许持续输出进度的慢克隆，但静默超过停滞窗口即判定挂起；总超时默认关闭。
 * 使用场景：调用 `gitwork.Watch` 或 `gitwork.CloneFromRepositoryCache` 时传入监控配置。
 *
 * @param {object} repository - 仓库上下文对象（`domain.RepositoryContext`）。
 * @returns {object} 进程监控选项对象（`procwatch.Options`）。
 */
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

/**
 * 在指定工作目录中执行 Git 命令（不自动追加 `-C`）。
 * 使用场景：执行 `git init`、`git ls-remote` 等以工作目录为当前目录的命令。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} workspace - 命令执行目录。
 * @param {...string} args - Git 子命令与参数列表。
 * @returns {string} 命令标准输出文本。
 * @throws {Error} Git 命令执行失败时抛出错误。
 */
function runGit(ctx, workspace, ...args) {
  return Run(ctx, workspace, ...args);
}

/**
 * 以 `git -C <workspace>` 方式在指定仓库工作区中执行 Git 命令。
 * 使用场景：在已初始化的 Git 仓库中执行 `fetch`、`checkout`、`remote`、`commit` 等操作。
 *
 * @param {AbortSignal|null} ctx - 取消信号。
 * @param {string} workspace - Git 仓库工作区目录。
 * @param {...string} args - Git 子命令与参数列表。
 * @returns {string} 命令标准输出文本。
 * @throws {Error} Git 命令执行失败时抛出错误。
 */
function gitC(ctx, workspace, ...args) {
  return C(ctx, workspace, ...args);
}

/**
 * 返回运行对应的持久化沙箱标识符（即运行 ID）。
 * 使用场景：关联或定位某次运行对应的沙箱实例。
 *
 * @param {object} run - 运行对象（`domain.Run`）。
 * @returns {string} 运行主键 ID。
 */
function persistentSandboxID(run) {
  return run.ID;
}

/**
 * 判断工作区相对记录的基线提交是否已产生新提交或未提交改动。
 * 使用场景：检查工作区是否有尚未同步的代码成果，用于清理、迁移或交付判定。
 *
 * @param {string} workspace - Git 工作区目录路径。
 * @returns {boolean} `HEAD` 偏离基线提交或存在工作树变更时返回 `true`，否则返回 `false`。
 */
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

/**
 * 生成默认开发工作分支名；无关联需求（聊天工作区、自由协作）时追加随机短后缀防止同分钟冲突。
 * 使用场景：启动未显式指定工作分支的运行前自动分配开发分支名。
 *
 * @param {number} issueNumber - 关联需求序号（大于 0 时优先使用）。
 * @param {string} issueID - 关联需求 ID（无序号时回退使用）。
 * @param {Date} now - 用于格式化本地时间戳的当前时间对象。
 * @returns {string} 生成的 `feature/...` 格式工作分支名。
 */
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

/**
 * 生成用于区分无关联运行工作分支的 6 位十六进制随机短串（随机数读取失败时回退为纳秒模数 36 进制）。
 * 使用场景：由 `defaultWorkBranch` 在无需求关联时调用。
 *
 * @returns {string} 短随机标识符字符串。
 */
function workBranchNonce() {
  try {
    return randomBytes(3).toString("hex");
  } catch {
    return Number(process.hrtime.bigint() % BigInt(1 << 24)).toString(36);
  }
}

/**
 * 记录当前工作区的基线提交信息与基线分支名到工作区元数据文件。
 * 使用场景：仓库克隆、快照或恢复完成后落盘基线，供后续改动检测与补丁采集对照。
 *
 * @param {string} workspace - Git 工作区目录路径。
 * @param {string} baseBranch - 基线分支名（快照模式可为空字符串）。
 * @returns {void} 无返回值。
 * @throws {Error} 读取 `HEAD` 或写入基线文件失败时抛出错误。
 */
function recordRepositoryBaseline(workspace, baseBranch) {
  RecordBaseline(workspace, baseBranch);
}

module.exports = { normalizeRepositories, repositoryWorkspacePath, repositoryWorkspaceDirs, prepareRepositories, repositoryBaseBranch, existingDevelopmentBranch, prepareRepository, prepareLocalSnapshotRepository, seedEmptyRepository, liveDockerSandbox, resetCloneDestination, resumeRepository, checkoutContinuedWorkBranch, checkoutNewWorkBranch, fetchRepositoryWorkBranch, fetchRemoteWorkBranch, gitRevParse, isWorkBranchNamesakeOfBase, createWorkBranchFromBase, checkoutWorkBranch, cloneWatch, runGit, gitC, persistentSandboxID, workspaceHasRepoWork, defaultWorkBranch, workBranchNonce, recordRepositoryBaseline };
