// workspace_checkpoint_stream.js —— 对应 Go 文件：internal/engine/workspace_checkpoint_stream.go
// 作用：工作区快照流式传输：保存、下载、恢复与校验分块快照。
// context.Context 译为 AbortSignal；(值, error) 译为 [值, error]，只返回 error 的译为 error 值；os.IsNotExist/errors.Is(err, os.ErrNotExist) 译为 err.code === "ENOENT"；Go 的 io.* 调用按原文保留作对照。

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes, createHash } = require("node:crypto");

const { RunnerWorkspaceRequest, RunnerWorkspaceOperationCheckpointStatus, RunnerWorkspaceOperationCheckpointExport, RunnerWorkspaceOperationCheckpointRead, RunnerWorkspaceOperationCheckpointClose, RunnerWorkspaceOperationCheckpointUpload, RunnerWorkspaceOperationCheckpointAppend, RunnerWorkspaceOperationCheckpointCommit, RunnerWorkspaceOperationCheckpoint, RunnerWorkspaceOperationRestore, RunnerWorkspaceOperationInfo, WorkspaceCheckpointTransfer, WorkspaceErrorTerminalActive, WorkspaceErrorMissing } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspaceRequest/RunnerWorkspaceOperation*/WorkspaceCheckpointTransfer/WorkspaceError*，runner_workspace.js 已翻译
const { ErrWorkspaceInUse } = require("../repo/workspace_checkpoints.js"); // 对应 Go 的 repo.ErrWorkspaceInUse，workspace_checkpoints.js 已翻译
const { ValidateWorkspaceCheckpointFrom, CreateWorkspaceCheckpointToContext, EmptyWorkspaceCheckpoint, WorkspaceCheckpointMaxBytes, WorkspaceCheckpointArchiveMaxBytes, WorkspaceCheckpointChunkBytes, RestoreWorkspaceCheckpointFrom } = require("../runtime/workspace_checkpoint.js"); // 对应 Go 的 runtime.ValidateWorkspaceCheckpointFrom/CreateWorkspaceCheckpointToContext/EmptyWorkspaceCheckpoint/WorkspaceCheckpointMaxBytes/WorkspaceCheckpointArchiveMaxBytes/WorkspaceCheckpointChunkBytes/RestoreWorkspaceCheckpointFrom，runtime 待翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { errWorkspaceTerminalActive, runnerWorkspaceBusy } = require("./workspace_busy.js"); // 对应 Go 同包标识与函数，workspace_busy.js 本次一同翻译

// Go 的 os.ErrNotExist：JS 用 code 为 ENOENT 的 Error 表示。
const errNotExist = new Error("file does not exist");
errNotExist.code = "ENOENT";

// Go 的 json 标签是小驼峰，JS 字段是大写，解析时按标签映射；[]byte 按 base64 解码。
function workspaceCheckpointTransferFromWire(raw) {
  return new WorkspaceCheckpointTransfer({ ID: raw.id ?? "", Size: raw.size ?? 0, SHA256: raw.sha256 ?? "", Offset: raw.offset ?? 0, Data: raw.data != null ? Buffer.from(raw.data, "base64") : null });
}

