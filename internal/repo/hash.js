/**
 * @file internal/repo/hash.js
 * @description 对应 Go 文件：internal/repo/hash.go
 * 职责与边界：提供仓库层通用的字符串 SHA-256 小写十六进制摘要计算工具，
 * 用于生成令牌哈希、幂等执行键、Bot 会话与消息标识及分布式锁键等定长摘要。
 * 语法差异说明：
 * - Go 的 `sha256.Sum256` 与 `hex.EncodeToString` 组合直接译为 Node.js `node:crypto` 的 `createHash("sha256").update(..., "utf8").digest("hex")`。
 */

"use strict";

const { createHash } = require("node:crypto"); // Go crypto/sha256 与 encoding/hex

/**
 * 计算输入字符串的 UTF-8 字节序列的 SHA-256 摘要，并返回小写十六进制字符串。
 * 使用场景：在 `insights.js`、`bot_identities.js`、`bot_interactions.js`、`integration_lock.js` 等模块中生成确定性哈希键或令牌摘要。
 *
 * @param {string} value - 待计算摘要的原始字符串。
 * @returns {string} 64 位小写十六进制 SHA-256 摘要字符串。
 */
function hexSHA256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

module.exports = { hexSHA256 };
