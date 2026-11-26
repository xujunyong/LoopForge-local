// shared_schedule_assets.js —— 对应 Go 文件：internal/repo/shared_schedule_assets.go
// 作用：共享定时任务的直接引用解析、资产校验与级联共享。
// Go 的 fmt.Errorf %w 译为模板字符串。

"use strict";

const { AssistantReference } = require("../domain/assistant.js"); // 对应 Go 的 domain.AssistantReference，assistant.js 已翻译
const { SharedScheduleAsset } = require("../domain/shared_schedule.js"); // 对应 Go 的 domain.SharedScheduleAsset，shared_schedule.js 已翻译

const ErrSharedScheduleReferences = new Error("共享任务引用资产不可用");

CatalogRepo.prototype.sharedScheduleAssets = function (refs) {
  const [resolved, refsErr] = this.directScheduleReferences(refs);
  if (refsErr != null) {
    return [null, refsErr];
  }
  const out = [];
  for (const ref of resolved) {
    const [, shared, found] = this.sharedScheduleReference(ref);
    if (!found || !shared) {
      return [null, new Error(`${ErrSharedScheduleReferences.message}：${ref.Type}/${ref.ID} 不存在或尚未共享`)];
    }
    out.push(new SharedScheduleAsset({ Type: ref.Type, ID: ref.ID, ProjectID: ref.ProjectID }));
  }
  return [out, null];
};

CatalogRepo.prototype.directScheduleReferences = function (refs) {
  if (refs.length > 12) {
    return [null, new Error(`${ErrSharedScheduleReferences.message}：最多引用 12 个资产`)];
  }
  const out = [];
  const seen = {};
  for (const raw of refs) {
    const ref = new AssistantReference({ Type: raw.Type.trim(), ID: raw.ID.trim() });
    if (ref.Type !== "agent" && ref.Type !== "skill" && ref.Type !== "sop") {
      return [null, new Error(`${ErrSharedScheduleReferences.message}：${ref.Type} 不支持随 AI 定时任务共享`)];
    }
    const key = ref.Type + "/" + ref.ID;
    if (seen[key]) {
      continue;
    }
    const [canonical, , found] = this.sharedScheduleReference(ref);
    if (ref.ID === "" || !found) {
      return [null, new Error(`${ErrSharedScheduleReferences.message}：${key} 不存在`)];
    }
    seen[key] = true;
    out.push(canonical);
  }
  return [out, null];
};

CatalogRepo.prototype.shareScheduleReference = function (ref, projectID) {
  const [canonical, shared, found] = this.sharedScheduleReference(ref);
  if (!found) {
    return new Error(`${ErrSharedScheduleReferences.message}：${ref.Type}/${ref.ID} 不存在`);
  }
  if (shared) {
    return null;
  }
  if (canonical.ProjectID !== projectID) {
    return new Error(`${ErrSharedScheduleReferences.message}：${ref.Type}/${ref.ID} 不属于当前项目且尚未共享`);
  }
  let err = null;
  switch (ref.Type) {
    case "agent":
      err = this.ShareAgent(ref.ID);
      break;
    case "skill":
      err = this.ShareSkill(ref.ID);
      break;
    case "sop":
      err = this.ShareWorkflow(ref.ID);
      break;
    default:
      return new Error(`${ErrSharedScheduleReferences.message}：${ref.Type} 不支持随 AI 定时任务共享`);
  }
  if (err != null) {
    return new Error(`${ErrSharedScheduleReferences.message}：共享 ${ref.Type}/${ref.ID} 失败：${err.message}`);
  }
  return null;
};

CatalogRepo.prototype.sharedScheduleReference = function (ref) {
  ref = new AssistantReference({ Type: ref.Type.trim(), ID: ref.ID.trim() });
  switch (ref.Type) {
    case "agent": {
      const [v, ok] = this.Agent(ref.ID);
      ref.Name = v.Name;
      ref.ProjectID = v.ProjectID;
      return [ref, v.Shared, ok];
    }
    case "skill": {
      const [v, ok] = this.Skill(ref.ID);
      ref.Name = v.Name;
      ref.ProjectID = v.ProjectID;
      return [ref, v.Shared, ok];
    }
    case "sop": {
      const [v, ok] = this.Workflow(ref.ID);
      ref.Name = v.Name;
      ref.ProjectID = v.ProjectID;
      return [ref, v.Shared || v.Generic, ok];
    }
    default:
      return [ref, false, false];
  }
};

CatalogRepo.prototype.ValidateSharedScheduleAssets = function (v) {
  const [assets, err] = this.sharedScheduleAssets(v.References);
  if (err != null) {
    return err;
  }
  if (assets.length !== v.Assets.length) {
    return new Error(`${ErrSharedScheduleReferences.message}：直接引用列表与共享版本不一致`);
  }
  for (const asset of assets) {
    // Go 的 slices.Contains 按值比较结构体，JS 用 some 按字段比较。
    if (!v.Assets.some((a) => a.Type === asset.Type && a.ID === asset.ID && a.ProjectID === asset.ProjectID)) {
      return new Error(`${ErrSharedScheduleReferences.message}：${asset.Type}/${asset.ID} 的归属已变更，请发布新版本`);
    }
  }
  return null;
};

module.exports = { ErrSharedScheduleReferences };
