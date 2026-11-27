/**
 * @file internal/engine/conversation_workspace.js
 * 对应 Go 源文件：internal/engine/conversation_workspace.go
 *
 * 作用与职责边界：
 * 管理对话工作区的租约、空闲保存与回收认领、按需实体化检出、快照恢复、离线实例跨主机重绑定，
 * 以及节点执行前的快照恢复与租约竞争重试；
 * 领域方法挂载于 `Engine.prototype`（`Engine` 定义于 `engine.js`），后台异步保存逻辑位于 `conversation_workspace_save.js`。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一译为成功返回值（或 `undefined`）、失败 `throw err`；`(值, bool)` 译为 `[值, boolean]`。
 * - Go 的空结构体上下文键 `conversationWorkspaceTokenKey{}` 译为 `Symbol`，租约对象挂在 `ctx` 上。
 * - Go 的 `time.Duration` 换算为毫秒；`time.Time` 零值在对象属性中为 `null`（参与时间戳比较时按 `new Date(0)` 处理）。
 * - Go 的 `select` + `time.After` 译为 `async` + `Promise` 定时器与 `AbortSignal` 监听；`env.nodeMu` 在单线程 JS 中省略。
 */

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
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { withRunGitCredentials, explainGitAuthFailure } = require("./git_auth.js"); // 对应 Go 同包函数，git_auth.js 已翻译
const { repositoryWorkspaceDirs, prepareRepositories } = require("./repository_workspace.js"); // 对应 Go 同包函数，repository_workspace.js 已翻译
const { safeRunnerPath } = require("./runner_dispatch.js"); // 对应 Go 同包函数，runner_dispatch.js 已翻译
const { runnerWorkspaceBusy } = require("./workspace_busy.js"); // 对应 Go 同包函数，workspace_busy.js 已翻译
const { sharesWorkspace, workspaceRunID } = require("./workspace_owner.js"); // 对应 Go 同包函数，workspace_owner.js 已翻译

// 对话工作区在最后一次跟进使用后的空闲回收保护时长（1 小时，换算为毫秒）。
const ConversationWorkspaceIdleTTL = 60 * 60 * 1000;

// Go 的空结构体 context key 译为 Symbol，用于在上下文对象上挂载已持有的工作区租约。
const conversationWorkspaceTokenKey = Symbol("conversationWorkspaceTokenKey");

/**
 * 存放在上下文中的对话工作区租约记录，记录租约令牌及其可选的作用域运行 ID。
 */
