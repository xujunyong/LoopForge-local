/**
 * @file internal/runtime/mcp_credentials.js
 * @description 对应 Go 源文件：internal/runtime/mcp_credentials.go
 *
 * 职责与边界：
 * 负责将平台托管的用户个人凭据（`AuthType === "credential"`）绑定到 HTTP MCP 服务的
 * `Authorization: Bearer <token>` 请求头中，并在缺少凭据时按严格/容错模式报错或剔除对应服务。
 * 不负责持久化存储凭据、修改原始资产定义或处理 GitHub Token 鉴权（GitHub 鉴权见 `github_mcp.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(domain.AgentAssetBundle, []string, error)` 译为成功返回 `[out, dropped]`，失败抛出 `Error`。
 * - Go 参数名 `in` 为 JS 保留字，局部改名为 `inHeaders`。
 * - Go 结构体与切片按值复制在 JS 中通过浅拷贝 `{ ...obj }` 与 `[...arr]` 实现，避免修改入参资产。
 */

"use strict";

/**
 * 浅拷贝 HTTP 请求头映射对象，避免后续修改污染原始资产上的请求头。
 * 使用场景：在为单个任务覆写 `Authorization` 等请求头前复制基础头集合。
 *
 * @param {Record<string, string> | null | undefined} inHeaders - 原始请求头映射（对应 Go 参数名 `in`）。
 * @returns {Record<string, string>} 新的请求头浅拷贝对象。
 */
function cloneHeaders(inHeaders) {
  const out = {};
  if (inHeaders) {
    for (const [k, v] of Object.entries(inHeaders)) {
      out[k] = v;
    }
  }
  return out;
}

// MCPAuthCredential 是 MCPServerDefinition.AuthType 的取值之一，用于将平台托管凭据
// 绑定为 MCP 服务的 Authorization Bearer 请求头。具体凭据名称由 CredentialKind 指定，
// 并在每次运行时从 RunCredentials.Extra 中解析，确保存储的资产本身不保存明文密钥。
const MCPAuthCredential = "credential";

/**
 * 将负责用户的已保存凭据（按 `CredentialKind` 查找）绑定到声明了 `AuthType === "credential"`
 * 的 HTTP MCP 服务请求头中。原始资产不会被就地修改；目标服务上原有的任意大小写 `Authorization`
 * 头都会被移除并替换为 `Bearer <token>`。
 * 当所需凭据缺失时：若 `required` 为 `true` 则直接抛出错误；否则将该服务从结果中剔除并将其名称
 * 记录在返回的剔除列表中，以便其余服务继续工作。
 * 使用场景：Agent 调用、助手调用（`required = true`）或脚本/门禁的尽最大努力绑定（`required = false`）。
 *
 * @param {Object} assets - 待处理的 `domain.AgentAssetBundle` 资产集合。
 * @param {Record<string, string> | null | undefined} extra - 本次运行的扩展凭据映射（键为 `CredentialKind`，值为明文令牌）。
 * @param {boolean} required - 缺少凭据时是否强制失败；为 `false` 时跳过缺失凭据的服务并返回其名称列表。
 * @returns {[Object, string[]]} 二元组 `[out, dropped]`：`out` 为更新后的资产副本，`dropped` 为按字典序排列的被跳过服务名称数组；凭据配置无效或必需凭据缺失时抛出 `Error`。
 */
function BindCredentialMCPHeaders(assets, extra, required) {
  const out = { ...assets };
  out.MCPServers = assets.MCPServers ? [...assets.MCPServers] : [];
  const kept = [];
  const dropped = [];
  for (let i = 0; i < out.MCPServers.length; i++) {
    const server = { ...out.MCPServers[i] };
    if ((server.AuthType || "").trim().toLowerCase() !== MCPAuthCredential) {
      kept.push(server);
      continue;
    }
    const kind = (server.CredentialKind || "").trim();
    if (kind === "") {
      throw new Error(`MCP ${server.Name} declares credential authentication without a credentialKind`);
    }
    const token = ((extra && extra[kind]) || "").trim();
    if (token === "") {
      if (required) {
        throw new Error(`MCP ${server.Name} requires the saved credential ${JSON.stringify(kind)}; configure it in personal settings`);
      }
      dropped.push(server.Name);
      continue;
    }
    server.Headers = cloneHeaders(server.Headers);
    for (const key of Object.keys(server.Headers)) {
      if (key.trim().toLowerCase() === "authorization") {
        delete server.Headers[key];
      }
    }
    server.Headers["Authorization"] = "Bearer " + token;
    kept.push(server);
  }
  out.MCPServers = kept;
  dropped.sort();
  return [out, dropped];
}

/**
 * 判断资产集合中是否存在至少一个需要已保存平台凭据的 MCP 服务。
 * 使用场景：运行前预检是否需要向凭据服务加载用户的扩展凭据。
 *
 * @param {Object} assets - `domain.AgentAssetBundle` 资产集合。
 * @returns {boolean} 若存在任意 `AuthType` 为 `"credential"`（不区分大小写）的服务则返回 `true`，否则返回 `false`。
 */
function RequiresMCPCredential(assets) {
  for (const server of assets.MCPServers || []) {
    if ((server.AuthType || "").trim().toLowerCase() === MCPAuthCredential) {
      return true;
    }
  }
  return false;
}

module.exports = {
  MCPAuthCredential,
  BindCredentialMCPHeaders,
  RequiresMCPCredential,
  cloneHeaders,
};
