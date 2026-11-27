/**
 * @file internal/runtime/conversation_sandbox.js
 * @description 对应 Go 源文件：internal/runtime/conversation_sandbox.go
 *
 * 职责与边界：
 * 负责为对话工作区配置持久化的原生 HOME/cwd 挂载（支持 Docker 容器重建与 native 进程沙箱配置）、
 * 生成只读安全守卫文件及其父目录锚点挂载参数、解析宿主机本地 CLI 路径，以及在现有 Docker 容器中按需安装并验证各供应商官方 CLI。
 * 不负责容器基础生命周期管理或进程池调度。
 *
 * 语法差异说明：
 * - `context.Context` 译为 `AbortSignal`；`context.WithTimeout` 译为 `AbortSignal.timeout`。
 * - `(值, error)` 译为成功返回值、失败抛出 `Error`（子进程合并输出失败时在抛出的 `Error` 上挂载 `output` 属性）；`(值, bool)` 译为 `[值, boolean]`。
 * - `exec.CommandContext(...).CombinedOutput` 译为 `spawnSync` 同步执行并拼接标准输出与标准错误。
 * - `sync.RWMutex`/`sync.Once` 与 `channel` 在单线程 JS 中不需要，略去。
 * - 与 `conversation_process.js` 存在同包循环依赖，调用 `conversationBinary` 时在函数内延迟 `require("./conversation_process.js")`。
 */

"use strict";

const fs = require("node:fs"); // Go os
const os = require("node:os"); // Go os
const path = require("node:path"); // Go path/filepath
const { spawnSync } = require("node:child_process"); // Go os/exec

const { ReadInventory, BinaryFor } = require("../managedcli/manifest.js"); // 对应 Go 的 managedcli.ReadInventory/BinaryFor，manifest.js 已翻译
const { AgentCLICursor, AgentCLIZCode } = require("./agent_cli.js"); // 对应 Go 同包常量，agent_cli.js 已翻译
const { onDemandCLICatalog, OnDemandCLIPath, scriptCLIInstaller } = require("./cli_ondemand.js"); // 对应 Go 同包函数，cli_ondemand.js 已翻译
const { fileIsExecutable, lookPath } = require("./claude_install.js"); // 对应 Go 同包函数，claude_install.js 已翻译
const { unwrapSandbox } = require("./browser.js"); // 对应 Go 同包函数，browser.js 已翻译
const { prepareSharedCursorCLI } = require("./cursor_install.js"); // 对应 Go 同包函数，cursor_install.js 本批翻译
const { dockerSandbox, isDockerCLIMissing } = require("./sandbox_docker.js"); // 对应 Go 同包类型与函数，sandbox_docker.js 待翻译
const { processSandbox } = require("./sandbox_process.js"); // 对应 Go 同包类型，sandbox_process.js 待翻译
const { explicitNativeCLIPath } = require("./managed_cli.js"); // 对应 Go 同包函数，managed_cli.js 待翻译
const { toolchainPathSetup } = require("./toolchain.js"); // 对应 Go 同包常量，toolchain.js 待翻译
const { shellSingleQuote } = require("./sandbox_environment.js"); // 对应 Go 同包函数，sandbox_environment.js 待翻译

/**
 * 为已有运行沙箱附加持久的原生 HOME/cwd 挂载；若为 Docker 沙箱且挂载根变更则重建容器。
 * 由调用方在持有执行互斥栅栏时调用，容器重建后需重新执行准备流程。
 *
 * @param {AbortSignal|null} ctx 取消信号。
 * @param {object} sandbox 目标沙箱实例（可为包装沙箱）。
 * @param {string} root 会话根目录路径。
 * @returns {void} 配置成功无返回值；不支持的沙箱类型或重建失败时抛出错误。
 */
function ConfigureConversationSandbox(ctx, sandbox, root) {
  root = path.resolve(root);
  fs.mkdirSync(path.join(root, "ws"), { recursive: true, mode: 0o700 });
  const inner = unwrapSandbox(sandbox);
  if (inner instanceof processSandbox) {
    return configureProcessConversationSandbox(inner, root);
  }
  const s = inner;
  if (!(s instanceof dockerSandbox)) {
    throw new Error("对话工作区只支持 Docker 或 native 沙箱");
  }
  // Go 的 s.execGate.Lock()：单线程 JS 不需要，略去。
  if (s.requirements.ConversationRoot === root) {
    return;
  }
  const previousRoot = s.requirements.ConversationRoot;
  s.requirements.ConversationRoot = root;
  try {
    s.Recreate(ctx);
  } catch (err) {
    s.requirements.ConversationRoot = previousRoot;
    throw err;
  }
}

