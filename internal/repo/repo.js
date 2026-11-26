// repo.js —— 对应 Go 文件：internal/repo/repo.go
// 作用：gorm 持久层的共享依赖、领域 Repo 类型组合与 Store 连接生命周期。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const mysql = require("gorm.io/driver/mysql"); // Go 第三方包 gorm.io/driver/mysql
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause
const logger = require("gorm.io/gorm/logger"); // Go 第三方包 gorm.io/gorm/logger

const { Issue, ExternalRef } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue/ExternalRef，issue.js 已翻译
const { Run, NodeRun } = require("../domain/run.js"); // 对应 Go 的 domain.Run/NodeRun，run.js 已翻译
const { autoMigrateIncremental } = require("./automigrate.js"); // 对应 Go 同包函数，automigrate.js 已翻译

const ErrRunDecisionStale = new Error("run changed before the decision was committed");
const ErrRunLeaseHeld = new Error("run lease is held by another instance");
const ErrRunLeaseLost = new Error("run lease ownership or generation changed");
const ErrRunWorkspaceBound = new Error("run workspace is already bound to another host path");

// deps 是所有领域 Repo 共享的依赖（repo 层的共享依赖只有 gorm 句柄）。
class deps {
  constructor(init = {}) {
    this.DB = init.DB ?? null;
  }

  isMySQL() {
    return this.DB != null && this.DB.Dialector.Name() === "mysql";
  }

  sqlJSONText(path) {
    if (this.isMySQL()) {
      return "JSON_UNQUOTE(JSON_EXTRACT(payload, ?))";
    }
    return "json_extract(payload, ?)";
  }

  sqlPayloadJSONText(path) {
    if (this.isMySQL()) {
      return "JSON_UNQUOTE(JSON_EXTRACT(payload, '$." + path + "'))";
    }
    return "json_extract(payload, '$." + path + "')";
  }

  sqlExecutionContextJSONText(path) {
    if (this.isMySQL()) {
      return "JSON_UNQUOTE(JSON_EXTRACT(execution_context, '$." + path + "'))";
    }
    return "json_extract(execution_context, '$." + path + "')";
  }

  locking(q) {
    if (this.isMySQL()) {
      return q.Clauses(new clause.Locking({ Strength: "UPDATE" }));
    }
    return q;
  }
}

// CatalogRepo owns the reusable definitions: agents, rules, skills, MCP
// servers, executors, sandboxes (with their Dockerfile or install), workflows,
// repositories, sync config, schedule jobs and definition revisions.
class CatalogRepo extends deps {
  constructor(init = {}) {
    super(init);
    this.projects = init.projects ?? null;
    this.notifications = init.notifications ?? null;
    this.BotInteractionsRepo = init.BotInteractionsRepo ?? null;
  }
}

// ProjectsRepo owns projects and their members.
class BusinessDomainsRepo extends deps {
  constructor(init = {}) {
    super(init);
  }
}

class ProjectsRepo extends deps {
  constructor(init = {}) {
    super(init);
  }
}

// IssuesRepo owns issues and issue comments.
class IssuesRepo extends deps {
  constructor(init = {}) {
    super(init);
    // Go 的 sync.Mutex 无 JS 对应写法，单线程下不需要。
    this.projects = init.projects ?? null;
    this.users = init.users ?? null;
    this.tasks = init.tasks ?? null;
  }
}

// TasksRepo owns tasks (the cross-instance idempotency records).
class TasksRepo extends deps {
  constructor(init = {}) {
    super(init);
  }
}

// UsersRepo owns users and their saved credentials.
class UsersRepo extends deps {
  constructor(init = {}) {
    super(init);
  }
}

// TokensRepo owns API tokens.
class TokensRepo extends deps {
  constructor(init = {}) {
    super(init);
  }
}

// AssistantRepo owns Studio AI assistant conversations and scheduled prompts.
class AssistantRepo extends deps {
  constructor(init = {}) {
    super(init);
    this.users = init.users ?? null;
    this.notifications = init.notifications ?? null;
    this.BotInteractionsRepo = init.BotInteractionsRepo ?? null;
  }
}

// RunsRepo owns runs, their children (nodes/events/telemetry/logs/artifacts),
// run leases and workflow metrics.
class RunsRepo extends deps {
  constructor(init = {}) {
    super(init);
    this.assistant = init.assistant ?? null;
    this.issues = init.issues ?? null;
    this.catalog = init.catalog ?? null;
    this.notifications = init.notifications ?? null;
    this.BotInteractionsRepo = init.BotInteractionsRepo ?? null;
  }
}

// RunnersRepo owns the CLI runner registry, runner tasks and runner events.
class RunnersRepo extends deps {
  constructor(init = {}) {
    super(init);
  }
}

