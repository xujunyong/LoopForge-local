// managed_cli.js —— 对应 Go 文件：internal/runtime/managed_cli.go
//
// 文件作用与职责边界：
// 为平台侧本地/seatbelt/bwrap 沙箱工作流运行解析并固定受管 CLI 可执行文件（含环境变量显式覆盖与
// managedcli 清单租约占用），并在 bwrap 私有 `/tmp` 隔离模式下识别需要只读绑定回挂的托管安装目录。
//
// Go 与 JS 语法差异说明：
// - Go 的 `(string, *managedcli.ClaimLease, error)` 译为成功返回 `[binary, lease]`、失败 `throw Error`；
// - Go 的 `filepath.EvalSymlinks` 译为 `fs.realpathSync`；`slices.Clone` 译为数组浅拷贝 `[...arr]`；
// - 与 `conversation_process.js` 存在同包循环引用，按约定在函数体内延迟 `require("./conversation_process.js")`。

"use strict";

const fs = require("node:fs"); // 对应 Go 标准库 os / filepath.EvalSymlinks
const path = require("node:path"); // 对应 Go 标准库 path/filepath

const managedcli = require("../managedcli/index.js"); // 对应 Go 包 agentflow/internal/managedcli
const { fileIsExecutable } = require("./claude_install.js"); // 对应 Go 同包函数

/**
 * 读取指定 provider 对应的环境变量二进制覆盖路径（如 `AGENTFLOW_<PROVIDER>_BIN`，`claude-code` 特例为
 * `AGENTFLOW_CLAUDE_BIN`），仅当目标文件存在且可执行时返回该路径。
 *
 * @param {string} provider 执行器 provider 标识（如 `"claude-code"`、`"codex"`、`"codebuddy"`）。
 * @returns {string} 有效的显式可执行文件路径；未配置或不可执行时返回空字符串。
 */
function explicitNativeCLIPath(provider) {
  let override = "AGENTFLOW_" + provider.replaceAll("-", "_").toUpperCase() + "_BIN";
  if (provider === "claude-code") {
    override = "AGENTFLOW_CLAUDE_BIN";
  }
  const binary = (process.env[override] ?? "").trim();
  if (binary !== "" && fileIsExecutable(binary)) {
    return binary;
  }
  return "";
}

/**
 * 为平台侧执行的工作流运行固定宿主机受管 CLI 可执行文件并返回租约（仅适用于 `local`、`seatbelt`、`bwrap` 驱动；
 * Docker 沙箱与远端 runner 各自在其执行机上解析 CLI）。
 *
 * @param {AbortSignal | null} ctx 用于取消租约申请的上下文信号。
 * @param {string} driver 沙箱驱动名称。
 * @param {string} runID 当前工作流运行 ID（非空时按 `"platform:<runID>"` 固定清单版本）。
 * @param {{ Kind?: string, Binary?: string }} executor 执行器定义对象（`domain.ExecutorDefinition`）。
 * @returns {[string, Object | null]} 成功返回 `[binaryPath, claimLease]`；不适用或未命中时返回 `["", null]`，申请或读取清单失败时抛出 `Error`。
 */
function pinNativeExecutorCLI(ctx, driver, runID, executor) {
  switch (driver) {
    case "local":
    case "seatbelt":
    case "bwrap":
      break;
    default:
      return ["", null];
  }
  const root = (process.env.AGENTFLOW_MANAGED_CLI_ROOT ?? "").trim();
  const kind = (executor.Kind ?? "").trim();
  if (root === "" || !managedcli.Supports(kind)) {
    return ["", null];
  }
  // 延迟加载以打破 managed_cli.js <-> conversation_process.js 的同包循环依赖。
  const { conversationBinary } = require("./conversation_process.js");
  const binary = (executor.Binary ?? "").trim();
  if (binary !== "" && binary !== conversationBinary(kind)) {
    return ["", null];
  }
  const explicitPath = explicitNativeCLIPath(kind);
  if (explicitPath !== "") {
    return [explicitPath, null];
  }
  let lease;
  try {
    lease = managedcli.BeginClaim(ctx, root);
  } catch (err) {
    throw new Error(`managed CLI usage for ${kind}: ${err.message}`, { cause: err });
  }
  let inventory;
  try {
    runID = (runID ?? "").trim();
    if (runID !== "") {
      inventory = managedcli.PinInventory(root, "platform:" + runID);
    } else {
      inventory = managedcli.ReadInventory(root);
    }
  } catch (err) {
    lease.Close();
    throw new Error(`managed CLI inventory for ${kind}: ${err.message}`, { cause: err });
  }
  const [resolvedBinary, ok] = inventory.BinaryFor(kind);
  if (ok) {
    return [resolvedBinary, lease];
  }
  lease.Close();
  return ["", null];
}

