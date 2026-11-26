/**
 * @file internal/managedcli/manifest.js
 * @description 对应 Go 文件：internal/managedcli/manifest.go。
 * 作用与职责边界：管理平台托管 CLI 的版本安装记录、全局状态文件（`state.json`）与单次运行固定清单（`pins/*.json`）的读写、
 * 根目录/子目录安全校验、可执行文件防符号链接逃逸校验及原子 JSON 写入。
 * 语法差异说明：
 * - `time.Time` / `*time.Time` 译为 `Date`（零值 `null`）；
 * - `Inventory`（`map[string]Installation`）及普通 `map[string]V` 译为普通对象 `{}`，Go 挂在 `Inventory` 上的方法 `BinaryFor` 译为独立函数；
 * - `(值, error)` 译为成功返回值、失败抛出 `Error`；仅 `error` 译为成功返回 `undefined`、失败抛出 `Error`；
 * - `(值, bool)` 译为 `[值, boolean]` 元组；
 * - 与 `providers.js` 存在同包循环引用，调用时延迟 `require("./providers.js")`。
 */

"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const releaseVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * 指向单个不可变、按版本隔离的托管 CLI 安装记录（不包含认证或配置目录）。
 * 使用场景：存储在 `State.Current`、`State.Previous`、`State.Candidates` 以及 `pins/*.json` 清单中。
 */
class Installation {
  /**
   * 构造 `Installation` 实例，兼容 Go 大写字段名与 JSON 小写 tag 字段名。
   * 使用场景：从 `state.json`/`pins/*.json` 反序列化或在安装完成后组装新记录。
   *
   * @param {object|null} [init={}] 初始字段对象，允许传入 Go 字段名或 JSON 字段名。
   */
  constructor(init = {}) {
    const src = init ?? {};
    this.Version = src.Version ?? src.version ?? "";
    this.Binary = src.Binary ?? src.binary ?? "";
    this.Integrity = src.Integrity ?? src.integrity ?? "";
    this.PublishedAt = toDate(src.PublishedAt ?? src.publishedAt ?? null);
    this.InstalledAt = toDate(src.InstalledAt ?? src.installedAt ?? null);
  }

  /**
   * 按 Go struct JSON tag 规则序列化为普通对象，跳过值为空的 `omitempty` 字段。
   * 使用场景：供 `JSON.stringify` 在持久化状态文件或固定清单时自动调用。
   *
   * @returns {{ version: string, binary: string, integrity?: string, publishedAt?: Date, installedAt?: Date }} 序列化后的 JSON 对象。
   */
  toJSON() {
    const out = { version: this.Version, binary: this.Binary };
    if (this.Integrity !== "") {
      out.integrity = this.Integrity;
    }
    if (this.PublishedAt != null) {
      out.publishedAt = this.PublishedAt;
    }
    if (this.InstalledAt != null) {
      out.installedAt = this.InstalledAt;
    }
    return out;
  }
}

/**
 * 从清单映射中查找指定供应商的可执行文件路径。
 * 使用场景：对应 Go 的 `(i Inventory) BinaryFor(provider string) (string, bool)`，供沙箱或命令解析逻辑查询已激活 CLI 路径。
 *
 * @param {Record<string, Installation>|null|undefined} inventory 供应商到安装记录的映射对象。
 * @param {string} provider 供应商标识名（如 `"claude-code"`、`"codex"`）。
 * @returns {[string, boolean]} 元组 `[可执行文件路径, 是否存在且非空]`。
 */
function BinaryFor(inventory, provider) {
  const ok = inventory != null && Object.prototype.hasOwnProperty.call(inventory, provider);
  const v = ok ? inventory[provider] : null;
  const binary = v != null ? v.Binary : "";
  return [binary, ok && binary !== ""];
}

/**
 * 托管 CLI 更新器的持久化状态，包含日检时间、候选/当前/回滚版本清单、已拒绝版本及供应商观察历史。
 * 使用场景：对应 `root/state.json`，由 `ReadState` 读取并在原子重命名中整体提交。
 */
