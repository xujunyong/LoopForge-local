/**
 * 对应 Go 源文件：internal/engine/shared_schedule_assets.go
 *
 * 文件作用与职责边界：
 * 负责共享定时任务准入时的资产可见性校验，确保任务引用的 SOP、沙箱配置与智能体角色
 * 均属于当前项目或已标记为共享，避免跨项目越权访问私有依赖。
 *
 * Go 与 JS 语法差异说明：
 * - Go 仅返回 `error` 的函数在 JS 中译为成功返回 `undefined`、失败直接 `throw new Error(...)`。
 * - Go 结构体方法接收者 `(e *Engine)` 统一挂载在 `Engine.prototype` 上。
 */

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { IsPreviewBuildAgent } = require("../domain/preview.js"); // 对应 Go 的 domain.IsPreviewBuildAgent，preview.js 已翻译
const { workflowAgent } = require("./assets.js"); // 对应 Go 同包函数，assets.js 已翻译

/**
 * 校验共享定时任务使用的工作流、沙箱与所有智能体角色对目标项目是否可见。
 * 使用场景：创建或准入共享定时任务时，由引擎调用以拦截引用其他项目私有资产的流程。
 * 每个 SOP 仅在准入时检查自身资产；沙箱自带 Dockerfile 或环境变量，检查沙箱即覆盖其配置。
 *
 * @param {object} wf - 待校验的工作流定义（domain.WorkflowDefinition）。
 * @param {string} projectID - 发起定时任务的目标项目 ID。
 * @param {object} profile - 工作流绑定的沙箱配置（domain.SandboxProfile）。
 * @returns {void} 无返回值。
 * @throws {Error} 当 SOP、沙箱或任一非预览构建角色不存在、不属于当前项目且未共享时抛出错误。
 */
Engine.prototype.validateSharedScheduleWorkflow = function (wf, projectID, profile) {
  sharedScheduleAssetVisible(projectID, "SOP", wf.ProjectID, wf.Shared || wf.Generic);
  sharedScheduleAssetVisible(projectID, "沙箱", profile.ProjectID, profile.Shared);
  for (const node of wf.Nodes) {
    if (node.Type !== "agent" || IsPreviewBuildAgent(node.AgentID)) {
      continue;
    }
    const [agent, ok] = workflowAgent(this.repo, wf, node.AgentID);
    if (!ok) {
      throw new Error("共享任务使用的角色不存在");
    }
    sharedScheduleAssetVisible(projectID, "角色", agent.ProjectID, agent.Shared);
  }
};

/**
 * 判断单个资产是否对指定项目可见（已共享或归属该项目）。
 * 使用场景：由 validateSharedScheduleWorkflow 调用，分别校验 SOP、沙箱与角色。
 *
 * @param {string} projectID - 当前项目 ID。
 * @param {string} kind - 资产中文类型名（如 "SOP"、"沙箱"、"角色"），用于构造错误提示。
 * @param {string} owner - 资产所属项目 ID。
 * @param {boolean} shared - 资产是否已公开共享（或为通用模板）。
 * @returns {void} 无返回值。
 * @throws {Error} 当资产未共享且不属于当前项目时抛出错误。
 */
function sharedScheduleAssetVisible(projectID, kind, owner, shared) {
  projectID = projectID.trim();
  owner = owner.trim();
  if (shared || (projectID !== "" && owner === projectID)) {
    return;
  }
  throw new Error(`共享任务使用的${kind}不属于当前项目且尚未共享`);
}

module.exports = { sharedScheduleAssetVisible };
