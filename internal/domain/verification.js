/**
 * @file internal/domain/verification.js
 * @description 对应 Go 文件：internal/domain/verification.go
 * 职责与边界：校验工作流核查门（VerificationGate）的模式与执行范围，判定命令是否依赖 Git 仓库检出，
 * 并将未声明 `ExecutionScope` 的历史核查门拆分为 `run` 范围交付门与 `repositories` 范围 Git 检查门。
 * 语法差异说明：
 * - Go 集合 `map[string]bool` 译为普通对象 `{}`（已使用 ID 记为 `true`）。
 * - Go 多返回值 `(runCmds, repoCmds)` 译为二元组 `[runCmds, repoCmds]`；`error` 返回译为成功无返回值、失败 `throw Error`。
 */

"use strict";

const { ExecutionScopeRun, ExecutionScopeRepositories } = require("./observability.js");

/**
 * 判断核查门配置中是否至少包含一条非空白命令。
 * 供本文件内部模式推断与合法性校验调用。
 * @param {Object} gate - `VerificationGate` 核查门对象。
 * @returns {boolean} 存在非空白命令时返回 `true`，否则返回 `false`。
 */
function commandHasContent(gate) {
  for (const command of gate.Commands ?? []) {
    if (command.trim() !== "") {
      return true;
    }
  }
  return false;
}

/**
 * 解析核查门的实际模式：当 `Mode` 为空且配置了有效命令时，默认视作 `"command"` 模式。
 * 供 `ValidateVerificationGate` 内部调用。
 * @param {Object} gate - `VerificationGate` 核查门对象。
 * @returns {string} 归一化为小写的核查门模式字符串。
 */
function gateMode(gate) {
  const mode = gate.Mode.trim().toLowerCase();
  if (mode === "" && commandHasContent(gate)) {
    return "command";
  }
  return mode;
}

/**
 * 判断单条核查门命令是否检查或修改 Git 仓库检出，从而应归入 `executionScope=repositories` 执行。
 * 在校验或拆分历史核查门命令时调用。
 * @param {string} command - 单条 shell 命令文本。
 * @returns {boolean} 命令涉及 `git` 调用或 `.git/` 目录时返回 `true`，否则返回 `false`。
 */
function CommandNeedsRepository(command) {
  let cmd = command.trim();
  if (cmd.startsWith("set -e")) {
    cmd = cmd.slice("set -e".length).trim();
  }
  if (cmd === "") {
    return false;
  }
  return cmd.includes("git ") || cmd.includes("git\t") || cmd.includes(".git/") || cmd.includes("$(git");
}

/**
 * 重写归入仓库范围执行的命令中对运行根目录（`.agentflow/` 及标准报告文件）的相对路径引用，
 * 使其在各个子仓库目录执行时仍能通过 `$AGENTFLOW_WORKSPACE/...` 正确解析。
 * 供 `partitionGateCommands` 内部调用。
 * @param {string} command - 待重写的仓库范围 shell 命令。
 * @returns {string} 完成运行根目录路径重写后的命令字符串。
 */
function rewriteRepositoryWorkspaceRefs(command) {
  let out = command;
  if (out.includes(".agentflow/") && !out.includes("$AGENTFLOW_WORKSPACE/.agentflow/") && !out.includes("${AGENTFLOW_WORKSPACE}/.agentflow/")) {
    out = out.replaceAll(".agentflow/", "$AGENTFLOW_WORKSPACE/.agentflow/");
  }
  if (out.includes("git ") || out.includes("git\t")) {
    for (const name of ["change-report.md", "fix-report.md", "e2e-cases.md"]) {
      if (out.includes(":!" + name) || out.includes(":(exclude)" + name)) {
        continue;
      }
      const prefixed = "$AGENTFLOW_WORKSPACE/" + name;
      if (!out.includes(prefixed)) {
        out = out.replaceAll(name, prefixed);
      }
    }
  }
  return out;
}

/**
 * 在已有核查门 ID 集合 `used` 中基于 `base` 生成不冲突的唯一门禁 ID（冲突时依次追加 `-2`、`-3`...）。
 * 供 `repositoryGitGate` 派生配套 Git 检查门时内部调用。
 * @param {string} base - 期望的基础 ID 字符串。
 * @param {Object<string, boolean>} used - 已占用的核查门 ID 集合映射。
 * @returns {string} 未被占用的唯一核查门 ID。
 */
function uniqueGateID(base, used) {
  const id = base.trim() === "" ? "gate-git" : base.trim();
  if (used[id] !== true) {
    return id;
  }
  for (let i = 2; ; i++) {
    const candidate = `${id}-${i}`;
    if (used[candidate] !== true) {
      return candidate;
    }
  }
}

// MR 核查门模式：由引擎校验各仓库已推送分支是否存在包含最新提交的 MR，自身不携带命令。
const VerificationModeMR = "mr";

/**
 * 校验单个核查门的模式、执行范围以及命令约束；命令门必须显式声明 `run` 或 `repositories` 执行范围。
 * 在保存 Agent/工作流定义或执行前校验核查门配置时调用。
 * @param {Object} gate - `VerificationGate` 核查门对象。
 * @returns {void} 无返回值；配置不合法时抛出异常。
 */
