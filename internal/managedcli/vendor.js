// vendor.js —— 对应 Go 文件：internal/managedcli/vendor.go
// 作用：处理不走 npm registry 的供应商直供 CLI（Cursor 与 Antigravity/agy），包括解析发布脚本/清单、
// 校验归档 URL/ETag/SHA512、受限 HTTPS 下载、解压并生成禁用上游自更新的启动包装脚本。
// 职责边界：负责供应商直供候选发现、安全下载与启动器写入，归档解压细节委托给 vendor_archive.js，
// 跨次检查的观察记录委托给 vendor_observation.js。
// 语法差异说明：
// - Go 的 time.Time 译为 JS Date（零值译为 null）；
// - Go 的 (值, error) 多返回值译为成功直接 return、失败 throw Error；
// - Go 的 http.Client 请求译为全局 fetch 配合 AbortSignal 与重定向目标校验；
// - Go 的 runtime.GOOS / runtime.GOARCH 译为 process.platform / process.arch 的映射函数；
// - Go 同包挂在 release / *Manager 上的方法分别挂载在 release.prototype / Manager.prototype 上。

"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Buffer } = require("node:buffer");

const { Manager } = require("./updater.js");
const { release, validIntegrity } = require("./registry.js");
const { validProviderVersion, providerSpecs, commandTimeout } = require("./providers.js");
const { extractVendorArchive } = require("./vendor_archive.js");

const cursorInstallerURL = "https://cursor.com/install";
const agyReleaseOrigin = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";
const agyStoragePrefix = "/antigravity-public/antigravity-cli/";
const maxVendorArchive = 512 << 20;

// Go 的零值时间 time.Time{}（0001-01-01T00:00:00Z）在 JS Date 中的毫秒时间戳。
const goZeroTimeMs = -62135596800000;

/**
 * 描述一个供应商直供归档的下载地址与可选强 ETag 标识。
 */
class vendorArtifact {
  /**
   * 构造供应商直供归档元数据对象，按 Go struct 零值规则初始化缺省字段。
   *
   * @param {object} [init={}] 初始字段对象，可选包含 url、etag。
   */
  constructor(init = {}) {
    this.url = init.url ?? "";
    this.etag = init.etag ?? "";
  }
}

/**
 * 返回当前 release 的唯一完整性标识。
 * 在安装记录落盘和判断缓存候选是否可复用时调用；若无 SHA512 摘要但存在直供归档则返回 "etag:<etag>"。
 *
 * @returns {string} 完整性标识字符串（"sha512-..." 或 "etag:..."）。
 */
release.prototype.identity = function () {
  if (this.Artifact != null && this.Dist.Integrity === "") {
    return "etag:" + this.Artifact.etag;
  }
  return this.Dist.Integrity;
};

const cursorDownloadLine = /^DOWNLOAD_URL="https:\/\/downloads\.cursor\.com\/lab\/([^/"\r\n]+)\/\$\{OS\}\/\$\{ARCH\}\/agent-cli-package\.tar\.gz"\r?$/m;

/**
 * 根据版本号与当前操作系统/架构拼装 Cursor 官方归档下载地址。
 * 在 vendorCandidate 解析 Cursor 安装脚本以及 vendorObservation.release 校验历史记录时调用。
 *
 * @param {string} version Cursor 构建版本号。
 * @returns {string} 对应的官方 tar.gz 归档 HTTPS URL。
 */
function cursorArchiveURL(version) {
  let arch = goarch();
  if (arch === "amd64") {
    arch = "x64";
  }
  return `https://downloads.cursor.com/lab/${version}/${goos()}/${arch}/agent-cli-package.tar.gz`;
}

/**
 * 判断给定的 ETag 是否为合法的带双引号强 ETag（长度在 3~128 之间且首尾均为双引号）。
 * 在 vendorCandidate 与 vendorObservation.release 校验 Cursor 归档 ETag 时调用。
 *
 * @param {string} tag 待校验的 ETag 响应头值。
 * @returns {boolean} 合法返回 true，否则返回 false。
 */
function validCursorETag(tag) {
  return tag.length >= 3 && tag.length <= 128 && tag.startsWith('"') && tag.endsWith('"');
}