/**
 * 针对 `bwrap` 覆盖私有 `/tmp` 的场景，校验命令首参数是否位于 `AGENTFLOW_MANAGED_CLI_ROOT` 对应的受管安装目录下：
 * 必要时将根目录符号链接前缀解析进 `Argv[0]`（保持 npm bin 符号链接本身不变），
 * 并在安装目录位于 `/tmp` 下时记录 `managedCLIInstall` 供 bwrap 以只读 bind 方式恢复可见性。
 *
 * @param {Object} command 待执行的命令规格对象（`CommandSpec`）。
 * @param {string} driver 沙箱驱动名称。
 * @returns {Object} 处理后的命令规格对象（不满足条件时原样返回）。
 */
function withBwrapManagedCLI(command, driver) {
  if (
    driver !== "bwrap" ||
    !managedcli.Supports(command.Provider) ||
    (command.Argv ?? []).length === 0 ||
    !path.isAbsolute(command.Argv[0])
  ) {
    return command;
  }
  const root = (process.env.AGENTFLOW_MANAGED_CLI_ROOT ?? "").trim();
  if (!path.isAbsolute(root) || path.normalize(root) !== root || root === "/") {
    return command;
  }
  const base = path.join(root, "providers", command.Provider);
  const relative = path.relative(base, command.Argv[0]);
  const relativeIsLocal =
    relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep);
  if (relative === "." || !relativeIsLocal) {
    return command;
  }
  let resolvedRoot;
  try {
    resolvedRoot = fs.realpathSync(root);
  } catch {
    return command;
  }
  const sepIdx = relative.indexOf(path.sep);
  const releaseDir = sepIdx >= 0 ? relative.slice(0, sepIdx) : relative;
  const providerDir = path.join(resolvedRoot, "providers", command.Provider);
  const install = path.join(providerDir, releaseDir);
  let binary;
  try {
    binary = fs.realpathSync(command.Argv[0]);
  } catch {
    return command;
  }
  const resolvedRelative = path.relative(install, binary);
  const resolvedIsLocal =
    resolvedRelative !== "" &&
    !path.isAbsolute(resolvedRelative) &&
    resolvedRelative !== ".." &&
    !resolvedRelative.startsWith(".." + path.sep);
  if (!resolvedIsLocal) {
    return command;
  }
  // 对应 Go 值传递拷贝：不直接改写调用方传入对象的引用。
  const out = { ...command };
  // `/tmp` 下的符号链接祖先目录即使目标可见也可能被遮蔽；解析根前缀同时保留 npm bin 符号链接。
  const resolvedArgv0 = path.join(providerDir, relative);
  if (resolvedArgv0 !== out.Argv[0]) {
    out.Argv = [...out.Argv];
    out.Argv[0] = resolvedArgv0;
  }
  try {
    const privateTmp = fs.realpathSync("/tmp");
    if (install.startsWith(privateTmp + path.sep)) {
      out.managedCLIInstall = install;
    }
  } catch {
    // 无法解析 /tmp 时按 Go 原文忽略。
  }
  return out;
}

module.exports = {
  explicitNativeCLIPath,
  pinNativeExecutorCLI,
  withBwrapManagedCLI,
};
