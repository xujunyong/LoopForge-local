// claude_endpoint.js —— 对应 Go 文件：internal/runtime/claude_endpoint.go
//
// 文件作用与职责边界：
// 为本地执行与 Runner 执行共用，配置 Claude Code 所使用的 Anthropic Messages 端点环境变量，
// 并在目标主机为 DeepSeek 兼容端点时写入对应的协议兼容开关。
//
// Go 与 JS 语法差异说明：
// - Go 的 `net/url.Parse` 译为 Node.js `new URL(...)`，解析失败时按 Go 语义跳过特殊分支；
// - Go 的 `map[string]string` 译为普通对象 `{}`。

"use strict";

const { URL } = require("node:url"); // 对应 Go 标准库 net/url

/**
 * 配置 Anthropic Messages 端点地址及供应商专用协议环境变量。
 * 在本地和 Runner 启动 Claude Code 进程前调用；当 baseURL 为空时回退到官方端点，
 * 当主机名为 `api.deepseek.com` 时禁用延迟工具搜索与实验性 beta 字段以兼容其协议。
 * @param {Object<string, string>} env - 待写入的环境变量映射对象（原地修改）。
 * @param {string} baseURL - 用户或配置指定的 Anthropic API 基础地址。
 * @returns {void} 无返回值。
 */
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
    // 对应 Go：url.Parse 失败时跳过。
  }
  if (endpoint !== null && endpoint.hostname.toLowerCase() === "api.deepseek.com") {
    env["ENABLE_TOOL_SEARCH"] = "false";
    env["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"] = "1";
  }
}

module.exports = { BindClaudeCodeEndpoint };
