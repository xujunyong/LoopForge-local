// generic_store.js —— 对应 Go 文件：internal/repo/generic_store.go
// 作用：通用模板的存取：按工作流读写 generic_templates 表并做版本与发布控制。

"use strict";

const { Buffer } = require("node:buffer");

const { WorkflowDefinition, AgentDefinition, RuleDefinition, SkillDefinition, ValidateWorkflowMetricStages } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition 等，domain 已翻译
const { ValidateWorkflowPreparation } = require("../domain/workspace_preparation.js"); // 对应 Go 的 domain.ValidateWorkflowPreparation，domain 已翻译
const { GenericTemplate } = require("./generic_workflows.js"); // 对应 Go 同包类型，generic_workflows.js 本次一同翻译
const { genericTemplateRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON, upsert, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译
const { workflowContent, workflowPublishedRevision, workflowNeedsPublish } = require("./catalog.js"); // 对应 Go 同包函数，catalog.js 待翻译

// Go 的 time.Time 零值译为 null。
function isZeroTime(t) {
  return t == null;
}

CatalogRepo.prototype.loadGenericTemplate = function (id) {
  id = id.trim();
  if (id === "") {
    return [new GenericTemplate(), false];
  }
  const row = new genericTemplateRow();
  if (this.DB.Where("id = ?", id).Take(row).Error != null || row.Payload == null || row.Payload.length === 0) {
    return [new GenericTemplate(), false];
  }
  const [template, err] = decodeGenericTemplate(row.Payload);
  if (err != null) {
    return [new GenericTemplate(), false];
  }
  return [template, true];
};

function decodeGenericTemplate(raw) {
  let parsed;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
  } catch (err) {
    return [new GenericTemplate(), err];
  }
  const template = new GenericTemplate(parsed);
  if (parsed.Workflow != null) {
    const workflow = new WorkflowDefinition();
    workflow.UnmarshalJSON(JSON.stringify(parsed.Workflow));
    template.Workflow = workflow;
  }
  // Agents/Rules/Skills 只有小驼峰 JSON 键，domain 类构造器认 Go 字段名，直接构造只填默认值。
  template.Agents = (parsed.Agents ?? []).map((a) => new AgentDefinition(a));
  template.Rules = (parsed.Rules ?? []).map((r) => new RuleDefinition(r));
  template.Skills = (parsed.Skills ?? []).map((s) => new SkillDefinition(s));
  if (template.Workflow.ID.trim() === "") {
    return [new GenericTemplate(), new Error("generic template missing workflow id")];
  }
  template.Workflow.Generic = true;
  template.Workflow.ProjectID = "";
  template.Workflow.Shared = false;
  return [template, null];
}

CatalogRepo.prototype.putGenericTemplate = function (template) {
  const id = template.Workflow.ID.trim();
  if (id === "") {
    return new Error("generic template workflow id is required");
  }
  template.Workflow.ID = id;
  template.Workflow.Generic = true;
  template.Workflow.ProjectID = "";
  template.Workflow.Shared = false;
  const err = this.validateWorkflowNotifications(template.Workflow);
  if (err != null) {
    return err;
  }
  const now = new Date();
  if (isZeroTime(template.Workflow.UpdatedAt)) {
    template.Workflow.UpdatedAt = now;
  }
  let name = template.Workflow.Name.trim();
  if (name === "") {
    name = id;
  }
  return upsert(this.DB, "generic_templates", {
    id: id,
    name: name,
    payload: mustJSON(template),
    updated_at: timePtr(template.Workflow.UpdatedAt),
  });
};

CatalogRepo.prototype.PutGenericTemplate = function (template) {
  return this.putGenericTemplate(template);
};

CatalogRepo.prototype.UpdateGenericWorkflow = function (workflow) {
  let err = ValidateWorkflowPreparation(workflow);
  if (err != null) {
    return [new WorkflowDefinition(), err];
  }
  err = ValidateWorkflowMetricStages(workflow);
  if (err != null) {
    return [new WorkflowDefinition(), err];
  }
  const [template, ok] = this.GenericTemplateByWorkflow(workflow.ID);
  if (!ok) {
    return [new WorkflowDefinition(), new Error("generic template not found")];
  }
  const old = template.Workflow;
  if (workflow.Revision !== old.Revision) {
    return [new WorkflowDefinition(), new Error(`workflow revision conflict: current revision is ${old.Revision}`)];
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
    return [old, null];
  }
  workflow.PublishedRevision = workflowPublishedRevision(old);
  template.Workflow = workflow;
  err = this.snapshotRevision("workflow", old.ID, old.Name, old.Version, old.Revision, old);
  if (err != null) {
    return [new WorkflowDefinition(), err];
  }
  err = this.putGenericTemplate(template);
  if (err != null) {
    return [new WorkflowDefinition(), err];
  }
  return [workflow, null];
};

