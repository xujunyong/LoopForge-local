/**
 * @file legacy_handoff.js
 * 对应 Go 源文件：internal/engine/legacy_handoff.go
 * 作用与职责边界：提供已归档自由协作交接（Group SOP Handoff）的只读兼容支持，包括归档产物完整性与 SHA256 校验、
 * 分片对话记录重组、生成节点输入清单与物化只读文件、子 SOP 交接继承以及 Runner 8 MiB 任务载荷上限校验。
 * 语法差异说明：
 * - Go 的 `(值, error)` / `error` 返回值统一转为直接返回值或无返回值，失败时 `throw Error`。
 * - Go 的 `(string, []domain.RunnerInputFile)` 非错误双返回值（`sopHandoffInputs`）译为 `[manifest, files]` 二元组，空切片用 `[]`。
 * - Go 的 `json.Unmarshal` 译为 `JSON.parse`，构造函数同时兼容 Go 字段名（大写）与 JSON 标签名（小写）。
 * - 同包函数（`artifacts.js`、`human_context.js`）按需延迟 `require`，避免循环依赖。
 */

"use strict";

const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath
const { RunnerInputFile } = require("../domain/runner.js"); // 对应 Go 的 domain.RunnerInputFile，runner.js 已翻译
const { WorkspaceContentSHA } = require("../runtime/workspace_edit.js"); // 对应 Go 的 runtime.WorkspaceContentSHA，runtime 未翻译
const { WorkspaceCheckpointMaxBytes } = require("../runtime/workspace_checkpoint.js"); // 对应 Go 的 runtime.WorkspaceCheckpointMaxBytes，runtime 未翻译
const { EnsureControlDirectory } = require("../runtime/materialize.js"); // 对应 Go 的 runtime.EnsureControlDirectory，runtime 未翻译

// groupSOPHandoffNode：自由协作交接归档产物固定的来源节点 ID。
const groupSOPHandoffNode = "group-handoff";

/**
 * 自由协作交接对话记录的单个分片描述。
 * 使用场景：解析分片清单 JSON 中的 `parts` 条目并校验各分片产物。
 */
class sopHandoffTranscriptPart {
  /**
   * 构造分片描述对象，兼容 Go 大写字段名与 JSON 小写标签名，字段按 Go 字符串零值初始化。
   * 使用场景：反序列化交接对话清单时构造每个分片项。
   *
   * @param {object} [init={}] - 原始对象，可包含 `Name/name`、`Path/path`、`InputPath/inputPath`、`SHA256/sha256`。
   * @returns {sopHandoffTranscriptPart} 新的分片描述实例。
   */
  constructor(init = {}) {
    this.Name = init.Name ?? init.name ?? "";
    this.Path = init.Path ?? init.path ?? "";
    this.InputPath = init.InputPath ?? init.inputPath ?? "";
    this.SHA256 = init.SHA256 ?? init.sha256 ?? "";
  }
}

/**
 * 自由协作交接对话记录的分片清单结构。
 * 使用场景：判断对话归档为单文件 JSON 还是分片清单格式，并校验总字节数、整体 SHA256 与分片列表。
 */
class sopHandoffTranscriptManifest {
  /**
   * 构造对话分片清单对象，兼容 Go 大写字段名与 JSON 小写标签名，字段按 Go 零值初始化。
   * 使用场景：反序列化 `sop-handoff-conversation` 产物正文时调用。
   *
   * @param {object} [init={}] - 原始对象，可包含 `Format/format`、`Bytes/bytes`、`SHA256/sha256`、`Parts/parts`。
   * @returns {sopHandoffTranscriptManifest} 新的清单实例。
   */
  constructor(init = {}) {
    this.Format = init.Format ?? init.format ?? "";
    this.Bytes = init.Bytes ?? init.bytes ?? 0;
    this.SHA256 = init.SHA256 ?? init.sha256 ?? "";
    const rawParts = init.Parts ?? init.parts ?? [];
    this.Parts = rawParts.map((p) => (p instanceof sopHandoffTranscriptPart ? p : new sopHandoffTranscriptPart(p)));
  }
}

