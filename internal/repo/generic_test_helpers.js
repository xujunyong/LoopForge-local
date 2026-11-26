/**
 * @file internal/repo/generic_test_helpers.js
 * @description 对应 Go 文件：internal/repo/generic_test_helpers.go
 * 职责与边界：构造并写入测试专用的精简通用模板种子数据（后端、产品、前端三套 SOP），
 * 供测试验证通用模板的列表查询、克隆与目录查找，避免在生产二进制中内嵌完整剧本正文。
 * 语法差异说明：
 * - Go 仅返回 `error` 的函数在 JS 中遵循成功无返回值（`undefined`）、失败直接 `throw err` 的约定。
 * - Go 中内联匿名结构体切片直接译为普通对象数组。
 */

"use strict";

const { WorkflowDefinition, WorkflowNode, WorkflowRequirement, WorkflowEdge, ArtifactContract, Position } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition 等，domain 已翻译
const { AgentDefinition } = require("../domain/agent.js"); // 对应 Go 的 domain.AgentDefinition，domain 已翻译
const { RuleDefinition, SkillDefinition } = require("../domain/assets.js"); // 对应 Go 的 domain.RuleDefinition/SkillDefinition，domain 已翻译
const { GenericTemplate, GenericBackendDeliveryWorkflowID, GenericDockerSandboxID, GenericAgentRequirement, GenericAgentDesign, GenericAgentImplement, GenericAgentReview, GenericAgentTest, GenericAgentMR, GenericAgentSummary, GenericAgentProductPRD, GenericAgentFrontendShape, GenericProductDeliveryWorkflowID, GenericFrontendDeliveryWorkflowID, GenericRuleCore, GenericRuleBackendProfile, GenericSkillClarifyRequirements, GenericSkillBrainstorming, GenericSkillTechDesign, GenericSkillWritingPlans, GenericSkillKnowledgeDistill, RequirementGongfengGitToken, RequirementGongfengMCP } = require("./generic_workflows.js"); // 对应 Go 同包类型与常量

/**
 * 向测试存储写入精简的通用模板行（后端、产品、前端三套交付 SOP），供测试覆盖模板查询、克隆与目录解析逻辑。
 * 使用场景：测试初始化（如 OpenTest 或单测准备阶段）时调用；当 `s` 为空时直接跳过。
 *
 * @param {import("./repo.js").Store | null} s - 存储实例；为 `null` 或 `undefined` 时不执行任何写入。
 * @returns {void} 无返回值；任一模板写入失败时抛出错误。
 */
function SeedTestGenericTemplates(s) {
  if (s == null) {
    return;
  }
  for (const template of [
    testBackendGenericTemplate(),
    testNamedGenericTemplate(GenericProductDeliveryWorkflowID, "通用产品交付 SOP", GenericAgentProductPRD),
    testNamedGenericTemplate(GenericFrontendDeliveryWorkflowID, "通用前端交付 SOP", GenericAgentFrontendShape),
  ]) {
    s.PutGenericTemplate(template);
  }
}

/**
 * 构造单节点精简通用模板，包含一个通用工作流定义及与其绑定的单个角色定义。
 * 使用场景：由 `SeedTestGenericTemplates` 调用，用于生成产品交付与前端交付的测试模板。
 *
 * @param {string} id - 通用工作流标识（如 `GenericProductDeliveryWorkflowID`）。
 * @param {string} name - 通用工作流展示名称。
 * @param {string} agentID - 模板内唯一执行节点引用的角色标识。
 * @returns {GenericTemplate} 构造好的精简通用模板实例。
 */
function testNamedGenericTemplate(id, name, agentID) {
  return new GenericTemplate({
    Workflow: new WorkflowDefinition({
      ID: id,
      Name: name,
      Version: 1,
      Revision: 1,
      Status: "published",
      Owner: "平台",
      Description: name,
      SandboxProfileID: GenericDockerSandboxID,
      Generic: true,
      Nodes: [
        new WorkflowNode({
          ID: "work",
          Name: "执行",
          Type: "agent",
          AgentID: agentID,
          MaxAttempts: 1,
          ArtifactOutputs: [new ArtifactContract({ Name: "report", Path: "report.md", Required: true })],
        }),
      ],
    }),
    Agents: [
      new AgentDefinition({
        ID: agentID,
        Name: name + "角色",
        Version: 1,
        ExecutorID: "codebuddy",
        Prompt: "完成任务\n\n任务输入：{{input}}",
      }),
    ],
  });
}

/**
 * 构造包含完整七阶段节点链（需求定型 → 方案设计 → 实现 → 独立评审 → 测试验证 → 发起 MR → 交付汇总）、
 * 前置依赖声明、角色、规则与技能的测试用通用后端交付模板。
 * 使用场景：由 `SeedTestGenericTemplates` 调用，为测试库提供精简后端 SOP 模板。
 *
 * @returns {GenericTemplate} 构造好的测试用后端通用模板实例。
 */
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
      ID: spec.id,
      Name: spec.name,
      Version: 1,
      ExecutorID: "codebuddy",
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
      ID: nodeID,
      Name: spec.name,
      Type: "agent",
      AgentID: spec.id,
      MaxAttempts: 1,
      ArtifactOutputs: [new ArtifactContract({ Name: nodeID + "-report", Path: nodeID + "-report.md", Required: true })],
      Position: new Position({ X: 80 + i * 80, Y: 200 }),
    }));
  }
  return new GenericTemplate({
    Workflow: new WorkflowDefinition({
      ID: GenericBackendDeliveryWorkflowID,
      Name: "通用后端交付 SOP（LoopForge）",
      Version: 1,
      Revision: 1,
      Status: "published",
      Owner: "平台",
      Description: "测试用通用后端 SOP",
      SandboxProfileID: GenericDockerSandboxID,
      Generic: true,
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
