// git_ssh.js —— 对应 Go 文件：internal/runtime/git_ssh.go
// 作用与职责边界：将请求者的 Git SSH 密钥通过临时 SSH Agent 绑定到单次命令、工作区 CLI 或单个交互终端，并按沙箱隔离能力控制套接字目录权限与回退提示。
// 语法差异说明：
// - Go 的 (func(), error) 译为成功返回清理闭包、失败 throw；context.Context 译为 AbortSignal；
// - os.RemoveAll 译为带 recursive 与 force 选项的 fs.rmSync，清理路径上按 Go 原文忽略错误。

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { AllowedProtocols } = require("../gitwork/remote.js"); // 对应 Go 的 gitwork.AllowedProtocols，remote.js 待翻译
const { StartSSH, StartSSHHosts } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork.StartSSH/StartSSHHosts，ssh.js 待翻译
const { EnsureControlDirectory } = require("./materialize.js"); // 对应 Go 同包函数，materialize.js 待翻译
const { sandboxDriver } = require("./runner.js"); // 对应 Go 同包函数，runner.js 待翻译
const { BindGit, BindGitWorkspace } = require("./runtime.js"); // 对应 Go 同包常量，runtime.js 待翻译

/**
 * 为单次命令启动短期 SSH Agent 并将配置与套接字写入工作区控制目录，仅在命令执行期间有效。
 *
 * @param {AbortSignal|null} ctx 上下文取消信号。
 * @param {Object} sandbox 沙箱实例，用于判断是否运行在 Docker 容器中。
 * @param {string} workspace 工作区根目录路径。
 * @param {Object<string, string>} environment 待注入 GIT_ALLOW_PROTOCOL 及 SSH 变量的命令环境变量映射。
 * @param {Object<string, string>} keys 请求者的 Git SSH 密钥映射。
 * @returns {() => void} 停止并清理 SSH Agent 的回调函数；无密钥时返回空操作函数。
 */
function BindGitSSH(ctx, sandbox, workspace, environment, keys) {
  if (Object.keys(keys ?? {}).length === 0) {
    return () => {};
  }
  const root = EnsureControlDirectory(workspace, "runtime");
  let clientRoot = "";
  if (sandboxDriver(sandbox) === "docker") {
    clientRoot = "/workspace/.agentflow/runtime";
  }
  environment["GIT_ALLOW_PROTOCOL"] = AllowedProtocols;
  return StartSSH(ctx, environment, keys, root, clientRoot);
}

/**
 * 根据命令声明的凭据绑定类型（工作区级或单命令级），将对应的 Git SSH 密钥绑定到命令环境中。
 *
 * @param {AbortSignal|null} ctx 上下文取消信号。
 * @param {Object} sandbox 沙箱实例。
 * @param {string} workspace 工作区根目录路径。
 * @param {Object} command 命令规格对象（含 CredentialBindings 与 environment）。
 * @param {Object} credentials 本次运行的凭据集合（含 GitSSHHostKeys 与 GitSSHKeys）。
 * @returns {() => void} 清理 SSH Agent 的回调函数。
 */
function bindCommandGitSSH(ctx, sandbox, workspace, command, credentials) {
  if ((command.CredentialBindings ?? []).includes(BindGitWorkspace)) {
    return bindWorkspaceGitSSH(ctx, sandbox, path.normalize(workspace), command.environment, credentials.GitSSHHostKeys);
  }
  if (!(command.CredentialBindings ?? []).includes(BindGit)) {
    return () => {};
  }
  return BindGitSSH(ctx, sandbox, path.normalize(workspace), command.environment, credentials.GitSSHKeys);
}

/**
 * 为工作区 CLI 启动按主机配置的 SSH Agent；若启动失败（如主机未配置 known_hosts），则设置 GIT_SSH_COMMAND 输出中文错误提示而不阻断 HTTPS 令牌访问。
 *
 * @param {AbortSignal|null} ctx 上下文取消信号。
 * @param {Object} sandbox 沙箱实例。
 * @param {string} workspace 工作区根目录路径。
 * @param {Object<string, string>} environment 命令环境变量映射。
 * @param {Object<string, string>} keys 按主机映射的 SSH 密钥集合。
 * @returns {() => void} 清理 SSH Agent 的回调函数；无密钥或启动失败时返回空操作函数。
 */
