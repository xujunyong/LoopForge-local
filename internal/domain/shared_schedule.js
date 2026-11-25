// shared_schedule.js —— 对应 Go 文件：internal/domain/shared_schedule.go
// 作用：共享定时任务的不可变已发布版本，含参数校验与提示词渲染。

"use strict";

// ScheduleParameter：共享定时任务的一个参数定义。
class ScheduleParameter {
  constructor(init = {}) {
    this.Name = init.Name ?? "";
    this.Label = init.Label ?? "";
    this.Type = init.Type ?? "";
    this.Required = init.Required ?? false;
    this.Default = init.Default ?? "";
  }
}

// SharedScheduleVersion：不可变的、无凭据的已发布共享定义。
class SharedScheduleVersion {
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Version = init.Version ?? 0;
    this.SourceProjectID = init.SourceProjectID ?? "";
    this.SourceProjectName = init.SourceProjectName ?? "";
    this.SourceJobID = init.SourceJobID ?? "";
    this.Name = init.Name ?? "";
    this.Description = init.Description ?? "";
    this.Prompt = init.Prompt ?? "";
    this.References = init.References ?? null;
    this.Assets = init.Assets ?? null;
    this.Model = init.Model ?? "";
    this.Cron = init.Cron ?? "";
    this.IntervalSec = init.IntervalSec ?? 0;
    this.Parameters = init.Parameters ?? null;
    this.ChangeNote = init.ChangeNote ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
  }

  HasAsset(typ, id) {
    for (const asset of this.Assets ?? []) {
      if (asset.Type === typ && asset.ID === id) {
        return true;
      }
    }
    return false;
  }

  Validate() {
    // Go 的 len(Name) 按字节计。
    if (this.Name.trim() === "" || Buffer.byteLength(this.Name, "utf8") > 255 || this.Prompt.trim() === "") {
      throw new Error("共享名称和提示词必填，名称最多 255 字节");
    }
    if (Buffer.byteLength(this.Description, "utf8") > 2000 || Buffer.byteLength(this.ChangeNote, "utf8") > 1000 || (this.Parameters ?? []).length > 20) {
      throw new Error("描述、版本说明或参数数量超出限制");
    }
    const known = new Set();
    for (const p of this.Parameters ?? []) {
      if (!scheduleParameterName.test(p.Name) || known.has(p.Name)) {
        throw new Error(`参数名必须唯一，以字母开头，使用字母、数字或下划线：${p.Name}`);
      }
      if (p.Label === "" || Buffer.byteLength(p.Label, "utf8") > 120) {
        throw new Error(`请填写参数 ${p.Name} 的显示名称`);
      }
      normalizeScheduleParameter(p, p.Default, false);
      known.add(p.Name);
    }
    for (const m of this.Prompt.matchAll(scheduleParameterToken)) {
      if (!known.has(m[1].trim())) {
        throw new Error(`提示词引用了未定义参数：${m[1].trim()}`);
      }
    }
  }

  // Render：只解析本锁定版本，一次替换完成。
  Render(input) {
    this.Validate();
    const values = {};
    for (const p of this.Parameters ?? []) {
      let value = input[p.Name];
      if (value === undefined) {
        value = p.Default;
      }
      values[p.Name] = normalizeScheduleParameter(p, value, true);
    }
    for (const key of Object.keys(input)) {
      if (!Object.prototype.hasOwnProperty.call(values, key)) {
        throw new Error(`未知参数：${key}`);
      }
    }
    const prompt = this.Prompt.replace(scheduleParameterToken, (token, name) => values[name.trim()]);
    return [prompt, values];
  }
}

// SharedScheduleAsset：锁定一个直接引用的共享定时任务资产归属。
class SharedScheduleAsset {
  constructor(init = {}) {
    this.Type = init.Type ?? "";
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
  }
}

const scheduleParameterName = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const scheduleParameterToken = /\{\{\s*params\.([^{}]+?)\s*\}\}/g;

function normalizeScheduleParameter(p, value, enforceRequired) {
  value = value.trim();
  if (Buffer.byteLength(value, "utf8") > 2000) {
    throw new Error(`参数 ${p.Name} 过长`);
  }
  switch (p.Type) {
    case "string":
    case "integer":
    case "number":
    case "boolean":
      break;
    default:
      throw new Error(`参数 ${p.Name} 类型无效`);
  }
  if (value === "") {
    if (enforceRequired && p.Required) {
      throw new Error(`请填写参数：${p.Label}`);
    }
    return "";
  }
  let valid = true;
  switch (p.Type) {
    case "integer":
      valid = /^[+-]?\d+$/.test(value);
      break;
    case "number": {
      const n = Number(value);
      valid = !Number.isNaN(n) && Number.isFinite(n);
      break;
    }
    case "boolean":
      valid = value === "true" || value === "false";
      break;
    default:
      break;
  }
  if (!valid) {
    throw new Error(`参数 ${p.Label} 需要有效的 ${p.Type} 值`);
  }
  return value;
}

module.exports = { ScheduleParameter, SharedScheduleVersion, SharedScheduleAsset };
