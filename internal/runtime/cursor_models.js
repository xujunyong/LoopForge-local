// cursor_models.js —— 对应 Go 文件：internal/runtime/cursor_models.go
// 作用：cursor-agent 的模型族表：按思考强度把族 ID 解析成具体模型 ID，或把 CLI 列出的强度 ID 折叠回族。
// (值, bool) 译为 [值, bool]；slices.Clone 译为数组展开复制，slices.Index 译为 indexOf；
// Go 的 map[string]string 译为普通对象，nil 切片译为 null。

"use strict";

const { ExecutorEffortLevels } = require("../domain/agent.js"); // 对应 Go 的 domain.ExecutorEffortLevels，agent.js 已翻译
const domain = require("../domain/user.js"); // 对应 Go 的 domain，user.js 已翻译
const { AgentCLICursor } = require("./agent_cli.js"); // 对应 Go 同包常量，agent_cli.js 已翻译

class CursorModel {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Name = init.Name ?? "";
    this.Default = init.Default ?? "";
    this.Variants = init.Variants ?? {};
  }
}

const cursorModels = [
  { ID: "auto", Name: "Auto", Default: "", Variants: { "": "auto" } },
  { ID: "composer-2.5", Name: "Composer 2.5", Default: "", Variants: { "": "composer-2.5" } },
  { ID: "composer-2.5-fast", Name: "Composer 2.5 Fast", Default: "", Variants: { "": "composer-2.5-fast" } },
  { ID: "grok-4.7", Name: "Grok 4.7", Default: "medium", Variants: { low: "grok-4.7-low", medium: "grok-4.7-medium", high: "grok-4.7-high", xhigh: "grok-4.7-xhigh" } },
  { ID: "grok-4.7-fast", Name: "Grok 4.7 Fast", Default: "medium", Variants: { low: "grok-4.7-low-fast", medium: "grok-4.7-medium-fast", high: "grok-4.7-high-fast", xhigh: "grok-4.7-xhigh-fast" } },
  { ID: "cursor-grok-4.6", Name: "Grok 4.6", Default: "high", Variants: { low: "cursor-grok-4.6-low", medium: "cursor-grok-4.6-medium", high: "cursor-grok-4.6-high", xhigh: "cursor-grok-4.6-xhigh" } },
  { ID: "cursor-grok-4.6-fast", Name: "Grok 4.6 Fast", Default: "high", Variants: { low: "cursor-grok-4.6-low-fast", medium: "cursor-grok-4.6-medium-fast", high: "cursor-grok-4.6-high-fast", xhigh: "cursor-grok-4.6-xhigh-fast" } },
  { ID: "cursor-grok-4.5", Name: "Grok 4.5", Default: "high", Variants: { low: "cursor-grok-4.5-low", medium: "cursor-grok-4.5-medium", high: "cursor-grok-4.5-high" } },
  { ID: "cursor-grok-4.5-fast", Name: "Grok 4.5 Fast", Default: "high", Variants: { low: "cursor-grok-4.5-low-fast", medium: "cursor-grok-4.5-medium-fast", high: "cursor-grok-4.5-high-fast" } },
  { ID: "claude-fable-5-1", Name: "Claude Fable 5.1 (NO ZDR)", Default: "high", Variants: { low: "claude-fable-5-1-low", medium: "claude-fable-5-1-medium", high: "claude-fable-5-1-high", xhigh: "claude-fable-5-1-xhigh", max: "claude-fable-5-1-max" } },
  { ID: "claude-fable-5-1-thinking", Name: "Claude Fable 5.1 Thinking (NO ZDR)", Default: "high", Variants: { low: "claude-fable-5-1-thinking-low", medium: "claude-fable-5-1-thinking-medium", high: "claude-fable-5-1-thinking-high", xhigh: "claude-fable-5-1-thinking-xhigh", max: "claude-fable-5-1-thinking-max" } },
  { ID: "claude-fable-5", Name: "Claude Fable 5 (NO ZDR)", Default: "high", Variants: { low: "claude-fable-5-low", medium: "claude-fable-5-medium", high: "claude-fable-5-high", xhigh: "claude-fable-5-xhigh", max: "claude-fable-5-max" } },
  { ID: "claude-fable-5-thinking", Name: "Claude Fable 5 Thinking (NO ZDR)", Default: "high", Variants: { low: "claude-fable-5-thinking-low", medium: "claude-fable-5-thinking-medium", high: "claude-fable-5-thinking-high", xhigh: "claude-fable-5-thinking-xhigh", max: "claude-fable-5-thinking-max" } },
  { ID: "claude-opus-5-5", Name: "Claude Opus 5.5", Default: "medium", Variants: { low: "claude-opus-5-5-low", medium: "claude-opus-5-5-medium", high: "claude-opus-5-5-high", xhigh: "claude-opus-5-5-xhigh", max: "claude-opus-5-5-max" } },
  { ID: "claude-opus-5-5-fast", Name: "Claude Opus 5.5 Fast", Default: "medium", Variants: { low: "claude-opus-5-5-low-fast", medium: "claude-opus-5-5-medium-fast", high: "claude-opus-5-5-high-fast", xhigh: "claude-opus-5-5-xhigh-fast", max: "claude-opus-5-5-max-fast" } },
  { ID: "claude-opus-5", Name: "Claude Opus 5", Default: "high", Variants: { low: "claude-opus-5-low", medium: "claude-opus-5-medium", high: "claude-opus-5-high" } },
  { ID: "claude-opus-5-thinking", Name: "Claude Opus 5 Thinking", Default: "high", Variants: { low: "claude-opus-5-thinking-low", medium: "claude-opus-5-thinking-medium", high: "claude-opus-5-thinking-high", xhigh: "claude-opus-5-thinking-xhigh", max: "claude-opus-5-thinking-max" } },
  { ID: "claude-opus-5-fast", Name: "Claude Opus 5 Fast", Default: "high", Variants: { low: "claude-opus-5-low-fast", medium: "claude-opus-5-medium-fast", high: "claude-opus-5-high-fast" } },
  { ID: "claude-opus-5-thinking-fast", Name: "Claude Opus 5 Thinking Fast", Default: "high", Variants: { low: "claude-opus-5-thinking-low-fast", medium: "claude-opus-5-thinking-medium-fast", high: "claude-opus-5-thinking-high-fast", xhigh: "claude-opus-5-thinking-xhigh-fast", max: "claude-opus-5-thinking-max-fast" } },
  { ID: "claude-opus-4-8", Name: "Claude Opus 4.8", Default: "high", Variants: { low: "claude-opus-4-8-low", medium: "claude-opus-4-8-medium", high: "claude-opus-4-8-high", xhigh: "claude-opus-4-8-xhigh", max: "claude-opus-4-8-max" } },
  { ID: "claude-opus-4-8-thinking", Name: "Claude Opus 4.8 Thinking", Default: "high", Variants: { low: "claude-opus-4-8-thinking-low", medium: "claude-opus-4-8-thinking-medium", high: "claude-opus-4-8-thinking-high", xhigh: "claude-opus-4-8-thinking-xhigh", max: "claude-opus-4-8-thinking-max" } },
  { ID: "claude-opus-4-8-fast", Name: "Claude Opus 4.8 Fast", Default: "high", Variants: { low: "claude-opus-4-8-low-fast", medium: "claude-opus-4-8-medium-fast", high: "claude-opus-4-8-high-fast", xhigh: "claude-opus-4-8-xhigh-fast", max: "claude-opus-4-8-max-fast" } },
  { ID: "claude-opus-4-8-thinking-fast", Name: "Claude Opus 4.8 Thinking Fast", Default: "high", Variants: { low: "claude-opus-4-8-thinking-low-fast", medium: "claude-opus-4-8-thinking-medium-fast", high: "claude-opus-4-8-thinking-high-fast", xhigh: "claude-opus-4-8-thinking-xhigh-fast", max: "claude-opus-4-8-thinking-max-fast" } },
  { ID: "claude-opus-4-7", Name: "Claude Opus 4.7", Default: "xhigh", Variants: { low: "claude-opus-4-7-low", medium: "claude-opus-4-7-medium", high: "claude-opus-4-7-high", xhigh: "claude-opus-4-7-xhigh", max: "claude-opus-4-7-max" } },
  { ID: "claude-opus-4-7-thinking", Name: "Claude Opus 4.7 Thinking", Default: "xhigh", Variants: { low: "claude-opus-4-7-thinking-low", medium: "claude-opus-4-7-thinking-medium", high: "claude-opus-4-7-thinking-high", xhigh: "claude-opus-4-7-thinking-xhigh", max: "claude-opus-4-7-thinking-max" } },
  { ID: "claude-opus-4-7-fast", Name: "Claude Opus 4.7 Fast", Default: "xhigh", Variants: { low: "claude-opus-4-7-low-fast", medium: "claude-opus-4-7-medium-fast", high: "claude-opus-4-7-high-fast", xhigh: "claude-opus-4-7-xhigh-fast", max: "claude-opus-4-7-max-fast" } },
  { ID: "claude-opus-4-7-thinking-fast", Name: "Claude Opus 4.7 Thinking Fast", Default: "xhigh", Variants: { low: "claude-opus-4-7-thinking-low-fast", medium: "claude-opus-4-7-thinking-medium-fast", high: "claude-opus-4-7-thinking-high-fast", xhigh: "claude-opus-4-7-thinking-xhigh-fast", max: "claude-opus-4-7-thinking-max-fast" } },
  { ID: "claude-4.6-opus", Name: "Claude Opus 4.6", Default: "high", Variants: { high: "claude-4.6-opus-high", max: "claude-4.6-opus-max" } },
  { ID: "claude-4.6-opus-thinking", Name: "Claude Opus 4.6 Thinking", Default: "high", Variants: { high: "claude-4.6-opus-high-thinking", max: "claude-4.6-opus-max-thinking" } },
  { ID: "claude-4.5-opus", Name: "Claude Opus 4.5", Default: "high", Variants: { high: "claude-4.5-opus-high" } },
  { ID: "claude-4.5-opus-thinking", Name: "Claude Opus 4.5 Thinking", Default: "high", Variants: { high: "claude-4.5-opus-high-thinking" } },
  { ID: "claude-sonnet-5-5", Name: "Claude Sonnet 5.5", Default: "medium", Variants: { low: "claude-sonnet-5-5-low", medium: "claude-sonnet-5-5-medium", high: "claude-sonnet-5-5-high", xhigh: "claude-sonnet-5-5-xhigh", max: "claude-sonnet-5-5-max" } },
  { ID: "claude-sonnet-5", Name: "Claude Sonnet 5", Default: "high", Variants: { low: "claude-sonnet-5-low", medium: "claude-sonnet-5-medium", high: "claude-sonnet-5-high", xhigh: "claude-sonnet-5-xhigh", max: "claude-sonnet-5-max" } },
  { ID: "claude-sonnet-5-thinking", Name: "Claude Sonnet 5 Thinking", Default: "high", Variants: { low: "claude-sonnet-5-thinking-low", medium: "claude-sonnet-5-thinking-medium", high: "claude-sonnet-5-thinking-high", xhigh: "claude-sonnet-5-thinking-xhigh", max: "claude-sonnet-5-thinking-max" } },
  { ID: "claude-4.6-sonnet", Name: "Claude Sonnet 4.6", Default: "medium", Variants: { medium: "claude-4.6-sonnet-medium" } },
  { ID: "claude-4.6-sonnet-thinking", Name: "Claude Sonnet 4.6 Thinking", Default: "medium", Variants: { medium: "claude-4.6-sonnet-medium-thinking" } },
  { ID: "claude-4.5-sonnet", Name: "Claude Sonnet 4.5", Default: "", Variants: { "": "claude-4.5-sonnet" } },
  { ID: "claude-4.5-sonnet-thinking", Name: "Claude Sonnet 4.5 Thinking", Default: "", Variants: { "": "claude-4.5-sonnet-thinking" } },
  { ID: "claude-4-sonnet", Name: "Claude Sonnet 4", Default: "", Variants: { "": "claude-4-sonnet" } },
  { ID: "claude-4-sonnet-thinking", Name: "Claude Sonnet 4 Thinking", Default: "", Variants: { "": "claude-4-sonnet-thinking" } },
  { ID: "claude-haiku-5-5", Name: "Claude Haiku 5.5", Default: "medium", Variants: { low: "claude-haiku-5-5-low", medium: "claude-haiku-5-5-medium", high: "claude-haiku-5-5-high", xhigh: "claude-haiku-5-5-xhigh", max: "claude-haiku-5-5-max" } },
  { ID: "claude-haiku-5-5-thinking", Name: "Claude Haiku 5.5 Thinking", Default: "medium", Variants: { low: "claude-haiku-5-5-thinking-low", medium: "claude-haiku-5-5-thinking-medium", high: "claude-haiku-5-5-thinking-high", xhigh: "claude-haiku-5-5-thinking-xhigh", max: "claude-haiku-5-5-thinking-max" } },
  { ID: "gpt-5.6-sol", Name: "GPT-5.6 Sol", Default: "medium", Variants: { none: "gpt-5.6-sol-none", low: "gpt-5.6-sol-low", medium: "gpt-5.6-sol-medium", high: "gpt-5.6-sol-high", xhigh: "gpt-5.6-sol-xhigh", max: "gpt-5.6-sol-max" } },
  { ID: "gpt-5.6-sol-fast", Name: "GPT-5.6 Sol Fast", Default: "medium", Variants: { none: "gpt-5.6-sol-none-fast", low: "gpt-5.6-sol-low-fast", medium: "gpt-5.6-sol-medium-fast", high: "gpt-5.6-sol-high-fast", xhigh: "gpt-5.6-sol-xhigh-fast", max: "gpt-5.6-sol-max-fast" } },
  { ID: "gpt-5.6-terra", Name: "GPT-5.6 Terra", Default: "medium", Variants: { none: "gpt-5.6-terra-none", low: "gpt-5.6-terra-low", medium: "gpt-5.6-terra-medium", high: "gpt-5.6-terra-high", xhigh: "gpt-5.6-terra-xhigh", max: "gpt-5.6-terra-max" } },
  { ID: "gpt-5.6-terra-fast", Name: "GPT-5.6 Terra Fast", Default: "medium", Variants: { none: "gpt-5.6-terra-none-fast", low: "gpt-5.6-terra-low-fast", medium: "gpt-5.6-terra-medium-fast", high: "gpt-5.6-terra-high-fast", xhigh: "gpt-5.6-terra-xhigh-fast", max: "gpt-5.6-terra-max-fast" } },
  { ID: "gpt-5.6-luna", Name: "GPT-5.6 Luna", Default: "medium", Variants: { none: "gpt-5.6-luna-none", low: "gpt-5.6-luna-low", medium: "gpt-5.6-luna-medium", high: "gpt-5.6-luna-high", xhigh: "gpt-5.6-luna-xhigh", max: "gpt-5.6-luna-max" } },
  { ID: "gpt-5.6-luna-fast", Name: "GPT-5.6 Luna Fast", Default: "medium", Variants: { none: "gpt-5.6-luna-none-fast", low: "gpt-5.6-luna-low-fast", medium: "gpt-5.6-luna-medium-fast", high: "gpt-5.6-luna-high-fast", xhigh: "gpt-5.6-luna-xhigh-fast", max: "gpt-5.6-luna-max-fast" } },
  { ID: "gpt-5.5", Name: "GPT-5.5", Default: "medium", Variants: { none: "gpt-5.5-none", low: "gpt-5.5-low", medium: "gpt-5.5-medium", high: "gpt-5.5-high", xhigh: "gpt-5.5-extra-high" } },
  { ID: "gpt-5.5-fast", Name: "GPT-5.5 Fast", Default: "medium", Variants: { none: "gpt-5.5-none-fast", low: "gpt-5.5-low-fast", medium: "gpt-5.5-medium-fast", high: "gpt-5.5-high-fast", xhigh: "gpt-5.5-extra-high-fast" } },
  { ID: "gpt-5.4", Name: "GPT-5.4", Default: "medium", Variants: { low: "gpt-5.4-low", medium: "gpt-5.4-medium", high: "gpt-5.4-high", xhigh: "gpt-5.4-xhigh" } },
  { ID: "gpt-5.4-fast", Name: "GPT-5.4 Fast", Default: "medium", Variants: { medium: "gpt-5.4-medium-fast", high: "gpt-5.4-high-fast", xhigh: "gpt-5.4-xhigh-fast" } },
  { ID: "gpt-5.4-mini", Name: "GPT-5.4 Mini", Default: "medium", Variants: { none: "gpt-5.4-mini-none", low: "gpt-5.4-mini-low", medium: "gpt-5.4-mini-medium", high: "gpt-5.4-mini-high", xhigh: "gpt-5.4-mini-xhigh" } },
  { ID: "gpt-5.4-nano", Name: "GPT-5.4 Nano", Default: "medium", Variants: { none: "gpt-5.4-nano-none", low: "gpt-5.4-nano-low", medium: "gpt-5.4-nano-medium", high: "gpt-5.4-nano-high", xhigh: "gpt-5.4-nano-xhigh" } },
  { ID: "gpt-5.3-codex", Name: "Codex 5.3", Default: "medium", Variants: { low: "gpt-5.3-codex-low", medium: "gpt-5.3-codex", high: "gpt-5.3-codex-high", xhigh: "gpt-5.3-codex-xhigh" } },
  { ID: "gpt-5.3-codex-fast", Name: "Codex 5.3 Fast", Default: "medium", Variants: { low: "gpt-5.3-codex-low-fast", medium: "gpt-5.3-codex-fast", high: "gpt-5.3-codex-high-fast", xhigh: "gpt-5.3-codex-xhigh-fast" } },
  { ID: "gpt-5.2", Name: "GPT-5.2", Default: "medium", Variants: { low: "gpt-5.2-low", medium: "gpt-5.2", high: "gpt-5.2-high", xhigh: "gpt-5.2-xhigh" } },
  { ID: "gpt-5.2-fast", Name: "GPT-5.2 Fast", Default: "medium", Variants: { low: "gpt-5.2-low-fast", medium: "gpt-5.2-fast", high: "gpt-5.2-high-fast", xhigh: "gpt-5.2-xhigh-fast" } },
  { ID: "gpt-5.1", Name: "GPT-5.1", Default: "medium", Variants: { low: "gpt-5.1-low", medium: "gpt-5.1", high: "gpt-5.1-high" } },
  { ID: "gpt-5-mini", Name: "GPT-5 Mini", Default: "", Variants: { "": "gpt-5-mini" } },
  { ID: "gemini-4-neon", Name: "Gemini 4 Neon", Default: "medium", Variants: { low: "gemini-4-neon-low", medium: "gemini-4-neon-medium", high: "gemini-4-neon-high", xhigh: "gemini-4-neon-xhigh" } },
  { ID: "gemini-4-carbon", Name: "Gemini 4 Carbon", Default: "medium", Variants: { low: "gemini-4-carbon-low", medium: "gemini-4-carbon-medium", high: "gemini-4-carbon-high" } },
  { ID: "gemini-4-hydrogen", Name: "Gemini 4 Hydrogen", Default: "medium", Variants: { low: "gemini-4-hydrogen-low", medium: "gemini-4-hydrogen-medium", high: "gemini-4-hydrogen-high", xhigh: "gemini-4-hydrogen-xhigh" } },
  { ID: "gemini-4-argon", Name: "Gemini 4 Argon", Default: "medium", Variants: { low: "gemini-4-argon-low", medium: "gemini-4-argon-medium", high: "gemini-4-argon-high" } },
  { ID: "gemini-3.8-flash", Name: "Gemini 3.8 Flash", Default: "medium", Variants: { low: "gemini-3.8-flash-low", medium: "gemini-3.8-flash-medium", high: "gemini-3.8-flash-high" } },
  { ID: "gemini-3.7-flash", Name: "Gemini 3.7 Flash", Default: "high", Variants: { low: "gemini-3.7-flash-low", medium: "gemini-3.7-flash-medium", high: "gemini-3.7-flash-high" } },
  { ID: "gemini-3.6-flash", Name: "Gemini 3.6 Flash", Default: "high", Variants: { minimal: "gemini-3.6-flash-minimal", low: "gemini-3.6-flash-low", medium: "gemini-3.6-flash-medium", high: "gemini-3.6-flash-high" } },
  { ID: "gemini-3.5-flash", Name: "Gemini 3.5 Flash", Default: "", Variants: { "": "gemini-3.5-flash" } },
  { ID: "gemini-3.1-pro", Name: "Gemini 3.1 Pro", Default: "", Variants: { "": "gemini-3.1-pro" } },
  { ID: "gemini-3-flash", Name: "Gemini 3 Flash", Default: "", Variants: { "": "gemini-3-flash" } },
  { ID: "kimi-k3", Name: "Kimi K3", Default: "max", Variants: { low: "kimi-k3-low", high: "kimi-k3-high", max: "kimi-k3-max" } },
  { ID: "kimi-k2.7-code", Name: "Kimi K2.7 Code", Default: "", Variants: { "": "kimi-k2.7-code" } },
  { ID: "deepseek-v41-flash-1017", Name: "DeepSeek V4.1 Flash 1017", Default: "medium", Variants: { none: "deepseek-v41-flash-1017-none", low: "deepseek-v41-flash-1017-low", medium: "deepseek-v41-flash-1017-medium", high: "deepseek-v41-flash-1017-high", max: "deepseek-v41-flash-1017-max" } },
  { ID: "glm-5.2", Name: "GLM 5.2", Default: "high", Variants: { high: "glm-5.2-high", max: "glm-5.2-max" } },
  { ID: "muse-spark-1.3", Name: "Muse Spark 1.3", Default: "high", Variants: { minimal: "muse-spark-1.3-minimal", low: "muse-spark-1.3-low", medium: "muse-spark-1.3-medium", high: "muse-spark-1.3-high", xhigh: "muse-spark-1.3-xhigh", max: "muse-spark-1.3-max" } },
  { ID: "muse-wonder-1.0", Name: "Muse Wonder", Default: "medium", Variants: { minimal: "muse-wonder-1.0-minimal", low: "muse-wonder-1.0-low", medium: "muse-wonder-1.0-medium", high: "muse-wonder-1.0-high", xhigh: "muse-wonder-1.0-xhigh", max: "muse-wonder-1.0-max" } },
];

