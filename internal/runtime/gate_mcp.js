// gate_mcp.js —— 对应 Go 文件：internal/runtime/gate_mcp.go
// 作用：物化 Gate MCP 服务端二进制并生成 mock 门禁结果。
// Go 的 (值, error) 译为成功返回值、失败 throw；(值, bool) 译为 [值, bool]；sync.Mutex 省略，JS 单线程无需加锁；
// runtime.GOOS/GOARCH 译为 process.platform/process.arch 的映射；fmt.Sprintf 的 %q 译为 JSON.stringify；
// mock 结果按 JSON 字段名（decision/reason/…）组织，因 writeMockGateResult 会把它 JSON 序列化后写盘。

"use strict";

const fs = require("node:fs");
const os = require("node:os"); // Go os.TempDir
const path = require("node:path");
const { spawnSync } = require("node:child_process"); // Go os/exec
const { writeManagedFile } = require("./managed_files.js"); // 对应 Go 同包函数，managed_files.js 待翻译

// Go 的 runtime.GOOS/GOARCH：process.platform/process.arch 映射而来。
const currentGOOS = process.platform === "win32" ? "windows" : process.platform;
const currentGOARCH = process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch;

const gateMCPServerID = "agentflow-gate";

// splitN：Go 的 strings.SplitN，JS 的 split 不支持“余下部分不再切分”。
function splitN(s, sep, n) {
  if (n <= 0) {
    return [];
  }
  const parts = s.split(sep);
  if (parts.length <= n) {
    return parts;
  }
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join(sep)];
}

function materializeGateMCP(workspace, configRoot, binaryRel, resultPath, driver) {
  resultPath = path.normalize(resultPath.trim()).split(path.sep).join("/");
  if (resultPath === "." || path.isAbsolute(resultPath) || resultPath === ".." || resultPath.startsWith("../")) {
    throw new Error(`invalid gate result path ${JSON.stringify(resultPath)}`);
  }
  let targetOS = currentGOOS;
  if (driver.trim().toLowerCase() === "docker") {
    targetOS = "linux";
  }
  const source = resolveGateMCPBinary(targetOS, currentGOARCH);
  let raw;
  try {
    raw = fs.readFileSync(source);
  } catch (err) {
    throw new Error(`read gate MCP binary: ${err.message}`);
  }
  const binaryPath = path.join(configRoot, "gate-mcp");
  writeManagedFile(workspace, binaryPath, raw, 0o700);
  return {
    ID: gateMCPServerID,
    Name: "LoopForge Gate",
    Transport: "stdio",
    Command: binaryRel.split(path.sep).join("/"),
    Environment: {
      AGENTFLOW_GATE_RESULT_PATH: resultPath,
    },
  };
}

function resolveGateMCPBinary(targetOS, targetArch) {
  if (targetOS !== "darwin" && targetOS !== "linux") {
    throw new Error(`unsupported gate MCP operating system ${JSON.stringify(targetOS)}`);
  }
  if (targetArch !== "amd64" && targetArch !== "arm64") {
    throw new Error(`unsupported gate MCP architecture ${JSON.stringify(targetArch)}`);
  }
  const pattern = (process.env.AGENTFLOW_GATE_MCP_BINARY ?? "").trim();
  if (pattern !== "") {
    const expanded = expandPlatformPath(pattern, targetOS, targetArch);
    if (validExecutableFile(expanded)) {
      return expanded;
    }
    throw new Error(`gate MCP binary ${targetOS}/${targetArch} is not deployed at ${expanded}`);
  }
  // Go 的 os.Executable 译为 process.execPath。
  const dir = path.dirname(process.execPath);
  for (const name of [`agentflow-gate-mcp-${targetOS}-${targetArch}`, "agentflow-gate-mcp"]) {
    const candidate = path.join(dir, name);
    if (validExecutableFile(candidate) && (name !== "agentflow-gate-mcp" || (targetOS === currentGOOS && targetArch === currentGOARCH))) {
      return candidate;
    }
  }
  const root = gateMCPSourceRoot();
  if (root === "") {
    throw new Error(`gate MCP binary ${targetOS}/${targetArch} is unavailable; deploy AGENTFLOW_GATE_MCP_BINARY or AGENTFLOW_SOURCE_ROOT`);
  }
  const cache = path.join(os.tmpdir(), `agentflow-gate-mcp-${targetOS}-${targetArch}`);
  if (!buildArtifactFresh(cache, root)) {
    const build = spawnSync("go", ["build", "-o", cache, "./cmd/agentflow-gate-mcp"], {
      cwd: root,
      env: { ...process.env, CGO_ENABLED: "0", GOOS: targetOS, GOARCH: targetArch },
      encoding: "utf8",
    });
    if (build.error != null || build.status !== 0) {
      const err = build.error != null ? build.error : new Error(`exit status ${build.status}`);
      const out = ((build.stdout ?? "") + (build.stderr ?? "")).trim();
      throw new Error(`build gate MCP binary ${targetOS}/${targetArch}: ${err.message}: ${out}`);
    }
  }
  return cache;
}

function expandPlatformPath(pattern, targetOS, targetArch) {
  return pattern.replaceAll("{os}", targetOS).replaceAll("{arch}", targetArch);
}

function validExecutableFile(filePath) {
  try {
    const info = fs.statSync(filePath);
    return !info.isDirectory() && info.size > 0;
  } catch {
    return false;
  }
}

