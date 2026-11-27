/**
 * @file internal/engine/workspace_checkpoint_stream.js
 * 对应 Go 源文件：internal/engine/workspace_checkpoint_stream.go
 *
 * 作用与职责边界：
 * 实现运行工作区快照的流式保存、分块下载、远端探测复用、按流/内联恢复及存储归档校验；
 * `Engine` 相关方法挂载于 `Engine.prototype`（`Engine` 定义于 `engine.js`），传输通道转发与 HTTP 端点位于 `workspace_checkpoint_transport.js`。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；
 *   纯错误映射辅助函数 `workspaceCheckpointResponseError` 保留返回 `Error | null` 以便调用方检查错误码。
 * - Go 的 `context.Context` 译为 `AbortSignal`；`defer` 译为 `try ... finally`。
 * - Go 的 `os.IsNotExist` / `errors.Is(err, os.ErrNotExist)` 译为 `err.code === "ENOENT"`。
 * - Go 的 `io.ReadAll` / `io.LimitReader` / `io.ReadFull` / `io.Copy` / `io.Discard` 保留原始调用形态以便 1:1 对照。
 * - Go 的 JSON 小驼峰标签与 JS 类的大写字段名之间通过 `workspaceCheckpointTransferFromWire` 显式映射。
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes, createHash } = require("node:crypto");

const { RunnerWorkspaceRequest, RunnerWorkspaceOperationCheckpointStatus, RunnerWorkspaceOperationCheckpointExport, RunnerWorkspaceOperationCheckpointRead, RunnerWorkspaceOperationCheckpointClose, RunnerWorkspaceOperationCheckpointUpload, RunnerWorkspaceOperationCheckpointAppend, RunnerWorkspaceOperationCheckpointCommit, RunnerWorkspaceOperationCheckpoint, RunnerWorkspaceOperationRestore, RunnerWorkspaceOperationInfo, WorkspaceCheckpointTransfer, WorkspaceErrorTerminalActive, WorkspaceErrorMissing } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspaceRequest/RunnerWorkspaceOperation*/WorkspaceCheckpointTransfer/WorkspaceError*，runner_workspace.js 已翻译
const { ErrWorkspaceInUse } = require("../repo/workspace_checkpoints.js"); // 对应 Go 的 repo.ErrWorkspaceInUse，workspace_checkpoints.js 已翻译
const { ValidateWorkspaceCheckpointFrom, CreateWorkspaceCheckpointToContext, EmptyWorkspaceCheckpoint, WorkspaceCheckpointMaxBytes, WorkspaceCheckpointArchiveMaxBytes, WorkspaceCheckpointChunkBytes, RestoreWorkspaceCheckpointFrom } = require("../runtime/workspace_checkpoint.js"); // 对应 Go 的 runtime.ValidateWorkspaceCheckpointFrom/CreateWorkspaceCheckpointToContext/EmptyWorkspaceCheckpoint/WorkspaceCheckpointMaxBytes/WorkspaceCheckpointArchiveMaxBytes/WorkspaceCheckpointChunkBytes/RestoreWorkspaceCheckpointFrom，runtime 待翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { errWorkspaceTerminalActive, runnerWorkspaceBusy } = require("./workspace_busy.js"); // 对应 Go 同包标识与函数，workspace_busy.js 已翻译
const { safeRunnerPath } = require("./runner_dispatch.js"); // 对应 Go 同包函数，runner_dispatch.js 已翻译
const { workspaceRunID } = require("./workspace_owner.js"); // 对应 Go 同包函数，workspace_owner.js 已翻译

// Go 的 os.ErrNotExist：JS 用 code 为 ENOENT 的 Error 表示。
const errNotExist = new Error("file does not exist");
errNotExist.code = "ENOENT";

/**
 * 将工作区快照传输协议的小驼峰 JSON 载荷转换为 `WorkspaceCheckpointTransfer` 实例。
 * 使用场景：解析控制通道返回的传输清单、分块数据或服务端入站请求中的 `checkpointTransfer` 字段。
 *
 * @param {object} raw - 经 `JSON.parse` 解析后的原始对象。
 * @returns {WorkspaceCheckpointTransfer} 字段按大写 Go 命名填充的传输对象；`data` 按 base64 解码为 `Buffer`。
 */
