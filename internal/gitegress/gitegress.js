// gitegress.js —— 对应 Go 文件：internal/gitegress/gitegress.go
// 作用：限制控制面连 Git 主机的出口地址，只放行公网地址或管理员授权的网段。
// Go 的 netip.Addr/Prefix 译为本文件的 parseIP / parsePrefix（BigInt 算掩码）；
// net.Dialer 的 Control 回调译为拨号时的 dns.lookup 校验，见 newDialer 的注释。

"use strict";

const net = require("node:net"); // Go net：建连与地址解析
const dns = require("node:dns"); // Go net.Dialer 的 DNS 解析

// AllowCIDRsEnv lists comma-separated networks the control plane may reach
// even though they are not public, for example an internal GitLab.
const AllowCIDRsEnv = "AGENTFLOW_GIT_EGRESS_ALLOW_CIDRS";

const timeout = 30 * 1000;
const connectTimeout = 10 * 1000;

const ErrNonPublicAddress = new Error("git egress: address is not public");
const ErrHTTPSAddressChanged = new Error("git egress: HTTPS address is outside the host authorization");
const ErrHTTPSHostLookup = new Error("git egress: could not load HTTPS host authorization");
const ErrUseLastResponse = new Error("use last response"); // Go 的 http.ErrUseLastResponse：让调用方自己处理重定向

// HTTPSHostLookup resolves a host:port to its approved addresses. A nil result
// means the endpoint uses the default egress policy.
 // JS 里是 async (ctx, address) => Promise<Addr[]>，ctx 为 AbortSignal（可空）。

// parseIP：Go 的 netip.ParseAddr，返回 {value: BigInt, is6: bool}。
function parseIP(s) {
  if (net.isIPv4(s)) {
    let value = 0n;
    for (const part of s.split(".")) {
      value = (value << 8n) | BigInt(Number(part));
    }
    return { value, is6: false };
  }
  if (net.isIPv6(s)) {
    return { value: parseIPv6(s), is6: true };
  }
  return null;
}

// parseIPv6：把 IPv6 文本（含 :: 缩写）展开成 128 位整数。
function parseIPv6(s) {
  const halves = s.split("::");
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length < 2 || halves[1] === "" ? [] : halves[1].split(":");
  const missing = 8 - head.length - tail.length;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  let value = 0n;
  for (const g of groups) {
    // IPv4 尾段（如 ::ffff:192.0.2.1）按两个 16 位组展开。
    if (g.includes(".")) {
      const octets = g.split(".").map(Number);
      value = (value << 16n) | BigInt((octets[0] << 8) | octets[1]);
      value = (value << 16n) | BigInt((octets[2] << 8) | octets[3]);
    } else {
      value = (value << 16n) | BigInt(parseInt(g, 16));
    }
  }
  return value;
}

// parsePrefix：Go 的 netip.ParsePrefix，返回 {network: BigInt, bits, is6}；非法时返回 null。
function parsePrefix(s) {
  const idx = s.lastIndexOf("/");
  if (idx < 0) {
    return null;
  }
  const ip = parseIP(s.slice(0, idx));
  const bits = Number(s.slice(idx + 1));
  if (ip == null || Number.isNaN(bits)) {
    return null;
  }
  const total = ip.is6 ? 128 : 32;
  if (bits < 0 || bits > total) {
    return null;
  }
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(total - bits);
  return { network: ip.value & mask, bits, is6: ip.is6, total };
}

// prefixContains：Go 的 Prefix.Contains。
function prefixContains(prefix, ip) {
  if (ip.is6 !== prefix.is6) {
    return false;
  }
  const mask = prefix.bits === 0 ? 0n : ((1n << BigInt(prefix.bits)) - 1n) << BigInt(prefix.total - prefix.bits);
  return (ip.value & mask) === prefix.network;
}

