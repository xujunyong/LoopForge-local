// engine.js —— 对应 Go 文件：internal/engine/engine.go
// 作用：执行引擎核心定义：维护运行期状态、执行配置、后台维护任务与预览宿主接入。
// 职责边界：仅负责 Engine 结构定义、构造与基础配置/回调入口；具体调度、观察、门禁与工作区逻辑由同包其他文件挂载到 Engine.prototype。
// 语法差异说明：context.Context 译为 AbortSignal；sync.Mutex 在单线程 JS 中省略；sync.Map 译为 Map；time.Duration 换算为毫秒；(值, error) 译为成功返回值、失败 throw。

"use strict";

const os = require("node:os");

const { Run } = require("../domain/run.js"); // 对应 Go 的 domain.Run，run.js 已翻译
const { RunnerWorkspaceFacts, RunnerTask } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerWorkspaceFacts/RunnerTask，runner.js 已翻译
const { RunnerWorkspaceRequest, RunnerWorkspaceResponse } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspaceRequest/RunnerWorkspaceResponse，runner_workspace.js 已翻译
const { Store } = require("../repo/repo.js"); // 对应 Go 的 repo.Store，repo.js 已翻译
const { NewExecutorRunner } = require("../runtime/runner.js"); // 对应 Go 的 runtime.NewExecutorRunner，runtime 待翻译
const { Service } = require("../preview/service.js"); // 对应 Go 的 preview.Service，preview 待翻译

/**
 * 执行引擎主类型，对应 Go 的 engine.Engine。
 * 用于协调工作流运行、沙箱生命周期、遥测观察队列、远端执行机器与预览服务；
 * Go 中的 sync.Mutex 字段在单线程 JS 中省略。
 */
class Engine {
  /**
   * 按 Go 结构体零值语义初始化 Engine 实例，在直接构造或由 New 工厂函数创建引擎时调用。
   * @param {Object} [init={}] - 可选的初始字段覆盖对象。
   * @returns {Engine} 初始化后的引擎实例。
   */
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
    this.leaseTTL = init.leaseTTL ?? 0;
    this.executeRuns = init.executeRuns ?? false;
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

  /**
   * 启动进程级后台维护任务（沙箱回收、定时清扫与遥测刷盘循环），保证仅启动一次。
   * 在服务主流程初始化完成后调用；New 故意不自动启动后台任务以便短生命周期调用方安全关闭。
   * @param {AbortSignal|null} [ctx] - 生命周期取消信号，为空时创建默认永不取消的 AbortSignal。
   * @returns {void} 无返回值。
   */
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

  /**
   * 配置当前引擎实例的身份、工作区主机名、租约时长与是否允许本地执行运行任务。
   * 在服务启动读取部署配置时调用。
   * @param {string} instanceID - 实例唯一标识，去空白后非空才覆盖。
   * @param {string} workspaceHost - 工作区所在主机名，去空白后非空才覆盖。
   * @param {number} ttl - 运行租约有效期（毫秒），大于 0 才覆盖。
   * @param {boolean} enabled - 是否允许本实例执行 Run。
   * @returns {void} 无返回值。
   */
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

  /**
   * 配置平台内置 MCP 端点基地址与可选 Bearer 令牌。
   * 用于为开启 AgentDefinition.PlatformMCP 的角色生成保留服务绑定；空基地址表示禁用。
   * @param {string} baseURL - 平台 API 基地址，会自动去除首尾空白与末尾斜杠。
   * @param {string} token - 可选 Bearer 令牌，会自动去除首尾空白。
   * @returns {void} 无返回值。
   */
  ConfigurePlatformMCP(baseURL, token) {
    this.platformMCPBase = baseURL.trim().replace(/\/+$/, "");
    this.platformMCPToken = token.trim();
  }

  /**
   * 绑定预览服务并将当前引擎注册为其宿主。
   * 在装配 HTTP 服务与预览模块时调用。
   * @param {Service|null} svc - 预览服务实例，可为 null。
   * @returns {void} 无返回值。
   */
  SetPreview(svc) {
    this.preview = svc;
    if (svc != null) {
      svc.SetHost(this);
    }
  }

  /**
   * 获取当前绑定的预览服务实例。
   * 在需要访问运行预览能力的场景下调用。
   * @returns {Service|null} 当前预览服务实例，未绑定时为 null。
   */
  Preview() {
    return this.preview;
  }

  /**
   * 处理执行机器任务完成回调，将其转发给预览服务以更新归档任务状态。
   * 在 runner 任务状态流转至终态时调用。
   * @param {RunnerTask} task - 已完成的执行机器任务对象。
   * @returns {void} 无返回值。
   */
  OnRunnerTaskCompleted(task) {
    if (this.preview != null) {
      this.preview.OnArchiveTaskCompleted(task);
    }
  }
}

/** 当实例禁用运行执行时返回的错误对象。 */
const ErrExecutionDisabled = new Error("run execution is disabled on this instance");

/**
 * 创建并初始化默认配置的 Engine 实例（不启动后台维护循环）。
 * 在服务启动装配或测试构造引擎时调用。
 * @param {Store|null} s - 数据仓库 Store 实例。
 * @param {Object|null} sm - 沙箱管理器（runtime.Manager）实例。
 * @returns {Engine} 初始化完成的执行引擎实例。
 */
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
