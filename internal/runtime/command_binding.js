// command_binding.js —— 对应 Go 文件：internal/runtime/command_binding.go
// 作用：给子命令绑定凭据与环境：清空宿主凭据、按绑定写入密钥、配置私有 HOME 与遥测。
// Go 的 (值, error) 译为成功返回值、失败 throw；结构体按值复制译为对象浅复制。

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
      try {
        EnsureControlDirectory(workspace, "private-home", provider, dir);
      } catch (err) {
        throw err;
      }
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
          bound.environment[envName] = credentials.Extra[credName];
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
        const [argv, env] = ApplyAgentCLICredential(command.Provider, credentials.AgentCLI[command.Provider], command.AgentCLI, home, homeEnv, bound.Argv);
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

// bindTelemetryEnvironment：把子 CLI 的 OpenTelemetry 导出器指向 AgentFlow 采集器，
// 并用 run 与节点给 span 打标签。telemetry 为空时环境保持不动。
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

// CodexUserProviderArgv：在最后的 argv 元素（提示词）之前插入专用的 "agentflow_user"
// 模型供应商。baseURL 为空时回退到 OpenAI API。密钥留在进程环境里作 CODEX_API_KEY；
// argv 里只写变量名，专用供应商可防止回退到宿主登录。输入切片不修改。
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

// PrivateHomeName：PrivateHome 命令以 HOME 运行的 .agentflow/private-home 下的目录。
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

// AgentCLIPrivateHomeKey：Agent CLI 调用的 PrivateHomeKey：每个 CLI 与 Agent 一个 HOME，
// 这样并发的 Agent 各自保有 MCP 配置与会话。
function AgentCLIPrivateHomeKey(kind, agentID) {
  return safeID(kind + "-" + agentID);
}

// BindAgentCLICommand：Runner 侧的 BindAgentCLI：把 Agent CLI 的配置渲染进命令的私有 HOME，
// 返回运行它用的 argv 与环境（包含 HOME 与 TMPDIR）。Agent CLI 始终在该 HOME 里运行，
// 无论是否沙箱化，因为 MCP 配置就在那里。
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

// privateHomePaths：返回 PrivateHome 命令在宿主上的 HOME 与进程看到的 HOME。
function privateHomePaths(sandbox, workspace, command) {
  const name = PrivateHomeName(command);
  const host = path.join(workspace, ".agentflow", "private-home", name);
  if (sandboxDriver(sandbox) === "docker") {
    return [host, path.join("/workspace", ".agentflow", "private-home", name).split(path.sep).join("/")];
  }
  return [host, host];
}

// bindWorkspaceGitEnvironment：安装标准宿主级 helper。
// 它通过实时中继请求凭据，而不是写 token。
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

// workspaceGitHosts：把 host→platform 渲染为 GitHostsEnv 的有序 "host=platform" 列表，
// 跳过任何不是纯 HTTPS host 的项。
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

// sandboxBasePath：沙箱内进程启动时的 PATH：配置里的（带有已激活环境的工具）或宿主的。
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