// sopHandoffTranscriptFormat：分片版交接对话清单的格式版本号。
const sopHandoffTranscriptFormat = "agentflow.sop-handoff.transcript/v1";

/**
 * 检索并严格校验运行中归档的自由协作交接产物（摘要、对话根文件及可选的全部分片）。
 * 使用场景：启动 SOP、物化交接输入或继承给子 SOP 前，确认归档完整且未被篡改。
 *
 * @param {object} run - 运行对象（domain.Run）。
 * @returns {object[]} 按顺序排列的已校验交接产物列表；未挂载交接引用时返回空数组 `[]`。
 * @throws {Error} 任一归档产物缺失、JSON 格式错误、清单超限、分片路径非法或哈希校验失败时抛出错误。
 */
function archivedSOPHandoffArtifacts(run) {
  const { maxArtifactBytes } = require("./artifacts.js");
  const ref = run.WorkflowSnapshot.GroupSOPHandoff;
  if (ref == null) {
    return [];
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
  } catch {
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

/**
 * 从已选中的交接产物列表中读取并重组完整对话字节内容（单文件直接返回，分片格式拼接并校验总字节数与 SHA256）。
 * 使用场景：校验分片归档完整性或读取完整交接对话正文时调用。
 *
 * @param {object[]} artifacts - 已选中的交接产物数组（前两项为摘要与对话根文件，后续为各分片）。
 * @returns {Buffer} 完整交接对话的 UTF-8 字节缓冲。
 * @throws {Error} 产物不足、JSON 解析失败、清单无效、总大小超限或完整内容校验失败时抛出错误。
 */
function readSOPHandoffTranscript(artifacts) {
  if (artifacts.length < 2) {
    throw new Error("自由协作交接归档不完整");
  }
  const root = Buffer.from(artifacts[1].Content, "utf8");
  const manifest = new sopHandoffTranscriptManifest(JSON.parse(root.toString("utf8")));
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

/**
 * 构造注入给 SOP 节点的交接输入清单文本与 `RunnerInputFile` 文件列表。
 * 输入与图谱血缘无关，每次派发都直接从归档产物生成，确保重试、重建或远程工作区都能保留交接内容。
 * 使用场景：本地物化交接输入文件或派发远程 Runner 任务时生成输入载荷。
 *
 * @param {object} run - 运行对象（domain.Run）。
 * @returns {[string, object[]]} 二元组 `[manifest, files]`，分别为清单 Markdown 文本与 `RunnerInputFile` 列表；无交接、群组模式或校验失败时返回 `["", []]`。
 */
function sopHandoffInputs(run) {
  const { writeInputManifestEntry } = require("./artifacts.js");
  const ref = run.WorkflowSnapshot.GroupSOPHandoff;
  if (ref == null || run.WorkflowSnapshot.CollaborationMode === "group") {
    return ["", []];
  }
  const manifest = [];
  const files = [];
  let artifacts;
  try {
    artifacts = archivedSOPHandoffArtifacts(run);
  } catch {
    return ["", []];
  }
  for (const a of artifacts) {
    const inputPath = sopHandoffInputPath(ref, a.Name);
    files.push(new RunnerInputFile({ Path: inputPath, Content: a.Content }));
    writeInputManifestEntry(manifest, a, inputPath);
  }
  return [manifest.join(""), files];
}

/**
 * 生成指定交接产物在工作区 `.agentflow/inputs/group-handoff/` 下的相对挂载路径。
 * 使用场景：校验分片 `InputPath`、构造 `RunnerInputFile` 路径及本地落盘时统一路径规则。
 *
 * @param {object} ref - 自由协作交接引用对象（domain.GroupSOPHandoff）。
 * @param {string} name - 交接产物名称。
 * @returns {string} 相对工作区的安全挂载路径。
 */
function sopHandoffInputPath(ref, name) {
  const { safePathSegment } = require("./human_context.js");
  let ext = ".md";
  if (name === "sop-handoff-conversation") {
    ext = ".json";
  } else if (name.startsWith("sop-handoff-conversation-part-")) {
    ext = ".txt";
  }
  return ".agentflow/inputs/group-handoff/" + safePathSegment(ref.ID) + "-" + safePathSegment(name) + ext;
}

/**
 * 校验非群组模式运行所挂载的自由协作交接归档是否完整有效。
 * 使用场景：启动 SOP、物化交接输入或继承给子 SOP 前的前置校验入口。
 *
 * @param {object} run - 运行对象（domain.Run）。
 * @returns {void} 无返回值。
 * @throws {Error} 交接归档缺失或校验失败时抛出错误。
 */
function validateSOPHandoffArtifacts(run) {
  const ref = run.WorkflowSnapshot.GroupSOPHandoff;
  if (ref == null || run.WorkflowSnapshot.CollaborationMode === "group") {
    return;
  }
  archivedSOPHandoffArtifacts(run);
}

/**
 * 校验并将交接归档输入物化写入工作区控制目录（只读权限 `0o444`），返回拼接后的输入清单文本。
 * 使用场景：本地节点执行前由 `materializeInputs` 调用，将归档内容挂载为只读文件供 Agent 读取。
 *
 * @param {string} workspace - 沙箱工作区根目录路径。
 * @param {object} run - 运行对象（domain.Run）。
 * @returns {string} 生成的输入清单文本；无交接文件时返回空字符串。
 * @throws {Error} 交接校验失败、目标路径不是普通文件或文件系统读写/改权失败时抛出错误。
 */
function materializeSOPHandoffInputs(workspace, run) {
  validateSOPHandoffArtifacts(run);
  const [manifest, files] = sopHandoffInputs(run);
  if (files.length === 0) {
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

/**
 * 将父运行的自由协作交接归档完整冻结克隆到同项目的子 SOP 运行中。
 * 子 SOP 拥有独立工作区，不能假设父目录文件可见，因此在调度首节点前复制产物并重写引用 ID。
 * 使用场景：从带有自由协作交接的父运行派生子 SOP 时调用。
 *
 * @param {object} parent - 父运行对象（domain.Run）。
 * @param {object} child - 子运行对象（domain.Run），会被原地追加克隆产物并写入 `GroupSOPHandoff`。
 * @returns {void} 无返回值。
 * @throws {Error} 跨项目继承或父运行交接归档校验失败时抛出错误。
 */
function inheritSOPHandoff(parent, child) {
  const { newArtifact } = require("./artifacts.js");
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

/**
 * 校验附带交接输入的 Runner 任务 JSON 载荷是否超出客户端 8 MiB 单次 claim 响应上限（预留 4 KiB 给 lease 字段）。
 * 使用场景：向远程执行机器入队任务前调用，避免排入已发布 Runner 永远无法解码的超大任务。
 *
 * @param {object} run - 运行对象（domain.Run）。
 * @param {object} task - 待入队的 Runner 任务对象（domain.RunnerTask）。
 * @returns {void} 无返回值。
 * @throws {Error} JSON 序列化失败或序列化字节长度超出 `(8 MiB - 4 KiB)` 上限时抛出错误。
 */
function validateSOPHandoffRunnerPayload(run, task) {
  if (run.WorkflowSnapshot.GroupSOPHandoff == null) {
    return;
  }
  const payload = JSON.stringify({ task });
  if (Buffer.byteLength(payload, "utf8") > (8 << 20) - (4 << 10)) {
    throw new Error("完整交接输入超出执行机器的 8 MiB 任务响应上限；原始归档完整保留，未截断，请查看交接摘要与归档后调整继续任务");
  }
}

module.exports = { groupSOPHandoffNode, sopHandoffTranscriptPart, sopHandoffTranscriptManifest, sopHandoffTranscriptFormat, archivedSOPHandoffArtifacts, readSOPHandoffTranscript, sopHandoffInputs, sopHandoffInputPath, validateSOPHandoffArtifacts, materializeSOPHandoffInputs, inheritSOPHandoff, validateSOPHandoffRunnerPayload };
