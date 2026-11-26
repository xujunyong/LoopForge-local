/**
 * @file internal/repo/workspace_checkpoints.js
 * 对应 Go 源文件：internal/repo/workspace_checkpoints.go
 *
 * 作用与职责边界：
 * 实现运行工作区快照与跨实例使用租约（`run_workspace_checkpoints` 表）的完整生命周期管理，
 * 包括快照元数据读取、内联快照读写、前台使用/后台归档/恢复租约的获取、抢占、交接、续约与释放、
 * 废弃租约回收、跟进标记、工作区重绑定及显式删除声明；
 * 领域方法挂载于 `RunsRepo.prototype`（`RunsRepo` 定义于 `repo.js`），分块流式存取与恢复收尾分别位于 `workspace_checkpoint_chunks.js` 与 `workspace_restore.js`。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)`、`(值1, 值2, error)` 与仅 `error` 返回统一按成功返回值（或二元组、`undefined`）、失败 `throw err` 处理；
 *   `db.Transaction(tx => ...)` 回调同样遵循失败抛错、成功正常返回。
 * - Go 的 `(值, bool)` 译为二元组 `[值, boolean]`；`errors.Is(err, gorm.ErrRecordNotFound)` 译为 `===`；`time.Duration` 换算为毫秒。
 * - 与 `workspace_checkpoint_chunks.js`、`workspace_restore.js` 存在同包循环引用，引用其导出的常量与模型时统一采用函数内延迟 `require`。
 * - Go 的 `io.ReadAll` 保留原调用形态并按返回值/抛错约定表达；`Count(&n)` 指针出参使用 `{ value: 0 }` 对象承接。
 */

"use strict";

const { randomBytes, createHash } = require("node:crypto");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runRow, runNodeRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { assistantHeartbeatTimeout } = require("./assistant_generations.js"); // 对应 Go 同包常量，assistant_generations.js 已翻译

/**
 * 运行工作区快照与租约状态表的实体模型，对应数据库表 `run_workspace_checkpoints`。
 */
class WorkspaceCheckpoint {
  /**
   * 构造 `WorkspaceCheckpoint` 实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ArchiveID = init.ArchiveID ?? "";
    this.ArchiveBytes = init.ArchiveBytes ?? 0;
    this.ArchiveChunks = init.ArchiveChunks ?? 0;
    this.SaveFailures = init.SaveFailures ?? 0;
    this.SaveRetryAt = init.SaveRetryAt ?? null;
    this.RunID = init.RunID ?? "";
    this.Archive = init.Archive ?? null;
    this.SHA256 = init.SHA256 ?? "";
    this.LastUsedAt = init.LastUsedAt ?? null;
    this.SavedAt = init.SavedAt ?? null;
    this.FollowUp = init.FollowUp ?? false;
    this.Error = init.Error ?? "";
    this.LeaseHandoffID = init.LeaseHandoffID ?? "";
    this.LeaseToken = init.LeaseToken ?? "";
    this.LeaseUntil = init.LeaseUntil ?? null;
    // 最近一次获取或续约租约的时刻：MySQL 下采用数据库时钟（见 leaseRenewalClock），
    // 以便其他副本准确衡量持有者心跳沉默时长，不受持有者本机时钟偏差影响。
    this.LeaseRenewedAt = init.LeaseRenewedAt ?? null;
    this.RestoreStatus = init.RestoreStatus ?? "";
    this.RestoreStarted = init.RestoreStarted ?? null;
    this.RestoreError = init.RestoreError ?? "";
    // 会话切离当前工作区的时刻；在再次使用前允许后台巡检立即回收而无需等待 1 小时空闲期。
    this.ReleasedAt = init.ReleasedAt ?? null;
  }

  /**
   * 返回当前模型对应的物理数据库表名。
   * 使用场景：供 GORM 映射物理表名称。
   *
   * @returns {string} 固定返回 `"run_workspace_checkpoints"`。
   */
  TableName() {
    return "run_workspace_checkpoints";
  }

  /**
   * 判断工作区是否在最后一次使用之后已被显式释放（`ReleasedAt` 不为空且 `LastUsedAt` 不晚于 `ReleasedAt`）。
   * 使用场景：空闲清理时判断是否可以跳过 1 小时跟进保护期直接回收工作区。
   *
   * @returns {boolean} 已释放返回 `true`，否则返回 `false`。
   */
  Released() {
    return this.ReleasedAt != null && !(this.LastUsedAt != null && this.LastUsedAt.getTime() > this.ReleasedAt.getTime());
  }
}

