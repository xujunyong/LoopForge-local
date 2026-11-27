// node_outputs.js —— 对应 Go 文件：internal/engine/node_outputs.go
// 作用：节点产物读取抽象与实现，统一控制面沙箱工作区读取与远端执行机器上报产物读取，并负责契约产物路径解析与远端输入清单拼装。
// 职责边界：仅负责节点产物的读取、缓存吸收与路径映射；不负责产物落地写盘、契约校验或数据库持久化。
// 语法差异说明：Go 接口 nodeOutputs 在 JS 中采用鸭子类型；sync.Mutex 在单线程 JS 中省略；(值, error) 统一译为成功返回值、失败 throw Error；(值, bool) 译为 [值, boolean]；map[string]bool 译为普通对象 {}；strings.Builder 译为字符串数组拼接。

"use strict";

const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath

const { RepositoryContext } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryContext，project.js 已翻译
const { ExecutionScopeRepositories } = require("../domain/observability.js"); // 对应 Go 的 domain.ExecutionScopeRepositories，observability.js 已翻译
const { RunnerInputFile } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerInputFile，runner.js 已翻译
const { maxArtifactBytes, latestInputArtifacts, artifactInputRelPath, writeInputManifestEntry } = require("./artifacts.js"); // 对应 Go 同包符号，artifacts.js 已翻译
const { collectRepositoryPatch, repositoryPatchSummary } = require("./repository_patch.js"); // 对应 Go 同包函数，repository_patch.js 已翻译
const { repositoryWorkspacePath } = require("./repository_workspace.js"); // 对应 Go 同包函数，repository_workspace.js 已翻译
const { normalizeExecutionScope } = require("./execution_scope.js"); // 对应 Go 同包函数，execution_scope.js 已翻译
const { ancestors } = require("./workflow_graph.js"); // 对应 Go 同包函数，workflow_graph.js 已翻译
const { sopHandoffInputs } = require("./legacy_handoff.js"); // 对应 Go 同包函数，legacy_handoff.js 已翻译

/** 目标路径不是常规文件（如目录、符号链接）时抛出的哨兵错误。 */
const errOutputNotRegular = new Error("is not a regular file");
/** 目标产物大小超过单文件上限（maxArtifactBytes）时抛出的哨兵错误。 */
const errOutputTooLarge = new Error("exceeds artifact size limit");

/**
 * 构造基于控制面本地沙箱工作区的节点产物读取器，对应 Go 的 workspaceOutputs 类型。
 * 在本地/云端控制面执行模式下，供门禁结果读取、产物校验与交付物收集使用。
 *
 * @param {string} value - 运行工作区根目录绝对路径。
 * @returns {{ readFile: function(string): Buffer, repositoryPatch: function(string): Buffer }} 实现 nodeOutputs 接口的对象。
 */
function workspaceOutputs(value) {
  return {
    /**
     * 读取工作区中指定相对路径的常规文件内容，并校验大小上限。
     * 在读取 submit_gate_result 或校验产物契约文件时调用。
     *
     * @param {string} rel - 相对于工作区根目录的正斜杠路径。
     * @returns {Buffer} 文件原始字节内容。
     * @throws {Error} 文件不存在（ENOENT）、不是常规文件（errOutputNotRegular）或超出大小上限（errOutputTooLarge）时抛出错误。
     */
    readFile(rel) {
      const full = path.join(value, rel.split("/").join(path.sep));
      const info = fs.statSync(full);
      if (!info.isFile()) {
        throw errOutputNotRegular;
      }
      if (info.size > maxArtifactBytes) {
        throw errOutputTooLarge;
      }
      return fs.readFileSync(full);
    },

    /**
     * 收集工作区中指定代码仓库目录的 Git 补丁内容。
     * 在节点完成后登记 repository-patch 产物时调用。
     *
     * @param {string} dir - 仓库在工作区内的相对目录（空字符串表示工作区根目录）。
     * @returns {Buffer} 仓库补丁字节内容。
     * @throws {Error} 收集仓库补丁失败时抛出错误。
     */
    repositoryPatch(dir) {
      return collectRepositoryPatch(repositoryWorkspacePath(value, new RepositoryContext({ WorkspaceDir: dir })));
    },
  };
}

/**
 * 保存远端执行机器为当前节点单次调用上报的产物内容，对应 Go 的 reportedOutputs 结构体。
 * 在远端 Runner 支持上报产物时替代控制面本地工作区，供产物校验、登记与提交式门禁读取使用；
 * Go 中的 sync.Mutex 在单线程 JS 中省略。
 */
