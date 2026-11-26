// updater.js —— 对应 Go 文件：internal/managedcli/updater.go
// 作用：提供托管 CLI 更新器 Manager 及核心流程入口（每日检查 Check、批量更新 Update、
// 单供应商更新 UpdateProvider 与显式回滚 Rollback），管理门控校验、暂存缓存、维护窗口激活与报告落盘。
// 职责边界：编排整体更新与回滚生命周期，具体的 registry 拉取、供应商直供处理、npm 装包和文件锁委托给同包其他模块。
// 语法差异说明：
// - Go 的 time.Time 译为 JS Date（零值译为 null），time.Duration 译为毫秒数；
// - Go 的 context.Context 译为 AbortSignal；
// - Go 的 (值, error) 多返回值译为成功直接 return、失败 throw Error；
// - Go 的 errors.Join 译为按换行符拼接多个错误消息生成新 Error；
// - Go 的 defer 报告落盘逻辑译为 try/catch/finally。

"use strict";

const path = require("node:path");

const { ReadState, Installation, atomicJSON, validRoot, validateInventory, toDate } = require("./manifest.js");
const { WithUpdateLock, WithMaintenance } = require("./coordinator.js");
const { EnabledProviders, Supports, providerSpecs, providerAllowlistEnv, observationWindow, maintenanceTimeout, validProviderVersion } = require("./providers.js");
const { executeCommand } = require("./command_capture.js");
const schedulerPkg = require("./scheduler.js");

// Go 的零值时间 time.Time{}（0001-01-01T00:00:00Z）在 JS Date 中的毫秒时间戳。
const goZeroTimeMs = -62135596800000;

/**
 * 托管 CLI 更新管理器，持有根目录、HTTP 客户端配置、命令执行器、时钟函数及解析出的 node/npm 路径。
 */
class Manager {
  /**
   * 构造 Manager 实例，按 Go struct 零值规则初始化缺省字段。
   *
   * @param {object} [init={}] 初始字段对象，可选包含 Root、Client、RunCommand、Now、nodeBinary、npmBinary。
   */
  constructor(init = {}) {
    this.Root = init.Root ?? "";
    this.Client = init.Client ?? null;
    this.RunCommand = init.RunCommand ?? null;
    this.Now = init.Now ?? null;
    this.nodeBinary = init.nodeBinary ?? ""; // 从当前进程 PATH 解析，不受本地策略覆盖。
    this.npmBinary = init.npmBinary ?? "";
  }
}

/**
 * 记录单个供应商在一次检查、更新或回滚操作中的结果明细。
 */
class ProviderResult {
  /**
   * 构造供应商操作结果实例，兼容 Go 字段名与 JSON 字段名。
   *
   * @param {object} [init={}] 初始字段对象，可选包含 Provider/provider、From/from、To/to、Status/status、Message/message、Validation/validation。
   */
  constructor(init = {}) {
    this.Provider = init.Provider ?? init.provider ?? "";
    this.From = init.From ?? init.from ?? "";
    this.To = init.To ?? init.to ?? "";
    this.Status = init.Status ?? init.status ?? "";
    this.Message = init.Message ?? init.message ?? "";
    this.Validation = init.Validation ?? init.validation ?? "";
  }

  /**
   * 按 Go 的 json 标签序列化，值为空的 omitempty 字段不输出。
   *
   * @returns {object} 可用于 JSON.stringify 的普通对象。
   */
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

/**
 * 记录一次完整的 check、update 或 rollback 执行报告，会被原子写入 last-report.json。
 */
class Report {
  /**
   * 构造执行报告实例，兼容 Go 字段名与 JSON 字段名。
   *
   * @param {object} [init={}] 初始字段对象，可选包含 Action/action、StartedAt/startedAt、FinishedAt/finishedAt、Results/results、Error/error。
   */
  constructor(init = {}) {
    this.Action = init.Action ?? init.action ?? "";
    this.StartedAt = toDate(init.StartedAt ?? init.startedAt ?? null);
    this.FinishedAt = toDate(init.FinishedAt ?? init.finishedAt ?? null);
    this.Results = init.Results ?? init.results ?? [];
    this.Error = init.Error ?? init.error ?? "";
  }

