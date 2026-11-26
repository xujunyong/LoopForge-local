// assistant_generations.js —— 对应 Go 文件：internal/repo/assistant_generations.go
// 作用：一轮生成的开始、心跳、检查点、转向、取消与超时回收。
// gorm 链式调用按原样保留，gorm/clause 只做 require，不做实现；(值, error) 译为返回值、失败 throw，(值, bool) 译为 [值, bool]。

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

class assistantGenerationRow {
  constructor(init = {}) {
    this.SessionID = init.SessionID ?? "";
    this.UserID = init.UserID ?? 0;
    this.GenerationID = init.GenerationID ?? "";
    this.Status = init.Status ?? "";
    this.CancelRequested = init.CancelRequested ?? false;
    this.Payload = init.Payload ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
    // FinishedAt is set when a turn ends through a checkpoint and cleared when
    // the next turn starts. Rows that ended before the column existed keep
    // NULL, which is how read tracking leaves older history unmarked.
    this.FinishedAt = init.FinishedAt ?? null;
    // WorkspaceRunID and WorkspaceLease name the foreground workspace lease
    // this turn holds. Only that exact token is released when the turn is
    // reaped; a lease another turn took in the meantime never matches.
    this.WorkspaceRunID = init.WorkspaceRunID ?? "";
    this.WorkspaceLease = init.WorkspaceLease ?? "";
  }

  TableName() {
    return "assistant_generations";
  }
}

// Keep private control state alongside the public generation snapshot.
class assistantGenerationPayload extends AssistantGeneration {
  constructor(init = {}) {
    super(init);
    this.NativeApprovals = init.NativeApprovals ?? [];
    this.SteeringClosed = init.SteeringClosed ?? false;
  }
}

// assistantHeartbeatTimeout is how long a running turn may go without a
// durable heartbeat before a reader that does not own it declares it dead.
const assistantHeartbeatTimeout = 45 * 1000;

const errAssistantGenerationEnded = new Error("生成已结束或不存在");

// AssistantGenerationLease is the workspace lease a reaped turn held.
class AssistantGenerationLease {
  constructor(init = {}) {
    this.RunID = init.RunID ?? "";
    this.Token = init.Token ?? "";
  }
}

function generationPayload(row) {
  let parsed = {};
  try {
    parsed = JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8"));
  } catch (err) {
    // Go 忽略解码错误。
  }
  return new assistantGenerationPayload(parsed);
}

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

// PeekAssistantGeneration reads the latest turn without declaring it dead.
// The owner of a live turn must use this. AssistantGeneration also reaps a
// turn whose heartbeat is older than 45 seconds, which is only safe once the
// owning process is gone: a slow commit stores an old updated_at and the next
// read would otherwise cancel a CLI that is still working.
AssistantRepo.prototype.PeekAssistantGeneration = function (userID, sessionID) {
  const [row, ok] = this.loadAssistantGeneration(userID, sessionID);
  if (!ok) {
    return [new AssistantGeneration(), false];
  }
  return [decodeGeneration(row), true];
};

AssistantRepo.prototype.loadAssistantGeneration = function (userID, sessionID) {
  const row = new assistantGenerationRow();
  const err = this.DB.Where("session_id = ? AND user_id = ?", sessionID, userID).Take(row).Error;
  if (err != null) {
    return [new assistantGenerationRow(), false];
  }
  return [row, true];
};

AssistantRepo.prototype.AssistantGeneration = function (userID, sessionID) {
  const [g, , ok] = this.ReapAssistantGeneration(userID, sessionID);
  return [g, ok];
};

