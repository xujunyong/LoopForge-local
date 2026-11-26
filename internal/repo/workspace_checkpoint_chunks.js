/**
 * @file internal/repo/workspace_checkpoint_chunks.js
 * 对应 Go 源文件：internal/repo/workspace_checkpoint_chunks.go
 *
 * 作用与职责边界：
 * 实现大体积运行工作区快照的分块流式持久化（`run_workspace_checkpoint_chunks` 表）、
 * 按租约 CAS 原子发布快照清单、清理过期暂存分块，以及按序流式回读并校验整包 SHA-256 的读取器；
 * 领域方法挂载于 `RunsRepo.prototype`（`RunsRepo` 定义于 `repo.js`），不负责 tar 打包与解包。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理；
 *   `db.Transaction(tx => ...)` 回调同样遵循失败抛错、成功正常返回。
 * - Go 的 `io` / `bytes` 流式接口在 JS 中无 1:1 同步对应实现，保留 `io.*` 与 `bytes.NewReader` 名称作源码对照，
 *   并统一按返回值 / `throw`（包括 `io.EOF` 与 `io.ErrUnexpectedEOF`）约定表达。
 * - Go 的 `defer` 译为 `try { ... } finally { ... }`；`time.Hour` 换算为毫秒数 `60 * 60 * 1000`；
 *   Go 的 `hash.Sum(nil)` 不终结哈希状态，JS 使用 `hash.copy().digest("hex")` 保持相同语义。
 */

"use strict";

const { Buffer } = require("node:buffer");
const { randomBytes, createHash } = require("node:crypto");

const { RunsRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { WorkspaceCheckpoint, ErrWorkspaceInUse } = require("./workspace_checkpoints.js"); // 对应 Go 同包类型与错误，workspace_checkpoints.js 已翻译

// 单个分块上限（4 MiB）、整包归档大小上限（512 MiB）以及直接内联存放在主表的阈值（12 MiB）。
const workspaceCheckpointChunkBytes = 4 << 20;
const workspaceCheckpointArchiveBytes = 512 << 20;
const workspaceCheckpointInlineBytes = 12 << 20;

/**
 * 工作区快照分块表的物理行模型，对应数据库表 `run_workspace_checkpoint_chunks`。
 */
class workspaceCheckpointChunk {
  /**
   * 构造分块行对象，缺省字段按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.RunID=""] - 所属运行 ID（联合主键之一）。
   * @param {string} [init.ArchiveID=""] - 本次快照归档批次 ID（联合主键之一）。
   * @param {number} [init.Sequence=0] - 从 0 递增的分块序号（联合主键之一）。
   * @param {Buffer | null} [init.Data=null] - 当前分块的二进制载荷（最大 4 MiB）。
   * @param {Date | null} [init.CreatedAt=null] - 分块写入时间。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.RunID = init.RunID ?? "";
    this.ArchiveID = init.ArchiveID ?? "";
    this.Sequence = init.Sequence ?? 0;
    this.Data = init.Data ?? null;
    this.CreatedAt = init.CreatedAt ?? null;
  }

  /**
   * 返回当前模型对应的物理数据库表名。
   * 使用场景：供 GORM 映射物理表名称。
   *
   * @returns {string} 固定返回 `"run_workspace_checkpoint_chunks"`。
   */
  TableName() {
    return "run_workspace_checkpoint_chunks";
  }
}

/**
 * 以流式分块方式暂存工作区快照，再在事务中通过租约 CAS 原子发布快照清单；
 * 若总大小不超过内联阈值（12 MiB）则自动回退到 `SaveWorkspaceCheckpoint` 内联写入以保持滚动升级兼容。
 * 保存失败不会替换既有已发布的快照，未发布的暂存分块会在 `finally` 中自动清理，崩溃遗留分块也会在下次保存时过期清理。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} token - 当前调用方持有的工作区租约令牌。
 * @param {Date} now - 记为本次快照保存完成的时间戳。
 * @param {object} source - 提供工作区归档字节流的只读 `io.Reader` 对象。
 * @returns {void} 无返回值。
 * @throws {Error} 租约丢失/过期（`ErrWorkspaceInUse`）、归档为空或超过 512 MiB 上限、读流失败或数据库操作失败时抛出错误。
 */
RunsRepo.prototype.SaveWorkspaceCheckpointStream = function (runID, token, now, source) {
  // 对小归档沿用主表内联存储（兼容滚动升级）；预读字节数有固定上限，与归档总大小无关。
  const prefix = io.ReadAll(io.LimitReader(source, workspaceCheckpointInlineBytes + 1));
  if (prefix.length <= workspaceCheckpointInlineBytes) {
    this.SaveWorkspaceCheckpoint(runID, token, now, prefix);
    return;
  }
  source = io.MultiReader(bytes.NewReader(prefix), source);
  const raw = randomBytes(24);
  const id = raw.toString("hex");
  let published = false;
  try {
    const deleteErr = this.DB.Where("run_id = ? AND created_at < ? AND archive_id NOT IN (?)", runID, new Date(Date.now() - 60 * 60 * 1000),
      this.DB.Model(new WorkspaceCheckpoint()).Select("COALESCE(archive_id, '')").Where("run_id = ?", runID)).Delete(new workspaceCheckpointChunk()).Error;
    if (deleteErr != null) {
      throw deleteErr;
    }
    const hash = createHash("sha256");
    let size = 0;
    let count = 0;
    const buffer = Buffer.alloc(workspaceCheckpointChunkBytes);
    for (;;) {
      let n = 0;
      let unexpectedEOF = false;
      try {
        // Go 的 io.ReadFull 在正常读完流尾时返回 io.EOF，读到最后不足一块时返回部分字节数与 io.ErrUnexpectedEOF。
        n = io.ReadFull(source, buffer);
      } catch (err) {
        if (err === io.EOF) {
          break;
        }
        if (err === io.ErrUnexpectedEOF) {
          n = err.bytesRead ?? 0;
          unexpectedEOF = true;
        } else {
          throw err;
        }
      }
      if (n === 0) {
        break;
      }
      size += n;
      if (size > workspaceCheckpointArchiveBytes) {
        throw new Error("workspace checkpoint exceeds archive size limit");
      }
      // Go 的 Count(&active) 用对象接出参。
      const active = { value: 0 };
      const countErr = this.DB.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, new Date()).Count(active).Error;
      if (countErr != null) {
        throw countErr;
      }
      if (active.value !== 1) {
        throw ErrWorkspaceInUse;
      }
      const chunk = new workspaceCheckpointChunk({ RunID: runID, ArchiveID: id, Sequence: count, Data: buffer.subarray(0, n), CreatedAt: new Date() });
      const createErr = this.DB.Create(chunk).Error;
      if (createErr != null) {
        throw createErr;
      }
      hash.update(buffer.subarray(0, n));
      count++;
      if (unexpectedEOF) {
        break;
      }
    }
    if (size === 0) {
      throw new Error("empty workspace checkpoint");
    }
    this.DB.Transaction((tx) => {
      this.takeRunForUpdate(tx, runID);
      const result = tx.Model(new WorkspaceCheckpoint()).Where("run_id = ? AND lease_token = ? AND lease_until > ?", runID, token, new Date()).Updates({
        archive: null, archive_id: id, archive_bytes: size, archive_chunks: count,
        // Go 的 hash.Sum 不终结 hash，JS 用 copy().digest 保留这一语义。
        sha256: hash.copy().digest("hex"), saved_at: now, error: "", save_failures: 0, save_retry_at: null,
      });
      if (result.Error != null) {
        throw result.Error;
      }
      if (result.RowsAffected !== 1) {
        throw ErrWorkspaceInUse;
      }
      const cleanupErr = tx.Where("run_id = ? AND archive_id <> ?", runID, id).Delete(new workspaceCheckpointChunk()).Error;
      if (cleanupErr != null) {
        throw cleanupErr;
      }
    });
    published = true;
  } finally {
    // Go 的 defer：未发布时删掉本次暂存的分块。
    if (!published) {
      this.DB.Where("run_id = ? AND archive_id = ?", runID, id).Delete(new workspaceCheckpointChunk());
    }
  }
};

