// conversation_workspace.js —— 对应 Go 文件：internal/engine/conversation_workspace.go
// 作用：对话工作区租约与恢复：闲置保存、回收认领、快照还原与跨实例重绑。
// (值, error) 译为返回值、失败 throw，(值, bool) 译为 [值, bool]；time.Duration 译为毫秒数；select + time.After 译为 async + sleepOrAbort；context.Context 译为 AbortSignal。

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { RunnerTaskQueued, RunnerTaskLeased, RunnerTaskRunning } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerTask*，runner.js 已翻译
const { RunnerWorkspaceRequest, RunnerWorkspaceOperationPrepare } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspace*，runner_workspace.js 已翻译
const { ErrWorkspaceInUse } = require("../repo/workspace_checkpoints.js"); // 对应 Go 的 repo.ErrWorkspaceInUse，workspace_checkpoints.js 已翻译
const { RunAssistantSessionID } = require("../repo/assistant_shared.js"); // 对应 Go 的 repo.RunAssistantSessionID，assistant_shared.js 已翻译
const { WorkspaceDirHasContent } = require("../runtime/workspace_checkpoint.js"); // 对应 Go 的 runtime.WorkspaceDirHasContent，runtime 未翻译
const { WithRepositoryCacheIn } = require("../runtime/repository_cache.js"); // 对应 Go 的 runtime.WithRepositoryCacheIn，runtime 未翻译
const { WithSSHKeys } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork.WithSSHKeys，gitwork 未翻译

// Go 的 time.Hour，JS 里以毫秒计。
const ConversationWorkspaceIdleTTL = 60 * 60 * 1000;

// Go 的空结构体 context key 没有 JS 对应写法，用 Symbol 作键，lease 直接挂在 ctx 上。
const conversationWorkspaceTokenKey = Symbol("conversationWorkspaceTokenKey");

class conversationWorkspaceLease {
  constructor(init = {}) {
    this.token = init.token ?? "";
    this.runID = init.runID ?? "";
  }
}

function WithConversationWorkspaceToken(ctx, token, ...runID) {
  const lease = new conversationWorkspaceLease({ token });
  if (runID.length > 0) {
    lease.runID = runID[0];
  }
  ctx[conversationWorkspaceTokenKey] = lease;
  return ctx;
}

function ConversationWorkspaceToken(ctx, ...runID) {
  const lease = (ctx != null && ctx[conversationWorkspaceTokenKey] instanceof conversationWorkspaceLease) ? ctx[conversationWorkspaceTokenKey] : new conversationWorkspaceLease();
  if (runID.length > 0 && (lease.runID === "" || lease.runID !== runID[0])) {
    return "";
  }
  return lease.token;
}

Engine.prototype.BeginConversationWorkspaceUse = function (id) {
  const [token, previous] = this.repo.BeginWorkspaceUsePreemptingSave(id, new Date());
  if (previous === "") {
    return token;
  }
  if (this.conversationSaves.has(previous)) {
    this.conversationSaves.get(previous)();
  }
  // 另一实例可能持有保存操作，其租约观察器会取消导出；只等 runner 的只读门探针，不等归档。
  try {
    this.waitForBackgroundWorkspaceSave(id);
  } catch (err) {
    try {
      this.repo.FinishWorkspaceUse(id, token, new Date(), null, "");
    } catch (e) {
      // Go 在此忽略该错误。
    }
    throw err;
  }
  return token;
};

Engine.prototype.RenewConversationWorkspaceUse = function (id, token) {
  this.repo.RenewWorkspaceUse(id, token, new Date());
};

Engine.prototype.ReleaseConversationWorkspace = function (id) {
  this.repo.ReleaseWorkspace(id, new Date());
};

Engine.prototype.ConversationWorkspaceStatus = function (id) {
  return this.repo.WorkspaceCheckpoint(id);
};

