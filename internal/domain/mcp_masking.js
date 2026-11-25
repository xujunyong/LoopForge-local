// mcp_masking.js —— 对应 Go 文件：internal/domain/mcp_masking.go
// 作用：MCP 服务凭据在 API 响应里打码，编辑回传时恢复原文。

"use strict";

// MaskedSecretValue：API 响应里替代已存 MCP 凭据的掩码，客户端原样送回即保留原文。
const MaskedSecretValue = "******";

const sensitiveEnvironmentKeyParts = [
  "TOKEN", "SECRET", "PASSWORD", "PASSWD", "API_KEY", "APIKEY", "ACCESS_KEY", "PRIVATE_KEY",
  "AUTH", "COOKIE", "CREDENTIAL", "SESSION",
];

// PublicMCPServer：掩盖全部字面 header 值与键名涉凭据的环境变量值，${secret:NAME} 引用原样展示。
function PublicMCPServer(server) {
  const out = { ...server };
  out.Headers = maskMCPValues(server.Headers, () => true);
  out.Environment = maskMCPValues(server.Environment, sensitiveEnvironmentKey);
  return out;
}

function PublicMCPServers(servers) {
  return (servers ?? []).map((server) => PublicMCPServer(server));
}

// RestoreMaskedMCPSecrets：编辑回传的掩码处恢复已存值，无已存对照的掩码值直接丢弃。
function RestoreMaskedMCPSecrets(incoming, existing) {
  incoming.Headers = restoreMaskedValues(incoming.Headers, existing.Headers);
  incoming.Environment = restoreMaskedValues(incoming.Environment, existing.Environment);
}

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

function sensitiveEnvironmentKey(key) {
  const upper = key.toUpperCase();
  for (const part of sensitiveEnvironmentKeyParts) {
    if (upper.includes(part)) {
      return true;
    }
  }
  return false;
}

module.exports = { MaskedSecretValue, PublicMCPServer, PublicMCPServers, RestoreMaskedMCPSecrets };
