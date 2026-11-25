// vendor.js —— 对应 Go 文件：internal/managedcli/vendor.go
// 作用：不走 npm 的供应商直供包：Cursor 安装脚本与 Antigravity 清单。
// Go 的 time.Time 译为 JS Date；(值, error) 译为成功返回值、失败 throw；
// http 请求译为 fetch；runtime.GOOS/GOARCH 译为 process.platform/arch 的映射。

"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Buffer } = require("node:buffer");

const { Manager } = require("./updater.js"); // 对应 Go 同包类型，updater.js 已翻译
const { release } = require("./registry.js"); // 对应 Go 同包类型，registry.js 已翻译
const { validProviderVersion, providerSpecs, commandTimeout } = require("./providers.js"); // 对应 Go 同包常量与函数，providers.js 已翻译
const { extractVendorArchive } = require("./vendor_archive.js"); // 对应 Go 同包函数，vendor_archive.js 已翻译

const cursorInstallerURL = "https://cursor.com/install";
const agyReleaseOrigin = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";
const agyStoragePrefix = "/antigravity-public/antigravity-cli/";
const maxVendorArchive = 512 << 20;

class vendorArtifact {
  constructor(init = {}) {
    this.url = init.url ?? "";
    this.etag = init.etag ?? "";
  }
}

release.prototype.identity = function () {
  if (this.Artifact != null && this.Dist.Integrity === "") {
    return "etag:" + this.Artifact.etag;
  }
  return this.Dist.Integrity;
};

const cursorDownloadLine = /^DOWNLOAD_URL="https:\/\/downloads\.cursor\.com\/lab\/([^/"\r\n]+)\/\$\{OS\}\/\$\{ARCH\}\/agent-cli-package\.tar\.gz"\r?$/m;

function cursorArchiveURL(version) {
  let arch = goarch();
  if (arch === "amd64") {
    arch = "x64";
  }
  return `https://downloads.cursor.com/lab/${version}/${goos()}/${arch}/agent-cli-package.tar.gz`;
}

function validCursorETag(tag) {
  return tag.length >= 3 && tag.length <= 128 && tag.startsWith('"') && tag.endsWith('"');
}

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

Manager.prototype.vendorCandidate = async function (ctx, provider) {
  if ((goos() !== "linux" && goos() !== "darwin") || (goarch() !== "amd64" && goarch() !== "arm64")) {
    throw new Error(`${provider} has no managed release for ${goos()}/${goarch()}`);
  }
  let candidate = new release();
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
      if (manifest == null || !validProviderVersion(provider, manifest.version)) {
        throw new Error("invalid Antigravity release manifest");
      }
      const artifact = agyArchiveURL(manifest.url, manifest.version);
      let hash;
      try {
        hash = Buffer.from(manifest.sha512, "hex");
      } catch {
        throw new Error("Antigravity release requires a valid SHA512");
      }
      if (hash.length !== 64) {
        throw new Error("Antigravity release requires a valid SHA512");
      }
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
  if (candidate.Published == null || candidate.Published.getTime() === 0) {
    throw new Error("vendor artifact has no valid publication time");
  }
  if (provider === "cursor") {
    // Pin the official build URL and ETag before downloading the archive.
    const tag = resp.headers.get("etag");
    if (!validCursorETag(tag ?? "")) {
      throw new Error("Cursor release has no strong ETag");
    }
    candidate.Artifact.etag = tag;
  }
  return candidate;
};

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

Manager.prototype.vendorMetadata = async function (ctx, address) {
  const resp = await this.vendorRequest(ctx, "GET", address, "");
  const maxMetadata = 1 << 20;
  const data = Buffer.from(await resp.arrayBuffer());
  if (data.length > maxMetadata) {
    throw new Error("vendor release metadata exceeds size limit");
  }
  return data;
};

