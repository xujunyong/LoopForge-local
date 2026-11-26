// runners.js —— 对应 Go 文件：internal/repo/runners.go
// 作用：执行机器注册表与任务队列：注册、心跳、租约认领、完成与默认执行机。

"use strict";

const { Buffer } = require("node:buffer");

const { Runner, RunnerStatusOnline, RunnerStatusOffline, RunnerTaskQueued, RunnerTaskLeased, RunnerTaskRunning, RunnerTaskSuccess, RunnerTaskFailed, RunnerTaskCanceled, RunnerTaskDesiredCancel, RuntimeStatusOnline, RuntimeStatusDisabled, RuntimeAuthLocal, RuntimeAuthPersonal, SupportsRunnerLogin, RunnerTask, RunnerTaskEvent } = require("../domain/runner.js"); // 对应 Go 的 domain.*，runner.js 已翻译
const { IsAgentCLIKind } = require("../domain/agent.js"); // 对应 Go 的 domain.IsAgentCLIKind，agent.js 已翻译
const { RunnersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runnerRow, runnerTaskRow, userRunnerPrefRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { upsert, insertIgnore, timePtr, jsonBytes, mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { isZeroTime, timeMs } = require("./analytics.js"); // 对应 Go 的时间比较，analytics.js 已翻译
const { lockAdmissionGate, admissionBucketKey } = require("./run_admission.js"); // 对应 Go 同包函数，run_admission.js 已翻译

const ErrRunnerTaskNotClaimable = new Error("runner task is not claimable");
const ErrRunnerTaskLeaseLost = new Error("runner task lease ownership changed");
const ErrRunnerNotFound = new Error("runner not found");

class runnerTaskPayload {
  constructor(init = {}) {
    this.Prompt = init.Prompt ?? "";
    this.Workspace = init.Workspace ?? "";
    this.Args = init.Args ?? null;
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
    this.Artifacts = init.Artifacts ?? null;
    this.Outputs = init.Outputs ?? null;
  }

  // toJSON：Go 的 json.Marshal 按字段标签写小写键，omitempty 省略空值；JS 的 JSON.stringify 靠 toJSON 复现。
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

// runnerTaskTime：内嵌 time.Time 的时间包装；零值译为 null。
class runnerTaskTime {
  constructor(time = null) {
    this.Time = time;
  }

  UnmarshalJSON(raw) {
    const s = String(raw).trim().replace(/^"+|"+$/g, "");
    if (s === "" || s === "null") {
      return null;
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
    return null;
  }

  MarshalJSON() {
    if (this.Time == null) {
      return "null";
    }
    // Go：t.Time.UTC().Format(time.RFC3339Nano)。
    const iso = this.Time.toISOString().replace(/\.000Z$/, "Z").replace(/(\.\d+?)0+Z$/, "$1Z");
    return JSON.stringify(iso);
  }

  toJSON() {
    const raw = this.MarshalJSON();
    return raw === "null" ? null : JSON.parse(raw);
  }

  toTime() {
    if (this.Time == null) {
      return null;
    }
    return this.Time;
  }
}

// parseRunnerTaskTime：Go 的 json.Unmarshal 会按字段类型分发到 runnerTaskTime.UnmarshalJSON；JS 里显式调用一次。
function parseRunnerTaskTime(value) {
  const t = new runnerTaskTime();
  if (value != null) {
    t.UnmarshalJSON(JSON.stringify(value));
  }
  return t;
}

function newRunnerTaskTime(v) {
  if (v == null) {
    return null;
  }
  return new runnerTaskTime(v);
}

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
      Prompt: raw.prompt ?? "", Workspace: raw.workspace ?? "", Args: raw.args ?? null,
      ExitCode: raw.exitCode ?? null, Result: raw.result ?? "", Error: raw.error ?? "",
      StartedAt: parseRunnerTaskTime(raw.startedAt), CompletedAt: parseRunnerTaskTime(raw.completedAt),
      RunID: raw.runId ?? "", NodeID: raw.nodeId ?? "", Invocation: raw.invocation ?? null,
      Sandbox: raw.sandbox ?? null, Command: raw.command ?? "", Action: raw.action ?? "",
      PreviewArchive: raw.previewArchive ?? null, WorkBranchMessage: raw.workBranchMessage ?? "",
      IntegrationLabel: raw.integrationLabel ?? "", Artifacts: raw.artifacts ?? null, Outputs: raw.outputs ?? null,
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

function runnerTaskRowValues(v) {
  return {
    id: v.ID, runner_id: v.RunnerID, provider: v.Provider, status: v.Status,
    lease_owner: v.LeaseOwner, lease_until: v.LeaseUntil, desired_state: v.DesiredState,
    attempt: v.Attempt, max_attempts: v.MaxAttempts, payload: runnerTaskPayloadBytes(v),
    created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  };
}

function takeRunnerTask(db, id) {
  const row = new runnerTaskRow();
  if (db.Where("id = ?", id).Take(row).Error != null) {
    return [new runnerTaskRow(), false];
  }
  return [row, true];
}

// ---------- Runner registry ----------

RunnersRepo.prototype.PutRunner = function (v) {
  if (v.ID.trim() === "") {
    return new Error("runner id is required");
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
  return upsert(this.DB, "runners", {
    id: v.ID, name: v.Name, status: v.Status, os: v.OS, arch: v.Arch,
    runner_version: v.RunnerVersion, labels: jsonBytes(v.Labels), max_concurrency: v.MaxConcurrency,
    native_sandbox_available: v.NativeSandboxAvailable,
    owner_user_id: nullableInt64(v.OwnerUserID), session_token_hash: v.SessionTokenHash,
    session_expires_at: v.SessionExpiresAt, runtimes: jsonBytes(v.Runtimes),
    last_seen_at: v.LastSeenAt, created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  });
};

const MaxRunnerRunLimit = 100;

RunnersRepo.prototype.SetRunnerRunLimit = function (id, limit) {
  if (limit < 0 || limit > MaxRunnerRunLimit) {
    return new Error(`最多同时运行条数需在 0-${MaxRunnerRunLimit} 之间（0 表示不限制）`);
  }
  let value = null;
  if (limit > 0) {
    value = limit;
  }
  return this.DB.Transaction((tx) => {
    const lockErr = lockAdmissionGate(this, tx, admissionBucketKey("", id, true));
    if (lockErr != null) {
      return lockErr;
    }
    const res = tx.Model(new runnerRow()).Where("id = ?", id).Updates({ run_limit: value, updated_at: new Date() });
    if (res.Error != null) {
      return res.Error;
    }
    if (res.RowsAffected === 0) {
      return ErrRunnerNotFound;
    }
    return null;
  });
};

RunnersRepo.prototype.Runner = function (id) {
  return this.runnerRow(id);
};

RunnersRepo.prototype.runnerRow = function (id) {
  const row = new runnerRow();
  if (this.DB.Where("id = ?", id).Take(row).Error != null) {
    return [new Runner(), false];
  }
  return [runnerFromRow(row), true];
};

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
  let raw;
  try {
    raw = JSON.stringify(runtimes);
  } catch (marshalErr) {
    return marshalErr;
  }
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
    return res.Error;
  }
  if (res.RowsAffected === 0) {
    return ErrRunnerNotFound;
  }
  return null;
};

RunnersRepo.prototype.SetRunnerRuntimeAuthMode = function (runnerID, provider, authMode, now) {
  if (authMode !== RuntimeAuthLocal && authMode !== RuntimeAuthPersonal) {
    return new Error(`invalid runtime auth mode "${authMode}"`);
  }
  if (provider.toLowerCase() === "codebuddy" && authMode !== RuntimeAuthPersonal) {
    return new Error("CodeBuddy 仅支持个人凭证");
  }
  if (IsAgentCLIKind(provider) && !SupportsRunnerLogin(provider) && authMode !== RuntimeAuthPersonal) {
    return new Error(`${provider} 仅支持个人凭证`);
  }
  return this.updateRunnerRuntimes(runnerID, (runtimes) => {
    let found = false;
    for (let i = 0; i < runtimes.length; i++) {
      if (runtimes[i].Provider.toLowerCase() === provider.toLowerCase()) {
        runtimes[i].AuthMode = authMode;
        found = true;
      }
    }
    if (!found) {
      return [false, new Error(`runtime "${provider}" not found on runner ${runnerID}`)];
    }
    return [true, null];
  }, now);
};

RunnersRepo.prototype.SetRunnerRuntimeStatus = function (runnerID, provider, status, now) {
  if (status !== RuntimeStatusOnline && status !== RuntimeStatusDisabled) {
    return new Error(`invalid runtime status "${status}"`);
  }
  return this.updateRunnerRuntimes(runnerID, (runtimes) => {
    let found = false;
    for (let i = 0; i < runtimes.length; i++) {
      if (runtimes[i].Provider.toLowerCase() === provider.toLowerCase()) {
        runtimes[i].Status = status;
        found = true;
      }
    }
    if (!found) {
      return [false, new Error(`runtime "${provider}" not found on runner ${runnerID}`)];
    }
    return [true, null];
  }, now);
};

RunnersRepo.prototype.updateRunnerRuntimes = function (runnerID, mutate, now) {
  const [current, ok] = this.runnerRow(runnerID);
  if (!ok) {
    return ErrRunnerNotFound;
  }
  const [changed, err] = mutate(current.Runtimes);
  if (err != null) {
    return err;
  }
  if (!changed) {
    return null;
  }
  let raw;
  try {
    raw = JSON.stringify(current.Runtimes);
  } catch (marshalErr) {
    return marshalErr;
  }
  return this.DB.Model(new runnerRow()).Where("id = ?", runnerID).Updates({
    runtimes: raw, updated_at: now,
  }).Error;
};

RunnersRepo.prototype.MarkOfflineRunners = function (threshold, now) {
  if (this.DB == null) {
    return;
  }
  const cutoff = new Date(now.getTime() - threshold);
  this.DB.Model(new runnerRow()).
    Where("status <> ? AND last_seen_at IS NOT NULL AND last_seen_at < ?", RunnerStatusOffline, cutoff).
    Updates({ status: RunnerStatusOffline, updated_at: now });
};

RunnersRepo.prototype.MarkRunnerOffline = function (id, now) {
  id = id.trim();
  if (id === "") {
    return ErrRunnerNotFound;
  }
  const res = this.DB.Model(new runnerRow()).Where("id = ?", id).Updates({
    status: RunnerStatusOffline, updated_at: now,
  });
  if (res.Error != null) {
    return res.Error;
  }
  if (res.RowsAffected === 0) {
    return ErrRunnerNotFound;
  }
  return null;
};

// ---------- Runner tasks ----------

RunnersRepo.prototype.PutRunnerTask = function (v) {
  if (v.ID.trim() === "") {
    return new Error("runner task id is required");
  }
  if (v.Provider.trim() === "") {
    return new Error("runner task provider is required");
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
  return upsert(this.DB, "runner_tasks", runnerTaskRowValues(v));
};

RunnersRepo.prototype.RunnerTask = function (id) {
  const [row, ok] = takeRunnerTask(this.DB, id);
  if (!ok) {
    return [new RunnerTask(), false];
  }
  return [runnerTaskFromRow(row), true];
};

RunnersRepo.prototype.RunnerTaskControl = function (id) {
  const row = new runnerTaskRow();
  if (this.DB.Select("id", "desired_state", "status", "lease_owner").Where("id = ?", id).Take(row).Error != null) {
    return [new RunnerTask(), false];
  }
  return [new RunnerTask({ ID: row.ID, DesiredState: row.DesiredState, Status: row.Status, LeaseOwner: row.LeaseOwner }), true];
};

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

RunnersRepo.prototype.RunnerTaskAvailable = function (runnerID, providers) {
  if (runnerID.trim() === "" || providers.length === 0) {
    return [false, null];
  }
  const allowed = [];
  for (let provider of providers) {
    provider = provider.trim();
    if (provider !== "") {
      allowed.push(provider);
    }
  }
  if (allowed.length === 0) {
    return [false, null];
  }
  const rows = [];
  const err = this.DB.Select("id").Where("status = ? AND (runner_id = '' OR runner_id = ?) AND provider IN ?", RunnerTaskQueued, runnerID, allowed).Limit(1).Find(rows).Error;
  return [rows.length > 0, err];
};

RunnersRepo.prototype.ClaimRunnerTask = function (runnerID, providers, now, leaseTTL) {
  if (runnerID.trim() === "") {
    return [new RunnerTask(), false, new Error("runner id is required")];
  }
  if (providers.length === 0) {
    return [new RunnerTask(), false, null];
  }
  const allowed = [];
  for (let p of providers) {
    p = p.trim();
    if (p !== "") {
      allowed.push(p);
    }
  }
  if (allowed.length === 0) {
    return [new RunnerTask(), false, null];
  }
  let claimed = new RunnerTask();
  let found = false;
  const err = this.DB.Transaction((tx) => {
    const rows = [];
    const findErr = this.locking(tx).
      Where("status = ? AND (runner_id = '' OR runner_id = ?) AND provider IN ?", RunnerTaskQueued, runnerID, allowed).
      Order("created_at").Limit(1).
      Find(rows).Error;
    if (findErr != null) {
      return findErr;
    }
    if (rows.length === 0) {
      return null;
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
      return res.Error;
    }
    if (res.RowsAffected === 0) {
      return null;
    }
    const [row, ok] = takeRunnerTask(tx, taskID);
    if (!ok) {
      return new Error(`claimed task ${taskID} disappeared`);
    }
    claimed = runnerTaskFromRow(row);
    found = true;
    return null;
  });
  if (err != null) {
    return [new RunnerTask(), false, err];
  }
  return [claimed, found, null];
};

RunnersRepo.prototype.StartRunnerTask = function (id, runnerID, now) {
  return this.DB.Transaction((tx) => {
    const [row, ok] = this.takeRunnerTaskForLease(tx, id, runnerID);
    if (!ok) {
      return ErrRunnerTaskLeaseLost;
    }
    const task = runnerTaskFromRow(row);
    task.Status = RunnerTaskRunning;
    if (task.StartedAt == null) {
      task.StartedAt = now;
    }
    task.UpdatedAt = now;
    return tx.Model(new runnerTaskRow()).Where("id = ?", id).Updates({
      status: task.Status, payload: runnerTaskPayloadBytes(task), updated_at: now,
    }).Error;
  });
};

RunnersRepo.prototype.takeRunnerTaskForLease = function (tx, id, runnerID) {
  const row = new runnerTaskRow();
  if (this.locking(tx).
    Where("id = ? AND lease_owner = ? AND status IN ?", id, runnerID, [RunnerTaskLeased, RunnerTaskRunning]).
    Take(row).Error != null) {
    return [new runnerTaskRow(), false];
  }
  return [row, true];
};

RunnersRepo.prototype.RenewRunnerTaskLease = function (id, runnerID, ttl, now) {
  let desired = "";
  const err = this.DB.Transaction((tx) => {
    const [row, ok] = this.takeRunnerTaskForLease(tx, id, runnerID);
    if (!ok) {
      return ErrRunnerTaskLeaseLost;
    }
    const updateErr = tx.Model(new runnerTaskRow()).Where("id = ?", id).Updates({
      lease_until: new Date(now.getTime() + ttl), updated_at: now,
    }).Error;
    if (updateErr != null) {
      return updateErr;
    }
    desired = row.DesiredState;
    return null;
  });
  return [desired, err];
};

RunnersRepo.prototype.CompleteRunnerTask = function (id, runnerID, status, exitCode, result, errMsg, artifacts, outputs, now) {
  if (status !== RunnerTaskSuccess && status !== RunnerTaskFailed && status !== RunnerTaskCanceled) {
    return new Error(`invalid final task status "${status}"`);
  }
  return this.DB.Transaction((tx) => {
    const [row, ok] = this.takeRunnerTaskForLease(tx, id, runnerID);
    if (!ok) {
      return ErrRunnerTaskLeaseLost;
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
    return tx.Model(new runnerTaskRow()).Where("id = ?", id).Updates(runnerTaskRowValues(task)).Error;
  });
};

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

RunnersRepo.prototype.CancelRunnerTask = function (id, now) {
  return this.DB.Transaction((tx) => {
    const res = tx.Model(new runnerTaskRow()).
      Where("id = ? AND status = ?", id, RunnerTaskQueued).
      Updates({ status: RunnerTaskCanceled, lease_owner: "", lease_until: null, desired_state: "", updated_at: now });
    if (res.Error != null) {
      return res.Error;
    }
    if (res.RowsAffected > 0) {
      const [row, ok] = takeRunnerTask(tx, id);
      if (ok) {
        const task = runnerTaskFromRow(row);
        scrubRunnerTaskCredentials(task);
        task.CompletedAt = now;
        return tx.Model(new runnerTaskRow()).Where("id = ?", id).Updates({
          payload: runnerTaskPayloadBytes(task), updated_at: now,
        }).Error;
      }
      return null;
    }
    return tx.Model(new runnerTaskRow()).
      Where("id = ? AND status IN ?", id, [RunnerTaskLeased, RunnerTaskRunning]).
      Updates({ desired_state: RunnerTaskDesiredCancel, updated_at: now }).Error;
  });
};

RunnersRepo.prototype.ExpireRunnerTasks = function (now) {
  const recovered = [];
  const err = this.DB.Transaction((tx) => {
    const rows = [];
    const findErr = this.locking(tx).
      Where("status IN ? AND lease_until IS NOT NULL AND lease_until < ?", [RunnerTaskLeased, RunnerTaskRunning], now).
      Find(rows).Error;
    if (findErr != null) {
      return findErr;
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
        return updateErr;
      }
      recovered.push(task);
    }
    return null;
  });
  return [recovered, err];
};

RunnersRepo.prototype.AppendRunnerTaskEvents = function (taskID, events) {
  taskID = taskID.trim();
  if (taskID === "") {
    return [0, new Error("task id is required")];
  }
  if (events.length === 0) {
    return [0, null];
  }
  let accepted = 0;
  const err = this.DB.Transaction((tx) => {
    accepted = 0;
    for (const ev of events) {
      const inserted = insertIgnore(tx, "runner_task_events", {
        task_id: taskID, seq: ev.Seq, type: ev.Type, data: ev.Data, ts: timePtr(ev.Ts),
      });
      if (inserted) {
        accepted++;
      }
    }
    return null;
  });
  return [accepted, err];
};

RunnersRepo.prototype.RunnerTaskEvents = function (taskID) {
  return this.RunnerTaskEventsAfter(taskID, 0);
};

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

RunnersRepo.prototype.DeregisterRunner = function (id, now) {
  id = id.trim();
  if (id === "") {
    return new Error("runner id is required");
  }
  return this.DB.Transaction((tx) => {
    const rows = [];
    const findErr = tx.Where("runner_id = ? AND status = ?", id, RunnerTaskQueued).Find(rows).Error;
    if (findErr != null) {
      return findErr;
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
        return updateErr;
      }
    }
    const deleteErr = tx.Where("default_runner_id = ?", id).Delete(new userRunnerPrefRow()).Error;
    if (deleteErr != null) {
      return deleteErr;
    }
    const res = tx.Where("id = ?", id).Delete(new runnerRow());
    if (res.Error != null) {
      return res.Error;
    }
    if (res.RowsAffected === 0) {
      return ErrRunnerNotFound;
    }
    return null;
  });
};

// ---------- default execution machine (执行机器) ----------

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

RunnersRepo.prototype.SetDefaultRunner = function (userID, runnerID, now) {
  if (userID <= 0) {
    return new Error("user id is required");
  }
  runnerID = runnerID.trim();
  if (runnerID !== "") {
    const [, ok] = this.Runner(runnerID);
    if (!ok) {
      return ErrRunnerNotFound;
    }
  }
  if (runnerID === "") {
    return this.DB.Where("user_id = ?", userID).Delete(new userRunnerPrefRow()).Error;
  }
  return upsert(this.DB, "user_runner_prefs", {
    user_id: userID, default_runner_id: runnerID, updated_at: timePtr(now),
  });
};

// ---------- helpers ----------

function nullableInt64(v) {
  if (v === 0) {
    return null;
  }
  return v;
}

function sortRunnerTasksByCreated(tasks) {
  tasks.sort((a, b) => timeMs(a.CreatedAt) - timeMs(b.CreatedAt));
}

RunnersRepo.prototype.ActiveRunnerTasksForRun = function (runID) {
  runID = runID.trim();
  if (runID === "") {
    return [null, null];
  }
  const rows = [];
  const err = this.DB.Where("status IN ?", [RunnerTaskQueued, RunnerTaskLeased, RunnerTaskRunning]).Find(rows).Error;
  if (err != null) {
    return [null, err];
  }
  const out = [];
  for (const row of rows) {
    const task = runnerTaskFromRow(row);
    if (task.RunID === runID) {
      out.push(task);
    }
  }
  return [out, null];
};

RunnersRepo.prototype.CancelRunnerTasksForRun = function (runID, now) {
  const [tasks, err] = this.ActiveRunnerTasksForRun(runID);
  if (err != null) {
    return [null, err];
  }
  const ids = [];
  for (const task of tasks ?? []) {
    const cancelErr = this.CancelRunnerTask(task.ID, now);
    if (cancelErr != null) {
      return [ids, cancelErr];
    }
    ids.push(task.ID);
  }
  return [ids, null];
};

module.exports = { ErrRunnerTaskNotClaimable, ErrRunnerTaskLeaseLost, ErrRunnerNotFound, runnerTaskPayload, runnerTaskTime, parseRunnerTaskTime, newRunnerTaskTime, runnerTaskFromRow, runnerTaskPayloadBytes, runnerTaskRowValues, takeRunnerTask, MaxRunnerRunLimit, runnerFromRow, scrubRunnerTaskCredentials, nullableInt64, sortRunnerTasksByCreated };
