// providers.js —— 对应 Go 文件：internal/managedcli/providers.go
// 作用：定义托管 CLI 的固定安全边界常量、供应商规格表（包名、可执行名、帮助参数与必备参数），
// 以及启用供应商白名单解析、禁用上游自更新环境变量与版本号校验逻辑。
// 职责边界：只维护供应商静态规格与通用版本/支持性校验，不发起网络请求，不读写磁盘状态文件。
// 语法差异说明：
// - Go 的 time.Duration 译为毫秒数；
// - Go 的 (值, error) 多返回值译为成功直接 return、失败 throw Error；
// - Go 的集合 map[string]struct{} 译为普通对象 {}（值为 true）。

"use strict";

// manifest.js 不在顶层引用本文件，此处引入 releaseVersion 无顶层循环依赖，并重新导出供同包模块使用。
const { releaseVersion } = require("./manifest.js");

// Update safety bounds are fixed; no task, local policy or environment may
// change the registry, supported packages, or observation and timeout windows.
const npmRegistry = "https://registry.npmjs.org";
const observationWindow = 24 * 60 * 60 * 1000;
const maintenanceTimeout = 30 * 60 * 1000;
const commandTimeout = 10 * 60 * 1000;
const providerAllowlistEnv = "AGENTFLOW_MANAGED_CLIS";

/**
 * 单个托管 CLI 供应商的规格描述，记录 npm 包名、可执行文件名、探测帮助命令、必备参数与引擎检查策略。
 */
class providerSpec {
  /**
   * 构造供应商规格实例，按 Go struct 零值规则初始化缺省字段。
   *
   * @param {object} [init={}] 初始字段对象，可选包含 Package、Binary、Help、Flags、RelaxEngines。
   */
  constructor(init = {}) {
    this.Package = init.Package ?? "";
    this.Binary = init.Binary ?? "";
    this.Help = init.Help ?? [];
    this.Flags = init.Flags ?? [];
    this.RelaxEngines = init.RelaxEngines ?? false;
  }
}

const providerSpecs = {
  agy: new providerSpec({
    Binary: "agy",
    Help: ["--help"],
    Flags: ["--output-format", "--model", "--settings", "--conversation", "--disable-slash-commands"],
  }),
  cursor: new providerSpec({
    Binary: "cursor-agent",
    Help: ["--help"],
    Flags: ["--output-format", "--stream-partial-output", "--model", "--resume"],
  }),
  dsh: new providerSpec({
    Package: "@deepseek-ai/dsh",
    Binary: "dsh",
    Help: ["--profile", "headless", "--help"],
    Flags: ["--json", "--permission-mode", "--approval-policy", "--session-id"],
    // The runtime already uses DSH on Node 22. Probe the actual binary
    // on this worker before activating a release that declares Node 24.
    RelaxEngines: true,
  }),
  kimi: new providerSpec({
    Package: "@moonshot-ai/kimi-code",
    Binary: "kimi",
    Help: ["--help"],
    Flags: ["--output-format", "--agent-file", "--session"],
  }),
  opencode: new providerSpec({
    Package: "opencode-ai",
    Binary: "opencode",
    Help: ["run", "--help"],
    Flags: ["--format", "--thinking", "--model", "--session"],
  }),
  pi: new providerSpec({
    Package: "@earendil-works/pi-coding-agent",
    Binary: "pi",
    Help: ["--help"],
    Flags: ["--mode", "--session-id", "--model", "--tools", "--exclude-tools", "--append-system-prompt"],
  }),
  codex: new providerSpec({
    Package: "@openai/codex",
    Binary: "codex",
    Help: ["exec", "--help"],
    Flags: ["--json", "--sandbox", "--skip-git-repo-check", "--model"],
  }),
  codebuddy: new providerSpec({
    Package: "@tencent-ai/codebuddy-code",
    Binary: "codebuddy",
    Help: ["--help"],
    Flags: ["--print", "--output-format", "--permission-mode", "--setting-sources", "--system-prompt-file", "--mcp-config", "--strict-mcp-config", "--settings", "--resume", "--plugin-dir"],
  }),
  "claude-code": new providerSpec({
    Package: "@anthropic-ai/claude-code",
    Binary: "claude",
    Help: ["--help"],
    Flags: ["--print", "--output-format", "--verbose", "--permission-mode", "--setting-sources", "--system-prompt-file", "--mcp-config", "--settings", "--resume", "--plugin-dir"],
  }),
};

