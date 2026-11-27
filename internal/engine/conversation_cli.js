/**
 * @file internal/engine/conversation_cli.js
 * 对应 Go 源文件：internal/engine/conversation_cli.go
 *
 * 作用与职责边界：
 * 为对话 CLI 获取工作区专属的本地执行沙箱：校验工作区无活跃执行、活跃节点或终端占用后，
 * 配置对话沙箱并执行本地环境准备（含准备脚本与浏览器），递增活跃执行计数并返回沙箱与释放回调；
 * 领域方法挂载于 `Engine.prototype`（`Engine` 定义于 `engine.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(runtime.Sandbox, func(), error)` 译为成功返回二元组 `[sandbox, release]`、失败 `throw err`。
 * - Go 的 `env.nodeMu`（`sync.Mutex`）在单线程 JS 中省略，`env.activeExecutions`（`atomic.Int32`）对应 `run_environment.js` 中的普通数字字段。
 * - Go 的 `context.Context` 译为 `AbortSignal`。
 */

"use strict";

const { ConfigureConversationSandbox } = require("../runtime/conversation_sandbox.js"); // 对应 Go 的 runtime.ConfigureConversationSandbox，runtime 未翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译

/**
 * 获取对话工作区的本地执行沙箱并建立本地排他栅栏，防止调度器执行与终端接管并发修改工作区。
 * 调用方须已持有持久化的工作区租约，并在使用完成后调用返回的释放回调递减活跃计数。
 * 使用场景：在控制面本地为对话 CLI 启动命令前调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号。
 * @param {string} id - 运行（工作区）ID。
 * @param {string} root - 本地工作区根目录路径。
 * @returns {[Object, function(): void]} 二元组 `[配置并准备好的本地沙箱实例, 递减活跃执行计数的释放回调]`。
 * @throws {Error} 工作区不存在、当前存在活跃执行/节点/终端占用、获取环境失败或沙箱/本地环境准备失败时抛出错误。
 */
Engine.prototype.AcquireConversationCLI = function (ctx, id, root) {
  const [run, ok] = this.repo.RunState(id);
  if (!ok) {
    throw new Error("工作区不存在");
  }
  const env = this.acquireConversationEnvironment(ctx, run);
  // Go 的 env.nodeMu.Lock()/Unlock() 在单线程 JS 中省略；activeExecutions 在 runEnvironment 中为普通数值。
  if (env.activeExecutions > 0 || run.HasActiveNode() || this.workspaceTerminals.HasRunScope(id)) {
    throw new Error("工作区仍有执行或终端占用，请结束后重试");
  }
  ConfigureConversationSandbox(ctx, env.sandbox, root);
  this.prepareLocalEnvironment(ctx, run, env);
  env.activeExecutions += 1;
  return [env.sandbox, () => { env.activeExecutions -= 1; }];
};

module.exports = {};
