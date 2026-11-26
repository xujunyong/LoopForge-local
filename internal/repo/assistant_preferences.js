/**
 * @file internal/repo/assistant_preferences.js
 * 对应 Go 源文件：internal/repo/assistant_preferences.go
 *
 * 作用与职责边界：
 * 负责读取和覆盖保存用户维度的 Main Bot 助手偏好设置（包括主动角色/SOP 开关、发送时引导、
 * 工作区驱动、自定义指令及审批复核模式与自定义 API 配置）。
 * 不负责默认偏好推导逻辑本身（由领域层 `AssistantPreferences` 负责）或权限校验。
 *
 * 语法差异说明：
 * - Go `(domain.AssistantPreferences, error)` 译为成功返回偏好对象、失败 `throw err`。
 * - Go 指针字段 `*string` / `*time.Time` 在 JS 中直接以 `null` 或对应值表示。
 * - 同包方法通过 `AssistantRepo.prototype.<Method>` 挂载。
 */

"use strict";

const { AssistantPreferences, ApprovalReviewAPIConfig } = require("../domain/assistant_preferences.js"); // 对应 Go 同包类型，assistant_preferences.js 已翻译
const { assistantPreferenceRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

/**
 * 读取指定用户的 Main Bot 偏好设置。
 * 当用户 ID 非法或从未保存过偏好时返回零值 `AssistantPreferences`；读取到记录时会清洗首尾空白、
 * 解析审批复核 API 配置并计算生效的审批复核模式。
 *
 * @param {number} userID - 目标用户 ID。
 * @returns {AssistantPreferences} 用户的助手偏好设置对象。
 */
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

/**
 * 覆盖保存指定用户的 Main Bot 偏好设置，并返回落库后规范化的最新偏好对象。
 * 写入前会对文本字段及自定义审批复核 API 配置进行去空白整理。
 *
 * @param {number} userID - 目标用户 ID（必须大于 0）。
 * @param {AssistantPreferences} p - 待保存的偏好设置对象。
 * @returns {AssistantPreferences} 保存成功后重新读取的规范化偏好对象。
 * @throws {Error} 当 `userID <= 0` 或数据库保存失败时抛出错误。
 */
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
