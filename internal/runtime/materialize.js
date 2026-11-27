// materialize.js —— 对应 Go 文件：internal/runtime/materialize.go
//
// 文件作用与职责边界：
// 负责在执行器启动前将单次 Agent 调用所需的全部受控资产（规则、技能、MCP 服务定义、Hook、
// 系统提示词与 provider 专属配置）物化到工作区 `.agentflow/` 控制目录树中，并维护目录防符号链接、
// 相对符号链接绑定、MCP 请求头密钥展开等基础能力。
//
// Go 与 JS 语法差异说明：
// - Go 的 `(compiledConfig, error)` 译为成功返回 `compiledConfig`、失败 `throw Error`；
// - Go 的 `(string, bool)` 译为 `[string, boolean]` 元组；`defer unlock()` 译为 `try ... finally`；
// - 与 `provider.js`、`workspace_locks.js` 存在同包循环依赖，按约定在函数体内延迟 `require`。

"use strict";

const fs = require("node:fs"); // 对应 Go 标准库 os
const path = require("node:path"); // 对应 Go 标准库 path/filepath

const { safeID } = require("./identifier.js"); // 对应 Go 同包函数
const { openWorkspacePath, writeManagedFile } = require("./managed_files.js"); // 对应 Go 同包函数
const { mergeAgentHookDefinitions, materializeAgentHooks } = require("./hooks.js"); // 对应 Go 同包函数
const { EnsureAgentFlowGitExcludes } = require("./git_isolation.js"); // 对应 Go 同包函数
const { materializeGateMCP } = require("./gate_mcp.js"); // 对应 Go 同包函数
const { browserUsageHint } = require("./browser.js"); // 对应 Go 同包函数
const { InvocationOptions } = require("./runtime.js"); // 对应 Go 同包类型，runtime.js 待翻译
const { compileSelectedSkill } = require("./skill_md.js"); // 对应 Go 同包函数，skill_md.js 待翻译
const { writeSkillFiles } = require("./skill_tree.js"); // 对应 Go 同包函数，skill_tree.js 待翻译
const { prepareMCPServersForDriver, MCPRuntimeWorkingDirectory } = require("./mcp_provision.js"); // 对应 Go 同包函数，mcp_provision.js 待翻译

/**
 * 单次 Agent 调用物化完成后的运行时配置汇总，供执行器与各 provider 构造启动参数与环境。
 */
class compiledConfig {
  /**
   * 创建编译配置对象，各字段严格按 Go 零值初始化。
   *
   * @param {Partial<compiledConfig>} [init={}] 可选初始字段值。
   * @returns {compiledConfig} 新的 `compiledConfig` 实例。
   */
  constructor(init = {}) {
    this.Args = init.Args ?? [];
    this.AgentRoot = init.AgentRoot ?? "";
    this.RuntimeRoot = init.RuntimeRoot ?? "";
    this.HookFile = init.HookFile ?? "";
    this.HookOutput = init.HookOutput ?? "";
    this.Hooks = init.Hooks ?? [];
    this.HasSkills = init.HasSkills ?? false;
    this.HasMCP = init.HasMCP ?? false;
    this.AgentID = init.AgentID ?? "";
    // SystemPrompt 为需要随任务正文一起下发系统提示词的 provider 保存 agent-system.md 正文。
    this.SystemPrompt = init.SystemPrompt ?? "";
  }
}

/**
 * 使用默认调用选项与 `"local"` 驱动物化单次 Agent 调用的运行时目录与配置。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {string} invocationID 本次调用标识。
 * @param {Object} ex 执行器定义（`domain.ExecutorDefinition`）。
 * @param {Object} a Agent 定义（`domain.AgentDefinition`）。
 * @param {Object} assets Agent 资产包（`domain.AgentAssetBundle`）。
 * @returns {compiledConfig} 物化完成后的编译配置对象；失败时抛出 `Error`。
 */
function materialize(workspace, invocationID, ex, a, assets) {
  return materializeInvocation(workspace, invocationID, ex, a, assets, new InvocationOptions());
}

