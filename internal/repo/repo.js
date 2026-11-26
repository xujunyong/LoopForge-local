/**
 * @file internal/repo/repo.js
 * 对应 Go 源文件：internal/repo/repo.go
 *
 * 作用与职责边界：
 * 定义 AgentFlow GORM 持久层的共享错误常量、共享数据库依赖基类 `deps`、各领域 Repo 类型骨架、
 * 聚合全部领域 Repo 的根对象 `Store`、统一装配入口 `newStore`、MySQL 连接与增量迁移入口 `Open`、
 * 连接关闭与存储摘要方法，以及跨领域通用的工单追踪器绑定恢复、运行对象浅拷贝、引用规范化、排序和 JSON 序列化工具函数。
 * 领域业务查询与写入方法均定义在各自的领域文件中，禁止在 `Store` 上新增领域方法。
 *
 * 语法差异说明：
 * - 单嵌入 `*deps` 的领域 Repo 均通过 `extends deps` 继承 `DB`、`isMySQL`、`locking` 等方法；
 *   多嵌入（如 `Store` 组合 22 个领域 Repo，及 `CatalogRepo`/`AssistantRepo`/`RunsRepo` 额外嵌入 `*BotInteractionsRepo`）译为继承 `deps` 加同名组合属性。
 * - `InsightsRepo`、`EngineInstancesRepo`、`KnowledgeRepo`、`HTTPSHostTrustRepo`、`BotInteractionsRepo` 在各自文件中定义，
 *   `newStore` 内采用函数内延迟 `require` 避免顶层循环依赖；`Open` 内延迟引用 `automigrate.js` 避免经过 `models.js -> run_admission.js -> repo.js` 的循环。
 * - Go 的 `sync.Mutex` 在单线程 JS 下省略；`(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理。
 * - Go 的 `time.Duration` 换算为毫秒数（`30 * 60 * 1000`）；`[]byte` 在 `mustJSON` 中以 `Buffer` 表达。
 */

"use strict";

const { Buffer } = require("node:buffer");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const mysql = require("gorm.io/driver/mysql"); // Go 第三方包 gorm.io/driver/mysql
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause
const logger = require("gorm.io/gorm/logger"); // Go 第三方包 gorm.io/gorm/logger

const { ExternalRef } = require("../domain/issue.js"); // 对应 Go 的 domain.ExternalRef，issue.js 已翻译
const { Run, NodeRun } = require("../domain/run.js"); // 对应 Go 的 domain.Run/NodeRun，run.js 已翻译

// 决策提交前运行记录已被并发修改时抛出的乐观锁错误。
const ErrRunDecisionStale = new Error("run changed before the decision was committed");
// 运行租约当前被其他实例持有时抛出的错误。
const ErrRunLeaseHeld = new Error("run lease is held by another instance");
// 运行租约归属或代次（generation）已变更时抛出的错误。
const ErrRunLeaseLost = new Error("run lease ownership or generation changed");
// 运行工作区已绑定到其他宿主机路径时抛出的错误。
const ErrRunWorkspaceBound = new Error("run workspace is already bound to another host path");

/**
 * 所有领域 Repo 共享的基础依赖基类（repo 层共享依赖仅包含 GORM 数据库句柄）。
 * 提供数据库方言识别、跨 MySQL/SQLite 的 JSON 路径提取 SQL 表达式构造以及行级写锁封装。
 */
class deps {
  /**
   * 构造共享依赖实例。
   *
   * @param {Object} [init={}] - 可选初始依赖映射。
   * @param {object | null} [init.DB=null] - 已连接的 `gorm.DB` 句柄。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.DB = init.DB ?? null;
  }

  /**
   * 判断当前连接是否使用 MySQL 方言。
   * 用于决定是否附加 MySQL 专属的 `JSON_UNQUOTE` 包装或 `FOR UPDATE` 行锁。
   *
   * @returns {boolean} 方言名为 `"mysql"` 时返回 `true`，否则返回 `false`。
   */
  isMySQL() {
    return this.DB != null && this.DB.Dialector.Name() === "mysql";
  }

