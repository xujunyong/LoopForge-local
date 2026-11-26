// assets.js —— 对应 Go 文件：internal/engine/assets.go
// 作用：角色资产解析：规则、技能、MCP 服务与工作流全局规则的组装。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 待翻译
const { BaselineAlignWorkflowID } = require("./align.js"); // 对应 Go 同包常量，align.js 本批翻译
const { BaselineAlignAgentID, PlatformMCPServerID } = require("../domain/agent.js"); // 对应 Go 的 domain.BaselineAlignAgentID/PlatformMCPServerID，domain 已翻译
const { MCPServerDefinition, AgentAssetBundle, SandboxProfile } = require("../domain/assets.js"); // 对应 Go 的 domain.MCPServerDefinition/AgentAssetBundle/SandboxProfile，domain 已翻译
const { KnowledgeMCPServerID } = require("../domain/knowledge.js"); // 对应 Go 的 domain.KnowledgeMCPServerID，domain 已翻译
const { IsPreviewBuildAgent } = require("../domain/preview.js"); // 对应 Go 的 domain.IsPreviewBuildAgent，domain 已翻译
const { PreviewBuildAgent } = require("../domain/preview_build.js"); // 对应 Go 的 domain.PreviewBuildAgent，domain 已翻译
const { SignProxyToken } = require("../knowledge/token.js"); // 对应 Go 的 knowledge.SignProxyToken，knowledge 待翻译
const { MCPServerDefinition: knowledgeMCPServerDefinition, UsageRule } = require("../knowledge/rules.js"); // 对应 Go 的 knowledge.MCPServerDefinition/UsageRule，knowledge 待翻译

Engine.prototype.platformMCPServer = function () {
  // Go 的 sync.Mutex 省略，JS 单线程无需加锁。
  const base = this.platformMCPBase;
  const token = this.platformMCPToken;
  const def = new MCPServerDefinition({ ID: PlatformMCPServerID, Name: "LoopForge 平台", Scope: "project", Description: "LoopForge 平台侧能力：需求、任务、运行、项目等平台操作以 MCP 工具提供", Transport: "http", URL: base + "/mcp", TimeoutSec: 60 });
  if (token !== "") {
    def.Headers = { Authorization: "Bearer " + token };
  }
  return def;
};

Engine.prototype.knowledgeMCPServer = function (agentID, projectID, userID) {
  if (this.repo == null) {
    return [new MCPServerDefinition(), false];
  }
  // Go 的 sync.Mutex 省略，JS 单线程无需加锁。
  const base = this.platformMCPBase;
  const settings = this.repo.KnowledgeSettings();
  if (!settings.Ready()) {
    return [new MCPServerDefinition(), false];
  }
  let token;
  try {
    token = SignProxyToken(settings, { ProjectID: projectID, UserID: userID, AgentID: agentID }, new Date());
  } catch {
    return [new MCPServerDefinition(), false];
  }
  return [knowledgeMCPServerDefinition(base, token), true];
};

function knowledgeSkippedWarning(agent, assets) {
  if (!agent.KnowledgeBase) {
    return "";
  }
  for (const server of assets.MCPServers) {
    if (server.ID === KnowledgeMCPServerID) {
      return "";
    }
  }
  return "角色开启了团队知识库，但未注入 " + KnowledgeMCPServerID + "：知识中心未启用或未配置知识库地址/Token";
}

Engine.prototype.RoleAssets = function (agent, projectID, userID) {
  return this.resolveAssets(agent, projectID, "", userID);
};

Engine.prototype.resolveAssets = function (agent, projectID, workflowID, userID) {
  const bundle = new AgentAssetBundle();
  for (const id of agent.Rules) {
    const [v, ok] = this.repo.Rule(id);
    if (ok) {
      if (v.ProjectID !== projectID && !v.Shared) {
        const [tmpl, found] = this.repo.GenericRuleByID(id);
        if (found) {
          bundle.Rules.push(tmpl);
        }
        continue;
      }
      bundle.Rules.push(v);
      continue;
    }
    const [gv, gok] = this.repo.GenericRuleByID(id);
    if (gok) {
      bundle.Rules.push(gv);
    }
  }
  for (const id of agent.Skills) {
    const [v, ok] = this.repo.Skill(id);
    if (ok) {
      if (v.ProjectID !== projectID && !v.Shared) {
        const [tmpl, found] = this.repo.GenericSkillByID(id);
        if (found) {
          bundle.Skills.push(tmpl);
        }
        continue;
      }
      if (v.FileRefs.length > 0) {
        const contents = this.repo.SkillFileContents(v.ID);
        if (contents != null && Object.keys(contents).length > 0) {
          if (bundle.SkillFiles == null) {
            bundle.SkillFiles = {};
          }
          bundle.SkillFiles[v.ID] = contents;
        }
      }
      bundle.Skills.push(v);
      continue;
    }
    const [gv, gok] = this.repo.GenericSkillByID(id);
    if (gok) {
      bundle.Skills.push(gv);
    }
  }
  for (const id of agent.MCPServers) {
    const [v, ok] = this.repo.MCPServer(id);
    if (ok) {
      if (!roleMCPServerVisible(v, projectID, userID)) {
        continue;
      }
      bundle.MCPServers.push(v);
      this.loadMCPFiles(bundle, v);
      continue;
    }
    const [pv, pok] = this.projectMarketMCP(id, projectID);
    if (pok) {
      bundle.MCPServers.push(pv);
    }
  }
  // 平台 MCP 是角色级独立开关（不进 mcpServers 列表）：开启即注入 agentflow-platform，让本次调用拿到平台侧操作工具。
  if (agent.PlatformMCP) {
    bundle.MCPServers.push(this.platformMCPServer());
  }
  if (agent.KnowledgeBase) {
    const [v, ok] = this.knowledgeMCPServer(agent.ID, projectID, userID);
    if (ok) {
      bundle.MCPServers.push(v);
      bundle.Rules.push(UsageRule());
    }
  }
  this.appendWorkflowGlobalRules(bundle, projectID, workflowID);
  return bundle;
};

