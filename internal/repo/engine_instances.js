// engine_instances.js —— 对应 Go 文件：internal/repo/engine_instances.go
// 作用：引擎实例心跳与存活查询：注册工作进程的中断地址并按租约判断存活。

"use strict";

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause
const { ErrRunLeaseLost } = require("./repo.js"); // 对应 Go 同包变量，repo.js 待翻译
const { engineInstanceRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译

class EngineInstance {
  constructor(init = {}) {
    this.InstanceID = init.InstanceID ?? "";
    this.Role = init.Role ?? "";
    this.ControlURL = init.ControlURL ?? "";
    this.WorkspaceHost = init.WorkspaceHost ?? "";
  }
}

class EngineInstancesRepo {
  constructor(init = {}) {
    this.DB = init.DB ?? null;
  }

  HeartbeatEngineInstance(inst, ttl) {
    const id = inst.InstanceID.trim();
    if (id === "" || ttl <= 0) {
      return ErrRunLeaseLost;
    }
    const now = new Date();
    const row = new engineInstanceRow({
      InstanceID: id,
      Role: inst.Role.trim(),
      ControlURL: inst.ControlURL.trim().replace(/\/+$/, ""),
      WorkspaceHost: inst.WorkspaceHost.trim(),
      HeartbeatAt: now,
      LeaseUntil: new Date(now.getTime() + ttl),
    });
    return this.DB.Clauses(new clause.OnConflict({
      Columns: [{ Name: "instance_id" }],
      DoUpdates: new clause.AssignmentColumns(["role", "control_url", "workspace_host", "heartbeat_at", "lease_until"]),
    })).Create(row).Error;
  }

  DeleteEngineInstance(instanceID) {
    const id = instanceID.trim();
    if (id === "") {
      return null;
    }
    return this.DB.Where("instance_id = ?", id).Delete(new engineInstanceRow()).Error;
  }

  WorkspaceHostAlive(host) {
    host = host.trim();
    if (host === "") {
      return false;
    }
    let count = 0;
    const err = this.DB.Model(new engineInstanceRow()).
      Where("workspace_host = ? AND lease_until > ? AND role IN ?", host, new Date(), ["worker", "all"]).
      Count(count).Error;
    if (err != null) {
      return true;
    }
    return count > 0;
  }

  EngineInstanceControlURL(instanceID) {
    const id = instanceID.trim();
    if (id === "") {
      return "";
    }
    const row = new engineInstanceRow();
    const err = this.DB.Where("instance_id = ? AND control_url <> '' AND lease_until > ?", id, new Date()).Take(row).Error;
    if (err != null) {
      return "";
    }
    return row.ControlURL.trim().replace(/\/+$/, "");
  }

  LiveWorkerControlURLs() {
    const rows = [];
    if (this.DB.Where("control_url <> '' AND lease_until > ? AND role IN ?", new Date(), ["worker", "all"]).Find(rows).Error != null) {
      return null;
    }
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      const u = row.ControlURL.trim().replace(/\/+$/, "");
      if (u === "") {
        continue;
      }
      if (seen.has(u)) {
        continue;
      }
      seen.add(u);
      out.push(u);
    }
    return out;
  }

  WorkspaceHostControlURL(host) {
    const row = new engineInstanceRow();
    if (this.DB.Where("workspace_host = ? AND control_url <> '' AND lease_until > ? AND role IN ?", host, new Date(), ["worker", "all"]).Order("heartbeat_at DESC").Take(row).Error != null) {
      return "";
    }
    return row.ControlURL.replace(/\/+$/, "");
  }
}

module.exports = { EngineInstance, EngineInstancesRepo };