  /**
   * 返回从 `payload` 列按参数化 JSON 路径提取文本值的跨库 SQL 表达式。
   * MySQL 需要 `JSON_UNQUOTE` 去除字符串引号，SQLite 的 `json_extract` 直接返回去引号文本。
   *
   * @param {string} path - JSON 路径占位提示（实际 SQL 中使用 `?` 绑定）。
   * @returns {string} 可跨 MySQL 与 SQLite 使用的 SQL 表达式片段。
   */
  sqlJSONText(path) {
    if (this.isMySQL()) {
      return "JSON_UNQUOTE(JSON_EXTRACT(payload, ?))";
    }
    return "json_extract(payload, ?)";
  }

  /**
   * 返回从 `payload` 列按字面量路径提取文本值的 SQL 表达式，用于无法绑定参数的 `SELECT` 投影。
   * 参数 `path` 是位于 `"$."` 之下的路径常量，严禁传入用户输入。
   *
   * @param {string} path - 位于 `"$."` 之下的代码常量 JSON 路径。
   * @returns {string} 拼接完成的 SQL 表达式片段。
   */
  sqlPayloadJSONText(path) {
    if (this.isMySQL()) {
      return "JSON_UNQUOTE(JSON_EXTRACT(payload, '$." + path + "'))";
    }
    return "json_extract(payload, '$." + path + "')";
  }

  /**
   * 返回从 `execution_context` 列按字面量路径提取文本值的 SQL 表达式。
   * 参数 `path` 是位于 `"$."` 之下的代码常量，严禁传入用户输入。
   *
   * @param {string} path - 位于 `"$."` 之下的代码常量 JSON 路径。
   * @returns {string} 拼接完成的 SQL 表达式片段。
   */
  sqlExecutionContextJSONText(path) {
    if (this.isMySQL()) {
      return "JSON_UNQUOTE(JSON_EXTRACT(execution_context, '$." + path + "'))";
    }
    return "json_extract(execution_context, '$." + path + "')";
  }

  /**
   * 在 MySQL 下为给定查询附加 `FOR UPDATE` 行锁子句；SQLite 测试库采用单连接串行写入，直接原样返回查询。
   *
   * @param {object} q - 待附加锁子句的 `gorm.DB` 查询构建器。
   * @returns {object} 附加锁子句后的或原始的 `gorm.DB` 查询对象。
   */
  locking(q) {
    if (this.isMySQL()) {
      return q.Clauses(new clause.Locking({ Strength: "UPDATE" }));
    }
    return q;
  }
}

/**
 * 目录资产领域仓储，管理智能体、规则、技能、MCP 服务、执行器、沙箱、工作流、仓库、同步配置、定时任务与定义修订版本。
 * 对应 Go 的 `CatalogRepo`（嵌入 `*deps` 与 `*BotInteractionsRepo`，并持有 `projects`、`notifications` 跨领域指针）。
 */
