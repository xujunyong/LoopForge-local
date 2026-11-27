// gate_mcp.js —— 对应 Go 文件：internal/runtime/gate_mcp.go
// 作用与职责边界：定位或按需编译并物化 Gate MCP 服务端二进制到工作区配置目录，以及为 mock 执行器解析并写出模拟门禁结果。
// 语法差异说明：
// - Go 的 (值, error) 译为成功返回值、失败 throw；sync.Mutex 在单线程 JS 中略去；
// - runtime.GOOS/GOARCH 通过 process.platform/process.arch 映射；fmt.Sprintf 的 %q 译为 JSON.stringify；
// - mock 结果按 JSON 字段名（decision/reason/…）组织，因 writeMockGateResult 会直接 JSON 序列化落盘。

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

/**
 * 将目标平台的 Gate MCP 二进制复制到工作区受管配置目录，并返回对应的 stdio MCP 服务定义。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {string} configRoot 工作区内用于存放运行时二进制的配置目录路径。
 * @param {string} binaryRel MCP 服务配置中引用的二进制相对路径。
 * @param {string} resultPath 门禁结果文件的相对路径，将写入 AGENTFLOW_GATE_RESULT_PATH 环境变量。
 * @param {string} driver 沙箱驱动名称（为 "docker" 时目标系统强制切换为 linux）。
 * @returns {{ ID: string, Name: string, Transport: string, Command: string, Environment: Object<string, string> }} 物化完成后的 MCPServerDefinition 对象。
 */
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

/**
 * 按“环境变量指定路径 → 当前可执行文件同目录伴生二进制 → 源码根目录按需编译缓存”的顺序解析 Gate MCP 二进制路径。
 *
 * @param {string} targetOS 目标操作系统（仅支持 "darwin" 或 "linux"）。
 * @param {string} targetArch 目标 CPU 架构（仅支持 "amd64" 或 "arm64"）。
 * @returns {string} 可用的 Gate MCP 二进制文件绝对路径。
 */
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

/**
 * 将路径模板中的 `{os}` 和 `{arch}` 占位符替换为目标平台值，用于展开 AGENTFLOW_GATE_MCP_BINARY 配置。
 *
 * @param {string} pattern 含占位符的路径模板。
 * @param {string} targetOS 目标操作系统名称。
 * @param {string} targetArch 目标架构名称。
 * @returns {string} 替换完成后的路径字符串。
 */
function expandPlatformPath(pattern, targetOS, targetArch) {
  return pattern.replaceAll("{os}", targetOS).replaceAll("{arch}", targetArch);
}

/**
 * 检查指定路径是否为存在且非空的普通文件，用于校验二进制文件或 go.mod 是否有效。
 *
 * @param {string} filePath 待检查的文件路径。
 * @returns {boolean} 存在、非目录且大小大于 0 时返回 true，否则返回 false。
 */
function validExecutableFile(filePath) {
  try {
    const info = fs.statSync(filePath);
    return !info.isDirectory() && info.size > 0;
  } catch {
    return false;
  }
}

/**
 * 定位包含 `go.mod` 与 `cmd/agentflow-gate-mcp` 的项目源码根目录，优先读取 AGENTFLOW_SOURCE_ROOT，否则从当前目录逐级向上查找。
 *
 * @returns {string} 源码根目录路径；未找到时返回空字符串。
 */
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

/**
 * 判断目录是否为合法的 Gate MCP 源码根目录（同时包含 go.mod 文件和 cmd/agentflow-gate-mcp 目录）。
 *
 * @param {string} root 待检测的目录路径。
 * @returns {boolean} 满足源码根目录条件时返回 true，否则返回 false。
 */
function validSourceRoot(root) {
  return validExecutableFile(path.join(root, "go.mod")) && dirExistsRuntime(path.join(root, "cmd", "agentflow-gate-mcp"));
}

