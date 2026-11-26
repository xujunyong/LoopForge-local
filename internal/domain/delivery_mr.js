/**
 * 对应 Go 文件：internal/domain/delivery_mr.go
 * 作用：定义工作项交付 MR 与按分支查询 MR 的数据结构，提供 MR Web 链接构造、
 *       多 MR 状态聚合、Issue 上的交付 MR 读写方法，以及从一次运行中解析各仓库交付 MR 的逻辑。
 * 职责边界：仅处理交付 MR 的领域模型与纯计算逻辑，不直接调用外部 Git 平台 HTTP API。
 * 语法差异说明：
 * - 与 mr.js 存在同包循环引用，按约定在函数内部延迟 require("./mr.js")；
 * - Go 的 map[string]bool 与 map[string]artifactMRCandidate 均译为普通对象 {}；
 * - Issue 的跨文件方法挂载在 Issue.prototype 上。
 */

"use strict";

// 同包引用：project.js / user.js / issue.js；mr.js 存在循环引用，在函数内延迟加载。
const projectPkg = require("./project.js");
const userPkg = require("./user.js");
const { Issue } = require("./issue.js");

/**
 * 表示工作项交付的一条合并请求（MR/PR）。
 * 多仓库 SOP 场景下，每个参与运行的仓库至多对应一条交付 MR。
 */
