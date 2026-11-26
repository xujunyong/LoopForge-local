/**
 * @file internal/repo/run_admission.js
 * 对应 Go 源文件：internal/repo/run_admission.go
 *
 * 作用与职责边界：
 * 实现运行名额准入与分桶并发限流：按平台项目（`project:<id>`，上限 `ProjectRunLimit`）或个人执行机
 * （`runner:<id>`，按用户配置的 `Runner.RunLimit`）分桶加锁与记账，负责冻结运行配额归属、
 * 校验父子运行名额、溢出排队、按 FIFO 放行排队运行以及取消尚未开始的排队运行。
 * 不负责运行本身的节点调度与执行引擎循环。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；
 *   `db.Transaction(tx => ...)` 回调同样失败抛错、成功正常返回。
 * - `admissionLockRequired` 继承原生 `Error` 并实现大写 `Error()` 方法，与 Go 的 `error` 接口及 `errors.As` / `instanceof` 语义对齐。
 * - Go 的 `*sql.TxOptions` 译为含 `Isolation: "LevelReadCommitted"` 的普通对象；`gorm.Expr` 译为 `new clause.Expr({ SQL: ... })`。
 * - 与 `runs.js` 存在同包循环引用，调用 `runFromRow` 时采用函数内延迟 `require`。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { RunKindWorkspace, RunEvent } = require("../domain/run.js"); // 对应 Go 的 domain.RunKindWorkspace/RunEvent，run.js 已翻译
const { FreeCollaborationWorkflowID } = require("../domain/group_plan.js"); // 对应 Go 的 domain.FreeCollaborationWorkflowID，group_plan.js 已翻译
const { deps, RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runRow, runEventRow, runnerRow, issueRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { jsonBytes } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译

/**
 * 延迟调用 `runs.js` 中的 `runFromRow`，避免 `models.js -> run_admission.js -> runs.js -> models.js` 的顶层循环依赖。
 *
 * @param {runRow} row - 数据库 `runs` 表行模型。
 * @returns {import("../domain/run.js").Run} 映射后的运行领域对象。
 */
function runFromRow(row) {
  return require("./runs.js").runFromRow(row);
}

// 平台云端执行时每个项目并发准入的顶层 SOP 运行上限；个人执行机按其各自配置的 Runner.RunLimit 计额。
const ProjectRunLimit = 10;

/**
 * 准入分桶锁表（`run_admission_locks`）的持久化行模型。
 * 每个项目桶（`"project:<id>"`）或个人执行机桶（`"runner:<id>"`）独占一行，互不阻塞；
 * 事务须在获取任何运行行锁之前先获取且至多持有一个桶锁。
 */
class runAdmissionLockRow {
  /**
   * 构造分桶锁行对象，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.ID=""] - 分桶锁键（`"project:<id>"` 或 `"runner:<id>"`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
  }

  /**
   * 返回 GORM 映射的物理数据库表名。
   *
   * @returns {string} 表名 `"run_admission_locks"`。
   */
  TableName() {
    return "run_admission_locks";
  }
}

/**
 * 锁定指定准入分桶：首次使用时幂等创建锁行，随后在事务内对该行加排他锁。
 * 锁行属于运行期并发记账记录，不属于 seed 数据。
 *
 * @param {deps} d - 提供 `locking` 能力的共享依赖对象（或继承 `deps` 的仓储实例）。
 * @param {object} tx - 当前活跃的 `gorm.DB` 事务句柄。
 * @param {string} key - 目标准入分桶键。
 * @returns {void} 无返回值。
 * @throws {Error} 幂等插入锁行或加锁读取失败时抛出错误。
 */
function lockAdmissionGate(d, tx, key) {
  const row = new runAdmissionLockRow({ ID: key });
  const err = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
  if (err != null) {
    throw err;
  }
  const lockErr = d.locking(tx.Where("id = ?", row.ID)).Take(row).Error;
  if (lockErr != null) {
    throw lockErr;
  }
}

/**
 * 返回分桶加锁事务所需的隔离级别选项：MySQL 下使用 `ReadCommitted` 以避免默认 `REPEATABLE READ` 看不到锁前新提交；
 * SQLite 测试库单连接串行写入，返回 `null`。
 *
 * @returns {Array<{ Isolation: string }> | null} 事务隔离选项数组，或无需额外选项时返回 `null`。
 */