// 工作区当前已被其他前台轮次、恢复流程或后台保存占用时抛出的租约冲突错误。
const ErrWorkspaceInUse = new Error("工作区正在使用或保存，请稍后重试");
// 工作区快照保存失败后处于指数退避冷却期内时抛出的错误。
const ErrWorkspaceCheckpointBackoff = new Error("workspace checkpoint save is backing off");

// 后台归档保存租约令牌前缀，用于区分可被前台抢占的后台保存租约。
const workspaceBackgroundSavePrefix = "save:";

// 工作区租约自上次续约起的有效时长（15 分钟，换算为毫秒）。
const workspaceUseTerm = 15 * 60 * 1000;

/**
 * 读取指定运行的工作区快照元数据（刻意跳过大字段 `archive` 列以降低查询开销）。
 * 使用场景：前端展示快照保存状态或调度层检查租约与恢复状态。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @returns {[WorkspaceCheckpoint, boolean]} 找到记录时返回 `[checkpoint, true]`，否则返回 `[空 WorkspaceCheckpoint, false]`。
 */
RunsRepo.prototype.WorkspaceCheckpoint = function (runID) {
  const item = new WorkspaceCheckpoint();
  const err = this.DB.Omit("archive").Where("run_id = ?", runID).Take(item).Error;
  return [item, err == null];
};

/**
 * 完整读取并校验指定运行的工作区快照归档字节内容（自动兼容内联与分块存储）。
 * 使用场景：需要将整个快照归档一次性载入内存或测试校验时调用。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @returns {Buffer} 校验通过后的完整快照归档字节缓冲区。
 * @throws {Error} 打开归档失败、校验失败或读流失败时抛出错误。
 */
RunsRepo.prototype.WorkspaceCheckpointArchive = function (runID) {
  const source = this.OpenWorkspaceCheckpointArchive(runID);
  try {
    return io.ReadAll(source);
  } finally {
    source.Close();
  }
};

/**
 * 获取指定运行工作区的前台使用租约（必要时自动抢占正在进行的后台归档保存租约）。
 * 使用场景：交互式轮次、工具操作或工作区文件编辑前申请独占使用权。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {Date} now - 当前时刻，用于租约到期判定与更新 `last_used_at`。
 * @returns {string} 新签发的前台使用租约令牌。
 * @throws {Error} 工作区被其他独占租约占用或数据库事务失败时抛出错误。
 */
RunsRepo.prototype.BeginWorkspaceUse = function (runID, now) {
  const [token] = this.BeginWorkspaceUsePreemptingSave(runID, now);
  return token;
};

/**
 * 获取前台工作区使用租约，并允许抢占正在进行的后台归档保存租约；执行、恢复及维护删除租约仍保持互斥。
 * 被抢占的旧保存流程仍需按旧令牌 CAS 发布和结束，因此不会干扰新租约持有者。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {Date} now - 当前时刻。
 * @returns {[string, string]} 二元组 `[新前台租约令牌, 被抢占的后台保存令牌（未抢占时为空串）]`。
 * @throws {Error} 工作区被其他非后台保存租约占用或数据库事务失败时抛出错误。
 */
RunsRepo.prototype.BeginWorkspaceUsePreemptingSave = function (runID, now) {
  // Go 用 *string 接出参，JS 用 { value } 对象接出参。
  const previous = { value: "" };
  const token = this.beginWorkspaceLease(runID, now, true, false, previous);
  return [token, previous.value];
};

/**
 * 将当前持有的前台使用租约无间隙交接为带 `"save:"` 前缀的后台归档保存租约，
 * 既让后续前台操作可随时抢占归档，又通过写入 `save_retry_at` 让维护任务能够接管崩溃的后台保存。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} token - 当前持有的前台使用租约令牌（不能为空且不能已是后台保存令牌）。
 * @param {Date} now - 交接时刻。
 * @returns {string} 交接后生成的新后台保存租约令牌（`"save:" + token`）。
 * @throws {Error} 令牌非法、租约已丢失/过期（`ErrWorkspaceInUse`）或数据库更新失败时抛出错误。
 */