// ReapAssistantGeneration reads a turn and, when its heartbeat is late,
// records it as interrupted. The lease is returned only to the caller whose
// update actually reaped the turn, so the lease is released at most once.
AssistantRepo.prototype.ReapAssistantGeneration = function (userID, sessionID) {
  const [firstRow, firstOK] = this.loadAssistantGeneration(userID, sessionID);
  if (!firstOK) {
    return [new AssistantGeneration(), new AssistantGenerationLease(), false];
  }
  let row = firstRow;
  let lease = new AssistantGenerationLease();
  // A server that died cannot leave a conversation stuck forever. Never replay
  // a model turn automatically, because its tools may already have written.
  if (row.Status === "running" && this.heartbeatLate(this.DB, row.UpdatedAt)) {
    const g = decodeGeneration(row);
    g.Status = "interrupted";
    g.Error = "服务端生成已中断，请检查已执行操作后重试";
    g.Failure = new AssistantFailure({ Code: "EXECUTION_INTERRUPTED", Phase: "server", Message: g.Error, Suggestion: "检查已执行操作后再重试；可下载诊断信息交给管理员排查。" });
    this.DB.Transaction((tx) => {
      const res = this.lateHeartbeatOnly(tx.Model(new assistantGenerationRow()).Where("session_id = ? AND generation_id = ? AND status = ? AND updated_at = ?", sessionID, row.GenerationID, "running", row.UpdatedAt)).Updates({ status: g.Status, payload: mustJSON(g), updated_at: this.generationClock() });
      if (res.Error != null || res.RowsAffected !== 1) {
        return res.Error;
      }
      const err = checkpointAssistantDiagnostics(tx, g, null);
      if (err != null) {
        return err;
      }
      lease = new AssistantGenerationLease({ RunID: row.WorkspaceRunID, Token: row.WorkspaceLease });
      return null;
    });
    const [reloaded, reloadedOK] = this.loadAssistantGeneration(userID, sessionID);
    if (!reloadedOK) {
      return [new AssistantGeneration(), new AssistantGenerationLease(), false];
    }
    row = reloaded;
  }
  return [decodeGeneration(row), lease, true];
};

// RecordAssistantGenerationWorkspaceLease remembers the foreground workspace
// lease a running turn took, so a reader that reaps the turn after its process
// died can release exactly that lease. The heartbeat clock is not touched.
AssistantRepo.prototype.RecordAssistantGenerationWorkspaceLease = function (userID, sessionID, generationID, runID, token) {
  return this.DB.Model(new assistantGenerationRow())
    .Where("session_id = ? AND user_id = ? AND generation_id = ? AND status = ?", sessionID, userID, generationID, "running")
    .UpdateColumns({ workspace_run_id: runID, workspace_lease: token }).Error;
};

// heartbeatNow is the clock a heartbeat's age is measured on. MySQL stamps
// heartbeats with its own UTC_TIMESTAMP(3) (see generationClock), so their age
// is measured on that same clock: comparing them with this machine's time.Now()
// would turn any skew between the API host and the database into turns reaped
// while alive, or never reaped. ok is false when the clock cannot be read, and
// callers then treat the heartbeat as fresh rather than reap on a guess.
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

// heartbeatLate reports a heartbeat older than assistantHeartbeatTimeout on
// the heartbeat clock.
AssistantRepo.prototype.heartbeatLate = function (db, updatedAt) {
  const [now, ok] = this.heartbeatNow(db);
  const updatedMs = updatedAt == null ? 0 : updatedAt.getTime();
  return ok && now.getTime() - updatedMs > assistantHeartbeatTimeout;
};

// lateHeartbeatOnly lets the database itself confirm, when the reap commits,
// that the heartbeat is still late on its own clock.
AssistantRepo.prototype.lateHeartbeatOnly = function (q) {
  if (!this.isMySQL()) {
    return q;
  }
  return q.Where("updated_at < UTC_TIMESTAMP(3) - INTERVAL ? MICROSECOND", assistantHeartbeatTimeout * 1000); // Go 的 Microseconds：毫秒数 × 1000
};

// generationClock is the commit-time clock on MySQL. A Go timestamp captured
// before a stalled commit is already older than the 45 second reap when it
// becomes visible, so the next read interrupts a turn that just checked in.
AssistantRepo.prototype.generationClock = function () {
  if (this.isMySQL()) {
    return new clause.Expr({ SQL: "UTC_TIMESTAMP(3)" });
  }
  return new Date();
};

