// assistant_preferences.js —— 对应 Go 文件：internal/repo/assistant_preferences.go
// 作用：读写用户的 Main Bot 偏好设置。

"use strict";

const { AssistantPreferences, ApprovalReviewAPIConfig } = require("../domain/assistant_preferences.js"); // 对应 Go 同包类型，assistant_preferences.js 已翻译
const { assistantPreferenceRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// AssistantPreferences returns the user's Main Bot settings; the zero value
// when they never saved any.
AssistantRepo.prototype.AssistantPreferences = function (userID) {
  const out = new AssistantPreferences();
  if (userID <= 0) {
    return out;
  }
  const row = new assistantPreferenceRow();
  const err = this.DB.Where("user_id = ?", userID).Take(row).Error;
  if (err != null) {
    return out;
  }
  out.ProactiveRoles = row.ProactiveRoles;
  out.ProactiveSOPs = row.ProactiveSOPs;
  out.SteerOnSend = row.SteerOnSend;
  out.WorkspaceDriver = row.WorkspaceDriver;
  out.Instructions = row.Instructions;
  out.ApprovalReviewMode = row.ApprovalReviewMode.trim();
  out.ApprovalReviewModel = row.ApprovalReviewModel.trim();
  if (row.ApprovalReviewAPI != null && row.ApprovalReviewAPI.trim() !== "") {
    let cfg = null;
    try {
      cfg = new ApprovalReviewAPIConfig(JSON.parse(row.ApprovalReviewAPI));
    } catch (e) {
      cfg = null;
    }
    if (cfg != null) {
      cfg.Protocol = cfg.Protocol.trim();
      cfg.BaseURL = cfg.BaseURL.trim();
      cfg.Model = cfg.Model.trim();
      cfg.APIKey = cfg.APIKey.trim();
      cfg.APIKeyConfigured = cfg.APIKey !== "";
      cfg.APIKeyClear = false;
      if (cfg.Protocol !== "" || cfg.BaseURL !== "" || cfg.Model !== "" || cfg.APIKey !== "") {
        out.ApprovalReviewAPI = cfg;
      }
    }
  }
  out.ApprovalReviewMode = out.EffectiveApprovalReviewMode();
  if (row.UpdatedAt != null) {
    out.UpdatedAt = row.UpdatedAt;
  }
  return out;
};

// PutAssistantPreferences replaces the user's Main Bot settings.
AssistantRepo.prototype.PutAssistantPreferences = function (userID, p) {
  if (userID <= 0) {
    throw new Error("user id is required");
  }
  const now = new Date();
  let apiJSON = null;
  if (p.ApprovalReviewAPI != null) {
    const clean = new ApprovalReviewAPIConfig({
      Protocol: p.ApprovalReviewAPI.Protocol.trim(),
      BaseURL: p.ApprovalReviewAPI.BaseURL.trim(),
      Model: p.ApprovalReviewAPI.Model.trim(),
      APIKey: p.ApprovalReviewAPI.APIKey.trim(),
    });
    if (clean.Protocol !== "" || clean.BaseURL !== "" || clean.Model !== "" || clean.APIKey !== "") {
      try {
        apiJSON = JSON.stringify(clean);
      } catch (err) {
        // Go 忽略编码错误。
      }
    }
  }
  const row = new assistantPreferenceRow({
    UserID: userID,
    ProactiveRoles: p.ProactiveRoles,
    ProactiveSOPs: p.ProactiveSOPs,
    SteerOnSend: p.SteerOnSend,
    WorkspaceDriver: p.WorkspaceDriver.trim(),
    Instructions: p.Instructions.trim(),
    ApprovalReviewMode: p.EffectiveApprovalReviewMode(),
    ApprovalReviewModel: p.ApprovalReviewModel.trim(),
    ApprovalReviewAPI: apiJSON,
    UpdatedAt: now,
  });
  const err = this.DB.Save(row).Error;
  if (err != null) {
    throw err;
  }
  return this.AssistantPreferences(userID);
};

module.exports = {};
