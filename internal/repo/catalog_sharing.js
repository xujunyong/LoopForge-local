// catalog_sharing.js —— 对应 Go 文件：internal/repo/catalog_sharing.go
// 作用：目录共享：角色、技能、SOP 共享时的资产与边界校验。
// Go 的 fmt.Errorf %q/%w 译为模板字符串。

"use strict";

const { IsPreviewBuildAgent } = require("../domain/preview.js"); // 对应 Go 的 domain.IsPreviewBuildAgent，preview.js 已翻译
const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// PutAgentWithSharing preserves the catalog save path: a shared agent shares
// its owned rules and skills before its definition is saved.
CatalogRepo.prototype.PutAgentWithSharing = function (v) {
  if (v.Shared) {
    const err = this.ShareAgentAssets(v);
    if (err != null) {
      return err;
    }
  }
  return this.PutAgent(v);
};

// ShareAgent shares a stored agent through the same boundary as catalog saves.
// Already-shared agents are reused without replaying their dependency writes.
CatalogRepo.prototype.ShareAgent = function (id) {
  const [v, ok] = this.Agent(id);
  if (!ok) {
    return new Error(`agent "${id}" not found`);
  }
  if (v.Shared) {
    return null;
  }
  v.Shared = true;
  return this.PutAgentWithSharing(v);
};

// ShareAgentAssets is the existing catalog policy for direct agent bindings.
CatalogRepo.prototype.ShareAgentAssets = function (agent) {
  for (const id of agent.Rules) {
    const [item, ok] = this.Rule(id);
    if (!ok || item.Shared || (item.ProjectID !== "" && item.ProjectID !== agent.ProjectID)) {
      continue;
    }
    item.Shared = true;
    const err = this.PutRule(item);
    if (err != null) {
      return new Error(`share rule "${id}": ${err.message}`);
    }
  }
  for (const id of agent.Skills) {
    const [item, ok] = this.Skill(id);
    if (!ok || item.Shared || (item.ProjectID !== "" && item.ProjectID !== agent.ProjectID)) {
      continue;
    }
    item.Shared = true;
    const err = this.PutSkill(item);
    if (err != null) {
      return new Error(`share skill "${id}": ${err.message}`);
    }
  }
  return null;
};

// ShareSkill keeps the stored definition and file manifest intact when only
// its sharing state changes. Skill file contents remain in their own table.
CatalogRepo.prototype.ShareSkill = function (id) {
  const [v, ok] = this.Skill(id);
  if (!ok) {
    return new Error(`skill "${id}" not found`);
  }
  if (v.Shared) {
    return null;
  }
  v.Shared = true;
  return this.PutSkill(v);
};

// ValidateWorkflowAgentScopes is shared by SOP saves and sharing transitions.
CatalogRepo.prototype.ValidateWorkflowAgentScopes = function (workflow) {
  const projectID = workflow.ProjectID.trim();
  if (projectID === "") {
    return null;
  }
  for (const node of workflow.Nodes) {
    if (node.Type !== "agent") {
      continue;
    }
    const agentID = node.AgentID.trim();
    if (agentID === "" || IsPreviewBuildAgent(agentID)) {
      continue;
    }
    const [agent, ok] = this.Agent(agentID);
    if (!ok) {
      return new Error(`角色 "${agentID}" 不存在`);
    }
    const owner = agent.ProjectID.trim();
    if (owner === "" || (owner !== projectID && !agent.Shared)) {
      return new Error(`角色 "${agent.Name}" 不属于当前项目且尚未共享`);
    }
  }
  return null;
};

// ValidateWorkflowSharing preserves the SOP sandbox boundary. Sharing a SOP
// requires an already-shared sandbox; it does not share the sandbox itself.
CatalogRepo.prototype.ValidateWorkflowSharing = function (v) {
  if (v.SandboxProfileID.trim() === "") {
    return new Error("workflow sandboxProfileId is required");
  }
  const [profile, ok] = this.Sandbox(v.SandboxProfileID);
  if (!ok) {
    return new Error("sandbox profile not found");
  }
  if (v.ProjectID !== "" && profile.ProjectID !== "" && profile.ProjectID !== v.ProjectID && !profile.Shared) {
    return new Error("沙箱不属于当前项目且尚未共享");
  }
  if (v.Shared && !profile.Shared) {
    return new Error("共享 SOP 只能使用已共享的沙箱");
  }
  return null;
};

// ShareWorkflow applies SOP sharing checks before the ordinary save path,
// including its existing notification and revision validation.
CatalogRepo.prototype.ShareWorkflow = function (id) {
  const [v, ok] = this.Workflow(id);
  if (!ok) {
    return new Error(`workflow "${id}" not found`);
  }
  if (v.Shared || v.Generic) {
    return null;
  }
  v.Shared = true;
  let err = this.ValidateWorkflowAgentScopes(v);
  if (err != null) {
    return err;
  }
  err = this.ValidateWorkflowSharing(v);
  if (err != null) {
    return err;
  }
  return this.PutWorkflow(v);
};
