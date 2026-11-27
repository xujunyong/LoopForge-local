/**
 * @file internal/runtime/platform_mcp.js
 * @description 对应 Go 源文件：internal/runtime/platform_mcp.go
 *
 * 职责与边界：
 * 负责将解析后的资产集合整理为某次调用实际可访问的 MCP 服务列表：按执行目标重写平台内置 MCP 的地址
 * （或在缺少平台地址时剔除不可达的相对地址服务），并绑定 GitHub Token 与个人托管凭据。
 * 不负责底层 MCP 进程物化、安装脚本执行或命令行工具注入（这些职责位于 `mcp_provision.js` 与 `mcp_call.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(domain.AgentAssetBundle, []string, error)` 译为成功返回 `[assets, warnings]`，失败抛出 `Error`。
 * - Go 的 `(kept, dropped)` 多返回值译为 `[kept, dropped]` 二元组。
 * - Go 的 `net/url.Parse` 使用 Node.js `node:url` 的 `url.parse` 对齐其对相对路径与完整 URL 的宽松解析行为。
 */

"use strict";

const url = require("node:url");

const { PlatformMCPServerID } = require("../domain/agent.js");
const { KnowledgeMCPServerID } = require("../domain/knowledge.js");
const { BindGitHubMCPHeaders } = require("./github_mcp.js"); // 对应 Go 同包函数，github_mcp.js 待翻译
const { BindCredentialMCPHeaders } = require("./mcp_credentials.js");

/**
 * 描述一次调用中 MCP 服务的发起位置、平台访问地址与可用凭据配置。
 */
class MCPTarget {
  /**
   * 构造 `MCPTarget` 实例，未提供字段按 Go 结构体零值初始化。
   * 使用场景：在调用 `PrepareMCPServers` 前组装当前执行端的目标环境与凭据信息。
   *
   * @param {Partial<MCPTarget>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    // ServerURL 为执行侧访问平台的根地址；云端运行留空以沿用引擎解析好的绝对 URL。
    this.ServerURL = init.ServerURL ?? "";
    this.GitHTTPCredentials = init.GitHTTPCredentials ?? {};
    // ExtraCredentials 携带负责用户的平台托管凭据（RunCredentials.Extra），供 AuthType 为 "credential" 的服务使用。
    this.ExtraCredentials = init.ExtraCredentials ?? {};
    // RequireCredentials 为 true 时，缺少凭据鉴权的令牌将直接报错；脚本与门禁设为 false 以容错绑定。
    this.RequireCredentials = init.RequireCredentials ?? false;
    // SSHRepositoriesOnly 表示仅使用 SSH 仓库的工作流，可在缺少 GitHub Token 时跳过 GitHub MCP。
    this.SSHRepositoriesOnly = init.SSHRepositoriesOnly ?? false;
  }
}

/**
 * 将解析后的资产集合整理为本次调用实际可访问的 MCP 服务列表：先按需跳过纯 SSH 场景下无令牌的
 * GitHub MCP，再依次绑定 GitHub 请求头与个人托管凭据，最后根据 `target.ServerURL` 重写或过滤
 * 平台内置 MCP 地址。
 * 使用场景：工作流节点、脚本或 Runner 启动执行前统一准备 MCP 列表与告警信息。
 *
 * @param {Object} assets - 原始 `domain.AgentAssetBundle` 资产集合。
 * @param {MCPTarget} target - 本次调用的目标位置与凭据描述对象。
 * @returns {[Object, string[]]} 二元组 `[outAssets, warnings]`：`outAssets` 为整理后的资产副本，`warnings` 为被跳过或未注入服务的提示列表；凭据绑定失败时抛出 `Error`。
 */
function PrepareMCPServers(assets, target) {
  let outAssets = { ...assets };
  const warnings = [];
  let githubToken = "";
  const credential = target.GitHTTPCredentials ? target.GitHTTPCredentials["github.com"] : null;
  if (credential && credential.Token) {
    githubToken = credential.Token;
  }
  if (target.SSHRepositoriesOnly && githubToken === "") {
    const servers = outAssets.MCPServers || [];
    outAssets.MCPServers = [];
    for (const server of servers) {
      if (server.AuthType === "github-token") {
        warnings.push("Git SSH 仓库可直接推送分支；未配置 GitHub Token，已跳过 " + server.ID);
        continue;
      }
      outAssets.MCPServers.push(server);
    }
  }
  outAssets = BindGitHubMCPHeaders(outAssets, githubToken, target.RequireCredentials);
  let credDropped;
  [outAssets, credDropped] = BindCredentialMCPHeaders(outAssets, target.ExtraCredentials, target.RequireCredentials);
  for (const name of credDropped) {
    warnings.push("未配置所需凭证，已跳过 " + name);
  }
  const base = (target.ServerURL || "").trim().replace(/\/+$/, "");
  if (base !== "") {
    outAssets.MCPServers = rebasePlatformMCP(outAssets.MCPServers, base);
  } else {
    const [kept, dropped] = dropUnreachablePlatformMCP(outAssets.MCPServers);
    outAssets.MCPServers = kept;
    for (const id of dropped) {
      warnings.push("未注入 " + id + "：当前执行实例未配置平台地址（AGENTFLOW_PLATFORM_MCP_URL 或 AGENTFLOW_API_URL，需为沙箱可访问的地址）");
    }
  }
  return [outAssets, warnings];
}

/**
 * 判断指定 ID 的 MCP 服务是否由 AgentFlow 平台自身提供（而非第三方外部服务）。
 * 平台内置 MCP 的 URL 仅相对于执行侧访问平台的根地址才有意义。
 * 使用场景：重写平台 MCP 基地址或过滤不可达的平台服务时进行判定。
 *
 * @param {string} id - MCP 服务标识。
 * @returns {boolean} 属于平台内置 MCP 返回 `true`，否则返回 `false`。
 */
function IsPlatformMCP(id) {
  return id === PlatformMCPServerID || id === KnowledgeMCPServerID;
}

/**
 * 将列表中所有平台内置 MCP 服务的 URL 重写为指定基地址 `base` 下的绝对路径，不修改原数组元素。
 * 使用场景：执行端配置了 `target.ServerURL` 时，把平台内置 MCP 指向该可达地址。
 *
 * @param {Object[]} servers - `domain.MCPServerDefinition` 列表。
 * @param {string} base - 已去除末尾斜杠的平台基础 URL。
 * @returns {Object[]} 重写后的 MCP 服务定义新数组。
 */
function rebasePlatformMCP(servers, base) {
  const list = servers || [];
  const out = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const server = { ...list[i] };
    if (IsPlatformMCP(server.ID)) {
      server.URL = base + platformMCPPath(server.URL);
    }
    out[i] = server;
  }
  return out;
}

