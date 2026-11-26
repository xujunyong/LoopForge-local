/**
 * @file internal/repo/analytics_activity_usage.js
 * 对应 Go 源文件：internal/repo/analytics_activity_usage.go
 *
 * 作用与职责边界：
 * 负责按批次从数据库投影读取助手会话中助手回复的时间戳与 Token 用量（不加载消息正文与工具输出），
 * 并在不支持 `JSON_TABLE` 的 MySQL 5.7 环境下自动降级为只读批量提取，以及将单条回复用量累加至活跃度统计结构。
 *
 * 语法差异说明：
 * - Go 的 `sync/atomic.Bool`（`noAnalyticsUsageProjection`）在单线程 JS 中直接译为普通布尔变量。
 * - Go 仅返回 `error` 的方法在成功时返回 `undefined`、失败时抛出错误。
 * - Go 的 `[]byte` 字段零值初始化为 `[]`，`time.Time` 与指针字段零值初始化为 `null`。
 */

"use strict";

const { AssistantMessage } = require("../domain/assistant.js"); // 对应 Go 的 domain.AssistantMessage，domain 已翻译
const { AnalyticsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { summaryProjectionUnsupported } = require("./assistant_context.js"); // 对应 Go 同包函数，assistant_context.js 待翻译

/**
 * 数据库 JSON 投影得到的单条助手回复用量记录。
 * 仅保留消息索引、创建/开始时间与 Token 用量，用于活跃度用量统计。
 */
class analyticsUsageMessage {
  /**
   * 构造助手回复用量消息对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {number} [init.Index=0] - 消息在会话消息数组中的下标。
   * @param {Date|null} [init.CreatedAt=null] - 消息创建时间。
   * @param {Date|null} [init.StartedAt=null] - 消息开始生成时间（指针字段，缺失时为 `null`）。
   * @param {import("../domain/run.js").TokenUsage|null} [init.Usage=null] - 消息的 Token 用量结构（缺失时为 `null`）。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Index = init.Index ?? 0;
    this.CreatedAt = init.CreatedAt ?? null;
    this.StartedAt = init.StartedAt ?? null;
    this.Usage = init.Usage ?? null;
  }
}

/**
 * 会话用量投影查询的单行数据库扫描结果。
 */
class analyticsUsageRow {
  /**
   * 构造会话用量查询行对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.ID=""] - 会话 ID。
   * @param {Buffer|number[]} [init.Messages=[]] - 查询返回的消息用量 JSON 字节序列。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Messages = init.Messages ?? [];
  }
}

// 标记当前 MySQL 实例是否不支持 JSON_TABLE 投影；Go 的 atomic.Bool 在单线程 JS 中使用普通布尔变量。
let noAnalyticsUsageProjection = false;

/**
 * 按每批 100 条投影读取指定会话集合中全部助手回复的时间戳与 Token 用量，并逐会话回调处理。
 * 在活跃度统计读取会话回复用量时调用；优先通过 SQL JSON 投影剔除正文与工具输出，若 MySQL 不支持 `JSON_TABLE` 则自动回退为提取 `$.messages` 后在内存中过滤助手消息。
 *
 * @param {string[]} ids - 待统计的会话 ID 列表。
 * @param {function(string, analyticsUsageMessage[]): void} visit - 处理单个会话及其助手回复用量列表的回调函数，入参依次为会话 ID 与回复用量数组。
 * @returns {void} 无返回值；数据库查询或 JSON 解析失败时抛出错误。
 */
AnalyticsRepo.prototype.analyticsSessionUsage = function (ids, visit) {
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, Math.min(start + 100, ids.length));
    let rows = [];
    let projected = !noAnalyticsUsageProjection;
    if (projected) {
      let expr = `(SELECT json_group_array(json_object('index',CAST(m.key AS INTEGER),'createdAt',json_extract(m.value,'$.createdAt'),'startedAt',json_extract(m.value,'$.startedAt'),'usage',json_extract(m.value,'$.usage'))) FROM json_each(s.payload,'$.messages') m WHERE json_extract(m.value,'$.role')='assistant')`;
      if (this.isMySQL()) {
        expr = `(SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('index',m.pos-1,'createdAt',JSON_EXTRACT(s.payload,CONCAT('$.messages[',m.pos-1,'].createdAt')),'startedAt',JSON_EXTRACT(s.payload,CONCAT('$.messages[',m.pos-1,'].startedAt')),'usage',JSON_EXTRACT(s.payload,CONCAT('$.messages[',m.pos-1,'].usage')))),JSON_ARRAY()) FROM JSON_TABLE(s.payload,'$.messages[*]' COLUMNS(pos FOR ORDINALITY,role VARCHAR(32) PATH '$.role')) m WHERE m.role='assistant')`;
      }
      const err = this.DB.Table("assistant_sessions s").Select("s.id, " + expr + " AS messages").Where("s.id IN ?", batch).Scan(rows).Error;
      if (err != null) {
        if (!this.isMySQL() || !summaryProjectionUnsupported(err)) {
          throw err;
        }
        noAnalyticsUsageProjection = true;
        projected = false;
      }
    }
    if (!projected) {
      rows = [];
      const err = this.DB.Table("assistant_sessions").Select("id, JSON_EXTRACT(payload,'$.messages') AS messages").Where("id IN ?", batch).Scan(rows).Error;
      if (err != null) {
        throw err;
      }
    }
    for (const row of rows) {
      let messages = [];
      if (row.Messages != null && row.Messages.length > 0) {
        if (projected) {
          messages = JSON.parse(row.Messages.toString("utf8")).map((m) => new analyticsUsageMessage(m));
        } else {
          const full = JSON.parse(row.Messages.toString("utf8")).map((m) => new AssistantMessage(m));
          for (let i = 0; i < full.length; i++) {
            const m = full[i];
            if (m.Role === "assistant") {
              messages.push(new analyticsUsageMessage({ Index: i, CreatedAt: m.CreatedAt, StartedAt: m.StartedAt, Usage: m.Usage }));
            }
          }
        }
      }
      visit(row.ID, messages);
    }
  }
};

/**
 * 将单条助手回复的 Token 用量及上报状态累加到会话用量汇总对象中。
 * 在活跃度统计遍历助手消息时调用，同步记录无时间戳回复数、缺失用量回复数与已上报回复数；若 `TotalTokens` 为 0 则以输入输出之和补算。
 *
 * @param {import("../domain/analytics.js").AnalyticsSessionUsage} out - 目标会话用量汇总对象（就地修改）。
 * @param {import("../domain/run.js").TokenUsage|null} usage - 单条助手回复的 Token 用量；为 `null` 时计为缺失用量回复。
 * @param {boolean} undated - 该回复是否缺少有效时间戳。
 * @returns {void} 无返回值。
 */
function accumulateSessionUsage(out, usage, undated) {
  if (undated) {
    out.UndatedReplies++;
  }
  if (usage == null) {
    out.MissingReplies++;
    return;
  }
  out.ReportedReplies++;
  let total = usage.TotalTokens;
  if (total === 0) {
    total = usage.InputTokens + usage.OutputTokens;
  }
  out.Tokens += total;
  out.InputTokens += usage.InputTokens;
  out.OutputTokens += usage.OutputTokens;
  out.CacheReadTokens += usage.CacheReadTokens;
  out.CacheWriteTokens += usage.CacheWriteTokens;
}

module.exports = { analyticsUsageMessage, analyticsUsageRow, accumulateSessionUsage };
