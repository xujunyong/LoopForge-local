/**
 * @file internal/runtime/browser.js
 * @description 对应 Go 文件：internal/runtime/browser.go。
 * 负责运行级 Agent 浏览器的生命周期管理，包括 Docker 边车镜像构建/容器启动/健康探活、
 * 宿主 Chromium 查找/启动/端点记录/孤儿进程回收，以及跨进程浏览器端点发现。
 *
 * Go → JS 语法差异说明：
 * - `context.Context` 译为 `AbortSignal`；
 * - `(值, error)` 译为成功返回值、失败 `throw err`；仅 `error` 译为成功返回 `undefined`、失败 `throw err`；`(值, bool)` 译为 `[值, boolean]`；
 * - `sync.Mutex` / `sync.Once` 在单线程 JS 中省略（`sync.Once` 改用布尔标志）；
 * - `goroutine` 译为不 `await` 的异步函数；`channel` / `select` 译为 `Promise`；
 * - `embed.FS` 改为直接读取同级 `browser_assets/` 目录；
 * - `testing.Testing()` 译为 `process.env.NODE_ENV === "test"`；
 * - `syscall.Kill` 译为 `process.kill`；`os.Geteuid` 译为 `process.geteuid`；
 * - `map[string]*hostBrowser` 译为普通对象 `{}`。
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const { MCPServerDefinition } = require("../domain/assets.js");
const { TelemetryEvent } = require("../domain/run.js");
const { providerForKind } = require("./provider.js");
const { mockProvider } = require("./provider_mock.js");
const { dialDockerCDP, dialWebSocketCDP } = require("./browser_cdp.js");
// 与 sandbox_docker.js / sandbox_local.js / sandbox_process.js 存在循环引用，整模块引入并在调用时访问属性。
const sandboxDocker = require("./sandbox_docker.js");
const sandboxLocal = require("./sandbox_local.js");
const sandboxProcess = require("./sandbox_process.js");

// Go 使用 //go:embed 内嵌 browser_assets，JS 改为从同级目录读取。
const browserAssetsDir = path.join(__dirname, "browser_assets");

/**
 * 执行外部命令并收集合并的标准输出与标准错误，对应 Go 的 `exec.Cmd.CombinedOutput`。
 * 用于调用 docker 等子进程并在失败时保留尾部日志。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号，取消时终止子进程。
 * @param {string} name 可执行文件名称或路径。
 * @param {string[]} args 传给子进程的命令行参数列表。
 * @returns {Promise<Buffer>} 命令退出码为 0 时返回合并输出；失败时抛出 Error（其 `output` 属性附带已收集的 Buffer）。
 */
async function execCombinedOutput(ctx, name, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(name, args, { signal: ctx instanceof AbortSignal ? ctx : undefined });
    } catch (err) {
      err.output = Buffer.alloc(0);
      reject(err);
      return;
    }
    const chunks = [];
    if (child.stdout != null) {
      child.stdout.on("data", (chunk) => chunks.push(chunk));
    }
    if (child.stderr != null) {
      child.stderr.on("data", (chunk) => chunks.push(chunk));
    }
    child.on("error", (err) => {
      err.output = Buffer.concat(chunks);
      reject(err);
    });
    child.on("close", (code, signal) => {
      const output = Buffer.concat(chunks);
      if (signal != null) {
        const err = new Error(`signal: ${signal}`);
        err.output = output;
        reject(err);
      } else if (code !== 0) {
        const err = new Error(`exit status ${code}`);
        err.output = output;
        reject(err);
      } else {
        resolve(output);
      }
    });
  });
}

/**
 * 执行外部命令并仅检查是否成功，对应 Go 的 `exec.Cmd.Run`。
 * 用于不关心标准输出内容的清理或探活命令。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} name 可执行文件名称或路径。
 * @param {string[]} args 命令行参数列表。
 * @returns {Promise<void>} 无返回值；命令失败时抛出错误。
 */
async function execRun(ctx, name, args) {
  await execCombinedOutput(ctx, name, args);
}

/**
 * 等待指定毫秒数，若期间 `ctx` 取消则提前中止并抛错，对应 Go 的 `select { case <-ctx.Done(): ... case <-time.After(...): }`。
 * 用于轮询等待浏览器就绪时的退避休眠。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {number} ms 等待的毫秒数。
 * @returns {Promise<void>} 无返回值；若信号被取消则拒绝并抛出取消原因。
 */
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

