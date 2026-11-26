// conversation_runner_login.js —— 对应 Go 文件：internal/runtime/conversation_runner_login.go
// 作用：把执行机器上已登录的 CLI 账号文件复制进隔离会话家目录，支持 OAuth 续期。
// context.Context 译为 AbortSignal（context.Background() 译为 null）；(值, error) 译为成功返回值、失败 throw；
// (值, bool) 译为 [值, bool]；errors.Is 译为 ===；os.ErrNotExist 译为 code 为 ENOENT 的 Error；
// log.Printf 译为 console.log；defer 译为 try/finally；Go 按值传递的结构体在 JS 里先复制再改。

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 与 agent_cli.js 循环引用，整模块引用、调用时再取属性，避免加载时解构到未完成导出的值。
const agentCLI = require("./agent_cli.js"); // 对应 Go 同包常量与函数，agent_cli.js 已翻译
const { BindCodex, BindClaudeCode, BindAgentCLI } = require("./runtime.js"); // 对应 Go 同包常量，runtime.js 待翻译
const { PrivateHomeName, privateHomePaths } = require("./command_binding.js"); // 对应 Go 同包函数，command_binding.js 已翻译
const { EnsureControlDirectory } = require("./materialize.js"); // 对应 Go 同包函数，materialize.js 待翻译
const { sandboxDriver } = require("./runner.js"); // 对应 Go 同包函数，runner.js 待翻译
const { readAntigravityRunnerLogin } = require("./runner_login_antigravity.js"); // 对应 Go 同包函数，runner_login_antigravity.js 待翻译
const { fileRunnerLoginSource, parseRunnerOAuth, nativeRunnerLogins } = require("./runner_login_manager.js"); // 对应 Go 同包函数与变量，runner_login_manager.js 待翻译
const { newRunnerLoginLease } = require("./runner_login_lease.js"); // 对应 Go 同包函数，runner_login_lease.js 待翻译

class conversationLoginSpec {
  constructor(init = {}) {
    this.label = init.label ?? "";
    this.dir = init.dir ?? "";
    this.file = init.file ?? "";
    this.configEnv = init.configEnv ?? "";
    this.binding = init.binding ?? "";
  }
}

function runnerLoginSpec(provider) {
  switch (provider) {
    case "codex":
      return [new conversationLoginSpec({ label: "Codex", dir: ".codex", file: "auth.json", configEnv: "CODEX_HOME", binding: BindCodex }), true];
    case "claude-code":
      return [new conversationLoginSpec({ label: "Claude Code", dir: ".claude", file: ".credentials.json", configEnv: "CLAUDE_CONFIG_DIR", binding: BindClaudeCode }), true];
    case agentCLI.AgentCLIAntigravity:
      return [new conversationLoginSpec({ label: "Antigravity", dir: ".gemini/antigravity-cli", file: "antigravity-oauth-token", configEnv: "", binding: BindAgentCLI }), true];
    default:
      return [new conversationLoginSpec({}), false];
  }
}

// 只把原生 CLI 的登录文件复制进隔离的会话家目录；跑在执行机器上，文件不走控制连接，也不进同步的资产集。
function prepareConversationRunnerLogin(root, login, enabled, ...docker) {
  return prepareRunnerLogin(new agentCLI.AgentCLIHome({ Base: root, Rel: "home" }), login, enabled, ...docker);
}

// PrepareRunnerSandboxLogin 把选定 CLI 的登录放到节点的私有家目录；登录文件被删后，CLI 还能在下一次尝试时恢复会话；检查点排除这个控制目录。
function PrepareRunnerSandboxLogin(sandbox, provider, runID, nodeID) {
  const [login, supported] = runnerLoginSpec(provider);
  if (!supported) {
    return [null, null];
  }
  const scope = crypto.createHash("sha256").update(runID + "\x00" + nodeID, "utf8").digest();
  const home = agentCLI.WorkspaceAgentCLIHome(sandbox.Workspace(), `${provider}-login-${scope.subarray(0, 12).toString("hex")}`);
  const [cleanup, env] = prepareRunnerLogin(home, login, true, sandboxDriver(sandbox) === "docker");
  const outEnv = env ?? {};
  let homePath = home.Path();
  if (sandboxDriver(sandbox) === "docker") {
    homePath = path.join("/workspace", home.Rel).split(path.sep).join("/");
  }
  outEnv["HOME"] = homePath;
  if (login.configEnv !== "") {
    outEnv[login.configEnv] = path.join(homePath, login.dir).split(path.sep).join("/");
  }
  return [outEnv, cleanup];
}