Engine.prototype.saveConversationWorkspace = async function (ctx, run, token) {
  // Go os.CreateTemp 用随机后缀建临时文件；JS 直接拼一个随机名。
  const tmpPath = path.join(os.tmpdir(), `agentflow-checkpoint-save-${randomBytes(6).toString("hex")}`);
  let fd;
  try {
    fd = fs.openSync(tmpPath, "w+");
  } catch (err) {
    return err;
  }
  // Go 的 *os.File：JS 用 fd 加内部读写位置表示；Read 返回 [n, err]。
  let fileOffset = 0;
  const file = {
    Name() { return tmpPath; },
    Close() {
      try {
        fs.closeSync(fd);
      } catch (err) {
        return err;
      }
      return null;
    },
    // whence：0 起始，1 当前，2 末尾（对应 io.SeekStart/SeekCurrent/SeekEnd）。
    Seek(offset, whence) {
      try {
        if (whence === 1) {
          fileOffset += offset;
        } else if (whence === 2) {
          fileOffset = fs.fstatSync(fd).size + offset;
        } else {
          fileOffset = offset;
        }
        return [fileOffset, null];
      } catch (err) {
        return [0, err];
      }
    },
    Truncate(size) {
      try {
        fs.ftruncateSync(fd, size);
        if (fileOffset > size) {
          fileOffset = size;
        }
        return null;
      } catch (err) {
        return err;
      }
    },
    Write(data) {
      try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const n = fs.writeSync(fd, buf, 0, buf.length, fileOffset);
        fileOffset += n;
        return [n, null];
      } catch (err) {
        return [0, err];
      }
    },
    Read(data) {
      try {
        const n = fs.readSync(fd, data, 0, data.length, fileOffset);
        fileOffset += n;
        if (n === 0) {
          return [0, new Error("EOF")];
        }
        return [n, null];
      } catch (err) {
        return [0, err];
      }
    },
  };
  try {
    if (this.defaultExecutionRunner(run) !== "" || this.foreignWorkspaceBind(run)) {
      const downloadErr = await this.downloadConversationCheckpoint(ctx, run, file);
      if (downloadErr != null) {
        return downloadErr;
      }
      const [, seekErr] = file.Seek(0, 0);
      if (seekErr != null) {
        return seekErr;
      }
      const validateErr = ValidateWorkspaceCheckpointFrom(new WorkspaceCheckpointContextReader(ctx, file));
      if (validateErr != null) {
        return validateErr;
      }
    } else {
      const [root, reason] = this.LocalRunWorkspace(run);
      if (reason !== "") {
        return new Error(reason);
      }
      let err = CreateWorkspaceCheckpointToContext(ctx, root, new WorkspaceCheckpointContextWriter(ctx, file));
      if (err != null && err.code === "ENOENT" && run.WorkspaceHost === "") {
        const truncErr = file.Truncate(0);
        if (truncErr != null) {
          return truncErr;
        }
        const [, seekErr] = file.Seek(0, 0);
        if (seekErr != null) {
          return seekErr;
        }
        const [, writeErr] = file.Write(EmptyWorkspaceCheckpoint());
        err = writeErr;
      }
      if (err != null) {
        return err;
      }
    }
    const [, seekErr] = file.Seek(0, 0);
    if (seekErr != null) {
      return seekErr;
    }
    return this.repo.SaveWorkspaceCheckpointStream(run.ID, token, new Date(), new WorkspaceCheckpointContextReader(ctx, file));
  } finally {
    file.Close();
    try {
      fs.unlinkSync(file.Name());
    } catch {}
  }
};

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
    await this.requestWorkspaceCheckpoint(controller.signal, run, new RunnerWorkspaceRequest({ RunID: run.ID, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationCheckpointClose, CheckpointTransfer: new WorkspaceCheckpointTransfer({ ID: id }) }));
  } finally {
    clearTimeout(timer);
  }
};

const legacyCheckpointTerminalActive = "workspace terminal is still active";

function workspaceCheckpointResponseError(response) {
  if (response.Error === "" && response.Status < 400) {
    return null;
  }
  if (response.Code === WorkspaceErrorTerminalActive || response.Error === legacyCheckpointTerminalActive) {
    return new Error(`${errWorkspaceTerminalActive.message}（${response.Error}）`);
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

Engine.prototype.checkpointTransferRequest = async function (ctx, run, op, transfer) {
  const [response, err] = await this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({ RunID: run.ID, RunStatus: run.Status, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: op, CheckpointTransfer: transfer }));
  if (err != null) {
    return [new WorkspaceCheckpointTransfer({}), err];
  }
  const responseErr = workspaceCheckpointResponseError(response);
  if (responseErr != null) {
    return [new WorkspaceCheckpointTransfer({}), responseErr];
  }
  let result;
  try {
    result = workspaceCheckpointTransferFromWire(JSON.parse(response.Payload.toString("utf8")));
  } catch (parseErr) {
    return [new WorkspaceCheckpointTransfer({}), parseErr];
  }
  return [result, null];
};

Engine.prototype.beginCheckpointExport = async function (ctx, run) {
  const [response, err] = await this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({ RunID: run.ID, RunStatus: run.Status, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationCheckpointExport }));
  if (err != null) {
    return [response, err];
  }
  // 兼容不支持分块传输的旧 runner：小快照仍可保存，大归档不重试为巨型 RPC。
  if (response.Status === 400 || response.Error.includes("unsupported")) {
    return this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({ RunID: run.ID, RunStatus: run.Status, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationCheckpoint }));
  }
  return [response, null];
};

