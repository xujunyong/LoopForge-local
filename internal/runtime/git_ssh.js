// git_ssh.js —— 对应 Go 文件：internal/runtime/git_ssh.go
// 作用：把请求者的 Git SSH 身份绑定给单个命令、工作区 CLI 或单个交互终端。
// Go 的 (值, error) 译为成功返回值、失败 throw；context.Context 译为 AbortSignal；os.RemoveAll 译为带 force 的 rmSync，清理路径上忽略错误。

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { AllowedProtocols } = require("../gitwork/remote.js"); // 对应 Go 的 gitwork.AllowedProtocols，remote.js 待翻译
const { StartSSH, StartSSHHosts } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork.StartSSH/StartSSHHosts，ssh.js 待翻译
const { EnsureControlDirectory } = require("./materialize.js"); // 对应 Go 同包函数，materialize.js 待翻译
const { sandboxDriver } = require("./runner.js"); // 对应 Go 同包函数，runner.js 待翻译
const { BindGit, BindGitWorkspace } = require("./runtime.js"); // 对应 Go 同包常量，runtime.js 待翻译

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

function bindCommandGitSSH(ctx, sandbox, workspace, command, credentials) {
  if ((command.CredentialBindings ?? []).includes(BindGitWorkspace)) {
    return bindWorkspaceGitSSH(ctx, sandbox, path.normalize(workspace), command.environment, credentials.GitSSHHostKeys);
  }
  if (!(command.CredentialBindings ?? []).includes(BindGit)) {
    return () => {};
  }
  return BindGitSSH(ctx, sandbox, path.normalize(workspace), command.environment, credentials.GitSSHKeys);
}

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

function shellSingleQuoted(value) {
  // Go 的 strings.NewReplacer 单遍替换：逐字匹配，先匹配者胜，替换结果不再重扫。
  return `"` + value.replace(/["`$\\']/g, (ch) => (ch === `"` || ch === "`" ? "'" : "")) + `"`;
}

const terminalGitSSHUnavailable = `sh -c 'echo "当前工作区环境无法把个人 Git SSH 密钥只开放给这个终端，终端内不能直接用 SSH 访问仓库；请使用平台的提交/推送" >&2; exit 1' --`;

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
  let root;
  try {
    root = fs.mkdtempSync(path.join("/tmp", "lf-term-ssh-"));
  } catch (err) {
    throw err;
  }
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
