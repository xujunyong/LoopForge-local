/**
 * @file internal/repo/issues_delete.js
 * 对应 Go 源文件：internal/repo/issues_delete.go
 *
 * 作用与职责边界：
 * 实现需求删除与关闭前的准入检查、历史运行/任务扫描以及原子清理逻辑：
 * 根据需求的澄清状态、关联任务与关联运行记录判断阻塞原因及是否需要强制删除，
 * 并在引擎清理完关联运行记录后，在事务内原子删除任务、评论与需求本体。
 * 不负责运行记录及工作区本身的销毁（由引擎层先执行清理）。
 *
 * 语法差异说明：
 * - `IssuesRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `IssuesRepo.prototype` 挂载各删除与准入方法。
 * - Go 中 `IssuesRepo.mu`（`sync.Mutex`）在单线程 JS 中不需要，按规则直接略去。
 * - Go 的 `iota` 枚举（`IssueDeletionMode`）译为等值数字常量。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；`db.Transaction` 回调同样失败抛错、成功正常返回。
 * - Go 的 `map[string]V` 与嵌套 `map[string]map[string]bool` 统一译为普通对象 `{}`；`errors.Is` 译为 `===`。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { Issue } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue，issue.js 已翻译
const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { issueRow, issueCommentRow, taskRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { jsonUnmarshal } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { IssuesRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译

/** 需求处于澄清中或仍有未结束任务/运行时抛出的删除阻塞错误。 */
const ErrIssueBusy = new Error("需求正在澄清或执行 SOP，请先停止后再删除");
/** 在仅允许删除未成功需求的模式下，发现需求已有成功记录时抛出的错误。 */
const ErrIssueSucceeded = new Error("需求已有成功运行记录，不允许删除");
/** 在普通删除模式下，发现需求存在执行历史或已完成而需要强制确认时抛出的错误。 */
const ErrIssueForceRequired = new Error("需求已有执行记录或已完成，请确认强制删除");
/** 目标需求不存在时抛出的未找到错误。 */
const ErrIssueNotFound = new Error("issue not found");

// 需求删除模式常量（对应 Go 的 IssueDeletionMode iota 枚举）。
/** 普通删除模式：有历史执行记录或已完成时需要前端二次确认强制删除。 */
const IssueDeleteNormal = 0;
/** 强制删除模式：允许删除有历史记录的需求，但仍禁止删除进行中的需求。 */
const IssueDeleteForce = 1;
/** 保守清理模式：供同步与会话清理等内部调用方使用，禁止删除已有成功记录的需求。 */
const IssueDeleteUnsuccessful = 2;

/**
 * 在数据库事务中加锁校验需求是否满足指定删除模式，并返回需先由引擎清理的全部关联运行 ID 列表。
 * 用于执行破坏性清理前收集关联运行记录并提前拦截不允许删除的状态。
 *
 * @param {string} id - 待删除的需求 ID。
 * @param {number} mode - 删除模式（`IssueDeleteNormal`、`IssueDeleteForce` 或 `IssueDeleteUnsuccessful`）。
 * @returns {string[]} 需在删除需求前先清理的关联运行 ID 数组。
 * @throws {Error} 需求不存在、存在活跃阻塞、模式校验不通过或数据库查询失败时抛出错误。
 */
IssuesRepo.prototype.IssueDeletionRuns = function (id, mode) {
  let ids = [];
  this.DB.Transaction((tx) => {
    ids = this.issueDeletionRuns(tx, id, mode);
  });
  return ids;
};

/**
 * 在已有事务中对目标需求行加锁、检查其删除状态，按删除模式校验后返回关联运行 ID 列表。
 * 供 `IssueDeletionRuns` 与 `DeleteIssueAfterRunCleanup` 复用。
 *
 * @param {object} tx - 当前事务的 `gorm.DB` 句柄。
 * @param {string} id - 目标需求 ID。
 * @param {number} mode - 删除模式常量。
 * @returns {string[]} 关联运行 ID 数组。
 * @throws {Error} 需求不存在（`ErrIssueNotFound`）、JSON 解码失败、阻塞（`ErrIssueBusy`）、需强制删除（`ErrIssueForceRequired`）或已有成功记录（`ErrIssueSucceeded`）时抛出错误。
 */