/**
 * 为原生进程沙箱（Linux `bwrap` 或 macOS `seatbelt`）配置会话根目录。
 * 由 `ConfigureConversationSandbox` 在识别到底层为 `processSandbox` 时调用。
 *
 * @param {processSandbox} s 原生进程沙箱实例。
 * @param {string} root 会话根目录的绝对路径。
 * @returns {void} 配置成功无返回值；驱动不支持或建目录失败时抛出错误。
 */
function configureProcessConversationSandbox(s, root) {
  if (s.driver !== "bwrap" && s.driver !== "seatbelt") {
    throw new Error("对话工作区只支持 Docker 或 native 沙箱");
  }
  fs.mkdirSync(path.join(root, "home"), { recursive: true, mode: 0o700 });
  s.requirements.ConversationRoot = root;
}

// 固定路径挂载的安全配置文件清单；锚定全部父目录可防止通过重命名父目录绕过只读文件保护。
const conversationGuardFiles = [
  "home/.cursor/hooks.json", "home/.gemini/config/hooks.json",
  "home/.kimi-code/config.toml", "home/.config/opencode/opencode.json",
  "home/.config/opencode/plugins/loopforge-approval.js",
  "home/.pi/agent/extensions/loopforge-approval.ts",
  "home/.zcode/cli/config.json",
];

/**
 * 生成 Docker 容器启动时用于挂载安全守卫目录与只读守卫文件的 `-v` 参数列表。
 * 在构造 Docker 对话沙箱挂载参数时调用。
 *
 * @param {string} root 会话根目录的绝对路径。
 * @returns {string[]} 交替包含 `"-v"` 与挂载规格的参数数组。
 */
function conversationGuardMounts(root) {
  const [parents, files] = conversationGuardPaths(root);
  const mounts = [];
  for (const parent of parents) {
    mounts.push("-v", parent + ":" + parent);
  }
  for (const file of files) {
    mounts.push("-v", file + ":" + file + ":ro");
  }
  return mounts;
}

/**
 * 在会话根目录下确保所有安全守卫文件存在，并返回需要锚定的父目录列表与需只读挂载的文件列表。
 * 由 `conversationGuardMounts` 以及原生进程沙箱规则构建逻辑调用。
 *
 * @param {string} root 会话根目录的绝对路径。
 * @returns {[string[], string[]]} 二元组 `[已排序的父目录路径数组, 守卫文件路径数组]`。
 */