class DeliveryMR {
  /**
   * 构造交付 MR 对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<DeliveryMR>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.RepositoryID = init.RepositoryID ?? "";
    this.Repository = init.Repository ?? "";
    this.Project = init.Project ?? "";
    this.IID = init.IID ?? 0;
    this.URL = init.URL ?? "";
    this.State = init.State ?? "";
    this.TargetBranch = init.TargetBranch ?? "";
    this.GongfengState = init.GongfengState ?? "";
    this.HeadSHA = init.HeadSHA ?? "";
  }
}

/**
 * 描述向 Git 宿主查询“从某工作分支合入某目标分支的 MR”所需的执行上下文参数。
 * 其中 ProjectID 为运行所属项目，GitToken 为该次推送使用的凭据，ResponsibleUserID 为凭据归属责任人。
 */
class BranchMRQuery {
  /**
   * 构造分支 MR 查询参数对象，未提供字段按 Go 零值初始化。
   *
   * @param {Partial<BranchMRQuery>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ProjectID = init.ProjectID ?? "";
    this.RemoteProject = init.RemoteProject ?? "";
    this.SourceBranch = init.SourceBranch ?? "";
    this.TargetBranch = init.TargetBranch ?? "";
    this.GitToken = init.GitToken ?? "";
    this.ResponsibleUserID = init.ResponsibleUserID ?? 0;
  }
}

/**
 * 根据项目标识与 MR/PR 编号拼装规范的 Web 访问地址。
 * 支持 github: 前缀、ghe:/gitlab: 外部托管项目键，以及默认托管工蜂项目路径。
 *
 * @param {string} project - 项目标识（如 "group/repo"、"github:owner/repo"、"ghe:host/owner/repo" 等）。
 * @param {number} iid - 合并请求或拉取请求的数字编号（须大于 0）。
 * @returns {string} 规范化的 HTTPS Web 地址；若 project 为空或 iid 非正数则返回空字符串。
 */
function GongfengMRURL(project, iid) {
  const mrPkg = require("./mr.js");
  project = project.trim().replace(/^\/+|\/+$/g, "");
  if (project === "" || iid <= 0) {
    return "";
  }
  if (project.startsWith("github:")) {
    return `https://github.com/${project.slice("github:".length)}/pull/${iid}`;
  }
  const [platform, host, path, ok] = mrPkg.ExternalMRProject(project);
  if (ok) {
    if (platform === userPkg.GitPlatformGitHub) {
      return `https://${host}/${path}/pull/${iid}`;
    }
    return `https://${host}/${path}/-/merge_requests/${iid}`;
  }
  return `https://${projectPkg.GongfengRepositoryHost()}/${project}/-/merge_requests/${iid}`;
}

/**
 * 将多条交付 MR 的各自状态折叠为工作项层面的单一展示状态。
 * 规则：仅当全部 MR 均为 closed 时结果才为 closed；其余存活 MR 全为 merged 返回 merged，
 * 全部已达集成基线（merged + integrated）返回 integrated，否则返回首个未完成状态。
 *
 * @param {DeliveryMR[]} mrs - 工作项关联的交付 MR 列表。
 * @returns {string} 聚合后的状态字符串（如 "merged"、"integrated"、"closed"、"opened"、"unknown" 或空串）。
 */
function AggregateDeliveryMRState(mrs) {
  if (mrs.length === 0) {
    return "";
  }
  const norm = (s) => {
    s = s.toLowerCase().trim();
    if (s === "") {
      return "unknown";
    }
    return s;
  };
  if (mrs.length === 1) {
    return norm(mrs[0].State);
  }
  let live = 0;
  let merged = 0;
  let integrated = 0;
  let pending = "";
  for (const mr of mrs) {
    const st = norm(mr.State);
    switch (st) {
      case "closed":
        continue;
      case "merged":
        merged++;
        break;
      case "integrated":
        integrated++;
        break;
      default:
        if (pending === "" || (pending === "unknown" && st !== "unknown")) {
          pending = st;
        }
        break;
    }
    live++;
  }
  if (live === 0) {
    return "closed";
  } else if (merged === live) {
    return "merged";
  } else if (merged + integrated === live) {
    return "integrated";
  }
  return pending;
}

/**
 * 获取工作项的交付 MR 列表副本。
 * 兼容多 MR 支持前仅写入 DeliveryMRURL / DeliveryMRState 的历史工作项数据。
 *
 * @returns {DeliveryMR[]|null} 交付 MR 数组副本；若工作项无任何 MR 记录则返回 null。
 */
Issue.prototype.DeliveryMRList = function () {
  const mrPkg = require("./mr.js");
  if (this.DeliveryMRs != null && this.DeliveryMRs.length > 0) {
    return [...this.DeliveryMRs];
  }
  const url = this.DeliveryMRURL.trim();
  if (url === "") {
    return null;
  }
  const mr = new DeliveryMR({ URL: url, State: this.DeliveryMRState.trim() });
  const [project, iid, , ok] = mrPkg.ParseDeliveryMRURL(url);
  if (ok) {
    mr.Project = project;
    mr.IID = iid;
  }
  return [mr];
};

/**
 * 判断指定 URL 是否属于当前工作项已记录的交付 MR 之一。
 * 使用 SameGongfengMR 忽略 URL 形式差异进行比对。
 *
 * @param {string} url - 待比对的 MR/PR 地址。
 * @returns {boolean} 若已存在同一条 MR 返回 true，否则返回 false。
 */
Issue.prototype.HasDeliveryMR = function (url) {
  const mrPkg = require("./mr.js");
  for (const mr of this.DeliveryMRList() ?? []) {
    if (mrPkg.SameGongfengMR(mr.URL, url)) {
      return true;
    }
  }
  return false;
};

/**
 * 替换工作项的交付 MR 列表（按 URL 去重并过滤空链接），并同步更新旧版单 MR 字段：
 * DeliveryMRURL 取首条 MR 地址，DeliveryMRState 取聚合状态。
 *
 * @param {DeliveryMR[]} mrs - 新的交付 MR 列表。
 * @returns {void} 无返回值。
 */
Issue.prototype.SetDeliveryMRs = function (mrs) {
  const mrPkg = require("./mr.js");
  const out = [];
  for (const mr of mrs) {
    mr.URL = mr.URL.trim();
    if (mr.URL === "") {
      continue;
    }
    let dup = false;
    for (const cur of out) {
      if (mrPkg.SameGongfengMR(cur.URL, mr.URL)) {
        dup = true;
        break;
      }
    }
    if (!dup) {
      out.push(mr);
    }
  }
  if (out.length === 0) {
    this.DeliveryMRs = [];
    this.DeliveryMRURL = "";
    this.DeliveryMRState = "";
    return;
  }
  this.DeliveryMRs = out;
  this.DeliveryMRURL = out[0].URL;
  this.DeliveryMRState = AggregateDeliveryMRState(out);
};

/**
 * 更新工作项中指定 URL 对应交付 MR 的状态并重新同步聚合状态。
 * 若工作项此前尚未记录任何 MR，则直接采纳该 URL 作为唯一 MR；若已有 MR 但不包含该 URL，则不修改并返回 false。
 *
 * @param {string} url - 要更新状态的 MR/PR 地址。
 * @param {string} state - 目标交付状态字符串。
 * @returns {boolean} 更新或采纳成功返回 true，URL 为空或不匹配已有 MR 时返回 false。
 */
Issue.prototype.SetDeliveryMRState = function (url, state) {
  const mrPkg = require("./mr.js");
  url = url.trim();
  if (url === "") {
    return false;
  }
  const list = this.DeliveryMRList() ?? [];
  if (list.length === 0) {
    const mr = new DeliveryMR({ URL: url, State: state });
    const [project, iid, , ok] = mrPkg.ParseDeliveryMRURL(url);
    if (ok) {
      mr.Project = project;
      mr.IID = iid;
    }
    this.SetDeliveryMRs([mr]);
    return true;
  }
  for (let idx = 0; idx < list.length; idx++) {
    if (mrPkg.SameGongfengMR(list[idx].URL, url)) {
      list[idx].State = state;
      this.SetDeliveryMRs(list);
      return true;
    }
  }
  return false;
};

/**
 * 为一次运行中涉及的每个非仅对齐（AlignOnly）工蜂仓库解析出对应的交付 MR。
 * 优先使用 byBranch 按仓库工作分支实时查询权威 MR，未命中时再从运行产物中按同项目兜底；
 * 若运行未绑定任何工蜂仓库，则回退到按项目去重的产物候选 MR，最后回退到遥测事件中的 URL。
 *
 * @param {import("./run.js").Run} run - 运行记录对象，需提供 RepositoryContexts()、Artifacts 与 Telemetry。
 * @param {((rc: import("./project.js").RepositoryContext) => [DeliveryMR, boolean])|null} byBranch - 按仓库上下文查询工作分支 MR 的回调函数，返回 [DeliveryMR, found] 元组，可为 null。
 * @returns {DeliveryMR[]} 解析出的交付 MR 数组。
 */
function ResolveRunDeliveryMRs(run, byBranch) {
  const mrPkg = require("./mr.js");
  const candidates = runArtifactMRCandidates(run);
  const repos = [];
  for (const rc of run.RepositoryContexts()) {
    if (rc.GongfengProjectID.trim() !== "" && !rc.AlignOnly) {
      repos.push(rc);
    }
  }
  if (repos.length === 0) {
    const out = [];
    const seen = {};
    const add = (mr) => {
      const project = mr.Project.toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(seen, project)) {
        seen[project] = true;
        out.push(mr);
      }
    };
    if (candidates.length > 0) {
      for (const candidate of candidates) {
        add(candidate.mr);
      }
      return out;
    }
    for (const obs of run.Telemetry) {
      const url = obs.Attributes["url"];
      if (typeof url === "string") {
        const [project, iid, parsed, ok] = mrPkg.ParseDeliveryMRURL(url);
        if (ok) {
          add(new DeliveryMR({ Project: project, IID: iid, URL: parsed }));
        }
      }
    }
    return out;
  }
  const out = [];
  for (const rc of repos) {
    const project = rc.GongfengProjectID.trim();
    let picked = null;
    let found = false;
    if (byBranch != null && rc.WorkBranch.trim() !== "") {
      [picked, found] = byBranch(rc);
    }
    if (!found) {
      for (const c of candidates) {
        if (c.mr.Project.toLowerCase() === project.toLowerCase()) {
          picked = c.mr;
          found = true;
          break;
        }
      }
    }
    if (!found) {
      continue;
    }
    if (picked.Project === "") {
      picked.Project = project;
    }
    if (picked.URL === "") {
      picked.URL = GongfengMRURL(picked.Project, picked.IID);
    }
    picked.RepositoryID = rc.RepositoryID;
    picked.Repository = rc.Name;
    out.push(picked);
  }
  return out;
}

/**
 * 从运行的 MR 相关产物中提取候选交付 MR，并按优先级降序、产物先后顺序降序（越新越优先）、IID 降序排列。
 * 供 ResolveRunDeliveryMRs 在分支查询未命中或无仓库绑定时作为候选来源。
 *
 * @param {import("./run.js").Run} run - 运行记录对象，读取其 Artifacts 数组。
 * @returns {Array<{ mr: DeliveryMR, priority: number, order: number }>} 去重并排序后的候选 MR 列表。
 */
function runArtifactMRCandidates(run) {
  const mrPkg = require("./mr.js");
  const best = {};
  run.Artifacts.forEach((art, idx) => {
    const pri = mrPkg.MRArtifactPriority(art.Name, art.Path, art.NodeID);
    if (pri <= 0) {
      return;
    }
    for (const ref of mrPkg.ParseGongfengMRs(art.Content)) {
      const key = `${ref.Project.toLowerCase()}#${ref.IID}`;
      if (Object.prototype.hasOwnProperty.call(best, key) && best[key].priority >= pri) {
        continue;
      }
      best[key] = {
        mr: new DeliveryMR({ Project: ref.Project, IID: ref.IID, URL: ref.URL }),
        priority: pri,
        order: idx,
      };
    }
  });
  const out = Object.values(best);
  out.sort((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    if (a.order !== b.order) {
      return b.order - a.order;
    }
    return b.mr.IID - a.mr.IID;
  });
  return out;
}

module.exports = {
  DeliveryMR,
  BranchMRQuery,
  GongfengMRURL,
  AggregateDeliveryMRState,
  ResolveRunDeliveryMRs,
};
