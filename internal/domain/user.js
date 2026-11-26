/**
 * @file internal/domain/user.js
 * @description 对应 Go 文件：internal/domain/user.go
 * 职责与边界：定义系统用户实体（User）、个人 Git SSH/HTTPS 凭据类型、Agent CLI 模型目录与凭据配置、
 * API Token 实体，以及平台管理员判定、凭据脱敏、Git 平台/网络环境/CLI 协议归一化函数。
 * 语法差异说明：
 * - Go 切片零值初始化为 `[]`，普通映射 `map[string]V` 初始化为 `{}`，指针（含 `*[]string`）与 `time.Time` 初始化为 `null`。
 * - Go 单嵌入结构体（`GitHTTPCredentialSecret`、`GitHTTPExecutionCredential` 嵌入 `GitHTTPCredential`）译为类继承（`extends`）。
 * - Go 多返回值 `(string, bool)` 与 `(string, string)` 译为二元组 `[值1, 值2]`。
 */

"use strict";

const { IsAgentCLIKind } = require("./agent.js");

/**
 * 表示系统注册或登录的员工实体，包含基础身份、平台角色、个人 Git 凭据标记与各 Agent CLI 密钥/模型配置。
 */
class User {
  /**
   * 构造用户实体实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.AssistantDefaults = init.AssistantDefaults ?? null;
    this.CodexAPIKey = init.CodexAPIKey ?? "";
    this.CodexAPIKeyConfigured = init.CodexAPIKeyConfigured ?? false;
    this.CodexBaseURL = init.CodexBaseURL ?? "";
    this.ClaudeCodeAPIKey = init.ClaudeCodeAPIKey ?? "";
    this.ClaudeCodeAPIKeyConfigured = init.ClaudeCodeAPIKeyConfigured ?? false;
    this.ClaudeCodeBaseURL = init.ClaudeCodeBaseURL ?? "";
    this.CodexModels = init.CodexModels ?? [];
    this.ClaudeCodeModels = init.ClaudeCodeModels ?? [];
    this.AgentCLICredentials = init.AgentCLICredentials ?? {};
    this.ID = init.ID ?? 0;
    this.StaffID = init.StaffID ?? 0;
    this.LoginName = init.LoginName ?? "";
    this.ChineseName = init.ChineseName ?? "";
    this.DeptID = init.DeptID ?? 0;
    this.DeptName = init.DeptName ?? "";
    this.PlatformRole = init.PlatformRole ?? "";
    this.GitToken = init.GitToken ?? "";
    this.GitHubCredentialConfigured = init.GitHubCredentialConfigured ?? false;
    this.GitTokenOAuth = init.GitTokenOAuth ?? false;
    this.GitSSHKeyConfigured = init.GitSSHKeyConfigured ?? false;
    this.GitHTTPCredentialsConfigured = init.GitHTTPCredentialsConfigured ?? false;
    this.GongfengRefreshToken = init.GongfengRefreshToken ?? "";
    this.GongfengTokenExpiresAt = init.GongfengTokenExpiresAt ?? null;
    this.CodeBuddyAPIKey = init.CodeBuddyAPIKey ?? "";
    this.CodeBuddyAPIKeyConfigured = init.CodeBuddyAPIKeyConfigured ?? false;
    this.CodeBuddyBaseURL = init.CodeBuddyBaseURL ?? "";
    this.CodeBuddyInternetEnvironment = init.CodeBuddyInternetEnvironment ?? "";
    this.CodeBuddyModels = init.CodeBuddyModels ?? [];
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  /**
   * 判断用户是否为指定种类的执行器 CLI 配置了个人 API 密钥。
   * 在校验任务前置凭据或决定是否采用个人凭据执行时调用。
   * @param {string} kind - 执行器 CLI 种类标识（如 `"codebuddy"`、`"codex"`、`"claude-code"` 或扩展 CLI 标识）。
   * @returns {boolean} 对应密钥非空时返回 `true`，否则返回 `false`。
   */
  HasExecutorCredential(kind) {
    let key = "";
    switch (kind) {
      case "codebuddy":
        key = this.CodeBuddyAPIKey;
        break;
      case "codex":
        key = this.CodexAPIKey;
        break;
      case "claude-code":
        key = this.ClaudeCodeAPIKey;
        break;
      default:
        if (IsAgentCLIKind(kind)) {
          // Go 读缺失的 map 键得零值，JS 取不到时按空凭据处理。
          const cred = (this.AgentCLICredentials ?? {})[kind];
          key = cred ? cred.APIKey : "";
        }
        break;
    }
    return key.trim() !== "";
  }
}