function conversationGuardPaths(root) {
  const anchors = {};
  const files = [];
  for (const rel of conversationGuardFiles) {
    const file = path.join(root, ...rel.split("/"));
    for (let parent = path.dirname(file); parent !== path.join(root, "home"); parent = path.dirname(parent)) {
      anchors[parent] = true;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let statErr = null;
    try {
      fs.statSync(file);
    } catch (err) {
      statErr = err;
    }
    if (statErr !== null && statErr.code === "ENOENT") {
      fs.writeFileSync(file, "{}", { mode: 0o600 });
    } else if (statErr !== null) {
      throw statErr;
    }
    files.push(file);
  }
  const parents = Object.keys(anchors);
  parents.sort();
  return [parents, files];
}

/**
 * 按优先级解析宿主机上的原生对话 CLI 可执行文件路径（显式环境变量覆盖 → 托管清单 → PATH → `~/.local/bin` → 系统目录 → 按需安装路径）。
 * 在原生进程沙箱模式下由 `ensureConversationCLI` 调用。
 *
 * @param {string} provider CLI 供应商标识。
 * @returns {string} 解析到的可执行文件绝对路径。
 */
function resolveNativeConversationBinary(provider) {
  // 延迟 require 打破与 conversation_process.js 的同包循环依赖。
  const { conversationBinary } = require("./conversation_process.js");
  const binary = conversationBinary(provider);
  const explicit = explicitNativeCLIPath(provider);
  if (explicit !== "") {
    return explicit;
  }
  const root = (process.env.AGENTFLOW_MANAGED_CLI_ROOT ?? "").trim();
  if (root !== "") {
    let inventory = null;
    try {
      inventory = ReadInventory(root);
    } catch {
      // Go：ReadInventory 出错时跳过。
    }
    if (inventory !== null) {
      const [foundPath, ok] = BinaryFor(inventory, provider);
      if (ok) {
        return foundPath;
      }
    }
  }
  const found = lookPath(binary);
  if (found !== null) {
    return found;
  }
  let home = "";
  try {
    home = os.homedir();
  } catch {
    // Go：os.UserHomeDir 失败时 home 为空。
  }
  if (home.trim() !== "") {
    const candidate = path.join(home, ".local", "bin", binary);
    if (fileIsExecutable(candidate)) {
      return candidate;
    }
  }
  for (const candidate of ["/usr/local/bin/" + binary, "/usr/bin/" + binary]) {
    if (fileIsExecutable(candidate)) {
      return candidate;
    }
  }
  const [onDemand, ok] = OnDemandCLIPath(provider);
  if (ok) {
    return onDemand;
  }
  // Go：err 是上面 exec.LookPath 的错误，原文为 executable file not found in $PATH。
  throw new Error(`执行机器未安装 CLI ${provider}：exec: "${binary}": executable file not found in $PATH`);
}

/**
 * 确保指定沙箱内目标供应商的 CLI 可用，并返回其可执行文件路径。
 * 在对话进程启动阶段调用：原生沙箱解析宿主机二进制，Docker 沙箱则在容器内探测/安装并校验。
 *
 * @param {AbortSignal|null} ctx 取消信号。
 * @param {object} sandbox 目标沙箱实例。
 * @param {string} provider CLI 供应商标识。
 * @param {string} home 会话原生 HOME 目录路径。
 * @returns {string} 可用的 CLI 可执行文件路径。
 */
function ensureConversationCLI(ctx, sandbox, provider, home) {
  const inner = unwrapSandbox(sandbox);
  if (inner instanceof processSandbox) {
    return resolveNativeConversationBinary(provider);
  }
  const s = inner;
  if (!(s instanceof dockerSandbox)) {
    throw new Error("对话工作区只支持 Docker 或 native 沙箱");
  }
  // Go 的 s.execGate.RLock()：单线程 JS 不需要，略去。
  return s.ensureDockerCLI(ctx, provider, home);
}

const dockerCLISharedPath = "/opt/loopforge/conversation-cli/bin:/opt/loopforge/conversation-cli/.local/bin";
const dockerCLISharedPathSetup = "PATH=" + dockerCLISharedPath + ":$PATH\nexport PATH\n";

const dockerCLIProbe = `cli_path=$(command -v "$1") || exit 127
[ -f "$cli_path" ] && [ -x "$cli_path" ] || exit 127
printf '%s\\n' "$cli_path"
`;

/**
 * 在已有 Docker 容器内准备指定供应商的原生 CLI：探测执行用户 UID/GID、检查或安装 CLI 与 Python3 依赖、补齐 NSS 身份并验证可执行路径。
 * 挂在 `dockerSandbox.prototype` 上，由 `ensureConversationCLI` 在持有读锁时调用。
 *
 * @param {AbortSignal|null} ctx 取消信号（内部附加 10 分钟超时上限）。
 * @param {string} provider CLI 供应商标识。
 * @param {string} home 会话原生 HOME 目录路径。
 * @returns {string} 容器内执行用户可直接调用的 CLI 绝对路径。
 */
dockerSandbox.prototype.ensureDockerCLI = function (ctx, provider, home) {
  // 延迟 require 打破与 conversation_process.js 的同包循环依赖。
  const { conversationBinary } = require("./conversation_process.js");
  const binary = conversationBinary(provider);
  const setup = dockerCLISetup(provider, binary);
  // context.WithTimeout 译为 AbortSignal.timeout；父 ctx 取消时一并取消。
  const signals = [];
  if (ctx instanceof AbortSignal) {
    signals.push(ctx);
  }
  signals.push(AbortSignal.timeout(10 * 60 * 1000));
  ctx = AbortSignal.any(signals);
  // Go 的 cliSetupOnce 与 cliSetupGate：单线程 JS 不需要，略去；只保留 ctx 已取消的分支。
  if (ctx.aborted) {
    throw ctx.reason ?? new Error("context canceled");
  }
  let identity;
  try {
    identity = commandCombinedOutput(ctx, "docker", ["exec", "--workdir", "/", this.name, "sh", "-c", "id -u; id -g"]);
  } catch (identityErr) {
    throw new Error(`读取工作区 CLI 用户失败: ${identityErr.message}: ${conversationSetupOutput(identityErr.output ?? Buffer.alloc(0))}`);
  }
  const identityText = identity.toString("utf8").trim();
  const ids = identityText === "" ? [] : identityText.split(/\s+/);
  if (ids.length !== 2) {
    throw new Error("工作区 CLI 用户未返回 UID/GID");
  }
  for (const id of ids) {
    // Go 的 strconv.ParseUint(id, 10, 32)；1<<32-1 即 4294967295。
    const value = /^[0-9]+$/.test(id) ? Number(id) : NaN;
    if (Number.isNaN(value) || value >= 4294967295) {
      throw new Error("工作区 CLI 用户返回了无效 UID/GID");
    }
  }
  const toolchain = this.toolchainCLIExecEnv(binary);
  const taskArgs = ["exec", "--workdir", "/", ...toolchain, this.name, "sh", "-lc"];
  let taskPathSetup = dockerCLISharedPathSetup + toolchainPathSetup;
  let installMode = "reuse";
  try {
    commandCombinedOutput(ctx, "docker", [...taskArgs, taskPathSetup + dockerCLIProbe, "loopforge-cli-available", binary]);
  } catch (probeErr) {
    if (!isDockerCLIMissing(probeErr)) {
      throw new Error(`探测工作区 CLI ${binary} 失败：${probeErr.message}: ${conversationSetupOutput(probeErr.output ?? Buffer.alloc(0))}`);
    }
    installMode = "install";
    if (provider === AgentCLICursor && process.platform === "linux") {
      let shared = "";
      try {
        shared = prepareSharedCursorCLI(ctx, false);
      } catch {
        // Go：共享目录不可用不阻塞容器内安装。
      }
      if (shared !== "" && this.probeCLIVersion(ctx, provider, shared) !== "") {
        taskPathSetup += "PATH=$PATH:" + shellSingleQuote(path.dirname(shared)) + "\nexport PATH\n";
        installMode = "reuse";
      }
    }
  }
  const setupArgs = ["exec", "--user", "0:0", "--workdir", "/"];
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    if ((this.profile.Environment ?? {})[key] !== undefined) {
      setupArgs.push("-e", key + "=" + this.profile.Environment[key]);
    }
  }
  setupArgs.push(...toolchain, this.name, "sh", "-lc", setup, "loopforge-cli-setup", ids[0], ids[1], home, installMode);
  try {
    commandCombinedOutput(ctx, "docker", setupArgs);
  } catch (setupErr) {
    throw new Error(`准备 ${provider} 原生CLI失败（工作区镜像需支持 Node.js/npm 和 Python3）：${setupErr.message}: ${conversationSetupOutput(setupErr.output ?? Buffer.alloc(0))}`);
  }
  const check = taskPathSetup + "python3 -c 'import os,pwd; pwd.getpwuid(os.geteuid())' || exit\n" + dockerCLIProbe;
  const checkArgs = [...taskArgs, check, "loopforge-cli-verify", binary];
  let checkOutput;
  try {
    checkOutput = commandCombinedOutput(ctx, "docker", checkArgs);
  } catch (checkErr) {
    throw new Error(`验证工作区执行用户可使用 CLI ${binary} 失败：${checkErr.message}: ${conversationSetupOutput(checkErr.output ?? Buffer.alloc(0))}`);
  }
  const lines = checkOutput.toString("utf8").trim().split("\n");
  const cliPath = lines[lines.length - 1].trim();
  if (!cliPath.startsWith("/") || /[\r\n\x00]/.test(cliPath)) {
    throw new Error(`工作区执行用户未返回 CLI ${binary} 的可执行文件路径`);
  }
  return cliPath;
};

