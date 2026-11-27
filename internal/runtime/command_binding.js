/**
 * @file internal/runtime/command_binding.js
 * @description 对应 Go 源文件：internal/runtime/command_binding.go
 *
 * 职责与边界：
 * 负责子命令执行前的凭据与运行环境绑定：清空宿主敏感凭据、按声明的绑定类型注入目标凭据、
 * 准备并校验工作区私有 HOME/TMP 目录、配置 Git 实时凭据中继与身份信息、设置 OpenTelemetry 遥测变量。
 * 不负责底层沙箱进程拉起或具体 CLI 配置渲染（Agent CLI 凭据渲染见 `agent_cli.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 译为成功返回值、失败抛出 `Error`；仅 `error` 译为成功返回 `undefined`、失败抛出 `Error`。
 * - Go 的 `(值1, 值2, error)` 译为成功返回 `[值1, 值2]`、失败抛出 `Error`。
 * - Go 结构体按值复制译为对象浅拷贝 `{ ...command }`；`context.Context` 对应 `AbortSignal`。
 */

"use strict";

const path = require("node:path"); // Go path/filepath

const { NormalizeGitPlatform, GitPlatformOther } = require("../domain/user.js"); // 对应 Go 的 domain.NormalizeGitPlatform/GitPlatformOther，user.js 已翻译
const { HTTPSHostScope } = require("../gitwork/https_host.js"); // 对应 Go 的 gitwork.HTTPSHostScope，https_host.js 待翻译
const { CollectorTracesURL } = require("../observability/hooks.js"); // 对应 Go 的 observability.CollectorTracesURL，hooks.js 待翻译
const { BindCodeBuddy, BindCodex, BindClaudeCode, BindGit, BindGitWorkspace, BindMCP, BindExtra, BindAgentCLI } = require("./runtime.js"); // 对应 Go 同包常量，runtime.js 待翻译
const { workspaceGitSecretEnvironment } = require("./run_git_credentials.js"); // 对应 Go 同包变量，run_git_credentials.js 待翻译
const { EnsureControlDirectory, resetControlDirectory } = require("./materialize.js"); // 对应 Go 同包函数，materialize.js 待翻译
const { sandboxDriver } = require("./runner.js"); // 对应 Go 同包函数，runner.js 待翻译
const { mcpCallHostDir, mcpCallGuestPath, installMCPCallHelperForSandbox, bindMCPCallEnvironment, BindMCPCallArgv } = require("./mcp_call.js"); // 对应 Go 同包函数，mcp_call.js 待翻译
const { writeManagedFile } = require("./managed_files.js"); // 对应 Go 同包函数，managed_files.js 待翻译
const { shellSingleQuote } = require("./sandbox_environment.js"); // 对应 Go 同包函数，sandbox_environment.js 待翻译
const { BindClaudeCodeEndpoint } = require("./claude_endpoint.js"); // 对应 Go 同包函数，claude_endpoint.js 已翻译
const { WorkspaceAgentCLIHome, HostAgentCLIHome, ApplyAgentCLICredential, AgentCLILabel, agentCLIHostEnv } = require("./agent_cli.js"); // 对应 Go 同包函数与变量，agent_cli.js 待翻译
const { safeID } = require("./identifier.js"); // 对应 Go 同包函数，identifier.js 待翻译
const { SessionGatewayEnv, GitHostsEnv } = require("./git_credential_helper.js"); // 对应 Go 同包常量，git_credential_helper.js 待翻译
const { unwrapSandbox } = require("./browser.js"); // 对应 Go 同包函数，browser.js 待翻译
const { processSandbox } = require("./sandbox_process.js"); // 对应 Go 同包类型，sandbox_process.js 待翻译
const { localSandbox } = require("./sandbox_local.js"); // 对应 Go 同包类型，sandbox_local.js 待翻译

/**
 * 在 `KEY=VALUE` 形式的环境变量数组中更新或追加指定键（重复键仅保留首次替换项）。
 *
 * @param {string[]} env - 原始环境变量条目数组。
 * @param {string} key - 环境变量名。
 * @param {string} value - 新的环境变量值。
 * @returns {string[]} 更新后的环境变量数组。
 */
