"use strict";

/**
 * @file internal/runtime/process.js
 * @description 对应 Go 源文件 `internal/runtime/process.go`。
 * 负责子进程执行与标准输出/错误流的遥测采集：协调 Claude 托管登录回调桥接、
 * 实时逐行转发 stdout/stderr 到事件接收器、对敏感环境变量参数脱敏，并在进程结束时上报耗时与退出状态。
 *
 * Go -> JS 语法与结构差异说明：
 * - 单线程 JS 不需要 `sync.Mutex`，略去原文件中的互斥锁。
 * - `defer bridge.close()` 改写为 `try ... finally`。
 * - Go 多返回值 `(string, error)` 按规范统一改为成功返回字符串、失败抛出 `Error`。
 * - `bytes.Buffer` 以轻量字符串累加对象 `{ value: "" }` 表达；`[]rune` 截断使用 `Array.from`。
 */

const { TelemetryEvent } = require("../domain/run.js");
const { CommandSpec } = require("./runtime.js"); // 待翻译
const { isManagedClaude, newClaudeLoginBridge } = require("./runner_login_claude.js"); // 待翻译

/** 进程退出后等待继承输出管道排空的最长时长（毫秒），对应 Go `time.Second`。 */
const processWaitDelay = 1000;

/** 表示进程尚未成功启动的哨兵错误。 */
const errProcessNotStarted = new Error("process was not started");

/**
 * 执行子进程并流式上报进程遥测事件，同时协调 Claude 托管登录回调并在 `process.started` 中对凭据环境变量脱敏。
 * 用于本地、Docker 及进程沙箱执行命令并收集完整合并输出。
 *
 * @param {object} cmd - 待启动的命令对象（对应 Go `*exec.Cmd`）。
 * @param {((event: TelemetryEvent) => void) | null} sink - 遥测事件接收回调，可为 `null`。
 * @param {...CommandSpec} commands - 可选的命令规格，首个元素用于识别托管登录与凭据环境变量键。
 * @returns {string} 子进程合并后的标准输出与标准错误文本；失败时抛出 `Error`。
 */
