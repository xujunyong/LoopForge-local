/**
 * @file internal/runtime/conversation_process.js
 * @description 对应 Go 源文件：internal/runtime/conversation_process.go
 *
 * 职责与边界：
 * 实现原生对话进程池（`ConversationProcessPool`），负责会话目录准备、资产同步与重置、
 * 原生/沙箱 CLI 进程启动与生命周期管理、标准输入写入与路径重映射、轮询拉取输出事件、
 * 进程停止与墓碑回收，以及本地 MCP 工具 HTTP 中继服务与退出后凭据/Git 密钥清理。
 * 不负责具体沙箱容器驱动实现或单个 Provider 的审批钩子脚本生成。
 *
 * 语法差异说明：
 * - `context.Context` 译为 `AbortSignal`（`context.Background()` 译为 `null`）；`context.WithCancel` 译为 `AbortController`。
 * - `goroutine` 译为不 `await` 的异步函数；`chan` 译为 `Promise`（`finished`/`terminalResult`/`watchDone`）或 `pending` 标志加待通知者数组（`wake`，带 1 位缓冲）。
 * - `sync.Mutex`/`sync.Once`/`atomic.Bool` 在单线程 JS 中略去，`fence` 的 `TryLock` 用 `locked` 标志表示；`defer` 译为 `try/finally`。
 * - `(值, error)` 译为成功返回值、失败抛出 `Error`；`(值, bool)` 译为 `[值, boolean]` 元组；`errors.Is` 译为 `===`；`os.IsNotExist` 译为 `err.code === "ENOENT"`。
 * - `os.Pipe` 译为单个 `PassThrough` 同时充当读写两端；`time.Duration` 译为毫秒数；`time.Time` 在过期校验中译为 `Date`，轮询时间戳用毫秒数。
 * - 与 `cli_version.js`、`conversation_sandbox.js` 存在同包循环依赖，调用时在函数内延迟 `require`。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const { PassThrough } = require("node:stream");

const { SandboxDriverNative, SandboxDriverDocker, SandboxDriverBwrap, SandboxDriverSeatbelt, ResolveSandboxDriver } = require("../domain/assets.js"); // 对应 Go 的 domain，assets.js 已翻译
const { SafeWorkspaceRelPath, RunnerSandboxSpec } = require("../domain/runner.js"); // 对应 Go 的 domain.SafeWorkspaceRelPath/RunnerSandboxSpec，runner.js 已翻译
const { CommandSpec, RunCredentials, BindGitWorkspace } = require("./runtime.js"); // 对应 Go 同包类型与常量，runtime.js 待翻译
const { SandboxRequirements } = require("./provider.js"); // 对应 Go 同包类型，provider.js 待翻译
const { SandboxResources } = require("./sandbox_environment.js"); // 对应 Go 同包类型，sandbox_environment.js 待翻译
const { AgentCLIKimi, AgentCLIPi, AgentCLIOpenCode, AgentCLICursor, AgentCLIAntigravity, AgentCLIZCode, AgentCLIBinary, AgentCLIHome, AgentCLIOptions, openAgentCLIHome, insertBeforeFlag, agyChatPermissions } = require("./agent_cli.js"); // 对应 Go 同包常量与函数，agent_cli.js 已翻译
const { zcodeProviderDir } = require("./agent_cli_zcode.js"); // 对应 Go 同包常量，agent_cli_zcode.js 已翻译
const { bindCommand } = require("./command_binding.js"); // 对应 Go 同包函数，command_binding.js 已翻译
const { lookPath } = require("./claude_install.js"); // 对应 Go 的 exec.LookPath，复用同包已翻译实现
const { RemoveConversationSkillLinks, ValidateConversationRoot, conversationAssetTrees, ConversationAsset, NewConversationStateError } = require("./conversation_assets.js"); // 对应 Go 同包函数与变量，conversation_assets.js 待翻译
const { InstallConversationApproval } = require("./conversation_approval.js"); // 对应 Go 同包函数，conversation_approval.js 待翻译
const { conversationZCodeResumeArgv } = require("./conversation_zcode.js"); // 对应 Go 同包函数，conversation_zcode.js 待翻译
const { conversationDockerAccess } = require("./conversation_network.js"); // 对应 Go 同包函数，conversation_network.js 待翻译
const { runnerLoginSpec, prepareConversationRunnerLogin } = require("./conversation_runner_login.js"); // 对应 Go 同包函数，conversation_runner_login.js 本次一同翻译
const { ScrubWorkspaceGitSecrets } = require("./git_workspace_scrub.js"); // 对应 Go 同包函数，git_workspace_scrub.js 待翻译
const { withBwrapManagedCLI } = require("./managed_cli.js"); // 对应 Go 同包函数，managed_cli.js 待翻译
const { sandboxDriver } = require("./runner.js"); // 对应 Go 同包函数，runner.js 待翻译
const { OpenRemoteSandbox, WithCommandEnvironment, CommandEnvironment, WithSandboxCredentials } = require("./remote_sandbox.js"); // 对应 Go 同包函数，remote_sandbox.js 待翻译
const { localSandbox, ExecuteLocalCommand } = require("./sandbox_local.js"); // 对应 Go 同包类型与函数，sandbox_local.js 待翻译
const { errProcessNotStarted } = require("./process.js"); // 对应 Go 同包变量，process.js 待翻译

// 只有已确认的准备失败才带这个标记；丢失的 start RPC 响应可能藏着一个正在运行的 CLI，绝不能当作可安全重启。
const ErrConversationNotStarted = new Error("conversation process was not started");

/**
 * 原生对话进程控制请求结构。
 * 只通过已认证的 Runner 控制连接传输，密钥与进程输入永不落库到持久化任务行。
 */
class ConversationProcessRequest {
  /**
   * 构造 `ConversationProcessRequest` 实例，按 Go 零值初始化各字段。
   * 在组装或反序列化会话控制请求时调用。
   *
   * @param {object} [init={}] 初始字段对象。
   */
  constructor(init = {}) {
    this.Transient = init.Transient ?? false;
    this.Operation = init.Operation ?? "";
    this.ID = init.ID ?? "";
    this.SessionKey = init.SessionKey ?? "";
    this.SourceRoot = init.SourceRoot ?? "";
    this.Files = init.Files ?? [];
    this.Command = init.Command ?? null;
    this.Data = init.Data ?? "";
    this.EOF = init.EOF ?? false;
    this.After = init.After ?? 0;
    this.Gateway = init.Gateway ?? "";
    this.Token = init.Token ?? "";
    this.ReportVersion = init.ReportVersion ?? false;
  }
}

/**
 * 会话资产同步中的单个文件描述。
 * 在 `sync` 操作中由平台发送至执行机器写入会话目录。
 */
