// assets.js —— 对应 Go 文件：internal/domain/assets.go
// 作用：规则、技能、MCP 服务器与沙箱等运行配置资产的定义与校验。
// Go (值, error) 译为返回值、失败 throw；Go %q 译为 JSON.stringify。

"use strict";

const { RunnerSandboxSpec } = require("./runner.js"); // 对应 Go 同包类型，runner.js 翻译后补齐

class RuleDefinition {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Shared = init.Shared ?? false;
    this.Description = init.Description ?? "";
    this.Content = init.Content ?? "";
    this.Priority = init.Priority ?? 0;
    this.Global = init.Global ?? false;
    this.WorkflowIDs = init.WorkflowIDs ?? [];
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

class SkillDefinition {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Shared = init.Shared ?? false;
    this.Description = init.Description ?? "";
    this.Content = init.Content ?? "";
    this.Files = init.Files ?? {};
    this.FileRefs = init.FileRefs ?? [];
    this.Source = init.Source ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

// SkillSourceSkillHub：从 skillhub.cn 安装的技能来源。
const SkillSourceSkillHub = "skillhub";

// SkillSource：标识技能快照取自的市场版本。
class SkillSource {
  constructor(init = {}) {
    this.Provider = init.Provider ?? "";
    this.Namespace = init.Namespace ?? "";
    this.Slug = init.Slug ?? "";
    this.Version = init.Version ?? "";
    this.Homepage = init.Homepage ?? "";
    this.InstalledAt = init.InstalledAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

// SkillFileRef：技能的一个二进制文件，Path 为相对路径。
class SkillFileRef {
  constructor(init = {}) {
    this.Path = init.Path ?? "";
    this.Size = init.Size ?? 0;
    this.SHA256 = init.SHA256 ?? "";
    this.Mode = init.Mode ?? 0;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

class MCPServerDefinition {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.MarketID = init.MarketID ?? "";
    this.Scope = init.Scope ?? "";
    this.OwnerUserID = init.OwnerUserID ?? 0;
    this.IconURL = init.IconURL ?? "";
    this.Description = init.Description ?? "";
    this.Transport = init.Transport ?? "";
    this.Command = init.Command ?? "";
    this.Args = init.Args ?? [];
    this.URL = init.URL ?? "";
    this.Environment = init.Environment ?? {};
    this.Headers = init.Headers ?? {};
    this.InstallScript = init.InstallScript ?? "";
    this.WorkingDirectory = init.WorkingDirectory ?? "";
    this.PathEntries = init.PathEntries ?? [];
    this.FileRefs = init.FileRefs ?? [];
    this.AuthType = init.AuthType ?? "";
    this.CredentialKind = init.CredentialKind ?? "";
    this.TimeoutSec = init.TimeoutSec ?? 0;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

class MCPFileRef {
  constructor(init = {}) {
    this.Path = init.Path ?? "";
    this.Size = init.Size ?? 0;
    this.SHA256 = init.SHA256 ?? "";
    this.Mode = init.Mode ?? 0;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

class AgentAssetBundle {
  constructor(init = {}) {
    this.Rules = init.Rules ?? [];
    this.Skills = init.Skills ?? [];
    this.MCPServers = init.MCPServers ?? [];
    this.SkillFiles = init.SkillFiles ?? {};
    this.MCPFiles = init.MCPFiles ?? {};
  }
}

// DockerfileDefinition：runner 规格携带的 docker 沙箱构建配方。
class DockerfileDefinition {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Shared = init.Shared ?? false;
    this.Description = init.Description ?? "";
    this.Content = init.Content ?? "";
    this.Files = init.Files ?? {};
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

class SandboxProfile {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Shared = init.Shared ?? false;
    this.Driver = init.Driver ?? "";
    this.ReadOnlyRootFS = init.ReadOnlyRootFS ?? false;
    this.Environment = init.Environment ?? {};
    this.Dockerfile = init.Dockerfile ?? null;
    this.DockerfileID = init.DockerfileID ?? "";
  }
}

// SandboxDockerfile：Dockerfile 及其构建上下文文件。
class SandboxDockerfile {
  constructor(init = {}) {
    this.Content = init.Content ?? "";
    this.Files = init.Files ?? {};
  }
}

// ValidateSandboxAssets：校验沙箱驱动及其所需配方。
function ValidateSandboxAssets(v) {
  switch (v.Driver.trim()) {
    case SandboxDriverDocker:
    case SandboxDriverNative:
    case SandboxDriverSeatbelt:
    case SandboxDriverBwrap:
      break;
    case SandboxDriverLocal:
      throw new Error("local 沙箱已移除，请改用 native 沙箱");
    default:
      throw new Error(`不支持的沙箱类型 ${JSON.stringify(v.Driver)}`);
  }
  const docker = v.Driver.trim() === SandboxDriverDocker;
  if (docker && (v.Dockerfile == null || v.Dockerfile.Content.trim() === "")) {
    throw new Error("Docker 沙箱需要 Dockerfile 内容");
  } else if (!docker && v.Dockerfile != null) {
    throw new Error("只有 Docker 沙箱可以配置 Dockerfile");
  }
  if (v.Dockerfile != null) {
    try {
      ValidateManagedFiles(v.Dockerfile.Files);
    } catch (err) {
      throw new Error(`构建上下文：${err.message}`);
    }
  }
  return ValidateEnvironmentVariables(v.Environment);
}

// RunnerSandbox：已存 profile 的 runner 规格，Dockerfile 成为待构建配方。
function RunnerSandbox(profile) {
  const spec = new RunnerSandboxSpec({ Profile: new SandboxProfile(profile) });
  spec.Profile.Dockerfile = null;
  const d = profile.Dockerfile;
  if (d != null && d.Content.trim() !== "") {
    spec.Profile.DockerfileID = profile.ID;
    spec.Dockerfile = new DockerfileDefinition({ ID: profile.ID, Name: profile.Name, ProjectID: profile.ProjectID, Shared: profile.Shared, Content: d.Content, Files: d.Files });
  }
  return spec;
}

// 沙箱驱动：profile 存 native 或 docker，native 在执行机器上解析为 seatbelt / bwrap。
const SandboxDriverLocal = "local";
const SandboxDriverNative = "native";
const SandboxDriverDocker = "docker";
const SandboxDriverSeatbelt = "seatbelt";
const SandboxDriverBwrap = "bwrap";

// ConversationSandboxDriver：会话工作区能否用该驱动的沙箱运行。
function ConversationSandboxDriver(driver) {
  switch (driver.trim()) {
    case SandboxDriverDocker:
    case SandboxDriverNative:
    case SandboxDriverSeatbelt:
    case SandboxDriverBwrap:
      return true;
    default:
      return false;
  }
}

// ValidateFrozenSandbox：拒绝冻结进运行的已移除 local 驱动。
function ValidateFrozenSandbox(profile) {
  if (profile.Driver.trim() === SandboxDriverLocal) {
    throw new Error(`沙箱 ${profile.ID} 使用已移除的 local 类型，请改用 native 沙箱后重新发起`);
  }
}

// ResolveSandboxDriver：把 native 映射到 goos 的轻量沙箱，其余驱动原样返回。
function ResolveSandboxDriver(driver, goos) {
  driver = driver.trim();
  if (driver !== SandboxDriverNative) {
    return driver;
  }
  switch (goos.toLowerCase().trim()) {
    case "darwin":
      return SandboxDriverSeatbelt;
    case "linux":
      return SandboxDriverBwrap;
    case "":
      return driver;
    default:
      throw new Error(`系统轻量隔离（native）仅支持 macOS 与 Linux，当前执行机器为 ${goos}`);
  }
}

function ValidateEnvironmentVariables(values) {
  for (const [key, value] of Object.entries(values ?? {})) {
    if (key === "" || key.includes("=") || key.includes("\x00")) {
      throw new Error(`invalid environment variable name ${JSON.stringify(key)}`);
    }
    if (value.includes("\x00")) {
      throw new Error(`environment variable ${JSON.stringify(key)} contains NUL`);
    }
  }
}

function ValidateManagedFiles(files) {
  for (const name of Object.keys(files ?? {})) {
    ValidateRelativeFilePath(name);
  }
}

// 二进制技能上传限制，由 HTTP API 强制执行。
const SkillFileMaxBytes = 1 << 20;
const SkillMaxFileCount = 500;
const SkillTotalMaxBytes = 64 << 20;
const MCPFileMaxBytes = SkillFileMaxBytes;
const MCPMaxFileCount = SkillMaxFileCount;
const MCPTotalMaxBytes = SkillTotalMaxBytes;

// NormalizeSkillFileMode：只保留 unix 权限位，无权限位时默认 0o644。
function NormalizeSkillFileMode(mode) {
  if ((mode & 0o777) === 0) {
    return 0o644;
  }
  return mode & 0o777;
}

// ValidateSkillFileRefs：校验二进制清单路径。
function ValidateSkillFileRefs(refs) {
  for (const ref of refs ?? []) {
    ValidateRelativeFilePath(ref.Path);
    if (ref.Size < 0 || ref.Size > SkillFileMaxBytes) {
      throw new Error(`skill file ${ref.Path} exceeds the 1MB limit`);
    }
  }
}

function ValidateRelativeFilePath(name) {
  const clean = name.trim().replace(/\\/g, "/");
  if (clean === "" || clean === ".") {
    throw new Error(`invalid file path ${JSON.stringify(name)}`);
  }
  if (clean.startsWith("/") || clean.includes(":")) {
    throw new Error(`invalid file path ${JSON.stringify(name)}`);
  }
  for (const part of clean.split("/")) {
    if (part === "" || part === "." || part === "..") {
      throw new Error(`invalid file path ${JSON.stringify(name)}`);
    }
  }
}

function ValidateMCPServer(v) {
  if (v.ID.trim() === "" || v.Name.trim() === "") {
    throw new Error("MCP 需要 id 和 name");
  }
  validateMCPTransport(v);
  if (v.TimeoutSec < 0 || v.TimeoutSec > 600) {
    throw new Error("timeoutSec 需在 0–600 之间");
  }
  validateMCPScope(v);
  return validateMCPAuth(v);
}

// validateMCPTransport：校验 v.Transport 所需的启动设置。
function validateMCPTransport(v) {
  switch (v.Transport.trim()) {
    case "http":
      if (!v.URL.startsWith("http://") && !v.URL.startsWith("https://")) {
        throw new Error("HTTP MCP 需要有效的 url");
      }
      return;
    case "stdio":
    case "":
      return validateMCPStdio(v);
    default:
      throw new Error("transport 只能是 stdio 或 http");
  }
}

// validateMCPStdio：校验 stdio MCP 的命令、安装脚本与工作区相对路径。
function validateMCPStdio(v) {
  if (v.Command.trim() === "") {
    throw new Error("stdio MCP 需要 command");
  }
  if (v.InstallScript.includes("\x00")) {
    throw new Error("MCP 安装脚本不能包含 NUL");
  }
  const cwd = v.WorkingDirectory.trim();
  if (cwd !== "") {
    try {
      ValidateRelativeFilePath(cwd);
    } catch (err) {
      throw new Error(`workingDirectory: ${err.message}`);
    }
  }
  for (const entry of v.PathEntries ?? []) {
    try {
      ValidateRelativeFilePath(entry);
    } catch (err) {
      throw new Error(`pathEntries: ${err.message}`);
    }
  }
  for (const ref of v.FileRefs ?? []) {
    ValidateRelativeFilePath(ref.Path);
    if (ref.Size < 0 || ref.Size > MCPFileMaxBytes) {
      throw new Error(`MCP file ${ref.Path} exceeds the 1MB limit`);
    }
  }
}

// validateMCPScope：校验项目级与个人级服务器的归属字段。
function validateMCPScope(v) {
  switch (v.Scope.trim()) {
    case "":
      break;
    case "project":
      if (v.ProjectID.trim() === "") {
        throw new Error("项目级 MCP 需要 projectId");
      }
      if (v.OwnerUserID !== 0) {
        throw new Error("项目级 MCP 不能设置 ownerUserId");
      }
      break;
    case "personal":
      if (v.OwnerUserID <= 0) {
        throw new Error("个人级 MCP 需要 ownerUserId");
      }
      if (v.ProjectID.trim() !== "") {
        throw new Error("个人级 MCP 不能设置 projectId");
      }
      if (v.MarketID.trim() !== "") {
        throw new Error("市场 MCP 只能安装到项目，个人级 MCP 必须为自定义");
      }
      break;
    default:
      throw new Error("scope 只能为空、project 或 personal");
  }
}

// validateMCPAuth：校验 v.AuthType，令牌认证不存 Authorization 头。
function validateMCPAuth(v) {
  switch (v.AuthType.trim()) {
    case "":
    case "github-token":
    case "credential":
      break;
    default:
      throw new Error("authType must be empty, github-token or credential");
  }
  if (v.AuthType === "github-token" && v.Transport.trim() !== "http") {
    throw new Error("GitHub 令牌认证仅支持 HTTP MCP");
  }
  if (v.AuthType === "credential") {
    if (v.Transport.trim() !== "http") {
      throw new Error("credential authentication requires an HTTP MCP");
    }
    if (v.CredentialKind.trim() === "") {
      throw new Error("credential authentication requires credentialKind");
    }
  }
  if (v.AuthType === "github-token") {
    for (const key of Object.keys(v.Headers ?? {})) {
      if (key.trim().toLowerCase() === "authorization") {
        throw new Error("GitHub 令牌认证不允许在资产 Headers 中保存 Authorization");
      }
    }
  }
  if (v.AuthType === "credential") {
    for (const key of Object.keys(v.Headers ?? {})) {
      if (key.trim().toLowerCase() === "authorization") {
        throw new Error("credential authentication must not store an Authorization header on the asset");
      }
    }
  }
}

// Go json 标签名到 JS 字段名的映射，ParseMCPImport 解析 JSON 时用。
const mcpJSONKeys = { id: "ID", name: "Name", projectId: "ProjectID", marketId: "MarketID", scope: "Scope", ownerUserId: "OwnerUserID", iconUrl: "IconURL", description: "Description", transport: "Transport", command: "Command", args: "Args", url: "URL", environment: "Environment", headers: "Headers", installScript: "InstallScript", workingDirectory: "WorkingDirectory", pathEntries: "PathEntries", fileRefs: "FileRefs", authType: "AuthType", credentialKind: "CredentialKind", timeoutSec: "TimeoutSec", updatedAt: "UpdatedAt" };
const mcpFileJSONKeys = { path: "Path", size: "Size", sha256: "SHA256", mode: "Mode", updatedAt: "UpdatedAt" };

// mcpServerFromJSON：按 json 标签把解析出的对象转为 MCPServerDefinition。
function mcpServerFromJSON(v) {
  const init = {};
  for (const [key, value] of Object.entries(v)) {
    const field = mcpJSONKeys[key];
    if (field === undefined) {
      continue;
    }
    init[field] = field === "FileRefs" && Array.isArray(value) ? value.map((ref) => mcpFileRefFromJSON(ref)) : value;
  }
  return new MCPServerDefinition(init);
}

function mcpFileRefFromJSON(v) {
  const init = {};
  for (const [key, value] of Object.entries(v)) {
    const field = mcpFileJSONKeys[key];
    if (field !== undefined) {
      init[field] = value;
    }
  }
  return new MCPFileRef(init);
}

// ParseMCPImport：接受单个对象、数组、{mcpServers|servers: ...} 或按 id 索引的映射。
function ParseMCPImport(raw) {
  const trimmed = String(raw).trim();
  if (trimmed === "") {
    throw new Error("空的 MCP JSON");
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error("JSON 不是 MCP 对象、数组或 mcpServers 映射");
  }
  if (parsed === null) {
    throw new Error("空的 MCP 列表");
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error("空的 MCP 列表");
    }
    if (!parsed.every((v) => v != null && typeof v === "object" && !Array.isArray(v))) {
      throw new Error("JSON 不是 MCP 对象、数组或 mcpServers 映射");
    }
    return parsed.map((v) => mcpServerFromJSON(v));
  }
  if (typeof parsed === "object") {
    const one = mcpServerFromJSON(parsed);
    if (one.ID.trim() !== "" && one.Name.trim() !== "") {
      return [one];
    }
    const nested = parsed.mcpServers !== undefined && parsed.mcpServers !== null ? parsed.mcpServers : parsed.servers;
    if (nested !== undefined && nested !== null) {
      return ParseMCPImport(JSON.stringify(nested));
    }
    const entries = Object.entries(parsed);
    if (entries.length > 0 && entries.every(([, v]) => v != null && typeof v === "object" && !Array.isArray(v))) {
      const out = [];
      for (const [id, v] of entries) {
        const def = mcpServerFromJSON(v);
        if (def.ID.trim() === "") {
          def.ID = id;
        }
        out.push(def);
      }
      return out;
    }
  }
  throw new Error("JSON 不是 MCP 对象、数组或 mcpServers 映射");
}

module.exports = { RuleDefinition, SkillDefinition, SkillSourceSkillHub, SkillSource, SkillFileRef, MCPServerDefinition, MCPFileRef, AgentAssetBundle, DockerfileDefinition, SandboxProfile, SandboxDockerfile, ValidateSandboxAssets, RunnerSandbox, SandboxDriverLocal, SandboxDriverNative, SandboxDriverDocker, SandboxDriverSeatbelt, SandboxDriverBwrap, ConversationSandboxDriver, ValidateFrozenSandbox, ResolveSandboxDriver, ValidateEnvironmentVariables, ValidateManagedFiles, SkillFileMaxBytes, SkillMaxFileCount, SkillTotalMaxBytes, MCPFileMaxBytes, MCPMaxFileCount, MCPTotalMaxBytes, NormalizeSkillFileMode, ValidateSkillFileRefs, ValidateRelativeFilePath, ValidateMCPServer, validateMCPTransport, validateMCPStdio, validateMCPScope, validateMCPAuth, ParseMCPImport };