/**
 * 使用指定调用选项与默认 `"local"` 驱动物化单次 Agent 调用的运行时目录与配置。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {string} invocationID 本次调用标识。
 * @param {Object} ex 执行器定义（`domain.ExecutorDefinition`）。
 * @param {Object} a Agent 定义（`domain.AgentDefinition`）。
 * @param {Object} assets Agent 资产包（`domain.AgentAssetBundle`）。
 * @param {Object} options 调用附加选项（`InvocationOptions`）。
 * @returns {compiledConfig} 物化完成后的编译配置对象；失败时抛出 `Error`。
 */
function materializeInvocation(workspace, invocationID, ex, a, assets, options) {
  return materializeInvocationForDriver(workspace, invocationID, ex, a, assets, options, "local");
}

/**
 * 按指定沙箱驱动将单次 Agent 调用的规则、技能、MCP 配置、Hook、系统提示词及 provider 专属文件物化到
 * `.agentflow/` 控制目录中；全程持有工作区锁以保证并发分支写入共享目录与 Git excludes 时的互斥性。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {string} invocationID 本次调用标识。
 * @param {Object} ex 执行器定义（`domain.ExecutorDefinition`）。
 * @param {Object} a Agent 定义（`domain.AgentDefinition`）。
 * @param {Object} assets Agent 资产包（`domain.AgentAssetBundle`）。
 * @param {Object} options 调用附加选项（含门禁结果路径、Browser MCP 等）。
 * @param {string} driver 沙箱驱动名称（如 `"local"`、`"docker"`、`"bwrap"`）。
 * @returns {compiledConfig} 物化完成后的编译配置对象；校验或写盘失败时抛出 `Error`。
 */
