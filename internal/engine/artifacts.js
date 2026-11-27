/**
 * @file artifacts.js
 * 对应 Go 源文件：internal/engine/artifacts.go
 * 作用与职责边界：负责工作流节点产物的全生命周期处理，包括上游产物物化到输入目录与清单生成、
 * 误写到其他路径的交付物找回、产物契约校验、交付物与仓库补丁收集、失败路径尽力冻结产物，
 * 以及上游输入产物的去重筛选与新产物构造。
 * 语法差异说明：
 * - Go 的 `map[string]bool` 与复合键映射均译为普通对象 `{}`（复合键经 `JSON.stringify` 序列化为字符串键）。
 * - Go 的 `atomic.Uint64` 在单线程 JS 中直接用模块级数字变量递增。
 * - Go 的 `(T, error)` / `error` 统一译为返回结果或失败 `throw Error`。
 */

"use strict";

const { createHash } = require("node:crypto"); // Go crypto/sha256
const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath
const { spawnSync } = require("node:child_process"); // Go os/exec
const { Engine } = require("./engine.js"); // 对应 Go 同包的 Engine，engine.js 待翻译
const { Artifact, TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.Artifact/TelemetryEvent，domain 已翻译
const { ExecutionScopeRepositories } = require("../domain/observability.js"); // 对应 Go 的 domain.ExecutionScopeRepositories，domain 已翻译
const { RepositoryContext } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryContext，domain 已翻译
const { EnsureControlDirectory } = require("../runtime/materialize.js"); // 对应 Go 的 runtime.EnsureControlDirectory，runtime 待翻译

const maxArtifactBytes = 1 << 20;

// artifactSeq：并行分支在同一时钟刻度发布产物时保证产物 ID 唯一。
let artifactSeq = 0;

/**
 * 将当前节点的上游产物物化到工作区输入目录，并生成给提示词使用的 Markdown 输入清单。
 * 使用场景：节点执行前准备上游交付物文件、按需应用旧版仓库补丁并挂载 SOP 交接输入。
 *
 * @param {string} workspace - 当前运行的工作区根目录路径。
 * @param {object} wf - 工作流定义对象（domain.WorkflowDefinition）。
 * @param {object} node - 当前待执行的节点定义（domain.WorkflowNode）。
 * @param {object} run - 当前运行实例对象（domain.Run）。
 * @returns {string} 去除首尾空白后的上游输入清单 Markdown 文本。
 * @throws {Error} 补丁应用失败、目标路径非常规文件或文件读写失败时抛出错误。
 */
function materializeInputs(workspace, wf, node, run) {
  const sources = {};
  for (const edge of wf.Edges) {
    if (edge.Target === node.ID) {
      sources[edge.Source] = true;
    }
  }
  const prior = ancestors(wf, node.ID);
  const selected = latestInputArtifacts(run.Artifacts, sources, prior);
  // Go strings.Builder 译为字符串数组拼接。
  const manifest = [];
  for (const artifact of selected) {
    if (artifact.Name === "repository-patch") {
      if (!sources[artifact.NodeID]) {
        continue;
      }
      const repoWorkspace = repositoryWorkspacePath(workspace, new RepositoryContext({ WorkspaceDir: artifact.RepositoryDir }));
      const summary = repositoryPatchSummary(artifact);
      if (workspaceHasRepoWork(repoWorkspace)) {
        manifest.push(`## ${artifact.NodeID} / repository-patch (${artifact.RepositoryDir})\n\nSkipped applying; this run already owns the workspace. Read the files with git status / git diff.\n\n${summary}\n\n`);
        continue;
      }
      const body = repositoryPatchApplyBody(artifact);
      if (looksLikeGitDiff(body)) {
        try {
          applyRepositoryPatch(repoWorkspace, body);
        } catch (err) {
          throw new Error(`apply repository-patch from ${artifact.NodeID} (${artifact.RepositoryDir}): ${err.message}`);
        }
        manifest.push(`## ${artifact.NodeID} / repository-patch (${artifact.RepositoryDir})\n\nApplied a legacy unified diff (sha ${artifact.SHA256}).\n\n${summary}\n\n`);
        continue;
      }
      manifest.push(`## ${artifact.NodeID} / repository-patch (${artifact.RepositoryDir})\n\nNo full diff is stored. The run workspace is the source of truth.\n\n${summary}\n\n`);
      continue;
    }
    const nodeSegment = safePathSegment(nodeControlKey(run, artifact.NodeID));
    const controlSegments = ["inputs", nodeSegment];
    if (artifact.RepositoryDir !== "") {
      controlSegments.push(safePathSegment(artifact.RepositoryDir));
    }
    const inputDir = EnsureControlDirectory(workspace, ...controlSegments);
    const fileName = safePathSegment(artifact.Name) + extensionFor(artifact.MediaType);
    const rel = artifactInputRelPath(run, artifact);
    const target = path.join(inputDir, fileName);
    let info;
    try {
      info = fs.lstatSync(target);
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
    if (info !== undefined) {
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`artifact input path is not a regular file: ${target}`);
      }
      fs.chmodSync(target, 0o600);
    }
    fs.writeFileSync(target, artifact.Content, { mode: 0o600 });
    fs.chmodSync(target, 0o444);
    writeInputManifestEntry(manifest, artifact, rel);
  }
  const handoffManifest = materializeSOPHandoffInputs(workspace, run);
  manifest.push(handoffManifest);
  return manifest.join("").trim();
}

