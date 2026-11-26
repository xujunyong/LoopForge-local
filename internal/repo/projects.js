/**
 * @file internal/repo/projects.js
 * 对应 Go 源文件：internal/repo/projects.go
 *
 * 作用与职责边界：
 * 实现 `ProjectsRepo` 领域的项目列表查询、单项目读取、批量成员权限投影、归档/恢复软删除、
 * 以及带事务锁的项目与成员写入（同时保护业务域归属列并回填无负责人 Issue 的默认负责人）；
 * 不负责项目业务域归属变更（位于 `project_business_domain.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；
 *   `db.Transaction(tx => ...)` 回调同样失败抛错、成功正常返回。
 * - Go 的 `(值, bool)` 译为二元组 `[值, boolean]`；`map[string]V` 统一使用普通对象 `{}`。
 * - `jsonUnmarshal` 在反序列化失败时抛出异常，Go 中忽略单行解码失败的分支在 JS 中用 `try ... catch` 对应处理。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { Project, ProjectMember } = require("../domain/project.js"); // 对应 Go 的 domain.Project/ProjectMember，project.js 已翻译
const { Issue } = require("../domain/issue.js"); // 对应 Go 的 domain.Issue，issue.js 已翻译
const { ProjectsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { projectRow, projectMemberRow, issueRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { jsonUnmarshal, mustJSON, timePtr, upsert } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译

// ---------- Projects ----------

/**
 * 在已有事务中对指定项目行加排他锁（MySQL 下为 `FOR UPDATE`），仅查询主键列。
 * 供需要串行化同项目并发修改的事务流程调用。
 *
 * @param {object} tx - 当前活跃的 `gorm.DB` 事务句柄。
 * @param {string} id - 待锁定的项目主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 项目不存在或加锁查询失败时抛出错误。
 */
