// hash.js —— 对应 Go 文件：internal/repo/hash.go
// 作用：字符串的 SHA-256 小写十六进制摘要。

"use strict";

const { createHash } = require("node:crypto"); // Go crypto/sha256 与 encoding/hex

// hexSHA256：返回 value 的小写十六进制 SHA-256 摘要。
function hexSHA256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

module.exports = { hexSHA256 };
