/**
 * @file internal/repo/codebuddy_sponsor.js
 * 对应 Go 源文件：internal/repo/codebuddy_sponsor.go
 *
 * 作用与职责边界：
 * 实现平台共享 CodeBuddy API Key 的数据结构与持久化读写逻辑，挂载在 `UsersRepo` 原型上。
 * 未配置个人 CodeBuddy Key 的用户在对话与 SOP 运行时可借用管理员在平台管理中配置的共享 Key，
 * 若未配置共享 Key 则回退到环境变量 `AGENTFLOW_ASSISTANT_SPONSOR_LOGIN` 指定的历史赞助账号 Key。
 * API Key 仅存储在数据库中供服务端内部使用，对外管理状态结构永不回传明文 Key。
 *
 * 语法差异说明：
 * - `UsersRepo` 定义于 `repo.js`，本文件通过 `UsersRepo.prototype` 挂载共享 Key 相关方法。
 * - Go 的 `error` 返回统一按成功无返回值（`undefined`）、失败 `throw err` 处理；`(值, bool)` 译为 `[值, boolean]` 元组。
 * - Go 的 `os.Getenv` 译为 `process.env`；`gorm` 链式调用与 `clause.OnConflict` 按原样保留。
 * - Go 结构体切片字段（如 `Models`）的零值统一初始化为空数组 `[]`。
 */

"use strict";

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { User } = require("../domain/user.js"); // 对应 Go 的 domain.User，user.js 已翻译
const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 已翻译

// 未配置个人 CodeBuddy API Key 的用户使用平台管理员在平台管理中配置的共享 Key（受允许模型白名单限制），
// 覆盖聊天对话与 SOP 运行；定时任务、报告、Bot 与运行评测仍需用户个人 Key。
// 旧版部署在未配置共享 Key 时借用环境变量 AGENTFLOW_ASSISTANT_SPONSOR_LOGIN 对应账号的 Key，并限定使用 SponsoredCodeBuddyModel。
const CodeBuddySponsorLoginEnv = "AGENTFLOW_ASSISTANT_SPONSOR_LOGIN";
const SponsoredCodeBuddyModel = "deepseek-v4.1-flash";
// 平台共享 Key 允许配置的模型白名单数量上限。
const MaxSharedCodeBuddyModels = 32;

/**
 * 表示未配置个人 Key 的用户可借用的共享 CodeBuddy 凭据配置。
 * 包含 API Key、网络环境、允许使用的模型列表（首项为默认模型）及历史赞助账号 ID。
 */
class SharedCodeBuddyKey {
  /**
   * 构造并初始化共享 CodeBuddy Key 实例，未提供的字段按 Go 零值填充。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.APIKey = init.APIKey ?? "";
    this.InternetEnvironment = init.InternetEnvironment ?? "";
    // Models 为允许调用的模型列表，第一项为默认模型。
    this.Models = init.Models ?? [];
    // SponsorID 为历史赞助账号 ID；使用平台管理配置的共享 Key 时为 0。
    this.SponsorID = init.SponsorID ?? 0;
  }

  /**
   * 根据请求模型名解析本次共享 Key 回合应使用的模型。
   * 未指定时返回默认模型（列表首项）；指定且在白名单内时原样返回；白名单为空或不在白名单内时返回未命中。
   *
   * @param {string} requested - 调用方请求的模型标识（可为空）。
   * @returns {[string, boolean]} 返回 `[解析出的模型标识, 是否允许使用]`。
   */
  Model(requested) {
    if (this.Models.length === 0) {
      return ["", false];
    }
    requested = requested.trim();
    if (requested === "") {
      return [this.Models[0], true];
    }
    for (const id of this.Models) {
      if (id === requested) {
        return [id, true];
      }
    }
    return ["", false];
  }
}

/**
 * 对应数据库表 `platform_codebuddy_keys` 的单行持久化模型。
 * 表中至多保存主键为 `platformCodeBuddyKeyID` 的一行记录，Key 明文不经 API 暴露。
 */
class platformCodeBuddyKeyRow {
  /**
   * 构造并初始化平台共享 Key 数据库行模型。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? 0;
    this.APIKey = init.APIKey ?? "";
    this.InternetEnvironment = init.InternetEnvironment ?? "";
    this.Models = init.Models ?? "";
    this.UpdatedBy = init.UpdatedBy ?? 0;
    this.Updated = init.Updated ?? null;
  }

  /**
   * 返回对应的数据库表名 `"platform_codebuddy_keys"`。
   *
   * @returns {string} 数据库表名。
   */
  TableName() {
    return "platform_codebuddy_keys";
  }
}