function runCommand(cmd, sink, ...commands) {
  let command = new CommandSpec();
  if (commands.length > 0) {
    command = commands[0];
  }
  let bridge = null;
  if (isManagedClaude(command)) {
    try {
      bridge = newClaudeLoginBridge(cmd, command);
    } catch (err) {
      const wrapped = new Error(`${errProcessNotStarted.message}: ${err.message}`);
      wrapped.cause = err;
      throw wrapped;
    }
  }
  try {
    const buf = { value: "" };
    const stdout = new processWriter({
      output: buf,
      sink,
      name: "process.stdout",
      level: "info",
    });
    if (bridge !== null) {
      stdout.filter = bridge.filter.bind(bridge);
    }
    const stderr = new processWriter({
      output: buf,
      sink,
      name: "process.stderr",
      level: "error",
    });
    cmd.Stdout = stdout;
    cmd.Stderr = stderr;
    // 当钩子派生出继承 stdout/stderr 的脱离孙进程时，限制主进程退出后等待管道排空的时长；
    // 过短的等待时间会在高负载主机上截断失败日志尾部，因此保留 1 秒窗口。
    cmd.WaitDelay = processWaitDelay;

    let err = null;
    try {
      cmd.Start();
    } catch (startErr) {
      err = startErr;
    }
    if (err === null && sink != null) {
      sink(
        new TelemetryEvent({
          Category: "process",
          Name: "process.started",
          Timestamp: new Date(),
          Phase: "start",
          Message: compactCommand(cmd.Args, ...(command.credentialEnvKeys ?? [])),
          Attributes: { pid: cmd.Process.Pid },
        })
      );
    }

    if (err === null) {
      if (bridge !== null) {
        bridge.start();
      }
      try {
        cmd.Wait();
      } catch (waitErr) {
        err = waitErr;
      }
    } else if (sink != null) {
      sink(
        new TelemetryEvent({
          Category: "process",
          Name: "process.start_failed",
          Timestamp: new Date(),
          Phase: "start",
          Level: "error",
          Message: err.message,
        })
      );
    }

    if (err !== null && cmd.Process === null) {
      if (err.code === "E2BIG") {
        // 相同参数重试仍会失败，明确提示单参数超出内核约 128KiB 上限。
        const e2bigErr = new Error(
          `${err.message} (a single argument exceeds the ~128KiB kernel limit; pass long prompts on stdin or in a file)`
        );
        e2bigErr.cause = err;
        err = e2bigErr;
      }
      const notStartedErr = new Error(`${errProcessNotStarted.message}: ${err.message}`);
      notStartedErr.cause = err;
      err = notStartedErr;
    }

    if (cmd.Process !== null && cmd.SysProcAttr !== null && cmd.SysProcAttr.Setpgid) {
      try {
        process.kill(-cmd.Process.Pid, "SIGKILL");
      } catch (_) {
        // 忽略清理进程组时的错误。
      }
    }

    const outputIncomplete = err !== null && err.code === "ERR_WAIT_DELAY";
    if (outputIncomplete) {
      err = null;
    }
    stdout.flush();
    stderr.flush();
    if (bridge !== null && bridge.result() !== null) {
      err = bridge.result();
    }

    if (sink != null) {
      const phase = "finish";
      let level = "info";
      if (err !== null) {
        level = "error";
      }
      const attrs = { outputIncomplete };
      const state = cmd.ProcessState;
      if (state != null) {
        attrs["pid"] = state.Pid();
        attrs["exitCode"] = state.ExitCode();
        attrs["userCpuMs"] = state.UserTime();
        attrs["systemCpuMs"] = state.SystemTime();
        const status = state.Sys ? state.Sys() : null;
        if (
          status != null &&
          typeof status.Signaled === "function" &&
          typeof status.Signal === "function" &&
          status.Signaled()
        ) {
          attrs["signal"] = status.Signal().toString();
        }
      }
      sink(
        new TelemetryEvent({
          Category: "process",
          Name: "process.finished",
          Timestamp: new Date(),
          Phase: phase,
          Level: level,
          Message: commandResult(err),
          Attributes: attrs,
        })
      );
    }

    if (err !== null) {
      throw err;
    }
    return buf.value;
  } finally {
    if (bridge !== null) {
      bridge.close();
    }
  }
}

/**
 * 子进程输出行缓冲写入器，按换行符切分输出、执行可选过滤并写入合并缓冲与遥测接收器。
 * 对应 Go `processWriter`（单线程 JS 略去 `mu` 字段）。
 */
class processWriter {
  /**
   * 构造子进程输出写入器。
   *
   * @param {object} [init={}] - 初始化字段。
   * @param {((line: string) => boolean) | null} [init.filter=null] - 行级过滤函数，返回 `false` 时丢弃该行。
   * @param {{ value: string }} [init.output={ value: "" }] - 合并输出缓冲区。
   * @param {((event: TelemetryEvent) => void) | null} [init.sink=null] - 遥测事件接收回调。
   * @param {string} [init.name=""] - 上报事件名称（如 `process.stdout` / `process.stderr`）。
   * @param {string} [init.level=""] - 上报事件级别（如 `info` / `error`）。
   * @param {string} [init.pending=""] - 尚未遇到换行符的残留文本。
   */
  constructor(init = {}) {
    this.filter = init.filter ?? null;
    this.output = init.output ?? { value: "" };
    this.sink = init.sink ?? null;
    this.name = init.name ?? "";
    this.level = init.level ?? "";
    this.pending = init.pending ?? "";
  }

  /**
   * 写入一段原始字节或字符串，并立即刷新其中已完整的行。
   *
   * @param {Buffer | Uint8Array | string} p - 写入的数据块。
   * @returns {number} 实际消费的数据长度。
   */
  Write(p) {
    const chunk = typeof p === "string" ? p : Buffer.from(p).toString("utf8");
    this.pending += chunk;
    this.emitLines(false);
    return p.length;
  }

  /**
   * 在进程结束后刷出缓冲区中尚未以换行符结尾的最后一行内容。
   *
   * @returns {void} 无返回值。
   */
  flush() {
    this.emitLines(true);
  }

