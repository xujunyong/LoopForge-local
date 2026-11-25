// delivery_mr.js —— 对应 Go 文件：internal/domain/delivery_mr.go
// 作用：工作项的交付 MR 列表、状态聚合与按仓库解析。

"use strict";

// 同包引用：mr.go / project.go / user.go 的同包符号，待这些文件翻译后提供。
const mrPkg = require("./mr.js");
const projectPkg = require("./project.js");
const userPkg = require("./user.js");
const { Issue } = require("./issue.js");

// DeliveryMR：一个工作项交付的 MR，多仓 SOP 每仓至多一个。
class DeliveryMR {
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

// BranchMRQuery：向宿主查询某工作分支到某目标分支的 MR。
class BranchMRQuery {
  constructor(init = {}) {
    this.ProjectID = init.ProjectID ?? "";
    this.RemoteProject = init.RemoteProject ?? "";
    this.SourceBranch = init.SourceBranch ?? "";
    this.TargetBranch = init.TargetBranch ?? "";
    this.GitToken = init.GitToken ?? "";
    this.ResponsibleUserID = init.ResponsibleUserID ?? 0;
  }
}

// GongfengMRURL：工蜂 MR 的规范 Web 地址。
function GongfengMRURL(project, iid) {
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

// AggregateDeliveryMRState：把各 MR 状态折叠为工作项标签状态。
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

// DeliveryMRList：工作项的交付 MR 列表，兼容只有单个 MR 字段的老数据。
Issue.prototype.DeliveryMRList = function () {
  if (this.DeliveryMRs.length > 0) {
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

// HasDeliveryMR：url 是否是工作项的交付 MR 之一。
Issue.prototype.HasDeliveryMR = function (url) {
  for (const mr of this.DeliveryMRList() ?? []) {
    if (mrPkg.SameGongfengMR(mr.URL, url)) {
      return true;
    }
  }
  return false;
};

// SetDeliveryMRs：替换交付 MR 列表，并同步旧的单 MR 字段。
Issue.prototype.SetDeliveryMRs = function (mrs) {
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
    this.DeliveryMRs = null;
    this.DeliveryMRURL = "";
    this.DeliveryMRState = "";
    return;
  }
  this.DeliveryMRs = out;
  this.DeliveryMRURL = out[0].URL;
  this.DeliveryMRState = AggregateDeliveryMRState(out);
};

// SetDeliveryMRState：更新一个交付 MR 的状态，无 MR 的工作项以 url 为唯一 MR。
Issue.prototype.SetDeliveryMRState = function (url, state) {
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

// ResolveRunDeliveryMRs：为一次 run 的每个工蜂仓库挑出交付 MR。
function ResolveRunDeliveryMRs(run, byBranch) {
  const candidates = runArtifactMRCandidates(run);
  const repos = [];
  for (const rc of run.RepositoryContexts()) {
    if (rc.GongfengProjectID.trim() !== "" && !rc.AlignOnly) {
      repos.push(rc);
    }
  }
  if (repos.length === 0) {
    const out = [];
    const seen = new Set();
    const add = (mr) => {
      const project = mr.Project.toLowerCase();
      if (!seen.has(project)) {
        seen.add(project);
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

// runArtifactMRCandidates：MR 产物中引用的 MR，最优的在前：优先级高者优先，其次产物越新越优先。
function runArtifactMRCandidates(run) {
  const best = new Map();
  run.Artifacts.forEach((art, idx) => {
    const pri = mrPkg.MRArtifactPriority(art.Name, art.Path, art.NodeID);
    if (pri <= 0) {
      return;
    }
    for (const ref of mrPkg.ParseGongfengMRs(art.Content)) {
      const key = `${ref.Project.toLowerCase()}#${ref.IID}`;
      const cur = best.get(key);
      if (cur !== undefined && cur.priority >= pri) {
        continue;
      }
      best.set(key, { mr: new DeliveryMR({ Project: ref.Project, IID: ref.IID, URL: ref.URL }), priority: pri, order: idx });
    }
  });
  const out = [...best.values()];
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

module.exports = { DeliveryMR, BranchMRQuery, GongfengMRURL, AggregateDeliveryMRState, ResolveRunDeliveryMRs };
