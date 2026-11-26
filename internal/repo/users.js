/**
 * @file internal/repo/users.js
 * 对应 Go 源文件：internal/repo/users.go
 *
 * 作用与职责边界：
 * 实现用户主记录（`users`）与个人配置/凭据（`user_configs`）的联合查询与写入、
 * 事务行锁保护的个人执行器凭据及助手默认配置更新、工蜂 OAuth 令牌保存，
 * 以及扩展 Agent CLI 凭据合并和 CLI 模型目录（含 Cursor 思考强度映射与通用推理强度）的规范化校验；
 * 领域方法挂载于 `UsersRepo.prototype`（`UsersRepo` 定义于 `repo.js`），不负责登录鉴权会话或平台管理员名单管理（见 `platform_admin.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)`、`(值1, 值2, error)` 与仅 `error` 返回统一按成功返回值（或二元组、`undefined`）、失败 `throw err` 处理；
 *   `db.Transaction(tx => ...)` 回调同样遵循失败抛错、成功正常返回。
 * - Go 的 `(值, bool)` 译为二元组 `[值, boolean]`；`errors.Is(err, gorm.ErrRecordNotFound)` 译为 `===`。
 * - Go 的 `map[string]V` 统一使用普通对象 `{}`；`struct` 字段严格按 Go 零值初始化（如 `UserCredentialUpdate.AgentCLICredentials` 为 `{}`）。
 * - Go 中按值比较 `AssistantDefaults` 结构体在 JS 中展开为逐字段比较；按字符数计数（`utf8.RuneCountInString`）译为 `[...name].length`，按 UTF-8 字节长度校验（`len(id)`）译为 `Buffer.byteLength(id, "utf8")`。
 */

"use strict";

