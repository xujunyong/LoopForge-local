/**
 * @file internal/engine/runner_integrate.js
 * 对应 Go 源文件：internal/engine/runner_integrate.go
 *
 * 作用与职责边界：
 * 实现执行机器侧单仓库集成合入动作（`integrate`）的任务下发与结果收集：
 * 向持有运行工作区检出的执行机排队 `RunnerTaskActionIntegrate` 任务，按需推送合并结果到集成分支，
 * 等待任务完成、解析合并冲突列表并上报 `work_branch.integrated` 遥测事件。
 *
 * 语法差异说明：
 * - `Engine` 定义于 `engine.js`，本文件通过 `Engine.prototype` 挂载 `integrateOnRunner`。
 * - Go 的 `context.Context` 译为 `AbortSignal`；因等待 `awaitRunnerTask` 涉及异步阻塞，该方法译为 `async` 函数。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理。
 * - Go 的 `time.Now().UnixNano()` 译为 `BigInt(Date.now()) * 1000000n`。
 */

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { RunnerInvocation, RunnerTask, RunnerTaskActionIntegrate, RunnerTaskQueued, RunnerTaskSuccess, RunnerTaskCanceled, RunnerIntegrationResult } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerInvocation/RunnerTask/RunnerTaskActionIntegrate/RunnerTaskQueued/RunnerTaskSuccess/RunnerTaskCanceled/RunnerIntegrationResult，runner.js 已翻译
const { TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TelemetryEvent，run.js 已翻译
const { gitIdentityFrom } = require("./git_auth.js"); // 对应 Go 同包函数，git_auth.js 已翻译
const { integrationCommitLabel } = require("./integrate.js"); // 对应 Go 同包函数，integrate.js 已翻译
const { bindRunnerRepositories, safeRunnerPath, runnerWorkspaceRel } = require("./runner_dispatch.js"); // 对应 Go 同包函数，runner_dispatch.js 已翻译

// 集成动作在执行机任务列表中归属的虚拟节点名（集成属于整次运行，不归属某个工作流节点）。
const integrationTaskNode = "_integrate";

/**
 * 向持有运行工作区检出的执行机排队单仓库集成合入任务并等待其结束。
 * `pushIntegrate` 为 `true` 时执行机同步将合并结果推送至集成分支；返回合并过程中产生的冲突文件列表并上报已合并提交的遥测事件。
 *
 * @param {AbortSignal|null} ctx - 控制任务等待取消并携带 Git 身份的上下文信号。
 * @param {import("../domain/runner.js").Runner} runner - 目标执行机对象。
 * @param {import("../domain/run.js").Run} run - 当前运行快照对象。
 * @param {import("../domain/project.js").RepositoryContext} rc - 待执行集成合入的目标仓库上下文。
 * @param {boolean} pushIntegrate - 是否在合并成功后推送至远端集成分支。
 * @returns {Promise<string[]>} 合并产生的冲突文件路径列表（无冲突时为空数组）。
 * @throws {Error} 仓库不在运行仓库列表中、任务入队/等待失败、任务失败/取消或结果 JSON 解码失败时抛出错误。
 */
Engine.prototype.integrateOnRunner = async function (ctx, runner, run, rc, pushIntegrate) {
  const invocation = new RunnerInvocation({ RunID: run.ID, NodeID: integrationTaskNode });
  const identity = gitIdentityFrom(ctx);
  bindRunnerRepositories(invocation, run, identity.name, identity.email);
  invocation.Repository = null;
  let target = null;
  for (let i = 0; i < invocation.Repositories.length; i++) {
    if (invocation.Repositories[i].RepositoryID === rc.RepositoryID && invocation.Repositories[i].Dir === rc.WorkspaceDir) {
      target = invocation.Repositories[i];
      break;
    }
  }
  if (target == null) {
    throw new Error(`仓库 ${rc.Name} 不在运行 ${run.ID} 的仓库列表中`);
  }
  target.IntegrateBranch = rc.IntegrateBranch.trim();
  target.PushIntegrate = pushIntegrate;
  invocation.Repositories = [target];
  let suffix = "integrate";
  if (pushIntegrate) {
    suffix = "push-integrate";
  }
  const task = new RunnerTask({
    ID: `rt-${BigInt(Date.now()) * 1000000n}-${safeRunnerPath(rc.RepositoryID)}-${suffix}`,
    RunnerID: runner.ID,
    Provider: "terminal",
    Action: RunnerTaskActionIntegrate,
    IntegrationLabel: integrationCommitLabel(run),
    Workspace: runnerWorkspaceRel(run, integrationTaskNode),
    Status: RunnerTaskQueued,
    MaxAttempts: 1,
    RunID: run.ID,
    NodeID: integrationTaskNode,
    Invocation: invocation,
  });
  this.repo.PutRunnerTask(task);
  this.notifyRunnerDispatch("terminal");
  const final = await this.awaitRunnerTask(ctx, task.ID, null);
  switch (final.Status) {
    case RunnerTaskSuccess:
      break;
    case RunnerTaskCanceled:
      throw new Error("integrate canceled");
    default: {
      let msg = final.Error.trim();
      if (msg === "") {
        msg = "integrate failed on runner";
      }
      throw new Error(msg);
    }
  }
  let results = [];
  if (final.Result.trim() !== "") {
    try {
      results = JSON.parse(final.Result).map((r) => new RunnerIntegrationResult(r));
    } catch (err) {
      throw new Error(`decode integrate result: ${err.message}`);
    }
  }
  const conflicts = [];
  for (const result of results) {
    // Go 的 append(nil 切片) 为空操作，JS 里 null 按空数组处理。
    conflicts.push(...(result.Conflicts ?? []));
    if (result.Head !== "") {
      this.observe(run.ID, "", new TelemetryEvent({ Category: "sandbox", Name: "work_branch.integrated", Phase: "finish", Message: `${result.Name} @ ${result.WorkBranch} ← ${result.IntegrateBranch} → ${result.Head}`, Attributes: { repositoryId: result.RepositoryID, workBranch: result.WorkBranch, integrateBranch: result.IntegrateBranch, commit: result.Head, pushedIntegrate: result.PushedIntegrate, runnerId: runner.ID } }));
    }
  }
  return conflicts;
};

module.exports = { integrationTaskNode };
