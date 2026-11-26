/**
 * @file internal/repo/assistant_diagnostics.js
 * 对应 Go 源文件：internal/repo/assistant_diagnostics.go
 *
 * 作用与职责边界：
 * 定义 `assistant_diagnostics` 表的行模型，负责单轮助手生成诊断证据的初始化、检查点写入（支持全量覆盖与增量更新）
 * 以及读取时的心跳超时中断判定与诊断分析汇总。
 * 与当前生成槽位表分离存储，确保重试新一轮时不会覆盖上一轮的排查证据。
 *
 * 语法差异说明：
 * - Go 仅返回 `error` 的函数统一按成功无返回值（`undefined`）、失败 `throw err` 处理；`(值, bool)` 译为 `[值, boolean]`。
 * - Go 的 `gorm` 结构体标签略去，链式调用与 `clause.OnConflict` 保持原样。
 * - Go 的 `45 * time.Second` 译为毫秒数 `45000`。
 */

"use strict";

const { Buffer } = require("node:buffer");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { AssistantDiagnostics, AssistantFailure, AssistantDiagnosticTermination, AssistantDiagnosticEvent } = require("../domain/assistant_diagnostics.js"); // 对应 Go 同包类型，assistant_diagnostics.js 已翻译
const { AnalyzeAssistantDiagnostics } = require("../domain/assistant_diagnostic_analysis.js"); // 对应 Go 同包函数，assistant_diagnostic_analysis.js 已翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

/**
 * 对应数据库表 `assistant_diagnostics` 的持久化行模型。
 * 按 `GenerationID` 主键独立保存每轮生成的诊断载荷，查询时始终校验所属用户与会话。
 */
class assistantDiagnosticsRow {
  /**
   * 构造诊断记录数据库行实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 可选初始字段映射。
   * @param {string} [init.GenerationID=""] - 生成轮次主键 ID。
   * @param {string} [init.SessionID=""] - 所属会话 ID。
   * @param {number} [init.UserID=0] - 所属用户 ID。
   * @param {Buffer|string|null} [init.Payload=null] - 序列化后的诊断报告 JSON 载荷。
   * @param {Date|null} [init.UpdatedAt=null] - 最近检查点更新时间。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.GenerationID = init.GenerationID ?? "";
    this.SessionID = init.SessionID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Payload = init.Payload ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  /**
   * 返回 GORM 对应的底层数据库表名。
   *
   * @returns {string} 固定表名 `"assistant_diagnostics"`。
   */
  TableName() {
    return "assistant_diagnostics";
  }
}

/**
 * 根据一轮生成的基本元信息构造版本 2 的初始诊断报告对象。
 * 用于诊断行尚未落库或读取旧载荷失败时作为基准报告。
 *
 * @param {object} g - 当前助手生成对象（`domain.AssistantGeneration` 实例）。
 * @returns {AssistantDiagnostics} 初始化后的诊断报告对象。
 */
function initialAssistantDiagnostics(g) {
  return new AssistantDiagnostics({ Version: 2, GenerationID: g.ID, SessionID: g.SessionID, Status: g.Status, StartedAt: g.StartedAt, UpdatedAt: new Date(), Failure: g.Failure, Attempts: [] });
}

/**
 * 在事务中写入或更新单轮生成的诊断检查点，并同步执行诊断规则分析。
 * 当调用方传入完整报告 `reports` 时直接执行单次 upsert 覆盖；未传入时则读取已有诊断记录，
 * 在状态变为 `"interrupted"` 且缺少终止记录时补写心跳丢失事件后再插入或更新。
 *
 * @param {object} tx - 当前事务的 `gorm.DB` 句柄。
 * @param {object} g - 当前助手生成快照（`domain.AssistantGeneration` 实例）。
 * @param {AssistantDiagnostics[]|null} reports - 可选的调用方自有完整诊断报告列表（有元素时取首项覆盖写入）。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库查询、插入或更新失败时抛出错误。
 */
