// project.js —— 对应 Go 文件：internal/domain/project.go
// 作用：项目、仓库与共峰仓库链接解析。

"use strict";

const { GongfengHost } = require("../config/integration_hosts.js"); // Go import agentflow/internal/config，对应已翻译文件

// Project：项目。
class Project {
  constructor(init = {}) {
    this.BusinessDomainID = init.BusinessDomainID ?? "";
    this.ID = init.ID ?? "";
    this.Key = init.Key ?? "";
    this.Name = init.Name ?? "";
    this.Description = init.Description ?? "";
    this.Color = init.Color ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    // SOPPlaybooks 是已命名的需求组合（如完整需求 / 仅后端）；需求选其一，不继承单个项目级链。
    this.SOPPlaybooks = init.SOPPlaybooks ?? [];
    // SOPBindings 是旧版单个组合；SOPPlaybooks 为空时仍把它作为默认组合暴露，旧项目继续可用。
    this.SOPBindings = init.SOPBindings ?? [];
    this.DefaultRepositoryID = init.DefaultRepositoryID ?? "";
    this.OwnerID = init.OwnerID ?? 0;
    this.Members = init.Members ?? [];
    this.RunEval = init.RunEval ?? new RunEvalPolicy();
    // 以下已废弃的项目级凭据字段仅保留，以便旧载荷能解码并由结构迁移清理。
    this.GitToken = init.GitToken ?? "";
    this.GitHubCredentialConfigured = init.GitHubCredentialConfigured ?? false;
    this.CodeBuddyAPIKey = init.CodeBuddyAPIKey ?? "";
    this.CodeBuddyAPIKeyConfigured = init.CodeBuddyAPIKeyConfigured ?? false;
    this.CodeBuddyInternetEnvironment = init.CodeBuddyInternetEnvironment ?? "";
    this.TAPDWorkspaceID = init.TAPDWorkspaceID ?? "";
    this.TAPDIterationID = init.TAPDIterationID ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
    // ArchivedAt 标记已删除项目；它在项目列表与同步中隐藏，但需求、运行与设置保留以便恢复，id 仍被占用。
    this.ArchivedAt = init.ArchivedAt ?? null;
    this.ArchivedBy = init.ArchivedBy ?? 0;
  }
}

function PublicProject(p) {
  const out = new Project(p);
  out.GitToken = "";
  out.GitHubCredentialConfigured = false;
  out.CodeBuddyAPIKey = "";
  out.CodeBuddyAPIKeyConfigured = false;
  return out;
}

function PublicProjects(items) {
  return (items ?? []).map((p) => PublicProject(p));
}

// ProjectMember：项目成员。
class ProjectMember {
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.Role = init.Role ?? "";
  }
}

// RepositoryProviderSSH 只用 Git 传输，没有托管 API 适配器。
const RepositoryProviderSSH = "ssh";

// RepositoryProviderHTTPS 用 Git 传输，没有托管 API 适配器。
const RepositoryProviderHTTPS = "https";

function GitOnlyRepositoryProvider(provider) {
  return provider === RepositoryProviderSSH || provider === RepositoryProviderHTTPS;
}

