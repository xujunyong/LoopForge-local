/**
 * @file internal/repo/analytics.js
 * 对应 Go 源文件：internal/repo/analytics.go
 *
 * 作用与职责边界：
 * 提供平台只读运营分析核心视图的聚合逻辑，负责拉取并整合平台运行、外部洞察运行、
 * 需求、工作流/智能体/执行器定义、工具与人工干预信号、观测覆盖度与 MR 合并记录，
 * 输出包含总览指标、趋势、星期×小时热力图、多维拆解、版本对比、用户/项目用量、追踪列表与交付汇总的完整快照。
 *
 * 语法差异说明：
 * - `AnalyticsRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `AnalyticsRepo.prototype` 挂载其分析方法并保留导出兼容。
 * - Go 的 `defer applyAnalyticsCNY(&out)` 在 JS 中通过 `try { ... } finally { applyAnalyticsCNY(out); }` 1:1 表达。
 * - Go 的 `time.Time` 对应 `Date`（零值为 `null`），通过 `isZeroTime`/`timeMs`/`timeBefore`/`timeAfter`/`timeEqual` 保持与 Go 零值时间的比较一致。
 * - Go 的 `(值, error)` 与 `(值1, 值2, error)` 在成功时返回值或二元组、失败时抛出错误；`(值, bool)` 或 `(string, string)` 译为二元组。
 * - Go 的整数除法使用 `Math.trunc(...)` 保持向零截断语义；`map[string]V` 与 `map[string]struct{}` 统一使用普通对象 `{}`。
 * - 与 `analytics_pricing.js`、`analytics_insights.js` 存在同包循环引用，调用处采用函数内延迟 `require`。
 */

"use strict";