/**
 * 生成在 Docker 容器内以 root 身份执行的 CLI 与运行环境准备脚本（确保 Python3、NSS 身份及按需 CLI 安装）。
 * 由 `dockerSandbox.prototype.ensureDockerCLI` 调用。
 *
 * @param {string} provider CLI 供应商标识。
 * @param {string} binary 对应的可执行文件名。
 * @returns {string} 完整的 shell 准备脚本内容。
 */
function dockerCLISetup(provider, binary) {
  // Go：map 缺失时取 onDemandCLI 零值。
  const spec = onDemandCLICatalog()[provider] ?? { Package: "", InstallerURL: "", RelaxEngines: false };
  let installer = "";
  if (spec.Package !== "") {
    let flags = "";
    if (spec.RelaxEngines) {
      flags = "--engine-strict=false ";
    }
    installer = "npm install --no-audit --no-fund " + flags + "--prefix /opt/loopforge/conversation-cli " + shellSingleQuote(spec.Package) + " >&2\nln -sf ../node_modules/.bin/" + shellSingleQuote(binary) + " /opt/loopforge/conversation-cli/bin/" + shellSingleQuote(binary);
  } else if (spec.InstallerURL !== "") {
    installer = "export HOME=/opt/loopforge/conversation-cli\n" + scriptCLIInstaller(spec.InstallerURL);
  } else {
    switch (provider) {
      case AgentCLIZCode:
        installer = "echo 'ZCode CLI 未安装；请在工作区镜像中预装官方 ZCode CLI 并将 zcode 加入 PATH' >&2; exit 1";
        break;
      default:
        throw new Error(`不支持的会话CLI ${provider}`);
    }
  }
  return "set -eu\n" + dockerCLISharedPathSetup + toolchainPathSetup + `export TAR_OPTIONS=--no-same-owner
if ! command -v python3 >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then apt-get update >&2 && apt-get install -y python3 >&2
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache python3 >&2
  else echo 'Python3 is required for native CLI hooks and process supervision' >&2; exit 1; fi
fi
` + conversationCLIIdentitySetup + "if [ \"$4\" = install ]; then\nmkdir -p /opt/loopforge/conversation-cli/bin\n" + installer + "\nfi\n" +
    "python3 -c 'import json,urllib.request'\n";
}

