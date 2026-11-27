/**
 * @file 对应 Go 源文件：internal/runtime/conversation_login_models.go
 * 职责边界：复用与会话相同的登录来源，在空临时目录与私有 HOME 下调用 Runner 本机 CLI，
 * 探测 Antigravity、Codex、Claude Code 账号当前可用的模型列表及推理强度选项。
 * 语法差异说明：
 * - Go 的 context.Context 译为 AbortSignal，context.WithTimeout 译为 withTimeout；
 * - Go 的 (值, error) 返回值译为成功直接返回、失败 throw Error；
 * - Go 的阻塞 StdinPipe/StdoutPipe 与 bufio.Scanner 译为 async 函数与行队列扫描器；
 * - Go 的 map[string]bool 去重集合译为普通对象 {}。
 */

"use strict";

const fs = require("node:fs"); // Go os
const os = require("node:os"); // Go os
const path = require("node:path"); // Go path/filepath
const readline = require("node:readline"); // Go bufio.Scanner
const { spawn, spawnSync } = require("node:child_process"); // Go os/exec

const { CLIModel } = require("../domain/user.js"); // 对应 Go 的 domain.CLIModel，user.js 已翻译
const { AgentCLIAntigravity } = require("./agent_cli.js"); // 对应 Go 同包常量，agent_cli.js 已翻译
const { BindClaudeCode, BindCodex } = require("./runtime.js"); // 对应 Go 同包常量，runtime.js 待翻译
const { runnerLoginSpec, prepareConversationRunnerLogin } = require("./conversation_runner_login.js"); // 对应 Go 同包函数，conversation_runner_login.js 待翻译
const { appendEnvironment } = require("./sandbox_process.js"); // 对应 Go 同包函数，sandbox_process.js 待翻译
const { terminalBaseEnvironment } = require("./workspace_terminal_sandbox.js"); // 对应 Go 同包函数，workspace_terminal_sandbox.js 待翻译

/**
 * 基于父级取消信号构造带超时控制的派生 AbortSignal，对应 Go 的 context.WithTimeout。
 * 使用场景：为查询账号模型的子进程执行设置 15 秒总超时上限。
 * @param {AbortSignal|null|undefined} ctx 父级取消信号，可为空。
 * @param {number} ms 超时毫秒数。
 * @returns {[AbortSignal, function(): void]} 二元组 [signal, cancel]，分别为派生信号与清理定时器的取消函数。
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
 * 创建带总量（2MiB）与单行（1MiB）字节上限的异步按行扫描器，对应 Go 的 bufio.Scanner(io.LimitReader(...))。
 * 使用场景：逐行读取 Codex 或 Claude Code 子进程标准输出的 JSON-RPC / stream-json 响应。
 * @param {import("node:stream").Readable} stream 子进程的标准输出可读流。
 * @returns {{current: string|null, Scan: function(): Promise<boolean>, Bytes: function(): Buffer, Close: function(): void}} 具备 Scan、Bytes、Close 方法的扫描器对象。
 */
function newLoginScanner(stream) {
  const lines = [];
  const waiters = [];
  let ended = false;
  let failed = false;
  let total = 0;
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  rl.on("line", (line) => {
    total += Buffer.byteLength(line, "utf8") + 1;
    if (total > 2 << 20) {
      failed = true;
      rl.close();
    } else {
      lines.push(line);
    }
    while (waiters.length > 0) {
      waiters.shift()();
    }
  });
  rl.on("close", () => {
    ended = true;
    while (waiters.length > 0) {
      waiters.shift()();
    }
  });
  return {
    current: null,
    async Scan() {
      if (failed) {
        return false;
      }
      while (lines.length === 0) {
        if (ended) {
          return false;
        }
        await new Promise((resolve) => waiters.push(resolve));
        if (failed) {
          return false;
        }
      }
      const line = lines.shift();
      if (Buffer.byteLength(line, "utf8") > 1 << 20) {
        failed = true;
        return false;
      }
      this.current = line;
      return true;
    },
    Bytes() { return Buffer.from(this.current ?? "", "utf8"); },
    Close() { rl.close(); },
  };
}

