/**
 * @file internal/runtime/mcp_provision.js
 * @description 对应 Go 源文件：internal/runtime/mcp_provision.go
 *
 * 职责与边界：
 * 负责 stdio 类型 MCP 服务的运行时准备：计算工作区相对工作目录、为进程级隔离沙箱（seatbelt/bwrap）
 * 构建私有运行前缀与启动包装脚本、落盘用户上传的 MCP 程序文件、以及在目标沙箱内按哈希标记幂等执行安装脚本。
 * 不负责 HTTP MCP 凭据绑定或脚本节点 `agentflow mcp call` 命令行包装（分别见 `mcp_credentials.js` 与 `mcp_call.js`）。
 *
 * 语法差异说明：
 * - Go 的 `error` 译为成功返回 `undefined`、失败抛出 `Error`；`(assets, []string)` 译为返回 `[assets, skipped]`。
 * - Go 的 `defer base.Close()` 译为 `try { ... } finally { base.Close(); }`。
 * - Go 的 `filepath.ToSlash` 在 JS 中通过将反斜杠替换为正斜杠对齐；`os.PathListSeparator` 对应 `path.delimiter`。
 * - Go 的 `context.Context` 对应 `AbortSignal`。
 */

"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const { ValidateRelativeFilePath, NormalizeSkillFileMode } = require("../domain/assets.js");
const { safeID } = require("./identifier.js"); // 对应 Go 同包函数，identifier.js 待翻译
const { sandboxDriver } = require("./runner.js"); // 对应 Go 同包函数，runner.js 待翻译
const { shellSingleQuote } = require("./sandbox_environment.js"); // 对应 Go 同包函数，sandbox_environment.js 待翻译
const { EnsureControlDirectory, resolveMap } = require("./materialize.js"); // 对应 Go 同包函数，materialize.js 待翻译
const { WithCommandEnvironment } = require("./remote_sandbox.js"); // 对应 Go 同包函数，remote_sandbox.js 待翻译
const { CommandSpec } = require("./runtime.js"); // 对应 Go 同包类型，runtime.js 待翻译
const { openWorkspacePath, rejectWorkspaceSymlinks, writeManagedFile } = require("./managed_files.js"); // 对应 Go 同包函数，managed_files.js 待翻译

/**
 * 返回 MCP 服务相对于工作区根目录的工作目录路径（统一使用 `/` 分隔）。
 * 返回空字符串表示直接使用工作区根目录；包含上传文件的服务默认落在 `.agentflow/mcp/<safeID>` 下。
 * 使用场景：物化配置、执行安装脚本或生成进程沙箱启动脚本时确定服务工作目录。
 *
 * @param {Object} server - `domain.MCPServerDefinition` 服务定义。
 * @returns {string} 工作区相对路径（斜杠格式），或空字符串。
 */
function MCPRuntimeWorkingDirectory(server) {
  if (server.FileRefs && server.FileRefs.length > 0) {
    let root = path.join(".agentflow", "mcp", safeID(server.ID));
    const cwd = (server.WorkingDirectory || "").trim();
    if (cwd !== "") {
      root = path.join(root, path.normalize(cwd));
    }
    return root.replace(/\\/g, "/");
  }
  const cwd = (server.WorkingDirectory || "").trim();
  if (cwd !== "") {
    return path.normalize(cwd).replace(/\\/g, "/");
  }
  return "";
}

/**
 * 判断该 MCP 服务在当前沙箱驱动下是否需要由平台托管私有进程运行环境（生成独立 PREFIX 与 launch 脚本）。
 * 仅在 `seatbelt` 或 `bwrap` 进程沙箱中、传输方式为 `stdio`（或留空）且包含上传文件或安装脚本时返回 `true`。
 * 使用场景：决定是否物化 `.agentflow/mcp-runtime/<id>/launch` 以及是否重定向命令入口。
 *
 * @param {Object} server - `domain.MCPServerDefinition` 服务定义。
 * @param {string} driver - 当前沙箱驱动名称。
 * @returns {boolean} 需要托管进程运行环境返回 `true`，否则返回 `false`。
 */
function managedMCPProcessRuntime(server, driver) {
  driver = (driver || "").trim().toLowerCase();
  const transport = (server.Transport || "").trim().toLowerCase();
  return (
    (driver === "seatbelt" || driver === "bwrap") &&
    (transport === "" || transport === "stdio") &&
    ((server.FileRefs && server.FileRefs.length > 0) || (server.InstallScript || "").trim() !== "")
  );
}