function materializeInvocationForDriver(workspace, invocationID, ex, a, assets, options, driver) {
  invocationID = safeID(invocationID);
  if (invocationID === "") {
    throw new Error("empty invocation id");
  }
  // 延迟加载以打破 materialize.js <-> workspace_locks.js / provider.js 的同包循环依赖。
  const { lockWorkspace, refreshSharedControlDirectory } = require("./workspace_locks.js"); // 对应 Go 同包函数，workspace_locks.js 待翻译
  const { providerForKind, providerMaterializeContext } = require("./provider.js"); // 对应 Go 同包函数与类型，provider.js 待翻译

  // 并发分支会在同一检出中物化不同 Agent；共享的 rules/skills/mcp 目录与 git excludes 需串行写入。
  const unlock = lockWorkspace(workspace);
  try {
    const agentID = safeID(a.ID);
    if (agentID === "") {
      throw new Error("agent id is required for runtime isolation");
    }
    if (reservedAgentID(agentID)) {
      throw new Error(`agent id ${JSON.stringify(agentID)} conflicts with an AgentFlow control directory`);
    }
    const effectiveHookDefinitions = mergeAgentHookDefinitions(providerForKind(ex.Kind).SystemHooks(), a.Hooks);
    const agentRel = path.join(".agentflow", agentID);
    const runtimeRel = path.join(".agentflow", "runtime", invocationID);
    const compiled = new compiledConfig({
      AgentRoot: agentRel.split(path.sep).join("/"),
      RuntimeRoot: runtimeRel.split(path.sep).join("/"),
      HasSkills: (assets.Skills ?? []).length > 0,
      AgentID: agentID,
    });
    // run-context.json 仅作为调试产物，不写入二进制技能与 MCP 文件负载（它们随资产包传递而非落盘调试转储）。
    const slimAssets = { ...assets, SkillFiles: null, MCPFiles: null };
    const pkg = { agent: a, assets: slimAssets, executor: ex, compiledAt: new Date().toISOString() };
    const raw = Buffer.from(JSON.stringify(pkg, null, 2), "utf8");
    const root = prepareRuntimeRoot(workspace, invocationID);
    fs.writeFileSync(path.join(root, "run-context.json"), raw, { mode: 0o600 });
    if ((effectiveHookDefinitions ?? []).length > 0 || ex.Kind === "codebuddy") {
      const observationRoot = path.join(root, "observability");
      fs.mkdirSync(observationRoot, { recursive: true, mode: 0o700 });
      compiled.HookFile = path.join(observationRoot, "hooks.ndjson");
      compiled.HookOutput = path.join(runtimeRel, "observability", "hooks.ndjson").split(path.sep).join("/");
    }
    for (const dir of ["skills", "rules", "mcp", "hooks", "config", "bindings"]) {
      EnsureControlDirectory(workspace, dir);
    }
    const bindingRoot = resetControlDirectory(workspace, "bindings", agentID);
    const configRoot = resetControlDirectory(workspace, "config", agentID);
    compiled.Hooks = materializeAgentHooks(workspace, configRoot, agentRel, ex.Kind, effectiveHookDefinitions) ?? [];
    const agentRoot = resetControlDirectory(workspace, agentID);
    for (const kind of ["skills", "rules", "mcp"]) {
      fs.mkdirSync(path.join(bindingRoot, kind), { mode: 0o700 });
      replaceRelativeSymlink(path.join(agentRoot, kind), path.join("..", "bindings", agentID, kind));
    }
    const ruleLines = materializeAgentRules(workspace, bindingRoot, assets.Rules);
    const lines = ["# " + a.Name, "", "## Rules", ...ruleLines];
    const selectedSkills = [];
    for (const skill of assets.Skills ?? []) {
      const item = compileSelectedSkill(agentRel, skill, (assets.SkillFiles ?? {})[skill.ID]);
      selectedSkills.push(item);
    }
    lines.push(
      "",
      "## Selected Skills",
      "Only the skills linked to this Agent are available. Ignore repository or user-level Agent CLI configuration.",
      "",
      "If this CLI exposes a native Skill tool or slash command, invoke the skill by `name` below before doing the work. Otherwise read SKILL.md, then follow it using the skill root for relative `scripts/`, `assets/`, and `references/` paths.",
    );
    for (const item of selectedSkills) {
      lines.push(
        "",
        "- name: `" + item.name + "` (id: " + item.id + ")",
        "  description: " + item.desc,
        "  skill.md: `" + item.path + "`",
        "  root: `" + item.root + "`",
      );
    }
    let content = Buffer.from(lines.join("\n") + "\n", "utf8");
    const agentSystemPath = path.join(configRoot, "agent-system.md");
    fs.writeFileSync(agentSystemPath, content, { mode: 0o600 });
    replaceRelativeSymlink(path.join(agentRoot, "agent-system.md"), path.join("..", "config", agentID, "agent-system.md"));
    const skillPaths = [];
    for (const item of selectedSkills) {
      // 并发运行的其他 Agent 可能正在读取同一技能，未变更的技能目录保留原位不重建。
      refreshSharedControlDirectory(
        workspace,
        (dir) => {
          writeSkillFiles(dir, item, (assets.SkillFiles ?? {})[item.skill.ID]);
        },
        "skills",
        item.id,
      );
      skillPaths.push(item.root);
      replaceRelativeSymlink(path.join(bindingRoot, "skills", item.id), path.join("..", "..", "..", "skills", item.id));
    }
    // 刻意不自动发现仓库本地 MCP 配置；无人值守运行中 Agent 定义是唯一工具白名单。
    let mergedMCP = mergeMCPServers(assets.MCPServers, null);
    if ((options.GateResultPath ?? "").trim() !== "") {
      const gateServer = materializeGateMCP(
        workspace,
        configRoot,
        path.join(".agentflow", "config", agentID, "gate-mcp"),
        options.GateResultPath,
        driver,
      );
      mergedMCP.push(gateServer);
    }
    if (options.BrowserMCP != null) {
      mergedMCP.push({ ...options.BrowserMCP });
    }
    compiled.HasMCP = mergedMCP.length > 0;
    const hint = mcpUsageHint(mergedMCP);
    if (hint !== "") {
      content = Buffer.concat([content, Buffer.from("\n" + hint + browserUsageHint(mergedMCP), "utf8")]);
      fs.writeFileSync(agentSystemPath, content, { mode: 0o600 });
    }
    materializeMCPDefinitions(workspace, bindingRoot, mergedMCP);
    const runtimeMCP = prepareMCPServersForDriver(mergedMCP, driver);
    const entries = mcpConfigEntries(runtimeMCP);
    const mcpRaw = Buffer.from(JSON.stringify({ mcpServers: entries }, null, 2), "utf8");
    fs.writeFileSync(path.join(configRoot, "mcp.json"), mcpRaw, { mode: 0o600 });
    replaceRelativeSymlink(path.join(agentRoot, "mcp.json"), path.join("..", "config", agentID, "mcp.json"));
    const provider = providerForKind(ex.Kind);
    provider.Materialize(
      new providerMaterializeContext({
        Workspace: workspace,
        AgentID: agentID,
        AgentRel: agentRel,
        RuntimeRel: runtimeRel,
        ConfigRoot: configRoot,
        AgentRoot: agentRoot,
        Content: content,
        SkillPaths: skillPaths,
        MCPServers: runtimeMCP,
        Assets: assets,
        Compiled: compiled,
      }),
    );
    return compiled;
  } finally {
    unlock();
  }
}