const { Buffer } = require("node:buffer");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { User, PlatformRoleAdmin, CLIModel, AgentCLICredential, NormalizeAgentCLIProtocol } = require("../domain/user.js"); // 对应 Go 的 domain.User/PlatformRoleAdmin/CLIModel/AgentCLICredential/NormalizeAgentCLIProtocol，user.js 已翻译
const { AssistantDefaults } = require("../domain/assistant_preferences.js"); // 对应 Go 的 domain.AssistantDefaults，assistant_preferences.js 已翻译
const { ExecutorEffortLevels, IsAgentCLIKind } = require("../domain/agent.js"); // 对应 Go 的 domain.ExecutorEffortLevels/IsAgentCLIKind，agent.js 已翻译
const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { userRow, userConfigRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { upsert, insertIgnore, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { IsAllowlistedPlatformAdmin } = require("./platform_admin.js"); // 对应 Go 同包函数，platform_admin.js 已翻译
const { managedGitHTTPCredential } = require("./git_http_credentials.js"); // 对应 Go 同包函数，git_http_credentials.js 已翻译
const { ErrAssistantDefaultExecutorUnavailable, firstAssistantExecutor } = require("./user_assistant_defaults.js"); // 对应 Go 同包函数，user_assistant_defaults.js 已翻译

// ---------- Users ----------

/**
 * 承载 `users` 左连接 `user_configs` 联合查询结果的内部投影行模型，并附带 Git 凭据配置存在性子查询列。
 */
class userWithConfig {
  /**
   * 构造联合查询投影行实例，缺省字段严格按 Go 零值初始化（指针列为 `null`）。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? 0;
    this.StaffID = init.StaffID ?? 0;
    this.LoginName = init.LoginName ?? "";
    this.ChineseName = init.ChineseName ?? "";
    this.DeptID = init.DeptID ?? 0;
    this.DeptName = init.DeptName ?? "";
    this.PlatformRole = init.PlatformRole ?? "";
    this.GitToken = init.GitToken ?? null;
    this.GitSSHKeyConfigured = init.GitSSHKeyConfigured ?? false;
    this.GitHTTPCredentialsConfigured = init.GitHTTPCredentialsConfigured ?? false;
    this.GitHubCredentialConfigured = init.GitHubCredentialConfigured ?? false;
    this.GongfengRefreshToken = init.GongfengRefreshToken ?? null;
    this.GongfengTokenExpiresAt = init.GongfengTokenExpiresAt ?? null;
    this.CodeBuddyAPIKey = init.CodeBuddyAPIKey ?? null;
    this.CodeBuddyBaseURL = init.CodeBuddyBaseURL ?? null;
    this.CodeBuddyInternetEnvironment = init.CodeBuddyInternetEnvironment ?? "";
    this.CodeBuddyModels = init.CodeBuddyModels ?? null;
    this.CodexAPIKey = init.CodexAPIKey ?? null;
    this.CodexBaseURL = init.CodexBaseURL ?? null;
    this.CodexModels = init.CodexModels ?? null;
    this.ClaudeCodeAPIKey = init.ClaudeCodeAPIKey ?? null;
    this.ClaudeCodeBaseURL = init.ClaudeCodeBaseURL ?? null;
    this.ClaudeCodeModels = init.ClaudeCodeModels ?? null;
    this.AgentCLICredentials = init.AgentCLICredentials ?? null;
    this.AssistantDefaults = init.AssistantDefaults ?? null;
    this.Created = init.Created ?? null;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 将联合查询投影行转换为 `User` 领域对象，解码各执行器模型目录、扩展 CLI 凭据与助手默认设置，
   * 并根据是否存在平台托管工蜂 HTTPS 凭据补充 `GitHTTPCredentialsConfigured` 标记。
   *
   * @returns {User} 转换后的用户领域对象。
   */
  toDomain() {
    const u = new User({
      ID: this.ID, StaffID: this.StaffID, LoginName: this.LoginName, ChineseName: this.ChineseName,
      DeptID: this.DeptID, DeptName: this.DeptName, PlatformRole: this.PlatformRole,
      CodeBuddyInternetEnvironment: this.CodeBuddyInternetEnvironment,
      CodeBuddyModels: decodeCLIModels(this.CodeBuddyModels),
      GitSSHKeyConfigured: this.GitSSHKeyConfigured,
      GitHTTPCredentialsConfigured: this.GitHTTPCredentialsConfigured,
      GitHubCredentialConfigured: this.GitHubCredentialConfigured,
      // Go 的 AssistantDefaults 是值类型，零值为空结构体，JS 里显式给出。
      AssistantDefaults: new AssistantDefaults(),
    });
    if (this.GitToken != null) {
      u.GitToken = this.GitToken;
    }
    if (this.GongfengRefreshToken != null) {
      u.GongfengRefreshToken = this.GongfengRefreshToken;
    }
    if (this.GongfengTokenExpiresAt != null) {
      u.GongfengTokenExpiresAt = this.GongfengTokenExpiresAt;
    }
    if (this.CodeBuddyAPIKey != null) {
      u.CodeBuddyAPIKey = this.CodeBuddyAPIKey;
    }
    if (this.CodeBuddyBaseURL != null) {
      u.CodeBuddyBaseURL = this.CodeBuddyBaseURL;
    }
    if (this.CodexAPIKey != null) {
      u.CodexAPIKey = this.CodexAPIKey;
    }
    if (this.CodexBaseURL != null) {
      u.CodexBaseURL = this.CodexBaseURL;
    }
    u.CodexModels = decodeCLIModels(this.CodexModels);
    if (this.ClaudeCodeAPIKey != null) {
      u.ClaudeCodeAPIKey = this.ClaudeCodeAPIKey;
    }
    if (this.ClaudeCodeBaseURL != null) {
      u.ClaudeCodeBaseURL = this.ClaudeCodeBaseURL;
    }
    u.ClaudeCodeModels = decodeCLIModels(this.ClaudeCodeModels);
    if (this.AgentCLICredentials != null) {
      try {
        u.AgentCLICredentials = JSON.parse(this.AgentCLICredentials);
      } catch {
        // Go 忽略解码错误。
      }
    }
    if (this.AssistantDefaults != null) {
      try {
        u.AssistantDefaults = new AssistantDefaults(JSON.parse(this.AssistantDefaults));
      } catch {
        // Go 忽略解码错误。
      }
    }
    if (this.Created != null) {
      u.CreatedAt = this.Created;
    }
    if (this.Updated != null) {
      u.UpdatedAt = this.Updated;
    }
    const [, managed] = managedGitHTTPCredential(u);
    if (managed) {
      u.GitHTTPCredentialsConfigured = true;
    }
    return u;
  }
}

// 联合查询 `users` 与 `user_configs` 时复用的 SELECT 投影列清单。
const userSelectColumns = `u.id, u.staff_id, u.login_name, u.chinese_name, u.dept_id, u.dept_name,
	COALESCE(u.platform_role, '') AS platform_role,
	c.git_token, EXISTS (SELECT 1 FROM user_git_ssh_keys k WHERE k.user_id = u.id) AS git_ssh_key_configured,
	EXISTS (SELECT 1 FROM user_git_http_credentials h WHERE h.user_id = u.id) AS git_http_credentials_configured,
	EXISTS (SELECT 1 FROM user_git_http_credentials h WHERE h.user_id = u.id AND h.host = 'github.com') AS github_credential_configured,
	c.gongfeng_refresh_token, c.gongfeng_token_expires_at, c.codebuddy_api_key, c.codebuddy_base_url,
	COALESCE(c.codebuddy_internet_environment, '') AS codebuddy_internet_environment, c.codebuddy_models,
	c.codex_api_key, c.codex_base_url, c.codex_models, c.claude_code_api_key, c.claude_code_base_url, c.claude_code_models,
	c.agent_cli_credentials, c.assistant_defaults,
	u.created_at, u.updated_at`;

/**
 * 按给定 `WHERE` 条件查询单个用户及其配置记录，并映射为领域对象。
 * 使用场景：供 `User`、`UserByLoginName`、`UserByStaffID` 共用。
 *
 * @param {string} where - SQL `WHERE` 子句条件表达式（不包含 `WHERE` 关键字）。
 * @param {...*} args - 绑定到 `where` 占位符的参数列表。
 * @returns {[User, boolean]} 查询命中有效用户时返回 `[user, true]`，否则返回 `[空 User, false]`。
 */
UsersRepo.prototype.userQuery = function (where, ...args) {
  const row = new userWithConfig();
  const q = this.DB.Raw(`SELECT ${userSelectColumns} FROM users u LEFT JOIN user_configs c ON c.user_id=u.id WHERE ${where}`, ...args);
  if (q.Scan(row).Error != null || row.ID === 0) {
    return [new User(), false];
  }
  return [row.toDomain(), true];
};

/**
 * 查询全部用户及其配置记录，并按 `LoginName` 字典序升序返回。
 * 使用场景：成员选择器、权限配置页及平台管理员名单展示。
 *
 * @returns {User[]} 按登录名升序排列的用户领域对象数组；查询失败时返回空数组。
 */
UsersRepo.prototype.Users = function () {
  const rows = [];
  if (this.DB.Raw(`SELECT ${userSelectColumns} FROM users u LEFT JOIN user_configs c ON c.user_id=u.id ORDER BY u.login_name ASC`).Scan(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    out.push(row.toDomain());
  }
  out.sort((a, b) => (a.LoginName < b.LoginName ? -1 : a.LoginName > b.LoginName ? 1 : 0));
  return out;
};

/**
 * 按数字主键 ID 查询单个用户及其配置。
 * 使用场景：鉴权上下文加载当前用户或按用户 ID 补全展示信息。
 *
 * @param {number} id - 用户数字主键 ID；小于等于 0 时直接返回未找到。
 * @returns {[User, boolean]} 找到时返回 `[user, true]`，否则返回 `[空 User, false]`。
 */
UsersRepo.prototype.User = function (id) {
  if (id <= 0) {
    return [new User(), false];
  }
  return this.userQuery("u.id=?", id);
};

/**
 * 按登录名不区分大小写查询单个用户及其配置；MySQL 下直接利用不区分大小写排序规则保持索引命中。
 * 使用场景：登录回调或按账号查找用户记录。
 *
 * @param {string} loginName - 用户登录名。
 * @returns {[User, boolean]} 找到时返回 `[user, true]`，否则返回 `[空 User, false]`。
 */
UsersRepo.prototype.UserByLoginName = function (loginName) {
  if (this.isMySQL()) {
    // MySQL 排序规则本身不区分大小写，直接等值查询可保持索引命中。
    return this.userQuery("u.login_name=?", loginName);
  }
  return this.userQuery("LOWER(u.login_name) = LOWER(?)", loginName);
};

/**
 * 按企业工号（`staff_id`）查询单个用户及其配置。
 * 使用场景：单点登录或组织架构同步按工号匹配本地用户。
 *
 * @param {number} staffID - 用户数字工号。
 * @returns {[User, boolean]} 找到时返回 `[user, true]`，否则返回 `[空 User, false]`。
 */
UsersRepo.prototype.UserByStaffID = function (staffID) {
  return this.userQuery("u.staff_id=?", staffID);
};

/**
 * 创建或刷新用户身份主记录；登录刷新时仅更新身份信息并完整保留既有凭据与原角色，
 * 命中管理员白名单时自动授予平台管理员角色；仅在首次建档且携带初始配置时一并写入 `user_configs`。
 *
 * @param {User} v - 待保存的用户领域对象（`LoginName`、`StaffID`、`ID` 至少提供其一）。
 * @returns {void} 无返回值。
 * @throws {Error} 缺少身份标识或数据库写入失败时抛出错误。
 */
UsersRepo.prototype.PutUser = function (v) {
  if (v.LoginName === "" && v.StaffID === 0 && v.ID === 0) {
    throw new Error("user loginName, staffId, or ID is required");
  }
  const now = new Date();
  let old = new User();
  let ok = false;
  if (v.ID > 0) {
    [old, ok] = this.User(v.ID);
  } else if (v.LoginName !== "") {
    [old, ok] = this.UserByLoginName(v.LoginName);
  }
  if (ok) {
    if (v.ID === 0) {
      v.ID = old.ID;
    }
    v.CreatedAt = old.CreatedAt;
    // 登录认证仅刷新身份字段；个人凭据由 UpdateUserCredentials 独立维护，每次登录刷新都必须保留。
    v.GitToken = old.GitToken;
    v.GongfengRefreshToken = old.GongfengRefreshToken;
    v.GongfengTokenExpiresAt = old.GongfengTokenExpiresAt;
    v.CodexAPIKey = old.CodexAPIKey;
    v.CodexBaseURL = old.CodexBaseURL;
    v.CodexModels = old.CodexModels;
    v.ClaudeCodeAPIKey = old.ClaudeCodeAPIKey;
    v.ClaudeCodeBaseURL = old.ClaudeCodeBaseURL;
    v.ClaudeCodeModels = old.ClaudeCodeModels;
    v.CodeBuddyAPIKey = old.CodeBuddyAPIKey;
    v.CodeBuddyBaseURL = old.CodeBuddyBaseURL;
    v.CodeBuddyInternetEnvironment = old.CodeBuddyInternetEnvironment;
    v.CodeBuddyModels = old.CodeBuddyModels;
    v.AgentCLICredentials = old.AgentCLICredentials;
    if (v.PlatformRole.trim() === "") {
      v.PlatformRole = old.PlatformRole;
    }
  } else {
    v.CreatedAt = now;
  }
  if (IsAllowlistedPlatformAdmin(v.LoginName)) {
    v.PlatformRole = PlatformRoleAdmin;
  }
  v.UpdatedAt = now;
  const saved = this.writeUser(v);
  if (!ok && userHasConfig(saved)) {
    this.writeUserConfig(saved);
  }
};

/**
 * 将用户主记录写入 `users` 表：已有主键 ID 时执行冲突覆盖，否则执行忽略冲突插入并在并发撞上唯一登录名时认领并刷新既有行。
 * 使用场景：由 `PutUser` 内部调用以处理并发首次登录建档。
 *
 * @param {User} v - 待写入的用户领域对象。
 * @returns {User} 已补全数据库主键 `ID` 的用户对象。
 * @throws {Error} 数据库插入、查询或更新失败时抛出错误。
 */
UsersRepo.prototype.writeUser = function (v) {
  if (v.ID > 0) {
    upsert(this.DB, "users", {
      id: v.ID, staff_id: v.StaffID, login_name: v.LoginName, chinese_name: v.ChineseName,
      dept_id: v.DeptID, dept_name: v.DeptName, platform_role: v.PlatformRole,
      created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
    });
    return v;
  }
  const inserted = insertIgnore(this.DB, "users", {
    staff_id: v.StaffID, login_name: v.LoginName, chinese_name: v.ChineseName,
    dept_id: v.DeptID, dept_name: v.DeptName, platform_role: v.PlatformRole,
    created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  });
  if (!inserted) {
    // 唯一登录名已存在：认领该行并刷新其最新身份信息。
    const existing = new userRow();
    const takeErr = this.DB.Where("login_name = ?", v.LoginName).Take(existing).Error;
    if (takeErr != null) {
      throw takeErr;
    }
    const updateErr = this.DB.Model(new userRow()).Where("id = ?", existing.ID).Updates({
      staff_id: v.StaffID, chinese_name: v.ChineseName, dept_id: v.DeptID,
      dept_name: v.DeptName, platform_role: v.PlatformRole, updated_at: timePtr(v.UpdatedAt),
    }).Error;
    if (updateErr != null) {
      throw updateErr;
    }
    v.ID = existing.ID;
    return v;
  }
  const row = new userRow();
  const takeErr = this.DB.Where("login_name = ?", v.LoginName).Take(row).Error;
  if (takeErr != null) {
    throw takeErr;
  }
  v.ID = row.ID;
  return v;
};

/**
 * 判断用户对象是否包含任意非空的个人 Git 或执行器凭据/模型配置。
 * 使用场景：`PutUser` 新建用户时决定是否需要同步写入一条 `user_configs` 记录。
 *
 * @param {User} user - 待检测的用户领域对象。
 * @returns {boolean} 存在任一非空配置项时返回 `true`，否则返回 `false`。
 */
function userHasConfig(user) {
  return user.GitToken !== "" ||
    user.GongfengRefreshToken !== "" ||
    user.CodeBuddyAPIKey !== "" ||
    user.CodeBuddyBaseURL !== "" ||
    user.CodeBuddyInternetEnvironment !== "" ||
    (user.CodeBuddyModels ?? []).length > 0 ||
    user.CodexAPIKey !== "" ||
    user.CodexBaseURL !== "" ||
    (user.CodexModels ?? []).length > 0 ||
    user.ClaudeCodeAPIKey !== "" ||
    user.ClaudeCodeBaseURL !== "" ||
    (user.ClaudeCodeModels ?? []).length > 0 ||
    Object.keys(user.AgentCLICredentials ?? {}).length > 0;
}

/**
 * 用户个人执行器凭据、模型目录与助手默认参数的增量更新请求结构。
 * 指针类型字段传 `null` 表示保持原存储值不变，非空时覆盖更新。
 */
class UserCredentialUpdate {
  /**
   * 构造 `UserCredentialUpdate` 实例，缺省字段严格按 Go 零值初始化（映射字段初始化为 `{}`）。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.AssistantDefaults = init.AssistantDefaults ?? null;
    this.CodeBuddyAPIKey = init.CodeBuddyAPIKey ?? "";
    this.CodeBuddyAPIKeyClear = init.CodeBuddyAPIKeyClear ?? false;
    this.CodeBuddyBaseURL = init.CodeBuddyBaseURL ?? null;
    this.CodeBuddyInternetEnvironment = init.CodeBuddyInternetEnvironment ?? null;
    this.CodeBuddyModels = init.CodeBuddyModels ?? null;
    this.CodexAPIKey = init.CodexAPIKey ?? "";
    this.CodexAPIKeyClear = init.CodexAPIKeyClear ?? false;
    this.CodexBaseURL = init.CodexBaseURL ?? null;
    this.CodexModels = init.CodexModels ?? null;
    this.ClaudeCodeAPIKey = init.ClaudeCodeAPIKey ?? "";
    this.ClaudeCodeAPIKeyClear = init.ClaudeCodeAPIKeyClear ?? false;
    this.ClaudeCodeBaseURL = init.ClaudeCodeBaseURL ?? null;
    this.ClaudeCodeModels = init.ClaudeCodeModels ?? null;
    // 按 CLI 种类更新扩展 Agent CLI 凭据，缺省字段保留原值；CodeBuddy、Codex、Claude Code 仍存在各自独立列。
    this.AgentCLICredentials = init.AgentCLICredentials ?? {};
  }
}

/**
 * 单个扩展 Agent CLI 的凭据增量更新结构。
 */
class AgentCLICredentialUpdate {
  /**
   * 构造 `AgentCLICredentialUpdate` 实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.APIKey=""] - 新设置的 API Key（非空时覆盖）。
   * @param {boolean} [init.APIKeyClear=false] - 为 `true` 时清空现有 API Key。
   * @param {string | null} [init.BaseURL=null] - 可选更新的接口地址；`null` 表示保持不变。
   * @param {string | null} [init.Protocol=null] - 可选更新的协议类型；`null` 表示保持不变。
   * @param {CLIModel[] | null} [init.Models=null] - 可选更新的模型目录列表；`null` 表示保持不变。
   * @param {string} [init.DiscoveredForKey=""] - 自动发现模型目录时所对应的旧密钥，防止延迟回写覆盖新密钥目录。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.APIKey = init.APIKey ?? "";
    this.APIKeyClear = init.APIKeyClear ?? false;
    this.BaseURL = init.BaseURL ?? null;
    this.Protocol = init.Protocol ?? null;
    this.Models = init.Models ?? null;
    // 防止旧密钥触发的模型发现结果晚到并覆盖新密钥的模型目录。
    this.DiscoveredForKey = init.DiscoveredForKey ?? "";
  }
}

/**
 * 在事务并对 `users` 主行加排他锁的保护下更新指定用户的执行器凭据、模型目录与助手默认设置，
 * 即使请求跨多实例并发到达或尚未存在 `user_configs` 行也能严格串行化。
 *
 * @param {number} id - 目标用户数字主键 ID。
 * @param {UserCredentialUpdate} update - 增量凭据与默认配置更新载荷。
 * @returns {User} 更新并持久化后的完整用户领域对象。
 * @throws {Error} 用户不存在、参数校验失败或数据库事务执行失败时抛出错误。
 */
UsersRepo.prototype.UpdateUserCredentials = function (id, update) {
  let user = new User();
  this.DB.Transaction((tx) => {
    // 通过锁定 users 行，串行化同一用户的手工编辑与 CLI 模型自动发现写入。
    const owner = new userRow();
    const lockErr = this.locking(tx.Select("id")).Where("id = ?", id).Take(owner).Error;
    if (lockErr != null) {
      if (lockErr === gorm.ErrRecordNotFound) {
        throw new Error("user not found");
      }
      throw lockErr;
    }
    const credentials = new UsersRepo({ DB: tx });
    user = credentials.updateUserCredentials(id, update);
  });
  return user;
};

/**
 * 在事务内执行用户凭据、模型目录校验合并与助手默认执行器回退，并落库到 `user_configs`。
 * 使用场景：仅由 `UpdateUserCredentials` 在持有用户行锁的事务中调用。
 *
 * @param {number} id - 目标用户数字主键 ID。
 * @param {UserCredentialUpdate} update - 增量凭据更新载荷。
 * @returns {User} 更新并持久化后的用户领域对象。
 * @throws {Error} 用户不存在、模型目录/协议/默认执行器校验失败或写库失败时抛出错误。
 */
UsersRepo.prototype.updateUserCredentials = function (id, update) {
  const [user, ok] = this.User(id);
  if (!ok) {
    throw new Error("user not found");
  }
  // Go 按值复制结构体，JS 里展开复制一份再比较。
  const previousDefaults = { ...user.AssistantDefaults };
  if (user.AssistantDefaults.Executor === "") {
    user.AssistantDefaults.Executor = firstAssistantExecutor(user);
  }
  if (update.CodeBuddyAPIKeyClear) {
    user.CodeBuddyAPIKey = "";
    user.CodeBuddyBaseURL = "";
  } else if (update.CodeBuddyAPIKey.trim() !== "") {
    user.CodeBuddyAPIKey = update.CodeBuddyAPIKey.trim();
  }
  if (update.CodeBuddyBaseURL != null && !update.CodeBuddyAPIKeyClear) {
    user.CodeBuddyBaseURL = update.CodeBuddyBaseURL.trim();
  }
  if (update.CodeBuddyInternetEnvironment != null) {
    user.CodeBuddyInternetEnvironment = update.CodeBuddyInternetEnvironment.trim();
  }
  if (update.CodeBuddyModels != null) {
    user.CodeBuddyModels = normalizeCLIModels(update.CodeBuddyModels);
  }
  if (update.CodexAPIKeyClear) {
    user.CodexAPIKey = "";
  } else if (update.CodexAPIKey.trim() !== "") {
    user.CodexAPIKey = update.CodexAPIKey.trim();
  }
  if (update.ClaudeCodeAPIKeyClear) {
    user.ClaudeCodeAPIKey = "";
  } else if (update.ClaudeCodeAPIKey.trim() !== "") {
    user.ClaudeCodeAPIKey = update.ClaudeCodeAPIKey.trim();
  }
  if (update.CodexBaseURL != null) {
    user.CodexBaseURL = update.CodexBaseURL.trim();
  }
  if (update.ClaudeCodeBaseURL != null) {
    user.ClaudeCodeBaseURL = update.ClaudeCodeBaseURL.trim();
  }
  if (update.CodexModels != null) {
    user.CodexModels = normalizeCLIModels(update.CodexModels);
  }
  if (update.ClaudeCodeModels != null) {
    user.ClaudeCodeModels = normalizeCLIModels(update.ClaudeCodeModels);
  }
  applyAgentCLICredentialUpdates(user, update.AgentCLICredentials);
  if (update.AssistantDefaults != null) {
    if (!user.HasExecutorCredential(update.AssistantDefaults.Executor)) {
      throw ErrAssistantDefaultExecutorUnavailable;
    }
    user.AssistantDefaults = new AssistantDefaults(update.AssistantDefaults);
  } else if (!user.HasExecutorCredential(user.AssistantDefaults.Executor)) {
    user.AssistantDefaults.Executor = firstAssistantExecutor(user);
    user.AssistantDefaults.Model = "";
    user.AssistantDefaults.Effort = "";
  }
  user.UpdatedAt = new Date();
  this.writeUserConfig(user);
  // Go 按值比较结构体，JS 里逐字段比较。
  if (user.AssistantDefaults.Executor !== previousDefaults.Executor || user.AssistantDefaults.Model !== previousDefaults.Model || user.AssistantDefaults.Effort !== previousDefaults.Effort || user.AssistantDefaults.Approval !== previousDefaults.Approval) {
    const value = JSON.stringify(user.AssistantDefaults);
    const updateErr = this.DB.Model(new userConfigRow()).Where("user_id = ?", id).Update("assistant_defaults", value).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  }
  return user;
};

/**
 * 保存用户的工蜂 OAuth 访问令牌（写入 `git_token` 槽位）、刷新令牌及过期时间，供后续 Git 操作自动续期。
 * 使用场景：工蜂 OAuth 授权回调或令牌自动刷新完成后落库。
 *
 * @param {number} id - 目标用户数字主键 ID。
 * @param {string} accessToken - 工蜂 OAuth 访问令牌。
 * @param {string} refreshToken - 工蜂 OAuth 刷新令牌。
 * @param {Date} expiresAt - 访问令牌过期时间（将转为 UTC 保存）。
 * @returns {User} 更新后的用户领域对象。
 * @throws {Error} 用户不存在或写库失败时抛出错误。
 */
UsersRepo.prototype.SaveGongfengOAuth = function (id, accessToken, refreshToken, expiresAt) {
  const [user, ok] = this.User(id);
  if (!ok) {
    throw new Error("user not found");
  }
  user.GitToken = accessToken.trim();
  user.GongfengRefreshToken = refreshToken.trim();
  user.GongfengTokenExpiresAt = new Date(expiresAt.getTime());
  user.UpdatedAt = new Date();
  this.writeUserConfig(user);
  return user;
};

/**
 * 将用户的全部凭据与模型配置列以冲突覆盖（upsert）方式写入 `user_configs` 表。
 * 使用场景：由 `PutUser`、`updateUserCredentials`、`SaveGongfengOAuth` 内部调用。
 *
 * @param {User} v - 待持久化配置的用户领域对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
UsersRepo.prototype.writeUserConfig = function (v) {
  const values = {
    user_id: v.ID,
    git_token: nullableString(v.GitToken),
    gongfeng_refresh_token: nullableString(v.GongfengRefreshToken), gongfeng_token_expires_at: timePtr(v.GongfengTokenExpiresAt),
    codebuddy_api_key: nullableString(v.CodeBuddyAPIKey),
    codebuddy_base_url: nullableString(v.CodeBuddyBaseURL),
    codebuddy_internet_environment: v.CodeBuddyInternetEnvironment,
    codebuddy_models: encodeCLIModels(v.CodeBuddyModels),
    codex_api_key: nullableString(v.CodexAPIKey), codex_base_url: nullableString(v.CodexBaseURL), codex_models: encodeCLIModels(v.CodexModels),
    claude_code_api_key: nullableString(v.ClaudeCodeAPIKey), claude_code_base_url: nullableString(v.ClaudeCodeBaseURL), claude_code_models: encodeCLIModels(v.ClaudeCodeModels),
    agent_cli_credentials: encodeAgentCLICredentials(v.AgentCLICredentials),
    created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  };
  upsert(this.DB, "user_configs", values);
};

/**
 * 将空字符串转换为数据库 `NULL`（`null`），非空字符串原样返回。
 * 使用场景：写入 `user_configs` 的可空凭据列时避免存入空串。
 *
 * @param {string} v - 待转换的字符串值。
 * @returns {string | null} 空字符串返回 `null`，非空字符串原样返回。
 */
function nullableString(v) {
  if (v === "") {
    return null;
  }
  return v;
}

/**
 * 将扩展 Agent CLI 凭据的增量变更合并到 `user.AgentCLICredentials` 中：
 * 校验 CLI 类型与协议合法性、按需重置 Cursor 更换密钥后的旧模型目录、防止过期发现结果覆盖自定义目录，并剔除已清空的条目。
 *
 * @param {User} user - 待就地更新 `AgentCLICredentials` 的用户领域对象。
 * @param {Object.<string, AgentCLICredentialUpdate> | null} updates - 按 CLI 类型索引的增量凭据更新映射。
 * @returns {void} 无返回值。
 * @throws {Error} 传入不支持的 CLI 类型、不支持的协议或模型目录校验失败时抛出错误。
 */
function applyAgentCLICredentialUpdates(user, updates) {
  if (updates == null || Object.keys(updates).length === 0) {
    return;
  }
  let merged = {};
  for (const [kind, cred] of Object.entries(user.AgentCLICredentials ?? {})) {
    merged[kind] = cred;
  }
  for (let [kind, update] of Object.entries(updates)) {
    kind = kind.trim();
    if (!IsAgentCLIKind(kind)) {
      throw new Error(`不支持的 CLI：${kind}`);
    }
    // Go 读缺失的 map 键得零值，JS 取不到时按空凭据处理。
    const cred = merged[kind] ?? new AgentCLICredential();
    const previousKey = cred.APIKey;
    if (update.APIKeyClear) {
      cred.APIKey = "";
    } else if (update.APIKey.trim() !== "") {
      cred.APIKey = update.APIKey.trim();
    }
    // Cursor 的模型目录与思考强度变体绑定于密钥所属套餐；更换密钥且未同时提交新目录时清空旧目录。
    if (kind === "cursor" && cred.APIKey !== previousKey && update.Models == null) {
      cred.Models = null;
      cred.ModelsCustomized = false;
    }
    if (update.BaseURL != null) {
      cred.BaseURL = update.BaseURL.trim();
    }
    if (update.Protocol != null) {
      const protocol = update.Protocol.trim();
      if (protocol !== "" && NormalizeAgentCLIProtocol(kind, protocol) !== protocol) {
        throw new Error(`${kind} 不支持协议 ${protocol}`);
      }
      cred.Protocol = protocol;
    }
    const discovered = (update.DiscoveredForKey ?? "") !== "";
    if (update.Models != null && (!discovered || (!cred.ModelsCustomized && cred.APIKey === update.DiscoveredForKey))) {
      const models = normalizeCLIModels(update.Models);
      cred.Models = models;
      if (kind === "cursor") {
        cred.ModelsCustomized = !discovered && models.length !== 0;
      }
    }
    if (cred.APIKey === "" && cred.BaseURL === "" && cred.Protocol === "" && (cred.Models ?? []).length === 0) {
      delete merged[kind];
      continue;
    }
    merged[kind] = cred;
  }
  if (Object.keys(merged).length === 0) {
    merged = null;
  }
  user.AgentCLICredentials = merged;
}

/**
 * 将扩展 Agent CLI 凭据映射编码为 JSON 字符串用于落库；为空映射或序列化异常时返回 `null`。
 *
 * @param {Object.<string, AgentCLICredential> | null} creds - 扩展 Agent CLI 凭据映射。
 * @returns {string | null} JSON 字符串；无有效内容时返回 `null`。
 */
function encodeAgentCLICredentials(creds) {
  if (creds == null || Object.keys(creds).length === 0) {
    return null;
  }
  let raw;
  try {
    raw = JSON.stringify(creds);
  } catch {
    return null;
  }
  if (raw === "{}" || raw === "null") {
    return null;
  }
  return raw;
}

// 单个执行器允许配置的模型数量上限、模型 ID 最大字节长度及显示名称最大字符数。
const maxCLIModels = 100;
const maxCLIModelIDLen = 128;
const maxCLIModelNameRune = 64;

/**
 * 将数据库中存储的 CLI 模型目录 JSON 文本反序列化为 `CLIModel[]`；为空或解析失败时返回 `null`。
 *
 * @param {string | null} raw - 数据库列中保存的 JSON 字符串。
 * @returns {CLIModel[] | null} 解析得到的模型列表；输入为空或非法时返回 `null`。
 */
function decodeCLIModels(raw) {
  if (raw == null || raw.trim() === "") {
    return null;
  }
  let models;
  try {
    models = JSON.parse(raw);
  } catch {
    return null;
  }
  return Array.isArray(models) ? models : null;
}

/**
 * 将 CLI 模型目录数组编码为 JSON 字符串用于落库；为空数组或序列化失败时返回 `null`。
 *
 * @param {CLIModel[] | null} models - CLI 模型定义数组。
 * @returns {string | null} JSON 字符串；空列表或序列化出错时返回 `null`。
 */
function encodeCLIModels(models) {
  if (models == null || models.length === 0) {
    return null;
  }
  try {
    return JSON.stringify(models);
  } catch {
    return null;
  }
}

/**
 * 校验并规范化用户提交的 CLI 模型目录列表：检查总数上限、ID 合法性与去重、显示名称长度及控制字符，
 * 并递归规范化 Cursor 思考强度映射与通用推理强度列表。
 *
 * @param {CLIModel[] | null} models - 待校验的原始模型目录数组。
 * @returns {CLIModel[]} 规范化后的 `CLIModel` 实例数组。
 * @throws {Error} 数量超限、模型 ID 非法或重复、名称非法或思考强度不受支持时抛出错误。
 */
function normalizeCLIModels(models) {
  if ((models ?? []).length > maxCLIModels) {
    throw new Error(`模型目录最多 ${maxCLIModels} 个`);
  }
  const out = [];
  const seen = {};
  for (const model of models ?? []) {
    const id = model.ID.trim();
    let name = model.Name.trim();
    validCLIModelID(id);
    if (seen[id]) {
      throw new Error(`模型 ID ${id} 重复`);
    }
    seen[id] = true;
    if ([...name].length > maxCLIModelNameRune) {
      throw new Error(`显示名称长度不能超过 ${maxCLIModelNameRune} 个字符`);
    }
    for (const ch of name) {
      const r = ch.codePointAt(0);
      if (r < 32 || r === 0x7f) {
        throw new Error("显示名称不能包含控制字符");
      }
    }
    if (name === id) {
      name = "";
    }
    let efforts;
    let defaultEffort;
    try {
      [efforts, defaultEffort] = normalizeCLIModelEfforts(model.Efforts, model.DefaultEffort);
    } catch (err) {
      throw new Error(`模型 ${id}：${err}`);
    }
    let reasoningEfforts;
    try {
      reasoningEfforts = normalizeCLIReasoningEfforts(model.ReasoningEfforts);
    } catch (err) {
      throw new Error(`模型 ${id}：${err}`);
    }
    let discoveredEfforts;
    try {
      discoveredEfforts = normalizeCLIReasoningEfforts(model.DiscoveredReasoningEfforts);
    } catch (err) {
      throw new Error(`模型 ${id}：${err}`);
    }
    out.push(new CLIModel({
      ID: id, Name: name, Efforts: efforts, DefaultEffort: defaultEffort,
      ReasoningEfforts: reasoningEfforts, DiscoveredReasoningEfforts: discoveredEfforts,
    }));
  }
  return out;
}

/**
 * 校验并去重单模型的推理思考强度列表；每一项必须属于 `ExecutorEffortLevels` 中任意执行器允许的档位。
 *
 * @param {string[] | null} raw - 可选的原始思考强度列表；为 `null` 时表示未配置，直接返回 `null`。
 * @returns {string[] | null} 规范化并去重后的思考强度数组；输入为 `null` 时返回 `null`。
 * @throws {Error} 列表中存在不受支持的思考强度档位时抛出错误。
 */
function normalizeCLIReasoningEfforts(raw) {
  if (raw == null) {
    return null;
  }
  const levels = [];
  for (let level of raw) {
    level = level.trim();
    let supported = false;
    for (const allowed of Object.values(ExecutorEffortLevels)) {
      if (allowed.includes(level)) {
        supported = true;
        break;
      }
    }
    if (!supported) {
      throw new Error(`不支持思考强度 ${JSON.stringify(level)}`);
    }
    if (!levels.includes(level)) {
      levels.push(level);
    }
  }
  return levels;
}

/**
 * 校验单个 CLI 模型 ID 的合法性：非空、UTF-8 字节长度不超过 128、且不含空格、引号、反斜杠或控制字符。
 * 使用场景：由 `normalizeCLIModels` 和 `normalizeCLIModelEfforts` 调用。
 *
 * @param {string} id - 已去除首尾空白的模型 ID 字符串。
 * @returns {void} 无返回值。
 * @throws {Error} 模型 ID 为空、超长或包含禁止字符时抛出错误。
 */
function validCLIModelID(id) {
  if (id === "") {
    throw new Error("模型 ID 不能为空");
  }
  if (Buffer.byteLength(id, "utf8") > maxCLIModelIDLen) {
    throw new Error(`模型 ID 长度不能超过 ${maxCLIModelIDLen} 个字符`);
  }
  for (const ch of id) {
    const r = ch.codePointAt(0);
    if (r <= 32 || r === 0x7f || ch === '"' || ch === "'" || ch === "`" || ch === "\\") {
      throw new Error(`模型 ID ${JSON.stringify(id)} 不能包含空格、引号、反斜杠或控制字符`);
    }
  }
}

/**
 * 校验并规范化 Cursor 模型家族的「思考强度 → 目标模型 ID」映射；
 * 所有键必须属于 Cursor 支持的思考强度档位，所有目标值必须是合法模型 ID，不在映射内的默认值将被丢弃为空串。
 *
 * @param {Object.<string, string> | null} efforts - 思考强度到目标模型 ID 的映射对象。
 * @param {string} defaultEffort - 期望的默认思考强度档位。
 * @returns {[Object.<string, string> | null, string]} 二元组 `[规范化映射或 null, 有效的默认思考强度]`。
 * @throws {Error} 包含不受支持的思考强度键或非法目标模型 ID 时抛出错误。
 */
function normalizeCLIModelEfforts(efforts, defaultEffort) {
  if (efforts == null || Object.keys(efforts).length === 0) {
    return [null, ""];
  }
  const levels = ExecutorEffortLevels["cursor"];
  const out = {};
  for (let [effort, raw] of Object.entries(efforts)) {
    effort = effort.trim();
    raw = raw.trim();
    if (!levels.includes(effort)) {
      throw new Error(`不支持思考强度 ${JSON.stringify(effort)}`);
    }
    validCLIModelID(raw);
    out[effort] = raw;
  }
  defaultEffort = defaultEffort.trim();
  if (out[defaultEffort] === undefined) {
    defaultEffort = "";
  }
  return [out, defaultEffort];
}

module.exports = { userWithConfig, userSelectColumns, UserCredentialUpdate, AgentCLICredentialUpdate, userHasConfig, nullableString, applyAgentCLICredentialUpdates, encodeAgentCLICredentials, maxCLIModels, maxCLIModelIDLen, maxCLIModelNameRune, decodeCLIModels, encodeCLIModels, normalizeCLIModels, normalizeCLIReasoningEfforts, validCLIModelID, normalizeCLIModelEfforts };