deps.prototype.admissionTxOptions = function () {
  if (this.isMySQL()) {
    // Go 的 *sql.TxOptions 在 JS 中以同名隔离级别字段的普通对象表达。
    return [{ Isolation: "LevelReadCommitted" }];
  }
  return null;
};

/**
 * 信号错误类型：表示本次写入需要占用名额但当前事务尚未持有目标分桶锁。
 * 上层 `writeRun` 捕获该错误后会释放当前事务并以该 `key` 持锁重试。
 */
class admissionLockRequired extends Error {
  /**
   * 构造缺少准入桶锁的错误实例。
   * 兼容直接传分桶键字符串或 Go 结构体风格的 `{ key }` 对象两种构造形态。
   *
   * @param {string | { key?: string }} [init=""] - 目标准入分桶键或含 `key` 字段的对象。
   * @returns {void} 无返回值。
   */
  constructor(init = "") {
    const key = typeof init === "string" ? init : (init.key ?? "");
    super("admission lock required for " + key);
    this.name = "admissionLockRequired";
    this.key = key;
  }

  /**
   * 返回与 Go `(*admissionLockRequired).Error()` 完全一致的错误描述字符串。
   *
   * @returns {string} 形如 `"admission lock required for <key>"` 的错误文案。
   */
  Error() {
    return "admission lock required for " + this.key;
  }
}

/**
 * 根据项目 ID、执行机 ID 与是否豁免平台限流（个人执行机）计算准入分桶键。
 *
 * @param {string} project - 项目 ID。
 * @param {string} runnerID - 执行机 ID。
 * @param {boolean} exempt - 是否属于个人执行机（豁免项目桶限流而归入执行机桶）。
 * @returns {string} 准入分桶键（`"runner:<runnerID>"` 或 `"project:<project>"`）。
 */
function admissionBucketKey(project, runnerID, exempt) {
  if (exempt) {
    return "runner:" + runnerID.trim();
  }
  return "project:" + project.trim();
}

/**
 * 计算已冻结配额项目与豁免标记的运行记录对应的持久化分桶键。
 *
 * @param {import("../domain/run.js").Run} run - 运行领域对象。
 * @returns {string} 该运行所属的准入分桶键。
 */
function runAdmissionBucketKey(run) {
  return admissionBucketKey(run.ExecutionContext.ProjectID, run.ExecutionContext.ExecutionRunnerID, run.ConcurrencyExempt);
}

/**
 * 单台执行机的准入属性缓存项（是否属于个人执行机及并发上限）。
 */
class runnerAdmissionInfo {
  /**
   * 构造执行机准入属性对象，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {boolean} [init.personal=false] - 是否绑定了个人所有者（`OwnerUserID > 0`）。
   * @param {number} [init.limit=0] - 执行机并发上限（`0` 表示不限制）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.personal = init.personal ?? false;
    this.limit = init.limit ?? 0;
  }
}

/**
 * 单事务内的准入元数据查询缓存作用域。
 * 缓存执行机与 Issue 归属项目查询结果，避免历史未回填配额列的运行行逐条触发重复查询。
 */
class admissionScope {
  /**
   * 构造准入缓存作用域，缺省字段按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {object | null} [init.tx=null] - 当前事务 `gorm.DB` 句柄。
   * @param {Object<string, runnerAdmissionInfo>} [init.runners={}] - 执行机准入信息缓存。
   * @param {Object<string, string>} [init.issues={}] - Issue ID 到项目 ID 的缓存。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.tx = init.tx ?? null;
    this.runners = init.runners ?? {};
    this.issues = init.issues ?? {};
  }

  /**
   * 查询并缓存指定执行机的个人归属与并发上限信息；记录不存在时缓存零值信息。
   *
   * @param {string} id - 执行机 ID。
   * @returns {runnerAdmissionInfo} 执行机准入信息对象。
   * @throws {Error} 数据库查询发生非 `ErrRecordNotFound` 错误时抛出错误。
   */
  runner(id) {
    id = id.trim();
    if (id === "") {
      return new runnerAdmissionInfo();
    }
    if (this.runners[id] != null) {
      return this.runners[id];
    }
    const row = new runnerRow();
    const info = new runnerAdmissionInfo();
    const err = this.tx.Select("id", "owner_user_id", "run_limit").Where("id = ?", id).Take(row).Error;
    if (err == null) {
      info.personal = row.OwnerUserID != null && row.OwnerUserID > 0;
      if (row.RunLimit != null && row.RunLimit > 0) {
        info.limit = row.RunLimit;
      }
    } else if (err !== gorm.ErrRecordNotFound) {
      throw err;
    }
    this.runners[id] = info;
    return info;
  }