/**
 * 将每条规则写入共享目录 `.agentflow/rules`，在当前 Agent 的绑定目录中建立相对符号链接，
 * 并返回拼入 `agent-system.md` 的规则正文行。会按优先级降序原地排序 `rules`。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {string} bindingRoot 当前 Agent 的绑定目录路径（`.agentflow/bindings/<agentID>`）。
 * @param {Array<{ ID?: string, Name?: string, Priority?: number, Content?: string }>} rules 规则定义列表。
 * @returns {string[]} 供拼装进 `agent-system.md` 的文本行数组；规则 ID 为空或写盘失败时抛出 `Error`。
 */
function materializeAgentRules(workspace, bindingRoot, rules) {
  const list = rules ?? [];
  list.sort((a, b) => (b.Priority ?? 0) - (a.Priority ?? 0));
  const lines = [];
  for (const v of list) {
    const ruleID = safeID(v.ID);
    if (ruleID === "") {
      throw new Error("rule id is required");
    }
    const ruleFile = path.join(workspace, ".agentflow", "rules", ruleID + ".md");
    writeManagedFile(workspace, ruleFile, Buffer.from(v.Content ?? "", "utf8"), 0o600);
    replaceRelativeSymlink(path.join(bindingRoot, "rules", ruleID + ".md"), path.join("..", "..", "..", "rules", ruleID + ".md"));
    lines.push("", "### " + v.Name, v.Content);
  }
  return lines;
}

/**
 * 将每个 MCP 服务定义序列化写入共享目录 `.agentflow/mcp`，并在当前 Agent 的绑定目录建立相对符号链接。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {string} bindingRoot 当前 Agent 的绑定目录路径。
 * @param {Array<{ ID?: string }>} servers MCP 服务定义列表。
 * @returns {void} 无返回值；服务 ID 非法或写盘失败时抛出 `Error`。
 */
function materializeMCPDefinitions(workspace, bindingRoot, servers) {
  for (const server of servers ?? []) {
    const serverID = safeID(server.ID);
    if (serverID === "") {
      throw new Error("MCP server id is required");
    }
    const definition = Buffer.from(JSON.stringify(server, null, 2), "utf8");
    writeManagedFile(workspace, path.join(workspace, ".agentflow", "mcp", serverID + ".json"), definition, 0o600);
    replaceRelativeSymlink(
      path.join(bindingRoot, "mcp", serverID + ".json"),
      path.join("..", "..", "..", "mcp", serverID + ".json"),
    );
  }
}

/**
 * 确保指定路径为真实目录（非符号链接），若不存在则以给定权限创建。
 *
 * @param {string} dirPath 目标目录路径。
 * @param {number} mode 新建目录时的权限位。
 * @returns {void} 无返回值；路径为符号链接/非目录或创建失败时抛出 `Error`。
 */
function ensureDirectoryNoSymlink(dirPath, mode) {
  let info = null;
  let statErr = null;
  try {
    info = fs.lstatSync(dirPath);
  } catch (err) {
    statErr = err;
  }
  if (statErr == null) {
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`runtime path is not a real directory: ${dirPath}`);
    }
    return;
  }
  if (statErr.code !== "ENOENT") {
    throw statErr;
  }
  fs.mkdirSync(dirPath, { mode });
}

/**
 * 判断清洗后的 Agent ID 是否与 `.agentflow/` 下的系统保留控制目录名冲突。
 *
 * @param {string} id 清洗后的 Agent ID。
 * @returns {boolean} 命中保留目录名时返回 `true`，否则返回 `false`。
 */
