/**
 * @file internal/repo/runners.js
 * 对应 Go 源文件：internal/repo/runners.go
 *
 * 作用与职责边界：
 * 实现 `RunnersRepo` 的全部 CLI 执行机器（Runner）注册表、会话校验、心跳与运行时配置、
 * 执行任务队列的入队/认领/启动/租约续期/完成/取消/过期回收、任务事件流幂等追加与增量读取、
 * 执行机器注销清理以及用户默认执行机器偏好的持久化逻辑。
 * 任务状态始终落库持久化，执行机断连仅影响派发投递而不丢失任务本身。
 * 不负责 HTTP/WebSocket 连接管理、命令实际执行或工作区物化。
 *
 * 语法差异说明：
 * - `RunnersRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `RunnersRepo.prototype` 挂载各领域方法。
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；
 *   `(值1, 值2, error)` 成功返回 `[值1, 值2]`、失败 `throw err`；`db.Transaction(tx => ...)` 回调同样遵循失败抛错、成功正常返回。
 * - Go 的 `(值, bool)` 返回值译为 `[值, boolean]` 元组。
 * - Go 的 `map[string]V` / `map[string]bool` 译为普通对象 `{}`；`time.Time` 对应 `Date`（零值 `null`），`time.Duration` 换算为毫秒数。
 * - Go 的结构体按值传参与 `json.Marshal` `omitempty` 标签在 JS 中分别通过浅拷贝与 `toJSON()` 显式复现。
 */

"use strict";

const { Buffer } = require("node:buffer");

