// verification.js —— 对应 Go 文件：internal/domain/verification.go
// 作用：校验核查门配置，并把未声明执行范围的旧门拆成 run 门与 repositories 门。

"use strict";

function commandHasContent(gate) {
  for (const command of gate.Commands ?? []) {
    if (command.trim() !== "") {
      return true;
    }
  }
  return false;
}

function gateMode(gate) {
  const mode = gate.Mode.trim().toLowerCase();
  if (mode === "" && commandHasContent(gate)) {
    return "command";
  }
  return mode;
}

// CommandNeedsRepository：命令是否检查或修改 Git 检出。
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

function uniqueGateID(base, used) {
  const id = base.trim() === "" ? "gate-git" : base.trim();
  if (!used.has(id)) {
    return id;
  }
  for (let i = 2; ; i++) {
    const candidate = `${id}-${i}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

// VerificationModeMR：核查门只在 MR 携带已推送 tip 时通过，本身无命令。
const VerificationModeMR = "mr";

// ValidateVerificationGate：命令门必须声明 run 或 repositories 执行范围。
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

function ValidateVerificationGates(gates) {
  for (const gate of gates ?? []) {
    ValidateVerificationGate(gate);
  }
}

// SplitVerificationGates：把未声明范围的旧门拆成显式的 run 门与 repositories 门。
function SplitVerificationGates(gates) {
  const used = new Set();
  for (const gate of gates ?? []) {
    const id = gate.ID.trim();
    if (id !== "") {
      used.add(id);
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

// partitionGateCommands：去掉空命令，按是否操作 Git 检出拆成两组。
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

// repositoryGitGate：派生一个门在 repositories 范围跑 repoCmds。
function repositoryGitGate(gate, repoCmds, used) {
  const repoGate = { ...gate };
  let baseID = gate.ID.trim();
  if (baseID === "") {
    baseID = "gate";
  }
  repoGate.ID = uniqueGateID(baseID + "-git", used);
  used.add(repoGate.ID);
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