class conversationWorkspaceLease {
  /**
   * 构造 `conversationWorkspaceLease` 实例，缺省字段按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.token=""] - 已持有的工作区租约令牌。
   * @param {string} [init.runID=""] - 可选的作用域运行 ID。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.token = init.token ?? "";
    this.runID = init.runID ?? "";
  }
}

/**
 * 将已获取的工作区租约令牌附加到上下文中；传入 `runID` 时将复用范围限定到该运行（包含子任务恢复场景）。
 * 使用场景：对话轮次或执行恢复链路向下游传递已持有的工作区租约时调用。
 *
 * @param {Object} ctx - 上下文对象（通常为 `AbortSignal` 或上下文载体）。
 * @param {string} token - 工作区租约令牌。
 * @param {...string} runID - 可选的作用域运行 ID（仅取首个元素）。
 * @returns {Object} 附加租约信息后的上下文对象。
 */
function WithConversationWorkspaceToken(ctx, token, ...runID) {
  const lease = new conversationWorkspaceLease({ token });
  if (runID.length > 0) {
    lease.runID = runID[0];
  }
  ctx[conversationWorkspaceTokenKey] = lease;
  return ctx;
}

/**
 * 从上下文中读取已附加的工作区租约令牌；若指定了 `runID`，则仅当租约显式绑定到同一 `runID` 时才返回令牌。
 * 使用场景：执行恢复或租约冲突判定时检查当前调用链是否已持有该运行的工作区租约。
 *
 * @param {Object | null} ctx - 上下文对象。
 * @param {...string} runID - 可选的期望运行 ID；传入时要求严格匹配。
 * @returns {string} 匹配的工作区租约令牌；不存在或作用域不匹配时返回空字符串 `""`。
 */
function ConversationWorkspaceToken(ctx, ...runID) {
  const lease = (ctx != null && ctx[conversationWorkspaceTokenKey] instanceof conversationWorkspaceLease) ? ctx[conversationWorkspaceTokenKey] : new conversationWorkspaceLease();
  if (runID.length > 0 && (lease.runID === "" || lease.runID !== runID[0])) {
    return "";
  }
  return lease.token;
}

/**
 * 申请对话工作区的前台使用租约；若存在正在进行的后台保存租约则将其抢占并取消，并等待远端只读门探针释放。
 * 使用场景：对话轮次、工具读写、推送或终端操作占用工作区前调用。
 *
 * @param {string} id - 运行（工作区）ID。
 * @returns {Promise<string>} 新签发的前台使用租约令牌。
 * @throws {Error} 租约被占用、数据库失败或等待后台保存退出超时时抛出错误。
 */
Engine.prototype.BeginConversationWorkspaceUse = async function (id) {
  const [token, previous] = this.repo.BeginWorkspaceUsePreemptingSave(id, new Date());
  if (previous === "") {
    return token;
  }
  if (this.conversationSaves.has(previous)) {
    this.conversationSaves.get(previous)();
  }
  // 另一 API 实例可能持有保存操作，其租约观察器会取消导出；只等 runner 的只读门探针，不等归档完成。
  try {
    await this.waitForBackgroundWorkspaceSave(id);
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

/**
 * 续约当前持有的对话工作区使用租约，延长其有效期。
 * 使用场景：长耗时对话轮次或 IDE 会话心跳维持租约时调用。
 *
 * @param {string} id - 运行（工作区）ID。
 * @param {string} token - 当前持有的工作区租约令牌。
 * @returns {void} 无返回值。
 * @throws {Error} 租约已失效或数据库更新失败时抛出错误。
 */
Engine.prototype.RenewConversationWorkspaceUse = function (id, token) {
  this.repo.RenewWorkspaceUse(id, token, new Date());
};

/**
 * 标记对话已切离该工作区，将其交由空闲巡检在无活跃执行时立即保存并回收。
 * 使用场景：用户切换对话工作区或关闭会话绑定时调用。
 *
 * @param {string} id - 运行（工作区）ID。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新失败时抛出错误。
 */
Engine.prototype.ReleaseConversationWorkspace = function (id) {
  this.repo.ReleaseWorkspace(id, new Date());
};

/**
 * 查询指定对话工作区的快照与租约元数据状态。
 * 使用场景：前端或服务层展示工作区快照状态与恢复进度时调用。
 *
 * @param {string} id - 运行（工作区）ID。
 * @returns {[Object, boolean]} 二元组 `[WorkspaceCheckpoint 元数据, 是否存在]`。
 */
Engine.prototype.ConversationWorkspaceStatus = function (id) {
  return this.repo.WorkspaceCheckpoint(id);
};

/**
 * 判断指定运行对应的对话工作区当前是否处于完全空闲状态（非共享子工作区、无终端占用、无活跃回调、无运行中节点及活跃 Runner 任务）。
 * 使用场景：前台使用结束保存快照以及后台空闲巡检回收前调用。
 *
 * @param {Object} run - 运行记录对象（`domain.Run`）。
 * @returns {boolean} 工作区当前空闲返回 `true`，否则返回 `false`。
 */
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
  try {
    const tasks = this.repo.ActiveRunnerTasksForRun(run.ID);
    return tasks.length === 0;
  } catch (err) {
    return false;
  }
};

/**
 * 判断该运行关联的共享助手会话当前是否正有生成任务在运行。
 * 使用场景：空闲巡检决定是否可以开始快照保存与工作区回收时调用。
 *
 * @param {Object} run - 运行记录对象（`domain.Run`）。
 * @returns {boolean} 存在处于 `"running"` 状态的助手生成任务时返回 `true`，否则返回 `false`。
 */
Engine.prototype.conversationGenerationRunning = function (run) {
  const [session, ok] = this.repo.SharedAssistantSession(RunAssistantSessionID(run.ID));
  if (!ok) {
    return false;
  }
  const [job, ok2] = this.repo.PeekAssistantGeneration(session.UserID, session.ID);
  return ok2 && job.Status === "running";
};

/**
 * 同步结束一次对话工作区前台使用：先尝试保存工作区快照，再释放工作区租约并记录可能出现的保存错误。
 * 使用场景：需要同步等待保存完成再释放租约的调用方使用。
 *
 * @param {AbortSignal | null} ctx - 取消信号。
 * @param {string} id - 运行（工作区）ID。
 * @param {string} token - 当前持有的前台租约令牌。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 释放租约失败或快照保存失败时抛出错误。
 */
Engine.prototype.EndConversationWorkspaceUse = async function (ctx, id, token) {
  const now = new Date();
  let err = null;
  try {
    await this.saveConversationWorkspaceAfterUse(ctx, id, token);
  } catch (e) {
    err = e;
  }
  let message = "";
  if (err != null) {
    message = err.message;
  }
  this.repo.FinishWorkspaceUse(id, token, now, null, message);
  if (err != null) {
    throw err;
  }
};

/**
 * 确保对话工作区已在本地或目标执行机器上就绪（严格要求本地工作区不被其他在线实例占用）。
 * 使用场景：需要精确恢复历史状态并立即可读写工作区时调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号。
 * @param {string} id - 运行（工作区）ID。
 * @param {string} token - 当前持有的工作区租约令牌。
 * @returns {void} 无返回值。
 * @throws {Error} 租约无效、工作区被其他实例占用或恢复失败时抛出错误。
 */
Engine.prototype.EnsureConversationWorkspace = function (ctx, id, token) {
  this.prepareConversationWorkspace(ctx, id, token, true);
};

/**
 * 为尚未生成过物理工作区的空闲对话工作区执行首次代码仓库检出，以便 Main Bot 在执行任何命令前即可读写代码；
 * 已保存过快照或已回收的工作区则交由 `PrepareConversationWorkspace` 负责恢复。
 * 使用场景：打开全新对话工作区或首次进行只读/编辑工具调用前触发。
 *
 * @param {AbortSignal | null} ctx - 取消信号。
 * @param {string} id - 运行（工作区）ID。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 运行不存在、本地路径不可用、目录检查失败、远端或本地仓库检出失败时抛出错误。
 */
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
  // Go 的 env.nodeMu.Lock()/Unlock() 在单线程 JS 中省略。
  // 与 SOP 节点同一份检出：责任人的 Git Token、冻结基分支、全新工作分支。
  const credentials = env.credentialSnapshot();
  ctx = this.withPreparationProgress(ctx, run.ID);
  ctx = withRunGitCredentials(ctx, credentials);
  ctx = WithSSHKeys(this.withSSHKnownHosts(ctx), credentials.GitSSHKeys);
  ctx = WithRepositoryCacheIn(ctx, env.Unwrap());
  env.prepareRepositoriesOnce(() => {
    try {
      prepareRepositories(ctx, env.Workspace(), run.RepositoryContexts());
    } catch (err) {
      throw explainGitAuthFailure(new Error(`repository checkout: ${err.message}`), credentials.GitHTTPCredentials.length > 0);
    }
  });
};

// 打开远端 Runner 工作区时，等待并发准备或快照导出释放的最长时长（30 秒，换算为毫秒）。
const runnerMaterializeBusyWait = 30 * 1000;

/**
 * 向远端 Runner 发送非刷新模式的工作区准备请求以创建缺失的仓库检出；
 * 若 Runner 正在执行并发准备或快照导出导致忙碌，则在 `runnerMaterializeBusyWait` 内每 300 毫秒重试一次。
 * 使用场景：运行绑定在远端 Runner 上且首次打开对话工作区时，由 `MaterializeConversationWorkspace` 调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号。
 * @param {Object} run - 运行记录对象（`domain.Run`）。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 构造请求失败、传输失败、准备报错、等待超时或上下文取消时抛出错误。
 */
Engine.prototype.materializeRunnerConversationWorkspace = async function (ctx, run) {
  const request = this.preparedWorkspaceRequest(run, new RunnerWorkspaceRequest({ RunID: run.ID, Operation: RunnerWorkspaceOperationPrepare }));
  request.RefreshCleanRepositories = false;
  const deadline = Date.now() + runnerMaterializeBusyWait;
  for (;;) {
    const response = await this.requestWorkspaceCheckpoint(ctx, run, request);
    if (response.Error === "") {
      return;
    }
    if (!runnerWorkspaceBusy(response) || Date.now() > deadline) {
      throw explainGitAuthFailure(new Error(response.Error), this.resolveRunCredentials(run).GitHTTPCredentials.length > 0);
    }
    // Go：select { case <-ctx.Done(): return ctx.Err(); case <-time.After(300 * time.Millisecond): }
    await new Promise((resolve, reject) => {
      if (ctx instanceof AbortSignal && ctx.aborted) {
        reject(ctx.reason);
        return;
      }
      const timer = setTimeout(() => {
        if (ctx instanceof AbortSignal) {
          ctx.removeEventListener("abort", onAbort);
        }
        resolve();
      }, 300);
      const onAbort = () => {
        clearTimeout(timer);
        reject(ctx.reason);
      };
      if (ctx instanceof AbortSignal) {
        ctx.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
};

/**
 * 准备对话工作区：恢复快照（若有）并在无快照的旧检出上补回归档产物文件（已有真实快照时以快照为准，保留主动删除）。
 * 使用场景：对话轮次开始前准备可读写的工作区内容时调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号。
 * @param {string} id - 运行（工作区）ID。
 * @param {string} token - 当前持有的工作区租约令牌。
 * @returns {string[] | null} 补回的归档文件相对路径列表；无需补回时返回 `null`。
 * @throws {Error} 租约无效、运行不存在或恢复过程失败时抛出错误。
 */
Engine.prototype.PrepareConversationWorkspace = function (ctx, id, token) {
  return this.prepareConversationWorkspace(ctx, id, token, false);
};

/**
 * 对话工作区准备的内部公共实现：先确保工作区存在或已从快照恢复，再在没有权威快照且无活跃节点执行时恢复归档产物。
 * 使用场景：由 `EnsureConversationWorkspace`（`requireLocal=true`）与 `PrepareConversationWorkspace`（`requireLocal=false`）调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号。
 * @param {string} id - 运行（工作区）ID。
 * @param {string} token - 当前持有的工作区租约令牌。
 * @param {boolean} requireLocal - 为 `true` 时将 `ErrConversationWorkspaceBound` 视为错误抛出；为 `false` 时允许继续只读归档逻辑。
 * @returns {string[] | null} 补回的归档文件路径列表；无需补回时返回 `null`。
 * @throws {Error} 确保工作区失败、运行不存在或恢复归档文件失败时抛出错误。
 */
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

/**
 * 校验租约与跟进标记，并根据工作区当前绑定状态（远端 Runner、其他在线/离线实例、本地已清理或已有内容）
 * 决定直接复用、取消清理任务、跨实例重绑或从快照恢复工作区并刷新绑定记录。
 * 使用场景：由 `prepareConversationWorkspace` 调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号。
 * @param {string} id - 运行（工作区）ID。
 * @param {string} token - 当前持有的工作区租约令牌。
 * @returns {void} 无返回值。
 * @throws {Error} 共享子工作区、租约失效（`ErrWorkspaceInUse`）、绑定在其他在线实例（`ErrConversationWorkspaceBound`）、尚在回收或恢复失败时抛出错误。
 */
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
      this.repo.RestoreCheckpointWorkspaceBinding(id, token, "", "", new Date());
      return;
    }
    // 未清理的检出仍属于在线实例；此处返回成功曾让对话先启动、随后在 LocalRunWorkspace 报通用生成错误。
    if (this.workspaceBlocked(run)) {
      throw ErrConversationWorkspaceBound;
    }
    this.rebindOfflineConversationWorkspace(ctx, id, token, run);
    return;
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
    this.repo.RestoreCheckpointWorkspaceBinding(id, token, "", "", new Date());
    return;
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
      this.repo.RestoreCheckpointWorkspaceBinding(id, token, this.workspaceHost, this.sandboxes.Root(), new Date());
      return;
    }
    // 恢复前建的空目录或只有 .agentflow 的目录没有用户文件；拆掉绑旧 inode 的容器，
    // 让 restoreConversationCheckpoint 能原子替换它，下个容器绑定看到恢复后的文件。
    this.releaseRunEnvironment(id, false);
    this.sandboxes.DiscardRunContainer(ctx, id);
  }
  this.restoreConversationCheckpoint(ctx, run, root);
  this.repo.RestoreCheckpointWorkspaceBinding(id, token, this.workspaceHost, this.sandboxes.Root(), new Date());
};

// 表示目标工作区仍绑定在另一台在线 LoopForge 实例上，当前进程不可直接打开其检出目录。
const ErrConversationWorkspaceBound = new Error("工作区绑定在其他 LoopForge 实例");

// 表示原绑定实例已下线且既无残留检出也无可用快照，工作区已重绑至当前实例，提示用户重试。
const ErrConversationWorkspaceLost = new Error("原工作区实例已下线，未保存的改动无法恢复。工作区已换到当前实例，请重试");

/**
 * 将原本绑定在已下线实例上的对话工作区迁移到当前实例：
 * 若共享同一沙箱根目录且目录内已有用户文件则直接沿用，否则尝试从最近一次快照恢复，
 * 若无快照则创建空目录并抛出 `ErrConversationWorkspaceLost`；仅在本地目录就绪后才发布新绑定。
 * 使用场景：检测到 `foreignWorkspaceBind(run)` 且原实例已不在线时，由 `ensureConversationWorkspace` 调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号。
 * @param {string} id - 运行（工作区）ID。
 * @param {string} token - 当前持有的工作区租约令牌。
 * @param {Object} run - 运行记录对象（`domain.Run`）。
 * @returns {void} 无返回值。
 * @throws {Error} 检查目录、释放旧环境、恢复快照、创建目录、更新绑定失败或无快照可恢复（`ErrConversationWorkspaceLost`）时抛出错误。
 */
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
  // 先让恢复好的检出就绪再发布新绑定，以便恢复失败时可重试。
  this.repo.RestoreCheckpointWorkspaceBinding(id, token, this.workspaceHost, this.sandboxes.Root(), new Date());
  this.noteConversationWorkspaceRebound(id, message);
  if (lost != null) {
    throw lost;
  }
};