RunsRepo.prototype.HandoffWorkspaceUseToSave = function (runID, token, now) {
  if (token === "" || token.startsWith(workspaceBackgroundSavePrefix)) {
    throw ErrWorkspaceInUse;
  }
  const saveToken = workspaceBackgroundSavePrefix + token;
  this.DB.Transaction((tx) => {
    this.takeRunForUpdate(tx, runID);
    const result = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, now).Updates({
      lease_token: saveToken, lease_handoff_id: "", last_used_at: now, save_retry_at: now,
    });
    if (result.Error != null) {
      throw result.Error;
    }
    if (result.RowsAffected !== 1) {
      throw ErrWorkspaceInUse;
    }
  });
  return saveToken;
};

/**
 * 为后台空闲快照保存与清理流程申请独占租约（不刷新 `last_used_at`，并受保存失败退避时间 `SaveRetryAt` 约束）。
 * 使用场景：后台巡检任务尝试为已空闲的工作区执行快照归档。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {Date} now - 当前时刻。
 * @returns {string} 新签发的租约令牌。
 * @throws {Error} 处于保存退避期（`ErrWorkspaceCheckpointBackoff`）、工作区被占用（`ErrWorkspaceInUse`）或数据库失败时抛出错误。
 */
RunsRepo.prototype.BeginWorkspaceCheckpointSave = function (runID, now) {
  return this.beginWorkspaceLease(runID, now, false, false);
};

/**
 * 统一的工作区租约获取事务实现，在锁定 `runs` 行后创建或更新 `run_workspace_checkpoints` 租约记录。
 * 支持前台使用（`touch=true, restoring=false`，可抢占后台保存）、恢复（`touch=true, restoring=true`）
 * 及后台维护保存（`touch=false, restoring=false`）三种模式。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {Date} now - 当前时刻。
 * @param {boolean} touch - 是否刷新 `last_used_at` 并忽略保存失败退避窗口。
 * @param {boolean} restoring - 是否为工作区快照恢复流程申请租约。
 * @param {...{ value: string }} preempted - 可选出参容器，前台抢占后台保存时写回被抢占的旧令牌。
 * @returns {string} 新签发的十六进制随机租约令牌；若 `restoring=true` 且工作区已绑定且无需重恢复，则返回空字符串 `""`。
 * @throws {Error} 租约冲突（`ErrWorkspaceInUse`）、退避未到期（`ErrWorkspaceCheckpointBackoff`）或数据库操作失败时抛出错误。
 */
RunsRepo.prototype.beginWorkspaceLease = function (runID, now, touch, restoring, ...preempted) {
  const { WorkspaceRestoreInterrupted } = require("./workspace_restore.js"); // 延迟引用避免与 workspace_restore.js 循环依赖
  const raw = randomBytes(24);
  let token = raw.toString("hex");
  this.DB.Transaction((tx) => {
    const run = this.takeRunForUpdate(tx, runID);
    const checkpoint = new WorkspaceCheckpoint();
    const takeErr = tx.Omit("archive").Where("run_id = ?", runID).Take(checkpoint).Error;
    if (takeErr != null && takeErr !== gorm.ErrRecordNotFound) {
      throw takeErr;
    }
    // 已绑定工作区若上次恢复失败或仍停留在 restoring，仍需重试恢复而不能直接视作就绪。
    const unfinished = checkpoint.RestoreStatus === "failed" || checkpoint.RestoreStatus === "restoring";
    if (restoring && run.WorkspaceCleaned == null && !unfinished) {
      token = "";
      return;
    }
    if (!touch && checkpoint.SaveRetryAt != null && now.getTime() < checkpoint.SaveRetryAt.getTime()) {
      throw ErrWorkspaceCheckpointBackoff;
    }
    const until = new Date(now.getTime() + workspaceUseTerm);
    let lastUsed = now;
    if (!touch && run.Updated != null) {
      lastUsed = run.Updated;
    }
    const row = new WorkspaceCheckpoint({ RunID: runID, LastUsedAt: lastUsed });
    const createErr = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
    if (createErr != null) {
      throw createErr;
    }
    const values = { lease_token: token, lease_until: until, lease_renewed_at: this.leaseRenewalClock(now), lease_handoff_id: "" };
    if (touch) {
      values["last_used_at"] = now;
    }
    if (restoring) {
      values["restore_status"] = "restoring";
      values["restore_started"] = now;
      values["restore_error"] = "";
    } else if (checkpoint.RestoreStatus === "restoring") {
      // 接管一个已过期的恢复租约会栅栏隔离原恢复过程，将其标记为中断失败以便后续绑定区分。
      values["restore_status"] = "failed";
      values["restore_error"] = WorkspaceRestoreInterrupted;
    }
    let query = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ?", runID);
    if (touch && !restoring) {
      const current = new WorkspaceCheckpoint();
      const currentErr = tx.Omit("archive").Where("run_id = ?", runID).Take(current).Error;
      if (currentErr != null) {
        throw currentErr;
      }
      if (current.LeaseToken.startsWith(workspaceBackgroundSavePrefix) && preempted.length > 0) {
        preempted[0].value = current.LeaseToken;
      }
      query = query.Where("lease_until IS NULL OR lease_until < ? OR lease_token LIKE ?", now, workspaceBackgroundSavePrefix + "%");
    } else {
      query = query.Where("lease_until IS NULL OR lease_until < ?", now);
    }
    const result = query.Updates(values);
    if (result.Error != null) {
      throw result.Error;
    }
    if (result.RowsAffected !== 1) {
      throw ErrWorkspaceInUse;
    }
  });
  return token;
};

