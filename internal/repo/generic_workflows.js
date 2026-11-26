// generic_workflows.js —— 对应 Go 文件：internal/repo/generic_workflows.go
// 作用：通用模板的常量与结构：后端/产品/前端交付 SOP 的工作流、角色、规则与技能标识。

"use strict";

const { WorkflowDefinition } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition，domain 已翻译

const GenericBackendDeliveryWorkflowID = "generic-backend-delivery";

const GenericDockerSandboxID = "generic-docker";

const GenericAgentRequirement = "loopforge-requirement";
const GenericAgentDesign = "loopforge-design";
const GenericAgentImplement = "loopforge-implement";
const GenericAgentReview = "loopforge-review";
const GenericAgentTest = "loopforge-test";
const GenericAgentMR = "loopforge-mr";
const GenericAgentSummary = "loopforge-summary";

const RequirementGongfengGitToken = "gongfeng-git-token";
const RequirementGongfengMCP = "gongfeng-mcp";
const RequirementTAPDMCP = "tapd-mcp";

const GenericProductDeliveryWorkflowID = "generic-product-delivery";
const GenericFrontendDeliveryWorkflowID = "generic-frontend-delivery";

const GenericAgentProductPRD = "product-prd";
const GenericAgentProductDemo = "product-demo";
const GenericAgentProductHandoff = "product-handoff";
const GenericAgentProductAcceptance = "product-acceptance";
const GenericAgentProductTAPD = "product-tapd";
const GenericAgentProductSummary = "product-summary";

const GenericAgentFrontendShape = "frontend-shape";
const GenericAgentFrontendDesign = "frontend-design";
const GenericAgentFrontendBuild = "frontend-build";
const GenericAgentFrontendReview = "frontend-review";
const GenericAgentFrontendVerify = "frontend-verify";
const GenericAgentFrontendMR = "frontend-mr";
const GenericAgentFrontendArchive = "frontend-archive";

const GenericRuleCore = "loopforge-core";
const GenericRuleBackendProfile = "loopforge-backend-profile";

const GenericSkillClarifyRequirements = "loopforge-clarify-requirements";
const GenericSkillBrainstorming = "loopforge-brainstorming";
const GenericSkillTechDesign = "loopforge-tech-design";
const GenericSkillWritingPlans = "loopforge-writing-plans";
const GenericSkillKnowledgeDistill = "loopforge-knowledge-distillation";

class GenericTemplate {
  constructor(init = {}) {
    this.Workflow = init.Workflow ?? new WorkflowDefinition();
    this.Agents = init.Agents ?? [];
    this.Rules = init.Rules ?? [];
    this.Skills = init.Skills ?? [];
    this.VerdictGateSeedVersion = init.VerdictGateSeedVersion ?? 0;
    this.PlaybookSeedVersion = init.PlaybookSeedVersion ?? 0;
  }
}

module.exports = { GenericBackendDeliveryWorkflowID, GenericDockerSandboxID, GenericAgentRequirement, GenericAgentDesign, GenericAgentImplement, GenericAgentReview, GenericAgentTest, GenericAgentMR, GenericAgentSummary, RequirementGongfengGitToken, RequirementGongfengMCP, RequirementTAPDMCP, GenericProductDeliveryWorkflowID, GenericFrontendDeliveryWorkflowID, GenericAgentProductPRD, GenericAgentProductDemo, GenericAgentProductHandoff, GenericAgentProductAcceptance, GenericAgentProductTAPD, GenericAgentProductSummary, GenericAgentFrontendShape, GenericAgentFrontendDesign, GenericAgentFrontendBuild, GenericAgentFrontendReview, GenericAgentFrontendVerify, GenericAgentFrontendMR, GenericAgentFrontendArchive, GenericRuleCore, GenericRuleBackendProfile, GenericSkillClarifyRequirements, GenericSkillBrainstorming, GenericSkillTechDesign, GenericSkillWritingPlans, GenericSkillKnowledgeDistill, GenericTemplate };