Engine.prototype.downloadConversationCheckpoint = async function (ctx, run, destination) {
  const [response, err] = await this.beginCheckpointExport(ctx, run);
  if (err != null) {
    return err;
  }
  const responseErr = workspaceCheckpointResponseError(response);
  if (responseErr != null) {
    return responseErr;
  }
  let manifest;
  try {
    manifest = workspaceCheckpointTransferFromWire(JSON.parse(response.Payload.toString("utf8")));
  } catch (parseErr) {
    return parseErr;
  }
  if (manifest.ID === "") {
    let legacy;
    try {
      legacy = JSON.parse(response.Payload.toString("utf8"));
    } catch (parseErr) {
      return parseErr;
    }
    const checkpoint = legacy.checkpoint != null ? Buffer.from(legacy.checkpoint, "base64") : Buffer.alloc(0);
    if (checkpoint.length === 0 || checkpoint.length > WorkspaceCheckpointMaxBytes) {
      return new Error("执行机器返回无效工作区快照；请更新执行器以支持分块快照");
    }
    const [, writeErr] = destination.Write(checkpoint);
    return writeErr;
  }
  try {
    if (manifest.Size <= 0 || manifest.Size > WorkspaceCheckpointArchiveMaxBytes || manifest.SHA256.length !== 64) {
      return new Error("invalid checkpoint export manifest");
    }
    const hash = createHash("sha256");
    // Go 的 io.MultiWriter：同时写目标与哈希。
    const writer = new WorkspaceCheckpointContextWriter(ctx, {
      Write(data) {
        const [n, writeErr] = destination.Write(data);
        if (writeErr != null) {
          return [n, writeErr];
        }
        hash.update(data);
        return [n, null];
      },
    });
    for (let offset = 0; offset < manifest.Size;) {
      const [chunk, chunkErr] = await this.checkpointTransferRequest(ctx, run, RunnerWorkspaceOperationCheckpointRead, new WorkspaceCheckpointTransfer({ ID: manifest.ID, Offset: offset }));
      if (chunkErr != null) {
        return chunkErr;
      }
      if (chunk.ID !== manifest.ID || chunk.Offset !== offset || chunk.Data.length !== Math.min(WorkspaceCheckpointChunkBytes, manifest.Size - offset)) {
        return new Error("invalid checkpoint download chunk");
      }
      const [, writeErr] = writer.Write(chunk.Data);
      if (writeErr != null) {
        return writeErr;
      }
      offset += chunk.Data.length;
    }
    if (hash.digest("hex") !== manifest.SHA256) {
      return new Error("checkpoint download checksum mismatch");
    }
    return null;
  } finally {
    await this.closeCheckpointTransfer(ctx, run, manifest.ID);
  }
};

Engine.prototype.restoreOrReuseRemoteConversationCheckpoint = async function (ctx, run) {
  const [probe, probeErr] = await this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({ RunID: run.ID, RunStatus: run.Status, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationCheckpointStatus }));
  if (probeErr != null) {
    return probeErr;
  }
  let err = null;
  let probeResponse = probe;
  if (probe.Status === 400 || probe.Error.includes("unsupported")) {
    // 兼容部署了廉价探针之前的 worker/runner。
    const [exportResponse, exportErr] = await this.beginCheckpointExport(ctx, run);
    if (exportErr != null) {
      return exportErr;
    }
    probeResponse = exportResponse;
    err = workspaceCheckpointResponseError(probeResponse);
    if (err == null) {
      let transfer;
      try {
        transfer = workspaceCheckpointTransferFromWire(JSON.parse(probeResponse.Payload.toString("utf8")));
      } catch (parseErr) {
        return parseErr;
      }
      await this.closeCheckpointTransfer(ctx, run, transfer.ID);
    } else if (legacyCheckpointMissingPath(probeResponse.Error)) {
      if (this.defaultExecutionRunner(run) !== "") {
        // 旧传输处理把所有文件系统错误都返回 409；只读 info 操作对缺失根目录返回真正的 404。
        const [info, infoErr] = await this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({ RunID: run.ID, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationInfo }));
        if (infoErr != null) {
          return infoErr;
        }
        const missing = workspaceCheckpointResponseError(info);
        if (missing != null && missing.code === "ENOENT") {
          err = missing;
        }
      } else {
        // 旧 Worker 公布工作区根目录；精确匹配该根目录，不把缺失嵌套文件当作回收。
        const root = path.join(run.WorkspaceRoot, safeRunnerPath(workspaceRunID(run)));
        if (probeResponse.Error.startsWith("lstat " + root + ": ") || probeResponse.Error.startsWith("stat " + root + ": ")) {
          err = errNotExist;
        }
      }
    }
  } else {
    err = workspaceCheckpointResponseError(probeResponse);
    if (err == null) {
      let status = null;
      try {
        status = probeResponse.Payload != null && probeResponse.Payload.length > 0 ? JSON.parse(probeResponse.Payload.toString("utf8")) : null;
      } catch {
        status = null;
      }
      if (status != null && status.empty) {
        err = errNotExist;
      }
    }
  }
  if (err == null) {
    return this.verifyStoredCheckpoint(ctx, run.ID);
  }
  if (err.code !== "ENOENT") {
    return err;
  }
  return this.restoreConversationCheckpoint(ctx, run, "");
};

