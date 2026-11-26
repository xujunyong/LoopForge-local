// legacy_handoff.js —— 对应 Go 文件：internal/engine/legacy_handoff.go
// 作用：已归档自由协作交接的只读兼容：校验、分片重组、发给 SOP 节点与子 SOP。
// (值, error) 译为成功返回值、失败 throw；(值, 值, error) 译为 [值, 值]、失败 throw；json.Unmarshal 失败译为 throw。

"use strict";

const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath
const { RunnerInputFile } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerInputFile，runner.js 已翻译
const { WorkspaceContentSHA } = require("../runtime/workspace_edit.js"); // 对应 Go 的 runtime.WorkspaceContentSHA，runtime 未翻译
const { WorkspaceCheckpointMaxBytes } = require("../runtime/workspace_checkpoint.js"); // 对应 Go 的 runtime.WorkspaceCheckpointMaxBytes，runtime 未翻译
const { EnsureControlDirectory } = require("../runtime/materialize.js"); // 对应 Go 的 runtime.EnsureControlDirectory，runtime 未翻译

const groupSOPHandoffNode = "group-handoff";

class sopHandoffTranscriptPart {
  constructor(init = {}) {
    this.Name = init.Name ?? "";
    this.Path = init.Path ?? "";
    this.InputPath = init.InputPath ?? "";
    this.SHA256 = init.SHA256 ?? "";
  }
}

class sopHandoffTranscriptManifest {
  constructor(init = {}) {
    this.Format = init.Format ?? "";
    this.Bytes = init.Bytes ?? 0;
    this.SHA256 = init.SHA256 ?? "";
    this.Parts = init.Parts ?? [];
  }
}

const sopHandoffTranscriptFormat = "agentflow.sop-handoff.transcript/v1";

