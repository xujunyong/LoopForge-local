// cli_version.js —— 对应 Go 文件：internal/runtime/cli_version.go
// 作用：观测 CLI 版本：先读托管清单或包元数据，取不到时后台探测 --version 输出。
// Go 的 time.Duration 译为毫秒数；context.Context 译为 AbortSignal；
// goroutine 译为 setTimeout 延后执行；(值, error) 译为成功返回值、失败 throw，(值, bool) 译为 [值, bool]。

"use strict";

const fs = require("node:fs"); // Go os
const os = require("node:os"); // Go os
const path = require("node:path"); // Go path/filepath
const { spawnSync } = require("node:child_process"); // Go os/exec

const { ReadInventory } = require("../managedcli/manifest.js"); // 对应 Go 的 managedcli.ReadInventory，manifest.js 已翻译
const { onDemandCLICatalog, onDemandCLILabel } = require("./cli_ondemand.js"); // 对应 Go 同包函数，cli_ondemand.js 已翻译
const { IsAgentCLI } = require("./agent_cli.js"); // 对应 Go 同包函数，agent_cli.js 待翻译
const { unwrapSandbox } = require("./browser.js"); // 对应 Go 同包函数，browser.js 待翻译
const { dockerSandbox } = require("./sandbox_docker.js"); // 对应 Go 同包类型，sandbox_docker.js 待翻译
const { processSandbox, lookupEnvSlice } = require("./sandbox_process.js"); // 对应 Go 同包类型与函数，sandbox_process.js 待翻译
const { localSandbox } = require("./sandbox_local.js"); // 对应 Go 同包类型，sandbox_local.js 待翻译
const { conversationBinary } = require("./conversation_process.js"); // 对应 Go 同包函数，conversation_process.js 待翻译
const { upsertEnv } = require("./command_binding.js"); // 对应 Go 同包函数，command_binding.js 已翻译
const { CommandSpec } = require("./runtime.js"); // 对应 Go 同包类型，runtime.js 待翻译
const { toolchainPathSetup } = require("./toolchain.js"); // 对应 Go 同包常量，toolchain.js 待翻译
const { dockerCLISharedPathSetup } = require("./conversation_sandbox.js"); // 对应 Go 同包常量，conversation_sandbox.js 待翻译
const { dockerConversationProcessSupervisor } = require("./conversation_docker_process.js"); // 对应 Go 同包常量，conversation_docker_process.js 待翻译

const CLIVersionEvent = "cli.version";

const cliVersionOutputLimit = 8 << 10;
const cliVersionTimeout = 5 * 1000;
const cliVersionNumber = `[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\\+[A-Za-z0-9.-]+)?`;

const cliVersionValue = new RegExp("^" + cliVersionNumber + "$");
const cliVersionLine = new RegExp(`^(?:([a-z][a-z0-9 -]*?)[ /:]+)?(v?${cliVersionNumber})(?:\\s+\\([^()]+\\))?$`, "i");

// NormalizeCLIVersion：只接受版本号本身，不带展示前缀。
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

// ObserveCLIVersion：有安装元数据时立即上报，否则在实际调用进行期间后台探测。
// 返回的取消函数在调用退出时调用。
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
  // Native workspace requirements can be reassigned after its lease ends.
  if (sandbox instanceof processSandbox) {
    // Go 的 *native 是值复制。
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
  // Go 的 go 语句：JS 单线程，用 setTimeout 延后到下一轮执行，不阻塞调用方。
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

function cliInstallationVersion(provider, binary) {
  const root = (process.env.AGENTFLOW_MANAGED_CLI_ROOT ?? "").trim();
  if (root !== "") {
    let inventory = null;
    try {
      inventory = ReadInventory(root);
    } catch {
      // Go：ReadInventory 出错时跳过。
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
      // Go：os.Stat 出错时跳过。
    }
    if (info === null || !info.isFile() || info.size > (64 << 10)) {
      continue;
    }
    let raw = null;
    try {
      raw = fs.readFileSync(pkgPath);
    } catch {
      // Go：os.ReadFile 出错时跳过。
    }
    let pkg = null;
    if (raw !== null) {
      try {
        pkg = JSON.parse(raw.toString("utf8"));
      } catch {
        // Go：json.Unmarshal 出错时跳过。
      }
    }
    if (pkg !== null && pkg.Name === pkgName) {
      const version = NormalizeCLIVersion(pkg.Version ?? "");
      if (version !== "") {
        return [version, "package_metadata"];
      }
    }
  }
  return ["", ""];
}

function cliVersionFromOutput(provider, output) {
  const binary = conversationBinary(provider);
  const label = onDemandCLILabel(provider).toLowerCase();
  for (const line of output.split("\n")) {
    const match = cliVersionLine.exec(line.trim());
    if (match === null || match.length !== 3) {
      continue;
    }
    // Go：strings.TrimSuffix(strings.ToLower(match[1]), " version")；未参与匹配的分组在 JS 里是 undefined。
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
        // bwrap mounts its own /tmp. Bind only the disposable probe directory.
        command.privateBinds = [home];
        cmd = sandbox.command(timeoutCtx, command, env);
      }
    } catch {
      return "";
    }
    // The sandbox profile and normal command can supply credentials and
    // config paths. The version process only needs PATH and its scratch HOME.
    cmd.Env = upsertEnv(env, "PATH", lookupEnvSlice(cmd.Env, "PATH"));
    return cliVersionFromOutput(provider, runCLIVersionProbe(cmd));
  } finally {
    // Go：defer os.RemoveAll(home)。
    fs.rmSync(home, { recursive: true, force: true });
  }
}

