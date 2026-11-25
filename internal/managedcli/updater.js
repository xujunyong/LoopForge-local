// updater.js —— 对应 Go 文件：internal/managedcli/updater.go
// 作用：托管 CLI 更新器的入口：日检、更新、单供应商更新与回滚。
// Go 的 time.Time 译为 JS Date；time.Duration 译为毫秒数；
// context.Context 译为 AbortSignal；(值, error) 译为成功返回值、失败 throw；
// errors.Join 译为把多条错误信息拼成一个 Error。

"use strict";

const path = require("node:path");

const { ReadState, Installation, atomicJSON, validRoot, validateInventory, toDate } = require("./manifest.js"); // 对应 Go 同包函数，manifest.js 已翻译
const { WithUpdateLock, WithMaintenance } = require("./coordinator.js"); // 对应 Go 同包函数，coordinator.js 已翻译
const { EnabledProviders, Supports, providerSpecs, providerAllowlistEnv, observationWindow, maintenanceTimeout, validProviderVersion } = require("./providers.js"); // 对应 Go 同包常量与函数，providers.js 已翻译
const { executeCommand } = require("./command_capture.js"); // 对应 Go 同包函数，command_capture.js 已翻译
const schedulerPkg = require("./scheduler.js"); // 对应 Go 同包函数，scheduler.js 已翻译；循环引用，调用时再取属性

class Manager {
  constructor(init = {}) {
    this.Root = init.Root ?? "";
    this.Client = init.Client ?? null;
    this.RunCommand = init.RunCommand ?? null;
    this.Now = init.Now ?? (() => new Date());
    this.nodeBinary = init.nodeBinary ?? ""; // Resolved from the worker process PATH, not local policy.
    this.npmBinary = init.npmBinary ?? "";
  }
}

class ProviderResult {
  // 构造器同时认 Go 字段名与 JSON tag 名。
  constructor(init = {}) {
    this.Provider = init.Provider ?? init.provider ?? "";
    this.From = init.From ?? init.from ?? "";
    this.To = init.To ?? init.to ?? "";
    this.Status = init.Status ?? init.status ?? "";
    this.Message = init.Message ?? init.message ?? "";
    this.Validation = init.Validation ?? init.validation ?? "";
  }

  // toJSON：Go 的 json.Marshal 按 tag 输出，omitempty 字段为空时省略。
  toJSON() {
    const out = { provider: this.Provider, status: this.Status };
    if (this.From !== "") {
      out.from = this.From;
    }
    if (this.To !== "") {
      out.to = this.To;
    }
    if (this.Message !== "") {
      out.message = this.Message;
    }
    if (this.Validation !== "") {
      out.validation = this.Validation;
    }
    return out;
  }
}

class Report {
  // 构造器同时认 Go 字段名与 JSON tag 名。
  constructor(init = {}) {
    this.Action = init.Action ?? init.action ?? "";
    this.StartedAt = toDate(init.StartedAt ?? init.startedAt ?? null);
    this.FinishedAt = toDate(init.FinishedAt ?? init.finishedAt ?? null);
    this.Results = init.Results ?? init.results ?? [];
    this.Error = init.Error ?? init.error ?? "";
  }

  // toJSON：Go 的 json.Marshal 按 tag 输出，omitempty 字段为空时省略。
  toJSON() {
    const out = {
      action: this.Action,
      startedAt: this.StartedAt,
      finishedAt: this.FinishedAt,
      results: this.Results,
    };
    if (this.Error !== "") {
      out.error = this.Error;
    }
    return out;
  }
}

function NewManager(root) {
  const rootErr = validRoot(root);
  if (rootErr != null) {
    throw rootErr;
  }
  return new Manager({
    Root: root,
    RunCommand: executeCommand,
    Now: () => new Date(),
    Client: {
      Timeout: 2 * 60 * 1000,
      CheckRedirect: (url, via) => {
        if (url.protocol !== "https:" || via.length >= 5) {
          throw new Error("refuse insecure or excessive registry redirects");
        }
      },
    },
  });
}

// Check claims today's Beijing window before any external work. Failed or
// interrupted attempts consume that date; manual Update remains available.
Manager.prototype.Check = async function (ctx) {
  return this.run(ctx, "check", "");
};

// Update stages independent providers without blocking tasks. Only publication
// of Current enters maintenance; failures retain the previous active version.
Manager.prototype.Update = async function (ctx) {
  return this.run(ctx, "update", "");
};

// UpdateProvider updates a single CLI already selected by the runner.
Manager.prototype.UpdateProvider = async function (ctx, provider) {
  if (!Supports(provider)) {
    throw new Error(`unsupported managed CLI ${JSON.stringify(provider)}`);
  }
  return this.run(ctx, "update", provider);
};

// Rollback is explicit, never triggered by task/model errors. Existing run pins
// stay immutable and automatic updates never retry the rejected version.
Manager.prototype.Rollback = async function (ctx, provider) {
  return this.run(ctx, "rollback", provider);
};