function upsertEnv(env, key, value) {
  const prefix = key + "=";
  const out = [];
  let found = false;
  for (const kv of env) {
    if (kv.startsWith(prefix)) {
      if (!found) {
        out.push(prefix + value);
        found = true;
      }
      continue;
    }
    out.push(kv);
  }
  if (!found) {
    out.push(prefix + value);
  }
  return out;
}

/**
 * 为待执行命令绑定运行环境与凭据：清空宿主敏感变量、创建并校验私有 HOME、
 * 按 `CredentialBindings` 注入对应凭据与参数，最后注入钩子输出路径和遥测变量。
 *
 * @param {AbortSignal} ctx - 取消信号（对应 Go `context.Context`）。
 * @param {Object} sandbox - 目标沙箱实例。
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {Object} command - 待绑定的 `CommandSpec` 对象。
 * @param {Object} credentials - 本次运行的 `RunCredentials` 凭据集合。
 * @returns {Object} 绑定完成后的新 `CommandSpec` 对象；目录校验、凭据缺失或未知绑定类型时抛出 `Error`。
 */
function bindCommand(ctx, sandbox, workspace, command, credentials) {
  if (command.bindingsPrepared) {
    return command;
  }
  // Go 按值复制结构体。
  const bound = { ...command };
  bound.environment = {};
  for (const [key, value] of Object.entries(command.environment ?? {})) {
    bound.environment[key] = value;
  }
  // 已知宿主凭据默认对每个子进程清空。供应商只有显式请求受控绑定时才能拿到。
  bound.environment["CODEBUDDY_API_KEY"] = "";
  bound.environment["CODEBUDDY_BASE_URL"] = "";
  bound.environment["CODEBUDDY_INTERNET_ENVIRONMENT"] = "";
  bound.environment["AGENTFLOW_GIT_TOKEN"] = "";
  bound.environment["GH_TOKEN"] = "";
  bound.environment["GITHUB_TOKEN"] = "";
  for (const key of workspaceGitSecretEnvironment) {
    bound.environment[key] = "";
  }
  let gitBinding = false;
  for (const binding of command.CredentialBindings ?? []) {
    if (binding === BindGit || binding === BindGitWorkspace) {
      gitBinding = true;
    }
  }
  if (!gitBinding) {
    bound.environment["GIT_CONFIG_COUNT"] = "1";
    bound.environment["GIT_CONFIG_KEY_0"] = "credential.helper";
    bound.environment["GIT_CONFIG_VALUE_0"] = "";
    // Go 的 os.DevNull 在 Unix 上是 /dev/null。
    bound.environment["GIT_CONFIG_GLOBAL"] = "/dev/null";
    bound.environment["GIT_CONFIG_SYSTEM"] = "/dev/null";
  }
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
    bound.environment[key] = "";
  }
  if (command.Provider === "codebuddy") {
    // 每个对话与工作区都有自己的 CLI 家目录，CodeBuddy 会往每个家目录下载
    // 内置插件市场（约 71 MB）。LoopForge 自己写 skills 与 agents，不装插件。
    bound.environment["CODEBUDDY_SKIP_BUILTIN_MARKETPLACE"] = "1";
  }
  // 在任何凭据绑定能写配置之前，先校验私有家目录的每个组成部分。沙箱可能把父目录换成了符号链接。
  if (command.PrivateHome) {
    const provider = PrivateHomeName(command);
    let hostHome;
    try {
      hostHome = EnsureControlDirectory(workspace, "private-home", provider);
    } catch (err) {
      throw new Error(`create private home: ${err.message}`);
    }
    let hostTmp;
    try {
      hostTmp = EnsureControlDirectory(workspace, "tmp", provider);
    } catch (err) {
      throw new Error(`create private temp: ${err.message}`);
    }
    if (sandboxDriver(sandbox) === "docker") {
      bound.environment["HOME"] = path.join("/workspace", ".agentflow", "private-home", provider).split(path.sep).join("/");
      bound.environment["TMPDIR"] = path.join("/workspace", ".agentflow", "tmp", provider).split(path.sep).join("/");
    } else {
      bound.environment["HOME"] = hostHome;
      bound.environment["TMPDIR"] = hostTmp;
    }
    if (command.Provider === "codex" || command.Provider === "claude-code") {
      let dir = ".codex";
      let key = "CODEX_HOME";
      if (command.Provider === "claude-code") {
        dir = ".claude";
        key = "CLAUDE_CONFIG_DIR";
      }
      EnsureControlDirectory(workspace, "private-home", provider, dir);
      bound.environment[key] = path.join(bound.environment["HOME"], dir).split(path.sep).join("/");
    }
  }
  for (const binding of command.CredentialBindings ?? []) {
    switch (binding) {
      case BindCodeBuddy: {
        // 清空端点会为该版本恢复 CodeBuddy 的官方地址。
        bound.environment["CODEBUDDY_API_KEY"] = (credentials.CodeBuddy.APIKey ?? "").trim();
        if (bound.environment["CODEBUDDY_API_KEY"] === "") {
          throw new Error("需求责任人未配置 CodeBuddy API Key，请在个人配置中配置");
        }
        bound.environment["CODEBUDDY_INTERNET_ENVIRONMENT"] = (credentials.CodeBuddy.InternetEnvironment ?? "").trim();
        bound.environment["CODEBUDDY_BASE_URL"] = (credentials.CodeBuddy.BaseURL ?? "").trim();
        break;
      }
      case BindGit:
      case BindGitWorkspace: {
        bindWorkspaceGitEnvironment(ctx, sandbox, workspace, bound.environment, credentials);
        break;
      }
      case BindExtra: {
        // 缺失的凭据特意导出为空字符串：子进程不得继承 AgentFlow 宿主进程自己的值，
        // 部署通过 Extra 凭据路由的变量尤其如此。
        for (const [envName, credName] of Object.entries(command.ExtraCredentialEnv ?? {})) {
          bound.environment[envName] = (credentials.Extra ?? {})[credName] ?? "";
          bound.credentialEnvKeys = [...(bound.credentialEnvKeys ?? []), envName];
        }
        break;
      }
      case BindMCP: {
        bindMCPCallEnvironment(ctx, sandbox, workspace, bound.environment, credentials.MCPServers);
        bound.Argv = BindMCPCallArgv(sandbox, bound.Argv);
        break;
      }
      case BindCodex: {
        bound.environment["CODEX_API_KEY"] = (credentials.Codex.APIKey ?? "").trim();
        if (bound.environment["CODEX_API_KEY"] === "") {
          throw new Error("需求责任人未配置 Codex API Key，请在个人配置中配置");
        }
        bound.Argv = CodexUserProviderArgv(bound.Argv, credentials.Codex.BaseURL);
        break;
      }
      case BindClaudeCode: {
        bound.environment["ANTHROPIC_API_KEY"] = (credentials.ClaudeCode.APIKey ?? "").trim();
        if (bound.environment["ANTHROPIC_API_KEY"] === "") {
          throw new Error("需求责任人未配置 Claude Code API Key，请在个人配置中配置");
        }
        BindClaudeCodeEndpoint(bound.environment, credentials.ClaudeCode.BaseURL);
        break;
      }
      case BindAgentCLI: {
        let home;
        let homeEnv = bound.environment["HOME"];
        if (command.PrivateHome) {
          home = WorkspaceAgentCLIHome(workspace, PrivateHomeName(command));
        } else {
          homeEnv = command.environment["HOME"];
          if ((homeEnv ?? "").trim() === "") {
            throw new Error(`${AgentCLILabel(command.Provider)} 需要独立的 HOME 目录`);
          }
          home = HostAgentCLIHome(homeEnv);
        }
        const cred = (credentials.AgentCLI ?? {})[command.Provider] ?? { APIKey: "", BaseURL: "", Protocol: "", Models: [] };
        const [argv, env] = ApplyAgentCLICredential(command.Provider, cred, command.AgentCLI, home, homeEnv, bound.Argv);
        bound.Argv = argv;
        for (const key of agentCLIHostEnv) {
          bound.environment[key] = "";
        }
        for (const [key, value] of Object.entries(env)) {
          bound.environment[key] = value;
        }
        break;
      }
      default:
        throw new Error(`unsupported credential binding ${JSON.stringify(binding)}`);
    }
  }
  if (command.HookOutput !== "") {
    bound.environment["AGENTFLOW_HOOK_OUTPUT"] = command.HookOutput;
  }
  bindTelemetryEnvironment(bound.environment, command.Telemetry, command.Provider);
  return bound;
}

