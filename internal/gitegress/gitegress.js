/**
 * @file internal/gitegress/gitegress.js
 * @description 对应 Go 文件：internal/gitegress/gitegress.go
 * 职责与边界：约束控制面向用户配置的 Git 托管主机发起的出站网络连接（含令牌校验、PR 发现与主机公钥发现等），
 * 在 DNS 解析后、实际建连前校验目标 IP 是否为公网地址、管理员授权的 HTTPS 主机地址或环境变量放行网段（工作区流量不经由此处）。
 * 语法差异说明：
 * - Go 原函数 `public` 命中 JS 严格模式保留字，局部改名为 `isPublic`。
 * - Go 的 `netip.Addr` / `netip.Prefix` 译为内部对象 `{ value: BigInt, is6: boolean }` 与 `{ network: BigInt, bits: number, is6: boolean, total: number }`。
 * - Go 的 `net.Dialer.Control` 回调在 JS 中无底层 socket 钩子，改在 `dialWithCheck` 中先执行 `dns.lookup` 逐一校验解析结果，仅对放行地址建连；因涉及异步 DNS 与建连，拨号函数使用 `async/await`。
 * - Go 的 `time.Duration` 译为毫秒数；`context.Context` 译为 `AbortSignal`（可为空）；`(值, error)` 译为成功返回值、失败 `throw Error`。
 */

"use strict";

const net = require("node:net"); // 对应 Go net：TCP 建连与 IP 格式判定
const dns = require("node:dns"); // 对应 Go net.Dialer 的 DNS 解析

// AllowCIDRsEnv 指定允许控制面访问的非公网 CIDR 网段列表（逗号分隔），例如企业内网 GitLab。
const AllowCIDRsEnv = "AGENTFLOW_GIT_EGRESS_ALLOW_CIDRS";

const timeout = 30 * 1000;
const connectTimeout = 10 * 1000;

const ErrNonPublicAddress = new Error("git egress: address is not public");
const ErrHTTPSAddressChanged = new Error("git egress: HTTPS address is outside the host authorization");
const ErrHTTPSHostLookup = new Error("git egress: could not load HTTPS host authorization");
const ErrUseLastResponse = new Error("use last response"); // 对应 Go 的 http.ErrUseLastResponse：不自动跟随重定向

// HTTPSHostLookup 类型约定：async (ctx, address) => Promise<Array<{ value: bigint, is6: boolean }>|null>
// 将 host:port 解析为管理员预先批准的 IP 地址列表；返回 null 时回退到默认公网/白名单出口策略。

/**
 * 将 IPv4 或 IPv6 文本解析为内部大整数地址表示，对应 Go 的 `netip.ParseAddr`。
 * 在 CIDR 解析、主机端口解析与地址白名单比对时调用。
 * @param {string} s - 待解析的 IPv4 或 IPv6 地址字符串。
 * @returns {{ value: bigint, is6: boolean }|null} 解析成功返回 `{ value, is6 }`，非法字符串返回 `null`。
 */
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

/**
 * 将合法的 IPv6 地址字符串（支持 `::` 零段缩写及末尾内嵌 IPv4 写法）展开为 128 位无符号 `BigInt`。
 * 由 `parseIP` 在 `net.isIPv6` 校验通过后内部调用。
 * @param {string} s - 合法的 IPv6 地址字符串（如 `"::ffff:192.0.2.1"` 或 `"64:ff9b::192.0.2.1"`）。
 * @returns {bigint} 对应的 128 位无符号整数地址值。
 */
