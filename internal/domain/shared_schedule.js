/**
 * @file internal/domain/shared_schedule.js
 * @description 对应 Go 文件：internal/domain/shared_schedule.go
 * 职责与边界：定义共享定时任务的不可变已发布版本、参数定义与直接引用资产归属类型，
 * 实现版本发布前校验、参数值类型规范化校验，以及单次遍历模板提示词渲染。
 * 语法差异说明：
 * - Go 切片零值初始化为 `[]`，`time.Time` 初始化为 `null`，`map[string]bool` 译为普通对象 `{}`。
 * - Go 多返回值 `(T, error)` 译为成功返回 `T`、失败 `throw Error`；`(T1, T2, error)` 译为成功返回 `[T1, T2]`、失败 `throw Error`。
 */

"use strict";

/**
 * 描述共享定时任务中声明的单个可配置参数（名称、显示名、类型、必填性与默认值）。
 */
class ScheduleParameter {
  /**
   * 构造定时任务参数定义实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Name = init.Name ?? "";
    this.Label = init.Label ?? "";
    this.Type = init.Type ?? "";
    this.Required = init.Required ?? false;
    this.Default = init.Default ?? "";
  }
}

/**
 * 表示共享定时任务的一个不可变、不含凭据的已发布版本定义。
 */
class SharedScheduleVersion {
  /**
   * 构造共享定时任务版本实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Version = init.Version ?? 0;
    this.SourceProjectID = init.SourceProjectID ?? "";
    this.SourceProjectName = init.SourceProjectName ?? "";
    this.SourceJobID = init.SourceJobID ?? "";
    this.Name = init.Name ?? "";
    this.Description = init.Description ?? "";
    this.Prompt = init.Prompt ?? "";
    this.References = init.References ?? [];
    this.Assets = init.Assets ?? [];
    this.Model = init.Model ?? "";
    this.Cron = init.Cron ?? "";
    this.IntervalSec = init.IntervalSec ?? 0;
    this.Parameters = init.Parameters ?? [];
    this.ChangeNote = init.ChangeNote ?? "";
    this.CreatedAt = init.CreatedAt ?? null;
  }

  /**
   * 判断本共享版本是否直接声明引用了指定类型与 ID 的资产。
   * 在权限核对或依赖资产解析时调用。
   * @param {string} typ - 资产类型标识。
   * @param {string} id - 资产唯一标识。
   * @returns {boolean} 存在匹配的直接引用资产时返回 `true`，否则返回 `false`。
   */
  HasAsset(typ, id) {
    for (const asset of this.Assets ?? []) {
      if (asset.Type === typ && asset.ID === id) {
        return true;
      }
    }
    return false;
  }

  /**
   * 校验本共享版本的名称、提示词、长度上限、参数定义唯一性与默认值，并检查提示词中所有模板占位符均已定义。
   * 在发布新版本及渲染提示词前调用。
   * @returns {void} 无返回值；任一项不合法时抛出异常。
   */
  Validate() {
    // Go 的 len(Name) 按 UTF-8 字节长度计算。
    if (this.Name.trim() === "" || Buffer.byteLength(this.Name, "utf8") > 255 || this.Prompt.trim() === "") {
      throw new Error("共享名称和提示词必填，名称最多 255 字节");
    }
    if (Buffer.byteLength(this.Description, "utf8") > 2000 || Buffer.byteLength(this.ChangeNote, "utf8") > 1000 || (this.Parameters ?? []).length > 20) {
      throw new Error("描述、版本说明或参数数量超出限制");
    }
    const known = {};
    for (const p of this.Parameters ?? []) {
      if (!scheduleParameterName.test(p.Name) || known[p.Name] === true) {
        throw new Error(`参数名必须唯一，以字母开头，使用字母、数字或下划线：${p.Name}`);
      }
      if (p.Label === "" || Buffer.byteLength(p.Label, "utf8") > 120) {
        throw new Error(`请填写参数 ${p.Name} 的显示名称`);
      }
      normalizeScheduleParameter(p, p.Default, false);
      known[p.Name] = true;
    }
    for (const m of this.Prompt.matchAll(scheduleParameterToken)) {
      if (known[m[1].trim()] !== true) {
        throw new Error(`提示词引用了未定义参数：${m[1].trim()}`);
      }
    }
  }

  /**
   * 校验传入参数映射，并按单次扫描替换本版本提示词中的 `{{ params.xxx }}` 占位符。
   * 参数值本身包含模板语法时按字面量保留，不会二次展开其他参数。
   * @param {Object<string, string>} input - 调用方提供的参数名到参数值映射。
   * @returns {[string, Object<string, string>]} 二元组 `[渲染后的提示词, 规范化后的参数值映射]`；校验失败时抛出异常。
   */
  Render(input) {
    this.Validate();
    const values = {};
    for (const p of this.Parameters ?? []) {
      let value = Object.prototype.hasOwnProperty.call(input, p.Name) ? input[p.Name] : p.Default;
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

/**
 * 锁定共享定时任务直接引用的单个资产归属；嵌套依赖仍遵循被引用资产自身的权限与解析规则。
 */
class SharedScheduleAsset {
  /**
   * 构造共享任务资产引用实例，未提供的字段按 Go 零值初始化。
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Type = init.Type ?? "";
    this.ID = init.ID ?? "";
    this.ProjectID = init.ProjectID ?? "";
  }
}

const scheduleParameterName = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const scheduleParameterToken = /\{\{\s*params\.([^{}]+?)\s*\}\}/g;

/**
 * 去除参数值首尾空白并校验其字节长度、必填约束及数据类型格式（`string`/`integer`/`number`/`boolean`）。
 * 供 `SharedScheduleVersion.Validate`（校验默认值）与 `Render`（校验运行入参）内部调用。
 * @param {ScheduleParameter} p - 参数定义对象。
 * @param {string} value - 待校验的原始参数值字符串。
 * @param {boolean} enforceRequired - 是否强制校验必填项（渲染时为 `true`，校验默认值时为 `false`）。
 * @returns {string} 规范化后的参数值字符串；校验不通过时抛出异常。
 */
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