function checkpointAssistantDiagnostics(tx, g, reports) {
  const now = new Date();
  if (reports != null && reports.length > 0) {
    // 调用方持有完整诊断报告，无需先读回旧记录：单次 upsert 直接覆盖上一检查点。
    const report = reports[0];
    report.LastCheckpointAt = now;
    report.GenerationID = g.ID;
    report.SessionID = g.SessionID;
    report.Status = g.Status;
    report.Failure = g.Failure;
    report.UpdatedAt = now;
    AnalyzeAssistantDiagnostics(report);
    const row = new assistantDiagnosticsRow({ GenerationID: g.ID, SessionID: g.SessionID, UserID: g.UserID, Payload: mustJSON(report), UpdatedAt: now });
    const upsertErr = tx.Clauses(new clause.OnConflict({ Columns: [new clause.Column({ Name: "generation_id" })], DoUpdates: clause.AssignmentColumns(["payload", "updated_at"]) })).Create(row).Error;
    if (upsertErr != null) {
      throw upsertErr;
    }
    return;
  }
  const row = new assistantDiagnosticsRow();
  const err = tx.Where("generation_id = ? AND session_id = ? AND user_id = ?", g.ID, g.SessionID, g.UserID).Take(row).Error;
  if (err != null && err !== gorm.ErrRecordNotFound) {
    throw err;
  }
  const report = initialAssistantDiagnostics(g);
  if (err == null) {
    try {
      Object.assign(report, JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
    } catch (e) {
      // Go 忽略解码错误，保留初始诊断对象。
    }
    if (report.LastCheckpointAt == null && row.UpdatedAt != null) {
      report.LastCheckpointAt = row.UpdatedAt;
    }
  }
  if (g.Status === "interrupted" && report.Termination == null) {
    report.Termination = new AssistantDiagnosticTermination({ At: now, Code: "CHECKPOINT_LOST", Source: "platform", Message: "超过 45 秒未收到运行实例心跳，生成已中断" });
    let seq = report.Timeline.length + 1;
    if (report.Timeline.length > 0 && report.Timeline[report.Timeline.length - 1].Sequence >= seq) {
      seq = report.Timeline[report.Timeline.length - 1].Sequence + 1;
    }
    report.Timeline.push(new AssistantDiagnosticEvent({ At: now, Sequence: seq, Source: "platform", Kind: "generation.termination", Code: "CHECKPOINT_LOST", Message: report.Termination.Message }));
  }
  report.GenerationID = g.ID;
  report.SessionID = g.SessionID;
  report.Status = g.Status;
  report.Failure = g.Failure;
  report.UpdatedAt = now;
  AnalyzeAssistantDiagnostics(report);
  if (err === gorm.ErrRecordNotFound) {
    const createErr = tx.Create(new assistantDiagnosticsRow({ GenerationID: g.ID, SessionID: g.SessionID, UserID: g.UserID, Payload: mustJSON(report), UpdatedAt: now })).Error;
    if (createErr != null) {
      throw createErr;
    }
    return;
  }
  const updateErr = tx.Model(row).Updates({ payload: mustJSON(report), updated_at: now }).Error;
  if (updateErr != null) {
    throw updateErr;
  }
}

/**
 * 按所属用户、会话 ID 与生成 ID 读取该轮生成的诊断报告并运行诊断分析。
 * 若记录状态仍为 `"running"` 且距离最后更新时间已超过 45 秒，会在返回副本上补全中断状态、终止原因与失败建议。
 *
 * @param {number} userID - 会话所属用户 ID。
 * @param {string} sessionID - 会话 ID。
 * @param {string} generationID - 生成轮次 ID。
 * @returns {[AssistantDiagnostics, boolean]} 返回 `[诊断报告实例, 是否找到且解码成功]`；未找到或解析失败时返回 `[空报告实例, false]`。
 */
AssistantRepo.prototype.AssistantDiagnostics = function (userID, sessionID, generationID) {
  const row = new assistantDiagnosticsRow();
  const err = this.DB.Where("user_id = ? AND session_id = ? AND generation_id = ?", userID, sessionID, generationID).Take(row).Error;
  if (err != null) {
    return [new AssistantDiagnostics(), false];
  }
  let report = null;
  try {
    report = new AssistantDiagnostics(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
  } catch (e) {
    report = null;
  }
  if (report == null) {
    return [new AssistantDiagnostics(), false];
  }
  if (report.Status === "running" && row.UpdatedAt != null && Date.now() - row.UpdatedAt.getTime() > 45000) {
    const now = new Date();
    report.Status = "interrupted";
    if (report.LastCheckpointAt == null) {
      report.LastCheckpointAt = row.UpdatedAt;
    }
    if (report.Termination == null) {
      report.Termination = new AssistantDiagnosticTermination({ At: now, Code: "CHECKPOINT_LOST", Source: "platform", Message: "超过 45 秒未收到运行实例心跳，生成已中断" });
    }
    if (report.Failure == null) {
      report.Failure = new AssistantFailure({ Code: "EXECUTION_INTERRUPTED", Phase: "server", Message: "服务端生成已中断，请检查已执行操作后重试", Suggestion: "检查已执行操作后再重试；可下载诊断信息交给管理员排查。" });
    }
  }
  AnalyzeAssistantDiagnostics(report);
  return [report, true];
};

module.exports = { assistantDiagnosticsRow, initialAssistantDiagnostics, checkpointAssistantDiagnostics };