  /**
   * 解析运行所属项目 ID：优先取运行上下文的 `ProjectID`，缺失时通过关联的 `IssueID` 查询并缓存。
   *
   * @param {import("../domain/run.js").Run} run - 目标运行对象。
   * @returns {string} 解析得到的项目 ID（无法归属时为空串 `""`）。
   * @throws {Error} 查询关联 Issue 发生非 `ErrRecordNotFound` 错误时抛出错误。
   */
  project(run) {
    const id = run.ExecutionContext.ProjectID.trim();
    if (id !== "") {
      return id;
    }
    const issueID = run.ExecutionContext.IssueID.trim();
    if (issueID === "") {
      return "";
    }
    if (this.issues[issueID] != null) {
      return this.issues[issueID];
    }
    const row = new issueRow();
    let project = "";
    const err = this.tx.Select("id", "project_id").Where("id = ?", issueID).Take(row).Error;
    if (err == null) {
      project = row.ProjectID;
    } else if (err !== gorm.ErrRecordNotFound) {
      throw err;
    }
    this.issues[issueID] = project;
    return project;
  }

  /**
   * 判断运行是否因运行在个人执行机上而豁免项目桶限流。
   *
   * @param {import("../domain/run.js").Run} run - 目标运行对象。
   * @returns {boolean} 归属个人执行机时返回 `true`，否则返回 `false`。
   * @throws {Error} 查询执行机信息失败时抛出错误。
   */
  exempt(run) {
    const info = this.runner(run.ExecutionContext.ExecutionRunnerID);
    return info.personal;
  }

  /**
   * 返回指定分桶的并发名额上限；返回 `0` 表示不限制。
   *
   * @param {string} key - 准入分桶键。
   * @returns {number} 并发名额上限。
   * @throws {Error} 查询执行机上限失败时抛出错误。
   */
  limit(key) {
    // Go 的 strings.CutPrefix 在前缀匹配时剥离前缀。
    if (key.startsWith("runner:")) {
      const info = this.runner(key.slice("runner:".length));
      return info.limit;
    }
    return ProjectRunLimit;
  }

  /**
   * 读取运行行已持久化的分桶键；对尚未回填配额列的历史行，回退至执行上下文、关联 Issue 与执行机归属动态推导。
   *
   * @param {runRow} row - 数据库 `runs` 表行对象。
   * @returns {string} 推导得到的准入分桶键。
   * @throws {Error} 关联查询失败时抛出错误。
   */
  rowBucketKey(row) {
    if (row.QuotaBucket != null && row.QuotaBucket !== "") {
      return row.QuotaBucket;
    }
    const run = runFromRow(row);
    let project = "";
    if (row.QuotaProjectID != null) {
      project = row.QuotaProjectID;
    } else {
      project = this.project(run);
    }
    let exempt = row.QuotaExempt != null && row.QuotaExempt;
    if (row.QuotaExempt == null) {
      exempt = this.exempt(run);
    }
    return admissionBucketKey(project, run.ExecutionContext.ExecutionRunnerID, exempt);
  }

  /**
   * 统计目标分桶当前已占用的顶层 SOP 运行名额数（可排除指定 `exclude` 运行 ID）。
   * 对话工作区、已退役的自由协作工作流以及嵌套子 SOP 均不占用独立顶层名额；未回填 `quota_bucket` 的历史行会按规则兜底计入。
   *
   * @param {string} key - 目标准入分桶键。
   * @param {string} exclude - 需要排除计数的运行 ID（空串表示不排除）。
   * @returns {number} 当前已占用的并发名额数量。
   * @throws {Error} 数据库查询或历史行归属推导失败时抛出错误。
   */
  occupied(key, exclude) {
    const rows = [];
    let q = this.tx.Select("id", "kind", "workflow_id", "status", "quota_bucket", "quota_project_id", "quota_parent_run_id", "quota_exempt", "admission_state", "execution_context").
      Where("(quota_bucket = ? OR quota_bucket IS NULL) AND status NOT IN ? AND (admission_state IS NULL OR admission_state <> ?)",
        key, ["succeeded", "queued"], "unstarted");
    if (exclude !== "") {
      q = q.Where("id <> ?", exclude);
    }
    const err = q.Find(rows).Error;
    if (err != null) {
      throw err;
    }
    let n = 0;
    for (const row of rows) {
      let parent = "";
      if (row.QuotaParentRunID != null) {
        parent = row.QuotaParentRunID;
      } else {
        parent = runFromRow(row).ExecutionContext.ParentRunID;
      }
      if (parent.trim() !== "") {
        continue;
      }
      if (row.Kind === RunKindWorkspace || row.WorkflowID === FreeCollaborationWorkflowID) {
        continue;
      }
      const bucket = this.rowBucketKey(row);
      if (bucket === key) {
        n++;
      }
    }
    return n;
  }