const [cursorModelByID, cursorModelByVariant] = (() => {
  const byID = {};
  const byVariant = {};
  for (const model of cursorModels) {
    byID[model.ID] = model;
    for (const id of Object.values(model.Variants)) {
      byVariant[id] = model;
    }
  }
  return [byID, byVariant];
})();

function CursorModels() { return [...cursorModels]; }

function CursorModelFamily(id) {
  const model = cursorModelByVariant[id];
  return [model ?? new CursorModel(), model !== undefined];
}

function CursorModelEfforts(id, catalog) {
  const [model, ok] = lookupCursorFamily(id, catalog);
  if (!ok) {
    return null;
  }
  const out = [];
  for (const effort of ExecutorEffortLevels[AgentCLICursor]) {
    if (model.Variants[effort] !== undefined) {
      out.push(effort);
    }
  }
  return out.length === 0 ? null : out;
}

function CursorModelID(id, effort, catalog) {
  const [model, ok] = lookupCursorFamily(id, catalog);
  if (ok) {
    return cursorVariantID(model, effort);
  }
  return id;
}

function cursorVariantID(model, effort) {
  if (model.Variants[""] !== undefined) {
    return model.Variants[""];
  }
  if (model.Variants[effort] !== undefined) {
    return model.Variants[effort];
  }
  const levels = ExecutorEffortLevels[AgentCLICursor];
  const want = levels.indexOf(effort);
  if (want < 0) {
    return model.Variants[model.Default];
  }
  let best = model.Default;
  let distance = levels.length;
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (model.Variants[level] !== undefined && abs(i - want) <= distance) {
      best = level;
      distance = abs(i - want);
    }
  }
  return model.Variants[best];
}

