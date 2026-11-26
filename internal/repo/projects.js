// projects.js —— 对应 Go 文件：internal/repo/projects.go
// 作用：项目及其成员的列表、读取、归档与写入。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { Project, ProjectMember } = require("../domain/project.js"); // 对应 Go 的 domain.Project/ProjectMember，project.js 已翻译
const { Issue } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue，issue.js 已翻译
const { ProjectsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { projectRow, projectMemberRow, issueRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { jsonUnmarshal, mustJSON, timePtr, upsert } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译

// ---------- Projects ----------

ProjectsRepo.prototype.lockProjectInTx = function (tx, id) {
  const row = new projectRow();
  return this.locking(tx).Select("id").Where("id = ?", id).First(row).Error;
};

// Projects lists live projects; deleted (archived) ones are left out. Project
// still returns an archived project so its history and restore keep working.
ProjectsRepo.prototype.Projects = function () {
  const rows = [];
  const err = this.DB.Find(rows).Error;
  if (err != null) {
    return [];
  }
  const memberRows = [];
  const members = {};
  if (rows.length > 0) {
    this.DB.Order("user_id").Find(memberRows).Error;
    for (const member of memberRows) {
      members[member.ProjectID] = [...(members[member.ProjectID] ?? []), new ProjectMember({ UserID: member.UserID, Role: member.Role })];
    }
  }
  const out = [];
  for (const row of rows) {
    const project = new Project();
    if (jsonUnmarshal(row.Payload, project) != null || project.ArchivedAt != null) {
      continue;
    }
    if (row.OwnerUserID != null) {
      project.OwnerID = row.OwnerUserID;
    } else {
      project.OwnerID = 0;
    }
    project.BusinessDomainID = row.BusinessDomainID;
    if (row.Updated != null) {
      project.UpdatedAt = row.Updated;
    }
    project.Members = members[project.ID];
    if (project.Members == null) {
      project.Members = [];
    }
    out.push(project);
  }
  out.sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0));
  return out;
};

ProjectsRepo.prototype.Project = function (id) {
  const row = new projectRow();
  const err = this.DB.Where("id = ?", id).Take(row).Error;
  if (err != null) {
    return [new Project(), false];
  }
  const project = new Project();
  if (jsonUnmarshal(row.Payload, project) != null) {
    return [new Project(), false];
  }
  if (row.OwnerUserID != null) {
    project.OwnerID = row.OwnerUserID;
  } else {
    project.OwnerID = 0;
  }
  project.BusinessDomainID = row.BusinessDomainID;
  if (row.Updated != null) {
    project.UpdatedAt = row.Updated;
  }
  project.Members = this.projectMembers(project.ID);
  return [project, true];
};

// ProjectMemberships returns only project identity, ownership and membership
// for batched authorization. Missing projects are absent from the map.
ProjectsRepo.prototype.ProjectMemberships = function (ids) {
  const out = {};
  for (let start = 0; start < ids.length; start += 500) {
    const batch = ids.slice(start, Math.min(start + 500, ids.length));
    const rows = [];
    const err = this.DB.Select("id", "owner_user_id").Where("id IN ?", batch).Find(rows).Error;
    if (err != null) {
      throw err;
    }
    for (const row of rows) {
      const project = new Project({ ID: row.ID });
      if (row.OwnerUserID != null) {
        project.OwnerID = row.OwnerUserID;
      }
      out[row.ID] = project;
    }
    const members = [];
    const membersErr = this.DB.Select("project_id", "user_id").Where("project_id IN ?", batch).Find(members).Error;
    if (membersErr != null) {
      throw membersErr;
    }
    for (const member of members) {
      if (out[member.ProjectID] != null) {
        const project = out[member.ProjectID];
        project.Members = [...(project.Members ?? []), new ProjectMember({ UserID: member.UserID })];
        out[member.ProjectID] = project;
      }
    }
  }
  return out;
};

