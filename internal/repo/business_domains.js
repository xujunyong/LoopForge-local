// business_domains.js —— 对应 Go 文件：internal/repo/business_domains.go
// 作用：业务域配置及其项目归属记录的读写，带乐观并发冲突检测。
// gorm 链式调用按原样保留；errors.Is 译为 ===。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { BusinessDomain } = require("../domain/business_domain.js"); // 对应 Go 的 domain.BusinessDomain，business_domain.js 已翻译
const { jsonUnmarshal, mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { BusinessDomainsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译
const { timeEqual } = require("./analytics.js"); // 对应 Go 的时间比较，analytics.js 已翻译

class businessDomainRow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Active = init.Active ?? false;
    this.Payload = init.Payload ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  TableName() {
    return "business_domains";
  }
}

class businessDomainAssignmentRow {
  constructor(init = {}) {
    this.ID = init.ID ?? 0;
    this.ProjectID = init.ProjectID ?? "";
    this.FromDomainID = init.FromDomainID ?? "";
    this.ToDomainID = init.ToDomainID ?? "";
    this.ActorID = init.ActorID ?? 0;
    this.Reason = init.Reason ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
  }

  TableName() {
    return "business_domain_assignments";
  }
}

BusinessDomainsRepo.prototype.BusinessDomains = function () {
  const rows = [];
  const err = this.DB.Order("name, id").Find(rows).Error;
  if (err != null) {
    return [null, err];
  }
  const out = [];
  for (const row of rows) {
    const v = new BusinessDomain();
    const unmarshalErr = jsonUnmarshal(row.Payload, v);
    if (unmarshalErr != null) {
      return [null, unmarshalErr];
    }
    out.push(v);
  }
  return [out, null];
};

BusinessDomainsRepo.prototype.BusinessDomain = function (id) {
  const row = new businessDomainRow();
  const err = this.DB.Where("id = ?", id).Take(row).Error;
  if (err != null) {
    return [new BusinessDomain(), err];
  }
  const v = new BusinessDomain();
  const unmarshalErr = jsonUnmarshal(row.Payload, v);
  return [v, unmarshalErr];
};

const ErrBusinessDomainConflict = new Error("业务域配置已变化，请刷新后重试");

BusinessDomainsRepo.prototype.PutBusinessDomain = function (v, expectedUpdatedAt) {
  v.ID = v.ID.trim();
  v.Name = v.Name.trim();
  if (v.ID === "" || v.Name === "") {
    return new Error("业务域标识和名称不能为空");
  }
  return this.DB.Transaction((tx) => {
    const row = new businessDomainRow();
    const err = this.locking(tx).Where("id = ?", v.ID).Take(row).Error;
    if (err != null && err !== gorm.ErrRecordNotFound) {
      return err;
    }
    let previous = new BusinessDomain();
    if (err == null) {
      const decodeErr = jsonUnmarshal(row.Payload, previous);
      if (decodeErr != null) {
        return decodeErr;
      }
    }
    // MySQL DATETIME truncates precision; compare the exact payload version.
    if ((expectedUpdatedAt == null && err == null) || (expectedUpdatedAt != null && (err != null || !timeEqual(previous.UpdatedAt, expectedUpdatedAt)))) {
      return ErrBusinessDomainConflict;
    }
    const now = new Date();
    v.CreatedAt = now;
    v.UpdatedAt = now;
    if (err == null) {
      v.CreatedAt = previous.CreatedAt;
    }
    if (err === gorm.ErrRecordNotFound) {
      return tx.Create(new businessDomainRow({ ID: v.ID, Name: v.Name, Active: v.Active, Payload: mustJSON(v), CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt })).Error;
    }
    return tx.Model(new businessDomainRow()).Where("id = ?", v.ID).Updates({ name: v.Name, active: v.Active, payload: mustJSON(v), updated_at: v.UpdatedAt }).Error;
  });
};

module.exports = { businessDomainRow, businessDomainAssignmentRow, ErrBusinessDomainConflict };