/**
 * 计算 MCP 私有运行前缀相对于工作区根目录的路径（`.agentflow/mcp-runtime/<safeID>`）。
 * 使用场景：组装 `launch` 脚本路径以及安装脚本执行的 `PREFIX` 目录。
 *
 * @param {Object} server - `domain.MCPServerDefinition` 服务定义。
 * @returns {string} 相对路径（斜杠格式）。
 */
function mcpRuntimeRootRel(server) {
  return path.join(".agentflow", "mcp-runtime", safeID(server.ID)).replace(/\\/g, "/");
}

/**
 * 构建进程沙箱内 MCP 私有运行前缀所需的全套环境变量映射，将常见包管理器（npm、pip、composer、go、cargo、gem 等）
 * 的安装目录与缓存目录全部重定向到 `prefix` 下。
 * 使用场景：在 `seatbelt`/`bwrap` 沙箱内运行 MCP 安装脚本前注入隔离环境变量。
 *
 * @param {string} prefix - MCP 私有运行前缀的绝对目录路径。
 * @returns {Record<string, string>} 重定向后的环境变量键值对映射。
 */
function mcpRuntimeEnvironment(prefix) {
  return {
    PREFIX: prefix,
    HOME: path.join(prefix, "home"),
    TMPDIR: path.join(prefix, "tmp"),
    XDG_CACHE_HOME: path.join(prefix, "cache"),
    XDG_CONFIG_HOME: path.join(prefix, "config"),
    XDG_DATA_HOME: path.join(prefix, "data"),
    NPM_CONFIG_PREFIX: prefix,
    NPM_CONFIG_CACHE: path.join(prefix, "cache", "npm"),
    COMPOSER_HOME: path.join(prefix, "composer"),
    COMPOSER_CACHE_DIR: path.join(prefix, "cache", "composer"),
    COMPOSER_BIN_DIR: path.join(prefix, "bin"),
    PYTHONUSERBASE: prefix,
    PIP_USER: "1",
    PIP_CACHE_DIR: path.join(prefix, "cache", "pip"),
    GOBIN: path.join(prefix, "bin"),
    GOPATH: path.join(prefix, "go"),
    CARGO_HOME: path.join(prefix, "cargo"),
    GEM_HOME: path.join(prefix, "gems"),
    BUNDLE_PATH: path.join(prefix, "bundle"),
    AGENTFLOW_MCP_PREFIX: prefix,
  };
}

/**
 * 返回进程沙箱中 MCP 私有命令搜索路径目录列表。用户声明的 `PathEntries` 相对于 `prefix` 解析，
 * 其余默认条目覆盖各类包管理器重定向后的可执行文件目录及工作目录下的 `node_modules/.bin`。
 * 使用场景：由 `mcpRuntimePATH` 拼接成 `PATH` 前缀，供安装脚本和 `launch` 启动器使用。
 *
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {string} prefix - MCP 私有运行前缀目录路径。
 * @param {Object} server - `domain.MCPServerDefinition` 服务定义。
 * @returns {string[]} 去重后的搜索目录路径数组。
 */