// BeginAssistantGeneration may lock a session that does not exist yet; two
// first messages to new sessions can deadlock on that gap and are retried.
AssistantRepo.prototype.BeginAssistantGeneration = async function (g, ...pending) {
  const { decodeAssistantSession } = require("./assistant.js"); // 循环引用：调用时现取，不缓存
  return this.retryAssistantDeadlock(() => this.DB.Transaction((tx) => {
    const session = new assistantSessionRow();
    let err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ?", g.SessionID).Take(session).Error;
    if (err == null && session.UserID !== g.UserID) {
      return new Error("无权访问会话");
    } else if (err != null && err !== gorm.ErrRecordNotFound) {
      return err;
    }
    if (pending.length > 0) {
      const next = pending[0];
      next.ExecutionTargetLocked = true;
      const old = decodeAssistantSession(session);
      if (next.IssueID !== old.IssueID) {
        return new Error("关联需求已更新，请重新发送");
      }
      if (next.Messages.length < old.Messages.length) {
        return new Error("会话已更新，请重新打开后发送");
      }
      for (let i = 0; i < old.Messages.length; i++) {
        const a = JSON.stringify(old.Messages[i]);
        const b = JSON.stringify(next.Messages[i]);
        if (a !== b) {
          return new Error("会话已更新，请重新打开后发送");
        }
      }
      const scoped = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
      scoped.DB = tx;
      const base = { ...this.deps, DB: tx };
      scoped.deps = base;
      err = scoped.putAssistantSession(g.UserID, next, g.ClientRequestID);
      if (err != null) {
        return err;
      }
    } else if (session.ID !== "") {
      const item = decodeAssistantSession(session);
      item.ExecutionTargetLocked = true;
      err = tx.Model(new assistantSessionRow()).Where("id = ?", session.ID).UpdateColumn("payload", mustJSON(item)).Error;
      if (err != null) {
        return err;
      }
    }

    const old = new assistantGenerationRow();
    err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ?", g.SessionID).Take(old).Error;
    if (err == null) {
      if (old.UserID !== g.UserID) {
        return new Error("无权访问会话");
      }
      if (old.Status === "running") {
        return new Error("此会话正在生成，请等待完成或停止");
      }
      err = tx.Model(old).Updates({ generation_id: g.ID, status: "running", cancel_requested: false, payload: mustJSON(g), updated_at: this.generationClock(), finished_at: null, workspace_run_id: "", workspace_lease: "" }).Error;
      if (err != null) {
        return err;
      }
      return checkpointAssistantDiagnostics(tx, g, null);
    }
    if (err !== gorm.ErrRecordNotFound) {
      return err;
    }
    err = tx.Create(new assistantGenerationRow({ SessionID: g.SessionID, UserID: g.UserID, GenerationID: g.ID, Status: "running", Payload: mustJSON(g), UpdatedAt: new Date() })).Error;
    if (err != null) {
      return err;
    }
    if (this.isMySQL()) {
      // The first heartbeat is on the database clock like every later one.
      err = tx.Model(new assistantGenerationRow()).Where("session_id = ?", g.SessionID).UpdateColumn("updated_at", this.generationClock()).Error;
      if (err != null) {
        return err;
      }
    }
    return checkpointAssistantDiagnostics(tx, g, null);
  }));
};

AssistantRepo.prototype.CheckpointAssistantGeneration = function (g, ...diagnostics) {
  return this.checkpointAssistantGeneration(g, true, diagnostics);
};

// HeartbeatAssistantGeneration records a running checkpoint whose diagnostic
// evidence has not changed since it was last stored, so the diagnostic payload
// is not rewritten.
AssistantRepo.prototype.HeartbeatAssistantGeneration = function (g) {
  return this.checkpointAssistantGeneration(g, false, null);
};