class ConversationFile {
  /**
   * 构造 `ConversationFile` 实例，按 Go 零值初始化各字段。
   * 在构造同步文件列表时调用。
   *
   * @param {object} [init={}] 初始字段对象。
   */
  constructor(init = {}) {
    this.Rewrite = init.Rewrite ?? false;
    this.Path = init.Path ?? "";
    this.Data = init.Data ?? Buffer.alloc(0);
    this.Mode = init.Mode ?? 0;
  }
}

/**
 * 原生对话进程启动命令描述。
 * 携带命令行参数、供应商标识、凭据绑定、环境变量与交互模式标志。
 */
class ConversationCommand {
  /**
   * 构造 `ConversationCommand` 实例，按 Go 零值初始化各字段。
   * 在构造 `start` 请求的命令载荷时调用。
   *
   * @param {object} [init={}] 初始字段对象。
   */
  constructor(init = {}) {
    this.RunnerLogin = init.RunnerLogin ?? false;
    this.Argv = init.Argv ?? [];
    this.Provider = init.Provider ?? "";
    this.Bindings = init.Bindings ?? [];
    this.Environment = init.Environment ?? {};
    this.ExtraCredentialEnv = init.ExtraCredentialEnv ?? {};
    this.AgentCLI = init.AgentCLI ?? new AgentCLIOptions({});
    this.Credentials = init.Credentials ?? new RunCredentials({});
    this.Interactive = init.Interactive ?? false;
  }
}

/**
 * 根据通用 `CommandSpec` 与运行凭据构造 `ConversationCommand`。
 * 在平台侧将准备好的命令转换为可通过控制连接发送的对话命令时调用。
 *
 * @param {CommandSpec} command 命令规格对象。
 * @param {RunCredentials} credentials 运行凭据对象。
 * @returns {ConversationCommand} 转换后的对话命令对象。
 */
function ConversationCommandFor(command, credentials) {
  return new ConversationCommand({ Argv: command.Argv, Provider: command.Provider, Bindings: command.CredentialBindings, Environment: CommandEnvironment(command), ExtraCredentialEnv: command.ExtraCredentialEnv, AgentCLI: command.AgentCLI, Credentials: credentials, Interactive: command.Stdin != null });
}

/**
 * 原生对话进程控制请求的返回结果结构。
 * 用于返回会话根目录、进程 ID、增量输出事件、完成状态、错误信息及清理报告。
 */
class ConversationProcessResult {
  /**
   * 构造 `ConversationProcessResult` 实例，按 Go 零值初始化各字段。
   * 在 `ConversationProcessPool.Handle` 各操作分支返回结果时调用。
   *
   * @param {object} [init={}] 初始字段对象。
   */
  constructor(init = {}) {
    this.Root = init.Root ?? "";
    this.ID = init.ID ?? "";
    this.Events = init.Events ?? [];
    this.Sequence = init.Sequence ?? 0;
    this.Done = init.Done ?? false;
    this.Error = init.Error ?? "";
    this.NotStarted = init.NotStarted ?? false;
    this.CLIVersion = init.CLIVersion ?? "";
    this.VersionSource = init.VersionSource ?? "";
    // GitScrubbed 记的是 Agent 手写后被清理的 Git 凭据名，永不存值。
    this.GitScrubbed = init.GitScrubbed ?? [];
    // 只发回平台的会话相对路径。
    this.RemovedSkillLinks = init.RemovedSkillLinks ?? [];
  }
}

/**
 * 原生对话进程池，负责维护执行机器上活跃的对话进程、目录占用与资产读写互斥栅栏。
 * 在 Runner 进程内作为单例或长生命周期对象持有。
 */
class ConversationProcessPool {
  /**
   * 构造空的 `ConversationProcessPool` 实例。
   * 在初始化 Runner 运行时环境时调用。
   */
  constructor() {
    this.assets = {};
    this.entries = {};
    this.roots = {};
  }

  /**
   * 判断当前进程池中是否存在正在运行的原生对话进程。
   * 在 Runner 优雅退出或空闲检测场景下调用。
   *
   * @returns {boolean} 存在活跃会话根目录占用时返回 `true`，否则返回 `false`。
   */
  Active() {
    return Object.keys(this.roots ?? {}).length !== 0;
  }