Engine.prototype.conversationWorkspaceIdle = function (run) {
  if (sharesWorkspace(run) || this.workspaceTerminals.HasRunScope(run.ID)) {
    return false;
  }
  if (this.WorkspaceActive != null && this.WorkspaceActive(run)) {
    return false;
  }
  if (run.Status === "running" || run.Status === "queued" || run.HasActiveNode()) {
    return false;
  }
  if (run.Status === "waiting" && !run.IsWorkspace()) {
    return false;
  }
  const tasks = this.repo.ActiveRunnerTasksForRun(run.ID);
  return tasks.length === 0;
};

Engine.prototype.conversationGenerationRunning = function (run) {
  const [session, ok] = this.repo.SharedAssistantSession(RunAssistantSessionID(run.ID));
  if (!ok) {
    return false;
  }
  const [job, ok2] = this.repo.PeekAssistantGeneration(session.UserID, session.ID);
  return ok2 && job.Status === "running";
};

Engine.prototype.EndConversationWorkspaceUse = function (ctx, id, token) {
  const now = new Date();
  let err = null;
  try {
    this.saveConversationWorkspaceAfterUse(ctx, id, token);
  } catch (e) {
    err = e;
  }
  let message = "";
  if (err != null) {
    message = err.message;
  }
  try {
    this.repo.FinishWorkspaceUse(id, token, now, null, message);
  } catch (finishErr) {
    throw finishErr;
  }
  if (err != null) {
    throw err;
  }
};

Engine.prototype.EnsureConversationWorkspace = function (ctx, id, token) {
  this.prepareConversationWorkspace(ctx, id, token, true);
};

Engine.prototype.MaterializeConversationWorkspace = async function (ctx, id) {
  const [run, ok] = this.repo.RunState(id);
  if (!ok) {
    throw new Error("运行不存在");
  }
  if (!run.IsWorkspace() || sharesWorkspace(run) || run.WorkspaceCleanedAt != null || this.foreignWorkspaceBind(run)) {
    return;
  }
  const [meta, exists] = this.repo.WorkspaceCheckpoint(id);
  if (exists && meta.SavedAt != null) {
    return;
  }
  if (this.defaultExecutionRunner(run) !== "") {
    await this.materializeRunnerConversationWorkspace(ctx, run);
    return;
  }
  const [root, reason] = this.LocalRunWorkspace(run);
  if (reason !== "") {
    throw new Error(reason);
  }
  let lstatErr = null;
  let rootExists = false;
  try {
    fs.lstatSync(root);
    rootExists = true;
  } catch (e) {
    lstatErr = e;
  }
  if (rootExists) {
    // 重试之前失败的检出（例如配好 Git Token 之前）；已有仓库检出的绝不动。
    let missing = false;
    for (const dir of repositoryWorkspaceDirs(root, run.RepositoryContexts())) {
      if (!fs.existsSync(path.join(dir, ".git"))) {
        missing = true;
      }
    }
    if (!missing) {
      return;
    }
  } else if (lstatErr.code !== "ENOENT") {
    throw lstatErr;
  }
  const env = this.acquireConversationEnvironment(ctx, run);
  env.nodeMu.Lock();
  try {
    // Go 的 defer env.nodeMu.Unlock() 译为 finally。
    // 与 SOP 节点同一份检出：责任人的 Git Token、冻结基分支、全新工作分支。
    const credentials = env.credentialSnapshot();
    ctx = this.withPreparationProgress(ctx, run.ID);
    ctx = withRunGitCredentials(ctx, credentials);
    ctx = WithSSHKeys(this.withSSHKnownHosts(ctx), credentials.GitSSHKeys);
    ctx = WithRepositoryCacheIn(ctx, env.Unwrap());
    return env.prepareRepositoriesOnce(() => {
      try {
        prepareRepositories(ctx, env.Workspace(), run.RepositoryContexts());
      } catch (err) {
        throw explainGitAuthFailure(new Error(`repository checkout: ${err.message}`), credentials.GitHTTPCredentials.length > 0);
      }
    });
  } finally {
    env.nodeMu.Unlock();
  }
};

// Go 的 30*time.Second，JS 里以毫秒计。
const runnerMaterializeBusyWait = 30 * 1000;