/**
 * 为子 CLI 配置 OpenTelemetry 导出环境变量，并按 RunID、NodeID 与供应商名称打资源标签。
 * `telemetry` 为空时不对 `env` 做任何改动。
 *
 * @param {Object<string, string>} env - 目标环境变量字典（就地修改）。
 * @param {Object | null | undefined} telemetry - 调用遥测选项（含 `RunID`、`NodeID`）。
 * @param {string} provider - 执行器供应商名称。
 * @returns {void} 无返回值。
 */
function bindTelemetryEnvironment(env, telemetry, provider) {
  if (telemetry == null) {
    return;
  }
  const runID = telemetry.RunID;
  const nodeID = telemetry.NodeID;
  env["AGENTFLOW_RUN_ID"] = runID;
  env["AGENTFLOW_NODE_ID"] = nodeID;
  switch (provider) {
    case "codebuddy":
      env["CODEBUDDY_CODE_ENABLE_TELEMETRY"] = "1";
      break;
    case "claude-code":
      env["CLAUDE_CODE_ENABLE_TELEMETRY"] = "1";
      break;
    default:
      break;
  }
  env["OTEL_TRACES_EXPORTER"] = "otlp";
  env["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf";
  env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] = CollectorTracesURL();
  env["OTEL_LOG_TOOL_DETAILS"] = "1";
  let attributes = `agentflow.run_id=${runID},agentflow.node_id=${nodeID}`;
  if (provider === "") {
    attributes += ",service.name=agentflow";
  } else {
    attributes += `,agentflow.executor_kind=${provider},service.name=agentflow-${provider}`;
  }
  env["OTEL_RESOURCE_ATTRIBUTES"] = attributes;
}