// DeliveryRepo owns MR delivery state and the delivery locking that follows.
class DeliveryRepo extends deps {
  constructor(init = {}) {
    super(init);
    this.issues = init.issues ?? null;
    this.tasks = init.tasks ?? null;
    this.catalog = init.catalog ?? null;
    this.runs = init.runs ?? null;
  }
}

// AnalyticsRepo owns the read-only operational analytics view.
class AnalyticsRepo extends deps {
  constructor(init = {}) {
    super(init);
    this.runs = init.runs ?? null;
    this.catalog = init.catalog ?? null;
    this.delivery = init.delivery ?? null;
    this.issues = init.issues ?? null;
    this.tasks = init.tasks ?? null;
    this.projects = init.projects ?? null;
    this.insights = init.insights ?? null;
  }
}

// RoomsRepo stores project group chats and their messages.
class RoomsRepo extends deps {
  constructor(init = {}) {
    super(init);
  }
}

// SpacesRepo、KnowledgeRepo、SSHHostTrustRepo、PreviewsRepo、NotificationsRepo
// 的方法在各自文件里以 prototype 挂载，这里只定义类型。
class SpacesRepo extends deps {
  constructor(init = {}) {
    super(init);
  }
}

class KnowledgeRepo extends deps {
  constructor(init = {}) {
    super(init);
  }
}

class SSHHostTrustRepo extends deps {
  constructor(init = {}) {
    super(init);
  }
}

class PreviewsRepo extends deps {
  constructor(init = {}) {
    super(init);
  }
}

class NotificationsRepo extends deps {
  constructor(init = {}) {
    super(init);
  }
}

// Store 组合各领域 Repo。领域 Repo 以匿名指针嵌入（未导出类型）：包外仅能
// 通过提升的方法调用，与现有调用形态完全兼容（方法提升对未导出类型同样生效）。
class Store extends deps {
  constructor(init = {}) {
    super(init);
    this.CatalogRepo = init.CatalogRepo ?? null;
    this.ProjectsRepo = init.ProjectsRepo ?? null;
    this.BusinessDomainsRepo = init.BusinessDomainsRepo ?? null;
    this.IssuesRepo = init.IssuesRepo ?? null;
    this.TasksRepo = init.TasksRepo ?? null;
    this.UsersRepo = init.UsersRepo ?? null;
    this.TokensRepo = init.TokensRepo ?? null;
    this.AssistantRepo = init.AssistantRepo ?? null;
    this.RunsRepo = init.RunsRepo ?? null;
    this.RunnersRepo = init.RunnersRepo ?? null;
    this.DeliveryRepo = init.DeliveryRepo ?? null;
    this.AnalyticsRepo = init.AnalyticsRepo ?? null;
    this.InsightsRepo = init.InsightsRepo ?? null;
    this.PreviewsRepo = init.PreviewsRepo ?? null;
    this.EngineInstancesRepo = init.EngineInstancesRepo ?? null;
    this.RoomsRepo = init.RoomsRepo ?? null;
    this.SpacesRepo = init.SpacesRepo ?? null;
    this.KnowledgeRepo = init.KnowledgeRepo ?? null;
    this.SSHHostTrustRepo = init.SSHHostTrustRepo ?? null;
    this.HTTPSHostTrustRepo = init.HTTPSHostTrustRepo ?? null;
    this.NotificationsRepo = init.NotificationsRepo ?? null;
    this.BotInteractionsRepo = init.BotInteractionsRepo ?? null;
  }

  // Close releases the underlying connection pool. The gorm handle is kept so
  // in-flight background goroutines fail gracefully ("sql: database is closed")
  // instead of panicking on a nil handle.
  Close() {
    if (this.DB == null) {
      return;
    }
    try {
      const sqlDB = this.DB.DB();
      sqlDB.Close();
    } catch {
      // Go 的 err == nil 分支：取不到连接池时直接返回。
    }
  }

  StorageInfo() {
    return {
      driver: this.DB.Dialector.Name(),
      database: true,
      note: "所有状态都在 MySQL：项目、Issue、SOP、运行记录、助手对话和定时任务都直接读写数据库。",
    };
  }
}

