/**
 * @file internal/runtime/conversation_runner_login.js
 * @description 对应 Go 源文件：internal/runtime/conversation_runner_login.go
 *
 * 职责与边界：
 * 负责将执行机器上已登录的 CLI 账号凭据（Codex、Claude Code、Antigravity）安全复制到隔离的会话或工作区私有 HOME 中，
 * 支持经 OAuth 续期管理器签发租约、运行结束后清理凭据副本，以及仅在受信任路径下安全回写刷新后的登录文件。
 * 不负责 OAuth 刷新协议本身或 Antigravity 密钥链读取（分别位于 `runner_login_manager.js`、`runner_login_lease.js` 与 `runner_login_antigravity.js`）。
 *
 * 语法差异说明：
 * - `context.Context` 译为 `AbortSignal`（`context.Background()` 译为 `null`）；`context.WithTimeout` 译为 `AbortSignal.timeout`。
 * - `(值, error)` 译为成功返回值、失败抛出 `Error`；`(值1, 值2, error)` 译为成功返回二元组 `[值1, 值2]`、失败抛出 `Error`；`(值, bool)` 译为 `[值, boolean]`。
 * - `errors.Is` 译为 `===`；`os.ErrNotExist` 译为 `code === "ENOENT"` 的 `Error`；`errors.Join` 译为 `AggregateError`。
 * - `log.Printf` 译为 `console.log`；`defer` 译为 `try/finally`；Go 按值传递的 `AgentCLIHome` 结构体在 JS 中先复制再修改 `Rel`。
 * - 与 `agent_cli.js` 存在同包循环依赖，调用时在函数内延迟 `require("./agent_cli.js")`。
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { BindCodex, BindClaudeCode, BindAgentCLI } = require("./runtime.js"); // 对应 Go 同包常量，runtime.js 待翻译
const { PrivateHomeName, privateHomePaths } = require("./command_binding.js"); // 对应 Go 同包函数，command_binding.js 已翻译
const { EnsureControlDirectory } = require("./materialize.js"); // 对应 Go 同包函数，materialize.js 待翻译
const { sandboxDriver } = require("./runner.js"); // 对应 Go 同包函数，runner.js 待翻译
const { readAntigravityRunnerLogin } = require("./runner_login_antigravity.js"); // 对应 Go 同包函数，runner_login_antigravity.js 待翻译
const { fileRunnerLoginSource, parseRunnerOAuth, nativeRunnerLogins } = require("./runner_login_manager.js"); // 对应 Go 同包函数与变量，runner_login_manager.js 待翻译
const { newRunnerLoginLease } = require("./runner_login_lease.js"); // 对应 Go 同包函数，runner_login_lease.js 待翻译

/**
 * 单个 CLI 供应商本机登录态的目录、文件名、环境变量与凭据绑定规格。
 * 由 `runnerLoginSpec` 返回并传递给登录准备流程。
 */
class conversationLoginSpec {
  /**
   * 构造 `conversationLoginSpec` 实例，按 Go 零值初始化各字段。
   * 在查找支持的本机登录规格时调用。
   *
   * @param {object} [init={}] 初始字段对象。
   */
  constructor(init = {}) {
    this.label = init.label ?? "";
    this.dir = init.dir ?? "";
    this.file = init.file ?? "";
    this.configEnv = init.configEnv ?? "";
    this.binding = init.binding ?? "";
  }
}

/**
 * 根据供应商标识查询其本机登录态规格。
 * 在对话进程启动、沙箱节点准备及模型探测前判断该 CLI 是否支持复用执行机器本机登录时调用。
 *
 * @param {string} provider CLI 供应商标识（如 `"codex"`、`"claude-code"`、`"agy"`）。
 * @returns {[conversationLoginSpec, boolean]} 二元组 `[登录规格, 是否支持]`。
 */
function runnerLoginSpec(provider) {
  const { AgentCLIAntigravity } = require("./agent_cli.js");
  switch (provider) {
    case "codex":
      return [new conversationLoginSpec({ label: "Codex", dir: ".codex", file: "auth.json", configEnv: "CODEX_HOME", binding: BindCodex }), true];
    case "claude-code":
      return [new conversationLoginSpec({ label: "Claude Code", dir: ".claude", file: ".credentials.json", configEnv: "CLAUDE_CONFIG_DIR", binding: BindClaudeCode }), true];
    case AgentCLIAntigravity:
      return [new conversationLoginSpec({ label: "Antigravity", dir: ".gemini/antigravity-cli", file: "antigravity-oauth-token", configEnv: "", binding: BindAgentCLI }), true];
    default:
      return [new conversationLoginSpec({}), false];
  }
}