/**
 * 在运行事件时间线中追加一条 `workspace.rebound` 事件，记录工作区跨实例重绑定的说明。
 * 使用场景：由 `rebindOfflineConversationWorkspace` 在重绑完成后调用。
 *
 * @param {string} id - 运行 ID。
 * @param {string} message - 重绑定说明文案。
 * @returns {void} 无返回值。
 */
Engine.prototype.noteConversationWorkspaceRebound = function (id, message) {
  this.updateRunSettling(id, (r) => {
    this.event(r, "", "workspace.rebound", message);
  });
};

/**
 * 在后台空闲巡检中尝试接管并保存闲置对话工作区快照，在满足回收条件时认领物理清理权。
 * 即使保存失败仍归为受管工作区，防止旧清理路径误删尚未持久化的文件。
 * 使用场景：后台沙箱与工作区清理巡检遍历候选运行时调用。
 *
 * @param {Object} run - 运行记录对象（`domain.Run`）。
 * @param {Date} now - 当前巡检时刻。
 * @returns {Promise<[boolean, boolean, (function(): void) | null]>} 三元组 `[是否受对话快照机制托管, 是否成功认领清理权, 清理完成后需调用的租约释放回调]`。
 * @throws {Error} 标记跟进状态失败、快照保存失败或认领清理权数据库失败时抛出错误。
 */
