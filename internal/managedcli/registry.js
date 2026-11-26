// registry.js —— 对应 Go 文件：internal/managedcli/registry.go
// 作用：从 npm registry 拉取完整包元数据，按 24 小时观察期筛选不高于 latest 的最新成熟版本，
// 并校验发布状态、SHA512 完整性摘要与发布时间。
// 职责边界：负责 npm 包候选版本解析与版本号比较，不执行本地装包或供应商直供归档下载。
// 语法差异说明：
// - Go 的 time.Time 译为 JS Date（零值译为 null）；
// - Go 的 (值, error) 多返回值译为成功直接 return、失败 throw Error；
// - Go 的 http.Client.Do 译为全局 fetch 配合 Client 超时与重定向校验；
// - Go 的 context.Context 译为 AbortSignal；
// - Go 同包挂在 *Manager 上的方法挂载在 Manager.prototype 上。

"use strict";

const { Manager } = require("./updater.js");
const { toDate } = require("./manifest.js");
const { npmRegistry, observationWindow, validProviderVersion, providerSpecs } = require("./providers.js");

// Go 的零值时间 time.Time{}（0001-01-01T00:00:00Z）在 JS Date 中的毫秒时间戳。
const goZeroTimeMs = -62135596800000;

/**
 * 表示一个待评估或待安装的 CLI 发行版本（包含 npm 包或供应商直供归档的元数据）。
 */
class release {
  /**
   * 构造发行版本对象，兼容 Go 字段名与 npm JSON 字段名；Artifact 与 Published 不参与 JSON 序列化。
   *
   * @param {object} [init={}] 初始字段对象，可选包含 Name/name、Version/version、Deprecated/deprecated、Dist/dist、Artifact、Published。
   */
  constructor(init = {}) {
    this.Name = init.Name ?? init.name ?? "";
    this.Version = init.Version ?? init.version ?? "";
    this.Deprecated = init.Deprecated ?? init.deprecated ?? "";
    this.Dist = init.Dist ?? init.dist ?? { Integrity: "" };
    if (this.Dist == null || this.Dist.Integrity == null) {
      this.Dist = { Integrity: this.Dist?.integrity ?? "" };
    }
    this.Artifact = init.Artifact ?? null;
    this.Published = toDate(init.Published ?? null);
  }

  /**
   * 按 Go 的 json 标签序列化为 npm 元数据格式，省略标记为 json:"-" 的 Artifact 与 Published。
   *
   * @returns {object} 可用于 JSON.stringify 的普通对象。
   */
  toJSON() {
    return {
      name: this.Name,
      version: this.Version,
      deprecated: this.Deprecated,
      dist: { integrity: this.Dist.Integrity },
    };
  }
}

/**
 * 表示从 npm registry 拉取的完整包元数据文档（含 dist-tags、versions 与 time 映射）。
 */
class packageMetadata {
  /**
   * 构造包元数据对象，并将 versions 中的各项规范化为 release 实例。
   *
   * @param {object} [init={}] 原始元数据对象，兼容 Go 字段名与 npm JSON 字段名。
   */
  constructor(init = {}) {
    this.Name = init.Name ?? init.name ?? "";
    this.Tags = init.Tags ?? init["dist-tags"] ?? {};
    this.Versions = {};
    for (const [k, v] of Object.entries(init.Versions ?? init.versions ?? {})) {
      this.Versions[k] = v instanceof release ? v : new release(v);
    }
    this.Times = init.Times ?? init.time ?? {};
  }
}

/**
 * 为指定供应商解析本次更新周期的候选发行版本。
 * 在 updateProvidersLocked 遍历各供应商时调用；无 npm 包名的供应商转交 vendorCandidate 处理。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {string} provider 供应商名称。
 * @returns {Promise<release>} 通过完整性、弃用状态与发布时间校验的候选 release；校验或拉取失败时抛出错误。
 */