/**
 * 在 Codex 命令最后一个参数（提示词）之前插入专用 `"agentflow_user"` 模型供应商配置参数。
 * `baseURL` 为空时默认回落到 OpenAI 官方 API；输入数组不修改。
 *
 * @param {string[]} argv - 原始 Codex 命令行参数数组（长度至少为 2）。
 * @param {string} baseURL - 自定义端点地址。
 * @returns {string[]} 插入供应商配置后的新参数数组；`argv` 长度不足时抛出 `Error`。
 */
function CodexUserProviderArgv(argv, baseURL) {
  if (argv.length < 2) {
    throw new Error("invalid Codex invocation");
  }
  baseURL = baseURL.trim();
  if (baseURL === "") {
    baseURL = "https://api.openai.com/v1";
  }
  const config = [
    "-c", `model_provider="agentflow_user"`,
    "-c", `model_providers.agentflow_user.name="User API"`,
    "-c", "model_providers.agentflow_user.base_url=" + JSON.stringify(baseURL),
    "-c", `model_providers.agentflow_user.env_key="CODEX_API_KEY"`,
    "-c", `model_providers.agentflow_user.wire_api="responses"`,
    "-c", "model_providers.agentflow_user.requires_openai_auth=false",
  ];
  const out = [...argv.slice(0, argv.length - 1), ...config, argv[argv.length - 1]];
  return out;
}

/**
 * 计算启用了 `PrivateHome` 的命令在 `.agentflow/private-home` 下的子目录名。
 * 依次回落：`PrivateHomeKey` → `Provider` → `"process"`。
 *
 * @param {Object} command - `CommandSpec` 对象。
 * @returns {string} 消毒后的安全目录名。
 */
