/**
 * @file internal/runtime/mcp_call.js
 * @description 对应 Go 源文件：internal/runtime/mcp_call.go
 *
 * 职责与边界：
 * 负责脚本节点、门禁与 Hook 中 `agentflow mcp call/tools/list` 助手能力的准备与命令行执行：
 * 将绑定的 MCP 列表写入 0600 权限配置文件、安装当前沙箱架构匹配的可执行助手与 shell 包装脚本、
 * 按沙箱隔离级别改写命令行参数以暴露 `agentflow` 命令，以及实现 CLI 子命令与 HTTP/stdio MCP 协议调用。
 * 不负责 MCP 凭据解析与服务端安装（分别见 `mcp_credentials.js`、`platform_mcp.js` 与 `mcp_provision.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 译为成功返回值、失败抛出 `Error`；仅 `error` 译为成功返回 `undefined`、失败抛出 `Error`。
 * - Go 的 `(值, bool)` 译为返回 `[值, boolean]` 二元组。
 * - Go 的 `context.Context` 对应 `AbortSignal`；`WithDockerRunnerHelperWait` 通过 `Symbol` 属性挂载等待回调。
 * - Go 的 `defer` 译为 `try { ... } finally { ... }`；`os.Executable()` 对应 `process.execPath`；`goruntime.GOOS`/`GOARCH` 对应 `process.platform`/`process.arch`。
 */

"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");

const mcpclient = require("../mcpclient/client.js");
const { EnsureControlDirectory, resolveMap } = require("./materialize.js"); // 对应 Go 同包函数，materialize.js 待翻译
const { sandboxDriver } = require("./runner.js"); // 对应 Go 同包函数，runner.js 待翻译
const { MCPRuntimeWorkingDirectory, managedMCPProcessRuntime, prepareMCPServersForDriver } = require("./mcp_provision.js");
const { writeManagedFile, openWorkspacePath, writeManagedReader } = require("./managed_files.js"); // 对应 Go 同包函数，managed_files.js 待翻译
const { cloneHeaders, MCPAuthCredential } = require("./mcp_credentials.js");
const { shellSingleQuote } = require("./sandbox_environment.js"); // 对应 Go 同包函数，sandbox_environment.js 待翻译
const { appendEnvironment } = require("./sandbox_process.js"); // 对应 Go 同包函数，sandbox_process.js 待翻译

const mcpCallConfigEnv = "AGENTFLOW_MCP_CONFIG";
const mcpCallBinEnv = "AGENTFLOW_BIN";

/**
 * 写入 `.agentflow/runtime/mcp-servers.json` 的顶层配置结构。
 */