function legacyCheckpointMissingPath(message) {
  return message.endsWith(": no such file or directory") || message.endsWith(": The system cannot find the path specified.") || message.endsWith(": The system cannot find the file specified.");
}

Engine.prototype.restoreConversationCheckpoint = async function (ctx, run, root) {
  let source;
  try {
    source = this.repo.OpenWorkspaceCheckpointArchive(run.ID);
  } catch (err) {
    return err;
  }
  try {
    const sourceReader = new WorkspaceCheckpointContextReader(ctx, source);
    if (root !== "") {
      return RestoreWorkspaceCheckpointFrom(root, sourceReader);
    }
    const [meta] = this.repo.WorkspaceCheckpoint(run.ID);
    if (meta.ArchiveBytes <= WorkspaceCheckpointMaxBytes) {
      const [archive, readErr] = io.ReadAll(io.LimitReader(sourceReader, WorkspaceCheckpointMaxBytes + 1));
      if (readErr != null) {
        return readErr;
      }
      if (archive.length > WorkspaceCheckpointMaxBytes) {
        return new Error("invalid inline checkpoint size");
      }
      const [response, requestErr] = await this.requestWorkspaceCheckpoint(ctx, run, new RunnerWorkspaceRequest({ RunID: run.ID, RunStatus: run.Status, WorkspaceLayout: run.ExecutionContext.RunnerWorkspaceLayout, Operation: RunnerWorkspaceOperationRestore, Checkpoint: archive }));
      if (requestErr != null) {
        return requestErr;
      }
      return workspaceCheckpointResponseError(response);
    }
    const [manifest, manifestErr] = await this.checkpointTransferRequest(ctx, run, RunnerWorkspaceOperationCheckpointUpload, new WorkspaceCheckpointTransfer({ Size: meta.ArchiveBytes, SHA256: meta.SHA256 }));
    if (manifestErr != null) {
      return manifestErr;
    }
    try {
      if (manifest.ID === "" || manifest.Size !== meta.ArchiveBytes || manifest.SHA256 !== meta.SHA256) {
        return new Error("invalid checkpoint upload response");
      }
      const buffer = Buffer.alloc(WorkspaceCheckpointChunkBytes);
      for (let offset = 0; offset < meta.ArchiveBytes;) {
        const size = Math.min(buffer.length, meta.ArchiveBytes - offset);
        const [n, readErr] = io.ReadFull(sourceReader, buffer.subarray(0, size));
        if (readErr != null) {
          return readErr;
        }
        const [ack, ackErr] = await this.checkpointTransferRequest(ctx, run, RunnerWorkspaceOperationCheckpointAppend, new WorkspaceCheckpointTransfer({ ID: manifest.ID, Offset: offset, Data: buffer.subarray(0, n) }));
        if (ackErr != null) {
          return ackErr;
        }
        offset += n;
        if (ack.ID !== manifest.ID || ack.Offset !== offset) {
          return new Error("invalid checkpoint upload acknowledgement");
        }
      }
      const [, commitErr] = await this.checkpointTransferRequest(ctx, run, RunnerWorkspaceOperationCheckpointCommit, new WorkspaceCheckpointTransfer({ ID: manifest.ID }));
      return commitErr;
    } finally {
      await this.closeCheckpointTransfer(ctx, run, manifest.ID);
    }
  } finally {
    source.Close();
  }
};

Engine.prototype.verifyStoredCheckpoint = async function (ctx, id) {
  let source;
  try {
    source = this.repo.OpenWorkspaceCheckpointArchive(id);
  } catch (err) {
    return err;
  }
  try {
    const [, copyErr] = io.Copy(io.Discard, new WorkspaceCheckpointContextReader(ctx, source));
    return copyErr;
  } finally {
    source.Close();
  }
};

class WorkspaceCheckpointContextReader {
  constructor(ctx, source) {
    this.ctx = ctx;
    this.source = source;
  }

  Read(data) {
    if (this.ctx instanceof AbortSignal && this.ctx.aborted) {
      return [0, this.ctx.reason];
    }
    return this.source.Read(data);
  }
}

class WorkspaceCheckpointContextWriter {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.destination = destination;
  }

  Write(data) {
    if (this.ctx instanceof AbortSignal && this.ctx.aborted) {
      return [0, this.ctx.reason];
    }
    return this.destination.Write(data);
  }
}

module.exports = { workspaceCheckpointResponseError, legacyCheckpointTerminalActive, WorkspaceCheckpointContextReader, WorkspaceCheckpointContextWriter, workspaceCheckpointTransferFromWire };
