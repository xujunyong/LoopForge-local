// delivery.js —— 对应 Go 文件：internal/repo/delivery.go
// 作用：MR 交付状态与交付锁定：MR 行存取、交付标记、基线提升与交付分析聚合。

"use strict";

const { MRDeliveryState, MRDeliveryKey } = require("../domain/mr_delivery.js"); // 对应 Go 的 domain.MRDeliveryState/MRDeliveryKey，domain 已翻译
const { DeliveryMR, ResolveRunDeliveryMRs } = require("../domain/delivery_mr.js"); // 对应 Go 的 domain.DeliveryMR/ResolveRunDeliveryMRs，domain 已翻译
const { Issue } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue，domain 已翻译
const { NormalizeBranchName, ParseDeliveryMRURL, ParseGongfengMRs, MRArtifactPriority, ClassifyMRDeliveryState, AnalyticsMRRank, BaselinePromoteIssueID, IsBaselinePromoteIssueID, EffectiveAnalyticsMRState, KeepMainlineDeliveryLabel, SameGongfengMR, FinalizeAnalyticsDelivery, WorkLandedWithPromote } = require("../domain/mr.js"); // 对应 Go 的 domain.*，domain 已翻译
const { DefaultIntegrateBranch } = require("../domain/sync.js"); // 对应 Go 的 domain.DefaultIntegrateBranch，domain 已翻译
const { AnalyticsDelivery, AnalyticsPhaseSamples, AnalyticsPhaseEvidence } = require("../domain/analytics.js"); // 对应 Go 的 domain.AnalyticsDelivery 等，domain 已翻译
const { WorkflowDefinition, WorkflowNode } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition/WorkflowNode，domain 已翻译
const { Run, Artifact } = require("../domain/run.js"); // 对应 Go 的 domain.Run/Artifact，domain 已翻译
const { Project } = require("../domain/project.js"); // 对应 Go 的 domain.Project，domain 已翻译
const { SOPLaneProduct, SOPLaneDesign, InferSOPLane } = require("../domain/sop_lane.js"); // 对应 Go 的 domain.*，domain 已翻译
const { mrDeliveryStateRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { insertIgnore, upsert, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { runEndedAt, runExecutionDuration } = require("./runs.js"); // 对应 Go 同包函数，runs.js 待翻译
const { BuildRequirementSnapshot } = require("./requirement.js"); // 对应 Go 同包函数，requirement.js 待翻译

// Go 的 time.Time 零值译为 null；timeMs 把 null 换算为 Go 零值时间的毫秒数。
function isZeroTime(t) {
  return t == null;
}
function timeMs(t) {
  return t == null ? -62135596800000 : t.getTime();
}
function timeBefore(a, b) {
  return timeMs(a) < timeMs(b);
}
function timeAfter(a, b) {
  return timeMs(a) > timeMs(b);
}

// analytics.js 与本文件循环引用（analytics.js 用 countDeliveryGroups），调用时现取。
function analyticsRunInWindow(run, filter) {
  return require("./analytics.js").analyticsRunInWindow(run, filter);
}
function analyticsRunMatchesUser(run, userID, issue) {
  return require("./analytics.js").analyticsRunMatchesUser(run, userID, issue);
}
function analyticsRunUserID(run, issue) {
  return require("./analytics.js").analyticsRunUserID(run, issue);
}
function analyticsIssueMatchesSource(issue, source) {
  return require("./analytics.js").analyticsIssueMatchesSource(issue, source);
}
function analyticsIsRequirementIssue(issue) {
  return require("./analytics.js").analyticsIsRequirementIssue(issue);
}
function analyticsWorkflowCategory(snapshot, fallback) {
  return require("./analytics.js").analyticsWorkflowCategory(snapshot, fallback);
}
function analyticsRunDuration(run, now) {
  return require("./analytics.js").analyticsRunDuration(run, now);
}
function usageCostKnown(usage) {
  return require("./analytics.js").usageCostKnown(usage);
}
function runReworks(run) {
  return require("./analytics.js").runReworks(run);
}

mrDeliveryStateRow.prototype.toDomain = function () {
  const item = new MRDeliveryState({
    MRProject: this.MRProject, MRIID: this.MRIID, MRURL: this.MRURL, State: this.State,
    TargetBranch: this.TargetBranch, IssueID: this.IssueID,
  });
  if (this.RegisteredBy != null) {
    item.RegisteredBy = this.RegisteredBy;
  }
  if (this.MergedAt != null) {
    item.MergedAt = this.MergedAt;
  }
  if (this.CheckedAt != null) {
    item.CheckedAt = this.CheckedAt;
  }
  if (this.Created != null) {
    item.CreatedAt = this.Created;
  }
  if (this.Updated != null) {
    item.UpdatedAt = this.Updated;
  }
  return item;
};

function mrDeliveryRowValues(item, now) {
  const checked = timePtr(item.CheckedAt);
  return {
    mr_project: item.MRProject, mr_iid: item.MRIID, mr_url: item.MRURL,
    state: item.State, target_branch: NormalizeBranchName(item.TargetBranch),
    issue_id: item.IssueID, merged_at: timePtr(item.MergedAt), checked_at: checked,
    created_at: timePtr(item.CreatedAt), updated_at: timePtr(now),
  };
}

class DeliveryRepo {
  constructor(init = {}) {
    this.DB = init.DB ?? null;
    this.issues = init.issues ?? null;
    this.tasks = init.tasks ?? null;
    this.catalog = init.catalog ?? null;
    this.runs = init.runs ?? null;
  }

  mrDeliveryState(project, iid) {
    return mrDeliveryStateDB(this.DB, project, iid);
  }

  EnsureMRDeliveryState(project, iid, url, issueID) {
    if (project === "" || iid <= 0) {
      return null;
    }
    url = url.trim();
    issueID = issueID.trim();
    const now = new Date();
    return this.DB.Transaction((tx) => {
      const [existing, ok] = mrDeliveryStateDB(tx, project, iid);
      if (!ok) {
        const [, err] = insertIgnore(tx, "mr_delivery_states", mrDeliveryRowValues(new MRDeliveryState({
          MRProject: project, MRIID: iid, MRURL: url, State: "unknown", IssueID: issueID,
        }), now));
        return err;
      }
      const originalURL = existing.MRURL;
      const originalIssueID = existing.IssueID;
      if (url !== "") {
        existing.MRURL = url;
      }
      if (existing.IssueID === issueID || issueID === BaselinePromoteIssueID) {
        // 保持不变
      } else if (existing.IssueID === BaselinePromoteIssueID) {
        // 基线标记不被降级
      } else if (issueID !== "") {
        existing.IssueID = issueID;
      }
      if (existing.MRURL === originalURL && existing.IssueID === originalIssueID) {
        return null;
      }
      return upsert(tx, "mr_delivery_states", mrDeliveryRowValues(existing, now));
    });
  }

  SetMRDeliveryRegisteredBy(project, iid, userID) {
    if (project === "" || iid <= 0 || userID <= 0) {
      return null;
    }
    return this.DB.Table("mr_delivery_states").
      Where("mr_project = ? AND mr_iid = ? AND registered_by IS NULL", project, iid).
      Update("registered_by", userID).Error;
  }

  UpdateMRDeliveryState(project, iid, state, targetBranch, mergedAt, checkedAt) {
    if (project === "" || iid <= 0) {
      return null;
    }
    state = state.trim();
    if (state === "") {
      state = "unknown";
    }
    targetBranch = NormalizeBranchName(targetBranch);
    if (isZeroTime(checkedAt)) {
      checkedAt = new Date();
    }
    const err = this.recordMRState(project, iid, state, targetBranch, mergedAt, checkedAt);
    if (err != null) {
      return err;
    }
    const classified = this.classifyMRDelivery(new MRDeliveryState({
      MRProject: project,
      State: state,
      TargetBranch: targetBranch,
    }));
    const [existing, ok] = this.mrDeliveryState(project, iid);
    if (!ok) {
      return null;
    }
    if (IsBaselinePromoteIssueID(existing.IssueID)) {
      if (classified === "merged") {
        return this.PromoteIntegratedIssuesIfBaselineLanded(project, checkedAt);
      }
      return null;
    }
    if (existing.IssueID !== "") {
      if (!this.shouldWriteIssueDeliveryFromMR(existing.IssueID, existing.MRURL)) {
        return null;
      }
      if (classified === "merged") {
        return this.MarkIssueDelivered(existing.IssueID, existing.MRURL, checkedAt);
      }
      return this.syncIssueMRState(existing.IssueID, existing.MRURL, classified);
    }
    return null;
  }

  recordMRState(project, iid, state, targetBranch, mergedAt, checkedAt) {
    const values = { state: state, target_branch: NormalizeBranchName(targetBranch), checked_at: checkedAt, updated_at: new Date() };
    if (state !== "merged") {
      values["merged_at"] = null;
    } else if (!isZeroTime(mergedAt)) {
      values["merged_at"] = mergedAt;
    }
    return this.DB.Model(new mrDeliveryStateRow()).
      Where("mr_project = ? AND mr_iid = ?", project, iid).
      Updates(values).Error;
  }

  MarkIssueDelivered(issueID, mrURL, deliveredAt) {
    return this.markIssueDelivered(issueID, singleDeliveryMR(mrURL), deliveredAt, false);
  }

  MarkIssueDeliveredFromSOP(issueID, mrURL, deliveredAt) {
    return this.MarkIssueDeliveredFromSOPMRs(issueID, singleDeliveryMR(mrURL), deliveredAt);
  }

  MarkIssueDeliveredFromSOPMRs(issueID, mrs, deliveredAt) {
    return this.markIssueDelivered(issueID, mrs, deliveredAt, true);
  }

  registerDeliveryMR(issueID, mr, at) {
    let project = mr.Project;
    let iid = mr.IID;
    if (project === "" || iid <= 0) {
      const [p, n, , ok] = ParseDeliveryMRURL(mr.URL);
      if (ok) {
        project = p;
        iid = n;
      }
    }
    if (project === "" || iid <= 0) {
      return "unknown";
    }
    this.EnsureMRDeliveryState(project, iid, mr.URL, issueID);
    const st = mr.GongfengState.trim();
    if (st !== "") {
      this.recordMRState(project, iid, st, mr.TargetBranch, null, at);
    }
    return this.lookupMRDeliveryState(mr.URL);
  }

  markIssueDelivered(issueID, mrs, deliveredAt, fromSOP) {
    issueID = issueID.trim();
    if (issueID === "") {
      return null;
    }
    const [issue, ok] = this.issues.Issue(issueID);
    if (!ok) {
      return null;
    }
    if (isZeroTime(deliveredAt)) {
      deliveredAt = new Date();
    }
    if (issueDeliverySkipped(issue, mrs, deliveredAt, fromSOP)) {
      return null;
    }
    issue.DeliveryState = "merged";
    if (mrs.length > 0 && (fromSOP || (issue.DeliveryMRList() ?? []).length === 0)) {
      const list = [];
      for (const mr of mrs) {
        mr.State = this.registerDeliveryMR(issue.ID, mr, deliveredAt);
        list.push(mr);
      }
      issue.SetDeliveryMRs(list);
    } else {
      for (const mr of mrs) {
        issue.SetDeliveryMRState(mr.URL, this.lookupMRDeliveryState(mr.URL));
      }
      if (fromSOP) {
        const list = issue.DeliveryMRList() ?? [];
        for (let idx = 0; idx < list.length; idx++) {
          list[idx].State = this.lookupMRDeliveryState(list[idx].URL);
        }
        issue.SetDeliveryMRs(list);
      }
    }
    issue.DeliveryUpdatedAt = deliveredAt;
    if (issue.Status !== "closed") {
      issue.Status = "done";
    }
    issue.AutomationState = "ignored";
    return this.issues.PutIssue(issue);
  }

  ReopenDeliveredIssue(issueID) {
    const [issue, ok] = this.issues.Issue(issueID.trim());
    if (!ok) {
      return [new Issue(), new Error("issue not found")];
    }
    if (issue.Status.toLowerCase() !== "closed" && !issue.DeliveryLocked()) {
      return [new Issue(), new Error("工作项尚未完成交付，无需重新打开")];
    }
    if (issue.TrackerClosed()) {
      return [new Issue(), new Error("外部工作项仍处于关闭状态，请先在外部系统重新打开")];
    }
    if (issue.DeliveryLocked()) {
      issue.DeliveryState = "reopened";
    }
    issue.DeliveryUpdatedAt = new Date();
    issue.Status = "todo";
    issue.CloseSource = "";
    issue.AutomationState = "eligible";
    const err = this.issues.PutIssue(issue);
    if (err != null) {
      return [new Issue(), err];
    }
    const [stored] = this.issues.Issue(issue.ID);
    return [stored, null];
  }

  ReconcileMergedMRDeliveries() {
    const rows = [];
    const findErr = this.DB.Where("state = 'merged' AND issue_id <> '' AND issue_id <> ?", BaselinePromoteIssueID).Find(rows).Error;
    if (findErr != null) {
      return findErr;
    }
    const items = [];
    for (const row of rows) {
      if (this.classifyMRDelivery(row.toDomain()) !== "merged") {
        continue;
      }
      let at = null;
      if (row.Updated != null) {
        at = row.Updated;
      }
      if (row.CheckedAt != null) {
        at = row.CheckedAt;
      }
      items.push({ issueID: row.IssueID, mrURL: row.MRURL, at: at });
    }
    for (const item of items) {
      const err = this.MarkIssueDelivered(item.issueID, item.mrURL, item.at);
      if (err != null) {
        return err;
      }
    }
    return null;
  }

  ReconcileUnlinkedDeliveryMRs() {
    const now = new Date();
    for (const issue of this.issues.Issues()) {
      if (!issue.DeliveryLocked() || (issue.DeliveryMRList() ?? []).length > 0) {
        continue;
      }
      const recovered = this.recoverUnlinkedDeliveryMRs(issue);
      if (recovered.length === 0) {
        continue;
      }
      for (let idx = 0; idx < recovered.length; idx++) {
        recovered[idx].State = this.registerDeliveryMR(issue.ID, recovered[idx], now);
      }
      issue.SetDeliveryMRs(recovered);
      const err = this.issues.PutIssue(issue);
      if (err != null) {
        return err;
      }
    }
    return null;
  }

  ReconcileCompletedDeliveries() {
    for (const issue of this.issues.Issues()) {
      if (issue.DeliveryLocked() || issue.DeliveryState.toLowerCase() === "reopened") {
        continue;
      }
      const taskID = issue.LatestTaskID.trim();
      if (taskID === "") {
        continue;
      }
      const [task, ok] = this.tasks.Task(taskID);
      if (!ok || task.Status !== "completed" || task.RunID.trim() === "") {
        continue;
      }
      const [run, runOk] = this.runs.Run(task.RunID);
      if (!runOk || run.Status !== "succeeded") {
        continue;
      }
      let at = run.UpdatedAt;
      if (isZeroTime(at)) {
        at = new Date();
      }
      const err = this.markIssueDelivered(issue.ID, ResolveRunDeliveryMRs(run, null), at, false);
      if (err != null) {
        return err;
      }
    }
    return null;
  }

  ReconcileDeliveryMRStates() {
    for (const issue of this.issues.Issues()) {
      if (!issue.DeliveryLocked()) {
        continue;
      }
      const list = issue.DeliveryMRList() ?? [];
      if (list.length === 0) {
        if (issue.DeliveryMRState !== "") {
          issue.DeliveryMRState = "";
          this.issues.PutIssue(issue);
        }
        continue;
      }
      // Go 的 before := issue 是值复制；JS 对象是引用，快照须在改动前取。
      const before = { ...issue, DeliveryMRs: (issue.DeliveryMRs ?? []).map((mr) => ({ ...mr })) };
      for (let idx = 0; idx < list.length; idx++) {
        const state = this.lookupMRDeliveryState(list[idx].URL);
        if (state === "" || KeepMainlineDeliveryLabel(list[idx].State, state)) {
          continue;
        }
        list[idx].State = state;
      }
      issue.SetDeliveryMRs(list);
      if (deliveryMRFieldsEqual(before, issue)) {
        continue;
      }
      this.issues.PutIssue(issue);
    }
    return this.ReconcileBaselinePromoteDeliveries();
  }

  PromoteIssueToMainline(issueID, mrURL, at) {
    issueID = issueID.trim();
    if (issueID === "") {
      return null;
    }
    const [issue, ok] = this.issues.Issue(issueID);
    if (!ok) {
      return null;
    }
    if (issue.DeliveryState.toLowerCase() === "reopened") {
      return null;
    }
    if (isZeroTime(at)) {
      at = new Date();
    }
    let changed = false;
    if (issue.DeliveryState !== "merged") {
      issue.DeliveryState = "merged";
      if (issue.Status !== "closed") {
        issue.Status = "done";
      }
      issue.AutomationState = "ignored";
      changed = true;
    }
    const before = { ...issue, DeliveryMRs: (issue.DeliveryMRs ?? []).map((mr) => ({ ...mr })) };
    const trimmed = mrURL.trim();
    if (trimmed !== "") {
      issue.SetDeliveryMRState(trimmed, "merged");
    } else if ((issue.DeliveryMRList() ?? []).length === 0) {
      issue.DeliveryMRState = "merged";
    }
    if (!deliveryMRFieldsEqual(before, issue)) {
      changed = true;
    }
    if (timeAfter(at, issue.DeliveryUpdatedAt)) {
      issue.DeliveryUpdatedAt = at;
      changed = true;
    }
    if (!changed) {
      return null;
    }
    return this.issues.PutIssue(issue);
  }

  PromoteIntegratedIssuesIfBaselineLanded(_project, _at) {
    return null;
  }

  ReconcileBaselinePromoteDeliveries() {
    return null;
  }

  promoteIntegratedIssues(project, promoteAt) {
    const seen = new Set();
    const rows = [];
    const findErr = this.DB.Where("mr_project = ? AND issue_id <> '' AND issue_id <> ?", project, BaselinePromoteIssueID).Find(rows).Error;
    if (findErr != null) {
      return findErr;
    }
    for (const row of rows) {
      const item = row.toDomain();
      if (IsBaselinePromoteIssueID(item.IssueID)) {
        continue;
      }
      let at = item.UpdatedAt;
      if (!isZeroTime(item.CheckedAt)) {
        at = item.CheckedAt;
      }
      if (this.classifyMRDelivery(new MRDeliveryState({ MRProject: project, State: item.State, TargetBranch: item.TargetBranch })) !== "integrated") {
        continue;
      }
      if (!WorkLandedWithPromote(at, promoteAt)) {
        continue;
      }
      const err = this.PromoteIssueToMainline(item.IssueID, item.MRURL, promoteAt);
      if (err != null) {
        return err;
      }
      seen.add(item.IssueID);
    }
    for (const issue of this.issues.Issues()) {
      if (seen.has(issue.ID)) {
        continue;
      }
      if (!WorkLandedWithPromote(issue.DeliveryUpdatedAt, promoteAt)) {
        continue;
      }
      for (const mr of issue.DeliveryMRList() ?? []) {
        if (mr.State.toLowerCase() !== "integrated") {
          continue;
        }
        const [proj, , , ok] = ParseDeliveryMRURL(mr.URL);
        if (!ok || proj.trim().toLowerCase() !== project.trim().toLowerCase()) {
          continue;
        }
        const err = this.PromoteIssueToMainline(issue.ID, mr.URL, promoteAt);
        if (err != null) {
          return err;
        }
      }
    }
    return null;
  }

  recoverUnlinkedDeliveryMRs(issue) {
    if (this.tasks == null || this.runs == null) {
      return null;
    }
    const taskID = issue.LatestTaskID.trim();
    if (taskID === "") {
      return null;
    }
    const [task, ok] = this.tasks.Task(taskID);
    if (!ok || task.RunID.trim() === "") {
      return null;
    }
    const [run, runOk] = this.runs.Run(task.RunID);
    if (!runOk || run.Status !== "succeeded") {
      return null;
    }
    return ResolveRunDeliveryMRs(run, null);
  }

  MergedWorkMRs(project) {
    project = project.trim();
    if (project === "") {
      return [null, null];
    }
    const rows = [];
    const findErr = this.DB.Where("mr_project = ? AND state = ? AND issue_id <> '' AND issue_id <> ?", project, "merged", BaselinePromoteIssueID).Find(rows).Error;
    if (findErr != null) {
      return [null, findErr];
    }
    const out = [];
    for (const row of rows) {
      out.push(row.toDomain());
    }
    return [out, null];
  }

  ApplyDefaultBranchLanding(issueID, mrURL, onDefault) {
    if (onDefault) {
      return this.PromoteIssueToMainline(issueID, mrURL, new Date());
    }
    return this.demoteIssueToBaseline(issueID, mrURL);
  }

  demoteIssueToBaseline(issueID, mrURL) {
    const [issue, ok] = this.issues.Issue(issueID.trim());
    if (!ok || issue.DeliveryState.toLowerCase() === "reopened") {
      return null;
    }
    mrURL = mrURL.trim();
    if (mrURL === "" || issue.DeliveryMRState.toLowerCase() !== "merged") {
      return null;
    }
    const before = { ...issue, DeliveryMRs: (issue.DeliveryMRs ?? []).map((mr) => ({ ...mr })) };
    if (!issue.SetDeliveryMRState(mrURL, "integrated")) {
      return null;
    }
    if (deliveryMRFieldsEqual(before, issue)) {
      return null;
    }
    return this.issues.PutIssue(issue);
  }

  lookupMRDeliveryState(mrURL) {
    const [project, iid, , ok] = ParseDeliveryMRURL(mrURL);
    if (!ok) {
      return "";
    }
    const states = this.MRDeliveryStatesMap([new MRDeliveryKey({ Project: project, IID: iid })]);
    const st = states[`${project}\x00${iid}`];
    if (st !== undefined) {
      const classified = this.classifyMRDelivery(st);
      if (classified !== "") {
        return classified;
      }
    }
    return "unknown";
  }

  classifyMRDelivery(st) {
    const [def, integ] = this.branchContextForMRProject(st.MRProject);
    return ClassifyMRDeliveryState(st.State, st.TargetBranch, def, integ);
  }

  branchContextForMRProject(project) {
    let integrate = DefaultIntegrateBranch;
    project = project.trim();
    if (project === "") {
      return ["", integrate];
    }
    for (const repo of this.catalog.Repositories()) {
      if (repo.GongfengProjectID.trim().toLowerCase() === project.toLowerCase()) {
        return [repo.DefaultBranch.trim(), repo.IntegrateBranch.trim()];
      }
    }
    return ["", integrate];
  }

  shouldWriteIssueDeliveryFromMR(issueID, mrURL) {
    const [issue, ok] = this.issues.Issue(issueID.trim());
    if (!ok) {
      return false;
    }
    if ((issue.DeliveryMRList() ?? []).length === 0) {
      return true;
    }
    return issue.HasDeliveryMR(mrURL);
  }

  syncIssueMRState(issueID, mrURL, state) {
    const [issue, ok] = this.issues.Issue(issueID.trim());
    if (!ok) {
      return null;
    }
    if (!this.shouldWriteIssueDeliveryFromMR(issue.ID, mrURL)) {
      return null;
    }
    state = state.trim();
    if (mrURL.trim() === "" || state === "") {
      return null;
    }
    const before = { ...issue, DeliveryMRs: (issue.DeliveryMRs ?? []).map((mr) => ({ ...mr })) };
    issue.SetDeliveryMRState(mrURL, state);
    if (deliveryMRFieldsEqual(before, issue)) {
      return null;
    }
    return this.issues.PutIssue(issue);
  }
}

function mrDeliveryStateDB(db, project, iid) {
  const row = new mrDeliveryStateRow();
  if (db.Where("mr_project = ? AND mr_iid = ?", project, iid).Take(row).Error != null) {
    return [new MRDeliveryState(), false];
  }
  return [row.toDomain(), true];
}

function singleDeliveryMR(mrURL) {
  mrURL = mrURL.trim();
  if (mrURL === "") {
    return null;
  }
  const mr = new DeliveryMR({ URL: mrURL });
  const [project, iid, , ok] = ParseDeliveryMRURL(mrURL);
  if (ok) {
    mr.Project = project;
    mr.IID = iid;
  }
  return [mr];
}

function issueDeliverySkipped(issue, mrs, deliveredAt, fromSOP) {
  if (issue.ManuallyClosed()) {
    return true;
  }
  if (issue.DeliveryState.toLowerCase() === "reopened" && !fromSOP) {
    return true;
  }
  if (!fromSOP) {
    for (const mr of mrs ?? []) {
      if ((issue.DeliveryMRList() ?? []).length > 0 && !issue.HasDeliveryMR(mr.URL)) {
        return true;
      }
    }
  }
  return issue.DeliveryState === "merged" && !(timeMs(deliveredAt) > timeMs(issue.DeliveryUpdatedAt));
}

function deliveryMRFieldsEqual(a, b) {
  if (a.DeliveryMRURL !== b.DeliveryMRURL || a.DeliveryMRState !== b.DeliveryMRState || (a.DeliveryMRs ?? []).length !== (b.DeliveryMRs ?? []).length) {
    return false;
  }
  for (let i = 0; i < (a.DeliveryMRs ?? []).length; i++) {
    // Go 按值比较结构体；JS 按 JSON 比较字段值。
    if (JSON.stringify(a.DeliveryMRs[i]) !== JSON.stringify(b.DeliveryMRs[i])) {
      return false;
    }
  }
  return true;
}

DeliveryRepo.prototype.MRDeliveryStatesMap = function (keys) {
  const out = {};
  if (keys.length === 0) {
    return out;
  }
  const conditions = [];
  const args = [];
  for (const k of keys) {
    if (k.Project === "" || k.IID <= 0) {
      continue;
    }
    conditions.push("(mr_project = ? AND mr_iid = ?)");
    args.push(k.Project, k.IID);
  }
  if (conditions.length === 0) {
    return out;
  }
  const rows = [];
  if (this.DB.Where(conditions.join(" OR "), ...args).Find(rows).Error != null) {
    return out;
  }
  for (const row of rows) {
    const item = row.toDomain();
    // Go 用结构体值作 map 键；JS 用 project 与 iid 拼成的字符串键代替。
    out[`${item.MRProject}\x00${item.MRIID}`] = item;
  }
  return out;
};

DeliveryRepo.prototype.MRDeliveryStatesNeedingRefresh = function (staleBefore) {
  const rows = [];
  const findErr = this.DB.
    Where("(state NOT IN ('merged', 'closed') OR (state='merged' AND (target_branch='' OR merged_at IS NULL))) AND (checked_at IS NULL OR checked_at < ?)", staleBefore).
    Order("checked_at IS NULL DESC, checked_at ASC").
    Find(rows).Error;
  if (findErr != null) {
    return [null, findErr];
  }
  const out = [];
  for (const row of rows) {
    out.push(row.toDomain());
  }
  return [out, null];
};

DeliveryRepo.prototype.ListMRDeliveryStates = function () {
  const rows = [];
  const findErr = this.DB.Order("updated_at DESC").Find(rows).Error;
  if (findErr != null) {
    return [null, findErr];
  }
  const out = [];
  for (const row of rows) {
    out.push(row.toDomain());
  }
  return [out, null];
};

DeliveryRepo.prototype.DiscoverMRDeliveryStatesFromArtifacts = function () {
  const rows = [];
  const findErr = this.DB.Table("run_artifacts").
    Joins("JOIN runs r ON r.id = run_artifacts.run_id").
    Where("run_artifacts.content LIKE ? AND (run_artifacts.name IN ('mr-body','e2e-report','closeout') OR run_artifacts.node_id='mr' OR run_artifacts.name LIKE '%mr%') AND run_artifacts.name NOT LIKE '%patch%' AND run_artifacts.name NOT LIKE '%diff%'", "%merge_requests/%").
    Select("r.execution_context AS execution_context, run_artifacts.name AS name, run_artifacts.node_id AS node_id, run_artifacts.content AS content").
    Find(rows).Error;
  if (findErr != null) {
    return findErr;
  }
  const seen = {};
  for (const row of rows) {
    const pri = MRArtifactPriority(row.Name, "", row.NodeID);
    if (pri <= 0) {
      continue;
    }
    const issueID = issueIDFromExecutionContext(row.ExecutionContext);
    for (const ref of ParseGongfengMRs(row.Content)) {
      const key = ref.Project + "#" + String(ref.IID);
      const cur = seen[key];
      if (cur !== undefined && (cur.pri > pri || (cur.pri === pri && cur.url.length >= ref.URL.length))) {
        continue;
      }
      seen[key] = { project: ref.Project, iid: ref.IID, url: ref.URL, issueID: issueID, pri: pri };
    }
  }
  for (const item of Object.values(seen)) {
    const err = this.EnsureMRDeliveryState(item.project, item.iid, item.url, item.issueID);
    if (err != null) {
      return err;
    }
  }
  return null;
};

function issueIDFromExecutionContext(raw) {
  raw = raw.trim();
  if (raw === "") {
    return "";
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  // Go 按 json tag issueId 解码；JS 构造器认 Go 字段名，直接读小驼峰键。
  return (parsed.issueId ?? parsed.IssueID ?? "").trim();
}

class deliveryAcc {
  constructor(init = {}) {
    this.item = init.item ?? new AnalyticsDelivery();
    this.latest = init.latest ?? null;
    this.latestRun = init.latestRun ?? new Run();
    this.mrAt = init.mrAt ?? null;
    this.displayRank = init.displayRank ?? 0;
    this.mrs = init.mrs ?? [];
    this.execDuration = init.execDuration ?? 0;
    this.runCount = init.runCount ?? 0;
    this.failedRuns = init.failedRuns ?? 0;
    this.reworks = init.reworks ?? 0;
    this.firstRunAt = init.firstRunAt ?? null;
    this.lastRunAt = init.lastRunAt ?? null;
    this.costKnown = init.costKnown ?? false;
    this.runs = init.runs ?? [];
    this.clarificationDuration = init.clarificationDuration ?? 0;
    this.developmentDuration = init.developmentDuration ?? 0;
    this.testDuration = init.testDuration ?? 0;
    this.clarificationStart = init.clarificationStart ?? null;
    this.clarificationSource = init.clarificationSource ?? "";
    this.developmentStart = init.developmentStart ?? null;
    this.developmentSource = init.developmentSource ?? "";
    this.developmentRunID = init.developmentRunID ?? "";
    this.phaseSamples = init.phaseSamples ?? new AnalyticsPhaseSamples();
    this.phaseEvidence = init.phaseEvidence ?? [];
    this.unclassifiedPhaseNodes = init.unclassifiedPhaseNodes ?? 0;
  }

  addMR(project, iid, url, at, sourceRank) {
    for (let i = 0; i < this.mrs.length; i++) {
      if (this.mrs[i].project === project && this.mrs[i].iid === iid) {
        if (url !== "" && this.mrs[i].url === "") {
          this.mrs[i].url = url;
        }
        if (timeAfter(at, this.mrs[i].createdAt)) {
          this.mrs[i].createdAt = at;
        }
        if (sourceRank > this.mrs[i].sourceRank) {
          this.mrs[i].sourceRank = sourceRank;
        }
        return;
      }
    }
    this.mrs.push(new mrRef({ project: project, iid: iid, url: url, createdAt: at, sourceRank: sourceRank }));
  }

  addMRsFromText(text, at, sourceRank) {
    const refs = ParseGongfengMRs(text);
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      this.addMR(ref.Project, ref.IID, ref.URL, at, sourceRank);
      if (i > 0) {
        continue;
      }
      if (this.item.MRURL !== "" && sourceRank < this.displayRank) {
        continue;
      }
      if (this.item.MRURL !== "" && sourceRank === this.displayRank && !timeAfter(at, this.mrAt)) {
        continue;
      }
      this.displayRank = sourceRank;
      this.mrAt = at;
      this.item.MRURL = ref.URL;
      this.item.MRProject = ref.Project;
      this.item.MRIID = ref.IID;
      this.item.MRState = "unknown";
    }
  }
}

function requirementPhaseDurations(run, fallback) {
  const measurements = requirementPhaseMeasurements(run, fallback);
  return [measurements.clarification, measurements.development, measurements.test];
}

class phaseMeasurements {
  constructor(init = {}) {
    this.clarification = init.clarification ?? 0;
    this.development = init.development ?? 0;
    this.test = init.test ?? 0;
    this.clarificationStart = init.clarificationStart ?? null;
    this.clarificationStartSource = init.clarificationStartSource ?? "";
    this.developmentStart = init.developmentStart ?? null;
    this.developmentStartSource = init.developmentStartSource ?? "";
    this.samples = init.samples ?? new AnalyticsPhaseSamples();
    this.evidence = init.evidence ?? [];
    this.unclassified = init.unclassified ?? 0;
  }
}

function requirementPhaseMeasurements(run, fallback) {
  const result = new phaseMeasurements();
  let workflow = run.WorkflowSnapshot;
  const frozenDefinition = workflow.ID !== "";
  if (workflow.ID === "") {
    workflow = fallback;
  }
  const definitions = {};
  for (const node of workflow.Nodes ?? []) {
    definitions[node.ID] = node;
  }
  const lane = InferSOPLane(workflow);
  for (const [nodeID, nodeRun] of Object.entries(run.Nodes ?? {})) {
    if (nodeRun == null || isZeroTime(nodeRun.StartedAt)) {
      continue;
    }
    const definition = definitions[nodeID] ?? new WorkflowNode();
    if (definition.Type === "sop") {
      continue;
    }
    const [stage, source] = nodeMetricStage(nodeID, definition, lane, frozenDefinition);
    if (stage === "clarification" && (isZeroTime(result.clarificationStart) || timeBefore(nodeRun.StartedAt, result.clarificationStart))) {
      result.clarificationStart = nodeRun.StartedAt;
      result.clarificationStartSource = source;
    }
    if (stage === "development" && (isZeroTime(result.developmentStart) || timeBefore(nodeRun.StartedAt, result.developmentStart))) {
      result.developmentStart = nodeRun.StartedAt;
      result.developmentStartSource = source;
    }
    if (isZeroTime(nodeRun.FinishedAt) || timeBefore(nodeRun.FinishedAt, nodeRun.StartedAt)) {
      continue;
    }
    const duration = nodeRun.FinishedAt.getTime() - nodeRun.StartedAt.getTime();
    switch (stage) {
      case "clarification":
        result.clarification += duration;
        result.samples.Clarification++;
        break;
      case "development":
        result.development += duration;
        result.samples.Development++;
        break;
      case "testing":
        result.test += duration;
        result.samples.Testing++;
        break;
      default:
        if (stage !== "none") {
          result.unclassified++;
        }
        continue;
    }
    if (source === "inferred") {
      result.samples.Inferred++;
    }
    result.evidence.push(new AnalyticsPhaseEvidence({
      RunID: run.ID, NodeID: nodeID, Stage: stage, Source: source, DurationMs: duration,
    }));
  }
  result.evidence.sort((a, b) => {
    if (a.RunID !== b.RunID) {
      return a.RunID < b.RunID ? -1 : 1;
    }
    if (a.NodeID !== b.NodeID) {
      return a.NodeID < b.NodeID ? -1 : 1;
    }
    return 0;
  });
  return result;
}

function nodeMetricStage(nodeID, definition, lane, frozenDefinition) {
  const stage = definition.MetricStage.trim();
  if (stage === "") {
    return [inferLegacyMetricStage(nodeID, definition.Name, lane), "inferred"];
  }
  if (!frozenDefinition) {
    return [stage, "inferred"];
  }
  return [stage, "explicit"];
}

function inferLegacyMetricStage(nodeID, name, lane) {
  const text = (nodeID + " " + name).trim().toLowerCase();
  if (text.includes("澄清") || text.includes("需求确认") || text.includes("clarif") || text.includes("requirement-shaping")) {
    return "clarification";
  }
  if (text.includes("测试") || text.includes("验证") || text.includes("验收") || text.includes("test") || text.includes("verify") || text.includes(" qa")) {
    return "testing";
  }
  if (text.includes("研发") || text.includes("开发") || text.includes("前端") || text.includes("后端") || text.includes("implement") || text.includes("coding") || text.includes("frontend") || text.includes("backend")) {
    return "development";
  }
  if (lane === SOPLaneProduct || lane === SOPLaneDesign) {
    return "clarification";
  }
  return "";
}

class mrRef {
  constructor(init = {}) {
    this.project = init.project ?? "";
    this.iid = init.iid ?? 0;
    this.url = init.url ?? "";
    this.createdAt = init.createdAt ?? null;
    this.sourceRank = init.sourceRank ?? 0;
  }
}

function deliveryGroupKey(issueID, issue, run) {
  const externalID = issue.RequirementTAPDID();
  if (externalID !== "") {
    let projectID = issue.ProjectID.trim();
    if (projectID === "") {
      projectID = run.ExecutionContext.ProjectID.trim();
    }
    return "tapd\x00" + projectID + "\x00" + externalID;
  }
  return "issue\x00" + issueID;
}

function deliveryRunIssueID(filter, run, issues) {
  const issueID = run.ExecutionContext.IssueID.trim();
  if (issueID === "") {
    return ["", false];
  }
  if (filter.WorkflowID !== "" && run.WorkflowID !== filter.WorkflowID) {
    return ["", false];
  }
  if (!analyticsRunInWindow(run, filter)) {
    return ["", false];
  }
  const issue = issues[issueID] ?? new Issue();
  if (filter.UserID !== "" && !analyticsRunMatchesUser(run, filter.UserID, issue)) {
    return ["", false];
  }
  if (filter.IssueSource !== "" && !analyticsIssueMatchesSource(issue, filter.IssueSource)) {
    return ["", false];
  }
  if (filter.RequirementsOnly && !analyticsIsRequirementIssue(issue)) {
    return ["", false];
  }
  return [issueID, true];
}

function countDeliveryGroups(filter, runs, issues) {
  const groups = new Set();
  for (const run of runs) {
    const [issueID, ok] = deliveryRunIssueID(filter, run, issues);
    if (!ok) {
      continue;
    }
    groups.add(deliveryGroupKey(issueID, issues[issueID] ?? new Issue(), run));
  }
  return groups.size;
}

DeliveryRepo.prototype.buildDeliveries = function (filter, now, runs, workflowDefs, issues) {
  const byIssue = {};
  if (issues == null) {
    issues = {};
    for (const issue of this.issues.Issues()) {
      issues[issue.ID] = issue;
    }
  }
  const clarificationByGroup = {};
  for (const [issueID, issue] of Object.entries(issues)) {
    const started = issue.Clarification.StartedAt;
    if (isZeroTime(started)) {
      continue;
    }
    const key = deliveryGroupKey(issueID, issue, new Run());
    const prior = clarificationByGroup[key] ?? null;
    if (prior == null || timeBefore(started, prior)) {
      clarificationByGroup[key] = started;
    }
  }
  const mrRuns = [];
  for (const run of runs) {
    const [, ok] = deliveryRunIssueID(filter, run, issues);
    if (ok) {
      mrRuns.push(run);
    }
  }
  const mrText = this.mrTextsByRun(mrRuns);
  for (const run of runs) {
    const [issueID, ok] = deliveryRunIssueID(filter, run, issues);
    if (!ok) {
      continue;
    }
    const groupKey = deliveryGroupKey(issueID, issues[issueID] ?? new Issue(), run);
    let acc = byIssue[groupKey] ?? null;
    if (acc == null) {
      acc = new deliveryAcc({ item: new AnalyticsDelivery({ IssueID: issueID, MRState: "none" }), costKnown: true });
      const started = clarificationByGroup[groupKey] ?? null;
      if (!isZeroTime(started)) {
        acc.clarificationStart = started;
        acc.clarificationSource = "recorded";
      }
      byIssue[groupKey] = acc;
    }
    acc.item.Tokens += run.Usage.TotalTokens;
    acc.item.CostUSD += run.Usage.CostUSD;
    acc.costKnown = acc.costKnown && usageCostKnown(run.Usage);
    if (run.IsWorkspace()) {
      if (isZeroTime(acc.firstRunAt) || timeBefore(run.CreatedAt, acc.firstRunAt)) {
        acc.firstRunAt = run.CreatedAt;
      }
      const ended = run.UpdatedAt;
      if (timeAfter(ended, acc.lastRunAt)) {
        acc.lastRunAt = ended;
      }
      if (acc.latestRun.ID === "" || (acc.latestRun.IsWorkspace() && timeAfter(run.CreatedAt, acc.latest))) {
        acc.latest = run.CreatedAt;
        acc.latestRun = run;
        acc.item.IssueID = issueID;
      }
      continue;
    }
    const nested = run.ExecutionContext.ParentRunID.trim() !== "";
    if (!nested) {
      acc.execDuration += runExecutionDuration(run);
    }
    const phase = requirementPhaseMeasurements(run, workflowDefs[run.WorkflowID] ?? new WorkflowDefinition());
    acc.developmentDuration += phase.development;
    acc.testDuration += phase.test;
    acc.phaseSamples.Development += phase.samples.Development;
    acc.phaseSamples.Testing += phase.samples.Testing;
    acc.phaseSamples.Inferred += phase.samples.Inferred;
    for (const evidence of phase.evidence) {
      if (evidence.Stage !== "clarification") {
        acc.phaseEvidence.push(evidence);
      }
    }
    {
      const started = phase.clarificationStart;
      if (!isZeroTime(started) && (isZeroTime(acc.clarificationStart) || timeBefore(started, acc.clarificationStart))) {
        acc.clarificationStart = started;
        acc.clarificationSource = phase.clarificationStartSource;
      }
    }
    {
      const started = phase.developmentStart;
      if (!isZeroTime(started) && (isZeroTime(acc.developmentStart) || timeBefore(started, acc.developmentStart))) {
        acc.developmentStart = started;
        acc.developmentSource = phase.developmentStartSource;
        acc.developmentRunID = run.ID;
      }
    }
    acc.unclassifiedPhaseNodes += phase.unclassified;
    acc.reworks += runReworks(run);
    if (!nested) {
      acc.runCount++;
      if (run.Status === "failed") {
        acc.failedRuns++;
      }
    }
    if (isZeroTime(acc.firstRunAt) || timeBefore(run.CreatedAt, acc.firstRunAt)) {
      acc.firstRunAt = run.CreatedAt;
    }
    const ended = runEndedAt(run, now);
    if (timeAfter(ended, acc.lastRunAt)) {
      acc.lastRunAt = ended;
    }
    const latestNested = acc.latestRun.ExecutionContext.ParentRunID.trim() !== "";
    const newer = isZeroTime(acc.latest) || timeAfter(run.CreatedAt, acc.latest);
    if (acc.latestRun.ID === "" || acc.latestRun.IsWorkspace() || (!nested && (latestNested || newer)) || (nested && latestNested && newer)) {
      acc.latest = run.CreatedAt;
      acc.latestRun = run;
      acc.item.IssueID = issueID;
    }
    acc.runs.push(run);
    let text = mrText[run.ID] ?? "";
    if (text === "") {
      text = runMRText(run);
    }
    acc.addMRsFromText(text, run.CreatedAt, 40);
  }
  const out = [];
  const mrsByIssue = {};
  const projectCache = {};
  for (const acc of Object.values(byIssue)) {
    const issueID = acc.item.IssueID;
    const run = acc.latestRun;
    acc.item.RunID = run.ID;
    acc.item.RunStatus = run.Status;
    acc.item.SOPSucceeded = !run.IsWorkspace() && run.Status === "succeeded";
    acc.item.DirectDelivery = run.IsWorkspace();
    acc.item.WorkflowID = run.WorkflowID;
    acc.item.WorkflowName = run.WorkflowSnapshot.Name;
    if (run.IsWorkspace()) {
      acc.item.WorkflowName = "对话改代码";
    }
    if (acc.item.WorkflowName === "") {
      acc.item.WorkflowName = (workflowDefs[run.WorkflowID] ?? new WorkflowDefinition()).Name;
    }
    if (acc.item.WorkflowName === "") {
      acc.item.WorkflowName = run.WorkflowID;
    }
    let duration;
    [duration] = analyticsRunDuration(run, now);
    if (run.IsWorkspace()) {
      duration = 0;
    }
    acc.item.DurationMs = duration;
    acc.item.RunCount = acc.runCount;
    acc.item.FailedRuns = acc.failedRuns;
    acc.item.Reworks = acc.reworks;
    acc.item.ExecutionDurationMs = acc.execDuration;
    if (!isZeroTime(acc.clarificationStart) && !isZeroTime(acc.developmentStart) && !timeBefore(acc.developmentStart, acc.clarificationStart)) {
      acc.clarificationDuration = acc.developmentStart.getTime() - acc.clarificationStart.getTime();
      acc.phaseSamples.Clarification = 1;
      acc.item.ClarificationStartedAt = acc.clarificationStart;
      acc.item.DevelopmentStartedAt = acc.developmentStart;
      let source = "explicit";
      if (acc.clarificationSource === "inferred" || acc.developmentSource === "inferred") {
        source = "inferred";
      }
      acc.phaseEvidence.push(new AnalyticsPhaseEvidence({ RunID: acc.developmentRunID, NodeID: "clarification-to-development", Stage: "clarification", Source: source, DurationMs: acc.clarificationDuration, StartedAt: acc.clarificationStart, FinishedAt: acc.developmentStart }));
    }
    acc.item.ClarificationDurationMs = acc.clarificationDuration;
    acc.item.DevelopmentDurationMs = acc.developmentDuration;
    acc.item.TestDurationMs = acc.testDuration;
    acc.item.PhaseSamples = acc.phaseSamples;
    acc.item.PhaseEvidence = acc.phaseEvidence;
    acc.item.UnclassifiedPhaseNodes = acc.unclassifiedPhaseNodes;
    acc.item.FirstRunAt = acc.firstRunAt;
    acc.item.LastRunAt = acc.lastRunAt;
    if (!isZeroTime(acc.firstRunAt) && timeAfter(acc.lastRunAt, acc.firstRunAt)) {
      acc.item.CycleDurationMs = acc.lastRunAt.getTime() - acc.firstRunAt.getTime();
    }
    acc.item.UserID = analyticsRunUserID(run, issues[issueID] ?? new Issue());
    acc.item.Category = analyticsWorkflowCategory(run.WorkflowSnapshot, workflowDefs[run.WorkflowID] ?? new WorkflowDefinition());
    acc.item.CostKnown = acc.costKnown;
    let project = new Project();
    const issue = issues[issueID];
    if (issue !== undefined && this.catalog != null && this.catalog.projects != null) {
      let cached = projectCache[issue.ProjectID];
      if (cached === undefined) {
        [cached] = this.catalog.projects.Project(issue.ProjectID);
        projectCache[issue.ProjectID] = cached;
      }
      project = cached;
    }
    acc.item.Lanes = compactDeliveryLanes(BuildRequirementSnapshot(issues[issueID] ?? new Issue(), project, acc.runs, null, workflowDefs, now).Lanes);
    if (issue !== undefined) {
      acc.item.Title = issue.Title;
      acc.item.Source = issue.Source;
      if (acc.item.Source === "") {
        acc.item.Source = "local";
      }
      if (issue.ExternalRef != null) {
        acc.item.ExternalIID = issue.ExternalRef.ExternalIID;
        acc.item.IssueURL = issue.ExternalRef.ExternalURL;
      }
      acc.item.ExternalID = issue.RequirementTAPDID();
      for (const mr of issue.DeliveryMRList() ?? []) {
        acc.addMRsFromText(mr.URL, issue.DeliveryUpdatedAt, 100);
      }
    } else {
      acc.item.Title = issueID;
      acc.item.Source = "local";
    }
    if (acc.item.MRURL === "") {
      acc.item.MRState = "none";
    }
    mrsByIssue[issueID] = acc.mrs;
    out.push(acc.item);
  }
  out.sort((a, b) => {
    if (a.Delivered !== b.Delivered) {
      return a.Delivered ? -1 : 1;
    }
    if (a.SOPSucceeded !== b.SOPSucceeded) {
      return a.SOPSucceeded ? -1 : 1;
    }
    if (a.RunID !== b.RunID) {
      return a.RunID > b.RunID ? -1 : 1;
    }
    return 0;
  });
  this.applyMRDeliveryStates(out, mrsByIssue, issues);
  return out;
};

function overlayIssueMRState(state, url, own) {
  for (const mr of own ?? []) {
    if (!SameGongfengMR(mr.URL, url)) {
      continue;
    }
    if (state === "" || state === "unknown") {
      if (mr.State !== "") {
        return mr.State;
      }
      return state;
    }
    return EffectiveAnalyticsMRState(state, mr.State);
  }
  return state;
}

DeliveryRepo.prototype.applyMRDeliveryStates = function (items, mrsByIssue, issues) {
  if (items.length === 0) {
    return;
  }
  const keySet = {};
  const ensured = new Set();
  const ensure = (project, iid, url, issueID) => {
    if (project === "" || iid <= 0) {
      return;
    }
    const ensureKey = `${project}\x00${iid}\x00${url}\x00${issueID}`;
    if (!ensured.has(ensureKey)) {
      this.EnsureMRDeliveryState(project, iid, url, issueID);
      ensured.add(ensureKey);
    }
    keySet[`${project}\x00${iid}`] = true;
  };
  for (let i = 0; i < items.length; i++) {
    for (const ref of mrsByIssue[items[i].IssueID] ?? []) {
      ensure(ref.project, ref.iid, ref.url, items[i].IssueID);
    }
    ensure(items[i].MRProject, items[i].MRIID, items[i].MRURL, items[i].IssueID);
  }
  if (Object.keys(keySet).length === 0) {
    for (let i = 0; i < items.length; i++) {
      const issue = issues[items[i].IssueID];
      if (issue !== undefined) {
        items[i].MRState = EffectiveAnalyticsMRState(items[i].MRState, issue.DeliveryMRState);
      }
      FinalizeAnalyticsDelivery(items[i]);
    }
    return;
  }
  const keys = [];
  for (const k of Object.keys(keySet)) {
    const [project, iid] = k.split("\x00");
    keys.push(new MRDeliveryKey({ Project: project, IID: Number(iid) }));
  }
  const states = this.MRDeliveryStatesMap(keys);
  const repositories = this.catalog.Repositories();
  const classify = (st) => {
    let def = "";
    let integ = DefaultIntegrateBranch;
    for (const repository of repositories) {
      if (repository.GongfengProjectID.trim().toLowerCase() === st.MRProject.trim().toLowerCase()) {
        def = repository.DefaultBranch.trim();
        integ = repository.IntegrateBranch.trim();
        break;
      }
    }
    return ClassifyMRDeliveryState(st.State, st.TargetBranch, def, integ);
  };
  for (let i = 0; i < items.length; i++) {
    let preferProject = "";
    let preferIID = 0;
    const issueForPrefer = issues[items[i].IssueID];
    if (issueForPrefer !== undefined) {
      const [p, iid, , ok] = ParseDeliveryMRURL(issueForPrefer.DeliveryMRURL);
      if (ok) {
        preferProject = p;
        preferIID = iid;
      }
    }
    const own = (issues[items[i].IssueID] ?? new Issue()).DeliveryMRList() ?? [];
    let best = null;
    let bestState = "";
    items[i].MRs = [];
    const seen = {};
    for (const ref of mrsByIssue[items[i].IssueID] ?? []) {
      if (ref.project === "" || ref.iid <= 0) {
        continue;
      }
      const st = states[`${ref.project}\x00${ref.iid}`];
      const ok = st !== undefined;
      const mr = new DeliveryMR({ Project: ref.project, IID: ref.iid, URL: ref.url, State: "unknown", TargetBranch: st !== undefined ? st.TargetBranch : "" });
      if (ok) {
        mr.State = classify(st);
      }
      mr.State = overlayIssueMRState(mr.State, mr.URL, own);
      const key = `${ref.project.toLowerCase()}\x00${ref.iid}`;
      if (!seen[key]) {
        items[i].MRs.push(mr);
        seen[key] = true;
      }
      if (!ok) {
        continue;
      }
      const classified = classify(st);
      if (classified === "") {
        continue;
      }
      if (best == null || betterAnalyticsMR(preferProject, preferIID, best, bestState, ref, classified)) {
        best = { ...ref };
        bestState = classified;
      }
    }
    if (best != null && AnalyticsMRRank(bestState) > 0) {
      items[i].MRProject = best.project;
      items[i].MRIID = best.iid;
      if (best.url !== "") {
        items[i].MRURL = best.url;
      }
      items[i].MRState = bestState;
    } else if (items[i].MRProject !== "" && items[i].MRIID > 0) {
      const st = states[`${items[i].MRProject}\x00${items[i].MRIID}`];
      if (st !== undefined) {
        const classified = classify(st);
        if (classified !== "" && classified !== "unknown") {
          items[i].MRState = classified;
        }
      }
    }
    const issue = issues[items[i].IssueID];
    if (issue !== undefined) {
      items[i].MRState = EffectiveAnalyticsMRState(items[i].MRState, issue.DeliveryMRState);
    }
    FinalizeAnalyticsDelivery(items[i]);
  }
};

function betterAnalyticsMR(preferProject, preferIID, best, bestState, next, nextState) {
  const bestRank = AnalyticsMRRank(bestState);
  const nextRank = AnalyticsMRRank(nextState);
  if (nextRank !== bestRank) {
    return nextRank > bestRank;
  }
  const bestPref = preferIID > 0 && best.project.toLowerCase() === preferProject.toLowerCase() && best.iid === preferIID;
  const nextPref = preferIID > 0 && next.project.toLowerCase() === preferProject.toLowerCase() && next.iid === preferIID;
  if (nextPref !== bestPref) {
    return nextPref;
  }
  if (next.sourceRank !== best.sourceRank) {
    return next.sourceRank > best.sourceRank;
  }
  return timeAfter(next.createdAt, best.createdAt);
}

function runMRText(run) {
  const urls = [];
  for (const mr of ResolveRunDeliveryMRs(run, null)) {
    urls.push(mr.URL);
  }
  return urls.join("\n");
}

DeliveryRepo.prototype.mrTextsByRun = function (runs) {
  const out = {};
  if (runs.length === 0) {
    return out;
  }
  if (runs.length > 500) {
    for (let start = 0; start < runs.length; start += 500) {
      const chunk = this.mrTextsByRun(runs.slice(start, Math.min(start + 500, runs.length)));
      for (const [id, value] of Object.entries(chunk)) {
        out[id] = value;
      }
    }
    return out;
  }
  const ids = [];
  const byID = {};
  for (const run of runs) {
    ids.push(run.ID);
    byID[run.ID] = run;
  }
  const rows = [];
  const findErr = this.DB.Where("run_id IN ? AND content LIKE ? AND name NOT LIKE ? AND name NOT LIKE ?", ids, "%merge_requests/%", "%patch%", "%diff%").
    Select("run_id", "name", "path", "node_id", "content").Order("created_at, id").Find(rows).Error;
  if (findErr != null) {
    return out;
  }
  for (const row of rows) {
    const run = byID[row.RunID] ?? new Run();
    run.Artifacts.push(new Artifact({ Name: row.Name, Path: row.Path, NodeID: row.NodeID, Content: row.Content }));
    byID[row.RunID] = run;
  }
  for (const [id, run] of Object.entries(byID)) {
    out[id] = runMRText(run);
  }
  return out;
};

function compactDeliveryLanes(lanes) {
  if ((lanes ?? []).length === 0) {
    return null;
  }
  const out = [];
  for (const lane of lanes) {
    out.push({ ...lane, Stages: null });
  }
  return out;
}

module.exports = { DeliveryRepo, deliveryAcc, phaseMeasurements, mrRef, mrDeliveryStateDB, mrDeliveryRowValues, singleDeliveryMR, issueDeliverySkipped, deliveryMRFieldsEqual, deliveryGroupKey, deliveryRunIssueID, countDeliveryGroups, requirementPhaseDurations, requirementPhaseMeasurements, nodeMetricStage, inferLegacyMetricStage, overlayIssueMRState, betterAnalyticsMR, runMRText, compactDeliveryLanes, issueIDFromExecutionContext, isZeroTime, timeMs, timeBefore, timeAfter };