/**
 * 使用与会话相同的登录来源，在空临时目录和隔离 HOME 中查询指定 CLI 账号可用的模型列表。
 * 使用场景：Runner 侧模型发现接口调用，支持 Antigravity、Codex 与 Claude Code。
 * @param {AbortSignal|null|undefined} ctx 外部取消信号。
 * @param {string} provider CLI 供应商标识。
 * @param {string} binary 目标 CLI 可执行文件路径。
 * @returns {Promise<CLIModel[]>} 解析后的可用模型列表。
 */
async function DiscoverRunnerLoginModels(ctx, provider, binary) {
  const [login, ok] = runnerLoginSpec(provider);
  if (!ok) {
    throw new Error("该 CLI 暂不支持获取账号模型");
  }
  let root;
  try {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "loopforge-login-models-"));
  } catch {
    throw new Error("无法创建模型查询目录");
  }
  try {
    const [cleanup, loginEnv] = prepareConversationRunnerLogin(root, login, true);
    try {
      const home = path.join(root, "home");
      const env = { NO_COLOR: "1", CI: "1" };
      if (login.configEnv !== "") {
        env[login.configEnv] = path.join(home, login.dir);
      }
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
        if (process.env[key] !== undefined) {
          env[key] = process.env[key];
        }
      }
      // Go 局部变量名 path 与 path 模块冲突，改名 pathEnv。
      const pathEnv = path.dirname(binary) + path.delimiter + (process.env.PATH ?? "");
      env.PATH = pathEnv;
      let args = ["app-server"];
      if (login.binding === BindClaudeCode) {
        args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--setting-sources", ""];
      }
      const [timeoutSignal, cancel] = withTimeout(ctx, 15 * 1000);
      try {
        const environment = appendEnvironment(terminalBaseEnvironment(home), env, loginEnv);
        const spawnEnv = Object.fromEntries(environment.map((e) => {
          const i = e.indexOf("=");
          return [e.slice(0, i), e.slice(i + 1)];
        }));
        if (provider === AgentCLIAntigravity) {
          const result = spawnSync(binary, ["models"], { cwd: root, env: spawnEnv, signal: timeoutSignal });
          // Node 的 spawnSync 在信号已取消时静默返回 status 0；Go 的 cmd.Output 此时返回错误。
          if (timeoutSignal.aborted || result.error != null || result.status !== 0 || (result.stdout ?? Buffer.alloc(0)).length > 2 << 20) {
            throw new Error("Antigravity 无法返回账号模型，请检查执行机器上的 CLI 版本和登录状态");
          }
          const models = antigravityLoginModels((result.stdout ?? Buffer.alloc(0)).toString("utf8"));
          if (models.length === 0) {
            throw new Error("Antigravity 未返回可用的账号模型");
          }
          return models;
        }
        if (login.binding === BindClaudeCode) {
          const statusResult = spawnSync(binary, ["auth", "status"], { cwd: root, env: spawnEnv, signal: timeoutSignal });
          let auth = null;
          try {
            auth = JSON.parse((statusResult.stdout ?? Buffer.alloc(0)).toString("utf8"));
          } catch {
            auth = null;
          }
          if (timeoutSignal.aborted || statusResult.error != null || statusResult.status !== 0 || auth == null || !auth.loggedIn) {
            throw new Error("执行机器上的 Claude Code 登录态不可用，请检查 CLI 版本和账号登录");
          }
        }
        const cmd = spawn(binary, args, { cwd: root, env: spawnEnv, signal: timeoutSignal });
        let spawnErr = null;
        cmd.on("error", (err) => { spawnErr = err; });
        cmd.stdin.on("error", () => {});
        cmd.stdout.on("error", () => {});
        const exited = new Promise((resolve) => cmd.on("close", () => resolve()));
        await new Promise((resolve) => setImmediate(resolve));
        if (spawnErr !== null) {
          throw new Error(`无法启动 ${login.label} 查询模型`);
        }
        const scanner = newLoginScanner(cmd.stdout);
        // Go json.Encoder：写一行 JSON，失败返回错误；其默认 HTML 转义 JSON.stringify 没有。
        const send = {
          Encode(value) {
            try {
              cmd.stdin.write(JSON.stringify(value) + "\n");
              return null;
            } catch (err) {
              return err;
            }
          },
        };
        let models;
        try {
          try {
            if (login.binding === BindCodex) {
              models = await codexLoginModels(send, scanner);
            } else {
              models = await claudeLoginModels(send, scanner);
            }
          } finally {
            cmd.stdin.end();
            scanner.Close();
          }
          if (timeoutSignal.aborted) {
            throw new Error(`查询 ${login.label} 模型超时`);
          }
          if (models == null) {
            throw new Error(`${login.label} 无法返回账号模型，请检查执行机器上的 CLI 版本和登录状态`);
          }
          return models;
        } finally {
          // Go 的 defer cancel 加 cmd.Wait：取消派生上下文并等进程退出；
          // CommandContext 取消时杀死进程，对应 SIGKILL。
          cancel();
          cmd.kill("SIGKILL");
          await exited;
        }
      } finally {
        cancel();
      }
    } finally {
      if (cleanup != null) {
        try {
          cleanup();
        } catch (err) {
          console.log(`runner login models: cleanup ${login.label}: ${err}`);
        }
      }
    }
  } finally {
    // Go 的 defer os.RemoveAll(root) 忽略错误。
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 解析 Antigravity CLI `models` 子命令的制表符分隔输出，去重后返回模型列表。
 * 使用场景：DiscoverRunnerLoginModels 处理 Antigravity 输出时调用。
 * @param {string} output CLI 标准输出文本，每行格式为 "<id>\t<name>"。
 * @returns {CLIModel[]} 解析并去重后的模型列表。
 */
function antigravityLoginModels(output) {
  const models = [];
  const seen = {};
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    const tab = trimmed.indexOf("\t");
    const found = tab !== -1;
    const id = found ? trimmed.slice(0, tab) : trimmed;
    const name = found ? trimmed.slice(tab + 1) : "";
    if (!found || id === "" || /[ \r\n]/.test(id) || seen[id]) {
      continue;
    }
    seen[id] = true;
    models.push(new CLIModel({ ID: id, Name: name.trim() }));
  }
  return models;
}

