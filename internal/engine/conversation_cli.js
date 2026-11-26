// conversation_cli.js —— 对应 Go 文件：internal/engine/conversation_cli.go
// 作用：为对话取工作区专用的本地执行沙箱：占用检查通过后配好会话环境并计数。
// (值, error) 译为返回值、失败 throw，(值, bool) 译为 [值, bool]；context.Context 译为 AbortSignal。

"use strict";

const { ConfigureConversationSandbox } = require("../runtime/conversation_sandbox.js"); // 对应 Go 的 runtime.ConfigureConversationSandbox，runtime 未翻译

Engine.prototype.AcquireConversationCLI = function (ctx, id, root) {
  const [run, ok] = this.repo.RunState(id);
  if (!ok) {
    throw new Error("工作区不存在");
  }
  const env = this.acquireConversationEnvironment(ctx, run);
  env.nodeMu.Lock();
  try {
    if (env.activeExecutions.Load() > 0 || run.HasActiveNode() || this.workspaceTerminals.HasRunScope(id)) {
      throw new Error("工作区仍有执行或终端占用，请结束后重试");
    }
    ConfigureConversationSandbox(ctx, env.sandbox, root);
    this.prepareLocalEnvironment(ctx, run, env);
    env.activeExecutions.Add(1);
  } catch (err) {
    env.nodeMu.Unlock();
    throw err;
  }
  env.nodeMu.Unlock();
  return [env.sandbox, () => { env.activeExecutions.Add(-1); }];
};