class CatalogRepo extends deps {
  /**
   * 构造 `CatalogRepo` 实例。
   *
   * @param {Object} [init={}] - 初始依赖映射。
   * @param {object | null} [init.DB=null] - GORM 数据库句柄。
   * @param {ProjectsRepo | null} [init.projects=null] - 项目仓储指针。
   * @param {NotificationsRepo | null} [init.notifications=null] - 通知仓储指针。
   * @param {object | null} [init.BotInteractionsRepo=null] - 嵌入的 Bot 交互仓储引用。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
    this.projects = init.projects ?? null;
    this.notifications = init.notifications ?? null;
    this.BotInteractionsRepo = init.BotInteractionsRepo ?? null;
  }
}

/**
 * 业务域配置领域仓储，管理业务域主数据及乐观锁更新。
 * 对应 Go 的 `BusinessDomainsRepo`（单嵌入 `*deps`）。
 */
class BusinessDomainsRepo extends deps {
  /**
   * 构造 `BusinessDomainsRepo` 实例。
   *
   * @param {Object} [init={}] - 可选初始依赖（包含 `DB`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
  }
}

/**
 * 项目及其成员领域仓储。
 * 对应 Go 的 `ProjectsRepo`（单嵌入 `*deps`）。
 */
class ProjectsRepo extends deps {
  /**
   * 构造 `ProjectsRepo` 实例。
   *
   * @param {Object} [init={}] - 可选初始依赖（包含 `DB`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
  }
}

/**
 * Issue 及其评论领域仓储。
 * 对应 Go 的 `IssuesRepo`（嵌入 `*deps`，持有 `projects`、`users`、`tasks` 指针；Go 的 `sync.Mutex` 在单线程 JS 中略去）。
 */
class IssuesRepo extends deps {
  /**
   * 构造 `IssuesRepo` 实例。
   *
   * @param {Object} [init={}] - 初始依赖映射。
   * @param {object | null} [init.DB=null] - GORM 数据库句柄。
   * @param {ProjectsRepo | null} [init.projects=null] - 项目仓储指针。
   * @param {UsersRepo | null} [init.users=null] - 用户仓储指针。
   * @param {TasksRepo | null} [init.tasks=null] - 任务仓储指针。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
    // Go 的 sync.Mutex 在单线程 JS 中不需要，直接略去。
    this.projects = init.projects ?? null;
    this.users = init.users ?? null;
    this.tasks = init.tasks ?? null;
  }
}

/**
 * 跨实例幂等任务记录领域仓储。
 * 对应 Go 的 `TasksRepo`（单嵌入 `*deps`）。
 */
class TasksRepo extends deps {
  /**
   * 构造 `TasksRepo` 实例。
   *
   * @param {Object} [init={}] - 可选初始依赖（包含 `DB`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
  }
}

/**
 * 用户信息、已保存凭据与平台管理员角色领域仓储。
 * 对应 Go 的 `UsersRepo`（单嵌入 `*deps`）。
 */
class UsersRepo extends deps {
  /**
   * 构造 `UsersRepo` 实例。
   *
   * @param {Object} [init={}] - 可选初始依赖（包含 `DB`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
  }
}

/**
 * API 令牌领域仓储。
 * 对应 Go 的 `TokensRepo`（单嵌入 `*deps`）。
 */
class TokensRepo extends deps {
  /**
   * 构造 `TokensRepo` 实例。
   *
   * @param {Object} [init={}] - 可选初始依赖（包含 `DB`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
  }
}

/**
 * Studio AI 助手对话会话与定时 Prompt 领域仓储。
 * 对应 Go 的 `AssistantRepo`（嵌入 `*deps` 与 `*BotInteractionsRepo`，持有 `users`、`notifications` 指针）。
 */
class AssistantRepo extends deps {
  /**
   * 构造 `AssistantRepo` 实例。
   *
   * @param {Object} [init={}] - 初始依赖映射。
   * @param {object | null} [init.DB=null] - GORM 数据库句柄。
   * @param {UsersRepo | null} [init.users=null] - 用户仓储指针。
   * @param {NotificationsRepo | null} [init.notifications=null] - 通知仓储指针。
   * @param {object | null} [init.BotInteractionsRepo=null] - 嵌入的 Bot 交互仓储引用。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
    this.users = init.users ?? null;
    this.notifications = init.notifications ?? null;
    this.BotInteractionsRepo = init.BotInteractionsRepo ?? null;
  }
}

/**
 * 运行主记录及其子资源（节点、事件、遥测、日志、产物）、运行租约、名额准入与工作流指标领域仓储。
 * 对应 Go 的 `RunsRepo`（嵌入 `*deps` 与 `*BotInteractionsRepo`，持有 `assistant`、`issues`、`catalog`、`notifications` 指针）。
 */
class RunsRepo extends deps {
  /**
   * 构造 `RunsRepo` 实例。
   *
   * @param {Object} [init={}] - 初始依赖映射。
   * @param {object | null} [init.DB=null] - GORM 数据库句柄。
   * @param {AssistantRepo | null} [init.assistant=null] - 助手仓储指针。
   * @param {IssuesRepo | null} [init.issues=null] - Issue 仓储指针。
   * @param {CatalogRepo | null} [init.catalog=null] - 目录资产仓储指针。
   * @param {NotificationsRepo | null} [init.notifications=null] - 通知仓储指针。
   * @param {object | null} [init.BotInteractionsRepo=null] - 嵌入的 Bot 交互仓储引用。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
    this.assistant = init.assistant ?? null;
    this.issues = init.issues ?? null;
    this.catalog = init.catalog ?? null;
    this.notifications = init.notifications ?? null;
    this.BotInteractionsRepo = init.BotInteractionsRepo ?? null;
  }
}

/**
 * CLI Runner 注册表、Runner 任务与事件领域仓储。
 * 对应 Go 的 `RunnersRepo`（单嵌入 `*deps`）。
 */
class RunnersRepo extends deps {
  /**
   * 构造 `RunnersRepo` 实例。
   *
   * @param {Object} [init={}] - 可选初始依赖（包含 `DB`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
  }
}

/**
 * MR 交付状态与集成锁领域仓储。
 * 对应 Go 的 `DeliveryRepo`（嵌入 `*deps`，持有 `issues`、`tasks`、`catalog`、`runs` 指针）。
 */
class DeliveryRepo extends deps {
  /**
   * 构造 `DeliveryRepo` 实例。
   *
   * @param {Object} [init={}] - 初始依赖映射。
   * @param {object | null} [init.DB=null] - GORM 数据库句柄。
   * @param {IssuesRepo | null} [init.issues=null] - Issue 仓储指针。
   * @param {TasksRepo | null} [init.tasks=null] - 任务仓储指针。
   * @param {CatalogRepo | null} [init.catalog=null] - 目录资产仓储指针。
   * @param {RunsRepo | null} [init.runs=null] - 运行仓储指针。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
    this.issues = init.issues ?? null;
    this.tasks = init.tasks ?? null;
    this.catalog = init.catalog ?? null;
    this.runs = init.runs ?? null;
  }
}

/**
 * 只读运营分析与需求进度视图领域仓储。
 * 对应 Go 的 `AnalyticsRepo`（嵌入 `*deps`，聚合多个领域只读指针）。
 */
class AnalyticsRepo extends deps {
  /**
   * 构造 `AnalyticsRepo` 实例。
   *
   * @param {Object} [init={}] - 初始依赖映射。
   * @param {object | null} [init.DB=null] - GORM 数据库句柄。
   * @param {RunsRepo | null} [init.runs=null] - 运行仓储指针。
   * @param {CatalogRepo | null} [init.catalog=null] - 目录资产仓储指针。
   * @param {DeliveryRepo | null} [init.delivery=null] - 交付仓储指针。
   * @param {IssuesRepo | null} [init.issues=null] - Issue 仓储指针。
   * @param {TasksRepo | null} [init.tasks=null] - 任务仓储指针。
   * @param {ProjectsRepo | null} [init.projects=null] - 项目仓储指针。
   * @param {object | null} [init.insights=null] - 外部洞察仓储指针。
   * @returns {void} 无返回值。
   */
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

/**
 * 项目群聊房间与消息领域仓储（方法挂载于 `rooms.js`）。
 * 对应 Go 的 `RoomsRepo`（单嵌入 `*deps`）。
 */
class RoomsRepo extends deps {
  /**
   * 构造 `RoomsRepo` 实例。
   *
   * @param {Object} [init={}] - 可选初始依赖（包含 `DB`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
  }
}

/**
 * 需求空间、成员、版本化产物与线程领域仓储（方法挂载于 `spaces.js`）。
 * 对应 Go 的 `SpacesRepo`（单嵌入 `*deps`）。
 */
class SpacesRepo extends deps {
  /**
   * 构造 `SpacesRepo` 实例。
   *
   * @param {Object} [init={}] - 可选初始依赖（包含 `DB`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
  }
}

/**
 * 平台 Git SSH 主机公钥信任登记领域仓储（方法挂载于 `ssh_host_trust.js`）。
 * 对应 Go 的 `SSHHostTrustRepo`（单嵌入 `*deps`）。
 */
class SSHHostTrustRepo extends deps {
  /**
   * 构造 `SSHHostTrustRepo` 实例。
   *
   * @param {Object} [init={}] - 可选初始依赖（包含 `DB`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
  }
}

/**
 * 运行预览、预览会话与归档包体领域仓储（方法挂载于 `previews.js`）。
 * 对应 Go 的 `PreviewsRepo`（单嵌入 `*deps`）。
 */
class PreviewsRepo extends deps {
  /**
   * 构造 `PreviewsRepo` 实例。
   *
   * @param {Object} [init={}] - 可选初始依赖（包含 `DB`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
  }
}

/**
 * 通知 Bot 配置与投递队列领域仓储（方法挂载于 `notifications.js` 与 `notification_reports.js`）。
 * 对应 Go 的 `NotificationsRepo`（嵌入 `*deps`，持有 `users`、`projects`、`issues`、`interactions` 跨领域指针）。
 */
class NotificationsRepo extends deps {
  /**
   * 构造 `NotificationsRepo` 实例。
   *
   * @param {Object} [init={}] - 初始依赖映射。
   * @param {object | null} [init.DB=null] - GORM 数据库句柄。
   * @param {UsersRepo | null} [init.users=null] - 用户仓储指针。
   * @param {ProjectsRepo | null} [init.projects=null] - 项目仓储指针。
   * @param {IssuesRepo | null} [init.issues=null] - Issue 仓储指针。
   * @param {object | null} [init.interactions=null] - Bot 交互仓储指针。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
    this.users = init.users ?? null;
    this.projects = init.projects ?? null;
    this.issues = init.issues ?? null;
    this.interactions = init.interactions ?? null;
  }
}

/**
 * 根持久层门面，组合全部 22 个领域 Repo 与数据库连接生命周期管理。
 * Go 中以匿名指针嵌入实现方法提升；JS 中继承 `deps` 并以同名属性持有各领域 Repo 实例。
 */
class Store extends deps {
  /**
   * 构造 `Store` 实例，按 Go 字段顺序初始化共享依赖与所有领域 Repo 槽位。
   *
   * @param {Object} [init={}] - 可选初始依赖与各领域 Repo 实例映射。
   * @returns {void} 无返回值。
   */
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

