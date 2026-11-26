/**
 * @file internal/repo/generic_store.js
 * 对应 Go 源文件：internal/repo/generic_store.go
 *
 * 作用与职责边界：
 * 实现平台通用模板表（`generic_templates`）的读写、版本/修订号控制、原子发布以及按 ID 跨模板检索能力，
 * 全部仓储方法挂载在 `CatalogRepo.prototype` 上。
 * 支持独立更新通用模板的工作流定义或单个内置角色、判断项目角色是否遮蔽模板角色，以及列出引用某角色的工作流名称。
 *
 * 语法差异说明：
 * - `CatalogRepo` 定义于 `repo.js`，本文件通过 `CatalogRepo.prototype` 挂载通用模板相关方法。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；`db.Transaction` 回调同样失败抛错、成功正常返回。
 * - Go 的 `(值, bool)` 返回译为 `[值, boolean]` 元组。
 * - Go 的 `time.Time` 零值译为 `null`。
 */

"use strict";

const { Buffer } = require("node:buffer");

const { AgentDefinition } = require("../domain/agent.js"); // 对应 Go 的 domain.AgentDefinition，agent.js 已翻译
const { RuleDefinition, SkillDefinition } = require("../domain/assets.js"); // 对应 Go 的 domain.RuleDefinition/SkillDefinition，assets.js 已翻译
const { WorkflowDefinition, ValidateWorkflowMetricStages } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition/ValidateWorkflowMetricStages，workflow.js 已翻译
const { ValidateWorkflowPreparation } = require("../domain/workspace_preparation.js"); // 对应 Go 的 domain.ValidateWorkflowPreparation，workspace_preparation.js 已翻译
const { GenericTemplate } = require("./generic_workflows.js"); // 对应 Go 同包类型，generic_workflows.js 已翻译
const { genericTemplateRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { mustJSON, upsert, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { workflowContent, workflowPublishedRevision, workflowNeedsPublish } = require("./catalog.js"); // 对应 Go 同包函数，catalog.js 已翻译

/**
 * 判断时间对象是否为 Go 语境下的零值时间（`null` 或 `undefined`）。
 *
 * @param {Date|null|undefined} t - 待判断的时间对象。
 * @returns {boolean} 为零值时间时返回 `true`，否则返回 `false`。
 */
function isZeroTime(t) {
  return t == null;
}

/**
 * 按模板 ID 从 `generic_templates` 表读取并解码单个通用模板。
 *
 * @param {string} id - 通用模板工作流 ID。
 * @returns {[GenericTemplate, boolean]} 返回 `[通用模板对象, 是否找到并解码成功]`。
 */
CatalogRepo.prototype.loadGenericTemplate = function (id) {
  id = id.trim();
  if (id === "") {
    return [new GenericTemplate(), false];
  }
  const row = new genericTemplateRow();
  if (this.DB.Where("id = ?", id).Take(row).Error != null || row.Payload == null || row.Payload.length === 0) {
    return [new GenericTemplate(), false];
  }
  try {
    const template = decodeGenericTemplate(row.Payload);
    return [template, true];
  } catch {
    return [new GenericTemplate(), false];
  }
};

/**
 * 将数据库行中的 JSON 载荷反序列化为 `GenericTemplate` 实例，并强制归正其通用模板元数据标记（`Generic=true`、`ProjectID=""`、`Shared=false`）。
 *
 * @param {string|Buffer} raw - 原始 JSON 字节或文本。
 * @returns {GenericTemplate} 解码并归正后的通用模板对象。
 * @throws {Error} JSON 解析失败、工作流反序列化失败或模板缺少工作流 ID 时抛出错误。
 */
function decodeGenericTemplate(raw) {
  const parsed = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
  const template = new GenericTemplate(parsed);
  if (parsed.Workflow != null) {
    const workflow = new WorkflowDefinition();
    workflow.UnmarshalJSON(JSON.stringify(parsed.Workflow));
    template.Workflow = workflow;
  }
  // 将载荷里的角色、规则与技能子数组实例化为对应的 domain 类对象。
  template.Agents = (parsed.Agents ?? []).map((a) => new AgentDefinition(a));
  template.Rules = (parsed.Rules ?? []).map((r) => new RuleDefinition(r));
  template.Skills = (parsed.Skills ?? []).map((s) => new SkillDefinition(s));
  if (template.Workflow.ID.trim() === "") {
    throw new Error("generic template missing workflow id");
  }
  template.Workflow.Generic = true;
  template.Workflow.ProjectID = "";
  template.Workflow.Shared = false;
  return template;
}

/**
 * 内部写路径：校验通用模板 ID 与工作流通知配置，规范化通用标记后写入 `generic_templates` 表。
 *
 * @param {GenericTemplate} template - 待持久化的通用模板对象。
 * @returns {void} 无返回值。
 * @throws {Error} 缺少工作流 ID、通知配置不合法或数据库写入失败时抛出错误。
 */
CatalogRepo.prototype.putGenericTemplate = function (template) {
  const id = template.Workflow.ID.trim();
  if (id === "") {
    throw new Error("generic template workflow id is required");
  }
  template.Workflow.ID = id;
  template.Workflow.Generic = true;
  template.Workflow.ProjectID = "";
  template.Workflow.Shared = false;
  this.validateWorkflowNotifications(template.Workflow);
  const now = new Date();
  if (isZeroTime(template.Workflow.UpdatedAt)) {
    template.Workflow.UpdatedAt = now;
  }
  let name = template.Workflow.Name.trim();
  if (name === "") {
    name = id;
  }
  upsert(this.DB, "generic_templates", {
    id: id,
    name: name,
    payload: mustJSON(template),
    updated_at: timePtr(template.Workflow.UpdatedAt),
  });
};

/**
 * 替换存储中的整个通用模板记录（调用方须已提前完成平台管理员鉴权）。
 *
 * @param {GenericTemplate} template - 待保存的通用模板对象。
 * @returns {void} 无返回值。
 * @throws {Error} 校验失败或数据库写入失败时抛出错误。
 */
CatalogRepo.prototype.PutGenericTemplate = function (template) {
  this.putGenericTemplate(template);
};

/**
 * 仅更新已存储通用模板中的工作流定义部分，保持其随附的角色、规则与技能不变。
 * 执行工作区重建准备校验、指标阶段校验与乐观并发修订号检查，有实质变更时先归档历史版本快照再落盘。
 *
 * @param {WorkflowDefinition} workflow - 待更新的通用模板工作流定义。
 * @returns {WorkflowDefinition} 更新后的工作流定义（若内容无实质变更则返回原定义）。
 * @throws {Error} 校验失败、模板不存在、修订号冲突、快照归档失败或写库失败时抛出错误。
 */
CatalogRepo.prototype.UpdateGenericWorkflow = function (workflow) {
  ValidateWorkflowPreparation(workflow);
  ValidateWorkflowMetricStages(workflow);
  const [template, ok] = this.GenericTemplateByWorkflow(workflow.ID);
  if (!ok) {
    throw new Error("generic template not found");
  }
  const old = template.Workflow;
  if (workflow.Revision !== old.Revision) {
    throw new Error(`workflow revision conflict: current revision is ${old.Revision}`);
  }
  workflow.Revision = old.Revision + 1;
  const now = new Date();
  workflow.Generic = true;
  workflow.ProjectID = "";
  workflow.Shared = false;
  if (workflow.Version === 0) {
    workflow.Version = template.Workflow.Version;
  }
  if (workflow.Version === 0) {
    workflow.Version = 1;
  }
  if (workflow.Status === "") {
    workflow.Status = template.Workflow.Status;
  }
  if (isZeroTime(workflow.CreatedAt)) {
    workflow.CreatedAt = template.Workflow.CreatedAt;
  }
  if ((workflow.Requirements ?? []).length === 0) {
    workflow.Requirements = template.Workflow.Requirements;
  }
  if (workflow.SandboxProfileID.trim() === "") {
    workflow.SandboxProfileID = template.Workflow.SandboxProfileID;
  }
  workflow.UpdatedAt = now;
  if (workflowContent(workflow) === workflowContent(old)) {
    return old;
  }
  workflow.PublishedRevision = workflowPublishedRevision(old);
  template.Workflow = workflow;
  this.snapshotRevision("workflow", old.ID, old.Name, old.Version, old.Revision, old);
  this.putGenericTemplate(template);
  return workflow;
};

/**
 * 替换指定通用模板中打包的单个内置角色定义，保持模板的工作流图、规则与技能不变，且不写入项目角色表。
 *
 * @param {string} workflowID - 目标通用模板的工作流 ID。
 * @param {AgentDefinition} agent - 待更新的角色定义对象。
 * @returns {AgentDefinition} 递增版本号并保存后的角色定义对象。
 * @throws {Error} 模板不存在、角色 ID 为空、角色不属于该模板、版本号冲突或写库失败时抛出错误。
 */
CatalogRepo.prototype.UpdateGenericAgent = function (workflowID, agent) {
  const [template, ok] = this.GenericTemplateByWorkflow(workflowID);
  if (!ok) {
    throw new Error("generic template not found");
  }
  const id = agent.ID.trim();
  if (id === "") {
    throw new Error("agent id is required");
  }
  let index = -1;
  for (let i = 0; i < template.Agents.length; i++) {
    if (template.Agents[i].ID === id) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    throw new Error(`角色 ${JSON.stringify(id)} 不属于该通用模板`);
  }
  const existing = template.Agents[index];
  agent.ID = id;
  agent.ProjectID = "";
  agent.Shared = false;
  if (agent.Version !== 0 && agent.Version !== existing.Version) {
    throw new Error(`角色 ${JSON.stringify(id)} 版本冲突：当前版本已是 ${existing.Version}，请刷新后重改`);
  }
  agent.Version = existing.Version + 1;
  if (isZeroTime(agent.UpdatedAt)) {
    agent.UpdatedAt = new Date();
  }
  template.Agents[index] = agent;
  this.putGenericTemplate(template);
  return agent;
};

/**
 * 在事务行锁保护下发布指定的通用模板工作流；仅当模板自上次发布后有变更时递增版本号与修订号。
 *
 * @param {string} id - 通用模板工作流 ID。
 * @returns {WorkflowDefinition} 发布后的工作流定义对象。
 * @throws {Error} 模板不存在或事务执行失败时抛出错误。
 */
CatalogRepo.prototype.PublishGenericWorkflow = function (id) {
  let published = new WorkflowDefinition();
  this.DB.Transaction((tx) => {
    const row = { ID: "" };
    const takeErr = this.locking(tx.Table("generic_templates")).Select("id").Where("id = ?", id).Take(row).Error;
    if (takeErr != null) {
      throw takeErr;
    }
    const catalog = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    catalog.DB = tx;
    catalog.deps = { ...this.deps, DB: tx };
    published = catalog.publishGenericWorkflow(id);
  });
  return published;
};

/**
 * 在当前数据库连接/事务上下文中执行单条通用模板工作流的发布状态更新。
 * 由 `PublishGenericWorkflow` 在持有行锁的事务内调用。
 *
 * @param {string} id - 通用模板工作流 ID。
 * @returns {WorkflowDefinition} 发布后的工作流定义对象。
 * @throws {Error} 模板不存在或写入失败时抛出错误。
 */
CatalogRepo.prototype.publishGenericWorkflow = function (id) {
  const [template, ok] = this.GenericTemplateByWorkflow(id);
  if (!ok) {
    throw new Error("generic template not found");
  }
  if (!workflowNeedsPublish(template.Workflow)) {
    return template.Workflow;
  }
  template.Workflow.Status = "published";
  template.Workflow.Version++;
  template.Workflow.Revision++;
  template.Workflow.PublishedRevision = template.Workflow.Revision;
  if (template.Workflow.Version < 1) {
    template.Workflow.Version = 1;
  }
  template.Workflow.UpdatedAt = new Date();
  this.putGenericTemplate(template);
  return template.Workflow;
};

/**
 * 按 ID 升序查询并返回 `generic_templates` 表中全部解码成功的通用模板。
 *
 * @returns {GenericTemplate[]} 通用模板对象数组；查询失败时返回空数组 `[]`。
 */
CatalogRepo.prototype.GenericTemplates = function () {
  const rows = [];
  if (this.DB.Order("id ASC").Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    try {
      const template = decodeGenericTemplate(row.Payload);
      out.push(template);
    } catch {
      continue;
    }
  }
  return out;
};

/**
 * 按工作流 ID 查找对应的完整通用模板。
 *
 * @param {string} id - 通用模板工作流 ID。
 * @returns {[GenericTemplate, boolean]} 返回 `[通用模板对象, 是否找到]`。
 */
CatalogRepo.prototype.GenericTemplateByWorkflow = function (id) {
  return this.loadGenericTemplate(id);
};

/**
 * 按工作流 ID 查找通用模板中的工作流定义。
 *
 * @param {string} id - 通用模板工作流 ID。
 * @returns {[WorkflowDefinition, boolean]} 返回 `[工作流定义对象, 是否找到]`。
 */
CatalogRepo.prototype.GenericWorkflowByID = function (id) {
  const [template, ok] = this.GenericTemplateByWorkflow(id);
  if (!ok) {
    return [new WorkflowDefinition(), false];
  }
  return [template.Workflow, true];
};

/**
 * 遍历全部已存储的通用模板，按角色 ID 查找对应的内置角色定义。
 *
 * @param {string} id - 角色 ID。
 * @returns {[AgentDefinition, boolean]} 返回 `[角色定义对象, 是否找到]`。
 */
CatalogRepo.prototype.GenericAgentByID = function (id) {
  id = id.trim();
  if (id === "") {
    return [new AgentDefinition(), false];
  }
  for (const template of this.GenericTemplates()) {
    for (const agent of template.Agents) {
      if (agent.ID === id) {
        return [agent, true];
      }
    }
  }
  return [new AgentDefinition(), false];
};

/**
 * 判断某个项目私有角色在给定工作流项目上下文中是否被排除在外（因其复用了某个通用模板内置角色 ID，
 * 仅在自己所属项目内生效，其他项目或通用模板自身运行时仍使用内置角色）。
 *
 * @param {AgentDefinition} agent - 待检查的存储角色定义。
 * @param {string} workflowProjectID - 目标工作流所属的项目 ID。
 * @returns {boolean} 若该角色在目标工作流项目中不生效（被模板角色隔离）则返回 `true`，否则返回 `false`。
 */
CatalogRepo.prototype.AgentShadowsTemplateOutside = function (agent, workflowProjectID) {
  if (agent.ProjectID.trim() === "" || agent.Shared || agent.ProjectID === workflowProjectID) {
    return false;
  }
  const [, inTemplate] = this.GenericAgentByID(agent.ID);
  return inTemplate;
};

/**
 * 列出运行时节点会实际解析到指定存储角色的所有工作流名称列表。
 *
 * @param {AgentDefinition} agent - 目标角色定义对象。
 * @returns {string[]} 引用该角色的工作流名称数组。
 */
CatalogRepo.prototype.WorkflowNamesUsingAgent = function (agent) {
  const names = [];
  for (const workflow of this.Workflows()) {
    if (this.AgentShadowsTemplateOutside(agent, workflow.ProjectID)) {
      continue;
    }
    for (const node of workflow.Nodes) {
      if (node.AgentID.trim() === agent.ID) {
        names.push(workflow.Name);
        break;
      }
    }
  }
  return names;
};

/**
 * 遍历全部已存储的通用模板，按规则 ID 查找对应的内置规则定义。
 *
 * @param {string} id - 规则 ID。
 * @returns {[RuleDefinition, boolean]} 返回 `[规则定义对象, 是否找到]`。
 */
CatalogRepo.prototype.GenericRuleByID = function (id) {
  id = id.trim();
  if (id === "") {
    return [new RuleDefinition(), false];
  }
  for (const template of this.GenericTemplates()) {
    for (const rule of template.Rules) {
      if (rule.ID === id) {
        return [rule, true];
      }
    }
  }
  return [new RuleDefinition(), false];
};

/**
 * 遍历全部已存储的通用模板，按技能 ID 查找对应的内置技能定义。
 *
 * @param {string} id - 技能 ID。
 * @returns {[SkillDefinition, boolean]} 返回 `[技能定义对象, 是否找到]`。
 */
CatalogRepo.prototype.GenericSkillByID = function (id) {
  id = id.trim();
  if (id === "") {
    return [new SkillDefinition(), false];
  }
  for (const template of this.GenericTemplates()) {
    for (const skill of template.Skills) {
      if (skill.ID === id) {
        return [skill, true];
      }
    }
  }
  return [new SkillDefinition(), false];
};

/**
 * 返回所有已存储通用模板中的工作流定义列表。
 *
 * @returns {WorkflowDefinition[]} 通用模板工作流定义数组。
 */
CatalogRepo.prototype.GenericWorkflows = function () {
  const templates = this.GenericTemplates();
  const out = [];
  for (const template of templates) {
    out.push(template.Workflow);
  }
  return out;
};

module.exports = { decodeGenericTemplate, isZeroTime };
