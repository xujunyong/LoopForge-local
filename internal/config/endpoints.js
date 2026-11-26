// endpoints.js —— 对应 Go 文件：internal/config/endpoints.go
// 作用与职责边界：在进程启动阶段统一从命令行标志与环境变量解析本进程监听及对外分发的各类端点地址，
// 并提供进程级全局读写接口，避免业务代码四处重复读取环境变量。
// 语法差异说明：Go 的 struct 译为带零值构造的类；(值, error) 译为成功返回值、失败 throw；
// Go 的 sync.RWMutex 在单线程 JS 环境下不需要，直接略去。

"use strict";

/**
 * 进程监听地址与对外暴露/回调地址的聚合配置（对应 Go 的 config.Endpoints）。
 * 显式区分 api、worker、all 三种运行角色下各端点的差异。
 */
class Endpoints {
  /**
   * 构造端点配置对象，各字符串字段按 Go 零值初始化为空串。
   * 使用场景：LoadEndpoints 构建结果、拷贝修改或测试构造配置时使用。
   * @param {{
   *   Role?: string,
   *   ListenAddr?: string,
   *   APIBase?: string,
   *   PlatformBase?: string,
   *   PlatformMCPToken?: string,
   *   ControlURL?: string,
   *   ControlToken?: string,
   *   WorkerFallbackURL?: string,
   *   AgentToolGateway?: string,
   *   CollectorBase?: string
   * }} [init={}] - 初始化字段对象。
   */
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

  /**
   * 返回将原生 Agent 工具回调地址指向本进程私有回环地址 base 的新配置副本。
   * 使用场景：主进程启动私有监听后（含无缝交接场景），确保该进程拉起的 CLI 回调本进程内存中的工具会话；
   * 若环境变量 AGENTFLOW_AGENT_TOOL_GATEWAY_URL 已显式配置，则仍以环境变量优先。
   * @param {string} base - 本进程私有回环监听基地址。
   * @returns {Endpoints} 新的 Endpoints 副本（对应 Go 值接收者语义）。
   */
  WithPrivateAgentToolGateway(base) {
    const copy = new Endpoints(this);
    if (env("AGENTFLOW_AGENT_TOOL_GATEWAY_URL") === "" && trimURL(base) !== "") {
      copy.AgentToolGateway = trimURL(base);
    }
    return copy;
  }
}

/** API 服务默认监听端口号。 */
const defaultAPIPort = "8080";
/** Worker 角色默认监听地址。 */
const defaultWorkerAddr = ":8081";

/**
 * 根据运行角色、-addr 参数和环境变量解析完整的 Endpoints 配置。
 * 使用场景：进程启动入口初始化网络端点，或 Current() 未发布配置时的兜底解析。
 * @param {string} role - 进程角色（如 "api"、"worker"、"all"）。
 * @param {string} addrFlag - 命令行传入的 -addr 监听地址标志。
 * @returns {Endpoints} 解析后的端点配置对象；端口号非法时抛出 Error。
 */
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

/**
 * 读取并校验环境变量 AGENTFLOW_HTTP_PORT，未设置时回退到默认端口 8080。
 * 使用场景：LoadEndpoints 解析 API 端口时内部调用。
 * @returns {string} 合法的 TCP 端口号字符串（1–65535）；非合法整数或越界时抛出 Error。
 */
function httpPortFromEnv() {
  const port = firstNonEmpty(env("AGENTFLOW_HTTP_PORT"), defaultAPIPort);
  const n = atoi(port);
  if (n === null || n < 1 || n > 65535) {
    throw new Error(`invalid AGENTFLOW_HTTP_PORT ${JSON.stringify(port)}`);
  }
  return port;
}

/**
 * 将监听地址转换为同机可访问的 http 回环 URL，将通配监听主机映射为 127.0.0.1。
 * 使用场景：根据监听地址推导本机 APIBase 或 ControlURL 时使用。
 * @param {string} listenAddr - 监听地址字符串（如 ":8080"、"0.0.0.0:8080"、"[::]:8080"）。
 * @returns {string} 转换后的 http URL；地址为空或无法解析时返回空字符串 ""。
 */
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

