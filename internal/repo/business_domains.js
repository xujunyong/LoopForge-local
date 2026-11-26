/**
 * @file internal/repo/business_domains.js
 * 对应 Go 源文件：internal/repo/business_domains.go
 *
 * 作用与职责边界：
 * 定义业务域表（`business_domains`）与项目业务域归属变更流水表（`business_domain_assignments`）的持久化行模型，
 * 并为 `BusinessDomainsRepo` 提供业务域全量列表查询、单条详情读取，以及带行锁和载荷精确时间比对的乐观并发写入。
 * 不负责项目归属批量迁移与业务域运营报表聚合（位于同包其他文件中）。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；`db.Transaction` 回调同样失败抛错、成功正常返回。
 * - Go 的 `errors.Is` 译为 `===`；`time.Time.Equal` 复用 `analytics.js` 提供的 `timeEqual` 保持与零值时间语义一致。
 * - GORM `struct` 标签直接略去，链式调用按原样保留。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { BusinessDomain } = require("../domain/business_domain.js"); // 对应 Go 的 domain.BusinessDomain，business_domain.js 已翻译
const { jsonUnmarshal, mustJSON } = require("./payload.js"); // 对应 Go 同包函数，payload.js 待翻译
const { BusinessDomainsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译
const { timeEqual } = require("./analytics.js"); // 对应 Go 的时间比较，analytics.js 已翻译

/**
 * 对应数据库表 `business_domains` 的业务域持久化行模型。
 * 主体领域字段以 JSON 存入 `payload` 列，同时冗余主键、唯一名称、启用状态与时间戳列便于查询索引。
 */
class businessDomainRow {
  /**
   * 构造业务域行对象，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.ID=""] - 业务域主键 ID。
   * @param {string} [init.Name=""] - 业务域名称（唯一索引）。
   * @param {boolean} [init.Active=false] - 是否处于启用状态。
   * @param {Buffer|string|null} [init.Payload=null] - 序列化后的 `BusinessDomain` JSON 载荷。
   * @param {Date|null} [init.CreatedAt=null] - 创建时间。
   * @param {Date|null} [init.UpdatedAt=null] - 最后更新时间。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Active = init.Active ?? false;
    this.Payload = init.Payload ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
  }

  /**
   * 返回 GORM 映射的物理数据库表名。
   *
   * @returns {string} 表名 `"business_domains"`。
   */
  TableName() {
    return "business_domains";
  }
}

/**
 * 对应数据库表 `business_domain_assignments` 的项目业务域归属变更审计流水行模型。
 * 记录项目从一个业务域调整到另一个业务域的操作人、原因与变更时间。
 */
class businessDomainAssignmentRow {
  /**
   * 构造业务域归属变更流水行对象，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {number} [init.ID=0] - 自增主键 ID。
   * @param {string} [init.ProjectID=""] - 发生归属变更的项目 ID。
   * @param {string} [init.FromDomainID=""] - 原所属业务域 ID。
   * @param {string} [init.ToDomainID=""] - 变更后目标业务域 ID。
   * @param {number} [init.ActorID=0] - 执行变更的操作用户 ID。
   * @param {string} [init.Reason=""] - 变更原因说明。
   * @param {Date|null} [init.CreatedAt=null] - 变更记录创建时间。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? 0;
    this.ProjectID = init.ProjectID ?? "";
    this.FromDomainID = init.FromDomainID ?? "";
    this.ToDomainID = init.ToDomainID ?? "";
    this.ActorID = init.ActorID ?? 0;
    this.Reason = init.Reason ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
  }

  /**
   * 返回 GORM 映射的物理数据库表名。
   *
   * @returns {string} 表名 `"business_domain_assignments"`。
   */
  TableName() {
    return "business_domain_assignments";
  }
}

/**
 * 按名称与 ID 升序查询全部业务域配置并反序列化为领域对象列表。
 * 用于业务域管理列表与项目归属下拉选择。
 *
 * @returns {BusinessDomain[]} 排序后的全部业务域配置数组。
 * @throws {Error} 数据库查询失败或 JSON 载荷反序列化失败时抛出错误。
 */