/**
 * 续约当前持有的工作区租约，将 `lease_until` 顺延一个 `workspaceUseTerm` 并刷新 `lease_renewed_at`。
 * 在锁定 `runs` 行后先读取验证令牌匹配，避免同一毫秒内 `lease_until` 未变化时被 MySQL 误判为丢失租约。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} token - 当前持有的租约令牌。
 * @param {Date} now - 续约时刻。
 * @returns {void} 无返回值。
 * @throws {Error} 租约已不属于该令牌（`ErrWorkspaceInUse`）或数据库更新失败时抛出错误。
 */
RunsRepo.prototype.RenewWorkspaceUse = function (runID, token, now) {
  this.DB.Transaction((tx) => {
    this.takeRunForUpdate(tx, runID);
    const checkpoint = new WorkspaceCheckpoint();
    const takeErr = tx.Omit("archive").Where("run_id = ? AND lease_token = ?", runID, token).Take(checkpoint).Error;
    if (takeErr != null) {
      if (takeErr === gorm.ErrRecordNotFound) {
        throw ErrWorkspaceInUse;
      }
      throw takeErr;
    }
    // 已通过 run 行加锁并读出匹配令牌，即使同毫秒内 lease_until 值未变仍视作有效续约。
    const until = new Date(now.getTime() + workspaceUseTerm);
    const err = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ?", runID, token).Updates({ lease_until: until, lease_renewed_at: this.leaseRenewalClock(now) }).Error;
    if (err != null) {
      throw err;
    }
  });
};

/**
 * 结束一次前台工作区使用并释放租约；可选附带内联归档字节或保存失败错误信息。
 * 使用场景：工作区轮次或编辑会话退出时收尾释放租约。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} token - 当前持有的租约令牌。
 * @param {Date} now - 使用结束时刻。
 * @param {Buffer | null} archive - 可选的内联归档字节；为 `null` 时不覆盖快照内容。
 * @param {string} saveError - 可选的快照保存错误说明；非空时触发指数退避重试调度。
 * @returns {void} 无返回值。
 * @throws {Error} 租约丢失（`ErrWorkspaceInUse`）或数据库操作失败时抛出错误。
 */
RunsRepo.prototype.FinishWorkspaceUse = function (runID, token, now, archive, saveError) {
  let attemptedAt = new Date();
  if (now.getTime() > attemptedAt.getTime()) {
    attemptedAt = now;
  }
  this.finishWorkspaceUse(runID, token, now, attemptedAt, archive, saveError);
};

/**
 * 结束一次后台工作区快照保存租约；保持工作区原空闲起始时间 `idleSince`，并在失败时基于 `attemptedAt` 计算下次退避时间。
 * 使用场景：后台归档保存任务完成或失败后释放租约。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} token - 当前持有的后台保存租约令牌。
 * @param {Date} idleSince - 工作区原本的最后活跃时间，避免后台保存把空闲计时重置。
 * @param {Date} attemptedAt - 本次保存尝试时刻，用于计算失败指数退避基准。
 * @param {string} saveError - 本次保存失败信息；成功时传空字符串 `""`。
 * @returns {void} 无返回值。
 * @throws {Error} 租约丢失（`ErrWorkspaceInUse`）或数据库操作失败时抛出错误。
 */
RunsRepo.prototype.FinishWorkspaceCheckpointSave = function (runID, token, idleSince, attemptedAt, saveError) {
  this.finishWorkspaceUse(runID, token, idleSince, attemptedAt, null, saveError);
};

