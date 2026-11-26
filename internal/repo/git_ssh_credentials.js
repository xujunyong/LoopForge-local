// git_ssh_credentials.js —— 对应 Go 文件：internal/repo/git_ssh_credentials.go
// 作用：用户 Git SSH 密钥的增删改查与按远端取密钥。

"use strict";

const { createHash } = require("node:crypto"); // Go crypto/sha256：摘要后转十六进制

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { SSHHostScope, ParseSSHRemote } = require("../gitwork/ssh_remote.js"); // 对应 Go 的 gitwork 包，gitwork 未翻译
const { ErrSSHKeyRequired } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork 包，gitwork 未翻译
const { gitSSHKeyRow } = require("./models.js"); // 对应 Go 同包类型，models.js 待翻译
const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

function gitSSHKeyID(host) {
  return createHash("sha256").update(host, "utf8").digest("hex");
}

// GitSSHKeyDescriptions：只读公开描述，私钥不进响应。
UsersRepo.prototype.GitSSHKeyDescriptions = function (userID) {
  const keys = [];
  const err = this.DB.Model(new gitSSHKeyRow()).Select("id", "name", "host").Where("user_id = ?", userID).Order("name, id").Find(keys).Error;
  return [keys, err];
};

const ErrGitSSHKeyExists = new Error("该 SSH 主机已有密钥，请编辑现有密钥");

UsersRepo.prototype.SaveGitSSHKey = function (userID, existingID, host, name, privateKey) {
  const [scopedHost, scopeErr] = SSHHostScope(host);
  if (scopeErr != null) {
    return scopeErr;
  }
  host = scopedHost;
  const id = gitSSHKeyID(host);
  if (existingID === "") {
    if (privateKey === "") {
      return ErrSSHKeyRequired;
    }
    const row = new gitSSHKeyRow({ UserID: userID, ID: id, Host: host, Name: name, PrivateKey: privateKey });
    const err = this.DB.Create(row).Error;
    if (err === gorm.ErrDuplicatedKey) {
      return ErrGitSSHKeyExists;
    }
    return err;
  }
  if (existingID !== id) {
    return gorm.ErrRecordNotFound;
  }
  const row = this.DB.Model(new gitSSHKeyRow()).Where("user_id = ? AND id = ?", userID, id);
  const updates = { name: name };
  if (privateKey !== "") {
    updates.private_key = privateKey;
  }
  const result = row.Session(new gorm.Session()).Updates(updates);
  if (result.Error != null || result.RowsAffected !== 0) {
    return result.Error;
  }
  // MySQL can report zero affected rows for an unchanged value.
  // Go 的 Count(&count) 用对象接出参。
  const countOut = { value: 0 };
  const countErr = row.Count(countOut).Error;
  if (countErr != null) {
    return countErr;
  }
  if (countOut.value === 0) {
    return gorm.ErrRecordNotFound;
  }
  return null;
};

UsersRepo.prototype.DeleteGitSSHKey = function (userID, id) {
  return this.DB.Where("user_id = ? AND id = ?", userID, id).Delete(new gitSSHKeyRow()).Error;
};

// GitSSHKeysForRemotes：只取每个 SSH 主机端口对应的用户密钥；未配置的远端留空，不借用他机身份。
UsersRepo.prototype.GitSSHKeysForRemotes = function (userID, urls) {
  if (urls.length === 0) {
    return null;
  }
  const keys = {};
  const ids = [];
  const targets = {};
  for (const raw of urls) {
    keys[raw] = "";
    const [remote, err] = ParseSSHRemote(raw);
    if (err != null) {
      continue;
    }
    const id = gitSSHKeyID(remote.Endpoint());
    targets[raw] = id;
    ids.push(id);
  }
  if (userID <= 0 || ids.length === 0) {
    return keys;
  }
  const matches = [];
  if (this.DB.Select("id", "private_key").Where("user_id = ? AND id IN ?", userID, ids).Find(matches).Error != null) {
    return keys;
  }
  const byID = {};
  for (const key of matches) {
    byID[key.ID] = key.PrivateKey;
  }
  for (const [remote, id] of Object.entries(targets)) {
    // Go 读缺失的 map 键得零值。
    keys[remote] = byID[id] ?? "";
  }
  return keys;
};

// GitSSHKeysByHost：返回用户全部 SSH 密钥，按 host:port 端点索引。
UsersRepo.prototype.GitSSHKeysByHost = function (userID) {
  if (userID <= 0) {
    return null;
  }
  const rows = [];
  if (this.DB.Select("host", "private_key").Where("user_id = ?", userID).Find(rows).Error != null) {
    return null;
  }
  const keys = {};
  for (const row of rows) {
    if (row.Host !== "" && row.PrivateKey !== "") {
      keys[row.Host] = row.PrivateKey;
    }
  }
  return keys;
};

module.exports = { ErrGitSSHKeyExists, gitSSHKeyID };
