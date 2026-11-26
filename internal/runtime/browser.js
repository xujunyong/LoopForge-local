// browser.js —— 对应 Go 文件：internal/runtime/browser.go
// 作用：运行级 Agent 浏览器：Docker 边车与宿主 Chromium 的准备、发现与回收。
// context.Context 译为 AbortSignal；(值, error) 译为成功返回值、失败 throw，(值, bool) 译为 [值, bool]；
// sync.Mutex/sync.Once 在单线程 JS 里不需要，略去；goroutine 译为不 await 的异步函数；
// exec.Cmd.CombinedOutput/Output/Run 译为 execCombinedOutput/execRun；
// embed.FS 没有 JS 对应写法，browser_assets 改为从文件同级 browser_assets 目录读盘；
// testing.Testing() 没有 JS 对应写法，译为 process.env.NODE_ENV === "test"；
// syscall.Kill 译为 process.kill；os.Geteuid 译为 process.geteuid。

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const { MCPServerDefinition } = require("../domain/assets.js"); // 对应 Go 的 domain.MCPServerDefinition，assets.js 已翻译
const { TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TelemetryEvent，run.js 已翻译
const { providerForKind } = require("./provider.js"); // 对应 Go 同包的 providerForKind，provider.js 待翻译
const { mockProvider } = require("./provider_mock.js"); // 对应 Go 同包的 mockProvider，provider_mock.js 待翻译
const { dialDockerCDP, dialWebSocketCDP } = require("./browser_cdp.js"); // 对应 Go 同包的 dialDockerCDP/dialWebSocketCDP，browser_cdp.js 已翻译
// 与 sandbox_docker.js/sandbox_local.js/sandbox_process.js 循环引用，整模块引用、调用时再取属性，避免加载时解构到未完成导出的值。
const sandboxDocker = require("./sandbox_docker.js"); // 对应 Go 同包，sandbox_docker.js 待翻译
const sandboxLocal = require("./sandbox_local.js"); // 对应 Go 同包，sandbox_local.js 待翻译
const sandboxProcess = require("./sandbox_process.js"); // 对应 Go 同包，sandbox_process.js 待翻译

// browserAssetsDir：Go 用 //go:embed 内嵌 browser_assets，JS 改为读同级目录。
const browserAssetsDir = path.join(__dirname, "browser_assets");

// execCombinedOutput：跑一条命令并收集合并输出，对应 Go 的 exec.Cmd.CombinedOutput；返回 [输出, 错误]。
async function execCombinedOutput(ctx, name, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(name, args, { signal: ctx instanceof AbortSignal ? ctx : undefined });
    } catch (err) {
      resolve([Buffer.alloc(0), err]);
      return;
    }
    const chunks = [];
    if (child.stdout != null) {
      child.stdout.on("data", (chunk) => chunks.push(chunk));
    }
    if (child.stderr != null) {
      child.stderr.on("data", (chunk) => chunks.push(chunk));
    }
    child.on("error", (err) => resolve([Buffer.concat(chunks), err]));
    child.on("close", (code, signal) => {
      const output = Buffer.concat(chunks);
      if (signal != null) {
        resolve([output, new Error(`signal: ${signal}`)]);
      } else if (code !== 0) {
        resolve([output, new Error(`exit status ${code}`)]);
      } else {
        resolve([output, null]);
      }
    });
  });
}

// execRun：只关心成败，对应 Go 的 exec.Cmd.Run。
async function execRun(ctx, name, args) {
  const [, err] = await execCombinedOutput(ctx, name, args);
  return err;
}

// sleepOrAbort：等满毫秒或等到 ctx 取消，对应 Go 的 time.NewTimer + select。
function sleepOrAbort(ctx, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = () => {
      if (ctx instanceof AbortSignal) {
        ctx.removeEventListener("abort", onAbort);
      }
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
  });
}

