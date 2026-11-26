// issues.js —— 对应 Go 文件：internal/repo/issues.go
// 作用：需求与需求评论的读写：分析视图、列表、单条存取、同步写入与补丁。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { Issue, ExternalRef, IssueSOPNone, IssueComment } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue/ExternalRef/IssueSOPNone/IssueComment，issue.js 已翻译
const { SameGongfengMR } = require("../domain/mr.js"); // 对应 Go 的 domain.SameGongfengMR，mr.js 已翻译
const { Task } = require("../domain/task.js"); // 对应 Go 的 domain.Task，task.js 已翻译
const { Project } = require("../domain/project.js"); // 对应 Go 的 domain.Project，project.js 已翻译
const { WorkflowDefinition } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition，workflow.js 已翻译
const { issueRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { jsonUnmarshal, mustJSON, timePtr, upsert, payloadOne, payloadList } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { IssuesRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译
const { bindDefaultWorkflow, ProjectIssueWorkflowID } = require("./catalog.js"); // 对应 Go 同包函数，catalog.js 已翻译
const { ErrIssueNotFound } = require("./issues_delete.js"); // 对应 Go 同包变量，issues_delete.js 本次一同翻译

// Go 的 time.Time 零值译为 null；timeMs 把 null 换算为 Go 零值时间的毫秒数。
function isZeroTime(t) {
  return t == null;
}
function timeMs(t) {
  return t == null ? -62135596800000 : t.getTime();
}
function timeBefore(a, b) {
  return timeMs(a) < timeMs(b);
}
function timeAfter(a, b) {
  return timeMs(a) > timeMs(b);
}

IssuesRepo.prototype.IssueAnalyticsViews = function () {
  class liteRow {
    constructor(init = {}) {
      this.ID = init.ID ?? "";
      this.ProjectID = init.ProjectID ?? "";
      this.Title = init.Title ?? "";
      this.Status = init.Status ?? "";
      this.Kind = init.Kind ?? "";
      this.Source = init.Source ?? "";
      this.WorkflowID = init.WorkflowID ?? "";
      this.AssigneeUserID = init.AssigneeUserID ?? null;
      this.ExternalID = init.ExternalID ?? "";
      this.ExternalURL = init.ExternalURL ?? "";
      this.TapdID = init.TapdID ?? "";
      this.ClarificationStartedAt = init.ClarificationStartedAt ?? "";
      this.DeliveryState = init.DeliveryState ?? "";
      this.CreatedAt = init.CreatedAt ?? null;
      this.DeliveryMRURL = init.DeliveryMRURL ?? "";
    }
  }
  const rows = [];
  if (this.DB.Table("issues").Select(
    "id", "project_id", "title", "status", "kind", "source", "workflow_id", "assignee_user_id", "external_id", "created_at",
    this.sqlPayloadJSONText("externalRef.externalUrl") + " AS external_url",
    this.sqlPayloadJSONText("tapdId") + " AS tapd_id",
    this.sqlPayloadJSONText("clarification.startedAt") + " AS clarification_started_at",
    this.sqlPayloadJSONText("deliveryState") + " AS delivery_state",
    this.sqlPayloadJSONText("deliveryMrUrl") + " AS delivery_mr_url",
  ).Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const issue = new Issue({
      ID: row.ID,
      ProjectID: row.ProjectID,
      Title: row.Title,
      Status: row.Status,
      Kind: row.Kind,
      Source: row.Source,
      TapdID: row.TapdID.trim(),
      WorkflowID: row.WorkflowID,
      DeliveryState: row.DeliveryState.trim(),
      DeliveryMRURL: row.DeliveryMRURL.trim(),
      CreatedAt: row.CreatedAt,
    });
    // Go 的 time.Parse 失败返回错误；JS 用无效 Date 判断，失败时跳过。
    const started = new Date(row.ClarificationStartedAt.trim());
    if (!Number.isNaN(started.getTime())) {
      issue.Clarification.StartedAt = started;
    }
    if (row.AssigneeUserID != null) {
      issue.AssigneeUserID = row.AssigneeUserID;
    }
    const extID = row.ExternalID.trim();
    const extURL = row.ExternalURL.trim();
    if (extID !== "" || extURL !== "") {
      issue.ExternalRef = new ExternalRef({ Source: issue.Source, ExternalID: extID, ExternalURL: extURL });
    }
    out.push(issue);
  }
  if (out.length === 0) {
    return null;
  }
  return out;
};

IssuesRepo.prototype.Issues = function () {
  const rows = [];
  if (this.DB.Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const issue = new Issue();
    if (jsonUnmarshal(row.Payload, issue) != null) {
      continue;
    }
    if (row.AssigneeUserID != null) {
      issue.AssigneeUserID = row.AssigneeUserID;
    } else {
      issue.AssigneeUserID = 0;
    }
    out.push(issue);
  }
  out.sort((a, b) => {
    if (a.ProjectID === b.ProjectID) {
      return b.Number - a.Number;
    }
    return a.ProjectID < b.ProjectID ? -1 : 1;
  });
  if (out.length === 0) {
    // 与 master 保持同一 wire 行为：空结果序列化为 null 而非 []。
    return null;
  }
  return out;
};

IssuesRepo.prototype.Issue = function (id) {
  const row = new issueRow();
  if (this.DB.Where("id = ?", id).Take(row).Error != null) {
    return [new Issue(), false];
  }
  const issue = new Issue();
  if (jsonUnmarshal(row.Payload, issue) != null) {
    return [new Issue(), false];
  }
  if (row.AssigneeUserID != null) {
    issue.AssigneeUserID = row.AssigneeUserID;
  } else {
    issue.AssigneeUserID = 0;
  }
  return [issue, true];
};

function preserveIssueDeliveryFields(v, old) {
  if (old.DeliveryState.trim() === "") {
    return;
  }
  if (v.DeliveryState.trim() === "") {
    v.DeliveryState = old.DeliveryState;
  }
  if (v.DeliveryMRURL.trim() === "") {
    v.DeliveryMRURL = old.DeliveryMRURL;
  }
  if (v.DeliveryMRState.trim() === "") {
    v.DeliveryMRState = old.DeliveryMRState;
  }
  if (v.DeliveryMRs.length === 0 && SameGongfengMR(v.DeliveryMRURL, old.DeliveryMRURL)) {
    v.DeliveryMRs = old.DeliveryMRs;
  }
  if (isZeroTime(v.DeliveryUpdatedAt)) {
    v.DeliveryUpdatedAt = old.DeliveryUpdatedAt;
  }
}

IssuesRepo.prototype.PutIssue = function (v) {
  this.mu.Lock();
  try {
    // Go 的 defer r.mu.Unlock() 译为 finally。
    return this.putIssueLocked(v);
  } finally {
    this.mu.Unlock();
  }
};

IssuesRepo.prototype.ReserveIssueDispatch = function (task) {
  let stored = new Task();
  let created = false;
  const err = this.DB.Transaction((tx) => {
    const issue = new issueRow();
    const err = this.locking(tx).Select("id").Where("id = ?", task.IssueID).Take(issue).Error;
    if (err === gorm.ErrRecordNotFound) {
      return ErrIssueNotFound;
    }
    if (err != null) {
      return err;
    }
    try {
      [stored, created] = this.tasks.createTask(tx, task);
    } catch (e) {
      return e;
    }
    return null;
  });
  if (err != null) {
    throw err;
  }
  return [stored, created];
};

IssuesRepo.prototype.PutSyncedIssue = function (v) {
  this.mu.Lock();
  try {
    return this.saveIssueLocked(v, true, false);
  } finally {
    this.mu.Unlock();
  }
};

IssuesRepo.prototype.PatchIssue = function (id, fn) {
  id = id.trim();
  if (id === "") {
    throw new Error("issue id is required");
  }
  if (fn == null) {
    throw new Error("patch function is required");
  }
  this.mu.Lock();
  try {
    const [issue, ok] = this.Issue(id);
    if (!ok) {
      throw ErrIssueNotFound;
    }
    const fnErr = fn(issue);
    if (fnErr != null) {
      throw fnErr;
    }
    const saveErr = this.saveIssueLocked(issue, false, true);
    if (saveErr != null) {
      throw saveErr;
    }
    const [stored, storedOk] = this.Issue(id);
    if (storedOk) {
      return stored;
    }
    return issue;
  } finally {
    this.mu.Unlock();
  }
};

IssuesRepo.prototype.putIssueLocked = function (v) {
  return this.saveIssueLocked(v, false, false);
};

IssuesRepo.prototype.saveIssueLocked = function (v, fromSync, existingOnly) {
  const now = new Date();
  const [old, ok] = this.Issue(v.ID);
  if (existingOnly && !ok) {
    return ErrIssueNotFound;
  }
  const preserveStatus = fromSync && ok;
  if (ok) {
    if (preserveStatus) {
      v.Status = old.Status;
      v.CloseSource = old.CloseSource;
      v.AutomationState = old.AutomationState;
    }
    v.CreatedAt = old.CreatedAt;
    if (v.Number === 0) {
      v.Number = old.Number;
    }
    if (v.AutomationState.trim() === "") {
      v.AutomationState = old.AutomationState;
    }
    if (v.Operations.length === 0 && old.Operations.length > 0) {
      v.Operations = old.Operations;
    }
    if (v.ConversationSessionID.trim() === "") {
      v.ConversationSessionID = old.ConversationSessionID;
    }
    if (v.SOPMode.trim() === "") {
      v.SOPMode = old.SOPMode;
    }
    if (!isZeroTime(old.Clarification.StartedAt) && (isZeroTime(v.Clarification.StartedAt) || timeAfter(v.Clarification.StartedAt, old.Clarification.StartedAt))) {
      v.Clarification.StartedAt = old.Clarification.StartedAt;
    }
    preserveIssueDeliveryFields(v, old);
  } else {
    v.CreatedAt = now;
    if (v.Number === 0) {
      v.Number = 1;
      const maxNumber = { Valid: false, Int64: 0 }; // Go 的 sql.NullInt64；JS 用对象代替。
      const scanErr = this.DB.Raw("SELECT MAX(number) FROM issues WHERE project_id=?", v.ProjectID).Scan(maxNumber).Error;
      if (scanErr != null) {
        return scanErr;
      }
      if (maxNumber.Valid) {
        v.Number = maxNumber.Int64 + 1;
      }
    }
  }
  if (!preserveStatus) {
    if (v.TrackerClosed() && v.Status !== "closed") {
      v.Status = "closed";
      v.CloseSource = "external";
    }
    if (v.Status === "closed") {
      if (v.CloseSource === "") {
        if (ok && old.Status === "closed") {
          v.CloseSource = old.CloseSource;
          if (v.CloseSource === "") {
            v.CloseSource = "manual"; // CloseSource 字段出现之前的旧手动关闭
          }
        } else if (v.TrackerClosed()) {
          v.CloseSource = "external";
        } else {
          v.CloseSource = "manual";
        }
      }
    } else {
      v.CloseSource = "";
    }
    if (v.Status === "done" || v.Status === "closed" || v.Status === "cancelled" || v.GongfengClosed()) {
      v.AutomationState = "ignored";
    }
  }
  if (v.AssigneeUserID === 0) {
    const [project, found] = this.projects.Project(v.ProjectID);
    if (found) {
      v.AssigneeUserID = project.OwnerID;
    }
  }
  // 完成时间是生命周期事件，不可由客户端编辑；未知则保持未知，重开则清空。
  v.CompletedAt = null;
  if (ok && v.Completed()) {
    if (old.Completed()) {
      v.CompletedAt = old.CompletedAt;
    } else {
      v.CompletedAt = now;
    }
  }
  if (v.WithoutSOP()) {
    v.SOPMode = IssueSOPNone;
    v.WorkflowID = "";
    v.PlaybookID = "";
    v.SOPBindings = null;
    v.AutomationState = "ignored";
  } else {
    v.SOPMode = "";
    bindDefaultWorkflow(v, this.projectWorkflowID(v.ProjectID), this.projectIssueWorkflowID(v.ProjectID));
  }
  v.UpdatedAt = now;
  if (existingOnly) {
    const result = this.DB.Model(new issueRow()).Where("id = ?", v.ID).Updates(issueValues(v));
    if (result.Error == null && result.RowsAffected === 0) {
      return ErrIssueNotFound;
    }
    return result.Error;
  }
  return this.writeIssue(v);
};

IssuesRepo.prototype.writeIssue = function (v) {
  return upsert(this.DB, "issues", issueValues(v));
};

function issueValues(v) {
  let ext = "";
  if (v.ExternalRef != null) {
    ext = v.ExternalRef.ExternalID;
  }
  let assignee = null;
  if (v.AssigneeUserID > 0) {
    assignee = v.AssigneeUserID;
  }
  return {
    id: v.ID, project_id: v.ProjectID, number: v.Number, title: v.Title,
    status: v.Status, kind: v.Kind, source: v.Source, workflow_id: v.WorkflowID,
    assignee_user_id: assignee, external_id: ext, payload: mustJSON(v),
    created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  };
}

IssuesRepo.prototype.ResponsibleUser = function (issue) {
  let userID = issue.AssigneeUserID;
  if (userID === 0) {
    const [project, ok] = this.projects.Project(issue.ProjectID);
    if (!ok || project.OwnerID === 0) {
      throw new Error("项目未配置 Owner，需求也未配置责任人");
    }
    userID = project.OwnerID;
  }
  const [user, ok] = this.users.User(userID);
  if (!ok) {
    throw new Error("需求责任人或项目 Owner 未关联有效用户");
  }
  return user;
};

IssuesRepo.prototype.projectWorkflowID = function (projectID) {
  if (projectID.trim() === "") {
    return "";
  }
  const [p, ok] = payloadOne(Project, this.DB, "projects", projectID);
  if (ok) {
    return p.WorkflowID.trim();
  }
  return "";
};

IssuesRepo.prototype.projectIssueWorkflowID = function (projectID) {
  const id = ProjectIssueWorkflowID(projectID);
  if (id === "") {
    return "";
  }
  const [, ok] = payloadOne(WorkflowDefinition, this.DB, "workflows", id);
  if (ok) {
    return id;
  }
  return "";
};

IssuesRepo.prototype.IssueHasTask = function (issueID) {
  return this.IssueHasTaskForWorkflow(issueID, "");
};

IssuesRepo.prototype.IssueHasTaskForWorkflow = function (issueID, workflowID) {
  issueID = issueID.trim();
  if (issueID === "") {
    return false;
  }
  workflowID = workflowID.trim();
  for (const task of this.tasks.Tasks()) {
    if (task.IssueID !== issueID) {
      continue;
    }
    const taskWF = task.WorkflowID.trim();
    // 旧 Task 可能没有 workflowId，按「这条需求已经跑过」处理，避免定时任务重复派发。
    if (workflowID === "" || taskWF === "" || taskWF === workflowID) {
      return true;
    }
  }
  if (workflowID !== "") {
    return false;
  }
  const [issue, ok] = this.Issue(issueID);
  if (ok && issue.LatestTaskID.trim() !== "") {
    return true;
  }
  return false;
};

IssuesRepo.prototype.Comments = function (issueID) {
  const out = payloadList(IssueComment, this.DB, "issue_comments", "issue_id = ?", issueID);
  out.sort((a, b) => timeMs(a.CreatedAt) - timeMs(b.CreatedAt));
  return out;
};

IssuesRepo.prototype.PutComment = function (v) {
  v.CreatedAt = new Date();
  return upsert(this.DB, "issue_comments", {
    id: v.ID, issue_id: v.IssueID, payload: mustJSON(v), created_at: timePtr(v.CreatedAt),
  });
};

module.exports = { preserveIssueDeliveryFields, issueValues, isZeroTime, timeMs, timeBefore, timeAfter };
