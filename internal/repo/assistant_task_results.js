/**
 * @file internal/repo/assistant_task_results.js
 * 对应 Go 源文件：internal/repo/assistant_task_results.go
 *
 * 作用与职责边界：
 * 负责在定时助手任务单次执行完成后，在行锁事务中仅回写本次运行的运行时结果字段
 * （状态、错误、输出消息、通知正文、关联会话 ID 与更新时间）并按需入队完成通知。
 * 若任务在执行期间已被删除或已被更新的运行覆盖，则直接跳过，绝不重建已删除的任务。
 *
 * 语法差异说明：
 * - Go 仅返回 `error` 的方法在 JS 中成功返回 `undefined`、失败 `throw err`；`db.Transaction` 回调同样遵循失败抛错、成功正常返回。
 * - Go 的 `time.Time.UnixMilli()` 对零值返回 `-62135596800000`，JS 对 `null` 时间按同一毫秒基准比较。
 * - Go 的 `map[string]string[key]` 在键不存在时返回 `""`，JS 使用 `?? ""` 保持相同零值语义。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { decodeAssistantTask } = require("./assistant.js"); // 对应 Go 同包函数，assistant.js 已翻译
const { assistantTaskRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

/**
 * 仅更新定时助手任务的本次运行时结果字段，绝不重建已被删除的任务。
 * 供后台定时任务执行器在单轮执行结束时调用；若任务已被删除或 `LastRunAt` 已不匹配，则静默返回；
 * 若任务从 `"running"` 进入 `"ok"` 或 `"error"`，则使用启动时冻结的通知快照将通知入队。
 *
 * @param {number} userID - 定时任务所属用户 ID。
 * @param {import("../domain/assistant.js").AssistantTask} result - 包含本次执行结果字段的任务对象。
 * @returns {void} 无返回值。
 * @throws {Error} 查询、更新数据库或入队任务通知失败时抛出错误。
 */
AssistantRepo.prototype.SaveAssistantTaskResult = function (userID, result) {
  this.DB.Transaction((tx) => {
    const row = new assistantTaskRow();
    const err = this.locking(tx).Where("id = ? AND user_id = ?", result.ID, userID).First(row).Error;
    if (err === gorm.ErrRecordNotFound) {
      return;
    }
    if (err != null) {
      throw err;
    }
    const current = decodeAssistantTask(row);
    const currentMs = current.LastRunAt == null ? -62135596800000 : current.LastRunAt.getTime();
    const resultMs = result.LastRunAt == null ? -62135596800000 : result.LastRunAt.getTime();
    if (currentMs !== resultMs) {
      return;
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
      throw updateErr;
    }
    const trigger = ({ ok: "succeeded", error: "failed" })[result.LastStatus] ?? "";
    if (priorStatus === "running" && trigger !== "") {
      let content = current.NotificationResult;
      if (content === "") {
        content = current.LastMessage;
      }
      this.notifications.enqueueTaskNotifications(tx, "assistant_task", current.ID, current.ProjectID, current.Name, trigger, current.LastRunAt, current.NotificationSnapshot, content, current.LastError);
    }
  });
};