/**
 * 计算上游产物在当前运行工作区中的挂载相对路径。
 * 使用场景：物化上游输入文件并在清单中向 Agent 指明文件路径。
 *
 * @param {object} run - 当前运行实例对象（domain.Run）。
 * @param {object} artifact - 上游产物对象（domain.Artifact）。
 * @returns {string} 相对于运行工作区根目录的正斜杠路径（形如 `.agentflow/inputs/...`）。
 */
function artifactInputRelPath(run, artifact) {
  const segments = [".agentflow", "inputs", safePathSegment(nodeControlKey(run, artifact.NodeID))];
  if (artifact.RepositoryDir !== "") {
    segments.push(safePathSegment(artifact.RepositoryDir));
  }
  segments.push(safePathSegment(artifact.Name) + extensionFor(artifact.MediaType));
  return segments.join("/");
}

/**
 * 向输入清单追加单条产物的元信息条目（路径、SHA256 与字节大小）。
 * 使用场景：由 `materializeInputs` 调用，提示 Agent 按路径读取文件而不在提示词中内联正文。
 *
 * @param {string[]} manifest - 用于累积清单片段的字符串数组。
 * @param {object} artifact - 上游产物对象（domain.Artifact）。
 * @param {string} rel - 产物相对工作区的挂载路径。
 * @returns {void} 无返回值。
 */
function writeInputManifestEntry(manifest, artifact, rel) {
  manifest.push(`## ${artifact.NodeID} / ${artifact.Name}\n\n- path: \`${rel}\`\n- sha256: \`${artifact.SHA256}\`\n- bytes: ${Buffer.byteLength(artifact.Content, "utf8")}\n\nRead this file; the body is not inlined in the prompt.\n\n`);
}

/**
 * 当执行器把声明的交付物误写到宿主机检出目录或工作区嵌套子目录时，将其复制回契约要求的目标路径。
 * 使用场景：节点执行结束后的产物回收阶段（逐仓库作用域节点不执行此收回，避免多仓库同名文件互相覆盖）。
 *
 * @param {string} workspace - 沙箱工作区根目录路径。
 * @param {string} hostLocalPath - 宿主机本地仓库检出路径（为空时仅在工作区内查找）。
 * @param {object} node - 节点定义对象（domain.WorkflowNode）。
 * @returns {string[]} 成功收回的交付物记录列表，每项格式为 `<目标路径> ← <来源路径>`。
 */
