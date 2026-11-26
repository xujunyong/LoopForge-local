/**
 * @file internal/repo/runs_conversation.js
 * 对应 Go 源文件：internal/repo/runs_conversation.go
 *
 * 作用与职责边界：
 * 实现对话工作区（`RunKindWorkspace`）运行记录的行锁增量写能力，挂载于 `RunsRepo` 原型上：
 * 在并发对话回合下安全累加模型 token 与成本用量（`AddConversationRunUsage`）、
 * 关联对话工作区所处理的需求 ID（`LinkConversationRunIssue`），以及在整行回写时保护单调增长的用量与既有关联需求不被旧副本覆盖（`keepConversationRunFields`）。
 * 仅作用于对话工作区运行，对其他类型运行不做任何修改。
 *
 * 语法差异说明：
 * - `RunsRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `RunsRepo.prototype` 挂载对话工作区增量写方法。
 * - Go 的 `(bool, error)` 与仅 `error` 返回统一按成功返回布尔值（或 `undefined`）、失败 `throw err` 处理；`db.Transaction(tx => ...)` 回调同样失败抛错、成功正常返回。
 * - Go 的 `gorm.Expr("revision + 1")` 在 JS 中通过 `new clause.Expr({ SQL: "revision + 1" })` 表达。
 * - Go 的 `json.Unmarshal`/`json.Marshal` 按 `TokenUsage` 的 JSON 小写标签映射，本文件保留显式编解码辅助函数以维持键名一致。
 */

"use strict";

const { Buffer } = require("node:buffer");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { TokenUsage, RunKindWorkspace } = require("../domain/run.js"); // 对应 Go 的 domain.TokenUsage/RunKindWorkspace，run.js 已翻译
const { AnalyticsPricedUsage } = require("../domain/token_pricing.js"); // 对应 Go 的 domain.AnalyticsPricedUsage，token_pricing.js 已翻译
const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { runRow } = require("./models.js"); // 对应 Go 同包类型，models.js 已翻译
const { jsonBytes } = require("./payload.js"); // 对应 Go 同包函数，payload.js 已翻译

/**
 * 将数据库行中的 JSON 载荷安全解析为普通对象；若内容为空、非对象或解析失败则返回 `null`。
 *
 * @param {Buffer | string | null} raw - 原始 JSON 字节缓冲区或字符串。
 * @returns {Object.<string, *> | null} 解析得到的普通对象，解析失败时返回 `null`。
 */
function parsePayloadJSON(raw) {
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    if (parsed != null && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // Go 忽略解码错误。
  }
  return null;
}

/**
 * 将 `usage_json` 列按 Go `TokenUsage` 的 JSON 标签反序列化为领域对象实例。
 *
 * @param {Buffer | string} raw - 原始 `usage_json` 字节缓冲区或字符串。
 * @returns {[TokenUsage, boolean]} 二元组 `[解码后的 TokenUsage, 是否解析成功]`。
 */
function decodeTokenUsage(raw) {
  const parsed = parsePayloadJSON(raw);
  if (parsed == null) {
    return [new TokenUsage(), false];
  }
  return [new TokenUsage({
    InputTokens: parsed.inputTokens ?? parsed.InputTokens ?? 0,
    OutputTokens: parsed.outputTokens ?? parsed.OutputTokens ?? 0,
    CacheReadTokens: parsed.cacheReadTokens ?? parsed.CacheReadTokens ?? 0,
    CacheWriteTokens: parsed.cacheWriteTokens ?? parsed.CacheWriteTokens ?? 0,
    TotalTokens: parsed.totalTokens ?? parsed.TotalTokens ?? 0,
    CostUSD: parsed.costUsd ?? parsed.CostUSD ?? 0,
    ReasoningTokens: parsed.reasoningTokens ?? parsed.ReasoningTokens ?? 0,
    ContextWindow: parsed.contextWindow ?? parsed.ContextWindow ?? 0,
    CostStatus: parsed.costStatus ?? parsed.CostStatus ?? "",
  }), true];
}

/**
 * 将 `TokenUsage` 领域对象按 Go JSON 标签与 `omitempty` 语义转为待序列化的纯对象。
 *
 * @param {TokenUsage} total - 待序列化的累计用量对象。
 * @returns {Object.<string, *>} 带小写驼峰键名的 JSON 对象。
 */
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

/**
 * 在行级写锁（`FOR UPDATE`）事务内仅重写对话工作区运行的指定 JSON 列并递增 `revision`，
 * 避免并发对话回合相互覆盖增量写入。若记录不存在、非对话工作区或回调返回不更新，则不做修改。
 *
 * @param {string} runID - 运行主键 ID。
 * @param {function(runRow): [Object.<string, *> | null, boolean]} mutate - 基于锁定行计算待更新列映射的回调，返回 `[更新列映射, 是否需要写回]`。
 * @returns {boolean} 实际执行了更新返回 `true`，否则返回 `false`。
 * @throws {Error} 事务内加锁查询（非 `ErrRecordNotFound`）或数据库更新失败时抛出错误。
 */
