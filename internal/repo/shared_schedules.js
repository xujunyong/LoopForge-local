/**
 * @file internal/repo/shared_schedules.js
 * 对应 Go 源文件：internal/repo/shared_schedules.go
 *
 * 作用与职责边界：
 * 为目录仓储 `CatalogRepo` 实现共享 AI 定时任务版本的历史查询、单版本读取、共享市场最新版本列表查询，
 * 以及带行锁与乐观版本号校验（`baseVersion`）的共享版本发布事务（自动级联共享直接引用资产并固化归属快照）。
 * 不负责直接引用资产解析与校验细节（见 `shared_schedule_assets.js`）。
 *
 * 语法差异说明：
 * - `CatalogRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `CatalogRepo.prototype` 挂载方法。
 * - Go 的 `(值, error)` 返回统一按成功返回值、失败 `throw err` 处理；`db.Transaction(tx => ...)` 回调同样失败抛错、成功正常返回。
 * - Go 的 `crypto/sha256` 与 `encoding/hex` 译为 Node.js `node:crypto` 的 `createHash("sha256")`。
 * - Go 的 `catalog := *r; catalog.deps = &deps{DB: tx}` 在 JS 中通过保留原型的浅拷贝对象替换 `DB` 与 `deps` 句柄。
 */

"use strict";

