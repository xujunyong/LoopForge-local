/**
 * @file internal/repo/schedule_trigger_config.js
 * 对应 Go 源文件：internal/repo/schedule_trigger_config.go
 *
 * 作用与职责边界：
 * 为目录仓储 `CatalogRepo` 实现项目级自动触发配置的串行化写入（`PutProjectTriggerConfig`），
 * 通过在事务内锁定所属项目行保证同一项目最多仅存在一个触发配置，同时兼容所属项目记录已缺失时的原地编辑。
 * 不负责独立 AI 定时任务（`SkipDispatch === true`）的写入与共享发布。
 *
 * 语法差异说明：
 * - `CatalogRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `CatalogRepo.prototype` 挂载方法。
 * - Go 的仅 `error` 返回与 `db.Transaction(tx => ...)` 回调统一按成功返回 `undefined`、失败 `throw err` 处理。
 * - `this.projects.lockProjectInTx` 失败时直接抛错，因此以 `try ... catch` 对应 Go 中的 `errors.Is(err, gorm.ErrRecordNotFound)` 分支。
 * - Go 的 `writer := *r; writer.deps = &deps{DB: tx}` 在 JS 中通过保留原型的浅拷贝对象替换 `DB` 与 `deps` 句柄。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { ScheduleJob } = require("../domain/sync.js"); // 对应 Go 的 domain.ScheduleJob，sync.js 已翻译
const { CatalogRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { jsonUnmarshal } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译
const { scheduleJobRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译

// 同一项目下已存在其他非独立触发配置时抛出的冲突错误。
const ErrProjectTriggerConfigExists = new Error("当前项目已有触发配置，请刷新后编辑已有配置");

/**
 * 在事务内锁定所属项目行后写入项目级触发配置，保证跨实例并发创建时同一项目至多存在一条触发配置。
 * 若项目记录已不存在，则仅允许原地更新已存在的同项目触发配置，禁止向缺失项目新建或迁入配置。
 *
 * @param {ScheduleJob} v - 待保存的项目触发配置对象。
 * @returns {void} 无返回值。
 * @throws {Error} 项目不存在且非合法原地更新（`gorm.ErrRecordNotFound`）、项目已有其他触发配置（`ErrProjectTriggerConfigExists`）或事务读写失败时抛出错误。
 */
CatalogRepo.prototype.PutProjectTriggerConfig = function (v) {
  this.DB.Transaction((tx) => {
    try {
      this.projects.lockProjectInTx(tx, v.ProjectID);
    } catch (lockErr) {
      if (lockErr === gorm.ErrRecordNotFound) {
        // 既有任务可能比其所属项目存活更久：允许原地编辑兼容更新，但不允许向缺失项目新建或迁入配置。
        const row = new scheduleJobRow();
        const err = this.locking(tx).Where("id = ?", v.ID).First(row).Error;
        if (err != null) {
          throw err;
        }
        const prior = new ScheduleJob();
        jsonUnmarshal(row.Payload, prior);
        if (prior.ProjectID !== v.ProjectID || prior.SkipDispatch) {
          throw gorm.ErrRecordNotFound;
        }
      } else {
        throw lockErr;
      }
    }
    const rows = [];
    const findErr = tx.Where(this.sqlJSONText("$.projectId") + " = ?", "$.projectId", v.ProjectID).Find(rows).Error;
    if (findErr != null) {
      throw findErr;
    }
    for (const row of rows) {
      const existing = new ScheduleJob();
      jsonUnmarshal(row.Payload, existing);
      if (!existing.SkipDispatch && existing.ID !== v.ID) {
        throw ErrProjectTriggerConfigExists;
      }
    }
    const writer = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    writer.DB = tx;
    writer.deps = { ...this.deps, DB: tx };
    writer.PutScheduleJob(v);
  });
};

module.exports = { ErrProjectTriggerConfigExists };
