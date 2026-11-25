// vendor_observation.js —— 对应 Go 文件：internal/managedcli/vendor_observation.go
// 作用：留住已观察到的供应商版本，让观察期窗口不被频繁发版一直重置。
// Go 的 time.Time 译为 JS Date；(值, error) 译为成功返回值、失败 throw。

"use strict";

const { Manager, blockedByRollback, newerRelease } = require("./updater.js"); // 对应 Go 同包类型与函数，updater.js 已翻译
const { release } = require("./registry.js"); // 对应 Go 同包类型，registry.js 已翻译
const { validProviderVersion, observationWindow } = require("./providers.js"); // 对应 Go 同包常量与函数，providers.js 已翻译
const { cursorArchiveURL, validCursorETag, agyArchiveURL, validIntegrity, vendorArtifact } = require("./vendor.js"); // 对应 Go 同包函数，vendor.js 已翻译
const { Installation, toDate } = require("./manifest.js"); // 对应 Go 同包类型与函数，manifest.js 已翻译

const maxVendorObservations = 8;

class vendorObservation {
  // 构造器同时认 Go 字段名与 JSON tag 名。
  constructor(init = {}) {
    this.Version = init.Version ?? init.version ?? "";
    this.Published = toDate(init.Published ?? init.published ?? null);
    this.URL = init.URL ?? init.url ?? "";
    this.ETag = init.ETag ?? init.etag ?? "";
    this.Integrity = init.Integrity ?? init.integrity ?? "";
  }

  // toJSON：Go 的 json.Marshal 按 tag 输出，omitempty 字段为空时省略。
  toJSON() {
    const out = { version: this.Version, published: this.Published, url: this.URL };
    if (this.ETag !== "") {
      out.etag = this.ETag;
    }
    if (this.Integrity !== "") {
      out.integrity = this.Integrity;
    }
    return out;
  }

  release(provider) {
    if (this.Published == null || this.Published.getTime() === 0 || !validProviderVersion(provider, this.Version)) {
      return [new release(), false];
    }
    switch (provider) {
      case "cursor":
        if (this.URL !== cursorArchiveURL(this.Version) || !validCursorETag(this.ETag) || this.Integrity !== "") {
          return [new release(), false];
        }
        break;
      case "agy":
        try {
          agyArchiveURL(this.URL, this.Version);
        } catch {
          return [new release(), false];
        }
        if (!validIntegrity(this.Integrity) || this.ETag !== "") {
          return [new release(), false];
        }
        break;
      default:
        return [new release(), false];
    }
    const candidate = new release({
      Version: this.Version,
      Published: this.Published,
      Artifact: new vendorArtifact({ url: this.URL, etag: this.ETag }),
    });
    candidate.Dist.Integrity = this.Integrity;
    return [candidate, true];
  }
}

function observeVendorRelease(candidate) {
  return new vendorObservation({
    Version: candidate.Version,
    Published: candidate.Published,
    URL: candidate.Artifact.url,
    ETag: candidate.Artifact.etag,
    Integrity: candidate.Dist.Integrity,
  });
}

// Vendor manifests advertise only their latest release. Retain observed
// archives across checks so a new publish cannot perpetually reset the
// observation window for the channel.
Manager.prototype.observeVendorReleases = function (state, provider, latest) {
  const installed = state.Current[provider] ?? new Installation();
  const isUpgrade = (candidate) =>
    !blockedByRollback(state, provider, candidate) &&
    (installed.Version === "" || newerRelease(provider, candidate, installed.Version, installed.PublishedAt));
  const previous = state.VendorObservations[provider] ?? [];
  if (!isUpgrade(latest)) {
    // A channel retreat removes observations above the advertised
    // version. Wait for a newly advertised upgrade.
    if (previous.length > 0) {
      delete state.VendorObservations[provider];
      this.save(state);
    }
    return latest;
  }

  const retained = [];
  let selected = latest;
  const cutoff = new Date(this.Now().getTime() - observationWindow);
  for (const observationRaw of previous) {
    const observation = observationRaw instanceof vendorObservation ? observationRaw : new vendorObservation(observationRaw);
    const [seen, ok] = observation.release(provider);
    if (!ok || !isUpgrade(seen) || !newerRelease(provider, latest, seen.Version, seen.Published)) {
      continue;
    }
    // At capacity, keep the earlier observations first so they can reach
    // the 24-hour gate during bursts of releases. Reserve slots for the
    // selected candidate and the latest release.
    if (retained.length < maxVendorObservations - 2) {
      retained.push(observation);
    }
    if (latest.Published > cutoff && !(seen.Published > cutoff) &&
      (selected.Version === latest.Version || newerRelease(provider, seen, selected.Version, selected.Published))) {
      selected = seen;
    }
  }
  if (selected.Version !== latest.Version && !retained.some((o) => o.Version === selected.Version)) {
    retained.push(observeVendorRelease(selected));
  }
  retained.push(observeVendorRelease(latest));
  if (!observationsEqual(previous, retained)) {
    state.VendorObservations[provider] = retained;
    this.save(state);
  }
  return selected;
};

// Go 的 slices.Equal：逐个比较 Version/Published/URL/ETag/Integrity。
function observationsEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i] instanceof vendorObservation ? a[i] : new vendorObservation(a[i]);
    const y = b[i] instanceof vendorObservation ? b[i] : new vendorObservation(b[i]);
    const xPub = x.Published == null ? 0 : x.Published.getTime();
    const yPub = y.Published == null ? 0 : y.Published.getTime();
    if (x.Version !== y.Version || xPub !== yPub || x.URL !== y.URL || x.ETag !== y.ETag || x.Integrity !== y.Integrity) {
      return false;
    }
  }
  return true;
}

module.exports = { maxVendorObservations, vendorObservation, observeVendorRelease };