/**
 * 基于父取消信号创建带超时的子信号，对应 Go 的 `context.WithTimeout`。
 * 用于给镜像构建等长耗时操作加上独立超时上限。
 *
 * @param {AbortSignal | null | undefined} ctx 父级取消信号。
 * @param {number} ms 超时毫秒数。
 * @returns {[AbortSignal, () => void]} 返回 `[子信号, 清理定时器函数]` 元组。
 */
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

/**
 * 在系统 `PATH` 环境变量中查找可执行文件，对应 Go 的 `exec.LookPath`。
 * 用于定位本机已安装的浏览器或 `playwright-mcp` 命令。
 *
 * @param {string} name 要查找的可执行文件名。
 * @returns {string} 找到时返回完整路径，未找到时返回空字符串 `""`。
 */
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

/**
 * 展开包含 `*` 通配符的路径模式，对应 Go 的 `filepath.Glob`。
 * 用于扫描 Playwright 缓存目录中的 Chromium 可执行文件。
 *
 * @param {string} pattern 含通配符 `*` 的路径模式。
 * @returns {string[]} 匹配到的全部路径列表。
 */
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

/**
 * 按字典序递归遍历 `browser_assets` 目录并回调每个文件内容，对应 Go 的 `fs.WalkDir`。
 * 用于计算构建资产的内容哈希。
 *
 * @param {(relPath: string, raw: Buffer) => void} visit 访问回调函数，参数为相对路径和文件原始字节。
 * @returns {void} 无返回值。
 */
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

/**
 * 读取 `browser_assets` 目录下的单个资源文件，对应 Go 的 `browserAssets.ReadFile`。
 * 用于构建浏览器 Docker 镜像时写出临时上下文文件。
 *
 * @param {string} name 资源文件名（如 `"Dockerfile"`）。
 * @returns {Buffer} 文件原始字节内容。
 */
function readBrowserAsset(name) {
  return fs.readFileSync(path.join(browserAssetsDir, name));
}

const BrowserMCPServerID = "agentflow-browser";
const playwrightMCPPackage = "@playwright/mcp@0.0.83";
const browserMCPPort = 8931;
const browserRunLabel = "agentflow.browser.run";
const browserOwnerLabel = "agentflow.browser.owner";

/**
 * 判断运行级 Agent 浏览器开关是否启用。
 * 通过环境变量 `AGENTFLOW_BROWSER` 控制（设为 `off`/`0`/`false`/`no` 时关闭），默认开启。
 *
 * @returns {boolean} 启用返回 `true`，关闭返回 `false`。
 */
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

/**
 * 判断指定类型的执行器是否需要挂载 Agent 浏览器。
 * 进程内 mock 执行器与测试环境下默认不启动浏览器，除非环境变量 `AGENTFLOW_BROWSER=always`。
 *
 * @param {string} kind 执行器类型标识。
 * @returns {boolean} 需要启用浏览器返回 `true`，否则返回 `false`。
 */
function BrowserWantedForExecutor(kind) {
  if (!BrowserEnabled()) {
    return false;
  }
  if (providerForKind(kind) instanceof mockProvider || process.env.NODE_ENV === "test") {
    return (process.env.AGENTFLOW_BROWSER ?? "").trim().toLowerCase() === "always";
  }
  return true;
}

/**
 * 表示已发现的运行级浏览器连接端点，对应 Go 的 `browserEndpoint`。
 * 区分 Docker 边车容器端点与宿主本地 WebSocket 端点。
 */
class browserEndpoint {
  /**
   * 构造浏览器端点描述对象，未传入的字段按 Go 零值初始化。
   *
   * @param {object} [init={}] 初始字段对象。
   * @param {string} [init.Kind=""] 端点类型（`"docker"` 或 `"local"`）。
   * @param {string} [init.Container=""] Docker 边车容器名称。
   * @param {string} [init.WebSocket=""] 宿主 Chromium 的 CDP WebSocket 地址。
   * @param {string} [init.Workspace=""] 宿主浏览器提供 `file://` 服务的工作区目录路径。
   */
  constructor(init = {}) {
    this.Kind = init.Kind ?? "";
    this.Container = init.Container ?? "";
    this.WebSocket = init.WebSocket ?? "";
    // Workspace 是宿主浏览器用 file:// 服务的宿主目录。
    this.Workspace = init.Workspace ?? "";
  }
}