function PrivateHomeName(command) {
  let name = safeID(command.PrivateHomeKey);
  if (name === "") {
    name = safeID(command.Provider);
  }
  if (name === "") {
    name = "process";
  }
  return name;
}

/**
 * 生成 Agent CLI 调用专用的 `PrivateHomeKey`（每个 CLI 与 Agent 组合独立一份 HOME）。
 *
 * @param {string} kind - Agent CLI 种类标识。
 * @param {string} agentID - Agent 角色标识。
 * @returns {string} 消毒后的私有 HOME 键名。
 */
function AgentCLIPrivateHomeKey(kind, agentID) {
  return safeID(kind + "-" + agentID);
}

/**
 * Runner 侧 Agent CLI 凭据绑定入口：确保私有 HOME 与 TMP 目录安全存在，
 * 渲染模型配置并返回运行所需的命令行参数与环境变量（含 `HOME` 与 `TMPDIR`）。
 *
 * @param {Object} sandbox - 目标沙箱实例。
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {Object} command - `CommandSpec` 对象。
 * @param {Object} cred - 目标供应商凭据对象。
 * @param {string[]} argv - 原始命令行参数数组。
 * @returns {[string[], Object<string, string>]} 二元组 `[更新后的 argv, 环境变量映射]`；目录或凭据绑定失败时抛出 `Error`。
 */
function BindAgentCLICommand(sandbox, workspace, command, cred, argv) {
  const name = PrivateHomeName(command);
  const [, homeEnv] = privateHomePaths(sandbox, workspace, command);
  // 每一层都经过 Lstat 校验：工作区可从沙箱写入，
  // 所以 .agentflow、私有家目录或家目录本身可能已被换成符号链接。
  try {
    EnsureControlDirectory(workspace, "private-home", name);
  } catch (err) {
    throw new Error(`create private home: ${err.message}`);
  }
  let tmp;
  try {
    tmp = EnsureControlDirectory(workspace, "tmp", name);
  } catch (err) {
    throw new Error(`create private temp: ${err.message}`);
  }
  const [boundArgv, bound] = ApplyAgentCLICredential(command.Provider, cred, command.AgentCLI, WorkspaceAgentCLIHome(workspace, name), homeEnv, argv);
  argv = boundArgv;
  const env = {};
  for (const key of agentCLIHostEnv) {
    env[key] = "";
  }
  for (const [key, value] of Object.entries(bound)) {
    env[key] = value;
  }
  env["HOME"] = homeEnv;
  env["TMPDIR"] = tmp;
  if (sandboxDriver(sandbox) === "docker") {
    env["TMPDIR"] = path.join("/workspace", ".agentflow", "tmp", name).split(path.sep).join("/");
  }
  return [argv, env];
}

/**
 * 返回 `PrivateHome` 命令在宿主上的 HOME 路径以及子进程视角看到的 HOME 路径。
 *
 * @param {Object} sandbox - 目标沙箱实例。
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {Object} command - `CommandSpec` 对象。
 * @returns {[string, string]} 二元组 `[宿主 HOME 路径, 进程视角 HOME 路径]`。
 */
function privateHomePaths(sandbox, workspace, command) {
  const name = PrivateHomeName(command);
  const host = path.join(workspace, ".agentflow", "private-home", name);
  if (sandboxDriver(sandbox) === "docker") {
    return [host, path.join("/workspace", ".agentflow", "private-home", name).split(path.sep).join("/")];
  }
  return [host, host];
}

/**
 * 为工作区命令配置 Git 身份、清空 `gh`/`glab` 历史登录态，并安装基于会话网关的实时凭据中继 helper 与 CLI shim。
 *
 * @param {AbortSignal} ctx - 取消信号（对应 Go `context.Context`）。
 * @param {Object} sandbox - 目标沙箱实例。
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {Object<string, string>} environment - 待写入的环境变量映射（就地修改）。
 * @param {Object} credentials - 本次运行的 `RunCredentials` 凭据集合。
 * @returns {void} 成功无返回值；目录创建、写配置或安装 helper 失败时抛出 `Error`。
 */
