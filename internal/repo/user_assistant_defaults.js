/**
 * @file internal/repo/user_assistant_defaults.js
 * 对应 Go 源文件：internal/repo/user_assistant_defaults.go
 *
 * 作用与职责边界：
 * 提供用户更新助手默认执行器时的校验错误常量，以及按固定优先级从用户已配置凭据中挑选首个可用默认执行器的辅助函数；
 * 供 `users.js` 在凭据更新与回退默认执行器时复用，不负责凭据持久化。
 */

"use strict";

const { AgentCLIExecutorKinds } = require("../domain/agent.js"); // 对应 Go 的 domain.AgentCLIExecutorKinds，agent.js 已翻译

// 当用户指定的助手默认执行器尚未配置有效凭据时抛出的校验错误。
const ErrAssistantDefaultExecutorUnavailable = new Error("请选择已配置的执行器");

/**
 * 按内置优先级顺序（`codebuddy`、`codex`、`claude-code` 及扩展 `AgentCLIExecutorKinds`）
 * 查找用户首个已配置有效凭据的执行器标识。
 * 使用场景：当用户尚未设置默认执行器、或原默认执行器凭据被清空后自动回退选择可用执行器。
 *
 * @param {import("../domain/user.js").User} user - 待检查凭据配置的用户领域对象。
 * @returns {string} 首个可用的执行器标识；若用户未配置任何执行器凭据则返回空字符串 `""`。
 */
function firstAssistantExecutor(user) {
  for (const executor of ["codebuddy", "codex", "claude-code", ...AgentCLIExecutorKinds]) {
    if (user.HasExecutorCredential(executor)) {
      return executor;
    }
  }
  return "";
}

module.exports = { ErrAssistantDefaultExecutorUnavailable, firstAssistantExecutor };