function reservedAgentID(id) {
  switch (id) {
    case "skills":
    case "rules":
    case "mcp":
    case "hooks":
    case "config":
    case "bindings":
    case "runtime":
    case "inputs":
    case "isolation":
    case "environment":
    case "docker":
      return true;
    default:
      return false;
  }
}

/**
 * 重置 `.agentflow/` 下由 `elements` 指定的受控子目录：校验并创建父级目录后，
 * 若末级目录已存在则先校验其为真实目录并清空删除，再以 `0o700` 权限重建。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {...string} elements `.agentflow/` 下的多级路径段（至少包含 1 段）。
 * @returns {string} 重建完成后的目标目录绝对路径；路径段非法或遇到非目录/符号链接时抛出 `Error`。
 */
function resetControlDirectory(workspace, ...elements) {
  if (elements.length === 0) {
    throw new Error("missing AgentFlow control directory");
  }
  const parent = EnsureControlDirectory(workspace, ...elements.slice(0, -1));
  const name = elements[elements.length - 1];
  if (name === "" || name === "." || name === ".." || path.basename(name) !== name) {
    throw new Error(`invalid AgentFlow control path segment ${JSON.stringify(name)}`);
  }
  const target = path.join(parent, name);
  const [root, rel] = openWorkspacePath(workspace, target);
  try {
    let info = null;
    let lstatErr = null;
    try {
      info = root.Lstat(rel);
    } catch (err) {
      lstatErr = err;
    }
    if (lstatErr == null) {
      if (!info.isDirectory()) {
        throw new Error(`managed path is not a real directory: ${target}`);
      }
      root.RemoveAll(rel);
    } else if (lstatErr.code !== "ENOENT") {
      throw lstatErr;
    }
    root.Mkdir(rel, 0o700);
    return target;
  } finally {
    root.Close();
  }
}

/**
 * 在指定位置创建或替换指向相对目标的符号链接；若原路径已存在但不是符号链接则报错拒绝覆盖。
 *
 * @param {string} linkPath 符号链接文件路径。
 * @param {string} target 相对目标路径（禁止绝对路径）。
 * @returns {void} 无返回值；目标为绝对路径、原路径非符号链接或创建失败时抛出 `Error`。
 */
function replaceRelativeSymlink(linkPath, target) {
  if (path.isAbsolute(target)) {
    throw new Error(`AgentFlow link target must be relative: ${target}`);
  }
  let info = null;
  let statErr = null;
  try {
    info = fs.lstatSync(linkPath);
  } catch (err) {
    statErr = err;
  }
  if (statErr == null) {
    if (!info.isSymbolicLink()) {
      throw new Error(`Agent binding path is not a symlink: ${linkPath}`);
    }
    fs.unlinkSync(linkPath);
  } else if (statErr.code !== "ENOENT") {
    throw statErr;
  }
  fs.symlinkSync(target, linkPath);
}

/**
 * 校验并创建控制面在沙箱执行器启动前唯一写入的仓库旁目录 `.agentflow`，
 * 同时确保 `.git/info/exclude` 已排除 `.agentflow/`。
 *
 * @param {string} workspace 工作区根目录路径。
 * @returns {void} 无返回值；目录校验或写 exclude 失败时抛出 `Error`。
 */
function EnsureControlRoot(workspace) {
  const baseAbs = path.resolve(workspace);
  const root = {
    Lstat(rel) {
      return fs.lstatSync(path.join(baseAbs, rel));
    },
    Mkdir(rel, mode) {
      fs.mkdirSync(path.join(baseAbs, rel), { mode });
    },
    Close() {},
  };
  try {
    ensureRootDirectory(root, ".agentflow");
  } finally {
    root.Close();
  }
  EnsureAgentFlowGitExcludes(workspace);
}

/**
 * 在受限根对象 `root` 下确保相对路径 `rel` 为真实目录（非符号链接）；
 * 并发竞争导致 `EEXIST` 时重新执行 `Lstat` 复验，若胜出者为符号链接或非目录仍安全拒绝。
 *
 * @param {Object} root 提供 `Lstat(rel)` 与 `Mkdir(rel, mode)` 方法的根目录操作对象。
 * @param {string} rel 相对根目录的子目录路径。
 * @returns {void} 无返回值；路径非真实目录或创建失败时抛出 `Error`。
 */
