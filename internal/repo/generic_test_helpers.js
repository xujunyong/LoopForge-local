// generic_test_helpers.js —— 对应 Go 文件：internal/repo/generic_test_helpers.go
// 作用：测试用通用模板种子数据：后端/产品/前端三套精简模板。

"use strict";

const { WorkflowDefinition, WorkflowNode, WorkflowRequirement, WorkflowEdge, ArtifactContract, Position } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition 等，domain 已翻译
const { AgentDefinition } = require("../domain/agent.js"); // 对应 Go 的 domain.AgentDefinition，domain 已翻译
const { RuleDefinition, SkillDefinition } = require("../domain/assets.js"); // 对应 Go 的 domain.RuleDefinition/SkillDefinition，domain 已翻译
const { GenericTemplate, GenericBackendDeliveryWorkflowID, GenericDockerSandboxID, GenericAgentRequirement, GenericAgentDesign, GenericAgentImplement, GenericAgentReview, GenericAgentTest, GenericAgentMR, GenericAgentSummary, GenericAgentProductPRD, GenericAgentFrontendShape, GenericProductDeliveryWorkflowID, GenericFrontendDeliveryWorkflowID, GenericRuleCore, GenericRuleBackendProfile, GenericSkillClarifyRequirements, GenericSkillBrainstorming, GenericSkillTechDesign, GenericSkillWritingPlans, GenericSkillKnowledgeDistill, RequirementGongfengGitToken, RequirementGongfengMCP } = require("./generic_workflows.js"); // 对应 Go 同包类型与常量，generic_workflows.js 本次一同翻译

function SeedTestGenericTemplates(s) {
  if (s == null) {
    return null;
  }
  for (const template of [testBackendGenericTemplate(), testNamedGenericTemplate(GenericProductDeliveryWorkflowID, "通用产品交付 SOP", GenericAgentProductPRD), testNamedGenericTemplate(GenericFrontendDeliveryWorkflowID, "通用前端交付 SOP", GenericAgentFrontendShape)]) {
    const err = s.PutGenericTemplate(template);
    if (err != null) {
      return err;
    }
  }
  return null;
}

function testNamedGenericTemplate(id, name, agentID) {
  return new GenericTemplate({
    Workflow: new WorkflowDefinition({
      ID: id, Name: name, Version: 1, Revision: 1, Status: "published",
      Owner: "平台", Description: name, SandboxProfileID: GenericDockerSandboxID,
      Generic: true,
      Nodes: [new WorkflowNode({
        ID: "work", Name: "执行", Type: "agent", AgentID: agentID, MaxAttempts: 1, ArtifactOutputs: [new ArtifactContract({ Name: "report", Path: "report.md", Required: true })],
      })],
    }),
    Agents: [new AgentDefinition({
      ID: agentID, Name: name + "角色", Version: 1, ExecutorID: "codebuddy",
      Prompt: "完成任务\n\n任务输入：{{input}}",
    })],
  });
}