class mcpCallConfigFile {
  /**
   * 构造 `mcpCallConfigFile` 实例，未提供字段按 Go 零值初始化。
   * 使用场景：序列化或反序列化 `mcp-servers.json` 时承载服务数组。
   *
   * @param {Partial<mcpCallConfigFile>} [init={}] - 初始化字段对象（兼容 JSON 小写键 `servers`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Servers = init.Servers ?? init.servers ?? [];
  }
}

/**
 * 写入 `mcp-servers.json` 的单条 MCP 服务配置结构。
 */
class mcpCallServer {
  /**
   * 构造 `mcpCallServer` 实例，未提供字段按 Go 零值初始化。
   * 使用场景：将 `domain.MCPServerDefinition` 转换为脚本助手配置文件条目或反序列化配置。
   *
   * @param {Partial<mcpCallServer>} [init={}] - 初始化字段对象（兼容 JSON 键名）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? init.id ?? "";
    this.Name = init.Name ?? init.name ?? "";
    this.MarketID = init.MarketID ?? init.marketId ?? "";
    this.URL = init.URL ?? init.url ?? "";
    this.Command = init.Command ?? init.command ?? "";
    this.Args = init.Args ?? init.args ?? [];
    this.CWD = init.CWD ?? init.cwd ?? "";
    this.Environment = init.Environment ?? init.environment ?? {};
    this.Transport = init.Transport ?? init.transport ?? "";
    this.AuthType = init.AuthType ?? init.authType ?? "";
    this.CredentialKind = init.CredentialKind ?? init.credentialKind ?? "";
    this.Headers = init.Headers ?? init.headers ?? {};
    this.TimeoutSec = init.TimeoutSec ?? init.timeoutSec ?? 0;
    this.Aliases = init.Aliases ?? init.aliases ?? [];
  }
}

/**
 * 返回宿主机上存放 `agentflow mcp` 运行时配置与助手二进制的目录路径。
 * 使用场景：准备配置文件路径、助手可执行文件路径与包装脚本路径。
 *
 * @param {string} workspace - 宿主工作区目录路径。
 * @returns {string} `<workspace>/.agentflow/runtime` 路径。
 */
function mcpCallHostDir(workspace) {
  return path.join(workspace, ".agentflow", "runtime");
}

/**
 * 计算 Docker 容器内对应的运行时文件路径（固定挂载在 `/workspace/.agentflow/runtime` 下）。
 * 使用场景：在 Docker 沙箱下生成容器内可见的配置路径与助手路径。
 *
 * @param {string} rel - 相对于 `.agentflow/runtime` 的子路径。
 * @returns {string} 容器内 POSIX 路径字符串。
 */
function mcpCallGuestPath(rel) {
  return path.posix.join("/workspace", ".agentflow", "runtime", rel.replace(/\\/g, "/"));
}

/**
 * 在工作区中物化脚本节点助手（`agentflow mcp call`）及其绑定的 MCP 服务列表。
 * 令牌仅保存在 0600 权限的配置文件中，不以环境变量形式暴露。
 * 使用场景：由 `bindMCPCallEnvironment` 在脚本、门禁或 Hook 命令执行前调用。
 *
 * @param {AbortSignal} ctx - 取消信号（对应 Go `context.Context`）。
 * @param {Object | null} sandbox - 目标沙箱实例。
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {Object[]} servers - 已绑定凭据的 `domain.MCPServerDefinition` 列表。
 * @returns {Record<string, string>} 包含 `AGENTFLOW_MCP_CONFIG` 与 `AGENTFLOW_BIN` 的环境变量映射；目录创建、文件写入或助手安装失败时抛出 `Error`。
 */
function PrepareMCPCall(ctx, sandbox, workspace, servers) {
  const hostRoot = mcpCallHostDir(workspace);
  const hostBin = path.join(hostRoot, "bin");
  try {
    EnsureControlDirectory(workspace, "runtime", "bin");
  } catch (err) {
    throw new Error(`create mcp call dir: ${err.message}`, { cause: err });
  }
  const driver = sandboxDriver(sandbox);
  const runtimeServers = prepareMCPServersForDriver(servers, driver);
  for (let i = 0; i < runtimeServers.length; i++) {
    if (managedMCPProcessRuntime(servers[i], driver)) {
      runtimeServers[i].Command = path.join(workspace, runtimeServers[i].Command.replace(/\//g, path.sep));
    }
  }
  const cfg = new mcpCallConfigFile({ Servers: mcpCallConfigServers(runtimeServers) });
  const raw = Buffer.from(JSON.stringify({
    servers: cfg.Servers.map((s) => ({
      id: s.ID,
      name: s.Name,
      ...(s.MarketID ? { marketId: s.MarketID } : {}),
      url: s.URL,
      ...(s.Command ? { command: s.Command } : {}),
      ...(s.Args && s.Args.length > 0 ? { args: s.Args } : {}),
      ...(s.CWD ? { cwd: s.CWD } : {}),
      ...(s.Environment && Object.keys(s.Environment).length > 0 ? { environment: s.Environment } : {}),
      transport: s.Transport,
      ...(s.AuthType ? { authType: s.AuthType } : {}),
      ...(s.CredentialKind ? { credentialKind: s.CredentialKind } : {}),
      ...(s.Headers && Object.keys(s.Headers).length > 0 ? { headers: s.Headers } : {}),
      ...(s.TimeoutSec ? { timeoutSec: s.TimeoutSec } : {}),
      ...(s.Aliases && s.Aliases.length > 0 ? { aliases: s.Aliases } : {}),
    })),
  }, null, 2));
  const configHost = path.join(hostRoot, "mcp-servers.json");
  try {
    writeManagedFile(workspace, configHost, raw, 0o600);
  } catch (err) {
    throw new Error(`write mcp call config: ${err.message}`, { cause: err });
  }
  const helperHost = path.join(hostBin, "agentflow-helper");
  installMCPCallHelperForSandbox(ctx, sandbox, workspace, helperHost);
  const wrapperHost = path.join(hostBin, "agentflow");
  const self = process.execPath || "";
  let helperExec = helperHost;
  let configEnv = configHost;
  let wrapperEnv = wrapperHost;
  let fallback = self.trim();
  if (sandboxDriver(sandbox) === "docker") {
    // 容器仅绑定挂载工作区目录，宿主机二进制路径在容器文件系统内不可见。
    helperExec = mcpCallGuestPath("bin/agentflow-helper");
    configEnv = mcpCallGuestPath("mcp-servers.json");
    wrapperEnv = mcpCallGuestPath("bin/agentflow");
    fallback = "";
  }
  try {
    writeManagedFile(workspace, wrapperHost, Buffer.from(mcpCallWrapperScript(helperExec, fallback)), 0o700);
  } catch (err) {
    throw new Error(`write mcp call wrapper: ${err.message}`, { cause: err });
  }
  return {
    [mcpCallConfigEnv]: configEnv,
    [mcpCallBinEnv]: wrapperEnv,
  };
}

/**
 * 将运行时 MCP 服务定义转换为写入 `mcp-servers.json` 的配置条目列表。
 * 传输类型默认回退为 `stdio`，并跳过缺少 `URL`（http）或缺少 `Command`（stdio）的服务。
 * 使用场景：由 `PrepareMCPCall` 构建待落盘的配置对象。
 *
 * @param {Object[]} servers - `domain.MCPServerDefinition` 列表。
 * @returns {mcpCallServer[]} 过滤并规范化后的配置条目数组。
 */
function mcpCallConfigServers(servers) {
  const out = [];
  for (const server of servers || []) {
    let transport = (server.Transport || "").trim().toLowerCase();
    if (transport === "") {
      transport = "stdio";
    }
    if (transport === "http" && (server.URL || "").trim() === "") {
      continue;
    }
    if (transport === "stdio" && (server.Command || "").trim() === "") {
      continue;
    }
    out.push(
      new mcpCallServer({
        ID: server.ID,
        Name: server.Name,
        MarketID: server.MarketID,
        URL: server.URL,
        Transport: transport,
        Command: server.Command,
        Args: server.Args ? [...server.Args] : [],
        CWD: MCPRuntimeWorkingDirectory(server),
        Environment: resolveMap(server.Environment),
        AuthType: server.AuthType,
        CredentialKind: server.CredentialKind,
        Headers: cloneHeaders(server.Headers),
        TimeoutSec: server.TimeoutSec,
        Aliases: mcpCallAliases(server),
      })
    );
  }
  return out;
}

/**
 * 生成 `agentflow` POSIX shell 包装脚本内容：优先执行工作区内的 `helperPath`，
 * 不可用时再尝试宿主机 `fallback`，均不可用则输出提示并以 127 退出。
 * 使用场景：由 `PrepareMCPCall` 写入 `.agentflow/runtime/bin/agentflow`。
 *
 * @param {string} helperPath - 首选助手可执行文件路径。
 * @param {string} fallback - 宿主机回退可执行文件路径（Docker 场景下为空字符串）。
 * @returns {string} 完整的 shell 包装脚本文本。
 */
function mcpCallWrapperScript(helperPath, fallback) {
  let b = "";
  b += "#!/bin/sh\n";
  if ((helperPath || "").trim() !== "") {
    b += "if [ -x " + shellSingleQuote(helperPath) + " ]; then\n";
    b += "  exec " + shellSingleQuote(helperPath) + " \"$@\"\n";
    b += "fi\n";
  }
  if ((fallback || "").trim() !== "") {
    b += "if [ -x " + shellSingleQuote(fallback) + " ]; then\n";
    b += "  exec " + shellSingleQuote(fallback) + " \"$@\"\n";
    b += "fi\n";
  }
  b += "echo \"agentflow: mcp helper is not available in this sandbox\" >&2\n";
  b += "exit 127\n";
  return b;
}

/**
 * 将当前运行中的主程序二进制复制到工作区目标路径作为 MCP 助手。
 * 使用场景：非 Docker 沙箱或 Linux 宿主机上的 Docker 沙箱直接复用当前二进制。
 *
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {string} dest - 目标助手文件路径。
 * @returns {void} 无返回值；获取可执行路径或复制失败时抛出 `Error`。
 */
function installMCPCallHelper(workspace, dest) {
  const src = process.execPath;
  if (!src) {
    throw new Error("cannot determine current executable path");
  }
  installMCPCallHelperFrom(workspace, src, dest);
}

const dockerRunnerHelperWaitKey = Symbol("dockerRunnerHelperWaitKey");

/**
 * 在上下文对象上附加一个等待回调，使个人 Runner 在真正需要 Linux Git/MCP 助手二进制时
 * 可以等待后台下载完成。
 * 使用场景：非 Linux 个人 Runner 启动任务前将后台下载等待函数注入上下文。
 *
 * @param {AbortSignal | Object | null} ctx - 原始上下文对象（对应 Go `context.Context`）。
 * @param {(ctx: AbortSignal | Object | null, src: string) => void} wait - 等待后台下载完成的函数，失败时抛出 `Error`。
 * @returns {Object} 附加了等待回调的新上下文视图对象。
 */
function WithDockerRunnerHelperWait(ctx, wait) {
  const derived = ctx != null ? Object.create(ctx) : {};
  derived[dockerRunnerHelperWaitKey] = wait;
  return derived;
}

/**
 * 按目标沙箱驱动与宿主机操作系统安装对应的 MCP/Git 助手二进制：
 * 非 Docker 或 Linux 宿主直接复制当前可执行文件；非 Linux 宿主运行 Docker 时查找并复制 Linux Runner 二进制。
 * 使用场景：由 `PrepareMCPCall` 或 `command_binding.js` 安装工作区助手二进制时调用。
 *
 * @param {AbortSignal | Object | null} ctx - 上下文对象（可能携带 `WithDockerRunnerHelperWait` 注册的等待函数）。
 * @param {Object | null} sandbox - 目标沙箱实例。
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {string} dest - 工作区内的目标助手文件路径。
 * @returns {void} 无返回值；二进制缺失、等待失败或复制失败时抛出 `Error`。
 */
function installMCPCallHelperForSandbox(ctx, sandbox, workspace, dest) {
  if (sandboxDriver(sandbox) !== "docker" || process.platform === "linux") {
    installMCPCallHelper(workspace, dest);
    return;
  }
  const src = DockerRunnerHelperPath();
  const wait = ctx && typeof ctx[dockerRunnerHelperWaitKey] === "function" ? ctx[dockerRunnerHelperWaitKey] : null;
  if (wait) {
    wait(ctx, src);
  }
  try {
    fs.statSync(src);
  } catch (err) {
    throw new Error(`Docker Git/MCP helper requires a Linux runner binary: set AGENTFLOW_RUNNER_BINARY with {os} and {arch}: ${err.message}`, { cause: err });
  }
  installMCPCallHelperFrom(workspace, src, dest);
}

/**
 * 计算非 Linux Runner 在 Docker 内执行 Git/MCP 助手所需的 Linux Runner 二进制路径。
 * 优先使用环境变量 `AGENTFLOW_RUNNER_BINARY`（含 `{os}` 占位符），否则默认同目录下的
 * `agentflow-runner-{os}-{arch}`，并拒绝解析到与宿主当前二进制同一文件。
 * 使用场景：非 Linux 宿主下载或安装 Docker 内 Linux 助手二进制时统一路径口径。
 *
 * @returns {string} 解析后的 Linux Runner 二进制绝对路径；无法获取自身路径或与宿主二进制冲突时抛出 `Error`。
 */
function DockerRunnerHelperPath() {
  const self = process.execPath;
  if (!self) {
    throw new Error("cannot determine current executable path");
  }
  let pattern = (process.env.AGENTFLOW_RUNNER_BINARY || "").trim();
  if (!pattern.includes("{os}")) {
    pattern = path.join(path.dirname(self), "agentflow-runner-{os}-{arch}");
  }
  const helperPath = pattern.replace(/\{os\}/g, "linux").replace(/\{arch\}/g, process.arch);
  try {
    const helper = fs.statSync(helperPath);
    const host = fs.statSync(self);
    if (helper.ino !== 0 && helper.dev === host.dev && helper.ino === host.ino) {
      throw new Error(`Docker Git/MCP helper path aliases the host Runner: ${helperPath}`);
    }
  } catch (err) {
    if (err && err.message && err.message.startsWith("Docker Git/MCP helper path aliases")) {
      throw err;
    }
  }
  return helperPath;
}

/**
 * 将源二进制 `src` 复制到工作区目标路径 `dest`（权限 0755）；若目标已是普通文件且大小一致、
 * 源修改时间不晚于目标，则跳过复制以复用缓存。
 * 使用场景：由 `installMCPCallHelper` 与 `installMCPCallHelperForSandbox` 调用。
 *
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {string} src - 源可执行文件路径。
 * @param {string} dest - 工作区内的目标路径。
 * @returns {void} 无返回值；源文件不可读、目标非普通文件或复制失败时抛出 `Error`。
 */
function installMCPCallHelperFrom(workspace, src, dest) {
  const srcInfo = fs.statSync(src);
  const [root, rel] = openWorkspacePath(workspace, dest);
  try {
    let dstInfo = null;
    try {
      dstInfo = root.Stat(rel);
    } catch (err) {
      if (!err || err.code !== "ENOENT") {
        throw err;
      }
    }
    if (dstInfo != null) {
      const isRegular = typeof dstInfo.isFile === "function" ? dstInfo.isFile() : dstInfo.Mode().IsRegular();
      if (!isRegular) {
        throw new Error("MCP helper is not a regular file");
      }
      const dstSize = dstInfo.size !== undefined ? dstInfo.size : dstInfo.Size();
      const dstMtime = dstInfo.mtimeMs !== undefined ? dstInfo.mtimeMs : dstInfo.ModTime().getTime();
      if (dstSize === srcInfo.size && srcInfo.mtimeMs <= dstMtime) {
        return;
      }
    }
  } finally {
    root.Close();
  }
  copyFileMode(workspace, src, dest, 0o755);
}

/**
 * 以流方式打开源文件并通过受控写入接口复制到工作区指定路径，并设置文件权限模式。
 * 使用场景：由 `installMCPCallHelperFrom` 复制助手可执行文件时调用。
 *
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {string} src - 源文件路径。
 * @param {string} dest - 目标文件路径。
 * @param {number} mode - 目标文件权限位（如 `0o755`）。
 * @returns {void} 无返回值；打开源文件或写入失败时抛出 `Error`。
 */
function copyFileMode(workspace, src, dest, mode) {
  const fd = fs.openSync(src, "r");
  try {
    writeManagedReader(workspace, dest, fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 为单条 MCP 服务收集去重后的命令行匹配别名列表（来源包括 ID、MarketID、Name、URL 末段路径以及 `mcp-<short>-...` 前缀段）。
 * 使用场景：生成 `mcp-servers.json` 时写入 `aliases`，供用户在 `agentflow mcp call <server>` 中简写调用。
 *
 * @param {Object} server - `domain.MCPServerDefinition` 服务定义。
 * @returns {string[]} 按添加顺序去重（不区分大小写）后的别名数组。
 */
function mcpCallAliases(server) {
  const seen = {};
  const out = [];
  const add = (v) => {
    v = (v || "").trim();
    if (v === "" || seen[v.toLowerCase()]) {
      return;
    }
    seen[v.toLowerCase()] = true;
    out.push(v);
  };
  add(server.ID);
  add(server.MarketID);
  add(server.Name);
  try {
    const parsed = url.parse(server.URL || "");
    if (parsed && parsed.pathname) {
      add(path.posix.basename(parsed.pathname.replace(/\/+$/, "")));
    }
  } catch (_) {
    // URL 无法解析时忽略路径别名
  }
  if ((server.ID || "").startsWith("mcp-")) {
    const parts = server.ID.split("-");
    if (parts.length >= 2) {
      add(parts[1]);
    }
  }
  return out;
}

/**
 * 准备 `agentflow mcp call` 所需的配置文件与包装脚本，并将结果环境变量（跳过 `PATH`）写入目标 `environment` 映射。
 * 使用场景：由 `command_binding.js` 或 `ScriptMCPEnvironment` 为命令注入 MCP 助手环境变量。
 *
 * @param {AbortSignal} ctx - 取消信号（对应 Go `context.Context`）。
 * @param {Object | null} sandbox - 目标沙箱实例。
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {Record<string, string>} environment - 待写入的目标环境变量对象。
 * @param {Object[]} servers - `domain.MCPServerDefinition` 列表。
 * @returns {void} 无返回值；准备失败时抛出 `Error`。
 */
function bindMCPCallEnvironment(ctx, sandbox, workspace, environment, servers) {
  const prepared = PrepareMCPCall(ctx, sandbox, workspace, servers);
  for (const [key, value] of Object.entries(prepared)) {
    if (key === "PATH") {
      continue;
    }
    environment[key] = value;
  }
}

/**
 * 判断指定沙箱驱动是否提供进程级或容器级隔离（`docker`、`bwrap`、`seatbelt`）。
 * 使用场景：决定 `BindMCPCallArgv` 是前置 `PATH` 还是注入局部 shell 函数。
 *
 * @param {Object | null} sb - 目标沙箱实例。
 * @returns {boolean} 属于隔离沙箱返回 `true`，否则返回 `false`。
 */
function sandboxIsolatesProcess(sb) {
  switch (sandboxDriver(sb)) {
    case "docker":
    case "bwrap":
    case "seatbelt":
      return true;
    default:
      return false;
  }
}

const localMCPCallPreamble = `agentflow() {
  if [ -z "\${AGENTFLOW_BIN-}" ] || [ ! -x "$AGENTFLOW_BIN" ]; then
    echo "agentflow: mcp helper is not available in this sandbox" >&2
    return 127
  fi
  command "$AGENTFLOW_BIN" "$@"
}
`;

const isolatedMCPCallPreamble = `if [ -n "\${AGENTFLOW_BIN-}" ] && [ -x "$AGENTFLOW_BIN" ]; then
  PATH="$(dirname "$AGENTFLOW_BIN"):$PATH"
  export PATH
fi
`;

/**
 * 改写脚本或门禁命令的 `argv`，使其能直接调用工作区内的 `agentflow` 助手。
 * Docker 驱动保持原样（由容器入口处理）；隔离进程沙箱在登录 shell 重置后前置 `PATH`；
 * 非隔离本地进程不改写 `PATH`，改为注入局部 shell 函数 `agentflow()`。
 * 使用场景：由 `command_binding.js` 在绑定命令参数时调用。
 *
 * @param {Object | null} sandbox - 目标沙箱实例。
 * @param {string[]} argv - 原始命令参数数组。
 * @returns {string[]} 改写后的命令参数数组（无需改写时返回原数组）。
 */
function BindMCPCallArgv(sandbox, argv) {
  if (sandboxDriver(sandbox) === "docker") {
    return argv;
  }
  if (sandboxIsolatesProcess(sandbox)) {
    const [out, ok] = injectShellPreamble(argv, isolatedMCPCallPreamble);
    if (ok) {
      return out;
    }
    return wrapIsolatedMCPCallExec(argv);
  }
  const [out, ok] = injectShellPreamble(argv, localMCPCallPreamble);
  if (ok) {
    return out;
  }
  return argv;
}

/**
 * 当 `argv` 是标准 POSIX shell（`sh`/`bash`/`zsh`/`dash`/`ksh`/`ash`）的 `-c`/`-lc`/`-cl` 调用时，
 * 在命令字符串开头插入前置脚本 `preamble`。
 * 使用场景：避免误改 Codex、Python 等同样接受 `-c` 参数的非 shell 程序。
 *
 * @param {string[]} argv - 原始命令参数数组。
 * @param {string} preamble - 待插入的前置 shell 片段。
 * @returns {[string[], boolean]} 二元组 `[out, injected]`：成功注入返回新数组与 `true`，否则返回原数组与 `false`。
 */
function injectShellPreamble(argv, preamble) {
  if (!argv || argv.length < 3 || (preamble || "").trim() === "") {
    return [argv, false];
  }
  // -c 在 Codex 中表示配置项、在 Python 中表示源码，仅能对已知 shell 命令字符串注入前置脚本。
  switch (path.basename(argv[0])) {
    case "sh":
    case "bash":
    case "zsh":
    case "dash":
    case "ksh":
    case "ash":
      break;
    default:
      return [argv, false];
  }
  const out = [...argv];
  for (let i = 1; i < out.length - 1; i++) {
    switch (out[i]) {
      case "-c":
      case "-lc":
      case "-cl":
        out[i + 1] = preamble + out[i + 1];
        return [out, true];
    }
  }
  return [argv, false];
}

/**
 * 将隔离沙箱下的非 shell 直接执行命令包装在 `sh -c` 中，以便先前置 `AGENTFLOW_BIN` 所在目录到 `PATH` 再 `exec` 原命令。
 * 使用场景：`BindMCPCallArgv` 在隔离沙箱下未能通过 `injectShellPreamble` 注入时的兜底包装。
 *
 * @param {string[]} argv - 原始命令参数数组。
 * @returns {string[]} 包装后的参数数组；若原数组为空则原样返回。
 */
function wrapIsolatedMCPCallExec(argv) {
  if (!argv || argv.length === 0) {
    return argv;
  }
  return ["sh", "-c", isolatedMCPCallPreamble + `exec "$0" "$@"`, ...argv];
}

/**
 * 为脚本执行物化 `agentflow mcp call` 助手并返回 `AGENTFLOW_BIN` 与配置文件路径环境变量，
 * 不会修改本地非隔离进程的 `PATH`。
 * 使用场景：脚本节点直接获取 MCP 助手环境变量映射时调用。
 *
 * @param {AbortSignal} ctx - 取消信号（对应 Go `context.Context`）。
 * @param {Object | null} sandbox - 目标沙箱实例。
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {Object[]} servers - `domain.MCPServerDefinition` 列表。
 * @returns {Record<string, string>} 包含 `AGENTFLOW_MCP_CONFIG` 与 `AGENTFLOW_BIN` 的环境变量映射；准备失败时抛出 `Error`。
 */
function ScriptMCPEnvironment(ctx, sandbox, workspace, servers) {
  const env = {};
  bindMCPCallEnvironment(ctx, sandbox, workspace, env, servers);
  return env;
}

/**
 * 从环境变量 `AGENTFLOW_MCP_CONFIG` 指向的文件中读取并解析 `mcpCallConfigFile`。
 * 使用场景：`agentflow mcp call/tools/list` 子命令启动时加载当前任务注入的 MCP 配置。
 *
 * @returns {mcpCallConfigFile} 解析后的配置对象；未注入环境变量、读取失败或 JSON 非法时抛出 `Error`。
 */
function loadMCPCallConfig() {
  const configPath = (process.env[mcpCallConfigEnv] || "").trim();
  if (configPath === "") {
    throw new Error("未注入 MCP：agentflow mcp call 只在脚本、门禁或 Hook 里可用");
  }
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(`read mcp config: ${err.message}`, { cause: err });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`decode mcp config: ${err.message}`, { cause: err });
  }
  const servers = Array.isArray(parsed && parsed.servers)
    ? parsed.servers.map((s) => new mcpCallServer(s))
    : [];
  return new mcpCallConfigFile({ Servers: servers });
}

/**
 * 按 ID、MarketID、Name 或别名不区分大小写地查找唯一匹配的 MCP 服务。
 * 使用场景：`agentflow mcp call` 与 `agentflow mcp tools` 解析用户传入的 `<server>` 参数。
 *
 * @param {mcpCallServer[]} servers - 当前可用的 MCP 服务配置列表。
 * @param {string} query - 用户指定的服务标识或别名。
 * @returns {mcpCallServer} 唯一匹配的 `mcpCallServer` 对象；参数为空、未命中或命中多个时抛出 `Error`。
 */
function matchMCPCallServer(servers, query) {
  query = (query || "").trim();
  if (query === "") {
    throw new Error("请指定要调用的 MCP");
  }
  const lower = query.toLowerCase();
  const matches = [];
  for (const server of servers || []) {
    if (mcpCallServerMatches(server, lower)) {
      matches.push(server);
    }
  }
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    const names = matches.map((server) => server.Name + " (" + server.ID + ")");
    throw new Error(`MCP ${JSON.stringify(query)} 匹配到多个：${names.join("、")}`);
  }
  throw new Error(`当前任务没有 MCP ${JSON.stringify(query)}`);
}

/**
 * 判断单条 `mcpCallServer` 是否匹配指定的小写查询词。
 * 使用场景：由 `matchMCPCallServer` 遍历服务列表时调用。
 *
 * @param {mcpCallServer} server - MCP 服务配置条目。
 * @param {string} lower - 已转为小写的查询字符串。
 * @returns {boolean} 命中 ID、MarketID、Name 或任一别名返回 `true`，否则返回 `false`。
 */
function mcpCallServerMatches(server, lower) {
  if (
    (server.ID || "").toLowerCase() === lower ||
    (server.MarketID || "").toLowerCase() === lower ||
    (server.Name || "").toLowerCase() === lower
  ) {
    return true;
  }
  for (const alias of server.Aliases || []) {
    if ((alias || "").trim().toLowerCase() === lower) {
      return true;
    }
  }
  return false;
}

/**
 * 从请求头映射中按不区分大小写的键名提取 `Authorization` 头的值。
 * 使用场景：调用 HTTP MCP 前检查是否已具备鉴权头。
 *
 * @param {Record<string, string> | null | undefined} headers - HTTP 请求头映射。
 * @returns {string} 去除首尾空白后的 `Authorization` 头值；不存在时返回空字符串。
 */
function authorizationHeader(headers) {
  if (!headers) {
    return "";
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.trim().toLowerCase() === "authorization") {
      return (value || "").trim();
    }
  }
  return "";
}

/**
 * 处理 `agentflow mcp ...`（以及 `agentflow-runner` 上的相同子命令）CLI 入口。
 * 当首个参数不是 `"mcp"` 时返回 `false`，让进程继续执行常规入口；否则执行子命令并退出进程。
 * 使用场景：主程序与 Runner 启动时的顶层参数分派。
 *
 * @param {string[]} args - 去除程序名后的命令行参数数组。
 * @returns {boolean} 若命中 `mcp` 子命令则调用 `process.exit` 并返回 `true`，否则返回 `false`。
 */
function RunMCPCallCLI(args) {
  if (!args || args.length === 0 || args[0] !== "mcp") {
    return false;
  }
  process.exit(mcpCallMain(args.slice(1)));
  return true;
}

/**
 * 分派 `call`、`tools`、`list` 子命令并返回进程退出码（0 成功，1 执行错误，2 用法错误）。
 * 使用场景：由 `RunMCPCallCLI` 调用。
 *
 * @param {string[]} args - 去除 `"mcp"` 后的子命令参数数组。
 * @returns {number} 退出码。
 */
function mcpCallMain(args) {
  if (!args || args.length === 0) {
    process.stderr.write(mcpCallUsage + "\n");
    return 2;
  }
  switch (args[0]) {
    case "call":
      try {
        mcpCallInvoke(args.slice(1));
        return 0;
      } catch (err) {
        process.stderr.write(err.message + "\n");
        return 1;
      }
    case "tools":
      try {
        mcpCallTools(args.slice(1));
        return 0;
      } catch (err) {
        process.stderr.write(err.message + "\n");
        return 1;
      }
    case "list":
      try {
        mcpCallList();
        return 0;
      } catch (err) {
        process.stderr.write(err.message + "\n");
        return 1;
      }
    default:
      process.stderr.write(mcpCallUsage + "\n");
      return 2;
  }
}

const mcpCallUsage = `用法:
  agentflow mcp call <server> <tool> [json-args]
  agentflow mcp tools <server>
  agentflow mcp list`;

/**
 * 执行 `agentflow mcp call <server> <tool> [json-args]`：加载配置、匹配服务、校验鉴权头与参数 JSON，
 * 按 HTTP 或 stdio 协议调用工具并将结果输出到标准输出。
 * 使用场景：由 `mcpCallMain` 在子命令为 `"call"` 时调用。
 *
 * @param {string[]} args - `call` 子命令后的参数数组。
 * @returns {void} 无返回值；参数不足、鉴权缺失、JSON 非法或调用失败时抛出 `Error`。
 */
function mcpCallInvoke(args) {
  if (!args || args.length < 2) {
    throw new Error(mcpCallUsage);
  }
  const cfg = loadMCPCallConfig();
  const server = matchMCPCallServer(cfg.Servers, args[0]);
  if (
    (server.Transport || "").trim().toLowerCase() === "http" &&
    (server.AuthType || "").trim() !== "" &&
    authorizationHeader(server.Headers) === ""
  ) {
    if ((server.AuthType || "").trim().toLowerCase() === MCPAuthCredential) {
      throw new Error(`MCP ${server.Name} 需要凭证 ${JSON.stringify(server.CredentialKind)}：请先在个人凭证中配置`);
    }
    throw new Error(`MCP ${server.Name} 需要 GitHub Git Token：请先在个人凭证中配置`);
  }
  const tool = (args[1] || "").trim();
  if (tool === "") {
    throw new Error("请指定 MCP 工具名");
  }
  let rawArgs = "{}";
  if (args.length >= 3) {
    rawArgs = (args[2] || "").trim();
  }
  if (rawArgs === "") {
    rawArgs = "{}";
  }
  let parsed;
  try {
    parsed = JSON.parse(rawArgs);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected JSON object");
    }
  } catch (err) {
    throw new Error(`工具参数必须是 JSON 对象: ${err.message}`, { cause: err });
  }
  let text;
  if ((server.Transport || "").trim().toLowerCase() === "http") {
    let client = mcpclient.New(server.URL, server.Headers);
    if (server.TimeoutSec > 0) {
      client = client.WithTimeout(server.TimeoutSec * 1000);
    }
    text = client.CallTool(tool, parsed);
  } else {
    text = stdioMCPCall(server, tool, parsed);
  }
  process.stdout.write(text + "\n");
}

/**
 * 执行 `agentflow mcp list`：将当前任务已注入的 MCP 服务精简信息以格式化 JSON 输出到标准输出。
 * 使用场景：由 `mcpCallMain` 在子命令为 `"list"` 时调用。
 *
 * @returns {void} 无返回值；加载配置或序列化失败时抛出 `Error`。
 */
function mcpCallList() {
  const cfg = loadMCPCallConfig();
  const out = [];
  for (const server of cfg.Servers) {
    out.push({
      id: server.ID,
      name: server.Name,
      ...(server.MarketID ? { marketId: server.MarketID } : {}),
      transport: server.Transport,
      ...(server.URL ? { url: server.URL } : {}),
      ...(server.Command ? { command: server.Command } : {}),
      ...(server.Aliases && server.Aliases.length > 0 ? { aliases: server.Aliases } : {}),
    });
  }
  const raw = JSON.stringify(out, null, 2);
  process.stdout.write(raw + "\n");
}

/**
 * 执行 `agentflow mcp tools <server>`：查询目标 MCP 服务暴露的全部工具名称，
 * 并以格式化 JSON 数组输出到标准输出。
 * 使用场景：由 `mcpCallMain` 在子命令为 `"tools"` 时调用。
 *
 * @param {string[]} args - `tools` 子命令后的参数数组。
 * @returns {void} 无返回值；参数不足、鉴权缺失或查询失败时抛出 `Error`。
 */
function mcpCallTools(args) {
  if (!args || args.length < 1) {
    throw new Error(mcpCallUsage);
  }
  const cfg = loadMCPCallConfig();
  const server = matchMCPCallServer(cfg.Servers, args[0]);
  if (
    (server.Transport || "").trim().toLowerCase() === "http" &&
    (server.AuthType || "").trim() !== "" &&
    authorizationHeader(server.Headers) === ""
  ) {
    if ((server.AuthType || "").trim().toLowerCase() === MCPAuthCredential) {
      throw new Error(`MCP ${server.Name} 需要凭证 ${JSON.stringify(server.CredentialKind)}：请先在个人凭证中配置`);
    }
    throw new Error(`MCP ${server.Name} 需要 GitHub Git Token：请先在个人凭证中配置`);
  }
  let names = [];
  if ((server.Transport || "").trim().toLowerCase() === "http") {
    let client = mcpclient.New(server.URL, server.Headers);
    if (server.TimeoutSec > 0) {
      client = client.WithTimeout(server.TimeoutSec * 1000);
    }
    const tools = client.ListTools();
    for (const tool of tools || []) {
      if ((tool.Name || "").trim() !== "") {
        names.push(tool.Name);
      }
    }
  } else {
    names = stdioMCPTools(server);
  }
  const raw = JSON.stringify(names, null, 2);
  process.stdout.write(raw + "\n");
}

/**
 * stdio MCP JSON-RPC 2.0 响应消息结构。
 */
class stdioRPCResponse {
  /**
   * 构造 `stdioRPCResponse` 实例，未提供字段按 Go 零值初始化。
   * 使用场景：解析 stdio MCP 标准输出的单行 JSON-RPC 响应。
   *
   * @param {Partial<stdioRPCResponse>} [init={}] - 初始化字段对象（兼容 JSON 键名）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? init.id ?? 0;
    this.Result = init.Result ?? init.result ?? null;
    this.Error = init.Error ?? init.error ?? null;
  }
}

/**
 * 通过 stdio JSON-RPC 协议调用指定 MCP 工具并提取返回的文本内容块。
 * 若结果无法按标准 `content` 结构解析则返回原始文本；若返回体标记 `isError` 则抛出错误。
 * 使用场景：由 `mcpCallInvoke` 调用非 HTTP（stdio）类型的 MCP 服务。
 *
 * @param {mcpCallServer} server - 目标 stdio MCP 服务配置。
 * @param {string} tool - 要调用的工具名称。
 * @param {Record<string, any>} args - 工具参数对象。
 * @returns {string} 拼接后的文本结果；子进程调用失败或工具返回错误标记时抛出 `Error`。
 */
function stdioMCPCall(server, tool, args) {
  const raw = runStdioMCP(server, "tools/call", { name: tool, arguments: args });
  let result;
  try {
    result = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) {
    return String(raw).trim();
  }
  const blocks = [];
  for (const b of (result && result.content) || []) {
    if (b.type === "text" && b.text !== "") {
      blocks.push(b.text);
    }
  }
  if (result && result.isError) {
    throw new Error(`mcp tool ${tool}: ${blocks.join("\n")}`);
  }
  return blocks.join("\n");
}

/**
 * 通过 stdio JSON-RPC 协议调用 `tools/list` 并提取非空工具名称列表。
 * 使用场景：由 `mcpCallTools` 查询非 HTTP（stdio）类型 MCP 服务的工具清单。
 *
 * @param {mcpCallServer} server - 目标 stdio MCP 服务配置。
 * @returns {string[]} 工具名称数组；子进程通信或解析失败时抛出 `Error`。
 */
function stdioMCPTools(server) {
  const raw = runStdioMCP(server, "tools/list", {});
  const result = typeof raw === "string" ? JSON.parse(raw) : raw;
  const out = [];
  for (const tool of (result && result.tools) || []) {
    if ((tool.name || "").trim() !== "") {
      out.push(tool.name);
    }
  }
  return out;
}

/**
 * 启动一次性 stdio MCP 子进程，依次完成 `initialize` 握手、`notifications/initialized` 通知
 * 及目标 JSON-RPC 方法调用，并在结束时确保终止并回收子进程。
 * 使用场景：由 `stdioMCPCall` 与 `stdioMCPTools` 执行底层 stdio 协议交互。
 *
 * @param {mcpCallServer} server - stdio MCP 服务配置（含命令、参数、工作目录、环境变量与超时秒数）。
 * @param {string} method - 目标 JSON-RPC 方法名（如 `"tools/call"` 或 `"tools/list"`）。
 * @param {any} params - 目标方法参数对象。
 * @returns {string} 目标请求对应的 `result` 原始 JSON 文本；超时、启动失败或协议出错时抛出 `Error`。
 */
function runStdioMCP(server, method, params) {
  let timeout = server.TimeoutSec * 1000;
  if (timeout <= 0) {
    timeout = 60 * 1000;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("stdio MCP timeout")), timeout);
  try {
    let cwd;
    if (server.CWD !== "") {
      const root = path.dirname(path.dirname(path.dirname((process.env[mcpCallConfigEnv] || "").trim())));
      cwd = path.join(root, server.CWD.replace(/\//g, path.sep));
    }
    const envPairs = appendEnvironment(
      Object.entries(process.env).map(([k, v]) => `${k}=${v}`),
      server.Environment
    );
    const env = {};
    for (const pair of envPairs) {
      const idx = pair.indexOf("=");
      if (idx > 0) {
        env[pair.slice(0, idx)] = pair.slice(idx + 1);
      }
    }
    const messages = [];
    const writer = {
      write(chunk) {
        messages.push(chunk);
      },
    };
    writeStdioRPC(writer, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agentflow-script", version: "1" },
      },
    });
    writeStdioRPC(writer, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    writeStdioRPC(writer, {
      jsonrpc: "2.0",
      id: 2,
      method,
      params,
    });
    const res = childProcess.spawnSync(server.Command, server.Args || [], {
      cwd,
      env,
      input: messages.join(""),
      encoding: "utf8",
      timeout,
      maxBuffer: 4 << 20,
    });
    if (res.error) {
      throw new Error(`start stdio MCP ${server.Name}: ${res.error.message}`, { cause: res.error });
    }
    const lines = (res.stdout || "").split(/\r?\n/);
    const scanner = {
      lines,
      index: 0,
      Scan() {
        if (this.index < this.lines.length) {
          this.current = this.lines[this.index++];
          return true;
        }
        return false;
      },
      Text() {
        return this.current || "";
      },
    };
    const stderr = res.stderr || "";
    try {
      readStdioRPCResult(controller.signal, scanner, stderr, 1);
    } catch (err) {
      throw new Error(`mcp init: ${err.message}`, { cause: err });
    }
    return readStdioRPCResult(controller.signal, scanner, stderr, 2);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 将单条 JSON-RPC 对象序列化为以换行符结尾的 JSON 行并写入目标写入器。
 * 使用场景：由 `runStdioMCP` 向 stdio MCP 子进程标准输入发送请求与通知。
 *
 * @param {{ write: (chunk: string) => void }} w - 写入目标对象（对应 Go `io.Writer`）。
 * @param {any} value - 待序列化的 JSON-RPC 消息对象。
 * @returns {void} 无返回值；序列化或写入失败时抛出 `Error`。
 */
function writeStdioRPC(w, value) {
  const raw = JSON.stringify(value);
  w.write(raw + "\n");
}

/**
 * 逐行扫描 stdio MCP 标准输出，跳过通知、不可解析行与其他 ID 的响应，直至读取到匹配 `id` 的响应。
 * 使用场景：由 `runStdioMCP` 分别读取 `initialize`（id=1）和业务方法（id=2）的返回结果。
 *
 * @param {AbortSignal} ctx - 取消或超时信号（对应 Go `context.Context`）。
 * @param {{ Scan: () => boolean, Text: () => string }} scanner - 按行扫描标准输出的迭代器。
 * @param {string} stderr - 子进程标准错误输出文本。
 * @param {number} id - 期望匹配的 JSON-RPC 请求 ID。
 * @returns {string} 匹配响应中的 `result` 序列化 JSON 文本；返回 JSON-RPC 错误、上下文超时或进程提前退出时抛出 `Error`。
 */
function readStdioRPCResult(ctx, scanner, stderr, id) {
  while (scanner.Scan()) {
    let parsed;
    try {
      parsed = JSON.parse(scanner.Text());
    } catch (_) {
      continue;
    }
    const resp = new stdioRPCResponse(parsed);
    if (resp.ID !== id) {
      continue;
    }
    if (resp.Error != null) {
      throw new Error(`mcp error [${resp.Error.code}]: ${resp.Error.message}`);
    }
    return JSON.stringify(resp.Result);
  }
  if (ctx && ctx.aborted) {
    throw ctx.reason || new Error("context canceled");
  }
  throw new Error(`stdio MCP exited before response: ${(stderr || "").trim()}`);
}

module.exports = {
  PrepareMCPCall,
  WithDockerRunnerHelperWait,
  DockerRunnerHelperPath,
  BindMCPCallArgv,
  ScriptMCPEnvironment,
  RunMCPCallCLI,
  mcpCallHostDir,
  mcpCallGuestPath,
  installMCPCallHelperForSandbox,
  bindMCPCallEnvironment,
};