function abs(n) {
  if (n < 0) {
    return -n;
  }
  return n;
}

const cursorEffortSuffixes = [
  { token: "extra-high", effort: "xhigh" },
  { token: "minimal", effort: "minimal" },
  { token: "medium", effort: "medium" },
  { token: "xhigh", effort: "xhigh" },
  { token: "ultra", effort: "ultra" },
  { token: "high", effort: "high" },
  { token: "none", effort: "none" },
  { token: "max", effort: "max" },
  { token: "low", effort: "low" },
];

const cursorEffortNameSuffixes = ["Extra High", "Minimal", "Medium", "Xhigh", "Ultra", "High", "None", "Max", "Low"];

function lookupCursorFamily(id, catalog) {
  if (cursorModelByID[id] !== undefined) {
    return [cursorModelByID[id], true];
  }
  for (const entry of catalog) {
    if (entry.ID !== id || entry.Efforts === null || entry.Efforts === undefined || Object.keys(entry.Efforts).length === 0) {
      continue;
    }
    const variants = {};
    for (const [effort, raw] of Object.entries(entry.Efforts)) {
      if (cursorEffortToken(effort) !== "" && raw.trim() !== "") {
        variants[effort] = raw.trim();
      }
    }
    if (Object.keys(variants).length === 0) {
      return [new CursorModel(), false];
    }
    let def = entry.DefaultEffort;
    if (variants[def] === undefined) {
      def = inferredCursorDefault(variants);
    }
    return [new CursorModel({ ID: id, Name: entry.Name, Default: def, Variants: variants }), true];
  }
  return [new CursorModel(), false];
}