RunsRepo.prototype.updateConversationWorkspaceRun = function (runID, mutate) {
  runID = runID.trim();
  if (runID === "") {
    return false;
  }
  let changed = false;
  this.DB.Transaction((tx) => {
    const row = new runRow();
    const takeErr = tx.Clauses(new clause.Locking({ Strength: "UPDATE" })).Select("id", "kind", "execution_context", "usage_json").Where("id = ?", runID).Take(row).Error;
    if (takeErr != null) {
      if (takeErr === gorm.ErrRecordNotFound) {
        return;
      }
      throw takeErr;
    }
    if (row.Kind !== RunKindWorkspace) {
      return;
    }
    const [values, ok] = mutate(row);
    if (!ok) {
      return;
    }
    values["revision"] = new clause.Expr({ SQL: "revision + 1" });
    values["updated_at"] = new Date();
    changed = true;
    const updateErr = tx.Model(new runRow()).Where("id = ?", runID).Updates(values).Error;
    if (updateErr != null) {
      throw updateErr;
    }
  });
  return changed;
};

/**
 * 在对对话工作区执行整行回写前，保护已持久化的累计用量与已关联需求不被旧内存副本倒退覆盖。
 * 对话用量只增不减，已关联的需求 ID 不会被空值清空；供同包 `runs.js` 写路径调用。
 *
 * @param {import("../domain/run.js").Run} run - 即将写入的运行领域对象（会被就地补齐更高用量与已关联需求 ID）。
 * @param {runRow} current - 数据库中当前已存储的运行行记录。
 * @returns {void} 无返回值。
 */
function keepConversationRunFields(run, current) {
  if ((current.UsageJSON ?? []).length > 0) {
    const [stored, decoded] = decodeTokenUsage(current.UsageJSON);
    if (decoded && stored.TotalTokens > run.Usage.TotalTokens) {
      run.Usage = stored;
    }
  }
  if (run.ExecutionContext.IssueID.trim() !== "") {
    return;
  }
  if ((current.ExecutionContext ?? []).length > 0) {
    const parsed = parsePayloadJSON(current.ExecutionContext);
    if (parsed != null) {
      run.ExecutionContext.IssueID = parsed.issueId ?? parsed.IssueID ?? "";
    }
  }
}

/**
 * 将单次对话回合的模型用量按对应模型公开价目表计价后，原子累加到目标对话工作区运行中，
 * 使运营分析能够将对话消耗的 token 与费用归因到该工作区的项目、用户与需求。
 *
 * @param {string} runID - 对话工作区运行 ID。
 * @param {string} model - 本回合使用的模型标识（以 `gpt-` 开头时按含缓存输入计价）。
 * @param {TokenUsage} usage - 本回合产生的 token 与费用增量。
 * @returns {void} 无返回值。
 * @throws {Error} 事务更新对话工作区用量失败时抛出错误。
 */
RunsRepo.prototype.AddConversationRunUsage = function (runID, model, usage) {
  if (usage.TotalTokens === 0 && usage.InputTokens === 0 && usage.OutputTokens === 0 && usage.CostUSD === 0) {
    return;
  }
  const lower = model.trim().toLowerCase();
  usage = AnalyticsPricedUsage(model, usage, lower.startsWith("gpt-"));
  this.updateConversationWorkspaceRun(runID, (row) => {
    let total = new TokenUsage();
    if ((row.UsageJSON ?? []).length > 0) {
      const [decoded, ok] = decodeTokenUsage(row.UsageJSON);
      if (ok) {
        total = decoded;
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
    // 累计成本状态以精度最低的回合为准（unknown > estimated > reported）。
    if (first || usage.CostStatus === "unknown" || total.CostStatus === "") {
      total.CostStatus = usage.CostStatus;
    } else if (usage.CostStatus === "estimated" && total.CostStatus === "reported") {
      total.CostStatus = "estimated";
    }
    return [{ usage_json: jsonBytes(tokenUsageJSON(total)) }, true];
  });
};

/**
 * 为对话工作区运行记录关联的需求 ID；若该工作区已关联到其他需求，则保持原关联不变。
 *
 * @param {string} runID - 对话工作区运行 ID。
 * @param {string} issueID - 目标需求主键 ID。
 * @returns {boolean} 关联完成后该工作区归属 `issueID`（首次绑定或原本即一致）返回 `true`，否则返回 `false`。
 * @throws {Error} 事务更新执行上下文失败时抛出错误。
 */
RunsRepo.prototype.LinkConversationRunIssue = function (runID, issueID) {
  issueID = issueID.trim();
  if (issueID === "") {
    return false;
  }
  let linked = false;
  this.updateConversationWorkspaceRun(runID, (row) => {
    const parsed = ((row.ExecutionContext ?? []).length > 0 ? parsePayloadJSON(row.ExecutionContext) : null) ?? {};
    const current = (parsed.issueId ?? parsed.IssueID ?? "").trim();
    linked = current === "" || current === issueID;
    if (current !== "") {
      return [null, false];
    }
    parsed.issueId = issueID;
    return [{ execution_context: jsonBytes(parsed) }, true];
  });
  return linked;
};

module.exports = { keepConversationRunFields };
