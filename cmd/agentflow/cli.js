// cli.js —— 对应 Go 文件：cmd/agentflow/cli.go（学习用对照翻译，非可运行后端）
// Go 的 (值, error) 多返回值译为：成功 return，失败 throw。
// time.Duration 译为毫秒数。context.Context 译为 AbortSignal。

"use strict";

// runCLI(ctx, action, provider, timeout, stdout)
// ctx：AbortSignal（Go：context.Context）；timeout：毫秒（Go：time.Duration）。
async function runCLI(ctx, action, provider, timeout, stdout) {
  const managedcli = require("../../internal/managedcli"); // 对应 Go import，待转写该包时补全
  const root = (process.env.AGENTFLOW_MANAGED_CLI_ROOT || "").trim();
  if (root === "" || timeout <= 0) {
    throw new Error(
      "AGENTFLOW_MANAGED_CLI_ROOT and a positive -cli-timeout are required",
    );
  }
  if (action !== "status" && action !== "update" && action !== "rollback") {
    throw new Error("invalid -cli-action: choose status, update, or rollback");
  }
  if (action !== "rollback" && provider !== "") {
    throw new Error("-cli-provider is only supported with rollback");
  }
  // Go：ctx, cancel := context.WithTimeout(ctx, timeout)
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("context deadline exceeded")),
    timeout,
  );
  if (ctx) {
    if (ctx.aborted) controller.abort(ctx.reason);
    else
      ctx.addEventListener("abort", () => controller.abort(ctx.reason), {
        once: true,
      });
  }
  const signal = controller.signal;
  try {
    if (signal.aborted) throw signal.reason; // Go：ctx.Err()
    if (action === "status") {
      const state = await managedcli.readState(root);
      stdout.write(JSON.stringify(state) + "\n");
      return;
    }
    const manager = await managedcli.newManager(root);
    let report;
    let err = null;
    try {
      report =
        action === "rollback"
          ? await manager.rollback(signal, provider)
          : await manager.update(signal);
    } catch (e) {
      err = e;
    }
    let encodeErr = null;
    try {
      stdout.write(JSON.stringify(report) + "\n");
    } catch (e) {
      encodeErr = e;
    }
    if (err) throw err;
    if (encodeErr) throw encodeErr;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { runCLI };