  /**
   * 按 Go 的 json 标签序列化，Error 为空时省略。
   *
   * @returns {object} 可用于 JSON.stringify 的普通对象。
   */
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

/**
 * 校验托管根目录并创建带有默认执行器、系统时钟与安全 HTTPS 重定向限制的 Manager 实例。
 * 在 CLI 子命令或定时调度器启动管理操作前调用。
 *
 * @param {string} root 托管 CLI 根目录的绝对路径。
 * @returns {Manager} 初始化完成的 Manager 实例；根目录非法时抛出错误。
 */
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

/**
 * 执行每日定时检查：先占位当天的北京时间窗口再执行外部检查；失败或中断仍消耗当日窗口，手动 Update 仍可用。
 * 由 scheduler.js 的每日定时循环调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @returns {Promise<Report>} 本次检查报告；尚未到达窗口或当日已检查时返回空 Report；执行出错时抛出错误。
 */
Manager.prototype.Check = async function (ctx) {
  return this.run(ctx, "check", "");
};

/**
 * 批量更新所有已启用的托管 CLI 供应商。
 * 各供应商在锁外独立暂存，仅在发布 Current 清单时短暂进入维护窗口；失败时保留原有激活版本。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @returns {Promise<Report>} 本次更新报告；任一步骤出错时抛出错误。
 */
Manager.prototype.Update = async function (ctx) {
  return this.run(ctx, "update", "");
};

/**
 * 单独更新运行器指定的某一个托管 CLI 供应商。
 * 在按需触发单个供应商更新时调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {string} provider 目标供应商名称。
 * @returns {Promise<Report>} 本次单供应商更新报告；供应商不受支持、未启用或执行失败时抛出错误。
 */
Manager.prototype.UpdateProvider = async function (ctx, provider) {
  if (!Supports(provider)) {
    throw new Error(`unsupported managed CLI ${JSON.stringify(provider)}`);
  }
  return this.run(ctx, "update", provider);
};

/**
 * 显式将指定供应商回滚到上一版本，并将当前版本记入 Rejected 避免自动更新再次切回。
 * 仅由人工或运维显式触发，绝不由任务或模型错误自动调用；已固定版本的运行不受影响。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {string} provider 待回滚的供应商名称。
 * @returns {Promise<Report>} 本次回滚报告；无可回滚版本或验证/激活失败时抛出错误。
 */
Manager.prototype.Rollback = async function (ctx, provider) {
  return this.run(ctx, "rollback", provider);
};

/**
 * 统一的更新器加锁执行入口，负责解析白名单、获取 updater.lock、处理日检窗口占位及落盘 last-report.json。
 * 由 Check、Update、UpdateProvider 与 Rollback 内部调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {string} action 操作类型："check"、"update" 或 "rollback"。
 * @param {string} provider 可选的单供应商名称；批量操作时为空字符串 ""。
 * @returns {Promise<Report>} 执行报告对象；出错时抛出错误。
 */
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
    const now = this.Now(); // 对应 Go：m.Now().UTC()；JS 的 Date 内部始终为 UTC 时间戳。
    if (action === "check" && now < schedulerPkg.scheduledAt(this.Root, now)) {
      return;
    }
    const state = ReadState(this.Root);
    if (action === "check") {
      if (beijingDateString(state.LastCheck) >= beijingDateString(now)) {
        return;
      }
      if (ctx instanceof AbortSignal && ctx.aborted) {
        throw ctx.reason; // 对应 Go：ctx.Err()
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
        operationErr = operationErr == null ? e : new Error(`${operationErr.message}\n${e.message}`);
      }
    }
    if (operationErr != null) {
      throw operationErr;
    }
  });
  return report;
};

/**
 * 在持有更新锁的情况下，逐个拉取并校验供应商候选版本、暂存可升级版本并在维护窗口中统一激活。
 * 由 run 在执行 check 或 update 时调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {object} state 当前托管状态对象（State 实例）。
 * @param {Report} report 本次操作报告对象（方法内会追加 Results）。
 * @param {string[]} providers 本次待处理的供应商名称列表。
 * @returns {Promise<void>} 无返回值；存在任意供应商失败、取消或激活失败时合并抛出错误。
 */
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
      throw new Error(failures.map((e) => e.message).join("\n")); // 对应 Go：errors.Join
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
    throw new Error(failures.map((e) => e.message).join("\n")); // 对应 Go：errors.Join
  }
};

/**
 * 判断已解析的候选版本是否应被门控拦截（无变化、禁止自动降级、回滚拒绝或尚在 24 小时观察期内）。
 * 在 updateProvidersLocked 决定是否安装某个候选版本前调用；返回空 status 表示允许进入安装。
 *
 * @param {object} state 当前托管状态对象（State 实例）。
 * @param {string} provider 供应商名称。
 * @param {string} from 当前已激活版本号（尚未安装时为空字符串 ""）。
 * @param {object} candidate 候选版本发布对象（release 实例）。
 * @returns {[string, string]} 返回 [status, message] 元组；["", ""] 表示通过门控。
 */
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

/**
 * 判断候选版本是否被历史回滚记录所阻止（必须严格晚于被回滚的版本才允许重新自动更新）。
 * 在 releaseGate 与 observeVendorReleases 中调用。
 *
 * @param {object} state 当前托管状态对象（State 实例）。
 * @param {string} provider 供应商名称。
 * @param {object} candidate 候选版本发布对象（release 实例）。
 * @returns {boolean} 被回滚记录阻止返回 true，否则返回 false。
 */
