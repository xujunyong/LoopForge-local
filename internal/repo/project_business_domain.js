/**
 * @file internal/repo/project_business_domain.js
 * 对应 Go 源文件：internal/repo/project_business_domain.go
 *
 * 作用与职责边界：
 * 为 `ProjectsRepo` 提供项目业务域归属的原子 Compare-And-Swap 变更（含项目 Owner 首次归属权限校验、
 * 目标业务域启用状态校验与审计流水写入）以及项目业务域变更历史查询。
 * 不负责业务域自身的增删改（位于 `business_domains.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；
 *   `db.Transaction(tx => ...)` 回调同样失败抛错、成功正常返回。
 * - `ProjectsRepo` 定义于 `repo.js`，本文件通过 `ProjectsRepo.prototype` 挂载领域方法。
 */

"use strict";

const { BusinessDomainAssignment } = require("../domain/business_domain.js"); // 对应 Go 的 domain.BusinessDomainAssignment，business_domain.js 已翻译
const { ProjectsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { businessDomainRow, businessDomainAssignmentRow } = require("./business_domains.js"); // 对应 Go 同包类型，business_domains.js 已翻译
const { projectRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译

// 仅允许项目 Owner 执行首次归属但项目 Owner 或当前归属状态不满足条件时抛出的错误。
const ErrBusinessAssignmentForbidden = new Error("项目 Owner 或归属已变化，当前用户不能设置首次归属");

// 并发修改导致项目当前业务域与期望值不一致时抛出的冲突错误。
const ErrBusinessAssignmentConflict = new Error("项目归属已变化，请刷新后重试");

/**
 * 在行锁事务中以 Compare-And-Swap 方式更新项目的业务域归属并记录变更审计流水。
 * 当 `ownerOnly` 为 `true` 时，仅允许项目当前 Owner 在项目尚未归属任何业务域时执行首次绑定；
 * 当目标业务域非空时，会校验该目标业务域处于启用状态。
 *
 * @param {string} projectID - 待变更归属的项目主键 ID。
 * @param {string} expectedID - 调用方期望的项目当前业务域 ID（用于防并发覆盖）。
 * @param {string} targetID - 目标业务域 ID（空字符串表示解除归属）。
 * @param {number} actorID - 执行本次变更的操作用户 ID。
 * @param {string} reason - 变更原因说明（写入前会去除首尾空白）。
 * @param {boolean} ownerOnly - 是否限制为仅允许项目 Owner 进行首次归属。
 * @returns {void} 无返回值。
 * @throws {Error} 权限不满足（`ErrBusinessAssignmentForbidden`）、并发冲突（`ErrBusinessAssignmentConflict`）、目标业务域已停用或数据库读写失败时抛出错误。
 */
ProjectsRepo.prototype.SetProjectBusinessDomain = function (projectID, expectedID, targetID, actorID, reason, ownerOnly) {
  this.DB.Transaction((tx) => {
    const project = new projectRow();
    const err = this.locking(tx).Where("id = ?", projectID).Take(project).Error;
    if (err != null) {
      throw err;
    }
    if (ownerOnly && (actorID <= 0 || project.OwnerUserID == null || project.OwnerUserID !== actorID || project.BusinessDomainID !== "")) {
      throw ErrBusinessAssignmentForbidden;
    }
    if (project.BusinessDomainID !== expectedID) {
      throw ErrBusinessAssignmentConflict;
    }
    if (expectedID === targetID) {
      return;
    }
    if (targetID !== "") {
      const target = new businessDomainRow();
      const targetErr = this.locking(tx).Where("id = ?", targetID).Take(target).Error;
      if (targetErr != null) {
        throw targetErr;
      }
      if (!target.Active) {
        throw new Error("已停用的业务域不能接收项目");
      }
    }
    const now = new Date();
    const updateErr = tx.Model(new projectRow()).Where("id = ?", projectID).Updates({ business_domain_id: targetID, updated_at: now }).Error;
    if (updateErr != null) {
      throw updateErr;
    }
    const createErr = tx.Create(new businessDomainAssignmentRow({ ProjectID: projectID, FromDomainID: expectedID, ToDomainID: targetID, ActorID: actorID, Reason: reason.trim(), CreatedAt: now })).Error;
    if (createErr != null) {
      throw createErr;
    }
  });
};

/**
 * 按流水主键倒序查询指定项目最近最多 100 条业务域归属变更历史记录。
 * 供项目设置页与管理审计视图展示归属变更轨迹。
 *
 * @param {string} projectID - 项目主键 ID。
 * @returns {BusinessDomainAssignment[]} 业务域归属变更审计记录数组（按 `id DESC` 排列）。
 * @throws {Error} 数据库查询失败时抛出错误。
 */
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