function roleMCPServerVisible(server, projectID, userID) {
  switch (server.Scope) {
    case "":
      return false;
    case "project":
      return server.ProjectID === projectID;
    case "personal":
      return server.OwnerUserID === userID && server.MarketID === "";
    default:
      return true;
  }
}

Engine.prototype.appendWorkflowGlobalRules = function (bundle, projectID, workflowID) {
  workflowID = workflowID.trim();
  if (workflowID === "" || this == null || this.repo == null) {
    return;
  }
  const have = new Set();
  for (const rule of bundle.Rules) {
    have.add(rule.ID);
  }
  for (const rule of this.repo.Rules()) {
    if (!rule.Global) {
      continue;
    }
    if (have.has(rule.ID)) {
      continue;
    }
    if (rule.ProjectID !== projectID && !rule.Shared) {
      continue;
    }
    if (!ruleTargetsWorkflow(rule, workflowID)) {
      continue;
    }
    bundle.Rules.push(rule);
    have.add(rule.ID);
  }
};

function ruleTargetsWorkflow(rule, workflowID) {
  for (const id of rule.WorkflowIDs) {
    if (id.trim() === workflowID) {
      return true;
    }
  }
  return false;
}

function workflowAgent(st, wf, id) {
  if (IsPreviewBuildAgent(id)) {
    return [PreviewBuildAgent(wf.Preview), true];
  }
  if (wf.Generic) {
    const [template, ok] = st.GenericTemplateByWorkflow(wf.ID);
    if (ok) {
      for (const role of template.Agents) {
        if (role.ID === id) {
          return [role, true];
        }
      }
    }
  }
  const [agent, ok] = st.Agent(id);
  if (ok) {
    if (st.AgentShadowsTemplateOutside(agent, wf.ProjectID)) {
      return st.GenericAgentByID(id);
    }
    if (wf.ID === BaselineAlignWorkflowID && id === BaselineAlignAgentID) {
      for (const node of wf.Nodes) {
        if (node.Type === "agent" && node.AgentID === id && node.ExecutorID !== "") {
          if (agent.ExecutorID !== node.ExecutorID) {
            agent.ExecutorID = node.ExecutorID;
            agent.Model = "";
            agent.Effort = "";
          }
          break;
        }
      }
    }
    return [agent, true];
  }
  return st.GenericAgentByID(id);
}

function projectSandbox(st, preferred, projectID) {
  const [profile, ok] = st.Sandbox(preferred);
  if (ok && (profile.ProjectID === projectID || profile.ProjectID === "" || profile.Shared)) {
    return [profile, true];
  }
  const profiles = st.Sandboxes();
  profiles.sort((a, b) => (a.ID < b.ID ? -1 : a.ID > b.ID ? 1 : 0));
  for (const p of profiles) {
    if (p.ProjectID === projectID) {
      return [p, true];
    }
  }
  for (const p of profiles) {
    if (p.ProjectID === "" || p.Shared) {
      return [p, true];
    }
  }
  return [new SandboxProfile(), false];
}

Engine.prototype.projectMarketMCP = function (marketID, projectID) {
  marketID = marketID.trim();
  if (marketID === "" || projectID.trim() === "") {
    return [new MCPServerDefinition(), false];
  }
  for (const v of this.repo.MCPServers()) {
    if (v.Scope === "project" && v.ProjectID === projectID && projectMarketMCPMatches(v, marketID)) {
      return [v, true];
    }
  }
  return [new MCPServerDefinition(), false];
};

function projectMarketMCPMatches(server, ref) {
  ref = ref.trim();
  const marketID = server.MarketID.trim();
  if (ref === "" || marketID === "") {
    return false;
  }
  if (marketID.toLowerCase() === ref.toLowerCase()) {
    return true;
  }
  const u = server.URL.trim().replace(/\/+$/, "").toLowerCase();
  return u.endsWith("/" + ref.toLowerCase());
}

Engine.prototype.resolveScriptMCPAssets = function (projectID, userID) {
  const bundle = new AgentAssetBundle();
  projectID = projectID.trim();
  for (const v of this.repo.MCPServers()) {
    if (v.Scope === "project" && v.ProjectID.trim() === projectID) {
      bundle.MCPServers.push(v);
      this.loadMCPFiles(bundle, v);
      continue;
    }
    if (v.Scope === "personal" && v.OwnerUserID === userID && v.MarketID.trim() === "") {
      bundle.MCPServers.push(v);
      this.loadMCPFiles(bundle, v);
    }
  }
  return bundle;
};

Engine.prototype.loadMCPFiles = function (bundle, server) {
  if (bundle == null || server.FileRefs.length === 0) {
    return;
  }
  const contents = this.repo.MCPFileContents(server.ID);
  if (contents != null && Object.keys(contents).length > 0) {
    if (bundle.MCPFiles == null) {
      bundle.MCPFiles = {};
    }
    bundle.MCPFiles[server.ID] = contents;
  }
};

module.exports = { knowledgeSkippedWarning, roleMCPServerVisible, ruleTargetsWorkflow, workflowAgent, projectSandbox, projectMarketMCPMatches };
