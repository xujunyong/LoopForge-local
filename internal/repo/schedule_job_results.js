// schedule_job_results.js —— 对应 Go 文件：internal/repo/schedule_job_results.go
// 作用：定时任务执行结果回写：运行会话与终态，带防并发的围栏校验。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { ScheduleJob } = require("../domain/sync.js"); // 对应 Go 的 domain.ScheduleJob，sync.js 已翻译
const { jsonUnmarshal, mustJSON, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { scheduleJobRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { timeMs } = require("./analytics.js"); // 对应 Go 同包函数，analytics.js 已翻译

CatalogRepo.prototype.SaveScheduleJobRunSession = function (id, lastRunAt, sessionID) {
  return this.DB.Transaction((tx) => {
    const row = new scheduleJobRow();
    const err = this.locking(tx).Where("id = ?", id).First(row).Error;
    if (err === gorm.ErrRecordNotFound) {
      return null;
    }
    if (err != null) {
      return err;
    }
    const current = new ScheduleJob();
    const unmarshalErr = jsonUnmarshal(row.Payload, current);
    if (unmarshalErr != null) {
      return unmarshalErr;
    }
    if (timeMs(current.LastRunAt) !== timeMs(lastRunAt) || current.LastStatus !== "running") {
      return null;
    }
    current.LastSessionID = sessionID;
    if (current.UsesFixedSession()) {
      current.FixedSessionID = sessionID;
    }
    return tx.Model(row).Updates({ payload: mustJSON(current) }).Error;
  });
};

CatalogRepo.prototype.SaveScheduleJobResult = function (result) {
  return this.DB.Transaction((tx) => {
    const row = new scheduleJobRow();
    const err = this.locking(tx).Where("id = ?", result.ID).First(row).Error;
    if (err === gorm.ErrRecordNotFound) {
      return null;
    }
    if (err != null) {
      return err;
    }
    const current = new ScheduleJob();
    const unmarshalErr = jsonUnmarshal(row.Payload, current);
    if (unmarshalErr != null) {
      return unmarshalErr;
    }
    if (timeMs(current.LastRunAt) !== timeMs(result.LastRunAt)) {
      return null;
    }
    const priorStatus = current.LastStatus;
    current.LastStatus = result.LastStatus;
    current.LastError = result.LastError;
    current.LastPulled = result.LastPulled;
    current.LastDispatched = result.LastDispatched;
    current.LastAssistantMessage = result.LastAssistantMessage;
    current.NotificationResult = result.NotificationResult;
    current.Blockers = result.Blockers;
    current.LastSessionID = result.LastSessionID;
    // 期间的配置保存可能已退出固定模式，不再重新固定。
    if (result.FixedSessionID !== "" && current.UsesFixedSession()) {
      current.FixedSessionID = result.FixedSessionID;
    }
    current.UpdatedAt = new Date();
    const updateErr = tx.Model(row).Updates({ payload: mustJSON(current), updated_at: timePtr(current.UpdatedAt) }).Error;
    if (updateErr != null) {
      return updateErr;
    }
    const trigger = { success: "succeeded", failed: "failed" }[result.LastStatus] ?? "";
    if (priorStatus === "running" && trigger !== "") {
      let content = current.NotificationResult;
      if (content === "") {
        content = current.LastAssistantMessage;
      }
      return this.notifications.enqueueTaskNotifications(tx, "schedule_job", current.ID, current.ProjectID, current.Name, trigger, current.LastRunAt, current.NotificationSnapshot, content, current.LastError);
    }
    return null;
  });
};
