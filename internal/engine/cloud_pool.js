// cloud_pool.js —— 对应 Go 文件：internal/engine/cloud_pool.go
// 作用：云端执行机器池：把无默认执行机器的运行路由到带指定 Label 的平台 runner。
// (值, error) 译为返回值、失败 throw，(值, bool) 译为 [值, bool]；time.Duration 译为毫秒数；select + time.After 译为 async + sleepOrAbort。

"use strict";

const { Runner, RunnerStatusOnline } = require("../domain/runner.js"); // 对应 Go 的 domain.Runner/RunnerStatusOnline，runner.js 已翻译
const { ExecutionModeCloud, ExecutionModeRunner, RunnerWorkspaceLayoutShared } = require("../domain/observability.js"); // 对应 Go 的 domain.ExecutionMode*，observability.js 已翻译

class CloudRunnerPool {
  constructor(init = {}) {
    this.Label = init.Label ?? "";
    this.Projects = init.Projects ?? null;
    this.Required = init.Required ?? false;
  }

  serves(projectID) {
    return this.Label !== "" && cloudPoolServes(this.Projects, projectID);
  }
}

// Go 的 10*time.Minute，JS 里以毫秒计。
const poolBindWait = 10 * 60 * 1000;

Engine.prototype.ConfigureCloudRunnerPool = function (pool) {
  this.mu.Lock();
  try {
    // Go 的 defer e.mu.Unlock() 译为 finally。
    pool.Label = pool.Label.trim();
    this.cloudPool = pool;
  } finally {
    this.mu.Unlock();
  }
};

function ParseCloudRunnerProjects(raw) {
  const out = [];
  for (let p of raw.split(",")) {
    if ((p = p.trim()) !== "") {
      out.push(p);
    }
  }
  return out;
}

Engine.prototype.cloudPoolRunner = function (projectID) {
  this.mu.Lock();
  const pool = this.cloudPool;
  this.mu.Unlock();
  if (!pool.serves(projectID)) {
    return [new Runner(), false];
  }
  return this.pickPoolRunner(pool.Label);
};

Engine.prototype.ConversationCloudRunner = function (projectID) {
  this.mu.Lock();
  const pool = this.cloudPool;
  this.mu.Unlock();
  if (!pool.serves(projectID)) {
    return "";
  }
  for (const runner of this.repo.Runners()) {
    if (poolRunnerEligible(runner, pool.Label) && runner.SupportsConversationCLI()) {
      return runner.ID;
    }
  }
  throw new Error("云端暂无支持对话的在线执行机器，请升级 Runner 后重试");
};

Engine.prototype.pickPoolRunner = function (label) {
  const candidates = this.eligiblePoolRunners(label);
  if (candidates.length === 0) {
    return [new Runner(), false];
  }
  return [candidates[Math.floor(Math.random() * candidates.length)], true];
};

Engine.prototype.eligiblePoolRunners = function (label) {
  const out = [];
  for (const runner of this.repo.Runners()) {
    if (poolRunnerEligible(runner, label)) {
      out.push(runner);
    }
  }
  return out;
};

function poolRunnerEligible(runner, label) {
  // 池 runner 会收到所有用户的凭证，只有用平台 bootstrap token 注册（无 owner）的才合格。
  if (runner.OwnerUserID !== 0 || runner.Status !== RunnerStatusOnline || !runner.SupportsReportedOutputs() || !runner.SupportsIntegrate()) {
    return false;
  }
  for (const runnerLabel of runner.Labels ?? []) {
    if (runnerLabel.trim() === label) {
      return true;
    }
  }
  return false;
}

function cloudPoolServes(projects, projectID) {
  projectID = projectID.trim();
  for (const p of projects ?? []) {
    if (p === "*" || (projectID !== "" && p === projectID)) {
      return true;
    }
  }
  return false;
}

Engine.prototype.cloudPoolRequired = function (projectID) {
  this.mu.Lock();
  const pool = this.cloudPool;
  this.mu.Unlock();
  return pool.Required && pool.serves(projectID);
};

Engine.prototype.CloudPoolStatus = function () {
  const label = this.cloudPoolLabel();
  if (label === "") {
    return [false, 0];
  }
  return [true, this.eligiblePoolRunners(label).length];
};

Engine.prototype.cloudPoolLabel = function () {
  this.mu.Lock();
  try {
    // Go 的 defer e.mu.Unlock() 译为 finally。
    return this.cloudPool.Label;
  } finally {
    this.mu.Unlock();
  }
};

function isPoolRun(run) {
  return run.ExecutionContext.ExecutionPool === ExecutionModeCloud;
}