// `platform_codebuddy_keys` 表仅保存这一条固定主键记录。
const platformCodeBuddyKeyID = 1;

/**
 * 面向平台管理员展示的共享 CodeBuddy Key 状态视图，永不包含明文 API Key。
 */
class PlatformCodeBuddyKeyStatus {
  /**
   * 构造并初始化共享 Key 状态视图对象，未提供的字段按 Go 零值填充。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Configured = init.Configured ?? false;
    this.InternetEnvironment = init.InternetEnvironment ?? "";
    this.Models = init.Models ?? [];
    this.UpdatedAt = init.UpdatedAt ?? null;
    this.UpdatedBy = init.UpdatedBy ?? "";
    // 未配置共享 Key 时借用的历史赞助账号登录名与限定模型。
    this.LegacySponsor = init.LegacySponsor ?? "";
    this.LegacySponsorModel = init.LegacySponsorModel ?? "";
  }
}

/**
 * 管理员更新平台共享 CodeBuddy Key 配置的入参结构。
 * `APIKey` 为空串时保留当前已存 Key；`Models` 应由调用方提前完成校验。
 */
class PlatformCodeBuddyKeyUpdate {
  /**
   * 构造并初始化共享 Key 更新入参对象，未提供的字段按 Go 零值填充。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.APIKey = init.APIKey ?? "";
    this.InternetEnvironment = init.InternetEnvironment ?? "";
    this.Models = init.Models ?? [];
  }
}

const ErrSharedCodeBuddyKeyRequired = new Error("shared CodeBuddy API Key is required");
const ErrSharedCodeBuddyModelsRequired = new Error("at least one shared CodeBuddy model is required");

/**
 * 读取数据库中唯一一行平台共享 CodeBuddy Key 记录。
 *
 * @returns {[platformCodeBuddyKeyRow, boolean]} 返回 `[行记录, 是否成功读到记录]`。
 */
UsersRepo.prototype.platformCodeBuddyKey = function () {
  const row = new platformCodeBuddyKeyRow();
  if (this == null || this.deps == null || this.DB == null) {
    return [row, false];
  }
  const result = this.DB.Where("id = ?", platformCodeBuddyKeyID).Limit(1).Find(row);
  return [row, result.Error == null && result.RowsAffected > 0];
};

/**
 * 将数据库存储的模型白名单 JSON 字符串反序列化为字符串数组。
 * 解析失败时返回 `null`。
 *
 * @param {string} raw - 模型列表 JSON 文本。
 * @returns {string[]|null} 模型标识数组，解析异常时返回 `null`。
 */
function decodeSharedModels(raw) {
  let models;
  try {
    models = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  return models;
}

/**
 * 读取环境变量 `AGENTFLOW_ASSISTANT_SPONSOR_LOGIN` 指定的历史赞助账号（要求用户存在且配置了非空 CodeBuddy Key）。
 *
 * @returns {[User, boolean]} 返回 `[赞助账号用户对象, 是否可用]`。
 */
UsersRepo.prototype.legacyCodeBuddySponsor = function () {
  const login = (process.env[CodeBuddySponsorLoginEnv] ?? "").trim();
  if (login === "" || this == null) {
    return [new User(), false];
  }
  const [sponsor, ok] = this.UserByLoginName(login);
  if (!ok || sponsor.CodeBuddyAPIKey.trim() === "") {
    return [new User(), false];
  }
  return [sponsor, true];
};

/**
 * 获取当前生效的平台共享 CodeBuddy Key：优先使用平台管理中配置的共享 Key，未配置时回退到历史赞助账号的 Key。
 *
 * @returns {[SharedCodeBuddyKey, boolean]} 返回 `[共享 Key 配置对象, 是否存在可用共享 Key]`。
 */
UsersRepo.prototype.SharedCodeBuddyKey = function () {
  const [row, ok] = this.platformCodeBuddyKey();
  if (ok) {
    const models = decodeSharedModels(row.Models);
    if (row.APIKey.trim() !== "" && (models ?? []).length > 0) {
      return [new SharedCodeBuddyKey({ APIKey: row.APIKey, InternetEnvironment: row.InternetEnvironment, Models: models }), true];
    }
  }
  const [sponsor, sponsorOk] = this.legacyCodeBuddySponsor();
  if (!sponsorOk) {
    return [new SharedCodeBuddyKey(), false];
  }
  return [new SharedCodeBuddyKey({ APIKey: sponsor.CodeBuddyAPIKey, InternetEnvironment: sponsor.CodeBuddyInternetEnvironment, Models: [SponsoredCodeBuddyModel], SponsorID: sponsor.ID }), true];
};

/**
 * 返回无个人 Key 用户允许使用的共享模型列表（首项为默认模型）；若无共享 Key 则返回 `null`。
 *
 * @returns {string[]|null} 允许使用的模型标识列表，无可用共享 Key 时返回 `null`。
 */
UsersRepo.prototype.SharedCodeBuddyModels = function () {
  const [key, ok] = this.SharedCodeBuddyKey();
  if (ok) {
    return key.Models;
  }
  return null;
};

/**
 * 组装面向平台管理员的共享 CodeBuddy Key 当前状态（含历史赞助账号回退信息），不暴露明文 API Key。
 *
 * @returns {PlatformCodeBuddyKeyStatus} 平台共享 Key 状态视图对象。
 */
UsersRepo.prototype.PlatformCodeBuddyKeyStatus = function () {
  const status = new PlatformCodeBuddyKeyStatus({ Models: [] });
  const [row, ok] = this.platformCodeBuddyKey();
  if (ok && row.APIKey.trim() !== "") {
    status.Configured = true;
    status.InternetEnvironment = row.InternetEnvironment;
    const models = decodeSharedModels(row.Models);
    if (models != null) {
      status.Models = models;
    }
    status.UpdatedAt = row.Updated;
    const [user, userOk] = this.User(row.UpdatedBy);
    if (userOk) {
      status.UpdatedBy = user.LoginName;
    }
  }
  const [sponsor, sponsorOk] = this.legacyCodeBuddySponsor();
  if (sponsorOk) {
    status.LegacySponsor = sponsor.LoginName;
    status.LegacySponsorModel = SponsoredCodeBuddyModel;
  }
  return status;
};

/**
 * 保存或更新平台共享 CodeBuddy Key 配置。
 * 要求模型白名单非空且最终 Key 非空（传入空 Key 时沿用库中已有 Key），通过主键冲突更新原子落盘。
 *
 * @param {PlatformCodeBuddyKeyUpdate} update - 待写入的共享 Key 与模型白名单配置。
 * @param {number} actorID - 执行修改的平台管理员用户 ID。
 * @returns {void} 无返回值。
 * @throws {Error} 模型白名单为空、缺少有效 API Key、序列化失败或数据库写入失败时抛出错误。
 */
UsersRepo.prototype.SetPlatformCodeBuddyKey = function (update, actorID) {
  if (update.Models.length === 0) {
    throw ErrSharedCodeBuddyModelsRequired;
  }
  const [row] = this.platformCodeBuddyKey();
  const key = update.APIKey.trim();
  if (key !== "") {
    row.APIKey = key;
  }
  if (row.APIKey.trim() === "") {
    throw ErrSharedCodeBuddyKeyRequired;
  }
  const models = JSON.stringify(update.Models);
  const now = new Date();
  row.ID = platformCodeBuddyKeyID;
  row.InternetEnvironment = update.InternetEnvironment;
  row.Models = models;
  row.UpdatedBy = actorID;
  row.Updated = now;
  const err = this.DB.Clauses(new clause.OnConflict({
    Columns: [new clause.Column({ Name: "id" })],
    DoUpdates: clause.AssignmentColumns(["api_key", "internet_environment", "models", "updated_by", "updated_at"]),
  })).Create(row).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 清除平台管理中配置的共享 CodeBuddy Key；清除后未配个人 Key 的用户将无法借用（或回退到历史赞助账号）。
 *
 * @returns {void} 无返回值。
 * @throws {Error} 数据库删除失败时抛出错误。
 */
UsersRepo.prototype.ClearPlatformCodeBuddyKey = function () {
  const err = this.DB.Where("id = ?", platformCodeBuddyKeyID).Delete(new platformCodeBuddyKeyRow()).Error;
  if (err != null) {
    throw err;
  }
};

module.exports = { CodeBuddySponsorLoginEnv, SponsoredCodeBuddyModel, MaxSharedCodeBuddyModels, SharedCodeBuddyKey, platformCodeBuddyKeyRow, platformCodeBuddyKeyID, PlatformCodeBuddyKeyStatus, PlatformCodeBuddyKeyUpdate, ErrSharedCodeBuddyKeyRequired, ErrSharedCodeBuddyModelsRequired, decodeSharedModels };
