// providers.js —— 对应 Go 文件：internal/managedcli/providers.go
// 作用：托管 CLI 的供应商清单：包名、启动命令、必备参数与版本规则。
// Go 的 time.Duration 译为毫秒数；(值, error) 译为成功返回值、失败 throw。

"use strict";

// 与 manifest.js 循环引用：两边都在末尾重写 module.exports，顶层缓存的模块对象会是
// 加载中的空对象；故调用时现取 require("./manifest.js")，不缓存。

// Update safety bounds are fixed; no task, local policy or environment may
// change the registry, supported packages, or observation and timeout windows.
const npmRegistry = "https://registry.npmjs.org";
const observationWindow = 24 * 60 * 60 * 1000;
const maintenanceTimeout = 30 * 60 * 1000;
const commandTimeout = 10 * 60 * 1000;
const providerAllowlistEnv = "AGENTFLOW_MANAGED_CLIS";

class providerSpec {
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

// EnabledProviders returns the deployment's update allowlist, ignoring empty
// entries. A list with no names uses the defaults. Existing installations and
// rollback remain accessible when a provider is excluded.
function EnabledProviders() {
  const selected = new Set();
  for (const item of (process.env[providerAllowlistEnv] ?? "").split(",")) {
    const name = item.trim();
    if (name === "") {
      continue;
    }
    if (!Supports(name)) {
      throw new Error(`${providerAllowlistEnv} contains unsupported CLI ${JSON.stringify(name)}`);
    }
    selected.add(name);
  }
  if (selected.size === 0) {
    if (process.env.AGENTFLOW_SKIP_CODEBUDDY_INSTALL === "1") {
      return ["claude-code", "codex"];
    }
    return ["claude-code", "codebuddy", "codex"];
  }
  const providers = [...selected];
  providers.sort();
  return providers;
}

// AutoUpdateEnvironment disables a provider's built-in updater during managed execution.
// Pi replaces its CLI through the explicit pi update command. The shipped DSH
// headless profile relies on package-manager updates for the CLI.
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

function validProviderVersion(provider, version) {
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
      return require("./manifest.js").releaseVersion.test(core) && releaseCandidateNumber.test(candidate);
    }
  }
  return require("./manifest.js").releaseVersion.test(version);
}

// Supports reports whether the platform updater owns this provider.
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
  EnabledProviders,
  AutoUpdateEnvironment,
  cursorBuild,
  releaseCandidateNumber,
  validProviderVersion,
  Supports,
};
