// npm.js —— 对应 Go 文件：internal/managedcli/npm.go
// 作用：用隔离环境跑 npm 装包、验锁文件、探版本与必备参数。
// Go 的 os/exec.LookPath 译为按 PATH 逐个找可执行文件；
// context.Context 译为 AbortSignal；(值, error) 译为成功返回值、失败 throw。

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { Manager } = require("./updater.js"); // 对应 Go 同包类型，updater.js 已翻译
const { Installation, validateInventory, within, prepareDirectory } = require("./manifest.js"); // 对应 Go 同包函数，manifest.js 已翻译
const { providerSpecs, releaseVersion, npmRegistry, commandTimeout } = require("./providers.js"); // 对应 Go 同包常量与函数，providers.js 已翻译
const { emptyNPMConfig } = require("./npm_config.js"); // 对应 Go 同包函数，npm_config.js 已翻译

// CommandRunner is replaceable in tests: tests must never install real CLIs or
// consume model credentials. Production always executes an argv, never a shell.
// JS 里的 CommandRunner 是 (ctx, name, args, dir, env) => Promise<Buffer> 的函数。
// type CommandRunner func(context.Context, string, []string, string, []string) ([]byte, error)

Manager.prototype.command = async function (ctx, name, args, dir) {
  const signals = [];
  if (ctx instanceof AbortSignal) {
    signals.push(ctx);
  }
  signals.push(AbortSignal.timeout(commandTimeout));
  const derived = AbortSignal.any(signals); // Go：context.WithTimeout(ctx, commandTimeout)
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

Manager.prototype.commandEnvironment = function () {
  // Explicit allowlist: no platform bootstrap tokens, provider API keys,
  // task credentials, NODE_OPTIONS or shell-injected npm configuration.
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

Manager.prototype.prepareCommandDirectories = function () {
  for (const rel of ["updater-home", "tmp", "npm-cache", "providers"]) {
    prepareDirectory(this.Root, rel);
  }
  for (const name of ["npmrc-user", "npmrc-global"]) {
    emptyNPMConfig(path.join(this.Root, "updater-home", name));
  }
};

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

Manager.prototype.install = async function (ctx, provider, candidate) {
  const spec = providerSpecs[provider];
  prepareDirectory(this.Root, path.join("providers", provider));
  const base = path.join(this.Root, "providers", provider);
  const stage = fs.mkdtempSync(path.join(base, ".staging-"));
  // Only a freshly-created staging directory may be removed. Activated
  // versions are never overwritten/deleted, even if no local task uses them.
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
    // Rename a unique complete directory, never an existing installation.
    // Executable links and launchers are relative to the installation.
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
        fs.rmSync(stage, { recursive: true, force: true });
      }
    }
  }
};

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
  // Some native optional dependencies need lifecycle hooks. Defer them until
  // npm has fetched the exact candidate and its SRI has been checked. Commands
  // use the updater's isolated home and credential-free environment; they run
  // with the worker's OS permissions, not in a separate security sandbox.
  const rebuild = ["rebuild", "--prefix", stage, "--registry", npmRegistry, "--no-audit", "--no-fund"];
  try {
    await this.command(ctx, this.npmBinary, rebuild, stage);
  } catch (err) {
    throw new Error(`build verified CLI dependencies: ${err.message}`);
  }
  verifyPackageLock(stage, spec.Package, candidate);
};

function verifyPackageLock(dir, packageName, candidate) {
  // Lockfiles can exceed the small control-manifest limit.
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
  let lock;
  try {
    lock = JSON.parse(data.toString("utf8"));
  } catch (err) {
    throw err;
  }
  const actual = lock.packages?.["node_modules/" + packageName];
  if (actual == null || actual.version !== candidate.Version || actual.integrity !== candidate.Dist.Integrity) {
    throw new Error("installed npm package does not match the verified version/integrity");
  }
}

const outputVersion = /(?:^|[^0-9.])([0-9]+\.[0-9]+\.[0-9]+(?:-(?:rc\.[0-9]+|[a-f0-9]{7,40}))?)(?:$|[^0-9.A-Za-z+-])/;

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
  for (const flag of spec.Flags) {
    const pattern = new RegExp(escapeRegExp(flag) + `(?:[\\s,=<\\[\\]]|$)`);
    if (!pattern.test(out.toString("utf8"))) {
      if (provider === "claude-code" && flag === "--system-prompt-file") {
        await this.validateClaudeHiddenFileArgument(ctx, installed);
        continue;
      }
      throw new Error(`candidate CLI does not advertise required argument ${flag}`);
    }
  }
};

// escapeRegExp：Go 的 regexp.QuoteMeta。
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { outputVersion, verifyPackageLock, lookPath };