Engine.prototype.claimIdleConversationWorkspace = async function (run, now) {
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
  // 近期对话/IDE 活跃不与维护抢租约：前台结束时保存改动，物理回收等待 1 小时。
  // Go 的零值 time.Time 在此按 new Date(0) 处理。
  let idleSinceBeforeLease = meta.LastUsedAt ?? new Date(0);
  if (run.UpdatedAt != null && run.UpdatedAt.getTime() > idleSinceBeforeLease.getTime()) {
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
    idleSince = run.UpdatedAt ?? new Date(0);
    if (idleSince.getTime() === 0) {
      idleSince = now;
    }
  }
  if (run.UpdatedAt != null && run.UpdatedAt.getTime() > idleSince.getTime()) {
    idleSince = run.UpdatedAt;
  }
  // 闲置群组仍是进行中的对话，即使 Main Bot 只委派、从未调工作区工具；同样给一小时保护期。
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
    if (retryDue || released || meta.SavedAt == null || (run.UpdatedAt != null && run.UpdatedAt.getTime() > meta.SavedAt.getTime()) || meta.Error !== "" || now.getTime() >= idleSince.getTime() + ConversationWorkspaceIdleTTL) {
      // Go：ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
      const saveController = new AbortController();
      const saveTimer = setTimeout(() => saveController.abort(new Error("context deadline exceeded")), 5 * 60 * 1000);
      try {
        await this.saveConversationWorkspace(saveController.signal, run, token);
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
    // 修订号与节点检查把删除认领与 SOP 或群组分派串行化。
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

/**
 * 在节点执行或任务激活前检查并按需从快照恢复工作区：
 * 若为共享子工作区则递归恢复父工作区；若上下文已携带该运行的工作区租约则直接复用，
 * 否则临时申请租约完成恢复并在结束时释放（不重复重拍归档）。
 * 使用场景：由 `restoreCheckpointForExecution` 与 `RestoreConversationWorkspaceIfNeeded` 调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号（可能已携带工作区租约令牌）。
 * @param {Object} run - 运行记录对象（`domain.Run`）。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 租约被其他方占用（`ErrWorkspaceInUse`）或恢复工作区失败时抛出错误。
 */
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
      this.EnsureConversationWorkspace(ctx, run.ID, token);
      return;
    } finally {
      try {
        this.repo.FinishWorkspaceUse(run.ID, token, new Date(), null, "");
      } catch (e) {
        // Go 在此忽略该错误。
      }
    }
  }
  this.EnsureConversationWorkspace(ctx, run.ID, token);
};