/**
 * 读取当前部署启用的托管 CLI 更新白名单。
 * 在执行更新或检查前调用；若环境变量未配置任何有效名称则返回默认清单，已有安装与回滚不受排除项影响。
 *
 * @returns {string[]} 已去重并按字典序排序的供应商名称数组；若环境变量包含不支持的名称则抛出错误。
 */
function EnabledProviders() {
  const selected = {};
  for (const item of (process.env[providerAllowlistEnv] ?? "").split(",")) {
    const name = item.trim();
    if (name === "") {
      continue;
    }
    if (!Supports(name)) {
      throw new Error(`${providerAllowlistEnv} contains unsupported CLI ${JSON.stringify(name)}`);
    }
    selected[name] = true;
  }
  const providers = Object.keys(selected);
  if (providers.length === 0) {
    if (process.env.AGENTFLOW_SKIP_CODEBUDDY_INSTALL === "1") {
      return ["claude-code", "codex"];
    }
    return ["claude-code", "codebuddy", "codex"];
  }
  providers.sort();
  return providers;
}

/**
 * 返回用于关闭指定供应商内置自动更新功能的环境变量映射。
 * 在托管执行某个 CLI 进程前调用；不需要额外环境变量的供应商返回 null。
 *
 * @param {string} provider 供应商名称。
 * @returns {Object<string, string>|null} 环境变量键值对象；无需设置时返回 null。
 */
function AutoUpdateEnvironment(provider) {
  switch (provider) {
    case "claude-code":
    case "codebuddy":
      return { DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1" };
    case "opencode":
      return { OPENCODE_DISABLE_AUTOUPDATE: "1" };
    case "kimi":
      return { KIMI_CODE_NO_AUTO_UPDATE: "1" };
  }
  return null;
}

const cursorBuild = /^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[a-f0-9]{7,40}$/;
const releaseCandidateNumber = /^(0|[1-9][0-9]*)$/;

/**
 * 校验给定版本号是否符合对应供应商的发布版本格式规范。
 * 在解析 registry 元数据、供应商清单、安装清单或回滚记录时调用。
 *
 * @param {string} provider 供应商名称。
 * @param {string} version 待校验的版本号字符串。
 * @returns {boolean} 版本号合法返回 true，否则返回 false。
 */
function validProviderVersion(provider, version) {
  if (typeof version !== "string") {
    return false;
  }
  if (provider === "cursor") {
    if (!cursorBuild.test(version)) {
      return false;
    }
    // Go 的 time.Parse("2006.01.02", ...) 校验年月日是否合法：拼回 Date 再按数值比对，
    // 非法日期（如 02-30）会被 Date 进位，数值对不上。
    const y = Number(version.slice(0, 4));
    const mo = Number(version.slice(5, 7));
    const d = Number(version.slice(8, 10));
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d;
  }
  if (provider === "dsh") {
    const idx = version.indexOf("-rc.");
    if (idx !== -1) {
      const core = version.slice(0, idx);
      const candidate = version.slice(idx + 4);
      return releaseVersion.test(core) && releaseCandidateNumber.test(candidate);
    }
  }
  return releaseVersion.test(version);
}

/**
 * 判断平台托管更新器是否支持该供应商。
 * 在校验外部入参、白名单环境变量或清单键名时调用。
 *
 * @param {string} provider 供应商名称。
 * @returns {boolean} 支持返回 true，否则返回 false。
 */
function Supports(provider) {
  return Object.prototype.hasOwnProperty.call(providerSpecs, provider);
}

module.exports = {
  npmRegistry,
  observationWindow,
  maintenanceTimeout,
  commandTimeout,
  providerAllowlistEnv,
  providerSpec,
  providerSpecs,
  releaseVersion,
  EnabledProviders,
  AutoUpdateEnvironment,
  cursorBuild,
  releaseCandidateNumber,
  validProviderVersion,
  Supports,
};
