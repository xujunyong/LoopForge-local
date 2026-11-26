// node_outputs.js —— 对应 Go 文件：internal/engine/node_outputs.go
// 作用：节点产物读取：控制面沙箱工作区，或执行机器上报的产物。

"use strict";

const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath

const { RepositoryContext } = require("../domain/project.js"); // 对应 Go 的 domain.RepositoryContext，project.js 已翻译
const { ExecutionScopeRepositories } = require("../domain/observability.js"); // 对应 Go 的 domain.ExecutionScopeRepositories，observability.js 已翻译
const { RunnerInputFile } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerInputFile，runner.js 已翻译

const errOutputNotRegular = new Error("is not a regular file");
const errOutputTooLarge = new Error("exceeds artifact size limit");

// nodeOutputs：Go 接口，workspaceOutputs 与 reportedOutputs 都实现它；JS 里只用鸭子类型。
function workspaceOutputs(value) {
  return {
    readFile(rel) {
      const full = path.join(value, rel);
      const info = fs.statSync(full);
      if (!info.isFile()) {
        throw errOutputNotRegular;
      }
      if (info.size > maxArtifactBytes) {
        throw errOutputTooLarge;
      }
      return fs.readFileSync(full);
    },
    repositoryPatch(dir) {
      return collectRepositoryPatch(repositoryWorkspacePath(value, new RepositoryContext({ WorkspaceDir: dir })));
    },
  };
}

// reportedOutputs：执行机器上报的产物；JS 单线程，Go 的 sync.Mutex 省略。
class reportedOutputs {
  constructor(init = {}) {
    this.inputs = init.inputs ?? [];
    this.files = {};
    this.tooLarge = {};
    this.patches = {};
    this.recovered = null;
  }

  reset() {
    this.files = {};
    this.tooLarge = {};
    this.patches = {};
    this.recovered = null;
  }

  absorb(outputs) {
    if (outputs == null) {
      return;
    }
    // Go 对 nil map range 为空操作，JS 用 ?? 补空集合。
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
    this.recovered = [...(this.recovered ?? []), ...(outputs.Recovered ?? [])];
  }

  takeRecovered() {
    const out = this.recovered;
    this.recovered = null;
    // Go 返回 nil 切片时 len 为 0，JS 用 [] 代替 null。
    return out ?? [];
  }

  readFile(rel) {
    if (this.tooLarge[rel]) {
      throw errOutputTooLarge;
    }
    if (!Object.hasOwn(this.files, rel)) {
      // Go 的 &fs.PathError{Op: "read", Err: fs.ErrNotExist}。
      const err = new Error(`read ${rel}: no such file or directory`);
      err.code = "ENOENT";
      throw err;
    }
    return Buffer.from(this.files[rel], "utf8");
  }

  repositoryPatch(dir) {
    // Go 读缺失的 map 键得 ""，JS 用 ?? 补 ""。
    const patch = this.patches[dir] ?? "";
    if (patch !== "") {
      return Buffer.from(patch, "utf8");
    }
    // Go 返回 nil []byte，调用方按 len 为 0 处理，JS 用空 Buffer 代替 null。
    return Buffer.alloc(0);
  }
}

function newReportedOutputs(inputs) {
  const r = new reportedOutputs({ inputs });
  r.reset();
  return r;
}

function artifactRelPath(repositoryDir, contractPath) {
  const clean = path.posix.normalize(contractPath.trim());
  if (clean === "." || clean === ".." || path.posix.isAbsolute(clean) || clean.startsWith("../")) {
    return ["", false];
  }
  const dir = repositoryDir.trim().replace(/^\/+|\/+$/g, "");
  if (dir !== "") {
    return [path.posix.join(dir, clean), true];
  }
  return [clean, true];
}

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

function runnerArtifactInputs(wf, node, run) {
  const sources = new Set();
  for (const edge of wf.Edges) {
    if (edge.Target === node.ID) {
      sources.add(edge.Source);
    }
  }
  // Go strings.Builder 译为字符串数组拼接。
  const manifest = [];
  let files = [];
  for (const artifact of latestInputArtifacts(run.Artifacts, sources, ancestors(wf, node.ID))) {
    if (artifact.Name === "repository-patch") {
      if (!sources.has(artifact.NodeID)) {
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
