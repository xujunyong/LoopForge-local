/**
 * @file internal/domain/project.js
 * @description 对应 Go 源文件：internal/domain/project.go
 * 职责边界：定义项目、项目成员、代码仓库、运行期冻结仓库上下文及共峰（TGit）仓库链接解析、脱敏和工作区子目录分配逻辑。
 * 语法差异说明：
 * - Go 的 `time.Time` / `*time.Time` 对应 JS 的 `Date | null`（零值为 `null`）。
 * - Go 的 `(GongfengRepoInfo, bool)` 返回译为 `[GongfengRepoInfo, boolean]` 二元数组。
 * - Go 的 `map[string]bool` 集合译为普通对象 `{}`（值为 `true`）。
 * - 为避免与 `run_eval.js` / `run.js` 发生循环引用，`Project` 构造函数内延迟引入 `RunEvalPolicy`。
 * - `normalizeGongfengProjectPath` 虽为 Go 未导出函数，但同包 `mr.js` 引用了它，因此一并导出。
 */

"use strict";

const { GongfengHost } = require("../config/integration_hosts.js"); // Go import agentflow/internal/config，对应已翻译文件
const { StripURLCredentials } = require("./clone_url.js");

/**
 * 平台项目实体。
 * 归属特定业务域，维护 SOP 组合模板、默认仓库、成员列表、运行评估策略、TAPD 集成配置及归档状态。
 */
