// git_credential_helper.js —— 对应 Go 文件：internal/runtime/git_credential_helper.go
// 作用：工作区内隐藏的 Git 凭据 helper 与 gh/glab 垫片：向会话网关取凭据、只给单个进程注入 token。
// Go 的 (值, error) 译为成功返回值、失败 throw；(值, bool) 译为 [值, bool]；context.Context 译为 AbortSignal；
// net/http 译为 fetch（默认不走代理，对应 Transport{Proxy: nil}）；syscall.Exec 没有 JS 等价物，译为 spawnSync + 原样返回退出码；
// 网关回包按 JSON 字段名（username/password/…）取用；Go 的 os.Stdout/os.Stderr 是同步写，Node 的 process.stdout.write 写管道时是异步的，
// 故 RunGitHelperCLI 给 gitCredentialMain 传同步写出器，避免 process.exit 丢弃未刷新的凭据输出。

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process"); // Go os/exec
const { HTTPSHostScope, HTTPSRemoteHost } = require("../gitwork/https_host.js"); // 对应 Go 的 gitwork.HTTPSHostScope/HTTPSRemoteHost，https_host.js 待翻译
const { ParseSSHRemote } = require("../gitwork/ssh_remote.js"); // 对应 Go 的 gitwork.ParseSSHRemote，ssh_remote.js 待翻译

const SessionGatewayEnv = "AGENTFLOW_SESSION_GATEWAY";
const GitHostsEnv = "AGENTFLOW_GIT_HOSTS";

const gitCredentialMethod = "agentflow/gitCredential";

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
    clearTimeout(timer);
    return 0;
  }
  clearTimeout(timer);
  if (reply.password === "" || /[\r\n\x00]/.test(reply.username + reply.password)) {
    return 0;
  }
  out.write(`username=${reply.username}\npassword=${reply.password}\n`);
  if (reply.password_expiry_utc > 0) {
    out.write(`password_expiry_utc=${reply.password_expiry_utc}\n`);
  }
  return 0;
}

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

async function requestGitCredential(ctx, protocol, host, caller) {
  const gateway = (process.env[SessionGatewayEnv] ?? "").trim();
  if (gateway === "") {
    throw new Error("not running in a LoopForge workspace turn");
  }
  // Go 的 http.NewRequestWithContext：网关 URL 非法时直接返回该错误。
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
    }
    clearTimeout(timer);
    if (err != null) {
      process.stderr.write(`agentflow: no platform token for ${host}: ${err.message}\n`);
    } else if (reply.password !== "") {
      env = cliShimEnv(name, host, reply.password, env);
    }
  }
  const childEnv = {};
  for (const kv of env) {
    const eq = kv.indexOf("=");
    childEnv[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  // Go 的 syscall.Exec 没有 JS 等价物：同步拉起进程、继承 stdio，退出码原样返回，RunGitHelperCLI 再以该码退出。
  const result = spawnSync(real, [name, ...rest], { stdio: "inherit", env: childEnv });
  if (result.error != null) {
    process.stderr.write(`${name}: ${result.error.message}\n`);
    return 126;
  }
  return result.status ?? 126;
}

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

function cliHostScope(raw) {
  try {
    return HTTPSHostScope(raw);
  } catch {
    return "";
  }
}

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

function originRemote() {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", timeout: 5 * 1000 });
  if (result.error != null || result.status !== 0) {
    return "";
  }
  return (result.stdout ?? "").trim();
}

function cliShimEnv(name, host, token, env) {
  const set = Object.create(null);
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
    if (!(key in set)) {
      out.push(kv);
    }
  }
  for (const [key, value] of Object.entries(set)) {
    out.push(key + "=" + value);
  }
  return out;
}

module.exports = { SessionGatewayEnv, GitHostsEnv, gitCredentialMethod, RunGitHelperCLI, gitCredentialMain, readGitCredentialAttrs, requestGitCredential, cliShimMain, lookPathSkipping, cliShimHost, cliHostScope, cliFlagValue, cliRepoHost, remoteHost, originRemote, cliShimEnv };
