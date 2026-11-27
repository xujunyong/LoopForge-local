// cli_version.js —— 对应 Go 文件：internal/runtime/cli_version.go
//
// 文件作用与职责边界：
// 观测并上报受支持 CLI 工具的版本号。优先读取托管清单（managed_inventory）或 npm 包元数据（package_metadata），
// 无法静态获取或处于 Docker 沙箱时，在后台隔离环境中探测 `--version` 输出（version_probe）。
//
// Go 与 JS 语法差异说明：
// - Go 的 `time.Duration` 译为毫秒数；`context.Context` 译为 `AbortSignal`；
// - `goroutine` 译为 `setTimeout(..., 0)` 延后执行以不阻塞调用方；
// - `(值, error)` 译为成功返回值、失败 throw；多值无 error 返回译为数组元组。

"use strict";

const fs = require("node:fs"); // 对应 Go 标准库 os
const os = require("node:os"); // 对应 Go 标准库 os
const path = require("node:path"); // 对应 Go 标准库 path/filepath
const { spawnSync } = require("node:child_process"); // 对应 Go 标准库 os/exec

const { ReadInventory } = require("../managedcli/manifest.js"); // 对应 Go 的 managedcli.ReadInventory
const { onDemandCLICatalog, onDemandCLILabel } = require("./cli_ondemand.js"); // 对应 Go 同包函数
const { IsAgentCLI } = require("./agent_cli.js"); // 对应 Go 同包函数
const { unwrapSandbox } = require("./browser.js"); // 对应 Go 同包函数
const { dockerSandbox } = require("./sandbox_docker.js"); // 对应 Go 同包类型
const { processSandbox, lookupEnvSlice } = require("./sandbox_process.js"); // 对应 Go 同包类型与函数
const { localSandbox } = require("./sandbox_local.js"); // 对应 Go 同包类型
const { conversationBinary } = require("./conversation_process.js"); // 对应 Go 同包函数
const { upsertEnv } = require("./command_binding.js"); // 对应 Go 同包函数
const { CommandSpec } = require("./runtime.js"); // 对应 Go 同包类型
const { toolchainPathSetup } = require("./toolchain.js"); // 对应 Go 同包常量
const { dockerCLISharedPathSetup } = require("./conversation_sandbox.js"); // 对应 Go 同包常量
const { dockerConversationProcessSupervisor } = require("./conversation_docker_process.js"); // 对应 Go 同包常量

const CLIVersionEvent = "cli.version";

const cliVersionOutputLimit = 8 << 10;
const cliVersionTimeout = 5 * 1000;
const cliVersionNumber = `[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\\+[A-Za-z0-9.-]+)?`;

const cliVersionValue = new RegExp("^" + cliVersionNumber + "$");
const cliVersionLine = new RegExp(`^(?:([a-z][a-z0-9 -]*?)[ /:]+)?(v?${cliVersionNumber})(?:\\s+\\([^()]+\\))?$`, "i");

/**
 * 规范化并校验 CLI 版本号字符串，仅接受合法的语义化版本号（允许前导 `v`），不带展示前缀。
 * 在从清单、package.json 或命令行输出提取版本后调用。
 * @param {string} value - 原始版本号字符串。
 * @returns {string} 去掉前导 `v` 后的合法版本号；不合法或超过 80 字符时返回空字符串。
 */
function NormalizeCLIVersion(value) {
  value = value.trim();
  if (value.startsWith("v")) {
    value = value.slice(1);
  }
  // Go 的 len 是字节数，JS 的 length 是 UTF-16 码元数。
  if (value.length <= 80 && cliVersionValue.test(value)) {
    return value;
  }
  return "";
}

/**
 * 观测指定 CLI 的版本并通过回调上报：有静态安装元数据时立即上报，否则在实际调用期间后台探测。
 * 调用方应在 CLI 调用结束时执行返回的取消函数，以中止未完成的后台探测。
 * @param {AbortSignal} ctx - 取消信号。
 * @param {Object|null} sandbox - 当前沙箱实例（可能为包装后的 dockerSandbox、processSandbox 或 null）。
 * @param {string} provider - CLI 引擎/供应商标识名。
 * @param {string} binary - CLI 可执行文件绝对路径。
 * @param {function(string, string): void} report - 版本上报回调，入参为 `(version, source)`。
 * @returns {function(): void} 用于取消后台探测的取消函数。
 */
