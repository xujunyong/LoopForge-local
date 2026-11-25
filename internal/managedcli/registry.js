// registry.js —— 对应 Go 文件：internal/managedcli/registry.go
// 作用：从 npm registry 取候选版本，挑已过 24 小时观察期的最新成熟版。
// Go 的 time.Time 译为 JS Date；(值, error) 译为成功返回值、失败 throw；
// http.Client.Do 译为 fetch；context.Context 译为 AbortSignal。

"use strict";

const { Manager } = require("./updater.js"); // 对应 Go 同包类型，updater.js 已翻译
const { toDate } = require("./manifest.js"); // 对应 Go 同包函数，manifest.js 已翻译
const { npmRegistry, validProviderVersion, providerSpecs } = require("./providers.js"); // 对应 Go 同包常量与函数，providers.js 已翻译

class release {
  // 构造器同时认 Go 字段名与 JSON tag 名；Artifact/Published 的 tag 是 "-"，不进 JSON。
  constructor(init = {}) {
    this.Name = init.Name ?? init.name ?? "";
    this.Version = init.Version ?? init.version ?? "";
    this.Deprecated = init.Deprecated ?? init.deprecated ?? "";
    this.Dist = init.Dist ?? init.dist ?? { Integrity: "" };
    if (this.Dist.Integrity == null) {
      this.Dist = { Integrity: this.Dist.integrity ?? "" };
    }
    this.Artifact = init.Artifact ?? null;
    this.Published = toDate(init.Published ?? null);
  }

  // toJSON：Go 的 json.Marshal 按 tag 输出；Artifact 与 Published 不序列化。
  toJSON() {
    return {
      name: this.Name,
      version: this.Version,
      deprecated: this.Deprecated,
      dist: { integrity: this.Dist.Integrity },
    };
  }
}

class packageMetadata {
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

Manager.prototype.candidate = async function (ctx, provider) {
  const spec = providerSpecs[provider];
  if (spec.Package === "") {
    return this.vendorCandidate(ctx, provider);
  }
  const metadata = await this.fetchPackageMetadata(ctx, spec.Package);
  const version = metadata.Tags.latest;
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
  if (candidate.Published == null || candidate.Published.getTime() === 0) {
    throw new Error("candidate release has no valid publication time");
  }
  return candidate;
};

// fetchPackageMetadata downloads and decodes the full npm registry document
// for pkg.
Manager.prototype.fetchPackageMetadata = async function (ctx, pkg) {
  const endpoint = npmRegistry + "/" + encodeURIComponent(pkg);
  // Go 的 http.NewRequestWithContext：ctx 是 AbortSignal，直接传给 fetch。
  const response = await fetch(endpoint, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: ctx instanceof AbortSignal ? ctx : undefined,
  });
  if (response.status !== 200) {
    throw new Error(`package metadata HTTP ${response.status}`);
  }
  const limit = 64 << 20;
  const data = await response.text();
  if (data.length > limit) {
    throw new Error("package metadata exceeds size limit");
  }
  let metadata;
  try {
    metadata = new packageMetadata(JSON.parse(data));
  } catch (err) {
    throw new Error(`invalid package metadata: ${err.message}`);
  }
  return metadata;
};

// matureVersion returns the newest supported, non-deprecated release no
// newer than upper that was published before cutoff.
//
// Fast-moving CLIs may publish several times a day. Merely rejecting an
// immature latest tag would then postpone updates forever. Selecting the
// newest mature release, bounded by the official latest tag, keeps updates
// flowing. DSH release candidates are eligible only while latest is an RC.
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
    if (published == null || published.getTime() === 0 || published > cutoff) {
      continue;
    }
    if (mature === "" || compareVersions(v, mature) > 0) {
      mature = v;
    }
  }
  return mature;
}

function validIntegrity(value) {
  if (!value.startsWith("sha512-")) {
    return false;
  }
  let decoded;
  try {
    decoded = Buffer.from(value.slice("sha512-".length), "base64");
  } catch {
    return false;
  }
  return decoded.length === 64;
}

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

// strings.Cut(v, "-rc.")：切到第一处 "-rc."，没有时返回原串与空串。
function cutRC(v) {
  const idx = v.indexOf("-rc.");
  if (idx === -1) {
    return [v, ""];
  }
  return [v.slice(0, idx), v.slice(idx + 4)];
}

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

// parseJSONTime：Go 的 json.Unmarshal 进 time.Time，非法值返回零值；此处非法返回 null。
function parseJSONTime(raw) {
  if (raw == null) {
    return null;
  }
  let text = raw;
  if (typeof raw !== "string") {
    try {
      text = JSON.parse(raw);
    } catch {
      return null;
    }
  } else if (raw.startsWith('"')) {
    try {
      text = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = { release, packageMetadata, matureVersion, validIntegrity, compareVersions, compareVersionNumber };
