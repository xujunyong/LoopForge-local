/**
 * @file internal/repo/analytics_business_merge.js
 * 对应 Go 源文件：internal/repo/analytics_business_merge.go
 *
 * 作用与职责边界：
 * 负责将顶层运行的交付产物绑定到其关联的 MR，并基于运行成功事件与 MR 合并时间
 * 计算每条已合并 MR 的“完成到合并延迟”样本（含缺失样本与先合后完成样本分类）。
 *
 * 语法差异说明：
 * - Go 的 `map[domain.MRDeliveryKey]domain.MRDeliveryState` 以结构体为键（非字符串键），按对照规则在 JS 中使用 `Map`，遍历时使用 `states?.entries() ?? []` 对齐 Go 对 `nil` map 的空遍历语义。
 * - 与 `analytics_business_delivery.js` 存在同包循环引用，调用 `businessTimeInWindow` 时采用函数内延迟 `require`。
 * - Go 的 `(值, error)` 返回在成功时直接返回值，失败时抛出错误。
 */

"use strict";

const { Run, Artifact } = require("../domain/run.js"); // 对应 Go 的 domain.Run/Artifact，domain 已翻译
const { ResolveRunDeliveryMRs } = require("../domain/delivery_mr.js"); // 对应 Go 的 domain.ResolveRunDeliveryMRs，domain 已翻译
const { AnalyticsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { isZeroTime, timeBefore, timeAfter } = require("./analytics.js"); // 对应 Go 同包函数，analytics.js 已翻译

/**
 * 延迟获取 `analytics_business_delivery.js` 中的 `businessTimeInWindow` 以避免循环引用。
 * 在筛选合并时间是否命中时间窗口时调用。
 *
 * @param {Date|null} at - 待判断的时间点。
 * @param {import("../domain/analytics.js").AnalyticsFilter} filter - 分析查询筛选条件。
 * @returns {boolean} 命中窗口返回 `true`，否则返回 `false`。
 */
function businessTimeInWindow(at, filter) {
  return require("./analytics_business_delivery.js").businessTimeInWindow(at, filter);
}

/**
 * 单条已合并 MR 的“运行完成到 MR 合并”延迟样本结构。
 */
class businessMergeLatency {
  /**
   * 构造 MR 合并延迟样本实例，未提供字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {Date|null} [init.mergedAt=null] - MR 实际合并时间。
   * @param {Date|null} [init.completedAt=null] - 对应运行观测到的完成时间。
   * @param {number} [init.duration=0] - 完成到合并的间隔时长（毫秒）。
   * @param {boolean} [init.missing=false] - 是否因缺少可靠完成事件而无法计算延迟。
   * @param {boolean} [init.beforeCompletion=false] - 是否在运行完成之前就已合并（如流程内自动合入）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.mergedAt = init.mergedAt ?? null;
    this.completedAt = init.completedAt ?? null;
    this.duration = init.duration ?? 0;
    this.missing = init.missing ?? false;
    this.beforeCompletion = init.beforeCompletion ?? false;
  }
}

/**
 * 批量读取顶层运行记录中包含 MR 链接的非补丁产物，并解析每条运行对应的交付 MR 列表。
 * 在计算完成到合入延迟前调用，使每轮成功执行只与其自身产出的 MR 绑定，避免被后续无关运行或需求编辑时间改写归属。
 *
 * @param {Run[]} runs - 候选运行列表（仅处理顶层运行，即 `ParentRunID === ""`）。
 * @returns {Object<string, import("../domain/delivery_mr.js").DeliveryMR[]>} 按运行 ID 索引的交付 MR 数组映射；数据库查询失败时抛出错误。
 */
AnalyticsRepo.prototype.businessDeliveryMRs = function (runs) {
  const ids = [];
  const byID = {};
  for (const run of runs ?? []) {
    if (run.ExecutionContext.ParentRunID === "") {
      ids.push(run.ID);
      byID[run.ID] = run;
    }
  }
  for (let start = 0; start < ids.length; start += 500) {
    const rows = []; // Go: var rows []runArtifactRow（models.go 待翻译）
    const err = this.DB.Select("id", "run_id", "node_id", "name", "path", "content", "created_at").
      Where("run_id IN ? AND content LIKE ? AND name NOT LIKE ? AND name NOT LIKE ?", ids.slice(start, Math.min(start + 500, ids.length)), "%merge_requests/%", "%patch%", "%diff%").
      Order("created_at, id").Find(rows).Error;
    if (err != null) {
      throw err;
    }
    for (const row of rows) {
      // Go 按值取运行副本，追加产物后写回；此处构造 Run 副本以保留原型方法。
      const run = new Run({ ...byID[row.RunID], Artifacts: [...(byID[row.RunID].Artifacts ?? [])] });
      run.Artifacts.push(new Artifact({ ID: row.ID, NodeID: row.NodeID, Name: row.Name, Path: row.Path, Content: row.Content }));
      byID[row.RunID] = run;
    }
  }
  const out = {};
  for (const [id, run] of Object.entries(byID)) {
    out[id] = ResolveRunDeliveryMRs(run, null);
  }
  return out;
};

/**
 * 从运行的事件列表中选出与指定 MR 合并时刻最匹配的 `run.succeeded` 时间点。
 * 优先取不晚于 `mergedAt` 的最后一次成功时间；若全部成功事件都晚于合并时间（例如自动合并早于流程结束），则取合并后的最早一次成功时间，避免被后续重试漂移。
 *
 * @param {import("../domain/run.js").RunEvent[]|null|undefined} events - 单条运行的事件列表。
 * @param {Date} mergedAt - MR 合并时间。
 * @returns {Date|null} 选定的运行成功时间；无有效 `run.succeeded` 事件时返回 `null`。
 */
function completionForMR(events, mergedAt) {
  let before = null;
  let after = null;
  for (const event of events ?? []) {
    if (event.Type !== "run.succeeded" || isZeroTime(event.Timestamp)) {
      continue;
    }
    const at = event.Timestamp;
    if (!timeAfter(at, mergedAt) && timeAfter(at, before)) {
      before = at;
    }
    if (timeAfter(at, mergedAt) && (isZeroTime(after) || timeBefore(at, after))) {
      after = at;
    }
  }
  if (!isZeroTime(before)) {
    return before;
  }
  return after;
}

/**
 * 为单个需求在时间窗口内已合并的每条 MR 计算“运行完成到合并”的延迟样本列表。
 * 在业务域交付指标统计时调用；同一需求下不同仓库的 MR 按条各自作为一个独立样本，区分正常延迟、先合后完成与缺失完成事件三种情况。
 *
 * @param {import("./analytics_business_delivery.js").businessIssueTiming} item - 需求交付计时上下文。
 * @param {Object<string, import("../domain/delivery_mr.js").DeliveryMR[]>} refs - 按运行 ID 索引的交付 MR 引用列表。
 * @param {Map<import("../domain/mr_delivery.js").MRDeliveryKey, import("../domain/mr_delivery.js").MRDeliveryState>|null|undefined} states - 该需求的 MR 交付状态映射（非字符串结构体键，使用 `Map`）。
 * @param {Object<string, import("../domain/run.js").RunEvent[]>} events - 按运行 ID 索引的运行计时事件映射。
 * @param {import("../domain/analytics.js").AnalyticsFilter} filter - 分析查询筛选条件。
 * @returns {businessMergeLatency[]} 该需求下命中的全部已合并 MR 延迟样本数组。
 */
function businessCompletionToMerge(item, refs, states, events, filter) {
  const out = [];
  for (const [key, state] of (states?.entries() ?? [])) {
    if (state.IssueID !== item.issue.ID || isZeroTime(state.MergedAt) || !businessTimeInWindow(state.MergedAt, filter)) {
      continue;
    }
    let completed = null;
    let unknown = false;
    for (const run of item.runs) {
      if (run.ExecutionContext.ParentRunID !== "" || timeAfter(run.CreatedAt, state.MergedAt)) {
        continue;
      }
      let matched = false;
      for (const mr of refs[run.ID] ?? []) {
        if (mr.Project === key.Project && mr.IID === key.IID) {
          matched = true;
          break;
        }
      }
      if (!matched) {
        continue;
      }
      const at = completionForMR(events[run.ID], state.MergedAt);
      if (isZeroTime(at) || timeBefore(at, run.CreatedAt)) {
        unknown = unknown || run.Status === "succeeded";
        continue;
      }
      if (timeAfter(at, completed)) {
        completed = at;
      }
    }
    const latency = new businessMergeLatency({ mergedAt: state.MergedAt, completedAt: completed, missing: unknown || isZeroTime(completed) });
    if (!latency.missing) {
      latency.beforeCompletion = timeBefore(state.MergedAt, completed);
      if (!latency.beforeCompletion) {
        latency.duration = state.MergedAt.getTime() - completed.getTime();
      }
    }
    out.push(latency);
  }
  return out;
}

module.exports = { businessMergeLatency, completionForMR, businessCompletionToMerge };
