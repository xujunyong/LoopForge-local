// execution_scope.js —— 对应 Go 文件：internal/engine/execution_scope.go
// 作用：执行范围管理：按 Run 整体或逐仓库切分执行目标、包装仓库级遥测事件、注入工作分支环境变量并按目标依次执行命令。
// 职责边界：仅负责执行范围解析、目标命令绑定与多目标输出汇总；不直接执行具体沙箱命令或拉取 Git 仓库。
// 语法差异说明：(值, error) 统一译为成功直接返回值、失败 throw Error；map[string]any 译为普通对象 {}。

"use strict";

const { ExecutionScopeRun, ExecutionScopeRepositories } = require("../domain/observability.js"); // 对应 Go 的 domain.ExecutionScopeRun/ExecutionScopeRepositories，observability.js 已翻译
const { RepositoryContext } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryContext，project.js 已翻译
const { EventSink } = require("../runtime/runtime.js"); // 对应 Go 的 runtime.EventSink，runtime 待翻译
const { repositoryBaseBranch } = require("./repository_workspace.js"); // 对应 Go 同包函数，repository_workspace.js 已翻译
const { shellSingleQuote } = require("./runner_dispatch.js"); // 对应 Go 同包函数，runner_dispatch.js 已翻译

/**
 * 单个命令或门禁的执行目标，对应 Go 的 executionTarget。
 * 既可表示整个 Run 级别的目标（持有全部 Repositories），也可表示逐仓库模式下的单个仓库目标（持有 Repository）。
 */
class executionTarget {
  /**
   * 按 Go 结构体零值语义初始化执行目标。
   * @param {Object} [init={}] - 可选初始字段。
   * @param {string} [init.Scope=""] - 执行范围（Run 级或逐仓库级）。
   * @param {RepositoryContext|null} [init.Repository=null] - 逐仓库模式下的当前仓库上下文。
   * @param {RepositoryContext[]} [init.Repositories=[]] - Run 级别模式下的全部仓库上下文列表。
   * @returns {executionTarget} 初始化后的执行目标实例。
   */
  constructor(init = {}) {
    this.Scope = init.Scope ?? "";
    this.Repository = init.Repository ?? null;
    this.Repositories = init.Repositories ?? [];
  }

  /**
   * 返回该执行目标对应的工作区相对目录；Run 级别目标返回空字符串。
   * 在拼接 cd 命令或环境变量 AGENTFLOW_REPOSITORY_DIR 时调用。
   * @returns {string} 去除首尾空白后的工作区相对目录。
   */
  directory() {
    if (this.Repository == null) {
      return "";
    }
    return (this.Repository.WorkspaceDir ?? "").trim();
  }

