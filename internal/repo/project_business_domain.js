// project_business_domain.js —— 对应 Go 文件：internal/repo/project_business_domain.go
// 作用：项目首次业务域归属的原子校验与归属变更历史。

"use strict";

const { BusinessDomainAssignment } = require("../domain/business_domain.js"); // 对应 Go 的 domain.BusinessDomainAssignment，business_domain.js 已翻译
const { ProjectsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { businessDomainRow, businessDomainAssignmentRow } = require("./business_domains.js"); // 对应 Go 同包类型，business_domains.js 已翻译
const { projectRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译

const ErrBusinessAssignmentForbidden = new Error("项目 Owner 或归属已变化，当前用户不能设置首次归属");
const ErrBusinessAssignmentConflict = new Error("项目归属已变化，请刷新后重试");

// SetProjectBusinessDomain atomically validates the active target and records a compare-and-swap assignment.
ProjectsRepo.prototype.SetProjectBusinessDomain = function (projectID, expectedID, targetID, actorID, reason, ownerOnly) {
  return this.DB.Transaction((tx) => {
    const project = new projectRow();
    const err = this.locking(tx).Where("id = ?", projectID).Take(project).Error;
    if (err != null) {
      return err;
    }
    if (ownerOnly && (actorID <= 0 || project.OwnerUserID == null || project.OwnerUserID !== actorID || project.BusinessDomainID !== "")) {
      return ErrBusinessAssignmentForbidden;
    }
    if (project.BusinessDomainID !== expectedID) {
      return ErrBusinessAssignmentConflict;
    }
    if (expectedID === targetID) {
      return null;
    }
    if (targetID !== "") {
      const target = new businessDomainRow();
      const targetErr = this.locking(tx).Where("id = ?", targetID).Take(target).Error;
      if (targetErr != null) {
        return targetErr;
      }
      if (!target.Active) {
        return new Error("已停用的业务域不能接收项目");
      }
    }
    const now = new Date();
    const updateErr = tx.Model(new projectRow()).Where("id = ?", projectID).Updates({ business_domain_id: targetID, updated_at: now }).Error;
    if (updateErr != null) {
      return updateErr;
    }
    return tx.Create(new businessDomainAssignmentRow({ ProjectID: projectID, FromDomainID: expectedID, ToDomainID: targetID, ActorID: actorID, Reason: reason.trim(), CreatedAt: now })).Error;
  });
};

ProjectsRepo.prototype.ProjectBusinessDomainHistory = function (projectID) {
  const rows = [];
  const err = this.DB.Where("project_id = ?", projectID).Order("id DESC").Limit(100).Find(rows).Error;
  if (err != null) {
    throw err;
  }
  const out = [];
  for (const v of rows) {
    out.push(new BusinessDomainAssignment({ ID: v.ID, ProjectID: v.ProjectID, FromDomainID: v.FromDomainID, ToDomainID: v.ToDomainID, ActorID: v.ActorID, Reason: v.Reason, CreatedAt: v.CreatedAt }));
  }
  return out;
};

module.exports = { ErrBusinessAssignmentForbidden, ErrBusinessAssignmentConflict };