/**
 * 在事务内释放工作区租约的内部公共实现：若传入内联 `archive` 则写入归档并清理旧分块，
 * 若传入 `saveError` 则按 5 分钟起步、最高 6 小时的指数退避递增失败计数并设置 `save_retry_at`。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} token - 当前持有的租约令牌。
 * @param {Date} now - 期望更新的 `last_used_at`（不会倒退到已有 `LastUsedAt` 之前）。
 * @param {Date} attemptedAt - 计算保存失败重试退避的基准时间。
 * @param {Buffer | null} archive - 可选的内联快照归档字节。
 * @param {string} saveError - 可选的保存错误信息。
 * @returns {void} 无返回值。
 * @throws {Error} 租约丢失（`ErrWorkspaceInUse`）或数据库事务失败时抛出错误。
 */
RunsRepo.prototype.finishWorkspaceUse = function (runID, token, now, attemptedAt, archive, saveError) {
  const { workspaceCheckpointChunk } = require("./workspace_checkpoint_chunks.js"); // 延迟引用避免循环依赖
  this.DB.Transaction((tx) => {
    this.takeRunForUpdate(tx, runID);
    const item = new WorkspaceCheckpoint();
    const takeErr = tx.Omit("archive").Where("run_id = ? AND lease_token = ?", runID, token).Take(item).Error;
    if (takeErr != null) {
      if (takeErr === gorm.ErrRecordNotFound) {
        throw ErrWorkspaceInUse;
      }
      throw takeErr;
    }
    if (item.LastUsedAt != null && item.LastUsedAt.getTime() > now.getTime()) {
      now = item.LastUsedAt;
    }
    const values = { lease_token: "", lease_until: null, lease_handoff_id: "", last_used_at: now };
    if (archive != null) {
      const sum = createHash("sha256").update(archive).digest();
      values["archive"] = archive;
      values["archive_id"] = "";
      values["archive_bytes"] = archive.length;
      values["archive_chunks"] = 0;
      values["sha256"] = sum.toString("hex");
      values["saved_at"] = now;
      values["error"] = "";
      values["save_failures"] = 0;
      values["save_retry_at"] = null;
    } else if (saveError !== "") {
      const failures = Math.min(item.SaveFailures + 1, 12);
      const delay = Math.min(5 * 60 * 1000 * (1 << (failures - 1)), 6 * 60 * 60 * 1000);
      const next = new Date(attemptedAt.getTime() + delay);
      values["error"] = saveError;
      values["save_failures"] = failures;
      values["save_retry_at"] = next;
    }
    const result = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ?", runID, token).Updates(values);
    if (result.Error != null) {
      throw result.Error;
    }
    if (result.RowsAffected !== 1) {
      throw ErrWorkspaceInUse;
    }
    if (archive != null) {
      const delErr = tx.Where("run_id = ?", runID).Delete(new workspaceCheckpointChunk()).Error;
      if (delErr != null) {
        throw delErr;
      }
    }
  });
};

/**
 * 在删除本地磁盘工作区前，原子校验运行修订号、运行/节点空闲状态、有效租约、快照已安全落盘
 * 以及 1 小时跟进保护期，通过后将 `runs.workspace_cleaned_at` 置为 `now` 并清空 `sandbox_id`。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} token - 当前持有的维护租约令牌。
 * @param {number} revision - 期望的运行记录乐观锁修订版本号。
 * @param {Date} now - 回收判定与标记时刻。
 * @returns {boolean} 成功声明回收权返回 `true`；条件不满足跳过回收时返回 `false`。
 * @throws {Error} 租约无效、快照尚未成功保存或数据库操作失败时抛出错误。
 */
RunsRepo.prototype.ClaimCheckpointWorkspaceCleanup = function (runID, token, revision, now) {
  let claimed = false;
  this.DB.Transaction((tx) => {
    const row = this.takeRunForUpdate(tx, runID);
    if (row.Revision !== revision || row.Status === "running" || row.Status === "queued" || row.WorkspaceCleaned != null || row.CleanupNotBefore != null && now.getTime() < row.CleanupNotBefore.getTime()) {
      return;
    }
    const checkpoint = new WorkspaceCheckpoint();
    const takeErr = tx.Omit("archive").Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, now).Take(checkpoint).Error;
    if (takeErr != null) {
      throw takeErr;
    }
    if (checkpoint.SavedAt == null || checkpoint.SHA256 === "" || checkpoint.Error !== "") {
      throw new Error("工作区未成功保存，暂缓回收");
    }
    if (checkpoint.FollowUp && !checkpoint.Released() && now.getTime() < checkpoint.LastUsedAt.getTime() + 60 * 60 * 1000) {
      return;
    }
    // Go 的 Count(&count) 用对象接出参。
    const count = { value: 0 };
    const countErr = tx.Model(new runNodeRow()).Where("run_id = ? AND status = ?", runID, "running").Count(count).Error;
    if (countErr != null) {
      throw countErr;
    }
    if (count.value !== 0) {
      return;
    }
    const result = tx.Model(new runRow()).Where("id = ? AND revision = ?", runID, revision).Updates({ workspace_cleaned_at: now, sandbox_id: "" });
    claimed = result.RowsAffected === 1;
    if (result.Error != null) {
      throw result.Error;
    }
  });
  return claimed;
};

