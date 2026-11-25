// sop_lane.js —— 对应 Go 文件：internal/domain/sop_lane.go
// 作用：SOP 角色链（产品 / 前端 / 后端 / 设计 / 修复 / 其他）的归一化与推断。

"use strict";

const SOPLaneProduct = "product";
const SOPLaneFrontend = "frontend";
const SOPLaneBackend = "backend";
const SOPLaneDesign = "design";
const SOPLaneRepair = "repair";
const SOPLaneOther = "other";

// RequirementLaneOrder：需求角色链的展示顺序。
const RequirementLaneOrder = [SOPLaneProduct, SOPLaneFrontend, SOPLaneBackend];

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

// InferSOPLane：优先用显式字段，其次从 ID / 名称 / 标签推断。
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

function IsRequirementWorkItem(issue) {
  const kind = issue.Kind.trim().toLowerCase();
  const source = issue.Source.trim().toLowerCase();
  if (source === "gongfeng" || kind === "issue") {
    return false;
  }
  return kind === "requirement" || source === "tapd" || source === "local" || source === "";
}

module.exports = { SOPLaneProduct, SOPLaneFrontend, SOPLaneBackend, SOPLaneDesign, SOPLaneRepair, SOPLaneOther, RequirementLaneOrder, NormalizeSOPLane, SOPLaneLabel, InferSOPLane, IsRequirementWorkItem };
