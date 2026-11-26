// agy_models.js —— 对应 Go 文件：internal/runtime/agy_models.go
// 作用：Antigravity 模型 ID 的思考强度后缀拆分与账号模型折叠。

"use strict";

const { ExecutorEffortLevels } = require("../domain/agent.js"); // 对应 Go 的 domain.ExecutorEffortLevels，domain 已翻译
const { CLIModel } = require("../domain/user.js"); // 对应 Go 的 domain.CLIModel，domain 已翻译
const { AgentCLIAntigravity } = require("./agent_cli.js"); // 对应 Go 同包常量，agent_cli.js 已翻译
const { AgyModelEfforts } = require("./provider_agentcli.js"); // 对应 Go 同包函数，provider_agentcli.js 待翻译

// SplitAgyModelEffort：分离 Antigravity 模型 ID 中可识别的强度后缀。
function SplitAgyModelEffort(model) {
  for (const level of ExecutorEffortLevels[AgentCLIAntigravity]) {
    if (model.endsWith("-" + level)) {
      return [model.slice(0, model.length - level.length - 1), level];
    }
  }
  return [model, ""];
}

function agyClaudeFamily(model) {
  const [base] = SplitAgyModelEffort(model);
  switch (base) {
    case "claude-opus-5-5":
    case "claude-sonnet-5-5":
      return base;
  }
  return "";
}

// AgyAccountModelEfforts：账号登录暴露的 Claude 变体强度。
function AgyAccountModelEfforts(model) {
  if (agyClaudeFamily(model) !== "") {
    return ["low", "medium", "high", "max"];
  }
  return AgyModelEfforts(model);
}

// FoldAgyAccountModels：保留广告模型 ID 作默认项，并携带该账号返回的实际变体 ID 与强度。
function FoldAgyAccountModels(models) {
  const out = [];
  const groups = new Map();
  for (const model of models) {
    const [base, effort] = SplitAgyModelEffort(model.ID);
    const levels = AgyAccountModelEfforts(base);
    if (!levels.includes(effort)) {
      out.push(model);
      continue;
    }
    let index = groups.get(base);
    if (index === undefined) {
      index = out.length;
      groups.set(base, index);
      let name = model.Name;
      const suffix = " (" + effort + ")";
      if (name.toLowerCase().endsWith(suffix)) {
        name = name.slice(0, name.length - suffix.length);
      }
      if (name === "") {
        name = base;
      }
      out.push(new CLIModel({
        ID: model.ID, Name: name, DefaultEffort: effort,
        Efforts: {}, ReasoningEfforts: model.ReasoningEfforts,
      }));
    }
    const group = out[index];
    group.Efforts[effort] = model.ID;
    for (const level of levels) {
      const id = (model.Efforts ?? {})[level];
      if (id === base + "-" + level) {
        group.Efforts[level] = id;
      }
    }
    if (agyClaudeFamily(base) !== "" && effort === "medium") {
      group.ReasoningEfforts = model.ReasoningEfforts;
    }
  }
  for (const [base, index] of groups) {
    const row = out[index];
    if (agyClaudeFamily(base) !== "" && (row.Efforts["medium"] ?? "") !== "") {
      row.ID = row.Efforts["medium"];
      row.DefaultEffort = "medium";
    }
    const levels = [];
    for (const level of AgyAccountModelEfforts(base)) {
      if ((row.Efforts[level] ?? "") !== "") {
        levels.push(level);
      }
    }
    row.DiscoveredReasoningEfforts = levels;
  }
  return out;
}

module.exports = {
  SplitAgyModelEffort, agyClaudeFamily, AgyAccountModelEfforts, FoldAgyAccountModels,
};
