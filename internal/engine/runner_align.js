/**
 * @file internal/engine/runner_align.js
 * 对应 Go 源文件：internal/engine/runner_align.go
 *
 * 作用与职责边界：
 * 实现基线对齐任务（将仓库默认分支合入集成分支）的路由与下发逻辑：
 * 当云执行机池存在支持基线对齐的在线执行机且仓库具备远端克隆地址时，加集成锁并下发 `align_baseline` 任务至池执行机；
 * 否则（或仅本地路径可达的仓库）回退到当前宿主机直接执行基线对齐，并将执行机返回结果解析为干净合并、冲突错误或失败错误。
 *
 * 语法差异说明：
 * - `Engine` 定义于 `engine.js`，本文件通过 `Engine.prototype` 挂载各基线对齐方法。
 * - Go 的 `context.Context` / `context.WithTimeout` 译为 `AbortSignal` / `AbortController` + `setTimeout`。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；`(值, bool)` 译为 `[值, boolean]`。
 * - Go 的 `defer` 译为 `try { ... } finally { ... }`；`time.Duration` 换算为毫秒数；`time.Now().UnixNano()` 译为 `BigInt(Date.now()) * 1000000n`。
 */

"use strict";

const { RepositoryProviderSSH } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryProviderSSH，project.js 已翻译
const { NormalizeIntegrateBranch } = require("../domain/sync.js"); // 对应 Go 的 domain.NormalizeIntegrateBranch，sync.js 已翻译
const { Runner, RunnerTask, RunnerTaskQueued, RunnerTaskSuccess, RunnerTaskActionAlignBaseline, RunnerInvocation, RunnerRepository, RunnerAlignResult } = require("../domain/runner.js"); // 对应 Go 的 domain.Runner/RunnerTask/RunnerTaskQueued/RunnerTaskSuccess/RunnerTaskActionAlignBaseline/RunnerInvocation/RunnerRepository/RunnerAlignResult，runner.js 已翻译
const { RunCredentials } = require("../runtime/runtime.js"); // 对应 Go 的 runtime.RunCredentials，runtime 待翻译
const { WithSSHKeys } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork.WithSSHKeys，gitwork 待翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { AlignConflictError, ShouldAlignIntegrate, alignIntegrateBaseline } = require("./align.js"); // 对应 Go 同包类型与函数，align.js 已翻译
const { withRunGitCredentials } = require("./git_auth.js"); // 对应 Go 同包函数，git_auth.js 已翻译
const { lockIntegration } = require("./integrate.js"); // 对应 Go 同包函数，integrate.js 已翻译
const { safeRunnerPath } = require("./runner_dispatch.js"); // 对应 Go 同包函数，runner_dispatch.js 已翻译

// 执行机基线对齐任务超时时间（15 分钟，单位：毫秒）。
const alignTaskTimeout = 15 * 60 * 1000;

/**
 * 以指定用户身份将仓库默认分支合入集成分支。
 * 存在可用云执行机池时在池执行机上执行，否则（以及仅本地路径可达的仓库）在当前宿主机执行。
 *
 * @param {import("../domain/project.js").RepositoryContext} repository - 目标仓库上下文（含分支、克隆地址与提供方类型）。
 * @param {number} userID - 用于获取 Git HTTP/SSH 凭证的责任用户 ID。
 * @returns {Promise<void>} 合并成功或无需对齐时正常返回，无返回值。
 * @throws {Error} 合并冲突（`AlignConflictError`）、执行机能力不足、超时或对齐失败时抛出错误。
 */
Engine.prototype.AlignBaselineForUser = async function (repository, userID) {
  return this.alignBaseline(repository, userID);
};

/**
 * 基线对齐内部实现：优先路由至云执行机池下发 `align_baseline` 任务，不可用时回退至本机 Git 对齐。
 * 池执行机模式下先获取仓库集成锁并在结束时释放，防止并发合入踩踏。
 *
 * @param {import("../domain/project.js").RepositoryContext} repository - 目标仓库上下文。
 * @param {number} userID - 用于获取 Git 凭证的用户 ID。
 * @returns {Promise<void>} 合并成功或无需对齐时正常返回，无返回值。
 * @throws {Error} 能力校验失败、加锁失败、任务入队/等待失败或合并结果存在冲突/错误时抛出错误。
 */