Engine.prototype.materializeRunnerConversationWorkspace = async function (ctx, run) {
  const request = this.preparedWorkspaceRequest(run, new RunnerWorkspaceRequest({ RunID: run.ID, Operation: RunnerWorkspaceOperationPrepare }));
  request.RefreshCleanRepositories = false;
  const deadline = Date.now() + runnerMaterializeBusyWait;
  for (;;) {
    const response = this.requestWorkspaceCheckpoint(ctx, run, request);
    if (response.Error === "") {
      return;
    }
    if (!runnerWorkspaceBusy(response) || Date.now() > deadline) {
      throw explainGitAuthFailure(new Error(response.Error), this.resolveRunCredentials(run).GitHTTPCredentials.length > 0);
    }
    // Go：select { case <-ctx.Done(): return ctx.Err(); case <-time.After(300 * time.Millisecond): }
    await sleepOrAbort(ctx, 300);
  }
};

Engine.prototype.PrepareConversationWorkspace = function (ctx, id, token) {
  return this.prepareConversationWorkspace(ctx, id, token, false);
};

Engine.prototype.prepareConversationWorkspace = function (ctx, id, token, requireLocal) {
  let err = null;
  try {
    this.ensureConversationWorkspace(ctx, id, token);
  } catch (e) {
    err = e;
  }
  if (err != null && (requireLocal || err !== ErrConversationWorkspaceBound)) {
    throw err;
  }
  const [meta] = this.repo.WorkspaceCheckpoint(id);
  if (meta.SavedAt != null) {
    return null;
  }
  const [run, ok] = this.repo.RunState(id);
  if (!ok) {
    throw new Error("运行不存在");
  }
  // 执行期间读者仍可用；节点正要自己产出新交付物时，绝不注入旧输出。
  if (run.HasActiveNode() || (!run.IsWorkspace() && (run.Status === "running" || run.Status === "queued"))) {
    return null;
  }
  return this.restoreArchivedWorkspaceFiles(ctx, run);
};

Engine.prototype.ensureConversationWorkspace = function (ctx, id, token) {
  const [run0, ok0] = this.repo.RunState(id);
  if (ok0 && sharesWorkspace(run0)) {
    throw new Error("子 SOP 共享父任务工作区，请从父任务操作");
  }
  const [meta, ok] = this.repo.WorkspaceCheckpoint(id);
  if (!ok || meta.LeaseToken !== token || meta.LeaseUntil == null || meta.LeaseUntil.getTime() < Date.now()) {
    throw ErrWorkspaceInUse;
  }
  this.repo.MarkWorkspaceFollowUp(id, token, new Date());
  const [run, ok2] = this.repo.RunState(id);
  if (!ok2) {
    throw new Error("运行不存在");
  }
  const runner = this.defaultExecutionRunner(run);
  if (runner === "" && this.foreignWorkspaceBind(run)) {
    if (run.WorkspaceCleanedAt != null) {
      this.restoreOrReuseRemoteConversationCheckpoint(ctx, run);
      return this.repo.RestoreCheckpointWorkspaceBinding(id, token, "", "", new Date());
    }
    // 未清理的检出仍属于在线实例；此处返回成功曾让对话先启动、随后在 LocalRunWorkspace 报通用生成错误。
    if (this.workspaceBlocked(run)) {
      throw ErrConversationWorkspaceBound;
    }
    return this.rebindOfflineConversationWorkspace(ctx, id, token, run);
  }
  if (runner === "" && run.WorkspaceCleanedAt == null) {
    const [root, reason] = this.LocalRunWorkspace(run);
    if (reason !== "") {
      throw new Error(reason);
    }
    let info = null;
    try {
      info = fs.lstatSync(root);
    } catch (e) {
      if (e.code !== "ENOENT") {
        throw e;
      }
    }
    if (info != null) {
      if (!info.isDirectory()) {
        throw new Error("工作区路径不是目录");
      }
      return;
    }
  } else if (runner !== "" && run.WorkspaceCleanedAt == null) {
    return;
  }
  if (runner !== "") {
    const [task, exists] = this.repo.RunnerTask("rt-cleanup-" + safeRunnerPath(id));
    if (exists) {
      let t = task;
      if (t.Status === RunnerTaskQueued) {
        this.repo.CancelRunnerTask(t.ID, new Date());
        // 认领可能与取消竞态；取消只请求停止，等清理真正完成。
        [t] = this.repo.RunnerTask(t.ID);
      }
      if (t.Status === RunnerTaskLeased || t.Status === RunnerTaskRunning) {
        throw new Error("工作区尚在回收，请稍后恢复");
      }
    }
    this.restoreOrReuseRemoteConversationCheckpoint(ctx, run);
    return this.repo.RestoreCheckpointWorkspaceBinding(id, token, "", "", new Date());
  }
  const root = this.sandboxes.RunWorkspace(id);
  let rootInfo = null;
  try {
    rootInfo = fs.lstatSync(root);
  } catch (e) {
    rootInfo = null;
  }
  if (rootInfo != null && rootInfo.isDirectory() && !this.foreignWorkspaceBind(run)) {
    const hasContent = WorkspaceDirHasContent(root);
    if (hasContent) {
      this.verifyStoredCheckpoint(ctx, id);
      return this.repo.RestoreCheckpointWorkspaceBinding(id, token, this.workspaceHost, this.sandboxes.Root(), new Date());
    }
    // 恢复前建的空目录或只有 .agentflow 的目录没有用户文件；拆掉绑旧 inode 的容器，
    // 让 restoreConversationCheckpoint 能原子替换它，下个容器绑定看到恢复后的文件。
    this.releaseRunEnvironment(id, false);
    this.sandboxes.DiscardRunContainer(ctx, id);
  }
  this.restoreConversationCheckpoint(ctx, run, root);
  return this.repo.RestoreCheckpointWorkspaceBinding(id, token, this.workspaceHost, this.sandboxes.Root(), new Date());
};