/**
 * 在持有有效租约的前提下，将已恢复到新目录的工作区重新绑定回运行记录：
 * 清除 `workspace_cleaned_at`、递增 `revision`，并在传入新宿主机时更新 `workspace_host` 与 `workspace_root`；
 * 非恢复租约绑定时顺带将此前失败的恢复状态重置为 `"ready"`。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} token - 当前持有的工作区租约令牌。
 * @param {string} host - 恢复后的工作区宿主机标识；空串表示沿用原有宿主机。
 * @param {string} root - 恢复后的工作区本地根目录路径。
 * @param {Date} now - 租约有效期校验时刻。
 * @returns {void} 无返回值。
 * @throws {Error} 租约无效或已过期（`ErrWorkspaceInUse`）或数据库更新失败时抛出错误。
 */
RunsRepo.prototype.RestoreCheckpointWorkspaceBinding = function (runID, token, host, root, now) {
  this.DB.Transaction((tx) => {
    this.takeRunForUpdate(tx, runID);
    // Go 的 Count(&count) 用对象接出参。
    const count = { value: 0 };
    const countErr = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, now).Count(count).Error;
    if (countErr != null) {
      throw countErr;
    }
    if (count.value !== 1) {
      throw ErrWorkspaceInUse;
    }
    // 恢复租约保持 restoring 状态直至 FinishWorkspaceRestore 记录最终结果；
    // 其他租约重新绑定工作区则会覆盖此前失败或被中断的恢复状态。
    const failedErr = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ? AND restore_status = ?", runID, token, "failed").
      Updates({ restore_status: "ready", restore_error: "" }).Error;
    if (failedErr != null) {
      throw failedErr;
    }
    const values = { workspace_cleaned_at: null, revision: gorm.Expr("revision + 1") };
    if (host !== "") {
      values["workspace_host"] = host;
      values["workspace_root"] = root;
    }
    const err = tx.Model(new runRow()).Where("id = ?", runID).Updates(values).Error;
    if (err != null) {
      throw err;
    }
  });
};

/**
 * 查询 `run_workspace_checkpoints` 表中记录的全部运行 ID 列表。
 * 使用场景：后台巡检任务扫描存在快照记录的运行列表。
 *
 * @returns {string[]} 全部包含快照记录的运行 ID 数组。
 */
RunsRepo.prototype.CheckpointWorkspaceRunIDs = function () {
  const ids = [];
  this.DB.Model(new WorkspaceCheckpoint()).Pluck("run_id", ids);
  return ids;
};

/**
 * 在持有有效租约的前提下，以单行内联方式保存不超过 12 MiB 的工作区快照归档并删除历史分块。
 * 使用场景：小体积归档直接写入主表 `archive` 列（由 `SaveWorkspaceCheckpointStream` 或调用方直接调用）。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} token - 当前持有的工作区租约令牌。
 * @param {Date} now - 记为快照保存完成的时间戳。
 * @param {Buffer} archive - 待保存的完整归档字节缓冲区（长度须在 1 字节至 12 MiB 之间）。
 * @returns {void} 无返回值。
 * @throws {Error} 归档大小不合法、租约失效（`ErrWorkspaceInUse`）或数据库事务失败时抛出错误。
 */
