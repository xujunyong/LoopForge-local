/**
 * @file internal/repo/insights.js
 * @description 对应 Go 文件：internal/repo/insights.go
 * 职责与边界：定义洞察数据上报仓库 `InsightsRepo` 及其物理表行模型 `insightSourceRow`、`insightExecutionRow`，
 * 负责洞察来源凭证的创建、查询、有效期校验与撤销，以及已完成外部执行记录的原子幂等摄入与筛选查询。
 * 语法差异说明：
 * - Go 的 `(值, error)` 译为成功直接返回值、失败 `throw err`；仅 `error` 译为成功无返回值、失败 `throw err`。
 * - `gorm` 事务回调（`this.DB.Transaction((tx) => ...)`）同样遵循失败 `throw err`、成功正常返回的约定。
 * - Go 结构体嵌入的 `*deps` 在 JS 中以 `this.DB` 承载（`locking` 随 `repo.js` 运行期能力提供），避免与 `repo.js` 顶层循环引用。
 * - Go 的 `time.Time` 零值统一译为 `null`。
 */

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { InsightSource } = require("../domain/insights.js"); // 对应 Go 的 domain.InsightSource，domain 已翻译
const { hexSHA256 } = require("./hash.js"); // 对应 Go 同包函数
const { jsonBytes } = require("./payload.js"); // 对应 Go 同包函数

/** 上报的记录 ID 或外部执行 ID 已存在但内容哈希不一致时抛出的冲突错误。 */
const ErrInsightConflict = new Error("record ID or execution ID already exists with different content");

/**
 * 外部洞察数据上报的来源凭证与执行记录仓库。
 * 对应 Go 中嵌入 `*deps`（提供 `DB` 与 `locking`）的 `InsightsRepo`。
 */
class InsightsRepo {
  /**
   * 构造洞察仓库实例。
   * 使用场景：由 `repo.js` 的 `newStore` 装配存储层时创建。
   *
   * @param {Object} [init={}] - 初始化依赖映射。
   * @param {Object | null} [init.DB=null] - gorm 数据库句柄。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.DB = init.DB ?? null;
  }

  /**
   * 持久化一条新的洞察来源凭证记录。
   * 使用场景：项目维护者创建外部洞察上报令牌并保存来源元数据时调用。
   *
   * @param {InsightSource} source - 洞察来源领域对象（含 ID、项目 ID、用户映射及过期时间等）。
   * @param {string} tokenHash - 凭证令牌的 SHA-256 十六进制哈希。
   * @returns {void} 无返回值；数据库写入失败时抛出错误。
   */
  CreateInsightSource(source, tokenHash) {
    const err = this.DB.Create(new insightSourceRow({
      ID: source.ID,
      ProjectID: source.ProjectID,
      TokenHash: tokenHash,
      Payload: jsonBytes(source),
      ExpiresAt: source.ExpiresAt,
    })).Error;
    if (err != null) {
      throw err;
    }
  }

  /**
   * 按主键 ID 查询并解码单条洞察来源凭证。
   * 使用场景：管理端查看来源详情或执行撤销前校验来源归属时调用。
   *
   * @param {string} id - 洞察来源 ID。
   * @returns {InsightSource} 解码后的洞察来源领域对象；记录不存在、查询失败或 JSON 解码失败时抛出错误。
   */
  InsightSource(id) {
    const row = new insightSourceRow();
    const err = this.DB.First(row, "id = ?", id).Error;
    if (err != null) {
      throw err;
    }
    return decodeInsightSource(row);
  }

  /**
   * 按主键升序列出指定项目下的全部洞察来源凭证。
   * 使用场景：项目设置页展示已配置的洞察上报来源列表时调用。
   *
   * @param {string} projectID - 所属项目 ID。
   * @returns {InsightSource[]} 该项目的洞察来源列表；查询或任一行解码失败时抛出错误。
   */
  InsightSources(projectID) {
    const rows = [];
    const err = this.DB.Where("project_id = ?", projectID).Order("id").Find(rows).Error;
    if (err != null) {
      throw err;
    }
    const out = [];
    for (const row of rows) {
      out.push(decodeInsightSource(row));
    }
    return out;
  }

