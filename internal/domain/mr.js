// mr.js —— 对应 Go 文件：internal/domain/mr.go
// 作用：MR/PR 链接解析、交付状态分类与交付汇总。

"use strict";

// 同包引用：delivery_mr.go / https_host.go / project.go / public_repository.go / user.go / analytics.go 的同包符号，待翻译后提供。
const deliveryMr = require("./delivery_mr.js");
const httpsHost = require("./https_host.js");
const projectPkg = require("./project.js");
const publicRepo = require("./public_repository.js");
const userPkg = require("./user.js");
const analytics = require("./analytics.js");

// 在自由文本中按引用顺序找评审链接，宿主与项目在下面校验后才算交付证据。
const hostedReviewURL = /https?:\/\/([^/\s"'<>#]+)\/([^\s"'<>#]+)\/(pull|merge_requests)\/(\d+)/g;
const githubPRLink = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\/?$/;

// IsGitHubPRURL：文本是否恰好是一个 GitHub PR 链接。
function IsGitHubPRURL(text) {
  return githubPRLink.test(text.trim());
}

// github.com 与托管工蜂宿主之外的 MR 项目键："ghe:<host>/<owner>/<repo>" 与 "gitlab:<host>/<path>"。
const MRProjectGHE = "ghe:";
const MRProjectGitLab = "gitlab:";

const externalMRHost = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[1-9][0-9]{0,4})?$/;
const externalPRPath = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/;
const externalMRPath = /^\/((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)\/-\/merge_requests\/([1-9][0-9]*)\/?$/;
const externalPathPart = /^[A-Za-z0-9_.-]+$/;

function externalMRHostScope(host) {
  if (host.startsWith("[")) {
    try {
      return [httpsHost.HTTPSHostScope("https://" + host), true];
    } catch {
      return ["", false];
    }
  }
  return [host, host !== "github.com" && externalMRHost.test(host)];
}

// ExternalMRProject：把 ghe: 或 gitlab: 的 MR 项目键拆为平台、宿主与仓库路径。
function ExternalMRProject(project) {
  let rest = "";
  let platform = "";
  if (project.startsWith(MRProjectGHE)) {
    platform = userPkg.GitPlatformGitHub;
    rest = project.slice(MRProjectGHE.length);
  } else if (project.startsWith(MRProjectGitLab)) {
    platform = userPkg.GitPlatformGitLab;
    rest = project.slice(MRProjectGitLab.length);
  } else {
    return ["", "", "", false];
  }
  const slash = rest.indexOf("/");
  if (slash < 0) {
    return ["", "", "", false];
  }
  const [host, validHost] = externalMRHostScope(rest.slice(0, slash));
  if (!validHost) {
    return ["", "", "", false];
  }
  const path = rest.slice(slash + 1);
  const parts = path.split("/");
  if (parts.length < 2 || (platform === userPkg.GitPlatformGitHub && parts.length !== 2)) {
    return ["", "", "", false];
  }
  for (const part of parts) {
    if (!externalPathPart.test(part) || part === "." || part === "..") {
      return ["", "", "", false];
    }
  }
  return [platform, host, path, true];
}

// ParseDeliveryMRURL：读一个已存 PR/MR 链接，不在自由文本里搜索。
function ParseDeliveryMRURL(text) {
  const [project, iid, url, ok] = ParseGongfengMR(text);
  if (ok) {
    return [project, iid, url, true];
  }
  let u;
  try {
    u = new URL(text.trim());
  } catch {
    return ["", 0, "", false];
  }
  // Go 还要求 u.RawPath 为空；路径只含正则允许的字符，与此处正则校验等价。
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") {
    return ["", 0, "", false];
  }
  const [host, validHost] = externalMRHostScope(u.host.toLowerCase().replace(/:443$/, ""));
  if (!validHost) {
    return ["", 0, "", false];
  }
  let parsedProject = "";
  let parsedIID = 0;
  let match = externalPRPath.exec(u.pathname);
  if (match !== null) {
    parsedProject = MRProjectGHE + host + "/" + match[1];
    parsedIID = Number.parseInt(match[2], 10);
  } else {
    match = externalMRPath.exec(u.pathname);
    if (match !== null) {
      parsedProject = MRProjectGitLab + host + "/" + match[1];
      parsedIID = Number.parseInt(match[2], 10);
    }
  }
  if (!ExternalMRProject(parsedProject)[3] || parsedIID <= 0) {
    return ["", 0, "", false];
  }
  return [parsedProject, parsedIID, deliveryMr.GongfengMRURL(parsedProject, parsedIID), true];
}

// GongfengMRRef：从自由文本提取的一个 MR 地址。
class GongfengMRRef {
  constructor(init = {}) {
    this.Project = init.Project ?? "";
    this.IID = init.IID ?? 0;
    this.URL = init.URL ?? "";
  }
}

// ParseGongfengMR：提取文本中第一个工蜂 MR 地址。
function ParseGongfengMR(text) {
  const refs = ParseGongfengMRs(text);
  if (refs.length === 0) {
    return ["", 0, "", false];
  }
  return [refs[0].Project, refs[0].IID, refs[0].URL, true];
}

// ParseGongfengMRs：按出现顺序提取去重的工蜂 MR 地址。
function ParseGongfengMRs(text) {
  const out = [];
  const seen = new Set();
  for (const match of text.matchAll(hostedReviewURL)) {
    const host = match[1];
    let path = match[2];
    const kind = match[3];
    let project = "";
    if (kind === "pull" && host.toLowerCase() === "github.com" && publicRepo.githubRepositoryPath.test(path)) {
      project = "github:" + path;
    } else if (kind === "merge_requests" && projectPkg.IsGongfengHost(host)) {
      if (path.endsWith("/")) {
        path = path.slice(0, -1);
      }
      if (path.endsWith("/-")) {
        path = path.slice(0, -2);
      }
      project = projectPkg.normalizeGongfengProjectPath(path);
      if (project === "" && projectPkg.IsSafeGongfengProjectID(path)) {
        project = path;
      }
    }
    const iid = Number.parseInt(match[4], 10);
    if (project === "" || iid <= 0) {
      continue;
    }
    const key = gongfengMRKey(project, iid);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(new GongfengMRRef({ Project: project, IID: iid, URL: deliveryMr.GongfengMRURL(project, iid) }));
  }
  return out;
}

// MRArtifactPriority：按产物恢复工作项 MR 时的排序，含 patch/diff 的产物得 0 分。
function MRArtifactPriority(name, path, nodeID) {
  const n = name.toLowerCase().trim();
  const p = path.toLowerCase().trim();
  const blob = n + " " + p;
  if (blob.includes("patch") || blob.includes("diff")) {
    return 0;
  }
  switch (n) {
    case "mr-body":
      return 40;
    case "closeout":
      return 30;
    case "e2e-report":
      return 20;
    default:
      break;
  }
  if (nodeID.trim().toLowerCase() === "mr") {
    return 10;
  }
  if (n.includes("mr") || blob.includes("closeout") || blob.includes("e2e-report")) {
    return 10;
  }
  return 0;
}

// DeliveryMRList 也接受只有一个主 MR 的旧版分析响应。
analytics.AnalyticsDelivery.prototype.DeliveryMRList = function () {
  if ((this.MRs ?? []).length > 0) {
    return this.MRs;
  }
  if (this.MRURL === "") {
    return null;
  }
  return [new deliveryMr.DeliveryMR({ Project: this.MRProject, IID: this.MRIID, URL: this.MRURL, State: this.MRState })];
};

function SummarizeDeliveries(items) {
  const out = new analytics.AnalyticsDeliverySummary({ Issues: items.length });
  const mrs = new Map();
  let durationSum = 0;
  let durationN = 0;
  let execSum = 0;
  let execN = 0;
  const execValues = [];
  for (const item of items) {
    if (item.SOPSucceeded) {
      out.SOPSucceeded++;
      out.CompletedIssues++;
    }
    // 按受控标签归类需求，同一需求只计一次（items 已按 Issue 聚合）。
    switch (NormalizeMetricCategory(item.Category)) {
      case MetricCategoryRequirement:
        out.RequirementCount++;
        break;
      case MetricCategoryBugfix:
        out.BugFixCount++;
        break;
      default:
        break;
    }
    if (!item.CostKnown) {
      out.CostUnknownIssues++;
    }
    if (item.ExecutionDurationMs > 0) {
      execSum += item.ExecutionDurationMs;
      execN++;
      execValues.push(item.ExecutionDurationMs);
    }
    const list = item.DeliveryMRList() ?? [];
    if (list.length > 0) {
      out.WithMR++;
    }
    if (item.DirectDelivery) {
      out.DirectIssues++;
      if (list.length > 0) {
        out.DirectWithMR++;
      }
      if (item.Delivered) {
        out.DirectDelivered++;
      }
    }
    if (recordDeliveryMRs(mrs, list)) {
      out.IssuesWithMergedMR++;
    }
    if (item.Delivered) {
      out.Delivered++;
    }
    out.TotalTokens += item.Tokens;
    out.TotalCostUSD += item.CostUSD;
    if (item.DurationMs > 0) {
      durationSum += item.DurationMs;
      durationN++;
    }
  }
  out.TotalMRs = mrs.size;
  const [merged, integrated] = countDeliveryMRStates(mrs);
  out.MRMerged = merged;
  out.MRIntegrated = integrated;
  if (durationN > 0) {
    out.AverageDurationMs = Math.trunc(durationSum / durationN);
  }
  if (execN > 0) {
    out.AverageExecutionDurationMs = Math.trunc(execSum / execN);
    out.P50ExecutionDurationMs = analyticsPercentile(execValues, 50);
    out.P95ExecutionDurationMs = analyticsPercentile(execValues, 95);
  }
  return out;
}

// recordDeliveryMRs：把一个工作项的 MR 折进去重表，同一 MR 保留更高等级的状态。
function recordDeliveryMRs(mrs, list) {
  let merged = false;
  for (const mr of list) {
    const key = analyticsMRKey(mr);
    if (key === "") {
      continue;
    }
    if (!mrs.has(key) || AnalyticsMRRank(mr.State) > AnalyticsMRRank(mrs.get(key))) {
      mrs.set(key, mr.State);
    }
    merged = merged || mr.State === "merged";
  }
  return merged;
}

// countDeliveryMRStates：统计去重表中已合入与已合入基线的 MR 数。
function countDeliveryMRStates(mrs) {
  let merged = 0;
  let integrated = 0;
  for (const state of mrs.values()) {
    switch (state) {
      case "merged":
        merged++;
        break;
      case "integrated":
        integrated++;
        break;
      default:
        break;
    }
  }
  return [merged, integrated];
}

// gongfengMRKey：工蜂 MR 不区分大小写的身份。
function gongfengMRKey(project, iid) {
  return project.toLowerCase() + "#" + String(iid);
}

// analyticsMRKey：跨 URL 形式给一个交付 MR 去重，能解析的 URL 优先于已存项目编号。
function analyticsMRKey(mr) {
  let project = mr.Project;
  let iid = mr.IID;
  const [p, n, , ok] = ParseDeliveryMRURL(mr.URL);
  if (ok) {
    project = p;
    iid = n;
  }
  if (project !== "" && iid > 0) {
    return gongfengMRKey(project, iid);
  }
  return mr.URL.trim();
}

// analyticsPercentile：取最近邻分位数，输入允许无序（内部排序副本）。
function analyticsPercentile(values, pct) {
  if (values.length === 0 || pct <= 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (pct >= 100) {
    return sorted[sorted.length - 1];
  }
  const idx = Math.trunc((sorted.length - 1) * pct / 100);
  return sorted[idx];
}

// 受控统计标签：用于交付指标归类与前端筛选。
const MetricCategoryRequirement = "requirement";
const MetricCategoryBugfix = "bugfix";
const MetricCategoryOther = "other";

// NormalizeMetricCategory：将受控标签归一到枚举值，空值归为 other。
function NormalizeMetricCategory(raw) {
  switch (raw.toLowerCase().trim()) {
    case "requirement":
    case "需求开发":
    case "feature":
    case "需求":
      return MetricCategoryRequirement;
    case "bugfix":
    case "bug":
    case "bug 修复":
    case "bug修复":
    case "缺陷修复":
      return MetricCategoryBugfix;
    default:
      return MetricCategoryOther;
  }
}

// FinalizeAnalyticsDelivery：补默认 MR 状态标签与交付标志。
function FinalizeAnalyticsDelivery(item) {
  if (item.MRURL === "" && item.MRState === "") {
    item.MRState = "none";
  }
  if (item.MRURL !== "" && item.MRState === "") {
    item.MRState = "unknown";
  }
  item.Delivered = (item.SOPSucceeded || item.DirectDelivery) && item.MRState === "merged";
}

// NormalizeBranchName：去掉 refs/heads/ 与 origin/ 前缀以便比较。
function NormalizeBranchName(name) {
  name = name.trim();
  if (name.startsWith("refs/heads/")) {
    name = name.slice("refs/heads/".length);
  }
  if (name.startsWith("origin/")) {
    name = name.slice("origin/".length);
  }
  return name.trim();
}

function SameGitBranch(a, b) {
  const left = NormalizeBranchName(a);
  const right = NormalizeBranchName(b);
  return left !== "" && left.toLowerCase() === right.toLowerCase();
}

// SameGongfengMR：两个自由文本 URL 是否指同一工蜂 MR，忽略 /- 与非 /- 形式。
function SameGongfengMR(a, b) {
  const [pa, ia, , oka] = ParseDeliveryMRURL(a);
  const [pb, ib, , okb] = ParseDeliveryMRURL(b);
  if (!oka || !okb) {
    const left = a.trim();
    const right = b.trim();
    return left !== "" && left.toLowerCase() === right.toLowerCase();
  }
  return ia === ib && pa.toLowerCase() === pb.toLowerCase();
}

// IsMainlineBranch：目标是否为仓库默认分支，默认分支为空时 main 与 master 都算主线。
function IsMainlineBranch(target, defaultBranch) {
  target = NormalizeBranchName(target);
  if (target === "") {
    return false;
  }
  const def = NormalizeBranchName(defaultBranch);
  if (def !== "") {
    return SameGitBranch(target, def);
  }
  return SameGitBranch(target, "master") || SameGitBranch(target, "main");
}

// ClassifyMRDeliveryState：工蜂合并状态 + 目标分支映射为分析状态。
function ClassifyMRDeliveryState(gongfengState, targetBranch, defaultBranch, integrateBranch) {
  const state = gongfengState.toLowerCase().trim();
  if (state !== "merged") {
    if (state === "") {
      return "unknown";
    }
    return state;
  }
  if (NormalizeBranchName(targetBranch) === "") {
    return "unknown";
  }
  if (IsMainlineBranch(targetBranch, defaultBranch)) {
    return "merged";
  }
  return "integrated";
}

function AnalyticsMRRank(state) {
  switch (state) {
    case "merged":
      return 3;
    case "integrated":
      return 2;
    case "opened":
    case "reopened":
    case "closed":
      return 1;
    default:
      return 0;
  }
}

// BaselinePromoteIssueID：标记 mr_delivery_states 行是基线到默认分支的 MR，不是真实工作项。
const BaselinePromoteIssueID = "__baseline_promote__";

function IsBaselinePromoteIssueID(id) {
  return id.trim() === BaselinePromoteIssueID;
}

// EffectiveAnalyticsMRState：工作 MR 只落到基线、但工作项本身已标记主线合入时升级为主线合入。
function EffectiveAnalyticsMRState(classified, issueDeliveryMRState) {
  if (classified === "integrated" && issueDeliveryMRState.trim().toLowerCase() === "merged") {
    return "merged";
  }
  return classified;
}

// KeepMainlineDeliveryLabel：已提升的主线标签是否不被查到的工作 MR 状态覆盖。
function KeepMainlineDeliveryLabel(current, lookedUp) {
  if (current.trim().toLowerCase() !== "merged") {
    return false;
  }
  switch (lookedUp) {
    case "integrated":
    case "unknown":
    case "":
      return true;
    default:
      return false;
  }
}

// BranchListed：分支是否出现在某次提交的引用名里。
function BranchListed(names, branch) {
  if (NormalizeBranchName(branch) === "") {
    return false;
  }
  for (const name of names) {
    if (SameGitBranch(name, branch)) {
      return true;
    }
  }
  return false;
}

// WorkLandedWithPromote：基线合入后，本次提升 MR 合入是否可视为已上默认分支。
function WorkLandedWithPromote(workAt, promoteAt) {
  if (workAt == null || promoteAt == null) {
    return true;
  }
  return workAt.getTime() <= promoteAt.getTime();
}

module.exports = { IsGitHubPRURL, MRProjectGHE, MRProjectGitLab, ExternalMRProject, ParseDeliveryMRURL, GongfengMRRef, ParseGongfengMR, ParseGongfengMRs, MRArtifactPriority, SummarizeDeliveries, NormalizeMetricCategory, FinalizeAnalyticsDelivery, NormalizeBranchName, SameGitBranch, SameGongfengMR, IsMainlineBranch, ClassifyMRDeliveryState, AnalyticsMRRank, BaselinePromoteIssueID, IsBaselinePromoteIssueID, EffectiveAnalyticsMRState, KeepMainlineDeliveryLabel, BranchListed, WorkLandedWithPromote, MetricCategoryRequirement, MetricCategoryBugfix, MetricCategoryOther };
