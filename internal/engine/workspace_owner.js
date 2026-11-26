// workspace_owner.js —— 对应 Go 文件：internal/engine/workspace_owner.go
// 作用：工作区归属：子 SOP 共享父任务检出时的归属、绑定与进度判断。
// (值, bool) 译为 [值, bool]；strings.TrimSpace 译为 String.prototype.trim。

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译

// workspaceRunID 返回 r 执行所在的工作区所属运行。
function workspaceRunID(r) {
  const id = r.ExecutionContext.WorkspaceRunID.trim();
  if (id !== "") {
    return id;
  }
  return r.ID;
}

// sharesWorkspace 报告 r 是否为在另一运行的检出里工作的子 SOP。
function sharesWorkspace(r) {
  return workspaceRunID(r) !== r.ID;
}

// nodeControlKey 命名节点在检出内的自有控制路径（门禁结果、物化输入、运行时调用目录）。子 SOP 在父检出里与父的其他分支并发运行，工作流可能复用父的节点 ID；它的键带上子运行，双方互不清除或读取对方文件。
function nodeControlKey(r, nodeID) {
  if (!sharesWorkspace(r)) {
    return nodeID;
  }
  return r.ID + "--" + nodeID;
}

// workspaceBind 返回持有 r 工作区的 (host, root)。子 SOP 在拥有检出的运行绑定工作区后跟随它。
Engine.prototype.workspaceBind = function (r) {
  if (sharesWorkspace(r)) {
    const [owner, ok] = this.repo.RunState(workspaceRunID(r));
    if (ok && owner.WorkspaceRoot.trim() !== "") {
      return [owner.WorkspaceHost, owner.WorkspaceRoot];
    }
  }
  return [r.WorkspaceHost, r.WorkspaceRoot];
};

// hasCodeWorkspace 报告丢失 r 的工作区是否会丢失代码改动：它检出仓库，或在另一运行的检出里工作。
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

// hasWorkspaceProgress 报告除 nodeID 外是否已有节点改动过工作区，换全新检出继续会悄悄丢掉它们的工作。
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
