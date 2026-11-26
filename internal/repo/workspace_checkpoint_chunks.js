// workspace_checkpoint_chunks.js —— 对应 Go 文件：internal/repo/workspace_checkpoint_chunks.go
// 作用：工作区快照分块流式保存与读取：大快照分片落盘、按租约发布、按序校验回读。
// Go 的 io/bytes 没有同步的 JS 对应写法：io.* 与 bytes.NewReader 调用按原文保留作对照，
// source 是调用方传入的 reader；io.Reader 的 Read 返回 [n, err]，EOF 是正常结束信号。
// (值, error) 译为返回值、失败 throw；defer 译为 try/finally；time.Duration 换算为毫秒。

"use strict";

const { Buffer } = require("node:buffer");
const { randomBytes, createHash } = require("node:crypto");

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { WorkspaceCheckpoint, ErrWorkspaceInUse } = require("./workspace_checkpoints.js"); // 对应 Go 同包类型与错误，workspace_checkpoints.js 本次一同翻译

const workspaceCheckpointChunkBytes = 4 << 20;
const workspaceCheckpointArchiveBytes = 512 << 20;
const workspaceCheckpointInlineBytes = 12 << 20;

class workspaceCheckpointChunk {
  constructor(init = {}) {
    this.RunID = init.RunID ?? "";
    this.ArchiveID = init.ArchiveID ?? "";
    this.Sequence = init.Sequence ?? 0;
    this.Data = init.Data ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
  }

  TableName() {
    return "run_workspace_checkpoint_chunks";
  }
}

// Stage bounded rows, then publish the manifest by lease CAS. A failed save
// cannot replace the previous archive. Crashed staging rows expire on the next
// save; deleting a run also deletes all its chunks.
RunsRepo.prototype.SaveWorkspaceCheckpointStream = function (runID, token, now, source) {
  // Keep the legacy representation for small archives, including during a
  // rolling upgrade. The lookahead is bounded independently of archive size.
  const [prefix, readErr] = io.ReadAll(io.LimitReader(source, workspaceCheckpointInlineBytes + 1));
  if (readErr != null) {
    return readErr;
  }
  if (prefix.length <= workspaceCheckpointInlineBytes) {
    return this.SaveWorkspaceCheckpoint(runID, token, now, prefix);
  }
  source = io.MultiReader(bytes.NewReader(prefix), source);
  let raw;
  try {
    raw = randomBytes(24);
  } catch (err) {
    return err;
  }
  const id = raw.toString("hex");
  let published = false;
  try {
    const deleteErr = this.DB.Where("run_id = ? AND created_at < ? AND archive_id NOT IN (?)", runID, new Date(Date.now() - 60 * 60 * 1000),
      this.DB.Model(new WorkspaceCheckpoint()).Select("COALESCE(archive_id, '')").Where("run_id = ?", runID)).Delete(new workspaceCheckpointChunk()).Error;
    if (deleteErr != null) {
      return deleteErr;
    }
    const hash = createHash("sha256");
    let size = 0;
    let count = 0;
    const buffer = Buffer.alloc(workspaceCheckpointChunkBytes);
    for (;;) {
      const [n, err] = io.ReadFull(source, buffer);
      if (err != null && err !== io.EOF && err !== io.ErrUnexpectedEOF) {
        return err;
      }
      if (n === 0) {
        break;
      }
      size += n;
      if (size > workspaceCheckpointArchiveBytes) {
        return new Error("workspace checkpoint exceeds archive size limit");
      }
      // Go 的 Count(&n) 用对象接出参。
      const active = { value: 0 };
      const countErr = this.DB.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, new Date()).Count(active).Error;
      if (countErr != null) {
        return countErr;
      }
      if (active.value !== 1) {
        return ErrWorkspaceInUse;
      }
      const chunk = new workspaceCheckpointChunk({ RunID: runID, ArchiveID: id, Sequence: count, Data: buffer.subarray(0, n), CreatedAt: new Date() });
      const createErr = this.DB.Create(chunk).Error;
      if (createErr != null) {
        return createErr;
      }
      hash.update(buffer.subarray(0, n));
      count++;
      if (err === io.ErrUnexpectedEOF) {
        break;
      }
    }
    if (size === 0) {
      return new Error("empty workspace checkpoint");
    }
    const err = this.DB.Transaction((tx) => {
      this.takeRunForUpdate(tx, runID);
      const result = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, new Date()).Updates({
        archive: null, archive_id: id, archive_bytes: size, archive_chunks: count,
        // Go 的 hash.Sum 不终结 hash，JS 用 copy().digest 保留这一语义。
        sha256: hash.copy().digest("hex"), saved_at: now, error: "", save_failures: 0, save_retry_at: null,
      });
      if (result.Error != null) {
        return result.Error;
      }
      if (result.RowsAffected !== 1) {
        return ErrWorkspaceInUse;
      }
      return tx.Where("run_id = ? AND archive_id <> ?", runID, id).Delete(new workspaceCheckpointChunk()).Error;
    });
    published = err == null;
    return err;
  } finally {
    // Go 的 defer：未发布时删掉本次暂存的分块。
    if (!published) {
      this.DB.Where("run_id = ? AND archive_id = ?", runID, id).Delete(new workspaceCheckpointChunk());
    }
  }
};

