// cli_ondemand.js —— 对应 Go 文件：internal/runtime/cli_ondemand.go
//
// 文件作用与职责边界：
// 定义对话失败后允许按需安装的 CLI 白名单目录、磁盘路径探测与安装执行入口（支持 npm 包安装、
// 官方 HTTPS 脚本安装以及 Claude Code / 共享 Cursor CLI 的专用安装逻辑）。
// 包名与安装脚本 URL 全部固定在白名单内，外部请求只能选择引擎名称。
//
// Go 与 JS 语法差异说明：
// - Go 的 `os/exec` 译为 `child_process.spawnSync`；`context.Context` 译为 `AbortSignal`；
// - `(值, error)` 译为成功返回值、失败 throw；`(值, bool)` 译为 `[值, bool]`；
// - `sync.Mutex` 在单线程 JS 中不需要，已略去。

"use strict";

const fs = require("node:fs"); // 对应 Go 标准库 os
const os = require("node:os"); // 对应 Go 标准库 os
const path = require("node:path"); // 对应 Go 标准库 path/filepath
const { spawnSync } = require("node:child_process"); // 对应 Go 标准库 os/exec

const { RuntimeCLIDir, claudeCodeBinary, EnsureClaudeCode, fileIsExecutable, lookPath } = require("./claude_install.js"); // 对应 Go 同包函数
const { cursorCLIBinary, sharedCursorCLIPath, prepareSharedCursorCLI } = require("./cursor_install.js"); // 对应 Go 同包常量与函数
const { AgentCLICursor, AgentCLILabel } = require("./agent_cli.js"); // 对应 Go 同包常量与函数
const { shellSingleQuote } = require("./sandbox_environment.js"); // 对应 Go 同包函数
const { upsertEnv } = require("./command_binding.js"); // 对应 Go 同包函数
const { tailOutput } = require("./browser.js"); // 对应 Go 同包函数

// 已发布平台镜像不保证提供这些 CLI。Codex、CodeBuddy 与 DeepSeek Harness 烘焙在镜像里；
// 其余只在有人从失败对话中要求后才安装。包名与安装地址固定：请求只能选引擎，不能选 URL 或包。
const cursorInstallerURL = "https://cursor.com/install";
const agyInstallerURL = "https://antigravity.google/cli/install.sh";

// DeepSeekHarnessVersion：Dockerfile 捆绑、无则下载的 dsh 版本。必须显式命名：
// 每个 dsh 版本都是预发布版，要求比镜像自带的更新的 Node，裸包名解析不到任何版本。
const DeepSeekHarnessVersion = "0.2.2-rc.1";

/**
 * 描述一个支持按需安装的 CLI 规格元数据。
 * 由 onDemandCLICatalog 构建，供路径查询与安装调度使用。
 */
class onDemandCLI {
  /**
   * 构造按需安装 CLI 规格对象。
   * @param {Object} [init={}] - 初始化字段集合。
   * @param {string} [init.Engine=""] - 引擎标识名（如 `codex`、`claude-code`）。
   * @param {string} [init.Binary=""] - 安装后的可执行文件名。
   * @param {string} [init.Package=""] - npm 包名（可含固定版本号）。
   * @param {string} [init.InstallerURL=""] - 官方安装脚本 HTTPS 地址（非 npm 安装时使用）。
   * @param {boolean} [init.RelaxEngines=false] - npm 安装时是否传 `--engine-strict=false` 放宽 Node 版本校验。
   * @param {boolean} [init.Bundled=false] - 是否已随发布镜像内置，沙箱无需再安装。
   */
  constructor(init = {}) {
    this.Engine = init.Engine ?? "";
    this.Binary = init.Binary ?? "";
    this.Package = init.Package ?? "";
    this.InstallerURL = init.InstallerURL ?? "";
    this.RelaxEngines = init.RelaxEngines ?? false;
    // 已捆绑的 CLI 随已发布镜像提供，沙箱永不安装它们。
    this.Bundled = init.Bundled ?? false;
  }
}

/**
 * 返回全部白名单 CLI 引擎到其安装规格的映射表。
 * 供可安装性检查、路径探测、版本元数据读取和按需安装流程调用。
 * @returns {Object<string, onDemandCLI>} 以引擎标识为键的规格映射对象。
 */
