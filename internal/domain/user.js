// user.js —— 对应 Go 文件：internal/domain/user.go
// 作用：系统注册员工实体、个人 Git 凭据与 API token。

"use strict";

// User：系统注册或登录的员工实体。
class User {
  constructor(init = {}) {
    this.AssistantDefaults = init.AssistantDefaults ?? null;
    this.CodexAPIKey = init.CodexAPIKey ?? "";
    this.CodexAPIKeyConfigured = init.CodexAPIKeyConfigured ?? false;
    this.CodexBaseURL = init.CodexBaseURL ?? "";
    this.ClaudeCodeAPIKey = init.ClaudeCodeAPIKey ?? "";
    this.ClaudeCodeAPIKeyConfigured = init.ClaudeCodeAPIKeyConfigured ?? false;
    this.ClaudeCodeBaseURL = init.ClaudeCodeBaseURL ?? "";
    this.CodexModels = init.CodexModels ?? null;
    this.ClaudeCodeModels = init.ClaudeCodeModels ?? null;
    this.AgentCLICredentials = init.AgentCLICredentials ?? null;
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
    this.CodeBuddyModels = init.CodeBuddyModels ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  // HasExecutorCredential：用户是否为该 CLI 配了自己的密钥。
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

// GitSSHKey：个人 SSH 凭据的公开描述。
class GitSSHKey {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Host = init.Host ?? "";
  }
}

// 个人 HTTPS Git 凭据的平台。
const GitPlatformGitHub = "github";
const GitPlatformGitLab = "gitlab";
const GitPlatformOther = "other";

// GitTokenHTTPUser：凭据未指定用户名时 Basic 认证用的用户名。
const GitTokenHTTPUser = "x-access-token";

// ManagedGitHTTPCredentialID：内部适配器保管的只读凭据标识。
const ManagedGitHTTPCredentialID = "managed-internal";

// GitHTTPCredential：绑定到一个 host[:port] 的个人 HTTPS Git 凭据公开描述。
class GitHTTPCredential {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Platform = init.Platform ?? "";
    this.Host = init.Host ?? "";
    this.Username = init.Username ?? "";
    this.Managed = init.Managed ?? false;
  }

  // GitUsername：Git 随 token 发送的 Basic 认证用户名。
  GitUsername() {
    const user = this.Username.trim();
    if (user !== "") {
      return user;
    }
    return GitTokenHTTPUser;
  }

  // APIBase：控制面为该凭据 host 调用的 REST API 根地址。
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

// GitHTTPCredentialSecret：带 token 的凭据，只存在于内存中。
class GitHTTPCredentialSecret extends GitHTTPCredential {
  constructor(init = {}) {
    super(init);
    this.Token = init.Token ?? "";
    this.ExpiresAt = init.ExpiresAt ?? null;
  }

  // APIAuthHeader：对 APIBase 做认证用的请求头。
  APIAuthHeader() {
    if (this.Platform === GitPlatformGitLab && this.Username !== "oauth2") {
      return ["PRIVATE-TOKEN", this.Token];
    }
    return ["Authorization", "Bearer " + this.Token];
  }
}

// GitHTTPExecutionCredential：仅供已认证的临时执行派发使用。
class GitHTTPExecutionCredential extends GitHTTPCredential {
  constructor(init = {}) {
    super(init);
    this.Token = init.Token ?? "";
    this.ExpiresAt = init.ExpiresAt ?? null;
  }
}

// NormalizeGitPlatform：校验平台是否在三种类型内。
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

// NormalizeCodeBuddyInternetEnvironment：把个人设置里的网络环境映射为 CLI 取值。
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

// IsPlatformAdmin：用户是否持有平台管理员角色。
function IsPlatformAdmin(u) {
  return u.PlatformRole.trim().toLowerCase() === PlatformRoleAdmin;
}

// PublicUser：返回用户目录信息，不暴露凭据。
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

// CLIModel：CLI 模型目录中的一条。
class CLIModel {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Efforts = init.Efforts ?? null;
    this.DefaultEffort = init.DefaultEffort ?? "";
    this.ReasoningEfforts = init.ReasoningEfforts ?? null;
    this.DiscoveredReasoningEfforts = init.DiscoveredReasoningEfforts ?? null;
  }
}

// AgentCLICredential：一个 agent CLI 的个人配置。
class AgentCLICredential {
  constructor(init = {}) {
    this.APIKey = init.APIKey ?? "";
    this.APIKeyConfigured = init.APIKeyConfigured ?? false;
    this.BaseURL = init.BaseURL ?? "";
    this.Protocol = init.Protocol ?? "";
    this.Models = init.Models ?? null;
    this.ModelsCustomized = init.ModelsCustomized ?? false;
  }
}

// Agent CLI 对用户 Base URL 可说的线路协议。
const AgentCLIProtocolChat = "chat";
const AgentCLIProtocolResponses = "responses";
const AgentCLIProtocolMessages = "messages";
const AgentCLIProtocolGemini = "gemini";

// AgentCLIProtocolOptions：各 agent CLI 支持的协议，首个为默认值。
const AgentCLIProtocolOptions = {
  opencode: [AgentCLIProtocolChat, AgentCLIProtocolResponses, AgentCLIProtocolMessages],
  kimi: [AgentCLIProtocolChat, AgentCLIProtocolResponses, AgentCLIProtocolMessages],
  pi: [AgentCLIProtocolChat, AgentCLIProtocolResponses, AgentCLIProtocolMessages],
  dsh: [AgentCLIProtocolChat, AgentCLIProtocolResponses, AgentCLIProtocolMessages],
  zcode: [AgentCLIProtocolMessages, AgentCLIProtocolChat, AgentCLIProtocolResponses],
  agy: [AgentCLIProtocolGemini, AgentCLIProtocolChat],
};

// NormalizeAgentCLIProtocol：返回支持的协议选择，未知值回落到该 CLI 的默认值。
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

function PublicUsers(items) {
  const out = [];
  for (const u of items ?? []) {
    out.push(PublicUser(u));
  }
  return out;
}

// APIToken：用户所有的 REST API 与 MCP 访问凭据。
class APIToken {
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