/**
 * 检查指定路径是否存在且为目录。
 *
 * @param {string} pathToCheck 待检查的目录路径。
 * @returns {boolean} 存在且为目录时返回 true，否则返回 false。
 */
function dirExistsRuntime(pathToCheck) {
  try {
    const info = fs.statSync(pathToCheck);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 检查已缓存的 Gate MCP 二进制是否仍新于源码树中的所有 `.go`、`go.mod`、`go.sum` 文件；遍历时跳过隐藏目录和前端/依赖目录。
 *
 * @param {string} cache 缓存的二进制文件路径。
 * @param {string} root 项目源码根目录路径。
 * @returns {boolean} 缓存存在、非空且没有比其更新的 Go 源文件时返回 true，否则返回 false。
 */
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

/**
 * 为 mock 执行器生成门禁评审结果 JSON 并写入工作区目标路径（自动创建父目录，权限 0700 / 文件权限 0600）。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {string} resultPath 门禁结果文件的相对路径（斜杠分隔）。
 * @param {Object} agent Agent 定义对象（含 Prompt 字段）。
 * @returns {void} 无返回值。
 */
function writeMockGateResult(workspace, resultPath, agent) {
  const target = path.join(workspace, resultPath.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const result = mockGateResult(agent, resultPath);
  const raw = JSON.stringify(result);
  fs.writeFileSync(target, raw, { mode: 0o600 });
}

/**
 * 根据 Agent 提示词中的 `[[mock:...=...]]` 指令组装模拟门禁结果对象，用于 mock 执行器测试门禁分支流转。
 *
 * @param {Object} agent Agent 定义对象（读取其 Prompt 字段）。
 * @param {string} resultPath 门禁结果文件路径，用于从中解析当前尝试次数。
 * @returns {{ decision: string, reason: string, actionRequired?: string, summary?: string, findings?: Array<{ severity?: string, title: string, evidence?: string }> }} 序列化用的门禁结果对象。
 */
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
    // 对应 Go 的 strings.SplitN(value, "|", 3)：最多切成 3 段，第 3 段保留剩余分隔符。
    const rawParts = value.split("|");
    const parts = rawParts.length <= 3 ? rawParts : [rawParts[0], rawParts[1], rawParts.slice(2).join("|")];
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

/**
 * 从指令文本中提取第一个指定名称的 `[[mock:<name>=...]]` 值。
 *
 * @param {string} instructions 包含 mock 指令的提示词文本。
 * @param {string} name 指令键名（如 "reason"、"action"、"summary"）。
 * @returns {string} 匹配到的首个指令值；未匹配时返回空字符串。
 */
function mockDirective(instructions, name) {
  const values = mockDirectives(instructions, name);
  if (values.length === 0) {
    return "";
  }
  return values[0];
}

/**
 * 从指令文本中提取全部指定名称的 `[[mock:<name>=...]]` 值列表。
 *
 * @param {string} instructions 包含 mock 指令的提示词文本。
 * @param {string} name 指令键名（如 "finding"）。
 * @returns {string[]} 匹配到的全部去空白后的指令值数组。
 */
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

/**
 * 从 Agent 提示词的 `[[mock:gate=...]]` 决策序列和结果文件名中的 `attempt-N` 序号，确定本次尝试的门禁决策。
 *
 * @param {Object} agent Agent 定义对象（读取其 Prompt 字段）。
 * @param {string} resultPath 门禁结果文件路径（如 `attempt-2.json`）。
 * @returns {string} 门禁决策值（"pass" | "rework" | "fail" | "human"），无效或未指定时默认 "pass"。
 */
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

module.exports = { gateMCPServerID, materializeGateMCP, resolveGateMCPBinary, expandPlatformPath, validExecutableFile, gateMCPSourceRoot, validSourceRoot, dirExistsRuntime, buildArtifactFresh, writeMockGateResult, mockGateResult, mockDirective, mockDirectives, mockGateDecision };