function blockedByRollback(state, provider, candidate) {
  const rejected = state.Rejected[provider] ?? "";
  if (rejected === "") {
    return false;
  }
  // 若被拒绝的版本字符串本身非法，则保持拦截，防止中间版本清掉拒绝标记后让坏版本回流。
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

/**
 * 判断候选版本是否严格新于参考版本 from。
 * 在降级拦截、回滚门控与供应商观察列表筛选时调用；对于 cursor 同一天的不同构建，使用发布时间比较先后。
 *
 * @param {string} provider 供应商名称。
 * @param {object} candidate 候选版本发布对象（release 实例）。
 * @param {string} from 参考版本号。
 * @param {Date|null} published 参考版本的发布时间（仅 cursor 同日构建比较时使用）。
 * @returns {boolean} 候选版本严格更新返回 true，否则返回 false。
 */
function newerRelease(provider, candidate, from, published) {
  if (candidate.Version === from) {
    return false;
  }
  if (provider === "cursor") {
    // 同一天内的构建哈希没有自然顺序，需借助归档发布时间确认严格更新。
    const candidateDate = candidate.Version.slice(0, 10);
    const currentDate = from.slice(0, 10);
    if (candidateDate !== currentDate) {
      return candidateDate > currentDate;
    }
    return published != null && candidate.Published > published;
  }
  return compareVersions(candidate.Version, from) > 0;
}

/**
 * 延迟调用 registry.js 中的 compareVersions，打破 updater.js 与 registry.js 之间的循环引用。
 * 仅供本文件 newerRelease 内部调用。
 *
 * @param {string} a 左侧版本号。
 * @param {string} b 右侧版本号。
 * @returns {number} 比较结果（正数、负数或 0）。
 */
function compareVersions(a, b) {
  return require("./registry.js").compareVersions(a, b);
}

/**
 * 优先复用 state.Candidates 中版本、摘要与文件校验均匹配的缓存安装，否则重新安装并缓存，最后执行冒烟探测。
 * 在 updateProvidersLocked 准备激活候选版本前调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {object} state 当前托管状态对象（State 实例）。
 * @param {string} provider 供应商名称。
 * @param {object} candidate 候选版本发布对象（release 实例）。
 * @returns {Promise<Installation>} 通过冒烟探测的 Installation 记录；安装、保存或验证失败时抛出错误。
 */
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
    // 先把已下载安装的候选缓存到 state.json 再做探测，避免探测失败触发重复下载；此处不改动 Current。
    state.Candidates[provider] = installed;
    this.save(state);
  }
  await this.validate(ctx, provider, installed);
  return installed;
};

/**
 * 在持有更新锁的情况下执行单供应商回滚：验证 Previous 版本可用后交换 Current/Previous、记录 Rejected 并激活。
 * 由 run 在 action === "rollback" 时调用。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {string} provider 目标供应商名称。
 * @param {object} state 当前托管状态对象（State 实例）。
 * @param {Report} report 本次回滚报告对象（方法内会写入 Results[0]）。
 * @returns {Promise<void>} 无返回值；供应商未知、无上一版本、探测失败或激活失败时抛出错误。
 */
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

/**
 * 在维护锁（WithMaintenance）保护及 maintenanceTimeout 超时限制内，校验并原子落盘新的 state.json。
 * 调用方全程持有 updater.lock，无需二次重读状态文件。
 *
 * @param {AbortSignal|null} ctx 上层取消信号。
 * @param {object} state 待发布的托管状态对象（State 实例）。
 * @returns {Promise<void>} 无返回值；超时、取消、清单校验或写盘失败时抛出错误。
 */
Manager.prototype.activate = async function (ctx, state) {
  const signals = [];
  if (ctx instanceof AbortSignal) {
    signals.push(ctx);
  }
  signals.push(AbortSignal.timeout(maintenanceTimeout));
  const timeoutCtx = AbortSignal.any(signals); // 对应 Go：context.WithTimeout(ctx, maintenanceTimeout)
  await WithMaintenance(timeoutCtx, this.Root, async () => {
    validateInventory(this.Root, state.Current);
    state.UpdatedAt = this.Now();
    if (timeoutCtx.aborted) {
      throw timeoutCtx.reason; // 对应 Go：ctx.Err()
    }
    this.save(state);
  });
};

/**
 * 将托管状态原子写入根目录下的 state.json。
 * 在记录日检时间、缓存候选安装、更新观察列表或维护窗口发布新状态时调用。
 *
 * @param {object} state 待持久化的托管状态对象（State 实例）。
 * @returns {void} 无返回值；写入失败时抛出错误。
 */
Manager.prototype.save = function (state) {
  atomicJSON(path.join(this.Root, "state.json"), state);
};

/**
 * 将 Date 转换为北京时间（UTC+08）下的 YYYY-MM-DD 日期字符串，对应 Go 的 t.In(beijing).Format("2006-01-02")。
 * 在 run 判断当日是否已执行过日检时调用；空值或零值时间返回空字符串 ""，保证比较时小于任意有效日期。
 *
 * @param {Date|null} t 待格式化的时间对象。
 * @returns {string} 北京时间日期字符串 "YYYY-MM-DD" 或空字符串 ""。
 */
function beijingDateString(t) {
  if (t == null || t.getTime() === 0 || t.getTime() === goZeroTimeMs) {
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