/**
 * 打开指定运行的工作区快照归档只读流：
 * 内联快照在打开时立即校验整包 SHA-256 并返回内存读取器；分块快照先校验清单元数据合法性，再返回按序分块拉取的流式读取器。
 *
 * @param {string} runID - 运行记录主键 ID。
 * @returns {object} 实现 `io.ReadCloser` 接口的快照归档读取器。
 * @throws {Error} 快照记录不存在、尚无归档数据、清单元数据非法或内联校验失败时抛出错误。
 */
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

/**
 * 按分块序号流式拉取工作区快照并在读完最后一字节时校验整包 SHA-256 的内部读取器。
 * 对应 Go 的 `workspaceCheckpointReader`（实现 `io.Reader` 接口）。
 */
class workspaceCheckpointReader {
  /**
   * 构造分块快照读取器实例，缺省字段按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {RunsRepo | null} [init.repo=null] - 用于查询分块表的运行仓储实例。
   * @param {WorkspaceCheckpoint} [init.manifest=new WorkspaceCheckpoint()] - 已校验通过的快照清单记录。
   * @param {object | null} [init.hash=null] - 增量计算 SHA-256 的哈希器实例。
   * @param {Error | null} [init.err=null] - 已发生的持久化终态错误（后续读取直接重抛）。
   * @param {number} [init.next=0] - 下一个待拉取的分块序号。
   * @param {number} [init.read=0] - 已交付给调用方的累计字节数。
   * @param {Buffer | null} [init.buffer=null] - 当前分块尚未被读取完的剩余字节切片。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.repo = init.repo ?? null;
    this.manifest = init.manifest ?? new WorkspaceCheckpoint();
    this.hash = init.hash ?? null;
    this.err = init.err ?? null;
    this.next = init.next ?? 0;
    this.read = init.read ?? 0;
    this.buffer = init.buffer ?? null;
  }

  /**
   * 从分块快照中读取最多 `data.length` 字节拷贝到目标缓冲区，按需拉取下一分块并累加 SHA-256；
   * 读完最后一个字节时校验整包摘要，不匹配则记录并抛出校验失败错误。
   *
   * @param {Buffer} data - 接收读取数据的目标字节缓冲区。
   * @returns {number} 本次实际写入 `data` 的字节数。
   * @throws {Error} 已到达流尾（`io.EOF`）、分块查询失败、分块长度与预期不符或整包 SHA-256 校验失败时抛出错误。
   */
  Read(data) {
    if (this.err != null) {
      throw this.err;
    }
    if (data.length === 0) {
      return 0;
    }
    if (this.buffer == null || this.buffer.length === 0) {
      if (this.read === this.manifest.ArchiveBytes) {
        throw io.EOF;
      }
      const chunk = new workspaceCheckpointChunk();
      const err = this.repo.DB.Where("run_id = ? AND archive_id = ? AND sequence = ?", this.manifest.RunID, this.manifest.ArchiveID, this.next).Take(chunk).Error;
      if (err != null) {
        throw new Error(`read checkpoint chunk ${this.next}: ${err}`);
      }
      const expected = Math.min(workspaceCheckpointChunkBytes, this.manifest.ArchiveBytes - this.read);
      if ((chunk.Data ?? []).length !== expected) {
        throw new Error("invalid checkpoint chunk size");
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
      throw this.err;
    }
    return n;
  }
}

module.exports = { workspaceCheckpointChunkBytes, workspaceCheckpointArchiveBytes, workspaceCheckpointInlineBytes, workspaceCheckpointChunk, workspaceCheckpointReader };
