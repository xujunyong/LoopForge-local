// codebuddy_sponsor.js —— 对应 Go 文件：internal/repo/codebuddy_sponsor.go
// 作用：平台共享 CodeBuddy Key 的存取：管理员配置的共享 Key，缺省时用赞助账号的 Key。
// gorm 链式调用按原样保留；os.Getenv 译为 process.env。

"use strict";

const clause = require("gorm.io/gorm/clause"); // Go 第三方包 gorm.io/gorm/clause

const { User } = require("../domain/user.js"); // 对应 Go 的 domain.User，user.js 已翻译
const { UsersRepo } = require("./repo.js"); // 对应 Go 同包类型，repo.js 待翻译

// Users who have not configured their own CodeBuddy API Key use the shared
// key a platform administrator configured under 平台管理, limited to the
// models the administrator allowed. It covers chat conversations and SOP
// runs, so a new user can start working before configuring anything;
// scheduled prompts, reports, bots and run evaluation keep requiring the
// user's own key.
//
// Older deployments lent the key of the account named by
// AGENTFLOW_ASSISTANT_SPONSOR_LOGIN instead, limited to
// SponsoredCodeBuddyModel. That still applies while no shared key is
// configured.
const CodeBuddySponsorLoginEnv = "AGENTFLOW_ASSISTANT_SPONSOR_LOGIN";
const SponsoredCodeBuddyModel = "deepseek-v4.1-flash";
// MaxSharedCodeBuddyModels bounds the allow list of the shared key.
const MaxSharedCodeBuddyModels = 32;

// SharedCodeBuddyKey is the key users without their own borrow.
class SharedCodeBuddyKey {
  constructor(init = {}) {
    this.APIKey = init.APIKey ?? "";
    this.InternetEnvironment = init.InternetEnvironment ?? "";
    // Models are the models it may run; the first is the default.
    this.Models = init.Models ?? null;
    // SponsorID is the lending account under AGENTFLOW_ASSISTANT_SPONSOR_LOGIN,
    // 0 for the key configured under 平台管理.
    this.SponsorID = init.SponsorID ?? 0;
  }

  // Model returns the model a shared-key turn runs: the requested model when it
  // is allowed, the default when none is requested, and false otherwise.
  Model(requested) {
    if ((this.Models ?? []).length === 0) {
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

// The key is stored like personal CodeBuddy keys in user_configs: the
// database is the trust boundary, and the key is never returned by the API.
class platformCodeBuddyKeyRow {
  constructor(init = {}) {
    this.ID = init.ID ?? 0;
    this.APIKey = init.APIKey ?? "";
    this.InternetEnvironment = init.InternetEnvironment ?? "";
    this.Models = init.Models ?? "";
    this.UpdatedBy = init.UpdatedBy ?? 0;
    this.Updated = init.Updated ?? null;
  }

  TableName() {
    return "platform_codebuddy_keys";
  }
}

// The table holds at most this one row.
const platformCodeBuddyKeyID = 1;

// PlatformCodeBuddyKeyStatus is what administrators see; it never carries the key.
class PlatformCodeBuddyKeyStatus {
  constructor(init = {}) {
    this.Configured = init.Configured ?? false;
    this.InternetEnvironment = init.InternetEnvironment ?? "";
    this.Models = init.Models ?? null;
    this.UpdatedAt = init.UpdatedAt ?? null;
    this.UpdatedBy = init.UpdatedBy ?? "";
    // LegacySponsor is the account named by AGENTFLOW_ASSISTANT_SPONSOR_LOGIN
    // whose key is lent while no shared key is configured here.
    this.LegacySponsor = init.LegacySponsor ?? "";
    this.LegacySponsorModel = init.LegacySponsorModel ?? "";
  }
}

// PlatformCodeBuddyKeyUpdate replaces the shared key settings. An empty
// APIKey keeps the stored key. Models must already be validated.
class PlatformCodeBuddyKeyUpdate {
  constructor(init = {}) {
    this.APIKey = init.APIKey ?? "";
    this.InternetEnvironment = init.InternetEnvironment ?? "";
    this.Models = init.Models ?? null;
  }
}

const ErrSharedCodeBuddyKeyRequired = new Error("shared CodeBuddy API Key is required");
const ErrSharedCodeBuddyModelsRequired = new Error("at least one shared CodeBuddy model is required");

UsersRepo.prototype.platformCodeBuddyKey = function () {
  const row = new platformCodeBuddyKeyRow();
  if (this == null || this.deps == null || this.DB == null) {
    return [row, false];
  }
  const result = this.DB.Where("id = ?", platformCodeBuddyKeyID).Limit(1).Find(row);
  return [row, result.Error == null && result.RowsAffected > 0];
};

function decodeSharedModels(raw) {
  let models;
  try {
    models = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  return models;
}

// legacyCodeBuddySponsor returns the account named by
// AGENTFLOW_ASSISTANT_SPONSOR_LOGIN, if it exists and has a key.
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

// SharedCodeBuddyKey returns the key users without their own borrow: the one
// configured under 平台管理, else the legacy sponsor account's.
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

// SharedCodeBuddyModels returns the models users without their own key may
// use, the default first, or nil when there is no shared key.
UsersRepo.prototype.SharedCodeBuddyModels = function () {
  const [key, ok] = this.SharedCodeBuddyKey();
  if (ok) {
    return key.Models;
  }
  return null;
};

// PlatformCodeBuddyKeyStatus describes the shared key for administrators.
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

// SetPlatformCodeBuddyKey saves the shared key settings.
UsersRepo.prototype.SetPlatformCodeBuddyKey = function (update, actorID) {
  if (update.Models.length === 0) {
    return ErrSharedCodeBuddyModelsRequired;
  }
  const [row] = this.platformCodeBuddyKey();
  const key = update.APIKey.trim();
  if (key !== "") {
    row.APIKey = key;
  }
  if (row.APIKey.trim() === "") {
    return ErrSharedCodeBuddyKeyRequired;
  }
  let models;
  try {
    models = JSON.stringify(update.Models);
  } catch (e) {
    return e;
  }
  const now = new Date();
  row.ID = platformCodeBuddyKeyID;
  row.InternetEnvironment = update.InternetEnvironment;
  row.Models = models;
  row.UpdatedBy = actorID;
  row.Updated = now;
  return this.DB.Clauses(new clause.OnConflict({
    Columns: [new clause.Column({ Name: "id" })],
    DoUpdates: clause.AssignmentColumns(["api_key", "internet_environment", "models", "updated_by", "updated_at"]),
  })).Create(row).Error;
};

// ClearPlatformCodeBuddyKey removes the shared key; users without their own
// key need one again (or fall back to the legacy sponsor account).
UsersRepo.prototype.ClearPlatformCodeBuddyKey = function () {
  return this.DB.Where("id = ?", platformCodeBuddyKeyID).Delete(new platformCodeBuddyKeyRow()).Error;
};

module.exports = { CodeBuddySponsorLoginEnv, SponsoredCodeBuddyModel, MaxSharedCodeBuddyModels, SharedCodeBuddyKey, platformCodeBuddyKeyRow, platformCodeBuddyKeyID, PlatformCodeBuddyKeyStatus, PlatformCodeBuddyKeyUpdate, ErrSharedCodeBuddyKeyRequired, ErrSharedCodeBuddyModelsRequired, decodeSharedModels };
