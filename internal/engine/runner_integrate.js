// runner_integrate.js —— 对应 Go 文件：internal/engine/runner_integrate.go
// 作用：在执行机器上排队合入动作并等待结果，返回冲突文件。
// (值, error) 译为成功返回值、失败 throw；repo 只返回 error 的方法译为返回 err，调用方检查后 throw；time.Now().UnixNano() 译为 Date.now() * 1000000。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { RunnerInvocation, RunnerTask, RunnerTaskActionIntegrate, RunnerTaskQueued, RunnerTaskSuccess, RunnerTaskCanceled, RunnerIntegrationResult } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerInvocation/RunnerTask/RunnerTaskActionIntegrate/RunnerTaskQueued/RunnerTaskSuccess/RunnerTaskCanceled/RunnerIntegrationResult，runner.js 已翻译
const { TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TelemetryEvent，run.js 已翻译
const { gitIdentityFrom } = require("./git_auth.js"); // 对应 Go 同包函数，git_auth.js 已翻译
const { integrationCommitLabel } = require("./integrate.js"); // 对应 Go 同包函数，integrate.js 已翻译

const integrationTaskNode = "_integrate";

Engine.prototype.integrateOnRunner = function (ctx, runner, run, rc, pushIntegrate) {
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
    ID: `rt-${Date.now() * 1000000}-${safeRunnerPath(rc.RepositoryID)}-${suffix}`,
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
  const putErr = this.repo.PutRunnerTask(task);
  if (putErr != null) {
    throw putErr;
  }
  this.notifyRunnerDispatch("terminal");
  const final = this.awaitRunnerTask(ctx, task.ID, null);
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
