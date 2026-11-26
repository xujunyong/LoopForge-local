// catalog.js —— 对应 Go 文件：internal/repo/catalog.go
// 作用：可复用定义目录：角色、规则、技能、MCP、执行器、沙箱、SOP、仓库、同步配置、定时任务与版本快照。
// gorm 链式调用按原样保留；Go 的 (T, bool)/(T, error) 译为 [值, 布尔/错误]；time.Time 零值译为 null。

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
const { payloadList, payloadOne, upsert, mustJSON, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { normalizeRefs, CatalogRepo } = require("./repo.js"); // 对应 Go 同包函数与类型，repo.js 待翻译
const { isZeroTime, timeMs, zeroTimeDate } = require("./analytics.js"); // 对应 Go 的时间比较，analytics.js 已翻译
const { GenericDockerSandbox } = require("./generic_docker.js"); // 对应 Go 同包函数，generic_docker.js 待翻译
const { DefaultSandboxProfileID } = require("./sandbox_defaults.js"); // 对应 Go 同包常量，sandbox_defaults.js 待翻译
const { GenericDockerSandboxID, GenericBackendDeliveryWorkflowID, GenericProductDeliveryWorkflowID, GenericFrontendDeliveryWorkflowID } = require("./generic_workflows.js"); // 对应 Go 同包常量，generic_workflows.js 待翻译
const { mysqlSyncConfigID, scheduleJobRow, skillFileRow, mcpFileRow, scheduleJobExecutionStatRow } = require("./models.js"); // 对应 Go 同包类型与常量，models.js 待翻译

// BaselineAlignResolverAgent is the shared platform role for scheduled
// baseline alignment. No project hooks or issue-fix verification gates.
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

CatalogRepo.prototype.Agents = function () {
  const out = payloadList(AgentDefinition, this.DB, "agents", "");
  out.sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0));
  return out;
};

CatalogRepo.prototype.Agent = function (id) {
  return payloadOne(AgentDefinition, this.DB, "agents", id);
};

CatalogRepo.prototype.PutAgent = function (v) {
  if (v.ID.trim() === "" || v.Name.trim() === "") {
    return new Error("agent id and name are required");
  }
  if (v.Loop.Enabled) {
    if (v.Loop.MaxIterations < 1 || v.Loop.MaxIterations > 12) {
      return new Error("agent loop maxIterations must be between 1 and 12");
    }
    if (v.Loop.ExitCondition === "") {
      v.Loop.ExitCondition = "all_gates_pass";
    }
  }
  for (const output of v.ArtifactOutputs) {
    const clean = path.normalize(output.Path.trim());
    if (output.Name === "" || clean === "." || path.isAbsolute(clean) || clean === ".." || clean.startsWith(".." + path.sep)) {
      return new Error(`invalid agent artifact contract "${output.Name}"`);
    }
  }
  const validStages = { before_execution: true, after_execution: true, before_publish: true, on_failure: true };
  for (const point of v.Interventions) {
    if (point.ID === "" || point.Name === "" || !validStages[point.Stage]) {
      return new Error(`invalid agent intervention point "${point.ID}"`);
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
      return new Error(`invalid agent hook id "${hook.ID}"`);
    }
    if (hookIDs[hook.ID]) {
      return new Error(`duplicate agent hook "${hook.ID}"`);
    }
    hookIDs[hook.ID] = true;
    if (hook.Name === "" || !validHookEvents[hook.Event]) {
      return new Error(`invalid agent hook "${hook.ID}"`);
    }
    if (hook.Language !== "shell" && hook.Language !== "python") {
      return new Error(`agent hook "${hook.ID}" has invalid language "${hook.Language}"`);
    }
    if (hook.Script === "") {
      return new Error(`agent hook "${hook.ID}" script is required`);
    }
    if (hook.TimeoutSec === 0) {
      hook.TimeoutSec = 10;
    }
    if (hook.TimeoutSec < 1 || hook.TimeoutSec > 600) {
      return new Error(`agent hook "${hook.ID}" timeoutSec must be between 1 and 600`);
    }
  }
  v.UpdatedAt = new Date();
  v.Rules = normalizeRefs(v.Rules, "rules/");
  v.Skills = normalizeRefs(v.Skills, "skills/");
  const [old, ok] = this.Agent(v.ID);
  if (ok) {
    v.ProjectID = KeepCatalogProjectID(v.ProjectID, old.ProjectID);
    const err = this.snapshotRevision("agent", old.ID, old.Name, old.Version, 0, old);
    if (err != null) {
      return err;
    }
  }
  return upsert(this.DB, "agents", {
    id: v.ID, name: v.Name, payload: mustJSON(v), updated_at: timePtr(v.UpdatedAt),
  });
};