Manager.prototype.candidate = async function (ctx, provider) {
  const spec = providerSpecs[provider];
  if (spec.Package === "") {
    return this.vendorCandidate(ctx, provider);
  }
  const metadata = await this.fetchPackageMetadata(ctx, spec.Package);
  const version = metadata.Tags.latest ?? "";
  if (metadata.Name !== spec.Package || !validProviderVersion(provider, version)) {
    throw new Error("registry did not provide the expected package and a supported release version");
  }
  let resolvedVersion = version;
  const mature = matureVersion(provider, metadata, version, new Date(this.Now().getTime() - observationWindow));
  if (mature !== "") {
    resolvedVersion = mature;
  }
  const candidate = metadata.Versions[resolvedVersion];
  if (candidate == null || candidate.Name !== spec.Package || candidate.Version !== resolvedVersion) {
    throw new Error("release missing or inconsistent in registry metadata");
  }
  if (candidate.Deprecated !== "") {
    throw new Error("candidate release is deprecated");
  }
  if (!validIntegrity(candidate.Dist.Integrity)) {
    throw new Error("candidate requires a valid SHA512 package integrity value");
  }
  candidate.Published = parseJSONTime(metadata.Times[resolvedVersion]);
  if (candidate.Published == null || candidate.Published.getTime() === 0 || candidate.Published.getTime() === goZeroTimeMs) {
    throw new Error("candidate release has no valid publication time");
  }
  return candidate;
};

/**
 * 从固定 npm registry 下载并解码指定包的完整元数据文档（包含各版本发布时间，用于 24 小时观察期判定）。
 * 在 candidate 拉取 npm 供应商元数据阶段调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {string} pkg npm 包名（可含作用域前缀）。
 * @returns {Promise<packageMetadata>} 解码后的完整包元数据；网络异常、状态码非 200、超过 64 MiB 或 JSON 非法时抛出错误。
 */
Manager.prototype.fetchPackageMetadata = async function (ctx, pkg) {
  const endpoint = npmRegistry + "/" + encodeURIComponent(pkg);
  const signals = [];
  if (ctx instanceof AbortSignal) {
    signals.push(ctx);
  }
  if (this.Client != null && this.Client.Timeout > 0) {
    signals.push(AbortSignal.timeout(this.Client.Timeout));
  }
  let response;
  try {
    // 请求完整元数据（application/json）以获取发布时间；精简元数据缺少 time 字段会绕过观察期。
    response = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
    });
  } catch (err) {
    throw new Error(`fetch package metadata: ${err.message}`);
  }
  // Go 的 Client.CheckRedirect 在每次跳转时校验；fetch 默认自动跟随跳转，此处对最终 URL 执行同等校验。
  if (this.Client?.CheckRedirect != null && response.url) {
    const finalURL = new URL(response.url);
    if (finalURL.href !== endpoint) {
      try {
        this.Client.CheckRedirect(finalURL, [new URL(endpoint)]);
      } catch (err) {
        if (response.body != null) {
          await response.body.cancel();
        }
        throw new Error(`fetch package metadata: ${err.message}`);
      }
    }
  }
  if (response.status !== 200) {
    if (response.body != null) {
      await response.body.cancel();
    }
    throw new Error(`package metadata HTTP ${response.status}`);
  }
  const limit = 64 << 20;
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > limit) {
    throw new Error("package metadata exceeds size limit");
  }
  let metadata;
  try {
    metadata = new packageMetadata(JSON.parse(data.toString("utf8")));
  } catch (err) {
    throw new Error(`invalid package metadata: ${err.message}`);
  }
  return metadata;
};

/**
 * 在不高于官方 latest 上界（upper）的前提下，选出发布时间不晚于 cutoff 且未弃用的最新合法版本。
 * 在 candidate 中调用，用于防止高频发版的 CLI 因 latest 始终未满观察期而长期无法更新；
 * 对于 DSH，仅当 upper 本身为 RC 版本时才允许选中 RC 版本。
 *
 * @param {string} provider 供应商名称。
 * @param {packageMetadata} metadata 完整包元数据。
 * @param {string} upper 官方 latest 标签对应的版本号上界。
 * @param {Date} cutoff 观察期截止时刻（当前时间减去 observationWindow）。
 * @returns {string} 满足条件的最新成熟版本号；若无符合条件版本则返回空字符串 ""。
 */