BusinessDomainsRepo.prototype.BusinessDomains = function () {
  const rows = [];
  const err = this.DB.Order("name, id").Find(rows).Error;
  if (err != null) {
    throw err;
  }
  const out = [];
  for (const row of rows) {
    const v = new BusinessDomain();
    jsonUnmarshal(row.Payload, v);
    out.push(v);
  }
  return out;
};

/**
 * 按主键 ID 读取单条业务域配置并反序列化为领域对象。
 * 用于查看或校验单个业务域是否存在及其详情。
 *
 * @param {string} id - 业务域主键 ID。
 * @returns {BusinessDomain} 查得的业务域配置对象。
 * @throws {Error} 记录不存在、数据库查询失败或 JSON 反序列化失败时抛出错误。
 */
BusinessDomainsRepo.prototype.BusinessDomain = function (id) {
  const row = new businessDomainRow();
  const err = this.DB.Where("id = ?", id).Take(row).Error;
  if (err != null) {
    throw err;
  }
  const v = new BusinessDomain();
  jsonUnmarshal(row.Payload, v);
  return v;
};

// 乐观并发校验失败（记录已存在或 `UpdatedAt` 与预期不一致）时抛出的冲突错误。
const ErrBusinessDomainConflict = new Error("业务域配置已变化，请刷新后重试");

/**
 * 在行锁事务中创建或更新业务域配置，并通过比对载荷中的精确 `UpdatedAt` 实现乐观并发控制。
 * `expectedUpdatedAt` 为 `null` 表示期望新建；非 `null` 表示期望更新且必须与载荷中的旧更新时间完全一致
 * （因 MySQL DATETIME 会截断亚秒精度，故使用 JSON 载荷里的精确时间比对）。
 *
 * @param {BusinessDomain} v - 待创建的或更新后的业务域对象（`ID` 与 `Name` 去除空白后均不可为空）。
 * @param {Date|null} expectedUpdatedAt - 乐观锁期望的上次更新时间；新建时传 `null`。
 * @returns {void} 无返回值。
 * @throws {Error} 标识或名称为空、并发版本冲突（`ErrBusinessDomainConflict`）、反序列化失败或数据库写入失败时抛出错误。
 */
BusinessDomainsRepo.prototype.PutBusinessDomain = function (v, expectedUpdatedAt) {
  v.ID = v.ID.trim();
  v.Name = v.Name.trim();
  if (v.ID === "" || v.Name === "") {
    throw new Error("业务域标识和名称不能为空");
  }
  this.DB.Transaction((tx) => {
    const row = new businessDomainRow();
    const err = this.locking(tx).Where("id = ?", v.ID).Take(row).Error;
    if (err != null && err !== gorm.ErrRecordNotFound) {
      throw err;
    }
    const previous = new BusinessDomain();
    if (err == null) {
      jsonUnmarshal(row.Payload, previous);
    }
    // MySQL DATETIME 会截断时间精度，因此比对 JSON 载荷中保存的精确更新时间。
    if ((expectedUpdatedAt == null && err == null) || (expectedUpdatedAt != null && (err != null || !timeEqual(previous.UpdatedAt, expectedUpdatedAt)))) {
      throw ErrBusinessDomainConflict;
    }
    const now = new Date();
    v.CreatedAt = now;
    v.UpdatedAt = now;
    if (err == null) {
      v.CreatedAt = previous.CreatedAt;
    }
    if (err === gorm.ErrRecordNotFound) {
      const createErr = tx.Create(new businessDomainRow({ ID: v.ID, Name: v.Name, Active: v.Active, Payload: mustJSON(v), CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt })).Error;
      if (createErr != null) {
        throw createErr;
      }
      return;
    }
    const updateErr = tx.Model(new businessDomainRow()).Where("id = ?", v.ID).Updates({ name: v.Name, active: v.Active, payload: mustJSON(v), updated_at: v.UpdatedAt }).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
};

module.exports = { businessDomainRow, businessDomainAssignmentRow, ErrBusinessDomainConflict };