Manager.prototype.run = async function (ctx, action, provider) {
  let report = new Report();
  let providers = [];
  if (action !== "rollback") {
    providers = EnabledProviders();
    if (provider !== "") {
      if (!providers.includes(provider)) {
        throw new Error(`managed CLI ${JSON.stringify(provider)} is not enabled by ${providerAllowlistEnv}`);
      }
      providers = [provider];
    }
  }
  await WithUpdateLock(ctx, this.Root, async () => {
    const now = this.Now(); // Go：m.Now().UTC()；JS 的 Date 本就是 UTC 时间戳
    if (action === "check" && now < schedulerPkg.scheduledAt(this.Root, now)) {
      return;
    }
    const state = ReadState(this.Root);
    if (action === "check") {
      if (beijingDateString(state.LastCheck) >= beijingDateString(now)) {
        return;
      }
      if (ctx instanceof AbortSignal && ctx.aborted) {
        throw ctx.reason; // Go：ctx.Err()
      }
      state.LastCheck = now;
      this.save(state);
    }
    report = new Report({ Action: action, StartedAt: now, Results: [] });
    let operationErr = null;
    try {
      if (action === "rollback") {
        await this.rollbackLocked(ctx, provider, state, report);
      } else {
        await this.updateProvidersLocked(ctx, state, report, providers);
      }
    } catch (err) {
      operationErr = err;
    } finally {
      report.FinishedAt = this.Now();
      if (operationErr != null) {
        report.Error = operationErr.message;
      }
      try {
        atomicJSON(path.join(this.Root, "last-report.json"), report);
      } catch (e) {
        operationErr = operationErr == null ? e : new Error(`${operationErr.message}: ${e.message}`);
      }
    }
    if (operationErr != null) {
      throw operationErr;
    }
  });
  return report;
};

Manager.prototype.updateProvidersLocked = async function (ctx, state, report, providers) {
  const candidates = {};
  const failures = [];
  let toolsReady = false;
  for (const provider of providers) {
    const result = new ProviderResult({ Provider: provider, From: (state.Current[provider] ?? new Installation()).Version });
    let candidate;
    let err = null;
    try {
      candidate = await this.candidate(ctx, provider);
      if (candidate.Artifact != null) {
        candidate = this.observeVendorReleases(state, provider, candidate);
      }
    } catch (e) {
      err = e;
    }
    if (err == null) {
      result.To = candidate.Version;
      [result.Status, result.Message] = this.releaseGate(state, provider, result.From, candidate);
    }
    if (err == null && result.Status === "") {
      try {
        if (candidate.Artifact != null) {
          this.prepareCommandDirectories();
        } else if (!toolsReady) {
          await this.prepareTools(ctx);
          toolsReady = true;
        }
        const installed = await this.stageCandidate(ctx, state, provider, candidate);
        candidates[provider] = installed;
        result.Status = "staged";
        result.Validation = "version-and-required-arguments";
      } catch (e) {
        err = e;
      }
    }
    if (err != null) {
      result.Status = "failed";
      result.Message = err.message;
      failures.push(new Error(`${provider}: ${err.message}`));
    }
    report.Results.push(result);
    if (ctx instanceof AbortSignal && ctx.aborted) {
      failures.push(ctx.reason instanceof Error ? ctx.reason : new Error(String(ctx.reason)));
      throw new Error(failures.map((e) => e.message).join(": ")); // Go：errors.Join
    }
  }
  if (Object.keys(candidates).length !== 0) {
    for (const [provider, candidate] of Object.entries(candidates)) {
      if (state.Current[provider] != null) {
        state.Previous[provider] = state.Current[provider];
      }
      state.Current[provider] = candidate;
      delete state.Rejected[provider];
    }
    let activateErr = null;
    try {
      await this.activate(ctx, state);
    } catch (e) {
      activateErr = e;
    }
    for (const r of report.Results) {
      if (r.Status === "staged") {
        if (activateErr == null) {
          r.Status = "updated";
        } else {
          r.Message = "candidate retained; activation deferred: " + activateErr.message;
        }
      }
    }
    if (activateErr != null) {
      failures.push(activateErr);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.map((e) => e.message).join(": ")); // Go：errors.Join
  }
};

// releaseGate reports why a resolved release must not be staged for provider.
// An empty status means the release is eligible for installation.
Manager.prototype.releaseGate = function (state, provider, from, candidate) {
  if (candidate.Version === from) {
    return ["unchanged", ""];
  }
  if (from !== "" && !newerRelease(provider, candidate, from, state.Current[provider]?.PublishedAt ?? null)) {
    return ["skipped", "automatic downgrade refused"];
  }
  if (blockedByRollback(state, provider, candidate)) {
    if (state.Rejected[provider] === candidate.Version) {
      return ["skipped", "this release was rolled back; waiting for a newer release"];
    }
    return ["skipped", "waiting for a release newer than the rolled-back version"];
  }
  if (this.Now() < new Date(candidate.Published.getTime() + observationWindow)) {
    return ["skipped", "release is still in the observation window"];
  }
  return ["", ""];
};

