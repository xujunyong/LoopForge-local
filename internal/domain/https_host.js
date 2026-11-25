// https_host.js —— 对应 Go 文件：internal/domain/https_host.go
// 作用：规范化 HTTPS Git 主机名或 IPv6 地址，供凭据与交付链接共用。
// Go 的 net/netip 译为 node:net 的 isIP 与 WHATWG URL 的 IPv6 规范化；(值, error) 译为返回值、失败 throw。

"use strict";

const net = require("node:net"); // Go net/netip：校验 IP 地址

const httpsHostLabel = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const allDigits = /^[0-9]+$/;
const errHTTPSHost = new Error("请输入 HTTPS Git 主机名或 IPv6 地址。IPv6 带端口时请用 [fd00::2]:8443");

// HTTPSHostScope：Git 凭据与交付链接用的规范 HTTPS  authority，默认端口省略，IPv6 加方括号。
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
    // 裸 IPv6 用默认端口，显式端口用方括号。
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
    // Go 的 netip.ParseAddr + String：IPv6 规范压缩形式；含点的是 IPv4 或 4-in-6，都拒绝。
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

// splitHostPort：对应 Go net.SplitHostPort，失败返回 null。
function splitHostPort(addr) {
  const m = addr.match(/^(?:\[([^\]]+)\]|([^:]*)):([0-9]*)$/);
  if (!m) {
    return null;
  }
  return { host: m[1] ?? m[2], port: m[3] };
}

// canonicalIPv6：用 WHATWG URL 解析取规范压缩的 IPv6 形式（含方括号），失败返回 null。
function canonicalIPv6(host) {
  try {
    return new URL("http://[" + host + "]/").hostname;
  } catch {
    return null;
  }
}

// atoi：对应 Go strconv.Atoi，整数字符串才通过，否则返回 null。
function atoi(s) {
  if (!/^-?\d+$/.test(s)) {
    return null;
  }
  return Number.parseInt(s, 10);
}

module.exports = { HTTPSHostScope };
