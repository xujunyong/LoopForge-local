// execution_scope.js —— 对应 Go 文件：internal/engine/execution_scope.go
// 作用：执行范围：按 Run 或逐仓库切分执行目标并绑定工作分支环境变量。

"use strict";

const { ExecutionScopeRun, ExecutionScopeRepositories } = require("../domain/observability.js"); // 对应 Go 的 domain.ExecutionScopeRun/ExecutionScopeRepositories，observability.js 已翻译
const { RepositoryContext } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryContext，project.js 已翻译
const { EventSink } = require("../runtime/runtime.js"); // 对应 Go 的 runtime.EventSink，runtime 待翻译

class executionTarget {
  constructor(init = {}) {
    this.Scope = init.Scope ?? "";
    this.Repository = init.Repository ?? null;
    this.Repositories = init.Repositories ?? [];
  }

  directory() {
    if (this.Repository == null) {
      return "";
    }
    return (this.Repository.WorkspaceDir ?? "").trim();
  }

  label() {
    if (this.Repository == null) {
      return "Run";
    }
    const name = (this.Repository.Name ?? "").trim();
    if (name !== "") {
      return name;
    }
    const id = (this.Repository.RepositoryID ?? "").trim();
    if (id !== "") {
      return id;
    }
    const dir = this.directory();
    if (dir !== "") {
      return dir;
    }
    return "repository";
  }
}

function executionTargetSink(sink, target) {
  if (sink == null || target.Repository == null) {
    return sink;
  }
  return function (event) {
    const attributes = {};
    for (const [key, value] of Object.entries(event.Attributes ?? {})) {
      attributes[key] = value;
    }
    attributes["repositoryId"] = target.Repository.RepositoryID;
    attributes["repositoryName"] = target.Repository.Name;
    attributes["repositoryDir"] = target.Repository.WorkspaceDir;
    sink({ ...event, Attributes: attributes });
  };
}

function normalizeExecutionScope(scope) {
  if ((scope ?? "").trim().toLowerCase() === ExecutionScopeRepositories.toLowerCase()) {
    return ExecutionScopeRepositories;
  }
  return ExecutionScopeRun;
}

function executionTargets(run, scope) {
  scope = normalizeExecutionScope(scope);
  const repositories = run.RepositoryContexts();
  if (scope === ExecutionScopeRun) {
    return [[new executionTarget({ Scope: scope, Repositories: repositories })], null];
  }
  if (repositories.length === 0) {
    return [null, new Error("逐仓库执行需要 Run 至少绑定一个代码仓库")];
  }
  const targets = [];
  for (let i = 0; i < repositories.length; i++) {
    const rc = repositories[i];
    targets.push(new executionTarget({ Scope: scope, Repository: rc }));
  }
  return [targets, null];
}

function bindExecutionTarget(command, target) {
  let b = `export AGENTFLOW_WORKSPACE="$PWD"`;
  b += "\nexport AGENTFLOW_EXECUTION_SCOPE=" + shellSingleQuote(target.Scope);
  if (target.Repository != null) {
    b += "\nexport AGENTFLOW_REPOSITORY_ID=" + shellSingleQuote(target.Repository.RepositoryID);
    b += "\nexport AGENTFLOW_REPOSITORY_NAME=" + shellSingleQuote(target.Repository.Name);
    b += "\nexport AGENTFLOW_REPOSITORY_DIR=" + shellSingleQuote(target.directory());
    b += "\nexport AGENTFLOW_WORK_BRANCH=" + shellSingleQuote(writableWorkBranch(target.Repository));
    b += "\nexport AGENTFLOW_BASE_BRANCH=" + shellSingleQuote(repositoryBaseBranch(target.Repository));
    const dir = target.directory();
    if (dir !== "") {
      b += "\ncd -- " + shellSingleQuote(dir);
    }
  } else {
    b += "\nexport AGENTFLOW_WORK_BRANCHES=" + shellSingleQuote(workBranchManifest(target.Repositories));
  }
  b += "\n" + command;
  return b;
}

function writableWorkBranch(repository) {
  if (repository.ReadOnly) {
    return "";
  }
  return (repository.WorkBranch ?? "").trim();
}

function workBranchManifest(repositories) {
  const lines = [];
  for (const repository of repositories) {
    const work = writableWorkBranch(repository);
    if (work === "") {
      continue;
    }
    let dir = (repository.WorkspaceDir ?? "").trim();
    if (dir === "") {
      dir = ".";
    }
    lines.push(dir + "\t" + work + "\t" + repositoryBaseBranch(repository));
  }
  return lines.join("\n");
}

function executeForTargets(run, scope, execute) {
  const [targets, err] = executionTargets(run, scope);
  if (err != null) {
    return ["", err];
  }
  if (targets.length === 1) {
    const [result, runErr] = execute(targets[0]);
    if (runErr != null) {
      return [result, new Error(targets[0].label() + ": " + runErr.message)];
    }
    return [result, null];
  }
  let output = "";
  for (const target of targets) {
    const [result, runErr] = execute(target);
    if (targets.length > 1) {
      output += `## ${target.label()}\n\n`;
    }
    if ((result ?? "").trim() !== "") {
      output += result.trim();
      output += "\n";
    }
    if (runErr != null) {
      return [output.trim(), new Error(target.label() + ": " + runErr.message)];
    }
  }
  return [output.trim(), null];
}

module.exports = { executionTarget, executionTargetSink, normalizeExecutionScope, executionTargets, writableWorkBranch, workBranchManifest, bindExecutionTarget, executeForTargets };