const ErrConversationWorkspaceBound = new Error("工作区绑定在其他 LoopForge 实例");

const ErrConversationWorkspaceLost = new Error("原工作区实例已下线，未保存的改动无法恢复。工作区已换到当前实例，请重试");

Engine.prototype.rebindOfflineConversationWorkspace = function (ctx, id, token, run) {
  const [, boundRoot] = this.workspaceBind(run);
  const local = this.sandboxes.RunWorkspace(id);
  const sameRoot = boundRoot === this.sandboxes.Root();
  let hasCheckout = false;
  if (sameRoot) {
    hasCheckout = WorkspaceDirHasContent(local);
  }
  let message = "原工作区实例已下线，当前实例继续使用同一目录中的检出";
  let lost = null;
  if (!hasCheckout) {
    this.releaseRunEnvironment(id, !sameRoot);
    this.sandboxes.DiscardRunContainer(ctx, id);
    const [meta] = this.repo.WorkspaceCheckpoint(id);
    if (meta.SavedAt != null && meta.SHA256 !== "") {
      this.restoreConversationCheckpoint(ctx, run, local);
      message = "原工作区实例已下线，已从最近一次快照恢复；快照之后的未提交改动已丢失";
    } else {
      fs.mkdirSync(local, { recursive: true, mode: 0o700 });
      lost = ErrConversationWorkspaceLost;
      message = lost.message;
    }
  }
  // 先让恢复好的检出就绪再发布新绑定，恢复失败可重试。
  this.repo.RestoreCheckpointWorkspaceBinding(id, token, this.workspaceHost, this.sandboxes.Root(), new Date());
  this.noteConversationWorkspaceRebound(id, message);
  if (lost != null) {
    throw lost;
  }
};

Engine.prototype.noteConversationWorkspaceRebound = function (id, message) {
  this.updateRunSettling(id, (r) => {
    this.event(r, "", "workspace.rebound", message);
  });
};

