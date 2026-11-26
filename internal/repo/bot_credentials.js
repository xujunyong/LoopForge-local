// bot_credentials.js —— 对应 Go 文件：internal/repo/bot_credentials.go
// 作用：外部 Bot 凭据密文的读写与删除。

"use strict";

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm
const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

class botCredentialRow {
  constructor(init = {}) {
    this.BotID = init.BotID ?? "";
    this.Secret = init.Secret ?? "";
  }

  TableName() {
    return "user_bot_credentials";
  }
}

UsersRepo.prototype.BotCredential = function (botID) {
  const row = new botCredentialRow();
  const err = this.DB.Where("bot_id = ?", botID).First(row).Error;
  if (err === gorm.ErrRecordNotFound) {
    return ["", err];
  }
  return [row.Secret, err];
};

UsersRepo.prototype.putBotCredential = function (tx, id, secret) {
  return tx.Clauses(new clause.OnConflict({ UpdateAll: true })).Create(new botCredentialRow({ BotID: id, Secret: secret })).Error;
};

UsersRepo.prototype.deleteBotCredential = function (tx, id) {
  return tx.Where("bot_id = ?", id).Delete(new botCredentialRow()).Error;
};

module.exports = { botCredentialRow };