// newStore wires the shared deps and every cross-domain pointer. Domains have
// no cycles, so a single construction pass is enough.
function newStore(db) {
  const s = new Store({ DB: db });
  s.ProjectsRepo = new ProjectsRepo({ DB: db });
  s.BusinessDomainsRepo = new BusinessDomainsRepo({ DB: db });
  s.UsersRepo = new UsersRepo({ DB: db });
  // InsightsRepo、EngineInstancesRepo、HTTPSHostTrustRepo、BotInteractionsRepo
  // 在各自文件里定义，调用时现取，避免顶层循环引用。
  s.BotInteractionsRepo = new (require("./bot_interactions.js").BotInteractionsRepo)({ DB: db });
  s.TokensRepo = new TokensRepo({ DB: db });
  s.AssistantRepo = new AssistantRepo({ DB: db, users: s.UsersRepo });
  s.TasksRepo = new TasksRepo({ DB: db });
  s.NotificationsRepo = new NotificationsRepo({ DB: db });
  s.AssistantRepo.notifications = s.NotificationsRepo;
  s.CatalogRepo = new CatalogRepo({ DB: db, projects: s.ProjectsRepo, notifications: s.NotificationsRepo });
  s.IssuesRepo = new IssuesRepo({ DB: db, projects: s.ProjectsRepo, users: s.UsersRepo, tasks: s.TasksRepo });
  s.NotificationsRepo.issues = s.IssuesRepo;
  s.RunsRepo = new RunsRepo({ DB: db, assistant: s.AssistantRepo, issues: s.IssuesRepo, catalog: s.CatalogRepo, notifications: s.NotificationsRepo });
  s.RunnersRepo = new RunnersRepo({ DB: db });
  s.DeliveryRepo = new DeliveryRepo({ DB: db, issues: s.IssuesRepo, tasks: s.TasksRepo, catalog: s.CatalogRepo, runs: s.RunsRepo });
  s.InsightsRepo = new (require("./insights.js").InsightsRepo)({ DB: db });
  s.AnalyticsRepo = new AnalyticsRepo({ DB: db, runs: s.RunsRepo, catalog: s.CatalogRepo, delivery: s.DeliveryRepo, issues: s.IssuesRepo, tasks: s.TasksRepo, projects: s.ProjectsRepo, insights: s.InsightsRepo });
  s.PreviewsRepo = new PreviewsRepo({ DB: db });
  s.EngineInstancesRepo = new (require("./engine_instances.js").EngineInstancesRepo)({ DB: db });
  s.RoomsRepo = new RoomsRepo({ DB: db });
  s.SpacesRepo = new SpacesRepo({ DB: db });
  s.KnowledgeRepo = new KnowledgeRepo({ DB: db });
  s.SSHHostTrustRepo = new SSHHostTrustRepo({ DB: db });
  s.HTTPSHostTrustRepo = new (require("./git_https_hosts.js").HTTPSHostTrustRepo)({ DB: db });
  return s;
}

// Open connects the store to MySQL, which is where all state lives. An empty
// DSN is a configuration error, not a reason to invent state somewhere else.
function Open(dsn) {
  dsn = dsn.trim();
  if (dsn === "") {
    dsn = (process.env.AGENTFLOW_MYSQL_DSN ?? "").trim();
  }
  if (dsn === "") {
    throw new Error("AGENTFLOW_MYSQL_DSN 未配置：MySQL 是唯一数据源，缺少 DSN 时拒绝启动");
  }
  if (!dsn.includes("charset=")) {
    if (dsn.includes("?")) {
      dsn += "&charset=utf8mb4&collation=utf8mb4_unicode_ci";
    } else {
      dsn += "?charset=utf8mb4&collation=utf8mb4_unicode_ci";
    }
  }
  if (!dsn.includes("parseTime=")) {
    dsn += "&parseTime=true&loc=UTC";
  }
  let db;
  try {
    db = gorm.Open(mysql.Open(dsn), new gorm.Config({ TranslateError: true, Logger: logger.Default.LogMode(logger.Silent) }));
  } catch (err) {
    throw new Error(`mysql open: ${err}`);
  }
  let sqlDB = null;
  try {
    sqlDB = db.DB();
  } catch {
    sqlDB = null;
  }
  if (sqlDB != null) {
    sqlDB.SetMaxOpenConns(32);
    sqlDB.SetMaxIdleConns(8);
    sqlDB.SetConnMaxLifetime(30 * 60 * 1000);
    try {
      sqlDB.Ping();
    } catch (err) {
      throw new Error(`mysql ping: ${err}`);
    }
  }
  const s = newStore(db);
  // Incremental DDL only (missing columns/tables/indexes) via gorm's
  // migrator. Schema baselines, data migrations and seed data are NOT run
  // from code: they are plain SQL scripts under migrations/, applied
  // manually by the operator.
  const migrateErr = autoMigrateIncremental(s.DB);
  if (migrateErr != null) {
    s.Close();
    throw new Error(`auto migrate: ${migrateErr}`);
  }
  return s;
}

function IssueBoundToTracker(issue) {
  if (issue.Source !== "gongfeng" && issue.Source !== "tapd") {
    return false;
  }
  if (issue.ExternalRef == null) {
    return false;
  }
  return issue.ExternalRef.ExternalID.trim() !== "" || issue.ExternalRef.ExternalIID !== 0;
}

