// codebuddy_auth.js —— 对应 Go 文件：internal/engine/codebuddy_auth.go
// 作用：CodeBuddy 凭证解析：优先责任人自己的 Key，没有则用平台共享 Key；共享 Key 下限制模型。
// (值, error) 译为返回值、失败 throw，(值, bool) 译为 [值, bool]。

"use strict";

const { TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TelemetryEvent，run.js 已翻译
const { SharedCodeBuddyKey, SponsoredCodeBuddyModel } = require("../repo/codebuddy_sponsor.js"); // 对应 Go 的 repo.SharedCodeBuddyKey/SponsoredCodeBuddyModel，codebuddy_sponsor.js 已翻译
const { CodeBuddyCredential, CodeBuddyUserCredential } = require("../runtime/runtime.js"); // 对应 Go 的 runtime.CodeBuddyCredential/CodeBuddyUserCredential，runtime 未翻译

const codeBuddyAPIKeyEnv = "CODEBUDDY_API_KEY";
const codeBuddyInternetEnv = "CODEBUDDY_INTERNET_ENVIRONMENT";

function resolveCodeBuddyCredential(s, userID) {
  if (s == null || userID <= 0) {
    return new CodeBuddyCredential();
  }
  const [user, ok] = s.User(userID);
  if (!ok) {
    return new CodeBuddyCredential();
  }
  if (user.CodeBuddyAPIKey.trim() !== "") {
    return CodeBuddyUserCredential(user);
  }
  const [shared, ok2] = s.SharedCodeBuddyKey();
  if (!ok2 || (shared.SponsorID !== 0 && shared.SponsorID === user.ID)) {
    return new CodeBuddyCredential({ InternetEnvironment: user.CodeBuddyInternetEnvironment });
  }
  return new CodeBuddyCredential({ APIKey: shared.APIKey, InternetEnvironment: shared.InternetEnvironment, Sponsored: true, SponsoredModels: shared.Models });
}

const sponsoredRunEvent = "model.sponsored";

Engine.prototype.sponsoredExecutor = function (runID, ex, models, sink) {
  const configured = ex.Model.trim();
  const key = new SharedCodeBuddyKey({ Models: models });
  let [model, allowed] = key.Model(configured);
  if (!allowed) {
    [model] = key.Model("");
  }
  if (model === "") {
    model = SponsoredCodeBuddyModel;
  }
  ex.Model = model;
  let message = "责任人未配置个人 CodeBuddy API Key，本节点使用平台共享 Key，模型 " + model;
  if (configured !== "" && configured !== model) {
    message += "（角色配置的 " + configured + " 不在平台允许的模型中，本次不生效）";
  }
  sink(new TelemetryEvent({ Category: "model", Name: sponsoredRunEvent, Phase: "start", Message: message, Provider: ex.Kind, Model: ex.Model, Attributes: { configuredModel: configured } }));
  const [current, ok] = this.repo.RunState(runID);
  if (ok && !hasRunEvent(current, sponsoredRunEvent)) {
    this.updateRun(runID, (r) => {
      if (!hasRunEvent(r, sponsoredRunEvent)) {
        this.event(r, "", sponsoredRunEvent, "责任人未配置个人 CodeBuddy API Key，本次运行使用平台共享 Key，只能使用平台管理员允许的模型（" + models.join("、") + "）。在个人配置中配置自己的 Key 后，可使用角色配置的任意模型");
      }
    });
  }
  return ex;
};

function hasRunEvent(run, typ) {
  return run.Events.some((event) => event.Type === typ);
}

module.exports = { codeBuddyAPIKeyEnv, codeBuddyInternetEnv, resolveCodeBuddyCredential, sponsoredRunEvent, hasRunEvent };