const PlatformRoleAdmin = "admin";

/**
 * 表示用户个人 SSH 凭据的公开描述信息（不含私钥内容）。
 */
class GitSSHKey {
  /**
   * 构造 SSH 凭据公开描述实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Host = init.Host ?? "";
  }
}

// 个人 HTTPS Git 凭据支持的托管平台标识。
const GitPlatformGitHub = "github";
const GitPlatformGitLab = "gitlab";
const GitPlatformOther = "other";

// 个人 HTTPS Git 凭据未填写用户名时，Basic 认证默认使用的用户名。
const GitTokenHTTPUser = "x-access-token";

// 内部适配器在 user_configs 中维护并自动刷新的只读 HTTPS Git 凭据标识。
const ManagedGitHTTPCredentialID = "managed-internal";

/**
 * 表示绑定到单个 `host[:port]` 的个人 HTTPS Git 凭据公开描述，不携带令牌密文。
 */
class GitHTTPCredential {
  /**
   * 构造 HTTPS Git 凭据公开描述实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Platform = init.Platform ?? "";
    this.Host = init.Host ?? "";
    this.Username = init.Username ?? "";
    this.Managed = init.Managed ?? false;
  }

  /**
   * 返回 Git 随访问令牌一起发送的 HTTP Basic 认证用户名；未配置时回退到 `GitTokenHTTPUser`。
   * 在生成 Git 凭据应答或克隆认证信息时调用。
   * @returns {string} HTTP Basic 认证用户名。
   */
  GitUsername() {
    const user = this.Username.trim();
    if (user !== "") {
      return user;
    }
    return GitTokenHTTPUser;
  }

