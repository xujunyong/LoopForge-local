/**
 * @file internal/repo/catalog_sharing.js
 * 对应 Go 源文件：internal/repo/catalog_sharing.go
 *
 * 作用与职责边界：
 * 实现目录资产共享相关的写路径与可见性边界校验，挂载在 `CatalogRepo` 原型上，
 * 包括共享角色及其绑定的规则与技能、共享技能、校验工作流引用角色的项目/共享范围、校验工作流沙箱共享边界以及共享工作流。
 * 不负责底层 CRUD 存储（见 `catalog.js`）或通用模板管理（见 `generic_store.js`）。
 *
 * 语法差异说明：
 * - Go 的 `error` 返回统一按成功无返回值（`undefined`）、失败 `throw Error` 处理。
 * - Go 的 `fmt.Errorf` 含 `%q` / `%w` 的错误包装译为模板字符串与 `try ... catch` 重新抛出。
 */

"use strict";

const { IsPreviewBuildAgent } = require("../domain/preview.js"); // 对应 Go 的 domain.IsPreviewBuildAgent，preview.js 已翻译
const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译

/**
 * 保存角色定义并在角色标记为共享时先将其归属的同项目规则与技能一并设为共享。
 * 用于目录管理界面或共享接口保存角色时保持资产依赖一致性。
 *
 * @param {import("../domain/agent.js").AgentDefinition} v - 待保存的角色定义对象。
 * @returns {void} 无返回值。
 * @throws {Error} 共享关联资产失败或角色保存失败时抛出错误。
 */
CatalogRepo.prototype.PutAgentWithSharing = function (v) {
  if (v.Shared) {
    this.ShareAgentAssets(v);
  }
  this.PutAgent(v);
};

/**
 * 将已存储的角色标记为共享，并复用 `PutAgentWithSharing` 同步共享其关联规则与技能。
 * 若角色本身已处于共享状态则直接返回，避免重复写入依赖资产。
 *
 * @param {string} id - 待共享的角色 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 角色不存在、关联资产共享失败或保存失败时抛出错误。
 */
CatalogRepo.prototype.ShareAgent = function (id) {
  const [v, ok] = this.Agent(id);
  if (!ok) {
    throw new Error(`agent "${id}" not found`);
  }
  if (v.Shared) {
    return;
  }
  v.Shared = true;
  this.PutAgentWithSharing(v);
};

/**
 * 将角色直接绑定的未共享且归属于同项目（或无项目归属）的规则与技能设为共享。
 * 属于其他项目的私有资产会被跳过，避免越权共享他人项目资产。
 *
 * @param {import("../domain/agent.js").AgentDefinition} agent - 待共享关联资产的角色定义对象。
 * @returns {void} 无返回值。
 * @throws {Error} 保存任一规则或技能失败时包装并抛出错误。
 */
CatalogRepo.prototype.ShareAgentAssets = function (agent) {
  for (const id of agent.Rules) {
    const [item, ok] = this.Rule(id);
    if (!ok || item.Shared || (item.ProjectID !== "" && item.ProjectID !== agent.ProjectID)) {
      continue;
    }
    item.Shared = true;
    try {
      this.PutRule(item);
    } catch (err) {
      throw new Error(`share rule "${id}": ${err.message}`);
    }
  }
  for (const id of agent.Skills) {
    const [item, ok] = this.Skill(id);
    if (!ok || item.Shared || (item.ProjectID !== "" && item.ProjectID !== agent.ProjectID)) {
      continue;
    }
    item.Shared = true;
    try {
      this.PutSkill(item);
    } catch (err) {
      throw new Error(`share skill "${id}": ${err.message}`);
    }
  }
};

/**
 * 将已存储的技能标记为共享，保持原有定义与文件清单不变（技能二进制内容仍独立存放在文件表中）。
 * 若技能已共享则直接返回。
 *
 * @param {string} id - 待共享的技能 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 技能不存在或保存失败时抛出错误。
 */
CatalogRepo.prototype.ShareSkill = function (id) {
  const [v, ok] = this.Skill(id);
  if (!ok) {
    throw new Error(`skill "${id}" not found`);
  }
  if (v.Shared) {
    return;
  }
  v.Shared = true;
  this.PutSkill(v);
};

/**
 * 校验工作流中所有角色节点引用的角色均存在且对工作流所属项目可见（同项目或已共享）。
 * 跳过内置预览构建角色与未绑定具体项目的全局工作流；供 SOP 保存与共享流程共用。
 *
 * @param {import("../domain/workflow.js").WorkflowDefinition} workflow - 待校验的工作流定义对象。
 * @returns {void} 无返回值。
 * @throws {Error} 引用的角色不存在或不属于当前项目且未共享时抛出错误。
 */
CatalogRepo.prototype.ValidateWorkflowAgentScopes = function (workflow) {
  const projectID = workflow.ProjectID.trim();
  if (projectID === "") {
    return;
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
      throw new Error(`角色 "${agentID}" 不存在`);
    }
    const owner = agent.ProjectID.trim();
    if (owner === "" || (owner !== projectID && !agent.Shared)) {
      throw new Error(`角色 "${agent.Name}" 不属于当前项目且尚未共享`);
    }
  }
};

/**
 * 校验工作流绑定的沙箱配置存在且满足项目可见性与共享边界要求。
 * 共享 SOP 必须使用已共享的沙箱，不会自动把私有沙箱改为共享。
 *
 * @param {import("../domain/workflow.js").WorkflowDefinition} v - 待校验的工作流定义对象。
 * @returns {void} 无返回值。
 * @throws {Error} 缺少沙箱 ID、沙箱不存在、跨项目未共享或共享 SOP 绑定了未共享沙箱时抛出错误。
 */
CatalogRepo.prototype.ValidateWorkflowSharing = function (v) {
  if (v.SandboxProfileID.trim() === "") {
    throw new Error("workflow sandboxProfileId is required");
  }
  const [profile, ok] = this.Sandbox(v.SandboxProfileID);
  if (!ok) {
    throw new Error("sandbox profile not found");
  }
  if (v.ProjectID !== "" && profile.ProjectID !== "" && profile.ProjectID !== v.ProjectID && !profile.Shared) {
    throw new Error("沙箱不属于当前项目且尚未共享");
  }
  if (v.Shared && !profile.Shared) {
    throw new Error("共享 SOP 只能使用已共享的沙箱");
  }
};

/**
 * 将指定工作流设为共享：先完成角色可见性与沙箱共享边界校验，再走常规 `PutWorkflow` 保存路径（含通知与修订号检查）。
 * 若工作流已共享或属于通用模板则直接返回。
 *
 * @param {string} id - 待共享的工作流 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 工作流不存在、共享边界校验失败或保存失败时抛出错误。
 */
CatalogRepo.prototype.ShareWorkflow = function (id) {
  const [v, ok] = this.Workflow(id);
  if (!ok) {
    throw new Error(`workflow "${id}" not found`);
  }
  if (v.Shared || v.Generic) {
    return;
  }
  v.Shared = true;
  this.ValidateWorkflowAgentScopes(v);
  this.ValidateWorkflowSharing(v);
  this.PutWorkflow(v);
};