  /**
   * 为指定会话根目录获取资产读写互斥栅栏，串行化资产修改与新进程启动预约。
   * 在 `prepare`、`sync`、`resetAssets`、`discard` 与 `start` 阶段调用。
   *
   * @param {AbortSignal|null} ctx 取消信号，取消时放弃等待并抛出错误。
   * @param {string} root 会话根目录的绝对路径。
   * @returns {Promise<Function>} 释放该目录栅栏的回调函数。
   */
  async lockAssets(ctx, root) {
    if (this.assets == null) {
      this.assets = {};
    }
    let fence = this.assets[root];
    if (fence == null) {
      fence = new conversationAssetFence();
      this.assets[root] = fence;
    }
    fence.users++;
    const releaseRef = () => {
      fence.users--;
      if (fence.users === 0) {
        delete this.assets[root];
      }
    };
    for (;;) {
      if (ctx instanceof AbortSignal && ctx.aborted) {
        releaseRef();
        throw ctx.reason ?? new Error("context canceled");
      }
      // Go：sync.Mutex.TryLock；JS 单线程，用 locked 标志表示。
      if (!fence.locked) {
        fence.locked = true;
        return () => {
          fence.locked = false;
          releaseRef();
        };
      }
      // Go：time.NewTimer(10ms) + select；ctx 取消时停表并继续循环，循环顶判 ctx.Err()。
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, 10);
        const cleanup = () => {
          if (ctx instanceof AbortSignal) {
            ctx.removeEventListener("abort", onAbort);
          }
        };
        const onAbort = () => {
          clearTimeout(timer);
          cleanup();
          resolve();
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
  }

  /**
   * 统一处理原生对话进程的各类控制请求（`start`、`prepare`、`sync`、`resetAssets`、`discard`、`write`、`stop`、`poll`）。
   * 拥有执行机器上稳定的原生 HOME；仅同步生成的配置与资产，CLI 历史留在该机器本地。
   *
   * @param {AbortSignal|null} ctx 请求级取消信号。
   * @param {string} root 会话根目录路径（内部会转为绝对路径）。
   * @param {string} workspace 关联的运行工作区路径（工作区模式下使用）。
   * @param {RunnerSandboxSpec|null} sandbox 可选的沙箱规格；为 `null` 时直接在宿主机运行。
   * @param {ConversationProcessRequest} req 控制请求对象。
   * @param {Function|null} forward MCP 工具转发回调 `(ctx, token, data) => Promise<Buffer>`。
   * @param {...Function} factories 可选的自定义沙箱工厂函数列表（测试或特殊注入使用）。
   * @returns {Promise<ConversationProcessResult>} 控制操作执行结果。
   */
  async Handle(ctx, root, workspace, sandbox, req, forward, ...factories) {
    root = path.resolve(root);
    if (req.Operation === "start") {
      return this.start(ctx, root, workspace, sandbox, req, forward, ...factories);
    }
    let removedSkillLinks = [];
    if (req.Operation === "prepare" || req.Operation === "sync" || req.Operation === "resetAssets" || req.Operation === "discard") {
      // 资产写与新进程的预约要串行；先查 roots 再放 fence 会让 start 抢在写之前跑起来。
      const unlock = await this.lockAssets(ctx, root);
      try {
        const active = ((this.roots ?? {})[root] ?? "") !== "";
        if (active) {
          throw new Error("会话原生进程仍在运行，不能替换资产或启动新进程");
        }
        if (req.Operation === "prepare") {
          removedSkillLinks = RemoveConversationSkillLinks(root);
        } else {
          ValidateConversationRoot(root);
        }
        if (req.Operation === "discard") {
          if (!req.Transient) {
            throw new Error("only transient conversations can be discarded");
          }
          fs.rmSync(root, { recursive: true, force: true });
          return new ConversationProcessResult({});
        }
        for (const dir of ["home/tmp", "ws"]) {
          try {
            fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
          } catch (err) {
            throw NewConversationStateError("创建会话目录", dir, err);
          }
        }
      } finally {
        unlock();
      }
    }
    if (req.Operation === "prepare") {
      return new ConversationProcessResult({ Root: root, RemovedSkillLinks: removedSkillLinks });
    }
    if (req.Operation === "resetAssets") {
      for (const dir of conversationAssetTrees) {
        const target = path.join(root, ...dir.split("/"));
        conversationAssetPath(root, target);
        fs.rmSync(target, { recursive: true, force: true });
      }
      return new ConversationProcessResult({});
    }
    if (req.Operation === "sync") {
      let total = 0;
      for (const file of req.Files ?? []) {
        total += file.Data.length;
        const [allowed, rewrite] = ConversationAsset(file.Path);
        if (total > 16 << 20 || !SafeWorkspaceRelPath(file.Path) || !allowed || file.Rewrite !== rewrite) {
          throw new Error("invalid conversation asset");
        }
        const target = path.join(root, ...file.Path.split("/"));
        conversationAssetPath(root, target);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        let data = file.Data;
        if (file.Rewrite && req.SourceRoot !== "") {
          data = Buffer.from(data.toString("utf8").replaceAll(req.SourceRoot, root), "utf8");
        }
        fs.writeFileSync(target, data, { mode: (file.Mode ?? 0) & 0o777 });
        fs.chmodSync(target, (file.Mode ?? 0) & 0o777);
      }
      return new ConversationProcessResult({ Root: root });
    }
    let proc = (this.entries ?? {})[req.ID] ?? null;
    if (proc == null && req.Operation === "stop") {
      // 即使 start 的 goroutine 还没注册，也要拦下已派发的 start；过期的 ID 不会再启动，墓碑可安全回收。
      let expires = null;
      let idErr = null;
      try {
        expires = conversationProcessIDExpiry(req.ID);
      } catch (err) {
        idErr = err;
      }
      if (idErr == null) {
        if (Date.now() >= expires.getTime()) {
          return new ConversationProcessResult({ Done: true });
        }
        proc = new conversationProcess({ root, cancel: () => {}, done: true });
        proc._resolveFinished();
        if (this.entries == null) {
          this.entries = {};
        }
        this.entries[req.ID] = proc;
        this.reapProcessAfter(req.ID, proc, expires);
      }
    }
    if (proc == null || proc.root !== root) {
      throw new Error("原生对话进程已断开，请重试以续接原会话");
    }
    switch (req.Operation) {
      case "write": {
        const input = proc.input;
        const workspace = proc.workspace;
        if (input == null) {
          throw new Error("process has no stdin");
        }
        // Go：context.AfterFunc(ctx, ...)；返回的 stop 在函数结束时调用。
        let stopWrite = () => {};
        if (ctx instanceof AbortSignal) {
          const onAbort = () => {
            proc.cancel();
            input.end();
          };
          ctx.addEventListener("abort", onAbort, { once: true });
          stopWrite = () => ctx.removeEventListener("abort", onAbort);
        }
        try {
          if (req.EOF) {
            try {
              input.end();
            } catch (err) {
              // 短命 CLI 可能在客户端转交最后的 EOF 前就退出了；已关闭的 stdin 不算错。
              if (err.code !== "ERR_STREAM_DESTROYED") {
                throw err;
              }
            }
          } else {
            const data = remapConversationStdin(req.Data, req.SourceRoot, root, workspace, proc.stdinProvider);
            input.write(data);
          }
        } finally {
          stopWrite();
        }
        return new ConversationProcessResult({});
      }
      case "stop": {
        proc.cancel();
        const input = proc.input;
        if (input != null) {
          input.end();
        }
        // Go：select { case <-proc.finished: ...; case <-ctx.Done(): ... }
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            reject(ctx.reason ?? new Error("context canceled"));
          };
          const cleanup = () => {
            if (ctx instanceof AbortSignal) {
              ctx.removeEventListener("abort", onAbort);
            }
          };
          proc.finishedPromise.then(() => {
            cleanup();
            resolve();
          });
          if (ctx instanceof AbortSignal) {
            if (ctx.aborted) {
              onAbort();
              return;
            }
            ctx.addEventListener("abort", onAbort, { once: true });
          }
        });
        return new ConversationProcessResult({ Done: true });
      }
      case "poll": {
        if (ctx instanceof AbortSignal && ctx.aborted) {
          throw ctx.reason ?? new Error("context canceled");
        }
        proc.lastPoll = Date.now();
        if (proc.events.length === 0 && !proc.done) {
          // Go：等 wake、1 秒定时器或 ctx 取消。
          if (!proc.wakePending) {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                cleanup();
                resolve();
              }, 1000);
              const cleanup = () => {
                const idx = proc.wakeWaiters.indexOf(onWake);
                if (idx !== -1) {
                  proc.wakeWaiters.splice(idx, 1);
                }
                if (ctx instanceof AbortSignal) {
                  ctx.removeEventListener("abort", onAbort);
                }
              };
              const onWake = () => {
                clearTimeout(timer);
                cleanup();
                resolve();
              };
              const onAbort = () => {
                clearTimeout(timer);
                cleanup();
                reject(ctx.reason ?? new Error("context canceled"));
              };
              if (ctx instanceof AbortSignal) {
                if (ctx.aborted) {
                  onAbort();
                  return;
                }
                ctx.addEventListener("abort", onAbort, { once: true });
              }
              proc.wakeWaiters.push(onWake);
            });
          }
          proc.wakePending = false;
        }
        const ack = req.After - proc.base;
        if (ack < 0 || ack > proc.events.length) {
          throw new Error("invalid process cursor");
        }
        for (const event of proc.events.slice(0, ack)) {
          proc.bytes -= event.Message.length;
        }
        proc.events = proc.events.slice(ack);
        proc.base = req.After;
        const n = Math.min(proc.events.length, 256);
        const result = new ConversationProcessResult({
          ID: req.ID, Events: proc.events.slice(0, n), Sequence: proc.base + n,
          Done: proc.done && n === proc.events.length, Error: proc.err, NotStarted: proc.notStarted,
          CLIVersion: proc.cliVersion, VersionSource: proc.versionSource,
        });
        if (result.Done) {
          result.GitScrubbed = [...(proc.gitScrubbed ?? [])];
        }
        return result;
      }
      default:
        throw new Error("invalid conversation process operation");
    }
  }

  /**
   * 延迟回收已完成或已取消的进程表项，确保在整个启动窗口内保留 ID 防止重复启动。
   * 在进程结束或 `stop` 写入墓碑条目时调用。
   *
   * @param {string} id 进程 ID。
   * @param {conversationProcess} proc 对应的进程记录对象。
   * @param {Date} expires 该进程 ID 的启动窗口截止时间。
   * @returns {void} 无返回值。
   */
  reapProcessAfter(id, proc, expires) {
    setTimeout(() => {
      if (this.entries[id] === proc) {
        delete this.entries[id];
      }
    }, Math.max(expires.getTime() - Date.now(), 60000));
  }

  /**
   * 启动一个新的原生对话 CLI 进程并注册到进程池，随后在后台异步执行命令并采集输出事件。
   * 由 `Handle` 在收到 `start` 操作时调用。
   *
   * @param {AbortSignal|null} ctx 请求级取消信号。
   * @param {string} root 会话根目录的绝对路径。
   * @param {string} workspace 关联的运行工作区路径。
   * @param {RunnerSandboxSpec|null} spec 沙箱规格；为 `null` 时在本机直接运行。
   * @param {ConversationProcessRequest} req 启动请求对象。
   * @param {Function|null} forward MCP 工具转发回调。
   * @param {...Function} factories 可选的自定义沙箱工厂函数列表。
   * @returns {Promise<ConversationProcessResult>} 包含 `Root` 与进程 `ID` 的启动结果。
   */
  async start(ctx, root, workspace, spec, req, forward, ...factories) {
    if (req.Command == null || (req.Command.Argv ?? []).length === 0) {
      throw new Error("missing conversation command");
    }
    let id = req.ID;
    if (id === "") {
      id = NewConversationProcessID();
    }
    const expires = conversationProcessIDExpiry(id);
    // Go：context.WithCancel(ctx)；父 ctx 取消时一并取消。
    const procController = new AbortController();
    if (ctx instanceof AbortSignal) {
      if (ctx.aborted) {
        procController.abort(ctx.reason);
      } else {
        ctx.addEventListener("abort", () => procController.abort(ctx.reason), { once: true });
      }
    }
    const procCtx = procController.signal;
    const procCancel = () => procController.abort();
    const proc = new conversationProcess({ cancel: procCancel, root, lastPoll: Date.now(), stdinProvider: req.Command.Provider });
    // 过期与预约共用 stop 的过期 ID 回复那把锁；卡在截止时间上的 start 注册后不能再跑。
    if (Date.now() >= expires.getTime()) {
      procCancel();
      throw new Error("expired conversation process ID");
    }
    if (this.entries == null) {
      this.entries = {};
    }
    if (this.roots == null) {
      this.roots = {};
    }
    if (this.entries[id] != null || (this.roots[root] ?? "") !== "") {
      procCancel();
      throw new Error("会话原生进程仍在运行或启动已取消");
    }
    this.entries[id] = proc;
    this.roots[root] = id;
    let sb = null;
    let release = null;
    let stdin = null;
    let cleanupLogin = null;
    // Go：atomic.Bool；JS 单线程，用普通布尔变量。
    let stopAfterTerminalResult = false;
    // Go：terminalResult 是只关闭一次的 chan；JS 用 Promise 表示。
    let resolveTerminalResult = null;
    const terminalResultPromise = new Promise((resolve) => {
      resolveTerminalResult = resolve;
    });
    let terminalOnce = false;
    const finish = (runErr, notStarted) => {
      procCancel();
      // 取消可能跳过 shell 的 EXIT 陷阱；先清临时的 ZCode 凭据，再发布完成或释放该 root。
      let credentialCleanupErr = null;
      try {
        cleanupConversationCredentialFiles(root, req.Command.Provider);
      } catch (err) {
        credentialCleanupErr = err;
      }
      if (cleanupLogin != null) {
        try {
          cleanupLogin();
        } catch (err) {
          // Go：errors.Join(credentialCleanupErr, cleanupLogin())。
          credentialCleanupErr = credentialCleanupErr == null ? err : new AggregateError([credentialCleanupErr, err]);
        }
      }
      let gitScrubbed = [];
      if ((req.Command.Bindings ?? []).includes(BindGitWorkspace)) {
        gitScrubbed = scrubConversationGitSecrets(root, sb);
      }
      if (stdin != null) {
        try {
          stdin.destroy();
        } catch {
          // Go：_ = stdin.Close()，忽略错误。
        }
      }
      if (proc.closeRelay != null) {
        proc.closeRelay();
      }
      if (release != null) {
        release();
      }
      if (proc.input != null) {
        try {
          proc.input.destroy();
        } catch {
          // Go：_ = proc.input.Close()，忽略错误。
        }
      }
      if (credentialCleanupErr != null) {
        proc.err = "清理 CLI 临时凭证失败";
        proc.notStarted = notStarted;
      }
      proc.gitScrubbed = gitScrubbed;
      // 进程是因协议已发出终态结果才停的；这次 kill 不算失败的一轮，结果行才算。
      if (runErr != null && stopAfterTerminalResult) {
        runErr = null;
        notStarted = false;
      }
      if (runErr != null && proc.err === "") {
        proc.err = runErr.message;
        proc.notStarted = notStarted;
      }
      proc.done = true;
      // Go：select { case proc.wake <- struct{}{}: default: }
      if (proc.wakeWaiters.length > 0) {
        proc.wakeWaiters.shift()();
      } else {
        proc.wakePending = true;
      }
      if (this.roots[root] === id) {
        delete this.roots[root];
      }
      this.reapProcessAfter(id, proc, expires);
      proc._resolveFinished();
    };
    let started = false;
    try {
      const unlock = await this.lockAssets(procCtx, root);
      try {
        if (procCtx.aborted) {
          throw procCtx.reason ?? new Error("context canceled");
        }
        ValidateConversationRoot(root);
        for (const dir of ["home/tmp", "ws"]) {
          try {
            fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
          } catch (err) {
            throw NewConversationStateError("创建会话目录", dir, err);
          }
        }
        if (spec != null) {
          let profile = spec.Profile;
          if (profile.Driver === SandboxDriverNative) {
            const goos = process.platform === "win32" ? "windows" : process.platform;
            profile = { ...profile, Driver: ResolveSandboxDriver(profile.Driver, goos) };
          }
          if (profile.Driver !== SandboxDriverDocker && profile.Driver !== SandboxDriverBwrap && profile.Driver !== SandboxDriverSeatbelt) {
            throw new Error("对话工作区只支持 Docker 或 native 沙箱");
          }
          const resolved = new RunnerSandboxSpec({ ...spec, Profile: profile });
          spec = resolved;
          if (factories.length > 0 && factories[0] != null) {
            [sb, release] = await factories[0](procCtx, root);
          } else {
            const resources = new SandboxResources({});
            if (spec.Dockerfile != null) {
              resources.Dockerfile = spec.Dockerfile;
            }
            sb = await OpenRemoteSandbox(procCtx, "conversation-" + id, workspace, spec.Profile, new SandboxRequirements({ ConversationRoot: root }), resources);
            if (sb != null) {
              release = () => {
                try {
                  sb.Close(null);
                } catch {
                  // Go：_ = sb.Close(context.Background())，忽略错误。
                }
              };
            }
          }
        } else if (factories.length > 0 && factories[0] != null) {
          [sb, release] = await factories[0](procCtx, root);
        }
        let command = new CommandSpec({ Argv: [...(req.Command.Argv ?? [])], Provider: req.Command.Provider, CredentialBindings: req.Command.Bindings, ExtraCredentialEnv: req.Command.ExtraCredentialEnv, AgentCLI: req.Command.AgentCLI });
        for (let i = 0; i < command.Argv.length; i++) {
          command.Argv[i] = conversationRemap(command.Argv[i], req.SourceRoot, root);
        }
        const env = {};
        for (const [key, value] of Object.entries(req.Command.Environment ?? {})) {
          env[key] = conversationRemap(value, req.SourceRoot, root);
        }
        command = WithCommandEnvironment(command, env);
        command = command.WithPrivateHomeDir(path.join(root, "home"));
        command.AgentCLI.SystemPromptFile = conversationRemap(command.AgentCLI.SystemPromptFile, req.SourceRoot, root);
        command.WorkingDir = path.join(root, "ws");
        if (spec != null && spec.Profile.Driver === SandboxDriverSeatbelt) {
          // macOS seatbelt 没有挂载命名空间，无法把 <root>/ws 映射到运行工作区，沙箱里的 CLI 直接指向运行工作区。
          if (sb != null && (sb.Workspace() ?? "").trim() !== "") {
            command.WorkingDir = sb.Workspace();
          } else if ((workspace ?? "").trim() !== "") {
            command.WorkingDir = workspace;
          }
          if (command.WorkingDir !== path.join(root, "ws")) {
            proc.workspace = command.WorkingDir;
          }
        }
        command.OwnProcessGroup = true;
        if (spec != null) {
          command.Argv[0] = conversationBinary(command.Provider);
        }
        if (forward != null && req.Token !== "") {
          const [url, closeRelay] = await startConversationRelay(procCtx, req.Token, forward, spec != null && spec.Profile.Driver === SandboxDriverDocker);
          proc.closeRelay = closeRelay;
          for (let i = 0; i < command.Argv.length; i++) {
            command.Argv[i] = command.Argv[i].replaceAll(req.Gateway, url);
          }
          for (const key of Object.keys(command.environment ?? {})) {
            command.environment[key] = command.environment[key].replaceAll(req.Gateway, url);
          }
          replaceConversationGateway(root, req.Gateway, url);
        }
        // 有些 CLI 在 hook 解释器起不来时还会继续跑；平台守卫与原生审批 hook 都必须默认失败关闭。
        if ((spec == null || spec.Profile.Driver !== SandboxDriverDocker) && (command.Provider === AgentCLIKimi || command.Provider === "codex" || command.Provider === AgentCLICursor || command.Provider === AgentCLIAntigravity || command.Provider === AgentCLIZCode)) {
          const check = spawnSync("python3", ["-c", "import json,urllib.request"], { signal: procCtx instanceof AbortSignal ? procCtx : undefined });
          if (check.error != null || check.status !== 0) {
            const runErr = check.error ?? new Error(`exit status ${check.status}`);
            throw new Error(`原生工具审批需要 Python3：${runErr.message}`);
          }
        }
        // 这些 provider 在平台模式下也会从持久 HOME 里加载 hook 与扩展；每次启动都刷新，免得从工作区回来跑了旧 hook（Pi 的 codemode 包装器必须够到它具体的工具）。
        if (spec != null || command.Provider === AgentCLIKimi || command.Provider === AgentCLIPi || command.Provider === AgentCLIOpenCode || command.Provider === AgentCLICursor || command.Provider === AgentCLIAntigravity || command.Provider === AgentCLIZCode) {
          command = InstallConversationApproval(root, command.Provider, command);
        }
        if (spec != null) {
          // 延迟 require 打破与 conversation_sandbox.js 的同包循环依赖。
          const { ensureConversationCLI } = require("./conversation_sandbox.js");
          const binary = await ensureConversationCLI(procCtx, sb, command.Provider, path.join(root, "home"));
          command.Argv[0] = binary;
        }
        if (sb == null) {
          const binary = lookPath(command.Argv[0]);
          if (binary == null) {
            throw new Error(`执行机器未安装 CLI ${command.Provider}：exec: "${command.Argv[0]}": executable file not found in $PATH`);
          }
          command.Argv[0] = binary;
        }
        const cliBinary = command.Argv[0];
        let bindSandbox = sb;
        let bindWorkspace = path.join(root, "ws");
        if (bindSandbox == null) {
          bindSandbox = new localSandbox({ id: "conversation", workspace: bindWorkspace });
        } else {
          bindWorkspace = bindSandbox.Workspace();
        }
        let localEnv = null;
        const [login, supported] = runnerLoginSpec(command.Provider);
        if (req.Command.RunnerLogin && !supported) {
          throw new Error("该 CLI 不支持使用执行机器的本机登录");
        }
        if (supported) {
          [cleanupLogin, localEnv] = prepareConversationRunnerLogin(root, login, req.Command.RunnerLogin, spec != null && spec.Profile.Driver === SandboxDriverDocker);
          if (req.Command.RunnerLogin) {
            command.CredentialBindings = (command.CredentialBindings ?? []).filter((binding) => binding !== login.binding);
            if (command.Provider === AgentCLIAntigravity && command.AgentCLI.ReadOnly) {
              const settings = JSON.stringify({ permissions: agyChatPermissions });
              command.Argv = insertBeforeFlag(command.Argv, "-p", "--settings", settings);
            }
          }
        }
        const nativeArgv = [...(command.Argv ?? [])];
        command = withBwrapManagedCLI(command, sandboxDriver(bindSandbox));
        command = bindCommand(procCtx, bindSandbox, bindWorkspace, command, req.Command.Credentials);
        command = WithCommandEnvironment(command, localEnv);
        if (command.Provider === AgentCLIZCode) {
          command.Argv = conversationZCodeResumeArgv(root, nativeArgv, command.Argv);
        }
        command.bindingsPrepared = true;
        if (req.Command.Interactive) {
          // Go：os.Pipe 返回读写两端；JS 用一个 PassThrough 同时充当两端。
          const pipe = new PassThrough();
          const input = pipe;
          const writer = pipe;
          proc.input = writer;
          stdin = input;
          command.Stdin = input;
        }
        if (procCtx.aborted) {
          throw procCtx.reason ?? new Error("context canceled");
        }
        started = true;
        (async () => {
          let runErr = null;
          // Go：defer close(watchDone) 先于 finish 执行；JS 用 AbortController 表示 watchDone。
          const watchController = new AbortController();
          const watchDonePromise = new Promise((resolve) => {
            watchController.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          let watchTimer = null;
          let stopObserve = null;
          try {
            watchTimer = setInterval(() => {
              if (watchController.signal.aborted || (procCtx instanceof AbortSignal && procCtx.aborted)) {
                clearInterval(watchTimer);
                return;
              }
              if (Date.now() - proc.lastPoll > 45000) {
                procCancel();
                clearInterval(watchTimer);
              }
            }, 10000);
            // Hook 解释器与浏览器助手可能在 CLI 已发出终态结果后还拖着它；与 ExecutorRunner 同样的等待窗口：让尾部输出落袋，再停掉进程。
            (async () => {
              const closed = await Promise.race([
                terminalResultPromise.then(() => true),
                watchDonePromise.then(() => false),
              ]);
              if (!closed) {
                return;
              }
              const drained = await new Promise((resolve) => {
                const timer = setTimeout(() => {
                  cleanup();
                  resolve(true);
                }, conversationTerminalResultDrain);
                const cleanup = () => {
                  watchController.signal.removeEventListener("abort", onAbort);
                  if (procCtx instanceof AbortSignal) {
                    procCtx.removeEventListener("abort", onAbort);
                  }
                };
                const onAbort = () => {
                  clearTimeout(timer);
                  cleanup();
                  resolve(false);
                };
                watchController.signal.addEventListener("abort", onAbort, { once: true });
                if (procCtx instanceof AbortSignal) {
                  if (procCtx.aborted) {
                    onAbort();
                    return;
                  }
                  procCtx.addEventListener("abort", onAbort, { once: true });
                }
              });
              if (drained) {
                stopAfterTerminalResult = true;
                procCancel();
              }
            })();
            const sink = (ev) => {
              if (ev.Name !== "process.stdout" && ev.Name !== "process.stderr") {
                return;
              }
              if (proc.bytes + ev.Message.length <= 8 << 20 && proc.events.length < 32768) {
                proc.events.push(ev);
                proc.bytes += ev.Message.length;
              } else {
                proc.err = "原生进程输出超过缓冲限制";
                procCancel();
              }
              if (ev.Name === "process.stdout" && conversationStdoutTerminal(ev.Message)) {
                if (!terminalOnce) {
                  terminalOnce = true;
                  resolveTerminalResult();
                }
              }
              // Go：select { case proc.wake <- struct{}{}: default: }
              if (proc.wakeWaiters.length > 0) {
                proc.wakeWaiters.shift()();
              } else {
                proc.wakePending = true;
              }
            };
            if (req.ReportVersion) {
              // 延迟 require 打破与 cli_version.js 的同包循环依赖。
              const { ObserveCLIVersion } = require("./cli_version.js");
              stopObserve = ObserveCLIVersion(procCtx, sb, command.Provider, cliBinary, (version, source) => {
                if (!proc.done) {
                  proc.cliVersion = version;
                  proc.versionSource = source;
                }
                // Go：select { case proc.wake <- struct{}{}: default: }
                if (proc.wakeWaiters.length > 0) {
                  proc.wakeWaiters.shift()();
                } else {
                  proc.wakePending = true;
                }
              });
            }
            try {
              if (sb != null) {
                await WithSandboxCredentials(sb, req.Command.Credentials).Exec(procCtx, command, sink);
              } else {
                await ExecuteLocalCommand(procCtx, path.join(root, "ws"), command, req.Command.Credentials, sink);
              }
            } catch (err) {
              runErr = err;
            }
          } finally {
            if (watchTimer != null) {
              clearInterval(watchTimer);
            }
            if (stopObserve != null) {
              stopObserve();
            }
            watchController.abort();
            finish(runErr, runErr === errProcessNotStarted);
          }
        })();
        return new ConversationProcessResult({ Root: root, ID: id });
      } finally {
        unlock();
      }
    } catch (err) {
      if (!started) {
        finish(err, true);
      }
      throw err;
    }
  }
}

/**
 * 单个会话根目录的资产读写互斥栅栏与引用计数结构。
 * 由 `ConversationProcessPool.lockAssets` 内部管理。
 */
class conversationAssetFence {
  /**
   * 构造 `conversationAssetFence` 实例。
   * 在某个会话根目录首次申请资产锁时调用。
   */
  constructor() {
    // Go：sync.Mutex；JS 单线程，用 locked 标志表示。
    this.locked = false;
    this.users = 0;
  }
}

/**
 * 进程池内单个运行中或已结束对话进程的内部状态记录。
 * 用于保存取消函数、标准输入流、输出事件缓冲、轮询时间、完成通知及版本/清理元数据。
 */
class conversationProcess {
  /**
   * 构造 `conversationProcess` 实例，按 Go 零值初始化各字段。
   * 在 `start` 创建进程记录或 `stop` 创建墓碑条目时调用。
   *
   * @param {object} [init={}] 初始字段对象。
   */
  constructor(init = {}) {
    this.cancel = init.cancel ?? (() => {});
    this.input = init.input ?? null;
    this.events = init.events ?? [];
    this.base = init.base ?? 0;
    this.done = init.done ?? false;
    this.err = init.err ?? "";
    // Go：wake 是带 1 位缓冲的 chan；JS 用 pending 标志加待通知者数组表示。
    this.wakePending = init.wakePending ?? false;
    this.wakeWaiters = [];
    this.lastPoll = init.lastPoll ?? Date.now();
    this.closeRelay = init.closeRelay ?? null;
    // Go：finished 是关闭即完成的 chan；JS 用 Promise 表示。
    this.finishedPromise = new Promise((resolve) => {
      this._resolveFinished = resolve;
    });
    this.root = init.root ?? "";
    this.bytes = init.bytes ?? 0;
    this.notStarted = init.notStarted ?? false;
    this.cliVersion = init.cliVersion ?? "";
    this.versionSource = init.versionSource ?? "";
    // workspace 顶掉 seatbelt 下 stdin 里的 <root>/ws，seatbelt 没有挂载命名空间，无法把该路径映射到运行工作区。
    this.workspace = init.workspace ?? "";
    this.stdinProvider = init.stdinProvider ?? "";
    // gitScrubbed 随 done 一起在 mu 下设置。
    this.gitScrubbed = init.gitScrubbed ?? [];
  }
}

/**
 * 逐级检查目标资产路径到会话根目录之间是否包含符号链接或越界逃逸。
 * 在 `resetAssets` 与 `sync` 写删资产文件前调用。
 *
 * @param {string} root 会话根目录的绝对路径。
 * @param {string} target 目标文件或目录的绝对路径。
 * @returns {void} 校验通过无返回值；包含符号链接、越界或 stat 异常时抛出错误。
 */
function conversationAssetPath(root, target) {
  for (let p = target; p !== root; p = path.dirname(p)) {
    let info = null;
    try {
      info = fs.lstatSync(p);
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
    if (info != null && info.isSymbolicLink()) {
      throw new Error("conversation asset contains symlink");
    }
    if (path.dirname(p) === p) {
      throw new Error("conversation asset outside root");
    }
  }
}

// conversationTerminalResultDrain 是 CLI 发出 stream-json 终态结果后还可逗留的时间；ExecutorRunner 在停掉超时未退的 hook 进程前用同一个窗口。
const conversationTerminalResultDrain = 2500;

/**
 * 判断一行标准输出是否为 Claude 风格 stream-json 的终态结果帧（`type === "result"`）。
 * 在进程事件采集回调 `sink` 中触发终态宽限倒计时时调用。
 *
 * @param {string} line 单行标准输出文本。
 * @returns {boolean} 是合法的终态结果 JSON 帧返回 `true`，否则返回 `false`。
 */
function conversationStdoutTerminal(line) {
  line = line.trim();
  if (line === "" || line[0] !== "{") {
    return false;
  }
  try {
    const event = JSON.parse(line);
    return event.type === "result";
  } catch {
    return false;
  }
}

// ID 在派发前生成，取消才能定位到响应已丢失的 start；有限的接受窗口让我们能回收取消墓碑，而不会让同一个迟到的 start 在之后又执行。
const conversationStartWindow = 5 * 60 * 1000;

/**
 * 生成 48 位十六进制对话进程 ID（前 16 位为毫秒时间戳，后 32 位为随机字节）。
 * 在派发新对话进程前由调用方或 `start` 自动生成。
 *
 * @returns {string} 48 字符十六进制进程 ID。
 */
function NewConversationProcessID() {
  const random = crypto.randomBytes(16);
  return Date.now().toString(16).padStart(16, "0") + random.toString("hex");
}

/**
 * 校验对话进程 ID 格式并计算其启动接受窗口的过期时间。
 * 在 `start` 预约进程及 `stop` 写入墓碑条目时调用。
 *
 * @param {string} id 待校验的 48 字符十六进制进程 ID。
 * @returns {Date} 该 ID 允许启动的截止时间。
 */
function conversationProcessIDExpiry(id) {
  if (id.length !== 48) {
    throw new Error("invalid conversation process ID");
  }
  if (!/^[0-9a-fA-F]{48}$/.test(id)) {
    throw new Error("invalid conversation process ID");
  }
  const stamp = parseInt(id.slice(0, 16), 16);
  const issued = new Date(stamp);
  if (issued.getTime() > Date.now() + 30000) {
    throw new Error("expired conversation process ID");
  }
  return new Date(issued.getTime() + conversationStartWindow);
}

/**
 * 清理工作区 CLI 使用过的 HOME（含会话 HOME 与工作区私有 HOME）及代码检出目录中残留的 Git 密钥。
 * 在对话进程结束的 `finish` 钩子中、当命令绑定了 `BindGitWorkspace` 时调用。
 *
 * @param {string} root 会话根目录的绝对路径。
 * @param {object|null} sb 沙箱实例；为 `null` 时使用 `<root>/ws` 作为工作区。
 * @returns {string[]} 被清理的 Git 凭据名称列表（不包含凭据值）。
 */
function scrubConversationGitSecrets(root, sb) {
  let workspace = path.join(root, "ws");
  if (sb != null && (sb.Workspace() ?? "").trim() !== "") {
    workspace = sb.Workspace();
  }
  const homes = [path.join(root, "home")];
  const privateHomes = path.join(workspace, ".agentflow", "private-home");
  let entries = null;
  try {
    // Go：os.ReadDir 按文件名排序。
    entries = fs.readdirSync(privateHomes, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    // Go：ReadDir 出错时跳过。
  }
  if (entries != null) {
    for (const entry of entries) {
      if (entry.isDirectory()) {
        homes.push(path.join(privateHomes, entry.name));
      }
    }
  }
  return ScrubWorkspaceGitSecrets(null, homes, workspace);
}

/**
 * 清理 ZCode 对话进程按次生成的临时凭据文件（`provider_config.*.json`），保留原生日志与其余配置。
 * 在对话进程结束的 `finish` 钩子中调用，防止进程被取消时跳过 shell 退出清理。
 *
 * @param {string} root 会话根目录的绝对路径。
 * @param {string} provider CLI 供应商标识。
 * @returns {void} 清理完成无返回值；文件操作异常时抛出错误。
 */
function cleanupConversationCredentialFiles(root, provider) {
  if (provider !== AgentCLIZCode) {
    return;
  }
  const home = openAgentCLIHome(new AgentCLIHome({ Base: root, Rel: "home" }));
  try {
    let dir;
    try {
      dir = home.Open(zcodeProviderDir);
    } catch (err) {
      if (err.code === "ENOENT") {
        return;
      }
      throw err;
    }
    try {
      const entries = dir.ReadDir(-1);
      // 这个 HOME 只属于一个会话进程；原生日志与无关的 CLI 配置保留，只清按次生成的密钥文件。
      for (const entry of entries) {
        if (!entry.IsDir() && entry.Name().startsWith("provider_config.") && entry.Name().endsWith(".json")) {
          try {
            home.Remove(zcodeProviderDir + "/" + entry.Name());
          } catch (err) {
            if (err.code !== "ENOENT") {
              throw err;
            }
          }
        }
      }
    } finally {
      dir.Close();
    }
  } finally {
    home.Close();
  }
}

/**
 * 将供应商标识映射为对应的 CLI 可执行文件名。
 * 在解析宿主机或容器内 CLI 二进制名称时调用。
 *
 * @param {string} provider CLI 供应商标识（如 `"codebuddy"`、`"codex"`、`"claude-code"` 等）。
 * @returns {string} 对应的可执行文件名。
 */
function conversationBinary(provider) {
  switch (provider) {
    case "codebuddy":
      return "codebuddy";
    case "codex":
      return "codex";
    case "claude-code":
      return "claude";
    default:
      return AgentCLIBinary(provider);
  }
}

/**
 * 启动本地 HTTP 中继服务，将 CLI 发往 `/internal/agent-tools/<token>/mcp` 的 POST 请求转发给平台工具处理器。
 * 在 `start` 检测到存在 `forward` 回调与非空 `Token` 时调用。
 *
 * @param {AbortSignal|null} ctx 进程级取消信号，取消时自动关闭中继服务。
 * @param {string} token 本次会话的工具鉴权令牌。
 * @param {Function} forward 工具转发回调 `(ctx, token, data) => Promise<Buffer|null>`。
 * @param {boolean} docker 是否为 Docker 沙箱模式（为 `true` 时监听 `0.0.0.0` 并解析容器可访问的宿主机地址）。
 * @returns {Promise<[string, Function]>} 二元组 `[中继基础 URL, 关闭中继的清理函数]`。
 */
async function startConversationRelay(ctx, token, forward, docker) {
  const host = docker ? "0.0.0.0" : "127.0.0.1";
  const server = http.createServer(async (req, res) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://127.0.0.1").pathname;
    } catch {
      pathname = req.url ?? "";
    }
    if (pathname !== "/internal/agent-tools/" + token + "/mcp" || req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 page not found\n");
      return;
    }
    let data;
    try {
      data = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
          // Go：io.LimitReader 最多读 (4<<20)+1 字节。
          if (size < (4 << 20) + 1) {
            chunks.push(chunk);
            size += chunk.length;
          }
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("invalid request\n");
      return;
    }
    if (data.length > 4 << 20) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("invalid request\n");
      return;
    }
    let result;
    try {
      result = await forward(ctx, token, data);
    } catch {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("gateway unavailable\n");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (result == null || result.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.end(result);
  });
  // Go：net.Listen 同步返回监听器；Node 需等 listening 事件才知道端口。
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const stop = () => {
    server.close();
  };
  // Go：context.AfterFunc(ctx, stop)。
  let stopContext = () => {};
  if (ctx instanceof AbortSignal) {
    const onAbort = () => stop();
    ctx.addEventListener("abort", onAbort, { once: true });
    stopContext = () => ctx.removeEventListener("abort", onAbort);
  }
  let relayHost = "127.0.0.1";
  if (docker) {
    try {
      [relayHost] = await conversationDockerAccess(ctx);
    } catch (err) {
      stopContext();
      stop();
      throw err;
    }
  }
  const formattedHost = relayHost.includes(":") ? "[" + relayHost + "]" : relayHost;
  return ["http://" + formattedHost + ":" + server.address().port, () => {
    stopContext();
    stop();
  }];
}

/**
 * 遍历会话目录下允许重写的资产文件，将其中的平台网关占位地址替换为本地中继 URL。
 * 在 `start` 启动本地工具中继后调用。
 *
 * @param {string} root 会话根目录的绝对路径。
 * @param {string} source 待替换的原始网关地址。
 * @param {string} target 替换后的本地中继 URL。
 * @returns {void} 替换完成无返回值；文件读写异常时抛出错误。
 */
function replaceConversationGateway(root, source, target) {
  if (source === "") {
    return;
  }
  const walk = (dir) => {
    // Go：filepath.WalkDir 按字典序访问。
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "ws" || entry.name === "sessions" || entry.name === "tmp" || entry.name === "projects") {
          continue;
        }
        walk(full);
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const rel = path.relative(root, full);
      const [allowed, rewrite] = ConversationAsset(rel.split(path.sep).join("/"));
      if (!allowed || !rewrite) {
        continue;
      }
      const info = fs.statSync(full);
      if (info.size > 4 << 20) {
        continue;
      }
      const data = fs.readFileSync(full);
      if (data.toString("utf8").includes(source)) {
        fs.writeFileSync(full, Buffer.from(data.toString("utf8").replaceAll(source, target), "utf8"), { mode: info.mode & 0o777 });
      }
    }
  };
  walk(root);
}

