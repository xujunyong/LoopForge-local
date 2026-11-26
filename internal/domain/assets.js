/**
 * @file internal/domain/assets.js
 * 对应 Go 源文件：internal/domain/assets.go
 *
 * 作用与职责边界：
 * 定义运行配置资产（规则、技能、MCP 服务器、资产包、Dockerfile 与沙箱配置）的数据模型，
 * 并提供沙箱驱动解析与校验、相对路径与环境变量校验、技能/MCP 文件上传限制与模式归一化、
 * MCP 配置合法性校验以及多格式 MCP JSON 导入解析。
 * 不负责数据库读写或实际文件物化到磁盘。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 转写为成功返回值、失败抛出 `Error`；仅返回 `error` 的函数成功返回 `undefined`。
 * - Go 格式化占位符 `%q` 转写为 `JSON.stringify(...)`。
 * - `ParseMCPImport` 通过字段映射表模拟 Go `json.Unmarshal` 按 `json` 标签反序列化。
 */

"use strict";

const { RunnerSandboxSpec } = require("./runner.js"); // 对应 Go 同包类型，runner.js 翻译后补齐

/**
 * 表示可绑定到角色或整个工作流的规则定义。
 * 当 `Global` 为 `true` 时，会作为工作流级约束注入到 `WorkflowIDs` 对应工作流的每个节点。
 */
