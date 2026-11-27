/**
 * 对应 Go 源文件：internal/engine/sop_executors.go
 *
 * 文件作用与职责边界：
 * 负责 SOP 节点执行器的自动选择、前置配置需求检查与延迟解析：
 * 根据负责人的凭据配置、默认偏好以及执行机器（Runner）能力，为未固定执行器的节点计算默认执行器，
 * 并在手动启动前检查执行器就绪状态，或在排队运行真正执行前补齐延迟解析的执行器。
 *
 * Go 与 JS 语法差异说明：
 * - Go 的 `(值, error)` 译为成功返回值、失败 `throw`；`(值, bool)` 译为 `[值, boolean]` 元组。
 * - Go 的 `map[string]bool` 与 `map[string]AssistantDefaults` 统一译为普通对象 `{}`。
 * - Go 的 `fmt.Sprintf` 的 `%q` 格式化译为 `JSON.stringify`。
 * - Go 结构体按值传递时（如 `workflowNodeExecutor` 中的 `role`），JS 修改前先浅拷贝 `{ ...role }`。
 */

"use strict";

const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 已翻译
const { AssistantDefaults } = require("../domain/assistant_preferences.js"); // 对应 Go 的 domain.AssistantDefaults，assistant_preferences.js 已翻译
const { TelemetryContext } = require("../domain/observability.js"); // 对应 Go 的 domain.TelemetryContext，observability.js 已翻译
const { ExecutorDefinition } = require("../domain/agent.js"); // 对应 Go 的 domain.ExecutorDefinition，agent.js 已翻译
const { RuntimeAuthLocal, SupportsRunnerLogin } = require("../domain/runner.js"); // 对应 Go 的 domain.RuntimeAuthLocal/SupportsRunnerLogin，runner.js 已翻译
const { AttachPreviewBuild } = require("../domain/preview_build.js"); // 对应 Go 的 domain.AttachPreviewBuild，preview_build.js 已翻译
const { BuiltInExecutors, BuiltInExecutor, BuiltInExecutorForKind } = require("../repo/catalog.js"); // 对应 Go 的 repo.BuiltInExecutors/BuiltInExecutor/BuiltInExecutorForKind，catalog.js 已翻译
const { BaselineAlignWorkflowID, BaselineAlignAgentID, configureBaselineAlignCLI } = require("./align.js"); // 对应 Go 同包常量与函数，align.js 已翻译
const { resolveCodeBuddyCredential } = require("./codebuddy_auth.js"); // 对应 Go 同包函数，codebuddy_auth.js 已翻译
const { workflowAgent } = require("./assets.js"); // 对应 Go 同包函数，assets.js 已翻译
const { resolveNodeExecutor } = require("./node_execute.js"); // 对应 Go 同包函数，node_execute.js 已翻译

/**
 * 表示 SOP 执行所需的单个执行器依赖及其配置就绪状态。
 * 对应 Go 结构体 `SOPExecutorRequirement`。
 */
class SOPExecutorRequirement {
  /**
   * 构造执行器需求项。
   *
   * @param {object} [init={}] - 初始化字段。
   * @param {string} [init.Kind=""] - 执行器提供方标识（如 "codebuddy"、"codex"、"claude-code"）。
   * @param {string} [init.Name=""] - 执行器展示名称。
   * @param {boolean} [init.Configured=false] - 当前用户与执行环境是否已完成该执行器的可用配置。
   */
  constructor(init = {}) {
    this.Kind = init.Kind ?? "";
    this.Name = init.Name ?? "";
    this.Configured = init.Configured ?? false;
  }
}

const errSOPExecutorUnconfigured = new Error("请在个人配置中添加当前执行环境可用的执行器，再重试此节点");

/**
 * 封装负责人凭据、目标 Runner 能力与平台共享 CodeBuddy 凭据状态，用于判断各执行器是否可用及推导默认执行器。
 * 对应 Go 结构体 `sopExecutorAccess`。
 */
class sopExecutorAccess {
  /**
   * 构造执行器访问能力评估对象。
   *
   * @param {object} [init={}] - 初始化字段。
   * @param {object|null} [init.user=null] - 负责人用户对象（domain.User）。
   * @param {object|null} [init.runner=null] - 目标执行机器对象（domain.Runner）。
   * @param {boolean} [init.usesRunner=false] - 是否通过远程 Runner 执行。
   * @param {boolean} [init.sharedCodeBuddy=false] - 是否可使用平台共享的 CodeBuddy 凭据。
   */
  constructor(init = {}) {
    this.user = init.user ?? null;
    this.runner = init.runner ?? null;
    this.usesRunner = init.usesRunner ?? false;
    this.sharedCodeBuddy = init.sharedCodeBuddy ?? false;
  }

