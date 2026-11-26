/**
 * @file internal/repo/engine_instances.js
 * 对应 Go 源文件：internal/repo/engine_instances.go
 *
 * 作用与职责边界：
 * 实现引擎实例注册表仓储（`EngineInstancesRepo`），负责 API/Worker 进程心跳续租与注销、
 * 按工作区宿主机判断工作进程是否存活，以及查询指定实例、存活工作节点或宿主机对应的运行控制中断地址（`ControlURL`）。
 *
 * 语法差异说明：
 * - `EngineInstancesRepo` 继承 `deps`（对应 Go 的 `*deps` 匿名嵌入）。
 * - Go 的 `error` 返回统一按成功无返回值（`undefined`）、失败 `throw err` 处理。
 * - Go 的 `time.Duration` 译为毫秒数；`map[string]struct{}` 集合译为普通对象 `{}`（值为 `true`）。
 * - Go 的 `gorm` 链式调用与 `clause.OnConflict` 按原样保留。
 */

"use strict";

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause
const { deps, ErrRunLeaseLost } = require("./repo.js"); // 对应 Go 同包基类与错误变量，repo.js 已翻译
const { engineInstanceRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译

/**
 * 表示一个可接收运行控制中断请求的存活 API/Worker 引擎实例。
 * 当心跳停止超过租约期限后记录视为过期。
 */
class EngineInstance {
  /**
   * 构造并初始化引擎实例描述对象，未提供的字段按 Go 零值填充。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.InstanceID = init.InstanceID ?? "";
    this.Role = init.Role ?? "";
    this.ControlURL = init.ControlURL ?? "";
    this.WorkspaceHost = init.WorkspaceHost ?? "";
  }
}

/**
 * 引擎实例持久化仓储，管理活跃工作进程心跳租约与运行控制中断 URL。
 */
class EngineInstancesRepo extends deps {
  /**
   * 构造并初始化引擎实例仓储实例。
   *
   * @param {Object} [init={}] - 可选初始依赖（包含 `DB`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    super(init);
  }

  /**
   * 上报或续期引擎实例心跳租约，主键冲突时原子更新角色、控制 URL、工作区宿主机与租约截止时间。
   *
   * @param {EngineInstance} inst - 当前引擎实例信息。
   * @param {number} ttl - 心跳租约有效时长（毫秒），必须大于 0。
   * @returns {void} 无返回值。
   * @throws {Error} 实例 ID 为空、`ttl <= 0`（抛出 `ErrRunLeaseLost`）或数据库写入失败时抛出错误。
   */
  HeartbeatEngineInstance(inst, ttl) {
    const id = inst.InstanceID.trim();
    if (id === "" || ttl <= 0) {
      throw ErrRunLeaseLost;
    }
    const now = new Date();
    const row = new engineInstanceRow({
      InstanceID: id,
      Role: inst.Role.trim(),
      ControlURL: inst.ControlURL.trim().replace(/\/+$/, ""),
      WorkspaceHost: inst.WorkspaceHost.trim(),
      HeartbeatAt: now,
      LeaseUntil: new Date(now.getTime() + ttl),
    });
    const err = this.DB.Clauses(new clause.OnConflict({
      Columns: [new clause.Column({ Name: "instance_id" })],
      DoUpdates: clause.AssignmentColumns(["role", "control_url", "workspace_host", "heartbeat_at", "lease_until"]),
    })).Create(row).Error;
    if (err != null) {
      throw err;
    }
  }

  /**
   * 进程优雅退出时按实例 ID 删除其心跳注册记录。
   *
   * @param {string} instanceID - 待注销的引擎实例 ID。
   * @returns {void} 无返回值。
   * @throws {Error} 数据库删除失败时抛出错误。
   */
  DeleteEngineInstance(instanceID) {
    const id = instanceID.trim();
    if (id === "") {
      return;
    }
    const err = this.DB.Where("instance_id = ?", id).Delete(new engineInstanceRow()).Error;
    if (err != null) {
      throw err;
    }
  }

  /**
   * 判断指定工作区宿主机上是否仍有未过期的活跃工作进程（角色为 `worker` 或 `all`）。
   * 数据库查询出错时保守返回 `true`，避免在存活状态未知时误重建正在使用中的工作区而丢失未提交改动。
   *
   * @param {string} host - 工作区宿主机标识。
   * @returns {boolean} 宿主机仍有活跃 worker 或存活状态未知时返回 `true`，否则返回 `false`。
   */
  WorkspaceHostAlive(host) {
    host = host.trim();
    if (host === "") {
      return false;
    }
    let count = 0;
    const err = this.DB.Model(new engineInstanceRow()).
      Where("workspace_host = ? AND lease_until > ? AND role IN ?", host, new Date(), ["worker", "all"]).
      Count(count).Error;
    if (err != null) {
      // 存活状态未知时保留绑定：避免误重建仍在别处运行的工作区而丢失未提交工作。
      return true;
    }
    return count > 0;
  }

  /**
   * 查询指定未过期引擎实例对外通告的运行控制中断 URL（去除尾部斜杠）。
   *
   * @param {string} instanceID - 引擎实例 ID。
   * @returns {string} 规整后的控制 URL；实例不存在、已过期或无控制地址时返回 `""`。
   */
  EngineInstanceControlURL(instanceID) {
    const id = instanceID.trim();
    if (id === "") {
      return "";
    }
    const row = new engineInstanceRow();
    const err = this.DB.Where("instance_id = ? AND control_url <> '' AND lease_until > ?", id, new Date()).Take(row).Error;
    if (err != null) {
      return "";
    }
    return row.ControlURL.trim().replace(/\/+$/, "");
  }

  /**
   * 列出当前所有未过期工作节点（角色为 `worker` 或 `all`）去重后的运行控制 URL 列表。
   *
   * @returns {string[]|null} 去重后的控制 URL 数组；数据库查询失败时返回 `null`。
   */
  LiveWorkerControlURLs() {
    const rows = [];
    if (this.DB.Where("control_url <> '' AND lease_until > ? AND role IN ?", new Date(), ["worker", "all"]).Find(rows).Error != null) {
      return null;
    }
    const seen = {};
    const out = [];
    for (const row of rows) {
      const u = row.ControlURL.trim().replace(/\/+$/, "");
      if (u === "") {
        continue;
      }
      if (seen[u]) {
        continue;
      }
      seen[u] = true;
      out.push(u);
    }
    return out;
  }

  /**
   * 查询指定工作区宿主机上最近一次心跳的活跃工作进程控制 URL。
   *
   * @param {string} host - 工作区宿主机标识。
   * @returns {string} 去除尾部斜杠的控制 URL；未找到活跃进程时返回 `""`。
   */
  WorkspaceHostControlURL(host) {
    const row = new engineInstanceRow();
    if (this.DB.Where("workspace_host = ? AND control_url <> '' AND lease_until > ? AND role IN ?", host, new Date(), ["worker", "all"]).Order("heartbeat_at DESC").Take(row).Error != null) {
      return "";
    }
    return row.ControlURL.replace(/\/+$/, "");
  }
}

module.exports = { EngineInstance, EngineInstancesRepo };
