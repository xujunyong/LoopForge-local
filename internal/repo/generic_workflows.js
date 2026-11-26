/**
 * @file internal/repo/generic_workflows.js
 * @description 对应 Go 文件：internal/repo/generic_workflows.go
 * 职责与边界：定义平台级通用交付 SOP 模板（后端、产品、前端）的稳定标识常量，
 * 包括工作流 ID、平台 Docker 沙箱 ID、角色 ID、前置依赖键、规则 ID、技能 ID，
 * 以及存储于 `generic_templates` 表的组合载荷结构 `GenericTemplate`。
 * 语法差异说明：
 * - Go 结构体 `GenericTemplate` 译为带默认零值初始化的 ES6 类：嵌入值结构体初始化为默认实例，切片初始化为 `[]`，数值初始化为 `0`。
 */

"use strict";

const { WorkflowDefinition } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition，domain 已翻译

/** 存储在 `generic_templates` 表中的平台后端交付 SOP 稳定标识。 */
const GenericBackendDeliveryWorkflowID = "generic-backend-delivery";

/** 通用后端 SOP 绑定的平台 Docker 沙箱目录行标识（由初始化 SQL 写入，不在模板载荷内）。 */
const GenericDockerSandboxID = "generic-docker";

// 平台后端通用模板使用的角色标识；克隆模板时会将这些角色复制到目标项目。
const GenericAgentRequirement = "loopforge-requirement";
const GenericAgentDesign = "loopforge-design";
const GenericAgentImplement = "loopforge-implement";
const GenericAgentReview = "loopforge-review";
const GenericAgentTest = "loopforge-test";
const GenericAgentMR = "loopforge-mr";
const GenericAgentSummary = "loopforge-summary";

// 通用模板可声明的前置依赖键；Studio 会将其映射到个人凭据或项目 MCP 安装检查。
const RequirementGongfengGitToken = "gongfeng-git-token";
const RequirementGongfengMCP = "gongfeng-mcp";
const RequirementTAPDMCP = "tapd-mcp";

// 产品与前端交付模板的工作流标识，与后端 SOP 共用 `generic_templates` 表。
const GenericProductDeliveryWorkflowID = "generic-product-delivery";
const GenericFrontendDeliveryWorkflowID = "generic-frontend-delivery";

// 产品交付通用模板的角色标识。
const GenericAgentProductPRD = "product-prd";
const GenericAgentProductDemo = "product-demo";
const GenericAgentProductHandoff = "product-handoff";
const GenericAgentProductAcceptance = "product-acceptance";
const GenericAgentProductTAPD = "product-tapd";
const GenericAgentProductSummary = "product-summary";

// 前端交付通用模板的角色标识。
const GenericAgentFrontendShape = "frontend-shape";
const GenericAgentFrontendDesign = "frontend-design";
const GenericAgentFrontendBuild = "frontend-build";
const GenericAgentFrontendReview = "frontend-review";
const GenericAgentFrontendVerify = "frontend-verify";
const GenericAgentFrontendMR = "frontend-mr";
const GenericAgentFrontendArchive = "frontend-archive";

// 通用模板自带的规则标识；采纳模板时会克隆到目标项目并由模板角色引用。
const GenericRuleCore = "loopforge-core";
const GenericRuleBackendProfile = "loopforge-backend-profile";

// 通用模板自带的技能标识，对应各交付阶段能力。
const GenericSkillClarifyRequirements = "loopforge-clarify-requirements";
const GenericSkillBrainstorming = "loopforge-brainstorming";
const GenericSkillTechDesign = "loopforge-tech-design";
const GenericSkillWritingPlans = "loopforge-writing-plans";
const GenericSkillKnowledgeDistill = "loopforge-knowledge-distillation";

/**
 * 打包独立于项目的通用 SOP 工作流及其配套角色、规则与技能定义的模板结构。
 * 对应数据库 `generic_templates` 表的 JSON 载荷，引擎通过与自定义 SOP 相同的目录查找接口解析。
 */
class GenericTemplate {
  /**
   * 构造通用模板实例，未提供字段严格按 Go 零值初始化。
   * 使用场景：从数据库反序列化通用模板或构造测试/写入模板对象时调用。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {WorkflowDefinition} [init.Workflow] - 通用工作流定义。
   * @param {import("../domain/agent.js").AgentDefinition[]} [init.Agents] - 模板包含的角色定义列表。
   * @param {import("../domain/assets.js").RuleDefinition[]} [init.Rules] - 模板包含的规则定义列表。
   * @param {import("../domain/assets.js").SkillDefinition[]} [init.Skills] - 模板包含的技能定义列表。
   * @param {number} [init.VerdictGateSeedVersion] - 历史保留字段，用于兼容旧版模板 JSON 解码。
   * @param {number} [init.PlaybookSeedVersion] - 历史保留字段，用于兼容旧版模板 JSON 解码。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Workflow = init.Workflow ?? new WorkflowDefinition();
    this.Agents = init.Agents ?? [];
    this.Rules = init.Rules ?? [];
    this.Skills = init.Skills ?? [];
    // 保留两个历史种子版本字段，确保存量模板 JSON 持续兼容解码。
    this.VerdictGateSeedVersion = init.VerdictGateSeedVersion ?? 0;
    this.PlaybookSeedVersion = init.PlaybookSeedVersion ?? 0;
  }
}

module.exports = {
  GenericBackendDeliveryWorkflowID,
  GenericDockerSandboxID,
  GenericAgentRequirement,
  GenericAgentDesign,
  GenericAgentImplement,
  GenericAgentReview,
  GenericAgentTest,
  GenericAgentMR,
  GenericAgentSummary,
  RequirementGongfengGitToken,
  RequirementGongfengMCP,
  RequirementTAPDMCP,
  GenericProductDeliveryWorkflowID,
  GenericFrontendDeliveryWorkflowID,
  GenericAgentProductPRD,
  GenericAgentProductDemo,
  GenericAgentProductHandoff,
  GenericAgentProductAcceptance,
  GenericAgentProductTAPD,
  GenericAgentProductSummary,
  GenericAgentFrontendShape,
  GenericAgentFrontendDesign,
  GenericAgentFrontendBuild,
  GenericAgentFrontendReview,
  GenericAgentFrontendVerify,
  GenericAgentFrontendMR,
  GenericAgentFrontendArchive,
  GenericRuleCore,
  GenericRuleBackendProfile,
  GenericSkillClarifyRequirements,
  GenericSkillBrainstorming,
  GenericSkillTechDesign,
  GenericSkillWritingPlans,
  GenericSkillKnowledgeDistill,
  GenericTemplate,
};