function workspaceCheckpointTransferFromWire(raw) {
  return new WorkspaceCheckpointTransfer({ ID: raw.id ?? "", Size: raw.size ?? 0, SHA256: raw.sha256 ?? "", Offset: raw.offset ?? 0, Data: raw.data != null ? Buffer.from(raw.data, "base64") : null });
}

/**
 * 将对话或运行的工作区打包并流式写入快照存储；
 * 远端执行机或跨宿主工作区先经控制通道下载到临时文件并校验，本地工作区直接打包写入临时文件（目录不存在且无宿主机绑定时写入空快照）。
 * 使用场景：工作区空闲回收前或前台使用结束后持久化快照。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号（对应 Go 的 `context.Context`）。
 * @param {object} run - 当前运行快照（`domain.Run`）。
 * @param {string} token - 当前持有的工作区租约令牌。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 临时文件操作、远端下载、归档校验、打包或落库失败时抛出错误。
 */
Engine.prototype.saveConversationWorkspace = async function (ctx, run, token) {
  // Go os.CreateTemp 用随机后缀建临时文件；JS 直接拼一个随机名。
  const tmpPath = path.join(os.tmpdir(), `agentflow-checkpoint-save-${randomBytes(6).toString("hex")}`);
  const fd = fs.openSync(tmpPath, "w+");
  // Go 的 *os.File：JS 用 fd 加内部读写位置表示；方法遵循成功返回值、失败抛错。
  let fileOffset = 0;
  const file = {
    /**
     * 返回临时文件的完整路径。
     *
     * @returns {string} 临时文件路径。
     */
    Name() { return tmpPath; },
    /**
     * 关闭底层文件描述符。
     *
     * @returns {void} 无返回值。
     * @throws {Error} 关闭失败时抛出错误。
     */
    Close() {
      fs.closeSync(fd);
    },
    /**
     * 调整文件内部读写偏移量（`whence`：0 起始，1 当前，2 末尾，对应 `io.SeekStart/SeekCurrent/SeekEnd`）。
     *
     * @param {number} offset - 相对偏移字节数。
     * @param {number} whence - 基准位置标识。
     * @returns {number} 调整后的绝对偏移量。
     * @throws {Error} 获取文件大小失败时抛出错误。
     */
    Seek(offset, whence) {
      if (whence === 1) {
        fileOffset += offset;
      } else if (whence === 2) {
        fileOffset = fs.fstatSync(fd).size + offset;
      } else {
        fileOffset = offset;
      }
      return fileOffset;
    },
    /**
     * 将文件截断至指定字节大小并修正读写偏移。
     *
     * @param {number} size - 目标字节长度。
     * @returns {void} 无返回值。
     * @throws {Error} 截断失败时抛出错误。
     */
    Truncate(size) {
      fs.ftruncateSync(fd, size);
      if (fileOffset > size) {
        fileOffset = size;
      }
    },
    /**
     * 从当前偏移量写入字节数据并推进偏移。
     *
     * @param {Buffer|Uint8Array|string} data - 待写入的数据。
     * @returns {number} 实际写入的字节数。
     * @throws {Error} 写入失败时抛出错误。
     */
    Write(data) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const n = fs.writeSync(fd, buf, 0, buf.length, fileOffset);
      fileOffset += n;
      return n;
    },
    /**
     * 从当前偏移量读取字节数据到目标缓冲区并推进偏移。
     *
     * @param {Buffer} data - 接收读取数据的目标缓冲区。
     * @returns {number} 实际读取的字节数。
     * @throws {Error} 到达文件末尾（`EOF`）或读取失败时抛出错误。
     */
    Read(data) {
      const n = fs.readSync(fd, data, 0, data.length, fileOffset);
      fileOffset += n;
      if (n === 0) {
        throw new Error("EOF");
      }
      return n;
    },
  };
  try {
    if (this.defaultExecutionRunner(run) !== "" || this.foreignWorkspaceBind(run)) {
      await this.downloadConversationCheckpoint(ctx, run, file);
      file.Seek(0, 0);
      ValidateWorkspaceCheckpointFrom(new workspaceCheckpointContextReader(ctx, file));
    } else {
      const [root, reason] = this.LocalRunWorkspace(run);
      if (reason !== "") {
        throw new Error(reason);
      }
      try {
        CreateWorkspaceCheckpointToContext(ctx, root, new workspaceCheckpointContextWriter(ctx, file));
      } catch (err) {
        if (err != null && err.code === "ENOENT" && run.WorkspaceHost === "") {
          file.Truncate(0);
          file.Seek(0, 0);
          file.Write(EmptyWorkspaceCheckpoint());
        } else {
          throw err;
        }
      }
    }
    file.Seek(0, 0);
    this.repo.SaveWorkspaceCheckpointStream(run.ID, token, new Date(), new workspaceCheckpointContextReader(ctx, file));
  } finally {
    try {
      file.Close();
    } catch {}
    try {
      fs.unlinkSync(file.Name());
    } catch {}
  }
};

