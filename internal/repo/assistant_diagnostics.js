// assistant_diagnostics.js —— 对应 Go 文件：internal/repo/assistant_diagnostics.go
// 作用：一轮生成的诊断记录存取：检查点写入与中断判定。

"use strict";

const { Buffer } = require("node:buffer");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { AssistantDiagnostics, AssistantFailure, AssistantDiagnosticTermination, AssistantDiagnosticEvent } = require("../domain/assistant_diagnostics.js"); // 对应 Go 同包类型，assistant_diagnostics.js 已翻译
const { AnalyzeAssistantDiagnostics } = require("../domain/assistant_diagnostic_analysis.js"); // 对应 Go 同包函数，assistant_diagnostic_analysis.js 已翻译
const { mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// Separate from the current-generation slot: a retry must not replace the
// previous turn's evidence. Access always includes both owner and session.
class assistantDiagnosticsRow {
  constructor(init = {}) {
    this.GenerationID = init.GenerationID ?? "";
    this.SessionID = init.SessionID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Payload = init.Payload ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  TableName() {
    return "assistant_diagnostics";
  }
}

function initialAssistantDiagnostics(g) {
  return new AssistantDiagnostics({ Version: 2, GenerationID: g.ID, SessionID: g.SessionID, Status: g.Status, StartedAt: g.StartedAt, UpdatedAt: new Date(), Failure: g.Failure, Attempts: [] });
}

function checkpointAssistantDiagnostics(tx, g, reports) {
  const now = new Date();
  if (reports != null && reports.length > 0) {
    // The caller owns the full report, so nothing needs to be read back:
    // one upsert replaces the previous checkpoint.
    const report = reports[0];
    report.LastCheckpointAt = now;
    report.GenerationID = g.ID;
    report.SessionID = g.SessionID;
    report.Status = g.Status;
    report.Failure = g.Failure;
    report.UpdatedAt = now;
    AnalyzeAssistantDiagnostics(report);
    const row = new assistantDiagnosticsRow({ GenerationID: g.ID, SessionID: g.SessionID, UserID: g.UserID, Payload: mustJSON(report), UpdatedAt: now });
    return tx.Clauses(new clause.OnConflict({ Columns: [new clause.Column({ Name: "generation_id" })], DoUpdates: clause.AssignmentColumns(["payload", "updated_at"]) })).Create(row).Error;
  }
  const row = new assistantDiagnosticsRow();
  const err = tx.Where("generation_id = ? AND session_id = ? AND user_id = ?", g.ID, g.SessionID, g.UserID).Take(row).Error;
  if (err != null && err !== gorm.ErrRecordNotFound) {
    return err;
  }
  const report = initialAssistantDiagnostics(g);
  if (err == null) {
    try {
      Object.assign(report, JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
    } catch (e) {
      // Go 忽略解码错误。
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
    return tx.Create(new assistantDiagnosticsRow({ GenerationID: g.ID, SessionID: g.SessionID, UserID: g.UserID, Payload: mustJSON(report), UpdatedAt: now })).Error;
  }
  return tx.Model(row).Updates({ payload: mustJSON(report), updated_at: now }).Error;
}

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