AssistantRepo.prototype.checkpointAssistantGeneration = function (g, withDiagnostics, diagnostics) {
  return this.DB.Transaction((tx) => {
    const [row, lockErr] = lockRunningAssistantGeneration(tx, g.UserID, g.SessionID, g.ID);
    if (lockErr != null) {
      return new Error("生成状态已变化");
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
      return res.Error;
    }
    // MySQL counts changed rows. A heartbeat whose payload and clock match
    // the stored row reports 0 even though the turn is still running.
    // Treating that as "the turn disappeared" cancels a live CLI.
    if (res.RowsAffected !== 1) {
      if (g.Status !== "running") {
        return new Error("生成状态已变化");
      }
      const again = new assistantGenerationRow();
      const err = tx.Where("session_id = ? AND user_id = ? AND generation_id = ? AND status = ?", g.SessionID, g.UserID, g.ID, "running").Take(again).Error;
      if (err != null) {
        return new Error("生成状态已变化");
      }
    }
    if (!withDiagnostics) {
      return null;
    }
    return checkpointAssistantDiagnostics(tx, g, diagnostics);
  });
};

function lockRunningAssistantGeneration(tx, userID, sessionID, id) {
  const row = new assistantGenerationRow();
  const err = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("session_id = ? AND user_id = ? AND generation_id = ? AND status = ?", sessionID, userID, id, "running").Take(row).Error;
  return [row, err];
}

// CloseAssistantGenerationSteering hands the worker any accepted steer and
// prevents new steers while the worker saves the transcript. The generation
// stays running until that transcript is available to readers.
AssistantRepo.prototype.CloseAssistantGenerationSteering = function (userID, sessionID, id) {
  let steer = null;
  const err = this.DB.Transaction((tx) => {
    const [row, lockErr] = lockRunningAssistantGeneration(tx, userID, sessionID, id);
    if (lockErr != null) {
      return lockErr;
    }
    const payload = generationPayload(row);
    steer = payload.Steer;
    if (steer != null || payload.SteeringClosed) {
      return null;
    }
    payload.SteeringClosed = true;
    return tx.Model(row).Updates({ payload: mustJSON(payload), updated_at: this.generationClock() }).Error;
  });
  if (err != null) {
    throw err;
  }
  return steer;
};

AssistantRepo.prototype.SteerAssistantGeneration = function (userID, sessionID, id, steer) {
  return this.DB.Transaction((tx) => {
    const [row, lockErr] = lockRunningAssistantGeneration(tx, userID, sessionID, id);
    if (lockErr != null) {
      return errAssistantGenerationEnded;
    }
    const payload = generationPayload(row);
    if (payload.Steer != null) {
      return new Error("本轮已有待处理的引导，请稍后重试");
    }
    if (payload.SteeringClosed) {
      return errAssistantGenerationEnded;
    }
    payload.Steer = steer;
    payload.NativeApprovals = null;
    return tx.Model(row).Updates({ cancel_requested: true, payload: mustJSON(payload), updated_at: this.generationClock() }).Error;
  });
};

AssistantRepo.prototype.CancelAssistantGeneration = function (userID, sessionID, id) {
  const res = this.DB.Model(new assistantGenerationRow()).Where("session_id = ? AND user_id = ? AND generation_id = ? AND status = ?", sessionID, userID, id, "running").Update("cancel_requested", true);
  if (res.Error != null) {
    return res.Error;
  }
  if (res.RowsAffected !== 1) {
    return errAssistantGenerationEnded;
  }
  return null;
};

// AssistantGenerationState is the latest reply of a conversation as the
// history list shows it to one reader.
class AssistantGenerationState {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Status = init.Status ?? "";
    // FinishedAt is when the reply ended. Replies that ended before it was
    // recorded have none, so read tracking leaves older history unmarked.
    this.FinishedAt = init.FinishedAt ?? null;
    // Seen reports that the reader has opened the conversation since this
    // reply (see MarkAssistantSessionRead).
    this.Seen = init.Seen ?? false;
    // Stale reports a turn still stored as running whose heartbeat is late.
    // Status reads "interrupted" for it, but nothing has been written yet.
    this.Stale = init.Stale ?? false;
  }
}

// AssistantGenerationStatuses reads the latest reply of each conversation
// and whether the reader has seen it, in one query for the whole list.
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
