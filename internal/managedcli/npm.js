// npm.js —— 对应 Go 文件：internal/managedcli/npm.go
// 作用：在隔离环境中执行更新器外部命令、准备 node/npm 工具链、安装并暂存 CLI 候选版本、
// 校验 package-lock.json 完整性以及执行版本与必备参数兼容性探测。
// 职责边界：负责本地安装与探测流程，不负责从远端 registry 拉取元数据或协调全局锁。
// 语法差异说明：
// - Go 的 os/exec.LookPath 译为按 PATH 目录顺序查找可执行普通文件；
// - Go 的 context.Context 译为 AbortSignal，context.WithTimeout 译为 AbortSignal.any + AbortSignal.timeout；
// - Go 的 (值, error) 多返回值译为成功直接 return、失败 throw Error；
// - Go 的 defer 清理逻辑译为 try/finally；
// - Go 同包挂在 *Manager 上的方法挂载在 Manager.prototype 上。

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { Manager } = require("./updater.js");
const { Installation, validateInventory, within, prepareDirectory } = require("./manifest.js");
const { providerSpecs, releaseVersion, npmRegistry, commandTimeout } = require("./providers.js");
const { emptyNPMConfig } = require("./npm_config.js");

// CommandRunner 在测试中可替换：测试不得安装真实 CLI 或消耗模型凭证；生产环境始终以 argv 数组执行而非 shell。
// 对应 Go 类型：type CommandRunner func(context.Context, string, []string, string, []string) ([]byte, error)

/**
 * 在更新器超时与隔离环境变量约束下执行一条外部命令。
 * 在探测 Node 版本、执行 npm install/rebuild 以及验证候选 CLI 版本与参数时调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {string} name 可执行文件路径或命令名。
 * @param {string[]} args 命令行参数数组。
 * @param {string} dir 子进程工作目录。
 * @returns {Promise<Buffer>} 命令的标准输出与标准错误合并缓冲区；超时、取消或命令失败时抛出错误。
 */
Manager.prototype.command = async function (ctx, name, args, dir) {
  const signals = [];
  if (ctx instanceof AbortSignal) {
    signals.push(ctx);
  }
  signals.push(AbortSignal.timeout(commandTimeout));
  const derived = AbortSignal.any(signals); // 对应 Go：context.WithTimeout(ctx, commandTimeout)
  const env = this.commandEnvironment();
  let out;
  try {
    out = await this.RunCommand(derived, name, args, dir, env);
  } catch (err) {
    if (derived.aborted) {
      throw new Error(`CLI command timeout/cancellation: ${derived.reason}`);
    }
    throw err;
  }
  if (derived.aborted) {
    throw new Error(`CLI command timeout/cancellation: ${derived.reason}`);
  }
  return out;
};

/**
 * 构造更新器执行外部命令时的白名单隔离环境变量数组。
 * 在 command 执行子进程前调用，确保不透传平台令牌、模型 API Key、NODE_OPTIONS 或宿主机 npm 配置。
 *
 * @returns {string[]} 形如 "KEY=VALUE" 的环境变量字符串数组。
 */
