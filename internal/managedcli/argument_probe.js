// argument_probe.js —— 对应 Go 文件：internal/managedcli/argument_probe.go
// 作用：用“未知参数必被拒 + 缺失文件必报错”双重探针，确认 Claude 支持隐藏参数。
// context.Context 译为 AbortSignal；(值, error) 译为成功返回值、失败 throw。

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { Manager } = require("./updater.js"); // 对应 Go 同包类型，updater.js 已翻译

// Claude registers --system-prompt-file with hideHelp(). Its --help also exits
// successfully for UNKNOWN flags, so flag+help is not a valid support probe.
// Require both an unknown-option negative control and an exact missing-file
// positive control. Neither supplies a prompt; stdin is closed, the file cannot
// be read and credentials remain isolated. Real-vendor validation additionally
// confirmed this parser path in an offline container, before model execution.
Manager.prototype.validateClaudeHiddenFileArgument = async function (ctx, installed) {
  const probeDir = fs.mkdtempSync(path.join(this.Root, "tmp", "argument-probe-"));
  try {
    const missing = path.join(probeDir, "nonexistent-system-prompt.txt");
    let missingStat = null;
    try {
      missingStat = fs.lstatSync(missing);
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
    if (missingStat != null) {
      throw new Error("hidden-argument probe path unexpectedly exists");
    }
    const unknown = "--agentflow-invalid-option-probe";
    let negative = null;
    let negativeErr = null;
    try {
      negative = await this.command(ctx, installed.Binary, [unknown, missing, "--print"], this.Root);
    } catch (err) {
      negativeErr = err;
    }
    if (ctx instanceof AbortSignal && ctx.aborted) {
      throw ctx.reason; // Go：ctx.Err()
    }
    if (negativeErr == null || !negative.toString("utf8").toLowerCase().includes(`unknown option '${unknown}'`)) {
      throw new Error("cannot verify hidden --system-prompt-file: unknown-option control was not rejected");
    }
    let positive = null;
    let positiveErr = null;
    try {
      positive = await this.command(ctx, installed.Binary, ["--system-prompt-file", missing, "--print"], this.Root);
    } catch (err) {
      positiveErr = err;
    }
    if (ctx instanceof AbortSignal && ctx.aborted) {
      throw ctx.reason; // Go：ctx.Err()
    }
    if (positiveErr == null || positive.toString("utf8").trim() !== "Error: System prompt file not found: " + missing) {
      throw new Error("candidate CLI did not confirm required hidden argument --system-prompt-file with the missing-file probe");
    }
  } finally {
    fs.rmdirSync(probeDir); // 只删上面新建的空目录，Go 的 os.Remove 不递归
  }
};

module.exports = {};