function recoverMisplacedArtifacts(workspace, hostLocalPath, node) {
  if (normalizeExecutionScope(node.ExecutionScope) === ExecutionScopeRepositories) {
    return [];
  }
  const recovered = [];
  for (const contract of node.ArtifactOutputs) {
    const clean = path.normalize(contract.Path);
    if (clean === "." || path.isAbsolute(clean) || clean.startsWith("..")) {
      continue;
    }
    const dest = path.join(workspace, clean);
    try {
      fs.statSync(dest);
      continue;
    } catch {}
    const base = path.basename(clean);
    const candidates = [findNamedFile(workspace, base, 4)];
    const host = hostLocalPath.trim();
    if (host !== "") {
      candidates.push(path.join(host, clean), path.join(host, base), findNamedFile(host, base, 2));
    }
    for (const src of candidates) {
      if (src === "" || src === dest) {
        continue;
      }
      let info;
      try {
        info = fs.statSync(src);
      } catch {
        continue;
      }
      if (info.isDirectory() || info.size > maxArtifactBytes) {
        continue;
      }
      let data;
      try {
        data = fs.readFileSync(src);
      } catch {
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
      } catch {
        continue;
      }
      try {
        fs.writeFileSync(dest, data, { mode: 0o644 });
      } catch {
        continue;
      }
      recovered.push(contract.Path + " ← " + src);
      removeUntrackedHostLeak(hostLocalPath, src);
      break;
    }
  }
  return recovered;
}

/**
 * 在指定根目录下按字典序深度优先查找首个匹配文件名的文件（跳过 `.git`、`node_modules`、`.agentflow`）。
 * 使用场景：由 `recoverMisplacedArtifacts` 在工作区或宿主机目录内搜索放错位置的交付物。
 *
 * @param {string} root - 搜索根目录路径。
 * @param {string} name - 要匹配的文件基名。
 * @param {number} maxDepth - 最大目录遍历深度。
 * @returns {string} 找到的文件完整路径；未找到或入参无效时返回空字符串。
 */
function findNamedFile(root, name, maxDepth) {
  if (root.trim() === "" || name === "") {
    return "";
  }
  let found = "";
  // Go filepath.WalkDir 按字典序深度优先遍历；用帧栈模拟，读目录失败即停止。
  const readEntries = (dir) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return entries;
    } catch {
      return null;
    }
  };
  const rootEntries = readEntries(root);
  if (rootEntries === null) {
    return "";
  }
  const frames = [{ dir: root, entries: rootEntries, index: 0 }];
  while (frames.length > 0 && found === "") {
    const frame = frames[frames.length - 1];
    if (frame.index >= frame.entries.length) {
      frames.pop();
      continue;
    }
    const d = frame.entries[frame.index++];
    const p = path.join(frame.dir, d.name);
    if (d.isDirectory()) {
      const base = d.name;
      if ((base === ".git" || base === "node_modules" || base === ".agentflow") && p !== root) {
        continue;
      }
      const rel = path.relative(root, p);
      if (rel !== "." && rel.split(path.sep).length >= maxDepth) {
        continue;
      }
      const entries = readEntries(p);
      if (entries === null) {
        break;
      }
      frames.push({ dir: p, entries, index: 0 });
      continue;
    }
    if (d.name === name) {
      found = p;
    }
  }
  return found;
}

/**
 * 清理误写到宿主机仓库中且未被 Git 跟踪的泄露文件。
 * 使用场景：交付物从宿主机目录收回至沙箱后调用，避免污染宿主机工作树。
 *
 * @param {string} host - 宿主机仓库根目录路径。
 * @param {string} target - 被收回文件的路径（Go 原参数名为 `path`，为避免遮蔽 `node:path` 局部改名为 `target`）。
 * @returns {void} 无返回值。
 */
function removeUntrackedHostLeak(host, target) {
  host = host.trim();
  if (host === "" || target === "") {
    return;
  }
  const rel = path.relative(host, target);
  if (rel.startsWith("..")) {
    return;
  }
  let tracked;
  try {
    tracked = spawnSync("git", ["-C", host, "ls-files", "--error-unmatch", rel]);
  } catch {
    tracked = null;
  }
  if (tracked == null || tracked.status !== 0) {
    try {
      fs.unlinkSync(target);
    } catch {}
  }
}