// Agent CLI 把 MCP 与会话配置放在 Agent 现有的 HOME 里；账号认证放到那里，而不是替换整个 HOME。
function PrepareRunnerAgentCLILogin(sandbox, command) {
  const [login, supported] = runnerLoginSpec(command.Provider);
  if (!supported || !agentCLI.IsAgentCLI(command.Provider)) {
    throw new Error("该 CLI 不支持使用执行机器的本机登录");
  }
  const home = agentCLI.WorkspaceAgentCLIHome(sandbox.Workspace(), PrivateHomeName(command));
  const [cleanup, env] = prepareRunnerLogin(home, login, true);
  const [, homeEnv] = privateHomePaths(sandbox, sandbox.Workspace(), command);
  env["HOME"] = homeEnv;
  const tmp = EnsureControlDirectory(sandbox.Workspace(), "tmp", PrivateHomeName(command));
  env["TMPDIR"] = tmp;
  if (sandboxDriver(sandbox) === "docker") {
    env["TMPDIR"] = path.join("/workspace", ".agentflow", "tmp", PrivateHomeName(command)).split(path.sep).join("/");
  }
  return [env, cleanup];
}

function prepareRunnerLogin(home, login, enabled, ...docker) {
  // Go：home 是按值传递的结构体，改 Rel 只影响本地副本；JS 对象按引用传递，故先复制。
  home = new agentCLI.AgentCLIHome({ Base: home.Base, Rel: path.join(home.Rel, login.dir) });
  const target = agentCLI.openAgentCLIHome(home);
  try {
    const remove = (dir) => {
      try {
        dir.Remove(login.file);
      } catch (err) {
        if (err.code !== "ENOENT") {
          throw err;
        }
      }
    };
    // Runner 重启可能打断清理；即使这次改用个人密钥，也先删掉上一次的副本。
    remove(target);
    if (!enabled) {
      return [null, null];
    }
    if (login.binding === BindClaudeCode) {
      const token = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
      if (token !== "") {
        return [null, { CLAUDE_CODE_OAUTH_TOKEN: token }];
      }
    }
    let configDir = (process.env[login.configEnv] ?? "").trim();
    if (configDir === "") {
      let base = "";
      try {
        base = os.homedir();
      } catch {
        // Go：忽略 os.UserHomeDir 的错误。
      }
      if (base !== "") {
        configDir = path.join(base, login.dir);
      }
    }
    let data = null;
    let keepAntigravity = null;
    try {
      if (login.binding === BindAgentCLI) {
        [data, keepAntigravity] = readAntigravityRunnerLogin();
      } else {
        data = readRunnerLoginFile(configDir, login.file);
      }
    } catch (err) {
      throw new Error(`执行机器上的 ${login.label} 本机登录态不可用，请检查 Runner 账户的 CLI 登录`);
    }
    if (login.binding === BindCodex || login.binding === BindClaudeCode) {
      const source = fileRunnerLoginSource(login, configDir);
      let oauthOK = false;
      try {
        parseRunnerOAuth(source.provider, data);
        oauthOK = true;
      } catch {
        // Go：解析失败时走下面的不完整凭证检查。
      }
      if (oauthOK) {
        // Go：context.WithTimeout(context.Background(), 35*time.Second) 译为 AbortSignal.timeout。
        const leaseCtx = AbortSignal.timeout(35000);
        let lease;
        try {
          lease = newRunnerLoginLease(leaseCtx, nativeRunnerLogins, source, docker.length > 0 && docker[0]);
        } catch (leaseErr) {
          throw new Error(`执行机器上的 ${login.label} 登录暂时无法续期：${leaseErr.message}`);
        }
        let credential;
        try {
          credential = lease.credential();
        } catch (credentialErr) {
          lease.close();
          throw credentialErr;
        }
        try {
          target.WriteFile(login.file, credential, 0o600);
        } catch (credentialErr) {
          lease.close();
          throw credentialErr;
        }
        return [() => {
          lease.close();
          const dir = agentCLI.openAgentCLIHome(home);
          try {
            // 只有受信的刷新管理器才能更新宿主登录。
            remove(dir);
          } finally {
            dir.Close();
          }
        }, lease.environment()];
      }
      let incomplete = {};
      try {
        incomplete = JSON.parse(data.toString("utf8"));
      } catch {
        // Go：忽略 Unmarshal 错误。
      }
      if ((incomplete.tokens?.refresh_token ?? "") !== "" || (incomplete.claudeAiOauth?.refreshToken ?? "") !== "") {
        throw new Error(`执行机器上的 ${login.label} OAuth 凭证不完整，请重新登录 CLI`);
      }
    }
    const cleanup = () => {
      const dir = agentCLI.openAgentCLIHome(home);
      try {
        // 只有 Antigravity 经过验证的稳定刷新令牌流程才接受沙箱的更新；其他被改过的文件永不提升为宿主凭据。
        let keepErr = null;
        if (keepAntigravity != null) {
          let refreshed = null;
          let readErr = null;
          try {
            refreshed = readRootLoginFile(dir, login.file);
          } catch (err) {
            readErr = err;
          }
          if (readErr == null) {
            try {
              keepAntigravity(refreshed);
            } catch (err) {
              keepErr = err;
            }
          }
        } else {
          try {
            writeBackRefreshedLogin(dir, login, configDir, data);
          } catch (err) {
            keepErr = err;
          }
        }
        if (keepErr != null) {
          console.log(`runner login: keep refreshed ${login.label} login: ${keepErr.message}`);
        }
        remove(dir);
      } finally {
        dir.Close();
      }
    };
    try {
      target.WriteFile(login.file, data, 0o600);
    } catch (err) {
      throw new Error(`无法准备 ${login.label} 的本机登录态`);
    }
    if (login.binding === BindAgentCLI) {
      // 官方 CLI 在远程会话里选文件存储；这也防止沙箱去打开宿主操作系统的凭据库。
      const env = { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" };
      for (const key of agentCLI.agentCLIHostEnv) {
        env[key] = "";
      }
      // 上一轮 API 密钥可能选了直连 Gemini API。
      try {
        target.WriteFile("settings.json", Buffer.from("{}", "utf8"), 0o600);
      } catch (err) {
        throw new Error("无法准备 Antigravity 的账号登录配置");
      }
      return [cleanup, env];
    }
    return [cleanup, null];
  } finally {
    target.Close();
  }
}

function readRunnerLoginFile(dir, name) {
  if (dir === "") {
    const err = new Error("file does not exist");
    err.code = "ENOENT";
    throw err;
  }
  const maxSize = 1 << 20;
  const filePath = path.join(dir, name);
  const fi = fs.statSync(filePath);
  if (!fi.isFile() || fi.size > maxSize) {
    throw new Error("invalid login file");
  }
  // Go：os.Open + io.ReadAll(io.LimitReader(file, maxSize+1))；上面已校验大小，故直接读盘等价。
  const data = fs.readFileSync(filePath);
  if (data.length > maxSize || !jsonValid(data)) {
    throw new Error("invalid login file");
  }
  return data;
}

// 非托管的静态登录副本不能替换宿主凭据；OAuth 对由受信管理器刷新，沙箱里的 JSON 永远不是颁发者的响应。
function writeBackRefreshedLogin(dir, login, configDir, original) {
  let refreshed;
  try {
    refreshed = readRootLoginFile(dir, login.file);
  } catch {
    return;
  }
  if (refreshed.equals(original)) {
    return;
  }
  throw new Error("sandbox login changes cannot replace Runner credentials");
}

function replaceRunnerLoginFile(configDir, name, original, refreshed) {
  if (configDir === "") {
    return;
  }
  const filePath = path.join(configDir, name);
  let current;
  try {
    current = readRunnerLoginFile(configDir, name);
  } catch {
    return;
  }
  if (!current.equals(original)) {
    return;
  }
  // Go：os.CreateTemp 用随机后缀建临时文件；JS 直接拼一个随机名。
  const tmpPath = path.join(configDir, `.${name}.refresh-${crypto.randomBytes(6).toString("hex")}`);
  const tmp = fs.openSync(tmpPath, "wx", 0o600);
  try {
    fs.fchmodSync(tmp, 0o600);
    fs.writeSync(tmp, refreshed);
    fs.fsyncSync(tmp);
    fs.closeSync(tmp);
  } catch (err) {
    try {
      fs.closeSync(tmp);
    } catch {
      // Go：出错时先 Close 再返回，defer 的 Remove 随后删临时文件。
    }
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Go：defer os.Remove(tmp.Name())，忽略错误。
    }
    throw err;
  }
  // 交换前再校验一次，把与宿主并发刷新的窗口压到最小。
  try {
    current = readRunnerLoginFile(configDir, name);
  } catch {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Go：defer os.Remove(tmp.Name())，忽略错误。
    }
    return;
  }
  if (!current.equals(original)) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Go：defer os.Remove(tmp.Name())，忽略错误。
    }
    return;
  }
  fs.renameSync(tmpPath, filePath);
  const dir = fs.openSync(configDir, "r");
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}

// readRootLoginFile 经 os.Root 读隔离家目录下的登录文件，沙箱种下的符号链接指不到别处。
function readRootLoginFile(dir, name) {
  const maxSize = 1 << 20;
  const info = dir.Lstat(name);
  if (!info.isFile() || info.size > maxSize) {
    throw new Error("invalid login file");
  }
  // Go：dir.Open + io.ReadAll(io.LimitReader)；大小已由 Lstat 校验，改用已翻译的 Root.ReadFile 等价读盘。
  const data = dir.ReadFile(name);
  if (data.length > maxSize || !jsonValid(data)) {
    throw new Error("invalid login file");
  }
  return data;
}

// jsonValid：Go 的 json.Valid；JS 用 JSON.parse 试解析。
function jsonValid(data) {
  try {
    JSON.parse(data.toString("utf8"));
    return true;
  } catch {
    return false;
  }
}

module.exports = { conversationLoginSpec, runnerLoginSpec, prepareConversationRunnerLogin, PrepareRunnerSandboxLogin, PrepareRunnerAgentCLILogin, prepareRunnerLogin, readRunnerLoginFile, writeBackRefreshedLogin, replaceRunnerLoginFile, readRootLoginFile, jsonValid };