function ValidateVerificationGate(gate) {
  const mode = gateMode(gate);
  switch (mode) {
    case "":
    case "command":
    case "manual":
    case VerificationModeMR:
      break;
    default:
      throw new Error(`verification gate ${gate.ID} has invalid mode ${JSON.stringify(gate.Mode)}`);
  }
  const scope = gate.ExecutionScope.trim();
  if (scope !== "" && scope !== ExecutionScopeRun && scope !== ExecutionScopeRepositories) {
    throw new Error(`verification gate ${gate.ID} has invalid executionScope ${JSON.stringify(gate.ExecutionScope)}`);
  }
  if (mode === VerificationModeMR && commandHasContent(gate)) {
    throw new Error(`verification gate ${gate.ID}: mode ${JSON.stringify(VerificationModeMR)} takes no commands`);
  }
  if (mode === "manual" || !commandHasContent(gate)) {
    return;
  }
  if (scope === "") {
    let id = gate.ID.trim();
    if (id === "") {
      id = gate.Name.trim();
    }
    if (id === "") {
      id = "unnamed";
    }
    throw new Error(`verification gate ${id} requires executionScope ${JSON.stringify(ExecutionScopeRun)} or ${JSON.stringify(ExecutionScopeRepositories)}`);
  }
}

/**
 * 依次校验核查门列表中的每一项配置。
 * 在保存或加载包含多个核查门的资产时调用。
 * @param {Object[]} gates - `VerificationGate` 对象数组。
 * @returns {void} 无返回值；遇到首个不合法门禁时抛出异常。
 */
function ValidateVerificationGates(gates) {
  for (const gate of gates ?? []) {
    ValidateVerificationGate(gate);
  }
}

/**
 * 将未声明 `ExecutionScope` 的旧版核查门按命令内容拆分为显式的 `run` 范围交付门与 `repositories` 范围 Git 检查门；
 * 已声明范围的核查门保持原样返回。
 * 在迁移旧版模板或兼容历史核查门定义时调用。
 * @param {Object[]} gates - 原始 `VerificationGate` 列表。
 * @returns {Object[]} 补全执行范围及按需拆分后的 `VerificationGate` 列表。
 */
function SplitVerificationGates(gates) {
  const used = {};
  for (const gate of gates ?? []) {
    const id = gate.ID.trim();
    if (id !== "") {
      used[id] = true;
    }
  }
  const out = [];
  for (const gate of gates ?? []) {
    if (gate.ExecutionScope.trim() !== "") {
      out.push(gate);
      continue;
    }
    const [runCmds, repoCmds] = partitionGateCommands(gate.Commands);
    if (runCmds.length === 0 && repoCmds.length === 0) {
      out.push(gate);
      continue;
    }
    if (repoCmds.length === 0) {
      const g = { ...gate, Commands: runCmds, ExecutionScope: ExecutionScopeRun };
      out.push(g);
      continue;
    }
    if (runCmds.length === 0) {
      const g = { ...gate, Commands: repoCmds, ExecutionScope: ExecutionScopeRepositories };
      out.push(g);
      continue;
    }
    const runGate = { ...gate, Commands: runCmds, ExecutionScope: ExecutionScopeRun };
    const repoGate = repositoryGitGate(gate, repoCmds, used);
    out.push(runGate, repoGate);
  }
  return out;
}

/**
 * 丢弃空白命令，并将剩余命令按是否操作 Git 仓库检出划分为运行根目录命令组与仓库命令组（后者会同步重写路径引用）。
 * 供 `SplitVerificationGates` 内部调用。
 * @param {string[]} commands - 核查门命令字符串数组。
 * @returns {[string[], string[]]} 二元组 `[runCmds, repoCmds]`。
 */
function partitionGateCommands(commands) {
  const runCmds = [];
  const repoCmds = [];
  for (const command of commands ?? []) {
    if (command.trim() === "") {
      continue;
    }
    if (CommandNeedsRepository(command)) {
      repoCmds.push(rewriteRepositoryWorkspaceRefs(command));
      continue;
    }
    runCmds.push(command);
  }
  return [runCmds, repoCmds];
}

/**
 * 基于原核查门派生配套的 `repositories` 范围 Git 检查门，并在 `used` 集合中登记其唯一的 `-git` 后缀 ID。
 * 供 `SplitVerificationGates` 内部调用。
 * @param {Object} gate - 原始 `VerificationGate` 对象。
 * @param {string[]} repoCmds - 归入仓库范围执行的命令列表。
 * @param {Object<string, boolean>} used - 已占用的核查门 ID 集合映射（会被就地更新）。
 * @returns {Object} 新派生的仓库范围 `VerificationGate` 副本对象。
 */
function repositoryGitGate(gate, repoCmds, used) {
  const repoGate = { ...gate };
  let baseID = gate.ID.trim();
  if (baseID === "") {
    baseID = "gate";
  }
  repoGate.ID = uniqueGateID(baseID + "-git", used);
  used[repoGate.ID] = true;
  const name = gate.Name.trim();
  if (name !== "") {
    repoGate.Name = name + " · Git 检查";
  } else {
    repoGate.Name = "Git 检查";
  }
  repoGate.Commands = repoCmds;
  repoGate.ExecutionScope = ExecutionScopeRepositories;
  return repoGate;
}

module.exports = { CommandNeedsRepository, VerificationModeMR, ValidateVerificationGate, ValidateVerificationGates, SplitVerificationGates };