  /**
   * 返回该执行目标用于日志与输出分组标题的可读名称。
   * 在多仓库汇总输出标题或错误前缀拼装时调用。
   * @returns {string} 目标名称（依次回退 Name、RepositoryID、目录名或 "repository"，Run 级为 "Run"）。
   */
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

/**
 * 包装遥测事件接收回调，在逐仓库执行时自动为每条事件补充仓库标识属性。
 * 当 sink 为空或目标为 Run 级时直接原样返回。
 * @param {Function|null} sink - 原始遥测事件接收函数（runtime.EventSink）。
 * @param {executionTarget} target - 当前执行目标。
 * @returns {Function|null} 包装后的事件接收函数或原 sink。
 */
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

/**
 * 规范化执行范围字符串，忽略大小写与首尾空白。
 * 在解析节点或门禁配置的 ExecutionScope 时调用。
 * @param {string} scope - 原始执行范围配置值。
 * @returns {string} 规范化后的执行范围常量（ExecutionScopeRepositories 或 ExecutionScopeRun）。
 */
function normalizeExecutionScope(scope) {
  if ((scope ?? "").trim().toLowerCase() === ExecutionScopeRepositories.toLowerCase()) {
    return ExecutionScopeRepositories;
  }
  return ExecutionScopeRun;
}

/**
 * 根据 Run 绑定的代码仓库列表与执行范围，展开为待执行的目标列表。
 * 在脚本节点或验证门禁开始执行前调用；逐仓库模式下若 Run 未绑定仓库则抛出错误。
 * @param {Object} run - 运行对象（domain.Run）。
 * @param {string} scope - 执行范围配置值。
 * @returns {executionTarget[]} 展开后的执行目标数组。
 * @throws {Error} 逐仓库模式且 Run 未绑定任何代码仓库时抛出错误。
 */
function executionTargets(run, scope) {
  scope = normalizeExecutionScope(scope);
  const repositories = run.RepositoryContexts();
  if (scope === ExecutionScopeRun) {
    return [new executionTarget({ Scope: scope, Repositories: repositories })];
  }
  if (repositories.length === 0) {
    throw new Error("逐仓库执行需要 Run 至少绑定一个代码仓库");
  }
  const targets = [];
  for (let i = 0; i < repositories.length; i++) {
    const rc = repositories[i];
    targets.push(new executionTarget({ Scope: scope, Repository: rc }));
  }
  return targets;
}

/**
 * 将原始 shell 命令包装为与物理单/多仓库布局无关的脚本。
 * 逐仓库目标会注入单仓环境变量并 cd 到对应目录；Run 级目标会在工作区根目录注入 AGENTFLOW_WORK_BRANCHES 清单。
 * @param {string} command - 待执行的原始命令文本。
 * @param {executionTarget} target - 当前执行目标。
 * @returns {string} 注入环境变量与目录切换后的完整 shell 命令。
 */
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

/**
 * 返回仓库允许推送的工作分支名；只读仓库返回空字符串。
 * 在构造分支环境变量与校验 MR 时调用。
 * @param {RepositoryContext} repository - 代码仓库上下文对象。
 * @returns {string} 可写工作分支名，只读或未配置时为空字符串。
 */
function writableWorkBranch(repository) {
  if (repository.ReadOnly) {
    return "";
  }
  return (repository.WorkBranch ?? "").trim();
}

/**
 * 生成所有可写仓库的分支清单，每行格式为 "目录\t工作分支\t目标基线分支"。
 * 工作区根目录下的传统单仓布局以 "." 表示；用于注入 AGENTFLOW_WORK_BRANCHES。
 * @param {RepositoryContext[]} repositories - 代码仓库上下文列表。
 * @returns {string} 以换行符分隔的分支清单文本。
 */
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

/**
 * 按指定执行范围依次对每个目标调用 execute 回调，并在多目标场景下按目标名称分段汇总输出。
 * 在脚本节点执行与验证门禁命令执行时调用；任一目标失败时附加目标名称前缀后抛出错误。
 * @param {Object} run - 运行对象（domain.Run）。
 * @param {string} scope - 执行范围配置值。
 * @param {function(executionTarget): string} execute - 针对单个目标的执行回调，成功返回输出字符串，失败抛出 Error。
 * @returns {string} 汇总并去除首尾空白后的执行输出。
 * @throws {Error} 目标展开失败或任一目标执行失败时抛出带目标前缀的 Error（cause 指向原错误，多目标失败时 partialOutput 保存已收集输出）。
 */
function executeForTargets(run, scope, execute) {
  const targets = executionTargets(run, scope);
  if (targets.length === 1) {
    try {
      return execute(targets[0]);
    } catch (runErr) {
      const err = new Error(targets[0].label() + ": " + runErr.message);
      err.cause = runErr;
      throw err;
    }
  }
  let output = "";
  for (const target of targets) {
    let result = "";
    let runErr = null;
    try {
      result = execute(target);
    } catch (err) {
      runErr = err;
    }
    if (targets.length > 1) {
      output += `## ${target.label()}\n\n`;
    }
    if ((result ?? "").trim() !== "") {
      output += result.trim();
      output += "\n";
    }
    if (runErr != null) {
      const err = new Error(target.label() + ": " + runErr.message);
      err.cause = runErr;
      err.partialOutput = output.trim();
      throw err;
    }
  }
  return output.trim();
}

module.exports = { executionTarget, executionTargetSink, normalizeExecutionScope, executionTargets, writableWorkBranch, workBranchManifest, bindExecutionTarget, executeForTargets, repositoryBaseBranch };