const { createHash } = require("node:crypto"); // Go crypto/sha256

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { ScheduleJob } = require("../domain/sync.js"); // 对应 Go 的 domain.ScheduleJob，sync.js 已翻译
const { SharedScheduleVersion } = require("../domain/shared_schedule.js"); // 对应 Go 的 domain.SharedScheduleVersion，shared_schedule.js 已翻译
const { AssistantReference } = require("../domain/assistant.js"); // 对应 Go 的 domain.AssistantReference，assistant.js 已翻译
const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { jsonUnmarshal, mustJSON, timePtr } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { scheduleJobRow, sharedScheduleVersionRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { ErrSharedScheduleReferences } = require("./shared_schedule_assets.js"); // 对应 Go 同包变量，shared_schedule_assets.js 已翻译

// 发布共享定时任务新版本时传入的基准版本号落后于最新已发布版本时抛出的乐观锁冲突错误。
const ErrSharedScheduleVersionConflict = new Error("共享任务已有新版本，请刷新后再发布");

/**
 * 按版本号倒序查询指定共享定时任务的全部已发布历史版本。
 *
 * @param {string} id - 共享定时任务 ID（`shared_task_id`）。
 * @returns {SharedScheduleVersion[]} 按版本号降序排列的共享版本数组。
 * @throws {Error} 数据库查询或载荷 JSON 反序列化失败时抛出错误。
 */
CatalogRepo.prototype.SharedScheduleVersions = function (id) {
  const rows = [];
  const findErr = this.DB.Where("shared_task_id = ?", id).Order("version DESC").Find(rows).Error;
  if (findErr != null) {
    throw findErr;
  }
  const out = [];
  for (const row of rows) {
    const v = new SharedScheduleVersion();
    jsonUnmarshal(row.Payload, v);
    out.push(v);
  }
  return out;
};

/**
 * 按共享任务 ID 与精确版本号读取单个不可变共享版本记录。
 *
 * @param {string} id - 共享定时任务 ID（`shared_task_id`）。
 * @param {number} version - 目标版本号。
 * @returns {SharedScheduleVersion} 反序列化后的共享版本对象。
 * @throws {Error} 记录不存在、数据库查询或载荷反序列化失败时抛出错误。
 */
CatalogRepo.prototype.SharedScheduleVersion = function (id, version) {
  const row = new sharedScheduleVersionRow();
  const err = this.DB.Where("shared_task_id = ? AND version = ?", id, version).First(row).Error;
  if (err != null) {
    throw err;
  }
  const v = new SharedScheduleVersion();
  jsonUnmarshal(row.Payload, v);
  return v;
};

/**
 * 查询所有共享定时任务各自的最新版本，按最新发布时间倒序排列，供共享市场目录展示。
 *
 * @returns {SharedScheduleVersion[]} 每个共享任务的最新版本对象数组。
 * @throws {Error} 原生 SQL 聚合查询或载荷反序列化失败时抛出错误。
 */
CatalogRepo.prototype.SharedScheduleTasks = function () {
  const rows = [];
  const scanErr = this.DB.Raw("SELECT v.* FROM shared_schedule_versions v JOIN (SELECT shared_task_id, MAX(version) AS version FROM shared_schedule_versions GROUP BY shared_task_id) latest ON v.shared_task_id = latest.shared_task_id AND v.version = latest.version ORDER BY v.created_at DESC").Scan(rows).Error;
  if (scanErr != null) {
    throw scanErr;
  }
  const out = [];
  for (const row of rows) {
    const v = new SharedScheduleVersion();
    jsonUnmarshal(row.Payload, v);
    out.push(v);
  }
  return out;
};

/**
 * 在事务内锁定源独立 AI 定时任务、校验乐观锁基准版本号、级联共享其直接引用资产、
 * 固化引用元信息与资产归属并写入递增后的新共享版本记录。
 *
 * @param {string} jobID - 源独立 AI 定时任务 ID。
 * @param {string} projectID - 源任务所属项目 ID。
 * @param {SharedScheduleVersion} v - 待发布的共享版本元数据（会被补齐 ID、版本号、资产快照与创建时间）。
 * @param {number} baseVersion - 调用方期望的最新版本号（首次发布为 `0`），用于防并发覆盖。
 * @returns {SharedScheduleVersion} 写入成功并填充完整字段的新共享版本对象。
 * @throws {Error} 版本字段校验失败、源任务不符合发布条件、版本冲突（`ErrSharedScheduleVersionConflict`）、引用共享失败或写入失败时抛出错误。
 */
CatalogRepo.prototype.PublishSharedSchedule = function (jobID, projectID, v, baseVersion) {
  v.Validate();
  this.DB.Transaction((tx) => {
    const source = new scheduleJobRow();
    const lockErr = this.locking(tx).Where("id = ?", jobID).First(source).Error;
    if (lockErr != null) {
      throw lockErr;
    }
    const job = new ScheduleJob();
    jsonUnmarshal(source.Payload, job);
    if (!job.SkipDispatch || job.SharedTaskID !== "" || job.ProjectID !== projectID) {
      throw new Error("只能从当前项目的独立 AI 定时任务发布共享版本");
    }
    // 直接引用与锁定的源任务在同一事务内读取，绝不信任发布请求体里的引用；嵌套依赖仍由被引用资产各自的解析器负责。
    const catalog = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    catalog.DB = tx;
    catalog.deps = { ...this.deps, DB: tx };
    const sum = createHash("sha256").update(projectID + "\0" + jobID, "utf8").digest();
    const id = "shared-" + sum.subarray(0, 16).toString("hex");
    const latest = new sharedScheduleVersionRow();
    const latestErr = tx.Where("shared_task_id = ?", id).Order("version DESC").First(latest).Error;
    if (latestErr != null && latestErr !== gorm.ErrRecordNotFound) {
      throw latestErr;
    }
    if (baseVersion !== latest.Version) {
      throw ErrSharedScheduleVersionConflict;
    }
    const refs = catalog.directScheduleReferences(job.References);
    for (const ref of refs) {
      catalog.shareScheduleReference(ref, projectID);
    }
    const assets = catalog.sharedScheduleAssets(job.References);
    v.Assets = assets;
    v.References = [];
    for (const asset of assets) {
      const [ref, shared, ok] = catalog.sharedScheduleReference(new AssistantReference({ Type: asset.Type, ID: asset.ID }));
      if (!ok || !shared || ref.ProjectID !== asset.ProjectID) {
        throw new Error(`${ErrSharedScheduleReferences.message}：${asset.Type}/${asset.ID} 的权限或归属已变更`);
      }
      v.References.push(ref);
    }
    v.ID = id;
    v.Version = latest.Version + 1;
    v.SourceJobID = jobID;
    v.SourceProjectID = projectID;
    v.CreatedAt = new Date();
    const createErr = tx.Create(new sharedScheduleVersionRow({ ID: `${id}-v${v.Version}`, SharedTaskID: id, Version: v.Version, Payload: mustJSON(v), Created: timePtr(v.CreatedAt) })).Error;
    if (createErr != null) {
      throw createErr;
    }
  });
  return v;
};

module.exports = { ErrSharedScheduleVersionConflict };
