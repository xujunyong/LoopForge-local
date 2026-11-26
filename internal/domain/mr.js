/**
 * 对应 Go 文件：internal/domain/mr.go
 * 作用：提供工蜂/GitHub/GitHub Enterprise/GitLab 的 MR/PR 链接解析、产物优先级评分、
 *       分支与交付状态分类、基线提升状态判定，以及运营分析交付汇总计算逻辑。
 * 职责边界：仅处理 MR/PR 链接识别、状态分类与统计汇总纯逻辑，不发起远程 Git 平台请求。
 * 语法差异说明：
 * - 与 delivery_mr.js 存在同包循环引用，按约定在函数内部延迟 require("./delivery_mr.js")；
 * - Go 的 map[string]struct{} 与 map[string]string 均译为普通对象 {}；
 * - Go 返回的多值结果（含 ok 布尔值）译为定长数组元组；
 * - AnalyticsDelivery 的跨文件方法挂载在 analytics.AnalyticsDelivery.prototype 上。
 */

"use strict";

// 同包引用：https_host.js / project.js / public_repository.js / user.js / analytics.js；
// delivery_mr.js 存在循环引用，在调用函数内延迟加载。
const httpsHost = require("./https_host.js");
const projectPkg = require("./project.js");
const publicRepo = require("./public_repository.js");
const userPkg = require("./user.js");
const analytics = require("./analytics.js");