// ---------- Rules / Skills / MCP servers ----------

CatalogRepo.prototype.Rules = function () {
  const out = payloadList(RuleDefinition, this.DB, "rules", "");
  out.sort((a, b) => b.Priority - a.Priority);
  return out;
};

CatalogRepo.prototype.Rule = function (id) {
  return payloadOne(RuleDefinition, this.DB, "rules", id);
};

CatalogRepo.prototype.PutRule = function (v) {
  v.UpdatedAt = new Date();
  return upsert(this.DB, "rules", {
    id: v.ID, name: v.Name, payload: mustJSON(v), updated_at: timePtr(v.UpdatedAt),
  });
};

CatalogRepo.prototype.DeleteRule = function (id) {
  const [, ok] = this.Rule(id);
  if (!ok) {
    return new Error("rule not found");
  }
  return this.DB.Table("rules").Where("id = ?", id).Delete(null).Error;
};

CatalogRepo.prototype.Skills = function () {
  return payloadList(SkillDefinition, this.DB, "skills", "");
};

CatalogRepo.prototype.Skill = function (id) {
  return payloadOne(SkillDefinition, this.DB, "skills", id);
};

CatalogRepo.prototype.PutSkill = function (v) {
  v.UpdatedAt = new Date();
  return upsert(this.DB, "skills", {
    id: v.ID, name: v.Name, payload: mustJSON(v), updated_at: timePtr(v.UpdatedAt),
  });
};

CatalogRepo.prototype.DeleteSkill = function (id) {
  const [, ok] = this.Skill(id);
  if (!ok) {
    return new Error("skill not found");
  }
  return this.DB.Transaction((tx) => {
    const err = tx.Where("skill_id = ?", id).Delete(new skillFileRow()).Error;
    if (err != null) {
      return err;
    }
    return tx.Table("skills").Where("id = ?", id).Delete(null).Error;
  });
};

CatalogRepo.prototype.MCPServers = function () {
  return payloadList(MCPServerDefinition, this.DB, "mcp_servers", "");
};

CatalogRepo.prototype.MCPServer = function (id) {
  return payloadOne(MCPServerDefinition, this.DB, "mcp_servers", id);
};

CatalogRepo.prototype.PutMCPServer = function (v) {
  // Uploaded contents and their manifest are owned by the mcp_files API.
  // Definition-only updates (including JSON import) must not orphan existing
  // rows merely because fileRefs was omitted by an older client.
  if (v.FileRefs == null) {
    const [existing, ok] = this.MCPServer(v.ID);
    if (ok) {
      v.FileRefs = existing.FileRefs;
    }
  }
  const err = ValidateMCPServer(v);
  if (err != null) {
    return err;
  }
  v.UpdatedAt = new Date();
  return upsert(this.DB, "mcp_servers", {
    id: v.ID, name: v.Name, payload: mustJSON(v), updated_at: timePtr(v.UpdatedAt),
  });
};