CatalogRepo.prototype.UpdateGenericAgent = function (workflowID, agent) {
  const [template, ok] = this.GenericTemplateByWorkflow(workflowID);
  if (!ok) {
    return [new AgentDefinition(), new Error("generic template not found")];
  }
  const id = agent.ID.trim();
  if (id === "") {
    return [new AgentDefinition(), new Error("agent id is required")];
  }
  let index = -1;
  for (let i = 0; i < template.Agents.length; i++) {
    if (template.Agents[i].ID === id) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    return [new AgentDefinition(), new Error(`角色 ${JSON.stringify(id)} 不属于该通用模板`)];
  }
  const existing = template.Agents[index];
  agent.ID = id;
  agent.ProjectID = "";
  agent.Shared = false;
  if (agent.Version !== 0 && agent.Version !== existing.Version) {
    return [new AgentDefinition(), new Error(`角色 ${JSON.stringify(id)} 版本冲突：当前版本已是 ${existing.Version}，请刷新后重改`)];
  }
  agent.Version = existing.Version + 1;
  if (isZeroTime(agent.UpdatedAt)) {
    agent.UpdatedAt = new Date();
  }
  template.Agents[index] = agent;
  const err = this.putGenericTemplate(template);
  if (err != null) {
    return [new AgentDefinition(), err];
  }
  return [agent, null];
};

CatalogRepo.prototype.PublishGenericWorkflow = function (id) {
  let published = new WorkflowDefinition();
  const err = this.DB.Transaction((tx) => {
    const row = { ID: "" };
    const takeErr = this.locking(tx.Table("generic_templates")).Select("id").Where("id = ?", id).Take(row).Error;
    if (takeErr != null) {
      return takeErr;
    }
    const catalog = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    catalog.DB = tx;
    catalog.deps = { ...this.deps, DB: tx };
    let publishErr;
    [published, publishErr] = catalog.publishGenericWorkflow(id);
    return publishErr;
  });
  return [published, err];
};

CatalogRepo.prototype.publishGenericWorkflow = function (id) {
  const [template, ok] = this.GenericTemplateByWorkflow(id);
  if (!ok) {
    return [new WorkflowDefinition(), new Error("generic template not found")];
  }
  if (!workflowNeedsPublish(template.Workflow)) {
    return [template.Workflow, null];
  }
  template.Workflow.Status = "published";
  template.Workflow.Version++;
  template.Workflow.Revision++;
  template.Workflow.PublishedRevision = template.Workflow.Revision;
  if (template.Workflow.Version < 1) {
    template.Workflow.Version = 1;
  }
  template.Workflow.UpdatedAt = new Date();
  const err = this.putGenericTemplate(template);
  if (err != null) {
    return [new WorkflowDefinition(), err];
  }
  return [template.Workflow, null];
};

CatalogRepo.prototype.GenericTemplates = function () {
  const rows = [];
  if (this.DB.Order("id ASC").Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const [template, err] = decodeGenericTemplate(row.Payload);
    if (err != null) {
      continue;
    }
    out.push(template);
  }
  return out;
};

CatalogRepo.prototype.GenericTemplateByWorkflow = function (id) {
  return this.loadGenericTemplate(id);
};

CatalogRepo.prototype.GenericWorkflowByID = function (id) {
  const [template, ok] = this.GenericTemplateByWorkflow(id);
  if (!ok) {
    return [new WorkflowDefinition(), false];
  }
  return [template.Workflow, true];
};

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

CatalogRepo.prototype.AgentShadowsTemplateOutside = function (agent, workflowProjectID) {
  if (agent.ProjectID.trim() === "" || agent.Shared || agent.ProjectID === workflowProjectID) {
    return false;
  }
  const [, inTemplate] = this.GenericAgentByID(agent.ID);
  return inTemplate;
};

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

CatalogRepo.prototype.GenericWorkflows = function () {
  const templates = this.GenericTemplates();
  const out = [];
  for (const template of templates) {
    out.push(template.Workflow);
  }
  return out;
};

module.exports = { decodeGenericTemplate, isZeroTime };