ProjectsRepo.prototype.projectMembers = function (projectID) {
  const rows = [];
  const err = this.DB.Where("project_id = ?", projectID).Order("user_id").Find(rows).Error;
  if (err != null) {
    return null;
  }
  const members = [];
  for (const row of rows) {
    members.push(new ProjectMember({ UserID: row.UserID, Role: row.Role }));
  }
  return members;
};

// SetProjectArchived deletes (at != nil) or restores (at == nil) a project
// without touching its settings, members or requirements.
ProjectsRepo.prototype.SetProjectArchived = function (id, at, by) {
  return this.DB.Transaction((tx) => {
    const row = new projectRow();
    const err = this.locking(tx).Where("id = ?", id).Take(row).Error;
    if (err != null) {
      return err;
    }
    const payload = {};
    const unmarshalErr = jsonUnmarshal(row.Payload, payload);
    if (unmarshalErr != null) {
      return unmarshalErr;
    }
    if (at != null) {
      payload.archivedAt = at;
      payload.archivedBy = by;
    } else {
      delete payload.archivedAt;
      delete payload.archivedBy;
    }
    return tx.Model(new projectRow()).Where("id = ?", id).Updates({
      payload: mustJSON(payload), updated_at: timePtr(new Date()),
    }).Error;
  });
};

ProjectsRepo.prototype.PutProject = function (v) {
  const now = new Date();
  const [old, ok] = this.Project(v.ID);
  if (ok) {
    if (v.OwnerID === 0) {
      v.OwnerID = old.OwnerID;
    }
    if (v.Members == null) {
      v.Members = old.Members;
    }
    v.CreatedAt = old.CreatedAt;
  } else {
    v.CreatedAt = now;
  }
  v.UpdatedAt = now;
  return this.writeProject(v);
};

ProjectsRepo.prototype.writeProject = function (v) {
  const payload = { ...v };
  payload.Members = null;
  payload.GitToken = "";
  payload.CodeBuddyAPIKey = "";
  let owner = null;
  if (v.OwnerID > 0) {
    owner = v.OwnerID;
  }
  return this.DB.Transaction((tx) => {
    const current = new projectRow();
    const err = this.locking(tx).Where("id = ?", v.ID).Take(current).Error;
    if (err != null && err !== gorm.ErrRecordNotFound) {
      return err;
    }
    // Only SetProjectBusinessDomain owns the assignment, even for stale project payloads.
    v.BusinessDomainID = current.BusinessDomainID;
    payload.BusinessDomainID = current.BusinessDomainID;
    const upsertErr = upsert(tx, "projects", {
      id: v.ID, business_domain_id: v.BusinessDomainID, project_key: v.Key, name: v.Name, owner_user_id: owner,
      payload: mustJSON(payload), created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
    });
    if (upsertErr != null) {
      return upsertErr;
    }
    const deleteErr = tx.Where("project_id = ?", v.ID).Delete(new projectMemberRow()).Error;
    if (deleteErr != null) {
      return deleteErr;
    }
    for (const member of v.Members) {
      if (member.UserID <= 0) {
        continue;
      }
      let role = member.Role.trim();
      if (role === "") {
        role = "member";
      }
      const createErr = tx.Clauses(new clause.OnConflict({ UpdateAll: true })).Create(new projectMemberRow({
        ProjectID: v.ID, UserID: member.UserID, Role: role, Created: timePtr(new Date()),
      })).Error;
      if (createErr != null) {
        return createErr;
      }
    }
    if (v.OwnerID > 0) {
      // Backfill issue responsibility for issues that have no assignee.
      const issueRows = [];
      const issueErr = tx.Where("project_id = ? AND assignee_user_id IS NULL", v.ID).Find(issueRows).Error;
      if (issueErr != null) {
        return issueErr;
      }
      for (const row of issueRows) {
        const issue = new Issue();
        if (jsonUnmarshal(row.Payload, issue) != null) {
          continue;
        }
        issue.AssigneeUserID = v.OwnerID;
        const updateErr = tx.Model(new issueRow()).Where("id = ?", row.ID).Updates({
          assignee_user_id: v.OwnerID, payload: mustJSON(issue),
        }).Error;
        if (updateErr != null) {
          return updateErr;
        }
      }
    }
    return null;
  });
};
