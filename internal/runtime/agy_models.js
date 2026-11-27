/**
 * @file internal/runtime/agy_models.js
 * @description 对应 Go 源文件：internal/runtime/agy_models.go
 *
 * 职责与边界：
 * 负责 Antigravity 模型 ID 的思考强度后缀拆分、账号登录暴露的 Claude 变体强度查询，
 * 以及将同系列不同强度变体模型折叠为统一展示项的逻辑。
 * 不负责模型目录拉取或凭据绑定。
 *
 * 语法差异说明：
 * - Go 多返回值 `(base, effort string)` 译为二元组 `[base, effort]`。
 * - Go 的 `map[string]int` 译为普通对象 `{}`。
 */

"use strict";

const { ExecutorEffortLevels } = require("../domain/agent.js"); // 对应 Go 的 domain.ExecutorEffortLevels，domain 已翻译
const { CLIModel } = require("../domain/user.js"); // 对应 Go 的 domain.CLIModel，domain 已翻译
const { AgentCLIAntigravity } = require("./agent_cli.js"); // 对应 Go 同包常量，agent_cli.js 已翻译
const { AgyModelEfforts } = require("./provider_agentcli.js"); // 对应 Go 同包函数，provider_agentcli.js 待翻译

/**
 * 分离 Antigravity 模型 ID 末尾可识别的思考强度后缀（如 `-high`）。
 * 在模型折叠或识别模型家族时调用。
 *
 * @param {string} model - 原始模型 ID。
 * @returns {[string, string]} 二元组 `[基础模型 ID, 强度后缀]`；未匹配任何后缀时返回 `[model, ""]`。
 */
function SplitAgyModelEffort(model) {
  for (const level of ExecutorEffortLevels[AgentCLIAntigravity]) {
    if (model.endsWith("-" + level)) {
      return [model.slice(0, model.length - level.length - 1), level];
    }
  }
  return [model, ""];
}

/**
 * 判断模型是否属于 Antigravity 账号登录暴露的特定 Claude 家族，并返回基础家族名。
 *
 * @param {string} model - 原始模型 ID。
 * @returns {string} 命中时返回 `"claude-opus-5-5"` 或 `"claude-sonnet-5-5"`，否则返回 `""`。
 */
function agyClaudeFamily(model) {
  const [base] = SplitAgyModelEffort(model);
  switch (base) {
    case "claude-opus-5-5":
    case "claude-sonnet-5-5":
      return base;
  }
  return "";
}

/**
 * 返回 Antigravity 账号登录场景下指定模型支持的思考强度列表（包含 Claude 变体的强度档位）。
 *
 * @param {string} model - 模型 ID 或基础模型名。
 * @returns {string[]} 支持的思考强度数组。
 */
function AgyAccountModelEfforts(model) {
  if (agyClaudeFamily(model) !== "") {
    return ["low", "medium", "high", "max"];
  }
  return AgyModelEfforts(model);
}

/**
 * 将 Antigravity 账号返回的同系列多强度变体模型折叠为单个 `CLIModel` 条目，
 * 保留默认展示 ID，并在 `Efforts` 与 `DiscoveredReasoningEfforts` 中记录实际发现的变体映射与强度列表。
 *
 * @param {CLIModel[]} models - 账号返回的原始模型列表。
 * @returns {CLIModel[]} 折叠后的模型列表。
 */
function FoldAgyAccountModels(models) {
  const out = [];
  const groups = {};
  for (const model of models) {
    const [base, effort] = SplitAgyModelEffort(model.ID);
    const levels = AgyAccountModelEfforts(base);
    if (!levels.includes(effort)) {
      out.push(model);
      continue;
    }
    let index = groups[base];
    if (index === undefined) {
      index = out.length;
      groups[base] = index;
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
  for (const [base, index] of Object.entries(groups)) {
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