RunsRepo.prototype.SaveWorkspaceCheckpoint = function (runID, token, now, archive) {
  const { workspaceCheckpointChunk, workspaceCheckpointInlineBytes } = require("./workspace_checkpoint_chunks.js"); // 延迟引用避免循环依赖
  const archiveLen = (archive ?? []).length;
  if (archiveLen === 0 || archiveLen > workspaceCheckpointInlineBytes) {
    throw new Error("invalid inline workspace checkpoint size");
  }
  const sum = createHash("sha256").update(archive).digest();
  this.DB.Transaction((tx) => {
    this.takeRunForUpdate(tx, runID);
    const result = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, new Date()).Updates({ archive: archive, archive_id: "", archive_bytes: archive.length, archive_chunks: 0, sha256: sum.toString("hex"), saved_at: now, error: "", save_failures: 0, save_retry_at: null });
    if (result.Error != null) {
      throw result.Error;
    }
    if (result.RowsAffected !== 1) {
      throw ErrWorkspaceInUse;
    }
    const delErr = tx.Where("run_id = ?", runID).Delete(new workspaceCheckpointChunk()).Error;
    if (delErr != null) {
      throw delErr;
    }
  });
};

/**
 * 标记当前工作区已有后续跟进交互并刷新 `last_used_at`；
 * 通过先查询计数而非 `RowsAffected` 校验租约，避免同一毫秒内两个工具连续触达时被 MySQL 误判为租约丢失。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} token - 当前持有的工作区租约令牌。
 * @param {Date} now - 最新使用时刻。
 * @returns {void} 无返回值。
 * @throws {Error} 租约不存在或不匹配（`ErrWorkspaceInUse`）或数据库更新失败时抛出错误。
 */
RunsRepo.prototype.MarkWorkspaceFollowUp = function (runID, token, now) {
  this.DB.Transaction((tx) => {
    holdsWorkspaceLease(tx, runID, token);
    const err = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ?", runID, token).Updates({ follow_up: true, last_used_at: now }).Error;
    if (err != null) {
      throw err;
    }
  });
};

/**
 * 校验指定事务下 `runID` 当前是否正由 `token` 持有租约（仅按读计数校验，不依赖 `RowsAffected`）。
 * 使用场景：供 `MarkWorkspaceFollowUp` 等幂等更新流程在写入前验证租约所有权。
 *
 * @param {object} tx - 当前活跃的 `gorm.DB` 事务句柄。
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} token - 待校验的租约令牌。
 * @returns {void} 无返回值。
 * @throws {Error} 令牌为空、未命中唯一匹配行（`ErrWorkspaceInUse`）或数据库查询失败时抛出错误。
 */
function holdsWorkspaceLease(tx, runID, token) {
  if (token === "") {
    throw ErrWorkspaceInUse;
  }
  // Go 的 Count(&count) 用对象接出参。
  const count = { value: 0 };
  const err = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ?", runID, token).Count(count).Error;
  if (err != null) {
    throw err;
  }
  if (count.value !== 1) {
    throw ErrWorkspaceInUse;
  }
}

/**
 * 释放已被回收的僵死轮次所遗留的前台工作区租约，避免进程崩溃后阻断后续轮次长达 15 分钟。
 * 双重栅栏防止误伤活跃持有者：必须精确匹配该轮次登记的前台令牌（排除后台保存令牌），
 * 且其最近续约时间距今已超过心跳超时阈值（MySQL 下使用数据库统一时钟 `UTC_TIMESTAMP(3)`，旧行无续约时间则回退用 `lease_until` 判断）。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} token - 僵死轮次曾登记的前台租约令牌。
 * @param {Date} now - 当前检查时刻。
 * @returns {boolean} 成功释放 1 条废弃租约时返回 `true`，否则返回 `false`。
 * @throws {Error} 数据库查询或更新失败时抛出错误（`run` 记录不存在时静默返回 `false`）。
 */
RunsRepo.prototype.ReleaseAbandonedWorkspaceUse = function (runID, token, now) {
  runID = runID.trim();
  token = token.trim();
  if (runID === "" || token === "" || token.startsWith(workspaceBackgroundSavePrefix)) {
    return false;
  }
  let released = false;
  this.DB.Transaction((tx) => {
    try {
      this.takeRunForUpdate(tx, runID);
    } catch (e) {
      if (e === gorm.ErrRecordNotFound) {
        return;
      }
      throw e;
    }
    let silent = tx.Where("lease_renewed_at IS NULL AND lease_until <= ?", new Date(now.getTime() + workspaceUseTerm - assistantHeartbeatTimeout));
    if (this.isMySQL()) {
      silent = silent.Or("lease_renewed_at <= UTC_TIMESTAMP(3) - INTERVAL ? MICROSECOND", assistantHeartbeatTimeout * 1000);
    } else {
      silent = silent.Or("lease_renewed_at <= ?", new Date(now.getTime() - assistantHeartbeatTimeout));
    }
    const result = tx.Model(new WorkspaceCheckpoint()).
      Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, now).
      Where(silent).
      Updates({ lease_token: "", lease_until: null, lease_handoff_id: "" });
    released = result.RowsAffected === 1;
    if (result.Error != null) {
      throw result.Error;
    }
  });
  return released;
};