function ObserveCLIVersion(ctx, sandbox, provider, binary, report) {
  if (!path.isAbsolute(binary) || (ctx instanceof AbortSignal && ctx.aborted)) {
    return () => {};
  }
  if (onDemandCLICatalog()[provider] === undefined && !IsAgentCLI(provider)) {
    return () => {};
  }
  sandbox = unwrapSandbox(sandbox);
  if (!(sandbox instanceof dockerSandbox)) {
    const [version, source] = cliInstallationVersion(provider, binary);
    if (version !== "") {
      report(version, source);
      return () => {};
    }
  }
  // 原生工作区配置在租约结束后可能被重新分配，这里先拍一份浅拷贝快照。
  if (sandbox instanceof processSandbox) {
    // 对应 Go 的值复制 `snapshot := *native`。
    sandbox = Object.assign(Object.create(Object.getPrototypeOf(sandbox)), sandbox);
  }
  // context.WithCancel 译为 AbortController；父 ctx 取消时一并取消。
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (ctx instanceof AbortSignal) {
    if (ctx.aborted) {
      controller.abort();
    } else {
      ctx.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  const probeCtx = controller.signal;
  // 对应 Go 的 goroutine：JS 单线程下通过 setTimeout(..., 0) 延后执行，不阻塞调用方。
  setTimeout(() => {
    let version = "";
    if (sandbox instanceof dockerSandbox) {
      version = sandbox.probeCLIVersion(probeCtx, provider, binary);
    } else if (sandbox instanceof processSandbox || sandbox == null) {
      const native = sandbox instanceof processSandbox ? sandbox : null;
      version = probeHostCLIVersion(probeCtx, native, provider, binary);
    }
    if (version !== "" && !probeCtx.aborted) {
      report(version, "version_probe");
    }
  }, 0);
  return cancel;
}

/**
 * 尝试从静态安装元数据中读取 CLI 版本（不启动子进程）。
 * 先查询 `AGENTFLOW_MANAGED_CLI_ROOT` 下的托管清单，再沿符号链接解析后的父目录向上最多 5 层查找匹配的 `package.json`。
 * @param {string} provider - CLI 引擎标识名。
 * @param {string} binary - CLI 可执行文件绝对路径。
 * @returns {[string, string]} 命中时返回 `[version, source]`，未命中时返回 `["", ""]`。
 */
function cliInstallationVersion(provider, binary) {
  const root = (process.env.AGENTFLOW_MANAGED_CLI_ROOT ?? "").trim();
  if (root !== "") {
    let inventory = null;
    try {
      inventory = ReadInventory(root);
    } catch {
      // 对应 Go：ReadInventory 出错时跳过。
    }
    if (inventory !== null) {
      const install = inventory[provider];
      if (install !== undefined && install.Binary === binary) {
        const version = NormalizeCLIVersion(install.Version);
        if (version !== "") {
          return [version, "managed_inventory"];
        }
      }
    }
  }
  const entry = onDemandCLICatalog()[provider];
  let pkgName = entry !== undefined ? entry.Package : "";
  if (pkgName === "") {
    return ["", ""];
  }
  const pin = pkgName.lastIndexOf("@");
  if (pin > 0) {
    pkgName = pkgName.slice(0, pin);
  }
  let resolved;
  try {
    resolved = fs.realpathSync(binary);
  } catch {
    return ["", ""];
  }
  for (let dir = path.dirname(resolved), depth = 0; depth < 5; dir = path.dirname(dir), depth++) {
    const pkgPath = path.join(dir, "package.json");
    let info = null;
    try {
      info = fs.statSync(pkgPath);
    } catch {
      // 对应 Go：os.Stat 出错时跳过。
    }
    if (info === null || !info.isFile() || info.size > (64 << 10)) {
      continue;
    }
    let raw = null;
    try {
      raw = fs.readFileSync(pkgPath);
    } catch {
      // 对应 Go：os.ReadFile 出错时跳过。
    }
    let pkg = null;
    if (raw !== null) {
      try {
        pkg = JSON.parse(raw.toString("utf8"));
      } catch {
        // 对应 Go：json.Unmarshal 出错时跳过。
      }
    }
    // Go 的 json.Unmarshal 按字段名不区分大小写匹配 package.json 中的 name/version。
    const resolvedPkgName = pkg !== null ? (pkg.name ?? pkg.Name ?? "") : "";
    if (pkg !== null && resolvedPkgName === pkgName) {
      const version = NormalizeCLIVersion(pkg.version ?? pkg.Version ?? "");
      if (version !== "") {
        return [version, "package_metadata"];
      }
    }
  }
  return ["", ""];
}

/**
 * 从 CLI `--version` 命令的多行输出中提取合法版本号。
 * 仅接受无前缀或前缀与 `version`/provider/二进制名/展示标签匹配的行，过滤掉无关横幅信息。
 * @param {string} provider - CLI 引擎标识名。
 * @param {string} output - CLI 输出文本。
 * @returns {string} 提取并规范化后的版本号；未找到匹配行时返回空字符串。
 */
function cliVersionFromOutput(provider, output) {
  const binary = conversationBinary(provider);
  const label = onDemandCLILabel(provider).toLowerCase();
  for (const line of output.split("\n")) {
    const match = cliVersionLine.exec(line.trim());
    if (match === null || match.length !== 3) {
      continue;
    }
    // 对应 Go：strings.TrimSuffix(strings.ToLower(match[1]), " version")；未参与匹配的捕获组在 JS 中为 undefined。
    const rawPrefix = (match[1] ?? "").toLowerCase();
    const prefix = rawPrefix.endsWith(" version") ? rawPrefix.slice(0, rawPrefix.length - " version".length) : rawPrefix;
    switch (prefix) {
      case "":
      case "version":
      case provider:
      case binary:
      case binary + "-cli":
      case label:
      case label + " cli":
        return NormalizeCLIVersion(match[2]);
      default:
        break;
    }
  }
  return "";
}

/**
 * 在宿主机或原生进程沙箱的临时空目录中执行 `<binary> --version` 探测版本号。
 * 仅透传 PATH 与临时 HOME/TMPDIR，避免将凭据或用户配置暴露给探测进程。
 * @param {AbortSignal} ctx - 取消信号。
 * @param {processSandbox|null} sandbox - 原生进程沙箱实例；为 null 时使用本地临时沙箱。
 * @param {string} provider - CLI 引擎标识名。
 * @param {string} binary - CLI 可执行文件绝对路径。
 * @returns {string} 探测到的规范化版本号；探测失败或超时时返回空字符串。
 */
function probeHostCLIVersion(ctx, sandbox, provider, binary) {
  // context.WithTimeout 译为 AbortSignal.timeout；父 ctx 取消时一并取消。
  const signals = [];
  if (ctx instanceof AbortSignal) {
    signals.push(ctx);
  }
  signals.push(AbortSignal.timeout(cliVersionTimeout));
  const timeoutCtx = AbortSignal.any(signals);
  let home;
  try {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "loopforge-cli-version-"));
  } catch {
    return "";
  }
  try {
    const command = new CommandSpec({ Argv: [binary, "--version"], WorkingDir: home, OwnProcessGroup: true });
    const env = ["PATH=" + (process.env.PATH ?? ""), "HOME=" + home, "TMPDIR=" + home];
    let cmd;
    try {
      if (sandbox == null) {
        cmd = new localSandbox({ workspace: home }).command(timeoutCtx, command, env);
      } else {
        // bwrap 会挂载独立的 /tmp，此处仅绑定一次性临时探测目录。
        command.privateBinds = [home];
        cmd = sandbox.command(timeoutCtx, command, env);
      }
    } catch {
      return "";
    }
    // 沙箱配置与常规命令可能携带凭据和配置路径；版本探测进程只需要 PATH 与临时 HOME。
    cmd.Env = upsertEnv(env, "PATH", lookupEnvSlice(cmd.Env, "PATH"));
    return cliVersionFromOutput(provider, runCLIVersionProbe(cmd));
  } finally {
    // 对应 Go：defer os.RemoveAll(home)。
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * 带容量上限（cliVersionOutputLimit = 8 KiB）的输出缓冲区，对应 Go 的 `io.Writer` 实现。
 * 防止异常 CLI 输出大量内容耗尽内存。
 */
class cliVersionOutput {
  /**
   * 构造空的版本探测输出缓冲区。
   */
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * 追加写入一段字节数据；若超出上限则抛出错误。
   * @param {Buffer|Uint8Array|string} p - 待写入的数据块。
   * @returns {number} 本次写入的字节长度；超过上限时抛出 Error。
   */
  Write(p) {
    if (this.buffer.length + p.length > cliVersionOutputLimit) {
      throw new Error("CLI version output too large");
    }
    this.buffer = Buffer.concat([this.buffer, Buffer.from(p)]);
    return p.length;
  }
}

/**
 * 运行已构造好的版本探测命令对象，收集标准输出与标准错误并返回文本。
 * 执行出错时返回空字符串，并在进程退出后尽力调用 Cancel 清理残留进程。
 * @param {Object} cmd - 命令对象（包含 Stdout、Stderr、WaitDelay、Process、Cancel、Run）。
 * @returns {string} 命令成功退出时的 UTF-8 输出文本；失败时返回空字符串。
 */
function runCLIVersionProbe(cmd) {
  const output = new cliVersionOutput();
  cmd.Stdout = output;
  cmd.Stderr = output;
  cmd.WaitDelay = 200;
  let err = null;
  try {
    cmd.Run();
  } catch (e) {
    err = e;
  }
  if (cmd.Process != null && cmd.Cancel != null) {
    try {
      cmd.Cancel();
    } catch {
      // 对应 Go：忽略 Cancel 返回的错误。
    }
  }
  if (err != null) {
    return "";
  }
  return output.buffer.toString("utf8");
}

/**
 * 在当前 Docker 沙箱容器内隔离探测指定 CLI 的版本号。
 * 先通过 `docker inspect` 锁定容器 64 位 ID，再在容器临时目录中通过受限 Python 包装器执行 `--version`。
 * @param {AbortSignal} ctx - 取消信号。
 * @param {string} provider - CLI 引擎标识名。
 * @param {string} binary - 容器内 CLI 可执行文件绝对路径。
 * @returns {string} 探测到的规范化版本号；容器不可用或探测失败时返回空字符串。
 */
dockerSandbox.prototype.probeCLIVersion = function (ctx, provider, binary) {
  // context.WithTimeout 译为 AbortSignal.timeout；父 ctx 取消时一并取消。
  const signals = [];
  if (ctx instanceof AbortSignal) {
    signals.push(ctx);
  }
  signals.push(AbortSignal.timeout(cliVersionTimeout + 2 * 1000));
  const timeoutCtx = AbortSignal.any(signals);
  // 将探测绑定到具体容器 ID，避免后续回合用同名重建沙箱时串台；探测不占用执行闸门。
  const rawResult = spawnSync("docker", ["inspect", "--type", "container", "--format", "{{.Id}}", this.name], { signal: timeoutCtx });
  if (rawResult.error != null || rawResult.status !== 0) {
    return "";
  }
  const id = (rawResult.stdout ?? Buffer.alloc(0)).toString("utf8").trim();
  // 对应 Go：hex.DecodeString 成功且长度为 64。
  if (!/^[0-9a-fA-F]{64}$/.test(id)) {
    return "";
  }
  const args = ["exec", "--workdir", "/tmp"];
  if (this.profile.Environment["PATH"] !== undefined) {
    args.push("-e", "PATH=" + this.profile.Environment["PATH"]);
  }
  args.push(...this.toolchainExecEnv());
  args.push(
    id,
    "sh",
    "-c",
    dockerCLIVersionLaunch,
    "loopforge-cli-version",
    dockerConversationProcessSupervisor,
    dockerCLIVersionProbe,
    binary,
    String(Math.trunc(cliVersionTimeout / 1000)),
    dockerCLIVersionCommand,
  );
  return cliVersionFromOutput(provider, runCLIVersionProbe(commandContext(timeoutCtx, "docker", args)));
};

/**
 * 构造带有 `Run` 方法的同步命令对象，对应 Go 的 `exec.CommandContext`。
 * 供 `dockerSandbox.prototype.probeCLIVersion` 复用 `runCLIVersionProbe` 输出限流与错误处理逻辑。
 * @param {AbortSignal} signal - 取消信号。
 * @param {string} name - 可执行命令名。
 * @param {Array<string>} args - 命令参数数组。
 * @returns {{Stdout: Object|null, Stderr: Object|null, WaitDelay: number, Process: Object|null, Cancel: Function|null, Run: Function}} 可执行命令对象。
 */
function commandContext(signal, name, args) {
  const cmd = {
    Stdout: null,
    Stderr: null,
    WaitDelay: 0,
    Process: null,
    Cancel: null,
    Run() {
      const result = spawnSync(name, args, { signal });
      if (result.pid !== undefined) {
        cmd.Process = { Pid: result.pid };
      }
      // 合并 stdout 与 stderr 后写入输出缓冲。
      const out = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]);
      if (cmd.Stdout !== null) {
        cmd.Stdout.Write(out);
      }
      if (result.error != null) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error(`exit status ${result.status}`);
      }
    },
  };
  return cmd;
}

