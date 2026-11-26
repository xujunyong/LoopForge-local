// users.js —— 对应 Go 文件：internal/repo/users.go
// 作用：用户与凭据：用户查询与保存、凭据更新、CLI 模型目录校验。
// (值, error) 译为返回值、失败 throw，(值, bool) 译为 [值, bool]；errors.Is 译为 ===。

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
const { ErrAssistantDefaultExecutorUnavailable, firstAssistantExecutor } = require("./user_assistant_defaults.js"); // 对应 Go 同包函数，user_assistant_defaults.js 待翻译

class userWithConfig {
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

UsersRepo.prototype.userQuery = function (where, ...args) {
  const row = new userWithConfig();
  const q = this.DB.Raw(`SELECT ${userSelectColumns} FROM users u LEFT JOIN user_configs c ON c.user_id=u.id WHERE ${where}`, ...args);
  if (q.Scan(row).Error != null || row.ID === 0) {
    return [new User(), false];
  }
  return [row.toDomain(), true];
};

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

UsersRepo.prototype.User = function (id) {
  if (id <= 0) {
    return [new User(), false];
  }
  return this.userQuery("u.id=?", id);
};

UsersRepo.prototype.UserByLoginName = function (loginName) {
  if (this.isMySQL()) {
    // MySQL collation is already case-insensitive and keeps index usage.
    return this.userQuery("u.login_name=?", loginName);
  }
  return this.userQuery("LOWER(u.login_name) = LOWER(?)", loginName);
};

UsersRepo.prototype.UserByStaffID = function (staffID) {
  return this.userQuery("u.staff_id=?", staffID);
};

UsersRepo.prototype.PutUser = function (v) {
  if (v.LoginName === "" && v.StaffID === 0 && v.ID === 0) {
    return new Error("user loginName, staffId, or ID is required");
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
    // Authentication refreshes identity fields only. Credentials are managed
    // through UpdateUserCredentials and must survive every login refresh.
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
  let saved;
  try {
    saved = this.writeUser(v);
  } catch (err) {
    return err;
  }
  if (!ok && userHasConfig(saved)) {
    const err = this.writeUserConfig(saved);
    if (err != null) {
      return err;
    }
  }
  return null;
};

UsersRepo.prototype.writeUser = function (v) {
  if (v.ID > 0) {
    const err = upsert(this.DB, "users", {
      id: v.ID, staff_id: v.StaffID, login_name: v.LoginName, chinese_name: v.ChineseName,
      dept_id: v.DeptID, dept_name: v.DeptName, platform_role: v.PlatformRole,
      created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
    });
    if (err != null) {
      throw err;
    }
    return v;
  }
  const inserted = insertIgnore(this.DB, "users", {
    staff_id: v.StaffID, login_name: v.LoginName, chinese_name: v.ChineseName,
    dept_id: v.DeptID, dept_name: v.DeptName, platform_role: v.PlatformRole,
    created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  });
  if (!inserted) {
    // The unique login already exists: adopt that row and refresh it.
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

class UserCredentialUpdate {
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
    // AgentCLICredentials updates the agent CLIs by kind; absent fields keep
    // the stored value. CodeBuddy, Codex and Claude Code stay on their own columns.
    this.AgentCLICredentials = init.AgentCLICredentials ?? null;
  }
}

class AgentCLICredentialUpdate {
  constructor(init = {}) {
    this.APIKey = init.APIKey ?? "";
    this.APIKeyClear = init.APIKeyClear ?? false;
    this.BaseURL = init.BaseURL ?? null;
    this.Protocol = init.Protocol ?? null;
    this.Models = init.Models ?? null;
    // DiscoveredForKey prevents a refresh for an old key from replacing the
    // new key's models.
    this.DiscoveredForKey = init.DiscoveredForKey ?? "";
  }
}

UsersRepo.prototype.UpdateUserCredentials = function (id, update) {
  let user = new User();
  const err = this.DB.Transaction((tx) => {
    // Serialize edits and CLI discovery for this user even when they
    // arrive at different server instances or before a config row exists.
    const owner = new userRow();
    const lockErr = this.locking(tx.Select("id")).Where("id = ?", id).Take(owner).Error;
    if (lockErr != null) {
      if (lockErr === gorm.ErrRecordNotFound) {
        return new Error("user not found");
      }
      return lockErr;
    }
    const credentials = new UsersRepo({ DB: tx });
    try {
      user = credentials.updateUserCredentials(id, update);
    } catch (e) {
      return e;
    }
    return null;
  });
  if (err != null) {
    throw err;
  }
  return user;
};

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
  const agentErr = applyAgentCLICredentialUpdates(user, update.AgentCLICredentials);
  if (agentErr != null) {
    throw agentErr;
  }
  if (update.AssistantDefaults != null) {
    if (!user.HasExecutorCredential(update.AssistantDefaults.Executor)) {
      throw ErrAssistantDefaultExecutorUnavailable;
    }
    user.AssistantDefaults = update.AssistantDefaults;
  } else if (!user.HasExecutorCredential(user.AssistantDefaults.Executor)) {
    user.AssistantDefaults.Executor = firstAssistantExecutor(user);
    user.AssistantDefaults.Model = "";
    user.AssistantDefaults.Effort = "";
  }
  user.UpdatedAt = new Date();
  const configErr = this.writeUserConfig(user);
  if (configErr != null) {
    throw configErr;
  }
  // Go 按值比较结构体，JS 里逐字段比较。
  if (user.AssistantDefaults.Executor !== previousDefaults.Executor || user.AssistantDefaults.Model !== previousDefaults.Model || user.AssistantDefaults.Effort !== previousDefaults.Effort || user.AssistantDefaults.Approval !== previousDefaults.Approval) {
    let value;
    try {
      value = JSON.stringify(user.AssistantDefaults);
    } catch (err) {
      throw err;
    }
    const updateErr = this.DB.Model(new userConfigRow()).Where("user_id = ?", id).Update("assistant_defaults", value).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  }
  return user;
};

// SaveGongfengOAuth stores an OAuth access token in the git credential slot
// and keeps the refresh token so a later use can renew it.
UsersRepo.prototype.SaveGongfengOAuth = function (id, accessToken, refreshToken, expiresAt) {
  const [user, ok] = this.User(id);
  if (!ok) {
    throw new Error("user not found");
  }
  user.GitToken = accessToken.trim();
  user.GongfengRefreshToken = refreshToken.trim();
  user.GongfengTokenExpiresAt = new Date(expiresAt.getTime());
  user.UpdatedAt = new Date();
  const err = this.writeUserConfig(user);
  if (err != null) {
    throw err;
  }
  return user;
};

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
  return upsert(this.DB, "user_configs", values);
};

function nullableString(v) {
  if (v === "") {
    return null;
  }
  return v;
}

function applyAgentCLICredentialUpdates(user, updates) {
  if (updates == null || Object.keys(updates).length === 0) {
    return null;
  }
  let merged = {};
  for (const [kind, cred] of Object.entries(user.AgentCLICredentials ?? {})) {
    merged[kind] = cred;
  }
  for (let [kind, update] of Object.entries(updates)) {
    kind = kind.trim();
    if (!IsAgentCLIKind(kind)) {
      return new Error(`不支持的 CLI：${kind}`);
    }
    // Go 读缺失的 map 键得零值，JS 取不到时按空凭据处理。
    const cred = merged[kind] ?? new AgentCLICredential();
    const previousKey = cred.APIKey;
    if (update.APIKeyClear) {
      cred.APIKey = "";
    } else if (update.APIKey.trim() !== "") {
      cred.APIKey = update.APIKey.trim();
    }
    // Cursor's catalog and effort variants belong to the key's plan.
    // A replacement key starts with its own list unless the edit also
    // supplies a catalog.
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
        return new Error(`${kind} 不支持协议 ${protocol}`);
      }
      cred.Protocol = protocol;
    }
    const discovered = (update.DiscoveredForKey ?? "") !== "";
    if (update.Models != null && (!discovered || (!cred.ModelsCustomized && cred.APIKey === update.DiscoveredForKey))) {
      let models;
      try {
        models = normalizeCLIModels(update.Models);
      } catch (err) {
        return err;
      }
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
  return null;
}

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

const maxCLIModels = 100;
const maxCLIModelIDLen = 128;
const maxCLIModelNameRune = 64;

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
  return null;
}

// normalizeCLIModelEfforts checks the effort→model ID mapping of a Cursor
// model family: efforts are Cursor's levels and every target is a valid
// model ID. A default outside the mapping is dropped.
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