function ensureRootDirectory(root, rel) {
  let info = null;
  let err = null;
  try {
    info = root.Lstat(rel);
  } catch (e) {
    err = e;
  }
  if (err != null && err.code === "ENOENT") {
    try {
      root.Mkdir(rel, 0o700);
      return;
    } catch (mkdirErr) {
      if (mkdirErr.code !== "EEXIST") {
        throw mkdirErr;
      }
      // 其他 worker 可能在 Lstat 之后抢先创建；重新校验胜出者，符号链接或非目录仍须拒绝。
      err = null;
      try {
        info = root.Lstat(rel);
      } catch (e) {
        err = e;
      }
    }
  }
  if (err != null) {
    throw err;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`runtime path is not a real directory: ${rel}`);
  }
}

/**
 * 在 `.agentflow/` 下逐级创建并校验控制目录，拒绝任意控制面路径段中的符号链接或越界段名。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {...string} elements `.agentflow/` 下的路径段序列。
 * @returns {string} 目标控制目录的完整路径；路径段非法或校验失败时抛出 `Error`。
 */
function EnsureControlDirectory(workspace, ...elements) {
  for (const element of elements) {
    if (element === "" || element === "." || element === ".." || path.basename(element) !== element) {
      throw new Error(`invalid AgentFlow control path segment ${JSON.stringify(element)}`);
    }
  }
  EnsureControlRoot(workspace);
  const baseAbs = path.resolve(workspace);
  const root = {
    Lstat(rel) {
      return fs.lstatSync(path.join(baseAbs, rel));
    },
    Mkdir(rel, mode) {
      fs.mkdirSync(path.join(baseAbs, rel), { mode });
    },
    Close() {},
  };
  try {
    let current = ".agentflow";
    ensureRootDirectory(root, current);
    for (const element of elements) {
      current = path.join(current, element);
      ensureRootDirectory(root, current);
    }
    return path.join(workspace, current);
  } finally {
    root.Close();
  }
}

/**
 * 重置并准备单次调用的运行时目录 `.agentflow/runtime/<invocationID>`。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {string} invocationID 清洗后的调用标识。
 * @returns {string} 运行时根目录绝对路径；创建失败时抛出 `Error`。
 */
function prepareRuntimeRoot(workspace, invocationID) {
  return resetControlDirectory(workspace, "runtime", invocationID);
}

/**
 * 合并资产包 MCP 服务与本地 MCP 服务（按 ID 去重，资产包优先），并按规则追加兼容别名条目（如 `gongfeng`）。
 *
 * @param {Array<Object>} assets 资产包中的 MCP 服务定义列表。
 * @param {Array<Object> | null} local 额外本地 MCP 服务定义列表（可为空）。
 * @returns {Array<Object>} 去重并补齐别名后的 MCP 服务定义列表。
 */
function mergeMCPServers(assets, local) {
  const merged = [...(assets ?? [])];
  const seen = {};
  for (const m of merged) {
    if (m.ID) {
      seen[m.ID] = true;
    }
  }
  for (const m of local ?? []) {
    if (!m.ID || seen[m.ID]) {
      continue;
    }
    seen[m.ID] = true;
    merged.push(m);
  }
  for (const m of assets ?? []) {
    for (const alias of mcpAliases(m) ?? []) {
      if (seen[alias]) {
        continue;
      }
      seen[alias] = true;
      const cp = { ...m, ID: alias };
      merged.push(cp);
    }
  }
  return merged;
}

/**
 * 为指定 HTTP MCP 服务推导兼容别名列表（工蜂相关服务追加 `"gongfeng"` 别名）。
 *
 * @param {{ Transport?: string, ID?: string, URL?: string }} m MCP 服务定义对象。
 * @returns {string[] | null} 别名列表；非 HTTP 传输时返回 `null`。
 */
function mcpAliases(m) {
  if (m.Transport !== "http") {
    return null;
  }
  const key = ((m.ID ?? "") + " " + (m.URL ?? "")).toLowerCase();
  const out = [];
  if (m.ID === "gongfeng-delivery" || key.includes("gongfeng")) {
    out.push("gongfeng");
  }
  return out;
}

