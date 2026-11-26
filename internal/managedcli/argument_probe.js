/**
 * @file internal/managedcli/argument_probe.js
 * @description 对应 Go 文件：internal/managedcli/argument_probe.go。
 * 作用与职责边界：针对 Claude CLI 隐藏参数 `--system-prompt-file` 执行“未知参数阴性对照 + 缺失文件阳性对照”双重探针校验，
 * 仅在离线参数解析阶段验证该隐藏参数是否存在且生效，不触发模型请求也不读取真实凭证。
 * 语法差异说明：
 * - `context.Context` 译为 `AbortSignal`；
 * - 仅返回 `error` 的 Go 方法译为成功返回 `undefined`、失败抛出 `Error`；
 * - 子进程在非零退出时同时返回输出与错误，JS 侧通过捕获错误对象的 `err.output` 读取命令输出；
 * - 同包结构体方法按约定挂载在 `Manager.prototype` 上。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { Manager } = require("./updater.js"); // 对应 Go 同包类型，updater.js 已翻译

/**
 * 通过阴性对照（未知参数必被拒）与阳性对照（缺失文件必报精确错误）校验 Claude CLI 是否支持隐藏参数 `--system-prompt-file`。
 * 使用场景：在 `Manager.prototype.validate` 检查帮助输出未显式列出 `--system-prompt-file` 时调用，
 * 用于确认候选 Claude 二进制确实解析该隐藏参数且不依赖 `--help` 输出。
 *
 * @param {AbortSignal|null|undefined} ctx 取消信号，用于中断外部命令探针。
 * @param {import("./manifest.js").Installation} installed 待校验的候选安装记录，使用其 `Binary` 可执行文件路径。
 * @returns {Promise<void>} 无返回值；校验失败或上下文取消时抛出错误。
 */
Manager.prototype.validateClaudeHiddenFileArgument = async function (ctx, installed) {
  const probeDir = fs.mkdtempSync(path.join(this.Root, "tmp", "argument-probe-"));
  try {
    const missing = path.join(probeDir, "nonexistent-system-prompt.txt");
    let lstatErr = null;
    try {
      fs.lstatSync(missing);
    } catch (err) {
      lstatErr = err;
    }
    if (lstatErr == null || lstatErr.code !== "ENOENT") {
      throw new Error("hidden-argument probe path unexpectedly exists");
    }
    const unknown = "--agentflow-invalid-option-probe";
    let negative = Buffer.alloc(0);
    let negativeErr = null;
    try {
      negative = await this.command(ctx, installed.Binary, [unknown, missing, "--print"], this.Root);
    } catch (err) {
      negativeErr = err;
      negative = err.output ?? Buffer.alloc(0);
    }
    if (ctx instanceof AbortSignal && ctx.aborted) {
      throw ctx.reason; // Go：ctx.Err()
    }
    if (negativeErr == null || !negative.toString("utf8").toLowerCase().includes(`unknown option '${unknown}'`)) {
      throw new Error("cannot verify hidden --system-prompt-file: unknown-option control was not rejected");
    }
    let positive = Buffer.alloc(0);
    let positiveErr = null;
    try {
      positive = await this.command(ctx, installed.Binary, ["--system-prompt-file", missing, "--print"], this.Root);
    } catch (err) {
      positiveErr = err;
      positive = err.output ?? Buffer.alloc(0);
    }
    if (ctx instanceof AbortSignal && ctx.aborted) {
      throw ctx.reason; // Go：ctx.Err()
    }
    if (positiveErr == null || positive.toString("utf8").trim() !== "Error: System prompt file not found: " + missing) {
      throw new Error("candidate CLI did not confirm required hidden argument --system-prompt-file with the missing-file probe");
    }
  } finally {
    try {
      fs.rmdirSync(probeDir); // 仅删除上方新建的空目录，对应 Go 的 defer os.Remove(probeDir)（不递归且忽略清理错误）
    } catch {
      // 忽略清理错误，避免覆盖主流程错误。
    }
  }
};

module.exports = {};
