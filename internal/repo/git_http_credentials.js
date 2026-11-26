/**
 * @file internal/repo/git_http_credentials.js
 * @description 对应 Go 文件：internal/repo/git_http_credentials.go
 * 职责与边界：管理用户个人 HTTPS Git 凭据的增删改查、平台托管 OAuth 凭据映射、按主机/ID 提取密文凭据，
 * 以及为执行派发和工作区轮次组装主机凭据信息；方法按领域归属挂载于 `UsersRepo.prototype`。
 * 语法差异说明：
 * - Go 的 `(值, error)` 译为成功直接返回值、失败 `throw err`；仅 `error` 译为成功无返回值、失败 `throw err`；`(值, bool)` 译为 `[值, boolean]`。
 * - 涉及工蜂 OAuth 令牌刷新（调用异步的 `managedGitCredential`）的方法保留 `async` 标记以承接底层 HTTP `fetch` 刷新。
 * - Go 指针出参 `row.Count(&count)` 在 JS 中用 `{ value: 0 }` 对象接收。
 */

"use strict";

const { createHash } = require("node:crypto"); // Go crypto/sha256：摘要后转十六进制

const gorm = require("gorm.io/gorm"); // Go 第三方包 gorm.io/gorm

const { GongfengHost } = require("../config/integration_hosts.js"); // 对应 Go 的 config.GongfengHost，config 已翻译
const { GitHTTPCredential, GitHTTPCredentialSecret, GitHTTPExecutionCredential, GitPlatformGitLab, ManagedGitHTTPCredentialID } = require("../domain/user.js"); // 对应 Go 的 domain.*，domain 已翻译
const { HTTPSHostScope, HTTPSRemoteHost } = require("../gitwork/https_host.js"); // 对应 Go 的 gitwork 包，gitwork 未翻译
const { OAuthHTTPUser, HTTPUser, SplitToken } = require("../gitwork/auth.js"); // 对应 Go 的 gitwork 包，gitwork 未翻译
const { ConfigFromEnv } = require("../gongfeng/oauth.js"); // 对应 Go 的 gongfeng.ConfigFromEnv，gongfeng 已翻译
const { gitHTTPCredentialRow } = require("./models.js"); // 对应 Go 同包类型
const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型
const { formatManagedGitCredential } = require("./gongfeng_credential.js"); // 对应 Go 同包函数

/** 同一用户在同一主机下重复添加 HTTPS 访问令牌时抛出的错误。 */
const ErrGitHTTPCredentialExists = new Error("该主机已有访问令牌，请编辑现有凭据");

/** 新建 HTTPS Git 凭据但未提供访问令牌时抛出的错误。 */
const ErrGitHTTPTokenRequired = new Error("添加凭据时请填写访问令牌");

/** 尝试修改或删除平台内部托管凭据时抛出的错误。 */
const ErrGitHTTPCredentialManaged = new Error("内部托管凭据由平台维护，不能在这里修改或删除");

/**
 * 计算规范化主机名对应的 HTTPS 凭据主键（SHA-256 小写十六进制摘要）。
 * 使用场景：在新增、更新、按主机查找用户 HTTPS Git 凭据时生成确定性主键。
 *
 * @param {string} host - 规范化后的 `host[:port]` 字符串。
 * @returns {string} 64 位小写十六进制 SHA-256 摘要。
 */
function gitHTTPCredentialID(host) {
  return createHash("sha256").update(host, "utf8").digest("hex");
}

/**
 * 将数据库行 `gitHTTPCredentialRow` 转换为包含明文令牌的领域对象 `GitHTTPCredentialSecret`。
 * 使用场景：从数据库读取凭据行后映射为领域结构。
 *
 * @returns {GitHTTPCredentialSecret} 对应的 HTTPS Git 凭据密文对象。
 */
gitHTTPCredentialRow.prototype.secret = function () {
  return new GitHTTPCredentialSecret({
    ID: this.ID,
    Name: this.Name,
    Platform: this.Platform,
    Host: this.Host,
    Username: this.Username,
    Token: this.Token,
  });
};

/**
 * 解析内部适配器（工蜂）Git 服务的规范化 HTTPS 主机名。
 * 使用场景：判断托管凭据所属主机以及在按主机查找凭据时决定是否回退到托管凭据。
 *
 * @returns {string} 规范化后的 HTTPS 主机名；未配置或无法解析时返回空字符串 `""`。
 */
