/**
 * @file internal/repo/assistant_run_meta.js
 * 对应 Go 源文件：internal/repo/assistant_run_meta.go
 *
 * 作用与职责边界：
 * 为历史会话侧边栏提供轻量的批量只读投影查询，包括 SOP 运行头部元数据、关联需求编号与标题，
 * 以及各会话的持久化消息计数，避免逐条加载完整运行图或对话正文导致列表接口慢查询。
 * 不负责写操作或侧边栏最终展示文案拼装。
 *
 * 语法差异说明：
 * - Go `map[string]V` 统一译为普通对象 `{}`；结构体零值按 Go 语义初始化（`time.Time` 译为 `null`）。
 * - Go `log.Printf` 译为 `console.log`；`min(start+500, len(ids))` 译为 `Math.min(start + 500, ids.length)`。
 * - 按 Go 原文件跨 `RunsRepo`、`IssuesRepo`、`AssistantRepo` 三个领域类型分别挂载原型方法。
 */

"use strict";

const { Buffer } = require("node:buffer");

const { TelemetryContext } = require("../domain/observability.js"); // 对应 Go 同包类型，observability.js 已翻译
const { RunsRepo, IssuesRepo, AssistantRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

/**
 * 侧边栏展示共享 SOP 运行会话所需的轻量运行头部信息。
 * 通过批量查询替代逐条 `RunState` 读取，避免传输侧边栏不会展示的完整节点图。
 */
class SidebarRunMeta {
  /**
   * 构造并初始化侧边栏运行头部元数据对象。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Status = init.Status ?? "";
    this.WorkflowID = init.WorkflowID ?? "";
    this.Kind = init.Kind ?? "";
    this.WorkflowName = init.WorkflowName ?? "";
    this.IssueID = init.IssueID ?? "";
    this.IssueNumber = init.IssueNumber ?? 0;
    this.ResponsibleUserID = init.ResponsibleUserID ?? 0;
    // Input 为启动运行时的任务文本开头截断，用于为未关联需求的运行命名。
    this.Input = init.Input ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
  }
}

// 侧边栏每条运行最多读取的任务输入文本字符数上限。
const sidebarRunInputChars = 300;

/**
 * 按运行 ID 列表分批（每批 500 条）加载侧边栏所需的运行头部元数据。
 * 查询出错时记录日志并返回已收集的部分结果，不中断整体列表渲染。
 *
 * @param {Array<string>} ids - 待查询的运行 ID 列表。
 * @returns {Object<string, SidebarRunMeta>} 以运行 ID 为键、运行头部元数据为值的映射对象。
 */
RunsRepo.prototype.SidebarRunMetas = function (ids) {
  const out = {};
  if (ids.length === 0) {
    return out;
  }
  let nameExpr = "json_extract(snapshot, '$.name')";
  if (this.isMySQL()) {
    nameExpr = "JSON_UNQUOTE(JSON_EXTRACT(snapshot, '$.name'))";
  }
  for (let start = 0; start < ids.length; start += 500) {
    const rows = [];
    const err = this.DB.Table("runs")
      .Select(`id, status, workflow_id, kind, ${nameExpr} AS workflow, execution_context AS context, SUBSTR(input, 1, ${sidebarRunInputChars}) AS input, created_at AS created`)
      .Where("id IN ?", ids.slice(start, Math.min(start + 500, ids.length)))
      .Scan(rows).Error;
    if (err != null) {
      console.log(`sidebar run meta read failed: ${err}`);
      return out;
    }
    for (const row of rows) {
      const meta = new SidebarRunMeta({ Status: row.Status });
      if (row.Workflow != null) {
        meta.WorkflowName = row.Workflow;
      }
      let ctx = new TelemetryContext();
      if (row.Context != null && row.Context.length > 0) {
        try {
          ctx = new TelemetryContext(JSON.parse(typeof row.Context === "string" ? row.Context : Buffer.from(row.Context).toString("utf8")));
        } catch (e) {
          // Go 忽略解码错误。
        }
      }
      meta.IssueID = ctx.IssueID;
      meta.IssueNumber = ctx.IssueNumber;
      meta.ResponsibleUserID = ctx.ResponsibleUserID;
      if (row.WorkflowID != null) {
        meta.WorkflowID = row.WorkflowID;
      }
      if (row.Kind != null) {
        meta.Kind = row.Kind;
      }
      if (row.Input != null) {
        meta.Input = row.Input;
      }
      if (row.Created != null) {
        meta.CreatedAt = row.Created;
      }
      out[row.ID] = meta;
    }
  }
  return out;
};

/**
 * 展示在 SOP 运行旁边的精简需求标识（仅含编号与标题）。
 */
class SidebarIssue {
  /**
   * 构造并初始化侧边栏需求标识对象。
   *
   * @param {Object} [init={}] - 可选初始字段映射，缺省字段按 Go 零值填充。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Number = init.Number ?? 0;
    this.Title = init.Title ?? "";
  }
}

/**
 * 按需求 ID 列表分批（每批 500 条）仅加载需求编号与标题，不读取正文描述或评论。
 * 查询出错时记录日志并返回已收集的部分结果。
 *
 * @param {Array<string>} ids - 待查询的需求 ID 列表。
 * @returns {Object<string, SidebarIssue>} 以需求 ID 为键、精简需求标识为值的映射对象。
 */
IssuesRepo.prototype.IssueSidebarIdentities = function (ids) {
  const out = {};
  if (ids.length === 0) {
    return out;
  }
  for (let start = 0; start < ids.length; start += 500) {
    const rows = [];
    const err = this.DB.Table("issues").Select("id, number, title")
      .Where("id IN ?", ids.slice(start, Math.min(start + 500, ids.length))).Scan(rows).Error;
    if (err != null) {
      console.log(`sidebar issue identity read failed: ${err}`);
      return out;
    }
    for (const row of rows) {
      out[row.ID] = new SidebarIssue({ Number: row.Number, Title: row.Title });
    }
  }
  return out;
};

/**
 * 在数据库侧直接统计指定会话列表的持久化消息条数，不传输对话全文。
 * 供历史列表区分尚未讨论的空白 SOP 运行会话与已有讨论记录的会话。
 *
 * @param {Array<string>} ids - 待统计的会话 ID 列表。
 * @returns {Object<string, number>} 以会话 ID 为键、消息数量为值的映射对象。
 */
AssistantRepo.prototype.AssistantSessionMessageCounts = function (ids) {
  const out = {};
  if (ids.length === 0) {
    return out;
  }
  let expr = "COALESCE(json_array_length(payload, '$.messages'), 0)";
  if (this.isMySQL()) {
    expr = "COALESCE(JSON_LENGTH(JSON_EXTRACT(payload, '$.messages')), 0)";
  }
  for (let start = 0; start < ids.length; start += 500) {
    const rows = [];
    const err = this.DB.Table("assistant_sessions").Select("id, " + expr + " AS total")
      .Where("id IN ?", ids.slice(start, Math.min(start + 500, ids.length))).Scan(rows).Error;
    if (err != null) {
      console.log(`assistant message count read failed: ${err}`);
      return out;
    }
    for (const row of rows) {
      out[row.ID] = row.Total;
    }
  }
  return out;
};

module.exports = { SidebarRunMeta, sidebarRunInputChars, SidebarIssue };