/**
 * 通知远端关闭指定分块快照传输会话并释放其临时句柄；
 * 即使调用方上下文已取消，也会在独立短超时预算（1 秒或 5 秒）内尽力发送关闭请求并忽略错误。
 * 使用场景：快照下载、探测或上传结束的 `finally` 清理阶段。
 *
 * @param {AbortSignal|null} ctx - 原始取消信号，用于判断收尾超时预算。
 * @param {object} run - 当前运行快照（`domain.Run`）。
 * @param {string} id - 待关闭的传输会话 ID；为空字符串时直接跳过。
 * @returns {Promise<void>} 无返回值。
 */
Engine.prototype.closeCheckpointTransfer = async function (ctx, run, id) {
  if (id === "") {
    return;
  }
  let budget = 5 * 1000;
  if (ctx instanceof AbortSignal && ctx.aborted) {
    budget = 1000;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    try {
      await this.requestWorkspaceCheckpoint(controller.signal, run, new RunnerWorkspaceRequest({ RunID: run.ID, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationCheckpointClose, CheckpointTransfer: new WorkspaceCheckpointTransfer({ ID: id }) }));
    } catch {}
  } finally {
    clearTimeout(timer);
  }
};

// 旧版执行机在响应尚未携带 WorkspaceErrorTerminalActive 错误码前返回的终端占用提示文本。
const legacyCheckpointTerminalActive = "workspace terminal is still active";

/**
 * 将远端工作区快照控制响应映射为统一的领域错误对象；响应正常时返回 `null`。
 * 使用场景：所有快照探测、导出、分块读写及恢复响应的统一错误分类（终端占用快速失败、租约忙碌、目录缺失等）。
 *
 * @param {object} response - 远端返回的响应对象（`domain.RunnerWorkspaceResponse`）。
 * @returns {Error|null} 映射后的错误对象；无错误且状态码小于 400 时返回 `null`。
 */
function workspaceCheckpointResponseError(response) {
  if (response.Error === "" && response.Status < 400) {
    return null;
  }
  // 存在打开的终端属于等待无法消除的执行围栏：按工作区准备方式快速失败，绝不视为可重试租约竞争。
  if (response.Code === WorkspaceErrorTerminalActive || response.Error === legacyCheckpointTerminalActive) {
    const err = new Error(`${errWorkspaceTerminalActive.message}（${response.Error}）`);
    err.cause = errWorkspaceTerminalActive;
    return err;
  }
  if (runnerWorkspaceBusy(response)) {
    return ErrWorkspaceInUse;
  }
  if (response.Code === WorkspaceErrorMissing || response.Status === 404) {
    const err = new Error(`file does not exist: ${response.Error}`);
    err.code = "ENOENT";
    return err;
  }
  return new Error(`workspace checkpoint request failed (HTTP ${response.Status}): ${response.Error}`);
}

/**
 * 发送单次分块快照传输控制请求，校验响应错误并解析返回的传输元数据或数据块。
 * 使用场景：下载分块（`CheckpointRead`）及上传初始化/追加/提交（`CheckpointUpload`/`Append`/`Commit`）。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {object} run - 当前运行快照（`domain.Run`）。
 * @param {string} op - 控制操作类型常量（`domain.RunnerWorkspaceOperation*`）。
 * @param {WorkspaceCheckpointTransfer|null} transfer - 随请求携带的分块传输参数。
 * @returns {Promise<WorkspaceCheckpointTransfer>} 远端返回的传输状态或分块内容。
 * @throws {Error} 传输请求失败、远端返回错误或 JSON 解析失败时抛出错误。
 */
Engine.prototype.checkpointTransferRequest = async function (ctx, run, op, transfer) {
  const response = await this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({ RunID: run.ID, RunStatus: run.Status, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: op, CheckpointTransfer: transfer }));
  const responseErr = workspaceCheckpointResponseError(response);
  if (responseErr != null) {
    throw responseErr;
  }
  return workspaceCheckpointTransferFromWire(JSON.parse(response.Payload.toString("utf8")));
};

