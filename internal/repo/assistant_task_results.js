// assistant_task_results.js —— 对应 Go 文件：internal/repo/assistant_task_results.go
// 作用：只更新助手定时任务的运行时字段，任务删除后不再重建。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { decodeAssistantTask } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 本次一同翻译
const { assistantTaskRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// SaveAssistantTaskResult updates only runtime fields. A deleted task is never recreated.
AssistantRepo.prototype.SaveAssistantTaskResult = function (userID, result) {
  return this.DB.Transaction((tx) => {
    const row = new assistantTaskRow();
    const err = this.locking(tx).Where("id = ? AND user_id = ?", result.ID, userID).First(row).Error;
    if (err === gorm.ErrRecordNotFound) {
      return null;
    }
    if (err != null) {
      return err;
    }
    const current = decodeAssistantTask(row);
    const currentMs = current.LastRunAt == null ? 0 : current.LastRunAt.getTime();
    const resultMs = result.LastRunAt == null ? 0 : result.LastRunAt.getTime();
    if (currentMs !== resultMs) {
      return null;
    }
    const priorStatus = current.LastStatus;
    current.LastStatus = result.LastStatus;
    current.LastError = result.LastError;
    current.LastMessage = result.LastMessage;
    current.NotificationResult = result.NotificationResult;
    current.SessionID = result.SessionID;
    current.UpdatedAt = new Date();
    const updateErr = tx.Model(row).Updates({ payload: mustJSON(current), updated_at: timePtr(current.UpdatedAt) }).Error;
    if (updateErr != null) {
      return updateErr;
    }
    const trigger = ({ ok: "succeeded", error: "failed" })[result.LastStatus];
    if (priorStatus === "running" && trigger !== "") {
      let content = current.NotificationResult;
      if (content === "") {
        content = current.LastMessage;
      }
      return this.notifications.enqueueTaskNotifications(tx, "assistant_task", current.ID, current.ProjectID, current.Name, trigger, current.LastRunAt, current.NotificationSnapshot, content, current.LastError);
    }
    return null;
  });
};