  /**
   * 返回控制面针对该凭据对应主机调用托管平台 REST API 的根地址；不支持 API 调用的平台返回空字符串。
   * 在 PR 发现、MR 交付状态轮询等接口调用前获取 API 基础路径。
   * @returns {string} REST API 根 URL，或不支持时的空字符串 `""`。
   */
  APIBase() {
    switch (this.Platform) {
      case GitPlatformGitHub:
        if (this.Host === "github.com") {
          return "https://api.github.com";
        }
        return "https://" + this.Host + "/api/v3";
      case GitPlatformGitLab:
        return "https://" + this.Host + "/api/v4";
      default:
        return "";
    }
  }
}

/**
 * 表示携带明文令牌与过期时间的内存级 HTTPS Git 凭据对象，不参与常规对外序列化。
 */
class GitHTTPCredentialSecret extends GitHTTPCredential {
  /**
   * 构造带令牌的 HTTPS Git 凭据实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
    this.Token = init.Token ?? "";
    this.ExpiresAt = init.ExpiresAt ?? null;
  }

  /**
   * 返回访问对应托管平台 `APIBase` 所需的 HTTP 认证请求头名与头值。
   * GitLab 非 OAuth 令牌使用 `PRIVATE-TOKEN`，其余（GitHub 与 GitLab OAuth）使用 `Authorization: Bearer ...`。
   * @returns {[string, string]} 二元组 `[请求头名, 请求头值]`。
   */
  APIAuthHeader() {
    if (this.Platform === GitPlatformGitLab && this.Username !== "oauth2") {
      return ["PRIVATE-TOKEN", this.Token];
    }
    return ["Authorization", "Bearer " + this.Token];
  }
}

/**
 * 表示仅用于已认证临时执行派发的 HTTPS Git 凭据，通过加密通道下发给执行机器并在入队和管理响应中被剥离。
 */
class GitHTTPExecutionCredential extends GitHTTPCredential {
  /**
   * 构造执行期 HTTPS Git 凭据实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
    this.Token = init.Token ?? "";
    this.ExpiresAt = init.ExpiresAt ?? null;
  }
}

/**
 * 校验并归一化个人 HTTPS Git 凭据的托管平台类型（`github`、`gitlab`、`other`）。
 * 在保存或更新 HTTPS Git 凭据接口中调用。
 * @param {string} raw - 原始平台名称字符串。
 * @returns {[string, boolean]} 二元组 `[归一化后的平台标识, 是否有效]`。
 */
function NormalizeGitPlatform(raw) {
  const p = raw.trim().toLowerCase();
  switch (p) {
    case GitPlatformGitHub:
    case GitPlatformGitLab:
    case GitPlatformOther:
      return [p, true];
    default:
      return ["", false];
  }
}

/**
 * 将个人设置中选择的 CodeBuddy 网络环境归一化为环境变量 `CODEBUDDY_INTERNET_ENVIRONMENT` 的合法取值。
 * 国际站映射为 `""`，国内站映射为 `"internal"`，iOA 映射为 `"ioa"`，未知取值返回 `false` 拒绝保存。
 * @param {string} raw - 用户提交的网络环境标识字符串。
 * @returns {[string, boolean]} 二元组 `[归一化后的环境取值, 是否有效]`。
 */
function NormalizeCodeBuddyInternetEnvironment(raw) {
  switch (raw.trim().toLowerCase()) {
    case "":
    case "public":
    case "intl":
    case "international":
    case "国际站":
      return ["", true];
    case "internal":
    case "china":
    case "cn":
    case "国内站":
      return ["internal", true];
    case "ioa":
      return ["ioa", true];
    default:
      return ["", false];
  }
}

/**
 * 判断用户是否持有平台管理员角色（`"admin"`，不区分大小写）。
 * 在通用 SOP 模板编辑及平台级管理接口鉴权时调用。
 * @param {User} u - 用户实体对象。
 * @returns {boolean} 是平台管理员时返回 `true`，否则返回 `false`。
 */
function IsPlatformAdmin(u) {
  return u.PlatformRole.trim().toLowerCase() === PlatformRoleAdmin;
}

/**
 * 生成去除全部个人密钥与刷新令牌的用户公开目录副本，并同步回填各项 `Configured` 状态标记。
 * 在向前端或管理端接口返回单个用户信息前调用。
 * @param {User} u - 原始用户实体对象。
 * @returns {Object} 脱敏后的用户副本对象。
 */
function PublicUser(u) {
  const out = { ...u };
  out.CodexAPIKeyConfigured = out.CodexAPIKey.trim() !== "";
  out.CodexAPIKey = "";
  out.ClaudeCodeAPIKeyConfigured = out.ClaudeCodeAPIKey.trim() !== "";
  out.ClaudeCodeAPIKey = "";
  out.GitTokenOAuth = out.GongfengRefreshToken.trim() !== "";
  out.GitToken = "";
  out.GongfengRefreshToken = "";
  out.GongfengTokenExpiresAt = null;
  out.CodeBuddyAPIKeyConfigured = out.CodeBuddyAPIKey.trim() !== "";
  out.CodeBuddyAPIKey = "";
  if (out.AgentCLICredentials != null && Object.keys(out.AgentCLICredentials).length > 0) {
    const pub = {};
    for (const [kind, cred] of Object.entries(out.AgentCLICredentials)) {
      const c = { ...cred };
      c.APIKeyConfigured = c.APIKey.trim() !== "";
      c.APIKey = "";
      pub[kind] = c;
    }
    out.AgentCLICredentials = pub;
  }
  return out;
}

/**
 * 表示 CLI 模型目录中的单条模型配置，记录透传给 CLI 的模型 ID、展示名称及思考强度映射。
 */
class CLIModel {
  /**
   * 构造 CLI 模型条目实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Efforts = init.Efforts ?? {};
    this.DefaultEffort = init.DefaultEffort ?? "";
    this.ReasoningEfforts = init.ReasoningEfforts ?? null;
    this.DiscoveredReasoningEfforts = init.DiscoveredReasoningEfforts ?? null;
  }
}

/**
 * 表示单个扩展 Agent CLI 的个人凭据、自定义端点、协议类型与模型列表配置。
 */
class AgentCLICredential {
  /**
   * 构造 Agent CLI 个人凭据实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.APIKey = init.APIKey ?? "";
    this.APIKeyConfigured = init.APIKeyConfigured ?? false;
    this.BaseURL = init.BaseURL ?? "";
    this.Protocol = init.Protocol ?? "";
    this.Models = init.Models ?? [];
    this.ModelsCustomized = init.ModelsCustomized ?? false;
  }
}

// 扩展 Agent CLI 连接用户自定义 Base URL 时可使用的接口协议常量。
const AgentCLIProtocolChat = "chat";
const AgentCLIProtocolResponses = "responses";
const AgentCLIProtocolMessages = "messages";
const AgentCLIProtocolGemini = "gemini";

// 各扩展 Agent CLI 支持的自定义 Base URL 协议列表，每项首位为默认协议。
const AgentCLIProtocolOptions = {
  opencode: [AgentCLIProtocolChat, AgentCLIProtocolResponses, AgentCLIProtocolMessages],
  kimi: [AgentCLIProtocolChat, AgentCLIProtocolResponses, AgentCLIProtocolMessages],
  pi: [AgentCLIProtocolChat, AgentCLIProtocolResponses, AgentCLIProtocolMessages],
  dsh: [AgentCLIProtocolChat, AgentCLIProtocolResponses, AgentCLIProtocolMessages],
  zcode: [AgentCLIProtocolMessages, AgentCLIProtocolChat, AgentCLIProtocolResponses],
  agy: [AgentCLIProtocolGemini, AgentCLIProtocolChat],
};

/**
 * 规范化指定 Agent CLI 的协议选择：若传入值不在允许列表中则回退到该 CLI 的默认协议；无可用选项时返回空字符串。
 * 在保存个人 CLI 凭据和组装执行调用包时调用。
 * @param {string} kind - Agent CLI 种类标识。
 * @param {string} protocol - 待校验的协议字符串。
 * @returns {string} 合法的协议常量或空字符串 `""`。
 */
function NormalizeAgentCLIProtocol(kind, protocol) {
  const options = AgentCLIProtocolOptions[kind.trim()] ?? [];
  for (const option of options) {
    if (option === protocol.trim()) {
      return option;
    }
  }
  if (options.length === 0) {
    return "";
  }
  return options[0];
}

/**
 * 批量对用户列表执行脱敏处理，移除所有敏感凭据字段。
 * 在返回用户目录列表接口中调用。
 * @param {User[]} items - 原始用户实体列表。
 * @returns {Object[]} 脱敏后的用户对象数组。
 */
function PublicUsers(items) {
  const out = [];
  for (const u of items ?? []) {
    out.push(PublicUser(u));
  }
  return out;
}

/**
 * 表示归属于用户的 REST API 与 MCP 访问令牌元数据；`TokenHash` 持久化但不对外序列化。
 */
class APIToken {
  /**
   * 构造 API Token 实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Name = init.Name ?? "";
    this.Prefix = init.Prefix ?? "";
    this.TokenHash = init.TokenHash ?? "";
    this.LastUsedAt = init.LastUsedAt ?? null;
    this.ExpiresAt = init.ExpiresAt ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.RevokedAt = init.RevokedAt ?? null;
  }
}

module.exports = { User, PlatformRoleAdmin, GitSSHKey, GitPlatformGitHub, GitPlatformGitLab, GitPlatformOther, GitTokenHTTPUser, ManagedGitHTTPCredentialID, GitHTTPCredential, GitHTTPCredentialSecret, GitHTTPExecutionCredential, NormalizeGitPlatform, NormalizeCodeBuddyInternetEnvironment, IsPlatformAdmin, PublicUser, CLIModel, AgentCLICredential, AgentCLIProtocolChat, AgentCLIProtocolResponses, AgentCLIProtocolMessages, AgentCLIProtocolGemini, AgentCLIProtocolOptions, NormalizeAgentCLIProtocol, PublicUsers, APIToken };
