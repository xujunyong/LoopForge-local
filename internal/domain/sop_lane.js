/**
 * @file internal/domain/sop_lane.js
 * @description 对应 Go 文件：internal/domain/sop_lane.go
 * 职责与边界：定义 SOP 角色链（产品、前端、后端、设计、修复、其他）常量与展示顺序，
 * 提供角色链标识归一化、中文展示标签映射、从工作流元数据推断角色链，以及判断工作项是否属于需求的方法。
 */

"use strict";

const SOPLaneProduct = "product";
const SOPLaneFrontend = "frontend";
const SOPLaneBackend = "backend";
const SOPLaneDesign = "design";
const SOPLaneRepair = "repair";
const SOPLaneOther = "other";

// 需求详情页中角色链的默认展示顺序。
const RequirementLaneOrder = [SOPLaneProduct, SOPLaneFrontend, SOPLaneBackend];

/**
 * 将中英文别称或大小写不一的角色链标识归一化为标准 `SOPLane*` 常量；无法识别时返回 `SOPLaneOther`。
 * 在解析工作流配置、前端筛选参数或历史数据时调用。
 * @param {string} raw - 原始角色链字符串。
 * @returns {string} 归一化后的标准角色链常量值。
 */
function NormalizeSOPLane(raw) {
  switch (raw.trim().toLowerCase()) {
    case SOPLaneProduct:
    case "产品":
    case "prd":
      return SOPLaneProduct;
    case SOPLaneFrontend:
    case "front":
    case "前端":
      return SOPLaneFrontend;
    case SOPLaneBackend:
    case "back":
    case "后端":
      return SOPLaneBackend;
    case SOPLaneDesign:
    case "设计":
    case "uiux":
      return SOPLaneDesign;
    case SOPLaneRepair:
    case "fix":
    case "issue":
    case "bugfix":
    case "修复":
    case "缺陷":
      return SOPLaneRepair;
    case SOPLaneOther:
      return SOPLaneOther;
    default:
      return SOPLaneOther;
  }
}

/**
 * 返回角色链对应的中文展示名称。
 * 在界面展示角色链标签或生成统计分组标题时调用。
 * @param {string} lane - 角色链标识字符串。
 * @returns {string} 中文展示名称（`"产品"`、`"前端"`、`"后端"`、`"设计"`、`"修复"` 或 `"其他"`）。
 */
function SOPLaneLabel(lane) {
  switch (NormalizeSOPLane(lane)) {
    case SOPLaneProduct:
      return "产品";
    case SOPLaneFrontend:
      return "前端";
    case SOPLaneBackend:
      return "后端";
    case SOPLaneDesign:
      return "设计";
    case SOPLaneRepair:
      return "修复";
    default:
      return "其他";
  }
}

/**
 * 推断工作流定义所属的 SOP 角色链：优先使用显式声明的 `wf.SOPLane`，
 * 为空时综合工作流 ID、名称及标签关键词进行启发式匹配。
 * 在旧版工作流展示或按角色链归类 SOP 时调用。
 * @param {Object} wf - `WorkflowDefinition` 工作流定义对象。
 * @returns {string} 推断得到的标准 `SOPLane*` 常量值。
 */
function InferSOPLane(wf) {
  if (wf.SOPLane.trim() !== "") {
    return NormalizeSOPLane(wf.SOPLane);
  }
  const parts = [wf.ID, wf.Name];
  parts.push(...(wf.Tags ?? []));
  const hay = parts.join(" ").toLowerCase();
  if (
    hay.includes("generic-product") || hay.includes("产品交付") ||
    (hay.includes("product") && (hay.includes("delivery") || hay.includes("prd")))
  ) {
    return SOPLaneProduct;
  }
  if (
    hay.includes("generic-frontend") || hay.includes("前端交付") ||
    (hay.includes("frontend") && hay.includes("delivery"))
  ) {
    return SOPLaneFrontend;
  }
  if (
    hay.includes("generic-design") || hay.includes("设计交付") ||
    (hay.includes("设计") && !hay.includes("需求开发"))
  ) {
    return SOPLaneDesign;
  }
  if (
    hay.includes("generic-backend") || hay.includes("后端交付") ||
    hay.includes("requirement-development") || hay.includes("loopforge") ||
    hay.includes("需求开发")
  ) {
    return SOPLaneBackend;
  }
  if (
    hay.includes("issue-fix") || hay.includes("缺陷修复") ||
    (hay.includes("修复") && !hay.includes("交付"))
  ) {
    return SOPLaneRepair;
  }
  return SOPLaneOther;
}

/**
 * 判断一条工作项（Issue）是否属于需求类工作项（而非工蜂缺陷/普通 issue）。
 * 在决定是否展示需求角色链布局或按需求维度统计时调用。
 * @param {Object} issue - `Issue` 工作项对象。
 * @returns {boolean} 属于需求工作项时返回 `true`，否则返回 `false`。
 */
function IsRequirementWorkItem(issue) {
  const kind = issue.Kind.trim().toLowerCase();
  const source = issue.Source.trim().toLowerCase();
  if (source === "gongfeng" || kind === "issue") {
    return false;
  }
  return kind === "requirement" || source === "tapd" || source === "local" || source === "";
}

module.exports = { SOPLaneProduct, SOPLaneFrontend, SOPLaneBackend, SOPLaneDesign, SOPLaneRepair, SOPLaneOther, RequirementLaneOrder, NormalizeSOPLane, SOPLaneLabel, InferSOPLane, IsRequirementWorkItem };
