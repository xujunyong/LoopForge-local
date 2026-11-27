// git_credential_helper.js —— 对应 Go 文件：internal/runtime/git_credential_helper.go
// 作用与职责边界：实现工作区内的隐藏子命令（git-credential 凭据协议与 gh/glab CLI 垫片），通过会话中继网关按主机临时获取凭据并仅注入单个子进程。
// 语法差异说明：
// - Go 的 (值, error) 译为成功返回值、失败 throw；(值, bool) 译为 [值, bool]；context.Context 译为 AbortSignal；
// - Go 的 defer cancel() 译为 try ... finally { clearTimeout(timer); }；
// - net/http 译为异步 fetch（默认不走代理，对应 Transport{Proxy: nil}）；syscall.Exec 无 JS 等价物，译为 spawnSync（指定 argv0 并继承 stdio）后原样返回退出码；
// - Go 的 os.Stdout/os.Stderr 为同步写入，RunGitHelperCLI 传入基于 fs.writeSync 的写出器，防止 process.exit 丢弃未刷新的凭据输出。

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process"); // Go os/exec
const { HTTPSHostScope, HTTPSRemoteHost } = require("../gitwork/https_host.js"); // 对应 Go 的 gitwork.HTTPSHostScope/HTTPSRemoteHost，https_host.js 待翻译
const { ParseSSHRemote } = require("../gitwork/ssh_remote.js"); // 对应 Go 的 gitwork.ParseSSHRemote，ssh_remote.js 待翻译

const SessionGatewayEnv = "AGENTFLOW_SESSION_GATEWAY";
const GitHostsEnv = "AGENTFLOW_GIT_HOSTS";

const gitCredentialMethod = "agentflow/gitCredential";

/**
 * 分发工作区内的隐藏辅助子命令：`git-credential <get|store|erase>` 与 `cli-shim <gh|glab> [args...]`。
 *
 * @param {string[]} args 命令行参数列表（不含可执行文件本身）。
 * @returns {Promise<boolean>} 命中隐藏子命令并已处理时返回 true（实际会先调用 process.exit 退出进程），未命中时返回 false。
 */
async function RunGitHelperCLI(args) {
  if (args.length === 0) {
    return false;
  }
  switch (args[0]) {
    case "git-credential":
      process.exit(await gitCredentialMain(args.slice(1), fs.readFileSync(0, "utf8"), { write: (chunk) => fs.writeSync(1, chunk) }, { write: (chunk) => fs.writeSync(2, chunk) }));
    case "cli-shim":
      process.exit(await cliShimMain(args.slice(1)));
    default:
      return false;
  }
  return true;
}

/**
 * 执行 Git credential helper 协议主逻辑：仅响应 `get` 且协议为 `https` 的请求，向会话网关拉取凭据并按 Git 协议格式输出；`store`/`erase` 直接忽略。
 *
 * @param {string[]} args 子命令参数（期望长度为 1，取值为 get/store/erase）。
 * @param {string} input 从标准输入读取的 Git 凭据属性文本。
 * @param {{ write: (chunk: string) => void }} out 标准输出写出器。
 * @param {{ write: (chunk: string) => void }} errOut 标准错误写出器。
 * @returns {Promise<number>} 进程退出码（参数错误返回 2，其余情况返回 0）。
 */
async function gitCredentialMain(args, input, out, errOut) {
  if (args.length !== 1) {
    errOut.write("usage: agentflow git-credential <get|store|erase>\n");
    return 2;
  }
  const attrs = readGitCredentialAttrs(input);
  if (args[0] !== "get" || attrs["protocol"] !== "https" || (attrs["host"] ?? "") === "") {
    return 0;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), 30 * 1000);
  let reply;
  try {
    reply = await requestGitCredential(controller.signal, attrs["protocol"], attrs["host"], "git");
  } catch (err) {
    errOut.write("agentflow: " + err.message + "\n");
    return 0;
  } finally {
    clearTimeout(timer);
  }
  if (reply.password === "" || /[\r\n\x00]/.test(reply.username + reply.password)) {
    return 0;
  }
  out.write(`username=${reply.username}\npassword=${reply.password}\n`);
  if (reply.password_expiry_utc > 0) {
    out.write(`password_expiry_utc=${reply.password_expiry_utc}\n`);
  }
  return 0;
}

