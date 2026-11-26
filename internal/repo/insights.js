// insights.js —— 对应 Go 文件：internal/repo/insights.go
// 作用：洞察来源凭证与执行记录的创建、查询、撤销与幂等摄入。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { InsightSource } = require("../domain/insights.js"); // 对应 Go 的 domain.InsightSource，domain 已翻译
const { hexSHA256 } = require("./hash.js"); // 对应 Go 同包函数，hash.js 本次一同翻译
const { jsonBytes } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译

const ErrInsightConflict = new Error("record ID or execution ID already exists with different content");

// InsightsRepo：洞察上报的来源与执行记录，对应 Go 的 insights.go 中的同名类型。
// Go 的 *deps 嵌入提供 DB 与 locking，JS 里随 repo.js 补齐。
class InsightsRepo {
  constructor(init = {}) {
    this.DB = init.DB ?? null;
  }

  CreateInsightSource(source, tokenHash) {
    return this.DB.Create(new insightSourceRow({ ID: source.ID, ProjectID: source.ProjectID, TokenHash: tokenHash, Payload: jsonBytes(source), ExpiresAt: source.ExpiresAt })).Error;
  }

  InsightSource(id) {
    const row = new insightSourceRow();
    const err = this.DB.First(row, "id = ?", id).Error;
    if (err != null) {
      return [new InsightSource(), err];
    }
    return decodeInsightSource(row);
  }

  InsightSources(projectID) {
    const rows = [];
    const err = this.DB.Where("project_id = ?", projectID).Order("id").Find(rows).Error;
    if (err != null) {
      return [null, err];
    }
    const out = [];
    for (const row of rows) {
      const [s, decodeErr] = decodeInsightSource(row);
      if (decodeErr != null) {
        return [null, decodeErr];
      }
      out.push(s);
    }
    return [out, null];
  }

  ActiveInsightSource(tokenHash, now) {
    const row = new insightSourceRow();
    const err = this.DB.Where("token_hash = ? AND revoked_at IS NULL AND expires_at > ?", tokenHash, now).First(row).Error;
    if (err != null) {
      return [new InsightSource(), err];
    }
    return decodeInsightSource(row);
  }

  RevokeInsightSource(id, now) {
    return this.DB.Model(new insightSourceRow()).Where("id = ? AND revoked_at IS NULL", id).Update("revoked_at", now).Error;
  }

  // IngestInsightExecution：原子提交一条不可变的已完成执行；记录与执行 ID 在来源内唯一，重试不重复计数。
  IngestInsightExecution(source, execution) {
    let payload;
    try {
      payload = JSON.stringify(execution);
    } catch (err) {
      return [false, err];
    }
    const row = new insightExecutionRow({ ID: hexSHA256(source.ID + "\x00" + execution.ID), ExecutionKey: hexSHA256(source.ID + "\x00" + execution.ExternalExecutionID), SourceID: source.ID, ProjectID: source.ProjectID, UserID: (source.UserMappings ?? {})[execution.ExternalUserID] ?? 0, Payload: payload, ContentHash: hexSHA256(payload), FinishedAt: execution.FinishedAt, ReceivedAt: new Date() });
    let duplicate = false;
    const err = this.DB.Transaction((tx) => {
      const credential = new insightSourceRow();
      const lockErr = this.locking(tx).First(credential, "id = ? AND revoked_at IS NULL AND expires_at > ?", source.ID, new Date()).Error;
      if (lockErr != null) {
        return lockErr;
      }
      const existing = new insightExecutionRow();
      const findErr = tx.Where("id = ? OR execution_key = ?", row.ID, row.ExecutionKey).First(existing).Error;
      if (findErr == null) {
        if (existing.ID === row.ID && existing.ContentHash === row.ContentHash) {
          duplicate = true;
          return null;
        }
        return ErrInsightConflict;
      }
      if (findErr !== gorm.ErrRecordNotFound) {
        return findErr;
      }
      return tx.Create(row).Error;
    });
    return [duplicate, err];
  }

  insightExecutions(filter) {
    const rows = [];
    let q = this.DB.Model(new insightExecutionRow());
    if (filter.ProjectID !== "") {
      q = q.Where("project_id = ?", filter.ProjectID);
    }
    if (filter.ProjectIDs != null) {
      if (filter.ProjectIDs.length === 0) {
        return [rows, null];
      }
      q = q.Where("project_id IN ?", filter.ProjectIDs);
    }
    if (filter.UserID !== "") {
      q = q.Where("user_id = ?", filter.UserID);
    }
    if (!isZeroTime(filter.From)) {
      q = q.Where("finished_at >= ?", filter.From);
    }
    if (!isZeroTime(filter.To)) {
      q = q.Where("finished_at <= ?", filter.To);
    }
    const err = q.Order("finished_at, id").Find(rows).Error;
    return [rows, err];
  }
}

// Go 的 time.Time 零值译为 null。
function isZeroTime(t) {
  return t == null;
}

function decodeInsightSource(row) {
  let source;
  let err = null;
  try {
    // Go 的 json.Unmarshal 出错时返回 error，JS 用 try/catch 接住。
    source = new InsightSource(JSON.parse(row.Payload.toString("utf8")));
  } catch (e) {
    source = new InsightSource();
    err = e;
  }
  source.RevokedAt = row.RevokedAt;
  return [source, err];
}

class insightSourceRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.TokenHash = init.TokenHash ?? "";
    this.Payload = init.Payload ?? null;
    this.ExpiresAt = init.ExpiresAt ?? null;
    this.RevokedAt = init.RevokedAt ?? null;
  }

  TableName() {
    return "insight_sources";
  }
}

class insightExecutionRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ExecutionKey = init.ExecutionKey ?? "";
    this.SourceID = init.SourceID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Payload = init.Payload ?? null;
    this.ContentHash = init.ContentHash ?? "";
    this.FinishedAt = init.FinishedAt ?? null;
    this.ReceivedAt = init.ReceivedAt ?? null;
  }

  TableName() {
    return "insight_executions";
  }
}

module.exports = { ErrInsightConflict, InsightsRepo, insightSourceRow, insightExecutionRow, decodeInsightSource };