/**
 * 建立到该浏览器端点的 CDP 传输连接。
 * Docker 端点通过 `docker exec` 管道中继，宿主端点直接连接 WebSocket。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @returns {Promise<object>} 实现 `read`/`write`/`close` 方法的 CDP 传输对象。
 */
browserEndpoint.prototype.dial = async function (ctx) {
  if (this.Kind === "docker") {
    return dialDockerCDP(ctx, this.Container);
  }
  return dialWebSocketCDP(ctx, this.WebSocket);
};

/**
 * 检查当前宿主机上是否已经存在指定运行的浏览器实例。
 * 用于任务面板查询浏览器运行状态。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} runID 运行实例 ID。
 * @returns {Promise<boolean>} 已运行返回 `true`，否则返回 `false`。
 */
async function BrowserRunning(ctx, runID) {
  const [, ok] = await lookupBrowserEndpoint(ctx, runID);
  return ok;
}

/**
 * 为本次执行准备运行级浏览器，并返回供 Agent 调用的 MCP 服务器定义。
 * Docker 沙箱会启动共享网络命名空间的浏览器边车；宿主/进程沙箱会启动本地 Chromium。
 * 准备失败时仅通过 `sink` 发出告警并返回 `null`，不阻断节点继续执行。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {object | null | undefined} sb 沙箱实例（可能经过多层包装）。
 * @param {string} workspace 宿主机工作区目录路径。
 * @param {string} runID 运行实例 ID。
 * @param {((event: TelemetryEvent) => void) | null | undefined} sink 遥测事件回调，可为 `null`。
 * @returns {Promise<MCPServerDefinition | null>} 就绪时返回 MCP 服务器定义，未启用或失败时返回 `null`。
 */
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

/**
 * 递归解包实现了 `Unwrap()` 方法的沙箱包装层，获取最内层具体沙箱对象。
 * 用于在 `EnsureSandboxBrowser` 中识别底层沙箱类型。
 *
 * @param {object | null | undefined} sb 沙箱实例。
 * @returns {object | null} 最内层沙箱实例；传入空值时返回 `null`。
 */
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

/**
 * 当 MCP 服务器列表中包含 Agent 浏览器时，生成附加到提示词中的使用说明。
 * 用于告知模型直接复用内置 Playwright MCP，而非自行安装或启动浏览器。
 *
 * @param {MCPServerDefinition[]} servers 当前节点挂载的 MCP 服务器定义列表。
 * @returns {string} 命中时返回中文提示词片段，否则返回空字符串 `""`。
 */
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

/**
 * 获取运行浏览器的设备像素缩放倍率字符串（环境变量 `AGENTFLOW_BROWSER_SCALE`，范围 1~3，默认 `"2"`）。
 * 高分屏任务面板展示画面时依赖真实设备倍率以保证清晰度。
 *
 * @returns {string} 合法倍率的字符串表示，非法或未设置时返回 `"2"`。
 */
function BrowserDeviceScale() {
  const raw = (process.env.AGENTFLOW_BROWSER_SCALE ?? "").trim();
  const value = Number(raw);
  if (raw !== "" && !Number.isNaN(value) && value >= 1 && value <= 3) {
    return String(value);
  }
  return "2";
}

/**
 * 根据主沙箱容器名推导对应的浏览器边车容器名。
 *
 * @param {string} base 主沙箱容器名称。
 * @returns {string} 边车容器名称（`${base}-browser`）。
 */
function dockerBrowserContainerName(base) {
  return base + "-browser";
}

// Go 的 browserImageMu 锁省略，JS 单线程无需加锁。

/**
 * 计算或读取浏览器边车 Docker 镜像名称。
 * 若设置了 `AGENTFLOW_BROWSER_IMAGE` 则直接返回，否则按 `browser_assets/` 内容 SHA-256 前 16 位生成稳定镜像名。
 *
 * @returns {string} Docker 镜像名称。
 */
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

/**
 * 确保浏览器边车 Docker 镜像在本地可用：若不存在则拉取指定镜像或基于内嵌资产构建一次。
 * 导出供预热脚本（如 ensure-chromium 类流程）提前构建镜像。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @returns {Promise<string>} 可用的浏览器边车镜像名称；拉取或构建失败时抛出错误。
 */