/**
 * 解析 Git credential 协议标准输入中的 `key=value` 属性行（最多读取 64 KiB，遇空行结束）。
 *
 * @param {string} input 标准输入原始文本。
 * @returns {Object<string, string>} 解析出的属性键值映射对象。
 */
function readGitCredentialAttrs(input) {
  const attrs = {};
  const lines = input.slice(0, 64 * 1024).split("\n");
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      break;
    }
    const eq = line.indexOf("=");
    if (eq >= 0) {
      attrs[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return attrs;
}

/**
 * 通过会话中继网关（JSON-RPC 2.0）为指定协议、主机与调用方请求单次 Git 凭据。
 *
 * @param {AbortSignal|null} ctx 用于取消或超时的信号对象。
 * @param {string} protocol 协议名（如 "https"）。
 * @param {string} host 目标 Git 主机名。
 * @param {string} caller 调用方标识（如 "git"、"gh"、"glab"）。
 * @returns {Promise<{ username: string, password: string, password_expiry_utc: number, platform: string }>} 网关返回的凭据对象。
 */
async function requestGitCredential(ctx, protocol, host, caller) {
  const gateway = (process.env[SessionGatewayEnv] ?? "").trim();
  if (gateway === "") {
    throw new Error("not running in a LoopForge workspace turn");
  }
  // Go 的 http.NewRequestWithContext：网关 URL 非法时直接抛出错误。
  new URL(gateway);
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: gitCredentialMethod,
    params: { protocol, host, caller },
  });
  // Go 的 http.Client 超时 30 秒与调用方的 context 超时叠加。
  const timeout = AbortSignal.timeout(30 * 1000);
  const signal = ctx instanceof AbortSignal ? AbortSignal.any([ctx, timeout]) : timeout;
  let res;
  try {
    res = await fetch(gateway, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
      signal,
    });
  } catch (err) {
    throw new Error(`session gateway unreachable: ${err.message}`);
  }
  if (res.status !== 200) {
    throw new Error(`session gateway answered HTTP ${res.status}; the turn may have ended`);
  }
  const text = await res.text();
  let envelope;
  try {
    envelope = JSON.parse(text.slice(0, 64 * 1024));
  } catch (err) {
    throw new Error(`invalid session gateway reply: ${err.message}`);
  }
  if (envelope.error != null) {
    throw new Error(envelope.error.message);
  }
  // Go 的 envelope.Result 缺字段时取零值。
  const result = envelope.result ?? {};
  return {
    username: result.username ?? "",
    password: result.password ?? "",
    password_expiry_utc: result.password_expiry_utc ?? 0,
    platform: result.platform ?? "",
  };
}

/**
 * 执行 `gh` / `glab` CLI 垫片：在 PATH 中跳过自身目录定位真实二进制，向会话网关请求目标主机令牌并仅注入该子进程的环境变量。
 *
 * @param {string[]} args 子命令参数，首元素必须为 "gh" 或 "glab"，其余透传给目标 CLI。
 * @returns {Promise<number>} 子进程退出码（参数错误返回 2，未找到命令返回 127，执行失败返回 126）。
 */