/**
 * 在节点失败或中断路径上尽力收回并冻结已生成的可用产物，并写入运行记录与遥测事件。
 * 使用场景：节点执行失败、校验门禁未通过等异常退出路径，保留已经产出的中间成果供排查或返工复用。
 *
 * @param {string} runID - 运行实例 ID。
 * @param {object} node - 当前节点定义对象（domain.WorkflowNode）。
 * @param {string} workspace - 工作区根目录路径。
 * @param {object|null} reported - Runner 上报的产物对象（reportedOutputs）；本地执行时为 `null`。
 * @param {string} output - 节点执行输出文本。
 * @returns {void} 无返回值。
 */
Engine.prototype.freezeAvailableArtifacts = function (runID, node, workspace, reported, output) {
  const [current, ok] = this.repo.RunState(runID);
  if (!ok) {
    return;
  }
  let outputs = workspaceOutputs(workspace);
  let recovered = [];
  if (reported != null) {
    outputs = reported;
    // Go 的 len(nil 切片) 为 0，JS 取空数组等价。
    recovered = reported.takeRecovered() ?? [];
  } else {
    recovered = recoverMisplacedArtifacts(workspace, current.Repository.LocalPath, node) ?? [];
  }
  if (recovered.length > 0) {
    this.observe(runID, node.ID, new TelemetryEvent({ Category: "artifact", Name: "artifact.recovered", Phase: "progress", Message: "失败路径收回交付物：" + recovered.join("；") }));
  }
  let artifacts;
  try {
    artifacts = collectArtifactsMode(outputs, current, node, output, true);
  } catch {
    return;
  }
  if (artifacts == null || artifacts.length === 0) {
    return;
  }
  this.updateRun(runID, (r) => {
    r.Artifacts = [...r.Artifacts, ...artifacts];
  });
  for (const artifact of artifacts) {
    this.observe(runID, node.ID, new TelemetryEvent({ Category: "artifact", Name: "artifact.published", Phase: "finish", Message: artifact.Name, Attributes: { artifactId: artifact.ID, path: artifact.Path, mediaType: artifact.MediaType, size: artifact.Size, sha256: artifact.SHA256 } }));
  }
};

/**
 * 在验证门禁执行前校验本地工作区是否满足节点的产物契约。
 * 使用场景：节点主执行完成后、运行验证门禁之前调用，防止门禁脚本代为生成缺失的交付物。
 *
 * @param {string} workspace - 工作区根目录路径。
 * @param {object} run - 运行实例对象（domain.Run）。
 * @param {object} node - 节点定义对象（domain.WorkflowNode）。
 * @returns {void} 无返回值。
 * @throws {Error} 缺少必需产物、路径非法、文件非常规文件或超出大小上限时抛出错误。
 */
function validateArtifactContracts(workspace, run, node) {
  return validateArtifactOutputs(workspaceOutputs(workspace), run, node);
}

/**
 * 基于抽象产物读取接口校验节点的全部产物输出契约。
 * 使用场景：统一支持本地工作区与 Runner 上报产物的契约校验。
 *
 * @param {object} outputs - 实现 `readFile` 方法的产物读取器（nodeOutputs）。
 * @param {object} run - 运行实例对象（domain.Run）。
 * @param {object} node - 节点定义对象（domain.WorkflowNode）。
 * @returns {void} 无返回值。
 * @throws {Error} 逐仓库产物未绑定仓库、契约路径非法、必需文件缺失或读取失败时抛出错误。
 */
