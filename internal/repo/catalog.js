/**
 * @file internal/repo/catalog.js
 * 对应 Go 源文件：internal/repo/catalog.go
 *
 * 作用与职责边界：
 * 实现可复用定义目录仓储（`CatalogRepo`）的核心持久化读写与校验逻辑，涵盖角色（Agent）、规则（Rule）、
 * 技能（Skill）、MCP 服务器、执行器（Executor）、沙箱配置（Sandbox）、工作流（SOP/Workflow）、
 * 仓库（Repository）、同步配置（SyncConfig）、定时任务（ScheduleJob）以及定义版本快照（DefinitionRevision），
 * 并提供生产默认 SOP 绑定、沙箱/工作流规范化等目录领域辅助函数。
 * 不负责目录共享策略（见 `catalog_sharing.js`）、通用模板存取（见 `generic_store.js`）及对话工作区沙箱解析（见 `conversation_sandbox.js`）。
 *
 * 语法差异说明：
 * - `CatalogRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `CatalogRepo.prototype` 挂载各目录方法。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；`db.Transaction` 回调同样失败抛错、成功正常返回。
 * - Go 的 `(值, bool)` 返回译为 `[值, boolean]` 元组。
 * - Go 的 `gorm` 链式调用按原样保留；`errors.Is` 译为 `===`；`time.Time` 零值译为 `null`。
 * - Go 的 `map[string]bool` 译为普通对象 `{}`；Go 按值传参的结构体在需要修改副本时显式浅拷贝。
 */

"use strict";

const path = require("node:path");
const { Buffer } = require("node:buffer");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { AgentDefinition, ExecutorDefinition, BaselineAlignAgentID } = require("../domain/agent.js"); // 对应 Go 的 domain.AgentDefinition 等，agent.js 已翻译
const { RuleDefinition, SkillDefinition, MCPServerDefinition, SandboxProfile, SandboxDriverLocal, SandboxDriverNative, SandboxDriverDocker, SandboxDriverSeatbelt, SandboxDriverBwrap, ValidateMCPServer, ValidateEnvironmentVariables, ValidateSandboxAssets } = require("../domain/assets.js"); // 对应 Go 的 domain.*，assets.js 已翻译
const { KeepCatalogProjectID } = require("../domain/catalog.js"); // 对应 Go 的 domain.KeepCatalogProjectID，catalog.js 已翻译
const { WorkflowDefinition, DefinitionRevision, ValidateWorkflowMetricStages } = require("../domain/workflow.js"); // 对应 Go 的 domain.*，workflow.js 已翻译
const { ValidateWorkflowPreparation } = require("../domain/workspace_preparation.js"); // 对应 Go 的 domain.ValidateWorkflowPreparation，workspace_preparation.js 已翻译
const { Repository } = require("../domain/project.js"); // 对应 Go 的 domain.Repository，project.js 已翻译
const { SyncConfig, ScheduleJob } = require("../domain/sync.js"); // 对应 Go 的 domain.*，sync.js 已翻译
const { CloneNotificationBindings } = require("../domain/notification_template.js"); // 对应 Go 的 domain.CloneNotificationBindings，notification_template.js 已翻译
const { payloadList, payloadOne, upsert, mustJSON, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { normalizeRefs, CatalogRepo } = require("./repo.js"); // 对应 Go 同包函数与类型，repo.js 已翻译
const { isZeroTime, timeMs, zeroTimeDate } = require("./analytics.js"); // 对应 Go 的时间比较，analytics.js 已翻译
const { GenericDockerSandbox } = require("./generic_docker.js"); // 对应 Go 同包函数，generic_docker.js 已翻译
const { DefaultSandboxProfileID } = require("./sandbox_defaults.js"); // 对应 Go 同包常量，sandbox_defaults.js 已翻译
const { GenericBackendDeliveryWorkflowID, GenericProductDeliveryWorkflowID, GenericFrontendDeliveryWorkflowID } = require("./generic_workflows.js"); // 对应 Go 同包常量，generic_workflows.js 已翻译
const { mysqlSyncConfigID, scheduleJobRow, skillFileRow, mcpFileRow, scheduleJobExecutionStatRow } = require("./models.js"); // 对应 Go 同包类型与常量，models.js 已翻译

/**
 * 返回定时基线对齐专用的全平台共享角色定义。
 * 用于将默认分支合入集成分支并解决冲突的场景，不配置项目钩子或问题修复验证门禁。
 *
 * @returns {AgentDefinition} 平台内置的基线对齐执行员角色定义对象。
 */
function BaselineAlignResolverAgent() {
  return new AgentDefinition({
    ID: BaselineAlignAgentID,
    Name: "基线对齐执行员",
    Version: 1,
    ProjectID: "platform",
    Shared: true,
    Description: "全平台共用：把默认分支合入集成分支并解决冲突。不跑项目测试，不写修复报告，不发 MR。",
    Prompt: "你只做基线对齐，不是需求修复。\n1. 在当前工作分支执行 git fetch 并 merge 默认分支\n2. 逐块解决冲突，保留双方有效实现；拿不准时选对业务影响更小的一侧并在提交说明里写清\n3. git add 冲突文件并创建合并提交，提交说明列出冲突文件与取舍\n4. 不要 push，不要改默认分支，不要跑项目单测或 E2E，不要写 fix-plan.md / fix-report.md / review-report.md\n5. 结束后用几句话说明每个冲突文件的取舍即可",
  });
}

// ---------- Agents ----------

/**
 * 查询全部已存储的角色定义列表，按角色名称升序排列。
 * 用于角色目录列表展示及工作流节点角色解析。
 *
 * @returns {AgentDefinition[]} 按 `Name` 升序排列的角色定义数组。
 */
CatalogRepo.prototype.Agents = function () {
  const out = payloadList(AgentDefinition, this.DB, "agents", "");
  out.sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0));
  return out;
};

/**
 * 按主键 ID 读取单条角色定义。
 * 用于查看角色详情、更新前读取旧版本以及工作流运行时加载角色。
 *
 * @param {string} id - 角色唯一标识。
 * @returns {[AgentDefinition, boolean]} 返回 `[角色定义实例, 是否找到]`；未找到时返回 `[空角色实例, false]`。
 */
CatalogRepo.prototype.Agent = function (id) {
  return payloadOne(AgentDefinition, this.DB, "agents", id);
};

/**
 * 校验并持久化保存角色定义（新增或覆盖更新）。
 * 依次校验基础必填字段、循环配置、产物输出契约、人工介入点与钩子脚本；覆盖更新已有角色时会保留归属项目并写入历史版本快照。
 *
 * @param {AgentDefinition} v - 待保存的角色定义对象。
 * @returns {void} 无返回值。
 * @throws {Error} 字段校验失败、历史快照写入失败或数据库持久化失败时抛出错误。
 */
