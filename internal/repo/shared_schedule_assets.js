/**
 * @file internal/repo/shared_schedule_assets.js
 * 对应 Go 源文件：internal/repo/shared_schedule_assets.go
 *
 * 作用与职责边界：
 * 为目录仓储 `CatalogRepo` 实现共享 AI 定时任务的直接引用资产解析、归属与共享状态核验以及级联共享：
 * 仅解析和固定共享任务直接声明引用的角色（`agent`）、技能（`skill`）与工作流（`sop`），
 * 嵌套子依赖继续由被引用资产自身的解析与共享路径管理。
 * 不负责共享版本表的查询与发布事务控制（见 `shared_schedules.js`）。
 *
 * 语法差异说明：
 * - `CatalogRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `CatalogRepo.prototype` 挂载方法。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；
 *   Go 的非错误三返回值 `(AssistantReference, bool, bool)` 译为三元组 `[AssistantReference, boolean, boolean]`。
 * - Go 的 `fmt.Errorf("%w：...", ...)` 译为模板字符串拼接哨兵错误文案；`slices.Contains` 按结构体字段值比较译为 `Array.prototype.some`。
 */

"use strict";

const { AssistantReference } = require("../domain/assistant.js"); // 对应 Go 的 domain.AssistantReference，assistant.js 已翻译
const { SharedScheduleAsset } = require("../domain/shared_schedule.js"); // 对应 Go 的 domain.SharedScheduleAsset，shared_schedule.js 已翻译
const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译

// 共享定时任务直接引用的资产缺失、类型不支持、未共享或归属变更时抛出的哨兵错误。
const ErrSharedScheduleReferences = new Error("共享任务引用资产不可用");

/**
 * 解析共享定时任务的直接引用列表并校验每个引用均存在且已处于共享状态，生成可固定到版本中的资产归属列表。
 * 嵌套依赖由被引用资产自身的解析器负责，不在此展开固定。
 *
 * @param {AssistantReference[]} refs - 原始直接引用列表。
 * @returns {SharedScheduleAsset[]} 校验通过的直接引用资产归属数组。
 * @throws {Error} 引用列表非法或存在未共享/不存在的引用资产时抛出错误。
 */
CatalogRepo.prototype.sharedScheduleAssets = function (refs) {
  const resolved = this.directScheduleReferences(refs);
  const out = [];
  for (const ref of resolved) {
    const [, shared, found] = this.sharedScheduleReference(ref);
    if (!found || !shared) {
      throw new Error(`${ErrSharedScheduleReferences.message}：${ref.Type}/${ref.ID} 不存在或尚未共享`);
    }
    out.push(new SharedScheduleAsset({ Type: ref.Type, ID: ref.ID, ProjectID: ref.ProjectID }));
  }
  return out;
};

/**
 * 校验并去重定时任务的直接引用列表（上限 12 个，仅允许 `agent`/`skill`/`sop`），
 * 返回补齐了规范名称与项目归属的引用数组。
 *
 * @param {AssistantReference[]} refs - 原始引用列表。
 * @returns {AssistantReference[]} 去重且已解析目录元信息的引用数组。
 * @throws {Error} 数量超过 12、类型不受支持或引用目标不存在时抛出错误。
 */
CatalogRepo.prototype.directScheduleReferences = function (refs) {
  if (refs.length > 12) {
    throw new Error(`${ErrSharedScheduleReferences.message}：最多引用 12 个资产`);
  }
  const out = [];
  const seen = {};
  for (const raw of refs) {
    const ref = new AssistantReference({ Type: raw.Type.trim(), ID: raw.ID.trim() });
    if (ref.Type !== "agent" && ref.Type !== "skill" && ref.Type !== "sop") {
      throw new Error(`${ErrSharedScheduleReferences.message}：${ref.Type} 不支持随 AI 定时任务共享`);
    }
    const key = ref.Type + "/" + ref.ID;
    if (seen[key]) {
      continue;
    }
    const [canonical, , found] = this.sharedScheduleReference(ref);
    if (ref.ID === "" || !found) {
      throw new Error(`${ErrSharedScheduleReferences.message}：${key} 不存在`);
    }
    seen[key] = true;
    out.push(canonical);
  }
  return out;
};

/**
 * 在调用方提供的发布事务中，将归属当前项目且尚未共享的直接引用资产委托给对应资产的共享路径执行级联共享。
 * 若资产已共享则直接跳过；若属于其他项目且未共享则拒绝共享。
 *
 * @param {AssistantReference} ref - 待共享的单个直接引用。
 * @param {string} projectID - 发布方所属的项目 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 资产不存在、跨项目未共享、类型不受支持或底层共享失败时抛出错误。
 */
CatalogRepo.prototype.shareScheduleReference = function (ref, projectID) {
  const [canonical, shared, found] = this.sharedScheduleReference(ref);
  if (!found) {
    throw new Error(`${ErrSharedScheduleReferences.message}：${ref.Type}/${ref.ID} 不存在`);
  }
  if (shared) {
    return;
  }
  if (canonical.ProjectID !== projectID) {
    throw new Error(`${ErrSharedScheduleReferences.message}：${ref.Type}/${ref.ID} 不属于当前项目且尚未共享`);
  }
  if (ref.Type !== "agent" && ref.Type !== "skill" && ref.Type !== "sop") {
    throw new Error(`${ErrSharedScheduleReferences.message}：${ref.Type} 不支持随 AI 定时任务共享`);
  }
  try {
    switch (ref.Type) {
      case "agent":
        this.ShareAgent(ref.ID);
        break;
      case "skill":
        this.ShareSkill(ref.ID);
        break;
      case "sop":
        this.ShareWorkflow(ref.ID);
        break;
    }
  } catch (err) {
    throw new Error(`${ErrSharedScheduleReferences.message}：共享 ${ref.Type}/${ref.ID} 失败：${err.message}`);
  }
};

/**
 * 通过与对话一致的目录读取入口解析单个直接引用，补齐其名称与所属项目 ID 并报告是否已共享与是否存在。
 * 模板内部的角色与技能由 SOP 引擎自行解析，不在此处理。
 *
 * @param {AssistantReference} ref - 待解析的引用对象。
 * @returns {[AssistantReference, boolean, boolean]} 三元组 `[规范化引用, 是否已共享(含通用模板), 是否存在]`。
 */
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

/**
 * 重新核验已发布共享版本直接引用资产的当前权限与项目归属是否仍与版本发布时一致。
 * 用于订阅或运行共享定时任务前防止底层引用资产被取消共享或迁移归属。
 *
 * @param {import("../domain/shared_schedule.js").SharedScheduleVersion} v - 待核验的共享定时任务版本对象。
 * @returns {void} 无返回值。
 * @throws {Error} 任一直接引用不可用、数量不一致或项目归属发生变更时抛出错误。
 */
CatalogRepo.prototype.ValidateSharedScheduleAssets = function (v) {
  const assets = this.sharedScheduleAssets(v.References);
  if (assets.length !== v.Assets.length) {
    throw new Error(`${ErrSharedScheduleReferences.message}：直接引用列表与共享版本不一致`);
  }
  for (const asset of assets) {
    // Go 的 slices.Contains 按值比较结构体，JS 用 some 逐字段比较。
    if (!v.Assets.some((a) => a.Type === asset.Type && a.ID === asset.ID && a.ProjectID === asset.ProjectID)) {
      throw new Error(`${ErrSharedScheduleReferences.message}：${asset.Type}/${asset.ID} 的归属已变更，请发布新版本`);
    }
  }
};

module.exports = { ErrSharedScheduleReferences };