/**
 * 发起远端工作区快照导出请求；若旧版执行机不支持分块导出（HTTP 400 或提示 unsupported），自动回退为旧版整包快照操作。
 * 使用场景：下载远端工作区快照或兼容旧版执行机的快照存在性探测。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {object} run - 当前运行快照（`domain.Run`）。
 * @returns {Promise<object>} 远端返回的原始控制响应（`domain.RunnerWorkspaceResponse`）。
 * @throws {Error} 控制通道请求失败时抛出错误。
 */
Engine.prototype.beginCheckpointExport = async function (ctx, run) {
  let response = await this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({ RunID: run.ID, RunStatus: run.Status, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationCheckpointExport }));
  // 兼容不支持分块传输的旧执行机：小快照仍可保存，大归档绝不重试为巨型 RPC。
  if (response.Status === 400 || response.Error.includes("unsupported")) {
    response = await this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({ RunID: run.ID, RunStatus: run.Status, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationCheckpoint }));
  }
  return response;
};

/**
 * 从远端执行机或跨宿主工作区下载快照归档并写入 `destination`；
 * 支持旧版单包内联快照与新版分块流式下载，并在分块下载结束后校验 SHA-256 摘要。
 * 使用场景：由 `saveConversationWorkspace` 调用以拉取远端工作区快照。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {object} run - 当前运行快照（`domain.Run`）。
 * @param {{ Write: (data: Buffer) => number }} destination - 接收归档字节流的目标写入器。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 导出失败、清单非法、分块异常、写入失败或校验和不匹配时抛出错误。
 */
Engine.prototype.downloadConversationCheckpoint = async function (ctx, run, destination) {
  const response = await this.beginCheckpointExport(ctx, run);
  const responseErr = workspaceCheckpointResponseError(response);
  if (responseErr != null) {
    throw responseErr;
  }
  const manifest = workspaceCheckpointTransferFromWire(JSON.parse(response.Payload.toString("utf8")));
  if (manifest.ID === "") {
    const legacy = JSON.parse(response.Payload.toString("utf8"));
    const checkpoint = legacy.checkpoint != null ? Buffer.from(legacy.checkpoint, "base64") : Buffer.alloc(0);
    if (checkpoint.length === 0 || checkpoint.length > WorkspaceCheckpointMaxBytes) {
      throw new Error("执行机器返回无效工作区快照；请更新执行器以支持分块快照");
    }
    destination.Write(checkpoint);
    return;
  }
  try {
    if (manifest.Size <= 0 || manifest.Size > WorkspaceCheckpointArchiveMaxBytes || manifest.SHA256.length !== 64) {
      throw new Error("invalid checkpoint export manifest");
    }
    const hash = createHash("sha256");
    // Go 的 io.MultiWriter：同时写入目标与计算哈希。
    const writer = new workspaceCheckpointContextWriter(ctx, {
      Write(data) {
        const n = destination.Write(data);
        hash.update(data);
        return n;
      },
    });
    for (let offset = 0; offset < manifest.Size;) {
      const chunk = await this.checkpointTransferRequest(ctx, run, RunnerWorkspaceOperationCheckpointRead, new WorkspaceCheckpointTransfer({ ID: manifest.ID, Offset: offset }));
      if (chunk.ID !== manifest.ID || chunk.Offset !== offset || chunk.Data.length !== Math.min(WorkspaceCheckpointChunkBytes, manifest.Size - offset)) {
        throw new Error("invalid checkpoint download chunk");
      }
      writer.Write(chunk.Data);
      offset += chunk.Data.length;
    }
    if (hash.digest("hex") !== manifest.SHA256) {
      throw new Error("checkpoint download checksum mismatch");
    }
  } finally {
    await this.closeCheckpointTransfer(ctx, run, manifest.ID);
  }
};

/**
 * 探测远端工作区是否仍然完好存在：若已存在则仅校验数据库中的已存快照并复用，
 * 仅在明确确认远端目录缺失（`ENOENT` 或空目录）时才触发快照上传恢复，避免忙碌或离线宿主引发重复恢复。
 * 使用场景：确保远端对话工作区可用前的状态探测与恢复决策。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {object} run - 当前运行快照（`domain.Run`）。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 远端忙碌/离线、探测异常、快照校验失败或上传恢复失败时抛出错误。
 */