CatalogRepo.prototype.PutAgent = function (v) {
  if (v.ID.trim() === "" || v.Name.trim() === "") {
    throw new Error("agent id and name are required");
  }
  if (v.Loop.Enabled) {
    if (v.Loop.MaxIterations < 1 || v.Loop.MaxIterations > 12) {
      throw new Error("agent loop maxIterations must be between 1 and 12");
    }
    if (v.Loop.ExitCondition === "") {
      v.Loop.ExitCondition = "all_gates_pass";
    }
  }
  for (const output of v.ArtifactOutputs) {
    const clean = path.normalize(output.Path.trim());
    if (output.Name === "" || clean === "." || path.isAbsolute(clean) || clean === ".." || clean.startsWith(".." + path.sep)) {
      throw new Error(`invalid agent artifact contract "${output.Name}"`);
    }
  }
  const validStages = { before_execution: true, after_execution: true, before_publish: true, on_failure: true };
  for (const point of v.Interventions) {
    if (point.ID === "" || point.Name === "" || !validStages[point.Stage]) {
      throw new Error(`invalid agent intervention point "${point.ID}"`);
    }
  }
  const validHookEvents = { SessionStart: true, UserPromptSubmit: true, PreToolUse: true, PostToolUse: true, Stop: true };
  const hookIDs = {};
  for (let index = 0; index < v.Hooks.length; index++) {
    const hook = v.Hooks[index];
    hook.ID = hook.ID.trim();
    hook.Name = hook.Name.trim();
    hook.Event = hook.Event.trim();
    hook.Language = hook.Language.trim().toLowerCase();
    hook.Script = hook.Script.trim();
    if (hook.ID === "" || hook.ID === "." || hook.ID === ".." || path.basename(hook.ID) !== hook.ID || /[ \\/]/.test(hook.ID)) {
      throw new Error(`invalid agent hook id "${hook.ID}"`);
    }
    if (hookIDs[hook.ID]) {
      throw new Error(`duplicate agent hook "${hook.ID}"`);
    }
    hookIDs[hook.ID] = true;
    if (hook.Name === "" || !validHookEvents[hook.Event]) {
      throw new Error(`invalid agent hook "${hook.ID}"`);
    }
    if (hook.Language !== "shell" && hook.Language !== "python") {
      throw new Error(`agent hook "${hook.ID}" has invalid language "${hook.Language}"`);
    }
    if (hook.Script === "") {
      throw new Error(`agent hook "${hook.ID}" script is required`);
    }
    if (hook.TimeoutSec === 0) {
      hook.TimeoutSec = 10;
    }
    if (hook.TimeoutSec < 1 || hook.TimeoutSec > 600) {
      throw new Error(`agent hook "${hook.ID}" timeoutSec must be between 1 and 600`);
    }
  }
  v.UpdatedAt = new Date();
  v.Rules = normalizeRefs(v.Rules, "rules/");
  v.Skills = normalizeRefs(v.Skills, "skills/");
  const [old, ok] = this.Agent(v.ID);
  if (ok) {
    v.ProjectID = KeepCatalogProjectID(v.ProjectID, old.ProjectID);
    this.snapshotRevision("agent", old.ID, old.Name, old.Version, 0, old);
  }
  upsert(this.DB, "agents", {
    id: v.ID, name: v.Name, payload: mustJSON(v), updated_at: timePtr(v.UpdatedAt),
  });
};

// ---------- Rules / Skills / MCP servers ----------

/**
 * 查询全部规则定义，按优先级从高到低排序。
 * 用于规则目录列表及角色执行时按优先级拼装规则上下文。
 *
 * @returns {RuleDefinition[]} 按 `Priority` 降序排列的规则定义数组。
 */
CatalogRepo.prototype.Rules = function () {
  const out = payloadList(RuleDefinition, this.DB, "rules", "");
  out.sort((a, b) => b.Priority - a.Priority);
  return out;
};

/**
 * 按主键 ID 读取单条规则定义。
 *
 * @param {string} id - 规则唯一标识。
 * @returns {[RuleDefinition, boolean]} 返回 `[规则定义实例, 是否找到]`。
 */
CatalogRepo.prototype.Rule = function (id) {
  return payloadOne(RuleDefinition, this.DB, "rules", id);
};

/**
 * 新增或更新单条规则定义，并刷新其 `UpdatedAt` 时间戳。
 *
 * @param {RuleDefinition} v - 待保存的规则定义对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
CatalogRepo.prototype.PutRule = function (v) {
  v.UpdatedAt = new Date();
  upsert(this.DB, "rules", {
    id: v.ID, name: v.Name, payload: mustJSON(v), updated_at: timePtr(v.UpdatedAt),
  });
};

/**
 * 按 ID 删除单条规则定义；若规则不存在则抛出未找到错误。
 *
 * @param {string} id - 待删除的规则 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 规则不存在或数据库删除失败时抛出错误。
 */