RunsRepo.prototype.OpenWorkspaceCheckpointArchive = function (runID) {
  const item = new WorkspaceCheckpoint();
  const err = this.DB.Where("run_id = ?", runID).Take(item).Error;
  if (err != null) {
    throw err;
  }
  if (item.ArchiveID === "") {
    if ((item.Archive ?? []).length === 0) {
      throw new Error("该任务尚无可恢复的工作区快照；未保存的历史文件无法恢复");
    }
    const sum = createHash("sha256").update(item.Archive).digest();
    if (sum.toString("hex") !== item.SHA256) {
      throw new Error("工作区快照校验失败");
    }
    return io.NopCloser(bytes.NewReader(item.Archive));
  }
  if (item.ArchiveBytes <= 0 || item.ArchiveBytes > workspaceCheckpointArchiveBytes || item.ArchiveChunks !== Math.floor((item.ArchiveBytes + workspaceCheckpointChunkBytes - 1) / workspaceCheckpointChunkBytes) || item.SHA256.length !== 64) {
    throw new Error("工作区快照校验失败：invalid manifest");
  }
  const reader = new workspaceCheckpointReader({ repo: this, manifest: item, hash: createHash("sha256") });
  return io.NopCloser(reader);
};

class workspaceCheckpointReader {
  constructor(init = {}) {
    this.repo = init.repo ?? null;
    this.manifest = init.manifest ?? null;
    this.hash = init.hash ?? null;
    this.err = init.err ?? null;
    this.next = init.next ?? 0;
    this.read = init.read ?? 0;
    this.buffer = init.buffer ?? null;
  }

  Read(data) {
    if (this.err != null) {
      return [0, this.err];
    }
    if (data.length === 0) {
      return [0, null];
    }
    if (this.buffer == null || this.buffer.length === 0) {
      if (this.read === this.manifest.ArchiveBytes) {
        return [0, io.EOF];
      }
      const chunk = new workspaceCheckpointChunk();
      const err = this.repo.DB.Where("run_id = ? AND archive_id = ? AND sequence = ?", this.manifest.RunID, this.manifest.ArchiveID, this.next).Take(chunk).Error;
      if (err != null) {
        return [0, new Error(`read checkpoint chunk ${this.next}: ${err}`)];
      }
      const expected = Math.min(workspaceCheckpointChunkBytes, this.manifest.ArchiveBytes - this.read);
      if ((chunk.Data ?? []).length !== expected) {
        return [0, new Error("invalid checkpoint chunk size")];
      }
      this.buffer = chunk.Data;
      this.next++;
    }
    const n = this.buffer.copy(data);
    this.hash.update(data.subarray(0, n));
    this.buffer = this.buffer.subarray(n);
    this.read += n;
    if (this.read === this.manifest.ArchiveBytes && this.hash.copy().digest("hex") !== this.manifest.SHA256) {
      this.err = new Error("工作区快照校验失败");
      return [n, this.err];
    }
    return [n, null];
  }
}

module.exports = { workspaceCheckpointChunkBytes, workspaceCheckpointArchiveBytes, workspaceCheckpointInlineBytes, workspaceCheckpointChunk, workspaceCheckpointReader };