async function cliShimMain(args) {
  if (args.length === 0 || (args[0] !== "gh" && args[0] !== "glab")) {
    process.stderr.write("usage: agentflow cli-shim <gh|glab> [args...]\n");
    return 2;
  }
  const name = args[0];
  const rest = args.slice(1);
  const self = process.execPath;
  let real;
  try {
    real = lookPathSkipping(name, path.dirname(self), process.env.PATH ?? "");
  } catch {
    process.stderr.write(`${name}: command not found in this workspace; install it or call the platform API with a token from \`git credential fill\`\n`);
    return 127;
  }
  let env = Object.entries(process.env).filter(([, value]) => value !== undefined).map(([key, value]) => key + "=" + value);
  const host = cliShimHost(name, rest, (key) => process.env[key] ?? "", originRemote);
  if (host !== "") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), 30 * 1000);
    let reply = null;
    let err = null;
    try {
      reply = await requestGitCredential(controller.signal, "https", host, name);
    } catch (e) {
      err = e;
    } finally {
      clearTimeout(timer);
    }
    if (err != null) {
      process.stderr.write(`agentflow: no platform token for ${host}: ${err.message}\n`);
    } else if (reply.password !== "") {
      env = cliShimEnv(name, host, reply.password, env);
    }
  }
  const childEnv = {};
  for (const kv of env) {
    const eq = kv.indexOf("=");
    if (eq >= 0) {
      childEnv[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
  }
  // Go 的 syscall.Exec 没有 JS 等价物：同步拉起进程（argv0 设为 name，参数仅传 rest）、继承 stdio 并原样返回退出码。
  const result = spawnSync(real, rest, { argv0: name, stdio: "inherit", env: childEnv });
  if (result.error != null) {
    process.stderr.write(`${name}: ${result.error.message}\n`);
    return 126;
  }
  return result.status ?? 126;
}

/**
 * 在 PATH 环境变量中查找指定名称的可执行文件，同时跳过垫片自身所在目录以防递归调用自己。
 *
 * @param {string} name 可执行文件名（如 "gh"、"glab"）。
 * @param {string} skip 需要跳过的目录路径（垫片自身目录）。
 * @param {string} pathEnv PATH 环境变量字符串。
 * @returns {string} 找到的真实可执行文件完整路径；未找到时抛出错误。
 */
function lookPathSkipping(name, skip, pathEnv) {
  skip = path.normalize(skip);
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === "" || path.normalize(dir) === skip) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      const info = fs.statSync(candidate);
      if (info.isFile() && (info.mode & 0o111) !== 0) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  throw new Error(`exec: ${name}: executable file not found in $PATH`);
}

/**
 * 推断 `gh` 或 `glab` 本次调用将访问的目标平台主机，优先级依次为：主机环境变量、--hostname 参数、带主机的 --repo 参数、当前仓库 origin、默认公网主机。
 *
 * @param {string} name CLI 名称（"gh" 或 "glab"）。
 * @param {string[]} args 传给该 CLI 的参数列表。
 * @param {(key: string) => string} getenv 环境变量读取函数。
 * @param {() => string} origin 获取当前仓库 origin 远端 URL 的函数。
 * @returns {string} 规范化后的目标主机名。
 */
function cliShimHost(name, args, getenv, origin) {
  let vars = ["GH_HOST"];
  let fallback = "github.com";
  if (name === "glab") {
    vars = ["GITLAB_HOST", "GL_HOST"];
    fallback = "gitlab.com";
  }
  for (const key of vars) {
    const host = cliHostScope(getenv(key));
    if (host !== "") {
      return host;
    }
  }
  const hostnameValue = cliFlagValue(args, "--hostname", "");
  if (hostnameValue !== "") {
    return cliHostScope(hostnameValue);
  }
  const repo = cliFlagValue(args, "--repo", "-R");
  if (repo !== "") {
    const host = cliRepoHost(repo);
    if (host !== "") {
      return host;
    }
  }
  const originHost = remoteHost(origin());
  if (originHost !== "") {
    return originHost;
  }
  return fallback;
}

/**
 * 将原始主机字符串规范化为 HTTPS 主机作用域；解析失败时返回空字符串。
 *
 * @param {string} raw 原始主机或 URL 字符串。
 * @returns {string} 规范化后的主机名；非法时返回空字符串。
 */
function cliHostScope(raw) {
  try {
    return HTTPSHostScope(raw);
  } catch {
    return "";
  }
}