CatalogRepo.prototype.DeleteRule = function (id) {
  const [, ok] = this.Rule(id);
  if (!ok) {
    throw new Error("rule not found");
  }
  const err = this.DB.Table("rules").Where("id = ?", id).Delete(null).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 查询全部已存储的技能定义列表。
 *
 * @returns {SkillDefinition[]} 技能定义数组。
 */
CatalogRepo.prototype.Skills = function () {
  return payloadList(SkillDefinition, this.DB, "skills", "");
};

/**
 * 按主键 ID 读取单条技能定义。
 *
 * @param {string} id - 技能唯一标识。
 * @returns {[SkillDefinition, boolean]} 返回 `[技能定义实例, 是否找到]`。
 */
CatalogRepo.prototype.Skill = function (id) {
  return payloadOne(SkillDefinition, this.DB, "skills", id);
};

/**
 * 新增或更新单条技能定义，并刷新其 `UpdatedAt` 时间戳。
 *
 * @param {SkillDefinition} v - 待保存的技能定义对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
CatalogRepo.prototype.PutSkill = function (v) {
  v.UpdatedAt = new Date();
  upsert(this.DB, "skills", {
    id: v.ID, name: v.Name, payload: mustJSON(v), updated_at: timePtr(v.UpdatedAt),
  });
};

/**
 * 在事务内删除指定技能定义及其关联的技能二进制文件行。
 * 若技能不存在则直接抛出错误。
 *
 * @param {string} id - 待删除的技能 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 技能不存在或事务内删除失败时抛出错误。
 */
CatalogRepo.prototype.DeleteSkill = function (id) {
  const [, ok] = this.Skill(id);
  if (!ok) {
    throw new Error("skill not found");
  }
  this.DB.Transaction((tx) => {
    const fileErr = tx.Where("skill_id = ?", id).Delete(new skillFileRow()).Error;
    if (fileErr != null) {
      throw fileErr;
    }
    const err = tx.Table("skills").Where("id = ?", id).Delete(null).Error;
    if (err != null) {
      throw err;
    }
  });
};

/**
 * 查询全部已存储的 MCP 服务器定义列表。
 *
 * @returns {MCPServerDefinition[]} MCP 服务器定义数组。
 */
CatalogRepo.prototype.MCPServers = function () {
  return payloadList(MCPServerDefinition, this.DB, "mcp_servers", "");
};

/**
 * 按主键 ID 读取单条 MCP 服务器定义。
 *
 * @param {string} id - MCP 服务器唯一标识。
 * @returns {[MCPServerDefinition, boolean]} 返回 `[MCP 定义实例, 是否找到]`。
 */
CatalogRepo.prototype.MCPServer = function (id) {
  return payloadOne(MCPServerDefinition, this.DB, "mcp_servers", id);
};

/**
 * 校验并保存 MCP 服务器定义。
 * 当调用方省略 `FileRefs`（为 `null`）时，自动继承已有记录的文件清单，避免旧客户端更新定义时孤立已上传文件。
 *
 * @param {MCPServerDefinition} v - 待保存的 MCP 服务器定义对象。
 * @returns {void} 无返回值。
 * @throws {Error} MCP 配置校验不通过或数据库写入失败时抛出错误。
 */
CatalogRepo.prototype.PutMCPServer = function (v) {
  // 上传的文件内容和清单由 mcp_files API 维护；仅更新定义时若旧客户端未传 fileRefs，不得清空已有清单。
  if (v.FileRefs == null) {
    const [existing, ok] = this.MCPServer(v.ID);
    if (ok) {
      v.FileRefs = existing.FileRefs;
    }
  }
  ValidateMCPServer(v);
  v.UpdatedAt = new Date();
  upsert(this.DB, "mcp_servers", {
    id: v.ID, name: v.Name, payload: mustJSON(v), updated_at: timePtr(v.UpdatedAt),
  });
};

/**
 * 在事务内删除指定 MCP 服务器定义及其关联的二进制文件记录。
 *
 * @param {string} id - 待删除的 MCP 服务器 ID。
 * @returns {void} 无返回值。
 * @throws {Error} MCP 不存在或事务内删除失败时抛出错误。
 */
CatalogRepo.prototype.DeleteMCPServer = function (id) {
  const [, ok] = this.MCPServer(id);
  if (!ok) {
    throw new Error("MCP not found");
  }
  this.DB.Transaction((tx) => {
    const fileErr = tx.Where("mcp_id = ?", id).Delete(new mcpFileRow()).Error;
    if (fileErr != null) {
      throw fileErr;
    }
    const err = tx.Table("mcp_servers").Where("id = ?", id).Delete(null).Error;
    if (err != null) {
      throw err;
    }
  });
};

/**
 * 按 ID 删除单条角色定义；若角色不存在则抛出未找到错误。
 *
 * @param {string} id - 待删除的角色 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 角色不存在或数据库删除失败时抛出错误。
 */
CatalogRepo.prototype.DeleteAgent = function (id) {
  const [, ok] = payloadOne(AgentDefinition, this.DB, "agents", id);
  if (!ok) {
    throw new Error("agent not found");
  }
  const err = this.DB.Table("agents").Where("id = ?", id).Delete(null).Error;
  if (err != null) {
    throw err;
  }
};

// ---------- Executors ----------

/**
 * 查询数据库中持久化保存的全部执行器定义（用于历史快照与兼容）。
 *
 * @returns {ExecutorDefinition[]} 执行器定义数组。
 */
CatalogRepo.prototype.Executors = function () {
  return payloadList(ExecutorDefinition, this.DB, "executors", "");
};

/**
 * 按主键 ID 从数据库读取单条执行器定义。
 *
 * @param {string} id - 执行器 ID。
 * @returns {[ExecutorDefinition, boolean]} 返回 `[执行器定义实例, 是否找到]`。
 */
CatalogRepo.prototype.Executor = function (id) {
  return payloadOne(ExecutorDefinition, this.DB, "executors", id);
};

/**
 * 校验并写入单条执行器定义。
 *
 * @param {ExecutorDefinition} v - 待保存的执行器定义对象。
 * @returns {void} 无返回值。
 * @throws {Error} 缺少必填的 `ID`、`Name`、`Kind` 或数据库写入失败时抛出错误。
 */
CatalogRepo.prototype.PutExecutor = function (v) {
  if (v.ID.trim() === "" || v.Name.trim() === "" || v.Kind.trim() === "") {
    throw new Error("executor id, name and kind are required");
  }
  upsert(this.DB, "executors", {
    id: v.ID, name: v.Name, kind: v.Kind, payload: mustJSON(v),
  });
};

/**
 * 返回平台内置的全部可选 CLI 执行器目录。
 * 持久化表中的执行器仅作历史快照兼容，运行时可选目录以此列表为准。
 *
 * @returns {ExecutorDefinition[]} 内置执行器定义数组。
 */
function BuiltInExecutors() {
  return [
    new ExecutorDefinition({ ID: "codebuddy", Name: "CodeBuddy", Kind: "codebuddy", Binary: "codebuddy", Args: ["-p", "--output-format", "stream-json", "--include-partial-messages", "-y", "--setting-sources", "none"], Protocol: "stream-json" }),
    new ExecutorDefinition({ ID: "codex", Name: "Codex", Kind: "codex", Binary: "codex", Args: ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check"], Protocol: "jsonl" }),
    new ExecutorDefinition({ ID: "claude", Name: "Claude Code", Kind: "claude-code", Binary: "claude", Args: ["-p", "--output-format", "stream-json", "--permission-mode", "dontAsk"], Protocol: "stream-json" }),
    new ExecutorDefinition({ ID: "opencode", Name: "OpenCode", Kind: "opencode", Binary: "opencode", Protocol: "stream-json" }),
    new ExecutorDefinition({ ID: "cursor", Name: "Cursor CLI", Kind: "cursor", Binary: "cursor-agent", Protocol: "stream-json" }),
    new ExecutorDefinition({ ID: "agy", Name: "Antigravity", Kind: "agy", Binary: "agy", Protocol: "stream-json" }),
    new ExecutorDefinition({ ID: "kimi", Name: "Kimi Code", Kind: "kimi", Binary: "kimi", Protocol: "stream-json" }),
    new ExecutorDefinition({ ID: "pi", Name: "Pi", Kind: "pi", Binary: "pi", Protocol: "stream-json" }),
    new ExecutorDefinition({ ID: "dsh", Name: "DeepSeek Harness", Kind: "dsh", Binary: "dsh", Protocol: "stream-json" }),
    new ExecutorDefinition({ ID: "zcode", Name: "ZCode", Kind: "zcode", Binary: "zcode", Protocol: "stream-json" }),
  ];
}

/**
 * 按执行器 ID 在内置执行器目录中查找对应定义。
 *
 * @param {string} id - 执行器 ID（首尾空白会被忽略）。
 * @returns {[ExecutorDefinition, boolean]} 返回 `[匹配的执行器实例, 是否找到]`。
 */
function BuiltInExecutor(id) {
  for (const executor of BuiltInExecutors()) {
    if (executor.ID === id.trim()) {
      return [executor, true];
    }
  }
  return [new ExecutorDefinition(), false];
}

/**
 * 按执行器类型标识 `Kind` 在内置执行器目录中查找对应定义。
 *
 * @param {string} kind - 执行器类型标识（首尾空白会被忽略）。
 * @returns {[ExecutorDefinition, boolean]} 返回 `[匹配的执行器实例, 是否找到]`。
 */
function BuiltInExecutorForKind(kind) {
  for (const executor of BuiltInExecutors()) {
    if (executor.Kind === kind.trim()) {
      return [executor, true];
    }
  }
  return [new ExecutorDefinition(), false];
}

// ---------- Sandboxes ----------

/**
 * 查询全部可用的沙箱配置列表。
 * 过滤掉占用平台默认 ID 的非平台项目行，规范化平台默认沙箱与历史 `local` 驱动；若结果中不含默认沙箱则补齐内置默认沙箱。
 *
 * @returns {SandboxProfile[]} 规整后的沙箱配置档案数组。
 */
CatalogRepo.prototype.Sandboxes = function () {
  let profiles = payloadList(SandboxProfile, this.DB, "sandboxes", "");
  profiles = profiles.filter((profile) => !(isDefaultSandboxID(profile.ID) && !platformSandboxOwner(profile.ProjectID)));
  for (let i = 0; i < profiles.length; i++) {
    profiles[i] = platformSandboxProfile(profiles[i]);
  }
  for (const profile of profiles) {
    if (profile.ID === DefaultSandboxProfileID) {
      return profiles;
    }
  }
  const [profile, ok] = this.Sandbox(DefaultSandboxProfileID);
  if (ok) {
    profiles.push(profile);
  }
  return profiles;
};

/**
 * 按 ID 解析单条沙箱配置。
 * 对平台默认沙箱 ID（含 MySQL 排序规则等价 ID），在记录缺失或被非平台行占用时回退为内置 `GenericDockerSandbox()`；
 * 数据库故障或载荷损坏时不静默回退，直接返回未找到。
 *
 * @param {string} id - 沙箱配置 ID。
 * @returns {[SandboxProfile, boolean]} 返回 `[沙箱配置实例, 是否找到]`。
 */
CatalogRepo.prototype.Sandbox = function (id) {
  const isDefault = isDefaultSandboxID(id);
  if (isDefault) {
    id = DefaultSandboxProfileID;
  }
  let profile = new SandboxProfile();
  const row = { Payload: null, PlatformDefault: false };
  const err = this.DB.Table("sandboxes").Select("payload, id = ? AS platform_default", DefaultSandboxProfileID).
    Where("id = ?", id).Take(row).Error;
  // 记录缺失时允许回退内置默认沙箱；数据库故障或损坏的配置不得静默切换执行策略。
  if (err === gorm.ErrRecordNotFound) {
    try {
      if (this.IsReservedSandboxID(id)) {
        return [GenericDockerSandbox(), true];
      }
    } catch {
      // 查询保留标识失败时不回退默认沙箱。
    }
    return [new SandboxProfile(), false];
  }
  if (err != null) {
    return [new SandboxProfile(), false];
  }
  let unmarshalErr = null;
  try {
    profile = new SandboxProfile(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
  } catch (e) {
    unmarshalErr = e;
  }
  if (unmarshalErr != null) {
    return [new SandboxProfile(), false];
  }
  if (isDefault || row.PlatformDefault) {
    if (!platformSandboxOwner(profile.ProjectID)) {
      // 待迁移安装中若存在同名项目沙箱，不得覆盖平台级默认沙箱。
      return [GenericDockerSandbox(), true];
    }
    profile.ID = DefaultSandboxProfileID;
  }
  return [platformSandboxProfile(profile), true];
};

/**
 * 判断给定 ID（忽略首尾空白与大小写）是否为平台默认沙箱 ID。
 *
 * @param {string} id - 待判断的沙箱 ID。
 * @returns {boolean} 匹配平台默认沙箱 ID 时返回 `true`，否则返回 `false`。
 */
function isDefaultSandboxID(id) {
  return id.trim().toLowerCase() === DefaultSandboxProfileID.toLowerCase();
}

/**
 * 判断给定 ID 是否为平台保留默认沙箱 ID（含 MySQL `utf8mb4_unicode_ci` 排序规则下的等价字符串）。
 * 用于防止项目级沙箱抢占平台默认沙箱主键以及禁止删除默认沙箱。
 *
 * @param {string} id - 待检查的沙箱 ID。
 * @returns {boolean} 属于保留默认 ID 时返回 `true`，否则返回 `false`。
 * @throws {Error} MySQL 等价性查询执行失败时抛出错误。
 */
CatalogRepo.prototype.IsReservedSandboxID = function (id) {
  if (isDefaultSandboxID(id)) {
    return true;
  }
  if (id === "" || !this.isMySQL()) {
    return false;
  }
  let reserved = false;
  const err = this.DB.Raw("SELECT CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci = ?", id, DefaultSandboxProfileID).Scan(reserved).Error;
  if (err != null) {
    throw err;
  }
  return reserved;
};

/**
 * 判断沙箱配置归属项目 ID 是否属于平台默认所有者（数据库存储中平台默认行 `projectID` 为空串）。
 *
 * @param {string} projectID - 沙箱记录的 `ProjectID` 字段。
 * @returns {boolean} 为平台默认所有者返回 `true`，否则返回 `false`。
 */
function platformSandboxOwner(projectID) {
  return projectID === "";
}

/**
 * 规整读取出的平台默认沙箱与历史 `local` 驱动沙箱。
 * 保持平台默认通用 Docker 沙箱始终为共享状态，并将遗留的 `local` 驱动映射为 `native`。
 *
 * @param {SandboxProfile} profile - 从数据库解码的沙箱配置对象。
 * @returns {SandboxProfile} 规整后的沙箱配置对象。
 */
function platformSandboxProfile(profile) {
  if (isDefaultSandboxID(profile.ID) && platformSandboxOwner(profile.ProjectID)) {
    profile.ID = DefaultSandboxProfileID;
    profile.ProjectID = "platform";
    profile.Shared = true;
  }
  if (profile.Driver.trim() === SandboxDriverLocal) {
    profile = normalizeSandboxProfile(profile);
  }
  return profile;
}

/**
 * 校验并持久化保存沙箱配置档案。
 * 禁止非平台项目占用默认沙箱 ID，拒绝已移除的 `local` 驱动，并校验环境变量与资产配方后落盘。
 *
 * @param {SandboxProfile} v - 待保存的沙箱配置对象。
 * @returns {void} 无返回值。
 * @throws {Error} 参数校验失败、保留 ID 冲突、资产或环境变量非法或数据库写入失败时抛出错误。
 */
CatalogRepo.prototype.PutSandbox = function (v) {
  if (v.ID.trim() === "" || v.Name.trim() === "") {
    throw new Error("sandbox id and name are required");
  }
  const reserved = this.IsReservedSandboxID(v.ID);
  if (reserved) {
    if (v.ProjectID !== "" && v.ProjectID !== "platform") {
      throw new Error(`沙箱标识 ${DefaultSandboxProfileID} 保留给平台默认沙箱`);
    }
    v.ID = DefaultSandboxProfileID;
    v.ProjectID = "";
  }
  try {
    ValidateEnvironmentVariables(v.Environment);
  } catch (envErr) {
    throw new Error(`sandbox environment: ${envErr.message}`);
  }
  if (v.Driver.trim() === SandboxDriverLocal) {
    throw new Error("local 沙箱已移除，请改用 native 沙箱");
  }
  const stored = normalizeSandboxProfile(v);
  ValidateSandboxAssets(stored);
  upsert(this.DB, "sandboxes", {
    id: stored.ID, name: stored.Name, payload: mustJSON(stored),
  });
};

/**
 * 按 ID 删除自定义沙箱配置；平台默认运行沙箱禁止删除。
 *
 * @param {string} id - 待删除的沙箱 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 尝试删除平台默认沙箱、沙箱不存在或数据库删除失败时抛出错误。
 */
CatalogRepo.prototype.DeleteSandbox = function (id) {
  const reserved = this.IsReservedSandboxID(id);
  if (reserved) {
    throw new Error("默认运行沙箱不能删除；可编辑配置或新建其他沙箱");
  }
  const [, ok] = this.Sandbox(id);
  if (!ok) {
    throw new Error("sandbox not found");
  }
  const err = this.DB.Table("sandboxes").Where("id = ?", id).Delete(null).Error;
  if (err != null) {
    throw err;
  }
};

// ---------- Workflows ----------

/**
 * 列出全部项目 SOP 与已存储的通用模板工作流。
 * 先过滤掉与通用模板 ID 冲突的物理表遗留行，对物理表工作流按 `UpdatedAt` 降序排列，再将通用模板恒追加在列表尾部。
 *
 * @returns {WorkflowDefinition[]} 合并排序后的工作流定义数组。
 */
CatalogRepo.prototype.Workflows = function () {
  const generic = this.GenericWorkflows();
  const reserved = {};
  for (const template of generic) {
    reserved[template.ID] = true;
  }
  const stored = payloadList(WorkflowDefinition, this.DB, "workflows", "");
  const out = [];
  for (let workflow of stored) {
    workflow = normalizeWorkflowDefinition(workflow);
    if (reserved[workflow.ID]) {
      continue;
    }
    out.push(workflow);
  }
  out.sort((a, b) => timeMs(b.UpdatedAt) - timeMs(a.UpdatedAt));
  return out.concat(generic);
};

/**
 * 按 ID 解析自定义 SOP 或通用模板工作流。
 * 通用模板优先于同 ID 的物理表行，确保遗留冲突行不会遮蔽平台通用模板。
 *
 * @param {string} id - 工作流唯一标识。
 * @returns {[WorkflowDefinition, boolean]} 返回 `[工作流定义实例, 是否找到]`。
 */
CatalogRepo.prototype.Workflow = function (id) {
  const [wf, ok] = this.GenericWorkflowByID(id);
  if (ok) {
    return [wf, true];
  }
  const [workflow, found] = payloadOne(WorkflowDefinition, this.DB, "workflows", id);
  if (!found) {
    return [new WorkflowDefinition(), false];
  }
  return [normalizeWorkflowDefinition(workflow), found];
};

/**
 * 仅从物理 `workflows` 表读取工作流定义，不走通用模板回退。
 * 供写路径（保存、发布、删除）用于存在性检查，避免与通用模板修订号冲突。
 *
 * @param {string} id - 工作流唯一标识。
 * @returns {[WorkflowDefinition, boolean]} 返回 `[物理表工作流实例, 是否找到]`。
 */
CatalogRepo.prototype.storedWorkflow = function (id) {
  const [workflow, ok] = payloadOne(WorkflowDefinition, this.DB, "workflows", id);
  if (!ok) {
    return [new WorkflowDefinition(), false];
  }
  return [normalizeWorkflowDefinition(workflow), ok];
};

/**
 * 保存自定义工作流定义（非发布写路径）。
 *
 * @param {WorkflowDefinition} v - 待保存的工作流定义对象。
 * @returns {void} 无返回值。
 * @throws {Error} 校验失败、修订号冲突或数据库写入失败时抛出错误。
 */
CatalogRepo.prototype.PutWorkflow = function (v) {
  this.putWorkflow(v, false);
};

/**
 * 序列化工作流的核心业务内容（清零修订号与时间戳），用于判断两次保存之间是否存在实质内容变更。
 *
 * @param {WorkflowDefinition} v - 待比较的工作流定义对象。
 * @returns {string} 剥离易变元数据后的 JSON 字符串。
 */
function workflowContent(v) {
  // Go 按值传参，调用方不受清零影响；JS 此处浅拷贝一份再清零。
  const copy = Object.assign(new WorkflowDefinition(), v);
  copy.Revision = 0;
  copy.PublishedRevision = 0;
  copy.CreatedAt = zeroTimeDate();
  copy.UpdatedAt = zeroTimeDate();
  return mustJSON(copy).toString("utf8");
}

/**
 * 返回工作流对应的已发布修订号；兼容早于 `PublishedRevision` 字段引入前的旧版已发布工作流。
 *
 * @param {WorkflowDefinition} v - 工作流定义对象。
 * @returns {number} 已发布修订号。
 */
function workflowPublishedRevision(v) {
  if (v.PublishedRevision === 0 && v.Status === "published") {
    return v.Revision; // 历史已发布定义尚未记录 PublishedRevision，按当前 Revision 处理。
  }
  return v.PublishedRevision;
}

/**
 * 判断工作流是否存在尚未发布的变更（状态非 `published` 或当前修订号与已发布修订号不一致）。
 *
 * @param {WorkflowDefinition} v - 工作流定义对象。
 * @returns {boolean} 需要发布时返回 `true`，否则返回 `false`。
 */
function workflowNeedsPublish(v) {
  return v.Status !== "published" || workflowPublishedRevision(v) !== v.Revision;
}

/**
 * 在事务行锁保护下发布指定的自定义工作流。
 * 发布具备幂等性：在保存内容再次修改之前重复发布直接返回当前版本而不自增版本号。
 *
 * @param {string} id - 待发布的工作流 ID。
 * @returns {WorkflowDefinition} 发布后的最新工作流定义。
 * @throws {Error} 工作流不存在、校验失败或事务执行失败时抛出错误。
 */
CatalogRepo.prototype.PublishWorkflow = function (id) {
  let published = new WorkflowDefinition();
  this.DB.Transaction((tx) => {
    const row = { ID: "" };
    const takeErr = this.locking(tx.Table("workflows")).Select("id").Where("id = ?", id).Take(row).Error;
    if (takeErr != null) {
      throw takeErr;
    }
    const catalog = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    catalog.DB = tx;
    catalog.deps = { ...this.deps, DB: tx };
    published = catalog.publishStoredWorkflow(id);
  });
  return published;
};

/**
 * 在当前数据库连接/事务上下文中执行单条物理表工作流的发布逻辑。
 * 由 `PublishWorkflow` 在持有行锁的事务内调用。
 *
 * @param {string} id - 待发布的工作流 ID。
 * @returns {WorkflowDefinition} 发布后的最新工作流定义。
 * @throws {Error} 工作流不存在或保存发布状态失败时抛出错误。
 */
CatalogRepo.prototype.publishStoredWorkflow = function (id) {
  const [v, ok] = this.storedWorkflow(id);
  if (!ok) {
    throw new Error("workflow not found");
  }
  if (!workflowNeedsPublish(v)) {
    return v;
  }
  v.Status = "published";
  v.Version++;
  this.putWorkflow(v, true);
  const [stored] = this.storedWorkflow(id);
  return stored;
};

/**
 * 执行工作流定义的完整校验、规范化、乐观并发修订号检查、历史快照归档与落盘写入。
 * 供 `PutWorkflow` 与 `publishStoredWorkflow` 复用。
 *
 * @param {WorkflowDefinition} v - 待保存的工作流定义对象。
 * @param {boolean} publishing - 是否处于发布流程；发布时即便内容未变也会推进修订号并更新 `PublishedRevision`。
 * @returns {void} 无返回值。
 * @throws {Error} 必填校验、准备/指标阶段校验、沙箱存在性校验、修订号冲突、通知绑定校验或写库失败时抛出错误。
 */
CatalogRepo.prototype.putWorkflow = function (v, publishing) {
  if (v.ID.trim() === "" || v.Name.trim() === "") {
    throw new Error("workflow id and name are required");
  }
  ValidateWorkflowPreparation(v);
  ValidateWorkflowMetricStages(v);
  v = normalizeWorkflowDefinition(v);
  const [, sandboxOk] = this.Sandbox(v.SandboxProfileID);
  if (!sandboxOk) {
    throw new Error(`sandbox profile "${v.SandboxProfileID}" not found`);
  }
  const now = new Date();
  const [old, ok] = this.storedWorkflow(v.ID);
  if (ok) {
    v.ProjectID = KeepCatalogProjectID(v.ProjectID, old.ProjectID);
    if (v.Revision !== old.Revision) {
      throw new Error(`workflow revision conflict: current revision is ${old.Revision}`);
    }
    if (!publishing && workflowContent(v) === workflowContent(old)) {
      return;
    }
    v.PublishedRevision = workflowPublishedRevision(old);
    v.Revision = old.Revision + 1;
    v.CreatedAt = old.CreatedAt;
    if (v.Version === 0) {
      v.Version = old.Version;
    }
  } else {
    v.PublishedRevision = 0;
    v.Revision = 1;
    v.CreatedAt = now;
    if (v.Version === 0) {
      v.Version = 1;
    }
  }
  this.validateWorkflowNotifications(v);
  if (v.Status === "") {
    v.Status = "draft";
  }
  if (publishing) {
    v.PublishedRevision = v.Revision;
  }
  v.UpdatedAt = now;
  if (ok) {
    this.snapshotRevision("workflow", old.ID, old.Name, old.Version, old.Revision, old);
  }
  upsert(this.DB, "workflows", {
    id: v.ID, name: v.Name, version: v.Version, revision: v.Revision, status: v.Status,
    payload: mustJSON(v), created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  });
};

/**
 * 删除物理表中的自定义 SOP 定义；历史运行记录持有独立的 `WorkflowSnapshot`，删除后仍可完整查看。
 *
 * @param {string} id - 待删除的工作流 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 工作流不存在或数据库删除失败时抛出错误。
 */
CatalogRepo.prototype.DeleteWorkflow = function (id) {
  const [, ok] = this.storedWorkflow(id);
  if (!ok) {
    throw new Error("workflow not found");
  }
  const err = this.DB.Table("workflows").Where("id = ?", id).Delete(null).Error;
  if (err != null) {
    throw err;
  }
};

// ---------- Repositories ----------

/**
 * 查询全部项目代码仓库定义，按 `ProjectID`、再按 `Name` 升序排列。
 *
 * @returns {Repository[]} 排序后的仓库定义数组。
 */
CatalogRepo.prototype.Repositories = function () {
  const out = payloadList(Repository, this.DB, "repositories", "");
  out.sort((a, b) => {
    if (a.ProjectID === b.ProjectID) {
      return a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0;
    }
    return a.ProjectID < b.ProjectID ? -1 : a.ProjectID > b.ProjectID ? 1 : 0;
  });
  return out;
};

/**
 * 按主键 ID 读取单条代码仓库定义。
 *
 * @param {string} id - 仓库唯一标识。
 * @returns {[Repository, boolean]} 返回 `[仓库定义实例, 是否找到]`。
 */
CatalogRepo.prototype.Repository = function (id) {
  return payloadOne(Repository, this.DB, "repositories", id);
};

/**
 * 新增或更新代码仓库定义，并校验其所属项目存在；更新时保留原 `CreatedAt`。
 *
 * @param {Repository} v - 待保存的仓库定义对象。
 * @returns {void} 无返回值。
 * @throws {Error} 所属项目不存在或数据库写入失败时抛出错误。
 */
CatalogRepo.prototype.PutRepository = function (v) {
  const [, ok] = this.projects.Project(v.ProjectID);
  if (!ok) {
    throw new Error("project not found");
  }
  const now = new Date();
  const [old, found] = this.Repository(v.ID);
  if (found) {
    v.CreatedAt = old.CreatedAt;
  } else {
    v.CreatedAt = now;
  }
  v.UpdatedAt = now;
  upsert(this.DB, "repositories", {
    id: v.ID, project_id: v.ProjectID, name: v.Name, payload: mustJSON(v),
    created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  });
};

/**
 * 按 ID 删除单条代码仓库记录。
 *
 * @param {string} id - 待删除的仓库 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库删除失败时抛出错误。
 */
CatalogRepo.prototype.DeleteRepository = function (id) {
  const err = this.DB.Table("repositories").Where("id = ?", id).Delete(null).Error;
  if (err != null) {
    throw err;
  }
};

// ---------- Sync config / Schedule jobs ----------

/**
 * 读取平台全局同步配置单行记录；不存在时返回零值 `SyncConfig`。
 *
 * @returns {SyncConfig} 当前同步配置对象。
 */
CatalogRepo.prototype.SyncConfig = function () {
  const [cfg] = payloadOne(SyncConfig, this.DB, "sync_config", mysqlSyncConfigID);
  return cfg;
};

/**
 * 保存平台全局同步配置，并保留已有的 `PlaybookSeedRev` 字段不被覆盖。
 *
 * @param {SyncConfig} cfg - 待写入的同步配置对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
CatalogRepo.prototype.PutSyncConfig = function (cfg) {
  const current = this.SyncConfig();
  cfg.PlaybookSeedRev = current.PlaybookSeedRev;
  upsert(this.DB, "sync_config", {
    id: mysqlSyncConfigID, payload: mustJSON(cfg), updated_at: timePtr(new Date()),
  });
};

/**
 * 查询全部定时任务定义，按任务名称升序排列。
 *
 * @returns {ScheduleJob[]} 排序后的定时任务数组。
 */
CatalogRepo.prototype.ScheduleJobs = function () {
  const out = payloadList(ScheduleJob, this.DB, "schedule_jobs", "");
  out.sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0));
  return out;
};

/**
 * 按主键 ID 读取单条定时任务定义。
 *
 * @param {string} id - 定时任务 ID。
 * @returns {[ScheduleJob, boolean]} 返回 `[定时任务实例, 是否找到]`。
 */
CatalogRepo.prototype.ScheduleJob = function (id) {
  return payloadOne(ScheduleJob, this.DB, "schedule_jobs", id);
};

/**
 * 在事务行锁内创建或更新定时任务。
 * 校验通知绑定、维护创建/更新时间与最小间隔、在进入运行态时刷新通知快照，并在任务从运行态结束为成功/失败时将完成通知入队。
 *
 * @param {ScheduleJob} v - 待保存的定时任务对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库读取/解码失败、通知绑定校验失败、写入失败或通知入队失败时抛出错误。
 */
CatalogRepo.prototype.PutScheduleJob = function (v) {
  this.DB.Transaction((tx) => {
    const row = new scheduleJobRow();
    let old = new ScheduleJob();
    const err = this.locking(tx).Where("id = ?", v.ID).First(row).Error;
    if (err == null) {
      old = new ScheduleJob(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
    } else if (err !== gorm.ErrRecordNotFound) {
      throw err;
    }
    if (!(old.LastStatus === "running" && v.LastStatus !== "running")) {
      this.notifications.validateNotificationBindings(tx, v.ProjectID, v.Notifications, true);
    }
    const now = new Date();
    if (old.ID !== "") {
      v.CreatedAt = old.CreatedAt;
    } else {
      v.CreatedAt = now;
    }
    v.UpdatedAt = now;
    if (v.Cron.trim() === "" && v.IntervalSec < 30) {
      v.IntervalSec = 30;
    }
    v.NotificationSnapshot = CloneNotificationBindings(old.NotificationSnapshot);
    if (v.LastStatus === "running" && (old.LastStatus !== "running" || timeMs(old.LastRunAt) !== timeMs(v.LastRunAt))) {
      v.NotificationSnapshot = CloneNotificationBindings(v.Notifications);
    }
    let enabled = 0;
    if (v.Enabled) {
      enabled = 1;
    }
    upsert(tx, "schedule_jobs", { id: v.ID, name: v.Name, enabled: enabled, payload: mustJSON(v), updated_at: timePtr(v.UpdatedAt) });
    const trigger = { success: "succeeded", failed: "failed" }[v.LastStatus] ?? "";
    if (old.ID !== "" && old.LastStatus === "running" && trigger !== "" && !isZeroTime(v.LastRunAt)) {
      let result = v.NotificationResult;
      if (result === "") {
        result = v.LastAssistantMessage;
      }
      this.notifications.enqueueTaskNotifications(tx, "schedule_job", v.ID, v.ProjectID, v.Name, trigger, v.LastRunAt, old.NotificationSnapshot, result, v.LastError);
    }
  });
};

/**
 * 仅在行锁保护下切换定时任务的启用开关，不改动其余配置与进行中的执行结果。
 *
 * @param {string} id - 定时任务 ID。
 * @param {boolean} enabled - 目标启用状态。
 * @returns {ScheduleJob} 更新开关后的定时任务定义。
 * @throws {Error} 任务不存在、载荷解码失败或数据库更新失败时抛出错误。
 */
CatalogRepo.prototype.SetScheduleJobEnabled = function (id, enabled) {
  let out = new ScheduleJob();
  this.DB.Transaction((tx) => {
    const row = new scheduleJobRow();
    const firstErr = this.locking(tx).Where("id = ?", id).First(row).Error;
    if (firstErr != null) {
      throw firstErr;
    }
    out = new ScheduleJob(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
    out.Enabled = enabled;
    out.UpdatedAt = new Date();
    let flag = 0;
    if (enabled) {
      flag = 1;
    }
    const updateErr = tx.Model(row).Updates({ enabled: flag, payload: mustJSON(out), updated_at: timePtr(out.UpdatedAt) }).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
  return out;
};

// 当存储中的定时任务与调用方此前检查的状态不一致（如已被他人修改或移动项目）时抛出的冲突错误。
const ErrScheduleJobChanged = new Error("任务已被其他人修改或移动，请刷新后重试");

/**
 * 在事务行锁内校验定时任务未被修改后将其停用，并返回更新后的任务定义。
 * 仅当 `unchanged(current)` 返回 `true` 时执行停用，否则抛出 `ErrScheduleJobChanged`。
 *
 * @param {string} id - 定时任务 ID。
 * @param {function(ScheduleJob): boolean} unchanged - 用于核对当前行是否仍与调用方预期一致的判定函数。
 * @returns {ScheduleJob} 已停用的定时任务定义。
 * @throws {Error} 记录不存在或已变更（`ErrScheduleJobChanged`）、解码失败或更新失败时抛出错误。
 */
CatalogRepo.prototype.DisableScheduleJob = function (id, unchanged) {
  let current = new ScheduleJob();
  this.DB.Transaction((tx) => {
    const row = new scheduleJobRow();
    const firstErr = this.locking(tx).Where("id = ?", id).First(row).Error;
    if (firstErr === gorm.ErrRecordNotFound) {
      throw ErrScheduleJobChanged;
    }
    if (firstErr != null) {
      throw firstErr;
    }
    current = new ScheduleJob(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
    if (!unchanged(current)) {
      throw ErrScheduleJobChanged;
    }
    current.Enabled = false;
    current.UpdatedAt = new Date();
    const updateErr = tx.Model(row).Updates({ enabled: 0, payload: mustJSON(current), updated_at: timePtr(current.UpdatedAt) }).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
  return current;
};

/**
 * 在事务内删除指定定时任务及其全部执行记录和执行统计行。
 *
 * @param {string} id - 待删除的定时任务 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 定时任务不存在或事务内删除失败时抛出错误。
 */
CatalogRepo.prototype.DeleteScheduleJob = function (id) {
  const [, ok] = this.ScheduleJob(id);
  if (!ok) {
    throw new Error("schedule job not found");
  }
  this.DB.Transaction((tx) => {
    let err = tx.Table("schedule_job_executions").Where("job_id = ?", id).Delete(null).Error;
    if (err != null) {
      throw err;
    }
    err = tx.Where("job_id = ?", id).Delete(new scheduleJobExecutionStatRow()).Error;
    if (err != null) {
      throw err;
    }
    err = tx.Table("schedule_jobs").Where("id = ?", id).Delete(null).Error;
    if (err != null) {
      throw err;
    }
  });
};

// ---------- Definition revisions ----------

// 每个定义实体最多保留的历史版本快照数量上限。
const maxRevisionsPerEntity = 20;

/**
 * 在覆盖保存角色或工作流前，将旧版本归档至 `definition_revisions` 表，并按上限清理超出 `maxRevisionsPerEntity` 的最旧快照。
 *
 * @param {string} kind - 实体类别（如 `"agent"` 或 `"workflow"`）。
 * @param {string} entityID - 实体主键 ID。
 * @param {string} name - 快照时的实体名称。
 * @param {number} version - 快照时的逻辑版本号。
 * @param {number} revision - 快照时的修订号。
 * @param {*} payload - 待归档的完整实体对象。
 * @returns {void} 无返回值。
 * @throws {Error} 序列化失败、写入快照失败或清理旧快照失败时抛出错误。
 */
CatalogRepo.prototype.snapshotRevision = function (kind, entityID, name, version, revision, payload) {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  const item = new DefinitionRevision({
    ID: `${kind}-${entityID}-${version}-${revision}-${Date.now() * 1000000}`,
    Kind: kind,
    EntityID: entityID,
    Version: version,
    Revision: revision,
    Name: name,
    Summary: `${name} v${version} #${revision}`,
    Payload: raw,
    CreatedAt: new Date(),
  });
  upsert(this.DB, "definition_revisions", {
    id: item.ID, kind: item.Kind, entity_id: item.EntityID, version: item.Version,
    revision: item.Revision, name: item.Name, payload: mustJSON(item), created_at: timePtr(item.CreatedAt),
  });
  const dropped = [];
  // MySQL 要求 OFFSET 必须搭配 LIMIT；gorm 在仅有 Offset 时会生成非法 SQL。
  // sqlite 不接受超出 int64 的 LIMIT 字面量，故按方言分别处理。
  if (this.isMySQL()) {
    const err = this.DB.Raw(
      "SELECT id FROM definition_revisions WHERE kind = ? AND entity_id = ? " +
        "ORDER BY created_at DESC LIMIT 18446744073709551615 OFFSET ?",
      kind, entityID, maxRevisionsPerEntity).Scan(dropped).Error;
    if (err != null) {
      throw err;
    }
  } else {
    const err = this.DB.Table("definition_revisions").Select("id").
      Where("kind = ? AND entity_id = ?", kind, entityID).
      Order("created_at DESC").
      Limit(Number.MAX_SAFE_INTEGER).Offset(maxRevisionsPerEntity).
      Scan(dropped).Error;
    if (err != null) {
      throw err;
    }
  }
  for (const id of dropped) {
    const err = this.DB.Table("definition_revisions").Where("id = ?", id).Delete(null).Error;
    if (err != null) {
      throw err;
    }
  }
};

/**
 * 查询指定实体（按类别与实体 ID）的全部历史修订快照，按创建时间倒序排列。
 *
 * @param {string} kind - 实体类别（`"agent"` 或 `"workflow"`）。
 * @param {string} entityID - 实体主键 ID。
 * @returns {DefinitionRevision[]} 按 `CreatedAt` 降序排列的修订快照数组。
 */
CatalogRepo.prototype.Revisions = function (kind, entityID) {
  const out = payloadList(DefinitionRevision, this.DB, "definition_revisions", "kind = ? AND entity_id = ?", kind, entityID);
  out.sort((a, b) => timeMs(b.CreatedAt) - timeMs(a.CreatedAt));
  return out;
};

/**
 * 按主键 ID 读取单条定义修订快照。
 *
 * @param {string} id - 修订快照 ID。
 * @returns {[DefinitionRevision, boolean]} 返回 `[修订快照实例, 是否找到]`。
 */
CatalogRepo.prototype.Revision = function (id) {
  return payloadOne(DefinitionRevision, this.DB, "definition_revisions", id);
};

/**
 * 从指定历史修订快照恢复工作流定义，沿用当前线上工作流的修订号重新保存以通过乐观锁校验。
 *
 * @param {string} id - 工作流修订快照 ID。
 * @returns {WorkflowDefinition} 恢复并保存后的工作流定义。
 * @throws {Error} 快照不存在或类别不匹配、载荷解析失败、目标工作流不存在或保存失败时抛出错误。
 */
CatalogRepo.prototype.RestoreWorkflowRevision = function (id) {
  const [rev, ok] = this.Revision(id);
  if (!ok || rev.Kind !== "workflow") {
    throw new Error("revision not found");
  }
  const wf = new WorkflowDefinition(JSON.parse(typeof rev.Payload === "string" ? rev.Payload : Buffer.from(rev.Payload).toString("utf8")));
  const [current, found] = this.Workflow(wf.ID);
  if (!found) {
    throw new Error(`workflow ${wf.ID} not found`);
  }
  wf.Revision = current.Revision;
  this.PutWorkflow(wf);
  return wf;
};

/**
 * 从指定历史修订快照恢复角色定义；若目标角色当前仍存在，则在当前版本号基础上递增 `Version` 后保存。
 *
 * @param {string} id - 角色修订快照 ID。
 * @returns {AgentDefinition} 恢复并保存后的角色定义。
 * @throws {Error} 快照不存在或类别不匹配、载荷解析失败或保存失败时抛出错误。
 */
CatalogRepo.prototype.RestoreAgentRevision = function (id) {
  const [rev, ok] = this.Revision(id);
  if (!ok || rev.Kind !== "agent") {
    throw new Error("revision not found");
  }
  const agent = new AgentDefinition(JSON.parse(typeof rev.Payload === "string" ? rev.Payload : Buffer.from(rev.Payload).toString("utf8")));
  const [current, found] = this.Agent(agent.ID);
  if (found) {
    agent.Version = current.Version + 1;
  }
  this.PutAgent(agent);
  return agent;
};

// ---------- Production SOP ids ----------

const issueFixWorkflowID = "issue-fix-production";
const requirementWorkflowID = "requirement-development-production";

/**
 * 返回工作项未显式绑定 SOP 时的平台默认生产 SOP ID。
 * 工蜂缺陷或 `kind === "issue"` 走缺陷修复流程，TAPD 或本地需求走需求研发交付流程。
 *
 * @param {string} source - 工作项来源（如 `"gongfeng"`、`"tapd"`、`"local"`）。
 * @param {string} kind - 工作项类型（如 `"issue"`、`"story"`）。
 * @returns {string} 默认生产 SOP 的工作流 ID。
 */
function DefaultWorkflowID(source, kind) {
  if (source === "gongfeng" || kind === "issue") {
    return issueFixWorkflowID;
  }
  return requirementWorkflowID;
}

/**
 * 判断工作项是否属于需求交付类（而非工蜂或缺陷修复类）。
 *
 * @param {string} source - 工作项来源。
 * @param {string} kind - 工作项类型。
 * @returns {boolean} 属于需求交付类返回 `true`，否则返回 `false`。
 */
function isRequirement(source, kind) {
  return source !== "gongfeng" && kind !== "issue";
}

/**
 * 为尚未绑定工作流的工作项分配默认 SOP ID。
 * 需求优先使用项目默认需求工作流；缺陷优先使用项目缺陷工作流，其次若项目默认工作流为平台通用模板则复用该模板，最后回退到平台生产默认 SOP。
 *
 * @param {import("../domain/issue.js").Issue} v - 待补全默认工作流的工作项对象（原地修改）。
 * @param {string} projectWorkflowID - 项目配置的默认需求工作流 ID。
 * @param {string} projectIssueWorkflowID - 项目配置的默认缺陷工作流 ID。
 * @returns {void} 无返回值。
 */
function bindDefaultWorkflow(v, projectWorkflowID, projectIssueWorkflowID) {
  if (v.Source === "gongfeng" && v.Kind === "") {
    v.Kind = "issue";
  }
  if (v.WorkflowID !== "") {
    return;
  }
  if (isRequirement(v.Source, v.Kind)) {
    const wf = projectWorkflowID.trim();
    if (wf !== "") {
      v.WorkflowID = wf;
      return;
    }
  } else if (projectIssueWorkflowID.trim() !== "") {
    v.WorkflowID = projectIssueWorkflowID.trim();
    return;
  } else if (projectWorkflowID.trim() !== "" && isGenericWorkflowID(projectWorkflowID.trim())) {
    // 默认采用平台通用模板的项目，其同步的工蜂 Issue 同样复用该模板；绑定生产 SOP 的项目则继续回落到生产默认缺陷 SOP。
    v.WorkflowID = projectWorkflowID.trim();
    return;
  }
  v.WorkflowID = DefaultWorkflowID(v.Source, v.Kind);
}

/**
 * 判断工作流 ID 是否为存放在 `generic_templates` 表中的平台通用模板之一。
 *
 * @param {string} id - 工作流 ID。
 * @returns {boolean} 属于平台通用模板返回 `true`，否则返回 `false`。
 */
function isGenericWorkflowID(id) {
  switch (id.trim()) {
    case GenericBackendDeliveryWorkflowID:
    case GenericProductDeliveryWorkflowID:
    case GenericFrontendDeliveryWorkflowID:
      return true;
    default:
      return false;
  }
}

/**
 * 按项目 ID 生成约定式的项目缺陷修复 SOP ID（`<projectID>-issue-fix`）。
 *
 * @param {string} projectID - 项目 ID。
 * @returns {string} 约定缺陷工作流 ID；项目 ID 为空时返回 `""`。
 */
function ProjectIssueWorkflowID(projectID) {
  projectID = projectID.trim();
  if (projectID === "") {
    return "";
  }
  return projectID + "-issue-fix";
}

/**
 * 规整沙箱配置档案：仅保留目标驱动使用的字段，并将已移除的 `local` 或具体轻量隔离驱动统一归并到 `native`。
 *
 * @param {SandboxProfile} profile - 待规范化的沙箱配置对象。
 * @returns {SandboxProfile} 规范化后的沙箱配置对象。
 */
function normalizeSandboxProfile(profile) {
  profile.Driver = profile.Driver.trim();
  profile.DockerfileID = "";
  // 每种驱动仅保留自己的配方字段，切换驱动时丢弃旧配方以免保存校验失败。
  if (profile.Driver !== SandboxDriverDocker) {
    profile.Dockerfile = null;
  }
  switch (profile.Driver) {
    case SandboxDriverLocal:
    case SandboxDriverNative:
    case SandboxDriverSeatbelt:
    case SandboxDriverBwrap:
      profile.Driver = SandboxDriverNative;
      profile.ReadOnlyRootFS = false;
      break;
  }
  return profile;
}

/**
 * 规范化工作流定义：为空的 `SandboxProfileID` 填充平台默认沙箱，并将历史 `command` 节点统一迁移为 `script` 节点（默认语言 `"shell"`）。
 *
 * @param {WorkflowDefinition} workflow - 待规范化的工作流定义对象。
 * @returns {WorkflowDefinition} 规范化后的工作流定义对象。
 */
function normalizeWorkflowDefinition(workflow) {
  if (workflow.SandboxProfileID.trim() === "") {
    workflow.SandboxProfileID = DefaultSandboxProfileID;
  }
  for (let index = 0; index < workflow.Nodes.length; index++) {
    const node = workflow.Nodes[index];
    if (node.Type === "command") {
      node.Type = "script";
      if (node.Script.trim() === "") {
        node.Script = node.Command;
      }
    }
    if (node.Type === "script") {
      if (node.ScriptLanguage.trim() === "") {
        node.ScriptLanguage = "shell";
      }
      node.Command = "";
    }
  }
  return workflow;
}

module.exports = { BaselineAlignResolverAgent, BuiltInExecutors, BuiltInExecutor, BuiltInExecutorForKind, ErrScheduleJobChanged, DefaultWorkflowID, ProjectIssueWorkflowID, isRequirement, bindDefaultWorkflow, isGenericWorkflowID, isDefaultSandboxID, normalizeSandboxProfile, normalizeWorkflowDefinition, workflowContent, workflowPublishedRevision, workflowNeedsPublish, issueFixWorkflowID, requirementWorkflowID, maxRevisionsPerEntity };
