/**
 * @file internal/engine/conversation_push.js
 * 对应 Go 源文件：internal/engine/conversation_push.go
 *
 * 作用与职责边界：
 * 实现对话工作区代码推送：将当前运行绑定的所有可写且相对基分支有改动的仓库工作分支提交并推送到远端，
 * 支持可选直推共享分支（合并并推送），使对话在不经过 SOP 交付节点的情况下也能发起 MR 或同步代码；
 * 自动区分本地工作区执行与远端 Runner 执行两种路径，并上报推送遥测事件。
 * 领域方法挂载于 `Engine.prototype`（`Engine` 定义于 `engine.js`）。
 *
 * 语法差异说明：
 * - Go 的 `([]domain.RunnerWorkBranchHead, error)` 译为成功返回数组、失败 `throw err`；`(值, bool)` 译为二元组 `[值, boolean]`。
 * - Go 的 `context.Context` 译为 `AbortSignal`；`context.WithTimeout` 译为 `AbortController` + `setTimeout` 并在 `finally` 中清理定时器。
 * - Go 的 `time.Duration` 换算为毫秒；`time.Now().UnixNano()` 以 `BigInt(Date.now()) * 1000000n` 近似表达。
 * - Go 的 `map[string]bool` 译为普通对象 `{}`；访问映射中可能缺失的字符串键时使用 `?? ""` 还原 Go 字符串零值语义。
 * - 因 `awaitRunnerTask` 为异步方法，`PushConversationWorkspace` 与 `pushConversationOnRunner` 使用 `async/await`。
 */

"use strict";