Engine.prototype.alignBaseline = async function (repository, userID) {
  if (!ShouldAlignIntegrate(repository)) {
    return;
  }
  const [runner, ok] = this.alignRunner(repository);
  const ssh = repository.Provider === RepositoryProviderSSH;
  if (!ok) {
    let ctx = withRunGitCredentials(null, new RunCredentials({ GitHTTPCredentials: this.repo.GitHTTPCredentialSecrets(null, userID) }));
    if (ssh) {
      ctx = WithSSHKeys(this.withSSHKnownHosts(ctx), this.repo.GitSSHKeysForRemotes(userID, [repository.CloneURL]));
    }
    return alignIntegrateBaseline(ctx, repository, this.repo);
  }
  this.requireWorkBranchCapabilities(runner.ID, [repository]);
  const unlock = lockIntegration(this.repo, repository.RepositoryID);
  try {
    const integrate = NormalizeIntegrateBranch(repository.IntegrateBranch);
    const id = `rt-${BigInt(Date.now()) * 1000000n}-${safeRunnerPath(repository.RepositoryID)}-align`;
    const task = new RunnerTask({
      ID: id,
      RunnerID: runner.ID,
      Provider: "terminal",
      Action: RunnerTaskActionAlignBaseline,
      Workspace: "align/" + id,
      Status: RunnerTaskQueued,
      MaxAttempts: 1,
      Invocation: new RunnerInvocation({ GitHTTPUserID: userID, Repositories: [new RunnerRepository({
        RepositoryID: repository.RepositoryID,
        Name: repository.Name,
        CloneURL: repository.CloneURL,
        UseSSH: ssh,
        IntegrateBranch: integrate,
        DefaultBranch: repository.DefaultBranch.trim(),
      })] }),
    });
    if (ssh) {
      task.Invocation.GitSSHUserID = userID;
    }
    this.repo.PutRunnerTask(task);
    this.notifyRunnerDispatch("terminal");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), alignTaskTimeout);
    let final;
    try {
      final = await this.awaitRunnerTask(controller.signal, id, null);
    } finally {
      clearTimeout(timer);
    }
    return runnerAlignOutcome(final, integrate, repository.DefaultBranch.trim());
  } finally {
    unlock();
  }
};

/**
 * 将已结束的 `align_baseline` 执行机任务结果转换为 `alignBaseline` 的最终结果或错误。
 * 任务失败时抛出错误，JSON 解码失败时抛出解码错误，存在合并冲突时抛出 `AlignConflictError`，干净合并时正常返回。
 *
 * @param {RunnerTask} final - 到达终态的执行机任务对象。
 * @param {string} integrate - 规范化后的集成分支名。
 * @param {string} defaultBranch - 去除首尾空白后的默认分支名。
 * @returns {void} 干净合并时无返回值。
 * @throws {Error|AlignConflictError} 任务非成功状态、结果 JSON 无法解析或存在冲突文件时抛出对应错误。
 */
function runnerAlignOutcome(final, integrate, defaultBranch) {
  if (final.Status !== RunnerTaskSuccess) {
    let msg = final.Error.trim();
    if (msg === "") {
      msg = "align_baseline " + final.Status + " on runner";
    }
    throw new Error(msg);
  }
  let result;
  try {
    result = Object.assign(new RunnerAlignResult(), JSON.parse(final.Result));
  } catch (err) {
    throw new Error(`decode align result: ${err.message}`);
  }
  if ((result.Conflicts ?? []).length > 0) {
    throw new AlignConflictError({ Integrate: integrate, Default: defaultBranch, Files: result.Conflicts, Blocks: result.Blocks });
  }
}

/**
 * 为指定仓库挑选一台支持基线对齐动作的云池执行机。
 * 仅当配置了云池标签、仓库具有远端克隆地址且池内存在支持 `align_baseline` 的在线执行机时返回命中结果。
 *
 * @param {import("../domain/project.js").RepositoryContext} repository - 目标仓库上下文。
 * @returns {[Runner, boolean]} 返回 `[选中的执行机, 是否命中]`；无可用执行机时返回 `[空 Runner 实例, false]`。
 */
Engine.prototype.alignRunner = function (repository) {
  const label = this.cloudPoolLabel();
  if (label === "" || repository.CloneURL.trim() === "") {
    return [new Runner(), false];
  }
  const [runner, ok] = this.pickPoolRunner(label);
  if (!ok || !runner.SupportsAlignBaseline()) {
    return [new Runner(), false];
  }
  return [runner, true];
};

module.exports = { alignTaskTimeout, runnerAlignOutcome };