function archivedSOPHandoffArtifacts(run) {
  const ref = run.WorkflowSnapshot.GroupSOPHandoff;
  if (ref == null) {
    return null;
  }
  const selected = [];
  for (const expected of [
    { id: ref.SummaryArtifactID, path: ref.SummaryPath, name: "sop-handoff" },
    { id: ref.TranscriptArtifactID, path: ref.TranscriptPath, name: "sop-handoff-conversation" },
  ]) {
    let found = false;
    for (const a of run.Artifacts) {
      if (a.ID === expected.id && a.Path === expected.path && a.Name === expected.name && a.NodeID === groupSOPHandoffNode && a.SHA256 === WorkspaceContentSHA(a.Content)) {
        selected.push(a);
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error("自由协作交接归档缺失或校验失败，不能启动 SOP");
    }
  }
  let manifest;
  try {
    manifest = new sopHandoffTranscriptManifest(JSON.parse(selected[1].Content));
  } catch (err) {
    throw new Error("自由协作交接归档格式无效");
  }
  if (manifest.Format === "") {
    return selected;
  }
  if (manifest.Format !== sopHandoffTranscriptFormat || manifest.Parts.length < 2 || manifest.Parts.length > 16 || manifest.Bytes > WorkspaceCheckpointMaxBytes) {
    throw new Error("自由协作交接归档清单无效");
  }
  for (let i = 0; i < manifest.Parts.length; i++) {
    const part = manifest.Parts[i];
    if (part.Name !== `sop-handoff-conversation-part-${String(i + 1).padStart(3, "0")}` || part.Path !== path.join(path.dirname(ref.TranscriptPath), `conversation.part-${String(i + 1).padStart(3, "0")}.txt`).split(path.sep).join("/") || part.InputPath !== sopHandoffInputPath(ref, part.Name)) {
      throw new Error("自由协作交接归档分片路径无效");
    }
    let found = false;
    for (const a of run.Artifacts) {
      if (a.Name === part.Name && a.Path === part.Path && a.NodeID === groupSOPHandoffNode && a.SHA256 === part.SHA256 && a.SHA256 === WorkspaceContentSHA(a.Content) && Buffer.byteLength(a.Content, "utf8") <= maxArtifactBytes) {
        selected.push(a);
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error("自由协作交接归档分片缺失或校验失败");
    }
  }
  readSOPHandoffTranscript(selected);
  return selected;
}

function readSOPHandoffTranscript(artifacts) {
  if (artifacts.length < 2) {
    throw new Error("自由协作交接归档不完整");
  }
  const root = Buffer.from(artifacts[1].Content, "utf8");
  let manifest;
  try {
    manifest = new sopHandoffTranscriptManifest(JSON.parse(root.toString("utf8")));
  } catch (err) {
    throw err;
  }
  if (manifest.Format === "") {
    return root;
  }
  if (manifest.Format !== sopHandoffTranscriptFormat || artifacts.length !== manifest.Parts.length + 2 || manifest.Bytes < 0 || manifest.Bytes > WorkspaceCheckpointMaxBytes) {
    throw new Error("自由协作交接归档清单无效");
  }
  let full = "";
  for (const part of artifacts.slice(2)) {
    if (Buffer.byteLength(full, "utf8") + Buffer.byteLength(part.Content, "utf8") > WorkspaceCheckpointMaxBytes) {
      throw new Error("自由协作交接归档过大");
    }
    full += part.Content;
  }
  if (Buffer.byteLength(full, "utf8") !== manifest.Bytes || WorkspaceContentSHA(full) !== manifest.SHA256) {
    throw new Error("自由协作交接完整归档校验失败");
  }
  return Buffer.from(full, "utf8");
}

// sopHandoffInputs：输入与图谱血缘无关，每次派发都用归档内容，重试与重建/远程工作区也能保留交接。
function sopHandoffInputs(run) {
  const ref = run.WorkflowSnapshot.GroupSOPHandoff;
  if (ref == null || run.WorkflowSnapshot.CollaborationMode === "group") {
    return ["", null];
  }
  const manifest = [];
  const files = [];
  const artifacts = archivedSOPHandoffArtifacts(run);
  for (const a of artifacts) {
    const inputPath = sopHandoffInputPath(ref, a.Name);
    files.push(new RunnerInputFile({ Path: inputPath, Content: a.Content }));
    writeInputManifestEntry(manifest, a, inputPath);
  }
  return [manifest.join(""), files];
}

function sopHandoffInputPath(ref, name) {
  let ext = ".md";
  if (name === "sop-handoff-conversation") {
    ext = ".json";
  } else if (name.startsWith("sop-handoff-conversation-part-")) {
    ext = ".txt";
  }
  return ".agentflow/inputs/group-handoff/" + safePathSegment(ref.ID) + "-" + safePathSegment(name) + ext;
}

function validateSOPHandoffArtifacts(run) {
  const ref = run.WorkflowSnapshot.GroupSOPHandoff;
  if (ref == null || run.WorkflowSnapshot.CollaborationMode === "group") {
    return;
  }
  archivedSOPHandoffArtifacts(run);
}

function materializeSOPHandoffInputs(workspace, run) {
  validateSOPHandoffArtifacts(run);
  const [manifest, files] = sopHandoffInputs(run);
  if (files == null || files.length === 0) {
    return "";
  }
  const dir = EnsureControlDirectory(workspace, "inputs", groupSOPHandoffNode);
  for (const f of files) {
    const target = path.join(dir, path.basename(f.Path));
    let info;
    try {
      info = fs.lstatSync(target);
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
    if (info !== undefined) {
      if (!info.isFile()) {
        throw new Error(`交接输入不是普通文件：${f.Path}`);
      }
      fs.chmodSync(target, 0o600);
    }
    fs.writeFileSync(target, f.Content, { mode: 0o600 });
    fs.chmodSync(target, 0o444);
  }
  return manifest;
}

// inheritSOPHandoff：子 SOP 在 master 上有独立工作区，调度其首节点前把同一份交接冻结进子 SOP，不假设父目录文件可见。
function inheritSOPHandoff(parent, child) {
  const ref = parent.WorkflowSnapshot.GroupSOPHandoff;
  if (ref == null) {
    return;
  }
  if (parent.ExecutionContext.ProjectID !== child.ExecutionContext.ProjectID) {
    throw new Error("交接上下文不能跨项目继承");
  }
  validateSOPHandoffArtifacts(parent);
  const selected = archivedSOPHandoffArtifacts(parent);
  const copy = { ...ref };
  for (const a of selected) {
    const cloned = newArtifact(child.ID, groupSOPHandoffNode, 0, a.Name, a.Path, a.MediaType, Buffer.from(a.Content, "utf8"));
    child.Artifacts = [...child.Artifacts, cloned];
    if (a.ID === ref.SummaryArtifactID) {
      copy.SummaryArtifactID = cloned.ID;
    }
    if (a.ID === ref.TranscriptArtifactID) {
      copy.TranscriptArtifactID = cloned.ID;
    }
  }
  child.WorkflowSnapshot.GroupSOPHandoff = copy;
}

// validateSOPHandoffRunnerPayload：已发 Runner 客户端单次 claim 响应上限 8 MiB；长对话拆分后仍不得排入那些客户端永远解不出的任务，预留 4 KiB 给 claim 时附加的 lease 字段。
function validateSOPHandoffRunnerPayload(run, task) {
  if (run.WorkflowSnapshot.GroupSOPHandoff == null) {
    return;
  }
  let payload;
  try {
    payload = JSON.stringify({ task: task });
  } catch (err) {
    throw err;
  }
  if (Buffer.byteLength(payload, "utf8") > (8 << 20) - (4 << 10)) {
    throw new Error("完整交接输入超出执行机器的 8 MiB 任务响应上限；原始归档完整保留，未截断，请查看交接摘要与归档后调整继续任务");
  }
}

module.exports = { groupSOPHandoffNode, sopHandoffTranscriptPart, sopHandoffTranscriptManifest, sopHandoffTranscriptFormat, archivedSOPHandoffArtifacts, readSOPHandoffTranscript, sopHandoffInputs, sopHandoffInputPath, validateSOPHandoffArtifacts, materializeSOPHandoffInputs, inheritSOPHandoff, validateSOPHandoffRunnerPayload };