function cursorEffortToken(effort) {
  switch (effort.trim()) {
    case "none":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    case "ultra":
      return effort;
    default:
      return "";
  }
}

function splitCursorEffortID(id) {
  let fast = false;
  if (id.endsWith("-fast") && id.slice(0, -"-fast".length) !== "") {
    id = id.slice(0, -"-fast".length);
    fast = true;
  }
  for (const suffix of cursorEffortSuffixes) {
    if (!id.endsWith("-" + suffix.token)) {
      continue;
    }
    const base = id.slice(0, -("-" + suffix.token).length);
    if (base === "") {
      continue;
    }
    if (fast) {
      return [base + "-fast", suffix.effort, true];
    }
    return [base, suffix.effort, true];
  }
  return ["", "", false];
}

function stripCursorEffortName(name) {
  name = name.trim();
  let notes = "";
  while (name.endsWith(")")) {
    const open = name.lastIndexOf(" (");
    if (open <= 0) {
      break;
    }
    notes = name.slice(open) + notes;
    name = name.slice(0, open).trim();
  }
  let fast = false;
  if (name.endsWith(" Fast") && name.slice(0, -" Fast".length).trim() !== "") {
    name = name.slice(0, -" Fast".length).trim();
    fast = true;
  }
  for (const suffix of cursorEffortNameSuffixes) {
    if (name.length <= suffix.length + 1 || name[name.length - suffix.length - 1] !== " ") {
      continue;
    }
    if (name.slice(name.length - suffix.length).toLowerCase() === suffix.toLowerCase()) {
      name = name.slice(0, name.length - suffix.length).trim();
      break;
    }
  }
  if (fast) {
    name += " Fast";
  }
  return name + notes;
}