Manager.prototype.commandEnvironment = function () {
  // 显式白名单：禁止透传平台启动令牌、供应商 API Key、任务凭证、NODE_OPTIONS 或外部注入的 npm 配置。
  const env = [];
  for (const key of ["PATH", "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
    if (key !== "PATH" && process.env[key] !== undefined) {
      env.push(key + "=" + process.env[key]);
    }
  }
  let pathValue = process.env.PATH ?? "";
  if (pathValue === "") {
    pathValue = "/usr/local/bin:/usr/bin:/bin";
  }
  if (this.nodeBinary !== "") {
    pathValue = path.dirname(this.nodeBinary) + path.delimiter + pathValue;
  }
  const home = path.join(this.Root, "updater-home");
  env.push(
    "PATH=" + pathValue, "HOME=" + home, "TMPDIR=" + path.join(this.Root, "tmp"),
    "CODEX_HOME=" + path.join(home, ".codex"), "CLAUDE_CONFIG_DIR=" + path.join(home, ".claude"), "CODEBUDDY_CONFIG_DIR=" + path.join(home, ".codebuddy"),
    "DISABLE_AUTOUPDATER=1", "DISABLE_UPDATES=1", "OPENCODE_DISABLE_AUTOUPDATE=1", "KIMI_CODE_NO_AUTO_UPDATE=1",
    "CI=1", "NO_COLOR=1",
    "NPM_CONFIG_USERCONFIG=" + path.join(home, "npmrc-user"), "NPM_CONFIG_GLOBALCONFIG=" + path.join(home, "npmrc-global"),
    "NPM_CONFIG_CACHE=" + path.join(this.Root, "npm-cache"),
  );
  return env;
};

/**
 * 创建更新器运行所需的私有子目录与空白 npm 配置文件。
 * 在执行供应商直供包安装、回滚验证或 prepareTools 初始化前调用。
 *
 * @returns {void} 无返回值；目录或配置文件准备失败时抛出错误。
 */
Manager.prototype.prepareCommandDirectories = function () {
  for (const rel of ["updater-home", "tmp", "npm-cache", "providers"]) {
    prepareDirectory(this.Root, rel);
  }
  for (const name of ["npmrc-user", "npmrc-global"]) {
    emptyNPMConfig(path.join(this.Root, "updater-home", name));
  }
};

/**
 * 准备更新器命令目录，定位 node 与 npm 可执行文件，并校验 Node.js 主版本号不低于 22。
 * 在更新或回滚基于 npm 的 CLI 供应商前调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @returns {Promise<void>} 无返回值；缺少 node/npm 或 Node 版本不满足要求时抛出错误。
 */
Manager.prototype.prepareTools = async function (ctx) {
  this.prepareCommandDirectories();
  for (const [name, field] of [["node", "nodeBinary"], ["npm", "npmBinary"]]) {
    if (this[field] === "") {
      const found = lookPath(name);
      if (found == null) {
        throw new Error(`managed CLI updater requires ${name}: not found in PATH`);
      }
      this[field] = path.resolve(found);
    }
  }
  const out = await this.command(ctx, this.nodeBinary, ["--version"], this.Root);
  const version = out.toString("utf8").trim().replace(/^v/, "");
  if (!releaseVersion.test(version)) {
    throw new Error("cannot identify Node.js version");
  }
  const major = parseInt(version.split(".")[0], 10);
  if (major < 22) {
    throw new Error("managed CLI updater requires Node.js 22 or newer");
  }
};

/**
 * 按当前进程 PATH 环境变量顺序查找指定名称的可执行普通文件，对应 Go 的 exec.LookPath。
 * 在 prepareTools 定位宿主机的 node 与 npm 路径时调用。
 *
 * @param {string} name 可执行文件名称。
 * @returns {string|null} 找到时返回匹配路径，未找到返回 null。
 */
function lookPath(name) {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (dir === "") {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      const info = fs.statSync(candidate);
      if (info.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // 当前目录未命中可执行普通文件，继续检查下一项。
    }
  }
  return null;
}

/**
 * 在临时暂存目录中安装候选版本，经清单校验后原子重命名为不可变的最终安装目录。
 * 在 stageCandidate 发现本地尚无匹配的缓存安装时调用；异常时仅清理本次新建的 .staging-* 目录。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {string} provider 供应商名称。
 * @param {object} candidate 候选版本发布对象（release 实例）。
 * @returns {Promise<Installation>} 安装完成后的 Installation 记录；安装或校验失败时抛出错误。
 */
Manager.prototype.install = async function (ctx, provider, candidate) {
  const spec = providerSpecs[provider];
  prepareDirectory(this.Root, path.join("providers", provider));
  const base = path.join(this.Root, "providers", provider);
  const stage = fs.mkdtempSync(path.join(base, ".staging-"));
  // 仅允许清理本次新建的暂存目录，绝不覆盖或删除已激活的历史安装目录。
  try {
    let executable;
    if (candidate.Artifact != null) {
      executable = spec.Binary;
      await this.installVendorArtifact(ctx, provider, candidate, stage);
    } else {
      executable = path.join("node_modules", ".bin", spec.Binary);
      await this.installPackage(ctx, provider, spec, candidate, stage);
    }
    const staged = new Installation({ Version: candidate.Version, Binary: path.join(stage, executable) });
    validateInventory(this.Root, { [provider]: staged });
    // 重命名为全局唯一的完整安装目录，绝不复用已有目标路径。
    const final = path.join(base, candidate.Version + "-" + path.basename(stage).replace(/^\.staging-/, ""));
    let finalInfo;
    try {
      finalInfo = fs.lstatSync(final);
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw new Error("candidate installation target already exists or is inaccessible");
      }
    }
    if (finalInfo != null) {
      throw new Error("candidate installation target already exists or is inaccessible");
    }
    fs.renameSync(stage, final);
    const installed = new Installation({
      Version: candidate.Version,
      Binary: path.join(final, executable),
      Integrity: candidate.identity(),
      InstalledAt: this.Now(),
    });
    if (provider === "cursor") {
      installed.PublishedAt = candidate.Published;
    }
    validateInventory(this.Root, { [provider]: installed });
    return installed;
  } finally {
    if (within(base, stage) && path.dirname(stage) === base && path.basename(stage).startsWith(".staging-")) {
      let info;
      try {
        info = fs.lstatSync(stage);
      } catch {
        info = null;
      }
      if (info != null && info.isDirectory() && !info.isSymbolicLink()) {
        try {
          fs.rmSync(stage, { recursive: true, force: true });
        } catch {
          // 对应 Go 的 _ = os.RemoveAll(stage)，忽略清理阶段错误。
        }
      }
    }
  }
};

/**
 * 在暂存目录中通过 npm install（先禁脚本）与 npm rebuild 安装指定版本的 CLI 包，并两次校验锁文件。
 * 在 install 处理非供应商直供的 npm 包时调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {string} provider 供应商名称。
 * @param {object} spec 供应商规格对象（providerSpec 实例）。
 * @param {object} candidate 候选版本发布对象（release 实例）。
 * @param {string} stage 暂存目录的绝对路径。
 * @returns {Promise<void>} 无返回值；安装、构建或锁文件校验失败时抛出错误。
 */
