// tasks.js —— 对应 Go 文件：internal/repo/tasks.go
// 作用：跨实例幂等任务记录的读写与状态更新。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { Task } = require("../domain/task.js"); // 对应 Go 的 domain.Task，task.js 已翻译
const { payloadList, payloadOne, upsert, insertIgnore, mustJSON, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { taskRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译

TasksRepo.prototype.Tasks = function () {
  const out = payloadList(Task, this.DB, "tasks", "");
  out.sort((a, b) => (b.CreatedAt == null ? 0 : b.CreatedAt.getTime()) - (a.CreatedAt == null ? 0 : a.CreatedAt.getTime()));
  return out;
};

TasksRepo.prototype.Task = function (id) {
  return payloadOne(Task, this.DB, "tasks", id);
};

TasksRepo.prototype.PutTask = function (v) {
  const now = new Date();
  const [old, ok] = this.Task(v.ID);
  if (ok) {
    v.CreatedAt = old.CreatedAt;
  } else {
    v.CreatedAt = now;
  }
  v.UpdatedAt = now;
  return upsert(this.DB, "tasks", {
    id: v.ID, issue_id: v.IssueID, run_id: v.RunID, status: v.Status,
    payload: mustJSON(v), created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  });
};

TasksRepo.prototype.UpdateTaskStatus = function (v, status) {
  v.Status = status;
  v.UpdatedAt = new Date();
  return this.DB.Model(new taskRow()).Where("id = ? AND issue_id = ? AND COALESCE(run_id, '') = ?", v.ID, v.IssueID, v.RunID).
    Updates({ status: v.Status, payload: mustJSON(v), updated_at: timePtr(v.UpdatedAt) }).Error;
};

TasksRepo.prototype.createTask = function (tx, v) {
  if (v.ID.trim() === "" || v.IssueID.trim() === "") {
    return [new Task(), false, new Error("task id and issue id are required")];
  }
  const now = new Date();
  v.CreatedAt = now;
  v.UpdatedAt = now;
  let created = false;
  try {
    created = insertIgnore(tx, "tasks", {
      id: v.ID, issue_id: v.IssueID, run_id: v.RunID, status: v.Status,
      payload: mustJSON(v), created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
    });
  } catch (err) {
    // JS 版 insertIgnore 失败时 throw，Go 版返回 error。
    if (err !== gorm.ErrDuplicatedKey) {
      return [new Task(), false, err];
    }
  }
  if (created) {
    return [v, true, null];
  }
  const [existing, ok] = payloadOne(Task, tx, "tasks", v.ID);
  if (!ok) {
    return [new Task(), false, new Error("task reservation was not persisted")];
  }
  return [existing, false, null];
};

TasksRepo.prototype.deleteIssueTasks = function (tx, issueID) {
  return tx.Where("issue_id = ?", issueID).Delete(new taskRow()).Error;
};

TasksRepo.prototype.IssueHasTasks = function (issueID) {
  const n = { value: 0 }; // Go 的 Count(&n) 用对象接出参。
  const countErr = this.DB.Model(new taskRow()).Where("issue_id = ?", issueID).Limit(1).Count(n).Error;
  if (countErr != null) {
    return [false, countErr];
  }
  return [n.value > 0, null];
};
