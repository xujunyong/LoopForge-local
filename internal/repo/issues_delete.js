// issues_delete.js —— 对应 Go 文件：internal/repo/issues_delete.go
// 作用：需求删除的准入检查与清理：按执行历史决定能否删除，并原子删除需求及关联记录。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { Issue } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue，issue.js 已翻译
const { TerminalRunStatus } = require("../domain/run_eval.js"); // 对应 Go 的 domain.TerminalRunStatus，run_eval.js 已翻译
const { issueRow, issueCommentRow, taskRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { jsonUnmarshal } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { IssuesRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

const ErrIssueBusy = new Error("需求正在澄清或执行 SOP，请先停止后再删除");
const ErrIssueSucceeded = new Error("需求已有成功运行记录，不允许删除");
const ErrIssueForceRequired = new Error("需求已有执行记录或已完成，请确认强制删除");
const ErrIssueNotFound = new Error("issue not found");

// Go 的 iota 枚举；JS 用同值常量代替。
const IssueDeleteNormal = 0;
const IssueDeleteForce = 1;
const IssueDeleteUnsuccessful = 2;

// 删除前检查所有关联运行。
IssuesRepo.prototype.IssueDeletionRuns = function (id, mode) {
  let ids = [];
  const err = this.DB.Transaction((tx) => {
    try {
      ids = this.issueDeletionRuns(tx, id, mode);
    } catch (e) {
      return e;
    }
    return null;
  });
  if (err != null) {
    throw err;
  }
  return ids;
};

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
  const unmarshalErr = jsonUnmarshal(row.Payload, issue);
  if (unmarshalErr != null) {
    throw unmarshalErr;
  }
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

IssuesRepo.prototype.DeleteIssue = function (id) {
  return this.DeleteIssueAfterRunCleanup(id, IssueDeleteUnsuccessful);
};

IssuesRepo.prototype.DeleteIssueAfterRunCleanup = function (id, mode) {
  this.mu.Lock();
  try {
    // Go 的 defer r.mu.Unlock() 译为 finally。
    return this.DB.Transaction((tx) => {
      let ids;
      try {
        ids = this.issueDeletionRuns(tx, id, mode);
      } catch (e) {
        return e;
      }
      if (ids.length > 0) {
        return new Error("请先清理需求的历史运行记录");
      }
      const tasksErr = this.tasks.deleteIssueTasks(tx, id);
      if (tasksErr != null) {
        return tasksErr;
      }
      const commentsErr = tx.Where("issue_id = ?", id).Delete(new issueCommentRow()).Error;
      if (commentsErr != null) {
        return commentsErr;
      }
      return tx.Where("id = ?", id).Delete(new issueRow()).Error;
    });
  } finally {
    this.mu.Unlock();
  }
};

// IssueDeletionBlock 说明阻止删除需求的进行中工作，RunID 只在已有运行时填充。
class IssueDeletionBlock {
  constructor(init = {}) {
    this.Code = init.Code ?? "";
    this.Reason = init.Reason ?? "";
    this.RunID = init.RunID ?? "";
    this.TaskID = init.TaskID ?? "";
  }
}

class IssueDeletionState {
  constructor(init = {}) {
    this.Block = init.Block ?? null;
    this.hasHistory = init.hasHistory ?? false;
    this.successful = init.successful ?? false;
    this.runIDs = init.runIDs ?? [];
  }

  RequiresForce() {
    return this.Block == null && (this.hasHistory || this.successful);
  }

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

  addRun(run) {
    this.hasHistory = true;
    this.successful = this.successful || run.Status === "succeeded";
    this.runIDs.push(run.ID);
    if (TerminalRunStatus(run.Status) && !run.ActiveNodes) {
      return;
    }
    // 更早的原因是任务时，优先关联到进行中的运行。
    if (this.Block == null || (this.Block.Code === "active" && this.Block.RunID === "")) {
      this.Block = new IssueDeletionBlock({ Code: "active", Reason: "仍有未结束的运行，请先处理或停止后再删除", RunID: run.ID });
    }
  }
}

IssuesRepo.prototype.IssueDeletionStates = function (issues) {
  return this.issueDeletionStates(this.DB, issues);
};

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
  // 旧运行只靠任务的 RunID 关联。
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

// issueDeletionRun：通过执行上下文或旧任务 RunID 关联到需求的运行。
class issueDeletionRun {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Status = init.Status ?? "";
    this.IssueID = init.IssueID ?? "";
    this.ActiveNodes = init.ActiveNodes ?? false;
  }
}

IssuesRepo.prototype.IssueClosureAllowed = function (issues) {
  const states = this.IssueDeletionStates(issues);
  const allowed = {};
  for (const [id, state] of Object.entries(states)) {
    allowed[id] = state.Block == null;
  }
  return allowed;
};

module.exports = { ErrIssueBusy, ErrIssueSucceeded, ErrIssueForceRequired, ErrIssueNotFound, IssueDeleteNormal, IssueDeleteForce, IssueDeleteUnsuccessful, IssueDeletionBlock, IssueDeletionState, issueDeletionRun };