async function EnsureBrowserImage(ctx) {
  const image = browserImageName();
  if (sandboxDocker.dockerImageExists(ctx, image)) {
    return image;
  }
  if ((process.env.AGENTFLOW_BROWSER_IMAGE ?? "") !== "") {
    try {
      await execCombinedOutput(ctx, "docker", ["pull", image]);
    } catch (err) {
      throw new Error(`docker pull ${image}: ${err.message}: ${tailOutput(err.output)}`);
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
    try {
      await execCombinedOutput(ctx, "docker", [...args, dir]);
    } catch (err) {
      throw new Error(`docker build browser image: ${err.message}: ${tailOutput(err.output)}`);
    }
    return image;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 裁剪命令输出尾部最多 2000 个字符，防止错误消息过长。
 *
 * @param {Buffer | string | null | undefined} out 命令输出内容。
 * @returns {string} 去除首尾空白并按上限截断后的文本。
 */
function tailOutput(out) {
  let text = Buffer.isBuffer(out) ? out.toString("utf8") : String(out ?? "");
  text = text.trim();
  if (text.length > 2000) {
    text = "…" + text.slice(text.length - 2000);
  }
  return text;
}

/**
 * 为 Docker 沙箱准备并启动共享网络命名空间的浏览器边车容器，等待其 MCP 端点就绪。
 * Go 原文为 `(*dockerSandbox).ensureBrowser` 方法，因与 `sandbox_docker.js` 循环引用而在 JS 中保留为接收 `s` 的同文件函数。
 *
 * @param {object} s Docker 沙箱实例（含 `name`、`workspace`、`ensureStarted`）。
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} runID 运行实例 ID。
 * @param {((event: TelemetryEvent) => void) | null | undefined} sink 遥测事件回调。
 * @returns {Promise<MCPServerDefinition>} 指向容器内 HTTP MCP 服务的定义对象。
 */
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
  let inspectOut = "";
  let inspectErr = null;
  try {
    const out = await execCombinedOutput(ctx, "docker", ["inspect", "-f", "{{.State.Running}}|{{.Config.Image}}|{{index .Config.Labels \"" + browserRunLabel + "\"}}", name]);
    inspectOut = out.toString("utf8").trim();
  } catch (err) {
    inspectErr = err;
  }
  if (inspectErr != null || inspectOut !== "true|" + image + "|" + runID) {
    try {
      await execRun(ctx, "docker", ["rm", "-f", name]);
    } catch {}
    const args = ["run", "-d", "--name", name, "--init",
      "--label", browserRunLabel + "=" + runID, "--label", browserOwnerLabel + "=" + s.name,
      "--network", "container:" + s.name, "--cap-drop=ALL", "--security-opt", "no-new-privileges",
      "--shm-size", "512m", "-v", s.workspace + ":/workspace", "-w", "/workspace",
      "-e", "AGENTFLOW_BROWSER_OUTPUT=/workspace/.agentflow/browser", "-e", "AGENTFLOW_BROWSER_SCALE=" + BrowserDeviceScale(), image];
    try {
      await execCombinedOutput(ctx, "docker", args);
    } catch (err) {
      throw new Error(`启动浏览器容器失败: ${err.message}: ${tailOutput(err.output)}`);
    }
  }
  try {
    await waitDockerBrowserReady(ctx, name);
  } catch (err) {
    let logs = Buffer.alloc(0);
    try {
      logs = await execCombinedOutput(null, "docker", ["logs", "--tail", "20", name]);
    } catch (logErr) {
      logs = logErr.output ?? Buffer.alloc(0);
    }
    throw new Error(`${err.message}: ${tailOutput(logs)}`);
  }
  return new MCPServerDefinition({ ID: BrowserMCPServerID, Name: "Agent 浏览器", Transport: "http", URL: `http://127.0.0.1:${browserMCPPort}/mcp` });
}

/**
 * 轮询探测 Docker 边车容器内的 Playwright MCP HTTP 端点，直到就绪或超过 60 秒超时。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} name 浏览器边车容器名称。
 * @returns {Promise<void>} 无返回值；超时或取消时抛出错误。
 */
async function waitDockerBrowserReady(ctx, name) {
  const probe = `fetch('http://127.0.0.1:${browserMCPPort}/mcp').then(()=>process.exit(0),()=>process.exit(1))`;
  const deadline = Date.now() + 60 * 1000;
  for (;;) {
    try {
      await execCombinedOutput(ctx, "docker", ["exec", name, "node", "-e", probe]);
      return;
    } catch {}
    if (Date.now() > deadline) {
      throw new Error("浏览器 MCP 未在 60s 内就绪");
    }
    await sleepOrAbort(ctx, 500);
  }
}

/**
 * 强制删除与指定主沙箱关联的 Docker 浏览器边车容器，忽略删除失败。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} base 主沙箱容器名称。
 * @returns {Promise<void>} 无返回值。
 */
async function removeDockerBrowser(ctx, base) {
  try {
    await execRun(ctx, "docker", ["rm", "-f", dockerBrowserContainerName(base)]);
  } catch {}
}

/**
 * 表示由当前进程拉起的宿主 Chromium 子进程，供非 Docker 驱动（local/seatbelt/bwrap/plain runner）使用。
 * 对应 Go 的 `hostBrowser`。
 */
class hostBrowser {
  /**
   * 构造宿主浏览器句柄对象，并初始化退出通知 Promise。
   *
   * @param {object} [init={}] 初始字段对象。
   * @param {import("node:child_process").ChildProcess | null} [init.cmd=null] Chromium 子进程对象。
   * @param {number} [init.port=0] DevTools 远程调试监听端口。
   * @param {string} [init.workspace=""] 关联的宿主机工作区路径。
   * @param {string} [init.dir=""] 存放浏览器 profile 与 `endpoint.json` 的临时目录。
   */
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

/**
 * 写入 `endpoint.json` 的宿主浏览器持久化记录，供同机其他进程发现或回收孤儿浏览器。
 * 对应 Go 的 `hostBrowserRecord`。
 */
class hostBrowserRecord {
  /**
   * 构造宿主浏览器端点记录。
   *
   * @param {object} [init={}] 初始字段对象。
   * @param {number} [init.PID=0] Chromium 进程 PID。
   * @param {number} [init.Owner=0] 启动该浏览器的宿主进程 PID。
   * @param {string} [init.WebSocket=""] CDP WebSocket 连接地址。
   * @param {number} [init.Port=0] DevTools 监听端口。
   * @param {string} [init.Workspace=""] 关联工作区目录。
   */
  constructor(init = {}) {
    this.PID = init.PID ?? 0;
    this.Owner = init.Owner ?? 0;
    this.WebSocket = init.WebSocket ?? "";
    this.Port = init.Port ?? 0;
    this.Workspace = init.Workspace ?? "";
  }

  /**
   * 自定义 JSON 序列化，输出与 Go struct json tag 一致的小写键名；`Owner` 为 0 时按 `omitempty` 省略。
   *
   * @returns {{ pid: number, owner?: number, webSocket: string, port: number, workspace: string }} 序列化后的普通对象。
   */
  toJSON() {
    const out = { pid: this.PID, webSocket: this.WebSocket, port: this.Port, workspace: this.Workspace };
    if (this.Owner !== 0) {
      out.owner = this.Owner;
    }
    return out;
  }
}

// 对应 Go 的 map[string]*hostBrowser，字符串键使用普通对象 {}；sync.Mutex 在单线程 JS 中省略。
const hostBrowsers = {
  items: {},
  reaperDone: false,
};

const unsafeBrowserKey = /[^A-Za-z0-9_.-]/g;

/**
 * 计算指定运行 ID 对应的宿主浏览器临时数据目录。
 *
 * @param {string} runID 运行实例 ID。
 * @returns {string} 临时目录绝对路径。
 */
function hostBrowserDir(runID) {
  return path.join(os.tmpdir(), "agentflow-browser", runID.replace(unsafeBrowserKey, "_"));
}

/**
 * 为宿主驱动准备并复用该运行的本机 Chromium 实例，返回连接它的 stdio Playwright MCP 定义。
 * 首次调用时会启动后台回收定时器，并将进程与端口信息写入 `endpoint.json`。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} workspace 宿主机工作区路径。
 * @param {string} runID 运行实例 ID。
 * @returns {Promise<MCPServerDefinition>} 连接本机 Chromium 的 stdio MCP 服务器定义。
 */
async function ensureHostBrowser(ctx, workspace, runID) {
  // Go 的 hostBrowsers 锁省略，JS 单线程无需加锁。
  if (!hostBrowsers.reaperDone) {
    hostBrowsers.reaperDone = true;
    reapHostBrowsers();
  }
  let b = hostBrowsers.items[runID] ?? null;
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
    hostBrowsers.items[runID] = b;
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

/**
 * 轮询读取 Chromium profile 目录下的 `DevToolsActivePort` 文件，等待其开放调试端口（最长 20 秒）。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} profile Chromium 用户数据目录路径。
 * @param {hostBrowser} b 宿主浏览器句柄，用于检测进程是否提前退出。
 * @returns {Promise<[number, string]>} 返回 `[端口号, WebSocket 路径]` 元组；超时、退出或取消时抛错。
 */
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

/**
 * 终止宿主 Chromium 进程组（先 SIGTERM，等待 3 秒未退出再 SIGKILL）并清理其临时目录。
 *
 * @returns {Promise<void>} 无返回值。
 */
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

/**
 * 停止并移除所有服务于指定工作区目录的宿主浏览器实例。
 * 在沙箱关闭或工作区清理时调用。
 *
 * @param {string} workspace 宿主机工作区路径。
 * @returns {Promise<void>} 无返回值。
 */
async function stopHostBrowsers(workspace) {
  const stopping = [];
  for (const [runID, b] of Object.entries(hostBrowsers.items)) {
    if (b.workspace === workspace) {
      stopping.push(b);
      delete hostBrowsers.items[runID];
    }
  }
  for (const b of stopping) {
    await b.stop();
  }
}

/**
 * 启动宿主浏览器定期回收任务：立即清理一次孤儿浏览器，随后每分钟巡检已退出或工作区已删除的实例。
 * 用于兜底没有显式 Close 钩子的运行驱动。
 *
 * @returns {void} 无返回值。
 */
function reapHostBrowsers() {
  reapOrphanHostBrowsers();
  setInterval(async () => {
    reapOrphanHostBrowsers();
    const stopping = [];
    for (const [runID, b] of Object.entries(hostBrowsers.items)) {
      let workspaceGone = false;
      try {
        fs.statSync(b.workspace);
      } catch (err) {
        workspaceGone = err.code === "ENOENT";
      }
      if (b.exitedDone || workspaceGone) {
        stopping.push(b);
        delete hostBrowsers.items[runID];
      }
    }
    for (const b of stopping) {
      await b.stop();
    }
  }, 60 * 1000);
}

/**
 * 扫描临时目录下的 `endpoint.json`，强制清理属主进程已死亡的孤儿 Chromium 进程及其目录。
 *
 * @returns {void} 无返回值。
 */
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

/**
 * 通过发送 0 号信号探测指定 PID 的进程是否仍存活。
 *
 * @param {number} pid 进程 ID。
 * @returns {boolean} 进程存在或无权限发送信号（`EPERM`）时返回 `true`，否则返回 `false`。
 */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * 在宿主机上查找可用的 Chromium/Chrome/Edge 可执行文件路径。
 * 依次检查 `AGENTFLOW_CHROMIUM` 环境变量、系统 `PATH`、常见 macOS 应用路径与 Playwright 缓存目录。
 *
 * @returns {string} 找到的可执行文件绝对路径；全部未命中时抛出错误。
 */
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

/**
 * 在当前宿主机上查找指定运行 ID 对应的浏览器端点，无论由哪个本地进程启动。
 * 先检查宿主浏览器留下的 `endpoint.json` 并探活，再通过 Docker 标签查询边车容器。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} runID 运行实例 ID。
 * @returns {Promise<[browserEndpoint, boolean]>} 返回 `[端点对象, 是否找到]` 元组。
 */
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
  let out;
  try {
    out = await execCombinedOutput(ctx, "docker", ["ps", "--filter", "label=" + browserRunLabel + "=" + runID, "--format", "{{.Names}}"]);
  } catch {
    return [new browserEndpoint(), false];
  }
  for (const name of out.toString("utf8").split(/\s+/).filter((part) => part !== "")) {
    return [new browserEndpoint({ Kind: "docker", Container: name }), true];
  }
  return [new browserEndpoint(), false];
}

/**
 * 请求本机 Chromium DevTools 的 `/json/version` 接口，探测调试端口是否存活（2 秒超时）。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {number} port DevTools 监听端口号。
 * @returns {Promise<boolean>} HTTP 状态码为 200 时返回 `true`，否则返回 `false`。
 */
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