function validateArtifactOutputs(outputs, run, node) {
  const contracts = node.ArtifactOutputs;
  let contractTargets = [new RepositoryContext()];
  if (normalizeExecutionScope(node.ExecutionScope) === ExecutionScopeRepositories) {
    contractTargets = run.RepositoryContexts();
    if (contractTargets.length === 0 && contracts.length > 0) {
      throw new Error("逐仓库产物需要 Run 至少绑定一个代码仓库");
    }
  }
  for (const rc of contractTargets) {
    for (const contract of contracts) {
      const [rel, ok] = artifactRelPath(rc.WorkspaceDir, contract.Path);
      if (contract.Name === "" || !ok) {
        throw new Error(`invalid artifact ${JSON.stringify(contract.Name)} path ${JSON.stringify(contract.Path)}`);
      }
      try {
        outputs.readFile(rel);
      } catch (err) {
        // Go errors.Is(err, fs.ErrNotExist) 译为 err.code === "ENOENT"；errors.Is 译为 ===。
        if (err.code === "ENOENT" && !contract.Required) {
          continue;
        }
        if (err === errOutputNotRegular) {
          throw new Error(`${contract.Name} (${rc.WorkspaceDir}) is not a regular file`);
        }
        if (err === errOutputTooLarge) {
          throw new Error(`${contract.Name} exceeds ${maxArtifactBytes} bytes`);
        }
        throw new Error(`${contract.Name} (${rc.WorkspaceDir}): ${err.message}`);
      }
    }
  }
}

/**
 * 严格模式收集本地工作区中的节点产物与仓库补丁。
 * 使用场景：节点成功完成后的正式产物收集。
 *
 * @param {string} workspace - 工作区根目录路径。
 * @param {object} run - 运行实例对象（domain.Run）。
 * @param {object} node - 节点定义对象（domain.WorkflowNode）。
 * @param {string} output - 节点标准输出文本。
 * @returns {Artifact[]} 收集到的产物对象数组。
 * @throws {Error} 契约校验或补丁收集失败时抛出错误。
 */
function collectArtifacts(workspace, run, node, output) {
  return collectArtifactsMode(workspaceOutputs(workspace), run, node, output, false);
}

/**
 * 尽力模式收集本地工作区中的可用节点产物与仓库补丁，忽略缺失或异常项。
 * 使用场景：节点异常退出或部分产出时尽量保留已有交付物。
 *
 * @param {string} workspace - 工作区根目录路径。
 * @param {object} run - 运行实例对象（domain.Run）。
 * @param {object} node - 节点定义对象（domain.WorkflowNode）。
 * @param {string} output - 节点标准输出文本。
 * @returns {Artifact[]} 收集到的可用产物对象数组（无可用产物时返回空数组）。
 */
function collectArtifactsBestEffort(workspace, run, node, output) {
  return collectArtifactsMode(workspaceOutputs(workspace), run, node, output, true);
}

/**
 * 按指定模式（严格模式或尽力模式）从产物读取器收集交付物与仓库补丁产物。
 * 使用场景：由 `collectArtifacts`、`collectArtifactsBestEffort` 及 `freezeAvailableArtifacts` 调用。
 *
 * @param {object} outputs - 产物读取器（nodeOutputs），需提供 `readFile` 与 `repositoryPatch` 方法。
 * @param {object} run - 运行实例对象（domain.Run）。
 * @param {object} node - 节点定义对象（domain.WorkflowNode）。
 * @param {string} output - 节点执行输出文本（无声明契约且非尽力模式时作为 `result.md` 兜底产物）。
 * @param {boolean} bestEffort - 是否启用尽力模式（忽略缺失或超限项且不生成兜底 `result.md`）。
 * @returns {Artifact[]} 收集到的产物对象数组；尽力模式无产物时返回空数组。
 * @throws {Error} 严格模式下遇到契约非法、必需文件缺失、体积超限或补丁读取错误时抛出错误。
 */