/**
 * 仅将原生 CLI 的登录文件复制到隔离的会话家目录（`<root>/home`）。
 * 在执行机器上本地运行，凭据文件不经控制连接传输，也不会进入同步资产集合。
 *
 * @param {string} root 会话根目录路径。
 * @param {conversationLoginSpec} login CLI 登录态规格。
 * @param {boolean} enabled 是否启用本机登录（为 `false` 时仅清理历史副本）。
 * @param {...boolean} docker 可选参数，首位为 `true` 表示运行在 Docker 沙箱中。
 * @returns {[Function|null, Record<string, string>|null]} 二元组 `[清理函数或 null, 需注入的环境变量映射或 null]`。
 */
function prepareConversationRunnerLogin(root, login, enabled, ...docker) {
  const { AgentCLIHome } = require("./agent_cli.js");
  return prepareRunnerLogin(new AgentCLIHome({ Base: root, Rel: "home" }), login, enabled, ...docker);
}

/**
 * 将选定 CLI 的本机登录态暂存到工作区节点的私有家目录中。
 * 登录文件在运行结束后会被清理，但 CLI 仍可在后续重试时恢复会话；检查点会排除该控制目录。
 *
 * @param {object} sandbox 沙箱实例。
 * @param {string} provider CLI 供应商标识。
 * @param {string} runID 运行 ID。
 * @param {string} nodeID 节点 ID。
 * @returns {[Record<string, string>|null, Function|null]} 二元组 `[需注入的环境变量映射或 null, 清理函数或 null]`；不支持该供应商时返回 `[null, null]`。
 */
function PrepareRunnerSandboxLogin(sandbox, provider, runID, nodeID) {
  const { WorkspaceAgentCLIHome } = require("./agent_cli.js");
  const [login, supported] = runnerLoginSpec(provider);
  if (!supported) {
    return [null, null];
  }
  const scope = crypto.createHash("sha256").update(runID + "\x00" + nodeID, "utf8").digest();
  const home = WorkspaceAgentCLIHome(sandbox.Workspace(), `${provider}-login-${scope.subarray(0, 12).toString("hex")}`);
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

/**
 * 为扩展 Agent CLI 在其既有私有 HOME 中暂存账号登录态，而不替换已有 MCP 与会话配置。
 * 在工作流节点使用本机登录运行扩展 Agent CLI 前调用。
 *
 * @param {object} sandbox 沙箱实例。
 * @param {object} command 命令规格对象（需包含 `Provider` 等字段）。
 * @returns {[Record<string, string>, Function|null]} 二元组 `[需注入的环境变量映射, 清理函数或 null]`。
 */
function PrepareRunnerAgentCLILogin(sandbox, command) {
  const { IsAgentCLI, WorkspaceAgentCLIHome } = require("./agent_cli.js");
  const [login, supported] = runnerLoginSpec(command.Provider);
  if (!supported || !IsAgentCLI(command.Provider)) {
    throw new Error("该 CLI 不支持使用执行机器的本机登录");
  }
  const home = WorkspaceAgentCLIHome(sandbox.Workspace(), PrivateHomeName(command));
  const [cleanup, env] = prepareRunnerLogin(home, login, true);
  const [, homeEnv] = privateHomePaths(sandbox, sandbox.Workspace(), command);
  env["HOME"] = homeEnv;
  let tmp;
  try {
    tmp = EnsureControlDirectory(sandbox.Workspace(), "tmp", PrivateHomeName(command));
  } catch (err) {
    if (cleanup != null) {
      try {
        cleanup();
      } catch (cleanupErr) {
        throw new AggregateError([err, cleanupErr]);
      }
    }
    throw err;
  }
  env["TMPDIR"] = tmp;
  if (sandboxDriver(sandbox) === "docker") {
    env["TMPDIR"] = path.join("/workspace", ".agentflow", "tmp", PrivateHomeName(command)).split(path.sep).join("/");
  }
  return [env, cleanup];
}

/**
 * 核心本机登录态准备函数：先清理残留副本，再按供应商类型通过环境变量、OAuth 租约或安全文件复制方式写入隔离 HOME。
 * 由 `prepareConversationRunnerLogin`、`PrepareRunnerSandboxLogin`、`PrepareRunnerAgentCLILogin` 及 `agent_cli.js` 调用。
 *
 * @param {AgentCLIHome} home 目标隔离家目录描述对象。
 * @param {conversationLoginSpec} login CLI 登录态规格。
 * @param {boolean} enabled 是否启用本机登录；为 `false` 时仅删除残留文件并返回 `[null, null]`。
 * @param {...boolean} docker 可选参数，首位为 `true` 表示运行在 Docker 沙箱中。
 * @returns {[Function|null, Record<string, string>|null]} 二元组 `[清理函数或 null, 需注入的环境变量映射或 null]`。
 */
function prepareRunnerLogin(home, login, enabled, ...docker) {
  const { AgentCLIHome, openAgentCLIHome, agentCLIHostEnv } = require("./agent_cli.js");
  // Go：home 是按值传递的结构体，改 Rel 只影响本地副本；JS 对象按引用传递，故先复制。
  home = new AgentCLIHome({ Base: home.Base, Rel: path.join(home.Rel, login.dir) });
  const target = openAgentCLIHome(home);
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
    } catch {
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
          const dir = openAgentCLIHome(home);
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
      const dir = openAgentCLIHome(home);
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
    } catch {
      const writeErr = new Error(`无法准备 ${login.label} 的本机登录态`);
      try {
        cleanup();
      } catch (cleanupErr) {
        throw new AggregateError([writeErr, cleanupErr]);
      }
      throw writeErr;
    }
    if (login.binding === BindAgentCLI) {
      // 官方 CLI 在远程会话里选文件存储；这也防止沙箱去打开宿主操作系统的凭据库。
      const env = { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" };
      for (const key of agentCLIHostEnv) {
        env[key] = "";
      }
      // 上一轮 API 密钥可能选了直连 Gemini API。
      try {
        target.WriteFile("settings.json", Buffer.from("{}", "utf8"), 0o600);
      } catch {
        const settingsErr = new Error("无法准备 Antigravity 的账号登录配置");
        try {
          cleanup();
        } catch (cleanupErr) {
          throw new AggregateError([settingsErr, cleanupErr]);
        }
        throw settingsErr;
      }
      return [cleanup, env];
    }
    return [cleanup, null];
  } finally {
    target.Close();
  }
}