class State {
  /**
   * 构造 `State` 实例，兼容 Go 大写字段名与 JSON 小写 tag 字段名，并将缺省映射初始化为空对象。
   * 使用场景：从 `state.json` 反序列化或初始化全新状态对象。
   *
   * @param {object|null} [init={}] 初始字段对象。
   */
  constructor(init = {}) {
    const src = init ?? {};
    this.LastCheck = toDate(src.LastCheck ?? src.lastCheck ?? null);
    this.Candidates = toInventory(src.Candidates ?? src.candidates ?? {});
    this.Current = toInventory(src.Current ?? src.current ?? {});
    this.Previous = toInventory(src.Previous ?? src.previous ?? {});
    this.Rejected = src.Rejected ?? src.rejected ?? {};
    this.VendorObservations = src.VendorObservations ?? src.vendorObservations ?? {};
    this.UpdatedAt = toDate(src.UpdatedAt ?? src.updatedAt ?? null);
  }

  /**
   * 按 Go struct JSON tag 规则序列化为普通对象，跳过空映射和空时间的 `omitempty` 字段。
   * 使用场景：供 `JSON.stringify` 在写入 `state.json` 时自动调用。
   *
   * @returns {object} 序列化后的状态 JSON 对象。
   */
  toJSON() {
    const out = {
      lastCheck: this.LastCheck,
      candidates: this.Candidates,
      current: this.Current,
      previous: this.Previous,
    };
    if (Object.keys(this.Rejected).length > 0) {
      out.rejected = this.Rejected;
    }
    if (Object.keys(this.VendorObservations).length > 0) {
      out.vendorObservations = this.VendorObservations;
    }
    if (this.UpdatedAt != null) {
      out.updatedAt = this.UpdatedAt;
    }
    return out;
  }
}

/**
 * 将 JSON 反序列化得到的时间字符串或 `Date` 统一转换为 `Date`（空值或无效日期返回 `null`）。
 * 使用场景：供 `manifest.js`、`updater.js`、`registry.js`、`vendor_observation.js` 构造含时间字段的对象时使用。
 *
 * @param {Date|string|number|null|undefined} v 原始时间值。
 * @returns {Date|null} 有效 `Date` 对象或 `null`。
 */