function bindWorkspaceGitEnvironment(ctx, sandbox, workspace, environment, credentials) {
  environment["GIT_TERMINAL_PROMPT"] = "0";
  try {
    EnsureControlDirectory(workspace, "runtime");
  } catch (err) {
    throw new Error(`create git runtime dir: ${err.message}`);
  }
  const runtimeHost = mcpCallHostDir(workspace);
  const runtimePath = (rel) => {
    if (sandboxDriver(sandbox) === "docker") {
      return mcpCallGuestPath(rel);
    }
    return path.join(runtimeHost, rel);
  };
  // 请求者的身份是最低优先级（系统）默认值，所以 Agent 仍可用 git config --global 或 --local 设置自己的身份。
  const identity = workspaceGitIdentity(credentials.GitUserName, credentials.GitUserEmail);
  if (identity !== "") {
    try {
      writeManagedFile(workspace, path.join(runtimeHost, "gitconfig-system"), Buffer.from(identity, "utf8"), 0o600);
    } catch (err) {
      throw new Error(`write git identity: ${err.message}`);
    }
    environment["GIT_CONFIG_SYSTEM"] = runtimePath("gitconfig-system");
    environment["GIT_CONFIG_NOSYSTEM"] = "0";
  }
  // gh 与 glab 会在配置目录里保留上一位发言者的登录信息；每轮都从空目录开始。
  for (const [key, dir] of Object.entries({ GH_CONFIG_DIR: "gh-config", GLAB_CONFIG_DIR: "glab-config" })) {
    try {
      resetControlDirectory(workspace, "runtime", dir);
    } catch (err) {
      throw new Error(`reset ${dir}: ${err.message}`);
    }
    environment[key] = runtimePath(dir);
  }
  const gateway = (environment[SessionGatewayEnv] ?? "").trim();
  const hosts = workspaceGitHosts(credentials.GitHTTPHosts);
  environment[GitHostsEnv] = hosts;
  environment["GIT_CONFIG_COUNT"] = "1";
  environment["GIT_CONFIG_KEY_0"] = "credential.helper";
  environment["GIT_CONFIG_VALUE_0"] = "";
  if (gateway === "" || hosts === "") {
    delete environment[SessionGatewayEnv];
    environment[GitHostsEnv] = "";
    return;
  }
  const hostBin = path.join(runtimeHost, "bin");
  try {
    EnsureControlDirectory(workspace, "runtime", "bin");
  } catch (err) {
    throw new Error(`create git helper dir: ${err.message}`);
  }
  try {
    installMCPCallHelperForSandbox(ctx, sandbox, workspace, path.join(hostBin, "agentflow-helper"));
  } catch (err) {
    throw new Error(`install git credential helper: ${err.message}`);
  }
  const helper = runtimePath("bin/agentflow-helper");
  for (const name of ["gh", "glab"]) {
    const script = "#!/bin/sh\nexec " + shellSingleQuote(helper) + " cli-shim " + name + " \"$@\"\n";
    try {
      writeManagedFile(workspace, path.join(hostBin, name), Buffer.from(script, "utf8"), 0o700);
    } catch (err) {
      throw new Error(`write ${name} wrapper: ${err.message}`);
    }
  }
  // 空 helper 条目会丢掉排在它之前配置的每个 helper（系统、全局、仓库），所以已存的凭据永远不会代答。
  environment["GIT_CONFIG_COUNT"] = "2";
  environment["GIT_CONFIG_KEY_0"] = "credential.helper";
  environment["GIT_CONFIG_VALUE_0"] = "";
  environment["GIT_CONFIG_KEY_1"] = "credential.helper";
  environment["GIT_CONFIG_VALUE_1"] = "!" + shellSingleQuote(helper) + " git-credential";
  environment[GitHostsEnv] = hosts;
  if (sandboxDriver(sandbox) !== "docker") {
    let base = environment["PATH"];
    if (base === undefined || base === "") {
      base = sandboxBasePath(sandbox);
    }
    environment["PATH"] = hostBin + path.delimiter + base;
  }
}

