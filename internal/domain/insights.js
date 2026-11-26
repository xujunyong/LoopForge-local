/**
 * 对应 Go 文件：internal/domain/insights.go
 * 作用：定义外部洞察数据上报所需的来源凭证、工作流摘要、模型用量与执行记录数据结构。
 * 职责边界：仅负责洞察上报领域的数据模型定义，不处理凭证校验、鉴权或存储逻辑。
 * 语法差异说明：Go 的 time.Time 与指针字段零值均为 null，map[string]int64 零值为 {}，切片零值为 []。
 */

"use strict";

/**
 * 洞察上报来源凭证，仅授权向单个项目写入洞察执行数据。
 * 用户映射表由项目维护者配置，绝不由上报客户端自行指定。
 */
class InsightSource {
  /**
   * 构造洞察来源凭证对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<InsightSource>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Name = init.Name ?? "";
    this.UserMappings = init.UserMappings ?? {};
    this.TokenPrefix = init.TokenPrefix ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
    this.ExpiresAt = init.ExpiresAt ?? null;
    this.RevokedAt = init.RevokedAt ?? null;
  }
}

/**
 * 洞察执行记录所关联的工作流标识与名称。
 */
class InsightWorkflow {
  /**
   * 构造洞察工作流摘要对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<InsightWorkflow>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
  }
}

/**
 * 洞察执行中的单条模型调用 Token 与费用统计。
 * 输入与输出 Token 为包含口径，缓存与推理计数属于子集而非额外计费 Token；未知费用用 null 表示。
 */
class InsightUsage {
  /**
   * 构造模型用量统计对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<InsightUsage>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Provider = init.Provider ?? "";
    this.Model = init.Model ?? "";
    this.InputTokens = init.InputTokens ?? 0;
    this.OutputTokens = init.OutputTokens ?? 0;
    this.CacheReadTokens = init.CacheReadTokens ?? 0;
    this.CacheWriteTokens = init.CacheWriteTokens ?? 0;
    this.ReasoningTokens = init.ReasoningTokens ?? 0;
    this.CostUSD = init.CostUSD ?? null;
    this.CostStatus = init.CostStatus ?? "";
  }
}

/**
 * 单次外部或平台洞察执行记录，包含工作流信息、起止时间、活跃执行耗时与用量明细。
 * ExecutionDurationMs 为可选的活跃节点耗时总和，不可直接用墙钟时长替代。
 */
class InsightExecution {
  /**
   * 构造洞察执行记录对象，未提供字段严格按 Go 零值初始化。
   *
   * @param {Partial<InsightExecution>} [init={}] - 初始化字段对象。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Type = init.Type ?? "";
    this.ExternalExecutionID = init.ExternalExecutionID ?? "";
    this.Workflow = init.Workflow ?? new InsightWorkflow();
    this.ExternalUserID = init.ExternalUserID ?? "";
    this.URL = init.URL ?? "";
    this.StartedAt = init.StartedAt ?? null;
    this.FinishedAt = init.FinishedAt ?? null;
    this.ExecutionDurationMs = init.ExecutionDurationMs ?? null;
    this.Status = init.Status ?? "";
    this.Usage = init.Usage ?? [];
  }
}

module.exports = { InsightSource, InsightWorkflow, InsightUsage, InsightExecution };
