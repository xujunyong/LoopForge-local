// artifacts.js —— 对应 Go 文件：internal/engine/artifacts.go
// 作用：节点产物：上游产物物化为输入、交付物收集与校验、放错位置的产物找回。

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

// artifactSeq：并行分支同一时钟刻度发布时保证 ID 唯一。
let artifactSeq = 0;

function materializeInputs(workspace, wf, node, run) {
  const sources = new Set();
  for (const edge of wf.Edges) {
    if (edge.Target === node.ID) {
      sources.add(edge.Source);
    }
  }
  const prior = ancestors(wf, node.ID);
  const selected = latestInputArtifacts(run.Artifacts, sources, prior);
  // Go strings.Builder 译为字符串数组拼接。
  const manifest = [];
  for (const artifact of selected) {
    if (artifact.Name === "repository-patch") {
      if (!sources.has(artifact.NodeID)) {
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

function artifactInputRelPath(run, artifact) {
  const segments = [".agentflow", "inputs", safePathSegment(nodeControlKey(run, artifact.NodeID))];
  if (artifact.RepositoryDir !== "") {
    segments.push(safePathSegment(artifact.RepositoryDir));
  }
  segments.push(safePathSegment(artifact.Name) + extensionFor(artifact.MediaType));
  return segments.join("/");
}

function writeInputManifestEntry(manifest, artifact, rel) {
  manifest.push(`## ${artifact.NodeID} / ${artifact.Name}\n\n- path: \`${rel}\`\n- sha256: \`${artifact.SHA256}\`\n- bytes: ${Buffer.byteLength(artifact.Content, "utf8")}\n\nRead this file; the body is not inlined in the prompt.\n\n`);
}

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
  if (artifacts.length === 0) {
    return;
  }
  this.updateRun(runID, (r) => {
    r.Artifacts = [...r.Artifacts, ...artifacts];
  });
  for (const artifact of artifacts) {
    this.observe(runID, node.ID, new TelemetryEvent({ Category: "artifact", Name: "artifact.published", Phase: "finish", Message: artifact.Name, Attributes: { artifactId: artifact.ID, path: artifact.Path, mediaType: artifact.MediaType, size: artifact.Size, sha256: artifact.SHA256 } }));
  }
};

function validateArtifactContracts(workspace, run, node) {
  return validateArtifactOutputs(workspaceOutputs(workspace), run, node);
}

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

function collectArtifacts(workspace, run, node, output) {
  return collectArtifactsMode(workspaceOutputs(workspace), run, node, output, false);
}

function collectArtifactsBestEffort(workspace, run, node, output) {
  return collectArtifactsMode(workspaceOutputs(workspace), run, node, output, true);
}

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
      return null;
    }
    out.push(newArtifact(run.ID, node.ID, attempt, "result", "result.md", "text/markdown", output));
  }
  return out;
}

function latestInputArtifacts(artifacts, direct, prior) {
  const best = new Map();
  for (const artifact of artifacts) {
    if (!includeArtifact(direct, prior, artifact)) {
      continue;
    }
    const k = JSON.stringify([artifact.NodeID, artifact.RepositoryDir, artifact.Name, artifact.Path]);
    const prev = best.get(k);
    if (prev === undefined || artifact.Attempt > prev.Attempt || (artifact.Attempt === prev.Attempt && artifact.CreatedAt > prev.CreatedAt)) {
      best.set(k, artifact);
    }
  }
  const out = [...best.values()];
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

function includeArtifact(direct, prior, artifact) {
  if (direct.has(artifact.NodeID)) {
    return true;
  }
  return prior.has(artifact.NodeID) && artifact.Name !== "repository-patch";
}

function artifactPromptBody(artifact) {
  if (artifact.Name === "repository-patch") {
    return repositoryPatchSummary(artifact);
  }
  return artifact.Content;
}

function newArtifact(runID, nodeID, attempt, name, path, mediaType, content) {
  const sum = createHash("sha256").update(content).digest("hex");
  const now = new Date();
  return new Artifact({ ID: `artifact-${now.getTime() * 1000000}-${++artifactSeq}`, RunID: runID, NodeID: nodeID, Attempt: attempt, Name: name, Path: path, MediaType: mediaType, Size: Buffer.byteLength(content), SHA256: sum, Content: content.toString(), CreatedAt: now });
}

function appendArtifact(run, nodeID, attempt, name, path, mediaType, content) {
  run.Artifacts = [...run.Artifacts, newArtifact(run.ID, nodeID, attempt, name, path, mediaType, content)];
}

module.exports = { maxArtifactBytes, materializeInputs, artifactInputRelPath, writeInputManifestEntry, recoverMisplacedArtifacts, findNamedFile, removeUntrackedHostLeak, validateArtifactContracts, validateArtifactOutputs, collectArtifacts, collectArtifactsBestEffort, collectArtifactsMode, latestInputArtifacts, includeArtifact, artifactPromptBody, newArtifact, appendArtifact };