/**
 * 将 MCP 服务定义列表转换为写入 `mcp.json` 中 `mcpServers` 字段的键值映射。
 * HTTP 传输展开请求头密钥占位符，stdio 传输填充命令、参数、工作目录与环境变量。
 *
 * @param {Array<Object>} servers MCP 服务定义列表。
 * @returns {Object<string, Object>} 以服务 ID 为键的配置项映射；请求头密钥缺失时抛出 `Error`。
 */
function mcpConfigEntries(servers) {
  const out = {};
  for (const m of servers ?? []) {
    if (!m.ID) {
      continue;
    }
    const entry = {};
    if (m.Transport === "http") {
      entry.type = "http";
      entry.url = m.URL;
      const headers = httpMCPHeaders(m);
      if (Object.keys(headers).length > 0) {
        entry.headers = headers;
      }
    } else {
      entry.command = m.Command;
      entry.args = m.Args;
      const cwd = MCPRuntimeWorkingDirectory(m);
      if (cwd !== "") {
        entry.cwd = cwd;
      }
      const env = resolveMap(m.Environment);
      if (Object.keys(env).length > 0) {
        entry.env = env;
      }
    }
    out[m.ID] = entry;
  }
  return out;
}

/**
 * 展开 HTTP MCP 服务定义 `Headers` 中的 `${secret:...}` 占位符，并按需补充默认 `X-Username`。
 *
 * @param {Object} m MCP 服务定义对象（`domain.MCPServerDefinition`）。
 * @returns {Object<string, string>} 展开完成后的请求头键值对象；占位符无法解析时抛出 `Error`。
 */
function ResolveMCPHeaders(m) {
  return httpMCPHeaders(m);
}

/**
 * 校验并展开 HTTP MCP 服务的请求头映射；若未显式提供 `X-Username` 且环境配置了
 * `AGENTFLOW_MCP_USERNAME`，则自动补入该请求头。
 *
 * @param {Object} m MCP 服务定义对象。
 * @returns {Object<string, string>} 解析后的请求头键值对象；存在空密钥占位符时抛出 `Error`。
 */
function httpMCPHeaders(m) {
  for (const [k, v] of Object.entries(m.Headers ?? {})) {
    if (v.includes("${secret:")) {
      const [, ok] = resolveSecretString(v);
      if (!ok) {
        throw new Error(
          `MCP ${m.ID} header ${k}: \${secret:} is empty (put the Bearer token in this MCP's Headers JSON)`,
        );
      }
    }
  }
  let out = resolveMap(m.Headers);
  const [, hasUser] = headerLookup(out, "X-Username");
  if (!hasUser) {
    const user = (process.env.AGENTFLOW_MCP_USERNAME ?? "").trim();
    if (user !== "") {
      if (out == null) {
        out = {};
      }
      out["X-Username"] = user;
    }
  }
  return out;
}

/**
 * 按大小写无关方式在请求头映射中查找指定名称的头值。
 *
 * @param {Object<string, string>} headers 请求头键值对象。
 * @param {string} name 要查找的请求头名称。
 * @returns {[string, boolean]} 命中返回 `[value, true]`，否则返回 `["", false]`。
 */
function headerLookup(headers, name) {
  const target = (name ?? "").toLowerCase();
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === target) {
      return [v, true];
    }
  }
  return ["", false];
}

/**
 * 根据当前节点允许的 MCP 服务列表生成注入到 `agent-system.md` 尾部的 MCP 使用说明，
 * 包含工蜂 MR / Checkers 场景的专用指引。
 *
 * @param {Array<{ ID?: string, Transport?: string, URL?: string }>} servers 合并后的 MCP 服务列表。
 * @returns {string} Markdown 格式的 MCP 使用说明；无可用 MCP 时返回空字符串。
 */
