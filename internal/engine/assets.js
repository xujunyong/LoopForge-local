/**
 * @file assets.js
 * 对应 Go 源文件：internal/engine/assets.go
 * 作用与职责边界：负责运行期角色资产的解析与组装，包括平台内置 MCP、知识库代理 MCP、
 * 规则/技能/MCP 服务可见性校验与文件加载、工作流全局规则注入、工作流角色解析、
 * 项目沙箱选择以及脚本节点 MCP 资产收集。
 * 语法差异说明：
 * - Go 的 `sync.Mutex` 在单线程 JS 中省略。
 * - Go 的 `(T, bool)` 多返回值译为 `[值, boolean]` 二元组。
 * - Go 的集合 `map[string]struct{}` 译为普通对象 `{}`（值为 `true`）。
 * - 属于 `Engine` 的方法统一挂载在 `Engine.prototype` 上。
 */

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

/**
 * 构造预留的 `agentflow-platform` 平台侧 MCP 服务定义。
 * 使用场景：当角色开启 `PlatformMCP` 开关时调用，将平台地址与内存中的鉴权 Token 组装为 HTTP MCP 配置。
 *
 * @returns {MCPServerDefinition} 平台侧 MCP 服务定义对象。
 */
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

/**
 * 为角色构造只读团队知识库代理 MCP 服务定义，并签发项目级临时代理 Token。
 * 使用场景：角色开启 `KnowledgeBase` 开关时调用；知识中心未就绪或签发失败时静默降级返回 `false`，不中断运行。
 *
 * @param {string} agentID - 角色 ID。
 * @param {string} projectID - 项目 ID。
 * @param {number} userID - 触发用户 ID。
 * @returns {[MCPServerDefinition, boolean]} 成功返回 `[MCP 服务定义, true]`，不可用时返回 `[空定义, false]`。
 */
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

/**
 * 生成“角色开启知识库但未能注入知识库 MCP”的告警提示文本。
 * 使用场景：节点执行日志记录，提示用户为何角色配置了团队知识库却缺少对应工具。
 *
 * @param {object} agent - 角色定义对象（domain.AgentDefinition）。
 * @param {AgentAssetBundle} assets - 已解析的角色资产包。
 * @returns {string} 未开启或已成功注入时返回空字符串，否则返回中文告警说明。
 */
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

/**
 * 在非 SOP 运行场景下（如对话子代理）解析角色资产包，不附加工作流全局规则。
 * 使用场景：对话助手或独立子代理调用角色时加载规则、技能与 MCP 服务。
 *
 * @param {object} agent - 角色定义对象（domain.AgentDefinition）。
 * @param {string} projectID - 项目 ID。
 * @param {number} userID - 触发用户 ID。
 * @returns {AgentAssetBundle} 解析完成的角色资产包。
 */
Engine.prototype.RoleAssets = function (agent, projectID, userID) {
  return this.resolveAssets(agent, projectID, "", userID);
};

/**
 * 解析角色在指定项目与工作流下的完整资产包（规则、技能及其附件、可见 MCP 服务、平台/知识库 MCP 及工作流全局规则）。
 * 使用场景：执行 Agent 节点或对话角色前统一组装注入上下文。
 *
 * @param {object} agent - 角色定义对象（domain.AgentDefinition）。
 * @param {string} projectID - 当前项目 ID。
 * @param {string} workflowID - 当前工作流 ID（非工作流场景为空字符串）。
 * @param {number} userID - 触发用户 ID。
 * @returns {AgentAssetBundle} 组装完成的角色资产包。
 */
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

/**
 * 判断目录中的某个 MCP 服务对当前运行（项目与触发用户）是否可见。
 * 使用场景：过滤角色绑定的 MCP 服务列表，防止跨项目或越权使用他人个人 MCP。
 *
 * @param {MCPServerDefinition} server - MCP 服务定义对象。
 * @param {string} projectID - 当前运行所属项目 ID。
 * @param {number} userID - 当前触发用户 ID。
 * @returns {boolean} 允许注入本次运行时返回 `true`，否则返回 `false`。
 */
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

/**
 * 将标记为全局且绑定到指定工作流的项目/共享规则追加到资产包中（自动按规则 ID 去重）。
 * 使用场景：工作流内所有 Agent 节点共享全局规范，即使角色本身未显式勾选该规则也能收到。
 *
 * @param {AgentAssetBundle} bundle - 待追加规则的角色资产包对象。
 * @param {string} projectID - 当前项目 ID。
 * @param {string} workflowID - 当前工作流 ID。
 * @returns {void} 无返回值。
 */