/**
 * 从命令行参数列表中提取指定长选项或短选项的值（支持 `--flag val` 与 `--flag=val`，遇到 `--` 停止扫描）。
 *
 * @param {string[]} args 命令行参数数组。
 * @param {string} long 长选项名（如 "--repo"）。
 * @param {string} short 短选项名（如 "-R"；无短选项时为空字符串）。
 * @returns {string} 提取到的选项值；未找到时返回空字符串。
 */
function cliFlagValue(args, long, short) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      break;
    }
    for (const flag of [long, short]) {
      if (flag === "") {
        continue;
      }
      if (arg === flag && i + 1 < args.length) {
        return args[i + 1];
      }
      if (arg.startsWith(flag + "=")) {
        return arg.slice(flag.length + 1);
      }
    }
  }
  return "";
}

/**
 * 从 `HOST/OWNER/REPO` 或完整仓库 URL 中提取主机名；普通的 `OWNER/REPO` 不含主机名则返回空字符串。
 *
 * @param {string} repo `--repo` 参数传入的仓库标识。
 * @returns {string} 规范化后的主机名；无法识别主机时返回空字符串。
 */
function cliRepoHost(repo) {
  if (repo.includes("://")) {
    try {
      const u = new URL(repo);
      return cliHostScope("https://" + u.host);
    } catch {
      return "";
    }
  }
  const parts = repo.split("/");
  if (parts.length >= 3 && (parts[0].includes(".") || parts[0].startsWith("["))) {
    return cliHostScope(parts[0]);
  }
  return "";
}

/**
 * 解析 HTTPS 或 SSH 格式 Git 远端地址对应的平台 API 主机名。
 *
 * @param {string} remote Git 远端 URL 字符串。
 * @returns {string} 规范化后的平台主机名；无法解析时返回空字符串。
 */
function remoteHost(remote) {
  const [host, ok] = HTTPSRemoteHost(remote);
  if (ok) {
    return host;
  }
  try {
    const parsed = ParseSSHRemote(remote);
    return cliHostScope(parsed.Host);
  } catch {
    return "";
  }
}

/**
 * 执行 `git remote get-url origin` 获取当前目录 Git 仓库的 origin 远端地址（超时 5 秒）。
 *
 * @returns {string} 去空白后的 origin URL；命令失败或不在仓库内时返回空字符串。
 */
function originRemote() {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", timeout: 5 * 1000 });
  if (result.error != null || result.status !== 0) {
    return "";
  }
  return (result.stdout ?? "").trim();
}

/**
 * 构造注入目标主机令牌后的环境变量列表，替换已继承的同名令牌或主机变量。
 *
 * @param {string} name CLI 名称（"gh" 或 "glab"）。
 * @param {string} host 目标平台主机名。
 * @param {string} token 待注入的平台访问令牌。
 * @param {string[]} env 原始 `KEY=VALUE` 环境变量数组。
 * @returns {string[]} 替换并追加令牌变量后的新环境变量数组。
 */
function cliShimEnv(name, host, token, env) {
  const set = {};
  if (name === "glab") {
    set["GITLAB_TOKEN"] = token;
    set["GITLAB_HOST"] = "https://" + host;
  } else if (host === "github.com") {
    set["GH_TOKEN"] = token;
  } else {
    set["GH_ENTERPRISE_TOKEN"] = token;
    set["GH_HOST"] = host;
  }
  const out = [];
  for (const kv of env) {
    const eq = kv.indexOf("=");
    const key = eq < 0 ? kv : kv.slice(0, eq);
    if (!Object.prototype.hasOwnProperty.call(set, key)) {
      out.push(kv);
    }
  }
  for (const [key, value] of Object.entries(set)) {
    out.push(key + "=" + value);
  }
  return out;
}

module.exports = { SessionGatewayEnv, GitHostsEnv, gitCredentialMethod, RunGitHelperCLI, gitCredentialMain, readGitCredentialAttrs, requestGitCredential, cliShimMain, lookPathSkipping, cliShimHost, cliHostScope, cliFlagValue, cliRepoHost, remoteHost, originRemote, cliShimEnv };