// 父进程管理临时目录生命周期；即使外部断开 Docker 连接，容器内部也会强制执行超时，
// 并由已有进程监督脚本在删除临时目录前回收残留子进程。
const dockerCLIVersionLaunch =
  toolchainPathSetup +
  dockerCLISharedPathSetup +
  `set -eu
dir=$(mktemp -d /tmp/loopforge-cli-version.XXXXXXXX)
trap 'rm -rf -- "$dir"' EXIT
cd "$dir"
python3 -I -c "$1" "$dir/probe.pid" python3 -I -c "$2" "$3" "$4" "$5"
`;

// 登录 profile 可能设置解释器 PATH；仅将可执行文件自身输出重定向到捕获文件，
// 防止登录横幅混入版本号解析。
const dockerCLIVersionCommand =
  toolchainPathSetup +
  dockerCLISharedPathSetup +
  `exec env -i "PATH=$PATH" "HOME=$2" "TMPDIR=$2" "$1" --version > "$3" 2>&1
`;

const dockerCLIVersionProbe = `import os,resource,subprocess,sys,tempfile
home=os.getcwd()
env={"PATH": os.environ["PATH"], "HOME": home, "TMPDIR": home}
if "AGENTFLOW_TOOLCHAIN" in os.environ:
    env["AGENTFLOW_TOOLCHAIN"]=os.environ["AGENTFLOW_TOOLCHAIN"]
with tempfile.TemporaryFile(dir=home) as output:
    resource.setrlimit(resource.RLIMIT_FSIZE, (8192, 8192))
    try:
        output_path="/proc/self/fd/"+str(output.fileno())
        result=subprocess.run(["sh", "-lc", sys.argv[3], "loopforge-cli-version", sys.argv[1], home, output_path],
                              env=env, pass_fds=(output.fileno(),), timeout=int(sys.argv[2]),
                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        sys.exit(1)
    if result.returncode == 0:
        output.seek(0)
        sys.stdout.buffer.write(output.read())
`;

module.exports = {
  CLIVersionEvent,
  NormalizeCLIVersion,
  ObserveCLIVersion,
  cliInstallationVersion,
  cliVersionFromOutput,
  probeHostCLIVersion,
  cliVersionOutput,
  runCLIVersionProbe,
  dockerCLIVersionLaunch,
  dockerCLIVersionCommand,
  dockerCLIVersionProbe,
};