/**
 * 过滤掉未包含协议头（`://`）的平台内置 MCP 服务，并记录被剔除的服务 ID。
 * 使用场景：未配置平台基地址时，避免将相对路径形式的平台 MCP 注入到无法解析的沙箱环境中。
 *
 * @param {Object[]} servers - `domain.MCPServerDefinition` 列表。
 * @returns {[Object[], string[]]} 二元组 `[kept, dropped]`：`kept` 为保留的服务列表，`dropped` 为被剔除的平台服务 ID 列表。
 */
function dropUnreachablePlatformMCP(servers) {
  const kept = [];
  const dropped = [];
  for (const server of servers || []) {
    if (IsPlatformMCP(server.ID) && !(server.URL || "").includes("://")) {
      dropped.push(server.ID);
      continue;
    }
    kept.push(server);
  }
  return [kept, dropped];
}

/**
 * 从平台 MCP 的原始 URL 中提取路径及可选查询字符串；若解析失败或路径为空则返回原字符串。
 * 使用场景：`rebasePlatformMCP` 拼接新基地址与原服务端点路径时调用。
 *
 * @param {string} raw - 原始平台 MCP URL（可能是相对路径或完整 URL）。
 * @returns {string} 提取出的路径（含 `?query`）或原始字符串。
 */
function platformMCPPath(raw) {
  try {
    const u = url.parse(raw);
    if (u && u.pathname) {
      if (u.query) {
        return u.pathname + "?" + u.query;
      }
      return u.pathname;
    }
  } catch (_) {
    // 解析失败时回退到原始字符串
  }
  return raw;
}

module.exports = {
  MCPTarget,
  PrepareMCPServers,
  IsPlatformMCP,
};
