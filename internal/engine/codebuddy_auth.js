/**
 * @file internal/engine/codebuddy_auth.js
 * 对应 Go 源文件：internal/engine/codebuddy_auth.go
 *
 * 作用与职责边界：
 * 负责 CodeBuddy 执行凭证的解析与平台共享 Key 下的模型收敛：
 * 优先使用责任人个人配置的 CodeBuddy API Key，未配置时回退至平台共享 Key（跳过赞助者本人）；
 * 在使用平台共享 Key 时，将执行器模型限制在管理员允许的列表内并发送遥测与运行事件提示。
 * 领域方法挂载于 `Engine.prototype`（`Engine` 定义于 `engine.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(值, bool)` 译为二元组 `[值, boolean]`；`slices.ContainsFunc` 译为 `Array.prototype.some`。
 * - Go 的 `map[string]any` 译为普通对象 `{}`。
 */

"use strict";

const { TelemetryEvent } = require("../domain/run.js"); // 对应 Go 的 domain.TelemetryEvent，run.js 已翻译
const { SharedCodeBuddyKey, SponsoredCodeBuddyModel } = require("../repo/codebuddy_sponsor.js"); // 对应 Go 的 repo.SharedCodeBuddyKey/SponsoredCodeBuddyModel，codebuddy_sponsor.js 已翻译
const { CodeBuddyCredential, CodeBuddyUserCredential } = require("../runtime/runtime.js"); // 对应 Go 的 runtime.CodeBuddyCredential/CodeBuddyUserCredential，runtime 未翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译

// 注入到执行环境的 CodeBuddy API Key 与网络环境名称的环境变量键。
const codeBuddyAPIKeyEnv = "CODEBUDDY_API_KEY";
const codeBuddyInternetEnv = "CODEBUDDY_INTERNET_ENVIRONMENT";

/**
 * 解析指定责任人应使用的 CodeBuddy 凭证：若用户已配置个人 API Key 则优先使用个人凭证，
 * 否则尝试回退为平台共享 Key（若共享 Key 的赞助者即该用户本人则不回退，仅保留其网络环境配置）。
 * 使用场景：准备节点运行凭据或对话 CLI 凭据时调用。
 *
 * @param {Object | null} s - 数据仓库存储实例（`repo.Store`）。
 * @param {number} userID - 责任人用户 ID。
 * @returns {CodeBuddyCredential} 解析得到的 CodeBuddy 凭证对象；参数无效或用户不存在时返回空凭证。
 */
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

// 节点使用平台共享 Key 时写入遥测与运行时间线的事件类型名。
const sponsoredRunEvent = "model.sponsored";

/**
 * 将使用平台共享 CodeBuddy Key 的执行器模型约束在管理员允许的模型列表中：
 * 若角色配置的模型在允许列表内则保留，否则回退至允许列表默认模型或全局默认赞助模型，
 * 并向遥测接收器及运行事件流（每个运行仅记录一次）写入说明原因。
 * 使用场景：执行使用平台共享 Key 的 CodeBuddy 节点前调用。
 *
 * @param {string} runID - 当前运行 ID。
 * @param {Object} ex - 节点执行器定义（`domain.ExecutorDefinition`）。
 * @param {string[]} models - 平台管理员允许共享 Key 使用的模型列表。
 * @param {function(TelemetryEvent): void} sink - 节点遥测事件接收回调。
 * @returns {Object} 模型字段已按共享 Key 规则收敛后的执行器定义对象。
 */
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

/**
 * 检查运行记录的事件列表中是否已存在指定类型的运行事件。
 * 使用场景：避免在同一运行中重复写入 `model.sponsored` 提示事件。
 *
 * @param {Object} run - 运行记录对象（`domain.Run`）。
 * @param {string} typ - 目标事件类型名称。
 * @returns {boolean} 存在至少一条匹配事件返回 `true`，否则返回 `false`。
 */
function hasRunEvent(run, typ) {
  return run.Events.some((event) => event.Type === typ);
}

module.exports = { codeBuddyAPIKeyEnv, codeBuddyInternetEnv, resolveCodeBuddyCredential, sponsoredRunEvent, hasRunEvent };