/**
 * 校验并解析 Antigravity 发行清单中的归档下载地址，确保其严格属于 HTTPS GCS 公共存储前缀且无查询/片段/路径穿越。
 * 在 vendorCandidate 与 vendorObservation.release 校验 agy 归档地址时调用。
 *
 * @param {string} raw 清单中声明的原始 URL 字符串。
 * @param {string} version 声明的版本号。
 * @returns {URL} 校验通过后的 URL 对象；任一约束不满足时抛出错误。
 */
function agyArchiveURL(raw, version) {
  let artifact;
  try {
    artifact = new URL(raw);
  } catch {
    throw new Error("invalid Antigravity release archive URL");
  }
  if (
    artifact.protocol !== "https:" || artifact.host !== "storage.googleapis.com" ||
    artifact.username !== "" || artifact.password !== "" || artifact.search !== "" || artifact.hash !== "" ||
    artifact.pathname !== path.posix.normalize(artifact.pathname) || !artifact.pathname.endsWith(".tar.gz") ||
    !artifact.pathname.startsWith(agyStoragePrefix + version + "-")
  ) {
    throw new Error("invalid Antigravity release archive URL");
  }
  return artifact;
}

/**
 * 解析供应商直供 CLI（cursor 或 agy）的最新候选版本，并通过 HEAD 请求获取发布时间与强 ETag。
 * 当 providerSpecs 中 Package 为空时由 candidate 委托调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {string} provider 供应商名称（"cursor" 或 "agy"）。
 * @returns {Promise<release>} 构造完成的候选 release 对象；平台不支持、清单非法或 HEAD 校验失败时抛出错误。
 */
Manager.prototype.vendorCandidate = async function (ctx, provider) {
  if ((goos() !== "linux" && goos() !== "darwin") || (goarch() !== "amd64" && goarch() !== "arm64")) {
    throw new Error(`${provider} has no managed release for ${goos()}/${goarch()}`);
  }
  const candidate = new release();
  switch (provider) {
    case "cursor": {
      const script = await this.vendorMetadata(ctx, cursorInstallerURL);
      const match = cursorDownloadLine.exec(script.toString("utf8"));
      if (match == null || match.length !== 2 || !validProviderVersion(provider, match[1])) {
        throw new Error("Cursor installer did not identify a supported release");
      }
      candidate.Version = match[1];
      candidate.Artifact = new vendorArtifact({ url: cursorArchiveURL(candidate.Version) });
      break;
    }
    case "agy": {
      const data = await this.vendorMetadata(ctx, agyReleaseOrigin + "/manifests/" + agyVendorPlatform() + ".json");
      let manifest;
      try {
        manifest = JSON.parse(data.toString("utf8"));
      } catch {
        throw new Error("invalid Antigravity release manifest");
      }
      if (manifest == null || !validProviderVersion(provider, manifest.version ?? "")) {
        throw new Error("invalid Antigravity release manifest");
      }
      const artifact = agyArchiveURL(manifest.url, manifest.version);
      // Go 的 hex.DecodeString 严格校验十六进制字符且要求恰好 64 字节（128 个十六进制字符）；
      // Node 的 Buffer.from(..., "hex") 会在非法字符处静默截断，故先显式正则校验。
      if (typeof manifest.sha512 !== "string" || !/^[0-9a-fA-F]{128}$/.test(manifest.sha512)) {
        throw new Error("Antigravity release requires a valid SHA512");
      }
      const hash = Buffer.from(manifest.sha512, "hex");
      candidate.Version = manifest.version;
      candidate.Artifact = new vendorArtifact({ url: artifact.toString() });
      candidate.Dist.Integrity = "sha512-" + hash.toString("base64");
      break;
    }
    default:
      throw new Error(`unsupported vendor artifact provider ${JSON.stringify(provider)}`);
  }

  const resp = await this.vendorRequest(ctx, "HEAD", candidate.Artifact.url, "");
  if (resp.body != null) {
    await resp.body.cancel();
  }
  candidate.Published = parseHTTPTime(resp.headers.get("last-modified"));
  if (candidate.Published == null || candidate.Published.getTime() === 0 || candidate.Published.getTime() === goZeroTimeMs) {
    throw new Error("vendor artifact has no valid publication time");
  }
  if (provider === "cursor") {
    // 下载归档前固定官方构建地址与强 ETag，下载时通过 If-Match 防漂移。
    const tag = resp.headers.get("etag");
    if (!validCursorETag(tag ?? "")) {
      throw new Error("Cursor release has no strong ETag");
    }
    candidate.Artifact.etag = tag;
  }
  return candidate;
};

