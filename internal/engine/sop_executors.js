// sop_executors.js —— 对应 Go 文件：internal/engine/sop_executors.go
// 作用：SOP 节点执行器选择：按用户凭据与执行机器能力算默认执行器，并校验前置需求。
// (值, error) 译为成功返回值、失败 throw，(值, bool) 译为 [值, bool]；Go 的 map[string]bool 译为普通对象；fmt.Sprintf 的 %q 译为 JSON.stringify。

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

const errSOPExecutorUnconfigured = new Error("请在个人配置中添加当前执行环境可用的执行器，再重试此节点");

class sopExecutorAccess {
  constructor(init = {}) {
    this.user = init.user ?? null;
    this.runner = init.runner ?? null;
    this.usesRunner = init.usesRunner ?? false;
    this.sharedCodeBuddy = init.sharedCodeBuddy ?? false;
  }

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

Engine.prototype.sopExecutorAccess = function (ec) {
  const [user] = this.repo.User(ec.ResponsibleUserID);
  const [runner] = this.repo.Runner(ec.ExecutionRunnerID);
  return new sopExecutorAccess({
    user, runner, usesRunner: ec.ExecutionRunnerID !== "",
    sharedCodeBuddy: resolveCodeBuddyCredential(this.repo, user.ID).Sponsored,
  });
};

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

function followsSOPExecutorDefault(node, role) {
  return node.Type === "agent" && node.ExecutorID === "" &&
    (role.ExecutorID === "" || role.ExecutorID === "codebuddy") &&
    role.Model.trim() === "" && role.Effort.trim() === "";
}

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
      requirements.push({ Kind: ex.Kind, Name: ex.Name, Configured: ex.Kind !== "" && access.configured(ex.Kind) });
    }
  }
  return [selected, requirements];
};

Engine.prototype.SOPExecutorRequirements = function (wf, userID, projectID) {
  wf = configureBaselineAlignCLI(wf);
  wf = AttachPreviewBuild(wf);
  const ec = new TelemetryContext({ ResponsibleUserID: userID, ProjectID: projectID });
  this.selectSOPExecutionTarget(ec);
  const [, requirements] = this.planSOPExecutors(wf, ec, true);
  return requirements;
};

function workflowNodeExecutor(st, wf, node, role) {
  // Go 读 nil map 得零值，JS 里 ExecutorDefaults 为 null 时按空对象读。
  const defaults = (wf.ExecutorDefaults ?? {})[node.ID];
  if (defaults !== undefined && followsSOPExecutorDefault(node, role)) {
    if (defaults.Executor === "") {
      throw errSOPExecutorUnconfigured;
    }
    role.ExecutorID = defaults.Executor;
    role.Model = defaults.Model;
    role.Effort = defaults.Effort;
  }
  return resolveNodeExecutor(st, node, role);
}

Engine.prototype.resolveDeferredSOPExecutor = async function (run, node) {
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

module.exports = { errSOPExecutorUnconfigured, sopExecutorAccess, templateSOPRoleIDs, followsSOPExecutorDefault, workflowNodeExecutor };