IssuesRepo.prototype.issueDeletionRuns = function (tx, id, mode) {
  const row = new issueRow();
  const err = this.locking(tx.Where("id = ?", id)).Take(row).Error;
  if (err != null) {
    if (err === gorm.ErrRecordNotFound) {
      throw ErrIssueNotFound;
    }
    throw err;
  }
  const issue = new Issue();
  jsonUnmarshal(row.Payload, issue);
  const states = this.issueDeletionStates(tx, [issue]);
  const state = states[issue.ID];
  if (state.Block != null) {
    throw ErrIssueBusy;
  }
  if (mode === IssueDeleteNormal && state.RequiresForce()) {
    throw ErrIssueForceRequired;
  }
  if (mode === IssueDeleteUnsuccessful && state.successful) {
    throw ErrIssueSucceeded;
  }
  return state.runIDs;
};

/**
 * 按保守清理策略（`IssueDeleteUnsuccessful`）删除需求，仅供同步清理与会话清理等内部调用方使用。
 *
 * @param {string} id - 待删除的需求 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 需求存在未清理运行、已有成功记录、活跃阻塞或数据库删除失败时抛出错误。
 */
IssuesRepo.prototype.DeleteIssue = function (id) {
  this.DeleteIssueAfterRunCleanup(id, IssueDeleteUnsuccessful);
};

/**
 * 在引擎清理完关联运行记录后，在事务内重新校验删除条件并原子删除该需求的任务、评论与需求本体。
 * Go 原文通过 `r.mu` 与数据库事务协同保护；JS 单线程环境下直接执行数据库事务。
 *
 * @param {string} id - 待删除的需求 ID。
 * @param {number} mode - 删除模式常量。
 * @returns {void} 无返回值。
 * @throws {Error} 删除准入校验失败、仍残留历史运行记录或任一表删除失败时抛出错误。
 */
IssuesRepo.prototype.DeleteIssueAfterRunCleanup = function (id, mode) {
  this.DB.Transaction((tx) => {
    const ids = this.issueDeletionRuns(tx, id, mode);
    if (ids.length > 0) {
      throw new Error("请先清理需求的历史运行记录");
    }
    this.tasks.deleteIssueTasks(tx, id);
    const commentsErr = tx.Where("issue_id = ?", id).Delete(new issueCommentRow()).Error;
    if (commentsErr != null) {
      throw commentsErr;
    }
    const issueErr = tx.Where("id = ?", id).Delete(new issueRow()).Error;
    if (issueErr != null) {
      throw issueErr;
    }
  });
};

/**
 * 描述阻止删除或关闭需求的进行中工作原因。
 * `RunID` 仅在关联到实际存在的运行记录（含旧任务 `RunID` 关联）时填充。
 */
