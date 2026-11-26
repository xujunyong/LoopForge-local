/**
 * @file internal/repo/schedule_job_results.js
 * 对应 Go 源文件：internal/repo/schedule_job_results.go
 *
 * 作用与职责边界：
 * 为目录仓储 `CatalogRepo` 实现定时任务运行期会话 ID 绑定与执行终态结果回写，
 * 通过行级写锁与 `LastRunAt` 毫秒时间戳围栏校验，既保护并发编辑的定时任务配置不被覆盖，
 * 也防止已删除或已被新一轮调度取代的旧执行覆盖新状态；终态回写成功时在同一事务内入队完成/失败通知。
 * 不负责单次执行历史明细表写入与小时统计（见 `schedule_job_executions.js`）。
 *
 * 语法差异说明：
 * - `CatalogRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `CatalogRepo.prototype` 挂载方法。
 * - Go 的仅 `error` 返回与 `db.Transaction(tx => ...)` 回调统一按成功返回 `undefined`、失败 `throw err` 处理。
 * - `jsonUnmarshal` 与 `enqueueTaskNotifications` 失败时直接抛错，不再通过返回值传递错误。
 * - Go 的 `LastRunAt.UnixMilli()` 在 JS 中使用 `timeMs(LastRunAt)` 比较。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { ScheduleJob } = require("../domain/sync.js"); // 对应 Go 的 domain.ScheduleJob，sync.js 已翻译
const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { jsonUnmarshal, mustJSON, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { scheduleJobRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { timeMs } = require("./analytics.js"); // 对应 Go 同包函数，analytics.js 已翻译

/**
 * 在事务行锁内为当前正在运行的定时任务记录其打开的对话会话 ID，
 * 使中断的执行仍保留会话关联，固定会话模式的任务也会同步固定 `FixedSessionID`。
 * 仅当数据库中记录的 `LastRunAt` 与本次启动时间一致且处于 `running` 状态时才写回会话字段。
 *
 * @param {string} id - 定时任务主键 ID。
 * @param {Date} lastRunAt - 本次运行的启动时间戳（用于并发围栏校验）。
 * @param {string} sessionID - 本次运行打开的对话会话 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 事务加锁查询（非 `ErrRecordNotFound`）、载荷解码或更新失败时抛出错误。
 */
CatalogRepo.prototype.SaveScheduleJobRunSession = function (id, lastRunAt, sessionID) {
  this.DB.Transaction((tx) => {
    const row = new scheduleJobRow();
    const err = this.locking(tx).Where("id = ?", id).First(row).Error;
    if (err === gorm.ErrRecordNotFound) {
      return;
    }
    if (err != null) {
      throw err;
    }
    const current = new ScheduleJob();
    jsonUnmarshal(row.Payload, current);
    if (timeMs(current.LastRunAt) !== timeMs(lastRunAt) || current.LastStatus !== "running") {
      return;
    }
    current.LastSessionID = sessionID;
    if (current.UsesFixedSession()) {
      current.FixedSessionID = sessionID;
    }
    const updateErr = tx.Model(row).Updates({ payload: mustJSON(current) }).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
};

/**
 * 在事务行锁内回写定时任务本次执行的终态结果，同时保留期间用户的配置修改，
 * 并通过 `LastRunAt` 围栏过滤已删除或已被新一轮调度覆盖的过期回写。
 * 当状态由 `running` 转为 `success` 或 `failed` 时，在同一事务中调用通知仓储将任务通知入队。
 *
 * @param {ScheduleJob} result - 携带本次执行结果字段的定时任务对象。
 * @returns {void} 无返回值。
 * @throws {Error} 事务加锁查询（非 `ErrRecordNotFound`）、载荷解码、更新或通知入队失败时抛出错误。
 */
CatalogRepo.prototype.SaveScheduleJobResult = function (result) {
  this.DB.Transaction((tx) => {
    const row = new scheduleJobRow();
    const err = this.locking(tx).Where("id = ?", result.ID).First(row).Error;
    if (err === gorm.ErrRecordNotFound) {
      return;
    }
    if (err != null) {
      throw err;
    }
    const current = new ScheduleJob();
    jsonUnmarshal(row.Payload, current);
    if (timeMs(current.LastRunAt) !== timeMs(result.LastRunAt)) {
      return;
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
      throw updateErr;
    }
    const trigger = { success: "succeeded", failed: "failed" }[result.LastStatus] ?? "";
    if (priorStatus === "running" && trigger !== "") {
      let content = current.NotificationResult;
      if (content === "") {
        content = current.LastAssistantMessage;
      }
      this.notifications.enqueueTaskNotifications(tx, "schedule_job", current.ID, current.ProjectID, current.Name, trigger, current.LastRunAt, current.NotificationSnapshot, content, current.LastError);
    }
  });
};
