/**
 * 对应 Go 文件：internal/domain/https_host.go
 * 作用：校验并规范化 HTTPS Git 主机名或 IPv6 地址，生成供凭据与交付链接共用的标准 authority 字符串。
 * 职责边界：仅负责 HTTPS 主机与端口格式的解析、合法性校验与规范化输出，不发起网络连接。
 * 语法差异说明：
 * - Go 的 (string, error) 返回约定译为成功返回字符串、失败抛出 Error；
 * - Go 的 net/netip 校验与压缩译为 node:net 的 isIP 搭配 WHATWG URL 的 IPv6 规范化。
 */

"use strict";

const net = require("node:net"); // 对应 Go net/netip，用于判断 IP 地址类型

/** 单个域名标签正则：由小写字母、数字和连字符组成，首尾必须为字母或数字。 */
const httpsHostLabel = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
/** 纯数字正则，用于拒绝全数字顶级域名。 */
const allDigits = /^[0-9]+$/;
/** 非法 HTTPS Git 主机输入时抛出的标准错误对象。 */
const errHTTPSHost = new Error("请输入 HTTPS Git 主机名或 IPv6 地址。IPv6 带端口时请用 [fd00::2]:8443");

/**
 * 将原始输入规范化为用于 Git 凭据作用域与交付链接的 HTTPS authority 字符串。
 * 自动去除 https:// 前缀与末尾斜杠、省略默认 443 端口、为 IPv6 地址补齐方括号并压缩为标准形式。
 *
 * @param {string} raw - 原始主机名、HTTPS URL 或 IPv6（可带端口）字符串。
 * @returns {string} 规范化后的 HTTPS authority（如 "git.example.com"、"git.example.com:8443"、"[fd00::2]"）。
 * @throws {Error} 当协议非 https、含非法字符、端口越界或主机名/IPv6 不合法时抛出 errHTTPSHost。
 */
function HTTPSHostScope(raw) {
  let s = raw.toLowerCase().trim();
  let scheme = "";
  let rest = s;
  let hasScheme = false;
  const cut = s.indexOf("://");
  if (cut >= 0) {
    scheme = s.slice(0, cut);
    rest = s.slice(cut + 3);
    hasScheme = true;
  }
  if (hasScheme) {
    if (scheme !== "https") {
      throw errHTTPSHost;
    }
    s = rest;
  }
  if (s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  if (s === "" || /[/@?#*% \t\r\n]/.test(s)) {
    throw errHTTPSHost;
  }
  if (!hasScheme && s.split(":").length - 1 > 1 && !s.startsWith("[")) {
    // 裸 IPv6 地址使用默认端口；显式指定端口时需使用方括号格式。
    s = "[" + s + "]";
  }

  let host = s;
  let port = "";
  const bracketed = s.startsWith("[");
  if (bracketed && s.endsWith("]")) {
    host = s.slice(1, -1);
  } else if (s.includes(":")) {
    const hp = splitHostPort(s);
    if (hp === null) {
      throw errHTTPSHost;
    }
    host = hp.host;
    port = hp.port;
    const n = atoi(port);
    if (n === null || n < 1 || n > 65535 || String(n) !== port) {
      throw errHTTPSHost;
    }
  }
  if (bracketed) {
    // 对应 Go netip.ParseAddr + String：拒绝 IPv4 与 IPv4 映射 IPv6（含点号），并转为标准压缩形式。
    if (host.includes(".") || net.isIP(host) !== 6) {
      throw errHTTPSHost;
    }
    host = canonicalIPv6(host);
    if (host === null) {
      throw errHTTPSHost;
    }
  } else if (!validHTTPSHostName(host)) {
    throw errHTTPSHost;
  }
  if (port === "" || port === "443") {
    return host;
  }
  return host + ":" + port;
}

/**
 * 校验非方括号形式的主机字符串是否为合法 HTTPS 域名（不允许纯 IP 地址或全数字末段标签）。
 * 供 HTTPSHostScope 在非 IPv6 分支中调用。
 *
 * @param {string} host - 已转为小写的候选主机名字符串。
 * @returns {boolean} 符合长度、标签字符与非纯 IP 规则时返回 true，否则返回 false。
 */
function validHTTPSHostName(host) {
  if (host === "" || host.length > 253) {
    return false;
  }
  if (net.isIP(host) !== 0) {
    return false;
  }
  const labels = host.split(".");
  for (const label of labels) {
    if (label.length > 63 || !httpsHostLabel.test(label)) {
      return false;
    }
  }
  return !allDigits.test(labels[labels.length - 1]);
}

/**
 * 将 "host:port" 或 "[ipv6]:port" 拆分为主机与端口两部分，对应 Go 标准库 net.SplitHostPort。
 * 供 HTTPSHostScope 解析带端口的主机输入。
 *
 * @param {string} addr - 包含冒号的地址字符串。
 * @returns {{ host: string, port: string }|null} 拆分成功返回主机与端口对象，格式不合法返回 null。
 */
function splitHostPort(addr) {
  const m = addr.match(/^(?:\[([^\]]+)\]|([^:]*)):([0-9]*)$/);
  if (!m) {
    return null;
  }
  return { host: m[1] ?? m[2], port: m[3] };
}

/**
 * 借助 WHATWG URL 将 IPv6 地址转为带方括号的规范压缩形式（如 "[fd00::2]"）。
 * 供 HTTPSHostScope 替代 Go netip.Addr.String 的压缩行为。
 *
 * @param {string} host - 不带方括号的 IPv6 地址字符串。
 * @returns {string|null} 规范化后的带方括号 IPv6 字符串；解析失败返回 null。
 */
function canonicalIPv6(host) {
  try {
    return new URL("http://[" + host + "]/").hostname;
  } catch {
    return null;
  }
}

/**
 * 将严格十进制整数字符串转为整数，对应 Go 标准库 strconv.Atoi。
 * 供 HTTPSHostScope 解析端口号。
 *
 * @param {string} s - 待解析的整数字符串。
 * @returns {number|null} 解析成功返回整数值，非纯整数字符串返回 null。
 */
function atoi(s) {
  if (!/^-?\d+$/.test(s)) {
    return null;
  }
  return Number.parseInt(s, 10);
}

module.exports = { HTTPSHostScope };