class IssueDeletionBlock {
  /**
   * 构造需求删除阻塞说明对象，缺省字段按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.Code=""] - 阻塞代码（如 `"clarifying"`、`"active"`）。
   * @param {string} [init.Reason=""] - 面向用户的阻塞原因说明。
   * @param {string} [init.RunID=""] - 关联的活跃运行 ID。
   * @param {string} [init.TaskID=""] - 关联的活跃任务 ID。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Code = init.Code ?? "";
    this.Reason = init.Reason ?? "";
    this.RunID = init.RunID ?? "";
    this.TaskID = init.TaskID ?? "";
  }
}

/**
 * 汇总单条需求的删除准入判定状态，记录活跃阻塞信息、历史执行标记、成功标记以及关联运行 ID 列表。
 */
class IssueDeletionState {
  /**
   * 构造需求删除状态对象，缺省字段按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {IssueDeletionBlock | null} [init.Block=null] - 当前阻塞删除的活跃原因，无阻塞时为 `null`。
   * @param {boolean} [init.hasHistory=false] - 是否存在任何历史任务或运行记录。
   * @param {boolean} [init.successful=false] - 是否已完成或存在成功任务/运行记录。
   * @param {string[]} [init.runIDs=[]] - 所有关联运行 ID 数组。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Block = init.Block ?? null;
    this.hasHistory = init.hasHistory ?? false;
    this.successful = init.successful ?? false;
    this.runIDs = init.runIDs ?? [];
  }

  /**
   * 判断该需求在普通删除模式下是否需要前端确认强制删除。
   * 仅当无活跃阻塞且存在历史执行记录或已成功完成时返回 `true`。
   *
   * @returns {boolean} 需要强制删除确认时返回 `true`，否则返回 `false`。
   */
  RequiresForce() {
    return this.Block == null && (this.hasHistory || this.successful);
  }

  /**
   * 登记一条关联的任务记录：任意任务均记为存在历史，已完成/成功任务记为成功，其余未结束任务阻塞删除。
   *
   * @param {string} taskID - 任务唯一标识。
   * @param {string} status - 任务当前状态字符串。
   * @returns {void} 无返回值。
   */
  addTask(taskID, status) {
    this.hasHistory = true;
    switch (status) {
      case "completed":
      case "succeeded":
        this.successful = true;
        break;
      case "failed":
      case "cancelled":
        break;
      default:
        if (this.Block == null) {
          this.Block = new IssueDeletionBlock({ Code: "active", Reason: "仍有未结束的任务，请先处理或停止后再删除", TaskID: taskID });
        }
        break;
    }
  }

