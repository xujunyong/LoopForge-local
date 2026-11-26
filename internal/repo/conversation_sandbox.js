// conversation_sandbox.js —— 对应 Go 文件：internal/repo/conversation_sandbox.go
// 作用：对话工作区沙箱的校验与解析：只接受 Docker 或 native 沙箱，不静默替换。

"use strict";

const { SandboxProfile, SandboxDriverDocker, SandboxDriverNative, SandboxDriverSeatbelt, SandboxDriverBwrap } = require("../domain/assets.js"); // 对应 Go 的 domain.*，assets.js 已翻译
const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译
const { GenericDockerSandboxID } = require("./generic_workflows.js"); // 对应 Go 同包常量，generic_workflows.js 待翻译

// ConversationSandbox validates an explicit choice without silently substituting
// a different toolchain or exposing another project's environment. A
// conversation workspace runs in a Docker sandbox with a Dockerfile, or in the
// execution machine's native lightweight sandbox.
CatalogRepo.prototype.ConversationSandbox = function (projectID, id) {
  id = id.trim();
  const [profile, ok] = this.Sandbox(id);
  if (!ok || !(profile.Shared || (projectID !== "" && profile.ProjectID === projectID))) {
    if (projectID === "") {
      return [new SandboxProfile(), new Error("请选择共享的沙箱配置")];
    }
    return [new SandboxProfile(), new Error("请选择本项目或共享的沙箱配置")];
  }
  switch (profile.Driver) {
    case SandboxDriverDocker:
      if (profile.Dockerfile == null || profile.Dockerfile.Content.trim() === "") {
        return [new SandboxProfile(), new Error(`Docker 沙箱 ${profile.ID} 没有 Dockerfile，请联系项目 Owner 更新沙箱配置`)];
      }
      break;
    case SandboxDriverNative:
    case SandboxDriverSeatbelt:
    case SandboxDriverBwrap:
      break;
    default:
      return [new SandboxProfile(), new Error("对话工作区只支持 Docker 或 native 沙箱")];
  }
  return [profile, null];
};

// ResolveConversationSandbox validates the chosen sandbox, or the platform
// generic Docker sandbox when nothing was chosen. An invalid choice is
// reported instead of being replaced.
CatalogRepo.prototype.ResolveConversationSandbox = function (projectID, chosen) {
  let id = chosen.trim();
  if (id === "") {
    id = GenericDockerSandboxID;
  }
  return this.ConversationSandbox(projectID, id);
};

// ConversationSandboxes lists every sandbox a conversation of projectID may
// use.
CatalogRepo.prototype.ConversationSandboxes = function (projectID) {
  const out = [];
  for (const profile of this.Sandboxes()) {
    const [, err] = this.ConversationSandbox(projectID, profile.ID);
    if (err == null) {
      out.push(profile);
    }
  }
  return out;
};