function onDemandCLICatalog() {
  return {
    codex: new onDemandCLI({ Engine: "codex", Binary: "codex", Package: "@openai/codex", Bundled: true }),
    codebuddy: new onDemandCLI({ Engine: "codebuddy", Binary: "codebuddy", Package: "@tencent-ai/codebuddy-code", Bundled: true }),
    "claude-code": new onDemandCLI({ Engine: "claude-code", Binary: "claude", Package: "@anthropic-ai/claude-code" }),
    opencode: new onDemandCLI({ Engine: "opencode", Binary: "opencode", Package: "opencode-ai" }),
    cursor: new onDemandCLI({ Engine: "cursor", Binary: cursorCLIBinary, InstallerURL: cursorInstallerURL }),
    agy: new onDemandCLI({ Engine: "agy", Binary: "agy", InstallerURL: agyInstallerURL }),
    kimi: new onDemandCLI({ Engine: "kimi", Binary: "kimi", Package: "@moonshot-ai/kimi-code" }),
    pi: new onDemandCLI({ Engine: "pi", Binary: "pi", Package: "@earendil-works/pi-coding-agent" }),
    dsh: new onDemandCLI({ Engine: "dsh", Binary: "dsh", Package: "@deepseek-ai/dsh@" + DeepSeekHarnessVersion, RelaxEngines: true, Bundled: true }),
  };
}

/**
 * 判断失败对话是否可以向用户提议按需安装指定引擎的 CLI。
 * 仅白名单内的聊天执行器返回 true，拒绝任意调用方传入的未知名称。
 * @param {string} engine - 引擎标识名。
 * @returns {boolean} 在白名单内返回 true，否则返回 false。
 */
function OnDemandInstallable(engine) {
  return onDemandCLICatalog()[engine] !== undefined;
}

/**
 * 查找指定引擎已安装在磁盘上的可执行文件路径，不触发任何下载。
 * 对 Cursor 会优先检查共享安装路径，其余按安装规格定位二进制并校验可执行权限。
 * @param {string} engine - 引擎标识名。
 * @returns {[string, boolean]} 找到可执行文件时返回 `[绝对路径, true]`，否则返回 `["", false]`。
 */
function OnDemandCLIPath(engine) {
  const spec = onDemandCLICatalog()[engine];
  if (spec === undefined) {
    return ["", false];
  }
  if (engine === AgentCLICursor) {
    const cursorPath = sharedCursorCLIPath();
    if (fileIsExecutable(cursorPath)) {
      return [cursorPath, true];
    }
  }
  const cliPath = onDemandBinary(spec);
  if (cliPath === "" || !fileIsExecutable(cliPath)) {
    return ["", false];
  }
  return [cliPath, true];
}

/**
 * 根据 CLI 安装规格计算其在磁盘上的预期可执行文件路径。
 * 脚本安装型 CLI 位于用户 `~/.local/bin`，npm 安装型位于 RuntimeCLIDir 下对应目录。
 * @param {onDemandCLI} spec - CLI 安装规格对象。
 * @returns {string} 预期二进制绝对路径；缺少主目录或安装根目录时返回空字符串。
 */
function onDemandBinary(spec) {
  if (spec.InstallerURL !== "") {
    let home = "";
    try {
      home = os.homedir();
    } catch {
      // 对应 Go：os.UserHomeDir 失败时返回空。
    }
    if (home.trim() === "") {
      return "";
    }
    return path.join(home, ".local", "bin", spec.Binary);
  }
  const root = RuntimeCLIDir();
  if (root === "") {
    return "";
  }
  if (spec.Engine === "claude-code") {
    return claudeCodeBinary(root);
  }
  return path.join(root, spec.Engine, "current", "node_modules", ".bin", spec.Binary);
}

/**
 * 按需安装一个白名单内的 CLI 并返回其可执行文件路径；若已安装则直接复用。
 * 根据引擎类型分别走 Claude Code 安装器、共享 Cursor 安装器、官方脚本安装器或 npm 安装器。
 * @param {AbortSignal} ctx - 取消信号。
 * @param {string} engine - 引擎标识名。
 * @returns {string} 安装完成或已存在的可执行文件绝对路径；不在白名单或安装失败时抛出 Error。
 */
function InstallOnDemandCLI(ctx, engine) {
  const spec = onDemandCLICatalog()[engine];
  if (spec === undefined) {
    throw new Error(`不能从对话安装 ${engine}`);
  }
  const [existingPath, ok] = OnDemandCLIPath(engine);
  if (ok) {
    return existingPath;
  }
  const label = onDemandCLILabel(spec.Engine);
  let cliPath;
  // Go 使用无条件 switch；JS 用等价的 if/else 链。
  if (spec.Engine === "claude-code") {
    try {
      cliPath = EnsureClaudeCode(ctx);
    } catch (err) {
      throw new Error(`安装 ${label} 失败：${err.message}`);
    }
  } else if (spec.Engine === AgentCLICursor && sharedCursorCLIPath() !== "") {
    try {
      cliPath = prepareSharedCursorCLI(ctx, true);
    } catch (err) {
      throw new Error(`安装 ${label} 失败：${err.message}`);
    }
  } else if (spec.InstallerURL !== "") {
    let home = "";
    try {
      home = os.homedir();
    } catch {
      // 对应 Go：os.UserHomeDir 失败时 home 为空。
    }
    if (home.trim() === "") {
      // 对应 Go：直接返回错误，不包装外层“安装 xxx 失败”。
      throw new Error("无法确定安装用户的主目录");
    }
    try {
      cliPath = installScriptCLI(ctx, spec, home);
    } catch (err) {
      throw new Error(`安装 ${label} 失败：${err.message}`);
    }
  } else {
    try {
      cliPath = installNPMCLI(ctx, spec);
    } catch (err) {
      throw new Error(`安装 ${label} 失败：${err.message}`);
    }
  }
  return cliPath;
}

