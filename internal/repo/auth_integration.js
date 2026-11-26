/**
 * @file internal/repo/auth_integration.js
 * 对应 Go 源文件：internal/repo/auth_integration.go
 *
 * 作用与职责边界：
 * 定义第三方身份集成配置表（`auth_integrations`）的持久化行模型，
 * 并为 `UsersRepo` 提供 GitHub 登录应用 ClientID 的读取与覆盖写入方法。
 * 不负责 OAuth 回调认证流程或用户会话签发。
 *
 * 语法差异说明：
 * - Go 的 `(string, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理。
 * - GORM `struct` 标签直接略去，`clause.OnConflict` 与链式调用按原样保留。
 */

"use strict";

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

/**
 * 对应数据库表 `auth_integrations` 的第三方认证集成配置行模型。
 * 以认证提供方名称（如 `"github"`）为主键存储对应应用的客户端标识。
 */
class authIntegrationRow {
  /**
   * 构造认证集成配置行对象，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.Provider=""] - 第三方认证提供方标识（主键）。
   * @param {string} [init.ClientID=""] - 对应的 OAuth 应用 ClientID。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Provider = init.Provider ?? "";
    this.ClientID = init.ClientID ?? "";
  }

  /**
   * 返回 GORM 映射的物理数据库表名。
   *
   * @returns {string} 表名 `"auth_integrations"`。
   */
  TableName() {
    return "auth_integrations";
  }
}

/**
 * 读取持久化存储的 GitHub OAuth ClientID；若数据库中尚未配置记录则返回调用方提供的回退值。
 * 用于登录配置查询与 GitHub OAuth 授权跳转初始化。
 *
 * @param {string} fallback - 数据库未配置记录时使用的默认回退 ClientID。
 * @returns {string} 数据库中保存的 GitHub ClientID，或无记录时的 `fallback`。
 * @throws {Error} 数据库查询发生错误时抛出错误。
 */
UsersRepo.prototype.GitHubClientID = function (fallback) {
  const config = new authIntegrationRow();
  const result = this.DB.Where("provider = ?", "github").Limit(1).Find(config);
  if (result.Error == null && result.RowsAffected === 0) {
    return fallback;
  }
  if (result.Error != null) {
    throw result.Error;
  }
  return config.ClientID;
};

/**
 * 保存或更新平台级的 GitHub OAuth ClientID 配置（主键冲突时更新 `client_id` 列）。
 * 供管理员在平台认证设置中更新 GitHub 登录集成配置时调用。
 *
 * @param {string} clientID - 新的 GitHub OAuth ClientID。
 * @returns {void} 无返回值。
 * @throws {Error} 数据库写入失败时抛出错误。
 */
UsersRepo.prototype.SetGitHubClientID = function (clientID) {
  const err = this.DB.Clauses(new clause.OnConflict({
    Columns: [new clause.Column({ Name: "provider" })],
    DoUpdates: clause.AssignmentColumns(["client_id"]),
  })).Create(new authIntegrationRow({ Provider: "github", ClientID: clientID })).Error;
  if (err != null) {
    throw err;
  }
};

module.exports = { authIntegrationRow };
