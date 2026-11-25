// catalog.js —— 对应 Go 文件：internal/domain/catalog.go
// 作用：目录资产对当前项目的归属、共享可见性与运行项目判定。

"use strict";

// CatalogOwned：目录项是否属于当前项目。
function CatalogOwned(itemProjectID, currentProjectID) {
  const item = itemProjectID.trim();
  const current = currentProjectID.trim();
  return current !== "" && item === current;
}

// CatalogSharedWith：目录项是否应出现在当前项目的“共享”页；空 projectId 的旧记录仍作为共享可见。
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

// CatalogVisible：项目能否看到目录项：自有、已共享，或旧全局记录。
function CatalogVisible(itemProjectID, shared, currentProjectID) {
  return CatalogOwned(itemProjectID, currentProjectID) || CatalogSharedWith(itemProjectID, shared, currentProjectID);
}

// KeepCatalogProjectID：写入省略 projectId 时保留目录项原有项目。
function KeepCatalogProjectID(incoming, existing) {
  const id = incoming.trim();
  if (id !== "") {
    return id;
  }
  return existing.trim();
}

// AssetVisible：运行配置资产是否属于当前项目；空 projectId 表示平台级默认资产。
function AssetVisible(itemProjectID, currentProjectID) {
  const item = itemProjectID.trim();
  const current = currentProjectID.trim();
  return item === "" || current === "" || item === current;
}

// RunProjectID：优先用已盖章的执行上下文，其次用关联需求。
function RunProjectID(run, issueProjectID) {
  const id = run.ExecutionContext.ProjectID.trim();
  if (id !== "") {
    return id;
  }
  return issueProjectID.trim();
}

module.exports = { CatalogOwned, CatalogSharedWith, CatalogVisible, KeepCatalogProjectID, AssetVisible, RunProjectID };
