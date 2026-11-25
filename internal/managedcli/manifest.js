// manifest.js —— 对应 Go 文件：internal/managedcli/manifest.go
// 作用：托管 CLI 的安装清单与状态文件读写：版本、安装位置、回滚指针。
// Go 的 time.Time 译为 JS Date；(值, error) 译为成功返回值、失败 throw；
// Go 的 map[string]X 译为普通对象；os.FileMode 位运算按原样保留。

"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// 与 providers.js 循环引用：两边都在末尾重写 module.exports，顶层缓存的模块对象会是
// 加载中的空对象；故调用时现取 require("./providers.js")，不缓存。

const releaseVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

// Installation 指向一个不可变的版本专属 CLI 安装。
// Authentication/configuration homes are deliberately not part of this record.
class Installation {
  // 构造器同时认 Go 字段名与 JSON tag 名：state.json 里是小写 tag 名。
  constructor(init = {}) {
    this.Version = init.Version ?? init.version ?? "";
    this.Binary = init.Binary ?? init.binary ?? "";
    this.Integrity = init.Integrity ?? init.integrity ?? "";
    this.PublishedAt = toDate(init.PublishedAt ?? init.publishedAt ?? null);
    this.InstalledAt = toDate(init.InstalledAt ?? init.installedAt ?? null);
  }

  // toJSON：Go 的 json.Marshal 按 tag 输出，omitempty 字段为空时省略。
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

// Inventory：Go 的 type Inventory map[string]Installation，译为普通对象 {provider: Installation}。
// BinaryFor 是 Go 挂在该 map 类型上的方法，译为同名独立函数。
function BinaryFor(inventory, provider) {
  const v = inventory[provider];
  const binary = v != null ? v.Binary : "";
  return [binary, v != null && binary !== ""];
}

class State {
  // 构造器同时认 Go 字段名与 JSON tag 名。
  constructor(init = {}) {
    this.LastCheck = toDate(init.LastCheck ?? init.lastCheck ?? null);
    this.Candidates = toInventory(init.Candidates ?? init.candidates ?? {});
    this.Current = toInventory(init.Current ?? init.current ?? {});
    this.Previous = toInventory(init.Previous ?? init.previous ?? {});
    this.Rejected = init.Rejected ?? init.rejected ?? {};
    this.VendorObservations = init.VendorObservations ?? init.vendorObservations ?? {};
    this.UpdatedAt = toDate(init.UpdatedAt ?? init.updatedAt ?? null);
  }

  // toJSON：Go 的 json.Marshal 按 tag 输出，omitempty 字段为空时省略。
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

// toDate：Go 的 time.Time 从 JSON 解出来是时间值；JS 里 JSON.parse 给的是字符串，
// 在此统一转成 Date，非法字符串转 null（Go 遇到非法时间会报解码错）。
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

function toInventory(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = v instanceof Installation ? v : new Installation(v);
  }
  return out;
}

// State and its rollback pointers are committed in one atomic rename.
function ReadState(root) {
  const rootErr = validRoot(root);
  if (rootErr != null) {
    throw rootErr;
  }
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
  // Go 的 state.Current/Previous/Candidates/Rejected/VendorObservations 为 nil 时逐个补空值；
  // JS 里 State 构造器已补全空对象/空映射。
  try {
    validateInventory(root, state.Current);
  } catch (e) {
    throw new Error(`current inventory: ${e.message}`);
  }
  return state;
}

function ReadInventory(root) {
  const state = ReadState(root);
  return state.Current;
}

// PinInventory fixes the complete inventory for a run in this root, including
// an empty one before provisioning. Pins live outside agent-controlled workspaces.
// Publishing via link makes concurrent first claims observe a complete file.
// Old versions and pins are not automatically deleted: suspended/resumable runs
// may still reference them after the runner or updater restarts.
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
    return validateInventoryPinned(root, pinned);
  } else if (!isNotExist(err)) {
    throw err;
  }
  const current = ReadInventory(root);
  const tmp = writeTemporaryJSON(path.dirname(filePath), current);
  try {
    fs.linkSync(tmp, filePath);
  } catch (e) {
    if (e.code !== "EEXIST") {
      throw new Error(`publish run inventory: ${e.message}`);
    }
  } finally {
    fs.rmSync(tmp, { force: true }); // 只删上面新建的临时文件
  }
  const pinned2 = {};
  readJSON(filePath, pinned2);
  return validateInventoryPinned(root, pinned2);
}