function collectArtifactsMode(outputs, run, node, output, bestEffort) {
  let attempt = 0;
  const nr = run.Nodes[node.ID];
  if (nr != null) {
    attempt = nr.Attempt;
  }
  const contracts = node.ArtifactOutputs;
  const out = [];
  if (contracts.length === 0 && !bestEffort) {
    out.push(newArtifact(run.ID, node.ID, attempt, "result", "result.md", "text/markdown", output));
  }
  let contractTargets = [new RepositoryContext()];
  if (normalizeExecutionScope(node.ExecutionScope) === ExecutionScopeRepositories) {
    contractTargets = run.RepositoryContexts();
    if (contractTargets.length === 0 && contracts.length > 0 && !bestEffort) {
      throw new Error("逐仓库产物需要 Run 至少绑定一个代码仓库");
    }
  }
  for (const rc of contractTargets) {
    for (const contract of contracts) {
      const [rel, ok] = artifactRelPath(rc.WorkspaceDir, contract.Path);
      if (contract.Name === "" || !ok) {
        if (bestEffort) {
          continue;
        }
        throw new Error(`invalid artifact ${JSON.stringify(contract.Name)} path ${JSON.stringify(contract.Path)}`);
      }
      const clean = path.normalize(contract.Path);
      let content;
      try {
        content = outputs.readFile(rel);
      } catch (err) {
        if (bestEffort || (err.code === "ENOENT" && !contract.Required)) {
          continue;
        }
        if (err === errOutputTooLarge) {
          throw new Error(`${contract.Name} exceeds ${maxArtifactBytes} bytes`);
        }
        throw new Error(`${contract.Name} (${rc.WorkspaceDir}): ${err.message}`);
      }
      if (Buffer.byteLength(content) > maxArtifactBytes) {
        if (bestEffort) {
          continue;
        }
        throw new Error(`${contract.Name} exceeds ${maxArtifactBytes} bytes`);
      }
      let mediaType = contract.MediaType;
      if (mediaType === "") {
        mediaType = "text/markdown";
      }
      const artifact = newArtifact(run.ID, node.ID, attempt, contract.Name, clean, mediaType, content);
      artifact.RepositoryDir = rc.WorkspaceDir;
      out.push(artifact);
    }
  }
  let patchTargets = run.RepositoryContexts();
  if (patchTargets.length === 0) {
    patchTargets = [new RepositoryContext()];
  }
  for (const rc of patchTargets) {
    let patch;
    try {
      patch = outputs.repositoryPatch(rc.WorkspaceDir);
    } catch (err) {
      if (!bestEffort) {
        throw err;
      }
      continue;
    }
    if (patch.length === 0) {
      continue;
    }
    let name = "repository.patch";
    if (rc.WorkspaceDir !== "") {
      name = `repository-${rc.WorkspaceDir}.patch`;
    }
    const artifact = newArtifact(run.ID, node.ID, attempt, "repository-patch", name, "text/plain", patch);
    artifact.RepositoryDir = rc.WorkspaceDir;
    out.push(artifact);
  }
  if (out.length === 0) {
    if (bestEffort) {
      // Go 返回 nil 切片，JS 切片零值为 []。
      return [];
    }
    out.push(newArtifact(run.ID, node.ID, attempt, "result", "result.md", "text/markdown", output));
  }
  return out;
}

/**
 * 筛选并去重上游节点输入产物，按 `(NodeID, RepositoryDir, Name, Path)` 保留最新一次尝试的产物并排序。
 * 使用场景：物化上游产物前过滤出对当前节点可见且最新的产物集合。
 *
 * @param {Artifact[]} artifacts - 运行实例中的全部历史产物列表。
 * @param {Object<string, boolean>} direct - 当前节点的直接前驱节点 ID 集合。
 * @param {Object<string, boolean>} prior - 当前节点的全部祖先节点 ID 集合。
 * @returns {Artifact[]} 按 `NodeID`、`RepositoryDir`、`Name` 升序排列的去重产物数组。
 */
function latestInputArtifacts(artifacts, direct, prior) {
  const best = {};
  for (const artifact of artifacts) {
    if (!includeArtifact(direct, prior, artifact)) {
      continue;
    }
    const k = JSON.stringify([artifact.NodeID, artifact.RepositoryDir, artifact.Name, artifact.Path]);
    const prev = best[k];
    if (prev === undefined || artifact.Attempt > prev.Attempt || (artifact.Attempt === prev.Attempt && artifact.CreatedAt > prev.CreatedAt)) {
      best[k] = artifact;
    }
  }
  const out = Object.values(best);
  out.sort((a, b) => {
    if (a.NodeID !== b.NodeID) {
      return a.NodeID < b.NodeID ? -1 : 1;
    }
    if (a.RepositoryDir !== b.RepositoryDir) {
      return a.RepositoryDir < b.RepositoryDir ? -1 : 1;
    }
    if (a.Name !== b.Name) {
      return a.Name < b.Name ? -1 : 1;
    }
    return 0;
  });
  return out;
}