  /**
   * 按令牌哈希查找当前未撤销且尚未过期的有效洞察来源凭证。
   * 使用场景：外部洞察上报接口鉴权时验证请求携带的 Bearer Token。
   *
   * @param {string} tokenHash - 请求令牌的 SHA-256 十六进制哈希。
   * @param {Date} now - 用于校验未过期的当前时间。
   * @returns {InsightSource} 有效的洞察来源领域对象；无有效匹配或解码失败时抛出错误。
   */
  ActiveInsightSource(tokenHash, now) {
    const row = new insightSourceRow();
    const err = this.DB.Where("token_hash = ? AND revoked_at IS NULL AND expires_at > ?", tokenHash, now).First(row).Error;
    if (err != null) {
      throw err;
    }
    return decodeInsightSource(row);
  }

  /**
   * 将尚未撤销的洞察来源凭证标记为已撤销，记录撤销时间戳。
   * 使用场景：项目维护者吊销不再使用的洞察上报令牌时调用。
   *
   * @param {string} id - 洞察来源 ID。
   * @param {Date} now - 撤销生效时间。
   * @returns {void} 无返回值；数据库更新失败时抛出错误。
   */
  RevokeInsightSource(id, now) {
    const err = this.DB.Model(new insightSourceRow()).Where("id = ? AND revoked_at IS NULL", id).Update("revoked_at", now).Error;
    if (err != null) {
      throw err;
    }
  }

  /**
   * 在事务内原子提交一条不可变的已完成洞察执行记录；记录 ID 与外部执行 ID 在来源内均唯一，
   * 相同内容重试返回 `true`（幂等不重复计数），不同内容冲突则抛出 `ErrInsightConflict`。
   * 使用场景：外部洞察数据摄入接口落盘单条已完成执行记录时调用。
   *
   * @param {InsightSource} source - 已鉴权的洞察来源凭证（提供项目 ID 与外部用户映射）。
   * @param {import("../domain/insights.js").InsightExecution} execution - 待摄入的已完成执行记录。
   * @returns {boolean} 若该记录已以相同内容存在（幂等重试）返回 `true`，首次写入成功返回 `false`；来源失效、内容冲突或数据库失败时抛出错误。
   */
  IngestInsightExecution(source, execution) {
    const payload = JSON.stringify(execution);
    const row = new insightExecutionRow({
      ID: hexSHA256(source.ID + "\x00" + execution.ID),
      ExecutionKey: hexSHA256(source.ID + "\x00" + execution.ExternalExecutionID),
      SourceID: source.ID,
      ProjectID: source.ProjectID,
      UserID: (source.UserMappings ?? {})[execution.ExternalUserID] ?? 0,
      Payload: payload,
      ContentHash: hexSHA256(payload),
      FinishedAt: execution.FinishedAt,
      ReceivedAt: new Date(),
    });
    // 通过行锁与跨实例撤销操作串行化；SQLite 测试库单连接天然串行。
    let duplicate = false;
    this.DB.Transaction((tx) => {
      const credential = new insightSourceRow();
      const lockErr = this.locking(tx).First(credential, "id = ? AND revoked_at IS NULL AND expires_at > ?", source.ID, new Date()).Error;
      if (lockErr != null) {
        throw lockErr;
      }
      const existing = new insightExecutionRow();
      const findErr = tx.Where("id = ? OR execution_key = ?", row.ID, row.ExecutionKey).First(existing).Error;
      if (findErr == null) {
        if (existing.ID === row.ID && existing.ContentHash === row.ContentHash) {
          duplicate = true;
          return;
        }
        throw ErrInsightConflict;
      }
      if (findErr !== gorm.ErrRecordNotFound) {
        throw findErr;
      }
      const createErr = tx.Create(row).Error;
      if (createErr != null) {
        throw createErr;
      }
    });
    return duplicate;
  }

  /**
   * 按分析筛选条件（项目、项目集合、用户、完成时间起止）查询洞察执行物理行列表，按 `finished_at, id` 排序。
   * 使用场景：由运营分析模块（`analytics_insights.js`）读取外部洞察执行数据参与聚合统计。
   *
   * @param {import("../domain/analytics.js").AnalyticsFilter} filter - 运营分析查询筛选条件。
   * @returns {insightExecutionRow[]} 符合条件的洞察执行行数组；查询失败时抛出错误。
   */
  insightExecutions(filter) {
    const rows = [];
    let q = this.DB.Model(new insightExecutionRow());
    if (filter.ProjectID !== "") {
      q = q.Where("project_id = ?", filter.ProjectID);
    }
    if (filter.ProjectIDs != null) {
      if (filter.ProjectIDs.length === 0) {
        return rows;
      }
      q = q.Where("project_id IN ?", filter.ProjectIDs);
    }
    if (filter.UserID !== "") {
      q = q.Where("user_id = ?", filter.UserID);
    }
    // Go 的 time.Time 零值译为 null，非空即表示设置了时间边界。
    if (filter.From != null) {
      q = q.Where("finished_at >= ?", filter.From);
    }
    if (filter.To != null) {
      q = q.Where("finished_at <= ?", filter.To);
    }
    const err = q.Order("finished_at, id").Find(rows).Error;
    if (err != null) {
      throw err;
    }
    return rows;
  }
}