/**
 * 返回写入 `lease_renewed_at` 所使用的时钟值：MySQL 下使用所有副本共享的 `UTC_TIMESTAMP(3)` 表达式，
 * 其他数据库（如测试用 SQLite）使用调用方传入的 `now`。
 *
 * @param {Date} now - 调用方本地当前时间。
 * @returns {object | Date} MySQL 下返回 `clause.Expr`，否则返回 `now`。
 */
RunsRepo.prototype.leaseRenewalClock = function (now) {
  if (this.isMySQL()) {
    return new clause.Expr({ SQL: "UTC_TIMESTAMP(3)" });
  }
  return now;
};

/**
 * 标记工作区不再绑定任何活跃会话，使下一次空闲巡检可直接保存并回收而无需等待完整空闲保护期。
 * 使用场景：对话切换到其他工作区或会话关闭解绑时调用。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {Date} now - 释放时刻。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库事务写入失败时抛出错误。
 */
RunsRepo.prototype.ReleaseWorkspace = function (runID, now) {
  this.DB.Transaction((tx) => {
    const row = new WorkspaceCheckpoint({ RunID: runID, LastUsedAt: now });
    const createErr = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(row).Error;
    if (createErr != null) {
      throw createErr;
    }
    const err = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ?", runID).Update("released_at", now).Error;
    if (err != null) {
      throw err;
    }
  });
};

/**
 * 在工作区尚未被清理的前提下刷新其 `last_used_at` 并打上 `follow_up` 标记。
 * 使用场景：用户或助手访问尚未清理的运行工作区以延长其保留窗口。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {Date} now - 最新访问时刻。
 * @returns {void} 无返回值。
 * @throws {Error} 工作区已被清理（`ErrWorkspaceInUse`）或数据库事务失败时抛出错误。
 */
RunsRepo.prototype.TouchWorkspaceUse = function (runID, now) {
  this.DB.Transaction((tx) => {
    const run = this.takeRunForUpdate(tx, runID);
    if (run.WorkspaceCleaned != null) {
      throw ErrWorkspaceInUse;
    }
    const item = new WorkspaceCheckpoint({ RunID: runID, LastUsedAt: now, FollowUp: true });
    const createErr = tx.Clauses(new clause.OnConflict({ DoNothing: true })).Create(item).Error;
    if (createErr != null) {
      throw createErr;
    }
    const err = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ?", runID).Updates({ last_used_at: now, follow_up: true }).Error;
    if (err != null) {
      throw err;
    }
  });
};

/**
 * 在真正删除磁盘目录之前，基于同一租约与运行乐观锁修订号将工作区标记为已清理（`workspace_cleaned_at = now`），
 * 防止删除期间被重试或新轮次复用该目录。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} token - 当前持有的工作区租约令牌。
 * @param {number} revision - 期望的运行记录乐观锁修订版本号。
 * @param {Date} now - 标记删除与租约校验时刻。
 * @returns {void} 无返回值。
 * @throws {Error} 运行处于活跃状态、修订号不匹配、租约失效（`ErrWorkspaceInUse`）或数据库失败时抛出错误。
 */
RunsRepo.prototype.ClaimWorkspaceDeletion = function (runID, token, revision, now) {
  this.DB.Transaction((tx) => {
    const row = this.takeRunForUpdate(tx, runID);
    if (row.Revision !== revision || row.Status === "running" || row.Status === "waiting" || row.Status === "queued") {
      throw ErrWorkspaceInUse;
    }
    // Go 的 Count(&count) 用对象接出参。
    const count = { value: 0 };
    const countErr = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, now).Count(count).Error;
    if (countErr != null) {
      throw countErr;
    }
    if (count.value !== 1) {
      throw ErrWorkspaceInUse;
    }
    const err = tx.Model(new runRow()).Where("id = ?", runID).Update("workspace_cleaned_at", now).Error;
    if (err != null) {
      throw err;
    }
  });
};

module.exports = { WorkspaceCheckpoint, ErrWorkspaceInUse, ErrWorkspaceCheckpointBackoff, workspaceBackgroundSavePrefix, workspaceUseTerm, holdsWorkspaceLease };
