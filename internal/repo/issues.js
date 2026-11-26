/**
 * @file internal/repo/issues.js
 * 对应 Go 源文件：internal/repo/issues.go
 *
 * 作用与职责边界：
 * 实现需求与需求评论领域仓储（`IssuesRepo`）的核心持久化读写逻辑，包括：
 * 运营分析轻量需求视图查询、需求列表与单条读取、需求新建/更新/同步刷新/原子补丁写入、
 * 任务派发预留（持行锁创建任务）、需求责任人解析、工作流任务存在性检查以及需求评论读写。
 * 不负责需求手动关闭准入（见 `issues_close.js`）与需求删除清理（见 `issues_delete.js`）。
 *
 * 语法差异说明：
 * - `IssuesRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `IssuesRepo.prototype` 挂载各需求方法。
 * - Go 中 `IssuesRepo.mu`（`sync.Mutex`）在单线程 JS 中不需要，按规则直接略去。
 * - Go 的 `(值, error)`、`(值1, 值2, error)` 与仅 `error` 返回统一按成功返回值（或数组/`undefined`）、失败 `throw err` 处理；`db.Transaction` 回调及 `PatchIssue` 回调 `fn` 同样遵循失败抛错、成功正常返回约定。
 * - Go 的 `(值, bool)` 返回译为 `[值, boolean]` 元组；`time.Time` 零值译为 `null`，时间比较复用 `analytics.js` 的 `isZeroTime`/`timeMs`/`timeAfter`。
 * - `gorm` 链式调用按原样保留；`errors.Is` 译为 `===`；`sql.NullInt64` 用 `{ Valid, Int64 }` 对象表示。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { Issue, ExternalRef, IssueSOPNone, IssueComment } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue/ExternalRef/IssueSOPNone/IssueComment，issue.js 已翻译
const { SameGongfengMR } = require("../domain/mr.js"); // 对应 Go 的 domain.SameGongfengMR，mr.js 已翻译
const { Task } = require("../domain/task.js"); // 对应 Go 的 domain.Task，task.js 已翻译
const { Project } = require("../domain/project.js"); // 对应 Go 的 domain.Project，project.js 已翻译
const { WorkflowDefinition } = require("../domain/workflow.js"); // 对应 Go 的 domain.WorkflowDefinition，workflow.js 已翻译
const { issueRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { jsonUnmarshal, mustJSON, timePtr, upsert, payloadOne, payloadList } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { IssuesRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { isZeroTime, timeMs, timeAfter } = require("./analytics.js"); // 对应 Go 的时间零值与先后比较，analytics.js 已翻译
const { bindDefaultWorkflow, ProjectIssueWorkflowID } = require("./catalog.js"); // 对应 Go 同包函数，catalog.js 已翻译
const { ErrIssueNotFound } = require("./issues_delete.js"); // 对应 Go 同包变量，issues_delete.js 已翻译

// ---------- Issues ----------

/**
 * 加载运营分析所需的轻量需求视图，仅查询必要列及 JSON 提取字段，避免加载完整的澄清、评论与交付锁大载荷。
 * 用于运营分析统计聚合；查询失败返回空数组 `[]`，无数据时返回 `null`。
 *
 * @returns {Issue[] | null} 轻量需求视图数组；查询失败返回 `[]`，空结果返回 `null`。
 */