Manager.prototype.installPackage = async function (ctx, provider, spec, candidate, stage) {
  fs.writeFileSync(path.join(stage, "package.json"), "{\"private\":true}\n", { mode: 0o600 });
  let engines = "--engine-strict";
  if (spec.RelaxEngines) {
    engines = "--engine-strict=false";
  }
  const args = ["install", "--prefix", stage, "--registry", npmRegistry, "--no-audit", "--no-fund", engines, "--ignore-scripts", "--include=optional", "--save-exact", spec.Package + "@" + candidate.Version];
  try {
    await this.command(ctx, this.npmBinary, args, stage);
  } catch (err) {
    throw new Error(`install ${provider}: ${err.message}`);
  }
  verifyPackageLock(stage, spec.Package, candidate);
  // 部分原生可选依赖需要生命周期脚本；先在 --ignore-scripts 下完成下载与 SRI 校验后再执行 rebuild。
  const rebuild = ["rebuild", "--prefix", stage, "--registry", npmRegistry, "--no-audit", "--no-fund"];
  try {
    await this.command(ctx, this.npmBinary, rebuild, stage);
  } catch (err) {
    throw new Error(`build verified CLI dependencies: ${err.message}`);
  }
  verifyPackageLock(stage, spec.Package, candidate);
};

/**
 * 校验暂存目录中生成的 package-lock.json 是否存在、大小合法，且目标包版本与 SHA512 完整性摘要与候选版本一致。
 * 在 installPackage 的 npm install 与 npm rebuild 后各调用一次。
 *
 * @param {string} dir 暂存安装目录路径。
 * @param {string} packageName npm 包名。
 * @param {object} candidate 候选版本发布对象（release 实例）。
 * @returns {void} 无返回值；锁文件缺失、超限、解析失败或版本/完整性不匹配时抛出错误。
 */
function verifyPackageLock(dir, packageName, candidate) {
  // 锁文件可能大于常规控制清单的 1 MiB 上限，此处允许最大 16 MiB。
  const lockPath = path.join(dir, "package-lock.json");
  let info;
  try {
    info = fs.lstatSync(lockPath);
  } catch {
    throw new Error("missing or invalid installed npm lockfile");
  }
  if (!info.isFile() || info.size > 16 << 20) {
    throw new Error("missing or invalid installed npm lockfile");
  }
  const data = fs.readFileSync(lockPath);
  const lock = JSON.parse(data.toString("utf8"));
  const actual = lock?.packages?.["node_modules/" + packageName];
  if (actual == null || actual.version !== candidate.Version || actual.integrity !== candidate.Dist.Integrity) {
    throw new Error("installed npm package does not match the verified version/integrity");
  }
}

const outputVersion = /(?:^|[^0-9.])([0-9]+\.[0-9]+\.[0-9]+(?:-(?:rc\.[0-9]+|[a-f0-9]{7,40}))?)(?:$|[^0-9.A-Za-z+-])/;

/**
 * 对已安装的候选或回滚 CLI 执行冒烟校验：校验路径归属、执行 --version 核对版本号并检查帮助输出中的必备参数。
 * 在 stageCandidate 与 rollbackLocked 激活版本前调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {string} provider 供应商名称。
 * @param {Installation} installed 待验证的安装记录。
 * @returns {Promise<void>} 无返回值；任一项校验不通过时抛出错误。
 */
Manager.prototype.validate = async function (ctx, provider, installed) {
  validateInventory(this.Root, { [provider]: installed });
  let out;
  try {
    out = await this.command(ctx, installed.Binary, ["--version"], this.Root);
  } catch (err) {
    throw new Error(`version probe: ${err.message}`);
  }
  const match = outputVersion.exec(out.toString("utf8").trim());
  if (match == null || match.length !== 2 || match[1] !== installed.Version) {
    throw new Error("candidate executable reports an unexpected version");
  }
  const spec = providerSpecs[provider];
  try {
    out = await this.command(ctx, installed.Binary, spec.Help, this.Root);
  } catch (err) {
    throw new Error(`argument compatibility probe: ${err.message}`);
  }
  const helpText = out.toString("utf8");
  for (const flag of spec.Flags) {
    const pattern = new RegExp(escapeRegExp(flag) + `(?:[\\s,=<\\[\\]]|$)`);
    if (!pattern.test(helpText)) {
      if (provider === "claude-code" && flag === "--system-prompt-file") {
        await this.validateClaudeHiddenFileArgument(ctx, installed);
        continue;
      }
      throw new Error(`candidate CLI does not advertise required argument ${flag}`);
    }
  }
};

/**
 * 转义字符串中的正则表达式元字符，对应 Go 的 regexp.QuoteMeta。
 * 在 validate 按必备参数名构造匹配正则时调用。
 *
 * @param {string} s 待转义的原始文本。
 * @returns {string} 转义后的正则字面量字符串。
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { outputVersion, verifyPackageLock, lookPath };
