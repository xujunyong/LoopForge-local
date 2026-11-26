// shared_schedules.js —— 对应 Go 文件：internal/repo/shared_schedules.go
// 作用：共享定时任务版本的查询与发布，带乐观锁版本号校验。
// Go 的 fmt.Errorf %w 译为模板字符串。

"use strict";

const { createHash } = require("node:crypto"); // Go crypto/sha256

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { ScheduleJob } = require("../domain/sync.js"); // 对应 Go 的 domain.ScheduleJob，sync.js 已翻译
const { SharedScheduleVersion } = require("../domain/shared_schedule.js"); // 对应 Go 的 domain.SharedScheduleVersion，shared_schedule.js 已翻译
const { AssistantReference } = require("../domain/assistant.js"); // 对应 Go 的 domain.AssistantReference，assistant.js 已翻译
const { jsonUnmarshal, mustJSON, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { scheduleJobRow, sharedScheduleVersionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { ErrSharedScheduleReferences } = require("./shared_schedule_assets.js"); // 对应 Go 同包变量，shared_schedule_assets.js 已翻译

const ErrSharedScheduleVersionConflict = new Error("共享任务已有新版本，请刷新后再发布");

CatalogRepo.prototype.SharedScheduleVersions = function (id) {
  const rows = [];
  const findErr = this.DB.Where("shared_task_id = ?", id).Order("version DESC").Find(rows).Error;
  if (findErr != null) {
    return [null, findErr];
  }
  const out = [];
  for (const row of rows) {
    const v = new SharedScheduleVersion();
    const unmarshalErr = jsonUnmarshal(row.Payload, v);
    if (unmarshalErr != null) {
      return [null, unmarshalErr];
    }
    out.push(v);
  }
  return [out, null];
};

CatalogRepo.prototype.SharedScheduleVersion = function (id, version) {
  const row = new sharedScheduleVersionRow();
  const err = this.DB.Where("shared_task_id = ? AND version = ?", id, version).First(row).Error;
  if (err != null) {
    return [new SharedScheduleVersion(), err];
  }
  const v = new SharedScheduleVersion();
  const unmarshalErr = jsonUnmarshal(row.Payload, v);
  return [v, unmarshalErr];
};

CatalogRepo.prototype.SharedScheduleTasks = function () {
  const rows = [];
  const scanErr = this.DB.Raw("SELECT v.* FROM shared_schedule_versions v JOIN (SELECT shared_task_id, MAX(version) AS version FROM shared_schedule_versions GROUP BY shared_task_id) latest ON v.shared_task_id = latest.shared_task_id AND v.version = latest.version ORDER BY v.created_at DESC").Scan(rows).Error;
  if (scanErr != null) {
    return [null, scanErr];
  }
  const out = [];
  for (const row of rows) {
    const v = new SharedScheduleVersion();
    const unmarshalErr = jsonUnmarshal(row.Payload, v);
    if (unmarshalErr != null) {
      return [null, unmarshalErr];
    }
    out.push(v);
  }
  return [out, null];
};

CatalogRepo.prototype.PublishSharedSchedule = function (jobID, projectID, v, baseVersion) {
  try {
    v.Validate();
  } catch (err) {
    return [v, err];
  }
  const err = this.DB.Transaction((tx) => {
    const source = new scheduleJobRow();
    const lockErr = this.locking(tx).Where("id = ?", jobID).First(source).Error;
    if (lockErr != null) {
      return lockErr;
    }
    const job = new ScheduleJob();
    const unmarshalErr = jsonUnmarshal(source.Payload, job);
    if (unmarshalErr != null) {
      return unmarshalErr;
    }
    if (!job.SkipDispatch || job.SharedTaskID !== "" || job.ProjectID !== projectID) {
      return new Error("只能从当前项目的独立 AI 定时任务发布共享版本");
    }
    // 直接引用与锁定的源任务在同一事务内读取，嵌套依赖仍由被引用资产各自的解析器负责。
    const catalog = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    catalog.DB = tx;
    catalog.deps = { ...this.deps, DB: tx };
    const sum = createHash("sha256").update(projectID + "\0" + jobID, "utf8").digest();
    const id = "shared-" + sum.subarray(0, 16).toString("hex");
    const latest = new sharedScheduleVersionRow();
    const latestErr = tx.Where("shared_task_id = ?", id).Order("version DESC").First(latest).Error;
    if (latestErr != null && latestErr !== gorm.ErrRecordNotFound) {
      return latestErr;
    }
    if (baseVersion !== latest.Version) {
      return ErrSharedScheduleVersionConflict;
    }
    const [refs, refsErr] = catalog.directScheduleReferences(job.References);
    if (refsErr != null) {
      return refsErr;
    }
    for (const ref of refs) {
      const shareErr = catalog.shareScheduleReference(ref, projectID);
      if (shareErr != null) {
        return shareErr;
      }
    }
    const [assets, assetsErr] = catalog.sharedScheduleAssets(job.References);
    if (assetsErr != null) {
      return assetsErr;
    }
    v.Assets = assets;
    v.References = [];
    for (const asset of assets) {
      const [ref, shared, ok] = catalog.sharedScheduleReference(new AssistantReference({ Type: asset.Type, ID: asset.ID }));
      if (!ok || !shared || ref.ProjectID !== asset.ProjectID) {
        return new Error(`${ErrSharedScheduleReferences.message}：${asset.Type}/${asset.ID} 的权限或归属已变更`);
      }
      v.References.push(ref);
    }
    v.ID = id;
    v.Version = latest.Version + 1;
    v.SourceJobID = jobID;
    v.SourceProjectID = projectID;
    v.CreatedAt = new Date();
    return tx.Create(new sharedScheduleVersionRow({ ID: `${id}-v${v.Version}`, SharedTaskID: id, Version: v.Version, Payload: mustJSON(v), Created: timePtr(v.CreatedAt) })).Error;
  });
  return [v, err];
};

module.exports = { ErrSharedScheduleVersionConflict };
