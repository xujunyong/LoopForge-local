// conversation_push.js —— 对应 Go 文件：internal/engine/conversation_push.go
// 作用：提交对话工作区：把有改动的绑定仓库工作分支推送出去，可选直推共享分支。
// (值, error) 译为返回值、失败 throw，(值, bool) 译为 [值, bool]；time.Duration 译为毫秒数；context.Context 译为 AbortSignal。

"use strict";

const { RunnerWorkBranchHead, RunnerInvocation, RunnerTask, RunnerTaskActionPushWorkBranch, RunnerTaskQueued, RunnerTaskSuccess, RunnerVersionSharedPush } = require("../domain/runner.js"); // 对应 Go 的 domain.Runner*，runner.js 已翻译
const { RepositoryProviderSSH } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryProviderSSH，project.js 已翻译
const { RunnerWorkspaceLayoutShared } = require("../domain/observability.js"); // 对应 Go 的 domain.RunnerWorkspaceLayoutShared，observability.js 已翻译
const { TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TelemetryEvent，run.js 已翻译
const { ErrSSHKeyRequired } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork.ErrSSHKeyRequired，gitwork 未翻译
const { HasWork, RequireOnWorkBranch, PushExistingWorkBranch, PushWorkBranch } = require("../gitwork/workbranch.js"); // 对应 Go 的 gitwork 工作分支函数，gitwork 未翻译
const { RevParse } = require("../gitwork/git.js"); // 对应 Go 的 gitwork.RevParse，gitwork 未翻译
const { MergeWorkIntoSharedBranch } = require("../gitwork/shared.js"); // 对应 Go 的 gitwork.MergeWorkIntoSharedBranch，gitwork 未翻译
const { RunCredentials } = require("../runtime/runtime.js"); // 对应 Go 的 runtime.RunCredentials，runtime 未翻译

const conversationPushNode = "_push";
// Go 的 3*time.Minute，JS 里以毫秒计。
const conversationPushTimeout = 3 * 60 * 1000;

Engine.prototype.PushConversationWorkspace = function (ctx, runID, requesterID, gitUserName, gitUserEmail, message, sharedTarget) {
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
    if (rc.Provider === RepositoryProviderSSH && sshKeys[rc.CloneURL] === "") {
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
      return this.pushConversationOnRunner(ctx, runnerID, run, repositories, requesterID, gitUserName, gitUserEmail, message, sharedTarget);
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

Engine.prototype.pushConversationOnRunner = function (ctx, runnerID, run, repositories, requesterID, gitUserName, gitUserEmail, message, sharedTarget) {
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
  const final = this.awaitRunnerTask(ctx, task.ID, null);
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

Engine.prototype.observeConversationPush = function (runID, heads, runnerID) {
  for (const head of heads) {
    this.observe(runID, "", new TelemetryEvent({ Category: "sandbox", Name: "work_branch.pushed", Phase: "finish", Message: `${head.Name} @ ${head.WorkBranch} → ${head.Head}`, Attributes: { repositoryId: head.RepositoryID, workBranch: head.WorkBranch, commit: head.Head, runnerId: runnerID } }));
    if (head.SharedBranch !== "") {
      this.observe(runID, "", new TelemetryEvent({ Category: "sandbox", Name: "work_branch.shared_pushed", Phase: "finish", Message: `${head.Name} @ ${head.WorkBranch} → ${head.SharedBranch} ${head.SharedHead}`, Attributes: { repositoryId: head.RepositoryID, workBranch: head.WorkBranch, sharedBranch: head.SharedBranch, commit: head.SharedHead, runnerId: runnerID } }));
    }
  }
};

function truncateCommitMessage(message) {
  const runes = [...message];
  if (runes.length > 2000) {
    return runes.slice(0, 2000).join("");
  }
  return message;
}

module.exports = { conversationPushNode, conversationPushTimeout, truncateCommitMessage };