/**
 * 将字符串中出现的源根目录路径前缀全部替换为目标根目录路径。
 * 在重映射命令行参数、环境变量、系统提示词路径及标准输入时调用。
 *
 * @param {string} value 原始字符串。
 * @param {string} source 平台侧原始路径前缀；为空时不替换。
 * @param {string} target 执行机器侧目标路径前缀。
 * @returns {string} 替换后的字符串。
 */
function conversationRemap(value, source, target) {
  if (source === "") {
    return value;
  }
  return value.replaceAll(source, target);
}

/**
 * 返回路径在指定 CLI 标准输入流中对应的编码表示。
 * Codex app-server 帧使用 JSON 字符串，路径须以 JSON 转义后的形式重映射，即使单帧跨多次写入也能正确匹配。
 *
 * @param {string} path 原始文件路径。
 * @param {string} provider CLI 供应商标识。
 * @returns {string} 适用于该 CLI 标准输入流的编码路径字符串。
 */
function ConversationStdinPath(path, provider) {
  if (provider !== "codex") {
    return path;
  }
  const raw = JSON.stringify(path);
  return raw.slice(1, raw.length - 1);
}

/**
 * 对写入原生对话进程标准输入的数据执行根目录与工作区路径重映射。
 * 在 `Handle` 的 `write` 分支写入 stdin 前调用。
 *
 * @param {string} data 原始标准输入数据。
 * @param {string} source 平台侧原始会话根目录。
 * @param {string} root 执行机器侧会话根目录。
 * @param {string} workspace 可选的运行工作区路径（seatbelt 模式下用于替换 `<root>/ws`）。
 * @param {string} provider CLI 供应商标识。
 * @returns {string} 路径重映射后的标准输入数据。
 */
function remapConversationStdin(data, source, root, workspace, provider) {
  data = conversationRemap(data, ConversationStdinPath(source, provider), ConversationStdinPath(root, provider));
  if (workspace !== "") {
    data = conversationRemap(data, ConversationStdinPath(path.join(root, "ws"), provider), ConversationStdinPath(workspace, provider));
  }
  return data;
}

module.exports = { ErrConversationNotStarted, ConversationProcessRequest, ConversationFile, ConversationCommand, ConversationCommandFor, ConversationProcessResult, ConversationProcessPool, conversationAssetFence, conversationProcess, conversationAssetPath, conversationTerminalResultDrain, conversationStdoutTerminal, conversationStartWindow, NewConversationProcessID, conversationProcessIDExpiry, scrubConversationGitSecrets, cleanupConversationCredentialFiles, conversationBinary, startConversationRelay, replaceConversationGateway, conversationRemap, ConversationStdinPath, remapConversationStdin };
