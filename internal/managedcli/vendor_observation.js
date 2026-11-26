// vendor_observation.js —— 对应 Go 文件：internal/managedcli/vendor_observation.go
// 作用：在本地状态中跨检查周期留存已观察到的供应商直供版本（Cursor 与 Antigravity），
// 防止上游频繁发版导致 24 小时观察期窗口被不断重置。
// 职责边界：仅维护 state.VendorObservations 的记录筛选、持久化与成熟候选挑选，不直接发起网络请求或下载归档。
// 语法差异说明：
// - Go 的 time.Time 译为 JS Date（零值译为 null）；
// - Go 的 (release, bool) 多返回值译为 [release, boolean] 元组；
// - Go 的 (release, error) 多返回值译为成功直接 return、失败 throw Error；
// - Go 同包挂在 *Manager 上的方法挂载在 Manager.prototype 上。

"use strict";

const { Manager, blockedByRollback, newerRelease } = require("./updater.js");
const { release } = require("./registry.js");
const { validProviderVersion, observationWindow } = require("./providers.js");
const { cursorArchiveURL, validCursorETag, agyArchiveURL, validIntegrity, vendorArtifact } = require("./vendor.js");
const { Installation, toDate } = require("./manifest.js");

const maxVendorObservations = 8;

// Go 的零值时间 time.Time{}（0001-01-01T00:00:00Z）在 JS Date 中的毫秒时间戳。
const goZeroTimeMs = -62135596800000;

/**
 * 表示 state.json 中持久化保存的一条供应商直供版本观察记录。
 */
class vendorObservation {
  /**
   * 构造供应商版本观察记录，兼容 Go 字段名与 JSON 字段名。
   *
   * @param {object} [init={}] 初始字段对象，可选包含 Version/version、Published/published、URL/url、ETag/etag、Integrity/integrity。
   */
  constructor(init = {}) {
    this.Version = init.Version ?? init.version ?? "";
    this.Published = toDate(init.Published ?? init.published ?? null);
    this.URL = init.URL ?? init.url ?? "";
    this.ETag = init.ETag ?? init.etag ?? "";
    this.Integrity = init.Integrity ?? init.integrity ?? "";
  }

  /**
   * 按 Go 的 json 标签序列化，ETag 与 Integrity 为空时省略。
   *
   * @returns {object} 可用于 JSON.stringify 的普通对象。
   */
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

  /**
   * 校验当前观察记录是否仍然合法，并还原为对应的 release 实例。
   * 在 observeVendorReleases 遍历历史观察记录时调用，丢弃损坏或不符合当前主机规则的条目。
   *
   * @param {string} provider 供应商名称（"cursor" 或 "agy"）。
   * @returns {[release, boolean]} 合法时返回 [candidate, true]，非法时返回 [空 release, false]。
   */
  release(provider) {
    if (this.Published == null || this.Published.getTime() === 0 || this.Published.getTime() === goZeroTimeMs || !validProviderVersion(provider, this.Version)) {
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

/**
 * 将已解析的供应商直供候选 release 转换为可持久化的 vendorObservation 记录。
 * 在 observeVendorReleases 更新 state.VendorObservations 列表时调用。
 *
 * @param {release} candidate 含 Artifact 字段的候选发布对象。
 * @returns {vendorObservation} 对应的观察记录实例。
 */
function observeVendorRelease(candidate) {
  return new vendorObservation({
    Version: candidate.Version,
    Published: candidate.Published,
    URL: candidate.Artifact.url,
    ETag: candidate.Artifact.etag,
    Integrity: candidate.Dist.Integrity,
  });
}

/**
 * 结合本次从上游获取的 latest 版本与历史观察列表，维护最多 maxVendorObservations 条记录，
 * 并在 latest 尚处观察期时优先返回已满 24 小时观察期的最新历史候选版本。
 * 由 updateProvidersLocked 在 candidate.Artifact 非空时调用。
 *
 * @param {object} state 当前托管状态对象（State 实例，本方法可能修改其 VendorObservations 并写盘）。
 * @param {string} provider 供应商名称。
 * @param {release} latest 本次从供应商清单/安装脚本解析出的最新候选版本。
 * @returns {release} 最终供 releaseGate 评估的候选发布对象（可能是已满观察期的历史版本或 latest 本身）；写盘失败时抛出错误。
 */
Manager.prototype.observeVendorReleases = function (state, provider, latest) {
  const installed = state.Current[provider] ?? new Installation();
  const isUpgrade = (candidate) =>
    !blockedByRollback(state, provider, candidate) &&
    (installed.Version === "" || newerRelease(provider, candidate, installed.Version, installed.PublishedAt));
  const previous = state.VendorObservations[provider] ?? [];
  if (!isUpgrade(latest)) {
    // 若上游通道回退，则清除高于当前广播版本的历史观察，等待新的升级发布。
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
    // 达到容量上限时优先保留较早观察到的版本，确保高频发版期间早期版本能度过 24 小时门控；
    // 预留 2 个槽位分别给选中的成熟版本与 latest。
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

/**
 * 逐项比较两组观察记录是否完全一致，对应 Go 的 slices.Equal(previous, retained)。
 * 在 observeVendorReleases 决定是否需要原子回写 state.json 时调用。
 *
 * @param {Array<vendorObservation|object>} a 原始观察记录数组。
 * @param {Array<vendorObservation|object>} b 新生成的观察记录数组。
 * @returns {boolean} 长度与每项字段均一致返回 true，否则返回 false。
 */
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