function inferredCursorDefault(variants) {
  if (variants["medium"] !== undefined) {
    return "medium";
  }
  const levels = ExecutorEffortLevels[AgentCLICursor];
  const want = levels.indexOf("medium");
  let best = "";
  let distance = levels.length + 1;
  let bestIndex = -1;
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (variants[level] === undefined) {
      continue;
    }
    const gap = abs(i - want);
    if (best === "" || gap < distance || (gap === distance && i > bestIndex)) {
      best = level;
      distance = gap;
      bestIndex = i;
    }
  }
  return best;
}

function FoldCursorCLIModels(models) {
  const [present, groups, tail] = scanCursorCLIModels(models);
  const dynamic = mergePlainCursorFamilies(tail, groups);
  const out = [];
  for (const family of cursorModels) {
    if (present[family.ID]) {
      out.push(new domain.CLIModel({ ID: family.ID, Name: family.Name }));
    }
  }
  for (const item of dynamic) {
    if (!item.family) {
      out.push(item.plain);
      continue;
    }
    out.push(cursorFamilyRow(item.id, groups[item.id]));
  }
  return out;
}

class cursorFamilyGroup {
  constructor(init = {}) {
    this.name = init.name ?? "";
    this.variants = init.variants ?? {};
  }
}

class cursorModelSlot {
  constructor(init = {}) {
    this.family = init.family ?? false;
    this.id = init.id ?? "";
    this.plain = init.plain ?? null;
  }
}

