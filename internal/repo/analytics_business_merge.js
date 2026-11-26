// analytics_business_merge.js —— 对应 Go 文件：internal/repo/analytics_business_merge.go
// 作用：交付 MR 归属与完成到合入的延迟样本。

"use strict";

const { Artifact } = require("../domain/run.js"); // 对应 Go 的 domain.Artifact，domain 已翻译
const { ResolveRunDeliveryMRs } = require("../domain/delivery_mr.js"); // 对应 Go 的 domain.ResolveRunDeliveryMRs，domain 已翻译
const { AnalyticsRepo, isZeroTime, timeBefore, timeAfter } = require("./analytics.js"); // 对应 Go 同包类型与函数，analytics.js 已翻译

// businessTimeInWindow 在 analytics_business_delivery.js 中定义；两文件循环引用，调用时现取。
function businessTimeInWindow(at, filter) {
  return require("./analytics_business_delivery.js").businessTimeInWindow(at, filter);
}

class businessMergeLatency {
  constructor(init = {}) {
    this.mergedAt = init.mergedAt ?? null;
    this.completedAt = init.completedAt ?? null;
    this.duration = init.duration ?? 0;
    this.missing = init.missing ?? false;
    this.beforeCompletion = init.beforeCompletion ?? false;
  }
}

// Delivery artifacts bind a successful execution round to its own MRs. Later
// unrelated runs and an issue's editable UpdatedAt must not rewrite that cohort.
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
      // Go 按值取运行，Artifacts 追加后写回。
      const run = { ...byID[row.RunID], Artifacts: [...(byID[row.RunID].Artifacts ?? [])] };
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

// completionForMR chooses the latest observed success before merge. A flow
// which auto-merges before it finishes is classified separately, never clamped
// to zero. Later retries of the same Run cannot move an earlier merge cohort.
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

// Each merged MR is one sample. Repositories in the same requirement may
// merge on different days, or while another MR is still open.
function businessCompletionToMerge(item, refs, states, events, filter) {
  const out = [];
  for (const [key, state] of states.entries()) {
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