CatalogRepo.prototype.DeleteMCPServer = function (id) {
  const [, ok] = this.MCPServer(id);
  if (!ok) {
    return new Error("MCP not found");
  }
  return this.DB.Transaction((tx) => {
    const err = tx.Where("mcp_id = ?", id).Delete(new mcpFileRow()).Error;
    if (err != null) {
      return err;
    }
    return tx.Table("mcp_servers").Where("id = ?", id).Delete(null).Error;
  });
};

CatalogRepo.prototype.DeleteAgent = function (id) {
  const [, ok] = payloadOne(AgentDefinition, this.DB, "agents", id);
  if (!ok) {
    return new Error("agent not found");
  }
  return this.DB.Table("agents").Where("id = ?", id).Delete(null).Error;
};

// ---------- Executors ----------

CatalogRepo.prototype.Executors = function () {
  return payloadList(ExecutorDefinition, this.DB, "executors", "");
};

CatalogRepo.prototype.Executor = function (id) {
  return payloadOne(ExecutorDefinition, this.DB, "executors", id);
};

CatalogRepo.prototype.PutExecutor = function (v) {
  if (v.ID.trim() === "" || v.Name.trim() === "" || v.Kind.trim() === "") {
    return new Error("executor id, name and kind are required");
  }
  return upsert(this.DB, "executors", {
    id: v.ID, name: v.Name, kind: v.Kind, payload: mustJSON(v),
  });
};

// BuiltInExecutors is the complete user-selectable CLI catalog. Executor
// definitions remain persisted for historical snapshots and compatibility,
// but they are no longer a user-managed runtime asset.
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

function BuiltInExecutor(id) {
  for (const executor of BuiltInExecutors()) {
    if (executor.ID === id.trim()) {
      return [executor, true];
    }
  }
  return [new ExecutorDefinition(), false];
}

function BuiltInExecutorForKind(kind) {
  for (const executor of BuiltInExecutors()) {
    if (executor.Kind === kind.trim()) {
      return [executor, true];
    }
  }
  return [new ExecutorDefinition(), false];
}

// ---------- Sandboxes ----------

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