function scanCursorCLIModels(models) {
  const present = {};
  const groups = {};
  const tail = [];
  const seen = {};
  for (const model of models) {
    const id = model.ID.trim();
    if (id === "") {
      continue;
    }
    const [family, ok] = CursorModelFamily(id);
    if (ok) {
      present[family.ID] = true;
      continue;
    }
    const [familyID, effort, splitOk] = splitCursorEffortID(id);
    if (splitOk) {
      if (cursorModelByID[familyID] !== undefined) {
        present[familyID] = true;
        continue;
      }
      let g = groups[familyID] ?? null;
      if (g === null) {
        g = new cursorFamilyGroup({ variants: {} });
        groups[familyID] = g;
        if (!seen["family:" + familyID]) {
          seen["family:" + familyID] = true;
          tail.push(new cursorModelSlot({ family: true, id: familyID }));
        }
      }
      if (g.variants[effort] === undefined) {
        g.variants[effort] = id;
      }
      const stripped = stripCursorEffortName(model.Name);
      if (stripped !== "" && (g.name === "" || effort === "medium")) {
        g.name = stripped;
      }
      continue;
    }
    if (seen["plain:" + id]) {
      continue;
    }
    seen["plain:" + id] = true;
    tail.push(new cursorModelSlot({ id, plain: new domain.CLIModel({ ID: id, Name: model.Name.trim() }) }));
  }
  return [present, groups, tail];
}

