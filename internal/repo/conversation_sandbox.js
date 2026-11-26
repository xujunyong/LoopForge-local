/**
 * @file internal/repo/conversation_sandbox.js
 * 对应 Go 源文件：internal/repo/conversation_sandbox.go
 *
 * 作用与职责边界：
 * 实现对话工作区沙箱配置的可见性校验、默认回退解析与可用列表过滤，挂载在 `CatalogRepo` 原型上。
 * 仅允许使用带有效 Dockerfile 的 Docker 沙箱或执行机本地轻量隔离沙箱（`native`/`seatbelt`/`bwrap`），
 * 对无效选择直接报错而绝不静默替换工具链或暴露其他项目的私有环境。
 *
 * 语法差异说明：
 * - `CatalogRepo` 定义于 `repo.js`，本文件通过 `CatalogRepo.prototype` 挂载方法。
 * - Go 的 `(domain.SandboxProfile, error)` 返回译为成功返回 `SandboxProfile`、失败 `throw Error`。
 */

"use strict";

const { SandboxDriverDocker, SandboxDriverNative, SandboxDriverSeatbelt, SandboxDriverBwrap } = require("../domain/assets.js"); // 对应 Go 的 domain.*，assets.js 已翻译
const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { GenericDockerSandboxID } = require("./generic_workflows.js"); // 对应 Go 同包常量，generic_workflows.js 已翻译

/**
 * 校验对话工作区显式选中的沙箱配置：验证其存在性、对目标项目的可见性（共享或归属当前项目）以及驱动合规性。
 * Docker 沙箱必须包含非空 Dockerfile；不静默替换为其他沙箱。
 *
 * @param {string} projectID - 对话所属项目 ID（无项目归属时为空串，此时仅允许共享沙箱）。
 * @param {string} id - 选中的沙箱配置 ID。
 * @returns {import("../domain/assets.js").SandboxProfile} 校验通过的沙箱配置对象。
 * @throws {Error} 沙箱不存在、无权跨项目使用、Docker 沙箱缺少 Dockerfile 或驱动类型不受支持时抛出错误。
 */
CatalogRepo.prototype.ConversationSandbox = function (projectID, id) {
  id = id.trim();
  const [profile, ok] = this.Sandbox(id);
  if (!ok || !(profile.Shared || (projectID !== "" && profile.ProjectID === projectID))) {
    if (projectID === "") {
      throw new Error("请选择共享的沙箱配置");
    }
    throw new Error("请选择本项目或共享的沙箱配置");
  }
  switch (profile.Driver) {
    case SandboxDriverDocker:
      if (profile.Dockerfile == null || profile.Dockerfile.Content.trim() === "") {
        throw new Error(`Docker 沙箱 ${profile.ID} 没有 Dockerfile，请联系项目 Owner 更新沙箱配置`);
      }
      break;
    case SandboxDriverNative:
    case SandboxDriverSeatbelt:
    case SandboxDriverBwrap:
      break;
    default:
      throw new Error("对话工作区只支持 Docker 或 native 沙箱");
  }
  return profile;
};

/**
 * 解析对话工作区应使用的沙箱配置：若未指定（`chosen` 为空）则使用平台通用 Docker 沙箱，随后执行完整校验。
 * 对非法选择直接抛出错误，不做静默降级替换。
 *
 * @param {string} projectID - 对话所属项目 ID。
 * @param {string} chosen - 用户或会话指定的沙箱 ID（为空时回退至 `GenericDockerSandboxID`）。
 * @returns {import("../domain/assets.js").SandboxProfile} 解析并校验通过的沙箱配置对象。
 * @throws {Error} 解析到的沙箱不满足对话工作区校验规则时抛出错误。
 */
CatalogRepo.prototype.ResolveConversationSandbox = function (projectID, chosen) {
  let id = chosen.trim();
  if (id === "") {
    id = GenericDockerSandboxID;
  }
  return this.ConversationSandbox(projectID, id);
};

/**
 * 列出指定项目的对话工作区可选择的全部合规沙箱配置。
 * 遍历全部沙箱并过滤出通过 `ConversationSandbox` 校验的配置。
 *
 * @param {string} projectID - 目标项目 ID（为空串时仅返回合规的共享沙箱）。
 * @returns {import("../domain/assets.js").SandboxProfile[]} 可用于对话工作区的沙箱配置数组。
 */
CatalogRepo.prototype.ConversationSandboxes = function (projectID) {
  const out = [];
  for (const profile of this.Sandboxes()) {
    try {
      this.ConversationSandbox(projectID, profile.ID);
      out.push(profile);
    } catch {
      // 不满足对话工作区校验条件的沙箱跳过。
    }
  }
  return out;
};
