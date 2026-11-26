// integration_lock.js —— 对应 Go 文件：internal/repo/integration_lock.go
// 作用：仓库合入分支锁：MySQL 用命名锁跨实例串行合入，sqlite 用进程内锁。

"use strict";

const { DeliveryRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译
const { hexSHA256 } = require("./hash.js"); // 对应 Go 同包函数，hash.js 已翻译

// Go 的 sync.Map 译为 Map；JS 单线程，sync.Mutex 的加锁/解锁为空操作。
const localIntegrationLocks = new Map();

DeliveryRepo.prototype.LockIntegration = function (ctx, repositoryID, wait) {
  const name = integrationLockName(repositoryID);
  if (!this.isMySQL()) {
    let m = localIntegrationLocks.get(name);
    if (m === undefined) {
      m = { Lock: () => {}, Unlock: () => {} };
      localIntegrationLocks.set(name, m);
    }
    const mu = m;
    mu.Lock();
    return mu.Unlock;
  }
  const db = this.DB.DB();
  const conn = db.Conn(ctx);
  const got = { Valid: false, Int64: 0 }; // Go 的 sql.NullInt64；JS 用对象代替。
  // Go 的 int(wait/time.Second) 是整秒数；JS 的 wait 以毫秒计。
  const scanErr = conn.QueryRowContext(ctx, "SELECT GET_LOCK(?, ?)", name, Math.floor(wait / 1000)).Scan(got);
  if (scanErr != null) {
    conn.Close();
    throw scanErr;
  }
  if (!got.Valid || got.Int64 !== 1) {
    conn.Close();
    throw new Error(`等待仓库 ${repositoryID} 的合入锁超时（${wait}）`);
  }
  return () => {
    // Go 的 context.Background() 无 JS 对应写法，传 null。
    conn.ExecContext(null, "SELECT RELEASE_LOCK(?)", name);
    conn.Close();
  };
};

function integrationLockName(repositoryID) {
  let id = repositoryID.trim();
  if (id === "") {
    id = "_";
  }
  const name = "agentflow:integrate:" + id;
  if (name.length <= 64) {
    return name;
  }
  return "agentflow:integrate:" + hexSHA256(id).slice(0, 40);
}

module.exports = { integrationLockName };