function mergePlainCursorFamilies(tail, groups) {
  const dynamic = [];
  for (const item of tail) {
    if (item.family) {
      dynamic.push(item);
      continue;
    }
    const g = groups[item.id] ?? null;
    if (g === null) {
      dynamic.push(item);
      continue;
    }
    if (g.variants["medium"] === undefined) {
      g.variants["medium"] = item.id;
      if (item.plain.Name !== "") {
        g.name = item.plain.Name;
      }
    }
  }
  return dynamic;
}

function cursorFamilyRow(id, g) {
  const name = g.name === "" ? id : g.name;
  const variants = {};
  for (const [effort, raw] of Object.entries(g.variants)) {
    variants[effort] = raw;
  }
  return new domain.CLIModel({ ID: id, Name: name, Efforts: variants, DefaultEffort: inferredCursorDefault(variants) });
}

module.exports = { CursorModel, cursorModels, cursorModelByID, cursorModelByVariant, CursorModels, CursorModelFamily, CursorModelEfforts, CursorModelID, cursorVariantID, abs, cursorEffortSuffixes, cursorEffortNameSuffixes, lookupCursorFamily, cursorEffortToken, splitCursorEffortID, stripCursorEffortName, inferredCursorDefault, FoldCursorCLIModels, cursorFamilyGroup, cursorModelSlot, scanCursorCLIModels, mergePlainCursorFamilies, cursorFamilyRow };
