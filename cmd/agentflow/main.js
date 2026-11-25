// main.js —— 对应 Go 文件：cmd/agentflow/main.go（学习用对照翻译，非可运行后端）
// Go 的 (值, error) 多返回值译为：成功 return，失败 throw。time.Duration 译为毫秒数。
// struct 译为对象字面量，goroutine 译为不 await 的异步调用，channel 译为 Promise。

"use strict";

const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const { runCLI } = require("./cli.js");
const {
  listenMain,
  signalReady,
  handover,
  handoverReadyTimeout,
  handoverStatus,
  predecessorExited,
} = require("./handover.js");
// 以下 internal 包的 require 写在用到它们的函数入口处（Go 的 import 在程序启动时求值，
// JS 里 main() 就是程序入口）；包未转写完时，调用到它们才报错，纯函数仍可测试。
// 各 require 后的注释说明它对应 Go 的哪个 import，待转写该包时补全。

// log.Fatal：打印后退出进程，不走清理。
function fatal(message) {
  console.error(message);
  process.exit(1);
}

// time.ParseDuration："90s"、"1h30m" 这类 Go 时间字符串译为毫秒数，解析失败返回 null。
function parseDuration(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const text = raw.trim();
  if (text === "0") return 0;
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/g;
  const unitToMs = { ns: 1e-6, us: 0.001, µs: 0.001, μs: 0.001, ms: 1, s: 1000, m: 60000, h: 3600000 };
  let total = 0;
  let matched = "";
  let m;
  while ((m = re.exec(text)) !== null) {
    matched += m[0];
    total += Number(m[1]) * unitToMs[m[2]];
  }
  return matched === text ? total : null;
}

// strconv.ParseBool：只接受 Go 认可的写法，失败返回 null。
function parseBool(raw) {
  const v = String(raw).trim();
  if (["1", "t", "T", "TRUE", "true", "True"].includes(v)) return true;
  if (["0", "f", "F", "FALSE", "false", "False"].includes(v)) return false;
  return null;
}

// flag 包：定义见 main() 的 defs；支持 -name value、-name=value、--name；布尔 flag 不带值即 true。
function parseFlags(argv, defs) {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const flags = {};
  for (const d of defs) flags[d.name] = d.defaultValue;
  const positional = [];
  const convert = (def, raw) => {
    if (def.type === "int") {
      const n = Number.parseInt(raw, 10);
      if (Number.isNaN(n)) throw new Error(`invalid value "${raw}" for flag -${def.name}`);
      return n;
    }
    if (def.type === "bool") {
      const b = parseBool(raw);
      if (b === null) throw new Error(`invalid value "${raw}" for flag -${def.name}`);
      return b;
    }
    if (def.type === "duration") {
      const ms = parseDuration(raw);
      if (ms === null) throw new Error(`invalid value "${raw}" for flag -${def.name}`);
      return ms;
    }
    return raw;
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    arg = arg.replace(/^-+/, "");
    let name = arg;
    let value;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      name = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    }
    const def = byName.get(name);
    if (!def) throw new Error(`flag provided but not defined: -${name}`);
    if (value === undefined) {
      if (def.type === "bool") {
        flags[name] = true;
        continue;
      }
      i += 1;
      if (i >= argv.length) throw new Error(`flag needs an argument: -${name}`);
      value = argv[i];
    }
    flags[name] = convert(def, value);
  }
  return { flags, positional };
}