// Repository：仓库。
class Repository {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Provider = init.Provider ?? "";
    this.Name = init.Name ?? "";
    this.GongfengProjectID = init.GongfengProjectID ?? "";
    this.WebURL = init.WebURL ?? "";
    this.CloneURL = init.CloneURL ?? "";
    this.DefaultBranch = init.DefaultBranch ?? "";
    this.LocalPath = init.LocalPath ?? "";
    this.GitToken = init.GitToken ?? "";
    this.GitHubCredentialConfigured = init.GitHubCredentialConfigured ?? false;
    this.PipelineProjectID = init.PipelineProjectID ?? 0;
    this.PipelineDefID = init.PipelineDefID ?? 0;
    this.PipelineURLPattern = init.PipelineURLPattern ?? "";
    this.IntegrateBranch = init.IntegrateBranch ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

// PublicRepository：去掉 git token 再返回给 API；克隆与推送仍读实时 Studio 记录，运行快照永不复制 GitToken。
function PublicRepository(r) {
  const out = new Repository(r);
  out.GitHubCredentialConfigured = false;
  out.GitToken = "";
  // 凭据被拒收前保存的行可能仍嵌着凭据。
  out.CloneURL = StripURLCredentials(out.CloneURL);
  out.WebURL = StripURLCredentials(out.WebURL);
  return out;
}

// PublicRepositoryContext：去掉运行或任务快照里 URL 凭据再展示给读者；存储的快照保留凭据以便旧版克隆可用。
function PublicRepositoryContext(rc) {
  const out = new RepositoryContext(rc);
  out.CloneURL = StripURLCredentials(out.CloneURL);
  out.WebURL = StripURLCredentials(out.WebURL);
  return out;
}

function PublicRepositories(items) {
  return (items ?? []).map((r) => PublicRepository(r));
}

// RepositoryContext：一次运行冻结的仓库上下文。
class RepositoryContext {
  constructor(init = {}) {
    this.RepositoryID = init.RepositoryID ?? "";
    this.Provider = init.Provider ?? "";
    this.Name = init.Name ?? "";
    this.GongfengProjectID = init.GongfengProjectID ?? "";
    this.WebURL = init.WebURL ?? "";
    this.CloneURL = init.CloneURL ?? "";
    this.BaseBranch = init.BaseBranch ?? "";
    this.WorkBranch = init.WorkBranch ?? "";
    // RequireExistingWorkBranch 恢复已命名的远端分支，缺失时禁止创建替代分支。
    this.RequireExistingWorkBranch = init.RequireExistingWorkBranch ?? false;
    this.DefaultBranch = init.DefaultBranch ?? "";
    this.IntegrateBranch = init.IntegrateBranch ?? "";
    this.IntegrationReworks = init.IntegrationReworks ?? 0;
    this.LocalPath = init.LocalPath ?? "";
    this.PipelineProjectID = init.PipelineProjectID ?? 0;
    this.PipelineDefID = init.PipelineDefID ?? 0;
    this.PipelineURLPattern = init.PipelineURLPattern ?? "";
    this.AlignOnly = init.AlignOnly ?? false;
    // CreateNewWorkBranch 从基础分支创建 WorkBranch，同名远端分支存在时拒绝：调用方要的是新分支，既有同名分支属于别的工作，不能悄悄恢复。
    this.CreateNewWorkBranch = init.CreateNewWorkBranch ?? false;
    // ReadOnly 不带工作分支检出 BaseBranch：仓库可读、可构建、可测试，但永不提交或推送；这是落在 preview 这类共享分支上的唯一方式。
    this.ReadOnly = init.ReadOnly ?? false;
    // WorkspaceDir 是该仓库检出到的运行工作区一级子目录（斜杠分隔的相对路径）；空只保留给已在工作区根目录检出的持久化旧运行，新运行总会分到子目录，运行根目录的 SOP 交付物不会污染 git 检出。
    this.WorkspaceDir = init.WorkspaceDir ?? "";
  }

