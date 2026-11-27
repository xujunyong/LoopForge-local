/**
 * @file internal/engine/workspace_owner.js
 * 对应 Go 源文件：internal/engine/workspace_owner.go
 *
 * 作用与职责边界：
 * 定义工作区归属与共享判定规则：解析运行实际使用的工作区所属运行 ID、判断子 SOP 是否共享父运行检出目录、
 * 为共享检出中的节点生成互不冲突的控制路径键、解析工作区宿主机与根目录绑定，以及判断是否存在代码工作区与工作区进度；
 * `Engine` 方法挂载于 `Engine.prototype`（`Engine` 定义于 `engine.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(string, string)` 与 `(值, bool)` 多返回值译为二元组 `[值1, 值2]`。
 * - Go 的 `strings.TrimSpace` 译为 `String.prototype.trim`。
 */

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译

/**
 * 返回运行 `r` 实际执行所在的工作区归属运行 ID；若 `ExecutionContext.WorkspaceRunID` 非空则返回该父运行 ID，否则返回 `r.ID`。
 * 使用场景：定位沙箱工作区目录、快照归属与子 SOP 共享检出。
 *
 * @param {object} r - 运行快照对象（`domain.Run`）。
 * @returns {string} 持有工作区检出目录的运行 ID。
 */
function workspaceRunID(r) {
  const id = r.ExecutionContext.WorkspaceRunID.trim();
  if (id !== "") {
    return id;
  }
  return r.ID;
}

/**
 * 判断运行 `r` 是否为共享另一运行（父运行）检出目录的子 SOP。
 * 使用场景：区分独立工作区与共享父工作区，以决定清理、控制路径隔离与绑定跟随策略。
 *
 * @param {object} r - 运行快照对象（`domain.Run`）。
 * @returns {boolean} 共享其他运行工作区时返回 `true`，否则返回 `false`。
 */
function sharesWorkspace(r) {
  return workspaceRunID(r) !== r.ID;
}

/**
 * 生成节点在共享检出目录内的控制路径键（用于门禁结果、物化输入与运行时调用目录）。
 * 子 SOP 与父运行的其他分支并发运行在同一检出目录且可能复用节点 ID，因此子 SOP 的键会附加子运行 ID 前缀以防冲突。
 *
 * @param {object} r - 运行快照对象（`domain.Run`）。
 * @param {string} nodeID - 工作流节点 ID。
 * @returns {string} 节点控制路径键；独立工作区返回 `nodeID`，共享工作区返回 `${r.ID}--${nodeID}`。
 */
function nodeControlKey(r, nodeID) {
  if (!sharesWorkspace(r)) {
    return nodeID;
  }
  return r.ID + "--" + nodeID;
}

/**
 * 返回持有运行 `r` 工作区的 `(host, root)` 绑定信息；若 `r` 为子 SOP 且拥有检出的父运行已绑定工作区，则跟随父运行的绑定。
 * 使用场景：判断工作区位于本机还是跨宿主实例，以及拼接远端工作区路径。
 *
 * @param {object} r - 运行快照对象（`domain.Run`）。
 * @returns {[string, string]} 二元组 `[WorkspaceHost, WorkspaceRoot]`。
 */
Engine.prototype.workspaceBind = function (r) {
  if (sharesWorkspace(r)) {
    const [owner, ok] = this.repo.RunState(workspaceRunID(r));
    if (ok && owner.WorkspaceRoot.trim() !== "") {
      return [owner.WorkspaceHost, owner.WorkspaceRoot];
    }
  }
  return [r.WorkspaceHost, r.WorkspaceRoot];
};

/**
 * 判断丢失运行 `r` 的工作区是否会丢失代码改动（即该运行检出了至少一个仓库，或正在另一运行的检出中工作）。
 * 使用场景：判断工作区是否需要严格绑定到原宿主机而不允许在新宿主空目录续跑。
 *
 * @param {object} r - 运行快照对象（`domain.Run`）。
 * @returns {boolean} 包含代码工作区时返回 `true`，否则返回 `false`。
 */
function hasCodeWorkspace(r) {
  if (sharesWorkspace(r)) {
    return true;
  }
  for (const rc of r.RepositoryContexts()) {
    if (rc.RepositoryID.trim() !== "") {
      return true;
    }
  }
  return false;
}

/**
 * 判断除 `nodeID` 之外是否已有其他节点在工作区上成功产出改动；若已有进度，则在全新检出上继续执行会静默丢弃前序工作。
 * 使用场景：跨实例迁移或重试节点前判断是否必须复用原有工作区。
 *
 * @param {object} r - 运行快照对象（`domain.Run`）。
 * @param {string} nodeID - 当前准备执行的节点 ID（检查时排除该节点自身）。
 * @returns {boolean} 共享工作区或存在其他已成功节点时返回 `true`，否则返回 `false`。
 */
function hasWorkspaceProgress(r, nodeID) {
  if (sharesWorkspace(r)) {
    return true;
  }
  for (const [id, nr] of Object.entries(r.Nodes)) {
    if (id !== nodeID && nr != null && nr.Status === "succeeded") {
      return true;
    }
  }
  return false;
}

module.exports = { workspaceRunID, sharesWorkspace, nodeControlKey, hasCodeWorkspace, hasWorkspaceProgress };