  /**
   * 释放底层 SQL 连接池，同时保留 `this.DB` 句柄使在途后台任务收到关闭错误而非空指针崩溃。
   * 在服务优雅退出或初始化迁移失败回滚时调用。
   *
   * @returns {void} 无返回值。
   */
  Close() {
    if (this.DB == null) {
      return;
    }
    try {
      const sqlDB = this.DB.DB();
      sqlDB.Close();
    } catch {
      // Go 的 if sqlDB, err := s.DB.DB(); err == nil 分支：取不到底层连接池时静默忽略。
    }
  }

  /**
   * 返回当前存储驱动与数据库模式摘要信息，供健康检查或引导接口展示。
   *
   * @returns {{ driver: string, database: boolean, note: string }} 存储状态摘要对象。
   */
  StorageInfo() {
    return {
      driver: this.DB.Dialector.Name(),
      database: true,
      note: "所有状态都在 MySQL：项目、Issue、SOP、运行记录、助手对话和定时任务都直接读写数据库。",
    };
  }
}

/**
 * 装配共享依赖与全部领域 Repo 及其无环跨领域指针。
 * 由 `Open` 与测试入口 `OpenTest` 调用。
 *
 * @param {object} db - 已连接的 `gorm.DB` 数据库句柄。
 * @returns {Store} 完成所有领域 Repo 装配的 `Store` 实例。
 */
function newStore(db) {
  const s = new Store({ DB: db });
  s.ProjectsRepo = new ProjectsRepo({ DB: db });
  s.BusinessDomainsRepo = new BusinessDomainsRepo({ DB: db });
  s.UsersRepo = new UsersRepo({ DB: db });
  // BotInteractionsRepo、InsightsRepo、EngineInstancesRepo、KnowledgeRepo、HTTPSHostTrustRepo
  // 在各自文件中定义，这里采用函数内延迟 require 避免顶层循环引用。
  s.BotInteractionsRepo = new (require("./bot_interactions.js").BotInteractionsRepo)({ DB: db });
  s.TokensRepo = new TokensRepo({ DB: db });
  s.AssistantRepo = new AssistantRepo({ DB: db, users: s.UsersRepo });
  s.TasksRepo = new TasksRepo({ DB: db });
  s.NotificationsRepo = new NotificationsRepo({ DB: db, users: s.UsersRepo, projects: s.ProjectsRepo, interactions: s.BotInteractionsRepo });
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
  s.KnowledgeRepo = new (require("./knowledge.js").KnowledgeRepo)({ DB: db });
  s.SSHHostTrustRepo = new SSHHostTrustRepo({ DB: db });
  s.HTTPSHostTrustRepo = new (require("./git_https_hosts.js").HTTPSHostTrustRepo)({ DB: db });
  return s;
}

/**
 * 连接生产 MySQL 数据源，配置连接池、执行连通性探测并运行增量 DDL 补齐后返回 `Store`。
 * 若参数与环境变量 `AGENTFLOW_MYSQL_DSN` 均为空，直接报错拒绝启动。
 *
 * @param {string} dsn - MySQL DSN 连接串；为空时回退读取环境变量 `AGENTFLOW_MYSQL_DSN`。
 * @returns {Store} 已就绪的持久层 `Store` 实例。
 * @throws {Error} 缺少 DSN、打开连接失败、Ping 失败或增量 DDL 迁移失败时抛出错误。
 */
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
  // 仅通过 GORM Migrator 执行只增不改的增量 DDL 补齐（缺失的表/列/索引）；
  // 基线 schema、数据迁移与 seed 数据不从代码运行，统一由 migrations/ 下的手工 SQL 脚本执行。
  const { autoMigrateIncremental } = require("./automigrate.js");
  try {
    autoMigrateIncremental(s.DB);
  } catch (err) {
    s.Close();
    throw new Error(`auto migrate: ${err}`);
  }
  return s;
}

/**
 * 判断一条 Issue 是否已绑定外部工单追踪系统（工蜂 `gongfeng` 或 `tapd`）且具备有效外部标识。
 * 供同步与保存逻辑决定是否需要恢复被清空的外部引用。
 *
 * @param {import("../domain/issue.js").Issue} issue - 待检查的 Issue 领域对象。
 * @returns {boolean} 已绑定外部追踪器且外部 ID/IID 有效时返回 `true`，否则返回 `false`。
 */
function IssueBoundToTracker(issue) {
  if (issue.Source !== "gongfeng" && issue.Source !== "tapd") {
    return false;
  }
  if (issue.ExternalRef == null) {
    return false;
  }
  return issue.ExternalRef.ExternalID.trim() !== "" || issue.ExternalRef.ExternalIID !== 0;
}

/**
 * 在保存操作可能意外清空 `ExternalRef` 后，从已有快照或稳定的本地 ID（`tapd-...` / `gf-...`）恢复 Issue 的外部追踪器绑定信息。
 * 若传入 `issue` 为空或已具备有效绑定则不做修改。
 *
 * @param {import("../domain/issue.js").Issue | null} issue - 待就地补全绑定信息的目标 Issue 对象。
 * @param {import("../domain/issue.js").Issue} existing - 数据库中已有的历史 Issue 快照。
 * @returns {void} 无返回值。
 */
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
  // Go 的 strings.CutPrefix 在前缀匹配时返回剥离后的子串。
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

/**
 * 解析持久化格式的工蜂 Issue ID（形如 `"gf-<repo>-<iid>"`），提取仓库路径部分与正整数 IID。
 * 格式不合法或 IID 非正整数时返回 `["", 0]`。
 *
 * @param {string} id - 本地存储的 Issue ID。
 * @returns {[string, number]} 二元组 `[repo, iid]`。
 */
function parseStoredGongfengIssueID(id) {
  const trimmed = id.trim();
  const body = trimmed.startsWith("gf-") ? trimmed.slice(3) : trimmed;
  if (body === "" || body === trimmed) {
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

/**
 * 浅拷贝运行节点状态映射 `map[string]*domain.NodeRun` 及其每个非空节点对象。
 * 映射为空时返回 `null`（与 Go 一致）。
 *
 * @param {Object<string, NodeRun | null> | null} nodes - 原始节点运行状态映射。
 * @returns {Object<string, NodeRun> | null} 克隆后的节点状态映射；输入为空时返回 `null`。
 */
function cloneRunNodes(nodes) {
  if (nodes == null || Object.keys(nodes).length === 0) {
    return null;
  }
  const out = {};
  for (const [id, node] of Object.entries(nodes)) {
    if (node == null) {
      continue;
    }
    const cp = new NodeRun({ ...node });
    out[id] = cp;
  }
  return out;
}

/**
 * 浅拷贝 `Run` 领域对象，并独立复制其 `Nodes` 映射及 `Events`/`Telemetry`/`Logs`/`Artifacts` 切片，
 * 避免调用方修改副本时影响原对象（对应 Go 按值传递 `domain.Run` 的语义）。
 *
 * @param {Run} run - 原始运行领域对象。
 * @returns {Run} 克隆后的新 `Run` 实例。
 */
function cloneRun(run) {
  const copy = new Run({ ...run });
  copy.Nodes = cloneRunNodes(run.Nodes);
  copy.Events = run.Events == null ? null : [...run.Events];
  copy.Telemetry = run.Telemetry == null ? null : [...run.Telemetry];
  copy.Logs = run.Logs == null ? null : [...run.Logs];
  copy.Artifacts = run.Artifacts == null ? null : [...run.Artifacts];
  return copy;
}

/**
 * 对一组引用名称依次剥离指定前缀与 `.md` 后缀（各自至多剥离一次）。
 * 供规则、技能等资产引用列表规范化使用。
 *
 * @param {string[]} values - 原始引用路径或名称数组。
 * @param {string} prefix - 待剥离的前缀字符串。
 * @returns {string[]} 规范化后的引用名称数组。
 */
function normalizeRefs(values, prefix) {
  const out = [];
  for (let v of values) {
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

/**
 * 按 Go 风格比较器 `less(a, b)` 对数组进行原地排序。
 * 供 repo 包内需要按自定义条件排序切片的调用点复用。
 *
 * @template T
 * @param {T[]} values - 待原地排序的数组。
 * @param {(a: T, b: T) => boolean} less - 当 `a` 应排在 `b` 之前时返回 `true` 的比较函数。
 * @returns {void} 无返回值。
 */
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

/**
 * 将任意值序列化为 UTF-8 JSON 字节缓冲区；序列化失败或结果为空时兜底返回 `"{}"` 对应缓冲区。
 * 对应 Go 的 `mustJSON(v any) []byte`。
 *
 * @param {any} v - 待序列化的任意值。
 * @returns {Buffer} JSON 文本对应的 `Buffer` 对象。
 */
function mustJSON(v) {
  try {
    const raw = JSON.stringify(v);
    if (raw == null || raw.length === 0) {
      return Buffer.from("{}");
    }
    return Buffer.from(raw, "utf8");
  } catch {
    return Buffer.from("{}");
  }
}

module.exports = { deps, ErrRunDecisionStale, ErrRunLeaseHeld, ErrRunLeaseLost, ErrRunWorkspaceBound, CatalogRepo, BusinessDomainsRepo, ProjectsRepo, IssuesRepo, TasksRepo, UsersRepo, TokensRepo, AssistantRepo, RunsRepo, RunnersRepo, DeliveryRepo, AnalyticsRepo, RoomsRepo, SpacesRepo, SSHHostTrustRepo, PreviewsRepo, NotificationsRepo, Store, newStore, Open, IssueBoundToTracker, RestoreTrackerBinding, parseStoredGongfengIssueID, cloneRunNodes, cloneRun, normalizeRefs, sortSlice, mustJSON };
