// knowledge.js —— 对应 Go 文件：internal/repo/knowledge.go
// 作用：知识库连接配置与投稿队列的读写：配置存取、投稿列表、单条存取与删除。

"use strict";

const { Buffer } = require("node:buffer");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { KnowledgeSettings, KnowledgeSubmission, KnowledgeSubmissionPending } = require("../domain/knowledge.js"); // 对应 Go 的 domain.KnowledgeSettings/KnowledgeSubmission/KnowledgeSubmissionPending，knowledge.js 已翻译
const { knowledgeSettingsRow, knowledgeSubmissionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译

const knowledgeSettingsID = "default";

class KnowledgeRepo {
  constructor(init = {}) {
    this.DB = init.DB ?? null;
  }

  KnowledgeSettings() {
    const row = new knowledgeSettingsRow();
    if (this.DB.Where("id = ?", knowledgeSettingsID).Take(row).Error != null) {
      return new KnowledgeSettings();
    }
    let out = new KnowledgeSettings();
    try {
      out = new KnowledgeSettings(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
    } catch {
      // Go 忽略解码错误。
    }
    out.Token = "";
    if (row.Token != null) {
      out.Token = row.Token;
    }
    out.TokenConfigured = out.Token.trim() !== "";
    if (row.Updated != null) {
      out.UpdatedAt = row.Updated;
    }
    return out;
  }

  PutKnowledgeSettings(settings) {
    const now = new Date();
    const token = settings.Token.trim();
    settings.Token = "";
    settings.TokenConfigured = false;
    settings.UpdatedAt = now;
    let payload;
    try {
      payload = JSON.stringify(settings);
    } catch (e) {
      return e;
    }
    const row = new knowledgeSettingsRow({ ID: knowledgeSettingsID, Payload: payload, Updated: now });
    if (token !== "") {
      row.Token = token;
    }
    return this.DB.Clauses(new clause.OnConflict({
      Columns: [new clause.Column({ Name: "id" })],
      DoUpdates: clause.AssignmentColumns(["payload", "token", "updated_at"]),
    })).Create(row).Error;
  }

  KnowledgeSubmissions(projectID, status, limit) {
    const out = [];
    if (limit <= 0 || limit > 500) {
      limit = 200;
    }
    let q = this.DB.Model(new knowledgeSubmissionRow());
    projectID = projectID.trim();
    if (projectID !== "") {
      q = q.Where("project_id = ?", projectID);
    }
    status = status.trim();
    if (status !== "") {
      q = q.Where("status = ?", status);
    }
    const rows = [];
    if (q.Order("updated_at DESC").Limit(limit).Find(rows).Error != null) {
      return out;
    }
    for (const row of rows) {
      const item = knowledgeSubmissionFromRow(row);
      item.Content = "";
      out.push(item);
    }
    return out;
  }

  KnowledgeSubmission(id) {
    const row = new knowledgeSubmissionRow();
    if (this.DB.Where("id = ?", id.trim()).Take(row).Error != null) {
      return [new KnowledgeSubmission(), false];
    }
    return [knowledgeSubmissionFromRow(row), true];
  }

  KnowledgeSubmissionIDsByArtifact(artifactIDs) {
    const out = {};
    if (artifactIDs.length === 0) {
      return out;
    }
    const rows = [];
    if (this.DB.Select("id", "artifact_id").Where("artifact_id IN ?", artifactIDs).Find(rows).Error != null) {
      return out;
    }
    for (const row of rows) {
      out[row.ArtifactID] = row.ID;
    }
    return out;
  }

  PutKnowledgeSubmission(item) {
    if (item.ID.trim() === "") {
      return new Error("knowledge submission id is required");
    }
    const now = new Date();
    if (isZeroTime(item.CreatedAt)) {
      item.CreatedAt = now;
    }
    item.UpdatedAt = now;
    if (item.Status === "") {
      item.Status = KnowledgeSubmissionPending;
    }
    let payload;
    try {
      payload = JSON.stringify(item);
    } catch (e) {
      return e;
    }
    const created = item.CreatedAt;
    const row = new knowledgeSubmissionRow({
      ID: item.ID, ProjectID: item.ProjectID, RunID: item.RunID, ArtifactID: item.ArtifactID,
      Status: item.Status, Payload: payload, Created: created, Updated: now,
    });
    return this.DB.Clauses(new clause.OnConflict({
      Columns: [new clause.Column({ Name: "id" })],
      DoUpdates: clause.AssignmentColumns(["project_id", "run_id", "artifact_id", "status", "payload", "updated_at"]),
    })).Create(row).Error;
  }

  DeleteKnowledgeSubmission(id) {
    const res = this.DB.Where("id = ?", id.trim()).Delete(new knowledgeSubmissionRow());
    if (res.Error != null) {
      return res.Error;
    }
    if (res.RowsAffected === 0) {
      return gorm.ErrRecordNotFound;
    }
    return null;
  }
}

// Go 的 time.Time 零值译为 null。
function isZeroTime(t) {
  return t == null;
}

function knowledgeSubmissionFromRow(row) {
  let out = new KnowledgeSubmission();
  try {
    out = new KnowledgeSubmission(JSON.parse(typeof row.Payload === "string" ? row.Payload : Buffer.from(row.Payload).toString("utf8")));
  } catch {
    // Go 忽略解码错误。
  }
  out.ID = row.ID;
  out.ProjectID = row.ProjectID;
  out.RunID = row.RunID;
  out.ArtifactID = row.ArtifactID;
  out.Status = row.Status;
  if (row.Created != null) {
    out.CreatedAt = row.Created;
  }
  if (row.Updated != null) {
    out.UpdatedAt = row.Updated;
  }
  return out;
}

module.exports = { KnowledgeRepo, knowledgeSettingsID, knowledgeSubmissionFromRow, isZeroTime };
