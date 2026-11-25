// insights.js —— 对应 Go 文件：internal/domain/insights.go
// 作用：洞察上报的来源凭证、执行记录与用量结构。

"use strict";

// InsightSource：只授权向一个项目摄入的洞察来源凭证。
class InsightSource {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
    this.Name = init.Name ?? "";
    this.UserMappings = init.UserMappings ?? null;
    this.TokenPrefix = init.TokenPrefix ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
    this.ExpiresAt = init.ExpiresAt ?? null;
    this.RevokedAt = init.RevokedAt ?? null;
  }
}

class InsightWorkflow {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
  }
}

// InsightUsage：输入输出为包含口径，缓存与推理计数是子集而非额外计费。
class InsightUsage {
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

class InsightExecution {
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
