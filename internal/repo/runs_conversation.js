// runs_conversation.js —— 对应 Go 文件：internal/repo/runs_conversation.go
// 作用：对话工作区的增量写：用量累加、需求关联与旧副本写保护。

"use strict";

const { Buffer } = require("node:buffer");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause
// Go 的 gorm.Expr 在 JS 里用 clause.Expr。

const { TokenUsage, RunKindWorkspace } = require("../domain/run.js"); // 对应 Go 的 domain.TokenUsage/RunKindWorkspace，run.js 已翻译
const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { jsonBytes } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译

// parsePayloadJSON：把行里的 JSON 载荷解析为普通对象；非对象或解析失败返回 {}。
function parsePayloadJSON(raw) {
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    if (parsed != null && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // Go 忽略解码错误。
  }
  return {};
}

// decodeTokenUsage：Go 的 json.Unmarshal 到 TokenUsage，按 JSON 标签逐字段映射。
function decodeTokenUsage(raw) {
  const parsed = parsePayloadJSON(raw);
  return new TokenUsage({
    InputTokens: parsed.inputTokens ?? parsed.InputTokens ?? 0,
    OutputTokens: parsed.outputTokens ?? parsed.OutputTokens ?? 0,
    CacheReadTokens: parsed.cacheReadTokens ?? parsed.CacheReadTokens ?? 0,
    CacheWriteTokens: parsed.cacheWriteTokens ?? parsed.CacheWriteTokens ?? 0,
    TotalTokens: parsed.totalTokens ?? parsed.TotalTokens ?? 0,
    CostUSD: parsed.costUsd ?? parsed.CostUSD ?? 0,
    ReasoningTokens: parsed.reasoningTokens ?? parsed.ReasoningTokens ?? 0,
    ContextWindow: parsed.contextWindow ?? parsed.ContextWindow ?? 0,
    CostStatus: parsed.costStatus ?? parsed.CostStatus ?? "",
  });
}

// tokenUsageJSON：Go 的 json.Marshal 到 TokenUsage，按 JSON 标签写小写键。
function tokenUsageJSON(total) {
  const out = {
    inputTokens: total.InputTokens, outputTokens: total.OutputTokens,
    cacheReadTokens: total.CacheReadTokens, cacheWriteTokens: total.CacheWriteTokens,
    totalTokens: total.TotalTokens, costUsd: total.CostUSD,
  };
  if (total.ReasoningTokens !== 0) {
    out.reasoningTokens = total.ReasoningTokens;
  }
  if (total.ContextWindow !== 0) {
    out.contextWindow = total.ContextWindow;
  }
  if (total.CostStatus !== "") {
    out.costStatus = total.CostStatus;
  }
  return out;
}

RunsRepo.prototype.updateConversationWorkspaceRun = function (runID, mutate) {
  runID = runID.trim();
  if (runID === "") {
    return [false, null];
  }
  let changed = false;
  const err = this.DB.Transaction((tx) => {
    const row = new runRow();
    const takeErr = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Select("id", "kind", "execution_context", "usage_json").Where("id = ?", runID).Take(row).Error;
    if (takeErr != null) {
      if (takeErr === gorm.ErrRecordNotFound) {
        return null;
      }
      return takeErr;
    }
    if (row.Kind !== RunKindWorkspace) {
      return null;
    }
    const [values, ok] = mutate(row);
    if (!ok) {
      return null;
    }
    values["revision"] = new clause.Expr({ SQL: "revision + 1" });
    values["updated_at"] = new Date();
    changed = true;
    return tx.Model(new runRow()).Where("id = ?", runID).Updates(values).Error;
  });
  return [changed, err];
};

function keepConversationRunFields(run, current) {
  let stored = new TokenUsage();
  let decoded = false;
  if ((current.UsageJSON ?? []).length > 0) {
    try {
      stored = decodeTokenUsage(current.UsageJSON);
      decoded = true;
    } catch {
      // Go 忽略解码错误。
    }
  }
  if (decoded && stored.TotalTokens > run.Usage.TotalTokens) {
    run.Usage = stored;
  }
  if (run.ExecutionContext.IssueID.trim() !== "") {
    return;
  }
  if ((current.ExecutionContext ?? []).length > 0) {
    const parsed = parsePayloadJSON(current.ExecutionContext);
    run.ExecutionContext.IssueID = parsed.issueId ?? parsed.IssueID ?? "";
  }
}

RunsRepo.prototype.AddConversationRunUsage = function (runID, model, usage) {
  if (usage.TotalTokens === 0 && usage.InputTokens === 0 && usage.OutputTokens === 0 && usage.CostUSD === 0) {
    return null;
  }
  const lower = model.trim().toLowerCase();
  usage = AnalyticsPricedUsage(model, usage, lower.startsWith("gpt-"));
  const [, err] = this.updateConversationWorkspaceRun(runID, (row) => {
    let total = new TokenUsage();
    if ((row.UsageJSON ?? []).length > 0) {
      try {
        total = decodeTokenUsage(row.UsageJSON);
      } catch {
        // Go 忽略解码错误。
      }
    }
    const first = total.TotalTokens === 0 && total.InputTokens === 0 && total.OutputTokens === 0 && total.CostUSD === 0;
    total.InputTokens += usage.InputTokens;
    total.OutputTokens += usage.OutputTokens;
    total.CacheReadTokens += usage.CacheReadTokens;
    total.CacheWriteTokens += usage.CacheWriteTokens;
    total.ReasoningTokens += usage.ReasoningTokens;
    total.TotalTokens += usage.TotalTokens;
    total.CostUSD += usage.CostUSD;
    if (first || usage.CostStatus === "unknown" || total.CostStatus === "") {
      total.CostStatus = usage.CostStatus;
    } else if (usage.CostStatus === "estimated" && total.CostStatus === "reported") {
      total.CostStatus = "estimated";
    }
    return [{ usage_json: jsonBytes(tokenUsageJSON(total)) }, true];
  });
  return err;
};

RunsRepo.prototype.LinkConversationRunIssue = function (runID, issueID) {
  issueID = issueID.trim();
  if (issueID === "") {
    return [false, null];
  }
  let linked = false;
  const [, err] = this.updateConversationWorkspaceRun(runID, (row) => {
    const parsed = (row.ExecutionContext ?? []).length > 0 ? parsePayloadJSON(row.ExecutionContext) : {};
    const current = (parsed.issueId ?? parsed.IssueID ?? "").trim();
    linked = current === "" || current === issueID;
    if (current !== "") {
      return [null, false];
    }
    parsed.issueId = issueID;
    return [{ execution_context: jsonBytes(parsed) }, true];
  });
  return [linked, err];
};

module.exports = { keepConversationRunFields };
