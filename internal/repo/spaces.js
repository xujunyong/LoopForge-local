// spaces.js —— 对应 Go 文件：internal/repo/spaces.go
// 作用：需求空间：空间、成员、版本化产物与会话线程的存取。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { RequirementSpace, SpaceMember, SpaceArtifact, SpaceThread } = require("../domain/space.js"); // 对应 Go 的 domain.*，space.js 已翻译
const { payloadOne, upsert, mustJSON, timePtr, jsonUnmarshal } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { requirementSpaceRow, spaceMemberRow, spaceArtifactRow, spaceArtifactRevisionRow, spaceThreadRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { isZeroTime } = require("./analytics.js"); // 对应 Go 同包函数，analytics.js 已翻译

const ErrArtifactConflict = new Error("产物已被其他人更新，请刷新后再保存");

SpacesRepo.prototype.Space = function (id) {
  return payloadOne(RequirementSpace, this.DB, "requirement_spaces", id.trim());
};

SpacesRepo.prototype.PutSpace = function (v) {
  const now = new Date();
  const [old, ok] = this.Space(v.ID);
  if (ok) {
    v.CreatedAt = old.CreatedAt;
  } else if (isZeroTime(v.CreatedAt)) {
    v.CreatedAt = now;
  }
  v.UpdatedAt = now;
  return upsert(this.DB, "requirement_spaces", {
    id: v.ID, project_id: v.ProjectID, issue_id: v.IssueID,
    payload: mustJSON(v), created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
  });
};

SpacesRepo.prototype.SpaceByIssue = function (issueID) {
  const row = new requirementSpaceRow();
  issueID = issueID.trim();
  if (issueID === "") {
    return [new RequirementSpace(), false];
  }
  if (this.DB.Table("requirement_spaces").Where("issue_id = ?", issueID).Order("created_at").Take(row).Error != null) {
    return [new RequirementSpace(), false];
  }
  const item = new RequirementSpace();
  if (jsonUnmarshal(row.Payload, item) != null) {
    return [new RequirementSpace(), false];
  }
  return [item, true];
};

SpacesRepo.prototype.SpaceMembers = function (spaceID) {
  const rows = [];
  if (this.DB.Table("space_members").Where("space_id = ?", spaceID.trim()).Order("created_at").Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const item = new SpaceMember();
    if (jsonUnmarshal(row.Payload, item) == null) {
      out.push(item);
    }
  }
  return out;
};

SpacesRepo.prototype.PutSpaceMember = function (v) {
  if (isZeroTime(v.AddedAt)) {
    v.AddedAt = new Date();
  }
  return upsert(this.DB, "space_members", {
    space_id: v.SpaceID, user_id: v.UserID, payload: mustJSON(v), created_at: timePtr(v.AddedAt),
  });
};

SpacesRepo.prototype.DeleteSpaceMember = function (spaceID, userID) {
  return this.DB.Exec("DELETE FROM space_members WHERE space_id = ? AND user_id = ?", spaceID, userID).Error;
};

SpacesRepo.prototype.SpaceArtifacts = function (spaceID) {
  const rows = [];
  if (this.DB.Table("space_artifacts").Where("space_id = ?", spaceID.trim()).Order("created_at").Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const item = new SpaceArtifact();
    if (jsonUnmarshal(row.Payload, item) == null) {
      out.push(item);
    }
  }
  return out;
};

SpacesRepo.prototype.SpaceArtifact = function (spaceID, id) {
  const [item, ok] = payloadOne(SpaceArtifact, this.DB, "space_artifacts", id.trim());
  if (!ok || item.SpaceID !== spaceID.trim()) {
    return [new SpaceArtifact(), false];
  }
  return [item, true];
};

SpacesRepo.prototype.PutSpaceArtifact = function (v, baseVersion) {
  const err = this.DB.Transaction((tx) => {
    const now = new Date();
    const row = new spaceArtifactRow();
    const takeErr = tx.Table("space_artifacts").Clauses(new clause.Locking({ Strength: "UPDATE" })).Where("id = ?", v.ID).Take(row).Error;
    if (takeErr === gorm.ErrRecordNotFound) {
      if (baseVersion !== 0) {
        return ErrArtifactConflict;
      }
      v.Version = 1;
      v.CreatedAt = now;
    } else if (takeErr != null) {
      return takeErr;
    } else {
      const old = new SpaceArtifact();
      if (jsonUnmarshal(row.Payload, old) != null || old.SpaceID !== v.SpaceID) {
        return new Error(`artifact ${v.ID} belongs to another space`);
      }
      if (baseVersion !== old.Version) {
        return ErrArtifactConflict;
      }
      v.Version = old.Version + 1;
      v.CreatedAt = old.CreatedAt;
    }
    v.UpdatedAt = now;
    const upsertErr = upsert(tx, "space_artifacts", {
      id: v.ID, space_id: v.SpaceID, kind: v.Kind, version: v.Version,
      payload: mustJSON(v), created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
    });
    if (upsertErr != null) {
      return upsertErr;
    }
    return upsert(tx, "space_artifact_revisions", {
      artifact_id: v.ID, version: v.Version, space_id: v.SpaceID, payload: mustJSON(v), created_at: timePtr(now),
    });
  });
  return [v, err];
};

SpacesRepo.prototype.SpaceArtifactRevisions = function (spaceID, id) {
  const rows = [];
  if (this.DB.Table("space_artifact_revisions").Where("artifact_id = ? AND space_id = ?", id, spaceID).Order("version desc").Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const item = new SpaceArtifact();
    if (jsonUnmarshal(row.Payload, item) == null) {
      item.Body = "";
      out.push(item);
    }
  }
  return out;
};

SpacesRepo.prototype.SpaceArtifactRevision = function (spaceID, id, version) {
  const row = new spaceArtifactRevisionRow();
  if (this.DB.Table("space_artifact_revisions").Where("artifact_id = ? AND space_id = ? AND version = ?", id, spaceID, version).Take(row).Error != null) {
    return [new SpaceArtifact(), false];
  }
  const item = new SpaceArtifact();
  if (jsonUnmarshal(row.Payload, item) != null) {
    return [new SpaceArtifact(), false];
  }
  return [item, true];
};

SpacesRepo.prototype.DeleteSpaceArtifact = function (spaceID, id) {
  return this.DB.Transaction((tx) => {
    const err = tx.Exec("DELETE FROM space_artifact_revisions WHERE artifact_id = ? AND space_id = ?", id, spaceID).Error;
    if (err != null) {
      return err;
    }
    return tx.Exec("DELETE FROM space_artifacts WHERE id = ? AND space_id = ?", id, spaceID).Error;
  });
};

SpacesRepo.prototype.SpaceThreads = function (spaceID) {
  const rows = [];
  if (this.DB.Table("space_threads").Where("space_id = ?", spaceID.trim()).Order("created_at").Find(rows).Error != null) {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const item = new SpaceThread();
    if (jsonUnmarshal(row.Payload, item) == null) {
      out.push(item);
    }
  }
  return out;
};

SpacesRepo.prototype.SpaceThread = function (spaceID, id) {
  const [item, ok] = payloadOne(SpaceThread, this.DB, "space_threads", id.trim());
  if (!ok || item.SpaceID !== spaceID.trim()) {
    return [new SpaceThread(), false];
  }
  return [item, true];
};

SpacesRepo.prototype.SpaceRunThread = function (spaceID, runID) {
  const row = new spaceThreadRow();
  if (this.DB.Table("space_threads").Where("space_id = ? AND run_id = ?", spaceID, runID).Take(row).Error != null) {
    return [new SpaceThread(), false];
  }
  const item = new SpaceThread();
  if (jsonUnmarshal(row.Payload, item) != null) {
    return [new SpaceThread(), false];
  }
  return [item, true];
};

SpacesRepo.prototype.PutSpaceThread = function (v) {
  if (isZeroTime(v.CreatedAt)) {
    v.CreatedAt = new Date();
  }
  return upsert(this.DB, "space_threads", {
    id: v.ID, space_id: v.SpaceID, run_id: v.RunID, payload: mustJSON(v), created_at: timePtr(v.CreatedAt),
  });
};

module.exports = { ErrArtifactConflict };
