// user_assistant_defaults.js —— 对应 Go 文件：internal/repo/user_assistant_defaults.go
// 作用：助手默认执行器：按优先级选用户已配密钥的执行器。

"use strict";

const { AgentCLIExecutorKinds } = require("../domain/agent.js"); // 对应 Go 的 domain.AgentCLIExecutorKinds，agent.js 已翻译

const ErrAssistantDefaultExecutorUnavailable = new Error("请选择已配置的执行器");

function firstAssistantExecutor(user) {
  for (const executor of ["codebuddy", "codex", "claude-code", ...AgentCLIExecutorKinds]) {
    if (user.HasExecutorCredential(executor)) {
      return executor;
    }
  }
  return "";
}

module.exports = { ErrAssistantDefaultExecutorUnavailable, firstAssistantExecutor };
