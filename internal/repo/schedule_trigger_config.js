// schedule_trigger_config.js —— 对应 Go 文件：internal/repo/schedule_trigger_config.go
// 作用：项目触发配置写入：同一项目只允许一个触发配置，写时锁项目行串行化。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { ScheduleJob } = require("../domain/sync.js"); // 对应 Go 的 domain.ScheduleJob，sync.js 已翻译
const { jsonUnmarshal } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { scheduleJobRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译

const ErrProjectTriggerConfigExists = new Error("当前项目已有触发配置，请刷新后编辑已有配置");

CatalogRepo.prototype.PutProjectTriggerConfig = function (v) {
  return this.DB.Transaction((tx) => {
    const lockErr = this.projects.lockProjectInTx(tx, v.ProjectID);
    if (lockErr === gorm.ErrRecordNotFound) {
      // 项目记录缺失时只允许原地编辑，不新建、不迁移配置。
      const row = new scheduleJobRow();
      const err = this.locking(tx).Where("id = ?", v.ID).First(row).Error;
      if (err != null) {
        return err;
      }
      const prior = new ScheduleJob();
      const unmarshalErr = jsonUnmarshal(row.Payload, prior);
      if (unmarshalErr != null) {
        return unmarshalErr;
      }
      if (prior.ProjectID !== v.ProjectID || prior.SkipDispatch) {
        return gorm.ErrRecordNotFound;
      }
    } else if (lockErr != null) {
      return lockErr;
    }
    const rows = [];
    const findErr = tx.Where(this.sqlJSONText("$.projectId") + " = ?", "$.projectId", v.ProjectID).Find(rows).Error;
    if (findErr != null) {
      return findErr;
    }
    for (const row of rows) {
      const existing = new ScheduleJob();
      const unmarshalErr = jsonUnmarshal(row.Payload, existing);
      if (unmarshalErr != null) {
        return unmarshalErr;
      }
      if (!existing.SkipDispatch && existing.ID !== v.ID) {
        return ErrProjectTriggerConfigExists;
      }
    }
    const writer = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    writer.DB = tx;
    writer.deps = { ...this.deps, DB: tx };
    return writer.PutScheduleJob(v);
  });
};

module.exports = { ErrProjectTriggerConfigExists };
