/**
 * @file internal/repo/assistant_generations.js
 * 对应 Go 源文件：internal/repo/assistant_generations.go
 *
 * 作用与职责边界：
 * 负责助手单轮生成（generation）的完整存储状态机：包含启动生成、心跳续期、检查点落盘、
 * 引导转向（steer）关闭与写入、取消请求、超时死进程回收（reap）及批量状态/未读查询。
 * 不负责模型推理调用、消息流式推送或工作区容器本身的创建与销毁。
 *
 * 语法差异说明：
 * - Go `(值, error)` 译为成功返回值、失败 `throw err`；仅返回 `error` 的方法译为成功返回 `undefined`、失败 `throw err`；`(值, bool)` / `(值1, 值2, bool)` 译为对应长度元组。
 * - GORM `DB.Transaction` 回调统一遵循失败 `throw err`、成功正常返回的约定。
 * - `assistantGenerationPayload` 单嵌入 `AssistantGeneration`，使用 `extends` 继承；`time.Time` 与 `[]byte` 零值译为 `null`；`time.Duration` 译为毫秒数。
 * - `BeginAssistantGeneration` 因内部调用异步死锁重试 `retryAssistantDeadlock`，译为 `async` 方法。
 */

"use strict";

const { Buffer } = require("node:buffer");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { AssistantGeneration } = require("../domain/assistant_generation.js"); // 对应 Go 同包类型，assistant_generation.js 已翻译
const { AssistantFailure } = require("../domain/assistant_diagnostics.js"); // 对应 Go 同包类型，assistant_diagnostics.js 已翻译
const { checkpointAssistantDiagnostics } = require("./assistant_diagnostics.js"); // 对应 Go 同包函数，assistant_diagnostics.js 本次一同翻译
const { assistantSessionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

/**
 * 对应数据库表 `assistant_generations` 的持久化行模型。
 * 记录每个会话最新一轮生成的状态、取消标记、私有控制负载、心跳时间、结束时间与工作区租约。
 */
class assistantGenerationRow {
  /**
   * 构造并初始化生成记录行对象。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.SessionID = init.SessionID ?? "";
    this.UserID = init.UserID ?? 0;
    this.GenerationID = init.GenerationID ?? "";
    this.Status = init.Status ?? "";
    this.CancelRequested = init.CancelRequested ?? false;
    this.Payload = init.Payload ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
    // FinishedAt 在一轮通过检查点结束时写入，新一轮开始时清空；旧历史行保留 null 以免被误标未读。
    this.FinishedAt = init.FinishedAt ?? null;
    // WorkspaceRunID 和 WorkspaceLease 记录当前运行轮次持有的前台工作区租约，回收时仅释放匹配的精确令牌。
    this.WorkspaceRunID = init.WorkspaceRunID ?? "";
    this.WorkspaceLease = init.WorkspaceLease ?? "";
  }

  /**
   * 返回 GORM 映射的数据库表名。
   *
   * @returns {string} 表名 `"assistant_generations"`。
   */
  TableName() {
    return "assistant_generations";
  }
}

/**
 * 持久化在 `payload` 列中的生成完整快照，在公开的 `AssistantGeneration` 之上附带私有控制状态。
 * 用于保存原生工具审批列表和引导关闭标记。
 */
class assistantGenerationPayload extends AssistantGeneration {
  /**
   * 构造并初始化带私有控制状态的生成负载对象。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
    this.NativeApprovals = init.NativeApprovals ?? [];
    this.SteeringClosed = init.SteeringClosed ?? false;
  }
}

// 运行中轮次允许缺少持久化心跳的最长时长（毫秒），超时后非持有方读取时会判定其已中断。
const assistantHeartbeatTimeout = 45 * 1000;

// 目标生成轮次已结束或不存在时抛出的标准错误。
const errAssistantGenerationEnded = new Error("生成已结束或不存在");

/**
 * 表示被超时回收的生成轮次此前持有的前台工作区租约标识。
 */
class AssistantGenerationLease {
  /**
   * 构造并初始化工作区租约标识对象。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.RunID = init.RunID ?? "";
    this.Token = init.Token ?? "";
  }
}

/**
 * 将生成表行中的 JSON 字节解码为含私有控制字段的 `assistantGenerationPayload`。
 * 解码失败时按 Go 原语义忽略错误并返回零值实例。
 *
 * @param {assistantGenerationRow} row - 数据库查询得到的生成行记录。
 * @returns {assistantGenerationPayload} 解码后的完整生成负载对象。
 */
function generationPayload(row) {
  let parsed = {};
  try {
    parsed = JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8"));
  } catch (err) {
    // Go 忽略解码错误。
  }
  return new assistantGenerationPayload(parsed);
}

/**
 * 将生成表行解码为对外暴露的领域对象 `AssistantGeneration`，并用行上的权威列值覆盖状态字段。
 *
 * @param {assistantGenerationRow} row - 数据库查询得到的生成行记录。
 * @returns {AssistantGeneration} 解码后的领域层生成状态对象。
 */
function decodeGeneration(row) {
  let parsed = {};
  try {
    parsed = JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8"));
  } catch (err) {
    // Go 忽略解码错误。
  }
  const g = new AssistantGeneration(parsed);
  g.UserID = row.UserID;
  g.Status = row.Status;
  g.CancelRequested = row.CancelRequested;
  g.UpdatedAt = row.UpdatedAt;
  return g;
}

/**
 * 只读查看会话最新一轮生成的状态，不触发超时回收判定。
 * 供正在执行该轮生成的持有方使用，避免慢提交导致仍在运行的进程被误判为已死亡。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} sessionID - 会话 ID。
 * @returns {[AssistantGeneration, boolean]} 元组 `[生成状态, 是否存在]`。
 */
AssistantRepo.prototype.PeekAssistantGeneration = function (userID, sessionID) {
  const [row, ok] = this.loadAssistantGeneration(userID, sessionID);
  if (!ok) {
    return [new AssistantGeneration(), false];
  }
  return [decodeGeneration(row), true];
};

/**
 * 按用户 ID 与会话 ID 查询原始生成表行记录。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} sessionID - 会话 ID。
 * @returns {[assistantGenerationRow, boolean]} 元组 `[行记录, 是否查到]`。
 */
AssistantRepo.prototype.loadAssistantGeneration = function (userID, sessionID) {
  const row = new assistantGenerationRow();
  const err = this.DB.Where("session_id = ? AND user_id = ?", sessionID, userID).Take(row).Error;
  if (err != null) {
    return [new assistantGenerationRow(), false];
  }
  return [row, true];
};

/**
 * 读取会话最新一轮生成状态；若心跳已超时则顺带执行中断回收。
 * 适用于不需感知工作区租约释放的普通读取场景。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} sessionID - 会话 ID。
 * @returns {[AssistantGeneration, boolean]} 元组 `[生成状态, 是否存在]`。
 */
AssistantRepo.prototype.AssistantGeneration = function (userID, sessionID) {
  const [g, , ok] = this.ReapAssistantGeneration(userID, sessionID);
  return [g, ok];
};

/**
 * 读取会话最新一轮生成状态，并在心跳超时时将其原子更新为 `"interrupted"` 并写入诊断记录。
 * 仅真正赢得条件更新的调用方会收到该轮持有的工作区租约，从而保证租约最多被释放一次。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} sessionID - 会话 ID。
 * @returns {[AssistantGeneration, AssistantGenerationLease, boolean]} 元组 `[生成状态, 待释放的工作区租约, 是否存在]`。
 */
AssistantRepo.prototype.ReapAssistantGeneration = function (userID, sessionID) {
  const [firstRow, firstOK] = this.loadAssistantGeneration(userID, sessionID);
  if (!firstOK) {
    return [new AssistantGeneration(), new AssistantGenerationLease(), false];
  }
  let row = firstRow;
  let lease = new AssistantGenerationLease();
  // 服务端进程宕机不能让会话永久卡死；同时绝不自动重放模型轮次，因为工具可能已产生写入副作用。
  if (row.Status === "running" && this.heartbeatLate(this.DB, row.UpdatedAt)) {
    const g = decodeGeneration(row);
    g.Status = "interrupted";
    g.Error = "服务端生成已中断，请检查已执行操作后重试";
    g.Failure = new AssistantFailure({ Code: "EXECUTION_INTERRUPTED", Phase: "server", Message: g.Error, Suggestion: "检查已执行操作后再重试；可下载诊断信息交给管理员排查。" });
    try {
      this.DB.Transaction((tx) => {
        const res = this.lateHeartbeatOnly(tx.Model(new assistantGenerationRow()).Where("session_id = ? AND generation_id = ? AND status = ? AND updated_at = ?", sessionID, row.GenerationID, "running", row.UpdatedAt)).Updates({ status: g.Status, payload: mustJSON(g), updated_at: this.generationClock() });
        if (res.Error != null) {
          throw res.Error;
        }
        if (res.RowsAffected !== 1) {
          return;
        }
        checkpointAssistantDiagnostics(tx, g, null);
        lease = new AssistantGenerationLease({ RunID: row.WorkspaceRunID, Token: row.WorkspaceLease });
      });
    } catch (err) {
      // Go 忽略回收事务的错误，继续重新加载行状态。
    }
    const [reloaded, reloadedOK] = this.loadAssistantGeneration(userID, sessionID);
    if (!reloadedOK) {
      return [new AssistantGeneration(), new AssistantGenerationLease(), false];
    }
    row = reloaded;
  }
  return [decodeGeneration(row), lease, true];
};

/**
 * 记录运行中生成轮次所持有的前台工作区租约信息，供后续超时回收时精确释放。
 * 本操作只更新租约列，不刷新心跳时间戳。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} sessionID - 会话 ID。
 * @param {string} generationID - 当前运行中的生成轮次 ID。
 * @param {string} runID - 工作区对应的运行 ID。
 * @param {string} token - 工作区租约令牌。
 * @returns {void} 无返回值。
 * @throws {Error} 当数据库更新出错时抛出错误。
 */
AssistantRepo.prototype.RecordAssistantGenerationWorkspaceLease = function (userID, sessionID, generationID, runID, token) {
  const err = this.DB.Model(new assistantGenerationRow())
    .Where("session_id = ? AND user_id = ? AND generation_id = ? AND status = ?", sessionID, userID, generationID, "running")
    .UpdateColumns({ workspace_run_id: runID, workspace_lease: token }).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 获取用于衡量心跳年龄的基准当前时间。
 * MySQL 下使用数据库自身的 `UTC_TIMESTAMP(3)` 以消除 API 主机与数据库之间的时钟偏移；
 * 读取失败时返回 `[null, false]`，调用方应保守视为心跳新鲜而不误回收。
 *
 * @param {Object} db - 当前使用的 GORM 数据库或事务句柄。
 * @returns {[Date|null, boolean]} 元组 `[当前 UTC 时间, 时钟是否可读]`。
 */
AssistantRepo.prototype.heartbeatNow = function (db) {
  if (!this.isMySQL()) {
    return [new Date(), true];
  }
  let now = null;
  const err = db.Raw("SELECT UTC_TIMESTAMP(3)").Scan(now).Error;
  if (err != null || now == null) {
    return [null, false];
  }
  return [now, true];
};

/**
 * 判断给定心跳更新时间在心跳基准时钟上是否已超过超时阈值（45 秒）。
 *
 * @param {Object} db - 当前使用的 GORM 数据库或事务句柄。
 * @param {Date|null} updatedAt - 记录中保存的最近一次心跳时间。
 * @returns {boolean} 心跳已超时返回 `true`，否则返回 `false`。
 */
AssistantRepo.prototype.heartbeatLate = function (db, updatedAt) {
  const [now, ok] = this.heartbeatNow(db);
  const updatedMs = updatedAt == null ? 0 : updatedAt.getTime();
  return ok && now.getTime() - updatedMs > assistantHeartbeatTimeout;
};

/**
 * 在 MySQL 下为回收更新追加数据库侧心跳超时条件，由数据库在提交时再次确认心跳确实已过期。
 *
 * @param {Object} q - 待追加条件的 GORM 查询构建器。
 * @returns {Object} 追加条件后的 GORM 查询构建器。
 */
AssistantRepo.prototype.lateHeartbeatOnly = function (q) {
  if (!this.isMySQL()) {
    return q;
  }
  return q.Where("updated_at < UTC_TIMESTAMP(3) - INTERVAL ? MICROSECOND", assistantHeartbeatTimeout * 1000); // Go 的 Microseconds：毫秒数 × 1000
};

/**
 * 返回写入心跳时间时使用的时钟值。
 * MySQL 下返回 SQL 表达式 `UTC_TIMESTAMP(3)`，避免提交阻塞导致预采样的主机时间落库即过期。
 *
 * @returns {Object|Date} MySQL 下返回 `clause.Expr` 表达式对象，其余数据库返回当前 `Date`。
 */
AssistantRepo.prototype.generationClock = function () {
  if (this.isMySQL()) {
    return new clause.Expr({ SQL: "UTC_TIMESTAMP(3)" });
  }
  return new Date();
};

/**
 * 开启会话的新一轮生成，可选同时校验并写入待发送的新会话消息与执行目标锁定标记。
 * 由于首次消息可能锁定尚不存在的会话行并引发 InnoDB 间隙锁死锁，内部通过 `retryAssistantDeadlock` 重试。
 *
 * @param {AssistantGeneration} g - 即将启动的生成轮次描述对象。
 * @param {...Object} pending - 可选待提交的会话对象（最多取第一个元素 `AssistantSession`）。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 当无权访问、会话或关联需求发生并发修改、已有运行中生成或数据库操作失败时抛出错误。
 */
AssistantRepo.prototype.BeginAssistantGeneration = async function (g, ...pending) {
  const { decodeAssistantSession } = require("./assistant.js"); // 循环引用：调用时现取，不缓存
  await this.retryAssistantDeadlock(() => {
    this.DB.Transaction((tx) => {
      const session = new assistantSessionRow();
      let err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ?", g.SessionID).Take(session).Error;
      if (err == null && session.UserID !== g.UserID) {
        throw new Error("无权访问会话");
      } else if (err != null && err !== gorm.ErrRecordNotFound) {
        throw err;
      }
      if (pending.length > 0) {
        const next = pending[0];
        next.ExecutionTargetLocked = true;
        const old = decodeAssistantSession(session);
        if (next.IssueID !== old.IssueID) {
          throw new Error("关联需求已更新，请重新发送");
        }
        if (next.Messages.length < old.Messages.length) {
          throw new Error("会话已更新，请重新打开后发送");
        }
        for (let i = 0; i < old.Messages.length; i++) {
          const a = JSON.stringify(old.Messages[i]);
          const b = JSON.stringify(next.Messages[i]);
          if (a !== b) {
            throw new Error("会话已更新，请重新打开后发送");
          }
        }
        const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
        scoped.DB = tx;
        const base = { ...this.deps, DB: tx };
        scoped.deps = base;
        scoped.putAssistantSession(g.UserID, next, g.ClientRequestID);
      } else if (session.ID !== "") {
        const item = decodeAssistantSession(session);
        item.ExecutionTargetLocked = true;
        err = tx.Model(new assistantSessionRow()).Where("id = ?", session.ID).UpdateColumn("payload", mustJSON(item)).Error;
        if (err != null) {
          throw err;
        }
      }

      const old = new assistantGenerationRow();
      err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ?", g.SessionID).Take(old).Error;
      if (err == null) {
        if (old.UserID !== g.UserID) {
          throw new Error("无权访问会话");
        }
        if (old.Status === "running") {
          throw new Error("此会话正在生成，请等待完成或停止");
        }
        err = tx.Model(old).Updates({ generation_id: g.ID, status: "running", cancel_requested: false, payload: mustJSON(g), updated_at: this.generationClock(), finished_at: null, workspace_run_id: "", workspace_lease: "" }).Error;
        if (err != null) {
          throw err;
        }
        checkpointAssistantDiagnostics(tx, g, null);
        return;
      }
      if (err !== gorm.ErrRecordNotFound) {
        throw err;
      }
      err = tx.Create(new assistantGenerationRow({ SessionID: g.SessionID, UserID: g.UserID, GenerationID: g.ID, Status: "running", Payload: mustJSON(g), UpdatedAt: new Date() })).Error;
      if (err != null) {
        throw err;
      }
      if (this.isMySQL()) {
        // 首次心跳同样使用数据库时钟，与后续所有心跳保持同一时间基准。
        err = tx.Model(new assistantGenerationRow()).Where("session_id = ?", g.SessionID).UpdateColumn("updated_at", this.generationClock()).Error;
        if (err != null) {
          throw err;
        }
      }
      checkpointAssistantDiagnostics(tx, g, null);
    });
  });
};

/**
 * 持久化当前生成轮次的检查点状态，并同步更新对应的诊断报告。
 *
 * @param {AssistantGeneration} g - 最新生成状态快照。
 * @param {...Object} diagnostics - 可选诊断报告列表（`AssistantDiagnostics`）。
 * @returns {void} 无返回值。
 * @throws {Error} 当生成状态已变化或数据库写入失败时抛出错误。
 */
AssistantRepo.prototype.CheckpointAssistantGeneration = function (g, ...diagnostics) {
  this.checkpointAssistantGeneration(g, true, diagnostics);
};

/**
 * 记录运行中的心跳检查点，但不重写未发生变化的诊断证据载荷。
 *
 * @param {AssistantGeneration} g - 当前运行中的生成状态快照。
 * @returns {void} 无返回值。
 * @throws {Error} 当生成状态已变化或数据库写入失败时抛出错误。
 */
AssistantRepo.prototype.HeartbeatAssistantGeneration = function (g) {
  this.checkpointAssistantGeneration(g, false, null);
};

/**
 * 在行锁事务中更新运行中生成轮次的状态、私有负载与结束时间，按需同步保存诊断信息。
 * 兼容 MySQL 相同载荷更新返回 `RowsAffected === 0` 的场景，避免误判存活轮次已消失。
 *
 * @param {AssistantGeneration} g - 待写入的生成状态快照。
 * @param {boolean} withDiagnostics - 是否同步写入诊断检查点。
 * @param {Array<Object>|null} diagnostics - 可选诊断报告列表。
 * @returns {void} 无返回值。
 * @throws {Error} 当生成已不处于运行态、已被替换或数据库写入失败时抛出错误。
 */
AssistantRepo.prototype.checkpointAssistantGeneration = function (g, withDiagnostics, diagnostics) {
  this.DB.Transaction((tx) => {
    let row;
    try {
      row = lockRunningAssistantGeneration(tx, g.UserID, g.SessionID, g.ID);
    } catch (err) {
      throw new Error("生成状态已变化");
    }
    const current = generationPayload(row);
    if (g.Steer == null && current.Steer != null) {
      g.Steer = current.Steer;
    }
    Object.assign(current, g); // Go：current.AssistantGeneration = g，内嵌字段直接覆盖
    if (g.Status !== "running" || row.CancelRequested) {
      current.NativeApprovals = null;
    }
    const now = new Date();
    const changes = { status: g.Status, payload: mustJSON(current), updated_at: this.generationClock() };
    if (g.Status !== "running") {
      changes.finished_at = now;
    }
    const res = tx.Model(row).Updates(changes);
    if (res.Error != null) {
      throw res.Error;
    }
    // MySQL 仅统计实际变更的行数；载荷与时间戳完全一致的心跳会报告 0 行，仍需二次确认而非直接取消存活 CLI。
    if (res.RowsAffected !== 1) {
      if (g.Status !== "running") {
        throw new Error("生成状态已变化");
      }
      const again = new assistantGenerationRow();
      const err = tx.Where("session_id = ? AND user_id = ? AND generation_id = ? AND status = ?", g.SessionID, g.UserID, g.ID, "running").Take(again).Error;
      if (err != null) {
        throw new Error("生成状态已变化");
      }
    }
    if (!withDiagnostics) {
      return;
    }
    checkpointAssistantDiagnostics(tx, g, diagnostics);
  });
};

/**
 * 在事务中对指定用户、会话与生成 ID 的运行中生成行加排他写锁并读取。
 *
 * @param {Object} tx - 当前事务的 GORM 句柄。
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} sessionID - 会话 ID。
 * @param {string} id - 生成轮次 ID。
 * @returns {assistantGenerationRow} 已加锁的运行中生成行记录。
 * @throws {Error} 当未找到匹配的运行中记录或查询出错时抛出错误。
 */
function lockRunningAssistantGeneration(tx, userID, sessionID, id) {
  const row = new assistantGenerationRow();
  const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ? AND user_id = ? AND generation_id = ? AND status = ?", sessionID, userID, id, "running").Take(row).Error;
  if (err != null) {
    throw err;
  }
  return row;
}

/**
 * 关闭当前生成轮次的引导（steer）接收窗口，并返回已接受的引导指令给执行 worker。
 * 在 worker 保存最终对话记录期间，生成本身仍保持 `"running"` 状态，但不再接受新的引导。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} sessionID - 会话 ID。
 * @param {string} id - 生成轮次 ID。
 * @returns {Object|null} 若已存在待处理的引导指令则返回该 `AssistantSteer` 对象，否则返回 `null`。
 * @throws {Error} 当生成不再运行或更新负载失败时抛出错误。
 */
AssistantRepo.prototype.CloseAssistantGenerationSteering = function (userID, sessionID, id) {
  let steer = null;
  this.DB.Transaction((tx) => {
    const row = lockRunningAssistantGeneration(tx, userID, sessionID, id);
    const payload = generationPayload(row);
    steer = payload.Steer;
    if (steer != null || payload.SteeringClosed) {
      return;
    }
    payload.SteeringClosed = true;
    const err = tx.Model(row).Updates({ payload: mustJSON(payload), updated_at: this.generationClock() }).Error;
    if (err != null) {
      throw err;
    }
  });
  return steer;
};

/**
 * 为正在运行的生成轮次写入用户引导（steer）指令，同时置位取消标记并清空待决原生审批。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} sessionID - 会话 ID。
 * @param {string} id - 生成轮次 ID。
 * @param {Object} steer - 用户提交的引导指令对象（`AssistantSteer`）。
 * @returns {void} 无返回值。
 * @throws {Error} 当生成已结束、引导窗口已关闭、已有待处理引导或更新失败时抛出错误。
 */
AssistantRepo.prototype.SteerAssistantGeneration = function (userID, sessionID, id, steer) {
  this.DB.Transaction((tx) => {
    let row;
    try {
      row = lockRunningAssistantGeneration(tx, userID, sessionID, id);
    } catch (err) {
      throw errAssistantGenerationEnded;
    }
    const payload = generationPayload(row);
    if (payload.Steer != null) {
      throw new Error("本轮已有待处理的引导，请稍后重试");
    }
    if (payload.SteeringClosed) {
      throw errAssistantGenerationEnded;
    }
    payload.Steer = steer;
    payload.NativeApprovals = null;
    const err = tx.Model(row).Updates({ cancel_requested: true, payload: mustJSON(payload), updated_at: this.generationClock() }).Error;
    if (err != null) {
      throw err;
    }
  });
};

/**
 * 为指定的运行中生成轮次标记取消请求（`cancel_requested = true`）。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} sessionID - 会话 ID。
 * @param {string} id - 生成轮次 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 当数据库更新出错或未匹配到运行中记录时抛出错误。
 */
AssistantRepo.prototype.CancelAssistantGeneration = function (userID, sessionID, id) {
  const res = this.DB.Model(new assistantGenerationRow()).Where("session_id = ? AND user_id = ? AND generation_id = ? AND status = ?", sessionID, userID, id, "running").Update("cancel_requested", true);
  if (res.Error != null) {
    throw res.Error;
  }
  if (res.RowsAffected !== 1) {
    throw errAssistantGenerationEnded;
  }
};

/**
 * 表示历史会话列表面向单个读者展示的最新一轮回复状态与已读标记。
 */
class AssistantGenerationState {
  /**
   * 构造并初始化生成状态摘要对象。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Status = init.Status ?? "";
    // FinishedAt 为回复结束时间；历史老数据无此值，以便已读追踪不误标旧会话。
    this.FinishedAt = init.FinishedAt ?? null;
    // Seen 表示读者自该轮回复后是否已打开过会话。
    this.Seen = init.Seen ?? false;
    // Stale 表示库中仍记为 running 但心跳已超时的轮次，此时对外读作 interrupted 但尚未落库。
    this.Stale = init.Stale ?? false;
  }
}

/**
 * 通过单次关联查询批量读取多个会话的最新生成状态及指定读者的已读情况。
 * 供历史会话列表页一次性渲染运行态、超时态与未读小红点。
 *
 * @param {number} readerID - 当前查看列表的读者用户 ID。
 * @param {Array<string>} ids - 待查询的会话 ID 列表。
 * @returns {Object<string, AssistantGenerationState>} 以会话 ID 为键、最新生成状态摘要为值的映射对象。
 */
AssistantRepo.prototype.AssistantGenerationStatuses = function (readerID, ids) {
  const out = {};
  if (ids.length === 0) {
    return out;
  }
  const rows = [];
  const err = this.DB.Table("assistant_generations AS g")
    .Select("g.session_id, g.generation_id, g.status, g.updated_at, g.finished_at, r.generation_id AS read_id")
    .Joins("LEFT JOIN assistant_session_reads AS r ON r.session_id = g.session_id AND r.user_id = ?", readerID)
    .Where("g.session_id IN ?", ids)
    .Scan(rows).Error;
  if (err != null) {
    return out;
  }
  const [now, clockOK] = this.heartbeatNow(this.DB);
  for (const row of rows) {
    let status = row.Status;
    const updatedMs = row.UpdatedAt == null ? 0 : row.UpdatedAt.getTime();
    const stale = status === "running" && clockOK && now.getTime() - updatedMs > assistantHeartbeatTimeout;
    if (stale) {
      status = "interrupted";
    }
    out[row.SessionID] = new AssistantGenerationState({
      ID: row.GenerationID,
      Status: status,
      FinishedAt: row.FinishedAt,
      Seen: row.ReadID != null && row.ReadID === row.GenerationID,
      Stale: stale,
    });
  }
  return out;
};

module.exports = { assistantGenerationRow, assistantGenerationPayload, assistantHeartbeatTimeout, errAssistantGenerationEnded, AssistantGenerationLease, generationPayload, decodeGeneration, lockRunningAssistantGeneration, AssistantGenerationState };