Manager.prototype.vendorRequest = async function (ctx, method, address, etag) {
  const client = { ...this.Client };
  if (method === "GET" && (new URL(address).host === "downloads.cursor.com" || new URL(address).host === "storage.googleapis.com")) {
    client.Timeout = commandTimeout;
  }
  // Go 的 CheckRedirect 在每次跳转时校验；fetch 默认自动跟随跳转，这里用最终 URL 校验一次。
  const signals = [];
  if (ctx instanceof AbortSignal) {
    signals.push(ctx);
  }
  signals.push(AbortSignal.timeout(client.Timeout));
  const headers = { "Accept-Encoding": "identity" };
  if (etag !== "") {
    headers["If-Match"] = etag;
  }
  const resp = await fetch(address, { method, headers, signal: AbortSignal.any(signals) });
  const finalURL = new URL(resp.url);
  const same =
    finalURL.host === new URL(address).host ||
    (new URL(address).host === "cursor.com" && finalURL.host === "www.cursor.com");
  if (finalURL.protocol !== "https:" || !same || finalURL.username !== "" || finalURL.password !== "") {
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

Manager.prototype.installVendorArtifact = async function (ctx, provider, candidate, stage) {
  const resp = await this.vendorRequest(ctx, "GET", candidate.Artifact.url, candidate.Artifact.etag);
  const contentLength = Number(resp.headers.get("content-length") ?? -1);
  if (contentLength > maxVendorArchive) {
    throw new Error("vendor archive exceeds size limit");
  }
  const archivePath = path.join(stage, `.artifact-${randomSuffix()}`);
  const hash = createHash("sha512");
  let data;
  const archive = fs.openSync(archivePath, "wx", 0o600);
  try {
    data = Buffer.from(await resp.arrayBuffer());
    fs.writeSync(archive, data);
    hash.update(data);
  } finally {
    fs.closeSync(archive);
  }
  // Go 的 defer os.Remove(archive.Name()) 在函数返回时执行：解压用完后再删。
  try {
    if (data.length > maxVendorArchive) {
      throw new Error("vendor archive exceeds size limit");
    }
    if (candidate.Dist.Integrity !== "" && candidate.Dist.Integrity !== "sha512-" + hash.digest("base64")) {
      throw new Error("vendor artifact SHA512 did not match its manifest");
    }
    await extractVendorArchive(ctx, provider, archivePath, path.join(stage, "artifact"));
  } finally {
    fs.rmSync(archivePath, { force: true }); // 只删上面新建的临时归档
  }
  const bin = providerSpecs[provider].Binary;
  // Go 的 os.OpenRoot 把根目录锁在 artifact 内防逃逸；JS 无对应物，用 path.join 对应。
  const payloadPath = path.join(stage, "artifact", bin);
  let payload;
  try {
    payload = fs.statSync(payloadPath);
  } catch (err) {
    throw err;
  }
  if (!payload.isFile() || (payload.mode & 0o111) === 0) {
    throw new Error("vendor archive did not provide an executable CLI");
  }
  // Pinned versions stay immutable when the upstream CLI would normally
  // perform its own updates during a request.
  // Invoke each launcher directly by its absolute installation path.
  // ${0%/*} locates artifact/ beside $0, so a symlink entry point in a
  // different directory would look for the payload in the wrong place.
  let launcher = "#!/bin/sh\nAGY_CLI_DISABLE_AUTO_UPDATE=true exec \"${0%/*}/artifact/agy\" \"$@\"\n";
  if (provider === "cursor") {
    launcher = "#!/bin/sh\nexec \"${0%/*}/artifact/cursor-agent\" --disable-auto-update \"$@\"\n";
  }
  fs.writeFileSync(path.join(stage, bin), launcher, { mode: 0o700 });
};

// goos/goarch：Go 的 runtime.GOOS/GOARCH 译为 process.platform/arch 的映射。
function goos() {
  if (process.platform === "win32") {
    return "windows";
  }
  return process.platform;
}

function goarch() {
  if (process.arch === "x64") {
    return "amd64";
  }
  return process.arch;
}

// parseHTTPTime：Go 的 http.ParseTime 解析 HTTP 日期头，非法返回零值；此处非法返回 null。
function parseHTTPTime(value) {
  if (value == null || value === "") {
    return null;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function randomSuffix() {
  return `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
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
  goos,
  goarch,
};
