// assistant_preferences.js —— 对应 Go 文件：internal/domain/assistant_preferences.go
// 作用：单个用户对 Main Bot 的工作方式偏好与“帮我批准”评审设置。

"use strict";

const { SandboxDriverDocker, SandboxDriverNative } = require("./assets.js"); // 对应 Go 同包常量，assets.js 已翻译

// AssistantDefaults：用用户自己的凭证做新选择时适用的默认值。
class AssistantDefaults {
  constructor(init = {}) {
    this.Executor = init.Executor ?? "";
    this.Model = init.Model ?? "";
    this.Effort = init.Effort ?? "";
    this.Approval = init.Approval ?? "";
  }
}

// AssistantPreferencesInstructionsMax：用户给 Main Bot 的自定规则上限。
const AssistantPreferencesInstructionsMax = 4000;

// “帮我批准”的评审模式。
const ApprovalReviewModeFollow = "follow";
const ApprovalReviewModeCLI = "cli";
const ApprovalReviewModeAPI = "api";

// ApprovalReviewAPIConfig：可选的独立 HTTP API 配置，只用于“帮我批准”AI 评审。
class ApprovalReviewAPIConfig {
  constructor(init = {}) {
    this.Protocol = init.Protocol ?? "";
    this.BaseURL = init.BaseURL ?? "";
    this.Model = init.Model ?? "";
    this.APIKey = init.APIKey ?? "";
    this.APIKeyConfigured = init.APIKeyConfigured ?? false;
    this.APIKeyClear = init.APIKeyClear ?? false;
  }
}

// AssistantPreferences：一个用户希望 Main Bot 如何工作。
class AssistantPreferences {
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

  // EffectiveApprovalReviewMode：返回规范化后的评审模式，未存模式但存过模型时兼容为 CLI。
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

  // Sanitized：返回可发给 API 响应的副本，原始自定义评审 API 密钥已剥离。
  Sanitized() {
    const out = new AssistantPreferences(this);
    out.ApprovalReviewMode = this.EffectiveApprovalReviewMode();
    if (this.ApprovalReviewAPI != null) {
      const cp = { ...this.ApprovalReviewAPI };
      cp.APIKeyConfigured = cp.APIKey.trim() !== "" || cp.APIKeyConfigured;
      cp.APIKey = "";
      cp.APIKeyClear = false;
      out.ApprovalReviewAPI = cp;
    }
    return out;
  }
}

// ValidAssistantWorkspaceDriver：接受会话工作区可偏好的驱动，空表示无偏好。
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
