// claude_endpoint.js —— 对应 Go 文件：internal/runtime/claude_endpoint.go
// 作用：给 Claude Code 调用配置 Anthropic 端点及 DeepSeek 专用的协议选项。

"use strict";

const { URL } = require("node:url"); // Go net/url

// BindClaudeCodeEndpoint：配置 Anthropic Messages 端点及供应商专用的协议选项，供本地与 Runner 调用共用。
function BindClaudeCodeEndpoint(env, baseURL) {
  baseURL = baseURL.trim();
  if (baseURL === "") {
    baseURL = "https://api.anthropic.com";
  }
  env["ANTHROPIC_BASE_URL"] = baseURL;
  // DeepSeek 的 Anthropic 端点拒绝内联的 beta 工具定义。
  // 禁止新的延迟工具搜索，并在 Claude Code 回放旧会话中已存的工具搜索结果时去掉 beta 字段。
  let endpoint = null;
  try {
    endpoint = new URL(baseURL);
  } catch {
    // Go：url.Parse 失败时跳过。
  }
  if (endpoint !== null && endpoint.hostname.toLowerCase() === "api.deepseek.com") {
    env["ENABLE_TOOL_SEARCH"] = "false";
    env["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"] = "1";
  }
}

module.exports = { BindClaudeCodeEndpoint };