/**
 * 将 `host -> platform` 映射格式化为 `GitHostsEnv` 所需的有序 `"host=platform"` 逗号列表，
 * 自动跳过非纯 HTTPS 主机项。
 *
 * @param {Object<string, string> | null | undefined} hosts - 主机到 Git 平台类型的映射。
 * @returns {string} 排序并逗号拼接后的 `"host=platform"` 字符串。
 */
function workspaceGitHosts(hosts) {
  const pairs = [];
  for (const [host, platformRaw] of Object.entries(hosts ?? {})) {
    let scope;
    try {
      scope = HTTPSHostScope(host);
    } catch {
      continue;
    }
    if (scope !== host) {
      continue;
    }
    let platform = platformRaw;
    const [normalized, ok] = NormalizeGitPlatform(platform);
    if (!ok) {
      platform = GitPlatformOther;
    } else {
      platform = normalized;
    }
    pairs.push(host + "=" + platform);
  }
  pairs.sort();
  return pairs.join(",");
}

/**
 * 获取沙箱进程启动时的基础 `PATH`：优先取沙箱配置中的 `PATH`，否则回落到宿主进程 `PATH`。
 *
 * @param {Object} sandbox - 目标沙箱实例。
 * @returns {string} 基础 `PATH` 字符串。
 */
function sandboxBasePath(sandbox) {
  const sb = unwrapSandbox(sandbox);
  if (sb instanceof processSandbox) {
    if (sb.profile.Environment["PATH"] !== undefined && sb.profile.Environment["PATH"] !== "") {
      return sb.profile.Environment["PATH"];
    }
  } else if (sb instanceof localSandbox) {
    if (sb.environment["PATH"] !== undefined && sb.environment["PATH"] !== "") {
      return sb.environment["PATH"];
    }
  }
  return process.env.PATH ?? "";
}

/**
 * 将用户姓名与邮箱清洗并渲染为 `[user]` 段的 Git 系统级配置文件内容。
 *
 * @param {string} name - Git 用户名。
 * @param {string} email - Git 邮箱地址。
 * @returns {string} Git config 文本；姓名和邮箱均为空时返回 `""`。
 */
function workspaceGitIdentity(name, email) {
  const clean = (value) => value.replaceAll("\n", " ").replaceAll("\r", " ").replaceAll('"', "").replaceAll("\\", "");
  name = clean(name ?? "").trim();
  email = clean(email ?? "").trim();
  if (name === "" && email === "") {
    return "";
  }
  let out = "[user]\n";
  if (name !== "") {
    out += `\tname = "${name}"\n`;
  }
  if (email !== "") {
    out += `\temail = "${email}"\n`;
  }
  return out;
}

const gitAskPassScript = `#!/bin/sh
case "$1" in
  *[Uu]sername*) printf '%s\\n' "\${AGENTFLOW_GIT_USER:-private}" ;;
  *) printf '%s\\n' "\${AGENTFLOW_GIT_TOKEN-}" ;;
esac
`;

/**
 * 在工作区 `runtime` 目录下写出可执行的 `GIT_ASKPASS` 辅助脚本（权限 0o700）。
 *
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {string} filePath - 目标脚本文件绝对路径。
 * @returns {void} 成功无返回值；目录创建或写文件失败时抛出 `Error`。
 */
function writeGitAskPass(workspace, filePath) {
  try {
    EnsureControlDirectory(workspace, "runtime");
  } catch (err) {
    throw new Error(`create git askpass dir: ${err.message}`);
  }
  try {
    writeManagedFile(workspace, filePath, Buffer.from(gitAskPassScript, "utf8"), 0o700);
  } catch (err) {
    throw new Error(`write git askpass: ${err.message}`);
  }
}

module.exports = { upsertEnv, bindCommand, bindTelemetryEnvironment, CodexUserProviderArgv, PrivateHomeName, AgentCLIPrivateHomeKey, BindAgentCLICommand, privateHomePaths, bindWorkspaceGitEnvironment, workspaceGitHosts, sandboxBasePath, workspaceGitIdentity, gitAskPassScript, writeGitAskPass };