/**
 * 返回引擎用于错误提示与版本匹配的人类可读展示名称。
 * 对内置执行器返回固定名称，其余委托给 AgentCLILabel。
 * @param {string} engine - 引擎标识名。
 * @returns {string} 引擎展示名称。
 */
function onDemandCLILabel(engine) {
  switch (engine) {
    case "codex":
      return "Codex";
    case "codebuddy":
      return "CodeBuddy";
    case "claude-code":
      return "Claude Code";
    default:
      return AgentCLILabel(engine);
  }
}

/**
 * 通过 npm 将指定规格的 CLI 安装到共享目录的暂存位置并原子激活。
 * 在 InstallOnDemandCLI 处理 npm 类型引擎时调用。
 * @param {AbortSignal} ctx - 取消信号。
 * @param {onDemandCLI} spec - CLI 安装规格对象。
 * @returns {string} 激活后的二进制绝对路径；缺少目录/npm 或安装失败时抛出 Error。
 */
function installNPMCLI(ctx, spec) {
  const signal = ctx instanceof AbortSignal ? ctx : undefined;
  const root = RuntimeCLIDir();
  if (root === "") {
    throw new Error("没有配置 CLI 安装目录");
  }
  if (lookPath("npm") === null) {
    throw new Error("服务器上没有 npm，无法安装");
  }
  const parent = path.join(root, spec.Engine);
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
  } catch (err) {
    throw new Error(`准备安装目录失败：${err.message}`);
  }
  let stage;
  try {
    stage = fs.mkdtempSync(path.join(parent, ".install-"));
  } catch (err) {
    throw new Error(`准备安装目录失败：${err.message}`);
  }
  try {
    fs.chmodSync(stage, 0o755);
    const cmd = spawnSync("npm", npmCLIInstallArgs(stage, spec), { cwd: stage, signal });
    // Go CombinedOutput 合并 stdout 与 stderr；这里将两者拼接。
    const out = Buffer.concat([cmd.stdout ?? Buffer.alloc(0), cmd.stderr ?? Buffer.alloc(0)]);
    if (cmd.error != null || cmd.status !== 0) {
      const err = cmd.error != null ? cmd.error : new Error(`exit status ${cmd.status}`);
      throw new Error(installCommandError(ctx, err, out));
    }
    return activateNPMStage(parent, stage, spec.Binary);
  } finally {
    // 对应 Go：defer os.RemoveAll(stage)。
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * 构造将 spec 安装到暂存目录 stage 所需的 `npm install` 参数数组。
 * 根据 `spec.RelaxEngines` 决定是否放宽 Node 引擎版本严格校验。
 * @param {string} stage - 临时安装暂存目录路径。
 * @param {onDemandCLI} spec - CLI 安装规格对象。
 * @returns {Array<string>} 传给 `npm` 的参数列表。
 */
function npmCLIInstallArgs(stage, spec) {
  const args = ["install", "--prefix", stage, "--no-audit", "--no-fund", "--omit=dev", "--save-exact"];
  if (spec.RelaxEngines) {
    args.push("--engine-strict=false");
  } else {
    args.push("--engine-strict");
  }
  args.push(spec.Package);
  return args;
}

/**
 * 校验暂存目录中生成的二进制文件，替换 `parent/current` 为 `stage`，并返回激活后的二进制路径。
 * 在 npm 安装命令成功退出后调用。
 * @param {string} parent - 引擎安装父目录路径。
 * @param {string} stage - 临时暂存目录路径。
 * @param {string} binary - 期望生成的可执行文件名。
 * @returns {string} 激活目录内可执行文件的绝对路径；校验、清理或重命名失败时抛出 Error。
 */
function activateNPMStage(parent, stage, binary) {
  const staged = path.join(stage, "node_modules", ".bin", binary);
  if (!fileIsExecutable(staged)) {
    throw new Error(`安装后没有找到可执行文件 ${binary}`);
  }
  const target = path.join(parent, "current");
  fs.rmSync(target, { recursive: true, force: true });
  try {
    fs.renameSync(stage, target);
  } catch (err) {
    throw new Error(`启用安装结果失败：${err.message}`);
  }
  return path.join(target, "node_modules", ".bin", binary);
}

/**
 * 下载并执行官方 HTTPS 安装脚本，将 CLI 安装到指定主目录的 `.local/bin` 下。
 * 在 InstallOnDemandCLI 处理脚本型引擎（如 Cursor、agy）时调用。
 * @param {AbortSignal} ctx - 取消信号。
 * @param {onDemandCLI} spec - CLI 安装规格对象。
 * @param {string} home - 目标用户主目录绝对路径。
 * @returns {string} 安装完成的可执行文件绝对路径；缺少 bash、执行失败或未生成二进制时抛出 Error。
 */
function installScriptCLI(ctx, spec, home) {
  const signal = ctx instanceof AbortSignal ? ctx : undefined;
  if (lookPath("bash") === null) {
    throw new Error("服务器上没有 bash，无法安装");
  }
  const env = upsertEnv(
    Object.entries(process.env).map(([key, value]) => key + "=" + value),
    "HOME",
    home,
  );
  const cmd = spawnSync("sh", ["-ec", scriptCLIInstaller(spec.InstallerURL)], {
    env: Object.fromEntries(
      env.map((e) => {
        const i = e.indexOf("=");
        return [e.slice(0, i), e.slice(i + 1)];
      }),
    ),
    signal,
  });
  // Go CombinedOutput 合并 stdout 与 stderr；这里将两者拼接。
  const out = Buffer.concat([cmd.stdout ?? Buffer.alloc(0), cmd.stderr ?? Buffer.alloc(0)]);
  if (cmd.error != null || cmd.status !== 0) {
    const err = cmd.error != null ? cmd.error : new Error(`exit status ${cmd.status}`);
    throw new Error(installCommandError(ctx, err, out));
  }
  const cliPath = path.join(home, ".local", "bin", spec.Binary);
  if (!fileIsExecutable(cliPath)) {
    throw new Error(`安装后没有找到可执行文件 ${spec.Binary}`);
  }
  return cliPath;
}

/**
 * 生成“先完整下载 HTTPS 安装脚本（失败重试一次）再通过 bash 执行”的 shell 脚本片段。
 * 避免管道流式执行中途因瞬时 TLS 抖动而只跑了一半。
 * @param {string} url - 官方安装脚本的 HTTPS URL。
 * @returns {string} 可传给 `sh -ec` 的完整 shell 脚本字符串。
 */
function scriptCLIInstaller(url) {
  return (
    "installer_url=" +
    shellSingleQuote(url) +
    "\n" +
    `installer_file=$(mktemp)
trap 'rm -f "$installer_file"' EXIT
download_installer() {
  curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 45 -o "$installer_file" "$installer_url"
}
if ! download_installer; then
  sleep 1
  download_installer
fi
bash -o pipefail "$installer_file" >&2`
  );
}

/**
 * 将失败的安装子进程错误与输出整理为简短、面向用户的错误说明（最长 180 字符）。
 * 当上下文已取消或超时时统一返回“安装超时或已取消”。
 * @param {AbortSignal} ctx - 取消信号。
 * @param {Error} err - 子进程执行错误对象。
 * @param {Buffer|string} out - 子进程合并输出内容。
 * @returns {string} 格式化后的错误消息文本。
 */
function installCommandError(ctx, err, out) {
  // 对应 Go：errors.Is(err, context.DeadlineExceeded/Canceled)；JS 中子进程被取消时 error.name 为 AbortError。
  if ((ctx instanceof AbortSignal && ctx.aborted) || (err != null && err.name === "AbortError")) {
    return "安装超时或已取消";
  }
  let text = tailOutput(out)
    .split(/\s+/)
    .filter((field) => field !== "")
    .join(" ");
  if (text === "") {
    text = err.message;
  }
  // Go 按字节截断，JS 按 UTF-16 码元截断。
  if (text.length > 180) {
    text = text.slice(0, 180) + "…";
  }
  return text;
}

module.exports = {
  DeepSeekHarnessVersion,
  OnDemandInstallable,
  OnDemandCLIPath,
  InstallOnDemandCLI,
  onDemandCLICatalog,
  onDemandCLI,
  onDemandBinary,
  onDemandCLILabel,
  installNPMCLI,
  npmCLIInstallArgs,
  activateNPMStage,
  installScriptCLI,
  scriptCLIInstaller,
  installCommandError,
  lookPath,
};
