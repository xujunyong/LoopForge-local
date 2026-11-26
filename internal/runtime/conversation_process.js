// conversation_process.js —— 对应 Go 文件：internal/runtime/conversation_process.go
// 作用：原生对话进程池：启动、写 stdin、停止与轮询 CLI 进程，含沙箱绑定与工具中继。
// context.Context 译为 AbortSignal（context.Background() 译为 null）；context.WithCancel 译为 AbortController；
// goroutine 译为不 await 的异步函数；chan 译为 Promise（finished/terminalResult/watchDone）或 pending 标志加待通知者数组（wake，带 1 位缓冲）；
// sync.Mutex/sync.Once/atomic.Bool 在单线程 JS 里略去，fence 的 TryLock 用 locked 标志表示；defer 译为 try/finally；
// (值, error) 译为成功返回值、失败 throw；(值, bool) 译为 [值, bool]；errors.Is 译为 ===；os.IsNotExist 译为 err.code === "ENOENT"；
// os.Pipe 译为单个 PassThrough 同时充当读写两端；time.Duration 译为毫秒数；time.Time 译为毫秒时间戳。

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
// 与 cli_version.js 循环引用，整模块引用、调用时再取属性，避免加载时解构到未完成导出的值。
const cliVersion = require("./cli_version.js"); // 对应 Go 同包函数，cli_version.js 已翻译
const { RemoveConversationSkillLinks, ValidateConversationRoot, conversationAssetTrees, ConversationAsset, NewConversationStateError } = require("./conversation_assets.js"); // 对应 Go 同包函数与变量，conversation_assets.js 待翻译
const { InstallConversationApproval } = require("./conversation_approval.js"); // 对应 Go 同包函数，conversation_approval.js 待翻译
const { ensureConversationCLI } = require("./conversation_sandbox.js"); // 对应 Go 同包函数，conversation_sandbox.js 待翻译
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

// ConversationProcessRequest 只走已认证的 Runner 控制连接；密钥与进程输入永不进入持久任务行。
class ConversationProcessRequest {
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

class ConversationFile {
  constructor(init = {}) {
    this.Rewrite = init.Rewrite ?? false;
    this.Path = init.Path ?? "";
    this.Data = init.Data ?? Buffer.alloc(0);
    this.Mode = init.Mode ?? 0;
  }
}

class ConversationCommand {
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

function ConversationCommandFor(command, credentials) {
  return new ConversationCommand({ Argv: command.Argv, Provider: command.Provider, Bindings: command.CredentialBindings, Environment: CommandEnvironment(command), ExtraCredentialEnv: command.ExtraCredentialEnv, AgentCLI: command.AgentCLI, Credentials: credentials, Interactive: command.Stdin != null });
}

class ConversationProcessResult {
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

class ConversationProcessPool {
  constructor() {
    this.assets = null;
    this.entries = null;
    this.roots = null;
  }

  Active() {
    return Object.keys(this.roots ?? {}).length !== 0;
  }

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

  // Handle 拥有执行机器上稳定的原生 HOME；只有生成的配置与资产才同步，CLI 历史留在该机器上。
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

  // 调用方持有 p.mu；已完成的 ID 在整个启动窗口内保留。
  reapProcessAfter(id, proc, expires) {
    setTimeout(() => {
      if (this.entries[id] === proc) {
        delete this.entries[id];
      }
    }, Math.max(expires.getTime() - Date.now(), 60000));
  }

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
            profile = { ...profile, Driver: ResolveSandboxDriver(profile.Driver, process.platform) };
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
              stopObserve = cliVersion.ObserveCLIVersion(procCtx, sb, command.Provider, cliBinary, (version, source) => {
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

class conversationAssetFence {
  constructor() {
    // Go：sync.Mutex；JS 单线程，用 locked 标志表示。
    this.locked = false;
    this.users = 0;
  }
}

class conversationProcess {
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

// conversationStdoutTerminal 报告 Claude 风格 stream-json 的结果帧，Cursor、CodeBuddy 与其他 Agent CLI 在一轮结束时都会发出。
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

function NewConversationProcessID() {
  const random = crypto.randomBytes(16);
  return Date.now().toString(16).padStart(16, "0") + random.toString("hex");
}

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

// scrubConversationGitSecrets 清理工作区 CLI 用过的 HOME（会话自己的，以及 bindCommand 给 docker 命令配的私有的）与它工作过的检出区。
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
  return ["http://" + relayHost + ":" + server.address().port, () => {
    stopContext();
    stop();
  }];
}

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

function conversationRemap(value, source, target) {
  if (source === "") {
    return value;
  }
  return value.replaceAll(source, target);
}

// ConversationStdinPath 返回一条路径在 CLI stdin 流里占用的字节；Codex app-server 帧用 JSON 字符串，
// 即使一帧跨多次写入，路径也必须按编码后的形式重映射。
function ConversationStdinPath(path, provider) {
  if (provider !== "codex") {
    return path;
  }
  const raw = JSON.stringify(path);
  return raw.slice(1, raw.length - 1);
}

function remapConversationStdin(data, source, root, workspace, provider) {
  data = conversationRemap(data, ConversationStdinPath(source, provider), ConversationStdinPath(root, provider));
  if (workspace !== "") {
    data = conversationRemap(data, ConversationStdinPath(path.join(root, "ws"), provider), ConversationStdinPath(workspace, provider));
  }
  return data;
}

// lookPath：Go 的 exec.LookPath，按 PATH 逐个目录找可执行文件。
function lookPath(name) {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (dir === "") {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 继续找下一个目录。
    }
  }
  return null;
}

module.exports = { ErrConversationNotStarted, ConversationProcessRequest, ConversationFile, ConversationCommand, ConversationCommandFor, ConversationProcessResult, ConversationProcessPool, conversationAssetFence, conversationProcess, conversationAssetPath, conversationTerminalResultDrain, conversationStdoutTerminal, conversationStartWindow, NewConversationProcessID, conversationProcessIDExpiry, scrubConversationGitSecrets, cleanupConversationCredentialFiles, conversationBinary, startConversationRelay, replaceConversationGateway, conversationRemap, ConversationStdinPath, remapConversationStdin, lookPath };
