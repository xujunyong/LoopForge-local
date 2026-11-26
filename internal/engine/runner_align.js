// runner_align.js —— 对应 Go 文件：internal/engine/runner_align.go
// 作用：基线对齐任务下发：把默认分支合入集成分支，池内执行机或本机二选一。
// context.Context 译为 AbortSignal；(值, error) 译为成功返回值、失败 throw；(值, bool) 译为 [值, bool]；fmt.Sprintf 的 %q 译为 JSON.stringify。

"use strict";

const { RepositoryProviderSSH } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryProviderSSH，project.js 已翻译
const { NormalizeIntegrateBranch } = require("../domain/sync.js"); // 对应 Go 的 domain.NormalizeIntegrateBranch，sync.js 已翻译
const { Runner, RunnerTask, RunnerTaskQueued, RunnerTaskSuccess, RunnerTaskActionAlignBaseline, RunnerInvocation, RunnerRepository, RunnerAlignResult } = require("../domain/runner.js"); // 对应 Go 的 domain.Runner/RunnerTask/RunnerTaskQueued/RunnerTaskSuccess/RunnerTaskActionAlignBaseline/RunnerInvocation/RunnerRepository/RunnerAlignResult，runner.js 已翻译
const { RunCredentials } = require("../runtime/runtime.js"); // 对应 Go 的 runtime.RunCredentials，runtime 待翻译
const { WithSSHKeys } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork.WithSSHKeys，gitwork 待翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译

const alignTaskTimeout = 15 * 60 * 1000;

// AlignBaselineForUser：把仓库默认分支合入集成分支；有云执行机池时在池执行机上跑，否则（以及仅本地路径可达的仓库）在本机跑。
Engine.prototype.AlignBaselineForUser = async function (repository, userID) {
  return this.alignBaseline(repository, userID);
};

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
    const putErr = this.repo.PutRunnerTask(task);
    if (putErr != null) {
      throw putErr;
    }
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

// runnerAlignOutcome：把已结束的 align_baseline 执行机任务转成 alignBaseline 报告的错误：执行机失败、解码错误、分支分叉时为 AlignConflictError，干净合并为 nil。
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