// loadDotEnv：从找到的第一个 .env 文件加载 KEY=VALUE；已有环境变量优先，永不覆盖。
function loadDotEnv() {
  const candidates = [];
  try {
    let dir = process.cwd();
    for (let i = 0; i < 4; i++) {
      candidates.push(path.join(dir, ".env"));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  candidates.push(path.join(path.dirname(process.execPath), ".env")); // Go：os.Executable() 所在目录
  for (const p of candidates) {
    let content;
    try {
      content = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of content.split("\n")) {
      let line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      line = line.replace(/^export\s+/, "");
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      if (k !== "" && !process.env[k]) process.env[k] = v;
    }
    return;
  }
}

// http.Server 的 JS 对应物：Go 的 srv.Serve(ln) / ServeTLS / Shutdown / SetKeepAlivesEnabled。
function httpServer(addr, handler) {
  const server = http.createServer(handler);
  return {
    addr,
    handler,
    async Serve(ln) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(ln.address().port, ln.address().address, resolve);
      });
    },
    async ServeTLS(ln, certFile, keyFile) {
      const secure = https.createServer(
        { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) },
        handler,
      );
      await new Promise((resolve, reject) => {
        secure.once("error", reject);
        secure.listen(ln.address().port, ln.address().address, resolve);
      });
    },
    async Shutdown() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
    SetKeepAlivesEnabled(enabled) {
      server.keepAliveTimeout = enabled ? 5000 : 0;
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  const config = require("../../internal/config");
  const engine = require("../../internal/engine");
  const httpapi = require("../../internal/httpapi");
  const notification = require("../../internal/notification");
  const repo = require("../../internal/repo");
  const runtime = require("../../internal/runtime");
  const tracker = require("../../internal/tracker");
  const gin = require("gin"); // 对应 Go 的 github.com/gin-gonic/gin，暂无 JS 版
  if (runtime.RunMCPCallCLI(argv)) return;
  if (runtime.RunGitHelperCLI(argv)) return;
  const { flags, positional } = parseFlags(argv, [
    { name: "addr", type: "string", defaultValue: "" },
    { name: "workspaces", type: "string", defaultValue: "" },
    { name: "worker-concurrency", type: "int", defaultValue: 8 },
    { name: "basic-user", type: "string", defaultValue: "" },
    { name: "basic-pass", type: "string", defaultValue: "" },
    { name: "mcp-token", type: "string", defaultValue: "" },
    { name: "tls-cert", type: "string", defaultValue: "" },
    { name: "tls-key", type: "string", defaultValue: "" },
    { name: "mysql-dsn", type: "string", defaultValue: "" },
    { name: "role", type: "string", defaultValue: "" },
    { name: "cli-action", type: "string", defaultValue: "" },
    { name: "cli-provider", type: "string", defaultValue: "" },
    { name: "cli-timeout", type: "duration", defaultValue: 80 * 60 * 1000 },
    { name: "browser-image", type: "bool", defaultValue: false },
  ]);
  loadDotEnv();
  if (flags["browser-image"]) {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    let image;
    try {
      image = await runtime.EnsureBrowserImage(controller.signal);
    } catch (err) {
      fatal(err.message);
    }
    console.log(image);
    return;
  }
  if (!process.env.AGENTFLOW_SESSION_SECRET && flags["cli-action"] === "") {
    fatal("AGENTFLOW_SESSION_SECRET is required; generate with openssl rand -hex 32");
  }
  if (!process.env.AGENTFLOW_AUTH_REQUIRED) {
    process.env.AGENTFLOW_AUTH_REQUIRED = "true";
  }
  if (flags["cli-action"] !== "" || flags["cli-provider"] !== "") {
    if (positional.length !== 0) {
      fatal("CLI administration does not accept positional arguments");
    }
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    try {
      await runCLI(
        controller.signal,
        flags["cli-action"],
        flags["cli-provider"],
        flags["cli-timeout"],
        process.stdout,
      );
    } catch (err) {
      fatal(err.message);
    }
    return;
  }
  const role = resolveRole(flags.role);
  const root = resolveWorkspaceRoot(flags.workspaces);
  try {
    runtime.SetRepositoryCacheRoot(root);
  } catch (err) {
    console.log(`repository cache disabled: ${err.message}`);
  }
  const s = await repo.Open(flags["mysql-dsn"].trim());
  console.log(
    `storage driver=${s.StorageInfo().driver} database=${s.StorageInfo().database} role=${role}`,
  );
  const e = engine.New(s, runtime.NewManagerWithLimit(root, flags["worker-concurrency"]));
  const host = os.hostname();
  let instanceID = (process.env.AGENTFLOW_INSTANCE_ID || "").trim();
  if (instanceID === "") {
    instanceID = `${role}-${host}-${process.pid}`;
  }
  let leaseTTL = 30 * 1000;
  if ((process.env.AGENTFLOW_RUN_LEASE_TTL || "").trim() !== "") {
    const raw = process.env.AGENTFLOW_RUN_LEASE_TTL.trim();
    const parsed = parseDuration(raw);
    if (parsed === null || parsed <= 0) {
      fatal(`invalid AGENTFLOW_RUN_LEASE_TTL "${raw}"`);
    }
    leaseTTL = parsed;
  }
  let executeRuns = role !== "api";
  if (role === "all") {
    if ((process.env.AGENTFLOW_EXECUTE_RUNS || "").trim() !== "") {
      const raw = process.env.AGENTFLOW_EXECUTE_RUNS.trim();
      const parsed = parseBool(raw);
      if (parsed === null) {
        fatal(`invalid AGENTFLOW_EXECUTE_RUNS "${raw}"`);
      }
      executeRuns = parsed;
    }
  }
  e.ConfigureExecution(instanceID, host, leaseTTL, executeRuns);
  e.ConfigureCloudRunnerPool({
    Label: process.env.AGENTFLOW_CLOUD_RUNNER_LABEL,
    Projects: engine.ParseCloudRunnerProjects(process.env.AGENTFLOW_CLOUD_RUNNER_PROJECTS),
    // AGENTFLOW_LOCAL_EXECUTION=false 时本机不跑池子项目的节点，等池子 Runner 接手。
    Required: (process.env.AGENTFLOW_LOCAL_EXECUTION || "").trim().toLowerCase() === "false",
  });
  attachPreviewStore(e, s);
  console.log(
    `engine instance=${instanceID} role=${role} execute_runs=${executeRuns} run_lease_ttl=${leaseTTL}ms`,
  );
  const claimController = new AbortController();
  const claimCtx = claimController.signal;
  const stopClaim = () => claimController.abort();
  let endpoints = await config.LoadEndpoints(role, flags.addr.trim());
  config.SetCurrent(endpoints);
  e.ConfigurePlatformMCP(endpoints.PlatformBase, endpoints.PlatformMCPToken);
  if (endpoints.PlatformBase === "") {
    console.log(
      "platform MCP / knowledge proxy: no sandbox-reachable platform URL; cloud runs skip them (set AGENTFLOW_PLATFORM_MCP_URL)",
    );
  } else {
    console.log(`platform MCP / knowledge proxy base=${endpoints.PlatformBase}`);
  }

  const [mainLn, inherited] = await listenMain(endpoints.ListenAddr);
  let srv;
  let syncSvc;
  let background;
  let agentToolSrv;
  let readyStatus = "serving";
  if (role === "worker") {
    e.ConfigureControl({
      Role: role,
      URL: endpoints.ControlURL,
      Token: endpoints.ControlToken,
      APIURL: endpoints.APIBase,
    });
    e.StartInstanceHeartbeat(claimCtx);
    srv = httpServer(endpoints.ListenAddr, workerHandler(e));
  } else {
    readyStatus = handoverStatus;
    const agentToolLn = net.createServer();
    await new Promise((resolve, reject) => {
      agentToolLn.once("error", reject);
      agentToolLn.listen(0, "127.0.0.1", resolve);
    });
    endpoints = endpoints.WithPrivateAgentToolGateway(
      "http://" + agentToolLn.address().address + ":" + agentToolLn.address().port,
    );
    config.SetCurrent(endpoints);
    console.log(`agent tool gateway=${endpoints.AgentToolGateway}`);
    e.ConfigureControl({
      Token: endpoints.ControlToken,
      FallbackURL: endpoints.WorkerFallbackURL,
      APIURL: endpoints.APIBase,
    });
    const listenAddr = endpoints.ListenAddr;
    syncSvc = tracker.NewService();
    let token = flags["mcp-token"];
    if (token === "") token = process.env.AGENTFLOW_MCP_TOKEN || "";
    if (token !== "") syncSvc.SetAuthToken(token);
    gin.SetMode(gin.ReleaseMode);
    const cfg = s.SyncConfig();
    syncSvc.ConfigureWithStore(cfg, s);
    if (cfg.AutoSyncEnabled) syncSvc.StartAutoSync(s);
    syncSvc.StartMRStateSync(s);
    const notifications = notification.New(s);
    const opts = {};
    if (inherited) {
      console.log(
        `taking over listener ${mainLn.address().address}:${mainLn.address().port} from pid ${process.ppid}; startup recovery waits for it to exit`,
      );
      opts.RecoveryGate = predecessorExited();
    }
    const [handler, bg] = httpapi.NewWithNotificationsAndBackground(
      claimCtx,
      s,
      e,
      syncSvc,
      flags["basic-user"],
      flags["basic-pass"],
      notifications,
      opts,
    );
    background = bg;
    notifications.Start(claimCtx);
    srv = httpServer(listenAddr, handler);
    agentToolSrv = httpServer("", httpapi.AgentToolHandler(handler));
    agentToolSrv.Serve(agentToolLn).catch((err) => {
      console.log(`agent tool gateway: ${err.message}`);
    });
  }

  // 启动前先配好控制端点与 Runner 传输，再认领工作，避免对未配置的引擎执行节点。
  e.StartMaintenance(claimCtx);
  if (executeRuns) e.StartClaimLoop(claimCtx);
  const stopCLIUpdates = startManagedCLIUpdates(claimCtx, role, executeRuns);
  let handedOver = false; // Go：atomic.Bool
  let resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });
  let draining = false;
  async function handleSignal(received) {
    if (draining) {
      console.log(`ignoring ${received} while draining`);
      return;
    }
    if (received === "SIGHUP") {
      console.log(
        `${received}: handing listener ${mainLn.address().address}:${mainLn.address().port} over to a new process...`,
      );
      let successor;
      try {
        successor = await handover(mainLn, handoverReadyTimeout);
      } catch (err) {
        console.log(`handover failed, this process keeps serving: ${err.message}`);
        return;
      }
      handedOver = true;
      srv.SetKeepAlivesEnabled(false);
      mainLn.close();
      background.HandedOver();
      console.log(
        `handover complete: pid ${successor.pid} serves new requests; draining in-flight work`,
      );
    } else {
      console.log(
        `shutting down ${role} on ${received}: stop claiming, drain local work, then stop HTTP...`,
      );
    }
    draining = true;
    stopClaim();
    background.StopClaiming();
    if (syncSvc) {
      syncSvc.StopMRStateSync();
      syncSvc.StopAutoSync();
    }
    stopCLIUpdates();
    const drainTimeout = resolveDrainTimeout();
    const drainController = new AbortController();
    setTimeout(() => drainController.abort(), drainTimeout);
    try {
      await e.Drain(drainController.signal);
      console.log("all local runs drained");
    } catch (err) {
      console.log(`drain timeout with ${e.ActiveRunCount()} active run(s): ${err.message}`);
    }
    if (background) {
      if (background.Inflight() > 0) {
        console.log(
          `waiting up to ${drainTimeout}ms for ${background.Inflight()} in-process task(s) (conversations, clarifications, follow-ups, handoffs)`,
        );
      }
      try {
        await background.WaitInflight(drainController.signal);
        console.log("all in-process tasks drained");
      } catch (err) {
        console.log(
          `drain timeout with ${background.Inflight()} in-process task(s): ${err.message}`,
        );
      }
    }
    const shutdownController = new AbortController();
    setTimeout(() => shutdownController.abort(), 10 * 1000);
    try {
      await srv.Shutdown(shutdownController.signal);
    } catch (err) {
      console.log(`http shutdown: ${err.message}`);
    }
    background.Stop();
    if (agentToolSrv) await agentToolSrv.Shutdown(shutdownController.signal);
    s.Close();
    resolveStopped();
  }
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  if (role !== "worker") process.on("SIGHUP", () => handleSignal("SIGHUP"));

  let displayAddr = srv.addr;
  if (displayAddr.startsWith(":")) displayAddr = "localhost" + displayAddr;
  let serve = () => srv.Serve(mainLn);
  if (role !== "worker" && flags["tls-cert"] !== "" && flags["tls-key"] !== "") {
    console.log(`LoopForge ${role} listening on https://${displayAddr}`);
    serve = () => srv.ServeTLS(mainLn, flags["tls-cert"], flags["tls-key"]);
  } else {
    console.log(`LoopForge ${role} listening on http://${displayAddr}`);
  }
  await signalReady(readyStatus);
  let serveErr = null;
  try {
    await serve();
  } catch (err) {
    serveErr = err;
  }
  if (serveErr && serveErr.code !== "ERR_SERVER_CLOSED" && !handedOver) {
    stopClaim();
    stopCLIUpdates();
    fatal(serveErr.message);
  }
  await stopped;
}