Engine.prototype.appendWorkflowGlobalRules = function (bundle, projectID, workflowID) {
  workflowID = workflowID.trim();
  if (workflowID === "" || this == null || this.repo == null) {
    return;
  }
  const have = {};
  for (const rule of bundle.Rules) {
    have[rule.ID] = true;
  }
  for (const rule of this.repo.Rules()) {
    if (!rule.Global) {
      continue;
    }
    if (have[rule.ID]) {
      continue;
    }
    if (rule.ProjectID !== projectID && !rule.Shared) {
      continue;
    }
    if (!ruleTargetsWorkflow(rule, workflowID)) {
      continue;
    }
    bundle.Rules.push(rule);
    have[rule.ID] = true;
  }
};

/**
 * 判断规则是否绑定了指定的工作流 ID。
 * 使用场景：由 `appendWorkflowGlobalRules` 过滤全局规则的目标工作流。
 *
 * @param {object} rule - 规则定义对象（domain.RuleDefinition）。
 * @param {string} workflowID - 已去除首尾空白的工作流 ID。
 * @returns {boolean} 规则的 `WorkflowIDs` 中包含该工作流 ID 时返回 `true`，否则返回 `false`。
 */
function ruleTargetsWorkflow(rule, workflowID) {
  for (const id of rule.WorkflowIDs) {
    if (id.trim() === workflowID) {
      return true;
    }
  }
  return false;
}

/**
 * 解析工作流节点引用的角色定义，按顺序兼容预览构建内置角色、通用模板角色、项目角色与通用回退角色。
 * 使用场景：调度或构建工作流节点执行配置时解析 `AgentDefinition`，并对基线对齐角色应用节点执行器覆写。
 *
 * @param {object} st - 仓库存储实例（repo.Store）。
 * @param {object} wf - 工作流定义对象（domain.WorkflowDefinition）。
 * @param {string} id - 角色 ID。
 * @returns {[object, boolean]} 找到时返回 `[AgentDefinition, true]`，未找到时返回 `[空定义, false]`。
 */
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

/**
 * 在不跨越项目边界的前提下，为通用模板或项目工作流解析最合适的沙箱配置。
 * 使用场景：优先选用可见的 `preferred` 沙箱，其次按 ID 升序选用本项目沙箱，最后回退到平台共享沙箱。
 *
 * @param {object} st - 仓库存储实例（repo.Store）。
 * @param {string} preferred - 首选沙箱配置 ID。
 * @param {string} projectID - 当前项目 ID。
 * @returns {[SandboxProfile, boolean]} 找到可用沙箱时返回 `[SandboxProfile, true]`，否则返回 `[空配置, false]`。
 */
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

/**
 * 查找项目内安装的指定市场 MCP 服务实例（支持按市场目录 ID 或 URL 路径别名匹配）。
 * 使用场景：通用角色绑定市场 ID 或别名时，将其解析到当前项目已安装的项目级 MCP 服务。
 *
 * @param {string} marketID - 市场目录 ID 或别名。
 * @param {string} projectID - 当前项目 ID。
 * @returns {[MCPServerDefinition, boolean]} 命中时返回 `[MCPServerDefinition, true]`，否则返回 `[空定义, false]`。
 */
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

/**
 * 判断某个已安装的 MCP 服务是否匹配给定的市场引用（忽略大小写比对 `MarketID` 或 URL 末尾路径段）。
 * 使用场景：由 `projectMarketMCP` 调用，兼容数字 ID 与别名引用。
 *
 * @param {MCPServerDefinition} server - MCP 服务定义对象。
 * @param {string} ref - 角色引用的市场 ID 或别名。
 * @returns {boolean} 匹配时返回 `true`，否则返回 `false`。
 */
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

/**
 * 收集脚本节点可用的全部项目级与触发者个人级 MCP 资产及其附件。
 * 使用场景：脚本节点执行前准备可供脚本调用的 MCP 配置集合。
 *
 * @param {string} projectID - 当前项目 ID。
 * @param {number} userID - 触发用户 ID。
 * @returns {AgentAssetBundle} 仅包含可见 MCP 服务与附件的资产包。
 */
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

/**
 * 当 MCP 服务声明了附件引用时，从存储层加载其附件字节内容并写入资产包的 `MCPFiles`。
 * 使用场景：解析角色或脚本 MCP 资产时补充随服务下发的配置文件或脚本。
 *
 * @param {AgentAssetBundle|null} bundle - 目标资产包对象。
 * @param {MCPServerDefinition} server - MCP 服务定义对象。
 * @returns {void} 无返回值。
 */
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