function mcpUsageHint(servers) {
  const ids = [];
  let hasGongfeng = false;
  for (const m of servers ?? []) {
    if ((m.ID ?? "").trim() !== "") {
      ids.push(m.ID);
    }
    if (m.Transport !== "http") {
      continue;
    }
    const key = ((m.ID ?? "") + " " + (m.URL ?? "")).toLowerCase();
    if (m.ID === "gongfeng" || m.ID === "gongfeng-delivery" || key.includes("gongfeng")) {
      hasGongfeng = true;
    }
  }
  if (ids.length === 0) {
    return "";
  }
  let b = "";
  b += "## MCP 怎么用\n\n";
  b += "本节点的平台 MCP 配置已按 Agent allowlist 严格注入：";
  b += ids.join("、");
  b += "。别名：gongfeng-delivery=gongfeng。\n";
  b +=
    "这些 MCP 已写入 `--mcp-config .agentflow/config/<agent>/mcp.json`，会以原生工具出现（名称常为 mcp__<server>__*）。直接调原生工具。HTTP MCP 禁止用 curl 打网关，禁止 Bash mcporter：JSON body 容易丢，参数会被静默截断。\n";
  if (hasGongfeng) {
    b += "\n### 工蜂：看 MR / Checkers\n";
    b += "真值是 commit status，不是审查报告是否 SUCCESS。\n";
    b += "1. 读 mr-body.md，记下 project（group/repo）、iid、head SHA。\n";
    b += "2. 原生 `get_commit_combined_status`（sha=当前 HEAD）。这是 Checkers 列表。轮询最多 20 轮、间隔 90s，直到应等项终态。\n";
    b += "3. 失败项再 `search_merge_request_notes` 翻页对齐建议；`get_review_intelligent_result` 只表示审查意见，**不等于** MR审查 pipeline 绿。\n";
    b += "4. 创建 MR 用 `create_merge_request`；更新已有本轮 MR 才 `update_merge_request`；讨论区回评用 `create_merge_request_note`。\n";
    b += "自动代码审查类检查失败若是 401 / no permission 等鉴权错误且没有代码审查结论，记 SKIP_INFRA，不要当成业务缺陷打回。\n";
  }
  return b;
}

// 匹配 `${secret:ENV_NAME}` 密钥占位符。
const secretPlaceholder = /\$\{secret:([^}]+)\}/g;

/**
 * 批量展开字符串映射中所有值的 `${secret:NAME}` 占位符，解析失败或缺失的条目直接省略。
 *
 * @param {Object<string, string>} inMap 原始键值映射（请求头或环境变量）。
 * @returns {Object<string, string>} 展开后的新键值映射。
 */
function resolveMap(inMap) {
  const out = {};
  for (const [k, v] of Object.entries(inMap ?? {})) {
    const [resolved, ok] = resolveSecretString(v);
    if (!ok) {
      continue;
    }
    out[k] = resolved;
  }
  return out;
}

/**
 * 使用进程环境变量展开字符串中任意位置的 `${secret:NAME}` 占位符（例如 `"Bearer ${secret:FOO}"`）。
 * 若任意占位符对应的环境变量为空或未解析完，则返回 `["", false]` 以防止字面量 `${secret:...}` 落入 `mcp.json`。
 *
 * @param {string} value 待展开的原始字符串。
 * @returns {[string, boolean]} 展开成功返回 `[resolved, true]`；缺失环境变量或残留占位符时返回 `["", false]`。
 */
function resolveSecretString(value) {
  if (!value.includes("${secret:")) {
    return [value, true];
  }
  let missing = false;
  const resolved = value.replace(secretPlaceholder, (_match, envName) => {
    if (!envName) {
      missing = true;
      return "";
    }
    const actual = (process.env[envName] ?? "").trim();
    if (actual === "") {
      missing = true;
      return "";
    }
    return actual;
  });
  if (missing || resolved.includes("${secret:")) {
    return ["", false];
  }
  return [resolved, true];
}

module.exports = {
  compiledConfig,
  materialize,
  materializeInvocation,
  materializeInvocationForDriver,
  materializeAgentRules,
  materializeMCPDefinitions,
  ensureDirectoryNoSymlink,
  reservedAgentID,
  resetControlDirectory,
  replaceRelativeSymlink,
  EnsureControlRoot,
  ensureRootDirectory,
  EnsureControlDirectory,
  prepareRuntimeRoot,
  mergeMCPServers,
  mcpAliases,
  mcpConfigEntries,
  ResolveMCPHeaders,
  httpMCPHeaders,
  headerLookup,
  mcpUsageHint,
  secretPlaceholder,
  resolveMap,
  resolveSecretString,
};