Engine.prototype.restoreOrReuseRemoteConversationCheckpoint = async function (ctx, run) {
  let probe = await this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({ RunID: run.ID, RunStatus: run.Status, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationCheckpointStatus }));
  let err = null;
  if (probe.Status === 400 || probe.Error.includes("unsupported")) {
    // 兼容部署廉价探针之前的 worker/runner。
    probe = await this.beginCheckpointExport(ctx, run);
    err = workspaceCheckpointResponseError(probe);
    if (err == null) {
      const transfer = workspaceCheckpointTransferFromWire(JSON.parse(probe.Payload.toString("utf8")));
      await this.closeCheckpointTransfer(ctx, run, transfer.ID);
    } else if (legacyCheckpointMissingPath(probe.Error)) {
      if (this.defaultExecutionRunner(run) !== "") {
        // 旧传输处理把所有文件系统错误都返回 409；只读 info 操作对缺失根目录返回真正的 404，避免因导出时单个嵌套文件消失而误触发整包重恢复。
        const info = await this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({ RunID: run.ID, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationInfo }));
        const missing = workspaceCheckpointResponseError(info);
        if (missing != null && missing.code === "ENOENT") {
          err = missing;
        }
      } else {
        // 旧 Worker 会公布工作区根目录；精确匹配该根目录，不把缺失嵌套文件当作已回收。
        const root = path.join(run.WorkspaceRoot, safeRunnerPath(workspaceRunID(run)));
        if (probe.Error.startsWith("lstat " + root + ": ") || probe.Error.startsWith("stat " + root + ": ")) {
          err = errNotExist;
        }
      }
    }
  } else {
    err = workspaceCheckpointResponseError(probe);
    if (err == null) {
      let status = null;
      try {
        status = probe.Payload != null && probe.Payload.length > 0 ? JSON.parse(probe.Payload.toString("utf8")) : null;
      } catch {
        status = null;
      }
      if (status != null && status.empty) {
        err = errNotExist;
      }
    }
  }
  if (err == null) {
    this.verifyStoredCheckpoint(ctx, run.ID);
    return;
  }
  if (err.code !== "ENOENT") {
    throw err;
  }
  await this.restoreConversationCheckpoint(ctx, run, "");
};

/**
 * 判断旧版执行机或 Worker 返回的错误消息是否匹配跨平台（POSIX / Windows）的文件或路径不存在后缀。
 * 使用场景：兼容旧版无探针接口时的缺失目录识别。
 *
 * @param {string} message - 远端返回的错误消息文本。
 * @returns {boolean} 匹配已知缺失路径后缀时返回 `true`，否则返回 `false`。
 */
function legacyCheckpointMissingPath(message) {
  return message.endsWith(": no such file or directory") || message.endsWith(": The system cannot find the path specified.") || message.endsWith(": The system cannot find the file specified.");
}

/**
 * 从持久化存储打开运行工作区快照归档并恢复到目标位置：
 * 当传入非空本地 `root` 时直接解压恢复到本地目录；否则按归档大小选择单包内联恢复或分块上传提交恢复至远端。
 * 使用场景：工作区已回收后重新打开或恢复对话工作区时调用。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {object} run - 当前运行快照（`domain.Run`）。
 * @param {string} root - 本地目标工作区根目录；传空字符串 `""` 表示恢复至远端宿主机或执行机。
 * @returns {Promise<void>} 无返回值。
 * @throws {Error} 打开归档失败、归档大小非法、本地解压失败或远端上传提交失败时抛出错误。
 */