Engine.prototype.claimIdleConversationWorkspace = function (run, now) {
  if (sharesWorkspace(run)) {
    return [false, false, null];
  }
  let [meta, exists] = this.repo.WorkspaceCheckpoint(run.ID);
  const [session, shared] = this.repo.SharedAssistantSession(RunAssistantSessionID(run.ID));
  if (!exists && !run.IsWorkspace() && run.Status !== "succeeded" && run.Status !== "cancelled" && (!shared || session.Archived)) {
    return [false, false, null];
  }
  if (run.WorkspaceCleanedAt != null) {
    return [false, false, null];
  }
  if (!this.conversationWorkspaceIdle(run) || this.conversationGenerationRunning(run)) {
    return [true, false, null];
  }
  // Go 的零值 time.Time 在此译为 new Date(0)。
  let idleSinceBeforeLease = meta.LastUsedAt ?? new Date(0);
  if (run.UpdatedAt.getTime() > idleSinceBeforeLease.getTime()) {
    idleSinceBeforeLease = run.UpdatedAt;
  }
  const released = exists && meta.Released();
  const retryDue = meta.SaveRetryAt != null && now.getTime() >= meta.SaveRetryAt.getTime();
  if (exists && meta.FollowUp && !retryDue && !released && now.getTime() < idleSinceBeforeLease.getTime() + ConversationWorkspaceIdleTTL) {
    return [true, false, null];
  }
  let token;
  try {
    token = this.repo.BeginWorkspaceCheckpointSave(run.ID, now);
  } catch (e) {
    return [true, false, null];
  }
  meta = this.repo.WorkspaceCheckpoint(run.ID)[0];
  let idleSince = meta.LastUsedAt ?? new Date(0);
  if (!exists) {
    idleSince = run.UpdatedAt;
    if (idleSince.getTime() === 0) {
      idleSince = now;
    }
  }
  if (run.UpdatedAt.getTime() > idleSince.getTime()) {
    idleSince = run.UpdatedAt;
  }
  // 闲置群组仍是进行中的对话，即使 Main Bot 只委派、从未调工作区工具；同样给一小时。
  if (run.IsWorkspace() && !meta.FollowUp) {
    try {
      this.repo.MarkWorkspaceFollowUp(run.ID, token, idleSince);
    } catch (err) {
      try {
        this.repo.FinishWorkspaceCheckpointSave(run.ID, token, idleSince, now, err.message);
      } catch (e) {
        // Go 在此忽略该错误。
      }
      throw err;
    }
    meta.FollowUp = true;
  }
  let saveError = "";
  let claimed = false;
  const finish = () => {
    let attemptedAt = new Date();
    if (now.getTime() > attemptedAt.getTime()) {
      attemptedAt = now;
    }
    try {
      this.repo.FinishWorkspaceCheckpointSave(run.ID, token, idleSince, attemptedAt, saveError);
    } catch (e) {
      // Go 在此忽略该错误。
    }
  };
  try {
    // Go 的 defer func() { if !claimed { finish() } }() 译为 finally。
    if (retryDue || released || meta.SavedAt == null || run.UpdatedAt.getTime() > meta.SavedAt.getTime() || meta.Error !== "" || now.getTime() >= idleSince.getTime() + ConversationWorkspaceIdleTTL) {
      // Go：ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
      const saveController = new AbortController();
      const saveTimer = setTimeout(() => saveController.abort(new Error("context deadline exceeded")), 5 * 60 * 1000);
      try {
        this.saveConversationWorkspace(saveController.signal, run, token);
      } catch (captureErr) {
        saveError = captureErr.message;
        throw captureErr;
      } finally {
        clearTimeout(saveTimer);
      }
    }
    if (meta.FollowUp && !released && now.getTime() < idleSince.getTime() + ConversationWorkspaceIdleTTL) {
      return [true, false, null];
    }
    // 修订与节点检查把删除认领与 SOP 或群组分派串行化。
    claimed = this.repo.ClaimCheckpointWorkspaceCleanup(run.ID, token, run.Revision, now);
    if (claimed) {
      return [true, true, finish];
    }
    return [true, false, null];
  } finally {
    if (!claimed) {
      finish();
    }
  }
};