/**
 * 从宿主配置目录读取并校验 JSON 格式的本机登录文件（限制为普通文件且不超过 1 MiB）。
 * 在 `prepareRunnerLogin` 与 `replaceRunnerLoginFile` 中读取宿主机登录文件时调用。
 *
 * @param {string} dir 配置目录路径。
 * @param {string} name 登录文件名。
 * @returns {Buffer} 合法的登录文件原始字节内容。
 */
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

/**
 * 检查隔离家目录中的非托管登录文件是否被沙箱修改；若被修改则拒绝回写宿主凭据。
 * 在静态/非托管登录清理阶段由 `cleanup` 回调调用。
 *
 * @param {Root} dir 隔离家目录的安全根句柄。
 * @param {conversationLoginSpec} login CLI 登录态规格。
 * @param {string} configDir 宿主机配置目录路径。
 * @param {Buffer} original 启动前复制进去的原始凭据字节。
 * @returns {void} 未发生变化或文件不存在时无返回值；若沙箱篡改了文件内容则抛出错误。
 */
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

/**
 * 在宿主机配置目录中原地原子替换登录文件（仅当当前文件内容仍与 `original` 一致时才生效）。
 * 在受信任的刷新流程需要把刷新后的登录态原子写回宿主机时调用。
 *
 * @param {string} configDir 宿主机配置目录路径。
 * @param {string} name 登录文件名。
 * @param {Buffer} original 预期当前磁盘上的原始内容（用于 CAS 校验）。
 * @param {Buffer} refreshed 刷新后的新内容。
 * @returns {void} 替换完成或检测到并发变更跳过时无返回值；磁盘操作异常时抛出错误。
 */
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
    let closed = false;
    try {
      fs.fchmodSync(tmp, 0o600);
      fs.writeSync(tmp, refreshed);
      fs.fsyncSync(tmp);
      fs.closeSync(tmp);
      closed = true;
    } finally {
      if (!closed) {
        try {
          fs.closeSync(tmp);
        } catch {
          // Go：出错时先 Close 再返回，defer 的 Remove 随后删临时文件。
        }
      }
    }
    // 交换前再校验一次，把与宿主并发刷新的窗口压到最小。
    try {
      current = readRunnerLoginFile(configDir, name);
    } catch {
      return;
    }
    if (!current.equals(original)) {
      return;
    }
    fs.renameSync(tmpPath, filePath);
    const dir = fs.openSync(configDir, "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Go：defer os.Remove(tmp.Name())，忽略错误。
    }
  }
}

/**
 * 通过安全根句柄 `dir` 读取隔离家目录下的登录文件，防止沙箱植入的符号链接指向目录外。
 * 在清理阶段检查沙箱内登录文件变更时调用。
 *
 * @param {Root} dir 隔离家目录的安全根句柄。
 * @param {string} name 登录文件名。
 * @returns {Buffer} 合法的登录文件原始字节内容。
 */
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

/**
 * 校验给定字节缓冲是否为合法 JSON，对应 Go 标准库的 `json.Valid`。
 * 在 `readRunnerLoginFile` 与 `readRootLoginFile` 验证登录文件完整性时调用。
 *
 * @param {Buffer} data 待校验的原始字节数据。
 * @returns {boolean} 合法 JSON 返回 `true`，否则返回 `false`。
 */
function jsonValid(data) {
  try {
    JSON.parse(data.toString("utf8"));
    return true;
  } catch {
    return false;
  }
}

module.exports = { conversationLoginSpec, runnerLoginSpec, prepareConversationRunnerLogin, PrepareRunnerSandboxLogin, PrepareRunnerAgentCLILogin, prepareRunnerLogin, readRunnerLoginFile, writeBackRefreshedLogin, replaceRunnerLoginFile, readRootLoginFile, jsonValid };