function parseIPv6(s) {
  // 若尾部包含点分十进制 IPv4 段（占两个 16 位组），先展开为两个十六进制组再按 8 组补齐 `::`。
  if (s.includes(".")) {
    const lastColon = s.lastIndexOf(":");
    const octets = s.slice(lastColon + 1).split(".").map(Number);
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split("::");
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length < 2 || halves[1] === "" ? [] : halves[1].split(":");
  const missing = 8 - head.length - tail.length;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  let value = 0n;
  for (const g of groups) {
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

/**
 * 将 CIDR 字符串解析为网络前缀对象，对应 Go 的 `netip.ParsePrefix`。
 * 在解析内置保留网段及环境变量 `AGENTFLOW_GIT_EGRESS_ALLOW_CIDRS` 配置时调用。
 * @param {string} s - CIDR 网段字符串（如 `"10.0.0.0/8"` 或 `"2001:db8::/32"`）。
 * @returns {{ network: bigint, bits: number, is6: boolean, total: number }|null} 解析成功返回前缀对象，格式或掩码位数非法时返回 `null`。
 */
function parsePrefix(s) {
  const idx = s.lastIndexOf("/");
  if (idx < 0) {
    return null;
  }
  const ip = parseIP(s.slice(0, idx));
  const bitsStr = s.slice(idx + 1);
  if (ip == null || !/^(0|[1-9]\d*)$/.test(bitsStr)) {
    return null;
  }
  const bits = Number(bitsStr);
  const total = ip.is6 ? 128 : 32;
  if (bits < 0 || bits > total) {
    return null;
  }
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(total - bits);
  return { network: ip.value & mask, bits, is6: ip.is6, total };
}

/**
 * 判断指定 IP 地址是否落在给定 CIDR 前缀网段内，对应 Go 的 `netip.Prefix.Contains`。
 * 在出口地址白名单匹配、私网判定及非公网网段拦截时调用。
 * @param {{ network: bigint, bits: number, is6: boolean, total: number }} prefix - 已解析的 CIDR 前缀对象。
 * @param {{ value: bigint, is6: boolean }} ip - 已解析的 IP 地址对象。
 * @returns {boolean} 同协议族且网络前缀一致时返回 `true`，否则返回 `false`。
 */
function prefixContains(prefix, ip) {
  if (ip.is6 !== prefix.is6) {
    return false;
  }
  const mask = prefix.bits === 0 ? 0n : ((1n << BigInt(prefix.bits)) - 1n) << BigInt(prefix.total - prefix.bits);
  return (ip.value & mask) === prefix.network;
}

/**
 * 解析固定内置 CIDR 字符串，非法时直接抛出异常，对应 Go 的 `netip.MustParsePrefix`。
 * 在模块初始化阶段预编译静态保留/私有网段表时调用。
 * @param {string} s - 必须合法的 CIDR 网段字符串。
 * @returns {{ network: bigint, bits: number, is6: boolean, total: number }} 解析后的前缀对象。
 */
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

/**
 * 返回用于访问用户配置 Git 主机的 HTTP 客户端配置对象。
 * 每次建连均在 DNS 解析后对真实拨号地址做出口策略校验，禁用代理、禁用长连接复用，且不自动跟随重定向。
 * 在控制面发起 Git 令牌校验、PR/MR 发现等 HTTP 请求前调用。
 * @param {Function|null} [lookup] - 可选的 HTTPS 主机授权查询回调 `async (ctx, address) => Addr[]|null`；为空时使用默认出口策略。
 * @returns {Object} 与 Go `http.Client` 结构一致的客户端配置对象（含 `Timeout`、`Transport` 与 `CheckRedirect`）。
 */
function Client(lookup) {
  let dial = DialContext;
  if (lookup != null) {
    dial = async (ctx, network, address) => {
      const timeoutSignal = AbortSignal.timeout(connectTimeout);
      const dialCtx = ctx instanceof AbortSignal ? AbortSignal.any([ctx, timeoutSignal]) : timeoutSignal;
      let approved;
      try {
        approved = await lookup(dialCtx, address);
      } catch (err) {
        throw new Error(`${ErrHTTPSHostLookup.message}: ${err}`, { cause: ErrHTTPSHostLookup });
      }
      return newDialer(approved).DialContext(dialCtx, network, address);
    };
  }
  // Go 的 http.Transport / http.Client 在 JS 的 fetch 中没有自定义拨号入口，保留与 Go 对应的配置结构；
  // 实际建连通过 Transport.DialContext 执行出口校验与拨号。
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

/**
 * 使用默认 Git 出口安全策略解析目标地址并建立 TCP 连接（不走管理员单主机授权表）。
 * 在无需自定义 HTTPS 主机授权（如 SSH 主机公钥探测或默认 HTTP 拨号）时调用。
 * @param {AbortSignal|null} ctx - 可选的连接取消信号，对应 Go 的 `context.Context`。
 * @param {string} network - 网络类型（如 `"tcp"`、`"tcp4"`、`"tcp6"`）。
 * @param {string} address - 目标主机与端口字符串（`host:port` 或 `[ipv6]:port`）。
 * @returns {Promise<net.Socket>} 异步返回已建立的 TCP `net.Socket` 连接；地址被拦截或建连失败时抛出错误。
 */
async function DialContext(ctx, network, address) {
  return newDialer(null).DialContext(ctx, network, address);
}

/**
 * 构造携带当前环境变量白名单与可选已批准 IP 列表的拨号器对象。
 * 在每次拨号时读取最新 `AGENTFLOW_GIT_EGRESS_ALLOW_CIDRS`，确保动态配置立即生效。
 * @param {Array<{ value: bigint, is6: boolean }>|null} approved - 管理员预先批准的目标 IP 列表；为 `null` 时使用默认公网+白名单策略。
 * @returns {{ Timeout: number, DialContext: Function }} 带有 `Timeout` 与 `DialContext` 方法的拨号器对象。
 */
function newDialer(approved) {
  const allowed = allowedPrefixes();
  return {
    Timeout: connectTimeout,
    // Control：Go 在 Dialer 选好地址、建连前触发回调检查；JS 改在 dialWithCheck 中先解析 DNS 再逐个校验放行。
    DialContext: (ctx, network, address) => dialWithCheck(ctx, network, address, allowed, approved),
  };
}

/**
 * 解析目标主机 DNS 记录，按顺序对每个解析出的 IP 调用 `checkAddress` 校验，并连接到首个通过校验的地址。
 * 由 `newDialer` 返回的 `DialContext` 内部调用。
 * @param {AbortSignal|null} ctx - 可选的连接取消信号。
 * @param {string} network - 网络类型（`"tcp4"` 仅查 IPv4，`"tcp6"` 仅查 IPv6，其余查询全部）。
 * @param {string} address - 目标 `host:port` 地址字符串。
 * @param {Array<Object>} allowed - 从环境变量解析的放行 CIDR 前缀列表。
 * @param {Array<{ value: bigint, is6: boolean }>|null} approved - 管理员批准的 IP 列表或 `null`。
 * @returns {Promise<net.Socket>} 异步返回首个成功建立的 TCP `net.Socket`；全部被拒或建连失败时抛出最后一次错误。
 */
async function dialWithCheck(ctx, network, address, allowed, approved) {
  const parsedHostPort = splitHostPort(address);
  if (parsedHostPort == null) {
    throw new Error(`git egress: unexpected address "${address}"`);
  }
  const { host, port } = parsedHostPort;
  const family = network === "tcp4" ? 4 : network === "tcp6" ? 6 : 0;
  const resolved = await new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, family }, (err, addresses) => {
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
      const timeoutSignal = AbortSignal.timeout(connectTimeout);
      const signal = ctx instanceof AbortSignal ? AbortSignal.any([ctx, timeoutSignal]) : timeoutSignal;
      const socket = net.createConnection({ host: entry.address, port, signal });
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
  }
  throw lastErr ?? new Error(`git egress: no allowed address for ${address}`);
}

/**
 * 将 `host:port` 或 `[ipv6]:port` 拆分为主机名、端口号与是否带方括号标记，对应 Go 的 `net.SplitHostPort`。
 * 在 `dialWithCheck` 解析目标主机端口与 `parseAddrPort` 校验 IP:Port 字符串时调用。
 * @param {string} address - 待拆分的地址端口字符串。
 * @returns {{ host: string, port: number, bracketed: boolean }|null} 合法时返回拆分结果，缺少端口、方括号不匹配或端口非 `0..65535` 整数时返回 `null`。
 */
function splitHostPort(address) {
  if (typeof address !== "string") {
    return null;
  }
  let host;
  let portStr;
  let bracketed = false;
  if (address.startsWith("[")) {
    const idx = address.indexOf("]");
    if (idx < 0 || address[idx + 1] !== ":") {
      return null;
    }
    host = address.slice(1, idx);
    portStr = address.slice(idx + 2);
    bracketed = true;
  } else {
    const idx = address.lastIndexOf(":");
    if (idx < 0 || address.indexOf(":") !== idx) {
      return null;
    }
    host = address.slice(0, idx);
    portStr = address.slice(idx + 1);
  }
  if (!/^(0|[1-9]\d*)$/.test(portStr)) {
    return null;
  }
  const port = Number(portStr);
  if (port < 0 || port > 65535) {
    return null;
  }
  return { host, port, bracketed };
}

/**
 * 校验单个解析后的 `ip:port` 地址是否允许出站连接：优先匹配管理员授权列表，其次匹配环境变量白名单，最后要求为公网地址。
 * 在拨号建连前的地址准入检查环节调用。
 * @param {string} address - 待检查的 `ip:port` 或 `[ipv6]:port` 字符串。
 * @param {Array<Object>} allowed - 环境变量配置的允许 CIDR 前缀列表。
 * @param {Array<{ value: bigint, is6: boolean }>|null} approved - 管理员预先批准的 IP 地址列表；为 `null` 时按默认策略检查。
 * @returns {void} 校验通过时无返回值；地址非法或被策略拒绝时抛出对应错误。
 */
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
    throw new Error(`${ErrNonPublicAddress.message}: ${formatIP(ip)}; allow it in ${AllowCIDRsEnv}`, { cause: ErrNonPublicAddress });
  }
}

/**
 * 将 `ip:port` 或 `[ipv6]:port` 字符串解析为内部 IP 地址对象，对应 Go 的 `netip.ParseAddrPort`。
 * 严格要求 IPv6 必须使用方括号、IPv4 不得使用方括号且端口合法。
 * 在 `checkAddress` 解析实际建连目标地址时调用。
 * @param {string} address - 待解析的 `ip:port` 字符串。
 * @returns {{ value: bigint, is6: boolean }|null} 解析成功返回内部 IP 对象，否则返回 `null`。
 */
function parseAddrPort(address) {
  const parts = splitHostPort(address);
  if (parts == null) {
    return null;
  }
  const ip = parseIP(parts.host);
  if (ip == null || ip.is6 !== parts.bracketed) {
    return null;
  }
  return ip;
}

/**
 * 将 `::ffff:a.b.c.d` 形式的 IPv4 映射 IPv6 地址还原为纯 IPv4 地址对象，对应 Go 的 `netip.Addr.Unmap`。
 * 在 `checkAddress` 避免通过 IPv4 映射 IPv6 绕过 IPv4 私网/保留网段检查时调用。
 * @param {{ value: bigint, is6: boolean }} ip - 已解析的内部 IP 对象。
 * @returns {{ value: bigint, is6: boolean }} 若为 IPv4 映射 IPv6 则返回对应的 IPv4 对象，否则原样返回。
 */
function unmap(ip) {
  if (ip.is6 && (ip.value >> 32n) === 0xffffn) {
    return { value: ip.value & 0xffffffffn, is6: false };
  }
  return ip;
}

/**
 * 将内部 IP 地址对象格式化为可读字符串，用于构造拦截错误提示信息。
 * 在 `checkAddress` 拒绝非公网地址并拼接错误消息时调用。
 * @param {{ value: bigint, is6: boolean }} ip - 内部 IP 地址对象。
 * @returns {string} 点分十进制 IPv4 字符串或冒号分隔的十六进制 IPv6 字符串。
 */
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

/**
 * 判断指定 IP 是否为允许默认出站访问的公网单播地址（对应 Go 原函数 `public`，因 JS 严格模式保留字改名为 `isPublic`）。
 * 排除非全局单播、私有地址、回环地址、链路本地单播地址以及 `nonPublic` 中的特殊用途网段。
 * 在 `checkAddress` 默认出口策略判定时调用。
 * @param {{ value: bigint, is6: boolean }} ip - 已执行 `unmap` 的内部 IP 地址对象。
 * @returns {boolean} 属于可访问公网地址时返回 `true`，否则返回 `false`。
 */
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

/**
 * 判断指定 IP 是否为全局单播地址，与 Go 标准库 `netip.Addr.IsGlobalUnicast` 保持一致。
 * 排除未指定地址（`0.0.0.0` / `::`）、IPv4 受限广播（`255.255.255.255`）、回环、链路本地单播及组播地址。
 * 由 `isPublic` 内部调用。
 * @param {{ value: bigint, is6: boolean }} ip - 内部 IP 地址对象。
 * @returns {boolean} 满足全局单播条件时返回 `true`，否则返回 `false`。
 */
function isGlobalUnicast(ip) {
  if (ip.value === 0n) {
    return false;
  }
  if (!ip.is6 && ip.value === 0xffffffffn) {
    return false;
  }
  if (isLoopback(ip) || isLinkLocalUnicast(ip)) {
    return false;
  }
  if (!ip.is6) {
    return ((ip.value >> 24n) & 0xf0n) !== 0xe0n;
  }
  return (ip.value >> 120n) !== 0xffn;
}

const privatePrefixes = [
  "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
  "fc00::/7",
].map(mustParsePrefix);
const linkLocalPrefix = mustParsePrefix("fe80::/10");

/**
 * 判断指定 IP 是否属于 RFC 1918 / RFC 4193 私有地址段，对应 Go 的 `netip.Addr.IsPrivate`。
 * 由 `isPublic` 内部调用。
 * @param {{ value: bigint, is6: boolean }} ip - 内部 IP 地址对象。
 * @returns {boolean} 属于私有网段时返回 `true`，否则返回 `false`。
 */
function isPrivate(ip) {
  return privatePrefixes.some((prefix) => prefixContains(prefix, ip));
}

/**
 * 判断指定 IP 是否为回环地址（`127.0.0.0/8` 或 `::1`），对应 Go 的 `netip.Addr.IsLoopback`。
 * 由 `isPublic` 与 `isGlobalUnicast` 内部调用。
 * @param {{ value: bigint, is6: boolean }} ip - 内部 IP 地址对象。
 * @returns {boolean} 为回环地址时返回 `true`，否则返回 `false`。
 */
function isLoopback(ip) {
  if (!ip.is6) {
    return (ip.value >> 24n) === 127n;
  }
  return ip.value === 1n;
}

/**
 * 判断指定 IP 是否为链路本地单播地址（`169.254.0.0/16` 或 `fe80::/10`），对应 Go 的 `netip.Addr.IsLinkLocalUnicast`。
 * 由 `isPublic` 与 `isGlobalUnicast` 内部调用。
 * @param {{ value: bigint, is6: boolean }} ip - 内部 IP 地址对象。
 * @returns {boolean} 为链路本地单播地址时返回 `true`，否则返回 `false`。
 */
function isLinkLocalUnicast(ip) {
  if (!ip.is6) {
    return (ip.value >> 16n) === ((169n << 8n) | 254n);
  }
  return prefixContains(linkLocalPrefix, ip);
}

/**
 * 从环境变量 `AGENTFLOW_GIT_EGRESS_ALLOW_CIDRS` 读取并解析所有合法的放行 CIDR 前缀列表（忽略非法项）。
 * 在每次创建拨号器 `newDialer` 时实时读取，使运维修改的白名单立即生效。
 * @returns {Array<{ network: bigint, bits: number, is6: boolean, total: number }>} 掩码归一化后的允许前缀数组。
 */
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

/**
 * 将 CIDR 前缀的主机位清零，返回规范化副本，对应 Go 的 `netip.Prefix.Masked`。
 * 由 `allowedPrefixes` 在收集环境变量放行网段时调用。
 * @param {{ network: bigint, bits: number, is6: boolean, total: number }} prefix - 已解析的前缀对象。
 * @returns {{ network: bigint, bits: number, is6: boolean, total: number }} 网络地址主机位已清零的前缀副本。
 */
function masked(prefix) {
  const mask = prefix.bits === 0 ? 0n : ((1n << BigInt(prefix.bits)) - 1n) << BigInt(prefix.total - prefix.bits);
  return { ...prefix, network: prefix.network & mask };
}

module.exports = {
  AllowCIDRsEnv, ErrNonPublicAddress, ErrHTTPSAddressChanged, ErrHTTPSHostLookup,
  Client, DialContext,
};