  /**
   * 判断指定类型的执行器在当前用户与执行环境下是否已配置且可用。
   * 使用场景：计算默认执行器或生成预检需求列表时，逐个校验执行器提供方。
   *
   * @param {string} kind - 执行器提供方类型标识（如 "codebuddy"、"codex"）。
   * @returns {boolean} 可用返回 true，否则返回 false。
   */
  configured(kind) {
    if (this.usesRunner) {
      if (!this.runner.SupportsProvider(kind)) {
        return false;
      }
      if (SupportsRunnerLogin(kind) && this.runner.RuntimeAuthMode(kind) === RuntimeAuthLocal) {
        return true;
      }
      if (kind === "codebuddy" && this.user.CodeBuddyBaseURL.trim() !== "" && !this.runner.SupportsCodeBuddyBaseURL()) {
        return false;
      }
    }
    return this.user.HasExecutorCredential(kind) || (kind === "codebuddy" && this.sharedCodeBuddy);
  }

  /**
   * 按优先级推导当前用户与执行环境下的默认执行器配置（用户偏好 -> 已配个人凭据的内置执行器 -> Runner 本地登录执行器 -> 共享 CodeBuddy）。
   * 使用场景：为未固定执行器的 SOP 节点规划默认执行器或延迟补齐执行器时调用。
   *
   * @returns {AssistantDefaults} 推导出的默认执行器配置；若均不可用则返回零值 AssistantDefaults。
   */
  defaults() {
    const preferred = this.user.AssistantDefaults;
    const [ex, ok] = BuiltInExecutorForKind(preferred.Executor);
    if (ok && this.user.HasExecutorCredential(ex.Kind) && this.configured(ex.Kind)) {
      let model = preferred.Model.trim();
      if (model === "") {
        model = this.firstSavedModel(ex.Kind);
      }
      return new AssistantDefaults({ Executor: ex.ID, Model: model, Effort: preferred.Effort });
    }
    const executors = BuiltInExecutors();
    for (const ex of executors) {
      if (this.user.HasExecutorCredential(ex.Kind) && this.configured(ex.Kind)) {
        return new AssistantDefaults({ Executor: ex.ID, Model: this.firstSavedModel(ex.Kind) });
      }
    }
    for (const ex of executors) {
      if (this.usesRunner && SupportsRunnerLogin(ex.Kind) && this.runner.RuntimeAuthMode(ex.Kind) === RuntimeAuthLocal && this.configured(ex.Kind)) {
        return new AssistantDefaults({ Executor: ex.ID });
      }
    }
    if (this.configured("codebuddy")) {
      return new AssistantDefaults({ Executor: "codebuddy" });
    }
    return new AssistantDefaults();
  }

  /**
   * 获取用户在指定执行器类型下保存的第一个模型 ID。
   * 使用场景：用户偏好未指定具体模型或回退到其他已配凭据执行器时补充默认模型。
   *
   * @param {string} kind - 执行器提供方类型标识。
   * @returns {string} 第一个已保存模型的 ID；若未配置任何模型则返回空字符串。
   */
  firstSavedModel(kind) {
    let models = [];
    switch (kind) {
      case "codebuddy":
        models = this.user.CodeBuddyModels ?? [];
        break;
      case "codex":
        models = this.user.CodexModels ?? [];
        break;
      case "claude-code":
        models = this.user.ClaudeCodeModels ?? [];
        break;
      default:
        // Go 读缺失的 map 键得零值，JS 取不到时按空处理。
        models = (this.user.AgentCLICredentials ?? {})[kind]?.Models ?? [];
        break;
    }
    if (models.length !== 0) {
      return models[0].ID;
    }
    return "";
  }
}

/**
 * 根据执行上下文加载负责人、目标 Runner 与共享 CodeBuddy 凭据状态，构造 sopExecutorAccess。
 * 使用场景：规划 SOP 节点执行器或延迟解析执行器之前调用。
 *
 * @param {object} ec - 运行遥测与执行上下文（domain.TelemetryContext）。
 * @returns {sopExecutorAccess} 当前上下文对应的执行器访问能力对象。
 */
Engine.prototype.sopExecutorAccess = function (ec) {
  const [user] = this.repo.User(ec.ResponsibleUserID);
  const [runner] = this.repo.Runner(ec.ExecutionRunnerID);
  return new sopExecutorAccess({
    user, runner, usesRunner: ec.ExecutionRunnerID !== "",
    sharedCodeBuddy: resolveCodeBuddyCredential(this.repo, user.ID).Sponsored,
  });
};