/**
 * 按 Go 标准库 net.SplitHostPort 规则拆分 host 与 port。
 * 使用场景：LoopbackURL 内部解析监听地址时使用。
 * @param {string} addr - 待拆分的 "host:port" 或 "[ipv6]:port" 字符串。
 * @returns {{ host: string, port: string } | null} 拆分成功返回 { host, port }，格式非法返回 null。
 */
function splitHostPort(addr) {
  const m = addr.match(/^(?:\[([^\]]+)\]|([^:]*)):([^:]*)$/);
  if (!m) {
    return null;
  }
  return { host: m[1] ?? m[2], port: m[3] };
}

/**
 * 按 Go 标准库 net.JoinHostPort 规则拼接 host 与 port，IPv6 地址自动包裹方括号。
 * 使用场景：LoopbackURL 构造 URL 主机端口段时使用。
 * @param {string} host - 主机名或 IP 地址。
 * @param {string} port - 端口字符串。
 * @returns {string} 拼接后的 "host:port" 或 "[ipv6]:port" 字符串。
 */
function joinHostPort(host, port) {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** 当前进程已发布的全局 Endpoints 实例缓存（Go 中由 currentMu 保护，JS 单线程直接保存）。 */
let current = null;

/**
 * 发布主进程解析完成的全局 Endpoints 配置（拷贝保存，贴合 Go 值传参语义）。
 * 使用场景：主进程启动解析完端点后调用，供无法显式传参的包级函数通过 Current() 读取。
 * @param {Endpoints} ep - 已解析的端点配置对象。
 * @returns {void} 无返回值。
 */
function SetCurrent(ep) {
  current = new Endpoints(ep);
}

/**
 * 获取当前已发布的全局 Endpoints；若尚未发布，则按 "all" 角色从环境变量加载，失败时回退到 8080 默认配置。
 * 使用场景：测试、辅助命令行工具或未显式传入配置的包级代码读取进程端点时使用。
 * @returns {Endpoints} 当前有效的端点配置对象。
 */
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

/**
 * 读取指定环境变量并去除首尾空白。
 * 使用场景：config 包内读取所有配置项环境变量时调用。
 * @param {string} key - 环境变量名。
 * @returns {string} 去空白后的环境变量值；未定义时返回空字符串 ""。
 */
function env(key) {
  return (process.env[key] ?? "").trim();
}

/**
 * 去除 URL 字符串首尾空白及末尾所有斜杠。
 * 使用场景：标准化各类基地址配置，避免后续路径拼接出现双斜杠。
 * @param {string} u - 原始 URL 字符串。
 * @returns {string} 规整后的 URL 字符串。
 */
function trimURL(u) {
  return u.trim().replace(/\/+$/, "");
}

/**
 * 将指定环境变量作为基地址 URL 读取并去空白、去尾部斜杠。
 * 使用场景：读取 API、MCP、Worker 等外部地址环境变量时使用。
 * @param {string} key - 环境变量名。
 * @returns {string} 规整后的基地址 URL 字符串。
 */
function envURL(key) {
  return trimURL(env(key));
}

/**
 * 依次检查多个候选字符串，返回第一个去空白后非空的值。
 * 使用场景：按优先级从命令行参数、环境变量与默认值中选取最终配置值。
 * @param {...string} values - 按优先级排列的候选字符串列表。
 * @returns {string} 首个非空候选值；全部为空时返回空字符串 ""。
 */
function firstNonEmpty(...values) {
  for (let v of values) {
    v = v.trim();
    if (v !== "") {
      return v;
    }
  }
  return "";
}

/**
 * 按 Go 标准库 strconv.Atoi 规则解析十进制整数字符串。
 * 使用场景：httpPortFromEnv 校验端口字符串是否为合法整数时使用。
 * @param {string} s - 待解析字符串。
 * @returns {number | null} 合法整数返回对应数值，否则返回 null。
 */
function atoi(s) {
  if (!/^-?\d+$/.test(s)) {
    return null;
  }
  return Number.parseInt(s, 10);
}

module.exports = { Endpoints, LoadEndpoints, LoopbackURL, SetCurrent, Current, env, trimURL, envURL, firstNonEmpty };