CatalogRepo.prototype.Sandbox = function (id) {
  const isDefault = isDefaultSandboxID(id);
  if (isDefault) {
    id = DefaultSandboxProfileID;
  }
  let profile = new SandboxProfile();
  const row = { Payload: null, PlatformDefault: false };
  const err = this.DB.Table("sandboxes").Select("payload, id = ? AS platform_default", DefaultSandboxProfileID).
    Where("id = ?", id).Take(row).Error;
  // A missing row may use the built-in default. Database failures or invalid
  // stored configuration must not silently switch a run's execution policy.
  if (err === gorm.ErrRecordNotFound) {
    const [reserved, reservedErr] = this.IsReservedSandboxID(id);
    if (reservedErr == null && reserved) {
      return [GenericDockerSandbox(), true];
    }
    return [new SandboxProfile(), false];
  }
  let unmarshalErr = null;
  try {
    profile = new SandboxProfile(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
  } catch (e) {
    unmarshalErr = e;
  }
  if (err != null || unmarshalErr != null) {
    return [new SandboxProfile(), false];
  }
  if (isDefault || row.PlatformDefault) {
    if (!platformSandboxOwner(profile.ProjectID)) {
      // A project profile on an installation awaiting migration cannot
      // replace the platform-wide default.
      return [GenericDockerSandbox(), true];
    }
    profile.ID = DefaultSandboxProfileID;
  }
  return [platformSandboxProfile(profile), true];
};

function isDefaultSandboxID(id) {
  return id.trim().toLowerCase() === DefaultSandboxProfileID.toLowerCase();
}

// IsReservedSandboxID recognizes the default ID and its MySQL equivalents.
// The catalog uses utf8mb4_unicode_ci for its primary keys.
CatalogRepo.prototype.IsReservedSandboxID = function (id) {
  if (isDefaultSandboxID(id)) {
    return [true, null];
  }
  if (id === "" || !this.isMySQL()) {
    return [false, null];
  }
  let reserved = false;
  const err = this.DB.Raw("SELECT CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci = ?", id, DefaultSandboxProfileID).Scan(reserved).Error;
  return [reserved, err];
};

// Stored platform defaults are projectless, including operator overrides.
function platformSandboxOwner(projectID) {
  return projectID === "";
}

// platformSandboxProfile keeps the built-in generic Docker sandbox shared:
// conversation workspaces fall back to it, and rows seeded before it carried
// the shared flag would otherwise hide it from every project. A row still
// marked local reads as native, never as the runtime's unisolated driver.
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

CatalogRepo.prototype.PutSandbox = function (v) {
  if (v.ID.trim() === "" || v.Name.trim() === "") {
    return new Error("sandbox id and name are required");
  }
  const [reserved, reservedErr] = this.IsReservedSandboxID(v.ID);
  if (reservedErr != null) {
    return reservedErr;
  }
  if (reserved) {
    if (v.ProjectID !== "" && v.ProjectID !== "platform") {
      return new Error(`沙箱标识 ${DefaultSandboxProfileID} 保留给平台默认沙箱`);
    }
    v.ID = DefaultSandboxProfileID;
    v.ProjectID = "";
  }
  const envErr = ValidateEnvironmentVariables(v.Environment);
  if (envErr != null) {
    return new Error(`sandbox environment: ${envErr.message}`);
  }
  if (v.Driver.trim() === SandboxDriverLocal) {
    return new Error("local 沙箱已移除，请改用 native 沙箱");
  }
  const stored = normalizeSandboxProfile(v);
  const assetsErr = ValidateSandboxAssets(stored);
  if (assetsErr != null) {
    return assetsErr;
  }
  return upsert(this.DB, "sandboxes", {
    id: stored.ID, name: stored.Name, payload: mustJSON(stored),
  });
};

CatalogRepo.prototype.DeleteSandbox = function (id) {
  const [reserved, err] = this.IsReservedSandboxID(id);
  if (err != null) {
    return err;
  }
  if (reserved) {
    return new Error("默认运行沙箱不能删除；可编辑配置或新建其他沙箱");
  }
  const [, ok] = this.Sandbox(id);
  if (!ok) {
    return new Error("sandbox not found");
  }
  return this.DB.Table("sandboxes").Where("id = ?", id).Delete(null).Error;
};

// ---------- Workflows ----------

// Workflows lists project SOPs plus stored generic templates. A leftover
// workflows-table row occupying a generic id is filtered out so the template
// stays authoritative. Generic templates always sort after the stored SOPs
// (master semantics: the stored list is sorted by UpdatedAt, generics are
// appended).
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

// Workflow resolves a custom SOP or a generic_templates row. Generic ids stay
// reserved so a leftover workflows-table collision cannot shadow the template.
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

// storedWorkflow reads only the physical workflows table, ignoring the
// generic-template fallback. Writers use it for existence checks so a legacy
// colliding row stays writable and never conflicts with template revisions.
CatalogRepo.prototype.storedWorkflow = function (id) {
  const [workflow, ok] = payloadOne(WorkflowDefinition, this.DB, "workflows", id);
  if (!ok) {
    return [new WorkflowDefinition(), false];
  }
  return [normalizeWorkflowDefinition(workflow), ok];
};

CatalogRepo.prototype.PutWorkflow = function (v) {
  return this.putWorkflow(v, false);
};

function workflowContent(v) {
  // Go 按值传参，调用方不受清零影响；JS 此处复制一份再清零。
  const copy = Object.assign(new WorkflowDefinition(), v);
  copy.Revision = 0;
  copy.PublishedRevision = 0;
  copy.CreatedAt = zeroTimeDate();
  copy.UpdatedAt = zeroTimeDate();
  return mustJSON(copy).toString("utf8");
}

function workflowPublishedRevision(v) {
  if (v.PublishedRevision === 0 && v.Status === "published") {
    return v.Revision; // Legacy published definitions predate this marker.
  }
  return v.PublishedRevision;
}

function workflowNeedsPublish(v) {
  return v.Status !== "published" || workflowPublishedRevision(v) !== v.Revision;
}

// PublishWorkflow is idempotent until the saved definition changes.
CatalogRepo.prototype.PublishWorkflow = function (id) {
  let published = new WorkflowDefinition();
  const err = this.DB.Transaction((tx) => {
    const row = { ID: "" };
    const takeErr = this.locking(tx.Table("workflows")).Select("id").Where("id = ?", id).Take(row).Error;
    if (takeErr != null) {
      return takeErr;
    }
    const catalog = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    catalog.DB = tx;
    catalog.deps = { ...this.deps, DB: tx };
    let publishErr;
    [published, publishErr] = catalog.publishStoredWorkflow(id);
    return publishErr;
  });
  return [published, err];
};

CatalogRepo.prototype.publishStoredWorkflow = function (id) {
  const [v, ok] = this.storedWorkflow(id);
  if (!ok) {
    return [new WorkflowDefinition(), new Error("workflow not found")];
  }
  if (!workflowNeedsPublish(v)) {
    return [v, null];
  }
  v.Status = "published";
  v.Version++;
  const err = this.putWorkflow(v, true);
  if (err != null) {
    return [new WorkflowDefinition(), err];
  }
  const [stored] = this.storedWorkflow(id);
  return [stored, null];
};

CatalogRepo.prototype.putWorkflow = function (v, publishing) {
  if (v.ID.trim() === "" || v.Name.trim() === "") {
    return new Error("workflow id and name are required");
  }
  let err = ValidateWorkflowPreparation(v);
  if (err != null) {
    return err;
  }
  err = ValidateWorkflowMetricStages(v);
  if (err != null) {
    return err;
  }
  v = normalizeWorkflowDefinition(v);
  const [, sandboxOk] = this.Sandbox(v.SandboxProfileID);
  if (!sandboxOk) {
    return new Error(`sandbox profile "${v.SandboxProfileID}" not found`);
  }
  const now = new Date();
  const [old, ok] = this.storedWorkflow(v.ID);
  if (ok) {
    v.ProjectID = KeepCatalogProjectID(v.ProjectID, old.ProjectID);
    if (v.Revision !== old.Revision) {
      return new Error(`workflow revision conflict: current revision is ${old.Revision}`);
    }
    if (!publishing && workflowContent(v) === workflowContent(old)) {
      return null;
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
  err = this.validateWorkflowNotifications(v);
  if (err != null) {
    return err;
  }
  if (v.Status === "") {
    v.Status = "draft";
  }
  if (publishing) {
    v.PublishedRevision = v.Revision;
  }
  v.UpdatedAt = now;
  if (ok) {
    err = this.snapshotRevision("workflow", old.ID, old.Name, old.Version, old.Revision, old);
    if (err != null) {
      return err;
    }
  }
  return upsert(this.DB, "workflows", {
    id: v.ID, name: v.Name, version: v.Version, revision: v.Revision, status: v.Status,
    payload: mustJSON(v), created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  });
};

// DeleteWorkflow removes a SOP definition. Historical runs keep their own
// WorkflowSnapshot, so already-finished runs stay fully readable afterwards.
CatalogRepo.prototype.DeleteWorkflow = function (id) {
  const [, ok] = this.storedWorkflow(id);
  if (!ok) {
    return new Error("workflow not found");
  }
  return this.DB.Table("workflows").Where("id = ?", id).Delete(null).Error;
};

// ---------- Repositories ----------

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

CatalogRepo.prototype.Repository = function (id) {
  return payloadOne(Repository, this.DB, "repositories", id);
};

CatalogRepo.prototype.PutRepository = function (v) {
  const [, ok] = this.projects.Project(v.ProjectID);
  if (!ok) {
    return new Error("project not found");
  }
  const now = new Date();
  const [old, found] = this.Repository(v.ID);
  if (found) {
    v.CreatedAt = old.CreatedAt;
  } else {
    v.CreatedAt = now;
  }
  v.UpdatedAt = now;
  return upsert(this.DB, "repositories", {
    id: v.ID, project_id: v.ProjectID, name: v.Name, payload: mustJSON(v),
    created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  });
};

CatalogRepo.prototype.DeleteRepository = function (id) {
  return this.DB.Table("repositories").Where("id = ?", id).Delete(null).Error;
};

// ---------- Sync config / Schedule jobs ----------

CatalogRepo.prototype.SyncConfig = function () {
  const [cfg] = payloadOne(SyncConfig, this.DB, "sync_config", mysqlSyncConfigID);
  return cfg;
};

CatalogRepo.prototype.PutSyncConfig = function (cfg) {
  const current = this.SyncConfig();
  cfg.PlaybookSeedRev = current.PlaybookSeedRev;
  return upsert(this.DB, "sync_config", {
    id: mysqlSyncConfigID, payload: mustJSON(cfg), updated_at: timePtr(new Date()),
  });
};

CatalogRepo.prototype.ScheduleJobs = function () {
  const out = payloadList(ScheduleJob, this.DB, "schedule_jobs", "");
  out.sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0));
  return out;
};

CatalogRepo.prototype.ScheduleJob = function (id) {
  return payloadOne(ScheduleJob, this.DB, "schedule_jobs", id);
};

CatalogRepo.prototype.PutScheduleJob = function (v) {
  return this.DB.Transaction((tx) => {
    const row = new scheduleJobRow();
    let old = new ScheduleJob();
    const err = this.locking(tx).Where("id = ?", v.ID).First(row).Error;
    if (err == null) {
      try {
        old = new ScheduleJob(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
      } catch (e) {
        return e;
      }
    } else if (err !== gorm.ErrRecordNotFound) {
      return err;
    }
    if (!(old.LastStatus === "running" && v.LastStatus !== "running")) {
      const validateErr = this.notifications.validateNotificationBindings(tx, v.ProjectID, v.Notifications, true);
      if (validateErr != null) {
        return validateErr;
      }
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
    const upsertErr = upsert(tx, "schedule_jobs", { id: v.ID, name: v.Name, enabled: enabled, payload: mustJSON(v), updated_at: timePtr(v.UpdatedAt) });
    if (upsertErr != null) {
      return upsertErr;
    }
    const trigger = { success: "succeeded", failed: "failed" }[v.LastStatus] ?? "";
    if (old.ID !== "" && old.LastStatus === "running" && trigger !== "" && !isZeroTime(v.LastRunAt)) {
      let result = v.NotificationResult;
      if (result === "") {
        result = v.LastAssistantMessage;
      }
      return this.notifications.enqueueTaskNotifications(tx, "schedule_job", v.ID, v.ProjectID, v.Name, trigger, v.LastRunAt, old.NotificationSnapshot, result, v.LastError);
    }
    return null;
  });
};

// SetScheduleJobEnabled flips only a job's enabled flag, leaving its
// configuration and the outcome of a run in progress untouched.
CatalogRepo.prototype.SetScheduleJobEnabled = function (id, enabled) {
  let out = new ScheduleJob();
  const err = this.DB.Transaction((tx) => {
    const row = new scheduleJobRow();
    const firstErr = this.locking(tx).Where("id = ?", id).First(row).Error;
    if (firstErr != null) {
      return firstErr;
    }
    try {
      out = new ScheduleJob(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
    } catch (e) {
      return e;
    }
    out.Enabled = enabled;
    out.UpdatedAt = new Date();
    let flag = 0;
    if (enabled) {
      flag = 1;
    }
    return tx.Model(row).Updates({ enabled: flag, payload: mustJSON(out), updated_at: timePtr(out.UpdatedAt) }).Error;
  });
  return [out, err];
};

// ErrScheduleJobChanged reports that the stored job no longer matches what
// the caller checked, e.g. it was edited or moved to another project.
const ErrScheduleJobChanged = new Error("任务已被其他人修改或移动，请刷新后重试");

// DisableScheduleJob turns the job off only if unchanged accepts the row as
// it is stored now, checked under the row lock, and returns the stored job.
// Nothing else in the row is touched.
CatalogRepo.prototype.DisableScheduleJob = function (id, unchanged) {
  let current = new ScheduleJob();
  const err = this.DB.Transaction((tx) => {
    const row = new scheduleJobRow();
    const firstErr = this.locking(tx).Where("id = ?", id).First(row).Error;
    if (firstErr === gorm.ErrRecordNotFound) {
      return ErrScheduleJobChanged;
    }
    if (firstErr != null) {
      return firstErr;
    }
    try {
      current = new ScheduleJob(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
    } catch (e) {
      return e;
    }
    if (!unchanged(current)) {
      return ErrScheduleJobChanged;
    }
    current.Enabled = false;
    current.UpdatedAt = new Date();
    return tx.Model(row).Updates({ enabled: 0, payload: mustJSON(current), updated_at: timePtr(current.UpdatedAt) }).Error;
  });
  if (err != null) {
    return [new ScheduleJob(), err];
  }
  return [current, null];
};

CatalogRepo.prototype.DeleteScheduleJob = function (id) {
  const [, ok] = this.ScheduleJob(id);
  if (!ok) {
    return new Error("schedule job not found");
  }
  return this.DB.Transaction((tx) => {
    let err = tx.Table("schedule_job_executions").Where("job_id = ?", id).Delete(null).Error;
    if (err != null) {
      return err;
    }
    err = tx.Where("job_id = ?", id).Delete(new scheduleJobExecutionStatRow()).Error;
    if (err != null) {
      return err;
    }
    return tx.Table("schedule_jobs").Where("id = ?", id).Delete(null).Error;
  });
};

// ---------- Definition revisions ----------

const maxRevisionsPerEntity = 20;

// snapshotRevision archives the previous version of a definition before it is
// overwritten.
CatalogRepo.prototype.snapshotRevision = function (kind, entityID, name, version, revision, payload) {
  let raw;
  try {
    raw = Buffer.from(JSON.stringify(payload), "utf8");
  } catch (e) {
    return e;
  }
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
  let err = upsert(this.DB, "definition_revisions", {
    id: item.ID, kind: item.Kind, entity_id: item.EntityID, version: item.Version,
    revision: item.Revision, name: item.Name, payload: mustJSON(item), created_at: timePtr(item.CreatedAt),
  });
  if (err != null) {
    return err;
  }
  const dropped = [];
  // MySQL 要求 OFFSET 必须搭配 LIMIT；gorm 在仅有 Offset 时会生成非法 SQL。
  // sqlite 不接受超出 int64 的 LIMIT 字面量，故按方言分别处理。
  if (this.isMySQL()) {
    err = this.DB.Raw(
      "SELECT id FROM definition_revisions WHERE kind = ? AND entity_id = ? " +
        "ORDER BY created_at DESC LIMIT 18446744073709551615 OFFSET ?",
      kind, entityID, maxRevisionsPerEntity).Scan(dropped).Error;
    if (err != null) {
      return err;
    }
  } else {
    err = this.DB.Table("definition_revisions").Select("id").
      Where("kind = ? AND entity_id = ?", kind, entityID).
      Order("created_at DESC").
      Limit(Number.MAX_SAFE_INTEGER).Offset(maxRevisionsPerEntity).
      Scan(dropped).Error;
    if (err != null) {
      return err;
    }
  }
  for (const id of dropped) {
    err = this.DB.Table("definition_revisions").Where("id = ?", id).Delete(null).Error;
    if (err != null) {
      return err;
    }
  }
  return null;
};

CatalogRepo.prototype.Revisions = function (kind, entityID) {
  const out = payloadList(DefinitionRevision, this.DB, "definition_revisions", "kind = ? AND entity_id = ?", kind, entityID);
  out.sort((a, b) => timeMs(b.CreatedAt) - timeMs(a.CreatedAt));
  return out;
};

CatalogRepo.prototype.Revision = function (id) {
  return payloadOne(DefinitionRevision, this.DB, "definition_revisions", id);
};

CatalogRepo.prototype.RestoreWorkflowRevision = function (id) {
  const [rev, ok] = this.Revision(id);
  if (!ok || rev.Kind !== "workflow") {
    return [new WorkflowDefinition(), new Error("revision not found")];
  }
  let wf;
  try {
    wf = new WorkflowDefinition(JSON.parse(typeof rev.Payload === "string" ? rev.Payload : Buffer.from(rev.Payload).toString("utf8")));
  } catch (e) {
    return [new WorkflowDefinition(), e];
  }
  const [current, found] = this.Workflow(wf.ID);
  if (!found) {
    return [new WorkflowDefinition(), new Error(`workflow ${wf.ID} not found`)];
  }
  wf.Revision = current.Revision;
  return [wf, this.PutWorkflow(wf)];
};

CatalogRepo.prototype.RestoreAgentRevision = function (id) {
  const [rev, ok] = this.Revision(id);
  if (!ok || rev.Kind !== "agent") {
    return [new AgentDefinition(), new Error("revision not found")];
  }
  let agent;
  try {
    agent = new AgentDefinition(JSON.parse(typeof rev.Payload === "string" ? rev.Payload : Buffer.from(rev.Payload).toString("utf8")));
  } catch (e) {
    return [new AgentDefinition(), e];
  }
  const [current, found] = this.Agent(agent.ID);
  if (found) {
    agent.Version = current.Version + 1;
  }
  return [agent, this.PutAgent(agent)];
};

// ---------- Production SOP ids ----------

const issueFixWorkflowID = "issue-fix-production";
const requirementWorkflowID = "requirement-development-production";

// DefaultWorkflowID returns the production SOP to bind when an issue has none.
// Gongfeng issues use the repair loop; TAPD / local requirements use delivery.
function DefaultWorkflowID(source, kind) {
  if (source === "gongfeng" || kind === "issue") {
    return issueFixWorkflowID;
  }
  return requirementWorkflowID;
}

// isRequirement reports whether an issue is a requirement (delivery) rather than
// a defect/repair item.
function isRequirement(source, kind) {
  return source !== "gongfeng" && kind !== "issue";
}

// bindDefaultWorkflow assigns the SOP an issue should run when it has none yet.
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
    // Projects defaulting to a built-in generic template (e.g. the
    // LoopForge backend delivery SOP a new project starts with) run their
    // synced Gongfeng issues on it too; projects bound to a production SOP
    // keep the production default below.
    v.WorkflowID = projectWorkflowID.trim();
    return;
  }
  v.WorkflowID = DefaultWorkflowID(v.Source, v.Kind);
}

// isGenericWorkflowID reports whether the id is one of the platform generic
// templates stored in generic_templates.
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

// ProjectIssueWorkflowID is the conventional per-project defect SOP id.
function ProjectIssueWorkflowID(projectID) {
  projectID = projectID.trim();
  if (projectID === "") {
    return "";
  }
  return projectID + "-issue-fix";
}

// normalizeSandboxProfile keeps only what a driver uses; the removed local
// driver becomes native.
function normalizeSandboxProfile(profile) {
  profile.Driver = profile.Driver.trim();
  profile.DockerfileID = "";
  // Each driver keeps only its own recipe, so switching drivers drops the
  // other one instead of failing the save.
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