function gateMCPSourceRoot() {
  const root = (process.env.AGENTFLOW_SOURCE_ROOT ?? "").trim();
  if (root !== "") {
    if (validSourceRoot(root)) {
      return root;
    }
    return "";
  }
  let start;
  try {
    start = process.cwd();
  } catch {
    return "";
  }
  for (let current = start; ; current = path.dirname(current)) {
    if (validSourceRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return "";
    }
  }
}

function validSourceRoot(root) {
  return validExecutableFile(path.join(root, "go.mod")) && dirExistsRuntime(path.join(root, "cmd", "agentflow-gate-mcp"));
}

function dirExistsRuntime(pathToCheck) {
  try {
    const info = fs.statSync(pathToCheck);
    return info.isDirectory();
  } catch {
    return false;
  }
}

function buildArtifactFresh(cache, root) {
  let info;
  try {
    info = fs.statSync(cache);
  } catch {
    return false;
  }
  if (info.isDirectory() || info.size === 0) {
    return false;
  }
  const binaryTime = info.mtimeMs;
  let fresh = true;
  const walk = (dir) => {
    if (!fresh) {
      return false;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!fresh) {
        return false;
      }
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (p !== root && entry.name.startsWith(".")) {
          continue;
        }
        if (["vendor", "testdata", "web", "docs", "node_modules"].includes(entry.name)) {
          continue;
        }
        if (!walk(p)) {
          return false;
        }
        continue;
      }
      if (p.endsWith(".go") || p.endsWith("go.mod") || p.endsWith("go.sum")) {
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        if (st.mtimeMs > binaryTime) {
          fresh = false;
          return false;
        }
      }
    }
    return true;
  };
  walk(root);
  return fresh;
}

function writeMockGateResult(workspace, resultPath, agent) {
  const target = path.join(workspace, resultPath.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const result = mockGateResult(agent, resultPath);
  const raw = JSON.stringify(result);
  fs.writeFileSync(target, raw, { mode: 0o600 });
}

function mockGateResult(agent, resultPath) {
  const decision = mockGateDecision(agent, resultPath);
  // Go 结构体的 omitempty：空字段不进 JSON，故此处先算局部量再按需组装。
  let reason = mockDirective(agent.Prompt, "reason");
  let actionRequired = mockDirective(agent.Prompt, "action");
  const summary = mockDirective(agent.Prompt, "summary");
  if (reason === "") {
    reason = "mock executor called submit_gate_result with " + decision;
  }
  if (decision === "human" && actionRequired === "") {
    actionRequired = "请确认当前证据是否足以允许流程继续";
  }
  if (decision === "rework" && actionRequired === "") {
    actionRequired = "请上游节点根据评审发现完成修复后重新提交";
  }
  const findings = [];
  for (const value of mockDirectives(agent.Prompt, "finding")) {
    const parts = splitN(value, "|", 3);
    let severity = "";
    let title = parts[0].trim();
    let evidence = "";
    if (parts.length > 1) {
      severity = title;
      title = parts[1].trim();
    }
    if (parts.length > 2) {
      evidence = parts[2].trim();
    }
    if (title === "") {
      continue;
    }
    const finding = {};
    if (severity !== "") {
      finding.severity = severity;
    }
    finding.title = title;
    if (evidence !== "") {
      finding.evidence = evidence;
    }
    findings.push(finding);
  }
  const result = { decision, reason };
  if (actionRequired !== "") {
    result.actionRequired = actionRequired;
  }
  if (summary !== "") {
    result.summary = summary;
  }
  if (findings.length > 0) {
    result.findings = findings;
  }
  return result;
}

function mockDirective(instructions, name) {
  const values = mockDirectives(instructions, name);
  if (values.length === 0) {
    return "";
  }
  return values[0];
}

function mockDirectives(instructions, name) {
  const prefix = "[[mock:" + name + "=";
  const values = [];
  for (;;) {
    const start = instructions.indexOf(prefix);
    if (start < 0) {
      return values;
    }
    const rest = instructions.slice(start + prefix.length);
    const end = rest.indexOf("]]");
    if (end < 0) {
      return values;
    }
    values.push(rest.slice(0, end).trim());
    instructions = rest.slice(end + 2);
  }
}

function mockGateDecision(agent, resultPath) {
  const prefix = "[[mock:gate=";
  const instructions = agent.Prompt;
  const start = instructions.indexOf(prefix);
  if (start < 0) {
    return "pass";
  }
  const rest = instructions.slice(start + prefix.length);
  const end = rest.indexOf("]]");
  if (end < 0) {
    return "pass";
  }
  const sequence = rest.slice(0, end).split(",");
  let attempt = 1;
  const name = path.basename(resultPath.split("/").join(path.sep));
  let value = name.startsWith("attempt-") ? name.slice("attempt-".length) : name;
  const ext = path.extname(name);
  if (ext !== "" && value.endsWith(ext)) {
    value = value.slice(0, value.length - ext.length);
  }
  if (value !== "") {
    if (/^-?\d+$/.test(value)) {
      const parsed = parseInt(value, 10);
      if (parsed > 0) {
        attempt = parsed;
      }
    }
  }
  const index = Math.min(attempt - 1, sequence.length - 1);
  if (index < 0) {
    return "pass";
  }
  const decision = sequence[index].toLowerCase().trim();
  switch (decision) {
    case "pass":
    case "rework":
    case "fail":
    case "human":
      return decision;
    default:
      return "pass";
  }
}

module.exports = { gateMCPServerID, splitN, materializeGateMCP, resolveGateMCPBinary, expandPlatformPath, validExecutableFile, gateMCPSourceRoot, validSourceRoot, dirExistsRuntime, buildArtifactFresh, writeMockGateResult, mockGateResult, mockDirective, mockDirectives, mockGateDecision };
