// cli_ondemand.js —— 对应 Go 文件：internal/runtime/cli_ondemand.go
// 作用：对话失败后可按需安装的 CLI 清单与安装入口（npm 包或官方安装脚本）。
// Go 的 os/exec 译为 child_process.spawnSync；context.Context 译为 AbortSignal；
// (值, error) 译为成功返回值、失败 throw；(值, bool) 译为 [值, bool]；
// sync.Mutex 省略，JS 单线程无需加锁。

"use strict";

const fs = require("node:fs"); // Go os
const os = require("node:os"); // Go os
const path = require("node:path"); // Go path/filepath
const { spawnSync } = require("node:child_process"); // Go os/exec

const { RuntimeCLIDir, claudeCodeBinary, EnsureClaudeCode, fileIsExecutable } = require("./claude_install.js"); // 对应 Go 同包函数，claude_install.js 已翻译
const { cursorCLIBinary, sharedCursorCLIPath, prepareSharedCursorCLI } = require("./cursor_install.js"); // 对应 Go 同包常量与函数，cursor_install.js 待翻译
const { AgentCLICursor, AgentCLILabel } = require("./agent_cli.js"); // 对应 Go 同包常量与函数，agent_cli.js 待翻译
const { shellSingleQuote } = require("./sandbox_environment.js"); // 对应 Go 同包函数，sandbox_environment.js 待翻译
const { upsertEnv } = require("./command_binding.js"); // 对应 Go 同包函数，command_binding.js 已翻译
const { tailOutput } = require("./browser.js"); // 对应 Go 同包函数，browser.js 待翻译

// 已发布平台镜像不保证提供这些 CLI。Codex、CodeBuddy 与 DeepSeek Harness 烘焙在镜像里；
// 其余只在有人从失败对话中要求后才安装。包名与安装地址固定：请求只能选引擎，不能选 URL 或包。
const cursorInstallerURL = "https://cursor.com/install";
const agyInstallerURL = "https://antigravity.google/cli/install.sh";

// DeepSeekHarnessVersion：Dockerfile 捆绑、无则下载的 dsh 版本。必须显式命名：
// 每个 dsh 版本都是预发布版，要求比镜像自带的更新的 Node，裸包名解析不到任何版本。
const DeepSeekHarnessVersion = "0.2.2-rc.1";

class onDemandCLI {
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

// OnDemandInstallable：失败对话是否可提议安装该 CLI。集合是聊天执行器，不是调用方提供的名字。
function OnDemandInstallable(engine) {
  return onDemandCLICatalog()[engine] !== undefined;
}

// OnDemandCLIPath：返回已安装在磁盘上的 engine 可执行文件（若有）。不下载任何东西。
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

function onDemandBinary(spec) {
  if (spec.InstallerURL !== "") {
    let home = "";
    try {
      home = os.homedir();
    } catch {
      // Go：os.UserHomeDir 失败时返回空。
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

// InstallOnDemandCLI：安装一个白名单内的 CLI 并返回其可执行文件路径。第二次调用复用第一次的安装。
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
  // Go 是 switch { case 条件: }；JS 用等价的 if/else 链。
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
      // Go：os.UserHomeDir 失败时 home 为空。
    }
    if (home.trim() === "") {
      // Go：这里直接返回，不包安装失败的外层错误。
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
    // Go CombinedOutput 合并 stdout 与 stderr；这里把两者拼接。
    const out = Buffer.concat([cmd.stdout ?? Buffer.alloc(0), cmd.stderr ?? Buffer.alloc(0)]);
    if (cmd.error != null || cmd.status !== 0) {
      const err = cmd.error != null ? cmd.error : new Error(`exit status ${cmd.status}`);
      throw new Error(installCommandError(ctx, err, out));
    }
    return activateNPMStage(parent, stage, spec.Binary);
  } finally {
    // Go：defer os.RemoveAll(stage)。
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// npmCLIInstallArgs：构造把 spec 装进 stage 的 npm install 参数。
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

// activateNPMStage：校验暂存的二进制文件，把 parent/current 换成 stage，返回激活目录内的二进制路径。
function activateNPMStage(parent, stage, binary) {
  const staged = path.join(stage, "node_modules", ".bin", binary);
  if (!fileIsExecutable(staged)) {
    throw new Error(`安装后没有找到可执行文件 ${binary}`);
  }
  const target = path.join(parent, "current");
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    throw err;
  }
  try {
    fs.renameSync(stage, target);
  } catch (err) {
    throw new Error(`启用安装结果失败：${err.message}`);
  }
  return path.join(target, "node_modules", ".bin", binary);
}

function installScriptCLI(ctx, spec, home) {
  const signal = ctx instanceof AbortSignal ? ctx : undefined;
  if (lookPath("bash") === null) {
    throw new Error("服务器上没有 bash，无法安装");
  }
  const env = upsertEnv(Object.entries(process.env).map(([key, value]) => key + "=" + value), "HOME", home);
  const cmd = spawnSync("sh", ["-ec", scriptCLIInstaller(spec.InstallerURL)], {
    env: Object.fromEntries(env.map((e) => {
      const i = e.indexOf("=");
      return [e.slice(0, i), e.slice(i + 1)];
    })),
    signal,
  });
  // Go CombinedOutput 合并 stdout 与 stderr；这里把两者拼接。
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

// 先下载完整的 HTTPS 安装器再执行。重试一次传输，因为 TLS 连接失败可能是暂时的。
function scriptCLIInstaller(url) {
  return "installer_url=" + shellSingleQuote(url) + "\n" + `installer_file=$(mktemp)
trap 'rm -f "$installer_file"' EXIT
download_installer() {
  curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 45 -o "$installer_file" "$installer_url"
}
if ! download_installer; then
  sleep 1
  download_installer
fi
bash -o pipefail "$installer_file" >&2`;
}

function installCommandError(ctx, err, out) {
  // Go：errors.Is(err, context.DeadlineExceeded/Canceled)；JS 里 spawn 被取消时 error 的 name 是 AbortError。
  if ((ctx instanceof AbortSignal && ctx.aborted) || (err != null && err.name === "AbortError")) {
    return "安装超时或已取消";
  }
  let text = tailOutput(out).split(/\s+/).filter((field) => field !== "").join(" ");
  if (text === "") {
    text = err.message;
  }
  // Go 按字节截断，JS 按 UTF-16 码元截断。
  if (text.length > 180) {
    text = text.slice(0, 180) + "…";
  }
  return text;
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

module.exports = { DeepSeekHarnessVersion, OnDemandInstallable, OnDemandCLIPath, InstallOnDemandCLI, onDemandCLICatalog, onDemandCLI, onDemandBinary, onDemandCLILabel, installNPMCLI, npmCLIInstallArgs, activateNPMStage, installScriptCLI, scriptCLIInstaller, installCommandError, lookPath };
