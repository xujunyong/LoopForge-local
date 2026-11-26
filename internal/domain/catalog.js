/**
 * @file internal/domain/catalog.js
 * 对应 Go 源文件：internal/domain/catalog.go
 *
 * 作用与职责边界：
 * 提供目录资产（角色、工作流、规则、技能、执行器、沙箱等）对当前项目的归属判定、
 * 共享可见性判定、写入时项目归属保留以及运行所属项目解析的纯领域规则函数。
 * 不访问数据库，也不涉及用户身份鉴权。
 */

"use strict";

/**
 * 判断某目录项是否归属于当前项目。
 * 在筛选项目自有资产列表或校验编辑归属时调用；当前项目为空时始终返回 `false`。
 *
 * @param {string} itemProjectID - 目录项自身记录的所属项目 ID。
 * @param {string} currentProjectID - 当前上下文项目 ID。
 * @returns {boolean} 当前项目非空且与目录项所属项目一致时返回 `true`，否则返回 `false`。
 */
function CatalogOwned(itemProjectID, currentProjectID) {
  const item = itemProjectID.trim();
  const current = currentProjectID.trim();
  return current !== "" && item === current;
}

/**
 * 判断某目录项是否应出现在当前项目的“共享”标签页中。
 * 未填写 `projectId` 的历史全局记录视为共享可见，以保证存量生产 SOP 和角色不会消失；
 * 归属于当前项目自身的资产不重复出现在共享页中。
 *
 * @param {string} itemProjectID - 目录项自身记录的所属项目 ID。
 * @param {boolean} shared - 目录项是否开启了跨项目共享开关。
 * @param {string} currentProjectID - 当前上下文项目 ID。
 * @returns {boolean} 应对当前项目显示为共享资产时返回 `true`，否则返回 `false`。
 */
function CatalogSharedWith(itemProjectID, shared, currentProjectID) {
  const item = itemProjectID.trim();
  const current = currentProjectID.trim();
  if (item === "") {
    return true;
  }
  if (current !== "" && item === current) {
    return false;
  }
  return shared;
}

/**
 * 判断当前项目是否有权查看指定目录项。
 * 满足“项目自有”、“其他项目已共享”或“历史全局记录”任一条件即返回 `true`。
 *
 * @param {string} itemProjectID - 目录项自身记录的所属项目 ID。
 * @param {boolean} shared - 目录项是否开启了跨项目共享开关。
 * @param {string} currentProjectID - 当前上下文项目 ID。
 * @returns {boolean} 目录项对当前项目可见时返回 `true`，否则返回 `false`。
 */
function CatalogVisible(itemProjectID, shared, currentProjectID) {
  return CatalogOwned(itemProjectID, currentProjectID) || CatalogSharedWith(itemProjectID, shared, currentProjectID);
}

/**
 * 在更新目录项时保留其既有项目归属。
 * 当精简版更新请求或旧客户端省略 `projectId` 字段时，回退保留数据库中原有的 `existing` 项目 ID。
 *
 * @param {string} incoming - 本次写入请求传入的项目 ID。
 * @param {string} existing - 已有记录中保存的项目 ID。
 * @returns {string} 去空白后最终应写入的项目 ID。
 */
function KeepCatalogProjectID(incoming, existing) {
  const id = incoming.trim();
  if (id !== "") {
    return id;
  }
  return existing.trim();
}

/**
 * 判断运行配置资产（如执行器、沙箱）对当前项目是否可见。
 * `itemProjectID` 为空表示平台级默认资产，对所有项目可见；`currentProjectID` 为空时也不按项目过滤。
 *
 * @param {string} itemProjectID - 运行配置资产所属项目 ID（为空表示平台默认）。
 * @param {string} currentProjectID - 当前上下文项目 ID。
 * @returns {boolean} 资产对当前项目可见时返回 `true`，否则返回 `false`。
 */
function AssetVisible(itemProjectID, currentProjectID) {
  const item = itemProjectID.trim();
  const current = currentProjectID.trim();
  return item === "" || current === "" || item === current;
}

/**
 * 解析一次运行（`Run`）所属的项目 ID。
 * 优先采用运行执行上下文中固化的 `ProjectID`，为空时再回退到关联需求所属的 `issueProjectID`。
 *
 * @param {Object} run - 运行对象（`Run`），需包含 `ExecutionContext.ProjectID`。
 * @param {string} issueProjectID - 关联需求所属的项目 ID。
 * @returns {string} 去空白后解析得到的项目 ID。
 */
function RunProjectID(run, issueProjectID) {
  const id = run.ExecutionContext.ProjectID.trim();
  if (id !== "") {
    return id;
  }
  return issueProjectID.trim();
}

module.exports = { CatalogOwned, CatalogSharedWith, CatalogVisible, KeepCatalogProjectID, AssetVisible, RunProjectID };
