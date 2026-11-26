/**
 * @file internal/repo/tasks.js
 * 对应 Go 源文件：internal/repo/tasks.go
 *
 * 作用与职责边界：
 * 实现跨实例幂等任务记录表（`tasks`）的查询、写入、状态对账更新、事务内幂等占位创建、
 * 随 Issue 级联删除以及派发历史探测；
 * 方法按领域归属挂载于 `TasksRepo.prototype`（`TasksRepo` 定义于 `repo.js`），不负责任务调度执行。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)`、`(值1, 值2, error)` 与仅 `error` 返回统一按成功返回值（或二元组、`undefined`）、失败 `throw err` 处理。
 * - Go 的 `(值, bool)` 译为二元组 `[值, boolean]`；`errors.Is(err, gorm.ErrDuplicatedKey)` 译为 `===`。
 * - Go 的 `Count(&n)` 指针出参在 JS 中使用 `{ value: 0 }` 包装对象承接。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { Task } = require("../domain/task.js"); // 对应 Go 的 domain.Task，task.js 已翻译
const { TasksRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { payloadList, payloadOne, upsert, insertIgnore, mustJSON, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { taskRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译

// ---------- Tasks ----------

/**
 * 查询全部任务记录并按创建时间倒序（最新在前）排列返回。
 * 使用场景：后台巡检、运维视图或统计分析拉取全部任务清单。
 *
 * @returns {Task[]} 按 `CreatedAt` 降序排列的任务领域对象数组。
 */
TasksRepo.prototype.Tasks = function () {
  const out = payloadList(Task, this.DB, "tasks", "");
  out.sort((a, b) => (b.CreatedAt == null ? 0 : b.CreatedAt.getTime()) - (a.CreatedAt == null ? 0 : a.CreatedAt.getTime()));
  return out;
};

/**
 * 按任务主键 ID 读取单条任务记录。
 * 使用场景：根据任务 ID 查询其关联的 Issue、运行 ID 及当前状态。
 *
 * @param {string} id - 任务主键 ID。
 * @returns {[Task, boolean]} 找到且解码成功时返回 `[task, true]`，否则返回 `[空 Task, false]`。
 */
TasksRepo.prototype.Task = function (id) {
  return payloadOne(Task, this.DB, "tasks", id);
};

/**
 * 创建或覆盖写入一条任务记录；若任务已存在则保留原 `CreatedAt`，并更新 `UpdatedAt`。
 * 使用场景：派发任务绑定运行 ID 或整体刷新任务载荷。
 *
 * @param {Task} v - 待保存的任务领域对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
TasksRepo.prototype.PutTask = function (v) {
  const now = new Date();
  const [old, ok] = this.Task(v.ID);
  if (ok) {
    v.CreatedAt = old.CreatedAt;
  } else {
    v.CreatedAt = now;
  }
  v.UpdatedAt = now;
  upsert(this.DB, "tasks", {
    id: v.ID, issue_id: v.IssueID, run_id: v.RunID, status: v.Status,
    payload: mustJSON(v), created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  });
};

/**
 * 仅在任务仍存在且 `id`、`issue_id`、`run_id` 三者匹配时对账更新其状态，
 * 避免对应 Issue 及其执行历史已被删除后意外重新创建孤立任务行。
 *
 * @param {Task} v - 待更新状态的任务领域对象。
 * @param {string} status - 目标任务状态字符串。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库更新执行失败时抛出错误。
 */
TasksRepo.prototype.UpdateTaskStatus = function (v, status) {
  v.Status = status;
  v.UpdatedAt = new Date();
  const err = this.DB.Model(new taskRow()).Where("id = ? AND issue_id = ? AND COALESCE(run_id, '') = ?", v.ID, v.IssueID, v.RunID).
    Updates({ status: v.Status, payload: mustJSON(v), updated_at: timePtr(v.UpdatedAt) }).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 在已有事务中以任务主键作为跨实例幂等键执行占位插入；
 * 若主键已存在则回读既有任务并返回 `created = false`，供 `IssuesRepo` 派发流程去重使用。
 *
 * @param {object} tx - 当前活跃的 `gorm.DB` 事务句柄。
 * @param {Task} v - 待预留创建的任务领域对象（`ID` 与 `IssueID` 均不能为空）。
 * @returns {[Task, boolean]} 二元组 `[持久化任务对象, 是否为本次新创建]`。
 * @throws {Error} 缺少必填字段、数据库发生非重复键错误或冲突后回读不到既有任务时抛出错误。
 */
TasksRepo.prototype.createTask = function (tx, v) {
  if (v.ID.trim() === "" || v.IssueID.trim() === "") {
    throw new Error("task id and issue id are required");
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
    if (err !== gorm.ErrDuplicatedKey) {
      throw err;
    }
  }
  if (created) {
    return [v, true];
  }
  const [existing, ok] = payloadOne(Task, tx, "tasks", v.ID);
  if (!ok) {
    throw new Error("task reservation was not persisted");
  }
  return [existing, false];
};

/**
 * 在删除 Issue 的数据库事务中级联清理该 Issue 下的全部任务记录。
 * 使用场景：由 `IssuesRepo` 的删除事务调用，不单独对外暴露。
 *
 * @param {object} tx - 当前活跃的 `gorm.DB` 事务句柄。
 * @param {string} issueID - 待清理任务所属的 Issue ID。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库删除执行失败时抛出错误。
 */
TasksRepo.prototype.deleteIssueTasks = function (tx, issueID) {
  const err = tx.Where("issue_id = ?", issueID).Delete(new taskRow()).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 判断指定 Issue 是否曾被派发过任务：每次 SOP 派发都会先预留一条 `Task` 且不存在其他创建途径。
 * 使用场景：判断需求是否已进入或曾进入自动化执行流程。
 *
 * @param {string} issueID - 待检查的 Issue ID。
 * @returns {boolean} 存在至少一条关联任务记录时返回 `true`，否则返回 `false`。
 * @throws {Error} 数据库计数查询失败时抛出错误。
 */
TasksRepo.prototype.IssueHasTasks = function (issueID) {
  const n = { value: 0 }; // Go 的 Count(&n) 用对象接出参。
  const countErr = this.DB.Model(new taskRow()).Where("issue_id = ?", issueID).Limit(1).Count(n).Error;
  if (countErr != null) {
    throw countErr;
  }
  return n.value > 0;
};