// withTimeout：给 ctx 加一个超时，返回 [信号, 取消函数]，对应 Go 的 context.WithTimeout。
function withTimeout(ctx, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), ms);
  if (ctx instanceof AbortSignal) {
    if (ctx.aborted) {
      controller.abort(ctx.reason);
    } else {
      ctx.addEventListener("abort", () => controller.abort(ctx.reason), { once: true });
    }
  }
  return [controller.signal, () => clearTimeout(timer)];
}

// lookPath：在 PATH 里找可执行文件，对应 Go 的 exec.LookPath；找不到返回 ""。
function lookPath(name) {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir === "" ? "." : dir, name);
    try {
      const info = fs.statSync(candidate);
      if (!info.isDirectory()) {
        return candidate;
      }
    } catch {}
  }
  return "";
}

// globOne：按带 * 的路径模式展开，对应 Go 的 filepath.Glob。
function globOne(pattern) {
  let results = pattern.startsWith(path.sep) ? [path.sep] : [""];
  for (const seg of pattern.split(path.sep)) {
    if (seg === "") {
      continue;
    }
    const next = [];
    for (const base of results) {
      if (!seg.includes("*")) {
        next.push(path.join(base, seg));
      } else {
        const re = new RegExp("^" + seg.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
        let entries;
        try {
          entries = fs.readdirSync(base === "" ? "." : base);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (re.test(entry)) {
            next.push(path.join(base, entry));
          }
        }
      }
    }
    results = next;
  }
  return results;
}

// walkBrowserAssets：按字典序走 browser_assets 目录，对应 Go 的 fs.WalkDir。
function walkBrowserAssets(visit) {
  const walk = (dir, prefix) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = prefix + entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel + "/");
      } else {
        visit(rel, fs.readFileSync(full));
      }
    }
  };
  walk(browserAssetsDir, "browser_assets/");
}

// readBrowserAsset：读一个内嵌资源文件，对应 Go 的 browserAssets.ReadFile。
function readBrowserAsset(name) {
  return fs.readFileSync(path.join(browserAssetsDir, name));
}

const BrowserMCPServerID = "agentflow-browser";
const playwrightMCPPackage = "@playwright/mcp@0.0.83";
const browserMCPPort = 8931;
const browserRunLabel = "agentflow.browser.run";
const browserOwnerLabel = "agentflow.browser.owner";

// BrowserEnabled：AGENTFLOW_BROWSER=off 时关掉按运行分配的 Agent 浏览器，默认开启。
function BrowserEnabled() {
  switch ((process.env.AGENTFLOW_BROWSER ?? "").trim().toLowerCase()) {
    case "off":
    case "0":
    case "false":
    case "no":
      return false;
    default:
      return true;
  }
}

// BrowserWantedForExecutor：进程内 mock 与 go test 下不配浏览器，除非 AGENTFLOW_BROWSER=always 强制开启。
function BrowserWantedForExecutor(kind) {
  if (!BrowserEnabled()) {
    return false;
  }
  if (providerForKind(kind) instanceof mockProvider || process.env.NODE_ENV === "test") {
    return (process.env.AGENTFLOW_BROWSER ?? "").trim().toLowerCase() === "always";
  }
  return true;
}

class browserEndpoint {
  constructor(init = {}) {
    this.Kind = init.Kind ?? "";
    this.Container = init.Container ?? "";
    this.WebSocket = init.WebSocket ?? "";
    // Workspace 是宿主浏览器用 file:// 服务的宿主目录。
    this.Workspace = init.Workspace ?? "";
  }
}

browserEndpoint.prototype.dial = async function (ctx) {
  if (this.Kind === "docker") {
    return dialDockerCDP(ctx, this.Container);
  }
  return dialWebSocketCDP(ctx, this.WebSocket);
};

// BrowserRunning：本机是否已有该运行的浏览器。
async function BrowserRunning(ctx, runID) {
  const [, ok] = await lookupBrowserEndpoint(ctx, runID);
  return ok;
}

