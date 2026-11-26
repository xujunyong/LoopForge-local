/**
 * @file internal/repo/git_ssh_credentials.js
 * @description 对应 Go 文件：internal/repo/git_ssh_credentials.go
 * 职责与边界：管理用户个人 Git SSH 密钥的增删改查、按远端仓库地址精准匹配私钥以及按 `host:port` 导出私钥映射；
 * 方法按领域归属挂载于 `UsersRepo.prototype`。
 * 语法差异说明：
 * - Go 的 `(值, error)` 译为成功直接返回值、失败 `throw err`；仅 `error` 译为成功无返回值、失败 `throw err`。
 * - Go 的 `map[string]string` 译为普通对象 `{}`；读取缺失键返回零值空字符串 `""`。
 * - Go 指针出参 `row.Count(&count)` 在 JS 中用 `{ value: 0 }` 对象接收。
 */

"use strict";

const { createHash } = require("node:crypto"); // Go crypto/sha256：摘要后转十六进制

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { SSHHostScope, ParseSSHRemote } = require("../gitwork/ssh_remote.js"); // 对应 Go 的 gitwork 包，gitwork 未翻译
const { ErrSSHKeyRequired } = require("../gitwork/ssh.js"); // 对应 Go 的 gitwork 包，gitwork 未翻译
const { gitSSHKeyRow } = require("./models.js"); // 对应 Go 同包类型
const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型

/**
 * 计算规范化 SSH 主机端口端点对应的主键（SHA-256 小写十六进制摘要）。
 * 使用场景：新增、更新及按远端地址批量匹配用户 SSH 密钥时生成确定性主键。
 *
 * @param {string} host - 规范化后的 `host:port` 字符串。
 * @returns {string} 64 位小写十六进制 SHA-256 摘要。
 */
function gitSSHKeyID(host) {
  return createHash("sha256").update(host, "utf8").digest("hex");
}

/**
 * 查询用户的全部 Git SSH 密钥公开描述（仅含 `id`、`name`、`host`），绝不读取私钥列。
 * 使用场景：用户个人设置页展示已配置的 SSH 密钥列表时调用。
 *
 * @param {number} userID - 用户主键 ID。
 * @returns {import("../domain/user.js").GitSSHKey[]} SSH 密钥公开描述数组；查询失败时抛出错误。
 */
UsersRepo.prototype.GitSSHKeyDescriptions = function (userID) {
  const keys = [];
  const err = this.DB.Model(new gitSSHKeyRow()).Select("id", "name", "host").Where("user_id = ?", userID).Order("name, id").Find(keys).Error;
  if (err != null) {
    throw err;
  }
  return keys;
};

/** 同一用户在同一 SSH 主机端口下重复添加密钥时抛出的错误。 */
const ErrGitSSHKeyExists = new Error("该 SSH 主机已有密钥，请编辑现有密钥");

/**
 * 新建或更新用户的个人 Git SSH 密钥：`existingID` 为空时按规范化后的主机新建，否则更新既有记录。
 * 更新时若 `privateKey` 为空则仅修改展示名称并保留原私钥，且不允许修改既有记录对应的主机。
 * 使用场景：用户在个人设置页新增或编辑 Git SSH 密钥时调用。
 *
 * @param {number} userID - 用户主键 ID。
 * @param {string} existingID - 待更新的既有密钥 ID；为空字符串表示新建。
 * @param {string} host - SSH 主机名（可附带端口）或 SSH 克隆地址。
 * @param {string} name - 密钥展示名称。
 * @param {string} privateKey - SSH 私钥文本；新建时必填，更新时留空表示沿用原私钥。
 * @returns {void} 无返回值；主机非法、缺私钥、重复、不存在或写库失败时抛出错误。
 */
UsersRepo.prototype.SaveGitSSHKey = function (userID, existingID, host, name, privateKey) {
  host = SSHHostScope(host);
  const id = gitSSHKeyID(host);
  if (existingID === "") {
    if (privateKey === "") {
      throw ErrSSHKeyRequired;
    }
    const row = new gitSSHKeyRow({ UserID: userID, ID: id, Host: host, Name: name, PrivateKey: privateKey });
    const err = this.DB.Create(row).Error;
    if (err === gorm.ErrDuplicatedKey) {
      throw ErrGitSSHKeyExists;
    }
    if (err != null) {
      throw err;
    }
    return;
  }
  if (existingID !== id) {
    throw gorm.ErrRecordNotFound;
  }
  const row = this.DB.Model(new gitSSHKeyRow()).Where("user_id = ? AND id = ?", userID, id);
  const updates = { name: name };
  if (privateKey !== "") {
    updates.private_key = privateKey;
  }
  const result = row.Session(new gorm.Session()).Updates(updates);
  if (result.Error != null) {
    throw result.Error;
  }
  if (result.RowsAffected !== 0) {
    return;
  }
  // MySQL 在更新字段值未变化时可能返回 0 行受影响，需再检查记录是否确实存在。
  // Go 的 Count(&count) 用对象接出参。
  const countOut = { value: 0 };
  const countErr = row.Count(countOut).Error;
  if (countErr != null) {
    throw countErr;
  }
  if (countOut.value === 0) {
    throw gorm.ErrRecordNotFound;
  }
};

/**
 * 删除用户指定 ID 的个人 Git SSH 密钥。
 * 使用场景：用户在个人设置页移除已保存的 SSH 密钥时调用。
 *
 * @param {number} userID - 用户主键 ID。
 * @param {string} id - 待删除的 SSH 密钥 ID。
 * @returns {void} 无返回值；数据库删除失败时抛出错误。
 */
UsersRepo.prototype.DeleteGitSSHKey = function (userID, id) {
  const err = this.DB.Where("user_id = ? AND id = ?", userID, id).Delete(new gitSSHKeyRow()).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 按给定的远端仓库地址列表逐一匹配用户在对应 SSH 主机与端口下的私钥。
 * 未配置密钥的远端会保留空字符串，防止借用其他主机的身份或回退到执行机器本机凭据。
 * 使用场景：工作流运行或仓库同步前，为已知仓库清单精确装配 SSH 私钥映射。
 *
 * @param {number} userID - 用户主键 ID。
 * @param {string[]} urls - 待匹配的远端仓库 URL 列表。
 * @returns {Record<string, string> | null} 以原始远端 URL 为键、私钥内容（未匹配为空串）为值的映射；`urls` 为空时返回 `null`。
 */
UsersRepo.prototype.GitSSHKeysForRemotes = function (userID, urls) {
  if (urls.length === 0) {
    return null;
  }
  const keys = {};
  const ids = [];
  const targets = {};
  for (const raw of urls) {
    keys[raw] = "";
    let remote;
    try {
      remote = ParseSSHRemote(raw);
    } catch {
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
    // Go 读缺失的 map 键得零值空串。
    keys[remote] = byID[id] ?? "";
  }
  return keys;
};

/**
 * 返回用户的全部有效 SSH 私钥，按 `"host:port"` 端点索引。
 * 会话工作区无法预先得知 Agent 将克隆哪些仓库，因此按已配置的全部主机提供密钥。
 * 使用场景：初始化交互式会话工作区的 Git SSH 认证环境时调用。
 *
 * @param {number} userID - 用户主键 ID。
 * @returns {Record<string, string> | null} 以 `"host:port"` 为键、私钥内容为值的映射；用户无效或查询出错时返回 `null`。
 */
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