/**
 * 收集工作流所源自的通用模板中的角色 ID 集合（含项目克隆后的带项目后缀 ID）。
 * 使用场景：识别历史从通用模板派生的 CodeBuddy 角色，允许其继承用户默认执行器。
 *
 * @param {object} st - 仓库存储实例（repo.Store）。
 * @param {object} wf - 工作流定义（domain.WorkflowDefinition）。
 * @returns {object|null} 以角色 ID 为键、值为 true 的普通对象集合；找不到对应通用模板时返回 null。
 */
function templateSOPRoleIDs(st, wf) {
  let source = wf.ID;
  if (!wf.Generic) {
    source = "";
    for (const tag of wf.Tags) {
      // Go strings.CutPrefix：有前缀时去掉前缀并返回 true。
      if (tag.startsWith("generic-source:")) {
        source = tag.slice("generic-source:".length);
        break;
      }
    }
  }
  const [template, ok] = st.GenericTemplateByWorkflow(source);
  if (!ok) {
    return null;
  }
  const ids = {};
  for (const role of template.Agents) {
    ids[role.ID] = true;
    if (!wf.Generic) {
      ids[role.ID + "-" + wf.ProjectID] = true;
    }
  }
  return ids;
}

/**
 * 判断节点与角色是否允许继承 SOP 默认执行器。
 * 只有未指定节点执行器、角色未固定模型与推理强度、且角色执行器为空或为 codebuddy 的智能体节点才可继承。
 * 使用场景：规划默认执行器、解析节点执行器及延迟解析执行器时调用。
 *
 * @param {object} node - 工作流节点定义（domain.WorkflowNode）。
 * @param {object} role - 智能体角色定义（domain.AgentDefinition）。
 * @returns {boolean} 允许继承默认执行器返回 true，否则返回 false。
 */
function followsSOPExecutorDefault(node, role) {
  return node.Type === "agent" && node.ExecutorID === "" &&
    (role.ExecutorID === "" || role.ExecutorID === "codebuddy") &&
    role.Model.trim() === "" && role.Effort.trim() === "";
}

/**
 * 为工作流中的所有智能体节点规划默认执行器映射，并在预检模式下收集执行器配置需求列表。
 * 使用场景：启动 SOP 运行前生成 `ExecutorDefaults` 快照，或前端/接口预检工作流所需执行器时调用。
 *
 * @param {object} wf - 工作流定义（domain.WorkflowDefinition）。
 * @param {object} ec - 运行执行上下文（domain.TelemetryContext）。
 * @param {boolean} preflight - 是否处于预检模式；为 true 时遇到缺失角色或无法解析的执行器会抛错，并收集去重后的需求列表。
 * @returns {[object, SOPExecutorRequirement[]]} 返回 `[selected, requirements]`：节点 ID 到默认执行器配置的映射对象，以及去重后的执行器需求数组。
 * @throws {Error} 预检模式下角色不存在或节点执行器无法解析时抛出错误。
 */
Engine.prototype.planSOPExecutors = function (wf, ec, preflight) {
  const roleIDs = templateSOPRoleIDs(this.repo, wf);
  const access = this.sopExecutorAccess(ec);
  const defaults = access.defaults();
  const selected = {};
  const requirements = [];
  const seen = {};
  for (const node of wf.Nodes) {
    if (node.Type !== "agent") {
      continue;
    }
    const [role, ok] = workflowAgent(this.repo, wf, node.AgentID);
    if (!ok) {
      if (!preflight) {
        continue;
      }
      throw new Error(`agent ${JSON.stringify(node.AgentID)} not found`);
    }
    // Go 读 nil map 得 false，roleIDs 为 null 时按空对象读。
    const legacyTemplate = (roleIDs ?? {})[role.ID] && role.ProjectID === wf.ProjectID;
    const baselineResolver = wf.ID === BaselineAlignWorkflowID && role.ID === BaselineAlignAgentID;
    let ex = new ExecutorDefinition();
    if ((role.ExecutorID === "" || legacyTemplate || baselineResolver) && followsSOPExecutorDefault(node, role)) {
      selected[node.ID] = defaults;
      if (defaults.Executor !== "") {
        ex = BuiltInExecutor(defaults.Executor)[0];
      }
    } else if (preflight) {
      ex = resolveNodeExecutor(this.repo, node, role);
    }
    if (preflight && !seen[ex.Kind]) {
      seen[ex.Kind] = true;
      requirements.push(new SOPExecutorRequirement({
        Kind: ex.Kind, Name: ex.Name, Configured: ex.Kind !== "" && access.configured(ex.Kind),
      }));
    }
  }
  return [selected, requirements];
};