const { RunnerWorkBranchHead, RunnerInvocation, RunnerTask, RunnerTaskActionPushWorkBranch, RunnerTaskQueued, RunnerTaskSuccess, RunnerVersionSharedPush } = require("../domain/runner.js"); // 对应 Go 的 domain.Runner*，runner.js 已翻译
const { RepositoryProviderSSH } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryProviderSSH，project.js 已翻译
const { RunnerWorkspaceLayoutShared } = require("../domain/observability.js"); // 对应 Go 的 domain.RunnerWorkspaceLayoutShared，observability.js 已翻译
const { TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TelemetryEvent，run.js 已翻译
const { ErrSSHKeyRequired, WithSSHKeys } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork.ErrSSHKeyRequired/WithSSHKeys，gitwork 未翻译
const { HasWork, RequireOnWorkBranch, PushExistingWorkBranch, PushWorkBranch } = require("../gitwork/workbranch.js"); // 对应 Go 的 gitwork 工作分支函数，gitwork 未翻译
const { RevParse } = require("../gitwork/git.js"); // 对应 Go 的 gitwork.RevParse，gitwork 未翻译
const { MergeWorkIntoSharedBranch } = require("../gitwork/shared.js"); // 对应 Go 的 gitwork.MergeWorkIntoSharedBranch，gitwork 未翻译
const { RunCredentials } = require("../runtime/runtime.js"); // 对应 Go 的 runtime.RunCredentials，runtime 未翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { withGitIdentity, withRunGitCredentials, withRepositoryGit, sshRepositoryURLs, applyWorkspaceGitAuth, applyWorkspaceGitIdentity, explainGitAuthFailure } = require("./git_auth.js"); // 对应 Go 同包函数，git_auth.js 已翻译
const { ensureGitIdentity } = require("./integrate.js"); // 对应 Go 同包函数，integrate.js 已翻译
const { repositoryWorkspacePath, repositoryBaseBranch } = require("./repository_workspace.js"); // 对应 Go 同包函数，repository_workspace.js 已翻译
const { bindRunnerRepositories, safeRunnerPath, runnerWorkspaceRel } = require("./runner_dispatch.js"); // 对应 Go 同包函数，runner_dispatch.js 已翻译
const { WorkspaceRunID } = require("./workspace_cleanup.js"); // 对应 Go 同包函数，workspace_cleanup.js 已翻译

// 对话工作区推送任务在 Runner 上使用的虚拟节点标识。
const conversationPushNode = "_push";
// 对话工作区推送操作的超时时间（3 分钟，换算为毫秒）。
const conversationPushTimeout = 3 * 60 * 1000;

/**
 * 提交对话运行工作区中的所有未提交改动，并推送每个相对基分支存在差异的绑定可写仓库工作分支；
 * 若指定了 `sharedTarget`，还会将工作分支合并并直推到该共享分支。无改动的仓库不会出现在返回结果中。
 * 调用方须持有对话工作区租约，并传入发起人 ID 与 Git 身份，使提交归属到请求者名下。
 * 使用场景：用户在对话界面点击提交/发起 MR 或直推共享分支时调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号。
 * @param {string} runID - 目标运行 ID。
 * @param {number} requesterID - 发起推送的用户 ID，用于解析其 Git HTTP 凭据与 SSH 密钥。
 * @param {string} gitUserName - 提交使用的 Git 用户名。
 * @param {string} gitUserEmail - 提交使用的 Git 邮箱。
 * @param {string} message - 提交说明；为空时默认使用 `"LoopForge: " + run.Input`。
 * @param {string} sharedTarget - 可选的直推共享分支名；为空时仅推送工作分支。
 * @returns {Promise<RunnerWorkBranchHead[]>} 本次实际推送的仓库分支与最新提交信息列表。
 * @throws {Error} 运行不存在、子 SOP 共享父工作区、无绑定可推仓库、缺少 SSH 密钥、工作区不可用、推送或合并冲突失败时抛出错误。
 */
Engine.prototype.PushConversationWorkspace = async function (ctx, runID, requesterID, gitUserName, gitUserEmail, message, sharedTarget) {
  const [run, ok] = this.repo.RunState(runID);
  if (!ok) {
    throw new Error("运行不存在");
  }
  if (WorkspaceRunID(run) !== run.ID) {
    throw new Error("子 SOP 共享父任务工作区，请从父任务提交");
  }
  const repositories = [];
  for (const rc of run.RepositoryContexts()) {
    if (rc.ReadOnly || rc.CloneURL.trim() === "" || rc.WorkBranch.trim() === "") {
      continue;
    }
    repositories.push(rc);
  }
  if (repositories.length === 0) {
    throw new Error("当前任务没有绑定可推送的代码仓库");
  }
  const sshKeys = this.repo.GitSSHKeysForRemotes(requesterID, sshRepositoryURLs(repositories));
  for (const rc of repositories) {
    if (rc.Provider === RepositoryProviderSSH && (sshKeys[rc.CloneURL] ?? "") === "") {
      throw new Error(`${rc.Name}: ${ErrSSHKeyRequired.message}`);
    }
  }
  message = message.trim();
  if (message === "") {
    message = "LoopForge: " + run.Input.trim();
  }
  message = truncateCommitMessage(message);
  sharedTarget = sharedTarget.trim();
  // Go：ctx, cancel := context.WithTimeout(ctx, conversationPushTimeout)
  const pushController = new AbortController();
  const pushTimer = setTimeout(() => pushController.abort(new Error("context deadline exceeded")), conversationPushTimeout);
  if (ctx instanceof AbortSignal) {
    if (ctx.aborted) {
      pushController.abort(ctx.reason);
    } else {
      ctx.addEventListener("abort", () => pushController.abort(ctx.reason), { once: true });
    }
  }
  ctx = pushController.signal;
  try {
    // Go 的 defer cancel() 译为 finally。
    ctx = withGitIdentity(withRunGitCredentials(ctx, new RunCredentials({ GitHTTPCredentials: this.repo.GitHTTPCredentialSecrets(ctx, requesterID) })), gitUserName, gitUserEmail);
    ctx = WithSSHKeys(this.withSSHKnownHosts(ctx), sshKeys);
    const runnerID = this.defaultExecutionRunner(run);
    if (runnerID !== "") {
      return await this.pushConversationOnRunner(ctx, runnerID, run, repositories, requesterID, gitUserName, gitUserEmail, message, sharedTarget);
    }
    const [root, reason] = this.LocalRunWorkspace(run);
    if (reason !== "") {
      throw new Error(reason);
    }
    const heads = [];
    for (const rc of repositories) {
      const repoCtx = withRepositoryGit(ctx, rc);
      const dir = repositoryWorkspacePath(root, rc);
      if (!HasWork(repoCtx, dir, repositoryBaseBranch(rc))) {
        continue;
      }
      try {
        RequireOnWorkBranch(repoCtx, dir, rc.WorkBranch);
      } catch (err) {
        throw new Error(`${rc.Name}: ${err.message}`);
      }
      applyWorkspaceGitAuth(repoCtx, dir);
      applyWorkspaceGitIdentity(repoCtx, dir);
      ensureGitIdentity(repoCtx, dir);
      let head;
      try {
        if (rc.RequireExistingWorkBranch) {
          head = PushExistingWorkBranch(repoCtx, dir, rc.WorkBranch, message);
        } else {
          head = PushWorkBranch(repoCtx, dir, rc.WorkBranch, message);
        }
      } catch (err) {
        throw explainGitAuthFailure(new Error(`${rc.Name}: git push ${rc.WorkBranch}: ${err.message}`), true);
      }
      if (head === "") {
        try {
          head = RevParse(repoCtx, dir, "HEAD");
        } catch (e) {
          // Go 在此忽略该错误。
        }
      }
      const entry = new RunnerWorkBranchHead({ RepositoryID: rc.RepositoryID, Name: rc.Name, WorkBranch: rc.WorkBranch, Head: head });
      if (sharedTarget !== "") {
        let merged;
        let conflicts;
        try {
          [merged, conflicts] = MergeWorkIntoSharedBranch(repoCtx, dir, rc.WorkBranch, sharedTarget);
        } catch (err) {
          throw explainGitAuthFailure(new Error(`${rc.Name}: 直推 ${sharedTarget}: ${err.message}`), true);
        }
        if (conflicts.length > 0) {
          throw new Error(`${rc.Name}: 合并 ${rc.WorkBranch} 进 ${sharedTarget} 有冲突，没有推送：${conflicts.join(", ")}`);
        }
        entry.SharedBranch = sharedTarget;
        entry.SharedHead = merged;
      }
      heads.push(entry);
    }
    this.observeConversationPush(run.ID, heads, "");
    return heads;
  } finally {
    clearTimeout(pushTimer);
  }
};

/**
 * 通过下发 `push_work_branch` 类型的 Runner 任务，在远端执行机器的共享工作区上完成对话代码提交与推送。
 * 使用场景：当运行的默认执行位置位于远端 Runner 时，由 `PushConversationWorkspace` 调用。
 *
 * @param {AbortSignal | null} ctx - 带超时控制的取消信号。
 * @param {string} runnerID - 目标执行机器 ID。
 * @param {Object} run - 运行记录对象（`domain.Run`）。
 * @param {Object[]} repositories - 过滤后的可写仓库上下文列表（`domain.RepositoryContext[]`）。
 * @param {number} requesterID - 发起推送的用户 ID。
 * @param {string} gitUserName - 提交使用的 Git 用户名。
 * @param {string} gitUserEmail - 提交使用的 Git 邮箱。
 * @param {string} message - 已截断并清洗的提交说明。
 * @param {string} sharedTarget - 可选的直推共享分支名。
 * @returns {Promise<RunnerWorkBranchHead[]>} Runner 返回的已推送仓库分支头列表。
 * @throws {Error} 布局非共享、Runner 不存在、能力不满足、任务入队/等待失败、推送失败或结果 JSON 解码失败时抛出错误。
 */
Engine.prototype.pushConversationOnRunner = async function (ctx, runnerID, run, repositories, requesterID, gitUserName, gitUserEmail, message, sharedTarget) {
  if (run.ExecutionContext.RunnerWorkspaceLayout !== RunnerWorkspaceLayoutShared) {
    throw new Error("该任务的执行机器工作区不是共享布局，暂不支持直接提交 MR");
  }
  const [runner, ok] = this.repo.Runner(runnerID);
  if (!ok) {
    throw new Error(`执行机器 ${runnerID} 不存在`);
  }
  this.requireWorkBranchCapabilities(runnerID, repositories);
  if (sharedTarget !== "" && !runner.SupportsSharedPush()) {
    throw new Error(`执行机器 ${runnerID} 的 runner 版本是 ${runner.RunnerVersion.trim()}，还不支持直推共享分支（需要 ${RunnerVersionSharedPush} 及以上）；请先升级 runner，或改用 MR 提交`);
  }
  const invocation = new RunnerInvocation({ RunID: run.ID, NodeID: conversationPushNode });
  bindRunnerRepositories(invocation, run, gitUserName, gitUserEmail);
  invocation.GitHTTPUserID = requesterID;
  invocation.Repository = null;
  const wanted = {};
  for (const rc of repositories) {
    wanted[rc.RepositoryID + "\x00" + rc.WorkspaceDir] = true;
  }
  const kept = [];
  for (const repo of invocation.Repositories ?? []) {
    if (wanted[repo.RepositoryID + "\x00" + repo.Dir]) {
      repo.SyncWorkBranch = true;
      repo.SharedPushTarget = sharedTarget;
      kept.push(repo);
    }
  }
  invocation.Repositories = kept;
  if ((invocation.GitSSHRemotes() ?? []).length > 0) {
    invocation.GitSSHUserID = requesterID;
  } else {
    invocation.GitSSHUserID = 0;
  }
  // Go 的 time.Now().UnixNano() 是纪元纳秒，JS 取毫秒时间戳换算。
  const task = new RunnerTask({
    ID: `rt-${BigInt(Date.now()) * 1000000n}-${safeRunnerPath(run.ID)}-push`,
    RunnerID: runnerID,
    Provider: "terminal",
    Action: RunnerTaskActionPushWorkBranch,
    WorkBranchMessage: message,
    Workspace: runnerWorkspaceRel(run, conversationPushNode),
    Status: RunnerTaskQueued,
    MaxAttempts: 1,
    RunID: run.ID,
    NodeID: conversationPushNode,
    Invocation: invocation,
  });
  this.repo.PutRunnerTask(task);
  this.notifyRunnerDispatch("terminal");
  const final = await this.awaitRunnerTask(ctx, task.ID, null);
  if (final.Status !== RunnerTaskSuccess) {
    let msg = final.Error.trim();
    if (msg === "") {
      msg = "执行机器推送工作分支失败（" + final.Status + "）";
    }
    throw explainGitAuthFailure(new Error(`git push: ${msg}`), true);
  }
  let heads = [];
  if (final.Result.trim() !== "") {
    try {
      heads = JSON.parse(final.Result).map((h) => new RunnerWorkBranchHead(h));
    } catch (err) {
      throw new Error(`decode push result: ${err.message}`);
    }
  }
  this.observeConversationPush(run.ID, heads, runnerID);
  return heads;
};

/**
 * 为每次成功推送的工作分支（以及可选的共享分支直推）记录遥测观察事件。
 * 使用场景：本地或远端 Runner 推送对话工作区成功后由 `PushConversationWorkspace` / `pushConversationOnRunner` 调用。
 *
 * @param {string} runID - 运行 ID。
 * @param {RunnerWorkBranchHead[]} heads - 已推送的仓库分支与提交信息列表。
 * @param {string} runnerID - 执行推送的 Runner ID；本地推送时为空字符串 `""`。
 * @returns {void} 无返回值。
 */
Engine.prototype.observeConversationPush = function (runID, heads, runnerID) {
  for (const head of heads) {
    this.observe(runID, "", new TelemetryEvent({ Category: "sandbox", Name: "work_branch.pushed", Phase: "finish", Message: `${head.Name} @ ${head.WorkBranch} → ${head.Head}`, Attributes: { repositoryId: head.RepositoryID, workBranch: head.WorkBranch, commit: head.Head, runnerId: runnerID } }));
    if (head.SharedBranch !== "") {
      this.observe(runID, "", new TelemetryEvent({ Category: "sandbox", Name: "work_branch.shared_pushed", Phase: "finish", Message: `${head.Name} @ ${head.WorkBranch} → ${head.SharedBranch} ${head.SharedHead}`, Attributes: { repositoryId: head.RepositoryID, workBranch: head.WorkBranch, sharedBranch: head.SharedBranch, commit: head.SharedHead, runnerId: runnerID } }));
    }
  }
};

/**
 * 按 Unicode 字符（rune）长度将提交说明截断到最多 2000 个字符，防止超长提交消息导致命令或远端拒绝。
 * 使用场景：在构造 Git 提交说明前由 `PushConversationWorkspace` 调用。
 *
 * @param {string} message - 原始提交说明字符串。
 * @returns {string} 长度不超过 2000 个字符的提交说明。
 */
function truncateCommitMessage(message) {
  const runes = [...message];
  if (runes.length > 2000) {
    return runes.slice(0, 2000).join("");
  }
  return message;
}

module.exports = { conversationPushNode, conversationPushTimeout, truncateCommitMessage };