class cliVersionOutput {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  Write(p) {
    if (this.buffer.length + p.length > cliVersionOutputLimit) {
      throw new Error("CLI version output too large");
    }
    this.buffer = Buffer.concat([this.buffer, Buffer.from(p)]);
    return p.length;
  }
}

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
      // Go：忽略 Cancel 的错误。
    }
  }
  if (err != null) {
    return "";
  }
  return output.buffer.toString("utf8");
}

dockerSandbox.prototype.probeCLIVersion = function (ctx, provider, binary) {
  // context.WithTimeout 译为 AbortSignal.timeout；父 ctx 取消时一并取消。
  const signals = [];
  if (ctx instanceof AbortSignal) {
    signals.push(ctx);
  }
  signals.push(AbortSignal.timeout(cliVersionTimeout + 2 * 1000));
  const timeoutCtx = AbortSignal.any(signals);
  // Bind the probe to this container even if a later turn recreates the
  // sandbox under the same name. The probe never holds its execution gate.
  const rawResult = spawnSync("docker", ["inspect", "--type", "container", "--format", "{{.Id}}", this.name], { signal: timeoutCtx });
  if (rawResult.error != null || rawResult.status !== 0) {
    return "";
  }
  const id = (rawResult.stdout ?? Buffer.alloc(0)).toString("utf8").trim();
  // Go：hex.DecodeString 成功且长度为 64。
  if (!/^[0-9a-fA-F]{64}$/.test(id)) {
    return "";
  }
  const args = ["exec", "--workdir", "/tmp"];
  if (this.profile.Environment["PATH"] !== undefined) {
    args.push("-e", "PATH=" + this.profile.Environment["PATH"]);
  }
  args.push(...this.toolchainExecEnv());
  args.push(id, "sh", "-c", dockerCLIVersionLaunch, "loopforge-cli-version",
    dockerConversationProcessSupervisor, dockerCLIVersionProbe, binary,
    String(Math.trunc(cliVersionTimeout / 1000)), dockerCLIVersionCommand);
  return cliVersionFromOutput(provider, runCLIVersionProbe(commandContext(timeoutCtx, "docker", args)));
};

// commandContext：Go 的 exec.CommandContext，构造一个带 Run 的命令对象；
// Run 用 spawnSync 同步执行，输出写到 Stdout/Stderr 指定的目标。
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
      // Go CombinedOutput 合并 stdout 与 stderr；这里把两者拼接后一次写入。
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

// The parent owns the scratch directory. A timeout is enforced inside the
// container even if the Go client cancels its Docker connection. The existing
// supervisor reaps detached descendants before the parent removes the directory.
const dockerCLIVersionLaunch = toolchainPathSetup + dockerCLISharedPathSetup + `set -eu
dir=$(mktemp -d /tmp/loopforge-cli-version.XXXXXXXX)
trap 'rm -rf -- "$dir"' EXIT
cd "$dir"
python3 -I -c "$1" "$dir/probe.pid" python3 -I -c "$2" "$3" "$4" "$5"
`;

// Login profiles can set the interpreter's PATH. Redirect only the executable's
// output into the capture file, so a profile banner cannot become a version.
const dockerCLIVersionCommand = toolchainPathSetup + dockerCLISharedPathSetup + `exec env -i "PATH=$PATH" "HOME=$2" "TMPDIR=$2" "$1" --version > "$3" 2>&1
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

module.exports = { CLIVersionEvent, NormalizeCLIVersion, ObserveCLIVersion, cliInstallationVersion, cliVersionFromOutput, probeHostCLIVersion, cliVersionOutput, runCLIVersionProbe, dockerCLIVersionLaunch, dockerCLIVersionCommand, dockerCLIVersionProbe };
