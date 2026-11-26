/**
 * @file internal/repo/integration_lock.js
 * 对应 Go 源文件：internal/repo/integration_lock.go
 *
 * 作用与职责边界：
 * 为交付仓库 `DeliveryRepo` 提供仓库集成分支合入锁能力，用于在多控制面实例之间串行化同一仓库的合入流程：
 * MySQL 环境下基于独立连接申请命名锁（`GET_LOCK` / `RELEASE_LOCK`），SQLite 单进程环境下退化为进程内互斥锁映射。
 * 不负责具体的 Git 合入执行或 MR 交付状态持久化。
 *
 * 语法差异说明：
 * - `DeliveryRepo` 定义于 `repo.js`（继承 `deps`），本文件通过 `DeliveryRepo.prototype` 挂载 `LockIntegration` 方法。
 * - Go 的 `sync.Map` 译为 `Map`；JS 单线程环境下 `sync.Mutex` 的加锁/解锁为空操作，仅保留解锁回调结构以与 Go 对照。
 * - Go 的 `(func(), error)` 译为成功返回解锁函数、失败抛出 `Error`；`database/sql` 的 `Scan`/`Close`/`ExecContext` 按成功返回、失败抛错处理，`_ = ...` 忽略错误处用 `try/catch` 吞掉异常。
 * - Go 的 `context.Context` 译为 `AbortSignal`（`context.Background()` 传 `null`）；`time.Duration` 译为毫秒数，整数除法 `int(wait/time.Second)` 使用 `Math.trunc(wait / 1000)` 保持向零截断语义；`len(name)` 按 UTF-8 字节长度使用 `Buffer.byteLength(name, "utf8")`。
 */

"use strict";

const { Buffer } = require("node:buffer");

const { DeliveryRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译
const { hexSHA256 } = require("./hash.js"); // 对应 Go 同包函数，hash.js 已翻译

// SQLite 单进程测试环境下的进程内合入锁映射（Go 的 sync.Map 译为 Map）。
const localIntegrationLocks = new Map();

/**
 * 获取指定仓库集成分支的串行合入锁，并返回用于释放锁的回调函数。
 * MySQL 下在独立数据库连接上持有命名锁，连接断开或持有者崩溃时锁自动释放；SQLite 下使用进程内映射锁。
 * 用于跨多个控制面实例串行执行同一仓库的分支合入，防止并发合入冲突。
 *
 * @param {AbortSignal | null} ctx - 取消信号上下文，用于获取数据库连接与等待 MySQL 命名锁。
 * @param {string} repositoryID - 目标仓库唯一标识。
 * @param {number} wait - 获取命名锁的最大等待时长（毫秒）。
 * @returns {function(): void} 释放该合入锁的无参回调函数；释放失败时静默忽略。
 * @throws {Error} 获取底层数据库连接失败、锁查询失败或等待超时时抛出错误。
 */
DeliveryRepo.prototype.LockIntegration = function (ctx, repositoryID, wait) {
  const name = integrationLockName(repositoryID);
  if (!this.isMySQL()) {
    let m = localIntegrationLocks.get(name);
    if (m === undefined) {
      // JS 单线程下 sync.Mutex 加锁与解锁为空操作。
      m = { Lock: () => {}, Unlock: () => {} };
      localIntegrationLocks.set(name, m);
    }
    const mu = m;
    mu.Lock();
    return mu.Unlock;
  }
  const db = this.DB.DB();
  const conn = db.Conn(ctx);
  // Go 的 sql.NullInt64 用带 Valid 与 Int64 字段的对象表示。
  const got = { Valid: false, Int64: 0 };
  try {
    // Go 的 int(wait/time.Second) 向零截断取整秒数；JS 的 wait 单位为毫秒。
    conn.QueryRowContext(ctx, "SELECT GET_LOCK(?, ?)", name, Math.trunc(wait / 1000)).Scan(got);
  } catch (err) {
    try {
      conn.Close();
    } catch {
      // Go 忽略关闭连接时的错误。
    }
    throw err;
  }
  if (!got.Valid || got.Int64 !== 1) {
    try {
      conn.Close();
    } catch {
      // Go 忽略关闭连接时的错误。
    }
    throw new Error(`等待仓库 ${repositoryID} 的合入锁超时（${wait}）`);
  }
  return () => {
    // Go 的 context.Background() 在 JS 中以 null 表示。
    try {
      conn.ExecContext(null, "SELECT RELEASE_LOCK(?)", name);
    } catch {
      // Go 忽略释放命名锁时的错误。
    }
    try {
      conn.Close();
    } catch {
      // Go 忽略关闭连接时的错误。
    }
  };
};

/**
 * 生成符合 MySQL 64 字节长度上限的仓库合入命名锁名称。
 * 去除空白后为空的仓库 ID 替换为 `"_"`；拼接前缀后若 UTF-8 字节长度超过 64 字节，则改用仓库 ID 的 SHA-256 前 40 位十六进制摘要。
 *
 * @param {string} repositoryID - 原始仓库唯一标识。
 * @returns {string} 长度不超过 64 字节的 MySQL 命名锁名称。
 */
function integrationLockName(repositoryID) {
  let id = repositoryID.trim();
  if (id === "") {
    id = "_";
  }
  const name = "agentflow:integrate:" + id;
  if (Buffer.byteLength(name, "utf8") <= 64) {
    return name;
  }
  return "agentflow:integrate:" + hexSHA256(id).slice(0, 40);
}

module.exports = { integrationLockName };