// EnsureSandboxBrowser：给一次调用配好运行浏览器，返回 Agent 驱动它用的 MCP 服务器。
// docker 沙箱配一个共享其网络命名空间的边车；宿主驱动配一个宿主 Chromium。
// 失败只告警：节点没有浏览器也能跑。
async function EnsureSandboxBrowser(ctx, sb, workspace, runID, sink) {
  if (!BrowserEnabled() || runID.trim() === "") {
    return null;
  }
  let server;
  let err = null;
  const inner = unwrapSandbox(sb);
  try {
    if (inner instanceof sandboxDocker.dockerSandbox) {
      server = await ensureBrowser(inner, ctx, runID, sink);
    } else if (inner === null) {
      server = await ensureHostBrowser(ctx, workspace, runID);
    } else if (inner instanceof sandboxLocal.localSandbox) {
      server = await ensureHostBrowser(ctx, inner.workspace, runID);
    } else if (inner instanceof sandboxProcess.processSandbox) {
      server = await ensureHostBrowser(ctx, inner.workspace, runID);
    } else {
      return null;
    }
  } catch (e) {
    err = e;
  }
  if (err != null) {
    if (sink != null) {
      sink(new TelemetryEvent({ Category: "sandbox", Name: "browser.unavailable", Level: "warn", Message: "Agent 浏览器未就绪，本节点不提供浏览器工具：" + err.message }));
    }
    return null;
  }
  return server;
}

function unwrapSandbox(sb) {
  while (sb != null) {
    if (typeof sb.Unwrap !== "function") {
      return sb;
    }
    const next = sb.Unwrap();
    if (next === sb) {
      return sb;
    }
    sb = next;
  }
  return null;
}

function browserUsageHint(servers) {
  for (const m of servers) {
    if (m.ID === BrowserMCPServerID) {
      return `
### Agent 浏览器
本运行自带一个真实 Chromium（mcp__${BrowserMCPServerID}__*，Playwright MCP）。打开网页、点击、填表、截图都用它，不要自己安装或启动浏览器。用户能在任务面板实时看到并接管同一个浏览器；看到页面被用户改动时以当前快照为准。截图等输出写在 \`.agentflow/browser/\`。
`;
    }
  }
  return "";
}

// BrowserDeviceScale：运行浏览器的设备倍率（AGENTFLOW_BROWSER_SCALE，1 到 3，默认 2）。
function BrowserDeviceScale() {
  const raw = (process.env.AGENTFLOW_BROWSER_SCALE ?? "").trim();
  const value = Number(raw);
  if (raw !== "" && !Number.isNaN(value) && value >= 1 && value <= 3) {
    return String(value);
  }
  return "2";
}

function dockerBrowserContainerName(base) {
  return base + "-browser";
}

// Go 的 browserImageMu 锁省略，JS 单线程无需加锁。

function browserImageName() {
  if ((process.env.AGENTFLOW_BROWSER_IMAGE ?? "").trim() !== "") {
    return (process.env.AGENTFLOW_BROWSER_IMAGE ?? "").trim();
  }
  const h = crypto.createHash("sha256");
  walkBrowserAssets((relPath, raw) => {
    h.update(relPath);
    h.update("\0");
    h.update(String(raw.length));
    h.update("\0");
    h.update(raw);
  });
  return "agentflow-browser-" + h.digest("hex").slice(0, 16);
}