/**
 * 将数据库行 `insightSourceRow` 的 JSON 载荷反序列化为 `InsightSource` 领域对象，并回填独立的 `RevokedAt` 列。
 * 使用场景：由 `InsightSource`、`InsightSources` 与 `ActiveInsightSource` 内部调用。
 *
 * @param {insightSourceRow} row - 从 `insight_sources` 表读取的物理行。
 * @returns {InsightSource} 解码后的洞察来源领域对象；JSON 解析失败时抛出错误。
 */
function decodeInsightSource(row) {
  const raw = typeof row.Payload === "string" ? row.Payload : row.Payload.toString("utf8");
  const source = new InsightSource(JSON.parse(raw));
  source.RevokedAt = row.RevokedAt;
  return source;
}

/**
 * 对应数据库表 `insight_sources` 的洞察来源凭证行模型。
 */
class insightSourceRow {
  /**
   * 构造洞察来源行模型实例，未提供字段按 Go 零值初始化。
   * 使用场景：创建来源记录或执行 gorm 查询扫描时调用。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.ID=""] - 洞察来源主键 ID。
   * @param {string} [init.ProjectID=""] - 所属项目 ID。
   * @param {string} [init.TokenHash=""] - 凭证令牌的 SHA-256 哈希。
   * @param {Buffer | string | null} [init.Payload=null] - 序列化后的 `InsightSource` JSON 载荷。
   * @param {Date | null} [init.ExpiresAt=null] - 凭证过期时间。
   * @param {Date | null} [init.RevokedAt=null] - 凭证撤销时间（未撤销时为 `null`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.TokenHash = init.TokenHash ?? "";
    this.Payload = init.Payload ?? null;
    this.ExpiresAt = init.ExpiresAt ?? null;
    this.RevokedAt = init.RevokedAt ?? null;
  }

  /**
   * 返回 gorm 映射使用的物理表名。
   * 使用场景：由 gorm 模型解析与增量迁移调用。
   *
   * @returns {string} 物理表名 `"insight_sources"`。
   */
  TableName() {
    return "insight_sources";
  }
}

/**
 * 对应数据库表 `insight_executions` 的洞察执行记录行模型。
 * 主键与 `ExecutionKey` 均存储哈希值，以在 MySQL 默认排序规则下获得区分大小写且定长的唯一索引。
 */
class insightExecutionRow {
  /**
   * 构造洞察执行记录行模型实例，未提供字段按 Go 零值初始化。
   * 使用场景：摄入执行记录或按分析条件查询扫描时调用。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.ID=""] - 由来源 ID 与记录 ID 派生的 SHA-256 主键。
   * @param {string} [init.ExecutionKey=""] - 由来源 ID 与外部执行 ID 派生的唯一 SHA-256 键。
   * @param {string} [init.SourceID=""] - 上报来源 ID。
   * @param {string} [init.ProjectID=""] - 所属项目 ID。
   * @param {number} [init.UserID=0] - 映射后的平台用户 ID。
   * @param {Buffer | string | null} [init.Payload=null] - 序列化后的 `InsightExecution` JSON 载荷。
   * @param {string} [init.ContentHash=""] - 载荷正文 SHA-256 哈希，用于幂等重试一致性比对。
   * @param {Date | null} [init.FinishedAt=null] - 执行完成时间。
   * @param {Date | null} [init.ReceivedAt=null] - 平台接收时间。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ExecutionKey = init.ExecutionKey ?? "";
    this.SourceID = init.SourceID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.UserID = init.UserID ?? 0;
    this.Payload = init.Payload ?? null;
    this.ContentHash = init.ContentHash ?? "";
    this.FinishedAt = init.FinishedAt ?? null;
    this.ReceivedAt = init.ReceivedAt ?? null;
  }

  /**
   * 返回 gorm 映射使用的物理表名。
   * 使用场景：由 gorm 模型解析与增量迁移调用。
   *
   * @returns {string} 物理表名 `"insight_executions"`。
   */
  TableName() {
    return "insight_executions";
  }
}

module.exports = { ErrInsightConflict, InsightsRepo, insightSourceRow, insightExecutionRow, decodeInsightSource };