function toDate(v) {
  if (v == null) {
    return null;
  }
  if (v instanceof Date) {
    return v;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 将原始供应商映射对象规范化为 `{ [provider]: Installation }` 映射。
 * 使用场景：供 `State` 构造器规范化 `Candidates`、`Current` 与 `Previous` 字段。
 *
 * @param {Record<string, object>|null|undefined} raw 原始映射对象。
 * @returns {Record<string, Installation>} 规范化后的安装清单对象。
 */
function toInventory(raw) {
  const out = {};
  if (raw == null) {
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    out[k] = v instanceof Installation ? v : new Installation(v);
  }
  return out;
}

/**
 * 读取并校验托管 CLI 根目录下的 `state.json` 状态文件；文件不存在时返回空初始化状态。
 * 使用场景：更新器、回滚流程或 `ReadInventory` 加载当前激活清单与回滚指针时调用。
 *
 * @param {string} root 托管 CLI 根目录绝对路径。
 * @returns {State} 已校验 `Current` 清单的状态实例；根目录非法、JSON 解析失败或当前清单非法时抛出错误。
 */
function ReadState(root) {
  validRoot(root);
  const state = new State();
  let err = null;
  try {
    readJSON(path.join(root, "state.json"), state);
  } catch (e) {
    err = e;
  }
  if (err != null && !isNotExist(err)) {
    throw err;
  }
  // Go 中对 nil 映射逐一初始化为空映射；JS 的 State 构造器已将各映射初始化为空对象。
  try {
    validateInventory(root, state.Current);
  } catch (e) {
    throw new Error(`current inventory: ${e.message}`, { cause: e });
  }
  return state;
}

/**
 * 读取托管 CLI 根目录当前已激活的供应商安装清单。
 * 使用场景：运行期或固定清单前获取 `State.Current` 快照时调用。
 *
 * @param {string} root 托管 CLI 根目录绝对路径。
 * @returns {Record<string, Installation>} 当前激活的供应商安装清单；读取或校验失败时抛出错误。
 */
function ReadInventory(root) {
  const state = ReadState(root);
  return state.Current;
}

/**
 * 为指定运行键（`runKey`）固定并持久化一份完整的安装清单快照（包含尚未安装时的空清单）。
 * 使用场景：任务首次认领时调用，将当前激活版本以硬链接原子发布到 `root/pins/<sha256>.json`，
 * 使并发认领或挂起恢复后的任务始终使用同一版本集合。
 *
 * @param {string} root 托管 CLI 根目录绝对路径。
 * @param {string} runKey 运行唯一标识键（不可为空白字符串）。
 * @returns {Record<string, Installation>} 已校验的固定清单对象；参数非法、读写失败或清单非法时抛出错误。
 */
function PinInventory(root, runKey) {
  if (runKey.trim() === "") {
    throw new Error("managed CLI run key is required");
  }
  prepareDirectory(root, "pins");
  const sum = createHash("sha256").update(runKey).digest("hex");
  const filePath = path.join(root, "pins", sum + ".json");
  const pinned = {};
  let err = null;
  try {
    readJSON(filePath, pinned);
  } catch (e) {
    err = e;
  }
  if (err == null) {
    validateInventory(root, pinned);
    return pinned;
  } else if (!isNotExist(err)) {
    throw err;
  }
  const current = ReadInventory(root);
  const tmp = writeTemporaryJSON(path.dirname(filePath), current);
  try {
    try {
      fs.linkSync(tmp, filePath);
    } catch (e) {
      if (e.code !== "EEXIST") {
        throw new Error(`publish run inventory: ${e.message}`, { cause: e });
      }
    }
  } finally {
    try {
      fs.rmSync(tmp, { force: true }); // 仅删除上面创建的临时文件，对应 Go 的 defer os.Remove(tmp)
    } catch {
      // 忽略清理错误，避免覆盖主流程错误。
    }
  }
  const pinned2 = {};
  readJSON(filePath, pinned2);
  validateInventory(root, pinned2);
  return pinned2;
}

/**
 * 校验托管 CLI 根目录路径：必须是规范化后的非根绝对路径，且若已存在则必须是真实目录而非符号链接。
 * 使用场景：由 `ReadState`、`prepareDirectory` 与 `NewManager` 在操作根目录前调用。
 *
 * @param {string} root 待校验的根目录路径。
 * @returns {void} 无返回值；路径非法或目录为符号链接/非常规目录时抛出错误。
 */
function validRoot(root) {
  if (!path.isAbsolute(root) || path.normalize(root) !== root || root === path.sep) {
    throw new Error("managed CLI root must be a clean absolute non-root directory");
  }
  let info;
  try {
    info = fs.lstatSync(root);
  } catch (err) {
    if (!isNotExist(err)) {
      throw err;
    }
    return;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("managed CLI root must be a real directory, not a symlink");
  }
}

/**
 * 校验并创建托管 CLI 根目录及可选的相对子目录，逐级确认每一层目录都是真实目录而非符号链接。
 * 使用场景：在创建锁目录、`pins`、`tmp`、`updater-home` 或供应商目录前调用。
 *
 * @param {string} root 托管 CLI 根目录绝对路径。
 * @param {string} rel 相对于 `root` 的子目录路径；为空字符串时仅准备根目录。
 * @returns {void} 无返回值；路径非法、创建失败或任一层级非真实目录时抛出错误。
 */
function prepareDirectory(root, rel) {
  validRoot(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (rel === "") {
    return;
  }
  if (path.isAbsolute(rel) || path.normalize(rel) !== rel || rel === ".." || rel.startsWith(".." + path.sep)) {
    throw new Error("invalid managed CLI subdirectory");
  }
  let dirPath = root;
  for (const part of rel.split(path.sep)) {
    dirPath = path.join(dirPath, part);
    try {
      fs.mkdirSync(dirPath, { mode: 0o700 });
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
    }
    const info = fs.lstatSync(dirPath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`managed CLI directory is not a real directory: ${dirPath}`);
    }
  }
}

/**
 * 校验安装清单中每个供应商的名称、版本号格式、路径归属、符号链接解析边界及可执行权限。
 * 使用场景：在读取状态、固定清单、暂存安装及发布激活前调用，防止未知供应商或符号链接逃逸。
 *
 * @param {string} root 托管 CLI 根目录绝对路径。
 * @param {Record<string, Installation>|null|undefined} inventory 待校验的安装清单对象。
 * @returns {void} 无返回值；清单为空或任一项不合规时抛出错误。
 */
function validateInventory(root, inventory) {
  if (inventory == null) {
    throw new Error("managed CLI inventory must be a JSON object");
  }
  for (const [provider, installed] of Object.entries(inventory)) {
    if (!require("./providers.js").Supports(provider)) {
      throw new Error(`unknown managed CLI provider ${JSON.stringify(provider)}`);
    }
    if (!require("./providers.js").validProviderVersion(provider, installed.Version)) {
      throw new Error(`invalid release version for ${provider}`);
    }
    const base = path.join(root, "providers", provider);
    if (!within(base, installed.Binary)) {
      throw new Error(`${provider} executable escapes its managed installation`);
    }
    const resolvedBase = fs.realpathSync(base);
    const resolved = fs.realpathSync(installed.Binary);
    let resolvedRoot;
    try {
      resolvedRoot = fs.realpathSync(root);
    } catch {
      throw new Error("managed provider directory escapes root");
    }
    const expectedProviderBase = path.join(resolvedRoot, "providers", provider);
    if (!within(expectedProviderBase, resolvedBase) && resolvedBase !== expectedProviderBase) {
      throw new Error("managed provider directory escapes root");
    }
    if (!within(resolvedBase, resolved)) {
      throw new Error("managed executable symlink escapes installation");
    }
    let info;
    try {
      info = fs.statSync(resolved);
    } catch {
      throw new Error(`managed CLI ${provider} is not executable`);
    }
    if (!info.isFile() || (info.mode & 0o111) === 0) {
      throw new Error(`managed CLI ${provider} is not executable`);
    }
  }
}

/**
 * 判断绝对路径 `filePath` 是否严格位于目录 `root` 之下（不包含 `root` 本身及父级逃逸路径）。
 * 使用场景：用于校验可执行文件、符号链接解析结果与暂存目录是否处于允许的目录边界内。
 *
 * @param {string} root 基准目录路径。
 * @param {string} filePath 待检查的目标路径。
 * @returns {boolean} 若 `filePath` 是绝对路径且严格在 `root` 内部则返回 `true`，否则返回 `false`。
 */
function within(root, filePath) {
  if (!path.isAbsolute(filePath)) {
    return false;
  }
  // Go 的 filepath.Rel 同路径返回 "."，Node 的 path.relative 返回 ""，跨盘符时返回绝对路径，需一并排除。
  const rel = path.relative(root, filePath);
  return rel !== "" && rel !== "." && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/**
 * 读取并校验常规 JSON 控制文件（大小不超过 1 MiB、无尾随内容），并将解码结果填充到目标对象 `v` 中。
 * 使用场景：供 `ReadState` 读取 `state.json` 与 `PinInventory` 读取 `pins/*.json` 调用。
 *
 * @param {string} filePath JSON 文件路径。
 * @param {State|Record<string, Installation>} v 接收解码结果的目标对象（`State` 实例或清单普通对象）。
 * @returns {void} 无返回值；文件不存在、非常规文件、超过 1 MiB 或 JSON 结构非法时抛出错误。
 */
function readJSON(filePath, v) {
  const info = fs.lstatSync(filePath); // 不存在时抛出 ENOENT，对应 Go 的 os.Lstat 错误
  if (!info.isFile() || info.size > 1 << 20) {
    throw new Error(`invalid managed CLI JSON file: ${filePath}`);
  }
  const fd = fs.openSync(filePath, "r");
  let data;
  try {
    // 对应 Go 的 io.LimitReader(f, (1<<20)+1)，最多读取 1 MiB + 1 字节。
    const readCap = (1 << 20) + 1;
    const buf = Buffer.allocUnsafe(readCap);
    let offset = 0;
    while (offset < readCap) {
      const n = fs.readSync(fd, buf, offset, readCap - offset, offset);
      if (n === 0) {
        break;
      }
      offset += n;
    }
    data = buf.subarray(0, offset).toString("utf8");
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 忽略关闭错误，保留主流程结果或错误。
    }
  }
  // Go 通过 json.Decoder 二次解码校验无尾随内容；JSON.parse 原生拒绝尾随多余内容。
  const parsed = JSON.parse(data);
  if (parsed == null) {
    if (v instanceof State) {
      throw new Error("managed CLI state must be a JSON object");
    }
    throw new Error("managed CLI inventory must be a JSON object");
  }
  if (v instanceof State) {
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("managed CLI state must be a JSON object");
    }
    const rebuilt = new State(parsed);
    Object.assign(v, rebuilt);
    return;
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("managed CLI inventory must be a JSON object");
  }
  for (const [k, val] of Object.entries(parsed)) {
    v[k] = new Installation(val);
  }
}

/**
 * 将对象格式化为带缩进与尾随换行的 JSON，写入同目录的私有临时文件并执行 `fsync` 落盘。
 * 使用场景：供 `PinInventory`（硬链接发布）和 `atomicJSON`（原子重命名发布）内部调用。
 *
 * @param {string} dir 临时文件所在目录（与最终目标同目录以保证同文件系统原子操作）。
 * @param {any} v 待序列化写入的数据对象。
 * @returns {string} 新建并已同步落盘的临时文件绝对路径；写入、同步或关闭失败时删除临时文件并抛出错误。
 */
function writeTemporaryJSON(dir, v) {
  const data = JSON.stringify(v, null, "  ");
  // 对应 Go 的 os.CreateTemp(dir, ".managed-cli-*")：独占创建 0600 临时文件，失败不留残留。
  const tmpPath = path.join(dir, `.managed-cli-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
  const f = fs.openSync(tmpPath, "wx", 0o600);
  let err = null;
  try {
    fs.writeSync(f, data + "\n");
    fs.fsyncSync(f);
  } catch (e) {
    err = e;
  }
  try {
    fs.closeSync(f);
  } catch (closeErr) {
    if (err == null) {
      err = closeErr;
    }
  }
  if (err != null) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // 忽略清理错误，抛出写入/同步/关闭错误。
    }
    throw err;
  }
  return tmpPath;
}

/**
 * 先校验目标路径若存在则必须是常规文件，再通过写临时文件加原子重命名的方式更新 JSON 文件。
 * 使用场景：由 `Manager.prototype.save` 写 `state.json` 与 `Manager.prototype.run` 写 `last-report.json` 时调用。
 *
 * @param {string} filePath 目标 JSON 文件绝对路径。
 * @param {any} v 待序列化写入的数据对象。
 * @returns {void} 无返回值；目标为非常规文件、写入或重命名失败时抛出错误。
 */
function atomicJSON(filePath, v) {
  let info;
  try {
    info = fs.lstatSync(filePath);
  } catch (err) {
    if (!isNotExist(err)) {
      throw err;
    }
  }
  if (info != null && !info.isFile()) {
    throw new Error("refuse to replace non-regular managed state file");
  }
  const tmp = writeTemporaryJSON(path.dirname(filePath), v);
  try {
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      fs.rmSync(tmp, { force: true }); // 重命名成功后临时文件已不存在，仅清理失败残留
    } catch {
      // 忽略清理错误，避免覆盖重命名错误。
    }
  }
}

/**
 * 判断错误对象是否为“文件或目录不存在”（`ENOENT`），对应 Go 的 `os.IsNotExist`。
 * 使用场景：供本文件及同包逻辑区分缺失文件与真实 I/O 异常。
 *
 * @param {NodeJS.ErrnoException|Error|null|undefined} err 待判断的错误对象。
 * @returns {boolean} 当且仅当错误码为 `"ENOENT"` 时返回 `true`。
 */
function isNotExist(err) {
  return err != null && err.code === "ENOENT";
}

module.exports = {
  releaseVersion,
  toDate,
  Installation,
  BinaryFor,
  State,
  ReadState,
  ReadInventory,
  PinInventory,
  validRoot,
  prepareDirectory,
  validateInventory,
  within,
  readJSON,
  writeTemporaryJSON,
  atomicJSON,
  isNotExist,
};