Engine.prototype.restoreConversationCheckpoint = async function (ctx, run, root) {
  const source = this.repo.OpenWorkspaceCheckpointArchive(run.ID);
  try {
    const sourceReader = new workspaceCheckpointContextReader(ctx, source);
    if (root !== "") {
      RestoreWorkspaceCheckpointFrom(root, sourceReader);
      return;
    }
    const [meta] = this.repo.WorkspaceCheckpoint(run.ID);
    if (meta.ArchiveBytes <= WorkspaceCheckpointMaxBytes) {
      const archive = io.ReadAll(io.LimitReader(sourceReader, WorkspaceCheckpointMaxBytes + 1));
      if (archive.length > WorkspaceCheckpointMaxBytes) {
        throw new Error("invalid inline checkpoint size");
      }
      const response = await this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({ RunID: run.ID, RunStatus: run.Status, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationRestore, Checkpoint: archive }));
      const responseErr = workspaceCheckpointResponseError(response);
      if (responseErr != null) {
        throw responseErr;
      }
      return;
    }
    const manifest = await this.checkpointTransferRequest(ctx, run, RunnerWorkspaceOperationCheckpointUpload, new WorkspaceCheckpointTransfer({ Size: meta.ArchiveBytes, SHA256: meta.SHA256 }));
    try {
      if (manifest.ID === "" || manifest.Size !== meta.ArchiveBytes || manifest.SHA256 !== meta.SHA256) {
        throw new Error("invalid checkpoint upload response");
      }
      const buffer = Buffer.alloc(WorkspaceCheckpointChunkBytes);
      for (let offset = 0; offset < meta.ArchiveBytes;) {
        const size = Math.min(buffer.length, meta.ArchiveBytes - offset);
        const n = io.ReadFull(sourceReader, buffer.subarray(0, size));
        const ack = await this.checkpointTransferRequest(ctx, run, RunnerWorkspaceOperationCheckpointAppend, new WorkspaceCheckpointTransfer({ ID: manifest.ID, Offset: offset, Data: buffer.subarray(0, n) }));
        offset += n;
        if (ack.ID !== manifest.ID || ack.Offset !== offset) {
          throw new Error("invalid checkpoint upload acknowledgement");
        }
      }
      await this.checkpointTransferRequest(ctx, run, RunnerWorkspaceOperationCheckpointCommit, new WorkspaceCheckpointTransfer({ ID: manifest.ID }));
    } finally {
      await this.closeCheckpointTransfer(ctx, run, manifest.ID);
    }
  } finally {
    source.Close();
  }
};

/**
 * 完整流式读取一遍已存储的工作区快照归档并丢弃内容，以触发底层存储的完整性与哈希校验。
 * 使用场景：复用现有工作区前确认持久化快照本身未损坏。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {string} id - 运行记录主键 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 打开归档失败、读取中断或校验失败时抛出错误。
 */
Engine.prototype.verifyStoredCheckpoint = function (ctx, id) {
  const source = this.repo.OpenWorkspaceCheckpointArchive(id);
  try {
    io.Copy(io.Discard, new workspaceCheckpointContextReader(ctx, source));
  } finally {
    source.Close();
  }
};

/**
 * 为底层 `io.Reader` 附加取消信号检查的包装读取器。
 * 使用场景：快照保存、恢复与校验过程中在每次读取前感知上下文取消。
 */
class workspaceCheckpointContextReader {
  /**
   * 构造带取消信号的包装读取器。
   *
   * @param {AbortSignal|null} ctx - 取消控制信号。
   * @param {{ Read: (data: Buffer) => number }} source - 底层读取源对象。
   * @returns {void} 无返回值。
   */
  constructor(ctx, source) {
    this.ctx = ctx;
    this.source = source;
  }

  /**
   * 读取数据前先检查取消信号，未取消时委托给底层读取源。
   *
   * @param {Buffer} data - 接收数据的目标缓冲区。
   * @returns {number} 实际读取的字节数。
   * @throws {Error} 上下文已取消或底层读取失败时抛出错误。
   */
  Read(data) {
    if (this.ctx instanceof AbortSignal && this.ctx.aborted) {
      throw this.ctx.reason;
    }
    return this.source.Read(data);
  }
}

/**
 * 为底层 `io.Writer` 附加取消信号检查的包装写入器。
 * 使用场景：本地打包与远端分块下载写入过程中在每次写入前感知上下文取消。
 */
class workspaceCheckpointContextWriter {
  /**
   * 构造带取消信号的包装写入器。
   *
   * @param {AbortSignal|null} ctx - 取消控制信号。
   * @param {{ Write: (data: Buffer) => number }} destination - 底层写入目标对象。
   * @returns {void} 无返回值。
   */
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.destination = destination;
  }

  /**
   * 写入数据前先检查取消信号，未取消时委托给底层写入目标。
   *
   * @param {Buffer} data - 待写入的数据缓冲区。
   * @returns {number} 实际写入的字节数。
   * @throws {Error} 上下文已取消或底层写入失败时抛出错误。
   */
  Write(data) {
    if (this.ctx instanceof AbortSignal && this.ctx.aborted) {
      throw this.ctx.reason;
    }
    return this.destination.Write(data);
  }
}

module.exports = { workspaceCheckpointResponseError, legacyCheckpointTerminalActive, workspaceCheckpointContextReader, workspaceCheckpointContextWriter, workspaceCheckpointTransferFromWire };