function managedGitHost() {
  const configured = GongfengHost();
  if (configured !== "") {
    try {
      return HTTPSHostScope(configured);
    } catch {
      return "";
    }
  }
  const [host] = HTTPSRemoteHost(ConfigFromEnv().APIBase);
  return host;
}

/**
 * 将保存在 `user_configs` 中的内部适配器 OAuth 或 `"private:"` 令牌封装为只读的托管 HTTPS 凭据，不触发刷新。
 * 纯个人粘贴令牌不属于托管凭据，由主机凭据表独立管理。
 * 使用场景：列表展示托管凭据、判断用户是否已配置 HTTPS 凭据或刷新完成后装配密文对象。
 *
 * @param {import("../domain/user.js").User} user - 用户领域对象。
 * @returns {[GitHTTPCredentialSecret, boolean]} 二元组 `[托管凭据对象, 是否存在有效托管凭据]`。
 */
function managedGitHTTPCredential(user) {
  const raw = formatManagedGitCredential(user);
  const lower = raw.toLowerCase();
  if (!lower.startsWith(OAuthHTTPUser + ":") && !lower.startsWith(HTTPUser + ":")) {
    return [new GitHTTPCredentialSecret(), false];
  }
  const host = managedGitHost();
  const [username, token] = SplitToken(raw);
  if (host === "" || token === "") {
    return [new GitHTTPCredentialSecret(), false];
  }
  const secret = new GitHTTPCredentialSecret({
    ID: ManagedGitHTTPCredentialID,
    Name: "内部托管凭据",
    Platform: GitPlatformGitLab,
    Host: host,
    Username: username,
    Managed: true,
    Token: token,
  });
  if (user.GongfengRefreshToken.trim() !== "") {
    secret.ExpiresAt = user.GongfengTokenExpiresAt;
  }
  return [secret, true];
}

/**
 * 列出用户的 HTTPS Git 凭据公开描述；若个人凭据未覆盖托管主机，则在末尾附加只读托管凭据描述。
 * 令牌密文绝不会进入返回的描述对象。
 * 使用场景：用户个人设置页展示 HTTPS 凭据列表、工作区主机映射及执行前索引凭据主机。
 *
 * @param {number} userID - 用户主键 ID。
 * @returns {GitHTTPCredential[]} 不含令牌密文的凭据公开描述列表；查询失败时抛出错误。
 */
UsersRepo.prototype.GitHTTPCredentials = function (userID) {
  const rows = [];
  const err = this.DB.Select("id", "name", "platform", "host", "username")
    .Where("user_id = ?", userID)
    .Order("name, id")
    .Find(rows).Error;
  if (err != null) {
    throw err;
  }
  const out = [];
  const hosts = {};
  for (const row of rows) {
    const s = row.secret();
    // 严格只保留公开描述字段（对应 Go 取嵌入字段 .GitHTTPCredential），避免携带 Token/ExpiresAt。
    out.push(new GitHTTPCredential({
      ID: s.ID,
      Name: s.Name,
      Platform: s.Platform,
      Host: s.Host,
      Username: s.Username,
      Managed: s.Managed,
    }));
    hosts[row.Host] = true;
  }
  const [user, ok] = this.User(userID);
  if (ok) {
    const [managed, managedOk] = managedGitHTTPCredential(user);
    if (managedOk && !hosts[managed.Host]) {
      out.push(new GitHTTPCredential({
        ID: managed.ID,
        Name: managed.Name,
        Platform: managed.Platform,
        Host: managed.Host,
        Username: managed.Username,
        Managed: managed.Managed,
      }));
    }
  }
  return out;
};

/**
 * 新建或更新用户的个人 HTTPS Git 凭据：`existingID` 为空时按 `input.Host` 新建，否则更新既有凭据。
 * 更新时允许留空令牌以保留原令牌，且既有凭据绑定的主机不可变更；托管凭据不可通过此方法修改。
 * 使用场景：用户个人设置保存或编辑 HTTPS Git 访问令牌时调用。
 *
 * @param {number} userID - 用户主键 ID。
 * @param {string} existingID - 待更新的既有凭据 ID；为空字符串表示新建。
 * @param {GitHTTPCredentialSecret} input - 提交的凭据信息（含主机、平台、名称、用户名及可选令牌）。
 * @returns {void} 无返回值；校验失败、冲突、记录不存在或写库出错时抛出错误。
 */