/**
 * 在节点实际启动时循环等待并发工作区租约释放并完成快照恢复，避免临时租约竞争把节点尝试消耗为失败。
 * 首次遇到 `ErrWorkspaceInUse` 时会触发一次 `onBusy` 回调以向调用方反馈等待状态。
 * 使用场景：调度器真正启动节点执行前调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号。
 * @param {Object} run - 运行记录对象（`domain.Run`）。
 * @param {function(): void | null} onBusy - 首次检测到工作区被占用时触发的通知回调。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 上下文取消或发生非 `ErrWorkspaceInUse` 的恢复错误时抛出错误。
 */
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
    await new Promise((resolve, reject) => {
      if (ctx instanceof AbortSignal && ctx.aborted) {
        reject(ctx.reason);
        return;
      }
      const timer = setTimeout(() => {
        if (ctx instanceof AbortSignal) {
          ctx.removeEventListener("abort", onAbort);
        }
        resolve();
      }, 100);
      const onAbort = () => {
        clearTimeout(timer);
        reject(ctx.reason);
      };
      if (ctx instanceof AbortSignal) {
        ctx.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
};

/**
 * 若目标运行的工作区已被回收清理，则在激活修改运行状态或修订号之前预先从快照恢复其工作区。
 * 若运行不存在或工作区尚未被清理则直接返回（运行缺失交由常规激活校验报错）。
 * 使用场景：恢复/重跑/唤醒任务前的前置工作区恢复检查。
 *
 * @param {AbortSignal | null} ctx - 取消信号（可复用已有工作区租约）。
 * @param {string} id - 运行 ID。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 恢复快照或获取租约失败时抛出错误。
 */
Engine.prototype.RestoreConversationWorkspaceIfNeeded = async function (ctx, id) {
  const [run, ok] = this.repo.RunState(id);
  if (!ok) {
    return; // 常规激活校验会报告运行不存在
  }
  if (run.WorkspaceCleanedAt == null) {
    return;
  }
  await this.restoreCheckpointBeforeExecution(ctx, run);
};

/**
 * 在工作区刚刚被标记回收时，最多重试 50 次（每次间隔 100 毫秒）申请前台使用租约，
 * 等待短命的保存/删除租约自然结束，避免与物理删除发生竞态。
 * 使用场景：由 `restoreCheckpointBeforeExecution` 在无现成租约时调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号。
 * @param {string} id - 运行（工作区）ID。
 * @returns {Promise<string>} 成功获取的前台使用租约令牌。
 * @throws {Error} 上下文取消、出现非 `ErrWorkspaceInUse` 错误或重试 50 次仍被占用时抛出错误。
 */
Engine.prototype.beginWorkspaceUseAfterCleanup = async function (ctx, id) {
  let token = "";
  let err = null;
  // 回收先标记目录再物理删除；等短命的保存/删除租约完成再重试，避免与删除竞态。
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      token = await this.BeginConversationWorkspaceUse(id);
      return token;
    } catch (e) {
      err = e;
      if (e !== ErrWorkspaceInUse) {
        throw e;
      }
    }
    // Go：select { case <-ctx.Done(): return "", ctx.Err(); case <-time.After(100 * time.Millisecond): }
    await new Promise((resolve, reject) => {
      if (ctx instanceof AbortSignal && ctx.aborted) {
        reject(ctx.reason);
        return;
      }
      const timer = setTimeout(() => {
        if (ctx instanceof AbortSignal) {
          ctx.removeEventListener("abort", onAbort);
        }
        resolve();
      }, 100);
      const onAbort = () => {
        clearTimeout(timer);
        reject(ctx.reason);
      };
      if (ctx instanceof AbortSignal) {
        ctx.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
  throw err;
};

module.exports = { ConversationWorkspaceIdleTTL, conversationWorkspaceTokenKey, conversationWorkspaceLease, WithConversationWorkspaceToken, ConversationWorkspaceToken, ErrConversationWorkspaceBound, ErrConversationWorkspaceLost };