ProjectsRepo.prototype.lockProjectInTx = function (tx, id) {
  const row = new projectRow();
  const err = this.locking(tx).Select("id").Where("id = ?", id).First(row).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 查询全部未归档的活跃项目及其成员列表，并按项目名称升序排列。
 * 已归档（软删除）的项目会被过滤；若需读取已归档项目以支持历史查看或恢复，请调用 `Project(id)`。
 *
 * @returns {Project[]} 按 `Name` 升序排列的活跃项目领域对象数组；数据库查询失败时返回空数组。
 */
ProjectsRepo.prototype.Projects = function () {
  const rows = [];
  const err = this.DB.Find(rows).Error;
  if (err != null) {
    return [];
  }
  const memberRows = [];
  const members = {};
  if (rows.length > 0) {
    this.DB.Order("user_id").Find(memberRows);
    for (const member of memberRows) {
      members[member.ProjectID] = [...(members[member.ProjectID] ?? []), new ProjectMember({ UserID: member.UserID, Role: member.Role })];
    }
  }
  const out = [];
  for (const row of rows) {
    const project = new Project();
    try {
      jsonUnmarshal(row.Payload, project);
    } catch {
      continue;
    }
    if (project.ArchivedAt != null) {
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

/**
 * 按主键 ID 读取单个项目（包含已归档项目）及其成员列表。
 * 会用表中的 `owner_user_id`、`business_domain_id` 与 `updated_at` 覆盖载荷中的同名字段。
 *
 * @param {string} id - 项目主键 ID。
 * @returns {[Project, boolean]} 找到且载荷解码成功时返回 `[project, true]`，否则返回 `[空 Project, false]`。
 */
ProjectsRepo.prototype.Project = function (id) {
  const row = new projectRow();
  const err = this.DB.Where("id = ?", id).Take(row).Error;
  if (err != null) {
    return [new Project(), false];
  }
  const project = new Project();
  try {
    jsonUnmarshal(row.Payload, project);
  } catch {
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

/**
 * 按批次（每批最多 500 个）加载多个项目的标识、负责人与成员用户 ID 投影。
 * 专用于批量权限校验场景；不存在的项目不会出现在返回映射中。
 *
 * @param {string[]} ids - 待查询的项目 ID 数组。
 * @returns {Object<string, Project>} 以项目 ID 为键、仅填充 `ID`/`OwnerID`/`Members` 的映射对象。
 * @throws {Error} 任意批次的数据库查询失败时抛出错误。
 */
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

/**
 * 按用户 ID 升序查询单个项目的成员列表。
 * 供 `Project(id)` 填充成员字段使用。
 *
 * @param {string} projectID - 项目主键 ID。
 * @returns {ProjectMember[] | null} 项目成员数组；查询失败时返回 `null`。
 */
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

/**
 * 归档软删除（`at != null`）或恢复（`at == null`）指定项目，仅更新载荷里的归档元数据与更新时间。
 * 不会改动项目的其他配置、成员或需求数据。
 *
 * @param {string} id - 项目主键 ID。
 * @param {Date | null} at - 归档时间；传入 `null` 表示恢复项目。
 * @param {number} by - 执行归档操作的用户 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 项目不存在、载荷 JSON 解码失败或数据库更新失败时抛出错误。
 */
ProjectsRepo.prototype.SetProjectArchived = function (id, at, by) {
  this.DB.Transaction((tx) => {
    const row = new projectRow();
    const err = this.locking(tx).Where("id = ?", id).Take(row).Error;
    if (err != null) {
      throw err;
    }
    const payload = {};
    jsonUnmarshal(row.Payload, payload);
    if (at != null) {
      payload.archivedAt = new Date(at.getTime());
      payload.archivedBy = by;
    } else {
      delete payload.archivedAt;
      delete payload.archivedBy;
    }
    const updateErr = tx.Model(new projectRow()).Where("id = ?", id).Updates({
      payload: mustJSON(payload), updated_at: timePtr(new Date()),
    }).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
};

/**
 * 创建或更新项目记录。
 * 更新已有项目时会自动保留原有的 `CreatedAt`，并在新值未指定 `OwnerID` 或 `Members` 时继承旧值，然后委托 `writeProject` 落库。
 *
 * @param {Project} v - 待保存的项目领域对象。
 * @returns {void} 无返回值。
 * @throws {Error} 事务写入项目、成员或回填 Issue 负责人失败时抛出错误。
 */
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
  this.writeProject(v);
};

/**
 * 在行锁事务中持久化项目主行、重建项目成员表，并为无负责人的项目 Issue 回填项目 Owner。
 * 写入 JSON 载荷前会清空敏感令牌（`GitToken`、`CodeBuddyAPIKey`）与 `Members` 字段，并强制保留当前数据库中的 `BusinessDomainID`。
 *
 * @param {Project} v - 已补全时间戳与默认值的项目领域对象。
 * @returns {void} 无返回值。
 * @throws {Error} 事务内任一查询、写入、删除或更新步骤失败时抛出错误。
 */
ProjectsRepo.prototype.writeProject = function (v) {
  const payload = { ...v };
  payload.Members = null;
  payload.GitToken = "";
  payload.CodeBuddyAPIKey = "";
  let owner = null;
  if (v.OwnerID > 0) {
    owner = v.OwnerID;
  }
  this.DB.Transaction((tx) => {
    const current = new projectRow();
    const err = this.locking(tx).Where("id = ?", v.ID).Take(current).Error;
    if (err != null && err !== gorm.ErrRecordNotFound) {
      throw err;
    }
    // 只有 SetProjectBusinessDomain 负责维护业务域归属，避免旧项目载荷覆盖已变更的归属。
    v.BusinessDomainID = current.BusinessDomainID;
    payload.BusinessDomainID = current.BusinessDomainID;
    upsert(tx, "projects", {
      id: v.ID, business_domain_id: v.BusinessDomainID, project_key: v.Key, name: v.Name, owner_user_id: owner,
      payload: mustJSON(payload), created_at: timePtr(v.CreatedAt), updated_at: timePtr(v.UpdatedAt),
    });
    const deleteErr = tx.Where("project_id = ?", v.ID).Delete(new projectMemberRow()).Error;
    if (deleteErr != null) {
      throw deleteErr;
    }
    for (const member of v.Members ?? []) {
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
        throw createErr;
      }
    }
    if (v.OwnerID > 0) {
      // 为当前项目下尚未分配负责人的 Issue 回填默认负责人为项目 Owner。
      const issueRows = [];
      const issueErr = tx.Where("project_id = ? AND assignee_user_id IS NULL", v.ID).Find(issueRows).Error;
      if (issueErr != null) {
        throw issueErr;
      }
      for (const row of issueRows) {
        const issue = new Issue();
        try {
          jsonUnmarshal(row.Payload, issue);
        } catch {
          continue;
        }
        issue.AssigneeUserID = v.OwnerID;
        const updateErr = tx.Model(new issueRow()).Where("id = ?", row.ID).Updates({
          assignee_user_id: v.OwnerID, payload: mustJSON(issue),
        }).Error;
        if (updateErr != null) {
          throw updateErr;
        }
      }
    }
  });
};