// mustParsePrefix：Go 的 netip.MustParsePrefix，非法时直接 throw。
function mustParsePrefix(s) {
  const prefix = parsePrefix(s);
  if (prefix == null) {
    throw new Error(`invalid prefix ${s}`);
  }
  return prefix;
}

const nonPublic = [
  mustParsePrefix("0.0.0.0/8"),
  mustParsePrefix("100.64.0.0/10"),
  mustParsePrefix("192.0.0.0/24"),
  mustParsePrefix("198.18.0.0/15"),
  mustParsePrefix("64:ff9b::/96"),
  mustParsePrefix("2001:db8::/32"),
];

// Client returns an HTTP client for user-configured Git hosts. Each
// connection checks the address it actually dials, after DNS resolution, so
// a name cannot resolve to a vetted address and then connect elsewhere.
// Redirects are returned to the caller instead of followed, and no proxy is
// used because a proxy would connect on the client's behalf. Clients do not
// keep connections, so each call follows the current allow list.
function Client(lookup) {
  let dial = DialContext;
  if (lookup != null) {
    dial = async (ctx, network, address) => {
      let approved;
      try {
        approved = await lookup(ctx, address);
      } catch (err) {
        throw new Error(`${ErrHTTPSHostLookup.message}: ${err}`);
      }
      return newDialer(approved).DialContext(ctx, network, address);
    };
  }
  // Go 的 http.Transport / http.Client 在 JS 的 fetch 里没有拨号入口，这里只保留同样的配置结构；
  // 真正发请求时用返回的 dial（见 DialContext）建连，再走 http/https。
  return {
    Timeout: timeout,
    Transport: {
      Proxy: null,
      DialContext: dial,
      TLSHandshakeTimeout: 10 * 1000,
      ResponseHeaderTimeout: 20 * 1000,
      DisableKeepAlives: true,
    },
    CheckRedirect: () => {
      throw ErrUseLastResponse;
    },
  };
}

// DialContext applies the Git egress policy to the address selected by DNS.
async function DialContext(ctx, network, address) {
  return newDialer(null).DialContext(ctx, network, address);
}

function newDialer(approved) {
  const allowed = allowedPrefixes();
  return {
    Timeout: connectTimeout,
    // Control：Go 在 Dialer 选好地址、建连前回调检查；JS 没有这个钩子，
    // 改在 dns.lookup 里逐个校验解析出的地址，只连第一个放行的地址。
    DialContext: (ctx, network, address) => dialWithCheck(ctx, network, address, allowed, approved),
  };
}

// dialWithCheck：解析主机名，逐个按 checkAddress 校验，建连到第一个放行地址。
async function dialWithCheck(ctx, network, address, allowed, approved) {
  const { host, port } = splitHostPort(address);
  const resolved = await new Promise((resolve, reject) => {
    dns.lookup(host, { all: true }, (err, addresses) => {
      if (err) {
        reject(err);
      } else {
        resolve(addresses);
      }
    });
  });
  let lastErr = null;
  for (const entry of resolved) {
    const addrPort = entry.family === 6 ? `[${entry.address}]:${port}` : `${entry.address}:${port}`;
    try {
      checkAddress(addrPort, allowed, approved);
    } catch (err) {
      lastErr = err;
      continue;
    }
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: entry.address, port });
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
  }
  throw lastErr ?? new Error(`git egress: no allowed address for ${address}`);
}

// splitHostPort：Go 的 net.SplitHostPort（这里只拆 host:port 形式）。
function splitHostPort(address) {
  if (address.startsWith("[")) {
    const idx = address.indexOf("]");
    return { host: address.slice(1, idx), port: Number(address.slice(idx + 2)) };
  }
  const idx = address.lastIndexOf(":");
  return { host: address.slice(0, idx), port: Number(address.slice(idx + 1)) };
}