/**
 * 判断某条上游产物是否应纳入当前节点的输入范围。
 * 使用场景：直接前驱的全部产物均纳入；非直接祖先节点仅纳入非 `repository-patch` 产物。
 *
 * @param {Object<string, boolean>} direct - 直接前驱节点 ID 集合。
 * @param {Object<string, boolean>} prior - 全部祖先节点 ID 集合。
 * @param {Artifact} artifact - 待判断的产物对象。
 * @returns {boolean} 应纳入输入时返回 `true`，否则返回 `false`。
 */
function includeArtifact(direct, prior, artifact) {
  if (direct[artifact.NodeID]) {
    return true;
  }
  return Boolean(prior[artifact.NodeID]) && artifact.Name !== "repository-patch";
}

/**
 * 获取产物在提示词中展示的正文内容。
 * 使用场景：对 `repository-patch` 产物仅返回摘要，其余产物返回完整正文。
 *
 * @param {Artifact} artifact - 产物对象。
 * @returns {string} 适合展示在提示词中的文本内容。
 */
function artifactPromptBody(artifact) {
  if (artifact.Name === "repository-patch") {
    return repositoryPatchSummary(artifact);
  }
  return artifact.Content;
}

/**
 * 构造新的产物实例，自动生成唯一 ID、计算内容字节大小与 SHA256 摘要并记录 UTC 创建时间。
 * 使用场景：节点收集交付物、补丁或追加系统产物时调用。
 *
 * @param {string} runID - 所属运行实例 ID。
 * @param {string} nodeID - 产出该产物的节点 ID。
 * @param {number} attempt - 节点执行尝试次数。
 * @param {string} name - 产物逻辑名称。
 * @param {string} path - 产物相对路径。
 * @param {string} mediaType - 产物媒体类型（MIME）。
 * @param {Buffer|string} content - 产物原始内容。
 * @returns {Artifact} 新构造的产物实例。
 */
function newArtifact(runID, nodeID, attempt, name, path, mediaType, content) {
  const sum = createHash("sha256").update(content).digest("hex");
  const now = new Date();
  return new Artifact({ ID: `artifact-${now.getTime() * 1000000}-${++artifactSeq}`, RunID: runID, NodeID: nodeID, Attempt: attempt, Name: name, Path: path, MediaType: mediaType, Size: Buffer.byteLength(content), SHA256: sum, Content: content.toString(), CreatedAt: now });
}

/**
 * 构造新产物并追加到运行实例的产物列表中。
 * 使用场景：引擎在节点执行或系统流程中向 `run.Artifacts` 直接追加记录。
 *
 * @param {object} run - 运行实例对象（domain.Run）。
 * @param {string} nodeID - 产出该产物的节点 ID。
 * @param {number} attempt - 节点执行尝试次数。
 * @param {string} name - 产物逻辑名称。
 * @param {string} path - 产物相对路径。
 * @param {string} mediaType - 产物媒体类型（MIME）。
 * @param {Buffer|string} content - 产物原始内容。
 * @returns {void} 无返回值。
 */
function appendArtifact(run, nodeID, attempt, name, path, mediaType, content) {
  run.Artifacts = [...run.Artifacts, newArtifact(run.ID, nodeID, attempt, name, path, mediaType, content)];
}

module.exports = { maxArtifactBytes, materializeInputs, artifactInputRelPath, writeInputManifestEntry, recoverMisplacedArtifacts, findNamedFile, removeUntrackedHostLeak, validateArtifactContracts, validateArtifactOutputs, collectArtifacts, collectArtifactsBestEffort, collectArtifactsMode, latestInputArtifacts, includeArtifact, artifactPromptBody, newArtifact, appendArtifact };