class Project {
  /**
   * 构造项目实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.BusinessDomainID=""] - 所属业务域 ID。
   * @param {string} [init.ID=""] - 项目主键 ID。
   * @param {string} [init.Key=""] - 项目短标识键。
   * @param {string} [init.Name=""] - 项目名称。
   * @param {string} [init.Description=""] - 项目描述。
   * @param {string} [init.Color=""] - 项目展示色值。
   * @param {string} [init.WorkflowID=""] - 默认工作流 ID。
   * @param {object[]} [init.SOPPlaybooks=[]] - 命名的需求 SOP 组合列表（SOPPlaybook[]）。
   * @param {object[]} [init.SOPBindings=[]] - 兼容旧版的单组 SOP 绑定列表（IssueSOPBinding[]）。
   * @param {string} [init.DefaultRepositoryID=""] - 默认代码仓库 ID。
   * @param {number} [init.OwnerID=0] - 项目负责人用户 ID。
   * @param {ProjectMember[]} [init.Members=[]] - 项目成员列表。
   * @param {object} [init.RunEval] - 运行质量评估策略（RunEvalPolicy）。
   * @param {string} [init.GitToken=""] - 已废弃的项目级 Git 凭据（仅用于旧载荷解码与清理）。
   * @param {boolean} [init.GitHubCredentialConfigured=false] - 已废弃的 GitHub 凭据标记。
   * @param {string} [init.CodeBuddyAPIKey=""] - 已废弃的项目级 CodeBuddy API Key。
   * @param {boolean} [init.CodeBuddyAPIKeyConfigured=false] - 已废弃的 CodeBuddy Key 配置标记。
   * @param {string} [init.CodeBuddyInternetEnvironment=""] - 已废弃的网络环境字段。
   * @param {string} [init.TAPDWorkspaceID=""] - 关联 TAPD 项目空间 ID。
   * @param {string} [init.TAPDIterationID=""] - 关联 TAPD 迭代 ID。
   * @param {Date|null} [init.CreatedAt=null] - 创建时间。
   * @param {Date|null} [init.UpdatedAt=null] - 最近更新时间。
   * @param {Date|null} [init.ArchivedAt=null] - 归档（软删除）时间。
   * @param {number} [init.ArchivedBy=0] - 执行归档操作的用户 ID。
   */
  constructor(init = {}) {
    const { RunEvalPolicy } = require("./run_eval.js");
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

/**
 * 清除项目对象中已废弃的敏感凭据字段，返回可安全输出到 API 响应的副本。
 *
 * @param {Project} p - 原始项目对象。
 * @returns {Project} 脱敏后的项目副本。
 */
function PublicProject(p) {
  const out = new Project(p);
  out.GitToken = "";
  out.GitHubCredentialConfigured = false;
  out.CodeBuddyAPIKey = "";
  out.CodeBuddyAPIKeyConfigured = false;
  return out;
}

/**
 * 批量脱敏项目列表，用于项目列表 API 响应。
 *
 * @param {Project[]|null|undefined} items - 原始项目列表。
 * @returns {Project[]} 脱敏后的项目副本列表。
 */
function PublicProjects(items) {
  return (items ?? []).map((p) => PublicProject(p));
}

/**
 * 项目成员及角色映射。
 * 用于表示项目内的权限归属（maintainer、member 或 viewer）。
 */
class ProjectMember {
  /**
   * 构造项目成员实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {number} [init.UserID=0] - 成员用户 ID。
   * @param {string} [init.Role=""] - 成员角色（maintainer、member、viewer）。
   */
  constructor(init = {}) {
    this.UserID = init.UserID ?? 0;
    this.Role = init.Role ?? "";
  }
}

// 仅使用 SSH Git 传输协议、无托管平台 API 适配器的仓库提供方标识。
const RepositoryProviderSSH = "ssh";

// 仅使用 HTTPS Git 传输协议、无托管平台 API 适配器的仓库提供方标识。
const RepositoryProviderHTTPS = "https";

/**
 * 判断仓库提供方是否为纯 Git 传输类型（SSH 或 HTTPS，无托管平台 API 适配器）。
 *
 * @param {string} provider - 仓库提供方标识。
 * @returns {boolean} 是 `"ssh"` 或 `"https"` 时返回 `true`，否则返回 `false`。
 */
function GitOnlyRepositoryProvider(provider) {
  return provider === RepositoryProviderSSH || provider === RepositoryProviderHTTPS;
}

/**
 * 项目下配置的代码仓库实体。
 * 记录仓库提供方、访问与克隆地址、默认分支、集成目标分支及流水线关联信息。
 */
class Repository {
  /**
   * 构造代码仓库实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - 仓库主键 ID。
   * @param {string} [init.ProjectID=""] - 所属项目 ID。
   * @param {string} [init.Provider=""] - 仓库托管提供方标识。
   * @param {string} [init.Name=""] - 仓库展示名称。
   * @param {string} [init.GongfengProjectID=""] - 共峰（或带前缀的公开托管）项目标识。
   * @param {string} [init.WebURL=""] - 仓库网页访问地址。
   * @param {string} [init.CloneURL=""] - 仓库 Git 克隆地址。
   * @param {string} [init.DefaultBranch=""] - 仓库默认分支名。
   * @param {string} [init.LocalPath=""] - 本地仓库路径（如有）。
   * @param {string} [init.GitToken=""] - 已废弃的仓库级 Git 令牌。
   * @param {boolean} [init.GitHubCredentialConfigured=false] - 已废弃的 GitHub 凭据配置标记。
   * @param {number} [init.PipelineProjectID=0] - 关联流水线项目 ID。
   * @param {number} [init.PipelineDefID=0] - 关联流水线定义 ID。
   * @param {string} [init.PipelineURLPattern=""] - 流水线详情 URL 模板。
   * @param {string} [init.IntegrateBranch=""] - 默认集成分支名。
   * @param {Date|null} [init.CreatedAt=null] - 创建时间。
   * @param {Date|null} [init.UpdatedAt=null] - 最近更新时间。
   */
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

/**
 * 清除仓库对象中的 Git 令牌以及 `CloneURL`/`WebURL` 中可能内嵌的凭据，返回适合 API 展示的副本。
 * 实际克隆与推送仍读取实时记录；运行快照本身不会复制 `GitToken`。
 *
 * @param {Repository} r - 原始仓库对象。
 * @returns {Repository} 脱敏后的仓库副本。
 */
function PublicRepository(r) {
  const out = new Repository(r);
  out.GitHubCredentialConfigured = false;
  out.GitToken = "";
  // 凭据被拒收前保存的行可能仍嵌着凭据。
  out.CloneURL = StripURLCredentials(out.CloneURL);
  out.WebURL = StripURLCredentials(out.WebURL);
  return out;
}

/**
 * 剥离运行或任务快照的仓库上下文中的 URL 凭据，返回面向读者的安全副本。
 * 持久化快照保留原始值以兼容历史克隆记录。
 *
 * @param {RepositoryContext} rc - 原始仓库上下文对象。
 * @returns {RepositoryContext} 去除 URL 凭据后的仓库上下文副本。
 */
function PublicRepositoryContext(rc) {
  const out = new RepositoryContext(rc);
  out.CloneURL = StripURLCredentials(out.CloneURL);
  out.WebURL = StripURLCredentials(out.WebURL);
  return out;
}

/**
 * 批量脱敏代码仓库列表，用于仓库列表 API 响应。
 *
 * @param {Repository[]|null|undefined} items - 原始仓库列表。
 * @returns {Repository[]} 脱敏后的仓库副本列表。
 */
function PublicRepositories(items) {
  return (items ?? []).map((r) => PublicRepository(r));
}

/**
 * 一次运行启动时冻结的代码仓库上下文。
 * 描述仓库身份、基准分支、工作分支创建/恢复策略、只读模式以及运行工作区下的检出子目录。
 */
class RepositoryContext {
  /**
   * 构造仓库上下文实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.RepositoryID=""] - 仓库 ID。
   * @param {string} [init.Provider=""] - 仓库托管提供方。
   * @param {string} [init.Name=""] - 仓库名称。
   * @param {string} [init.GongfengProjectID=""] - 共峰或公开托管项目标识。
   * @param {string} [init.WebURL=""] - 仓库网页地址。
   * @param {string} [init.CloneURL=""] - 仓库克隆地址。
   * @param {string} [init.BaseBranch=""] - 基准分支名。
   * @param {string} [init.WorkBranch=""] - 工作分支名。
   * @param {boolean} [init.RequireExistingWorkBranch=false] - 是否要求必须恢复已存在的远端工作分支，缺失时禁止新建。
   * @param {string} [init.DefaultBranch=""] - 默认分支名。
   * @param {string} [init.IntegrateBranch=""] - 目标集成分支名。
   * @param {number} [init.IntegrationReworks=0] - 集成冲突返工次数。
   * @param {string} [init.LocalPath=""] - 本地路径。
   * @param {number} [init.PipelineProjectID=0] - 关联流水线项目 ID。
   * @param {number} [init.PipelineDefID=0] - 关联流水线定义 ID。
   * @param {string} [init.PipelineURLPattern=""] - 流水线 URL 模板。
   * @param {boolean} [init.AlignOnly=false] - 是否仅对齐代码而不执行开发修改。
   * @param {boolean} [init.CreateNewWorkBranch=false] - 是否必须基于基准分支新建工作分支，若同名远端分支已存在则拒绝。
   * @param {boolean} [init.ReadOnly=false] - 是否只读检出基准分支（禁止提交或推送）。
   * @param {string} [init.WorkspaceDir=""] - 检出到运行工作区的一级相对子目录名。
   */
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

  /**
   * 判断该仓库上下文是否为空（未携带任何可用的仓库标识、克隆地址、项目 ID 或本地路径）。
   *
   * @returns {boolean} 没有任何可用仓库信息时返回 `true`，否则返回 `false`。
   */
  IsZero() {
    return this.RepositoryID.trim() === "" &&
      this.CloneURL.trim() === "" &&
      this.GongfengProjectID.trim() === "" &&
      this.LocalPath.trim() === "";
  }
}

// 历史仓库与运行记录中使用的默认共峰主机名。
const GongfengRepoHost = "git.example.com";

/**
 * 获取当前生效的共峰仓库主机名；若未通过配置覆盖则回退到 `GongfengRepoHost`。
 *
 * @returns {string} 共峰仓库主机名。
 */
function GongfengRepositoryHost() {
  const host = GongfengHost();
  if (host !== "") {
    return host;
  }
  return GongfengRepoHost;
}

/**
 * 判断给定主机名是否匹配当前配置的共峰主机或历史默认共峰主机（忽略大小写）。
 *
 * @param {string} host - 待检查的主机名。
 * @returns {boolean} 属于共峰主机时返回 `true`，否则返回 `false`。
 */
function IsGongfengHost(host) {
  return host.toLowerCase() === GongfengRepositoryHost().toLowerCase() || host.toLowerCase() === GongfengRepoHost.toLowerCase();
}

/**
 * 从仓库链接中解析出的标准化仓库身份信息。
 * 供配置仓库时通过粘贴单个 URL 自动填充项目路径、名称、Web 地址与克隆地址。
 */
class GongfengRepoInfo {
  /**
   * 构造解析后的仓库信息实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.Project=""] - 规范化项目路径（如 `"group/repository"`）。
   * @param {string} [init.Name=""] - 仓库短名称（路径最后一段）。
   * @param {string} [init.WebURL=""] - 规范化的 HTTPS 网页地址。
   * @param {string} [init.CloneURL=""] - 规范化的 HTTPS 或 SSH 克隆地址。
   */
  constructor(init = {}) {
    this.Project = init.Project ?? "";
    this.Name = init.Name ?? "";
    this.WebURL = init.WebURL ?? "";
    this.CloneURL = init.CloneURL ?? "";
  }
}

// 指向仓库子页面（树视图、MR、Issue 等）的 URL 路径标记；首个标记之前的部分为项目路径。
const gongfengRepoSubpages = [
  "/-/", "/tree/", "/blob/", "/commit/", "/commits/", "/merge_requests/",
  "/issues/", "/snippets/", "/wikis/", "/releases/", "/tags/",
];

/**
 * 将共峰（TGit）的 HTTPS/SSH 链接、`git clone` 命令或裸项目路径解析为标准化仓库信息。
 * 支持如下格式：
 * - `https://git.example.com/group/repository`
 * - `https://git.example.com/group/repository/-/tree/master`
 * - `https://git.example.com/group/repository/merge_requests/12`
 * - `git@git.example.com:group/repository.git`
 * - `ssh://git@git.example.com:22/group/repository.git`
 * - `git.example.com/group/repository`
 * - `group/repository`
 *
 * @param {string} raw - 原始仓库链接、克隆命令或项目路径。
 * @returns {[GongfengRepoInfo, boolean]} 二元组 `[解析出的仓库信息, 是否解析成功]`。
 */
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

/**
 * 去除共峰仓库路径中的 `.git` 后缀与子页面路径标记，并校验其是否符合 `"group/repository"` 形态。
 * 拒绝绝对路径、含 `..` 的路径或包含非法字符的分段。
 *
 * @param {string} path - 原始仓库相对路径。
 * @returns {string} 规范化后的 `"group/repository"` 路径；不合法时返回空字符串 `""`。
 */
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

/**
 * 判断字符串是否非空且全部由 ASCII 数字字符 `0`-`9` 组成。
 * 用于识别 SSH URL 冒号后的端口号分段。
 *
 * @param {string} s - 待检测字符串。
 * @returns {boolean} 非空且全为数字时返回 `true`，否则返回 `false`。
 */
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

/**
 * 判断字符串是否为安全的单段旧版共峰项目标识（仅允许字母、数字、`-`、`_`、`.` 且不含 `..`）。
 * 完整仓库路径与链接应走 `ParseGongfengRepoURL`，此兼容校验有意收窄字符集。
 *
 * @param {string} s - 待校验的项目标识字符串。
 * @returns {boolean} 符合安全单段标识规则时返回 `true`，否则返回 `false`。
 */
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

/**
 * 将仓库名称转换为安全的一级子目录名，用作运行工作区下的代码检出目录。
 * 非字母/数字/`-`/`_` 字符统一替换为 `-`，若结果为空则依次回退到 `RepositoryID` 或 `"repo"`。
 *
 * @param {RepositoryContext} rc - 仓库上下文对象。
 * @returns {string} 规范化后的安全单级目录名。
 */
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

/**
 * 为运行绑定的仓库列表就地分配互不冲突的 `WorkspaceDir` 一级子目录名。
 * 同名冲突时自动追加 `-2`、`-3` 等数字后缀，保证运行根目录的 SOP 交付物与 Git 检出目录隔离。
 *
 * @param {RepositoryContext[]} repositories - 待分配检出目录的仓库上下文数组（就地修改每项的 `WorkspaceDir`）。
 * @returns {void} 无返回值。
 */
function AssignRepositoryDirs(repositories) {
  const used = {};
  for (let i = 0; i < repositories.length; i++) {
    const base = NormalizeRepositoryDirName(repositories[i]);
    let dir = base;
    for (let n = 2; used[dir]; n++) {
      dir = `${base}-${n}`;
    }
    used[dir] = true;
    repositories[i].WorkspaceDir = dir;
  }
}

module.exports = { Project, PublicProject, PublicProjects, ProjectMember, RepositoryProviderSSH, RepositoryProviderHTTPS, GitOnlyRepositoryProvider, Repository, PublicRepository, PublicRepositoryContext, PublicRepositories, RepositoryContext, GongfengRepoHost, GongfengRepositoryHost, IsGongfengHost, GongfengRepoInfo, ParseGongfengRepoURL, normalizeGongfengProjectPath, IsSafeGongfengProjectID, NormalizeRepositoryDirName, AssignRepositoryDirs };