const { AnalyticsBreakdown, AnalyticsWorkflowVersion, AnalyticsUserUsage, AnalyticsProjectUsage, AnalyticsFailure, AnalyticsSummary, AnalyticsCoverage, AnalyticsSnapshot, AnalyticsTrendPoint, AnalyticsRunTrace, AnalyticsWeekHourCell } = require("../domain/analytics.js"); // 对应 Go 的 domain.Analytics*，domain 已翻译
const { WorkflowDefinition, WorkflowNode } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition/WorkflowNode，domain 已翻译
const { ExecutorDefinition } = require("../domain/agent.js"); // 对应 Go 的 domain.ExecutorDefinition，domain 已翻译
const { Issue } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue，domain 已翻译
const { RunProjectID } = require("../domain/catalog.js"); // 对应 Go 的 domain.RunProjectID，domain 已翻译
const { IsRequirementWorkItem } = require("../domain/sop_lane.js"); // 对应 Go 的 domain.IsRequirementWorkItem，domain 已翻译
const { SummarizeDeliveries } = require("../domain/mr.js"); // 对应 Go 的 domain.SummarizeDeliveries，domain 已翻译
require("../domain/delivery_mr.js"); // Issue.prototype.DeliveryMRList 的原型方法，domain 已翻译
const { AnalyticsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { parallel, runDuration, runExecutionDuration, runWaitDuration, runEndedAt, runArtifactCount, queryAnalyticsWorkflowSnapshots } = require("./runs.js"); // 对应 Go 同包函数，runs.js 待翻译
const { countDeliveryGroups } = require("./delivery.js"); // 对应 Go 同包函数，delivery.js 待翻译

/**
 * 延迟调用 `analytics_pricing.js` 中的 `applyAnalyticsCNY`，避免同包循环引用。
 * 在 `analyticsWithRuns` 返回前将分析快照中的美元金额按汇率换算并写入人民币字段。
 *
 * @param {AnalyticsSnapshot} out - 待回填人民币成本字段的分析快照对象。
 * @returns {void} 无返回值。
 */
function applyAnalyticsCNY(out) {
  require("./analytics_pricing.js").applyAnalyticsCNY(out);
}

/**
 * 延迟调用 `analytics_pricing.js` 中的 `analyticsPricedRun`，避免同包循环引用。
 * 在分析聚合前对单条平台运行按模型价目表重算分析用成本。
 *
 * @param {import("../domain/run.js").Run} run - 待重定价的运行记录。
 * @returns {import("../domain/run.js").Run} 更新分析成本后的运行记录。
 */
function analyticsPricedRun(run) {
  return require("./analytics_pricing.js").analyticsPricedRun(run);
}

/**
 * 延迟调用 `analytics_insights.js` 中的 `accumulateInsightModels`，避免同包循环引用。
 * 将外部洞察执行记录中的模型用量累加到模型维度拆解表中。
 *
 * @param {Object<string, analyticsAccumulator>} models - 按模型名索引的维度累加器映射。
 * @param {import("../domain/insights.js").InsightExecution} execution - 外部洞察执行记录。
 * @returns {void} 无返回值。
 */
function accumulateInsightModels(models, execution) {
  require("./analytics_insights.js").accumulateInsightModels(models, execution);
}

/**
 * 判断时间对象是否为 Go 语境下的零值时间（即 `null` 或 `undefined`）。
 * 用于对照 Go 的 `t.IsZero()`。
 *
 * @param {Date|null|undefined} t - 待检查的时间对象。
 * @returns {boolean} 为零值时返回 `true`，否则返回 `false`。
 */
function isZeroTime(t) {
  return t == null;
}

/**
 * 将 `Date` 或零值时间换算为与 Go `time.Time` 一致的毫秒时间戳（零值对应公元 0001-01-01 UTC）。
 * 用于时间先后比较与差值计算。
 *
 * @param {Date|null|undefined} t - 待转换的时间对象。
 * @returns {number} 毫秒时间戳。
 */
function timeMs(t) {
  return t == null ? -62135596800000 : t.getTime();
}

/**
 * 判断时间 `a` 是否严格早于时间 `b`（对应 Go 的 `a.Before(b)`）。
 *
 * @param {Date|null|undefined} a - 左侧时间。
 * @param {Date|null|undefined} b - 右侧时间。
 * @returns {boolean} `a` 早于 `b` 时返回 `true`，否则返回 `false`。
 */
function timeBefore(a, b) {
  return timeMs(a) < timeMs(b);
}

/**
 * 判断时间 `a` 是否严格晚于时间 `b`（对应 Go 的 `a.After(b)`）。
 *
 * @param {Date|null|undefined} a - 左侧时间。
 * @param {Date|null|undefined} b - 右侧时间。
 * @returns {boolean} `a` 晚于 `b` 时返回 `true`，否则返回 `false`。
 */
function timeAfter(a, b) {
  return timeMs(a) > timeMs(b);
}

/**
 * 判断时间 `a` 与时间 `b` 是否表示同一时刻（对应 Go 的 `a.Equal(b)`）。
 *
 * @param {Date|null|undefined} a - 左侧时间。
 * @param {Date|null|undefined} b - 右侧时间。
 * @returns {boolean} 两者相等时返回 `true`，否则返回 `false`。
 */
function timeEqual(a, b) {
  return timeMs(a) === timeMs(b);
}

/**
 * 构造表示 Go 零值时间（公元 0001-01-01 00:00:00 UTC）的 `Date` 实例。
 * 用于在零值时间参与格式化或时区平移时保持与 Go 输出一致。
 *
 * @returns {Date} 公元 1 年 1 月 1 日零点 UTC 对应的 `Date` 实例。
 */
function zeroTimeDate() {
  const d = new Date(0);
  d.setUTCFullYear(1, 0, 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * 按 UTC 将时间格式化为 `YYYY-MM-DD` 日期字符串（对应 Go 的 `t.Format("2006-01-02")`）。
 * 零值时间格式化为 `"0001-01-01"`。
 *
 * @param {Date|null|undefined} t - 待格式化的时间对象。
 * @returns {string} `YYYY-MM-DD` 格式日期字符串。
 */
function formatDayUTC(t) {
  if (t == null) {
    return "0001-01-01";
  }
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * 按 UTC 将时间格式化为 `YYYY-MM` 月份字符串（对应 Go 的 `t.Format("2006-01")`）。
 * 零值时间格式化为 `"0001-01"`。
 *
 * @param {Date|null|undefined} t - 待格式化的时间对象。
 * @returns {string} `YYYY-MM` 格式月份字符串。
 */
function formatMonthUTC(t) {
  if (t == null) {
    return "0001-01";
  }
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  return `${t.getUTCFullYear()}-${mm}`;
}

/**
 * 计算给定 UTC 时间对应的 ISO-8601 周年与周序号（对应 Go 的 `t.ISOWeek()`）。
 * 在按周粒度聚合趋势分桶时调用。
 *
 * @param {Date} d - 待计算周序号的时间对象（按 UTC 字段取值）。
 * @returns {[number, number]} 二元组 `[ISO 年份, ISO 周序号]`。
 */
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return [year, week];
}

/**
 * 校验并加载 IANA 时区描述对象（对应 Go 的 `time.LoadLocation`）。
 * 空名称返回 UTC，`"Local"` 返回本地时区标记，无效时区名称由 `Intl.DateTimeFormat` 抛出错误。
 *
 * @param {string|null|undefined} name - IANA 时区名称（如 `"Asia/Shanghai"`）、`"Local"` 或空字符串。
 * @returns {{name: string, offsetMs?: number}} 时区描述对象。
 */
function loadTimeLocation(name) {
  if (name == null || name === "") {
    return { name: "UTC" };
  }
  if (name === "Local") {
    return { name: "Local" };
  }
  new Intl.DateTimeFormat("en-US", { timeZone: name });
  return { name };
}

/**
 * 将时间戳转换到目标时区，并返回一个 UTC 墙钟字段等于目标时区本地墙钟字段的 `Date`（对应 Go 的 `t.In(loc)`）。
 * 便于调用方统一用 `getUTC*` 方法读取目标时区的年月日、星期与小时；零值时间返回零值日期。
 *
 * @param {Date|null|undefined} date - 原始时间点。
 * @param {{name: string, offsetMs?: number}|null|undefined} loc - 由 `loadTimeLocation` 或固定偏移构造的时区描述对象。
 * @returns {Date} 墙钟字段已平移到目标时区的 `Date` 实例。
 */
function inLocation(date, loc) {
  if (date == null) {
    return zeroTimeDate();
  }
  if (loc == null || loc.name === "UTC") {
    return new Date(date.getTime());
  }
  if (loc.offsetMs != null) {
    return new Date(date.getTime() + loc.offsetMs);
  }
  if (loc.name === "Local") {
    return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()));
  }
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: loc.name, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"), date.getMilliseconds()));
}

/**
 * 多维拆解项累加器（用于工作流、分类、需求来源、模型、节点、智能体、执行器等维度）。
 * 暂存耗时样本切片、Token 四分项、节点重试/返工与唯一需求集合，汇总阶段由 `finalizeBreakdowns` 转为最终拆解项。
 */
class analyticsAccumulator {
  /**
   * 构造多维拆解项累加器实例，未提供字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {AnalyticsBreakdown} [init.item] - 对应的输出拆解项。
   * @param {number[]} [init.durations=[]] - 墙钟耗时样本列表（毫秒）。
   * @param {number} [init.duration=0] - 墙钟耗时累计和（毫秒）。
   * @param {number[]} [init.execDurations=[]] - 执行耗时样本列表（毫秒）。
   * @param {number} [init.execDuration=0] - 执行耗时累计和（毫秒）。
   * @param {number} [init.inputTokens=0] - 输入 Token 累计值。
   * @param {number} [init.outputTokens=0] - 输出 Token 累计值。
   * @param {number} [init.cacheReadTokens=0] - 缓存读取 Token 累计值。
   * @param {number} [init.cacheWriteTokens=0] - 缓存写入 Token 累计值。
   * @param {number} [init.toolCalls=0] - 工具调用次数累计值。
   * @param {number} [init.nodeRuns=0] - 节点执行次数累计值。
   * @param {number} [init.retriedNodes=0] - 发生重试的节点次数。
   * @param {number} [init.reworkNodes=0] - 发生返工的节点次数。
   * @param {Object<string, number>} [init.models={}] - 模型调用次数分布映射。
   * @param {Object<string, number>} [init.nodeTypes={}] - 工作流节点类型分布映射。
   * @param {number} [init.nodeCount=0] - 工作流定义的节点总数。
   * @param {Object<string, boolean>} [init.issueIDs={}] - 成功覆盖的唯一需求 ID 集合。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.item = init.item ?? new AnalyticsBreakdown();
    this.durations = init.durations ?? [];
    this.duration = init.duration ?? 0;
    this.execDurations = init.execDurations ?? [];
    this.execDuration = init.execDuration ?? 0;
    this.inputTokens = init.inputTokens ?? 0;
    this.outputTokens = init.outputTokens ?? 0;
    this.cacheReadTokens = init.cacheReadTokens ?? 0;
    this.cacheWriteTokens = init.cacheWriteTokens ?? 0;
    this.toolCalls = init.toolCalls ?? 0;
    this.nodeRuns = init.nodeRuns ?? 0;
    this.retriedNodes = init.retriedNodes ?? 0;
    this.reworkNodes = init.reworkNodes ?? 0;
    this.models = init.models ?? {};
    this.nodeTypes = init.nodeTypes ?? {};
    this.nodeCount = init.nodeCount ?? 0;
    this.issueIDs = init.issueIDs ?? {};
  }
}

/**
 * 工作流版本维度累加器，暂存单个 SOP 版本的墙钟与执行耗时样本。
 */
class analyticsVersionAccumulator {
  /**
   * 构造工作流版本累加器实例，未提供字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {AnalyticsWorkflowVersion} [init.item] - 对应的工作流版本统计项。
   * @param {number[]} [init.durations=[]] - 墙钟耗时样本列表（毫秒）。
   * @param {number} [init.duration=0] - 墙钟耗时累计和（毫秒）。
   * @param {number[]} [init.execDurations=[]] - 执行耗时样本列表（毫秒）。
   * @param {number} [init.execDuration=0] - 执行耗时累计和（毫秒）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.item = init.item ?? new AnalyticsWorkflowVersion();
    this.durations = init.durations ?? [];
    this.duration = init.duration ?? 0;
    this.execDurations = init.execDurations ?? [];
    this.execDuration = init.execDuration ?? 0;
  }
}

/**
 * 用户按日用量累加器包装结构。
 */
class analyticsUserAccumulator {
  /**
   * 构造用户按日用量累加器实例，未提供字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {AnalyticsUserUsage} [init.item] - 对应的用户每日用量项。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.item = init.item ?? new AnalyticsUserUsage();
  }
}

/**
 * 项目用量累加器，记录项目运行汇总与覆盖的唯一需求集合。
 */
class analyticsProjectAccumulator {
  /**
   * 构造项目用量累加器实例，未提供字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {AnalyticsProjectUsage} [init.item] - 对应的项目用量统计项。
   * @param {Object<string, boolean>} [init.issues={}] - 该项目覆盖的唯一需求 ID 集合。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.item = init.item ?? new AnalyticsProjectUsage();
    this.issues = init.issues ?? {};
  }
}

/**
 * 单条运行的工具调用成败与人工干预信号计数结构。
 */
class analyticsRunSignals {
  /**
   * 构造运行信号计数实例，未提供字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {number} [init.toolSucceeded=0] - 观测到的成功工具调用次数。
   * @param {number} [init.toolFailed=0] - 观测到的失败工具调用次数。
   * @param {number} [init.interventions=0] - 显式人工决策干预次数。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.toolSucceeded = init.toolSucceeded ?? 0;
    this.toolFailed = init.toolFailed ?? 0;
    this.interventions = init.interventions ?? 0;
  }
}

/**
 * 返回跨运行的只读、厂商中立的平台运营分析快照。
 * 作为对外运营分析查询入口调用，内部委托给 `analyticsWithRuns(filter, null)` 执行自行取数路径。
 *
 * @param {import("../domain/analytics.js").AnalyticsFilter} filter - 分析查询筛选条件。
 * @returns {AnalyticsSnapshot} 完整或概览级别的运营分析快照。
 */
AnalyticsRepo.prototype.Analytics = function (filter) {
  return this.analyticsWithRuns(filter, null);
};

/**
 * 基于筛选条件（及可选预取运行列表）计算运营分析快照。
 * 供 `Analytics` 与 `BusinessDomainReport` 共用；传入 `prefetched` 时覆盖 `filter.ProjectIDs` 且不预先裁剪时间窗，
 * 时间窗仍由本方法按同一谓词在内存中过滤，确保与自行查询结果完全一致；传 `null` 保持原有自查询行为。
 *
 * @param {import("../domain/analytics.js").AnalyticsFilter} filter - 分析查询筛选条件。
 * @param {import("../domain/run.js").Run[]|null} prefetched - 可选预取的全量运行摘要列表；为 `null` 时由内部查询。
 * @returns {AnalyticsSnapshot} 包含总览、活跃度、趋势、热力图、多维拆解、交付汇总与人民币成本的快照。
 */
AnalyticsRepo.prototype.analyticsWithRuns = function (filter, prefetched) {
  const overview = filter.Scope === "overview";
  const now = new Date();
  const out = new AnalyticsSnapshot({
    Filter: filter,
    Summary: new AnalyticsSummary({ GeneratedAt: now }),
    Coverage: new AnalyticsCoverage({ AdapterEvents: {}, LogLevels: {} }),
  });
  try {
    const trends = {};
    const trendIssues = {};
    const weekHourZone = analyticsWeekHourLocation(filter.TimeZone);
    const weekHour = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => new AnalyticsWeekHourCell()));
    const workflows = {};
    const agents = {};
    const executors = {};
    const models = {};
    const nodes = {};
    const categories = {};
    const sources = {};
    const versions = {};
    const users = {};
    const projects = {};
    const failures = {};
    let terminalDurations = [];
    let terminalExecDurations = [];
    let terminalDuration = 0;
    let terminalExecDuration = 0;
    let terminalWaitDuration = 0;
    let terminal = 0;
    let firstPassSucceeded = 0;
    // 需求维度：每个需求的执行次数/失败次数/节点求和耗时。
    const issueRuns = {};
    const issueFailures = {};
    const issueExec = {};
    // 成本识别与缓存命中率的累计基数。
    let costKnownRuns = 0;
    let cacheReadTotal = 0;
    let cacheDenominator = 0;
    let includedRunIDs = [];
    const runTraceIndex = {};
    let agentList = [];
    let executorList = [];
    let workflowList = [];
    let issueList = [];
    let runList = [];
    if (overview) {
      // 概览用轻量需求列 + 当前 SOP 目录，避免拉全量 payload / 每条 Run 的冻结快照。
      parallel(
        () => {
          try {
            runList = this.runs.RunSummariesFor(filter, "") ?? [];
          } catch {
            runList = [];
          }
        },
        () => { issueList = this.issues.IssueAnalyticsViews(); },
        () => { workflowList = this.catalog.Workflows(); },
      );
    } else {
      parallel(
        () => { agentList = this.catalog.Agents(); },
        () => { executorList = this.catalog.Executors(); },
        () => { workflowList = this.catalog.Workflows(); },
        () => { issueList = this.issues.Issues(); },
        () => {
          if (prefetched != null) {
            // 下方会就地重定价并回填工作流快照，先浅拷贝列表避免修改多份报表共享的预取切片。
            runList = [...prefetched];
            return;
          }
          try {
            runList = this.runs.RunSummariesFor(filter, "") ?? [];
          } catch {
            runList = [];
          }
        },
      );
    }

    const agentDefs = {};
    for (const agent of agentList) {
      agentDefs[agent.ID] = agent;
    }
    const executorDefs = {};
    for (const executor of executorList) {
      executorDefs[executor.ID] = executor;
    }
    const workflowDefs = {};
    for (const workflow of workflowList) {
      workflowDefs[workflow.ID] = workflow;
    }
    const issuesByID = {};
    for (const issue of issueList) {
      issuesByID[issue.ID] = issue;
    }
    // RunSummaries 在 MySQL 列表路径上有意省略工作流快照；
    // 完整扫描需要冻结的名称/版本/分类/节点绑定，而概览模式直接使用实时目录避免逐条回水。
    if (this.DB != null && !overview) {
      const runIDs = [];
      for (const run of runList) {
        if (filter.WorkflowID !== "" && run.WorkflowID !== filter.WorkflowID) {
          continue;
        }
        if (!analyticsRunInWindow(run, filter) || (filter.UserID !== "" && !analyticsRunMatchesUser(run, filter.UserID, issuesByID[run.ExecutionContext.IssueID.trim()] ?? new Issue()))) {
          continue;
        }
        const issueID = run.ExecutionContext.IssueID.trim();
        if (filter.IssueSource !== "" && !analyticsIssueMatchesSource(issuesByID[issueID] ?? new Issue(), filter.IssueSource)) {
          continue;
        }
        if (filter.RequirementsOnly && !analyticsIsRequirementIssue(issuesByID[issueID] ?? new Issue())) {
          continue;
        }
        runIDs.push(run.ID);
      }
      let snapshots = null;
      try {
        snapshots = queryAnalyticsWorkflowSnapshots(this.DB, runIDs);
      } catch {
        snapshots = null;
      }
      if (snapshots != null) {
        for (let i = 0; i < runList.length; i++) {
          const snapshot = snapshots[runList[i].ID];
          if (snapshot != null) {
            runList[i].WorkflowSnapshot = snapshot;
          }
        }
      }
    }

    for (let i = 0; i < runList.length; i++) {
      runList[i] = analyticsPricedRun(runList[i]);
    }
    let platformRuns = runList;
    try {
      this.analyticsActivity(filter, issueList, platformRuns, out);
    } catch {
      out.DataErrors = ["会话统计读取失败"];
      return out;
    }
    if (filter.Origin === "external") {
      runList = null;
      platformRuns = null;
      issueList = null;
    }
    let externalRuns;
    let externalMetadata;
    try {
      [externalRuns, externalMetadata] = this.analyticsInsightRuns(filter);
    } catch {
      out.DataErrors = ["外部用量读取失败"];
      return out;
    }
    runList = [...(runList ?? []), ...(externalRuns ?? [])];
    let qualityTerminal = 0;
    let executionMeasured = 0;
    const conversationIssues = {};
    const conversationTrendIssues = {};

    for (const run of runList) {
      const external = externalMetadata[run.ID] ?? null;
      const isExternal = external != null;
      if (filter.WorkflowID !== "" && run.WorkflowID !== filter.WorkflowID) {
        continue;
      }
      if (!isExternal && !analyticsRunInWindow(run, filter)) {
        continue;
      }
      const issueID = run.ExecutionContext.IssueID.trim();
      if (filter.UserID !== "" && !analyticsRunMatchesUser(run, filter.UserID, issuesByID[issueID] ?? new Issue())) {
        continue;
      }
      if (filter.IssueSource !== "" && !analyticsIssueMatchesSource(issuesByID[issueID] ?? new Issue(), filter.IssueSource)) {
        continue;
      }
      if (filter.RequirementsOnly && !analyticsIsRequirementIssue(issuesByID[issueID] ?? new Issue())) {
        continue;
      }
      if (!isExternal && run.IsWorkspace()) {
        accumulateConversationRun(out.Summary, conversationIssues, trends, conversationTrendIssues, users, projects, sources, run, issuesByID[issueID] ?? new Issue(), filter.Grain);
        continue;
      }
      if (!isExternal) {
        includedRunIDs.push(run.ID);
        out.Summary.QualityRuns++;
        out.Demo.CoveredRuns++;
      } else {
        out.Summary.ExternalRuns++;
      }

      out.Summary.TotalRuns++;
      out.Summary.TotalTokens += run.Usage.TotalTokens;
      out.Summary.TotalCostUSD += run.Usage.CostUSD;
      out.Summary.InputTokens += run.Usage.InputTokens;
      out.Summary.OutputTokens += run.Usage.OutputTokens;
      out.Summary.CacheReadTokens += run.Usage.CacheReadTokens;
      out.Summary.CacheWriteTokens += run.Usage.CacheWriteTokens;
      out.Summary.ReasoningTokens += run.Usage.ReasoningTokens;
      cacheReadTotal += run.Usage.CacheReadTokens;
      cacheDenominator += run.Usage.InputTokens;
      if (!isExternal) {
        cacheDenominator += run.Usage.CacheReadTokens;
      }
      out.Summary.CostReportedUSD += run.Usage.CostUSD;
      if (usageCostKnown(run.Usage)) {
        costKnownRuns++;
      } else {
        out.Summary.CostUnknownRuns++;
      }
      out.Summary.ToolCalls += run.ToolCalls;
      out.Summary.Artifacts += runArtifactCount(run);
      out.Summary.TelemetryEvents += run.TelemetrySequence;
      if ((run.Telemetry ?? []).length > run.TelemetrySequence) {
        out.Summary.TelemetryEvents += (run.Telemetry ?? []).length - run.TelemetrySequence;
      }
      out.Summary.LogRecords += run.LogSequence;
      if ((run.Logs ?? []).length > run.LogSequence) {
        out.Summary.LogRecords += (run.Logs ?? []).length - run.LogSequence;
      }
      if (run.TelemetrySequence > 0 || (run.Telemetry ?? []).length > 0) {
        out.Coverage.RunsWithTelemetry++;
      }
      if (run.LogSequence > 0 || (run.Logs ?? []).length > 0) {
        out.Coverage.RunsWithLogs++;
      }

      const reworks = runReworks(run);
      out.Summary.TotalReworks += reworks;
      if (reworks > 0) {
        out.Summary.ReworkedRuns++;
      }
      let [duration, complete] = analyticsRunDuration(run, now);
      // 执行耗时为 SOP 节点耗时之和，不含审批/排队/恢复等待。
      let execDuration = runExecutionDuration(run);
      const execKnown = !isExternal || external.execution.ExecutionDurationMs != null;
      if (isExternal) {
        duration = timeMs(external.execution.FinishedAt) - timeMs(external.execution.StartedAt);
        if (execKnown) {
          execDuration = external.execution.ExecutionDurationMs;
        }
      }
      if (complete) {
        terminal++;
        terminalDuration += duration;
        terminalDurations.push(duration);
        if (execKnown) {
          executionMeasured++;
          terminalExecDuration += execDuration;
          terminalExecDurations.push(execDuration);
        }
        if (!isExternal) {
          qualityTerminal++;
          terminalWaitDuration += runWaitDuration(run, now);
        }
      }
      switch (run.Status) {
        case "running":
          out.Summary.ActiveRuns++;
          break;
        case "waiting":
          out.Summary.WaitingRuns++;
          break;
        case "succeeded":
          out.Summary.SucceededRuns++;
          if (!isExternal) {
            out.Demo.CoveredSucceededRuns++;
          }
          if (!isExternal && reworks === 0) {
            firstPassSucceeded++;
          }
          break;
        case "failed":
          out.Summary.FailedRuns++;
          if (issueID !== "") {
            issueFailures[issueID] = (issueFailures[issueID] ?? 0) + 1;
          }
          break;
        case "cancelled":
          out.Summary.CancelledRuns++;
          break;
        default:
          break;
      }
      const issue = issuesByID[issueID] ?? new Issue();
      let traceID = run.ExecutionContext.TraceID.trim();
      if (traceID === "") {
        traceID = run.ID;
      }
      const projectID = RunProjectID(run, issue.ProjectID);
      const [errorNodeID, errorMessage] = analyticsRunError(run);
      const trace = new AnalyticsRunTrace({
        ProjectID: projectID, IssueID: issueID, IssueSource: analyticsIssueSource(issue), WorkflowTaskID: run.ExecutionContext.TaskID,
        RunID: run.ID, TraceID: traceID, Status: run.Status, DurationMs: duration,
        Tokens: run.Usage.TotalTokens, CostUSD: run.Usage.CostUSD, CostKnown: usageCostKnown(run.Usage),
        ToolCalls: run.ToolCalls, ErrorNodeID: errorNodeID, ErrorMessage: errorMessage,
        CreatedAt: run.CreatedAt,
      });
      const tapdID = issue.RequirementTAPDID();
      if (tapdID !== "") {
        trace.ExternalID = tapdID;
      }
      if (issue.ExternalRef != null) {
        trace.ExternalURL = issue.ExternalRef.ExternalURL;
      }
      if (complete) {
        trace.FinishedAt = runEndedAt(run, now);
      }
      if (isExternal) {
        trace.ExecutionDurationMs = external.execution.ExecutionDurationMs;
        trace.Origin = "external";
        trace.SourceID = external.sourceID;
        trace.WorkflowName = external.execution.Workflow.Name;
        trace.ExternalID = external.execution.ExternalExecutionID;
        trace.ExternalURL = external.execution.URL;
        trace.IssueSource = "";
        trace.FinishedAt = external.execution.FinishedAt;
      }
      runTraceIndex[run.ID] = out.RunTraces.length;
      out.RunTraces.push(trace);
      if (issueID !== "") {
        issueRuns[issueID] = (issueRuns[issueID] ?? 0) + 1;
        issueExec[issueID] = (issueExec[issueID] ?? 0) + execDuration;
        accumulateIssueSource(sources, analyticsIssueSource(issuesByID[issueID] ?? new Issue()), run, execDuration);
      }

      let workflow = run.WorkflowSnapshot;
      if (workflow.ID === "") {
        workflow = workflowDefs[run.WorkflowID] ?? new WorkflowDefinition();
      }
      let workflowName = workflow.Name;
      if (workflowName === "") {
        workflowName = run.WorkflowID;
      }
      const category = analyticsWorkflowCategory(workflow, workflowDefs[run.WorkflowID] ?? new WorkflowDefinition());
      accumulateBreakdown(workflows, run.WorkflowID, workflowName, run, reworks, duration, complete, execDuration);
      const workflowAcc = workflows[run.WorkflowID];
      if (workflowAcc != null) {
        workflowAcc.item.Category = category;
        workflowAcc.nodeCount = (workflow.Nodes ?? []).length;
        workflowAcc.nodeTypes = analyticsNodeTypes(workflow.Nodes);
      }
      if (!isExternal) {
        accumulateVersion(versions, run.WorkflowID, workflowName, workflow.Version, (workflowDefs[run.WorkflowID] ?? new WorkflowDefinition()).Version, run, duration, complete, execDuration);
        accumulateBreakdown(categories, category, "", run, reworks, duration, complete, execDuration);
        const categoryAcc = categories[category];
        if (categoryAcc != null && issueID !== "") {
          if (categoryAcc.issueIDs == null) {
            categoryAcc.issueIDs = {};
          }
          if (run.Status === "succeeded") {
            categoryAcc.issueIDs[issueID] = true;
          }
        }
      } else {
        const acc = workflows[run.WorkflowID];
        acc.item.QualityUnknownRuns++;
        if (!execKnown) {
          acc.execDurations = acc.execDurations.slice(0, acc.execDurations.length - 1);
        }
      }
      // 趋势与每用户每日用量在概览态同样输出，节点级拆解仍只在完整扫描时计算。
      let eventAt = run.CreatedAt;
      if (complete) {
        eventAt = runEndedAt(run, now);
      }
      if (isExternal) {
        eventAt = external.execution.FinishedAt;
      }
      const day = formatDayUTC(eventAt);
      const bucket = analyticsTrendBucket(eventAt, filter.Grain);
      const point = analyticsTrendEntry(trends, bucket);
      point.Runs++;
      if (!usageCostKnown(run.Usage)) {
        point.CostUnknownRuns++;
      }
      point.Reworks += reworks;
      point.Tokens += run.Usage.TotalTokens;
      point.CostUSD += run.Usage.CostUSD;
      point.InputTokens += run.Usage.InputTokens;
      point.OutputTokens += run.Usage.OutputTokens;
      point.CacheReadTokens += run.Usage.CacheReadTokens;
      point.CacheWriteTokens += run.Usage.CacheWriteTokens;
      point.ExecutionDurationMs += execDuration;
      if (complete) {
        point.DurationMs += duration;
      }
      if (run.Status === "succeeded") {
        point.Succeeded++;
      }
      if (run.Status === "failed") {
        point.Failed++;
      }
      const local = inLocation(eventAt, weekHourZone);
      const cell = weekHour[(local.getUTCDay() + 6) % 7][local.getUTCHours()];
      cell.Runs++;
      cell.Tokens += run.Usage.TotalTokens;
      cell.CostUSD += run.Usage.CostUSD;
      addAnalyticsTrendIssue(trendIssues, bucket, issueID);
      accumulateUserUsage(users, analyticsRunUserID(run, issuesByID[issueID] ?? new Issue()), day, run, duration, complete, execDuration);
      accumulateProjectUsage(projects, RunProjectID(run, (issuesByID[issueID] ?? new Issue()).ProjectID), issueID, run);
      if (isExternal) {
        accumulateInsightModels(models, external.execution);
        continue;
      }
      const definition = {};
      for (const node of workflow.Nodes ?? []) {
        definition[node.ID] = node;
      }
      for (const [nodeID, nodeRun] of Object.entries(run.Nodes ?? {})) {
        if (nodeRun == null) {
          continue;
        }
        const node = definition[nodeID] ?? new WorkflowNode();
        let nodeDuration = 0;
        const nodeComplete = !isZeroTime(nodeRun.StartedAt) && !isZeroTime(nodeRun.FinishedAt);
        if (nodeComplete) {
          nodeDuration = nodeRun.FinishedAt.getTime() - nodeRun.StartedAt.getTime();
        }
        const key = run.WorkflowID + "/" + nodeID;
        let name = node.Name;
        if (name === "") {
          name = nodeID;
        }
        accumulateNode(nodes, key, name, nodeRun, nodeDuration, nodeComplete);
        let model = nodeRun.Model;
        if (model === "" && node.ExecutorID !== "") {
          model = (executorDefs[node.ExecutorID] ?? new ExecutorDefinition()).Model;
        }
        if (model !== "") {
          accumulateNode(models, model, model, nodeRun, nodeDuration, nodeComplete);
        }
        if (nodeRun.Error !== "") {
          const code = normalizeFailure(nodeRun.Error);
          const failureKey = nodeID + "\x00" + code;
          if (failures[failureKey] == null) {
            failures[failureKey] = new AnalyticsFailure({ Code: code, NodeID: nodeID });
          }
          failures[failureKey].Count++;
        }
        if (!overview) {
          if (node.AgentID !== "") {
            accumulateNode(agents, node.AgentID, agentName(agentDefs, node.AgentID), nodeRun, nodeDuration, nodeComplete);
          }
          if (node.ExecutorID !== "") {
            accumulateNode(executors, node.ExecutorID, executorName(executorDefs, node.ExecutorID), nodeRun, nodeDuration, nodeComplete);
          }
        }
      }
    }

    // 工具结果与人工决策事件保存在只追加的事件表中，不在运行摘要列上；
    // 仅查询匹配的工具结束遥测与轻量控制事件，再回填至每条可审计的运行追踪行。
    const signals = this.analyticsRunSignals(includedRunIDs);
    for (const [runID, signal] of Object.entries(signals)) {
      const index = runTraceIndex[runID];
      if (index == null) {
        continue;
      }
      const trace = out.RunTraces[index];
      trace.ToolCallsSucceeded = signal.toolSucceeded;
      trace.ToolCallsFailed = signal.toolFailed;
      trace.HumanInterventions = signal.interventions;
      out.Demo.ToolCallsSucceeded += signal.toolSucceeded;
      out.Demo.ToolCallsFailed += signal.toolFailed;
      out.Demo.HumanInterventions += signal.interventions;
    }
    out.Demo.ToolCallsObserved = out.Demo.ToolCallsSucceeded + out.Demo.ToolCallsFailed;
    if (out.Demo.ToolCallsObserved > 0) {
      out.Demo.ToolSuccessRate = (out.Demo.ToolCallsSucceeded * 100) / out.Demo.ToolCallsObserved;
    }
    for (const trace of out.RunTraces) {
      if (trace.Origin !== "external" && trace.Status === "succeeded" && trace.HumanInterventions === 0) {
        out.Demo.AutomatedSucceededRuns++;
      }
    }
    out.Summary.ConversationIssues = Object.keys(conversationIssues).length;
    for (const id of Object.keys(conversationIssues)) {
      const issue = issuesByID[id] ?? new Issue();
      if ((issue.DeliveryMRList() ?? []).length > 0) {
        out.Summary.ConversationIssuesWithMR++;
      }
      if (issue.DeliveryState === "merged") {
        out.Summary.ConversationIssuesDelivered++;
      }
    }
    if (out.Summary.TotalRuns > 0) {
      out.Demo.AverageTokensPerRun = (out.Summary.TotalTokens - out.Summary.ConversationTokens) / out.Summary.TotalRuns;
      if (out.Demo.CoveredRuns > 0) {
        out.Demo.AverageHumanInterventions = out.Demo.HumanInterventions / out.Demo.CoveredRuns;
      }
    }
    if (out.Demo.CoveredSucceededRuns > 0) {
      out.Demo.AutomationRate = (out.Demo.AutomatedSucceededRuns * 100) / out.Demo.CoveredSucceededRuns;
    }
    out.RunTraces.sort((a, b) => {
      if (timeEqual(a.CreatedAt, b.CreatedAt)) {
        return a.RunID > b.RunID ? -1 : a.RunID < b.RunID ? 1 : 0;
      }
      return timeAfter(a.CreatedAt, b.CreatedAt) ? -1 : 1;
    });
    // 观测覆盖度按包含的运行统计适配器与日志级别分布：MySQL 走生成列索引分组，其他方言（测试库）从原始载荷计算。
    if (!overview && includedRunIDs.length > 0) {
      if (this.isMySQL()) {
        let coverageResult = null;
        try {
          coverageResult = queryAnalyticsCoverage(this.DB, includedRunIDs);
        } catch {
          coverageResult = null;
        }
        if (coverageResult != null) {
          const [adapters, levels] = coverageResult;
          out.Coverage.AdapterEvents = adapters;
          out.Coverage.LogLevels = levels;
        }
      } else {
        this.computeAnalyticsCoverage(includedRunIDs, out.Coverage);
      }
    }

    if (terminal > 0) {
      out.Summary.CompletionRate = (out.Summary.SucceededRuns * 100) / terminal;
      if (qualityTerminal > 0) {
        out.Summary.FirstPassRate = (firstPassSucceeded * 100) / qualityTerminal;
      }
      out.Summary.AverageDurationMs = Math.trunc(terminalDuration / terminal);
      out.Summary.CancelRate = (out.Summary.CancelledRuns * 100) / terminal;
      if (executionMeasured > 0) {
        out.Summary.ExecutionAverageDurationMs = Math.trunc(terminalExecDuration / executionMeasured);
      }
    }
    const attempts = out.Summary.SucceededRuns + out.Summary.FailedRuns;
    if (attempts > 0) {
      // 成功率排除取消的执行，取消率单独成列，避免"取消"污染成功率分母。
      out.Summary.SuccessRate = (out.Summary.SucceededRuns * 100) / attempts;
    }
    if (cacheDenominator > 0) {
      out.Summary.CacheHitRate = (cacheReadTotal * 100) / cacheDenominator;
    }
    if (out.Summary.TotalRuns > 0) {
      out.Summary.CostCoveragePct = (costKnownRuns * 100) / out.Summary.TotalRuns;
    }
    if (qualityTerminal > 0) {
      out.Summary.WaitAverageDurationMs = Math.trunc(terminalWaitDuration / qualityTerminal);
    }
    const issueCount = Object.keys(issueRuns).length;
    if (issueCount > 0) {
      out.Summary.UniqueIssues = issueCount;
      out.Summary.RunsPerIssue = sumIssueCounts(issueRuns) / issueCount;
      out.Summary.FailuresPerIssue = sumIssueCounts(issueFailures) / issueCount;
    }
    out.Summary.P50DurationMs = percentile(terminalDurations, 50);
    out.Summary.P95DurationMs = percentile(terminalDurations, 95);
    out.Summary.P99DurationMs = percentile(terminalDurations, 99);
    out.Summary.ExecutionP50DurationMs = percentile(terminalExecDurations, 50);
    out.Summary.ExecutionP95DurationMs = percentile(terminalExecDurations, 95);
    out.Summary.ExecutionP99DurationMs = percentile(terminalExecDurations, 99);
    const execValues = issueExecValues(issueExec);
    if (execValues.length > 0) {
      out.Summary.IssueP50ExecutionDurationMs = percentile(execValues, 50);
      out.Summary.IssueP95ExecutionDurationMs = percentile(execValues, 95);
    }
    // 轻量维度（SOP、模型、失败原因、用户每日用量）在概览态同样输出，
    // Agent/CLI 与交付明细仍只在完整扫描时计算。
    out.Workflows = finalizeBreakdowns(workflows);
    out.Categories = finalizeBreakdowns(categories);
    out.WorkflowVersions = finalizeWorkflowVersions(versions);
    out.IssueSources = finalizeBreakdowns(sources);
    out.UserUsage = finalizeUserUsage(users);
    out.ProjectUsage = finalizeProjectUsage(projects);
    out.Models = finalizeBreakdowns(models);
    out.Nodes = finalizeBreakdowns(nodes);
    applyBreakdownShares(out.Workflows, out.Summary.TotalTokens, out.Summary.TotalCostUSD);
    applyBreakdownShares(out.Categories, out.Summary.TotalTokens, out.Summary.TotalCostUSD);
    applyBreakdownShares(out.IssueSources, out.Summary.TotalTokens, out.Summary.TotalCostUSD);
    applyBreakdownShares(out.Models, out.Summary.TotalTokens, out.Summary.TotalCostUSD);
    applyBreakdownShares(out.Nodes, out.Summary.TotalTokens, out.Summary.TotalCostUSD);
    for (const failure of Object.values(failures)) {
      out.Failures.push(failure);
    }
    out.Failures.sort((a, b) => (a.Count > b.Count ? -1 : a.Count < b.Count ? 1 : 0));
    const [mrMerges, mergedMRsMissingTime] = this.mrMergeAnalytics(filter, issuesByID);
    out.MRMerges = mrMerges;
    out.Summary.MergedMRsMissingTime = mergedMRsMissingTime;
    out.Summary.MergedMRs = out.MRMerges.length;
    for (const mr of out.MRMerges) {
      analyticsTrendEntry(trends, analyticsTrendBucket(mr.MergedAt, filter.Grain)).MergedMRs++;
    }
    for (const point of Object.values(trends)) {
      const ids = trendIssues[point.Date];
      if (ids != null) {
        point.Issues = Object.keys(ids).length;
      }
      point.ConversationIssues = Object.keys(conversationTrendIssues[point.Date] ?? {}).length;
      out.Trend.push(point);
    }
    out.Trend.sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : 0));
    for (let weekday = 0; weekday < weekHour.length; weekday++) {
      for (let hour = 0; hour < weekHour[weekday].length; hour++) {
        const cell = weekHour[weekday][hour];
        if (cell.Runs === 0) {
          continue;
        }
        cell.Weekday = weekday;
        cell.Hour = hour;
        out.WeekHour.push(cell);
      }
    }
    if (overview) {
      if (filter.Origin !== "external") {
        out.Delivery.Issues = countDeliveryGroups(filter, platformRuns, issuesByID);
      }
      out.Summary.InProgressIssues = countInProgressIssues(issueList, filter);
      return out;
    }
    out.Agents = finalizeBreakdowns(agents);
    out.Executors = finalizeBreakdowns(executors);
    applyBreakdownShares(out.Agents, out.Summary.TotalTokens, out.Summary.TotalCostUSD);
    applyBreakdownShares(out.Executors, out.Summary.TotalTokens, out.Summary.TotalCostUSD);
    if (filter.Origin !== "external") {
      out.Deliveries = this.delivery.buildDeliveries(filter, now, platformRuns, workflowDefs, issuesByID);
    }
    out.Delivery = SummarizeDeliveries(out.Deliveries);
    applyWeeklyThroughput(out.Summary, out.Deliveries, now);
    out.Summary.InProgressIssues = countInProgressIssues(issueList, filter);
    return out;
  } finally {
    applyAnalyticsCNY(out);
  }
};

// 显式人工决策事件列表；排除 run.paused / run.resumed，因为它们也会在租约接管和服务恢复时触发，
// 且单次审批常常同时产生 pause + resume + gate 事件。
const analyticsHumanEventTypes = [
  "gate.approved",
  "node.passed",
  "gate.rejected",
  "node.retry_requested",
  "agent.turns.declined",
];

/**
 * 按每批 500 条查询指定运行的工具调用成败遥测与显式人工干预事件计数。
 * 在分析快照回填演示指标与运行追踪信号时调用，避免加载完整日志、输出与普通进度遥测。
 *
 * @param {string[]} runIDs - 待统计信号的平台运行 ID 列表。
 * @returns {Object<string, analyticsRunSignals>} 按运行 ID 索引的信号计数映射。
 */
AnalyticsRepo.prototype.analyticsRunSignals = function (runIDs) {
  const out = {};
  for (let start = 0; start < runIDs.length; start += 500) {
    const batch = runIDs.slice(start, Math.min(start + 500, runIDs.length));
    this.accumulateToolSignals(out, batch);

    const eventRows = []; // Go: var eventRows []runEventRow（models.go 待翻译）
    const err = this.DB.Select("run_id", "type").Where("run_id IN ? AND type IN ?", batch, analyticsHumanEventTypes).Find(eventRows).Error;
    if (err == null) {
      for (const row of eventRows) {
        const signal = out[row.RunID] ?? new analyticsRunSignals();
        signal.interventions++;
        out[row.RunID] = signal;
      }
    }
  }
  return out;
};

/**
 * 从 `run_telemetry` 表按批次聚合单次工具调用结束（`category=tool, name=tool.call, phase=finish`）的成败次数。
 * 供 `analyticsRunSignals` 分批调用，并根据数据库方言切换 SQLite 与 MySQL 的 JSON 提取表达式。
 *
 * @param {Object<string, analyticsRunSignals>} out - 按运行 ID 索引的信号映射（就地累加）。
 * @param {string[]} batch - 当前批次的运行 ID 列表。
 * @returns {void} 无返回值。
 */
AnalyticsRepo.prototype.accumulateToolSignals = function (out, batch) {
  if (batch.length === 0 || this.DB == null) {
    return;
  }
  let successExpr = "CASE WHEN json_extract(payload, '$.tool.success') IS NOT NULL THEN json_extract(payload, '$.tool.success') ELSE (CASE WHEN lower(coalesce(json_extract(payload, '$.level'), '')) = 'error' THEN 0 ELSE 1 END) END";
  let filter = "json_extract(payload, '$.category') = ? AND json_extract(payload, '$.name') = ? AND json_extract(payload, '$.phase') = ?";
  if (this.isMySQL()) {
    successExpr = "CASE WHEN JSON_EXTRACT(payload, '$.tool.success') IS NOT NULL THEN JSON_EXTRACT(payload, '$.tool.success') ELSE (LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.level')), '')) <> 'error') END";
    filter = "JSON_UNQUOTE(JSON_EXTRACT(payload, '$.category')) = ? AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.name')) = ? AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.phase')) = ?";
  }
  const rows = []; // Go: var rows []toolRow（本函数内定义的行类型）
  const err = this.DB.Table("run_telemetry")
    .Select("run_id, SUM(" + successExpr + ") AS succeeded, SUM(1-(" + successExpr + ")) AS failed")
    .Where("run_id IN ? AND " + filter, batch, "tool", "tool.call", "finish")
    .Group("run_id")
    .Scan(rows).Error;
  if (err != null) {
    return;
  }
  for (const row of rows) {
    const signal = out[row.RunID] ?? new analyticsRunSignals();
    signal.toolSucceeded += row.Succeeded;
    signal.toolFailed += row.Failed;
    out[row.RunID] = signal;
  }
};

/**
 * 提取运行中按节点 ID 字典序排在首位的出错节点及其归一化错误摘要。
 * 在构造 `AnalyticsRunTrace` 运行追踪记录时调用。
 *
 * @param {import("../domain/run.js").Run} run - 待提取错误信息的运行对象。
 * @returns {[string, string]} 二元组 `[出错节点 ID, 归一化错误消息]`；无错误节点时返回 `["", ""]`。
 */
function analyticsRunError(run) {
  const ids = [];
  for (const [id, node] of Object.entries(run.Nodes ?? {})) {
    if (node != null && node.Error.trim() !== "") {
      ids.push(id);
    }
  }
  if (ids.length === 0) {
    return ["", ""];
  }
  ids.sort();
  const node = run.Nodes[ids[0]];
  return [ids[0], normalizeFailure(node.Error)];
}

/**
 * 在不支持 MySQL 生成列的数据库方言（如测试 SQLite）下，从原始遥测与日志载荷中统计适配器与日志级别覆盖度。
 * 供 `analyticsWithRuns` 在非 MySQL 完整扫描路径调用。
 *
 * @param {string[]} runIDs - 纳入统计的平台运行 ID 列表。
 * @param {AnalyticsCoverage} coverage - 目标观测覆盖度对象（就地累加 `AdapterEvents` 与 `LogLevels`）。
 * @returns {void} 无返回值。
 */
AnalyticsRepo.prototype.computeAnalyticsCoverage = function (runIDs, coverage) {
  for (const runID of runIDs) {
    let telemetry;
    try {
      telemetry = this.runs.loadRunTelemetryAll(runID);
    } catch {
      continue;
    }
    for (const event of telemetry) {
      let adapter = event.Source.Adapter;
      if (adapter === "") {
        adapter = "unknown";
      }
      coverage.AdapterEvents[adapter] = (coverage.AdapterEvents[adapter] ?? 0) + 1;
    }
    let logs;
    try {
      logs = this.runs.loadRunLogsAll(runID);
    } catch {
      continue;
    }
    for (const record of logs) {
      let level = record.Level;
      if (level === "") {
        level = "info";
      }
      coverage.LogLevels[level] = (coverage.LogLevels[level] ?? 0) + 1;
    }
  }
};

/**
 * 利用 MySQL 的生成列索引通过单条 `UNION ALL` 分组查询遥测适配器分布与日志级别分布。
 * 供 `analyticsWithRuns` 在 MySQL 完整扫描路径调用。
 *
 * @param {Object} db - gorm 数据库句柄。
 * @param {string[]} runIDs - 纳入统计的平台运行 ID 列表。
 * @returns {[Object<string, number>, Object<string, number>]} 二元组 `[适配器事件计数映射, 日志级别计数映射]`；SQL 执行失败时抛出错误。
 */
function queryAnalyticsCoverage(db, runIDs) {
  const adapters = {};
  const levels = {};
  const placeholders = runIDs.map(() => "?").join(",");
  const args = [...runIDs];
  const coverageArgs = [...args, ...args];
  const rows = []; // Go: var rows []coverageRow（本函数内定义的行类型）
  const err = db.Raw(`
		SELECT 'adapter' AS kind, adapter AS value, COUNT(*) AS count
		FROM run_telemetry WHERE run_id IN (${placeholders}) GROUP BY value
		UNION ALL
		SELECT 'level' AS kind, level AS value, COUNT(*) AS count
		FROM run_logs WHERE run_id IN (${placeholders}) GROUP BY value`, ...coverageArgs).Scan(rows).Error;
  if (err != null) {
    throw err;
  }
  for (const row of rows) {
    if (row.Kind === "adapter") {
      adapters[row.Value] = row.Count;
    } else {
      levels[row.Value] = row.Count;
    }
  }
  return [adapters, levels];
}

/**
 * 汇总单次运行所有节点的返工次数总和。
 * 在分析聚合统计返工次数与一次通过率时调用。
 *
 * @param {import("../domain/run.js").Run} run - 运行对象。
 * @returns {number} 该运行全部节点的 `ReworkCount` 之和。
 */
function runReworks(run) {
  let total = 0;
  for (const node of Object.values(run.Nodes ?? {})) {
    total += node.ReworkCount;
  }
  return total;
}

/**
 * 计算单次运行的墙钟持续时长（毫秒）并判定是否已进入终态（`succeeded`/`failed`/`cancelled`）。
 * 在分析主流程累加终态耗时与分位数样本时调用。
 *
 * @param {import("../domain/run.js").Run} run - 运行对象。
 * @param {Date} now - 当前统计基准时间。
 * @returns {[number, boolean]} 二元组 `[运行持续毫秒数, 是否已终态]`。
 */
function analyticsRunDuration(run, now) {
  const complete = run.Status === "succeeded" || run.Status === "failed" || run.Status === "cancelled";
  return [runDuration(run, now), complete];
}

/**
 * 解析星期×小时热力图使用的时区描述对象；空值、`"Local"` 或无法识别的时区均回退到 `"Asia/Shanghai"`（最终兜底为东八区固定偏移）。
 * 在分析主流程构建 `WeekHour` 热力图前调用。
 *
 * @param {string|null|undefined} name - 筛选条件中传入的时区名称。
 * @returns {{name: string, offsetMs?: number}} 可用于 `inLocation` 的时区描述对象。
 */
function analyticsWeekHourLocation(name) {
  name = (name ?? "").trim();
  if (name === "" || name === "Local") {
    name = "Asia/Shanghai";
  }
  try {
    return loadTimeLocation(name);
  } catch {
    // Go：LoadLocation 失败时回退到 Asia/Shanghai。
  }
  try {
    return loadTimeLocation("Asia/Shanghai");
  } catch {
    // Go：再失败时用固定 +8 小时时区。
  }
  return { name: "Asia/Shanghai", offsetMs: 8 * 3600 * 1000 };
}

/**
 * 根据时间粒度（`week`/`month`/`all`/默认按日）将时间映射为趋势分桶键字符串。
 * 用于运营趋势、活跃度趋势、交付趋势与 MR 合并趋势的时间轴对齐。
 *
 * @param {Date|null|undefined} at - 待分桶的时间对象（按 UTC 字段取值）。
 * @param {string|null|undefined} grain - 统计粒度（`"day"`、`"week"`、`"month"`、`"all"`）。
 * @returns {string} 趋势分桶键（如 `"2026-09-01"`、`"2026-W36"`、`"2026-09"`）。
 */
function analyticsTrendBucket(at, grain) {
  const d = at ?? zeroTimeDate();
  switch ((grain ?? "").toLowerCase().trim()) {
    case "week": {
      const [year, week] = isoWeek(d);
      return `${year}-W${String(week).padStart(2, "0")}`;
    }
    case "month":
    case "all":
      return formatMonthUTC(d);
    default:
      return formatDayUTC(d);
  }
}

/**
 * 获取趋势映射中指定分桶键对应的趋势点，不存在时创建新点并存回映射。
 * 在累加运行趋势、会话工作区趋势或 MR 合并趋势时调用。
 *
 * @param {Object<string, AnalyticsTrendPoint>} trends - 按时间桶键索引的趋势点映射。
 * @param {string} bucket - 时间桶键。
 * @returns {AnalyticsTrendPoint} 该时间桶对应的趋势点对象。
 */
function analyticsTrendEntry(trends, bucket) {
  let point = trends[bucket];
  if (point == null) {
    point = new AnalyticsTrendPoint({ Date: bucket });
    trends[bucket] = point;
  }
  return point;
}

/**
 * 将需求 ID 登记到指定时间桶的需求集合中；`issueID` 为空时直接忽略。
 * 用于统计每个趋势时间桶覆盖的去重需求数。
 *
 * @param {Object<string, Object<string, boolean>>} trendIssues - 按时间桶键索引的需求 ID 集合映射。
 * @param {string} bucket - 时间桶键。
 * @param {string} issueID - 需求 ID。
 * @returns {void} 无返回值。
 */
function addAnalyticsTrendIssue(trendIssues, bucket, issueID) {
  if (issueID === "") {
    return;
  }
  if (trendIssues[bucket] == null) {
    trendIssues[bucket] = {};
  }
  trendIssues[bucket][issueID] = true;
}

/**
 * 按运行创建时间判断是否命中分析筛选条件的时间窗口 `[From, To]`（含边界）。
 * 保持与既有分析口径一致，在加载快照与遍历运行前过滤。
 *
 * @param {import("../domain/run.js").Run} run - 待判断的运行对象。
 * @param {import("../domain/analytics.js").AnalyticsFilter} filter - 包含 `From` 与 `To` 的筛选条件。
 * @returns {boolean} 命中时间窗口返回 `true`，否则返回 `false`。
 */
function analyticsRunInWindow(run, filter) {
  if (!isZeroTime(filter.From) && timeBefore(run.CreatedAt, filter.From)) {
    return false;
  }
  if (!isZeroTime(filter.To) && timeAfter(run.CreatedAt, filter.To)) {
    return false;
  }
  return true;
}

/**
 * 判断单次运行是否匹配指定的用户 ID 筛选条件（匹配执行责任人或关联需求的经办人）。
 * 在按成员筛选运行、活跃度与 MR 合并数据时调用。
 *
 * @param {import("../domain/run.js").Run} run - 运行对象。
 * @param {string|null|undefined} userID - 目标用户 ID 字符串；为空时不限制。
 * @param {Issue} issue - 该运行关联的需求对象。
 * @returns {boolean} 匹配返回 `true`，否则返回 `false`。
 */
function analyticsRunMatchesUser(run, userID, issue) {
  const want = (userID ?? "").trim();
  if (want === "") {
    return true;
  }
  if (String(run.ExecutionContext.ResponsibleUserID) === want) {
    return true;
  }
  return issue.AssigneeUserID !== 0 && String(issue.AssigneeUserID) === want;
}

/**
 * 解析运行的责任人 ID 字符串；执行上下文未记录责任人时回退到关联需求的经办人。
 * 在按“责任人 × 自然日”汇总用户用量时调用。
 *
 * @param {import("../domain/run.js").Run} run - 运行对象。
 * @param {Issue} issue - 关联需求对象。
 * @returns {string} 责任人 ID 字符串；均不存在时返回 `""`。
 */
function analyticsRunUserID(run, issue) {
  if (run.ExecutionContext.ResponsibleUserID !== 0) {
    return String(run.ExecutionContext.ResponsibleUserID);
  }
  if (issue.AssigneeUserID !== 0) {
    return String(issue.AssigneeUserID);
  }
  return "";
}

/**
 * 判断需求来源是否匹配筛选条件（忽略大小写与首尾空白，空来源归一为 `"local"`）。
 * 在按需求来源过滤运行、需求、会话与 MR 时调用。
 *
 * @param {Issue} issue - 需求对象。
 * @param {string|null|undefined} source - 目标来源标识；为空时不限制。
 * @returns {boolean} 匹配返回 `true`，否则返回 `false`。
 */
function analyticsIssueMatchesSource(issue, source) {
  const want = (source ?? "").toLowerCase().trim();
  if (want === "") {
    return true;
  }
  let got = (issue.Source ?? "").toLowerCase().trim();
  if (got === "") {
    got = "local";
  }
  return got === want;
}

/**
 * 判断给定对象是否为有效的需求类工作项（具备非空 ID 且满足 `IsRequirementWorkItem`）。
 * 在 `RequirementsOnly` 过滤与需求活跃度统计时调用。
 *
 * @param {Issue} issue - 待判断的需求对象。
 * @returns {boolean} 是有效需求工作项返回 `true`，否则返回 `false`。
 */
function analyticsIsRequirementIssue(issue) {
  return issue.ID !== "" && IsRequirementWorkItem(issue);
}

/**
 * 判断 Token 用量的成本是否已识别，区分“真实成本为 0”与“成本未知”。
 * 显式标记为 `"reported"`/`"estimated"` 视为已识别，`"unknown"` 视为未知，旧数据无状态时按 `CostUSD > 0` 判定。
 *
 * @param {import("../domain/run.js").TokenUsage} usage - Token 用量与成本对象。
 * @returns {boolean} 成本已识别返回 `true`，未知返回 `false`。
 */
function usageCostKnown(usage) {
  switch ((usage.CostStatus ?? "").toLowerCase().trim()) {
    case "reported":
    case "estimated":
      return true;
    case "unknown":
      return false;
    default:
      break;
  }
  return usage.CostUSD > 0;
}

/**
 * 获取工作流的受控统计分类标签，优先取运行冻结快照中的 `MetricCategory`，缺失时回退到目录定义。
 * 在工作流与分类维度拆解时调用。
 *
 * @param {WorkflowDefinition} snapshot - 运行时冻结的工作流快照。
 * @param {WorkflowDefinition} fallback - 目录中的当前工作流定义。
 * @returns {string} 去除首尾空白后的分类标签字符串。
 */
function analyticsWorkflowCategory(snapshot, fallback) {
  const category = (snapshot.MetricCategory ?? "").trim();
  if (category !== "") {
    return category;
  }
  return (fallback.MetricCategory ?? "").trim();
}

/**
 * 统计工作流节点定义列表按节点类型分组的数量分布（空类型归为 `"unknown"`）。
 * 用于在工作流维度拆解中附带流程结构画像。
 *
 * @param {WorkflowNode[]|null|undefined} nodes - 工作流节点定义列表。
 * @returns {Object<string, number>} 按节点类型索引的节点数量映射。
 */
function analyticsNodeTypes(nodes) {
  const out = {};
  for (const node of nodes ?? []) {
    let kind = (node.Type ?? "").trim();
    if (kind === "") {
      kind = "unknown";
    }
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

/**
 * 对按需求 ID 索引的计数字典求和。
 * 用于计算平均每需求的运行次数与失败次数。
 *
 * @param {Object<string, number>} values - 需求 ID 到计数的映射。
 * @returns {number} 全部计数的总和。
 */
function sumIssueCounts(values) {
  let total = 0;
  for (const count of Object.values(values)) {
    total += count;
  }
  return total;
}

/**
 * 提取按需求 ID 索引的执行耗时映射中的全部数值，生成用于分位数计算的数组。
 * 在计算需求维度 P50/P95 执行耗时前调用。
 *
 * @param {Object<string, number>} values - 需求 ID 到累计执行耗时（毫秒）的映射。
 * @returns {number[]} 耗时样本数组。
 */
function issueExecValues(values) {
  const out = [];
  for (const value of Object.values(values)) {
    out.push(value);
  }
  return out;
}

/**
 * 统计符合筛选条件且尚未闭环的在制需求数（WIP 快照）。
 * 在概览模式与完整扫描模式结尾回填 `Summary.InProgressIssues` 时调用。
 *
 * @param {Issue[]|null|undefined} issues - 需求列表。
 * @param {import("../domain/analytics.js").AnalyticsFilter} filter - 分析查询筛选条件。
 * @returns {number} 仍处于进行中的需求总数。
 */
function countInProgressIssues(issues, filter) {
  let total = 0;
  for (const issue of issues ?? []) {
    if (!filter.MatchesProject(issue.ProjectID)) {
      continue;
    }
    if (filter.WorkflowID !== "" && issue.WorkflowID !== filter.WorkflowID) {
      continue;
    }
    if (filter.IssueSource !== "" && !analyticsIssueMatchesSource(issue, filter.IssueSource)) {
      continue;
    }
    if (filter.RequirementsOnly && !analyticsIsRequirementIssue(issue)) {
      continue;
    }
    if (filter.UserID !== "" && String(issue.AssigneeUserID) !== filter.UserID) {
      continue;
    }
    if (!issueInProgress(issue)) {
      continue;
    }
    total++;
  }
  return total;
}

/**
 * 判断单条需求是否仍处于未闭环（进行中）状态。
 * 已合并交付（`DeliveryState === "merged"`）或状态为 `done`/`closed`/`cancelled`/`canceled` 时视为已闭环。
 *
 * @param {Issue} issue - 需求对象。
 * @returns {boolean} 未闭环返回 `true`，已闭环返回 `false`。
 */
function issueInProgress(issue) {
  if ((issue.DeliveryState ?? "").trim().toLowerCase() === "merged") {
    return false;
  }
  switch ((issue.Status ?? "").toLowerCase().trim()) {
    case "done":
    case "closed":
    case "cancelled":
    case "canceled":
      return false;
    default:
      break;
  }
  return true;
}

/**
 * 计算近 7 天的已交付唯一需求数、活跃贡献人数与人均周吞吐，并回填至总览汇总对象。
 * 在完整扫描模式生成交付明细列表后调用。
 *
 * @param {AnalyticsSummary} summary - 目标分析总览对象（就地修改）。
 * @param {import("../domain/analytics.js").AnalyticsDelivery[]|null|undefined} deliveries - 交付明细列表。
 * @param {Date} now - 当前统计基准时间。
 * @returns {void} 无返回值。
 */
function applyWeeklyThroughput(summary, deliveries, now) {
  const since = new Date(now.getTime());
  since.setUTCDate(since.getUTCDate() - 7);
  const until = new Date(now.getTime() + 60000);
  const issues = {};
  const contributors = {};
  for (const item of deliveries ?? []) {
    if (!item.Delivered || isZeroTime(item.LastRunAt)) {
      continue;
    }
    if (timeBefore(item.LastRunAt, since) || timeAfter(item.LastRunAt, until)) {
      continue;
    }
    issues[item.IssueID] = true;
    if (item.UserID !== "") {
      contributors[item.UserID] = true;
    }
  }
  summary.WeeklyDeliveredIssues = Object.keys(issues).length;
  summary.WeeklyActiveContributors = Object.keys(contributors).length;
  if (Object.keys(contributors).length > 0) {
    summary.WeeklyThroughputPerUser = Object.keys(issues).length / Object.keys(contributors).length;
  }
}

/**
 * 将单次运行的计数、返工、工具调用、Token/成本、状态与耗时累加到指定维度的累加器中。
 * 供工作流维度与分类维度统计调用。
 *
 * @param {Object<string, analyticsAccumulator>} values - 维度键到累加器的映射。
 * @param {string} key - 维度唯一键。
 * @param {string} name - 维度展示名称（非空时更新）。
 * @param {import("../domain/run.js").Run} run - 运行对象。
 * @param {number} reworks - 本次运行的返工总次数。
 * @param {number} duration - 本次运行的墙钟耗时（毫秒）。
 * @param {boolean} complete - 本次运行是否已终态。
 * @param {number} execDuration - 本次运行的纯执行耗时（毫秒）。
 * @returns {void} 无返回值。
 */
function accumulateBreakdown(values, key, name, run, reworks, duration, complete, execDuration) {
  let value = values[key];
  if (value == null) {
    value = new analyticsAccumulator({ item: new AnalyticsBreakdown({ Key: key, Name: name }) });
    values[key] = value;
  }
  if (name !== "") {
    value.item.Name = name;
  }
  value.item.Runs++;
  value.item.Reworks += reworks;
  value.item.ToolCalls += run.ToolCalls;
  accumulateBreakdownUsage(value, run.Usage);
  countBreakdownStatus(value.item, run.Status, run.Status === "running" || run.Status === "waiting");
  if (complete) {
    accumulateBreakdownDuration(value, duration, execDuration);
  }
}

/**
 * 将单次运行或节点的 Token 总量、成本总额、成本未识别计数与 Token 四分项累加到维度累加器。
 * 供工作流、分类、节点、模型、智能体、执行器等拆解维度共用。
 *
 * @param {analyticsAccumulator} value - 目标维度累加器（就地修改）。
 * @param {import("../domain/run.js").TokenUsage} usage - Token 与成本用量对象。
 * @returns {void} 无返回值。
 */
function accumulateBreakdownUsage(value, usage) {
  if (!usageCostKnown(usage)) {
    value.item.CostUnknownRuns++;
  }
  value.item.Tokens += usage.TotalTokens;
  value.item.CostUSD += usage.CostUSD;
  value.inputTokens += usage.InputTokens;
  value.outputTokens += usage.OutputTokens;
  value.cacheReadTokens += usage.CacheReadTokens;
  value.cacheWriteTokens += usage.CacheWriteTokens;
}

/**
 * 按状态字符串累加拆解项的终态计数（`succeeded`/`failed`/`cancelled`）以及活跃计数。
 * 供运行级与节点级累加器共用，`active` 判定由调用方按各自的状态词表传入。
 *
 * @param {AnalyticsBreakdown} item - 目标拆解项（就地修改）。
 * @param {string} status - 运行或节点状态字符串。
 * @param {boolean} active - 是否计入活跃状态数。
 * @returns {void} 无返回值。
 */
function countBreakdownStatus(item, status, active) {
  switch (status) {
    case "succeeded":
      item.Succeeded++;
      break;
    case "failed":
      item.Failed++;
      break;
    case "cancelled":
      item.Cancelled++;
      break;
    default:
      break;
  }
  if (active) {
    item.Active++;
  }
}

/**
 * 向维度累加器追加一次有效终态的墙钟耗时与执行耗时样本，供后续计算均值与 P95。
 *
 * @param {analyticsAccumulator} value - 目标维度累加器（就地修改）。
 * @param {number} duration - 墙钟耗时样本（毫秒）。
 * @param {number} execDuration - 执行耗时样本（毫秒）。
 * @returns {void} 无返回值。
 */
function accumulateBreakdownDuration(value, duration, execDuration) {
  value.duration += duration;
  value.durations.push(duration);
  value.execDuration += execDuration;
  value.execDurations.push(execDuration);
}

/**
 * 将单个节点执行的用量、重试、返工、模型分布、状态与耗时累加到目标维度（节点、模型、智能体或执行器）。
 * 供分析主流程遍历运行节点及外部洞察模型拆解调用。
 *
 * @param {Object<string, analyticsAccumulator>} values - 维度键到累加器的映射。
 * @param {string} key - 维度唯一键。
 * @param {string} name - 维度展示名称（非空时更新）。
 * @param {import("../domain/run.js").NodeRun} node - 节点运行记录。
 * @param {number} duration - 节点耗时（毫秒）。
 * @param {boolean} complete - 节点是否具备完整起止时间。
 * @returns {void} 无返回值。
 */
function accumulateNode(values, key, name, node, duration, complete) {
  let value = values[key];
  if (value == null) {
    value = new analyticsAccumulator({ item: new AnalyticsBreakdown({ Key: key, Name: name }) });
    values[key] = value;
  }
  if (name !== "") {
    value.item.Name = name;
  }
  value.item.Runs++;
  value.item.Reworks += node.ReworkCount;
  value.item.ToolCalls += node.ToolCalls;
  accumulateBreakdownUsage(value, node.Usage);
  value.nodeRuns++;
  if (node.Attempt > 1) {
    value.retriedNodes++;
  }
  if (node.ReworkCount > 0) {
    value.reworkNodes++;
  }
  if (node.Model !== "") {
    if (value.models == null) {
      value.models = {};
    }
    value.models[node.Model] = (value.models[node.Model] ?? 0) + 1;
  }
  countBreakdownStatus(value.item, node.Status, node.Status === "running" || node.Status === "waiting_approval");
  if (node.Status === "failed") {
    value.item.FailedNodes++;
  }
  if (complete) {
    // 节点耗时本身就是"执行耗时"，与双口径中的执行耗时同源。
    accumulateBreakdownDuration(value, duration, duration);
  }
}

/**
 * 按“工作流 ID + 版本号”聚合运行指标，用于 SOP 版本间效果对比。
 * 优先取运行冻结快照中的版本号，不大于 0 时回退至目录当前版本号。
 *
 * @param {Object<string, analyticsVersionAccumulator>} values - 版本键到累加器的映射。
 * @param {string} workflowID - 工作流 ID。
 * @param {string} workflowName - 工作流名称。
 * @param {number} snapshotVersion - 运行快照冻结的版本号。
 * @param {number} fallbackVersion - 目录中的兜底版本号。
 * @param {import("../domain/run.js").Run} run - 运行对象。
 * @param {number} duration - 墙钟耗时（毫秒）。
 * @param {boolean} complete - 是否已终态。
 * @param {number} execDuration - 执行耗时（毫秒）。
 * @returns {void} 无返回值。
 */
function accumulateVersion(values, workflowID, workflowName, snapshotVersion, fallbackVersion, run, duration, complete, execDuration) {
  let version = snapshotVersion;
  if (version <= 0) {
    version = fallbackVersion;
  }
  const key = workflowID + "#" + String(version);
  let value = values[key];
  if (value == null) {
    value = new analyticsVersionAccumulator({
      item: new AnalyticsWorkflowVersion({
        WorkflowID: workflowID,
        Name: workflowName,
        Version: version,
        InsufficientSample: true,
      }),
    });
    values[key] = value;
  }
  if (workflowName !== "") {
    value.item.Name = workflowName;
  }
  value.item.Runs++;
  if (!usageCostKnown(run.Usage)) {
    value.item.CostUnknownRuns++;
  }
  value.item.Tokens += run.Usage.TotalTokens;
  value.item.CostUSD += run.Usage.CostUSD;
  if (run.Status === "succeeded") {
    value.item.Succeeded++;
  }
  if (run.Status === "failed") {
    value.item.Failed++;
  }
  if (complete) {
    value.duration += duration;
    value.durations.push(duration);
    value.execDuration += execDuration;
    value.execDurations.push(execDuration);
  }
}

/**
 * 获取“责任人 × 自然日”对应的用户用量累加器，缺失时新建并存入映射；空责任人归入 `"unassigned"`。
 * 供 SOP 运行与会话工作区累加用户用量时共用。
 *
 * @param {Object<string, analyticsUserAccumulator>} values - 复合键到用户用量累加器的映射。
 * @param {string} userID - 责任人 ID 字符串。
 * @param {string} day - `YYYY-MM-DD` 自然日字符串。
 * @returns {analyticsUserAccumulator} 对应的用户用量累加器。
 */
function analyticsUserEntry(values, userID, day) {
  if (userID === "") {
    userID = "unassigned";
  }
  const key = userID + "\x00" + day;
  let value = values[key];
  if (value == null) {
    value = new analyticsUserAccumulator({ item: new AnalyticsUserUsage({ UserID: userID, Date: day, CostKnown: true }) });
    values[key] = value;
  }
  return value;
}

/**
 * 按“责任人 × 自然日”累加单次运行的次数、Token 四分项、成本、成败数与耗时。
 * 在分析主流程处理平台及外部运行时调用。
 *
 * @param {Object<string, analyticsUserAccumulator>} values - 用户用量累加器映射。
 * @param {string} userID - 责任人 ID 字符串。
 * @param {string} day - `YYYY-MM-DD` 自然日字符串。
 * @param {import("../domain/run.js").Run} run - 运行对象。
 * @param {number} duration - 墙钟耗时（毫秒）。
 * @param {boolean} complete - 是否已终态。
 * @param {number} execDuration - 执行耗时（毫秒）。
 * @returns {void} 无返回值。
 */
function accumulateUserUsage(values, userID, day, run, duration, complete, execDuration) {
  const value = analyticsUserEntry(values, userID, day);
  value.item.Runs++;
  value.item.Tokens += run.Usage.TotalTokens;
  value.item.InputTokens += run.Usage.InputTokens;
  value.item.OutputTokens += run.Usage.OutputTokens;
  value.item.CacheReadTokens += run.Usage.CacheReadTokens;
  value.item.CacheWriteTokens += run.Usage.CacheWriteTokens;
  value.item.CostUSD += run.Usage.CostUSD;
  value.item.ExecutionDurationMs += execDuration;
  if (!usageCostKnown(run.Usage)) {
    value.item.CostKnown = false;
  }
  if (run.Status === "succeeded") {
    value.item.Success++;
  }
  if (run.Status === "failed") {
    value.item.Failed++;
  }
  if (complete) {
    value.item.DurationMs += duration;
  }
}

/**
 * 将维度累加器映射收口为最终的拆解项数组，计算成功率、取消率、返工率、重试率、均值与 P95 耗时，并按运行数降序、名称升序排列。
 * 在各拆解维度累计完成后调用。
 *
 * @param {Object<string, analyticsAccumulator>} values - 维度累加器映射。
 * @returns {AnalyticsBreakdown[]} 排序后的拆解项数组。
 */
function finalizeBreakdowns(values) {
  const out = [];
  for (const value of Object.values(values)) {
    const terminal = value.item.Succeeded + value.item.Failed;
    if (terminal > 0) {
      value.item.SuccessRate = (value.item.Succeeded * 100) / terminal;
    }
    const all = terminal + value.item.Cancelled;
    if (all > 0) {
      value.item.CancelRate = (value.item.Cancelled * 100) / all;
      value.item.ReworkRate = (value.item.Reworks * 100) / value.item.Runs;
    }
    if (value.durations.length > 0) {
      value.item.AverageDurationMs = Math.trunc(value.duration / value.durations.length);
      value.item.P95DurationMs = percentile(value.durations, 95);
    }
    if (value.execDurations.length > 0) {
      value.item.AverageExecutionDurationMs = Math.trunc(value.execDuration / value.execDurations.length);
      value.item.P95ExecutionDurationMs = percentile(value.execDurations, 95);
    }
    value.item.InputTokens = value.inputTokens;
    value.item.OutputTokens = value.outputTokens;
    value.item.CacheReadTokens = value.cacheReadTokens;
    value.item.CacheWriteTokens = value.cacheWriteTokens;
    value.item.ToolCalls = value.toolCalls;
    value.item.NodeRuns = value.nodeRuns;
    value.item.RetriedNodes = value.retriedNodes;
    value.item.ReworkNodes = value.reworkNodes;
    if (value.nodeRuns > 0) {
      value.item.RetryRate = (value.retriedNodes * 100) / value.nodeRuns;
    }
    if (value.models != null && Object.keys(value.models).length > 0) {
      value.item.ModelMix = value.models;
    }
    if (value.nodeTypes != null && Object.keys(value.nodeTypes).length > 0) {
      value.item.NodeTypes = value.nodeTypes;
      value.item.NodeCount = value.nodeCount;
    }
    if (value.issueIDs != null && Object.keys(value.issueIDs).length > 0) {
      value.item.CompletedIssues = Object.keys(value.issueIDs).length;
    }
    out.push(value.item);
  }
  out.sort((a, b) => {
    if (a.Runs === b.Runs) {
      return a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0;
    }
    return a.Runs > b.Runs ? -1 : 1;
  });
  return out;
}

/**
 * 将工作流版本累加器映射收口为最终列表，计算成功率、平均耗时并标注样本不足（运行数 `< 5`），按工作流 ID 升序、版本号降序排列。
 *
 * @param {Object<string, analyticsVersionAccumulator>} values - 工作流版本累加器映射。
 * @returns {AnalyticsWorkflowVersion[]} 排序后的工作流版本统计数组。
 */
function finalizeWorkflowVersions(values) {
  const out = [];
  for (const value of Object.values(values)) {
    const terminal = value.item.Succeeded + value.item.Failed;
    if (terminal > 0) {
      value.item.SuccessRate = (value.item.Succeeded * 100) / terminal;
    }
    if (value.durations.length > 0) {
      value.item.AverageDurationMs = Math.trunc(value.duration / value.durations.length);
    }
    if (value.execDurations.length > 0) {
      value.item.AverageExecutionDurationMs = Math.trunc(value.execDuration / value.execDurations.length);
    }
    // 样本量不足时标注，避免版本对比被单次执行误导。
    value.item.InsufficientSample = value.item.Runs < 5;
    out.push(value.item);
  }
  out.sort((a, b) => {
    if (a.WorkflowID === b.WorkflowID) {
      return a.Version > b.Version ? -1 : a.Version < b.Version ? 1 : 0;
    }
    return a.WorkflowID < b.WorkflowID ? -1 : a.WorkflowID > b.WorkflowID ? 1 : 0;
  });
  return out;
}

/**
 * 将用户按日用量累加器映射收口为列表，并按日期降序、Token 总量降序排列。
 *
 * @param {Object<string, analyticsUserAccumulator>} values - 用户用量累加器映射。
 * @returns {AnalyticsUserUsage[]} 排序后的用户按日用量数组。
 */
function finalizeUserUsage(values) {
  const out = [];
  for (const value of Object.values(values)) {
    out.push(value.item);
  }
  out.sort((a, b) => {
    if (a.Date === b.Date) {
      return a.Tokens > b.Tokens ? -1 : a.Tokens < b.Tokens ? 1 : 0;
    }
    return a.Date > b.Date ? -1 : 1;
  });
  return out;
}

/**
 * 获取项目对应的用量累加器，不存在时新建并存入映射；空项目 ID 归为 `"unassigned"`。
 * 供 SOP 运行与会话工作区汇总项目用量时共用。
 *
 * @param {Object<string, analyticsProjectAccumulator>} values - 项目 ID 到累加器的映射。
 * @param {string} projectID - 项目 ID。
 * @returns {analyticsProjectAccumulator} 对应的项目用量累加器。
 */
function analyticsProjectEntry(values, projectID) {
  if (projectID === "") {
    projectID = "unassigned";
  }
  let value = values[projectID];
  if (value == null) {
    value = new analyticsProjectAccumulator({ item: new AnalyticsProjectUsage({ ProjectID: projectID, CostKnown: true }), issues: {} });
    values[projectID] = value;
  }
  return value;
}

/**
 * 将单次运行的次数、Token、成本、成败数及关联需求 ID 累加到对应项目的累加器中。
 * 在分析主流程处理平台及外部运行时调用。
 *
 * @param {Object<string, analyticsProjectAccumulator>} values - 项目用量累加器映射。
 * @param {string} projectID - 归属项目 ID。
 * @param {string} issueID - 关联需求 ID（为空时不计入去重需求集合）。
 * @param {import("../domain/run.js").Run} run - 运行对象。
 * @returns {void} 无返回值。
 */
function accumulateProjectUsage(values, projectID, issueID, run) {
  const value = analyticsProjectEntry(values, projectID);
  value.item.Runs++;
  value.item.Tokens += run.Usage.TotalTokens;
  value.item.CostUSD += run.Usage.CostUSD;
  if (!usageCostKnown(run.Usage)) {
    value.item.CostKnown = false;
  }
  if (run.Status === "succeeded") {
    value.item.Success++;
  }
  if (run.Status === "failed") {
    value.item.Failed++;
  }
  if (issueID !== "") {
    value.issues[issueID] = true;
  }
}

/**
 * 将项目用量累加器映射收口为列表，回填唯一需求数并按 Token 总量降序、运行数降序排列。
 *
 * @param {Object<string, analyticsProjectAccumulator>} values - 项目用量累加器映射。
 * @returns {AnalyticsProjectUsage[]} 排序后的项目用量数组。
 */
function finalizeProjectUsage(values) {
  const out = [];
  for (const value of Object.values(values)) {
    value.item.UniqueIssues = Object.keys(value.issues ?? {}).length;
    out.push(value.item);
  }
  out.sort((a, b) => {
    if (a.Tokens === b.Tokens) {
      return a.Runs > b.Runs ? -1 : a.Runs < b.Runs ? 1 : 0;
    }
    return a.Tokens > b.Tokens ? -1 : 1;
  });
  return out;
}

/**
 * 按全局 Token 总量与美元成本总量，为拆解项列表逐项回填 `TokenSharePct` 与 `CostSharePct` 占比百分比。
 * 在各拆解维度收口后调用。
 *
 * @param {AnalyticsBreakdown[]} list - 拆解项列表（就地回填占比字段）。
 * @param {number} totalTokens - 全局总 Token 数。
 * @param {number} totalCostUSD - 全局总美元成本。
 * @returns {void} 无返回值。
 */
function applyBreakdownShares(list, totalTokens, totalCostUSD) {
  for (let i = 0; i < list.length; i++) {
    if (totalTokens > 0) {
      list[i].TokenSharePct = (list[i].Tokens * 100) / totalTokens;
    }
    if (totalCostUSD > 0) {
      list[i].CostSharePct = (list[i].CostUSD * 100) / totalCostUSD;
    }
  }
}

/**
 * 归一化需求的来源标识（转小写去空白），未标注的本地需求归为 `"local"`。
 * 在构造追踪记录与来源维度拆解时调用。
 *
 * @param {Issue} issue - 需求对象。
 * @returns {string} 归一化后的来源字符串。
 */
function analyticsIssueSource(issue) {
  const source = (issue.Source ?? "").toLowerCase().trim();
  if (source === "") {
    return "local";
  }
  return source;
}

/**
 * 获取需求来源对应的拆解累加器，不存在时新建并存入映射；空来源归为 `"local"`。
 *
 * @param {Object<string, analyticsAccumulator>} values - 需求来源到累加器的映射。
 * @param {string} source - 需求来源标识。
 * @returns {analyticsAccumulator} 对应的维度累加器。
 */
function analyticsSourceEntry(values, source) {
  if (source === "") {
    source = "local";
  }
  let value = values[source];
  if (value == null) {
    value = new analyticsAccumulator({ item: new AnalyticsBreakdown({ Key: source, Name: source }) });
    values[source] = value;
  }
  return value;
}

/**
 * 按需求来源维度累加执行次数、Token 四分项、成本、工具调用、终态计数、成功需求去重集合与执行耗时。
 * 在分析主流程处理绑定需求的平台运行时调用。
 *
 * @param {Object<string, analyticsAccumulator>} values - 需求来源累加器映射。
 * @param {string} source - 归一化后的需求来源标识。
 * @param {import("../domain/run.js").Run} run - 运行对象。
 * @param {number} execDuration - 本次运行的纯执行耗时（毫秒）。
 * @returns {void} 无返回值。
 */
function accumulateIssueSource(values, source, run, execDuration) {
  const value = analyticsSourceEntry(values, source);
  value.item.Runs++;
  value.item.Tokens += run.Usage.TotalTokens;
  value.item.CostUSD += run.Usage.CostUSD;
  value.inputTokens += run.Usage.InputTokens;
  value.outputTokens += run.Usage.OutputTokens;
  value.cacheReadTokens += run.Usage.CacheReadTokens;
  value.cacheWriteTokens += run.Usage.CacheWriteTokens;
  value.item.ToolCalls += run.ToolCalls;
  if (run.Status === "succeeded") {
    value.item.Succeeded++;
    if (value.issueIDs == null) {
      value.issueIDs = {};
    }
    value.issueIDs[run.ExecutionContext.IssueID.trim()] = true;
  }
  if (run.Status === "failed") {
    value.item.Failed++;
  }
  if (run.Status === "cancelled") {
    value.item.Cancelled++;
  }
  if (execDuration > 0) {
    value.execDuration += execDuration;
    value.execDurations.push(execDuration);
  }
}

/**
 * 计算整数样本切片的向上取整分位数（如 P50、P95、P99），不修改原数组。
 * 在总览、维度拆解与业务域交付周期分位数计算时调用；空数组返回 0。
 *
 * @param {number[]} values - 数值样本数组。
 * @param {number} pct - 百分位数值（1～100，如 50、95、99）。
 * @returns {number} 对应百分位处的样本值。
 */
function percentile(values, pct) {
  if (values.length === 0) {
    return 0;
  }
  const copyValues = [...values];
  copyValues.sort((a, b) => a - b);
  let index = Math.trunc((copyValues.length * pct + 99) / 100) - 1;
  if (index < 0) {
    index = 0;
  }
  if (index >= copyValues.length) {
    index = copyValues.length - 1;
  }
  return copyValues[index];
}

/**
 * 归一化失败错误信息：取第一行并去除首尾空白，超长时截断至 160 字符，为空时返回 `"unknown failure"`。
 * 用于失败原因聚类与运行追踪错误摘要展示。
 *
 * @param {string} message - 原始错误消息。
 * @returns {string} 归一化后的单行错误摘要。
 */
function normalizeFailure(message) {
  message = message.split("\n")[0].trim();
  if (message.length > 160) {
    message = message.slice(0, 160);
  }
  if (message === "") {
    return "unknown failure";
  }
  return message;
}

/**
 * 按 ID 查找智能体展示名称，未命中或名称为空时回退返回原 ID。
 *
 * @param {Object<string, import("../domain/agent.js").AgentDefinition>} values - 按 ID 索引的智能体定义映射。
 * @param {string} id - 智能体 ID。
 * @returns {string} 展示名称或回退 ID。
 */
function agentName(values, id) {
  const value = values[id];
  if (value != null && value.Name !== "") {
    return value.Name;
  }
  return id;
}

/**
 * 按 ID 查找执行器展示名称，未命中或名称为空时回退返回原 ID。
 *
 * @param {Object<string, ExecutorDefinition>} values - 按 ID 索引的执行器定义映射。
 * @param {string} id - 执行器 ID。
 * @returns {string} 展示名称或回退 ID。
 */
function executorName(values, id) {
  const value = values[id];
  if (value != null && value.Name !== "") {
    return value.Name;
  }
  return id;
}

/**
 * 统计单条会话直改代码工作区（`run.IsWorkspace()`）的模型用量与关联需求。
 * 其 Token 与成本计入全局总览、趋势、用户、项目与需求来源拆解，但不计入 SOP 运行次数、状态、耗时与 SOP 需求数；
 * 关联的需求单独记入 `issues` 与各时间桶的 `trendIssues` 集合中。
 *
 * @param {AnalyticsSummary} summary - 总览汇总对象（就地累加会话工作区与全局用量字段）。
 * @param {Object<string, boolean>} issues - 会话工作区覆盖的唯一需求 ID 集合（就地修改）。
 * @param {Object<string, AnalyticsTrendPoint>} trends - 趋势点映射（就地修改）。
 * @param {Object<string, Object<string, boolean>>} trendIssues - 各时间桶会话工作区覆盖的需求 ID 集合映射（就地修改）。
 * @param {Object<string, analyticsUserAccumulator>} users - 用户按日用量累加器映射（就地修改）。
 * @param {Object<string, analyticsProjectAccumulator>} projects - 项目用量累加器映射（就地修改）。
 * @param {Object<string, analyticsAccumulator>} sources - 需求来源拆解累加器映射（就地修改）。
 * @param {import("../domain/run.js").Run} run - 会话工作区运行对象。
 * @param {Issue} issue - 关联需求对象。
 * @param {string} grain - 趋势时间粒度。
 * @returns {void} 无返回值。
 */
function accumulateConversationRun(summary, issues, trends, trendIssues, users, projects, sources, run, issue, grain) {
  const usage = run.Usage;
  const issueID = run.ExecutionContext.IssueID.trim();
  summary.ConversationWorkspaces++;
  summary.ConversationTokens += usage.TotalTokens;
  summary.ConversationCostUSD += usage.CostUSD;
  summary.TotalTokens += usage.TotalTokens;
  summary.TotalCostUSD += usage.CostUSD;
  summary.CostReportedUSD += usage.CostUSD;
  summary.InputTokens += usage.InputTokens;
  summary.OutputTokens += usage.OutputTokens;
  summary.CacheReadTokens += usage.CacheReadTokens;
  summary.CacheWriteTokens += usage.CacheWriteTokens;
  summary.ReasoningTokens += usage.ReasoningTokens;
  if (issueID !== "") {
    issues[issueID] = true;
    summary.ConversationLinkedWorkspaces++;
  }
  // 使用与分析时间窗过滤一致的时间戳。
  const at = run.CreatedAt;
  const bucket = analyticsTrendBucket(at, grain);
  const point = analyticsTrendEntry(trends, bucket);
  point.Tokens += usage.TotalTokens;
  point.CostUSD += usage.CostUSD;
  point.ConversationWorkspaces++;
  point.ConversationTokens += usage.TotalTokens;
  point.ConversationCostUSD += usage.CostUSD;
  point.InputTokens += usage.InputTokens;
  point.OutputTokens += usage.OutputTokens;
  point.CacheReadTokens += usage.CacheReadTokens;
  point.CacheWriteTokens += usage.CacheWriteTokens;
  addAnalyticsTrendIssue(trendIssues, bucket, issueID);
  if (usage.TotalTokens === 0 && usage.CostUSD === 0 && issueID === "") {
    return;
  }
  const user = analyticsUserEntry(users, analyticsRunUserID(run, issue), formatDayUTC(at));
  user.item.Tokens += usage.TotalTokens;
  user.item.InputTokens += usage.InputTokens;
  user.item.OutputTokens += usage.OutputTokens;
  user.item.CacheReadTokens += usage.CacheReadTokens;
  user.item.CacheWriteTokens += usage.CacheWriteTokens;
  user.item.CostUSD += usage.CostUSD;
  const project = analyticsProjectEntry(projects, RunProjectID(run, issue.ProjectID));
  project.item.Tokens += usage.TotalTokens;
  project.item.CostUSD += usage.CostUSD;
  if (issueID === "") {
    return;
  }
  project.issues[issueID] = true;
  const value = analyticsSourceEntry(sources, analyticsIssueSource(issue));
  value.item.Tokens += usage.TotalTokens;
  value.item.CostUSD += usage.CostUSD;
  value.inputTokens += usage.InputTokens;
  value.outputTokens += usage.OutputTokens;
  value.cacheReadTokens += usage.CacheReadTokens;
  value.cacheWriteTokens += usage.CacheWriteTokens;
}

module.exports = { AnalyticsRepo, analyticsAccumulator, analyticsVersionAccumulator, analyticsUserAccumulator, analyticsProjectAccumulator, analyticsRunSignals, analyticsHumanEventTypes, queryAnalyticsCoverage, runReworks, analyticsRunDuration, analyticsWeekHourLocation, analyticsTrendBucket, analyticsTrendEntry, addAnalyticsTrendIssue, analyticsRunInWindow, analyticsRunMatchesUser, analyticsRunUserID, analyticsIssueMatchesSource, analyticsIsRequirementIssue, usageCostKnown, analyticsWorkflowCategory, analyticsNodeTypes, sumIssueCounts, issueExecValues, countInProgressIssues, issueInProgress, applyWeeklyThroughput, analyticsRunError, accumulateBreakdown, accumulateBreakdownUsage, countBreakdownStatus, accumulateBreakdownDuration, accumulateNode, accumulateVersion, analyticsUserEntry, accumulateUserUsage, finalizeBreakdowns, finalizeWorkflowVersions, finalizeUserUsage, analyticsProjectEntry, accumulateProjectUsage, finalizeProjectUsage, applyBreakdownShares, analyticsIssueSource, analyticsSourceEntry, accumulateIssueSource, percentile, normalizeFailure, agentName, executorName, accumulateConversationRun, isZeroTime, zeroTimeDate, timeMs, timeBefore, timeAfter, timeEqual, formatDayUTC, formatMonthUTC, loadTimeLocation, inLocation };