class RuleDefinition {
  /**
   * 构造并初始化规则定义实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示技能资产定义，包含主内容、文本附加文件、二进制文件元数据清单及市场安装来源。
 * 当 `Source` 非空时，表示该技能为只读市场快照，仅允许通过市场更新流程替换。
 */
class SkillDefinition {
  /**
   * 构造并初始化技能定义实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

// 从 skillhub.cn 安装的技能市场提供方标识。
const SkillSourceSkillHub = "skillhub";

/**
 * 表示技能快照的市场来源与版本信息。
 * 由于 SkillHub 的 slug 仅在发布者命名空间内唯一，因此同时保留 `Namespace` 与 `Slug`。
 */
class SkillSource {
  /**
   * 构造并初始化技能市场来源实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示技能关联的单个二进制文件元数据引用。
 * `Path` 为相对技能目录的路径，`Mode` 保留上传时的 Unix 权限位以便脚本在沙箱中保持可执行。
 */
class SkillFileRef {
  /**
   * 构造并初始化技能二进制文件引用实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Path = init.Path ?? "";
    this.Size = init.Size ?? 0;
    this.SHA256 = init.SHA256 ?? "";
    this.Mode = init.Mode ?? 0;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

/**
 * 表示 MCP（Model Context Protocol）服务器资产定义。
 * 支持 `stdio` 与 `http` 两种传输协议、项目级/个人级作用域、自定义环境变量/请求头以及平台凭证认证。
 */
class MCPServerDefinition {
  /**
   * 构造并初始化 MCP 服务器定义实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示 MCP 服务器携带的单个二进制文件元数据引用。
 * 用于随 MCP 资产分发本地脚本或工具二进制。
 */
class MCPFileRef {
  /**
   * 构造并初始化 MCP 二进制文件引用实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Path = init.Path ?? "";
    this.Size = init.Size ?? 0;
    this.SHA256 = init.SHA256 ?? "";
    this.Mode = init.Mode ?? 0;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }
}

/**
 * 表示下发给本地运行时或远程执行器的完整 Agent 资产包。
 * 同时携带规则、技能、MCP 定义及对应二进制文件内容映射，便于在沙箱内直接物化。
 */
class AgentAssetBundle {
  /**
   * 构造并初始化 Agent 资产包实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Rules = init.Rules ?? [];
    this.Skills = init.Skills ?? [];
    this.MCPServers = init.MCPServers ?? [];
    this.SkillFiles = init.SkillFiles ?? {};
    this.MCPFiles = init.MCPFiles ?? {};
  }
}

/**
 * 表示执行器规格中用于构建 Docker 沙箱镜像的 Dockerfile 配方定义。
 * 通常由 `SandboxProfile` 派生，运行时据此在沙箱初始化阶段生成临时构建上下文。
 */
class DockerfileDefinition {
  /**
   * 构造并初始化 Dockerfile 配方定义实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示沙箱配置档案。
 * 描述沙箱隔离驱动类型、只读根文件系统开关、环境变量及 Docker 模式下内嵌的 Dockerfile 配方。
 */
class SandboxProfile {
  /**
   * 构造并初始化沙箱配置档案实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
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

/**
 * 表示内嵌于沙箱配置中的 Dockerfile 正文及其构建上下文文件映射。
 */
class SandboxDockerfile {
  /**
   * 构造并初始化沙箱 Dockerfile 实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Content = init.Content ?? "";
    this.Files = init.Files ?? {};
  }
}

/**
 * 校验沙箱配置的驱动类型、Dockerfile 配方要求、构建上下文路径及环境变量是否合法。
 * 在创建或更新沙箱配置资产时调用；Docker 驱动必须提供 Dockerfile，非 Docker 驱动禁止携带 Dockerfile。
 *
 * @param {SandboxProfile} v - 待校验的沙箱配置对象。
 * @returns {void} 校验通过无返回值；发现不合法配置时抛出 `Error`。
 */
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

/**
 * 将持久化存储的 `SandboxProfile` 转换为下发给执行器的 `RunnerSandboxSpec`。
 * 若沙箱包含有效 Dockerfile 内容，会将其提取为独立的 `DockerfileDefinition` 配方并剥离 `Profile` 中的内嵌副本。
 *
 * @param {SandboxProfile} profile - 已保存的沙箱配置档案。
 * @returns {RunnerSandboxSpec} 组装好的执行器沙箱规格对象。
 */
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

// 沙箱驱动类型常量：配置持久化仅存 native 或 docker，native 在执行机解析为 seatbelt（macOS）或 bwrap（Linux）。
const SandboxDriverLocal = "local";
const SandboxDriverNative = "native";
const SandboxDriverDocker = "docker";
const SandboxDriverSeatbelt = "seatbelt";
const SandboxDriverBwrap = "bwrap";

/**
 * 判断指定沙箱驱动是否允许用于对话工作区运行。
 * 接受 Docker 驱动以及系统轻量隔离驱动（`native` 或已解析的 `seatbelt`、`bwrap`）。
 *
 * @param {string} driver - 沙箱驱动名称。
 * @returns {boolean} 可用于对话工作区时返回 `true`，否则返回 `false`。
 */
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

/**
 * 校验冻结在历史运行快照中的沙箱配置，拒绝已移除的无隔离 `local` 驱动。
 * 在重跑或恢复历史运行任务前调用。
 *
 * @param {SandboxProfile} profile - 冻结在运行中的沙箱配置档案。
 * @returns {void} 校验通过无返回值；使用 `local` 驱动时抛出 `Error`。
 */
function ValidateFrozenSandbox(profile) {
  if (profile.Driver.trim() === SandboxDriverLocal) {
    throw new Error(`沙箱 ${profile.ID} 使用已移除的 local 类型，请改用 native 沙箱后重新发起`);
  }
}

/**
 * 根据目标执行机器的操作系统将 `native` 驱动解析为具体的系统轻量隔离驱动。
 * `darwin` 映射为 `seatbelt`，`linux` 映射为 `bwrap`，`goos` 为空时保留 `native` 交由执行机自行解析，其余驱动原样返回。
 *
 * @param {string} driver - 原始沙箱驱动名称。
 * @param {string} goos - 执行机器操作系统标识（如 `"darwin"`、`"linux"` 或 `""`）。
 * @returns {string} 解析后的沙箱驱动名称；不支持的操作系统下请求 `native` 时抛出 `Error`。
 */
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

/**
 * 校验环境变量键值对是否合法。
 * 变量名不能为空且不得包含 `=` 或 NUL 字符，变量值不得包含 NUL 字符。
 *
 * @param {Object<string, string>} values - 待校验的环境变量键值映射。
 * @returns {void} 校验通过无返回值；存在非法键名或字符时抛出 `Error`。
 */
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

/**
 * 校验受管文件映射中的所有文件名均为安全的相对路径。
 * 用于 Dockerfile 构建上下文文件与技能文本附加文件的路径检查。
 *
 * @param {Object<string, string>} files - 以相对路径为键、文件内容为值的映射对象。
 * @returns {void} 校验通过无返回值；任一路径非法时抛出 `Error`。
 */
function ValidateManagedFiles(files) {
  for (const name of Object.keys(files ?? {})) {
    ValidateRelativeFilePath(name);
  }
}

// 技能与 MCP 二进制文件上传的体积和数量上限常量，由 HTTP API 强制执行。
const SkillFileMaxBytes = 1 << 20;
const SkillMaxFileCount = 500;
const SkillTotalMaxBytes = 64 << 20;
const MCPFileMaxBytes = SkillFileMaxBytes;
const MCPMaxFileCount = SkillMaxFileCount;
const MCPTotalMaxBytes = SkillTotalMaxBytes;

/**
 * 规范化技能或 MCP 文件的 Unix 权限位。
 * 仅保留低 9 位（`0o777`）；若传入模式未包含任何权限位，则回退默认权限 `0o644`。
 *
 * @param {number} mode - 原始文件权限整数。
 * @returns {number} 规范化后的 Unix 权限位整数。
 */
function NormalizeSkillFileMode(mode) {
  if ((mode & 0o777) === 0) {
    return 0o644;
  }
  return mode & 0o777;
}

/**
 * 校验技能二进制文件引用清单中的每一条路径与文件大小。
 * 路径必须为合法相对路径，且单文件体积不得为负或超过 1MB 上限。
 *
 * @param {SkillFileRef[]} refs - 技能二进制文件元数据引用数组。
 * @returns {void} 校验通过无返回值；路径非法或超限时抛出 `Error`。
 */
function ValidateSkillFileRefs(refs) {
  for (const ref of refs ?? []) {
    ValidateRelativeFilePath(ref.Path);
    if (ref.Size < 0 || ref.Size > SkillFileMaxBytes) {
      throw new Error(`skill file ${ref.Path} exceeds the 1MB limit`);
    }
  }
}

/**
 * 校验单个文件路径是否为安全的相对路径，防止绝对路径、盘符和目录穿越（`..`）。
 * 在保存技能文件、MCP 文件、工作目录及 Dockerfile 上下文路径时调用。
 *
 * @param {string} name - 待校验的文件或目录相对路径。
 * @returns {void} 校验通过无返回值；路径不合法时抛出 `Error`。
 */
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

/**
 * 全面校验 MCP 服务器定义的标识、传输配置、超时范围、作用域归属及认证方式。
 * 在创建、更新或导入 MCP 服务器资产时调用。
 *
 * @param {MCPServerDefinition} v - 待校验的 MCP 服务器定义对象。
 * @returns {void} 校验通过无返回值；任一校验项不通过时抛出 `Error`。
 */
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

/**
 * 按 MCP 传输协议类型校验启动配置（`http` 校验 URL，`stdio` 或空值校验命令及工作区路径）。
 * 由 `ValidateMCPServer` 内部调用。
 *
 * @param {MCPServerDefinition} v - 待校验的 MCP 服务器定义对象。
 * @returns {void} 校验通过无返回值；协议或启动参数非法时抛出 `Error`。
 */
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

/**
 * 校验 `stdio` 类型 MCP 服务器的启动命令、安装脚本、工作目录、PATH 项与二进制文件清单。
 * 由 `validateMCPTransport` 内部调用。
 *
 * @param {MCPServerDefinition} v - 待校验的 `stdio` MCP 服务器定义对象。
 * @returns {void} 校验通过无返回值；发现空命令、NUL 字符、非法路径或文件超限时抛出 `Error`。
 */
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

/**
 * 校验 MCP 资产作用域（空、项目级 `project`、个人级 `personal`）与归属字段的一致性。
 * 项目级必须有 `ProjectID` 且无 `OwnerUserID`；个人级必须有正数 `OwnerUserID` 且不得设置 `ProjectID` 或 `MarketID`。
 *
 * @param {MCPServerDefinition} v - 待校验的 MCP 服务器定义对象。
 * @returns {void} 校验通过无返回值；归属字段冲突时抛出 `Error`。
 */
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

/**
 * 校验 MCP 服务器的认证方式配置。
 * 令牌/凭证类认证仅允许用于 HTTP MCP，凭证认证需提供 `CredentialKind`，且资产 `Headers` 中不得静态保存 `Authorization` 头。
 *
 * @param {MCPServerDefinition} v - 待校验的 MCP 服务器定义对象。
 * @returns {void} 校验通过无返回值；认证配置非法时抛出 `Error`。
 */
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

// Go json 标签名到 JS 类字段名的映射表，供 ParseMCPImport 解析 JSON 载荷时使用。
const mcpJSONKeys = { id: "ID", name: "Name", projectId: "ProjectID", marketId: "MarketID", scope: "Scope", ownerUserId: "OwnerUserID", iconUrl: "IconURL", description: "Description", transport: "Transport", command: "Command", args: "Args", url: "URL", environment: "Environment", headers: "Headers", installScript: "InstallScript", workingDirectory: "WorkingDirectory", pathEntries: "PathEntries", fileRefs: "FileRefs", authType: "AuthType", credentialKind: "CredentialKind", timeoutSec: "TimeoutSec", updatedAt: "UpdatedAt" };
const mcpFileJSONKeys = { path: "Path", size: "Size", sha256: "SHA256", mode: "Mode", updatedAt: "UpdatedAt" };

/**
 * 将反序列化后的普通 JSON 对象按 Go `json` 标签映射为 `MCPServerDefinition` 实例。
 * 由 `ParseMCPImport` 内部调用。
 *
 * @param {Object} v - 从 JSON 解析出的单个 MCP 配置普通对象。
 * @returns {MCPServerDefinition} 构造完成的 MCP 服务器定义实例。
 */
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

/**
 * 将反序列化后的普通 JSON 对象按 Go `json` 标签映射为 `MCPFileRef` 实例。
 * 由 `mcpServerFromJSON` 内部调用。
 *
 * @param {Object} v - 从 JSON 解析出的单个文件引用普通对象。
 * @returns {MCPFileRef} 构造完成的 MCP 文件引用实例。
 */
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

/**
 * 解析外部导入的 MCP JSON 文本，返回标准化的 `MCPServerDefinition` 数组。
 * 兼容四种常见格式：单个 MCP 对象、MCP 对象数组、`{mcpServers|servers: ...}` 包装对象、以及按服务器 ID 为键的映射表。
 *
 * @param {string|Buffer} raw - 原始 JSON 文本或字节内容。
 * @returns {MCPServerDefinition[]} 解析得到的 MCP 服务器定义数组；输入为空或格式不匹配时抛出 `Error`。
 */
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