function bindWorkspaceGitSSH(ctx, sandbox, workspace, environment, keys) {
  if (Object.keys(keys ?? {}).length === 0) {
    return () => {};
  }
  const root = EnsureControlDirectory(workspace, "runtime");
  let clientRoot = "";
  if (sandboxDriver(sandbox) === "docker") {
    clientRoot = "/workspace/.agentflow/runtime";
  }
  environment["GIT_ALLOW_PROTOCOL"] = AllowedProtocols;
  try {
    return StartSSHHosts(ctx, environment, keys, root, clientRoot);
  } catch (err) {
    environment["GIT_SSH_VARIANT"] = "ssh";
    environment["GIT_SSH_COMMAND"] = "sh -c 'echo " + shellSingleQuoted("个人 Git SSH 密钥不可用：" + err.message + "；可改用 HTTPS 地址（使用个人 Git Token）") + " >&2; exit 1' --";
    return () => {};
  }
}

/**
 * 将提示文本转义并包裹为双引号字符串，安全嵌入 `sh -c '...'` 内的 `echo` 参数中（单遍替换避免二次扫描）。
 *
 * @param {string} value 原始提示文本。
 * @returns {string} 转义并加上双引号后的安全字符串。
 */
function shellSingleQuoted(value) {
  // Go 的 strings.NewReplacer 单遍替换：逐字匹配，先匹配者胜，替换结果不再重扫。
  return `"` + value.replace(/["`$\\']/g, (ch) => (ch === `"` || ch === "`" ? "'" : "")) + `"`;
}

const terminalGitSSHUnavailable = `sh -c 'echo "当前工作区环境无法把个人 Git SSH 密钥只开放给这个终端，终端内不能直接用 SSH 访问仓库；请使用平台的提交/推送" >&2; exit 1' --`;

/**
 * 为单个交互终端绑定请求者的 Git SSH 身份：仅在 `bwrap` 或 `local` 沙箱下于 `/tmp` 创建 0700 独立临时目录承载 Agent 套接字（`bwrap` 额外私有挂载），其他共享文件系统的沙箱则注入不可用提示。
 *
 * @param {AbortSignal|null} ctx 上下文取消信号。
 * @param {Object} sandbox 沙箱实例。
 * @param {Object} command 交互终端命令规格对象（将更新其 environment 与 privateBinds）。
 * @param {Object<string, string>} keys 请求者的 Git SSH 密钥映射。
 * @returns {() => void} 停止 SSH Agent 并删除临时目录的清理闭包。
 */
function BindTerminalGitSSH(ctx, sandbox, command, keys) {
  if (Object.keys(keys ?? {}).length === 0) {
    return () => {};
  }
  if (command.environment == null) {
    command.environment = {};
  }
  command.environment["GIT_ALLOW_PROTOCOL"] = AllowedProtocols;
  const driver = sandboxDriver(sandbox);
  if (driver !== "bwrap" && driver !== "local") {
    command.environment["GIT_SSH_VARIANT"] = "ssh";
    command.environment["GIT_SSH_COMMAND"] = terminalGitSSHUnavailable;
    return () => {};
  }
  const root = fs.mkdtempSync(path.join("/tmp", "lf-term-ssh-"));
  try {
    fs.chmodSync(root, 0o700);
  } catch (err) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Go 的 os.RemoveAll 在此处忽略错误。
    }
    throw err;
  }
  let stop;
  try {
    stop = StartSSH(ctx, command.environment, keys, root, "");
  } catch (err) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Go 的 os.RemoveAll 在此处忽略错误。
    }
    throw err;
  }
  if (driver === "bwrap") {
    command.privateBinds = [...(command.privateBinds ?? []), root];
  }
  return () => {
    stop();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Go 的 os.RemoveAll 在清理闭包里忽略错误。
    }
  };
}

module.exports = { BindGitSSH, bindCommandGitSSH, bindWorkspaceGitSSH, shellSingleQuoted, terminalGitSSHUnavailable, BindTerminalGitSSH };