function blockedByRollback(state, provider, candidate) {
  const rejected = state.Rejected[provider] ?? "";
  if (rejected === "") {
    return false;
  }
  // An intermediate release could otherwise activate and clear the
  // rejection, allowing the rolled-back version to return later.
  if (!validProviderVersion(provider, rejected)) {
    return true;
  }
  let published = null;
  const previous = state.Previous[provider];
  if (previous != null && previous.Version === rejected) {
    published = previous.PublishedAt;
  }
  return !newerRelease(provider, candidate, rejected, published);
}

function newerRelease(provider, candidate, from, published) {
  if (candidate.Version === from) {
    return false;
  }
  if (provider === "cursor") {
    // Build hashes have no ordering within a day. The artifact's
    // timestamp must establish a strictly newer same-day release.
    const candidateDate = candidate.Version.slice(0, 10);
    const currentDate = from.slice(0, 10);
    if (candidateDate !== currentDate) {
      return candidateDate > currentDate;
    }
    return published != null && candidate.Published > published;
  }
  return compareVersions(candidate.Version, from) > 0;
}

// compareVersions 在 registry.js 里定义为同包函数；registry.js 又依赖本文件的 Manager，
// 顶层互相 require 会拿到未初始化的导出，故此处调用时再取模块属性。
function compareVersions(a, b) {
  return require("./registry.js").compareVersions(a, b);
}

// stageCandidate reuses the cached candidate installation when it still matches
// the release, otherwise installs it, then smoke-validates the result.
Manager.prototype.stageCandidate = async function (ctx, state, provider, candidate) {
  let installed = state.Candidates[provider] ?? new Installation();
  let needsInstall =
    installed.Version !== candidate.Version || installed.Integrity !== candidate.identity();
  if (!needsInstall) {
    try {
      validateInventory(this.Root, { [provider]: installed });
    } catch {
      needsInstall = true;
    }
  }
  if (needsInstall) {
    installed = await this.install(ctx, provider, candidate);
    // Cache before smoke validation: a failed probe must not cause
    // another download. No active inventory changes here.
    state.Candidates[provider] = installed;
    this.save(state);
  }
  await this.validate(ctx, provider, installed);
  return installed;
};

Manager.prototype.rollbackLocked = async function (ctx, provider, state, report) {
  if (!Supports(provider)) {
    throw new Error("rollback requires a known provider");
  }
  const previous = state.Previous[provider];
  if (previous == null) {
    throw new Error("no previous managed version available; global installations were not modified");
  }
  report.Results.push(new ProviderResult({
    Provider: provider,
    From: (state.Current[provider] ?? new Installation()).Version,
    To: previous.Version,
    Status: "failed",
  }));
  if (providerSpecs[provider].Package === "") {
    this.prepareCommandDirectories();
  } else {
    await this.prepareTools(ctx);
  }
  try {
    await this.validate(ctx, provider, previous);
  } catch (err) {
    throw new Error(`rollback candidate validation: ${err.message}`);
  }
  state.Rejected[provider] = (state.Current[provider] ?? new Installation()).Version;
  state.Previous[provider] = state.Current[provider] ?? new Installation();
  state.Current[provider] = previous;
  await this.activate(ctx, state);
  report.Results[0].Status = "rolled-back";
};

// The caller holds updater.lock throughout: no second state read is necessary.
Manager.prototype.activate = async function (ctx, state) {
  const signals = [];
  if (ctx instanceof AbortSignal) {
    signals.push(ctx);
  }
  signals.push(AbortSignal.timeout(maintenanceTimeout));
  const timeoutCtx = AbortSignal.any(signals); // Go：context.WithTimeout(ctx, maintenanceTimeout)
  await WithMaintenance(timeoutCtx, this.Root, async () => {
    validateInventory(this.Root, state.Current);
    state.UpdatedAt = this.Now();
    if (timeoutCtx.aborted) {
      throw timeoutCtx.reason; // Go：ctx.Err()
    }
    this.save(state);
  });
};

Manager.prototype.save = function (state) {
  atomicJSON(path.join(this.Root, "state.json"), state);
};

// beijingDateString：Go 的 t.In(beijing).Format("2006-01-02")；零值/空返回 ""，比较时小于任何日期。
function beijingDateString(t) {
  if (t == null || t.getTime() === 0) {
    return "";
  }
  const bj = new Date(t.getTime() + 8 * 60 * 60 * 1000);
  const mm = String(bj.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(bj.getUTCDate()).padStart(2, "0");
  return `${bj.getUTCFullYear()}-${mm}-${dd}`;
}

module.exports = {
  Manager,
  ProviderResult,
  Report,
  NewManager,
  blockedByRollback,
  newerRelease,
  beijingDateString,
};