/**
 * 通过 JSON-RPC 与 Codex `app-server` 交互，依次完成初始化、读取账号状态并拉取模型列表。
 * 使用场景：DiscoverRunnerLoginModels 查询 Codex 账号模型时调用。
 * @param {{Encode: function(any): (Error|null)}} send 向子进程标准输入写入一行 JSON 的编码器。
 * @param {{Scan: function(): Promise<boolean>, Bytes: function(): Buffer}} scanner 读取子进程标准输出的按行扫描器。
 * @returns {Promise<CLIModel[]|null>} 成功返回模型列表，协议握手或账号校验失败返回 null。
 */
async function codexLoginModels(send, scanner) {
  if (send.Encode({
    id: 1, method: "initialize",
    params: { clientInfo: { name: "loopforge", version: "1.0.0" } },
  }) !== null || (await codexLoginResult(scanner, 1)) === null) {
    return null;
  }
  if (send.Encode({ method: "initialized" }) !== null ||
    send.Encode({ id: 2, method: "account/read", params: { refreshToken: false } }) !== null) {
    return null;
  }
  const accountRaw = await codexLoginResult(scanner, 2);
  if (accountRaw === null) {
    return null;
  }
  let account = null;
  try {
    account = JSON.parse(accountRaw.toString("utf8"));
  } catch {
    return null;
  }
  if (account == null || account.account == null) {
    return null;
  }
  if (send.Encode({ id: 3, method: "model/list", params: { limit: 100, includeHidden: false } }) !== null) {
    return null;
  }
  const resultRaw = await codexLoginResult(scanner, 3);
  if (resultRaw === null) {
    return null;
  }
  let result = null;
  try {
    result = JSON.parse(resultRaw.toString("utf8"));
  } catch {
    return null;
  }
  if (result == null || result.data == null) {
    return null;
  }
  const models = [];
  for (const item of result.data) {
    const id = (item.model ?? "").trim();
    if (id !== "") {
      const model = new CLIModel({ ID: id, Name: item.displayName });
      if (item.supportedReasoningEfforts != null) {
        model.DiscoveredReasoningEfforts = item.supportedReasoningEfforts.map((level) => level.reasoningEffort);
      }
      models.push(model);
    }
  }
  return models;
}

