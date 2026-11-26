// engine.js —— 对应 Go 文件：internal/engine/engine.go
// 作用：执行引擎：保存运行状态、后台维护任务与执行配置。
// context.Context 译为 AbortSignal；sync.Mutex 在单线程 JS 里不需要；sync.Map 译为 Map；time.Duration 换算为毫秒；(值, error) 译为成功返回值、失败 throw。

"use strict";

const os = require("node:os");

const { Run } = require("../domain/run.js"); // 对应 Go 的 domain.Run，run.js 已翻译
const { RunnerWorkspaceFacts, RunnerTask } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerWorkspaceFacts/RunnerTask，runner.js 已翻译
const { RunnerWorkspaceRequest, RunnerWorkspaceResponse } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspaceRequest/RunnerWorkspaceResponse，runner_workspace.js 已翻译
const { Store } = require("../repo/repo.js"); // 对应 Go 的 repo.Store，repo.js 已翻译
const { NewExecutorRunner } = require("../runtime/runner.js"); // 对应 Go 的 runtime.NewExecutorRunner，runtime 待翻译
const { Service } = require("../preview/service.js"); // 对应 Go 的 preview.Service，preview 待翻译

// Engine：执行引擎，Go 的 sync.Mutex 字段省略，JS 单线程无需加锁。
class Engine {
  constructor(init = {}) {
    this.repo = init.repo ?? null;
    this.sandboxes = init.sandboxes ?? null;
    this.runner = init.runner ?? null;
    this.running = init.running ?? {};
    this.runEnvs = init.runEnvs ?? {};
    this.workspaceTerminals = init.workspaceTerminals ?? null;
    this.checkpointTransfers = init.checkpointTransfers ?? null;
    this.conversationSaves = init.conversationSaves ?? new Map();
    this.workspaceFacts = init.workspaceFacts ?? {};
    this.cloudPool = init.cloudPool ?? null;
    this.execLocks = init.execLocks ?? null;
    this.nodeExecs = init.nodeExecs ?? {};
    this.subs = init.subs ?? {};
    this.runnerTaskSubs = init.runnerTaskSubs ?? {};
    this.instanceID = init.instanceID ?? "";
    this.workspaceHost = init.workspaceHost ?? "";
    this.leaseTTL = init.leaseTTL ?? 30 * 1000;
    this.executeRuns = init.executeRuns ?? true;
    this.draining = init.draining ?? false;
    this.MergeIntoBranch = init.MergeIntoBranch ?? null;
    this.FindBranchMR = init.FindBranchMR ?? null;
    this.FindBranchMRsInto = init.FindBranchMRsInto ?? null;
    this.runnerDispatchNotify = init.runnerDispatchNotify ?? null;
    this.runnerControlNotify = init.runnerControlNotify ?? null;
    this.runControlNotify = init.runControlNotify ?? null;
    this.controlRole = init.controlRole ?? "";
    this.controlURL = init.controlURL ?? "";
    this.controlToken = init.controlToken ?? "";
    this.workspaceControlBase = init.workspaceControlBase ?? "";
    this.fallbackWorkerURL = init.fallbackWorkerURL ?? "";
    this.controlClient = init.controlClient ?? null;
    this.platformMCPBase = init.platformMCPBase ?? "";
    this.platformMCPToken = init.platformMCPToken ?? "";
    this.preview = init.preview ?? null;
    this.obsPending = init.obsPending ?? [];
    this.obsKick = init.obsKick ?? null;
    this.WorkspaceActive = init.WorkspaceActive ?? null;
    this.WorkspaceCheckpointTransport = init.WorkspaceCheckpointTransport ?? null;
    this.maintenanceOnce = init.maintenanceOnce ?? false;
  }

  StartMaintenance(ctx) {
    if (ctx == null) {
      ctx = new AbortController().signal;
    }
    if (this.maintenanceOnce) {
      return;
    }
    this.maintenanceOnce = true;
    this.reclaimSandboxes();
    this.sandboxSweep(ctx);
    this.observationFlushLoop(ctx);
  }

  ConfigureExecution(instanceID, workspaceHost, ttl, enabled) {
    if (instanceID.trim() !== "") {
      this.instanceID = instanceID.trim();
    }
    if (workspaceHost.trim() !== "") {
      this.workspaceHost = workspaceHost.trim();
    }
    if (ttl > 0) {
      this.leaseTTL = ttl;
    }
    this.executeRuns = enabled;
  }

  ConfigurePlatformMCP(baseURL, token) {
    this.platformMCPBase = baseURL.trim().replace(/\/+$/, "");
    this.platformMCPToken = token.trim();
  }

  SetPreview(svc) {
    this.preview = svc;
    if (svc != null) {
      svc.SetHost(this);
    }
  }

  Preview() {
    return this.preview;
  }

  OnRunnerTaskCompleted(task) {
    if (this.preview != null) {
      this.preview.OnArchiveTaskCompleted(task);
    }
  }
}

const ErrExecutionDisabled = new Error("run execution is disabled on this instance");

function New(s, sm) {
  let host = "";
  try {
    host = os.hostname();
  } catch {
    host = "";
  }
  const e = new Engine({
    repo: s,
    sandboxes: sm,
    runner: NewExecutorRunner(),
    running: {},
    runEnvs: {},
    workspaceFacts: {},
    subs: {},
    runnerTaskSubs: {},
    instanceID: `${host}-${process.pid}`,
    workspaceHost: host,
    leaseTTL: 30 * 1000,
    executeRuns: true,
    obsKick: { pending: false, waiters: [] },
  });
  return e;
}

module.exports = { Engine, ErrExecutionDisabled, New };