Engine.prototype.restoreCheckpointBeforeExecution = async function (ctx, run) {
  if (sharesWorkspace(run)) {
    await this.RestoreConversationWorkspaceIfNeeded(ctx, workspaceRunID(run));
    return;
  }
  const [checkpoint, exists] = this.repo.WorkspaceCheckpoint(run.ID);
  // Main Bot 回合或 IDE 心跳也会建这行元数据；旧回收运行可能有租约但无存档。
  if (!exists) {
    return;
  }
  if (checkpoint.SavedAt == null) {
    if (checkpoint.LeaseUntil != null && checkpoint.LeaseUntil.getTime() > Date.now() && checkpoint.LeaseToken !== ConversationWorkspaceToken(ctx, run.ID)) {
      throw ErrWorkspaceInUse;
    }
    return;
  }
  let token = ConversationWorkspaceToken(ctx, run.ID);
  const owned = token !== "";
  if (!owned) {
    token = await this.beginWorkspaceUseAfterCleanup(ctx, run.ID);
    // 重连复用不可变的已保存文件；此处重拍会多一次完整归档上传，重试还没开始。
    try {
      return this.EnsureConversationWorkspace(ctx, run.ID, token);
    } finally {
      try {
        this.repo.FinishWorkspaceUse(run.ID, token, new Date(), null, "");
      } catch (e) {
        // Go 在此忽略该错误。
      }
    }
  }
  return this.EnsureConversationWorkspace(ctx, run.ID, token);
};

Engine.prototype.restoreCheckpointForExecution = async function (ctx, run, onBusy) {
  let notified = false;
  for (;;) {
    if (ctx instanceof AbortSignal && ctx.aborted) {
      throw ctx.reason;
    }
    let err = null;
    try {
      await this.restoreCheckpointBeforeExecution(ctx, run);
    } catch (e) {
      err = e;
    }
    if (err !== ErrWorkspaceInUse) {
      if (err != null) {
        throw err;
      }
      return;
    }
    if (!notified && onBusy != null) {
      onBusy();
      notified = true;
    }
    // Go：select { case <-ctx.Done(): return ctx.Err(); case <-time.After(100 * time.Millisecond): }
    await sleepOrAbort(ctx, 100);
  }
};

Engine.prototype.RestoreConversationWorkspaceIfNeeded = async function (ctx, id) {
  const [run, ok] = this.repo.RunState(id);
  if (!ok) {
    return;
  }
  if (run.WorkspaceCleanedAt == null) {
    return;
  }
  await this.restoreCheckpointBeforeExecution(ctx, run);
};

Engine.prototype.beginWorkspaceUseAfterCleanup = async function (ctx, id) {
  let token = "";
  let err = null;
  // 回收先标记目录再物理删除；等短命的保存/删除租约完成再重试，别与删除竞态。
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      token = this.BeginConversationWorkspaceUse(id);
      return token;
    } catch (e) {
      err = e;
      if (e !== ErrWorkspaceInUse) {
        throw e;
      }
    }
    // Go：select { case <-ctx.Done(): return "", ctx.Err(); case <-time.After(100 * time.Millisecond): }
    await sleepOrAbort(ctx, 100);
  }
  throw err;
};

// sleepOrAbort：等满毫秒或等到 ctx 取消，对应 Go 的 time.NewTimer + select。
function sleepOrAbort(ctx, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(ctx.reason);
    };
    const cleanup = () => {
      if (ctx instanceof AbortSignal) {
        ctx.removeEventListener("abort", onAbort);
      }
    };
    if (ctx instanceof AbortSignal) {
      if (ctx.aborted) {
        onAbort();
        return;
      }
      ctx.addEventListener("abort", onAbort, { once: true });
    }
  });
}

module.exports = { ConversationWorkspaceIdleTTL, conversationWorkspaceTokenKey, conversationWorkspaceLease, WithConversationWorkspaceToken, ConversationWorkspaceToken, ErrConversationWorkspaceBound, ErrConversationWorkspaceLost };
