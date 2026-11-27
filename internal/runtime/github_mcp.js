// github_mcp.js —— 对应 Go 文件：internal/runtime/github_mcp.go
//
// 文件作用与职责边界：
// 将操作者的 Git 令牌严格绑定到 GitHub 官方 MCP 端点（`https://api.githubcopilot.com`），
// 防止任意自定义 MCP 服务通过声明 `github-token` 鉴权类型窃取用户的 Git 令牌。
//
// Go 与 JS 语法差异说明：
// - Go 的 `(domain.AgentAssetBundle, error)` 译为成功返回新的资产包浅拷贝对象、失败 `throw Error`；
// - Go 的 `net/url.Parse` 译为 `new URL(...)`，其中 `u.Scheme == "https"` 对应 `u.protocol === "https:"`，
//   `u.User != nil` 对应 `u.username !== "" || u.password !== ""`。

"use strict";

const { cloneHeaders } = require("./mcp_credentials.js"); // 对应 Go 同包函数，mcp_credentials.js 待翻译

/**
 * 为资产包中所有声明 `AuthType === "github-token"` 的 MCP 服务绑定 Bearer 鉴权请求头。
 * 仅允许绑定至 GitHub 官方 HTTPS MCP 端点（`api.githubcopilot.com`），并清除原有大小写无关的 `Authorization` 头。
 *
 * @param {Object} assets Agent 资产包（`domain.AgentAssetBundle` 结构），包含 `MCPServers` 列表。
 * @param {string} token 负责用户的 Git 访问令牌。
 * @param {boolean} required 当令牌为空时是否必须报错终止。
 * @returns {Object} 绑定好请求头后的资产包副本；端点不合法或必需令牌缺失时抛出 `Error`。
 */
function BindGitHubMCPHeaders(assets, token, required) {
  const out = {
    ...assets,
    MCPServers: (assets.MCPServers ?? []).map((server) => ({ ...server })),
  };
  for (let i = 0; i < out.MCPServers.length; i++) {
    const server = out.MCPServers[i];
    if (server.AuthType !== "github-token") {
      continue;
    }
    let u;
    try {
      u = new URL(server.URL);
    } catch {
      throw new Error("GitHub token authentication requires the official HTTPS MCP endpoint");
    }
    if (u.protocol !== "https:" || u.host !== "api.githubcopilot.com" || u.username !== "" || u.password !== "") {
      throw new Error("GitHub token authentication requires the official HTTPS MCP endpoint");
    }
    server.Headers = cloneHeaders(server.Headers);
    for (const key of Object.keys(server.Headers)) {
      if (key.toLowerCase() === "authorization") {
        delete server.Headers[key];
      }
    }
    if ((token ?? "").trim() === "") {
      if (required) {
        throw new Error("GitHub MCP requires the responsible user's Git token");
      }
      continue;
    }
    server.Headers["Authorization"] = "Bearer " + token.trim();
  }
  return out;
}

module.exports = {
  BindGitHubMCPHeaders,
};