  // IsZero：报告该上下文是否完全没有可用仓库。
  IsZero() {
    return this.RepositoryID.trim() === "" &&
      this.CloneURL.trim() === "" &&
      this.GongfengProjectID.trim() === "" &&
      this.LocalPath.trim() === "";
  }
}

// GongfengRepoHost 标识旧版仓库与运行记录里的链接。
const GongfengRepoHost = "git.example.com";

function GongfengRepositoryHost() {
  const host = GongfengHost();
  if (host !== "") {
    return host;
  }
  return GongfengRepoHost;
}

function IsGongfengHost(host) {
  return host.toLowerCase() === GongfengRepositoryHost().toLowerCase() || host.toLowerCase() === GongfengRepoHost.toLowerCase();
}

// GongfengRepoInfo：从粘贴的共峰链接里解析出的仓库标识，用一个 URL 即可配置仓库。
class GongfengRepoInfo {
  constructor(init = {}) {
    this.Project = init.Project ?? "";
    this.Name = init.Name ?? "";
    this.WebURL = init.WebURL ?? "";
    this.CloneURL = init.CloneURL ?? "";
  }
}

// gongfengRepoSubpages：指向仓库子页面的 URL 后缀（树视图、MR 列表、issue 等）；第一个标记之前的是项目路径。
const gongfengRepoSubpages = [
  "/-/", "/tree/", "/blob/", "/commit/", "/commits/", "/merge_requests/",
  "/issues/", "/snippets/", "/wikis/", "/releases/", "/tags/",
];

// ParseGongfengRepoURL：把共峰（TGit）仓库引用解析为项目路径与规范化 URL，返回 [信息, 是否成功]。接受：
//   - https://git.example.com/group/repository
//   - https://git.example.com/group/repository/-/tree/master
//   - https://git.example.com/group/repository/merge_requests/12
//   - git@git.example.com:group/repository.git
//   - ssh://git@git.example.com:22/group/repository.git
//   - git.example.com/group/repository
//   - group/repository（裸项目路径，无 URL 装饰）
function ParseGongfengRepoURL(raw) {
  let s = raw.trim().replace(/^['"]+|['"]+$/g, "");
  if (s.length >= 10 && s.slice(0, 10).toLowerCase() === "git clone ") {
    s = s.slice(10).trim().replace(/^['"]+|['"]+$/g, "");
    const i = s.search(/[ \t]/);
    if (i >= 0) {
      s = s.slice(0, i);
    }
  }
  if (s === "") {
    return [new GongfengRepoInfo(), false];
  }
  if (/[ \t"'<>()]/.test(s)) {
    return [new GongfengRepoInfo(), false];
  }
  const sshClone = s.toLowerCase().startsWith("git@") || s.toLowerCase().startsWith("ssh://");
  if (s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  // 去掉协议与用户信息，ssh / https / scp 形式收敛到同一路径。
  let pathSource = s;
  const scheme = pathSource.indexOf("://");
  if (scheme >= 0) {
    pathSource = pathSource.slice(scheme + 3);
  }
  const at = pathSource.lastIndexOf("@");
  if (at >= 0) {
    pathSource = pathSource.slice(at + 1);
  }
  let path = "";
  for (const host of [GongfengRepositoryHost(), GongfengRepoHost]) {
    if (pathSource.length <= host.length || pathSource.slice(0, host.length).toLowerCase() !== host.toLowerCase()) {
      continue;
    }
    const tail = pathSource.slice(host.length);
    if (tail[0] === "/") {
      path = tail.slice(1);
    } else if (tail[0] === ":") {
      path = tail.slice(1);
      const j = path.indexOf("/");
      if (j >= 0 && isAllDigits(path.slice(0, j))) {
        path = path.slice(j + 1);
      }
    }
    if (path !== "") {
      break;
    }
  }
  if (path === "" && !/[:@]/.test(s)) {
    // 受信调用方仍可规范化已保存的项目 ID。
    path = pathSource;
  }
  if (path === "") {
    return [new GongfengRepoInfo(), false];
  }
  const project = normalizeGongfengProjectPath(path);
  if (project === "") {
    return [new GongfengRepoInfo(), false];
  }
  const info = new GongfengRepoInfo({ Project: project });
  info.Name = project.slice(project.lastIndexOf("/") + 1);
  const host = GongfengRepositoryHost();
  info.WebURL = "https://" + host + "/" + project;
  info.CloneURL = info.WebURL + ".git";
  if (sshClone && !host.includes(":")) {
    info.CloneURL = "git@" + host + ":" + project + ".git";
  }
  return [info, true];
}

// normalizeGongfengProjectPath：去掉仓库路径的克隆后缀与子页面标记，校验剩余的 "group/repository" 形状。
function normalizeGongfengProjectPath(path) {
  let p = path.trim();
  if (p.startsWith("/") || p.includes("..")) {
    // 绝对本地路径永不是仓库路径。
    return "";
  }
  if (p.toLowerCase().endsWith(".git")) {
    p = p.slice(0, p.length - 4);
  }
  for (const marker of gongfengRepoSubpages) {
    const i = p.indexOf(marker);
    if (i >= 0) {
      p = p.slice(0, i);
    }
  }
  p = p.replace(/^\/+|\/+$/g, "");
  if (p === "" || !p.includes("/")) {
    // 必须像 group/repository（至少两段）。
    return "";
  }
  for (const seg of p.split("/")) {
    if (seg === "" || /[ \t\\?#]/.test(seg)) {
      return "";
    }
  }
  return p;
}

function isAllDigits(s) {
  if (s === "") {
    return false;
  }
  for (const r of s) {
    if (r < "0" || r > "9") {
      return false;
    }
  }
  return true;
}

// IsSafeGongfengProjectID：报告 s 是否为安全的单段旧版共峰项目标识；仓库路径与链接须改走 ParseGongfengRepoURL，该兼容路径有意收窄，畸形路径无法绕过解析器。
function IsSafeGongfengProjectID(s) {
  s = s.trim();
  if (s === "" || s === "." || s === ".." || s.includes("..")) {
    return false;
  }
  for (const r of s) {
    if ((r >= "a" && r <= "z") || (r >= "A" && r <= "Z") ||
      (r >= "0" && r <= "9") || r === "-" || r === "_" || r === ".") {
      continue;
    }
    return false;
  }
  return true;
}

// NormalizeRepositoryDirName：把仓库名转成安全的单级目录名，用作运行工作区下的检出目录。
function NormalizeRepositoryDirName(rc) {
  const name = rc.Name.trim();
  let out = "";
  for (const r of name) {
    if ((r >= "a" && r <= "z") || (r >= "A" && r <= "Z") || (r >= "0" && r <= "9") || r === "-" || r === "_") {
      out += r;
    } else {
      out += "-";
    }
  }
  out = out.replace(/^-+|-+$/g, "");
  if (out === "") {
    out = rc.RepositoryID.trim();
  }
  if (out === "") {
    out = "repo";
  }
  return out;
}

// AssignRepositoryDirs：填 WorkspaceDir，让每个绑定仓库检出到运行工作区唯一的一级子目录；fix-plan.md 这类 SOP 交付物留在运行根目录，永不进入 git 检出。
function AssignRepositoryDirs(repositories) {
  const used = new Set();
  for (let i = 0; i < repositories.length; i++) {
    const base = NormalizeRepositoryDirName(repositories[i]);
    let dir = base;
    for (let n = 2; used.has(dir); n++) {
      dir = `${base}-${n}`;
    }
    used.add(dir);
    repositories[i].WorkspaceDir = dir;
  }
}

module.exports = { Project, PublicProject, PublicProjects, ProjectMember, RepositoryProviderSSH, RepositoryProviderHTTPS, GitOnlyRepositoryProvider, Repository, PublicRepository, PublicRepositoryContext, PublicRepositories, RepositoryContext, GongfengRepoHost, GongfengRepositoryHost, IsGongfengHost, GongfengRepoInfo, ParseGongfengRepoURL, IsSafeGongfengProjectID, NormalizeRepositoryDirName, AssignRepositoryDirs };