class reportedOutputs {
  /**
   * 按 Go 结构体零值语义初始化 reportedOutputs 实例。
   *
   * @param {Object} [init={}] - 可选初始字段。
   * @param {RunnerInputFile[]} [init.inputs=[]] - 下发给远端执行机器的输入文件列表。
   * @returns {reportedOutputs} 初始化后的上报产物容器实例。
   */
  constructor(init = {}) {
    this.inputs = init.inputs ?? [];
    this.files = {};
    this.tooLarge = {};
    this.patches = {};
    this.recovered = [];
  }

  /**
   * 清空上一次调用缓存的全部上报文件、超限标记、补丁与找回记录。
   * 在节点新一轮自修正或重试开始前调用，因为 Runner 每次都会上报工作区全量状态。
   *
   * @returns {void} 无返回值。
   */
  reset() {
    this.files = {};
    this.tooLarge = {};
    this.patches = {};
    this.recovered = [];
  }

  /**
   * 合并单次远端任务上报的产物结果。
   * 脚本节点在逐仓库模式下会按仓库分别派发任务，因此同一次调用的多次上报需要累积合并。
   *
   * @param {Object|null} outputs - 远端任务上报的产物对象（domain.RunnerTaskOutputs）。
   * @returns {void} 无返回值。
   */
  absorb(outputs) {
    if (outputs == null) {
      return;
    }
    // Go 对 nil map / nil 切片 range 为空操作，JS 用 ?? 补空对象/空数组。
    for (const [rel, content] of Object.entries(outputs.Files ?? {})) {
      this.files[rel] = content;
      delete this.tooLarge[rel];
    }
    for (const rel of outputs.TooLarge ?? []) {
      this.tooLarge[rel] = true;
      delete this.files[rel];
    }
    for (const [dir, patch] of Object.entries(outputs.Patches ?? {})) {
      this.patches[dir] = patch;
    }
    this.recovered = [...this.recovered, ...(outputs.Recovered ?? [])];
  }

  /**
   * 取出并清空当前累计的误放交付物找回路径列表。
   * 在节点执行完成后记录 artifact.recovered 遥测事件时调用。
   *
   * @returns {string[]} 找回的交付物路径说明列表。
   */
  takeRecovered() {
    const out = this.recovered;
    this.recovered = [];
    return out;
  }

  /**
   * 读取远端执行机器上报的指定相对路径文件内容。
   * 实现 nodeOutputs 接口，与 workspaceOutputs.readFile 保持一致：成功返回 Buffer，失败抛出 Error。
   *
   * @param {string} rel - 相对于工作区根目录的正斜杠路径。
   * @returns {Buffer} 文件的 UTF-8 字节内容。
   * @throws {Error} 文件超限时抛出 errOutputTooLarge，文件不存在时抛出带 code="ENOENT" 的 Error。
   */
  readFile(rel) {
    if (this.tooLarge[rel]) {
      throw errOutputTooLarge;
    }
    if (!Object.hasOwn(this.files, rel)) {
      // 对应 Go 的 &fs.PathError{Op: "read", Path: rel, Err: fs.ErrNotExist}。
      const err = new Error(`read ${rel}: no such file or directory`);
      err.code = "ENOENT";
      throw err;
    }
    return Buffer.from(this.files[rel], "utf8");
  }

  /**
   * 读取远端执行机器上报的指定仓库目录补丁内容。
   * 实现 nodeOutputs 接口，未上报补丁时返回空 Buffer（长度 0，与 Go 的 nil []byte 一致）。
   *
   * @param {string} dir - 仓库在工作区内的相对目录。
   * @returns {Buffer} 补丁字节内容，无补丁时返回空 Buffer。
   */
  repositoryPatch(dir) {
    // Go 读缺失的 map 键得 ""，JS 用 ?? 补 ""。
    const patch = this.patches[dir] ?? "";
    if (patch !== "") {
      return Buffer.from(patch, "utf8");
    }
    // Go 返回 nil []byte，调用方按 len 为 0 处理，JS 用空 Buffer 代替。
    return Buffer.alloc(0);
  }
}

/**
 * 创建并初始化一个空的 reportedOutputs 实例。
 * 在节点开始使用远端执行机器上报模式时由 runEnvironment.beginReportedOutputs 调用。
 *
 * @param {RunnerInputFile[]} inputs - 本次调用需要随任务下发的输入文件列表。
 * @returns {reportedOutputs} 已初始化的上报产物容器实例。
 */