IssuesRepo.prototype.IssueAnalyticsViews = function () {
  /**
   * 运营分析轻量查询投影行结构，仅承载分析所需列及 JSON 文本提取列。
   */
  class liteRow {
    /**
     * 构造轻量投影行实例，缺省字段按 Go 零值初始化。
     *
     * @param {Object} [init={}] - 可选初始字段映射。
     * @returns {void} 无返回值。
     */
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
    // Go 的 time.Parse(time.RFC3339Nano, ...) 失败返回错误；JS 用无效 Date 判断，失败时跳过。
    const rawStarted = row.ClarificationStartedAt.trim();
    if (rawStarted !== "") {
      const started = new Date(rawStarted);
      if (!Number.isNaN(started.getTime())) {
        issue.Clarification.StartedAt = started;
      }
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

/**
 * 读取全部需求列表，并按项目 ID 升序、同项目内需求编号降序排列。
 * 反序列化失败的行会被跳过；为保持既有序列化契约，空结果返回 `null`。
 *
 * @returns {Issue[] | null} 排序后的需求数组；查询失败返回 `[]`，空结果返回 `null`。
 */
IssuesRepo.prototype.Issues = function () {
  const rows = [];
  if (this.DB.Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const issue = new Issue();
    try {
      jsonUnmarshal(row.Payload, issue);
    } catch {
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
    // 保持空结果序列化为 null 而非 [] 的既有接口行为。
    return null;
  }
  return out;
};

/**
 * 按主键 ID 读取单条需求并回填独立的 `AssigneeUserID` 列值。
 * 用于需求详情展示、更新前读取旧快照以及工作流派发上下文加载。
 *
 * @param {string} id - 需求唯一标识。
 * @returns {[Issue, boolean]} 返回 `[需求实例, 是否找到]`；未找到或解码失败时返回 `[空需求实例, false]`。
 */
IssuesRepo.prototype.Issue = function (id) {
  const row = new issueRow();
  if (this.DB.Where("id = ?", id).Take(row).Error != null) {
    return [new Issue(), false];
  }
  const issue = new Issue();
  try {
    jsonUnmarshal(row.Payload, issue);
  } catch {
    return [new Issue(), false];
  }
  if (row.AssigneeUserID != null) {
    issue.AssigneeUserID = row.AssigneeUserID;
  } else {
    issue.AssigneeUserID = 0;
  }
  return [issue, true];
};

/**
 * 在外部同步（工蜂/TAPD）写入省略交付字段的需求快照时，保留旧记录中已存在的交付锁与 MR 元数据，防止与 MR 对账产生竞态覆盖。
 *
 * @param {Issue} v - 即将写入的新需求对象（原地补全缺失的交付字段）。
 * @param {Issue} old - 数据库中已保存的旧需求对象。
 * @returns {void} 无返回值。
 */
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

/**
 * 新增或更新单条需求（常规写路径）。
 * Go 原文通过 `r.mu` 串行化写入；JS 单线程环境下直接调用内部写逻辑。
 *
 * @param {Issue} v - 待保存的需求对象。
 * @returns {void} 无返回值。
 * @throws {Error} 编号查询失败或数据库写入失败时抛出错误。
 */
IssuesRepo.prototype.PutIssue = function (v) {
  this.putIssueLocked(v);
};

/**
 * 在数据库事务中对需求行加锁并预留派发任务记录，确保任务派发与需求最终删除互斥，不会同时成功。
 * 用于向引擎派发需求执行任务前的跨实例幂等占位。
 *
 * @param {Task} task - 待创建的任务记录对象（必须包含 `IssueID`）。
 * @returns {[Task, boolean]} 返回 `[已落库的任务记录, 是否为本次新建]`。
 * @throws {Error} 需求不存在（`ErrIssueNotFound`）、行锁查询失败或任务创建失败时抛出错误。
 */
IssuesRepo.prototype.ReserveIssueDispatch = function (task) {
  let stored = new Task();
  let created = false;
  this.DB.Transaction((tx) => {
    const issue = new issueRow();
    const err = this.locking(tx).Select("id").Where("id = ?", task.IssueID).Take(issue).Error;
    if (err === gorm.ErrRecordNotFound) {
      throw ErrIssueNotFound;
    }
    if (err != null) {
      throw err;
    }
    [stored, created] = this.tasks.createTask(tx, task);
  });
  return [stored, created];
};

/**
 * 写入从外部跟踪器同步拉取的需求快照，保留已有需求的本地生命周期状态（状态、关闭来源与自动化状态）。
 * Go 原文通过 `r.mu` 串行化以防覆盖并发本地编辑；JS 单线程下直接执行同步保存路径。
 *
 * @param {Issue} v - 外部跟踪器同步得到的需求对象。
 * @returns {void} 无返回值。
 * @throws {Error} 编号查询失败或数据库写入失败时抛出错误。
 */
IssuesRepo.prototype.PutSyncedIssue = function (v) {
  this.saveIssueLocked(v, true, false);
};

/**
 * 读取指定需求的最新快照，执行补丁回调函数 `fn` 后写回，并返回最新落库的需求对象。
 * 仅允许更新已存在的需求；常用于澄清任务更新、手动关闭需求等局部变更场景。
 *
 * @param {string} id - 目标需求 ID。
 * @param {function(Issue): void} fn - 原地修改需求对象的补丁回调；失败时应抛出 `Error`。
 * @returns {Issue} 写入后重新读取（或回退返回内存副本）的最新需求对象。
 * @throws {Error} ID 为空、回调函数缺失、需求不存在（`ErrIssueNotFound`）、回调抛错或更新失败时抛出错误。
 */
IssuesRepo.prototype.PatchIssue = function (id, fn) {
  id = id.trim();
  if (id === "") {
    throw new Error("issue id is required");
  }
  if (fn == null) {
    throw new Error("patch function is required");
  }
  const [issue, ok] = this.Issue(id);
  if (!ok) {
    throw ErrIssueNotFound;
  }
  fn(issue);
  this.saveIssueLocked(issue, false, true);
  const [stored, storedOk] = this.Issue(id);
  if (storedOk) {
    return stored;
  }
  return issue;
};

/**
 * 内部非同步、允许新建的加锁写入口，由 `PutIssue` 调用。
 *
 * @param {Issue} v - 待保存的需求对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库读写失败时抛出错误。
 */
IssuesRepo.prototype.putIssueLocked = function (v) {
  this.saveIssueLocked(v, false, false);
};

/**
 * 执行需求的完整持久化前处理与落库逻辑：合并旧记录字段、分配项目内自增编号、维护关闭来源与自动化状态、
 * 回填默认责任人、维护完成时间戳、绑定或清空默认 SOP，最后按模式执行更新或 Upsert。
 *
 * @param {Issue} v - 待保存的需求对象。
 * @param {boolean} fromSync - 是否来自外部跟踪器同步；为 `true` 且记录已存在时保留本地生命周期状态。
 * @param {boolean} existingOnly - 是否仅允许更新已存在行；为 `true` 且记录不存在时抛出 `ErrIssueNotFound`。
 * @returns {void} 无返回值。
 * @throws {Error} 记录不存在（`ErrIssueNotFound`）、最大编号查询失败或数据库写入失败时抛出错误。
 */
IssuesRepo.prototype.saveIssueLocked = function (v, fromSync, existingOnly) {
  const now = new Date();
  const [old, ok] = this.Issue(v.ID);
  if (existingOnly && !ok) {
    throw ErrIssueNotFound;
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
      // Go 的 sql.NullInt64 用带 Valid 与 Int64 字段的对象表示。
      const maxNumber = { Valid: false, Int64: 0 };
      const scanErr = this.DB.Raw("SELECT MAX(number) FROM issues WHERE project_id=?", v.ProjectID).Scan(maxNumber).Error;
      if (scanErr != null) {
        throw scanErr;
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
            v.CloseSource = "manual"; // CloseSource 字段引入之前的旧手动关闭记录
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
  // 完成时间是生命周期事件，不可由客户端直接编辑；历史未知时间保持未知，重开时清空。
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
      throw ErrIssueNotFound;
    }
    if (result.Error != null) {
      throw result.Error;
    }
    return;
  }
  this.writeIssue(v);
};

/**
 * 将需求对象以 Upsert 方式写入物理表 `issues`。
 *
 * @param {Issue} v - 已完成前处理的需求对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
IssuesRepo.prototype.writeIssue = function (v) {
  upsert(this.DB, "issues", issueValues(v));
};

/**
 * 将领域需求对象展开为物理表 `issues` 所需的列值映射（含索引列与完整 JSON 载荷列）。
 *
 * @param {Issue} v - 需求领域对象。
 * @returns {Object<string, any>} 对应 `issues` 表各物理列的键值对对象。
 */
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

/**
 * 解析需求的责任用户：优先取需求显式指定的责任人，未指定时回退到所属项目配置的 Owner。
 * 用于需要以责任人身份执行凭据查询或通知派发的场景。
 *
 * @param {Issue} issue - 目标需求对象。
 * @returns {import("../domain/user.js").User} 解析得到的有效用户对象。
 * @throws {Error} 项目未配置 Owner 且需求未指定责任人，或关联用户不存在时抛出错误。
 */
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

/**
 * 读取指定项目配置的默认 SOP 工作流 ID。
 * 供 `saveIssueLocked` 绑定默认工作流时使用。
 *
 * @param {string} projectID - 项目 ID。
 * @returns {string} 去除空白后的默认工作流 ID；项目 ID 为空或项目不存在时返回 `""`。
 */
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

/**
 * 检查项目约定式缺陷修复 SOP（`<projectID>-issue-fix`）是否存在于 `workflows` 表中，存在则返回其 ID。
 * 供 `saveIssueLocked` 为缺陷类需求绑定默认工作流时使用。
 *
 * @param {string} projectID - 项目 ID。
 * @returns {string} 存在的项目缺陷工作流 ID；不存在或项目 ID 为空时返回 `""`。
 */
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

/**
 * 判断指定需求是否已经存在关联的任意任务记录（不限工作流）。
 *
 * @param {string} issueID - 需求 ID。
 * @returns {boolean} 存在关联任务或需求记录了 `LatestTaskID` 时返回 `true`，否则返回 `false`。
 */
IssuesRepo.prototype.IssueHasTask = function (issueID) {
  return this.IssueHasTaskForWorkflow(issueID, "");
};

/**
 * 判断指定需求在目标工作流维度上是否已有任务记录，防止定时同步或自动派发重复建单。
 * 若旧任务记录缺少 `WorkflowID`，按该需求已跑过处理；当 `workflowID` 为空时还会回退检查需求的 `LatestTaskID`。
 *
 * @param {string} issueID - 需求 ID。
 * @param {string} workflowID - 目标工作流 ID；为空字符串时表示不限定工作流。
 * @returns {boolean} 匹配到已有任务记录时返回 `true`，否则返回 `false`。
 */
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

// ---------- Issue comments ----------

/**
 * 查询指定需求下的全部评论，并按创建时间升序排列。
 *
 * @param {string} issueID - 目标需求 ID。
 * @returns {IssueComment[]} 按 `CreatedAt` 升序排列的评论数组。
 */
IssuesRepo.prototype.Comments = function (issueID) {
  const out = payloadList(IssueComment, this.DB, "issue_comments", "issue_id = ?", issueID);
  out.sort((a, b) => timeMs(a.CreatedAt) - timeMs(b.CreatedAt));
  return out;
};

/**
 * 持久化保存一条需求评论，并自动将评论创建时间设为当前 UTC 时间。
 *
 * @param {IssueComment} v - 待写入的需求评论对象。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
IssuesRepo.prototype.PutComment = function (v) {
  v.CreatedAt = new Date();
  upsert(this.DB, "issue_comments", {
    id: v.ID, issue_id: v.IssueID, payload: mustJSON(v), created_at: timePtr(v.CreatedAt),
  });
};

module.exports = { preserveIssueDeliveryFields, issueValues };