// RestoreTrackerBinding fills Source/ExternalRef from a still-bound snapshot, or
// from a stable local id (tapd-… / gf-…) after a save wiped the pointer.
function RestoreTrackerBinding(issue, existing) {
  if (issue == null || IssueBoundToTracker(issue)) {
    return;
  }
  if (IssueBoundToTracker(existing)) {
    issue.Source = existing.Source;
    issue.ExternalRef = existing.ExternalRef;
    if (issue.ID.trim() === "") {
      issue.ID = existing.ID;
    }
    return;
  }
  let id = issue.ID.trim();
  if (id === "") {
    id = existing.ID.trim();
    issue.ID = id;
  }
  // Go 的 strings.CutPrefix 返回剥离后的串与是否匹配。
  if (id.startsWith("tapd-")) {
    const extID = id.slice("tapd-".length);
    if (extID.trim() !== "") {
      issue.Source = "tapd";
      const ref = new ExternalRef({ Source: "tapd", ExternalID: extID, ExternalType: "story" });
      if (existing.ExternalRef != null) {
        ref.ExternalURL = existing.ExternalRef.ExternalURL;
        ref.ExternalState = existing.ExternalRef.ExternalState;
      }
      issue.ExternalRef = ref;
      return;
    }
  }
  const [, iid] = parseStoredGongfengIssueID(id);
  if (iid > 0) {
    issue.Source = "gongfeng";
    if (existing.ExternalRef != null) {
      issue.ExternalRef = existing.ExternalRef;
      return;
    }
    issue.ExternalRef = new ExternalRef({ Source: "gongfeng", ExternalIID: iid, ExternalType: "issue" });
  }
}

function parseStoredGongfengIssueID(id) {
  const body = id.trim().replace(/^gf-/, "");
  // Go 的 TrimPrefix 只在前缀存在时剥离；无前缀时返回空串与 0。
  if (body === "" || body === id.trim()) {
    return ["", 0];
  }
  const i = body.lastIndexOf("-");
  if (i <= 0) {
    return ["", 0];
  }
  let n = 0;
  for (const ch of body.slice(i + 1)) {
    if (ch < "0" || ch > "9") {
      return ["", 0];
    }
    n = n * 10 + (ch.charCodeAt(0) - "0".charCodeAt(0));
  }
  if (n <= 0) {
    return ["", 0];
  }
  return [body.slice(0, i), n];
}

function cloneRunNodes(nodes) {
  if (nodes == null || Object.keys(nodes).length === 0) {
    return null;
  }
  const out = {};
  for (const [id, node] of Object.entries(nodes)) {
    if (node == null) {
      continue;
    }
    const cp = { ...node };
    out[id] = cp;
  }
  return out;
}

function cloneRun(run) {
  run.Nodes = cloneRunNodes(run.Nodes);
  run.Events = run.Events == null ? null : [...run.Events];
  run.Telemetry = run.Telemetry == null ? null : [...run.Telemetry];
  run.Logs = run.Logs == null ? null : [...run.Logs];
  run.Artifacts = run.Artifacts == null ? null : [...run.Artifacts];
  return run;
}

function normalizeRefs(values, prefix) {
  const out = [];
  for (let v of values) {
    // Go 的 TrimPrefix/TrimSuffix 只剥离一次匹配的前后缀。
    if (v.startsWith(prefix)) {
      v = v.slice(prefix.length);
    }
    if (v.endsWith(".md")) {
      v = v.slice(0, -".md".length);
    }
    out.push(v);
  }
  return out;
}

function sortSlice(values, less) {
  values.sort((a, b) => {
    if (less(a, b)) {
      return -1;
    }
    if (less(b, a)) {
      return 1;
    }
    return 0;
  });
}

function mustJSON(v) {
  try {
    const raw = JSON.stringify(v);
    if (raw == null || raw.length === 0) {
      return "{}";
    }
    return raw;
  } catch {
    return "{}";
  }
}

module.exports = { deps, ErrRunDecisionStale, ErrRunLeaseHeld, ErrRunLeaseLost, ErrRunWorkspaceBound, CatalogRepo, BusinessDomainsRepo, ProjectsRepo, IssuesRepo, TasksRepo, UsersRepo, TokensRepo, AssistantRepo, RunsRepo, RunnersRepo, DeliveryRepo, AnalyticsRepo, RoomsRepo, SpacesRepo, KnowledgeRepo, SSHHostTrustRepo, PreviewsRepo, NotificationsRepo, Store, newStore, Open, IssueBoundToTracker, RestoreTrackerBinding, parseStoredGongfengIssueID, cloneRunNodes, cloneRun, normalizeRefs, sortSlice, mustJSON };