function newReportedOutputs(inputs) {
  const r = new reportedOutputs({ inputs });
  r.reset();
  return r;
}

/**
 * 计算单条产物契约在指定仓库目标下的工作区相对路径，并拦截逃逸出目标目录的非法路径。
 * 在枚举远端回传文件列表与校验产物契约时调用。
 *
 * @param {string} repositoryDir - 仓库在工作区内的相对目录（空字符串表示工作区根目录）。
 * @param {string} contractPath - 契约中声明的产物相对路径。
 * @returns {[string, boolean]} 合法时返回 [规范化后的正斜杠相对路径, true]，路径非法或越界时返回 ["", false]。
 */
function artifactRelPath(repositoryDir, contractPath) {
  const clean = path.posix.normalize(contractPath.trim().replaceAll("\\", "/"));
  if (clean === "." || clean === ".." || path.posix.isAbsolute(clean) || clean.startsWith("../")) {
    return ["", false];
  }
  const dir = repositoryDir.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (dir !== "") {
    return [path.posix.join(dir, clean), true];
  }
  return [clean, true];
}

/**
 * 列出节点全部产物契约解析出的工作区相对路径列表，目标切分逻辑与产物校验保持一致。
 * 在向远端执行机器下发需要回传的产物文件清单时调用。
 *
 * @param {Object} run - 当前运行对象（domain.Run）。
 * @param {Object} node - 当前工作流节点定义（domain.WorkflowNode）。
 * @returns {string[]} 所有合法契约产物的工作区相对路径数组。
 */
function artifactOutputFiles(run, node) {
  let targets = [new RepositoryContext({})];
  if (normalizeExecutionScope(node.ExecutionScope) === ExecutionScopeRepositories) {
    targets = run.RepositoryContexts();
  }
  const out = [];
  for (const rc of targets) {
    // Go 对 nil 切片 range 为空操作，JS 用 ?? [] 补空数组。
    for (const contract of node.ArtifactOutputs ?? []) {
      const [rel, ok] = artifactRelPath(rc.WorkspaceDir, contract.Path);
      if (ok) {
        out.push(rel);
      }
    }
  }
  return out;
}

/**
 * 为远端执行机器模式筛选上游输入产物，生成提示词输入清单与待下发的文件列表。
 * 对应本地模式的 materializeInputs，但不会向控制面工作区写盘，也不会应用仓库补丁（远端检出目录为唯一真相源）。
 *
 * @param {Object} wf - 工作流定义对象（domain.WorkflowDefinition）。
 * @param {Object} node - 当前待执行节点定义（domain.WorkflowNode）。
 * @param {Object} run - 当前运行对象（domain.Run）。
 * @returns {[string, RunnerInputFile[]]} 二元组 [去除首尾空白的输入清单 Markdown 文本, 待下发给执行机器的输入文件数组]。
 */
function runnerArtifactInputs(wf, node, run) {
  // Go 的 map[string]bool 译为普通对象 {}。
  const sources = {};
  for (const edge of wf.Edges) {
    if (edge.Target === node.ID) {
      sources[edge.Source] = true;
    }
  }
  // Go strings.Builder 译为字符串数组拼接。
  const manifest = [];
  let files = [];
  for (const artifact of latestInputArtifacts(run.Artifacts, sources, ancestors(wf, node.ID))) {
    if (artifact.Name === "repository-patch") {
      if (!sources[artifact.NodeID]) {
        continue;
      }
      manifest.push(`## ${artifact.NodeID} / repository-patch (${artifact.RepositoryDir})\n\nNo full diff is stored. The run workspace is the source of truth.\n\n${repositoryPatchSummary(artifact)}\n\n`);
      continue;
    }
    const rel = artifactInputRelPath(run, artifact);
    files.push(new RunnerInputFile({ Path: rel, Content: artifact.Content }));
    writeInputManifestEntry(manifest, artifact, rel);
  }
  const [handoffManifest, handoffFiles] = sopHandoffInputs(run);
  manifest.push(handoffManifest);
  files = [...files, ...handoffFiles];
  return [manifest.join("").trim(), files];
}

module.exports = { errOutputNotRegular, errOutputTooLarge, workspaceOutputs, reportedOutputs, newReportedOutputs, artifactRelPath, artifactOutputFiles, runnerArtifactInputs };