// conversationCLIIdentitySetup：Go 的反引号原生字符串译为模板字符串，其中的 \0、\r、\n 须写成 \\0、\\r、\\n 才保持原样。
const conversationCLIIdentitySetup = `python3 - "$1" "$2" "$3" <<'LOOPFORGE_CLI_IDENTITY'
import fcntl, pwd, sys
uid, gid = map(int, sys.argv[1:3])
home = sys.argv[3]
try:
    pwd.getpwuid(uid)
except KeyError:
    if not home.startswith("/") or any(c in home for c in "\\0:\\r\\n"):
        sys.exit("Invalid native CLI HOME for passwd identity")
    try:
        with open("/etc/passwd", "a+", encoding="utf-8") as passwd:
            fcntl.flock(passwd, fcntl.LOCK_EX)
            try:
                pwd.getpwuid(uid)
            except KeyError:
                name = "loopforge-cli-" + str(uid)
                names = {entry.pw_name for entry in pwd.getpwall()}
                while name in names:
                    name += "_"
                passwd.seek(0)
                previous = passwd.read()
                prefix = "" if not previous or previous.endswith("\\n") else "\\n"
                passwd.write(prefix + f"{name}:!:{uid}:{gid}:LoopForge CLI:{home}:/bin/false\\n")
                passwd.flush()
    except OSError as err:
        sys.exit(f"Native CLI UID {uid} has no passwd entry; add it to the workspace image or allow /etc/passwd writes during preparation: {err}")
    pwd.getpwuid(uid)
LOOPFORGE_CLI_IDENTITY
`;

/**
 * 截取容器准备命令输出的尾部（最多 3000 字节）并去除首尾空白，用于错误提示展示。
 * 在 `ensureDockerCLI` 格式化失败日志时调用。
 *
 * @param {Buffer} output 命令合并输出的原始字节。
 * @returns {string} 截断并裁剪空白后的 UTF-8 文本。
 */
function conversationSetupOutput(output) {
  if (output.length > 3000) {
    output = output.subarray(output.length - 3000);
  }
  return output.toString("utf8").trim();
}

/**
 * 同步执行外部命令并返回合并后的标准输出与标准错误，对应 Go 的 `exec.CommandContext(...).CombinedOutput()`。
 * 在 `ensureDockerCLI` 调用 `docker exec` 探测、安装与校验时使用。
 *
 * @param {AbortSignal|null} signal 取消或超时信号。
 * @param {string} name 可执行程序名。
 * @param {string[]} args 命令行参数数组。
 * @returns {Buffer} 命令成功时的合并输出；失败时抛出 `Error`（其 `output` 属性携带合并输出）。
 */
function commandCombinedOutput(signal, name, args) {
  const result = spawnSync(name, args, { signal });
  const output = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]);
  if (result.error !== null && result.error !== undefined) {
    result.error.output = output;
    throw result.error;
  }
  if (result.status !== 0) {
    const err = new Error(`exit status ${result.status}`);
    err.output = output;
    throw err;
  }
  return output;
}

module.exports = { ConfigureConversationSandbox, configureProcessConversationSandbox, conversationGuardFiles, conversationGuardMounts, conversationGuardPaths, resolveNativeConversationBinary, ensureConversationCLI, dockerCLISharedPath, dockerCLISharedPathSetup, dockerCLIProbe, dockerCLISetup, conversationCLIIdentitySetup, conversationSetupOutput };