  /**
   * 检查目标分桶中是否已有其他运行处于排队状态，防止新请求插队超越已排队运行。
   *
   * @param {string} key - 目标准入分桶键。
   * @param {string} exclude - 排除检查的当前运行 ID。
   * @returns {boolean} 存在其他排队运行时返回 `true`，否则返回 `false`。
   * @throws {Error} 数据库查询失败时抛出错误。
   */
  hasQueued(key, exclude) {
    const ids = [];
    const err = this.tx.Model(new runRow()).Where("quota_bucket = ? AND status = ? AND id <> ?", key, "queued", exclude).Limit(1).Pluck("id", ids).Error;
    if (err != null) {
      throw err;
    }
    return ids.length > 0;
  }
}

/**
 * 为指定事务创建新的准入查询缓存作用域。
 *
 * @param {object} tx - 当前活跃的 `gorm.DB` 事务句柄。
 * @returns {admissionScope} 初始化完成的缓存作用域实例。
 */
function newAdmissionScope(tx) {
  return new admissionScope({ tx: tx, runners: {}, issues: {} });
}

/**
 * 按分桶类型生成排队事件的用户提示文案。
 *
 * @param {string} key - 准入分桶键。
 * @returns {string} 面向用户的中文排队等待说明。
 */
function queuedMessage(key) {
  if (key.startsWith("runner:")) {
    return "等待执行机器可用运行名额";
  }
  return "等待项目可用运行名额";
}

/**
 * 在写入运行前冻结其配额归属（项目与豁免标记）并裁决是否需要申请名额、进入排队或校验父运行准入。
 * 若需要申请名额但调用方事务尚未持有对应分桶锁（`key !== lockedKey`），会抛出 `admissionLockRequired` 触发持锁重试。
 *
 * @param {object} tx - 当前活跃的 `gorm.DB` 事务句柄。
 * @param {import("../domain/run.js").Run} run - 即将写入的运行对象（会被就地回填准入与配额字段）。
 * @param {runRow} current - 数据库中已存在的旧运行行（`exists` 为 `true` 时有效）。
 * @param {boolean} exists - 数据库中是否已存在该运行记录。
 * @param {string} lockedKey - 调用方当前事务已持有的分桶锁键（未持锁时为空串 `""`）。
 * @returns {void} 无返回值。
 * @throws {Error} 排队状态冲突、缺少分桶锁（`admissionLockRequired`）、父运行未获得名额或数据库查询失败时抛出错误。
 */
RunsRepo.prototype.prepareRunAdmission = function (tx, run, current, exists, lockedKey) {
  const s = newAdmissionScope(tx);
  if (exists) {
    const cur = runFromRow(current);
    run.AdmissionState = current.AdmissionState;
    if (current.QueueEntered != null) {
      run.QueueEnteredAt = current.QueueEntered;
    }
    run.ExecutionContext.ParentRunID = cur.ExecutionContext.ParentRunID;
    if (current.QuotaProjectID != null) {
      run.ExecutionContext.ProjectID = current.QuotaProjectID;
    } else {
      run.ExecutionContext.ProjectID = s.project(cur);
    }
    if (current.QuotaExempt != null) {
      run.ConcurrencyExempt = current.QuotaExempt;
    } else {
      run.ConcurrencyExempt = s.exempt(cur);
    }
    // 基于旧快照发起的 running 写入不得绕过排队状态。
    if (current.Status === "queued" && run.Status === "running") {
      throw new Error("run is queued");
    }
  } else {
    run.ExecutionContext.ProjectID = s.project(run);
    run.ConcurrencyExempt = s.exempt(run);
  }
  if (run.Status === "succeeded") {
    run.AdmissionState = "released";
    return;
  }
  if (run.Status !== "running") {
    if (exists && current.Status === "queued") {
      if (run.Status !== "cancelled" && run.Status !== "queued") {
        throw new Error("run is queued");
      }
      if (run.Status === "cancelled") {
        run.AdmissionState = "unstarted";
      }
    }
    return;
  }
  if (exists && current.Status !== "succeeded" && current.AdmissionState !== "unstarted") {
    run.AdmissionState = "held";
    this.checkParentAdmission(tx, run);
    return;
  }
  run.AdmissionState = "held";
  if (run.ExecutionContext.ParentRunID.trim() !== "") {
    this.checkParentAdmission(tx, run);
    return;
  }
  const key = runAdmissionBucketKey(run);
  const limit = s.limit(key);
  if (limit <= 0) {
    return;
  }
  if (key !== lockedKey) {
    throw new admissionLockRequired(key);
  }
  const occupied = s.occupied(key, run.ID);
  const queued = s.hasQueued(key, run.ID);
  if (occupied >= limit || queued) {
    run.Status = "queued";
    run.AdmissionState = "queued";
    run.QueueEnteredAt = new Date();
    run.OwnerInstanceID = "";
    run.LeaseUntil = null;
    run.CancelRequested = false;
    run.PauseRequested = false;
    for (let i = 0; i < run.Events.length; i++) {
      if (run.Events[i].Type === "run.started" && !exists) {
        run.Events[i].Type = "run.queued";
        run.Events[i].Message = queuedMessage(key);
      }
    }
  }
};

/**
 * 沿父运行链向上校验所有祖先运行均存在、无环且当前仍持有有效运行名额。
 * 确保嵌套子 SOP 不会在父流程已成功、排队中或未获准入时被单独拉起。
 *
 * @param {object} tx - 当前活跃的 `gorm.DB` 事务句柄。
 * @param {import("../domain/run.js").Run} run - 待校验的运行对象。
 * @returns {void} 无返回值。
 * @throws {Error} 检测到父链成环、父运行不可用或父流程尚未获得运行名额时抛出错误。
 */
RunsRepo.prototype.checkParentAdmission = function (tx, run) {
  let parentID = run.ExecutionContext.ParentRunID.trim();
  const seen = { [run.ID]: true };
  while (parentID !== "") {
    if (seen[parentID]) {
      throw new Error("cyclic parent run");
    }
    seen[parentID] = true;
    const parent = new runRow();
    const err = tx.Where("id = ?", parentID).Take(parent).Error;
    if (err != null) {
      throw new Error(`parent run unavailable: ${err}`);
    }
    if (parent.Status === "succeeded" || parent.Status === "queued" || parent.AdmissionState === "unstarted") {
      throw new Error("请从顶层 SOP 重新运行，父流程尚未获得运行名额");
    }
    parentID = runFromRow(parent).ExecutionContext.ParentRunID.trim();
  }
};

/**
 * 扫描所有存在排队运行的分桶，按桶依次发起短事务以 FIFO 顺序放行可准入的运行。
 * 单个分桶放行失败不会阻塞其他分桶继续放行；若存在失败，在全部桶处理完后抛出首个错误。
 *
 * @returns {string[]} 本轮成功放行并转为 `running` 状态的运行 ID 数组。
 * @throws {Error} 查询排队分桶失败，或任一分桶放行过程中出错时抛出错误。
 */
RunsRepo.prototype.PromoteQueuedRuns = function () {
  const raw = [];
  const err = this.DB.Model(new runRow()).Where("status = ?", "queued").Distinct("quota_bucket").Pluck("quota_bucket", raw).Error;
  if (err != null) {
    throw err;
  }
  const keys = [];
  for (const key of raw) {
    if (key != null && key !== "") {
      keys.push(key);
    }
  }
  keys.sort();
  const promoted = [];
  let firstErr = null;
  for (const key of keys) {
    try {
      const ids = this.promoteBucket(key);
      promoted.push(...ids);
    } catch (bucketErr) {
      if (firstErr == null) {
        firstErr = new Error(`promote ${key}: ${bucketErr}`);
      }
    }
  }
  if (firstErr != null) {
    throw firstErr;
  }
  return promoted;
};

/**
 * 在单个分桶锁事务内按入队时间、创建时间与主键顺序放行指定分桶的排队运行，直至达到名额上限或队列清空。
 * 每放行一条运行会递增修订号、清除旧租约/取消标记并追加一条 `run.started` 事件。
 *
 * @param {string} key - 待放行的准入分桶键。
 * @returns {string[]} 该分桶本次放行的运行 ID 数组。
 * @throws {Error} 加锁、查询占用数、更新运行状态或写入事件失败时抛出错误。
 */
RunsRepo.prototype.promoteBucket = function (key) {
  let promoted = [];
  this.DB.Transaction((tx) => {
    promoted = [];
    // Go 的 r.deps 即嵌入的 deps，JS 里 RunsRepo 继承 deps，直接传入 this。
    lockAdmissionGate(this, tx, key);
    const s = newAdmissionScope(tx);
    const limit = s.limit(key);
    let occupied = 0;
    if (limit > 0) {
      occupied = s.occupied(key, "");
      if (occupied >= limit) {
        return;
      }
    }
    const queued = [];
    const queuedErr = tx.Select("id", "queue_entered_at", "created_at").Where("quota_bucket = ? AND status = ?", key, "queued").
      Order("queue_entered_at, created_at, id").Find(queued).Error;
    if (queuedErr != null) {
      throw queuedErr;
    }
    for (const row of queued) {
      if (limit > 0 && occupied >= limit) {
        break;
      }
      const now = new Date();
      // 并发取消会锁定运行行，因此这里重新校验 status = queued。
      const res = tx.Model(new runRow()).Where("id = ? AND status = ?", row.ID, "queued").Updates({
        status: "running", admission_state: "held", revision: new clause.Expr({ SQL: "revision + 1" }), updated_at: now,
        cancel_requested: false, pause_requested: false, owner_instance_id: "", lease_until: null,
      });
      if (res.Error != null) {
        throw res.Error;
      }
      if (res.RowsAffected === 0) {
        continue;
      }
      const seqHolder = [0];
      const seqErr = tx.Model(new runEventRow()).Select("COALESCE(MAX(seq), -1) + 1").Where("run_id = ?", row.ID).Scan(seqHolder).Error;
      if (seqErr != null) {
        throw seqErr;
      }
      const seq = seqHolder[0];
      const ev = new RunEvent({ ID: `adm-${BigInt(now.getTime()) * 1000000n}-${seq}`, RunID: row.ID, Type: "run.started", Message: "获得运行名额，开始执行", Timestamp: now });
      const createErr = tx.Create(new runEventRow({ RunID: row.ID, Seq: seq, EventID: ev.ID, Type: ev.Type, Message: ev.Message, Payload: jsonBytes(ev), Ts: now })).Error;
      if (createErr != null) {
        throw createErr;
      }
      occupied++;
      promoted.push(row.ID);
    }
  }, ...(this.admissionTxOptions() ?? []));
  return promoted;
};

/**
 * 在运行行锁事务中取消一条尚未开始的排队运行，将其置为 `cancelled` 且准入状态设为 `unstarted`。
 * 仅锁运行行而不取桶锁；`promoteBucket` 在放行前会于同一运行行上复核 `status = queued`。
 *
 * @param {string} id - 待取消的运行 ID。
 * @returns {boolean} 命中 `queued` 状态并成功取消时返回 `true`，运行已不在排队状态时返回 `false`。
 * @throws {Error} 运行不存在或数据库更新失败时抛出错误。
 */
RunsRepo.prototype.CancelQueuedRun = function (id) {
  let cancelled = false;
  this.DB.Transaction((tx) => {
    const row = this.takeRunForUpdate(tx, id);
    if (row.Status !== "queued") {
      return;
    }
    cancelled = true;
    const updateErr = tx.Model(new runRow()).Where("id = ?", id).Updates({ status: "cancelled", admission_state: "unstarted", revision: new clause.Expr({ SQL: "revision + 1" }), updated_at: new Date() }).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
  return cancelled;
};

module.exports = { ProjectRunLimit, runAdmissionLockRow, lockAdmissionGate, admissionLockRequired, admissionBucketKey, runAdmissionBucketKey, runnerAdmissionInfo, admissionScope, newAdmissionScope, queuedMessage };