function checkAddress(address, allowed, approved) {
  const parsed = parseAddrPort(address);
  if (parsed == null) {
    throw new Error(`git egress: unexpected address "${address}"`);
  }
  const ip = unmap(parsed);
  if (approved != null) {
    if (approved.some((a) => a.value === ip.value && a.is6 === ip.is6)) {
      return;
    }
    throw ErrHTTPSAddressChanged;
  }
  for (const prefix of allowed) {
    if (prefixContains(prefix, ip)) {
      return;
    }
  }
  if (!isPublic(ip)) {
    throw new Error(`${ErrNonPublicAddress.message}: ${formatIP(ip)}; allow it in ${AllowCIDRsEnv}`);
  }
}

// parseAddrPort：Go 的 netip.ParseAddrPort，返回 {value, is6}。
function parseAddrPort(address) {
  const { host } = splitHostPort(address);
  return parseIP(host);
}

// unmap：Go 的 Addr.Unmap，把 ::ffff:a.b.c.d 形式的 IPv6 映射地址还原为 IPv4。
function unmap(ip) {
  if (ip.is6 && (ip.value >> 32n) === 0xffffn) {
    return { value: ip.value & 0xffffffffn, is6: false };
  }
  return ip;
}

// formatIP：把内部地址表示还原为文本，只用于错误信息。
function formatIP(ip) {
  if (!ip.is6) {
    const v = ip.value;
    return `${Number((v >> 24n) & 0xffn)}.${Number((v >> 16n) & 0xffn)}.${Number((v >> 8n) & 0xffn)}.${Number(v & 0xffn)}`;
  }
  const groups = [];
  for (let i = 7; i >= 0; i--) {
    groups.push(((ip.value >> BigInt(i * 16)) & 0xffffn).toString(16));
  }
  return groups.join(":");
}

function isPublic(ip) {
  if (!isGlobalUnicast(ip) || isPrivate(ip) || isLoopback(ip) || isLinkLocalUnicast(ip)) {
    return false;
  }
  for (const prefix of nonPublic) {
    if (prefixContains(prefix, ip)) {
      return false;
    }
  }
  return true;
}

// isGlobalUnicast：Go 的 Addr.IsGlobalUnicast，排除未指定、组播与保留地址。
function isGlobalUnicast(ip) {
  if (ip.value === 0n) {
    return false;
  }
  if (!ip.is6) {
    return ip.value < (224n << 24n);
  }
  return (ip.value >> 120n) !== 0xffn;
}

const privatePrefixes = [
  "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
  "fc00::/7",
].map(mustParsePrefix);
const linkLocalPrefix = mustParsePrefix("fe80::/10");

// isPrivate：Go 的 Addr.IsPrivate。
function isPrivate(ip) {
  return privatePrefixes.some((prefix) => prefixContains(prefix, ip));
}

// isLoopback：Go 的 Addr.IsLoopback。
function isLoopback(ip) {
  if (!ip.is6) {
    return (ip.value >> 24n) === 127n;
  }
  return ip.value === 1n;
}

// isLinkLocalUnicast：Go 的 Addr.IsLinkLocalUnicast。
function isLinkLocalUnicast(ip) {
  if (!ip.is6) {
    return (ip.value >> 16n) === ((169n << 8n) | 254n);
  }
  return prefixContains(linkLocalPrefix, ip);
}

function allowedPrefixes() {
  const out = [];
  const raw = process.env[AllowCIDRsEnv] ?? "";
  for (const part of raw.split(",")) {
    const prefix = parsePrefix(part.trim());
    if (prefix != null) {
      out.push(masked(prefix));
    }
  }
  return out;
}

// masked：Go 的 Prefix.Masked，把主机位清零。
function masked(prefix) {
  const mask = prefix.bits === 0 ? 0n : ((1n << BigInt(prefix.bits)) - 1n) << BigInt(prefix.total - prefix.bits);
  return { ...prefix, network: prefix.network & mask };
}

module.exports = {
  AllowCIDRsEnv, ErrNonPublicAddress, ErrHTTPSAddressChanged, ErrHTTPSHostLookup,
  Client, DialContext,
};
