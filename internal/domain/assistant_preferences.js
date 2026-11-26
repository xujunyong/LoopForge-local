/**
 * @file internal/domain/assistant_preferences.js
 * 对应 Go 源文件：internal/domain/assistant_preferences.go
 *
 * 作用与职责边界：
 * 定义单个用户对 Studio 主助手（Main Bot）的个人默认配置与工作偏好模型，
 * 包括主动委派角色/SOP、发送时转向开关、偏好沙箱驱动、自定义指令上限、“帮我批准”评审模式及独立 HTTP API 配置，
 * 并提供评审模式归一化、API 密钥脱敏拷贝及工作区驱动合法性校验。
 * 不负责偏好读写存储或实际审批请求发送。
 */

"use strict";

const { SandboxDriverDocker, SandboxDriverNative } = require("./assets.js"); // 对应 Go 同包常量，assets.js 已翻译

/**
 * 表示使用用户个人凭证发起新会话或任务时的默认执行参数。
 */
class AssistantDefaults {
  /**
   * 构造并初始化用户默认执行参数实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Executor = init.Executor ?? "";
    this.Model = init.Model ?? "";
    this.Effort = init.Effort ?? "";
    this.Approval = init.Approval ?? "";
  }
}

// 用户附加给主助手的自定义规则文本长度上限（字符数）。
const AssistantPreferencesInstructionsMax = 4000;

// “帮我批准”功能的评审模式常量：跟随当前会话模型、使用 CLI 模型或使用独立 HTTP API。
const ApprovalReviewModeFollow = "follow";
const ApprovalReviewModeCLI = "cli";
const ApprovalReviewModeAPI = "api";

/**
 * 表示“帮我批准”AI 评审专用的可选独立 HTTP API 配置，无需依赖本地 CLI 凭证即可完成评审。
 */
class ApprovalReviewAPIConfig {
  /**
   * 构造并初始化独立评审 HTTP API 配置实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Protocol = init.Protocol ?? "";
    this.BaseURL = init.BaseURL ?? "";
    this.Model = init.Model ?? "";
    this.APIKey = init.APIKey ?? "";
    this.APIKeyConfigured = init.APIKeyConfigured ?? false;
    this.APIKeyClear = init.APIKeyClear ?? false;
  }
}

/**
 * 表示单个用户对主助手工作方式的完整偏好设置。
 * 控制角色/SOP 主动协作倾向、发送插话行为、工作区沙箱驱动偏好、自定义附加规则以及“帮我批准”评审模型设置。
 */
class AssistantPreferences {
  /**
   * 构造并初始化用户助手偏好实例。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ProactiveRoles = init.ProactiveRoles ?? false;
    this.ProactiveSOPs = init.ProactiveSOPs ?? false;
    this.SteerOnSend = init.SteerOnSend ?? false;
    this.WorkspaceDriver = init.WorkspaceDriver ?? "";
    this.Instructions = init.Instructions ?? "";
    this.ApprovalReviewMode = init.ApprovalReviewMode ?? "";
    this.ApprovalReviewModel = init.ApprovalReviewModel ?? "";
    this.ApprovalReviewAPI = init.ApprovalReviewAPI ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  /**
   * 返回规范化后的“帮我批准”评审模式。
   * 兼容早期仅保存了 `ApprovalReviewModel` 而未保存模式字段的历史记录（此时自动归为 `cli` 模式），
   * 均未配置时默认回退为 `follow`。
   *
   * @returns {string} 生效的评审模式常量（`"follow"`、`"cli"` 或 `"api"`）。
   */
  EffectiveApprovalReviewMode() {
    switch (this.ApprovalReviewMode.trim()) {
      case ApprovalReviewModeFollow:
      case ApprovalReviewModeCLI:
      case ApprovalReviewModeAPI:
        return this.ApprovalReviewMode.trim();
    }
    if (this.ApprovalReviewModel.trim() !== "") {
      return ApprovalReviewModeCLI;
    }
    return ApprovalReviewModeFollow;
  }

  /**
   * 返回可安全下发到 API 响应的脱敏副本。
   * 会先规范化 `ApprovalReviewMode`，并剥离 `ApprovalReviewAPI` 中的明文 `APIKey`（改由 `APIKeyConfigured` 标明是否已配置）。
   *
   * @returns {AssistantPreferences} 剥离敏感密钥后的偏好副本实例。
   */
  Sanitized() {
    const out = new AssistantPreferences(this);
    out.ApprovalReviewMode = this.EffectiveApprovalReviewMode();
    if (this.ApprovalReviewAPI != null) {
      const cp = new ApprovalReviewAPIConfig(this.ApprovalReviewAPI);
      cp.APIKeyConfigured = cp.APIKey.trim() !== "" || cp.APIKeyConfigured;
      cp.APIKey = "";
      cp.APIKeyClear = false;
      out.ApprovalReviewAPI = cp;
    }
    return out;
  }
}

/**
 * 校验用户偏好的对话工作区沙箱驱动是否合法。
 * 仅允许空字符串（表示无偏好，交由助手自动选择）、`docker` 或 `native`。
 *
 * @param {string} driver - 待校验的沙箱驱动名称。
 * @returns {boolean} 合法返回 `true`，否则返回 `false`。
 */
function ValidAssistantWorkspaceDriver(driver) {
  switch (driver) {
    case "":
    case SandboxDriverDocker:
    case SandboxDriverNative:
      return true;
  }
  return false;
}

module.exports = { AssistantDefaults, AssistantPreferencesInstructionsMax, ApprovalReviewModeFollow, ApprovalReviewModeCLI, ApprovalReviewModeAPI, ApprovalReviewAPIConfig, AssistantPreferences, ValidAssistantWorkspaceDriver };