  /**
   * 登记一条关联的运行记录：计入历史与运行 ID 列表，若运行未达终态或仍有活跃节点则设置阻塞。
   * 若先前的阻塞原因是活跃任务，会优先替换为关联到该活跃运行的阻塞说明。
   *
   * @param {issueDeletionRun} run - 关联运行摘要对象。
   * @returns {void} 无返回值。
   */
  addRun(run) {
    this.hasHistory = true;
    this.successful = this.successful || run.Status === "succeeded";
    this.runIDs.push(run.ID);
    if (TerminalRunStatus(run.Status) && !run.ActiveNodes) {
      return;
    }
    // 更早的阻塞原因是任务时，优先关联到进行中的运行记录。
    if (this.Block == null || (this.Block.Code === "active" && this.Block.RunID === "")) {
      this.Block = new IssueDeletionBlock({ Code: "active", Reason: "仍有未结束的运行，请先处理或停止后再删除", RunID: run.ID });
    }
  }
}

/**
 * 批量检查一组需求的完整执行历史与删除准入状态（通过两次批量 SQL 查询完成）。
 * 用于需求列表渲染删除按钮状态及批量校验。
 *
 * @param {Issue[]} issues - 待检查的需求数组。
 * @returns {Object<string, IssueDeletionState>} 以需求 ID 为键、对应删除状态为值的普通对象映射。
 * @throws {Error} 关联任务/运行查询失败或任务需求编号不一致时抛出错误。
 */
IssuesRepo.prototype.IssueDeletionStates = function (issues) {
  return this.issueDeletionStates(this.DB, issues);
};

/**
 * 在指定数据库或事务句柄上批量查询并组装一组需求的删除状态。
 * 先批量读取关联 `tasks`，再结合执行上下文与旧任务 `RunID` 批量查询关联 `runs` 及其活跃节点状态。
 *
 * @param {object} db - `gorm.DB` 或事务句柄。
 * @param {Issue[]} issues - 待检查的需求数组。
 * @returns {Object<string, IssueDeletionState>} 以需求 ID 为键的删除状态映射。
 * @throws {Error} 数据库查询失败或任务记录所属需求不在输入集合中时抛出错误。
 */
IssuesRepo.prototype.issueDeletionStates = function (db, issues) {
  const states = {};
  if (issues.length === 0) {
    return states;
  }
  const ids = [];
  for (const issue of issues) {
    ids.push(issue.ID);
    const state = new IssueDeletionState({ successful: issue.Status === "done" });
    if (issue.Clarification.Status === "analyzing") {
      state.Block = new IssueDeletionBlock({ Code: "clarifying", Reason: "正在澄清，请先停止澄清后再删除" });
    }
    states[issue.ID] = state;
  }
  const tasks = [];
  const tasksErr = db.Select("id", "issue_id", "run_id", "status").Where("issue_id IN ?", ids).Find(tasks).Error;
  if (tasksErr != null) {
    throw tasksErr;
  }
  // 历史旧运行可能仅通过 Task 的 RunID 与需求关联。
  const runIssues = {};
  const runIDs = [];
  for (const task of tasks) {
    const state = states[task.IssueID];
    if (state == null) {
      throw new Error(`执行任务 ${task.ID} 的需求编号与记录不一致`);
    }
    state.addTask(task.ID, task.Status);
    if (task.RunID !== "") {
      if (runIssues[task.RunID] == null) {
        runIssues[task.RunID] = {};
        runIDs.push(task.RunID);
      }
      runIssues[task.RunID][task.IssueID] = true;
    }
  }

  const expr = this.sqlExecutionContextJSONText("issueId");
  let q = db.Table("runs").Select("id, status, " + expr + " AS issue_id, " +
    "EXISTS (SELECT 1 FROM run_nodes WHERE run_id = runs.id AND status IN ('running', 'pending_input')) AS active_nodes").
    Where(expr + " IN ?", ids);
  if (runIDs.length > 0) {
    q = q.Or("id IN ?", runIDs);
  }
  const runs = [];
  const runsErr = q.Find(runs).Error;
  if (runsErr != null) {
    throw runsErr;
  }
  for (const run of runs) {
    const linked = runIssues[run.ID];
    for (const id of Object.keys(linked ?? {})) {
      states[id].addRun(run);
    }
    const state = states[run.IssueID];
    if (state != null && !(linked ?? {})[run.IssueID]) {
      state.addRun(run);
    }
  }
  return states;
};

/**
 * 表示一条通过执行上下文或旧任务 `RunID` 关联到需求的运行摘要行。
 */
class issueDeletionRun {
  /**
   * 构造关联运行摘要行实例，缺省字段按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.ID=""] - 运行唯一标识。
   * @param {string} [init.Status=""] - 运行状态。
   * @param {string} [init.IssueID=""] - 执行上下文中提取的需求 ID。
   * @param {boolean} [init.ActiveNodes=false] - 是否仍存在运行中或待人工输入的节点。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Status = init.Status ?? "";
    this.IssueID = init.IssueID ?? "";
    this.ActiveNodes = init.ActiveNodes ?? false;
  }
}

/**
 * 批量判定一组需求是否允许被关闭：允许存在已完结的历史执行记录，但不允许存在进行中的工作。
 * 供 `CloseIssue` 及前端关闭按钮可用性检查调用。
 *
 * @param {Issue[]} issues - 待检查的需求数组。
 * @returns {Object<string, boolean>} 以需求 ID 为键、是否允许关闭为布尔值的映射对象。
 * @throws {Error} 底层执行历史状态查询失败时抛出错误。
 */
IssuesRepo.prototype.IssueClosureAllowed = function (issues) {
  const states = this.IssueDeletionStates(issues);
  const allowed = {};
  for (const [id, state] of Object.entries(states)) {
    allowed[id] = state.Block == null;
  }
  return allowed;
};

module.exports = { ErrIssueBusy, ErrIssueSucceeded, ErrIssueForceRequired, ErrIssueNotFound, IssueDeleteNormal, IssueDeleteForce, IssueDeleteUnsuccessful, IssueDeletionBlock, IssueDeletionState, issueDeletionRun };