function testBackendGenericTemplate() {
  const agents = [
    { id: GenericAgentRequirement, name: "需求定型", mcp: null, skills: [GenericSkillClarifyRequirements] },
    { id: GenericAgentDesign, name: "方案设计", mcp: null, skills: [GenericSkillTechDesign, GenericSkillWritingPlans] },
    { id: GenericAgentImplement, name: "实现", mcp: null, skills: [GenericSkillBrainstorming] },
    { id: GenericAgentReview, name: "独立评审", mcp: null, skills: [GenericSkillKnowledgeDistill] },
    { id: GenericAgentTest, name: "测试验证", mcp: null, skills: null },
    { id: GenericAgentMR, name: "发起 MR", mcp: ["gongfeng"], skills: null },
    { id: GenericAgentSummary, name: "交付汇总", mcp: null, skills: null },
  ];
  const outAgents = [];
  const nodes = [];
  for (let i = 0; i < agents.length; i++) {
    const spec = agents[i];
    outAgents.push(new AgentDefinition({
      ID: spec.id, Name: spec.name, Version: 1, ExecutorID: "codebuddy",
      Rules: [GenericRuleCore, GenericRuleBackendProfile],
      Skills: spec.skills,
      MCPServers: spec.mcp,
      Prompt: spec.name + "\n\n任务输入：{{input}}",
    }));
    let nodeID = spec.id;
    switch (spec.id) {
      case GenericAgentRequirement:
        nodeID = "requirement";
        break;
      case GenericAgentDesign:
        nodeID = "design";
        break;
      case GenericAgentImplement:
        nodeID = "implement";
        break;
      case GenericAgentReview:
        nodeID = "review";
        break;
      case GenericAgentTest:
        nodeID = "test";
        break;
      case GenericAgentMR:
        nodeID = "mr";
        break;
      case GenericAgentSummary:
        nodeID = "summary";
        break;
    }
    nodes.push(new WorkflowNode({
      ID: nodeID, Name: spec.name, Type: "agent", AgentID: spec.id, MaxAttempts: 1,
      ArtifactOutputs: [new ArtifactContract({ Name: nodeID + "-report", Path: nodeID + "-report.md", Required: true })],
      Position: new Position({ X: 80 + i * 80, Y: 200 }),
    }));
  }
  return new GenericTemplate({
    Workflow: new WorkflowDefinition({
      ID: GenericBackendDeliveryWorkflowID, Name: "通用后端交付 SOP（LoopForge）",
      Version: 1, Revision: 1, Status: "published", Owner: "平台",
      Description: "测试用通用后端 SOP",
      SandboxProfileID: GenericDockerSandboxID, Generic: true,
      Requirements: [
        new WorkflowRequirement({ Key: RequirementGongfengGitToken, NodeID: "mr", Label: "工蜂 Git Token", Hint: "push 需要 Git Token", Setup: "settings" }),
        new WorkflowRequirement({ Key: RequirementGongfengMCP, NodeID: "mr", Label: "工蜂 MCP", Hint: "创建 MR 需要工蜂 MCP", Setup: "mcp" }),
      ],
      Nodes: nodes,
      Edges: [
        new WorkflowEdge({ ID: "e1", Source: "requirement", Target: "design", When: "success" }),
        new WorkflowEdge({ ID: "e2", Source: "design", Target: "implement", When: "success" }),
        new WorkflowEdge({ ID: "e3", Source: "implement", Target: "review", When: "success" }),
        new WorkflowEdge({ ID: "e4", Source: "review", Target: "test", When: "success" }),
        new WorkflowEdge({ ID: "e5", Source: "test", Target: "mr", When: "success" }),
        new WorkflowEdge({ ID: "e6", Source: "mr", Target: "summary", When: "success" }),
      ],
    }),
    Agents: outAgents,
    Rules: [
      new RuleDefinition({ ID: GenericRuleCore, Name: "LoopForge 核心", Content: "follow the stored template" }),
      new RuleDefinition({ ID: GenericRuleBackendProfile, Name: "后端画像", Content: "backend delivery" }),
    ],
    Skills: [
      new SkillDefinition({ ID: GenericSkillClarifyRequirements, Name: "澄清需求", Content: "clarify" }),
      new SkillDefinition({ ID: GenericSkillBrainstorming, Name: "方案头脑风暴", Content: "brainstorm" }),
      new SkillDefinition({ ID: GenericSkillTechDesign, Name: "技术方案", Content: "design" }),
      new SkillDefinition({ ID: GenericSkillWritingPlans, Name: "执行计划", Content: "plan" }),
      new SkillDefinition({ ID: GenericSkillKnowledgeDistill, Name: "知识蒸馏", Content: "distill" }),
    ],
  });
}

module.exports = { SeedTestGenericTemplates, testNamedGenericTemplate, testBackendGenericTemplate };
