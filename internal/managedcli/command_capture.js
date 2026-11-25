// command_capture.js —— 对应 Go 文件：internal/managedcli/command_capture.go
// 作用：跑一条外部命令，把标准输出与标准错误都抓进临时文件，限 1 MiB。
// Go 的 os/exec.Cmd 译为 child_process.spawn；goroutine 译为 setInterval 监视；
// context.Context 译为 AbortSignal；(值, error) 译为成功返回值、失败 throw。

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Go 用 //go:build 按平台二选一；JS 在加载时按 process.platform 选一次。
const { configureCommandGroup } =
  process.platform === "linux" || process.platform === "darwin"
    ? require("./command_unix.js")
    : require("./command_other.js");

const commandOutputLimit = 1 << 20;

async function executeCommand(ctx, name, args, dir, env) {
  // Some native CLIs exit before their async pipe writes have drained. On
  // Linux that truncated real --help output to 8192 bytes and falsely rejected
  // supported flags. A regular file gives the child a synchronous sink.
  const outputPath = path.join(dir, `.managed-cli-output-${randomSuffix()}`);
  const output = fs.openSync(outputPath, "wx", 0o600); // 新建私有文件，绝非已有路径
  try {
    return await runCommand(ctx, name, args, dir, env, output, outputPath);
  } finally {
    fs.closeSync(output);
    fs.rmSync(outputPath, { force: true });
  }
}

async function runCommand(ctx, name, args, dir, env, output, outputPath) {
  const controller = new AbortController();
  if (ctx instanceof AbortSignal) {
    if (ctx.aborted) {
      controller.abort(ctx.reason);
    } else {
      ctx.addEventListener("abort", () => controller.abort(ctx.reason), { once: true });
    }
  }
  // Go 的 exec.Cmd 在此只有字段：configureCommandGroup 往上面挂 detached 与 cancel。
  const cmd = { name, args, dir, env, detached: false, cancel: null, child: null };
  configureCommandGroup(cmd);
  controller.signal.addEventListener("abort", () => {
    if (cmd.cancel != null) {
      try {
        cmd.cancel();
      } catch {
        // Go 的 cmd.Cancel 同样可能报进程已结束，忽略。
      }
    } else if (cmd.child != null) {
      cmd.child.kill("SIGKILL");
    }
  });
  // Go 的 cmd.WaitDelay = 5s：子进程退出后最多再等 5 秒收尾；spawn 的 close 事件已等 stdio 排空。
  cmd.child = spawn(name, args, {
    cwd: dir,
    env: Object.fromEntries(env.map((e) => { const i = e.indexOf("="); return [e.slice(0, i), e.slice(i + 1)]; })),
    detached: cmd.detached,
    stdio: ["ignore", output, output],
    signal: controller.signal,
  });
  const stop = { stopped: false };
  const monitorDone = new Promise((resolve) => {
    const timer = setInterval(() => {
      if (stop.stopped) {
        clearInterval(timer);
        resolve();
        return;
      }
      let size = 0;
      try {
        size = fs.fstatSync(output).size;
      } catch {
        size = 0;
      }
      if (size > commandOutputLimit) {
        controller.abort(); // 杀整个命令组，不只是 npm 的 shell
        clearInterval(timer);
        resolve();
      }
    }, 10);
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
  stop.stopped = true;
  await monitorDone;
  const info = fs.fstatSync(output);
  if (info.size > commandOutputLimit) {
    throw new Error("CLI validation output exceeds 1 MiB");
  }
  const data = fs.readFileSync(outputPath).subarray(0, commandOutputLimit + 1);
  if (data.length > commandOutputLimit) {
    throw new Error("CLI validation output exceeds 1 MiB");
  }
  if (runErr != null) {
    // Never persist arbitrary npm/script output in an error: it can contain
    // credentials or proxy URLs. The private capture file is removed above.
    throw new Error(`command ${path.basename(name)} failed: ${runErr.message}`);
  }
  return data;
}

function randomSuffix() {
  return `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

module.exports = { commandOutputLimit, executeCommand };