Engine.prototype.bindPoolRunner = async function (ctx, run, nodeID) {
  if (run.ExecutionContext.ExecutionPinned) {
    if (run.ExecutionContext.ExecutionRunnerID !== "") {
      const [r, ok] = this.repo.Runner(run.ExecutionContext.ExecutionRunnerID);
      if (!ok || r.Status !== RunnerStatusOnline) {
        throw new Error("会话绑定的执行机器暂不可用，请等待原机器恢复");
      }
    }
    return run;
  }
  // 并行首节点一起绑定：第一个选机器，其余重读运行后跟随。
  const release = this.lockPoolBinding(run.ID);
  try {
    // Go 的 defer release() 译为 finally。
    const [fresh, ok] = this.repo.RunState(run.ID);
    if (ok) {
      run = fresh;
    }
    const ec = run.ExecutionContext;
    let convert = ec.ExecutionMode === ExecutionModeCloud && this.cloudPoolRequired(ec.ProjectID);
    if (convert && hasCodeWorkspace(run) && hasWorkspaceProgress(run, nodeID)) {
      // 控制面检出里已有本次运行的改动。
      convert = false;
    }
    if (!isPoolRun(run) && !convert) {
      return run;
    }
    const previous = ec.ExecutionRunnerID.trim();
    if (previous !== "" && !convert) {
      const [runner, ok2] = this.repo.Runner(previous);
      if (ok2 && runner.Status === RunnerStatusOnline) {
        return run;
      }
      // 检出只在那台机器上：节点不推中间提交，换机器会丢掉前面节点的代码改动。
      if (hasCodeWorkspace(run) && hasWorkspaceProgress(run, nodeID)) {
        let name = previous;
        if (ok2 && runner.Name.trim() !== "") {
          name = runner.Name;
        }
        return await this.waitForBoundPoolRunner(ctx, run, nodeID, name);
      }
    }
    const label = this.cloudPoolLabel();
    if (label === "") {
      throw new Error("云端执行池未配置，无法为该运行分配执行机器");
    }
    const deadline = Date.now() + poolBindWait;
    let runner;
    let announced = false;
    for (;;) {
      let ok3;
      [runner, ok3] = this.pickPoolRunner(label);
      if (ok3) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`云端执行池（${label}）在 ${poolBindWait / 60000} 分钟内没有在线的执行机器，请确认执行机器已启动并在线后重试`);
      }
      if (!announced) {
        announced = true;
        this.updateRun(run.ID, (c) => {
          this.event(c, nodeID, "execution.waiting", `云端执行池（${label}）暂无在线的执行机器，最多等待 ${poolBindWait / 60000} 分钟`);
        });
      }
      // Go：select { case <-ctx.Done(): return ctx.Err(); case <-time.After(2 * time.Second): }
      await sleepOrAbort(ctx, 2000);
    }
    this.updateRun(run.ID, (c) => {
      c.ExecutionContext.ExecutionMode = ExecutionModeRunner;
      c.ExecutionContext.ExecutionPool = ExecutionModeCloud;
      c.ExecutionContext.ExecutionRunnerID = runner.ID;
      c.ExecutionContext.RunnerWorkspaceLayout = RunnerWorkspaceLayoutShared;
      let msg = `已分配云端执行机器 ${runner.Name}`;
      if (previous !== "") {
        let name = previous;
        const [old, ok4] = this.repo.Runner(previous);
        if (ok4 && old.Name.trim() !== "") {
          name = old.Name;
        }
        msg = `执行机器 ${name} 不可用，已切换到云端执行机器 ${runner.Name} 重新拉取代码`;
      }
      this.event(c, nodeID, "execution.bound", msg);
    });
    const [bound, ok5] = this.repo.RunState(run.ID);
    if (!ok5) {
      throw new Error("run not found");
    }
    // 本机沙箱不再是执行环境，断开即可；旧容器靠 sleep infinity 之外的清理。
    this.discardLocalSandbox(run.ID);
    return bound;
  } finally {
    release();
  }
};

Engine.prototype.waitForBoundPoolRunner = async function (ctx, run, nodeID, name) {
  // Go：waitCtx, cancel := context.WithTimeout(ctx, poolBindWait)
  const waitController = new AbortController();
  const waitTimer = setTimeout(() => waitController.abort(new Error("context deadline exceeded")), poolBindWait);
  if (ctx instanceof AbortSignal) {
    if (ctx.aborted) {
      waitController.abort(ctx.reason);
    } else {
      ctx.addEventListener("abort", () => waitController.abort(ctx.reason), { once: true });
    }
  }
  const waitCtx = waitController.signal;
  try {
    this.updateRun(run.ID, (c) => {
      this.event(c, nodeID, "execution.waiting", `执行机器 ${name} 暂时离线，等待原机器恢复以继续使用已有工作区，最多等待 ${poolBindWait / 60000} 分钟`);
    });
    for (;;) {
      if (waitCtx.aborted) {
        if (ctx instanceof AbortSignal && ctx.aborted) {
          throw ctx.reason;
        }
        throw new Error(`执行机器 ${name} 在 ${poolBindWait / 60000} 分钟内未恢复在线，工作区和之前节点的代码改动仍保留在原机器上；请等该机器恢复后重试，或从头重跑`);
      }
      const [runner, ok] = this.repo.Runner(run.ExecutionContext.ExecutionRunnerID);
      if (ok && runner.Status === RunnerStatusOnline) {
        this.updateRun(run.ID, (c) => {
          this.event(c, nodeID, "execution.resumed", `执行机器 ${name} 已恢复在线，继续使用原工作区`);
        });
        const [current, ok2] = this.repo.RunState(run.ID);
        if (!ok2) {
          throw new Error("run not found");
        }
        return current;
      }
      // Go：select { case <-waitCtx.Done(): case <-ticker.C: }，ticker 每 2 秒一跳。
      try {
        await sleepOrAbort(waitCtx, 2000);
      } catch (e) {
        // 超时或取消后回到循环顶检查。
      }
    }
  } finally {
    clearTimeout(waitTimer);
  }
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

module.exports = { CloudRunnerPool, poolBindWait, ParseCloudRunnerProjects, poolRunnerEligible, cloudPoolServes, isPoolRun };