// EnsureBrowserImage：按内容哈希只构建一次边车镜像；供 ensure-chromium 式预热导出调用。
async function EnsureBrowserImage(ctx) {
  const image = browserImageName();
  if (sandboxDocker.dockerImageExists(ctx, image)) {
    return image;
  }
  if ((process.env.AGENTFLOW_BROWSER_IMAGE ?? "") !== "") {
    const [out, err] = await execCombinedOutput(ctx, "docker", ["pull", image]);
    if (err != null) {
      throw new Error(`docker pull ${image}: ${err.message}: ${tailOutput(out)}`);
    }
    return image;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-browser-build-"));
  try {
    for (const name of ["Dockerfile", "entrypoint.sh", "cdp-relay.mjs"]) {
      const raw = readBrowserAsset(name);
      fs.writeFileSync(path.join(dir, name), raw, { mode: 0o644 });
    }
    const args = ["build", "-t", image];
    const registry = (process.env.AGENTFLOW_BROWSER_NPM_REGISTRY ?? "").trim();
    if (registry !== "") {
      args.push("--build-arg", "NPM_REGISTRY=" + registry);
    }
    const [out, err] = await execCombinedOutput(ctx, "docker", [...args, dir]);
    if (err != null) {
      throw new Error(`docker build browser image: ${err.message}: ${tailOutput(out)}`);
    }
    return image;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tailOutput(out) {
  let text = Buffer.isBuffer(out) ? out.toString("utf8") : String(out ?? "");
  text = text.trim();
  if (text.length > 2000) {
    text = "…" + text.slice(text.length - 2000);
  }
  return text;
}

// ensureBrowser：docker 沙箱的浏览器边车；Go 是 dockerSandbox 的方法，JS 因与 sandbox_docker.js 循环引用写为同文件函数。
async function ensureBrowser(s, ctx, runID, sink) {
  await s.ensureStarted(ctx);
  // Go 的 s.browserMu 锁省略，JS 单线程无需加锁。
  let image = browserImageName();
  if (!sandboxDocker.dockerImageExists(ctx, image) && sink != null) {
    sink(new TelemetryEvent({ Category: "sandbox", Name: "browser.prepare", Phase: "start", Message: "首次准备 Agent 浏览器镜像（Chromium + Playwright MCP），可能需要几分钟" }));
  }
  const [buildCtx, cancel] = withTimeout(ctx, 15 * 60 * 1000);
  try {
    image = await EnsureBrowserImage(buildCtx);
  } finally {
    cancel();
  }
  const name = dockerBrowserContainerName(s.name);
  const [out, inspectErr] = await execCombinedOutput(ctx, "docker", ["inspect", "-f", "{{.State.Running}}|{{.Config.Image}}|{{index .Config.Labels \"" + browserRunLabel + "\"}}", name]);
  if (inspectErr != null || out.toString("utf8").trim() !== "true|" + image + "|" + runID) {
    await execRun(ctx, "docker", ["rm", "-f", name]);
    const args = ["run", "-d", "--name", name, "--init",
      "--label", browserRunLabel + "=" + runID, "--label", browserOwnerLabel + "=" + s.name,
      "--network", "container:" + s.name, "--cap-drop=ALL", "--security-opt", "no-new-privileges",
      "--shm-size", "512m", "-v", s.workspace + ":/workspace", "-w", "/workspace",
      "-e", "AGENTFLOW_BROWSER_OUTPUT=/workspace/.agentflow/browser", "-e", "AGENTFLOW_BROWSER_SCALE=" + BrowserDeviceScale(), image];
    const [runOut, err] = await execCombinedOutput(ctx, "docker", args);
    if (err != null) {
      throw new Error(`启动浏览器容器失败: ${err.message}: ${tailOutput(runOut)}`);
    }
  }
  try {
    await waitDockerBrowserReady(ctx, name);
  } catch (err) {
    const [logs] = await execCombinedOutput(null, "docker", ["logs", "--tail", "20", name]);
    throw new Error(`${err.message}: ${tailOutput(logs)}`);
  }
  return new MCPServerDefinition({ ID: BrowserMCPServerID, Name: "Agent 浏览器", Transport: "http", URL: `http://127.0.0.1:${browserMCPPort}/mcp` });
}

async function waitDockerBrowserReady(ctx, name) {
  const probe = `fetch('http://127.0.0.1:${browserMCPPort}/mcp').then(()=>process.exit(0),()=>process.exit(1))`;
  const deadline = Date.now() + 60 * 1000;
  for (;;) {
    const [, err] = await execCombinedOutput(ctx, "docker", ["exec", name, "node", "-e", probe]);
    if (err == null) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("浏览器 MCP 未在 60s 内就绪");
    }
    await sleepOrAbort(ctx, 500);
  }
}

async function removeDockerBrowser(ctx, base) {
  await execRun(ctx, "docker", ["rm", "-f", dockerBrowserContainerName(base)]);
}

// hostBrowser：宿主驱动用的本进程 Chromium 子进程。
class hostBrowser {
  constructor(init = {}) {
    this.cmd = init.cmd ?? null;
    this.port = init.port ?? 0;
    this.workspace = init.workspace ?? "";
    this.dir = init.dir ?? "";
    this.exitedDone = false;
    this._resolveExited = null;
    this.exited = new Promise((resolve) => {
      this._resolveExited = resolve;
    });
  }
}

class hostBrowserRecord {
  constructor(init = {}) {
    this.PID = init.PID ?? 0;
    this.Owner = init.Owner ?? 0;
    this.WebSocket = init.WebSocket ?? "";
    this.Port = init.Port ?? 0;
    this.Workspace = init.Workspace ?? "";
  }
  // Go 的 json tag 是小写键名，JSON.stringify 经 toJSON 输出小写键。
  toJSON() {
    const out = { pid: this.PID, webSocket: this.WebSocket, port: this.Port, workspace: this.Workspace };
    if (this.Owner !== 0) {
      out.owner = this.Owner;
    }
    return out;
  }
}

const hostBrowsers = {
  items: new Map(),
  reaperDone: false,
};

const unsafeBrowserKey = /[^A-Za-z0-9_.-]/g;

function hostBrowserDir(runID) {
  return path.join(os.tmpdir(), "agentflow-browser", runID.replace(unsafeBrowserKey, "_"));
}

async function ensureHostBrowser(ctx, workspace, runID) {
  // Go 的 hostBrowsers 锁省略，JS 单线程无需加锁。
  if (!hostBrowsers.reaperDone) {
    hostBrowsers.reaperDone = true;
    reapHostBrowsers();
  }
  let b = hostBrowsers.items.get(runID) ?? null;
  if (b != null && b.exitedDone) {
    b = null;
  }
  if (b == null) {
    const binary = FindChromium();
    const dir = hostBrowserDir(runID);
    const profile = path.join(dir, "profile");
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    try {
      fs.rmSync(path.join(profile, "DevToolsActivePort"), { force: true });
    } catch {}
    const args = ["--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
      "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--window-size=1280,800", "--lang=zh-CN", "--force-device-scale-factor=" + BrowserDeviceScale()];
    if (process.platform === "linux" && typeof process.geteuid === "function" && process.geteuid() === 0) {
      args.push("--no-sandbox", "--disable-dev-shm-usage");
    }
    let child;
    try {
      // Go：cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}，对应 spawn 的 detached。
      child = spawn(binary, [...args, "about:blank"], { detached: true });
    } catch (err) {
      throw new Error(`启动 Chromium 失败: ${err.message}`);
    }
    b = new hostBrowser({ cmd: child, workspace, dir });
    let spawnErr = null;
    child.on("error", (err) => {
      spawnErr = err;
      b.exitedDone = true;
      b._resolveExited();
    });
    child.on("close", () => {
      b.exitedDone = true;
      b._resolveExited();
    });
    await new Promise((resolve) => setImmediate(resolve));
    if (spawnErr != null) {
      throw new Error(`启动 Chromium 失败: ${spawnErr.message}`);
    }
    let port;
    let devToolsPath;
    try {
      [port, devToolsPath] = await waitDevToolsActivePort(ctx, profile, b);
    } catch (err) {
      await b.stop();
      throw err;
    }
    b.port = port;
    const record = new hostBrowserRecord({ PID: child.pid, Owner: process.pid, WebSocket: `ws://127.0.0.1:${port}${devToolsPath}`, Port: port, Workspace: workspace });
    try {
      fs.writeFileSync(path.join(dir, "endpoint.json"), JSON.stringify(record), { mode: 0o600 });
    } catch (err) {
      await b.stop();
      throw err;
    }
    hostBrowsers.items.set(runID, b);
  }
  let command = "npx";
  let args = ["-y", playwrightMCPPackage];
  const bin = lookPath("playwright-mcp");
  if (bin !== "") {
    command = bin;
    args = null;
  }
  args = [...(args ?? []), "--cdp-endpoint", `http://127.0.0.1:${b.port}`, "--shared-browser-context", "--output-dir", path.join(workspace, ".agentflow", "browser")];
  return new MCPServerDefinition({ ID: BrowserMCPServerID, Name: "Agent 浏览器", Transport: "stdio", Command: command, Args: args });
}

async function waitDevToolsActivePort(ctx, profile, b) {
  const deadline = Date.now() + 20 * 1000;
  for (;;) {
    try {
      const raw = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8");
      const lines = raw.split("\n").map((line) => line.trim());
      if (lines.length >= 2) {
        const port = /^-?\d+$/.test(lines[0]) ? parseInt(lines[0], 10) : NaN;
        if (Number.isInteger(port) && port > 0) {
          return [port, lines[1]];
        }
      }
    } catch {}
    if (Date.now() > deadline) {
      throw new Error("Chromium 未在 20s 内开放调试端口");
    }
    if (b.exitedDone) {
      throw new Error("Chromium 启动后立即退出");
    }
    await sleepOrAbort(ctx, 200);
  }
}

hostBrowser.prototype.stop = async function () {
  if (this.cmd != null && this.cmd.pid != null) {
    try {
      process.kill(-this.cmd.pid, "SIGTERM");
    } catch {}
    const exited = await Promise.race([
      this.exited.then(() => true),
      sleepOrAbort(null, 3 * 1000).then(() => false),
    ]);
    if (!exited) {
      try {
        process.kill(-this.cmd.pid, "SIGKILL");
      } catch {}
    }
  }
  fs.rmSync(this.dir, { recursive: true, force: true });
};

// stopHostBrowsers：结束服务过指定工作区的宿主浏览器。
async function stopHostBrowsers(workspace) {
  const stopping = [];
  for (const [runID, b] of hostBrowsers.items) {
    if (b.workspace === workspace) {
      stopping.push(b);
      hostBrowsers.items.delete(runID);
    }
  }
  for (const b of stopping) {
    await b.stop();
  }
}

// reapHostBrowsers：收没有 Close 钩子的驱动（如 plain runner 任务）留下的浏览器；
// 工作区已消失的浏览器没有运行可服务。Chromium 在自己的进程组里，崩溃或重启过的属主的浏览器按 endpoint 记录回收。
function reapHostBrowsers() {
  reapOrphanHostBrowsers();
  setInterval(async () => {
    reapOrphanHostBrowsers();
    const stopping = [];
    for (const [runID, b] of hostBrowsers.items) {
      let workspaceGone = false;
      try {
        fs.statSync(b.workspace);
      } catch (err) {
        workspaceGone = err.code === "ENOENT";
      }
      if (b.exitedDone || workspaceGone) {
        stopping.push(b);
        hostBrowsers.items.delete(runID);
      }
    }
    for (const b of stopping) {
      await b.stop();
    }
  }, 60 * 1000);
}

function reapOrphanHostBrowsers() {
  const root = path.join(os.tmpdir(), "agentflow-browser");
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const dir = path.join(root, name);
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, "endpoint.json"));
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      continue;
    }
    const record = new hostBrowserRecord({ PID: parsed.pid ?? 0, Owner: parsed.owner ?? 0, WebSocket: parsed.webSocket ?? "", Port: parsed.port ?? 0, Workspace: parsed.workspace ?? "" });
    if (record.Owner <= 0 || record.Owner === process.pid || processAlive(record.Owner)) {
      continue;
    }
    if (record.PID > 0 && processAlive(record.PID)) {
      try {
        process.kill(-record.PID, "SIGKILL");
      } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// FindChromium：给宿主驱动找一个 Chromium 系二进制。
function FindChromium() {
  const envPath = (process.env.AGENTFLOW_CHROMIUM ?? "").trim();
  if (envPath !== "") {
    try {
      fs.statSync(envPath);
    } catch (err) {
      throw new Error(`AGENTFLOW_CHROMIUM=${envPath} 不可用: ${err.message}`);
    }
    return envPath;
  }
  for (const name of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "chrome", "microsoft-edge"]) {
    const found = lookPath(name);
    if (found !== "") {
      return found;
    }
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  let home = "";
  try {
    home = os.homedir();
  } catch {
    home = "";
  }
  if (home !== "") {
    for (const pattern of [".cache/ms-playwright/chromium-*/chrome-linux*/chrome", "Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium", "Library/Caches/ms-playwright/chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]) {
      candidates.push(...globOne(path.join(home, pattern)));
    }
  }
  for (const candidate of candidates) {
    try {
      const info = fs.statSync(candidate);
      if (!info.isDirectory()) {
        return candidate;
      }
    } catch {}
  }
  throw new Error("本机未找到 Chromium/Chrome；运行 .ci/ensure-chromium.sh 安装，或设置 AGENTFLOW_CHROMIUM");
}

// lookupBrowserEndpoint：不论哪个本地进程启动的运行浏览器都能找到：
// 宿主浏览器留 endpoint 记录，docker 边车带运行标签。
async function lookupBrowserEndpoint(ctx, runID) {
  try {
    const raw = fs.readFileSync(path.join(hostBrowserDir(runID), "endpoint.json"));
    const parsed = JSON.parse(raw.toString("utf8"));
    const record = new hostBrowserRecord({ PID: parsed.pid ?? 0, Owner: parsed.owner ?? 0, WebSocket: parsed.webSocket ?? "", Port: parsed.port ?? 0, Workspace: parsed.workspace ?? "" });
    let alive = false;
    try {
      process.kill(record.PID, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (record.PID > 0 && alive && (await hostDevToolsAlive(ctx, record.Port))) {
      return [new browserEndpoint({ Kind: "local", WebSocket: record.WebSocket, Workspace: record.Workspace }), true];
    }
  } catch {}
  if (!sandboxDocker.dockerAvailable()) {
    return [new browserEndpoint(), false];
  }
  const [out, err] = await execCombinedOutput(ctx, "docker", ["ps", "--filter", "label=" + browserRunLabel + "=" + runID, "--format", "{{.Names}}"]);
  if (err != null) {
    return [new browserEndpoint(), false];
  }
  for (const name of out.toString("utf8").split(/\s+/).filter((part) => part !== "")) {
    return [new browserEndpoint({ Kind: "docker", Container: name }), true];
  }
  return [new browserEndpoint(), false];
}

async function hostDevToolsAlive(ctx, port) {
  try {
    const timeout = AbortSignal.timeout(2 * 1000);
    const signal = ctx instanceof AbortSignal ? AbortSignal.any([ctx, timeout]) : timeout;
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal });
    return res.status === 200;
  } catch {
    return false;
  }
}

module.exports = { BrowserMCPServerID, BrowserEnabled, BrowserWantedForExecutor, browserEndpoint, BrowserRunning, EnsureSandboxBrowser, unwrapSandbox, browserUsageHint, BrowserDeviceScale, dockerBrowserContainerName, browserImageName, EnsureBrowserImage, tailOutput, ensureBrowser, waitDockerBrowserReady, removeDockerBrowser, hostBrowser, hostBrowserRecord, hostBrowserDir, ensureHostBrowser, waitDevToolsActivePort, stopHostBrowsers, reapHostBrowsers, reapOrphanHostBrowsers, processAlive, FindChromium, lookupBrowserEndpoint, hostDevToolsAlive };