/**
 * 计算当前主机在 Antigravity 清单中对应的平台标识（如 linux_amd64、linux_amd64_musl、darwin_arm64）。
 * 在 vendorCandidate 拼接 agy 清单 URL 时调用。
 *
 * @returns {string} 平台标识字符串。
 */
function agyVendorPlatform() {
  let platform = goos() + "_" + goarch();
  if (goos() === "linux") {
    let arch = "aarch64";
    if (goarch() === "amd64") {
      arch = "x86_64";
    }
    if (fs.existsSync("/lib/ld-musl-" + arch + ".so.1")) {
      platform += "_musl";
    }
  }
  return platform;
}

/**
 * 通过受限的 HTTPS GET 请求下载供应商元数据（安装脚本或 JSON 清单），并限制响应体不超过 1 MiB。
 * 在 vendorCandidate 获取 Cursor 安装脚本或 Antigravity 清单时调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {string} address 目标 HTTPS 地址。
 * @returns {Promise<Buffer>} 元数据原始字节缓冲区；请求失败或超过 1 MiB 时抛出错误。
 */
Manager.prototype.vendorMetadata = async function (ctx, address) {
  const resp = await this.vendorRequest(ctx, "GET", address, "");
  const maxMetadata = 1 << 20;
  const data = Buffer.from(await resp.arrayBuffer());
  if (data.length > maxMetadata) {
    throw new Error("vendor release metadata exceeds size limit");
  }
  return data;
};

/**
 * 发送受限的供应商 HTTPS 请求：校验跳转目标仍属于允许的同源 HTTPS 主机，可选附加 If-Match 校验 ETag。
 * 在 vendorMetadata、vendorCandidate（HEAD）以及 installVendorArtifact（GET）中调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {string} method HTTP 方法（"GET" 或 "HEAD"）。
 * @param {string} address 目标 URL 字符串。
 * @param {string} etag 可选的强 ETag（非空时发送 If-Match 并校验响应 ETag 一致）。
 * @returns {Promise<Response>} 校验通过的 HTTP Response 对象；请求失败、跨源重定向或状态码/ETag 不匹配时抛出错误。
 */
Manager.prototype.vendorRequest = async function (ctx, method, address, etag) {
  const targetURL = new URL(address);
  const client = { ...(this.Client ?? {}) };
  if (method === "GET" && (targetURL.host === "downloads.cursor.com" || targetURL.host === "storage.googleapis.com")) {
    client.Timeout = commandTimeout;
  }
  // Go 的 CheckRedirect 在每次跳转时校验；fetch 默认自动跟随跳转，此处在收到响应后校验最终 URL。
  const signals = [];
  if (ctx instanceof AbortSignal) {
    signals.push(ctx);
  }
  if (client.Timeout > 0) {
    signals.push(AbortSignal.timeout(client.Timeout));
  }
  const headers = { "Accept-Encoding": "identity" };
  if (etag !== "") {
    headers["If-Match"] = etag;
  }
  let resp;
  try {
    resp = await fetch(address, {
      method,
      headers,
      signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
    });
  } catch (err) {
    throw new Error(`fetch vendor release: ${err.message}`);
  }
  const finalURL = new URL(resp.url);
  const same =
    finalURL.host === targetURL.host ||
    (targetURL.host === "cursor.com" && finalURL.host === "www.cursor.com");
  if (finalURL.protocol !== "https:" || !same || finalURL.username !== "" || finalURL.password !== "") {
    if (resp.body != null) {
      await resp.body.cancel();
    }
    throw new Error("refuse redirect outside the HTTPS vendor origin");
  }
  if (resp.status !== 200 || (etag !== "" && resp.headers.get("etag") !== etag)) {
    if (resp.body != null) {
      await resp.body.cancel();
    }
    throw new Error(`vendor release response did not match the candidate (HTTP ${resp.status})`);
  }
  return resp;
};

/**
 * 下载供应商直供 tar.gz 归档至暂存目录，校验大小与 SHA512 摘要，安全解压至 artifact/ 并写入禁用自动更新的启动包装脚本。
 * 当 candidate.Artifact 非空时由 install 调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {string} provider 供应商名称（"cursor" 或 "agy"）。
 * @param {release} candidate 候选版本发布对象。
 * @param {string} stage 暂存安装目录的绝对路径。
 * @returns {Promise<void>} 无返回值；下载超限、哈希不匹配、解压失败或缺少可执行载荷时抛出错误。
 */
