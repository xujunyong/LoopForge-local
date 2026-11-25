// endpoints.js —— 对应 Go 文件：internal/config/endpoints.go
// 作用：启动时从命令行参数与环境变量解析进程的各端点地址。
// Go 的 struct 译为类，方法挂在类上；(值, error) 译为成功返回值、失败 throw；
// sync.RWMutex 在单线程 JS 里不需要，略去。

"use strict";

// Endpoints：进程监听或交给别人的全部地址。
class Endpoints {
  constructor(init = {}) {
    this.Role = init.Role ?? "";
    this.ListenAddr = init.ListenAddr ?? "";
    this.APIBase = init.APIBase ?? "";
    this.PlatformBase = init.PlatformBase ?? "";
    this.PlatformMCPToken = init.PlatformMCPToken ?? "";
    this.ControlURL = init.ControlURL ?? "";
    this.ControlToken = init.ControlToken ?? "";
    this.WorkerFallbackURL = init.WorkerFallbackURL ?? "";
    this.AgentToolGateway = init.AgentToolGateway ?? "";
    this.CollectorBase = init.CollectorBase ?? "";
  }

  // WithPrivateAgentToolGateway：把原生 agent 工具回调指向 base（本进程的回环监听）。
  withPrivateAgentToolGateway(base) {
    if (env("AGENTFLOW_AGENT_TOOL_GATEWAY_URL") === "" && trimURL(base) !== "") {
      const copy = new Endpoints(this);
      copy.AgentToolGateway = trimURL(base);
      return copy;
    }
    return this;
  }
}

const defaultAPIPort = "8080";
const defaultWorkerAddr = ":8081";

// LoadEndpoints：按 role 从 -addr 参数和环境变量解析 Endpoints。
function LoadEndpoints(role, addrFlag) {
  const ep = new Endpoints({
    Role: role,
    PlatformMCPToken: env("AGENTFLOW_PLATFORM_MCP_TOKEN"),
    ControlToken: env("AGENTFLOW_CONTROL_TOKEN"),
    WorkerFallbackURL: envURL("AGENTFLOW_WORKER_URL"),
  });
  const httpPort = httpPortFromEnv();
  const configuredAPI = envURL("AGENTFLOW_API_URL");
  if (role === "worker") {
    ep.ListenAddr = firstNonEmpty(addrFlag, defaultWorkerAddr);
    ep.ControlURL = firstNonEmpty(envURL("AGENTFLOW_CONTROL_URL"), LoopbackURL(ep.ListenAddr));
    ep.APIBase = firstNonEmpty(configuredAPI, "http://127.0.0.1:" + httpPort);
    ep.PlatformBase = firstNonEmpty(envURL("AGENTFLOW_PLATFORM_MCP_URL"), configuredAPI);
  } else {
    ep.ListenAddr = firstNonEmpty(addrFlag, ":" + httpPort);
    ep.APIBase = firstNonEmpty(configuredAPI, LoopbackURL(ep.ListenAddr));
    ep.PlatformBase = firstNonEmpty(envURL("AGENTFLOW_PLATFORM_MCP_URL"), ep.APIBase);
  }
  ep.AgentToolGateway = firstNonEmpty(envURL("AGENTFLOW_AGENT_TOOL_GATEWAY_URL"), ep.APIBase);
  ep.CollectorBase = firstNonEmpty(ep.PlatformBase, ep.APIBase);
  return ep;
}

// httpPortFromEnv：返回 AGENTFLOW_HTTP_PORT，默认 defaultAPIPort；非 TCP 端口号则报错。
function httpPortFromEnv() {
  const port = firstNonEmpty(env("AGENTFLOW_HTTP_PORT"), defaultAPIPort);
  const n = atoi(port);
  if (n === null || n < 1 || n > 65535) {
    throw new Error(`invalid AGENTFLOW_HTTP_PORT ${JSON.stringify(port)}`);
  }
  return port;
}

// LoopbackURL：把监听地址转成同机 http URL，通配主机映射为 127.0.0.1；无法解析返回 ""。
function LoopbackURL(listenAddr) {
  const addr = listenAddr.trim();
  if (addr === "") {
    return "";
  }
  const hostPort = splitHostPort(addr);
  if (hostPort === null) {
    if (addr.startsWith(":")) {
      return "http://127.0.0.1" + addr;
    }
    return "";
  }
  let { host, port } = hostPort;
  if (host === "" || host === "0.0.0.0" || host === "::" || host === "[::]") {
    host = "127.0.0.1";
  }
  return "http://" + joinHostPort(host, port);
}

// splitHostPort：对应 Go net.SplitHostPort，失败返回 null。
function splitHostPort(addr) {
  const m = addr.match(/^(?:\[([^\]]+)\]|([^:]*)):([0-9]*)$/);
  if (!m) {
    return null;
  }
  return { host: m[1] ?? m[2], port: m[3] };
}

// joinHostPort：对应 Go net.JoinHostPort，IPv6 主机加方括号。
function joinHostPort(host, port) {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

let current = null;

// SetCurrent：发布 main 解析出的 endpoints，供拿不到参数的包级辅助函数用。
function SetCurrent(ep) {
  current = ep;
}

// Current：返回已发布的 endpoints；main 从未发布时用 "all" 角色的默认配置兜底。
function Current() {
  if (current != null) {
    return current;
  }
  try {
    return LoadEndpoints("all", "");
  } catch {
    const base = "http://127.0.0.1:" + defaultAPIPort;
    return new Endpoints({ Role: "all", ListenAddr: ":" + defaultAPIPort, APIBase: base, PlatformBase: base, AgentToolGateway: base, CollectorBase: base });
  }
}

function env(key) {
  return (process.env[key] ?? "").trim();
}

function trimURL(u) {
  return u.trim().replace(/\/+$/, "");
}

// envURL：读 key 作为 base URL：去空白、去尾部斜杠。
function envURL(key) {
  return trimURL(env(key));
}

function firstNonEmpty(...values) {
  for (let v of values) {
    v = v.trim();
    if (v !== "") {
      return v;
    }
  }
  return "";
}

// atoi：对应 Go strconv.Atoi，整数字符串才通过，否则返回 null。
function atoi(s) {
  if (!/^-?\d+$/.test(s)) {
    return null;
  }
  return Number.parseInt(s, 10);
}

module.exports = { Endpoints, LoadEndpoints, LoopbackURL, SetCurrent, Current, env, trimURL, envURL, firstNonEmpty };
