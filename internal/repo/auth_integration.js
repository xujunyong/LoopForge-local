// auth_integration.js —— 对应 Go 文件：internal/repo/auth_integration.go
// 作用：第三方登录集成配置的读写，如 GitHub 应用 ClientID。

"use strict";

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

class authIntegrationRow {
  constructor(init = {}) {
    this.Provider = init.Provider ?? "";
    this.ClientID = init.ClientID ?? "";
  }

  TableName() {
    return "auth_integrations";
  }
}

UsersRepo.prototype.GitHubClientID = function (fallback) {
  const config = new authIntegrationRow();
  const result = this.DB.Where("provider = ?", "github").Limit(1).Find(config);
  if (result.Error == null && result.RowsAffected === 0) {
    return [fallback, null];
  }
  return [config.ClientID, result.Error];
};

UsersRepo.prototype.SetGitHubClientID = function (clientID) {
  return this.DB.Clauses(new clause.OnConflict({
    Columns: [new clause.Column({ Name: "provider" })],
    DoUpdates: clause.AssignmentColumns(["client_id"]),
  })).Create(new authIntegrationRow({ Provider: "github", ClientID: clientID })).Error;
};

module.exports = { authIntegrationRow };