function matureVersion(provider, metadata, upper, cutoff) {
  let mature = "";
  const allowRC = upper.includes("-rc.");
  for (const [v, entry] of Object.entries(metadata.Versions)) {
    if (!allowRC && v.includes("-rc.")) {
      continue;
    }
    if (!validProviderVersion(provider, v) || compareVersions(v, upper) > 0 || entry.Deprecated !== "") {
      continue;
    }
    const published = parseJSONTime(metadata.Times[v]);
    if (published == null || published.getTime() === 0 || published.getTime() === goZeroTimeMs || published > cutoff) {
      continue;
    }
    if (mature === "" || compareVersions(v, mature) > 0) {
      mature = v;
    }
  }
  return mature;
}

/**
 * 校验包或归档的 SRI 完整性值是否为合法的 sha512 标准 Base64 摘要（解码后恰好 64 字节）。
 * 在 candidate 与 vendorObservation.release 校验摘要时调用。
 *
 * @param {string} value 待校验的完整性字符串（如 "sha512-..."）。
 * @returns {boolean} 合法返回 true，否则返回 false。
 */
function validIntegrity(value) {
  if (typeof value !== "string" || !value.startsWith("sha512-")) {
    return false;
  }
  const encoded = value.slice("sha512-".length);
  // Go 的 base64.StdEncoding.DecodeString 严格拒绝非法字符与未对齐长度；Node 的 Buffer.from 会静默忽略，需先显式校验。
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    return false;
  }
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 64;
}

/**
 * 按主.次.修订三段数字及可选 -rc.N 预发布后缀比较两个版本号的大小。
 * 在成熟版本筛选、降级拦截与回滚门控时调用；同核心版本下正式版大于 RC 版。
 *
 * @param {string} a 左侧版本号。
 * @param {string} b 右侧版本号。
 * @returns {number} a > b 返回正数，a < b 返回负数，相等返回 0。
 */
function compareVersions(a, b) {
  const [aCore, aRC = ""] = cutRC(a);
  const [bCore, bRC = ""] = cutRC(b);
  const left = aCore.split(".");
  const right = bCore.split(".");
  for (let i = 0; i < 3; i++) {
    const cmp = compareVersionNumber(left[i], right[i]);
    if (cmp !== 0) {
      return cmp;
    }
  }
  if (aRC === bRC) {
    return 0;
  }
  if (aRC === "") {
    return 1;
  }
  if (bRC === "") {
    return -1;
  }
  return compareVersionNumber(aRC, bRC);
}

/**
 * 按首次出现的 "-rc." 拆分版本号为核心段与 RC 编号，对应 Go 的 strings.Cut(v, "-rc.")。
 * 仅供 compareVersions 内部调用。
 *
 * @param {string} v 版本号字符串。
 * @returns {[string, string]} 返回 [核心版本, RC 编号]；不含 "-rc." 时第二项为空字符串 ""。
 */
function cutRC(v) {
  const idx = v.indexOf("-rc.");
  if (idx === -1) {
    return [v, ""];
  }
  return [v.slice(0, idx), v.slice(idx + 4)];
}

/**
 * 比较两个无前导零的非负整数字符串所代表的数值大小（先比长度再按字典序比较）。
 * 在 compareVersions 逐段比较主次修订号与 RC 序号时调用。
 *
 * @param {string} a 左侧数字字符串。
 * @param {string} b 右侧数字字符串。
 * @returns {number} a > b 返回正数，a < b 返回负数，相等返回 0。
 */
function compareVersionNumber(a, b) {
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * 将 npm 元数据 time 字段中的 JSON 时间值解码为 Date 对象，对应 Go 的 json.Unmarshal(..., &time.Time)。
 * 在 candidate 与 matureVersion 读取发布时间时调用；非法或非字符串时间值返回 null。
 *
 * @param {string|Buffer|null|undefined} raw 原始时间字段值（字符串或原始 JSON 字节）。
 * @returns {Date|null} 解析成功返回 Date，否则返回 null。
 */
function parseJSONTime(raw) {
  if (raw == null) {
    return null;
  }
  let text = raw;
  if (Buffer.isBuffer(raw)) {
    try {
      text = JSON.parse(raw.toString("utf8"));
    } catch {
      return null;
    }
  } else if (typeof raw === "string" && raw.startsWith('"')) {
    try {
      text = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof text !== "string" || text === "") {
    return null;
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = { release, packageMetadata, matureVersion, validIntegrity, compareVersions, compareVersionNumber };
