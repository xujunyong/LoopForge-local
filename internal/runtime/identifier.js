// identifier.js —— 对应 Go 文件：internal/runtime/identifier.go
//
// 文件作用与职责边界：
// 提供运行时目录名、文件名及资源标识符的统一清洗函数，将任意输入规范化为仅含小写字母、
// 数字与连字符且长度不超过 48 的安全标识符。
//
// Go 与 JS 语法差异说明：
// - Go 的 `strings.Builder` 译为字符串累加，`for _, r := range v` 译为按 Unicode 码点迭代 `for (const r of v)`。

"use strict";

/**
 * 将输入字符串清洗为安全的运行时标识符：转为小写，仅保留 `a-z`、`0-9` 与 `-`，并截断至最多 48 个字符。
 * 供工作区控制目录命名、Hook 文件命名、规则/MCP/技能目录命名等场景使用。
 *
 * @param {string} v 原始标识字符串。
 * @returns {string} 清洗并截断后的安全标识符；若无合法字符则返回空字符串。
 */
function safeID(v) {
  v = (v ?? "").toLowerCase();
  let b = "";
  for (const r of v) {
    if ((r >= "a" && r <= "z") || (r >= "0" && r <= "9") || r === "-") {
      b += r;
    }
  }
  if (b.length > 48) {
    return b.slice(0, 48);
  }
  return b;
}

module.exports = {
  safeID,
};