  /**
   * 按 `\n` 切分当前待处理缓冲区并逐行输出。
   *
   * @param {boolean} includePartial - 为 `true` 时将末尾未换行的残留文本也作为一行输出。
   * @returns {void} 无返回值。
   */
  emitLines(includePartial) {
    for (;;) {
      const raw = this.pending;
      const index = raw.indexOf("\n");
      if (index < 0) {
        if (includePartial && raw !== "") {
          this.pending = "";
          this.emit(raw);
        }
        return;
      }
      let line = raw.slice(0, index);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.pending = raw.slice(index + 1);
      this.emit(line);
    }
  }

  /**
   * 过滤并将单行文本写入合并缓冲区与遥测事件流。
   *
   * @param {string} line - 已去除换行符的单行输出文本。
   * @returns {void} 无返回值。
   */
  emit(line) {
    if (this.filter !== null && !this.filter(line)) {
      return;
    }
    this.output.value += line + "\n";
    if (this.sink != null) {
      this.sink(
        new TelemetryEvent({
          Category: "process",
          Name: this.name,
          Phase: "progress",
          Level: this.level,
          Message: line,
        })
      );
    }
  }
}

/**
 * 将命令行参数列表拼接为可读摘要，对敏感环境变量与已绑定凭据键的值进行脱敏，并在超长时按 Unicode 字符数截断。
 * 用于 `process.started` 遥测事件的消息字段。
 *
 * @param {string[]} args - 命令行参数数组。
 * @param {...string} credentialEnvKeys - 当前命令额外绑定的凭据环境变量名。
 * @returns {string} 脱敏并可能截断后的命令行字符串。
 */
function compactCommand(args, ...credentialEnvKeys) {
  const credentialKeys = {};
  for (const key of credentialEnvKeys) {
    credentialKeys[key.toUpperCase()] = true;
  }
  const redact = (key) => sensitiveProcessEnvironmentKey(key) || Boolean(credentialKeys[key.toUpperCase()]);
  const safe = [...args];
  for (let index = 0; index < safe.length; index++) {
    const value = safe[index];
    if (value === "-e" && index + 1 < safe.length) {
      const eqIdx = safe[index + 1].indexOf("=");
      if (eqIdx >= 0) {
        const key = safe[index + 1].slice(0, eqIdx);
        if (redact(key)) {
          safe[index + 1] = key + "=<redacted>";
        }
      }
      index++;
      continue;
    }
    const eqIdx = value.indexOf("=");
    if (eqIdx >= 0) {
      const key = value.slice(0, eqIdx);
      if (redact(key)) {
        safe[index] = key + "=<redacted>";
      }
    }
  }
  const joined = safe.join(" ");
  const runes = Array.from(joined);
  const maxRunes = 1024;
  if (runes.length <= maxRunes) {
    return joined;
  }
  return runes.slice(0, maxRunes).join("") + ` … [arguments truncated, ${runes.length} chars]`;
}

/**
 * 判断环境变量名是否属于需要脱敏的敏感键。
 * 通过常见后缀匹配，使新增 Agent CLI 的密钥变量无需单独登记即可自动脱敏。
 *
 * @param {string} key - 环境变量名。
 * @returns {boolean} 命中敏感键规则时返回 `true`，否则返回 `false`。
 */
function sensitiveProcessEnvironmentKey(key) {
  key = key.toUpperCase();
  if (key === "CODEX_REFRESH_TOKEN_URL_OVERRIDE") {
    return true;
  }
  for (const suffix of ["_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD"]) {
    if (key.endsWith(suffix)) {
      return true;
    }
  }
  return key.startsWith("GIT_CONFIG_KEY_");
}

/**
 * 将进程结束错误转换为遥测消息文本。
 *
 * @param {Error | null} err - 进程执行返回的错误对象，成功时为 `null`。
 * @returns {string} 成功返回 `"process exited successfully"`，失败返回错误消息文本。
 */
function commandResult(err) {
  if (err === null || err === undefined) {
    return "process exited successfully";
  }
  return err.message;
}

module.exports = {
  processWaitDelay,
  errProcessNotStarted,
  runCommand,
  processWriter,
  compactCommand,
  sensitiveProcessEnvironmentKey,
  commandResult,
};