UsersRepo.prototype.SaveGitHTTPCredential = function (userID, existingID, input) {
  if (existingID === ManagedGitHTTPCredentialID) {
    throw ErrGitHTTPCredentialManaged;
  }
  const host = HTTPSHostScope(input.Host);
  const id = gitHTTPCredentialID(host);
  const now = new Date();
  if (existingID === "") {
    if (input.Token === "") {
      throw ErrGitHTTPTokenRequired;
    }
    const row = new gitHTTPCredentialRow({
      UserID: userID,
      ID: id,
      Name: input.Name,
      Platform: input.Platform,
      Host: host,
      Username: input.Username,
      Token: input.Token,
      Created: now,
      Updated: now,
    });
    const createErr = this.DB.Create(row).Error;
    if (createErr === gorm.ErrDuplicatedKey) {
      throw ErrGitHTTPCredentialExists;
    }
    if (createErr != null) {
      throw createErr;
    }
    return;
  }
  if (existingID !== id) {
    throw gorm.ErrRecordNotFound;
  }
  const row = this.DB.Model(new gitHTTPCredentialRow()).Where("user_id = ? AND id = ?", userID, id);
  const updates = {
    name: input.Name,
    platform: input.Platform,
    username: input.Username,
    updated_at: now,
  };
  if (input.Token !== "") {
    updates.token = input.Token;
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
 * 删除用户指定的个人 HTTPS Git 凭据；拒绝删除平台内部托管凭据。
 * 使用场景：用户在个人设置中移除某主机的 HTTPS Git 访问令牌时调用。
 *
 * @param {number} userID - 用户主键 ID。
 * @param {string} id - 待删除的凭据 ID。
 * @returns {void} 无返回值；尝试删除托管凭据或数据库删除失败时抛出错误。
 */
UsersRepo.prototype.DeleteGitHTTPCredential = function (userID, id) {
  if (id === ManagedGitHTTPCredentialID) {
    throw ErrGitHTTPCredentialManaged;
  }
  const err = this.DB.Where("user_id = ? AND id = ?", userID, id).Delete(new gitHTTPCredentialRow()).Error;
  if (err != null) {
    throw err;
  }
};

/**
 * 查询用户在单个 `host[:port]` 上对应的 HTTPS Git 凭据密文；若命中内部托管主机则先刷新托管 OAuth 令牌。
 * 使用场景：工作区按需拉取单主机令牌、执行派发收集凭据密文或调用远端 Git API 前鉴权。
 *
 * @param {AbortSignal | null} ctx - 可选取消信号，供刷新托管 OAuth 令牌时透传。
 * @param {number} userID - 用户主键 ID。
 * @param {string} host - 目标主机或 HTTPS URL。
 * @returns {Promise<[GitHTTPCredentialSecret, boolean]>} 二元组 `[凭据密文对象, 是否找到有效凭据]`。
 */
UsersRepo.prototype.GitHTTPCredentialForHost = async function (ctx, userID, host) {
  try {
    host = HTTPSHostScope(host);
  } catch {
    return [new GitHTTPCredentialSecret(), false];
  }
  if (userID <= 0) {
    return [new GitHTTPCredentialSecret(), false];
  }
  const row = new gitHTTPCredentialRow();
  if (this.DB.Where("user_id = ? AND id = ?", userID, gitHTTPCredentialID(host)).Limit(1).Find(row).Error != null) {
    return [new GitHTTPCredentialSecret(), false];
  }
  if (row.ID !== "" && row.Host === host && row.Token !== "") {
    return [row.secret(), true];
  }
  if (host !== managedGitHost()) {
    return [new GitHTTPCredentialSecret(), false];
  }
  return this.refreshedManagedGitHTTPCredential(ctx, userID);
};

/**
 * 收集用户全部主机的执行期 HTTPS Git 凭据密文映射（按主机名索引），仅供已认证的执行派发使用。
 * 公开设置接口与运行快照仍使用不含令牌的凭据描述。
 * 使用场景：向执行器派发需要认证 Git 操作的任务前构造执行凭据包。
 *
 * @param {AbortSignal | null} ctx - 可选取消信号，供刷新托管 OAuth 令牌时透传。
 * @param {number} userID - 用户主键 ID。
 * @returns {Promise<Record<string, GitHTTPExecutionCredential>>} 以 `host[:port]` 为键的执行期凭据映射对象。
 */
UsersRepo.prototype.GitHTTPCredentialSecrets = async function (ctx, userID) {
  const out = {};
  let credentials;
  try {
    credentials = this.GitHTTPCredentials(userID);
  } catch {
    return out;
  }
  for (const credential of credentials) {
    const [secret, ok] = await this.GitHTTPCredentialForHost(ctx, userID, credential.Host);
    if (ok) {
      out[credential.Host] = new GitHTTPExecutionCredential({
        ID: secret.ID,
        Name: secret.Name,
        Platform: secret.Platform,
        Host: secret.Host,
        Username: secret.Username,
        Managed: secret.Managed,
        Token: secret.Token,
        ExpiresAt: secret.ExpiresAt,
      });
    }
  }
  return out;
};

/**
 * 按凭据 ID 解析用户的一条 HTTPS Git 凭据密文；若为托管凭据 ID 则先刷新托管令牌。
 * 使用场景：前端点击“校验已保存凭据”时按列表中的凭据 ID 取回密文进行连通性检查。
 *
 * @param {AbortSignal | null} ctx - 可选取消信号，供刷新托管 OAuth 令牌时透传。
 * @param {number} userID - 用户主键 ID。
 * @param {string} id - 凭据 ID（个人凭据主键或 `ManagedGitHTTPCredentialID`）。
 * @returns {Promise<[GitHTTPCredentialSecret, boolean]>} 二元组 `[凭据密文对象, 是否找到]`。
 */
UsersRepo.prototype.GitHTTPCredentialByID = async function (ctx, userID, id) {
  if (id === ManagedGitHTTPCredentialID) {
    return this.refreshedManagedGitHTTPCredential(ctx, userID);
  }
  const row = new gitHTTPCredentialRow();
  const err = this.DB.Where("user_id = ? AND id = ?", userID, id).Limit(1).Find(row).Error;
  if (err != null || row.ID === "") {
    return [new GitHTTPCredentialSecret(), false];
  }
  return [row.secret(), true];
};

/**
 * 先触发内部托管 OAuth 凭据刷新，再重新读取用户记录并构造托管 HTTPS 凭据密文。
 * 使用场景：由 `GitHTTPCredentialForHost` 与 `GitHTTPCredentialByID` 内部调用。
 *
 * @param {AbortSignal | null} ctx - 可选取消信号。
 * @param {number} userID - 用户主键 ID。
 * @returns {Promise<[GitHTTPCredentialSecret, boolean]>} 二元组 `[刷新后的托管凭据密文, 是否可用]`。
 */
UsersRepo.prototype.refreshedManagedGitHTTPCredential = async function (ctx, userID) {
  if ((await this.managedGitCredential(ctx, userID)) === "") {
    return [new GitHTTPCredentialSecret(), false];
  }
  const [user, ok] = this.User(userID);
  if (!ok) {
    return [new GitHTTPCredentialSecret(), false];
  }
  return managedGitHTTPCredential(user);
};

/**
 * 返回用户可提供给工作区轮次的“主机 → 托管平台”映射，不携带任何令牌密文。
 * 工作区轮次仅借此感知可用主机与平台，真正需要认证时再按单个主机申请令牌。
 * 使用场景：启动会话工作区或向执行环境注入可用 HTTPS Git 主机清单时调用。
 *
 * @param {number} userID - 用户主键 ID。
 * @returns {Record<string, string> | null} 以 `host[:port]` 为键、平台标识为值的映射对象；用户无效或查询失败时返回 `null`。
 */
UsersRepo.prototype.GitHTTPWorkspaceHosts = function (userID) {
  if (userID <= 0) {
    return null;
  }
  let creds;
  try {
    creds = this.GitHTTPCredentials(userID);
  } catch {
    return null;
  }
  const hosts = {};
  for (const cred of creds) {
    hosts[cred.Host] = cred.Platform;
  }
  return hosts;
};

module.exports = { ErrGitHTTPCredentialExists, ErrGitHTTPTokenRequired, ErrGitHTTPCredentialManaged, gitHTTPCredentialID, managedGitHost, managedGitHTTPCredential };
