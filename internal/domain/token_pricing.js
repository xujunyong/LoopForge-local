/**
 * @file internal/domain/token_pricing.js
 * @description 对应 Go 文件：internal/domain/token_pricing.go
 * 职责与边界：维护公开标准模型每百万 token 单价表与美元/人民币汇率常量，
 * 提供模型名称归一化、免费混元模型判定，以及不改写原始计费事实的用量成本估算函数。
 * 语法差异说明：
 * - Go 的 `regexp.ReplaceAllString` 对应带全局标志 `/g` 的正则替换，以保证与 Go 全量替换语义一致。
 * - 导出未导出函数 `pricingModel` 供同包 `schedule_execution.js` 引用。
 */

"use strict";

const AnalyticsUSDToCNY = 7.0;
const AnalyticsPricingVersion = "public-standard-2026-11-05";

/**
 * 描述单个模型的公开标准短上下文单价（每百万 token），保留原生计价币种（USD 或 CNY）。
 */
class TokenPrice {
  /**
   * 构造模型单价实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Currency = init.Currency ?? "";
    this.Input = init.Input ?? 0;
    this.Output = init.Output ?? 0;
    this.CacheRead = init.CacheRead ?? 0;
    this.CacheWrite = init.CacheWrite ?? 0;
  }
}

const publicTokenPrices = {
  "gpt-5.5": new TokenPrice({ Currency: "USD", Input: 5, Output: 30, CacheRead: 0.5, CacheWrite: 5 }),
  "claude-haiku-5-5": new TokenPrice({ Currency: "USD", Input: 0.1, Output: 0.5, CacheRead: 0.01, CacheWrite: 0.125 }),
  "gpt-6-astra": new TokenPrice({ Currency: "USD", Input: 10, Output: 50, CacheRead: 1, CacheWrite: 12.5 }),
  "gpt-6.1-sol": new TokenPrice({ Currency: "USD", Input: 2, Output: 10, CacheRead: 0.1, CacheWrite: 2.5 }),
  "gpt-6.1-terra": new TokenPrice({ Currency: "USD", Input: 1, Output: 5, CacheRead: 0.05, CacheWrite: 1.25 }),
  "gpt-6-sol": new TokenPrice({ Currency: "USD", Input: 2, Output: 10, CacheRead: 0.2, CacheWrite: 2.5 }),
  "gpt-6-luna": new TokenPrice({ Currency: "USD", Input: 0.1, Output: 0.5, CacheRead: 0.01, CacheWrite: 0.125 }),
  "gpt-5.6-sol": new TokenPrice({ Currency: "USD", Input: 4, Output: 20, CacheRead: 0.4, CacheWrite: 5 }),
  "gpt-5.6-terra": new TokenPrice({ Currency: "USD", Input: 2, Output: 12, CacheRead: 0.2, CacheWrite: 2.5 }),
  "gpt-5.6-luna": new TokenPrice({ Currency: "USD", Input: 0.2, Output: 1.2, CacheRead: 0.02, CacheWrite: 0.25 }),
  "gpt-5.4": new TokenPrice({ Currency: "USD", Input: 2.5, Output: 15, CacheRead: 0.25, CacheWrite: 2.5 }),
  "gpt-5.3-codex": new TokenPrice({ Currency: "USD", Input: 1.75, Output: 14, CacheRead: 0.175, CacheWrite: 1.75 }),
  "gpt-5.2": new TokenPrice({ Currency: "USD", Input: 1.75, Output: 14, CacheRead: 0.175, CacheWrite: 1.75 }),
  "claude-fable-5-1": new TokenPrice({ Currency: "USD", Input: 10, Output: 50, CacheRead: 0.25, CacheWrite: 12.5 }),
  "claude-fable-5": new TokenPrice({ Currency: "USD", Input: 10, Output: 50, CacheRead: 1, CacheWrite: 12.5 }),
  "claude-opus-5-5": new TokenPrice({ Currency: "USD", Input: 4, Output: 20, CacheRead: 0.2, CacheWrite: 5 }),
  "claude-opus-5": new TokenPrice({ Currency: "USD", Input: 5, Output: 25, CacheRead: 0.5, CacheWrite: 6.25 }),
  "claude-opus-4-8": new TokenPrice({ Currency: "USD", Input: 5, Output: 25, CacheRead: 0.5, CacheWrite: 6.25 }),
  "claude-opus-4-7": new TokenPrice({ Currency: "USD", Input: 5, Output: 25, CacheRead: 0.5, CacheWrite: 6.25 }),
  "claude-opus-4-6": new TokenPrice({ Currency: "USD", Input: 5, Output: 25, CacheRead: 0.5, CacheWrite: 6.25 }),
  "claude-opus-4-5": new TokenPrice({ Currency: "USD", Input: 5, Output: 25, CacheRead: 0.5, CacheWrite: 6.25 }),
  "claude-opus-4-1": new TokenPrice({ Currency: "USD", Input: 15, Output: 75, CacheRead: 1.5, CacheWrite: 18.75 }),
  "claude-opus-4": new TokenPrice({ Currency: "USD", Input: 15, Output: 75, CacheRead: 1.5, CacheWrite: 18.75 }),
  "claude-sonnet-5-5": new TokenPrice({ Currency: "USD", Input: 2, Output: 10, CacheRead: 0.1, CacheWrite: 2.5 }),
  "claude-sonnet-5": new TokenPrice({ Currency: "USD", Input: 2, Output: 10, CacheRead: 0.2, CacheWrite: 2.5 }),
  "claude-sonnet-4-6": new TokenPrice({ Currency: "USD", Input: 3, Output: 15, CacheRead: 0.3, CacheWrite: 3.75 }),
  "claude-sonnet-4-5": new TokenPrice({ Currency: "USD", Input: 3, Output: 15, CacheRead: 0.3, CacheWrite: 3.75 }),
  "claude-sonnet-4": new TokenPrice({ Currency: "USD", Input: 3, Output: 15, CacheRead: 0.3, CacheWrite: 3.75 }),
  "claude-haiku-4-5": new TokenPrice({ Currency: "USD", Input: 1, Output: 5, CacheRead: 0.1, CacheWrite: 1.25 }),
  "claude-haiku-3-5": new TokenPrice({ Currency: "USD", Input: 0.8, Output: 4, CacheRead: 0.08, CacheWrite: 1 }),
  "deepseek-flash": new TokenPrice({ Currency: "CNY", Input: 2, Output: 8, CacheRead: 0.04, CacheWrite: 2 }),
  "deepseek-v4-pro": new TokenPrice({ Currency: "CNY", Input: 9, Output: 27, CacheRead: 0.3, CacheWrite: 9 }),
  "glm-5.3": new TokenPrice({ Currency: "CNY", Input: 8, Output: 28, CacheRead: 2, CacheWrite: 8 }),
  "glm-5.2": new TokenPrice({ Currency: "CNY", Input: 8, Output: 28, CacheRead: 2, CacheWrite: 8 }),
  "glm-5.3-flash": new TokenPrice({ Currency: "CNY", Input: 0.8, Output: 2.8, CacheRead: 0.23, CacheWrite: 0.8 }),
  "glm-5.3-flashx": new TokenPrice({ Currency: "CNY", Input: 2, Output: 7, CacheRead: 0.57, CacheWrite: 2 }),
  "glm-5v-turbo": new TokenPrice({ Currency: "CNY", Input: 5, Output: 22, CacheRead: 1.2, CacheWrite: 5 }),
  "kimi-k3.1-pro": new TokenPrice({ Currency: "CNY", Input: 13, Output: 68, CacheRead: 1.3, CacheWrite: 13 }),
  "kimi-k3": new TokenPrice({ Currency: "CNY", Input: 20, Output: 100, CacheRead: 2, CacheWrite: 20 }),
  "kimi-k2.8-preview": new TokenPrice({ Currency: "CNY", Input: 6.5, Output: 27, CacheRead: 1.7, CacheWrite: 6.5 }),
  "kimi-k2.7-code": new TokenPrice({ Currency: "CNY", Input: 6.5, Output: 27, CacheRead: 1.3, CacheWrite: 6.5 }),
  "kimi-k2.6": new TokenPrice({ Currency: "CNY", Input: 6.5, Output: 27, CacheRead: 1.1, CacheWrite: 6.5 }),
  "minimax-m3": new TokenPrice({ Currency: "CNY", Input: 2.1, Output: 8.4, CacheRead: 0.42, CacheWrite: 2.1 }),
  "minimax-m2.7": new TokenPrice({ Currency: "CNY", Input: 2.1, Output: 8.4, CacheRead: 0.42, CacheWrite: 2.1 }),
  "minimax-m3.1-flash": new TokenPrice({ Currency: "CNY", Input: 1, Output: 4, CacheRead: 0.1, CacheWrite: 1 }),
  "mimo-v2.6-pro": new TokenPrice({ Currency: "CNY", Input: 3, Output: 6, CacheRead: 0.025, CacheWrite: 3 }),
  "qwen3-coder-plus": new TokenPrice({ Currency: "CNY", Input: 4, Output: 16, CacheRead: 0.4, CacheWrite: 5 }),
  "qwen3-coder-flash": new TokenPrice({ Currency: "CNY", Input: 1, Output: 4, CacheRead: 0.1, CacheWrite: 1.25 }),
  "qwen3.8-max": new TokenPrice({ Currency: "CNY", Input: 12, Output: 36, CacheRead: 1.2, CacheWrite: 15 }),
  "gemini-3.1-pro-preview": new TokenPrice({ Currency: "USD", Input: 2, Output: 12, CacheRead: 0.2, CacheWrite: 2 }),
  "gemini-4-argon": new TokenPrice({ Currency: "USD", Input: 2, Output: 10, CacheRead: 0.1, CacheWrite: 2 }),
};

const pricingSnapshotSuffix = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
const claudeVersionDots = /(claude-(?:opus|sonnet|haiku|fable)-\d+)\.(\d+)/g;
const hyVersionedModel = /^hy\d/;

/**
 * 将原始模型标识规范化为价目表查询键（剥离自定义前缀、内网/长上下文后缀、快照日期，并统一别名与版本号分隔符）。
 * 供 `AnalyticsPricedUsage` 及同包 `schedule_execution.js` 调用。
 * @param {string} model - 原始模型名称字符串。
 * @returns {string} 规范化后的价目表模型键名。
 */
function pricingModel(model) {
  model = model.toLowerCase().trim();
  model = model.startsWith("custom-local:") ? model.slice("custom-local:".length) : model;
  if (model.endsWith("-internal-ioa")) {
    model = model.slice(0, model.length - "-internal-ioa".length);
  }
  if (model.endsWith("-ioa")) {
    model = model.slice(0, model.length - "-ioa".length);
  }
  if (model.endsWith("-1m")) {
    model = model.slice(0, model.length - "-1m".length);
  }
  model = model.replace(claudeVersionDots, "$1-$2");
  model = model.replace(pricingSnapshotSuffix, "");
  switch (model) {
    case "deepseek-v4-flash":
    case "deepseek-v4-flash-vision-exp":
    case "deepseek-v4.1-flash":
    case "deepseek-v4.1-flash-1017":
      return "deepseek-flash";
    case "kimi-k2.7":
      return "kimi-k2.7-code";
    case "gemini-3.1-pro":
      return "gemini-3.1-pro-preview";
    default:
      return model;
  }
}

/**
 * 判断模型标识是否属于平台免费计价的混元（Hy / Hunyuan）系列模型。
 * 在成本估算及费用分析过滤中调用。
 * @param {string} model - 模型名称字符串。
 * @returns {boolean} 属于混元系列模型时返回 `true`，否则返回 `false`。
 */
function IsHYModel(model) {
  model = model.toLowerCase().trim();
  return model === "hy" || model.startsWith("hy-") || model.startsWith("hy.") || hyVersionedModel.test(model) || model.startsWith("hunyuan");
}

/**
 * 按公开价目表对单次调用的 `TokenUsage` 估算折算美元成本并返回新副本，不修改原始计费记录。
 * 人民币单价模型会按 `AnalyticsUSDToCNY` 折算为美元等价写入 `CostUSD` 以保持统计接口兼容。
 * @param {string} model - 调用使用的模型标识。
 * @param {Object} usage - 原始 `TokenUsage` 对象。
 * @param {boolean} inclusiveInput - `usage.InputTokens` 是否已包含缓存读写 token（Codex/外部 API 为 `true`，Anthropic 为 `false`）。
 * @returns {Object} 带有估算结果 `CostUSD` 与 `CostStatus`（`"estimated"` 或 `"unknown"`）的新对象。
 */
function AnalyticsPricedUsage(model, usage, inclusiveInput) {
  const out = { ...usage };
  out.CostUSD = 0;
  out.CostStatus = "unknown";
  if (IsHYModel(model)) {
    out.CostUSD = 0;
    out.CostStatus = "estimated";
    return out;
  }
  if (usage.InputTokens < 0 || usage.OutputTokens < 0 || usage.CacheReadTokens < 0 || usage.CacheWriteTokens < 0 || usage.ReasoningTokens < 0) {
    return out;
  }
  if (usage.InputTokens + usage.OutputTokens + usage.CacheReadTokens + usage.CacheWriteTokens === 0) {
    if (usage.TotalTokens === 0 && usage.ReasoningTokens === 0 && usage.CostUSD === 0) {
      out.CostStatus = "estimated";
    }
    return out;
  }
  const price = publicTokenPrices[pricingModel(model)];
  if (price === undefined) {
    return out;
  }
  let input = usage.InputTokens;
  if (inclusiveInput) {
    input -= usage.CacheReadTokens + usage.CacheWriteTokens;
    if (input < 0) {
      return out;
    }
  }
  let cost = (input * price.Input + usage.OutputTokens * price.Output + usage.CacheReadTokens * price.CacheRead + usage.CacheWriteTokens * price.CacheWrite) / 1e6;
  if (price.Currency === "CNY") {
    cost /= AnalyticsUSDToCNY;
  }
  out.CostUSD = cost;
  out.CostStatus = "estimated";
  return out;
}

module.exports = { AnalyticsUSDToCNY, AnalyticsPricingVersion, TokenPrice, IsHYModel, AnalyticsPricedUsage, pricingModel };