/**
 * 持续从扫描器读取 JSON-RPC 响应行，直到匹配指定请求 ID 并返回其原始 result 字段字节。
 * 使用场景：codexLoginModels 等待某次 RPC 请求返回结果时调用。
 * @param {{Scan: function(): Promise<boolean>, Bytes: function(): Buffer}} scanner 读取子进程标准输出的按行扫描器。
 * @param {number} id 期望匹配的 JSON-RPC 请求 ID。
 * @returns {Promise<Buffer|null>} 匹配到的 result 字段 UTF-8 JSON 字节；流结束或缺少 result 时返回 null。
 */
async function codexLoginResult(scanner, id) {
  while (await scanner.Scan()) {
    let message = null;
    try {
      message = JSON.parse(scanner.Bytes().toString("utf8"));
    } catch {
      continue;
    }
    if (message != null && message.id === id) {
      // Go json.RawMessage 是原始 JSON 字节；这里保留序列化后的原始值。
      return message.result === undefined ? null : Buffer.from(JSON.stringify(message.result), "utf8");
    }
  }
  return null;
}

/**
 * 向 Claude Code 发送 stream-json 初始化控制请求，并从响应中提取可用模型与推理强度列表。
 * 使用场景：DiscoverRunnerLoginModels 查询 Claude Code 账号模型时调用。
 * @param {{Encode: function(any): (Error|null)}} send 向子进程标准输入写入一行 JSON 的编码器。
 * @param {{Scan: function(): Promise<boolean>, Bytes: function(): Buffer}} scanner 读取子进程标准输出的按行扫描器。
 * @returns {Promise<CLIModel[]|null>} 成功返回模型列表，请求失败或响应无效时返回 null。
 */
async function claudeLoginModels(send, scanner) {
  const id = "loopforge-models";
  if (send.Encode({
    type: "control_request", request_id: id,
    request: { subtype: "initialize" },
  }) !== null) {
    return null;
  }
  while (await scanner.Scan()) {
    let message = null;
    try {
      message = JSON.parse(scanner.Bytes().toString("utf8"));
    } catch {
      continue;
    }
    if (message == null || message.type !== "control_response" || message.response == null || message.response.request_id !== id) {
      continue;
    }
    if (message.response.subtype !== "success" || message.response.response == null || message.response.response.models == null) {
      return null;
    }
    const models = [];
    for (const item of message.response.response.models) {
      const modelID = (item.value ?? "").trim();
      if (modelID !== "") {
        let levels = item.supportedEffortLevels ?? null;
        if (item.supportsEffort != null && !item.supportsEffort) {
          levels = [];
        }
        models.push(new CLIModel({ ID: modelID, Name: item.displayName, DiscoveredReasoningEfforts: levels }));
      }
    }
    return models;
  }
  return null;
}

module.exports = {
  DiscoverRunnerLoginModels, antigravityLoginModels, codexLoginModels, codexLoginResult, claudeLoginModels,
  withTimeout, newLoginScanner,
};
