/**
 * 对应 Go 文件：internal/domain/mcp_masking.go
 * 作用：在 API 响应中对 MCP 服务配置里的请求头与敏感环境变量进行打码脱敏，并在编辑提交回传掩码时恢复已存储的原值。
 * 职责边界：仅处理 MCP 配置键值对的掩码替换与回填逻辑，不负责加解密或持久化存储。
 */

"use strict";

/** API 响应中用于替代已存储 MCP 凭据的固定掩码；客户端原样回传该掩码即表示保留已存原值。 */
const MaskedSecretValue = "******";

/** 视为敏感凭据的环境变量键名关键词列表（大小写不敏感子串匹配）。 */
const sensitiveEnvironmentKeyParts = [
  "TOKEN", "SECRET", "PASSWORD", "PASSWD", "API_KEY", "APIKEY", "ACCESS_KEY", "PRIVATE_KEY",
  "AUTH", "COOKIE", "CREDENTIAL", "SESSION",
];

/**
 * 返回脱敏后的 MCP 服务定义副本，用于对外 API 响应。
 * 全部非空字面请求头值以及键名包含敏感关键词的环境变量值都会被替换为掩码；
 * `${secret:NAME}` 形式的密钥引用保持原样展示。
 *
 * @param {object} server - 原始 MCP 服务定义对象（包含 Headers 与 Environment 映射）。
 * @returns {object} 请求头与敏感环境变量已打码的服务定义副本。
 */
function PublicMCPServer(server) {
  const out = { ...server };
  out.Headers = maskMCPValues(server.Headers, () => true);
  out.Environment = maskMCPValues(server.Environment, sensitiveEnvironmentKey);
  return out;
}

/**
 * 批量对 MCP 服务定义列表执行脱敏，返回可供 API 响应的新数组。
 *
 * @param {object[]|null|undefined} servers - 原始 MCP 服务定义列表。
 * @returns {object[]} 脱敏后的 MCP 服务定义数组。
 */
function PublicMCPServers(servers) {
  return (servers ?? []).map((server) => PublicMCPServer(server));
}

/**
 * 在编辑保存 MCP 服务定义时，将客户端原样回传的掩码位置原地恢复为已存储的真实值。
 * 若某个掩码键在已有配置中找不到对应原值，则直接删除该键而不是把掩码本身落库。
 *
 * @param {object} incoming - 本次编辑提交的 MCP 服务定义对象（会被原地修改 Headers 与 Environment）。
 * @param {object} existing - 数据库中已存在的原 MCP 服务定义对象。
 * @returns {void} 无返回值。
 */
function RestoreMaskedMCPSecrets(incoming, existing) {
  incoming.Headers = restoreMaskedValues(incoming.Headers, existing.Headers);
  incoming.Environment = restoreMaskedValues(incoming.Environment, existing.Environment);
}

/**
 * 按敏感度判定函数对键值映射执行脱敏复制。
 * 供 PublicMCPServer 分别处理 Headers 与 Environment。
 *
 * @param {Record<string, string>|null|undefined} values - 原始键值映射。
 * @param {(key: string) => boolean} sensitive - 判断指定键是否需要打码的回调函数。
 * @returns {Record<string, string>|null|undefined} 若输入为空映射则原样返回，否则返回打码后的新映射对象。
 */
function maskMCPValues(values, sensitive) {
  if (values == null || Object.keys(values).length === 0) {
    return values;
  }
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== "" && sensitive(key) && !value.includes("${secret:")) {
      out[key] = MaskedSecretValue;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 原地遍历待保存的键值映射，将值为 MaskedSecretValue 的条目回填为 stored 中的原值，无对照则删除。
 * 供 RestoreMaskedMCPSecrets 分别处理 Headers 与 Environment。
 *
 * @param {Record<string, string>|null|undefined} incoming - 待保存的新键值映射（原地修改）。
 * @param {Record<string, string>|null|undefined} stored - 已存储的旧键值映射。
 * @returns {Record<string, string>|null|undefined} 处理后的 incoming 映射引用。
 */
function restoreMaskedValues(incoming, stored) {
  if (incoming == null) {
    return incoming;
  }
  for (const key of Object.keys(incoming)) {
    if (incoming[key] !== MaskedSecretValue) {
      continue;
    }
    if (stored != null && Object.prototype.hasOwnProperty.call(stored, key)) {
      incoming[key] = stored[key];
    } else {
      delete incoming[key];
    }
  }
  return incoming;
}

/**
 * 判断环境变量键名是否包含敏感凭据关键词（不区分大小写）。
 * 供 PublicMCPServer 筛选需要打码的环境变量。
 *
 * @param {string} key - 环境变量键名。
 * @returns {boolean} 键名命中任意敏感词返回 true，否则返回 false。
 */
function sensitiveEnvironmentKey(key) {
  const upper = key.toUpperCase();
  for (const part of sensitiveEnvironmentKeyParts) {
    if (upper.includes(part)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  MaskedSecretValue,
  PublicMCPServer,
  PublicMCPServers,
  RestoreMaskedMCPSecrets,
};
