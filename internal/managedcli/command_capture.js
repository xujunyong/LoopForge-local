/**
 * @file internal/managedcli/command_capture.js
 * @description 对应 Go 文件：internal/managedcli/command_capture.go。
 * 作用与职责边界：执行外部 CLI/npm 命令，将标准输出与标准错误同步写入独立私有临时文件并限制总大小不超过 1 MiB，
 * 避免管道缓冲截断，同时监控输出体积超限时取消整个进程组。
 * 语法差异说明：
 * - `os/exec.Cmd` 译为 `child_process.spawn` 及选项对象；
 * - Go 协程轮询文件大小译为 `setInterval` + `Promise`；
 * - `context.Context` 译为 `AbortSignal`；
 * - `(data, error)` 成功返回 `Buffer`，失败抛出 `Error`；命令非零退出时把已捕获字节挂在 `err.output` 上而不写入 `err.message`，以兼容调用方探针且避免泄漏凭证。
 */

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Go 用 //go:build 按平台二选一；JS 在加载时按 process.platform 选择对应实现。
const { configureCommandGroup } =
  process.platform === "linux" || process.platform === "darwin"
    ? require("./command_unix.js")
    : require("./command_other.js");

const commandOutputLimit = 1 << 20;

/**
 * 执行指定外部命令并捕获其合并后的标准输出与标准错误，同时强制 1 MiB 输出上限与取消传播。
 * 使用场景：作为 `Manager.RunCommand` 的默认实现，供版本探测、帮助文本探测、隐藏参数探测与 npm 安装/重建命令调用。
 *
 * @param {AbortSignal|null|undefined} ctx 取消信号，触发时终止整个子进程组。
 * @param {string} name 可执行文件路径或命令名。
 * @param {string[]} args 传递给命令的参数数组。
 * @param {string} dir 子进程工作目录，同时用于创建私有输出临时文件。
 * @param {string[]|null|undefined} env `KEY=VALUE` 形式的环境变量列表；为 `null`/`undefined` 时继承当前环境。
 * @returns {Promise<Buffer>} 命令产生的合并输出字节；命令失败或输出超限时抛出错误（命令非零退出时错误对象附带 `output` 与 `cause` 属性）。
 */
async function executeCommand(ctx, name, args, dir, env) {
  // 部分原生 CLI 退出时异步管道尚未排空，Linux 下会截断 --help 输出；使用常规文件作为同步输出目标。
  const outputPath = path.join(dir, `.managed-cli-output-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
  const output = fs.openSync(outputPath, "wx+", 0o600); // 新建私有可读写文件，对应 Go 的 os.CreateTemp
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(ctx.reason);
  try {
    if (ctx instanceof AbortSignal) {
      if (ctx.aborted) {
        controller.abort(ctx.reason);
      } else {
        ctx.addEventListener("abort", onParentAbort, { once: true });
      }
    }
    // 对应 Go 的 exec.CommandContext：configureCommandGroup 会在 cmd 上挂载 detached 与 cancel。
    const cmd = { name, args, dir, env, detached: false, cancel: null, child: null };
    configureCommandGroup(cmd);
    controller.signal.addEventListener("abort", () => {
      if (cmd.cancel != null) {
        try {
          cmd.cancel();
        } catch {
          // 与 Go 的 cmd.Cancel 一致，进程已结束时忽略取消报错。
        }
      } else if (cmd.child != null) {
        cmd.child.kill("SIGKILL");
      }
    });
    const envObject = env == null
      ? undefined
      : Object.fromEntries(env.map((e) => {
        const i = e.indexOf("=");
        return i >= 0 ? [e.slice(0, i), e.slice(i + 1)] : [e, ""];
      }));
    // Go 的 cmd.WaitDelay = 5s 用于限制退出后收尾等待；Node spawn 的 close 事件等待 stdio 排空。
    cmd.child = spawn(name, args, {
      cwd: dir,
      env: envObject,
      detached: cmd.detached,
      stdio: ["ignore", output, output],
      signal: controller.signal,
    });
    let stopMonitor = null;
    const monitorDone = new Promise((resolve) => {
      let stopped = false;
      const timer = setInterval(() => {
        if (stopped) {
          return;
        }
        let size = 0;
        try {
          size = fs.fstatSync(output).size;
        } catch {
          size = 0;
        }
        if (size > commandOutputLimit) {
          controller.abort(); // 终止整个进程组，而非仅终止外壳进程
          stopped = true;
          clearInterval(timer);
          resolve();
        }
      }, 10);
      stopMonitor = () => {
        if (!stopped) {
          stopped = true;
          clearInterval(timer);
          resolve();
        }
      };
    });
    const runErr = await new Promise((resolve) => {
      cmd.child.on("error", (err) => resolve(err));
      cmd.child.on("close", (code, signal) => {
        if (signal != null) {
          resolve(new Error(`signal: ${signal}`));
        } else if (code !== 0) {
          resolve(new Error(`exit status ${code}`));
        } else {
          resolve(null);
        }
      });
    });
    stopMonitor();
    await monitorDone;
    const info = fs.fstatSync(output);
    if (info.size > commandOutputLimit) {
      throw new Error("CLI validation output exceeds 1 MiB");
    }
    // 对应 Go 的 output.Seek(0, io.SeekStart) + io.ReadAll(io.LimitReader(output, commandOutputLimit+1))。
    const readCap = commandOutputLimit + 1;
    const buffer = Buffer.allocUnsafe(readCap);
    let offset = 0;
    while (offset < readCap) {
      const n = fs.readSync(output, buffer, offset, readCap - offset, offset);
      if (n === 0) {
        break;
      }
      offset += n;
    }
    const data = buffer.subarray(0, offset);
    if (data.length > commandOutputLimit) {
      throw new Error("CLI validation output exceeds 1 MiB");
    }
    if (runErr != null) {
      // 不把任意 npm/脚本输出拼进错误消息（可能包含凭证或代理地址），私有临时文件会在 finally 中删除。
      const err = new Error(`command ${path.basename(name)} failed: ${runErr.message}`);
      err.cause = runErr;
      err.output = data;
      throw err;
    }
    return data;
  } finally {
    if (ctx instanceof AbortSignal) {
      ctx.removeEventListener("abort", onParentAbort);
    }
    try {
      fs.closeSync(output);
    } catch {
      // 忽略关闭错误，保证后续删除临时文件继续执行。
    }
    try {
      fs.rmSync(outputPath, { force: true });
    } catch {
      // 忽略删除错误，避免覆盖主流程错误。
    }
  }
}

module.exports = { commandOutputLimit, executeCommand };