Manager.prototype.installVendorArtifact = async function (ctx, provider, candidate, stage) {
  const resp = await this.vendorRequest(ctx, "GET", candidate.Artifact.url, candidate.Artifact.etag);
  const contentLength = Number(resp.headers.get("content-length") ?? -1);
  if (contentLength > maxVendorArchive) {
    if (resp.body != null) {
      await resp.body.cancel();
    }
    throw new Error("vendor archive exceeds size limit");
  }
  const archivePath = path.join(stage, `.artifact-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
  const hash = createHash("sha512");
  const archive = fs.openSync(archivePath, "wx", 0o600);
  // 对应 Go 的 defer os.Remove(archive.Name())：无论下载、校验还是解压环节出错，均清理临时归档文件。
  try {
    let data;
    try {
      data = Buffer.from(await resp.arrayBuffer());
      fs.writeSync(archive, data);
      hash.update(data);
    } finally {
      fs.closeSync(archive);
    }
    if (data.length > maxVendorArchive) {
      throw new Error("vendor archive exceeds size limit");
    }
    if (candidate.Dist.Integrity !== "" && candidate.Dist.Integrity !== "sha512-" + hash.digest("base64")) {
      throw new Error("vendor artifact SHA512 did not match its manifest");
    }
    extractVendorArchive(ctx, provider, archivePath, path.join(stage, "artifact"));
  } finally {
    fs.rmSync(archivePath, { force: true }); // 只删上面新建的临时归档
  }
  const bin = providerSpecs[provider].Binary;
  // Go 使用 os.OpenRoot 限制在 artifact 目录内查找载荷；JS 使用 path.join 对应。
  const payloadPath = path.join(stage, "artifact", bin);
  let payload = null;
  try {
    payload = fs.statSync(payloadPath);
  } catch {
    payload = null;
  }
  if (payload == null || !payload.isFile() || (payload.mode & 0o111) === 0) {
    throw new Error("vendor archive did not provide an executable CLI");
  }
  // 固定版本必须禁止上游 CLI 在任务执行期间自更新；启动脚本用 ${0%/*} 定位同目录 artifact/ 下的真实可执行文件。
  let launcher = "#!/bin/sh\nAGY_CLI_DISABLE_AUTO_UPDATE=true exec \"${0%/*}/artifact/agy\" \"$@\"\n";
  if (provider === "cursor") {
    launcher = "#!/bin/sh\nexec \"${0%/*}/artifact/cursor-agent\" --disable-auto-update \"$@\"\n";
  }
  fs.writeFileSync(path.join(stage, bin), launcher, { mode: 0o700 });
};

/**
 * 将 Node.js 的 process.platform 映射为 Go 的 runtime.GOOS 命名（win32 映射为 windows，其余保持原样）。
 * 在拼接 Cursor/Antigravity 平台标识与判断支持平台时调用。
 *
 * @returns {string} Go 风格的操作系统标识（如 "linux"、"darwin"、"windows"）。
 */
function goos() {
  if (process.platform === "win32") {
    return "windows";
  }
  return process.platform;
}

/**
 * 将 Node.js 的 process.arch 映射为 Go 的 runtime.GOARCH 命名（x64 映射为 amd64，其余保持原样）。
 * 在拼接 Cursor/Antigravity 平台标识与判断支持架构时调用。
 *
 * @returns {string} Go 风格的 CPU 架构标识（如 "amd64"、"arm64"）。
 */
function goarch() {
  if (process.arch === "x64") {
    return "amd64";
  }
  return process.arch;
}

/**
 * 解析 HTTP 响应头中的时间字符串（如 Last-Modified），对应 Go 的 http.ParseTime。
 * 在 vendorCandidate 解析归档发布时间时调用；空值或非法时间返回 null。
 *
 * @param {string|null|undefined} value HTTP 日期响应头字符串。
 * @returns {Date|null} 解析成功返回 Date，否则返回 null。
 */
function parseHTTPTime(value) {
  if (value == null || value === "") {
    return null;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = {
  cursorInstallerURL,
  agyReleaseOrigin,
  agyStoragePrefix,
  maxVendorArchive,
  vendorArtifact,
  cursorDownloadLine,
  cursorArchiveURL,
  validCursorETag,
  agyArchiveURL,
  agyVendorPlatform,
  validIntegrity,
  goos,
  goarch,
};