function validateInventoryPinned(root, pinned) {
  validateInventory(root, pinned);
  return pinned;
}

function validRoot(root) {
  if (!path.isAbsolute(root) || path.normalize(root) !== root || root === path.sep) {
    return new Error("managed CLI root must be a clean absolute non-root directory");
  }
  let info;
  try {
    info = fs.lstatSync(root);
  } catch (err) {
    if (!isNotExist(err)) {
      return err;
    }
    return null;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return new Error("managed CLI root must be a real directory, not a symlink");
  }
  return null;
}

function prepareDirectory(root, rel) {
  const rootErr = validRoot(root);
  if (rootErr != null) {
    throw rootErr;
  }
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
    const resolvedRoot = fs.realpathSync(root);
    if (!within(path.join(resolvedRoot, "providers", provider), resolvedBase) && resolvedBase !== path.join(resolvedRoot, "providers", provider)) {
      throw new Error("managed provider directory escapes root");
    }
    if (!within(resolvedBase, resolved)) {
      throw new Error("managed executable symlink escapes installation");
    }
    const info = fs.statSync(resolved);
    if (!info.isFile() || (info.mode & 0o111) === 0) {
      throw new Error(`managed CLI ${provider} is not executable`);
    }
  }
}

function within(root, filePath) {
  if (!path.isAbsolute(filePath)) {
    return false;
  }
  const rel = path.relative(root, filePath);
  return rel !== "." && rel !== ".." && !rel.startsWith(".." + path.sep);
}

function readJSON(filePath, v) {
  const info = fs.lstatSync(filePath); // 不存在时 throw，对应 Go 的 Lstat 错误
  if (!info.isFile() || info.size > 1 << 20) {
    throw new Error(`invalid managed CLI JSON file: ${filePath}`);
  }
  const data = fs.readFileSync(filePath, { encoding: "utf8" }).slice(0, (1 << 20) + 1);
  // Go 用 json.Decoder 连续 Decode 两次，第二次须为 EOF；JSON.parse 本身就拒绝尾部多余内容。
  const parsed = JSON.parse(data);
  // Go 把 JSON null 解码进 *State 会得到 nil，ReadState 随后报 state must be a JSON object；
  // 解码进 map 则得到 nil map（空清单），不报错。
  if (parsed == null) {
    if (v instanceof State) {
      throw new Error("managed CLI state must be a JSON object");
    }
    return;
  }
  if (v instanceof State) {
    const rebuilt = new State(parsed);
    Object.assign(v, rebuilt);
    return;
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("managed CLI state must be a JSON object");
  }
  for (const [k, val] of Object.entries(parsed)) {
    v[k] = new Installation(val);
  }
}

function writeTemporaryJSON(dir, v) {
  const data = JSON.stringify(v, null, "  ");
  // Go 的 os.CreateTemp：随机后缀新建文件，失败不留文件。
  const tmpPath = path.join(dir, `.managed-cli-${randomSuffix()}`);
  const f = fs.openSync(tmpPath, "wx", 0o600);
  try {
    fs.writeSync(f, data + "\n");
    fs.fsyncSync(f);
  } catch (err) {
    fs.closeSync(f);
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
  fs.closeSync(f);
  return tmpPath;
}

function randomSuffix() {
  return `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

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
    fs.rmSync(tmp, { force: true }); // rename 成功后已不存在，rm 仅清理失败残留
  }
}

// isNotExist：Go 的 os.IsNotExist 译为检查 err.code。
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