/** 在自由文本中按引用顺序匹配评审链接的正则，宿主与项目需经后续校验才算有效交付证据。 */
const hostedReviewURL = /https?:\/\/([^/\s"'<>#]+)\/([^\s"'<>#]+)\/(pull|merge_requests)\/(\d+)/g;
/** 精确匹配单个 github.com PR 链接的正则。 */
const githubPRLink = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\/?$/;

/**
 * 判断输入文本去除首尾空白后是否恰好为一条合法的 github.com Pull Request 链接。
 *
 * @param {string} text - 待检测文本。
 * @returns {boolean} 严格匹配单个 GitHub PR 链接返回 true，否则返回 false。
 */
function IsGitHubPRURL(text) {
  return githubPRLink.test(text.trim());
}

/** GitHub Enterprise 外部 MR 项目键前缀（格式："ghe:<host>/<owner>/<repo>"）。 */
const MRProjectGHE = "ghe:";
/** 自托管 GitLab 外部 MR 项目键前缀（格式："gitlab:<host>/<path>"）。 */
const MRProjectGitLab = "gitlab:";

/** 合法外部 MR 主机名（可带端口）正则。 */
const externalMRHost = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[1-9][0-9]{0,4})?$/;
/** 外部 GitHub Enterprise PR 路径正则。 */
const externalPRPath = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/;
/** 外部 GitLab MR 路径正则。 */
const externalMRPath = /^\/((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)\/-\/merge_requests\/([1-9][0-9]*)\/?$/;
/** 外部仓库路径单段合法字符正则。 */
const externalPathPart = /^[A-Za-z0-9_.-]+$/;

/**
 * 校验并规范化外部 MR 链接的主机范围（支持带方括号的 IPv6 地址或非 github.com 域名）。
 * 供 ExternalMRProject 与 ParseDeliveryMRURL 内部复用。
 *
 * @param {string} host - 候选主机字符串（可带端口或 IPv6 方括号）。
 * @returns {[string, boolean]} 合法时返回 [规范主机, true]，非法时返回 [原串或空串, false]。
 */
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

/**
 * 将带 `ghe:` 或 `gitlab:` 前缀的外部 MR 项目键拆分为平台、规范主机与仓库路径。
 *
 * @param {string} project - 外部 MR 项目键（如 "ghe:git.corp.com/org/repo"）。
 * @returns {[string, string, string, boolean]} 合法时返回 [platform, host, path, true]，否则返回 ["", "", "", false]。
 */
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

/**
 * 解析单条已存储的交付 PR/MR 链接：先尝试按 github.com / 托管工蜂链接解析，
 * 再尝试解析单条完整的 HTTPS GitHub Enterprise PR 或 GitLab MR 链接。
 * 与 ParseGongfengMRs 不同，对外部宿主不在自由文本中搜索，防止产物引用的无关链接被误认。
 *
 * @param {string} text - 单条候选 PR/MR 链接文本。
 * @returns {[string, number, string, boolean]} 解析成功返回 [project, iid, 规范化 URL, true]，否则返回 ["", 0, "", false]。
 */
function ParseDeliveryMRURL(text) {
  const deliveryMr = require("./delivery_mr.js");
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
  // Go 还校验 u.RawPath 为空；此处路径仅允许下方正则限定字符，语义等价。
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

/**
 * 从自由文本中提取的单条工蜂或 GitHub 合并请求引用。
 */
class GongfengMRRef {
  /**
   * 构造 MR 引用对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<GongfengMRRef>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Project = init.Project ?? "";
    this.IID = init.IID ?? 0;
    this.URL = init.URL ?? "";
  }
}

/**
 * 从文本中提取第一条合法的工蜂或 GitHub PR/MR 链接。
 *
 * @param {string} text - 待扫描文本。
 * @returns {[string, number, string, boolean]} 找到时返回 [project, iid, 规范化 URL, true]，未找到返回 ["", 0, "", false]。
 */
function ParseGongfengMR(text) {
  const refs = ParseGongfengMRs(text);
  if (refs.length === 0) {
    return ["", 0, "", false];
  }
  return [refs[0].Project, refs[0].IID, refs[0].URL, true];
}

/**
 * 从自由文本中按首次出现顺序提取并去重全部合法的工蜂 MR 与 github.com PR 链接。
 *
 * @param {string} text - 待扫描的自由文本（如产物正文或评论）。
 * @returns {GongfengMRRef[]} 按出现顺序排列且去重后的 MR 引用数组。
 */
function ParseGongfengMRs(text) {
  const deliveryMr = require("./delivery_mr.js");
  const out = [];
  const seen = {};
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
    if (Object.prototype.hasOwnProperty.call(seen, key)) {
      continue;
    }
    seen[key] = true;
    out.push(new GongfengMRRef({ Project: project, IID: iid, URL: deliveryMr.GongfengMRURL(project, iid) }));
  }
  return out;
}

/**
 * 为运行产物评定 MR 恢复优先级分数，分数越高越可信。
 * 名称或路径包含 patch / diff 的产物固定得 0 分，避免误采补丁里引用的其他需求 MR。
 *
 * @param {string} name - 产物名称。
 * @param {string} path - 产物相对路径。
 * @param {string} nodeID - 生成该产物的节点 ID。
 * @returns {number} 优先级分值（40、30、20、10 或 0）。
 */
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

/**
 * 获取单条分析交付记录关联的 MR 列表，兼容仅含单个主 MR 字段的历史分析响应。
 *
 * @returns {import("./delivery_mr.js").DeliveryMR[]|null} MR 列表；无任何 MR 时返回 null。
 */
analytics.AnalyticsDelivery.prototype.DeliveryMRList = function () {
  const deliveryMr = require("./delivery_mr.js");
  if ((this.MRs ?? []).length > 0) {
    return this.MRs;
  }
  if (this.MRURL === "") {
    return null;
  }
  return [new deliveryMr.DeliveryMR({ Project: this.MRProject, IID: this.MRIID, URL: this.MRURL, State: this.MRState })];
};

/**
 * 对按工作项聚合的分析交付明细列表进行全局汇总，计算需求/缺陷数、MR 合并数、直接交付数、
 * Token/费用总计以及平均耗时和 P50/P95 执行耗时。
 *
 * @param {import("./analytics.js").AnalyticsDelivery[]} items - 按工作项聚合的交付明细数组。
 * @returns {import("./analytics.js").AnalyticsDeliverySummary} 汇总后的交付统计指标对象。
 */
function SummarizeDeliveries(items) {
  const out = new analytics.AnalyticsDeliverySummary({ Issues: items.length });
  const mrs = {};
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
  out.TotalMRs = Object.keys(mrs).length;
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

/**
 * 将单个工作项关联的 MR 列表折叠进“MR 标识 -> 最高等级状态”去重表中。
 * 无法识别标识的 MR 会被跳过；同一 MR 保留等级更高的状态。
 *
 * @param {Record<string, string>} mrs - 跨工作项共享的 MR 去重状态映射表（原地更新）。
 * @param {import("./delivery_mr.js").DeliveryMR[]} list - 当前工作项的 MR 列表。
 * @returns {boolean} 若当前工作项存在至少一条状态为 merged 的有效 MR 返回 true，否则返回 false。
 */
function recordDeliveryMRs(mrs, list) {
  let merged = false;
  for (const mr of list) {
    const key = analyticsMRKey(mr);
    if (key === "") {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(mrs, key) || AnalyticsMRRank(mr.State) > AnalyticsMRRank(mrs[key])) {
      mrs[key] = mr.State;
    }
    merged = merged || mr.State === "merged";
  }
  return merged;
}

/**
 * 统计去重状态表中已合入主线（merged）与已合入基线（integrated）的 MR 数量。
 * 供 SummarizeDeliveries 汇总 MR 状态指标。
 *
 * @param {Record<string, string>} mrs - 由 recordDeliveryMRs 构建的 MR 去重状态映射表。
 * @returns {[number, number]} 返回 [merged 数量, integrated 数量] 元组。
 */
function countDeliveryMRStates(mrs) {
  let merged = 0;
  let integrated = 0;
  for (const state of Object.values(mrs)) {
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

/**
 * 生成不区分项目名大小写的工蜂 MR 唯一去重键（格式："<小写项目>#<iid>"）。
 * 供 ParseGongfengMRs 与 analyticsMRKey 内部使用。
 *
 * @param {string} project - 项目标识。
 * @param {number} iid - MR 编号。
 * @returns {string} 唯一键字符串。
 */
function gongfengMRKey(project, iid) {
  return project.toLowerCase() + "#" + String(iid);
}

/**
 * 为单条交付 MR 生成用于分析去重的规范键。
 * 优先解析 URL 得到项目与编号；若 URL 不可解析则回退到已存 Project/IID，最后退回原始去空白 URL。
 *
 * @param {import("./delivery_mr.js").DeliveryMR} mr - 交付 MR 对象。
 * @returns {string} 去重键字符串；若所有标识字段均为空则返回空串。
 */
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

/**
 * 计算数值数组的最近邻百分位数（内部对副本升序排序，不修改原数组）。
 * 供 SummarizeDeliveries 计算 P50 / P95 执行耗时。
 *
 * @param {number[]} values - 耗时等数值样本数组，允许无序。
 * @param {number} pct - 百分位数值（0 到 100）。
 * @returns {number} 对应分位数值；样本为空或 pct <= 0 时返回 0。
 */
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

/** 受控统计标签：需求开发类。 */
const MetricCategoryRequirement = "requirement";
/** 受控统计标签：缺陷修复类。 */
const MetricCategoryBugfix = "bugfix";
/** 受控统计标签：其他类别。 */
const MetricCategoryOther = "other";

/**
 * 将原始工作项类别标签归一为受控统计枚举值（requirement / bugfix / other），用于交付指标归类与筛选。
 *
 * @param {string} raw - 原始类别字符串（支持中英文同义词）。
 * @returns {string} 归一化后的统计标签常量值。
 */
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

/**
 * 为单条分析交付记录补全默认的 MR 状态标签（none / unknown），并计算 Delivered 标志。
 *
 * @param {import("./analytics.js").AnalyticsDelivery} item - 待定型的交付分析条目（原地修改）。
 * @returns {void} 无返回值。
 */
function FinalizeAnalyticsDelivery(item) {
  if (item.MRURL === "" && item.MRState === "") {
    item.MRState = "none";
  }
  if (item.MRURL !== "" && item.MRState === "") {
    item.MRState = "unknown";
  }
  item.Delivered = (item.SOPSucceeded || item.DirectDelivery) && item.MRState === "merged";
}

/**
 * 去除分支名称前导的 `refs/heads/` 与 `origin/` 前缀及首尾空白，便于统一比较。
 *
 * @param {string} name - 原始分支名或引用名。
 * @returns {string} 规范化后的短分支名。
 */
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

/**
 * 判断两个分支名在去除引用前缀后是否指代同一 Git 分支（忽略大小写且均非空）。
 *
 * @param {string} a - 分支名 A。
 * @param {string} b - 分支名 B。
 * @returns {boolean} 非空且归一化后忽略大小写相等返回 true，否则返回 false。
 */
function SameGitBranch(a, b) {
  const left = NormalizeBranchName(a);
  const right = NormalizeBranchName(b);
  return left !== "" && left.toLowerCase() === right.toLowerCase();
}

/**
 * 判断两个自由文本 URL 是否指向同一条 MR/PR（比较项目标识与 IID，忽略 `/-/` 与非 `/-/` URL 形式差异）。
 * 若任一链接无法解析，则退回去除首尾空白后的忽略大小写字符串比较。
 *
 * @param {string} a - MR/PR 链接 A。
 * @param {string} b - MR/PR 链接 B。
 * @returns {boolean} 指向同一条 MR/PR 返回 true，否则返回 false。
 */
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

/**
 * 判断目标分支是否为仓库默认主线分支。
 * 当 defaultBranch 为空时，main 与 master 均视为主线分支。
 *
 * @param {string} target - 待判定的目标分支名。
 * @param {string} defaultBranch - 仓库配置的默认分支名，可为空串。
 * @returns {boolean} 为主线分支返回 true，否则返回 false。
 */
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

/**
 * 将工蜂原始合并状态与目标分支映射为交付分析状态。
 * 合入默认主线分支记为 "merged"，合入集成基线或其他非默认分支记为 "integrated"；
 * 若已合入但目标分支为空则记为 "unknown"，避免误报为已合入主线。
 *
 * @param {string} gongfengState - 工蜂/宿主返回的原始 MR 状态。
 * @param {string} targetBranch - MR 的目标分支名。
 * @param {string} defaultBranch - 仓库默认主线分支名。
 * @param {string} integrateBranch - 仓库集成基线分支名（保留与 Go 函数签名一致）。
 * @returns {string} 分类后的分析状态（"merged"、"integrated"、"opened"、"closed"、"reopened"、"unknown" 等）。
 */
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

/**
 * 返回交付分析状态的优先级数值，用于在去重合并同一 MR 多条记录时保留更推进的状态。
 *
 * @param {string} state - MR 交付分析状态字符串。
 * @returns {number} 优先级分值：merged 为 3，integrated 为 2，opened/reopened/closed 为 1，其余为 0。
 */
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

/** 标记 mr_delivery_states 表中“集成基线 -> 默认分支”提升 MR 的占位工作项 ID，并非真实工作项。 */
const BaselinePromoteIssueID = "__baseline_promote__";

/**
 * 判断工作项 ID 是否为基线提升 MR 的特殊占位标识。
 *
 * @param {string} id - 待检查的工作项 ID。
 * @returns {boolean} 去除空白后等于 BaselinePromoteIssueID 返回 true，否则返回 false。
 */
function IsBaselinePromoteIssueID(id) {
  return id.trim() === BaselinePromoteIssueID;
}

/**
 * 计算分析视图中单条工作 MR 的最终有效状态。
 * 若该 MR 仅合入集成基线（integrated），但所属工作项已被标记为主线合入（merged），则升级为 merged。
 *
 * @param {string} classified - 单条 MR 自身分类得到的交付状态。
 * @param {string} issueDeliveryMRState - 所属工作项记录的交付 MR 聚合状态。
 * @returns {string} 升级或保持原样后的分析 MR 状态。
 */
function EffectiveAnalyticsMRState(classified, issueDeliveryMRState) {
  if (classified === "integrated" && issueDeliveryMRState.trim().toLowerCase() === "merged") {
    return "merged";
  }
  return classified;
}

/**
 * 判断已提升为主线合入的工作项交付标签是否应避免被轮询查到的工作 MR 状态覆盖。
 * 当当前标签为 merged 且查到的状态为 integrated / unknown / 空串时保持原标签。
 *
 * @param {string} current - 当前工作项已记录的交付 MR 状态。
 * @param {string} lookedUp - 实时轮询工作 MR 得到的状态。
 * @returns {boolean} 应保留当前主线标签返回 true，否则返回 false。
 */
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

/**
 * 判断目标分支是否出现在某次提交关联的引用名称列表中。
 *
 * @param {string[]} names - 提交所属的引用名列表。
 * @param {string} branch - 待检查的目标分支名。
 * @returns {boolean} 存在匹配分支返回 true，否则返回 false。
 */
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

/**
 * 基于时间顺序判断一次合入基线的工作 MR 是否在基线提升 MR 合入前已落入默认分支。
 * 交付标签优先使用提交包含关系判定，本函数仅留给仅有时间戳信息的调用方使用。
 *
 * @param {Date|null} workAt - 工作 MR 合入基线的时间（零值为 null）。
 * @param {Date|null} promoteAt - 基线提升 MR 合入默认分支的时间（零值为 null）。
 * @returns {boolean} 任一时间为零值或 workAt 不晚于 promoteAt 时返回 true，否则返回 false。
 */
function WorkLandedWithPromote(workAt, promoteAt) {
  if (workAt == null || promoteAt == null) {
    return true;
  }
  return workAt.getTime() <= promoteAt.getTime();
}

module.exports = {
  IsGitHubPRURL,
  MRProjectGHE,
  MRProjectGitLab,
  ExternalMRProject,
  ParseDeliveryMRURL,
  GongfengMRRef,
  ParseGongfengMR,
  ParseGongfengMRs,
  MRArtifactPriority,
  SummarizeDeliveries,
  NormalizeMetricCategory,
  FinalizeAnalyticsDelivery,
  NormalizeBranchName,
  SameGitBranch,
  SameGongfengMR,
  IsMainlineBranch,
  ClassifyMRDeliveryState,
  AnalyticsMRRank,
  BaselinePromoteIssueID,
  IsBaselinePromoteIssueID,
  EffectiveAnalyticsMRState,
  KeepMainlineDeliveryLabel,
  BranchListed,
  WorkLandedWithPromote,
  MetricCategoryRequirement,
  MetricCategoryBugfix,
  MetricCategoryOther,
};