const { Runner, RunnerStatusOnline, RunnerStatusOffline, RunnerTaskQueued, RunnerTaskLeased, RunnerTaskRunning, RunnerTaskSuccess, RunnerTaskFailed, RunnerTaskCanceled, RunnerTaskDesiredCancel, RuntimeStatusOnline, RuntimeStatusDisabled, RuntimeAuthLocal, RuntimeAuthPersonal, SupportsRunnerLogin, RunnerTask, RunnerTaskEvent } = require("../domain/runner.js"); // 对应 Go 的 domain.*，runner.js 已翻译
const { IsAgentCLIKind } = require("../domain/agent.js"); // 对应 Go 的 domain.IsAgentCLIKind，agent.js 已翻译
const { RunnersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runnerRow, runnerTaskRow, userRunnerPrefRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { upsert, insertIgnore, timePtr, jsonBytes, mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { isZeroTime, timeMs } = require("./analytics.js"); // 对应 Go 的时间比较，analytics.js 已翻译
const { lockAdmissionGate, admissionBucketKey } = require("./run_admission.js"); // 对应 Go 同包函数，run_admission.js 已翻译

// 执行任务当前不可认领时抛出的哨兵错误。
const ErrRunnerTaskNotClaimable = new Error("runner task is not claimable");
// 执行任务租约归属已变更或不再处于可续期/可完成状态时抛出的哨兵错误。
const ErrRunnerTaskLeaseLost = new Error("runner task lease ownership changed");
// 目标执行机器不存在时抛出的哨兵错误。
const ErrRunnerNotFound = new Error("runner not found");

/**
 * 持久化在 `runner_tasks.payload` 列中的执行任务 JSON 载荷结构。
 * 用于解耦任务调度索引列与可变执行详情（提示词、参数、调用规格、产物与输出等）。
 */
class runnerTaskPayload {
  /**
   * 构造执行任务载荷对象，缺省字段严格按 Go 零值初始化（切片为 `[]`，映射为 `{}`，指针为 `null`）。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Prompt = init.Prompt ?? "";
    this.Workspace = init.Workspace ?? "";
    this.Args = init.Args ?? [];
    this.ExitCode = init.ExitCode ?? null;
    this.Result = init.Result ?? "";
    this.Error = init.Error ?? "";
    this.StartedAt = init.StartedAt ?? null;
    this.CompletedAt = init.CompletedAt ?? null;
    this.RunID = init.RunID ?? "";
    this.NodeID = init.NodeID ?? "";
    this.Invocation = init.Invocation ?? null;
    this.Sandbox = init.Sandbox ?? null;
    this.Command = init.Command ?? "";
    this.Action = init.Action ?? "";
    this.PreviewArchive = init.PreviewArchive ?? null;
    this.WorkBranchMessage = init.WorkBranchMessage ?? "";
    this.IntegrationLabel = init.IntegrationLabel ?? "";
    this.Artifacts = init.Artifacts ?? {};
    this.Outputs = init.Outputs ?? null;
  }

  /**
   * 按 Go 结构体 JSON 标签与 `omitempty` 语义生成序列化对象，供 `JSON.stringify` 自动调用。
   *
   * @returns {Object.<string, *>} 带小写驼峰键名且已省略空字段的纯 JSON 对象。
   */
  toJSON() {
    const out = { prompt: this.Prompt };
    if (this.Workspace !== "") {
      out.workspace = this.Workspace;
    }
    if ((this.Args ?? []).length > 0) {
      out.args = this.Args;
    }
    if (this.ExitCode != null) {
      out.exitCode = this.ExitCode;
    }
    if (this.Result !== "") {
      out.result = this.Result;
    }
    if (this.Error !== "") {
      out.error = this.Error;
    }
    if (this.StartedAt != null) {
      out.startedAt = this.StartedAt.toJSON();
    }
    if (this.CompletedAt != null) {
      out.completedAt = this.CompletedAt.toJSON();
    }
    if (this.RunID !== "") {
      out.runId = this.RunID;
    }
    if (this.NodeID !== "") {
      out.nodeId = this.NodeID;
    }
    if (this.Invocation != null) {
      out.invocation = this.Invocation;
    }
    if (this.Sandbox != null) {
      out.sandbox = this.Sandbox;
    }
    if (this.Command !== "") {
      out.command = this.Command;
    }
    if (this.Action !== "") {
      out.action = this.Action;
    }
    if (this.PreviewArchive != null) {
      out.previewArchive = this.PreviewArchive;
    }
    if (this.WorkBranchMessage !== "") {
      out.workBranchMessage = this.WorkBranchMessage;
    }
    if (this.IntegrationLabel !== "") {
      out.integrationLabel = this.IntegrationLabel;
    }
    if (this.Artifacts != null && Object.keys(this.Artifacts).length > 0) {
      out.artifacts = this.Artifacts;
    }
    if (this.Outputs != null) {
      out.outputs = this.Outputs;
    }
    return out;
  }
}

/**
 * 兼容新旧两种写入格式（RFC3339 与历史 MySQL `JSON_SET` DATETIME 字符串）的任务时间戳包装类型。
 * 单个时间字段解析失败时静默回退为零值 `null`，避免丢弃整条任务载荷。
 */
class runnerTaskTime {
  /**
   * 构造任务时间包装对象，对应 Go 内嵌的 `time.Time` 字段。
   *
   * @param {Date | null} [time=null] - 初始时间值，零值以 `null` 表达。
   * @returns {void} 无返回值。
   */
  constructor(time = null) {
    this.Time = time;
  }

  /**
   * 从原始 JSON 文本解析时间戳并转为 UTC `Date`，依次兼容 RFC3339 与无时区 DATETIME 格式。
   * 解析失败时不抛错，保持 `this.Time` 为零值。
   *
   * @param {string | Buffer} raw - 原始 JSON 字符串或字节内容。
   * @returns {void} 无返回值。
   */
  UnmarshalJSON(raw) {
    const s = String(raw).trim().replace(/^"+|"+$/g, "");
    if (s === "" || s === "null") {
      return;
    }
    // Go：依次尝试 RFC3339Nano、RFC3339 与两种无时区格式；解析失败保留零值。
    let parsed = NaN;
    const naive = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(s);
    if (naive != null) {
      const frac = (naive[7] ?? "").slice(0, 3).padEnd(3, "0");
      parsed = Date.UTC(+naive[1], +naive[2] - 1, +naive[3], +naive[4], +naive[5], +naive[6], frac === "" ? 0 : +frac);
    } else {
      parsed = Date.parse(s);
    }
    if (!Number.isNaN(parsed)) {
      this.Time = new Date(parsed);
    }
  }

  /**
   * 将时间格式化为 UTC RFC3339Nano JSON 字符串。
   *
   * @returns {string} JSON 编码后的时间字符串（零值时返回 `"null"`）。
   */
  MarshalJSON() {
    if (this.Time == null) {
      return "null";
    }
    // Go：t.Time.UTC().Format(time.RFC3339Nano)。
    const iso = this.Time.toISOString().replace(/\.000Z$/, "Z").replace(/(\.\d+?)0+Z$/, "$1Z");
    return JSON.stringify(iso);
  }

  /**
   * 供 `JSON.stringify` 调用的序列化钩子，返回去掉外层引号的 ISO 时间字符串或 `null`。
   *
   * @returns {string | null} 序列化后的时间字符串或 `null`。
   */
  toJSON() {
    const raw = this.MarshalJSON();
    return raw === "null" ? null : JSON.parse(raw);
  }

  /**
   * 将包装时间戳还原为普通 `Date` 或 `null`，零值时返回 `null` 以便 JSON 省略。
   *
   * @returns {Date | null} 有效时间返回 `Date` 实例，零值返回 `null`。
   */
  toTime() {
    if (this.Time == null) {
      return null;
    }
    return this.Time;
  }
}

/**
 * 解析 JSON 对象中的单个时间字段为 `runnerTaskTime` 实例（补足 JS 无自动按类型分发 `UnmarshalJSON` 的差异）。
 *
 * @param {*} value - 从 JSON 对象中取出的原始时间字段值。
 * @returns {runnerTaskTime} 解析后的 `runnerTaskTime` 实例。
 */
function parseRunnerTaskTime(value) {
  const t = new runnerTaskTime();
  if (value != null) {
    t.UnmarshalJSON(JSON.stringify(value));
  }
  return t;
}

/**
 * 将可选的 `Date` 包装为 `runnerTaskTime`；输入为 `null`/`undefined` 时返回 `null`。
 *
 * @param {Date | null | undefined} v - 原始时间值。
 * @returns {runnerTaskTime | null} 包装后的 `runnerTaskTime` 或 `null`。
 */
function newRunnerTaskTime(v) {
  if (v == null) {
    return null;
  }
  return new runnerTaskTime(v);
}

/**
 * 将数据库 `runner_tasks` 表行模型映射为领域对象 `RunnerTask`，并尽力解码其中的 JSON 载荷。
 *
 * @param {runnerTaskRow} row - 数据库任务行模型。
 * @returns {RunnerTask} 组装完成的执行任务领域对象。
 */
function runnerTaskFromRow(row) {
  const t = new RunnerTask({
    ID: row.ID, RunnerID: row.RunnerID, Provider: row.Provider, Status: row.Status,
    LeaseOwner: row.LeaseOwner, DesiredState: row.DesiredState,
    Attempt: row.Attempt, MaxAttempts: row.MaxAttempts,
    CreatedAt: null, UpdatedAt: null,
  });
  if (row.LeaseUntil != null) {
    t.LeaseUntil = row.LeaseUntil;
  }
  if (row.Created != null) {
    t.CreatedAt = row.Created;
  }
  if (row.Updated != null) {
    t.UpdatedAt = row.Updated;
  }
  let raw = null;
  try {
    raw = JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8"));
  } catch {
    // Go：解码失败时只保留行里的字段。
  }
  if (raw != null && typeof raw === "object") {
    const p = new runnerTaskPayload({
      Prompt: raw.prompt ?? "", Workspace: raw.workspace ?? "", Args: raw.args ?? [],
      ExitCode: raw.exitCode ?? null, Result: raw.result ?? "", Error: raw.error ?? "",
      StartedAt: parseRunnerTaskTime(raw.startedAt), CompletedAt: parseRunnerTaskTime(raw.completedAt),
      RunID: raw.runId ?? "", NodeID: raw.nodeId ?? "", Invocation: raw.invocation ?? null,
      Sandbox: raw.sandbox ?? null, Command: raw.command ?? "", Action: raw.action ?? "",
      PreviewArchive: raw.previewArchive ?? null, WorkBranchMessage: raw.workBranchMessage ?? "",
      IntegrationLabel: raw.integrationLabel ?? "", Artifacts: raw.artifacts ?? {}, Outputs: raw.outputs ?? null,
    });
    t.Prompt = p.Prompt;
    t.Workspace = p.Workspace;
    t.Args = p.Args;
    t.ExitCode = p.ExitCode;
    t.Result = p.Result;
    t.Error = p.Error;
    t.StartedAt = p.StartedAt.toTime();
    t.CompletedAt = p.CompletedAt.toTime();
    t.RunID = p.RunID;
    t.NodeID = p.NodeID;
    t.Invocation = p.Invocation;
    t.Sandbox = p.Sandbox;
    t.Command = p.Command;
    t.Action = p.Action;
    t.PreviewArchive = p.PreviewArchive;
    t.WorkBranchMessage = p.WorkBranchMessage;
    t.IntegrationLabel = p.IntegrationLabel;
    t.Artifacts = p.Artifacts;
    t.Outputs = p.Outputs;
  }
  return t;
}

/**
 * 将领域对象 `RunnerTask` 编码为待写入 `payload` 列的 JSON 字节缓冲区。
 * 编码前会复制调用规格并剥离临时 Git SSH 密钥与 HTTP 凭据，防止敏感凭据落盘。
 *
 * @param {RunnerTask} v - 执行任务领域对象。
 * @returns {Buffer} 序列化后的 UTF-8 JSON `Buffer`。
 */
function runnerTaskPayloadBytes(v) {
  // Go 按值传参，JS 先复制一份再剥离凭据。
  v = { ...v };
  if (v.Invocation != null && ((v.Invocation.GitSSHKeys ?? []).length > 0 || v.Invocation.GitHTTPCredentials != null)) {
    const invocation = { ...v.Invocation };
    invocation.GitSSHKeys = null;
    invocation.GitHTTPCredentials = null;
    v.Invocation = invocation;
  }
  return mustJSON(new runnerTaskPayload({
    Prompt: v.Prompt, Workspace: v.Workspace, Args: v.Args, ExitCode: v.ExitCode,
    Result: v.Result, Error: v.Error, StartedAt: newRunnerTaskTime(v.StartedAt),
    CompletedAt: newRunnerTaskTime(v.CompletedAt), RunID: v.RunID, NodeID: v.NodeID,
    Invocation: v.Invocation, Sandbox: v.Sandbox, Command: v.Command, Action: v.Action,
    PreviewArchive: v.PreviewArchive, WorkBranchMessage: v.WorkBranchMessage, Artifacts: v.Artifacts,
    Outputs: v.Outputs, IntegrationLabel: v.IntegrationLabel,
  }));
}

/**
 * 将 `RunnerTask` 转换为写入 `runner_tasks` 表所需的列名到列值映射对象。
 *
 * @param {RunnerTask} v - 执行任务领域对象。
 * @returns {Object.<string, *>} 数据库列名到列值的映射。
 */
function runnerTaskRowValues(v) {
  return {
    id: v.ID, runner_id: v.RunnerID, provider: v.Provider, status: v.Status,
    lease_owner: v.LeaseOwner, lease_until: v.LeaseUntil, desired_state: v.DesiredState,
    attempt: v.Attempt, max_attempts: v.MaxAttempts, payload: runnerTaskPayloadBytes(v),
    created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  };
}

/**
 * 按主键从 `runner_tasks` 表读取单条任务行记录。
 *
 * @param {object} db - `gorm.DB` 数据库或事务句柄。
 * @param {string} id - 任务主键 ID。
 * @returns {[runnerTaskRow, boolean]} 找到时返回 `[行对象, true]`，否则返回 `[空行对象, false]`。
 */
function takeRunnerTask(db, id) {
  const row = new runnerTaskRow();
  if (db.Where("id = ?", id).Take(row).Error != null) {
    return [new runnerTaskRow(), false];
  }
  return [row, true];
}

// ---------- Runner registry ----------

/**
 * 注册或更新一台 CLI 执行机器记录（故意不写 `run_limit` 列，避免重连覆盖用户配置的并发上限）。
 * 会补齐默认创建时间、离线状态与最小并发数 `1`。
 *
 * @param {Runner} v - 待保存的执行机器领域对象。
 * @returns {void} 无返回值。
 * @throws {Error} 缺少执行机 ID 或数据库写入失败时抛出错误。
 */
RunnersRepo.prototype.PutRunner = function (v) {
  if (v.ID.trim() === "") {
    throw new Error("runner id is required");
  }
  const now = new Date();
  if (isZeroTime(v.CreatedAt)) {
    v.CreatedAt = now;
  }
  v.UpdatedAt = now;
  if (v.Status === "") {
    v.Status = RunnerStatusOffline;
  }
  if (v.MaxConcurrency < 1) {
    v.MaxConcurrency = 1;
  }
  upsert(this.DB, "runners", {
    id: v.ID, name: v.Name, status: v.Status, os: v.OS, arch: v.Arch,
    runner_version: v.RunnerVersion, labels: jsonBytes(v.Labels), max_concurrency: v.MaxConcurrency,
    native_sandbox_available: v.NativeSandboxAvailable,
    owner_user_id: nullableInt64(v.OwnerUserID), session_token_hash: v.SessionTokenHash,
    session_expires_at: v.SessionExpiresAt, runtimes: jsonBytes(v.Runtimes),
    last_seen_at: v.LastSeenAt, created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  });
};

// 用户可为单台个人执行机器配置的最大同时运行数上限。
const MaxRunnerRunLimit = 100;

/**
 * 设置单台执行机器的并发运行上限（`run_limit` 列的唯一写入口；`0` 表示不限制并存为 `NULL`）。
 * 写入前仅锁定该执行机对应的准入分桶锁，防止上限修改与同机器准入决策交错。
 *
 * @param {string} id - 执行机器 ID。
 * @param {number} limit - 目标同时运行条数上限（范围 `0..MaxRunnerRunLimit`）。
 * @returns {void} 无返回值。
 * @throws {Error} 上限超出范围、执行机不存在（`ErrRunnerNotFound`）或事务更新失败时抛出错误。
 */
RunnersRepo.prototype.SetRunnerRunLimit = function (id, limit) {
  if (limit < 0 || limit > MaxRunnerRunLimit) {
    throw new Error(`最多同时运行条数需在 0-${MaxRunnerRunLimit} 之间（0 表示不限制）`);
  }
  let value = null;
  if (limit > 0) {
    value = limit;
  }
  this.DB.Transaction((tx) => {
    lockAdmissionGate(this, tx, admissionBucketKey("", id, true));
    const res = tx.Model(new runnerRow()).Where("id = ?", id).Updates({ run_limit: value, updated_at: new Date() });
    if (res.Error != null) {
      throw res.Error;
    }
    if (res.RowsAffected === 0) {
      throw ErrRunnerNotFound;
    }
  });
};

/**
 * 按主键 ID 查询单台执行机器记录。
 *
 * @param {string} id - 执行机器 ID。
 * @returns {[Runner, boolean]} 找到时返回 `[执行机对象, true]`，否则返回 `[空 Runner, false]`。
 */
RunnersRepo.prototype.Runner = function (id) {
  return this.runnerRow(id);
};

/**
 * 从 `runners` 表按主键读取并转换单台执行机器记录。
 * 供 `Runner`、心跳合并及运行时配置修改内部复用。
 *
 * @param {string} id - 执行机器 ID。
 * @returns {[Runner, boolean]} 找到时返回 `[执行机对象, true]`，否则返回 `[空 Runner, false]`。
 */
RunnersRepo.prototype.runnerRow = function (id) {
  const row = new runnerRow();
  if (this.DB.Where("id = ?", id).Take(row).Error != null) {
    return [new Runner(), false];
  }
  return [runnerFromRow(row), true];
};

/**
 * 将数据库 `runners` 表行模型映射为领域对象 `Runner`，并解码标签与运行时清单 JSON。
 *
 * @param {runnerRow} row - 数据库执行机行模型。
 * @returns {Runner} 组装完成的执行机器领域对象。
 */
function runnerFromRow(row) {
  const v = new Runner({
    ID: row.ID, Name: row.Name, Status: row.Status, OS: row.OS, Arch: row.Arch,
    RunnerVersion: row.RunnerVersion, MaxConcurrency: row.MaxConcurrency,
    NativeSandboxAvailable: row.NativeSandboxAvailable,
    SessionTokenHash: row.SessionTokenHash,
  });
  if (row.OwnerUserID != null) {
    v.OwnerUserID = row.OwnerUserID;
  }
  if (row.RunLimit != null && row.RunLimit > 0) {
    v.RunLimit = row.RunLimit;
  }
  if ((row.Labels ?? []).length > 0) {
    try {
      v.Labels = JSON.parse(typeof row.Labels === "string" ? row.Labels : Buffer.from(row.Labels).toString("utf8"));
    } catch {
      // Go 忽略解码错误。
    }
  }
  if ((row.Runtimes ?? []).length > 0) {
    try {
      v.Runtimes = JSON.parse(typeof row.Runtimes === "string" ? row.Runtimes : Buffer.from(row.Runtimes).toString("utf8"));
    } catch {
      // Go 忽略解码错误。
    }
  }
  if (row.SessionExpiresAt != null) {
    v.SessionExpiresAt = row.SessionExpiresAt;
  }
  if (row.LastSeenAt != null) {
    v.LastSeenAt = row.LastSeenAt;
  }
  if (row.Created != null) {
    v.CreatedAt = row.Created;
  }
  if (row.Updated != null) {
    v.UpdatedAt = row.Updated;
  }
  return v;
}

/**
 * 按创建时间升序列出全部已注册的 CLI 执行机器。
 *
 * @returns {Runner[]} 执行机器领域对象数组；查询失败时返回空数组。
 */
RunnersRepo.prototype.Runners = function () {
  const rows = [];
  if (this.DB.Order("created_at").Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    out.push(runnerFromRow(row));
  }
  return out;
};

/**
 * 通过会话令牌哈希查找对应的执行机器，并拒绝已过期的会话令牌。
 * 使用场景：CLI 守护进程请求认证中间件校验 Runner 身份。
 *
 * @param {string} hash - 会话令牌哈希字符串。
 * @returns {[Runner, boolean]} 命中且未过期时返回 `[执行机对象, true]`，否则返回 `[空 Runner, false]`。
 */
RunnersRepo.prototype.RunnerSessionByHash = function (hash) {
  hash = hash.trim();
  if (hash === "") {
    return [new Runner(), false];
  }
  const row = new runnerRow();
  if (this.DB.Where("session_token_hash = ?", hash).Take(row).Error != null) {
    return [new Runner(), false];
  }
  if (row.SessionExpiresAt != null && row.SessionExpiresAt.getTime() <= Date.now()) {
    return [new Runner(), false];
  }
  return [runnerFromRow(row), true];
};

/**
 * 记录执行机器心跳与最新上报的 CLI 运行时清单。
 * 会保留服务端已设置的运行时禁用状态（`disabled`）与认证模式偏好（`authMode`），不被守护进程心跳覆盖。
 *
 * @param {string} id - 执行机器 ID。
 * @param {import("../domain/runner.js").RunnerRuntime[]} runtimes - 守护进程上报的运行时清单（会被就地合并服务端偏好）。
 * @param {string} version - 执行机版本号（非空时同步更新）。
 * @param {boolean} nativeSandboxAvailable - 当前执行机是否支持本地轻量隔离沙箱。
 * @param {Date} now - 当前心跳时间。
 * @param {Date} sessionExpiresAt - 续期后的会话过期时间。
 * @returns {void} 无返回值。
 * @throws {Error} 序列化失败、执行机不存在（`ErrRunnerNotFound`）或数据库更新失败时抛出错误。
 */
RunnersRepo.prototype.RunnerHeartbeat = function (id, runtimes, version, nativeSandboxAvailable, now, sessionExpiresAt) {
  const [current, ok] = this.runnerRow(id);
  const disabled = {};
  const authModes = {};
  if (ok) {
    for (const rt of current.Runtimes ?? []) {
      if (rt.Status === RuntimeStatusDisabled) {
        disabled[rt.Provider] = true;
      }
      if (rt.AuthMode === RuntimeAuthLocal || rt.AuthMode === RuntimeAuthPersonal) {
        authModes[rt.Provider] = rt.AuthMode;
      }
    }
  }
  for (let i = 0; i < runtimes.length; i++) {
    if (disabled[runtimes[i].Provider]) {
      runtimes[i].Status = RuntimeStatusDisabled;
    }
    if (IsAgentCLIKind(runtimes[i].Provider) && !SupportsRunnerLogin(runtimes[i].Provider)) {
      runtimes[i].AuthMode = RuntimeAuthPersonal;
    } else if ((authModes[runtimes[i].Provider] ?? "") !== "") {
      runtimes[i].AuthMode = authModes[runtimes[i].Provider];
    } else if (runtimes[i].Provider.toLowerCase() === "codebuddy") {
      runtimes[i].AuthMode = RuntimeAuthPersonal;
    } else {
      runtimes[i].AuthMode = RuntimeAuthLocal;
    }
  }
  const raw = JSON.stringify(runtimes);
  const updates = {
    native_sandbox_available: nativeSandboxAvailable,
    status: RunnerStatusOnline, last_seen_at: now, runtimes: raw,
    session_expires_at: sessionExpiresAt, updated_at: now,
  };
  version = version.trim();
  if (version !== "") {
    updates["runner_version"] = version;
  }
  const res = this.DB.Model(new runnerRow()).Where("id = ?", id).Updates(updates);
  if (res.Error != null) {
    throw res.Error;
  }
  if (res.RowsAffected === 0) {
    throw ErrRunnerNotFound;
  }
};

/**
 * 为执行机器上指定的 CLI 运行时设置认证模式（本机登录或负责人个人凭证）。
 * 服务端保存的该偏好不会被守护进程后续心跳覆盖。
 *
 * @param {string} runnerID - 执行机器 ID。
 * @param {string} provider - CLI 运行时提供方名称（不区分大小写）。
 * @param {string} authMode - 目标认证模式（`RuntimeAuthLocal` 或 `RuntimeAuthPersonal`）。
 * @param {Date} now - 更新时间。
 * @returns {void} 无返回值。
 * @throws {Error} 认证模式非法、该提供方仅支持个人凭证、执行机或运行时不存在或更新失败时抛出错误。
 */
RunnersRepo.prototype.SetRunnerRuntimeAuthMode = function (runnerID, provider, authMode, now) {
  if (authMode !== RuntimeAuthLocal && authMode !== RuntimeAuthPersonal) {
    throw new Error(`invalid runtime auth mode "${authMode}"`);
  }
  if (provider.toLowerCase() === "codebuddy" && authMode !== RuntimeAuthPersonal) {
    throw new Error("CodeBuddy 仅支持个人凭证");
  }
  if (IsAgentCLIKind(provider) && !SupportsRunnerLogin(provider) && authMode !== RuntimeAuthPersonal) {
    throw new Error(`${provider} 仅支持个人凭证`);
  }
  this.updateRunnerRuntimes(runnerID, (runtimes) => {
    let found = false;
    for (let i = 0; i < runtimes.length; i++) {
      if (runtimes[i].Provider.toLowerCase() === provider.toLowerCase()) {
        runtimes[i].AuthMode = authMode;
        found = true;
      }
    }
    if (!found) {
      throw new Error(`runtime "${provider}" not found on runner ${runnerID}`);
    }
    return true;
  }, now);
};

/**
 * 启用或禁用执行机器上已发现的某个 CLI 运行时；禁用后该运行时不再接收对应提供方的任务。
 *
 * @param {string} runnerID - 执行机器 ID。
 * @param {string} provider - CLI 运行时提供方名称（不区分大小写）。
 * @param {string} status - 目标状态（`RuntimeStatusOnline` 或 `RuntimeStatusDisabled`）。
 * @param {Date} now - 更新时间。
 * @returns {void} 无返回值。
 * @throws {Error} 状态非法、执行机或运行时不存在或更新失败时抛出错误。
 */
RunnersRepo.prototype.SetRunnerRuntimeStatus = function (runnerID, provider, status, now) {
  if (status !== RuntimeStatusOnline && status !== RuntimeStatusDisabled) {
    throw new Error(`invalid runtime status "${status}"`);
  }
  this.updateRunnerRuntimes(runnerID, (runtimes) => {
    let found = false;
    for (let i = 0; i < runtimes.length; i++) {
      if (runtimes[i].Provider.toLowerCase() === provider.toLowerCase()) {
        runtimes[i].Status = status;
        found = true;
      }
    }
    if (!found) {
      throw new Error(`runtime "${provider}" not found on runner ${runnerID}`);
    }
    return true;
  }, now);
};

/**
 * 读取指定执行机的运行时列表、应用修改回调并在发生变更时写回数据库。
 * 供 `SetRunnerRuntimeAuthMode` 与 `SetRunnerRuntimeStatus` 内部共用。
 *
 * @param {string} runnerID - 执行机器 ID。
 * @param {function(import("../domain/runner.js").RunnerRuntime[]): boolean} mutate - 运行时修改回调，返回是否发生变化，失败时抛错。
 * @param {Date} now - 更新时间。
 * @returns {void} 无返回值。
 * @throws {Error} 执行机不存在（`ErrRunnerNotFound`）、回调抛错、序列化失败或数据库更新失败时抛出错误。
 */
RunnersRepo.prototype.updateRunnerRuntimes = function (runnerID, mutate, now) {
  const [current, ok] = this.runnerRow(runnerID);
  if (!ok) {
    throw ErrRunnerNotFound;
  }
  const changed = mutate(current.Runtimes);
  if (!changed) {
    return;
  }
  const raw = JSON.stringify(current.Runtimes);
  const err = this.DB.Model(new runnerRow()).Where("id = ?", runnerID).Updates({
    runtimes: raw, updated_at: now,
  }).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 将心跳时间早于 `now - threshold` 的非离线执行机器批量标记为离线。
 * 由后台巡检任务定期调用，阈值策略由调用方决定。
 *
 * @param {number} threshold - 心跳超时阈值（毫秒数，对应 Go `time.Duration`）。
 * @param {Date} now - 当前基准时间。
 * @returns {void} 无返回值。
 */
RunnersRepo.prototype.MarkOfflineRunners = function (threshold, now) {
  if (this.DB == null) {
    return;
  }
  const cutoff = new Date(now.getTime() - threshold);
  this.DB.Model(new runnerRow()).
    Where("status <> ? AND last_seen_at IS NOT NULL AND last_seen_at < ?", RunnerStatusOffline, cutoff).
    Updates({ status: RunnerStatusOffline, updated_at: now });
};

/**
 * 记录守护进程主动断开连接并将执行机置为离线，同时保留其身份、会话与用户偏好供下次重启恢复。
 *
 * @param {string} id - 执行机器 ID。
 * @param {Date} now - 断开时间。
 * @returns {void} 无返回值。
 * @throws {Error} ID 为空、执行机不存在（`ErrRunnerNotFound`）或数据库更新失败时抛出错误。
 */
RunnersRepo.prototype.MarkRunnerOffline = function (id, now) {
  id = id.trim();
  if (id === "") {
    throw ErrRunnerNotFound;
  }
  const res = this.DB.Model(new runnerRow()).Where("id = ?", id).Updates({
    status: RunnerStatusOffline, updated_at: now,
  });
  if (res.Error != null) {
    throw res.Error;
  }
  if (res.RowsAffected === 0) {
    throw ErrRunnerNotFound;
  }
};

// ---------- Runner tasks ----------

/**
 * 插入或覆盖保存一条远程执行任务，自动补齐创建时间、排队初始状态与最小最大重试次数 `1`。
 *
 * @param {RunnerTask} v - 待保存的执行任务领域对象。
 * @returns {void} 无返回值。
 * @throws {Error} 缺少任务 ID 或提供方名称、或数据库写入失败时抛出错误。
 */
RunnersRepo.prototype.PutRunnerTask = function (v) {
  if (v.ID.trim() === "") {
    throw new Error("runner task id is required");
  }
  if (v.Provider.trim() === "") {
    throw new Error("runner task provider is required");
  }
  const now = new Date();
  if (isZeroTime(v.CreatedAt)) {
    v.CreatedAt = now;
  }
  if (v.Status === "") {
    v.Status = RunnerTaskQueued;
  }
  if (v.MaxAttempts < 1) {
    v.MaxAttempts = 1;
  }
  v.UpdatedAt = now;
  upsert(this.DB, "runner_tasks", runnerTaskRowValues(v));
};

/**
 * 按主键 ID 读取完整的远程执行任务记录（含 JSON 载荷）。
 *
 * @param {string} id - 任务主键 ID。
 * @returns {[RunnerTask, boolean]} 找到时返回 `[任务对象, true]`，否则返回 `[空 RunnerTask, false]`。
 */
RunnersRepo.prototype.RunnerTask = function (id) {
  const [row, ok] = takeRunnerTask(this.DB, id);
  if (!ok) {
    return [new RunnerTask(), false];
  }
  return [runnerTaskFromRow(row), true];
};

/**
 * 仅读取活跃执行机轮询控制通道所需的轻量字段（`id`、`desired_state`、`status`、`lease_owner`），
 * 跳过提示词、调用规格、结果与产物大字段以降低查询开销。
 *
 * @param {string} id - 任务主键 ID。
 * @returns {[RunnerTask, boolean]} 找到时返回 `[仅含控制字段的任务对象, true]`，否则返回 `[空 RunnerTask, false]`。
 */
RunnersRepo.prototype.RunnerTaskControl = function (id) {
  const row = new runnerTaskRow();
  if (this.DB.Select("id", "desired_state", "status", "lease_owner").Where("id = ?", id).Take(row).Error != null) {
    return [new RunnerTask(), false];
  }
  return [new RunnerTask({ ID: row.ID, DesiredState: row.DesiredState, Status: row.Status, LeaseOwner: row.LeaseOwner }), true];
};

/**
 * 按创建时间倒序查询最近 200 条执行任务记录。
 *
 * @returns {RunnerTask[]} 执行任务领域对象数组；查询失败时返回空数组。
 */
RunnersRepo.prototype.RunnerTasks = function () {
  const rows = [];
  if (this.DB.Order("created_at DESC").Limit(200).Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    out.push(runnerTaskFromRow(row));
  }
  return out;
};

/**
 * 只读检查是否存在可供指定执行机及其可用提供方认领的排队任务，不获取租约。
 *
 * @param {string} runnerID - 执行机器 ID。
 * @param {string[]} providers - 该执行机当前启用的提供方列表。
 * @returns {boolean} 存在符合条件的排队任务时返回 `true`，否则返回 `false`。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
RunnersRepo.prototype.RunnerTaskAvailable = function (runnerID, providers) {
  if (runnerID.trim() === "" || providers.length === 0) {
    return false;
  }
  const allowed = [];
  for (let provider of providers) {
    provider = provider.trim();
    if (provider !== "") {
      allowed.push(provider);
    }
  }
  if (allowed.length === 0) {
    return false;
  }
  const rows = [];
  const err = this.DB.Select("id").Where("status = ? AND (runner_id = '' OR runner_id = ?) AND provider IN ?", RunnerTaskQueued, runnerID, allowed).Limit(1).Find(rows).Error;
  if (err != null) {
    throw err;
  }
  return rows.length > 0;
};

/**
 * 在事务行锁内原子认领一条最旧的匹配排队任务（提供方在可用列表中且未定向到其他执行机），
 * 更新为已租约状态、写入租约到期时间并递增尝试次数，确保多执行机并发唤醒时仅有一个胜出者。
 *
 * @param {string} runnerID - 申请认领的执行机器 ID。
 * @param {string[]} providers - 该执行机可用的提供方列表。
 * @param {Date} now - 当前认领时间。
 * @param {number} leaseTTL - 租约有效期（毫秒数，对应 Go `time.Duration`）。
 * @returns {[RunnerTask, boolean]} 二元组 `[已认领任务对象, 是否成功认领]`；无任务可认领时返回 `[空 RunnerTask, false]`。
 * @throws {Error} 执行机 ID 为空、数据库事务出错或已认领任务意外消失时抛出错误。
 */
RunnersRepo.prototype.ClaimRunnerTask = function (runnerID, providers, now, leaseTTL) {
  if (runnerID.trim() === "") {
    throw new Error("runner id is required");
  }
  if (providers.length === 0) {
    return [new RunnerTask(), false];
  }
  const allowed = [];
  for (let p of providers) {
    p = p.trim();
    if (p !== "") {
      allowed.push(p);
    }
  }
  if (allowed.length === 0) {
    return [new RunnerTask(), false];
  }
  let claimed = new RunnerTask();
  let found = false;
  this.DB.Transaction((tx) => {
    const rows = [];
    const findErr = this.locking(tx).
      Where("status = ? AND (runner_id = '' OR runner_id = ?) AND provider IN ?", RunnerTaskQueued, runnerID, allowed).
      Order("created_at").Limit(1).
      Find(rows).Error;
    if (findErr != null) {
      throw findErr;
    }
    if (rows.length === 0) {
      return;
    }
    const taskID = rows[0].ID;
    const res = tx.Model(new runnerTaskRow()).
      Where("id = ? AND status = ?", taskID, RunnerTaskQueued).
      Updates({
        status: RunnerTaskLeased, lease_owner: runnerID,
        lease_until: new Date(now.getTime() + leaseTTL), attempt: rows[0].Attempt + 1,
        desired_state: "", updated_at: now,
      });
    if (res.Error != null) {
      throw res.Error;
    }
    if (res.RowsAffected === 0) {
      return;
    }
    const [row, ok] = takeRunnerTask(tx, taskID);
    if (!ok) {
      throw new Error(`claimed task ${taskID} disappeared`);
    }
    claimed = runnerTaskFromRow(row);
    found = true;
  });
  return [claimed, found];
};

/**
 * 在事务内校验租约归属后，将已认领的任务流转为运行中（`running`）并首次记录开始时间。
 *
 * @param {string} id - 任务主键 ID。
 * @param {string} runnerID - 声称持有租约的执行机器 ID。
 * @param {Date} now - 开始执行时间。
 * @returns {void} 无返回值。
 * @throws {Error} 租约丢失（`ErrRunnerTaskLeaseLost`）或数据库更新失败时抛出错误。
 */
RunnersRepo.prototype.StartRunnerTask = function (id, runnerID, now) {
  this.DB.Transaction((tx) => {
    const [row, ok] = this.takeRunnerTaskForLease(tx, id, runnerID);
    if (!ok) {
      throw ErrRunnerTaskLeaseLost;
    }
    const task = runnerTaskFromRow(row);
    task.Status = RunnerTaskRunning;
    if (task.StartedAt == null) {
      task.StartedAt = now;
    }
    task.UpdatedAt = now;
    const err = tx.Model(new runnerTaskRow()).Where("id = ?", id).Updates({
      status: task.Status, payload: runnerTaskPayloadBytes(task), updated_at: now,
    }).Error;
    if (err != null) {
      throw err;
    }
  });
};

/**
 * 在事务内加行锁加载当前必须由 `runnerID` 持有租约且处于 `leased` 或 `running` 状态的任务行。
 *
 * @param {object} tx - 当前事务 `gorm.DB` 句柄。
 * @param {string} id - 任务主键 ID。
 * @param {string} runnerID - 预期的租约持有者执行机 ID。
 * @returns {[runnerTaskRow, boolean]} 命中有效租约时返回 `[任务行, true]`，否则返回 `[空任务行, false]`。
 */
RunnersRepo.prototype.takeRunnerTaskForLease = function (tx, id, runnerID) {
  const row = new runnerTaskRow();
  if (this.locking(tx).
    Where("id = ? AND lease_owner = ? AND status IN ?", id, runnerID, [RunnerTaskLeased, RunnerTaskRunning]).
    Take(row).Error != null) {
    return [new runnerTaskRow(), false];
  }
  return [row, true];
};

/**
 * 续期任务租约并返回任务的期望控制状态（`desired_state`），使取消指令可随续期响应下发而无需额外轮询。
 *
 * @param {string} id - 任务主键 ID。
 * @param {string} runnerID - 租约持有者执行机 ID。
 * @param {number} ttl - 续期时长（毫秒数，对应 Go `time.Duration`）。
 * @param {Date} now - 当前续期时间。
 * @returns {string} 当前任务的 `DesiredState` 字符串（如 `""` 或 `"cancel"`）。
 * @throws {Error} 租约丢失（`ErrRunnerTaskLeaseLost`）或数据库更新失败时抛出错误。
 */
RunnersRepo.prototype.RenewRunnerTaskLease = function (id, runnerID, ttl, now) {
  let desired = "";
  this.DB.Transaction((tx) => {
    const [row, ok] = this.takeRunnerTaskForLease(tx, id, runnerID);
    if (!ok) {
      throw ErrRunnerTaskLeaseLost;
    }
    const updateErr = tx.Model(new runnerTaskRow()).Where("id = ?", id).Updates({
      lease_until: new Date(now.getTime() + ttl), updated_at: now,
    }).Error;
    if (updateErr != null) {
      throw updateErr;
    }
    desired = row.DesiredState;
  });
  return desired;
};

/**
 * 终结一条执行任务并落盘退出码、结果、错误信息、上传产物及工作区输出，同时清理载荷中的敏感凭据并释放租约。
 * 仅当前租约持有者可调用完成。
 *
 * @param {string} id - 任务主键 ID。
 * @param {string} runnerID - 租约持有者执行机 ID。
 * @param {string} status - 终态状态（`RunnerTaskSuccess`、`RunnerTaskFailed` 或 `RunnerTaskCanceled`）。
 * @param {number | null} exitCode - 进程退出码（可为 `null`）。
 * @param {string} result - 任务文本结果。
 * @param {string} errMsg - 失败错误信息。
 * @param {Object.<string, string> | null} artifacts - 旧版契约名到产物正文的映射（可为 `null`）。
 * @param {import("../domain/runner.js").RunnerTaskOutputs | null} outputs - 执行机上报的结构化工作区输出（可为 `null`）。
 * @param {Date} now - 任务完成时间。
 * @returns {void} 无返回值。
 * @throws {Error} 终态非法、租约丢失（`ErrRunnerTaskLeaseLost`）或数据库更新失败时抛出错误。
 */
RunnersRepo.prototype.CompleteRunnerTask = function (id, runnerID, status, exitCode, result, errMsg, artifacts, outputs, now) {
  if (status !== RunnerTaskSuccess && status !== RunnerTaskFailed && status !== RunnerTaskCanceled) {
    throw new Error(`invalid final task status "${status}"`);
  }
  this.DB.Transaction((tx) => {
    const [row, ok] = this.takeRunnerTaskForLease(tx, id, runnerID);
    if (!ok) {
      throw ErrRunnerTaskLeaseLost;
    }
    const task = runnerTaskFromRow(row);
    task.Status = status;
    task.ExitCode = exitCode;
    task.Result = result;
    task.Error = errMsg;
    if (artifacts != null) {
      task.Artifacts = artifacts;
    }
    if (outputs != null) {
      task.Outputs = outputs;
    }
    scrubRunnerTaskCredentials(task);
    task.CompletedAt = now;
    task.LeaseOwner = "";
    task.LeaseUntil = null;
    task.UpdatedAt = now;
    const err = tx.Model(new runnerTaskRow()).Where("id = ?", id).Updates(runnerTaskRowValues(task)).Error;
    if (err != null) {
      throw err;
    }
  });
};

/**
 * 就地清除任务调用规格中的所有 API Key、Git SSH 密钥、HTTP 凭据与单/多仓库 Git Token。
 * 在任务进入终态（完成、取消、租约过期耗尽或执行机注销）写回载荷前调用。
 *
 * @param {RunnerTask | null} task - 待脱敏的任务对象。
 * @returns {void} 无返回值。
 */
function scrubRunnerTaskCredentials(task) {
  if (task == null || task.Invocation == null) {
    return;
  }
  task.Invocation.CodeBuddyAPIKey = "";
  task.Invocation.CodeBuddyBaseURL = "";
  task.Invocation.CodeBuddyInternetEnvironment = "";
  task.Invocation.CodexAPIKey = "";
  task.Invocation.CodexBaseURL = "";
  task.Invocation.ClaudeCodeAPIKey = "";
  task.Invocation.ClaudeCodeBaseURL = "";
  task.Invocation.AgentCLIAPIKey = "";
  task.Invocation.AgentCLIBaseURL = "";
  task.Invocation.GitSSHUserID = 0;
  task.Invocation.GitSSHKeys = null;
  task.Invocation.GitHTTPUserID = 0;
  task.Invocation.GitHTTPCredentials = null;
  if (task.Invocation.Repository != null) {
    task.Invocation.Repository.GitToken = "";
  }
  for (let i = 0; i < (task.Invocation.Repositories ?? []).length; i++) {
    task.Invocation.Repositories[i].GitToken = "";
  }
}

/**
 * 请求取消指定执行任务：尚在排队中的任务直接置为已取消并脱敏载荷；
 * 已被认领或运行中的任务则写入 `desired_state = cancel`，待执行机续期或轮询控制通道时感知。
 *
 * @param {string} id - 任务主键 ID。
 * @param {Date} now - 取消操作时间。
 * @returns {void} 无返回值。
 * @throws {Error} 事务内任一数据库更新失败时抛出错误。
 */
RunnersRepo.prototype.CancelRunnerTask = function (id, now) {
  this.DB.Transaction((tx) => {
    const res = tx.Model(new runnerTaskRow()).
      Where("id = ? AND status = ?", id, RunnerTaskQueued).
      Updates({ status: RunnerTaskCanceled, lease_owner: "", lease_until: null, desired_state: "", updated_at: now });
    if (res.Error != null) {
      throw res.Error;
    }
    if (res.RowsAffected > 0) {
      const [row, ok] = takeRunnerTask(tx, id);
      if (ok) {
        const task = runnerTaskFromRow(row);
        scrubRunnerTaskCredentials(task);
        task.CompletedAt = now;
        const updateErr = tx.Model(new runnerTaskRow()).Where("id = ?", id).Updates({
          payload: runnerTaskPayloadBytes(task), updated_at: now,
        }).Error;
        if (updateErr != null) {
          throw updateErr;
        }
      }
      return;
    }
    const err = tx.Model(new runnerTaskRow()).
      Where("id = ? AND status IN ?", id, [RunnerTaskLeased, RunnerTaskRunning]).
      Updates({ desired_state: RunnerTaskDesiredCancel, updated_at: now }).Error;
    if (err != null) {
      throw err;
    }
  });
};

/**
 * 回收所有租约已过期的活跃任务：仍有重试次数的退回排队（`queued`），重试耗尽的标记失败（`failed`）并脱敏凭据。
 * 返回本次回收的全部任务列表供上层记录可观测事件。
 *
 * @param {Date} now - 当前巡检基准时间。
 * @returns {RunnerTask[]} 本次恢复或判败的任务领域对象数组。
 * @throws {Error} 事务查询或更新失败时抛出错误。
 */
RunnersRepo.prototype.ExpireRunnerTasks = function (now) {
  const recovered = [];
  this.DB.Transaction((tx) => {
    const rows = [];
    const findErr = this.locking(tx).
      Where("status IN ? AND lease_until IS NOT NULL AND lease_until < ?", [RunnerTaskLeased, RunnerTaskRunning], now).
      Find(rows).Error;
    if (findErr != null) {
      throw findErr;
    }
    for (const row of rows) {
      const task = runnerTaskFromRow(row);
      if (task.Attempt < task.MaxAttempts) {
        task.Status = RunnerTaskQueued;
      } else {
        task.Status = RunnerTaskFailed;
        task.Error = "lease expired";
        task.CompletedAt = now;
        scrubRunnerTaskCredentials(task);
      }
      task.LeaseOwner = "";
      task.LeaseUntil = null;
      task.DesiredState = "";
      task.UpdatedAt = now;
      const updateErr = tx.Model(new runnerTaskRow()).Where("id = ?", task.ID).Updates(runnerTaskRowValues(task)).Error;
      if (updateErr != null) {
        throw updateErr;
      }
      recovered.push(task);
    }
  });
  return recovered;
};

/**
 * 在事务内批量幂等追加执行机上报的任务事件流，以 `(task_id, seq)` 作为幂等键忽略 HTTP 重试带来的重复序号。
 *
 * @param {string} taskID - 所属任务 ID。
 * @param {RunnerTaskEvent[]} events - 待追加的事件数组。
 * @returns {number} 本次实际新写入的事件条数。
 * @throws {Error} 任务 ID 为空或数据库事务插入失败时抛出错误。
 */
RunnersRepo.prototype.AppendRunnerTaskEvents = function (taskID, events) {
  taskID = taskID.trim();
  if (taskID === "") {
    throw new Error("task id is required");
  }
  if (events.length === 0) {
    return 0;
  }
  let accepted = 0;
  this.DB.Transaction((tx) => {
    accepted = 0;
    for (const ev of events) {
      const inserted = insertIgnore(tx, "runner_task_events", {
        task_id: taskID, seq: ev.Seq, type: ev.Type, data: ev.Data, ts: timePtr(ev.Ts),
      });
      if (inserted) {
        accepted++;
      }
    }
  });
  return accepted;
};

/**
 * 按序号升序读取指定任务的全部事件记录。
 *
 * @param {string} taskID - 所属任务 ID。
 * @returns {RunnerTaskEvent[]} 任务事件领域对象数组。
 */
RunnersRepo.prototype.RunnerTaskEvents = function (taskID) {
  return this.RunnerTaskEventsAfter(taskID, 0);
};

/**
 * 增量读取序号严格大于 `after` 的任务事件，避免实时桥接轮询反复加载整份 CLI 日志。
 *
 * @param {string} taskID - 所属任务 ID。
 * @param {number} after - 上次已消费的最大事件序号。
 * @returns {RunnerTaskEvent[]} 新增事件按 `seq` 升序排列的数组；查询失败时返回空数组。
 */
RunnersRepo.prototype.RunnerTaskEventsAfter = function (taskID, after) {
  const rows = [];
  if (this.DB.Where("task_id = ? AND seq > ?", taskID, after).Order("seq").Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const ev = new RunnerTaskEvent({ Seq: row.Seq, Type: row.Type, Data: row.Data });
    if (row.Ts != null) {
      ev.Ts = row.Ts;
    }
    out.push(ev);
  }
  return out;
};

/**
 * 在事务内注销指定执行机器并级联清理其关联状态：取消该机器名下尚未开始的排队任务并脱敏载荷、
 * 删除指向该机器的用户默认执行机偏好、最后删除执行机主记录（运行中的任务交由租约过期机制恢复）。
 *
 * @param {string} id - 待注销的执行机器 ID。
 * @param {Date} now - 注销时间。
 * @returns {void} 无返回值。
 * @throws {Error} 执行机 ID 为空、执行机不存在（`ErrRunnerNotFound`）或事务更新/删除失败时抛出错误。
 */
RunnersRepo.prototype.DeregisterRunner = function (id, now) {
  id = id.trim();
  if (id === "") {
    throw new Error("runner id is required");
  }
  this.DB.Transaction((tx) => {
    const rows = [];
    const findErr = tx.Where("runner_id = ? AND status = ?", id, RunnerTaskQueued).Find(rows).Error;
    if (findErr != null) {
      throw findErr;
    }
    for (const row of rows) {
      const task = runnerTaskFromRow(row);
      task.Status = RunnerTaskCanceled;
      task.LeaseOwner = "";
      task.LeaseUntil = null;
      scrubRunnerTaskCredentials(task);
      task.CompletedAt = now;
      task.UpdatedAt = now;
      const updateErr = tx.Model(new runnerTaskRow()).Where("id = ?", task.ID).Updates(runnerTaskRowValues(task)).Error;
      if (updateErr != null) {
        throw updateErr;
      }
    }
    const deleteErr = tx.Where("default_runner_id = ?", id).Delete(new userRunnerPrefRow()).Error;
    if (deleteErr != null) {
      throw deleteErr;
    }
    const res = tx.Where("id = ?", id).Delete(new runnerRow());
    if (res.Error != null) {
      throw res.Error;
    }
    if (res.RowsAffected === 0) {
      throw ErrRunnerNotFound;
    }
  });
};

// ---------- default execution machine (执行机器) ----------

/**
 * 查询用户配置的默认执行机器 ID；返回空字符串表示使用平台云端模式（控制面沙箱与平台 API Key）。
 *
 * @param {number} userID - 用户主键 ID。
 * @returns {string} 默认执行机器 ID（未配置或用户 ID 非法时返回 `""`）。
 */
RunnersRepo.prototype.DefaultRunner = function (userID) {
  if (userID <= 0) {
    return "";
  }
  const row = new userRunnerPrefRow();
  if (this.DB.Where("user_id = ?", userID).Take(row).Error != null) {
    return "";
  }
  return row.DefaultRunnerID.trim();
};

/**
 * 设置或清除（传入空 `runnerID`）用户的默认执行机器偏好。
 *
 * @param {number} userID - 用户主键 ID。
 * @param {string} runnerID - 目标默认执行机 ID；空字符串表示切回云端模式并删除偏好记录。
 * @param {Date} now - 更新时间。
 * @returns {void} 无返回值。
 * @throws {Error} 用户 ID 非法、目标执行机不存在（`ErrRunnerNotFound`）或数据库写删失败时抛出错误。
 */
RunnersRepo.prototype.SetDefaultRunner = function (userID, runnerID, now) {
  if (userID <= 0) {
    throw new Error("user id is required");
  }
  runnerID = runnerID.trim();
  if (runnerID !== "") {
    const [, ok] = this.Runner(runnerID);
    if (!ok) {
      throw ErrRunnerNotFound;
    }
  }
  if (runnerID === "") {
    const err = this.DB.Where("user_id = ?", userID).Delete(new userRunnerPrefRow()).Error;
    if (err != null) {
      throw err;
    }
    return;
  }
  upsert(this.DB, "user_runner_prefs", {
    user_id: userID, default_runner_id: runnerID, updated_at: timePtr(now),
  });
};

// ---------- helpers ----------

/**
 * 将 `0` 转为数据库 `NULL`（`null`），非零整数原样返回。
 * 用于写入可空外键列（如 `owner_user_id`）。
 *
 * @param {number} v - 64 位整数值。
 * @returns {number | null} 非零时返回原值，为 `0` 时返回 `null`。
 */
function nullableInt64(v) {
  if (v === 0) {
    return null;
  }
  return v;
}

/**
 * 按任务创建时间升序就地排序任务数组，供需要确定性顺序的测试场景使用。
 *
 * @param {RunnerTask[]} tasks - 待排序的执行任务数组。
 * @returns {void} 无返回值。
 */
function sortRunnerTasksByCreated(tasks) {
  tasks.sort((a, b) => timeMs(a.CreatedAt) - timeMs(b.CreatedAt));
}

/**
 * 查询归属指定运行（`runID`）的全部活跃远程任务（处于 `queued`、`leased` 或 `running` 状态）。
 *
 * @param {string} runID - 运行主键 ID。
 * @returns {RunnerTask[] | null} 匹配的活跃任务数组；`runID` 为空时返回 `null`。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
RunnersRepo.prototype.ActiveRunnerTasksForRun = function (runID) {
  runID = runID.trim();
  if (runID === "") {
    return null;
  }
  const rows = [];
  const err = this.DB.Where("status IN ?", [RunnerTaskQueued, RunnerTaskLeased, RunnerTaskRunning]).Find(rows).Error;
  if (err != null) {
    throw err;
  }
  const out = [];
  for (const row of rows) {
    const task = runnerTaskFromRow(row);
    if (task.RunID === runID) {
      out.push(task);
    }
  }
  return out;
};

/**
 * 中断指定运行的全部活跃远程任务：排队中的任务立即终止，已租约/运行中的任务写入持久化取消标记。
 *
 * @param {string} runID - 运行主键 ID。
 * @param {Date} now - 取消操作时间。
 * @returns {string[]} 本次成功下发取消的任务 ID 数组。
 * @throws {Error} 查询活跃任务或取消任一任务失败时抛出错误。
 */
RunnersRepo.prototype.CancelRunnerTasksForRun = function (runID, now) {
  const tasks = this.ActiveRunnerTasksForRun(runID);
  const ids = [];
  for (const task of tasks ?? []) {
    this.CancelRunnerTask(task.ID, now);
    ids.push(task.ID);
  }
  return ids;
};

module.exports = { ErrRunnerTaskNotClaimable, ErrRunnerTaskLeaseLost, ErrRunnerNotFound, runnerTaskPayload, runnerTaskTime, parseRunnerTaskTime, newRunnerTaskTime, runnerTaskFromRow, runnerTaskPayloadBytes, runnerTaskRowValues, takeRunnerTask, MaxRunnerRunLimit, runnerFromRow, scrubRunnerTaskCredentials, nullableInt64, sortRunnerTasksByCreated };