/**
 * 检查手动启动该工作流所需的执行器提供方及其配置状态。
 * 使用场景：HTTP API 在用户启动 SOP 前调用，向前端展示所需执行器名称及是否已配置。
 *
 * @param {object} wf - 原始工作流定义（domain.WorkflowDefinition）。
 * @param {number} userID - 负责执行该 SOP 的用户 ID。
 * @param {string} projectID - 所属项目 ID。
 * @returns {SOPExecutorRequirement[]} 去重后的执行器需求列表。
 * @throws {Error} 当基线对齐配置、预览构建节点挂载或执行器预检失败时抛出错误。
 */
Engine.prototype.SOPExecutorRequirements = function (wf, userID, projectID) {
  wf = configureBaselineAlignCLI(wf);
  wf = AttachPreviewBuild(wf);
  const ec = new TelemetryContext({ ResponsibleUserID: userID, ProjectID: projectID });
  this.selectSOPExecutionTarget(ec);
  const [, requirements] = this.planSOPExecutors(wf, ec, true);
  return requirements;
};

/**
 * 解析指定工作流节点最终使用的执行器定义，优先应用快照中记录的 `ExecutorDefaults`。
 * 使用场景：执行节点前确定实际调用的 CLI 执行器定义与模型/推理强度参数。
 *
 * @param {object} st - 仓库存储实例（repo.Store）。
 * @param {object} wf - 运行快照中的工作流定义（domain.WorkflowDefinition）。
 * @param {object} node - 待执行的工作流节点（domain.WorkflowNode）。
 * @param {object} role - 节点绑定的角色定义（domain.AgentDefinition）。
 * @returns {object} 解析后的执行器定义（domain.ExecutorDefinition）。
 * @throws {Error} 当节点依赖默认执行器但尚未配置，或底层执行器解析失败时抛出错误。
 */
function workflowNodeExecutor(st, wf, node, role) {
  // Go 读 nil map 得零值，JS 里 ExecutorDefaults 为 null 时按空对象读。
  const defaults = (wf.ExecutorDefaults ?? {})[node.ID];
  if (defaults !== undefined && followsSOPExecutorDefault(node, role)) {
    if (defaults.Executor === "") {
      throw errSOPExecutorUnconfigured;
    }
    // Go 结构体参数按值传递，修改前浅拷贝避免影响调用方对象。
    role = { ...role };
    role.ExecutorID = defaults.Executor;
    role.Model = defaults.Model;
    role.Effort = defaults.Effort;
  }
  return resolveNodeExecutor(st, node, role);
}

/**
 * 在节点真正运行前，对排队时尚未确定执行器的 SOP 运行执行延迟解析，并回写到运行快照。
 * 使用场景：运行入队时负责人尚未配置执行器，待绑定执行机器并开始首个角色节点前补齐默认执行器。
 *
 * @param {object} run - 当前运行实例（domain.Run）。
 * @param {object} node - 即将执行的工作流节点（domain.WorkflowNode）。
 * @returns {object} 解析并持久化后的最新运行实例（domain.Run）。
 * @throws {Error} 当当前执行环境仍无可用执行器或持久化运行快照失败时抛出错误。
 */
Engine.prototype.resolveDeferredSOPExecutor = function (run, node) {
  // Go 的 map 取值带 ok：键不存在时 pending 为 false。
  const defaults = (run.WorkflowSnapshot.ExecutorDefaults ?? {})[node.ID];
  if (defaults === undefined || defaults.Executor !== "") {
    return run;
  }
  const [role, found] = workflowAgent(this.repo, run.WorkflowSnapshot, node.AgentID);
  if (!found || !followsSOPExecutorDefault(node, role)) {
    return run;
  }
  const selected = this.sopExecutorAccess(run.ExecutionContext).defaults();
  if (selected.Executor === "") {
    throw errSOPExecutorUnconfigured;
  }
  this.updateRunErr(run.ID, (current) => {
    // Go range nil map 为空操作，JS 里 ExecutorDefaults 为 null 时按空对象读。
    for (const id of Object.keys(current.WorkflowSnapshot.ExecutorDefaults ?? {})) {
      if (current.WorkflowSnapshot.ExecutorDefaults[id].Executor === "") {
        current.WorkflowSnapshot.ExecutorDefaults[id] = selected;
      }
    }
    run = current;
  });
  return run;
};

module.exports = { SOPExecutorRequirement, errSOPExecutorUnconfigured, sopExecutorAccess, templateSOPRoleIDs, followsSOPExecutorDefault, workflowNodeExecutor };