function mcpRuntimePathDirs(workspace, prefix, server) {
  const seen = {};
  const dirs = [];
  const add = (dirPath) => {
    dirPath = path.normalize(dirPath);
    if (dirPath === "" || dirPath === "." || seen[dirPath]) {
      return;
    }
    seen[dirPath] = true;
    dirs.push(dirPath);
  };
  for (const entry of server.PathEntries || []) {
    if ((entry || "").trim() === "" || path.isAbsolute(entry)) {
      continue;
    }
    add(path.join(prefix, entry.replace(/\//g, path.sep)));
  }
  for (const entry of [
    "bin",
    "sbin",
    path.join(".local", "bin"),
    path.join("home", ".local", "bin"),
    ".",
    path.join("node_modules", ".bin"),
    path.join("cargo", "bin"),
    path.join("gems", "bin"),
    path.join("venv", "bin"),
  ]) {
    if (entry === ".") {
      add(prefix);
    } else {
      add(path.join(prefix, entry));
    }
  }
  let cwd = MCPRuntimeWorkingDirectory(server);
  if (cwd === "") {
    cwd = ".";
  }
  add(path.join(workspace, cwd.replace(/\//g, path.sep), "node_modules", ".bin"));
  return dirs;
}

/**
 * 将 `mcpRuntimePathDirs` 返回的目录列表用平台路径分隔符拼成单个 `PATH` 字符串片段。
 * 使用场景：生成安装脚本和 `launch` 启动脚本中的 `PATH` 导出语句。
 *
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {string} prefix - MCP 私有运行前缀目录路径。
 * @param {Object} server - `domain.MCPServerDefinition` 服务定义。
 * @returns {string} 以系统分隔符拼接的路径字符串。
 */
function mcpRuntimePATH(workspace, prefix, server) {
  return mcpRuntimePathDirs(workspace, prefix, server).join(path.delimiter);
}

/**
 * 按目标沙箱驱动改写 MCP 服务列表副本：对于需要托管进程运行环境的服务，将其命令替换为
 * `.agentflow/mcp-runtime/<safeID>/launch` 并清空原参数、工作目录与文件引用列表。
 * 使用场景：在生成客户端 MCP 配置（`materialize.js`）或脚本 `mcp-servers.json`（`mcp_call.js`）前适配运行入口。
 *
 * @param {Object[]} servers - `domain.MCPServerDefinition` 列表。
 * @param {string} driver - 目标沙箱驱动名称。
 * @returns {Object[]} 适配后的 MCP 服务定义新数组。
 */
function prepareMCPServersForDriver(servers, driver) {
  const out = (servers || []).map((s) => ({ ...s }));
  for (let i = 0; i < out.length; i++) {
    if (!managedMCPProcessRuntime(out[i], driver)) {
      continue;
    }
    out[i].Command = path.join(mcpRuntimeRootRel(out[i]), "launch").replace(/\\/g, "/");
    out[i].Args = null;
    out[i].WorkingDirectory = "";
    out[i].FileRefs = null;
  }
  return out;
}

/**
 * 在非隔离的 `local` 沙箱下剔除包含安装脚本的 stdio MCP 服务（安装脚本要求 docker、bwrap 或 seatbelt），
 * 并返回被跳过的服务名称列表。
 * 使用场景：工作区终端等仅提供可选工具的入口调用此函数保持终端可用；工作流节点则不调用它以显式报错。
 *
 * @param {Object | null} sandbox - 目标沙箱实例。
 * @param {Object} assets - `domain.AgentAssetBundle` 资产集合。
 * @returns {[Object, string[] | null]} 二元组 `[outAssets, skipped]`：若沙箱已隔离则原样返回 `[assets, null]`，否则返回过滤后的资产副本及被跳过的服务名数组。
 */
function WithoutUnprovisionableMCP(sandbox, assets) {
  if (sandbox != null && sandboxDriver(sandbox) !== "local") {
    return [assets, null];
  }
  const skipped = [];
  const kept = [];
  for (const server of assets.MCPServers || []) {
    const transport = (server.Transport || "").trim();
    const stdio = transport.toLowerCase() === "stdio" || transport === "";
    if (stdio && (server.InstallScript || "").trim() !== "") {
      skipped.push(server.Name);
      continue;
    }
    kept.push(server);
  }
  const outAssets = { ...assets, MCPServers: kept };
  return [outAssets, skipped];
}

/**
 * 将用户上传的 stdio MCP 程序文件物化到工作区，并在选定沙箱内幂等执行其安装脚本。
 * 完成标记与沙箱实例绑定：复用的 Run 容器只安装一次，而新建的 Runner 任务容器不会误复用宿主工作区标记。
 * 使用场景：工作流节点或会话启动前准备全部 stdio MCP 运行依赖。
 *
 * @param {AbortSignal} ctx - 取消信号（对应 Go `context.Context`）。
 * @param {Object | null} sandbox - 目标沙箱实例。
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {Object} assets - `domain.AgentAssetBundle` 资产集合（含 `MCPServers` 与 `MCPFiles`）。
 * @param {Object | null} sink - 运行事件输出接收器（`EventSink`）。
 * @returns {void} 无返回值；服务 ID 非法、文件落盘失败、沙箱不支持安装脚本或安装命令执行失败时抛出 `Error`。
 */
function ProvisionMCPAssets(ctx, sandbox, workspace, assets, sink) {
  for (const server of assets.MCPServers || []) {
    const transport = (server.Transport || "").trim();
    if (transport.toLowerCase() !== "stdio" && transport !== "") {
      continue;
    }
    const serverID = safeID(server.ID);
    if (serverID === "") {
      throw new Error(`MCP server id ${JSON.stringify(server.ID)} cannot be used as a runtime path`);
    }
    const serverFiles = (assets.MCPFiles && assets.MCPFiles[server.ID]) || null;
    const hash = mcpProvisionHash(server, serverFiles);
    materializeMCPFiles(workspace, server, serverID, serverFiles, hash);
    if (managedMCPProcessRuntime(server, sandboxDriver(sandbox))) {
      prepareMCPProcessRuntime(workspace, server);
    }
    const script = (server.InstallScript || "").trim();
    if (script === "") {
      continue;
    }
    if (sandbox == null || sandboxDriver(sandbox) === "local") {
      throw new Error(`MCP ${server.Name} 安装脚本要求使用 docker、bwrap 或 seatbelt 隔离沙箱`);
    }
    let cwd = MCPRuntimeWorkingDirectory(server);
    if (cwd === "") {
      cwd = ".";
    }
    let marker = path.join(".agentflow", "runtime", "mcp-provision", serverID + "-" + hash + "-" + safeID(sandbox.ID()) + ".done").replace(/\\/g, "/");
    if (sandboxDriver(sandbox) === "docker") {
      marker = "/tmp/agentflow-mcp-provision/" + serverID + "-" + hash + ".done";
    }
    let command = "if [ -f " + shellSingleQuote(marker) + " ]; then exit 0; fi\n";
    const environment = resolveMap(server.Environment);
    if (managedMCPProcessRuntime(server, sandboxDriver(sandbox))) {
      const prefix = path.join(workspace, mcpRuntimeRootRel(server).replace(/\//g, path.sep));
      for (const [key, value] of Object.entries(mcpRuntimeEnvironment(prefix))) {
        environment[key] = value;
      }
      command += "PATH=" + shellSingleQuote(mcpRuntimePATH(workspace, prefix, server)) + ":\"$PATH\"\nexport PATH\n";
    }
    command +=
      "cd " + shellSingleQuote(cwd) + "\n" +
      "sh -c " + shellSingleQuote(script) + "\n" +
      "mkdir -p " + shellSingleQuote(path.dirname(marker).replace(/\\/g, "/")) + "\n" +
      "touch " + shellSingleQuote(marker);
    const spec = WithCommandEnvironment(new CommandSpec({ Argv: ["sh", "-lc", command], Provider: "mcp-provision" }), environment);
    try {
      sandbox.Exec(ctx, spec, sink);
    } catch (err) {
      throw new Error(`provision MCP ${server.Name}: ${err.message}`, { cause: err });
    }
  }
}

/**
 * 为托管进程运行环境的 MCP 服务创建私有目录结构并写入可执行的 `launch` 启动包装脚本。
 * `launch` 会在启动目标命令前设置隔离的 `PREFIX`/`HOME`/包管理器环境变量、前置私有 `PATH` 并切换到工作目录。
 * 使用场景：在 `seatbelt` 或 `bwrap` 沙箱执行 `ProvisionMCPAssets` 时调用。
 *
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {Object} server - `domain.MCPServerDefinition` 服务定义。
 * @returns {void} 无返回值；创建目录或写入启动脚本失败时抛出 `Error`。
 */
function prepareMCPProcessRuntime(workspace, server) {
  const root = EnsureControlDirectory(workspace, "mcp-runtime", safeID(server.ID));
  for (const dir of ["bin", "home", "tmp", "cache", "config", "data"]) {
    EnsureControlDirectory(workspace, "mcp-runtime", safeID(server.ID), dir);
  }
  let cwd = MCPRuntimeWorkingDirectory(server);
  if (cwd === "") {
    cwd = ".";
  }
  let b = "";
  b += "#!/bin/sh\nset -e\n";
  b += "PREFIX=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\n";
  b += "WORKSPACE=$(CDPATH= cd -- \"$PREFIX/../../..\" && pwd)\n";
  b += "export PREFIX AGENTFLOW_MCP_PREFIX=\"$PREFIX\"\n";
  b += "export HOME=\"$PREFIX/home\" TMPDIR=\"$PREFIX/tmp\"\n";
  b += "export XDG_CACHE_HOME=\"$PREFIX/cache\" XDG_CONFIG_HOME=\"$PREFIX/config\" XDG_DATA_HOME=\"$PREFIX/data\"\n";
  b += "export NPM_CONFIG_PREFIX=\"$PREFIX\" NPM_CONFIG_CACHE=\"$PREFIX/cache/npm\"\n";
  b += "export COMPOSER_HOME=\"$PREFIX/composer\" COMPOSER_CACHE_DIR=\"$PREFIX/cache/composer\" COMPOSER_BIN_DIR=\"$PREFIX/bin\"\n";
  b += "export PYTHONUSERBASE=\"$PREFIX\" PIP_USER=1 PIP_CACHE_DIR=\"$PREFIX/cache/pip\"\n";
  b += "export GOBIN=\"$PREFIX/bin\" GOPATH=\"$PREFIX/go\" CARGO_HOME=\"$PREFIX/cargo\" GEM_HOME=\"$PREFIX/gems\" BUNDLE_PATH=\"$PREFIX/bundle\"\n";
  b += "PATH=" + shellSingleQuote(mcpRuntimePATH(workspace, root, server)) + ":\"$PATH\"\nexport PATH\n";
  b += "cd \"$WORKSPACE\"/" + shellSingleQuote(cwd.replace(/\\/g, "/")) + "\n";
  b += "exec " + shellSingleQuote(server.Command);
  for (const arg of server.Args || []) {
    b += " " + shellSingleQuote(arg);
  }
  b += "\n";
  writeManagedFile(workspace, path.join(root, "launch"), Buffer.from(b), 0o700);
}

/**
 * 将上传的 MCP 程序文件安全写入 `.agentflow/mcp/<serverID>`，并通过 `.sha256` 状态文件避免重复覆盖。
 * 写入前会校验全部相对路径、拒绝工作区符号链接并清理旧目录。
 * 使用场景：由 `ProvisionMCPAssets` 在执行安装脚本前调用。
 *
 * @param {string} workspace - 宿主工作区目录路径。
 * @param {Object} server - `domain.MCPServerDefinition` 服务定义。
 * @param {string} serverID - 经 `safeID` 规范化后的服务目录名。
 * @param {Record<string, Buffer | Uint8Array> | null} files - 按相对路径索引的上传文件内容映射。
 * @param {string} hash - 本次物化内容的 SHA-256 摘要前缀。
 * @returns {void} 无返回值；路径非法、缺少文件、命中符号链接或文件读写失败时抛出 `Error`。
 */
function materializeMCPFiles(workspace, server, serverID, files, hash) {
  if (!server.FileRefs || server.FileRefs.length === 0) {
    return;
  }
  if (serverID === "" || safeID(serverID) !== serverID) {
    throw new Error(`invalid MCP runtime id ${JSON.stringify(serverID)}`);
  }
  for (const ref of server.FileRefs) {
    ValidateRelativeFilePath(ref.Path);
    if (!files || !Object.prototype.hasOwnProperty.call(files, ref.Path)) {
      throw new Error(`MCP ${server.ID} missing uploaded file ${ref.Path}`);
    }
  }
  const target = path.join(workspace, ".agentflow", "mcp", serverID);
  const [base, root] = openWorkspacePath(workspace, target);
  try {
    const state = path.join(".agentflow", "runtime", "mcp-sources", serverID + ".sha256");
    rejectWorkspaceSymlinks(base, state);
    let raw = null;
    let readErr = null;
    try {
      raw = base.ReadFile(state);
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        throw err;
      }
      readErr = err;
    }
    if (readErr == null && String(raw).trim() === hash) {
      return;
    }
    base.RemoveAll(root);
    base.MkdirAll(root, 0o700);
    for (const ref of server.FileRefs) {
      const name = path.join(root, ref.Path.replace(/\//g, path.sep));
      base.MkdirAll(path.dirname(name), 0o755);
      writeManagedFile(workspace, path.join(workspace, name), files[ref.Path], NormalizeSkillFileMode(ref.Mode));
    }
    base.MkdirAll(path.dirname(state), 0o700);
    writeManagedFile(workspace, path.join(workspace, state), Buffer.from(hash + "\n"), 0o600);
  } finally {
    base.Close();
  }
}

/**
 * 基于安装脚本、工作目录、路径条目及排序后的上传文件内容计算 16 位十六进制 SHA-256 摘要，
 * 用于判断 MCP 源码物化与安装脚本是否需要重新执行。
 * 使用场景：由 `ProvisionMCPAssets` 生成物化状态哈希与安装完成标记文件名。
 *
 * @param {Object} server - `domain.MCPServerDefinition` 服务定义。
 * @param {Record<string, Buffer | Uint8Array> | null} files - 上传文件内容映射。
 * @returns {string} 16 字符长度的小写十六进制哈希串。
 */
function mcpProvisionHash(server, files) {
  const h = crypto.createHash("sha256");
  h.update("mcp-process-runtime-v1");
  h.update(server.InstallScript || "");
  h.update(Buffer.from([0]));
  h.update(server.WorkingDirectory || "");
  for (const entry of server.PathEntries || []) {
    h.update(Buffer.from([0]));
    h.update(entry);
  }
  const paths = files ? Object.keys(files).sort() : [];
  for (const name of paths) {
    h.update(Buffer.from([0]));
    h.update(name);
    h.update(Buffer.from([0]));
    h.update(files[name]);
  }
  return h.digest("hex").slice(0, 16);
}

module.exports = {
  MCPRuntimeWorkingDirectory,
  WithoutUnprovisionableMCP,
  ProvisionMCPAssets,
  managedMCPProcessRuntime,
  prepareMCPServersForDriver,
};