// resolveDrainTimeout：停机或交接时最多等本地 Run 与进行中任务多久，默认 120 分钟。
function resolveDrainTimeout() {
  const drainTimeout = 120 * 60 * 1000;
  const raw = (process.env.AGENTFLOW_DRAIN_TIMEOUT || "").trim();
  if (raw !== "") {
    const parsed = parseDuration(raw);
    if (parsed !== null && parsed > 0) return parsed;
  }
  return drainTimeout;
}

function startManagedCLIUpdates(ctx, role, executeRuns) {
  const root = (process.env.AGENTFLOW_MANAGED_CLI_ROOT || "").trim();
  // 根目录不推断；个人 Runner 与纯 API 进程不自动加入更新。
  if (!executeRuns || (role !== "worker" && role !== "all") || root === "") {
    return () => {};
  }
  const managedcli = require("../../internal/managedcli");
  return managedcli.Start(ctx, root);
}

function workerHandler(e) {
  return (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/health") {
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end("method not allowed");
        return;
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(`{"status":"ok","role":"worker","activeRuns":${e.ActiveRunCount()}}`);
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname.startsWith("/internal/runs/") &&
      url.pathname.endsWith("/interrupt")
    ) {
      e.HandleRunInterrupt(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/internal/workspace-checkpoint") {
      e.HandleWorkspaceCheckpoint(req, res);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  };
}

function resolveRole(override) {
  let role = (override || "").toLowerCase().trim();
  if (role === "") {
    role = (process.env.AGENTFLOW_ROLE || "").toLowerCase().trim();
  }
  if (role === "") role = "all";
  if (role === "api" || role === "worker" || role === "all") return role;
  throw new Error(`invalid role "${role}" (want api, worker, or all)`);
}

function resolveWorkspaceRoot(override) {
  const root = (override || "").trim();
  if (root !== "") return root;
  const home = os.homedir();
  if (!home || home.trim() === "") {
    throw new Error("resolve default sandbox workspace root: user home is empty");
  }
  return path.join(home, ".agentflow", "workspace");
}

function attachPreviewStore(e, s) {
  const preview = require("../../internal/preview");
  const cfg = preview.LoadConfig();
  e.SetPreview(preview.NewService(s, preview.NewDBStore(s), cfg));
  if (cfg.PublicHost !== "") {
    console.log(`preview gateway path=/preview/{token}/ public=${cfg.PublicScheme}://${cfg.PublicHost}`);
  } else {
    console.log("preview gateway path=/preview/{token}/");
  }
}

module.exports = {
  main,
  fatal,
  parseDuration,
  parseBool,
  parseFlags,
  loadDotEnv,
  resolveDrainTimeout,
  startManagedCLIUpdates,
  workerHandler,
  resolveRole,
  resolveWorkspaceRoot,
  attachPreviewStore,
  httpServer,
};
