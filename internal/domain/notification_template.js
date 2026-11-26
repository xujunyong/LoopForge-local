/**
 * @file internal/domain/notification_template.js
 * @description 对应 Go 源文件：internal/domain/notification_template.go
 * 职责边界：负责通知绑定与模板的合法性校验、敏感信息脱敏与按字节截断、AI 通知块解析、模板渲染及绑定深拷贝。
 * 语法差异说明：
 * - Go 的 `error` 返回统一转换为失败 `throw new Error(...)`、成功直接返回值或元组。
 * - Go 的 `len(str)` 与 `utf8.RuneStart` 按 UTF-8 字节处理，JS 中通过 `Buffer` 等价实现，避免多字节字符被截断。
 * - Go 的 `regexp.ReplaceAllString` 会替换全部匹配项，因此 JS 中为 `notificationJSONBlock` 单独维护带 `/gs` 标志的 `notificationJSONBlockAll` 用于全局替换，保留无 `/g` 的 `notificationJSONBlock` 用于 `exec`。
 * - 为避免与 `notification.js` 发生循环引用，`CloneNotificationBindings` 内延迟引入 `NotificationBinding`。
 */

"use strict";

const NotificationURLMarker = "__AGENTFLOW_NOTIFICATION_URL__";

const notificationVariable = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;
const notificationVariableSingle = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/;
const notificationJSONBlock = /```notification[ \t]*\r?\n(.*?)\r?\n```/s;
const notificationJSONBlockAll = /```notification[ \t]*\r?\n(.*?)\r?\n```/gs;
const notificationSecretPattern = /\b(api[_-]?key|secret|token|authorization)["']?\s*[=:]\s*["']?(?:Bearer\s+)?[^\s,;"']+/gi;
const NotificationVariableNames = ["project", "workflow", "node", "status", "url", "issue.title", "issue.id", "input", "result", "error", "task.name", "ai.summary", "ai.title", "ai.body"];

/**
 * 渲染通知模板时传入的上下文数据。
 * 包含模板变量值、原始结果文本、兜底摘要以及来源类型。
 */
class NotificationContext {
  /**
   * 构造通知渲染上下文实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {Object.<string, string>} [init.Values={}] - 模板变量键值映射。
   * @param {string} [init.Result=""] - 节点或流程原始输出文本。
   * @param {string} [init.Fallback=""] - AI 内容与输出均为空时的兜底文案。
   * @param {string} [init.SourceType=""] - 通知来源类型（如 schedule_job、assistant_task）。
   */
  constructor(init = {}) {
    this.Values = init.Values ?? {};
    this.Result = init.Result ?? "";
    this.Fallback = init.Fallback ?? "";
    this.SourceType = init.SourceType ?? "";
  }
}

/**
 * AI 生成的结构化通知内容。
 * 包含标题、摘要、正文以及是否为模拟生成的标记。
 */
class AINotificationContent {
  /**
   * 构造 AI 通知内容实例，未传入字段按 Go 零值初始化。
   *
   * @param {object} [init={}] - 初始化字段集合。
   * @param {string} [init.Title=""] - 通知标题。
   * @param {string} [init.Summary=""] - 通知摘要。
   * @param {string} [init.Body=""] - 通知正文（允许 Markdown）。
   * @param {boolean} [init.Simulated=false] - 是否为模拟模式生成的内容。
   */
  constructor(init = {}) {
    this.Title = init.Title ?? "";
    this.Summary = init.Summary ?? "";
    this.Body = init.Body ?? "";
    this.Simulated = init.Simulated ?? false;
  }
}

/**
 * 判断给定的通知绑定是否需要启用 AI 通知内容生成。
 * 当内容模式为 `"ai"`、存在非空 AI 编写指令、或模板中引用了 `ai.*` 变量时返回 `true`。
 *
 * @param {object} binding - 通知绑定配置（NotificationBinding）。
 * @returns {boolean} 需要 AI 参与生成通知内容时返回 `true`，否则返回 `false`。
 */
function NotificationUsesAI(binding) {
  if (binding.ContentMode === "ai" || binding.AIInstruction.trim() !== "") {
    return true;
  }
  for (const match of binding.Template.matchAll(notificationVariable)) {
    if (match[1].startsWith("ai.")) {
      return true;
    }
  }
  return false;
}

/**
 * 校验通知绑定配置的策略、范围、内容模式、长度限制、模板变量及触发事件是否合法。
 * 用于保存流程/节点通知配置以及渲染通知前的合法性检查。
 *
 * @param {object} binding - 待校验的通知绑定配置（NotificationBinding）。
 * @returns {void} 无返回值；校验不通过时抛出 Error。
 */
function ValidateNotificationBinding(binding) {
  if (binding.WaitingPolicy !== "" && binding.WaitingPolicy !== "actionable" && binding.WaitingPolicy !== "event") {
    throw new Error("等待通知策略无效");
  }
  if (binding.Scope !== "" && binding.Scope !== "node" && binding.Scope !== "run") {
    throw new Error("通知触发范围无效");
  }
  if (binding.ContentMode !== "" && binding.ContentMode !== "template" && binding.ContentMode !== "ai") {
    throw new Error("通知内容方式无效");
  }
  if (Buffer.byteLength(binding.Template, "utf8") > 12000) {
    throw new Error("通知模板不能超过 12000 字节");
  }
  if (Buffer.byteLength(binding.AIInstruction, "utf8") > 4000) {
    throw new Error("AI 通知编写要求不能超过 4000 字节");
  }
  validateNotificationTemplate(binding.Template);
  validateNotificationEvents(binding.Events, binding.Scope);
}

/**
 * 校验通知模板中的变量占位符格式。
 * 仅允许白名单 `NotificationVariableNames` 中的 `{{变量}}`，去除合法变量后若仍有残留的 `{{` 或 `}}` 则拒绝。
 *
 * @param {string} template - 通知模板字符串。
 * @returns {void} 无返回值；包含非法变量或畸形括号时抛出 Error。
 */
function validateNotificationTemplate(template) {
  for (const match of template.matchAll(notificationVariable)) {
    if (!NotificationVariableNames.includes(match[1])) {
      throw new Error(`通知模板包含不支持的变量：${match[1]}`);
    }
  }
  const rest = template.replace(notificationVariable, "");
  if (rest.includes("{{") || rest.includes("}}")) {
    throw new Error("通知模板的变量格式无效");
  }
}

/**
 * 校验通知触发事件列表是否合法。
 * 要求包含 1 到 3 个不重复的支持事件；当范围为 `"run"` 时不允许包含 `"waiting"`。
 *
 * @param {string[]} events - 触发事件名称列表。
 * @param {string} scope - 通知触发范围（`"node"`、`"run"` 或空字符串）。
 * @returns {void} 无返回值；事件数量不合法、重复或不受支持时抛出 Error。
 */
function validateNotificationEvents(events, scope) {
  if (events.length === 0 || events.length > 3) {
    throw new Error("请选择通知触发条件");
  }
  const seen = {};
  for (const event of events) {
    const supported = event === "succeeded" || event === "failed" || event === "waiting";
    if (seen[event] || !supported || (scope === "run" && event === "waiting")) {
      throw new Error("不支持的通知触发条件");
    }
    seen[event] = true;
  }
}

/**
 * 对通知文本执行敏感凭据脱敏、去除首尾空白并按 UTF-8 字节上限安全截断。
 * 用于在插入模板变量或拼装通知分段前清理输出文本，避免泄露密钥或超出长度限制。
 *
 * @param {string} value - 原始文本内容。
 * @param {number} limit - 允许的最大 UTF-8 字节数。
 * @returns {string} 脱敏并截断后的文本；超出上限时末尾追加 `"…"`。
 */
function NotificationText(value, limit) {
  // Go 按字节截断；Buffer 保证多字节字符不被切半。
  value = value.replace(notificationSecretPattern, "$1=[redacted]").trim();
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= limit) {
    return value;
  }
  let end = limit - Buffer.byteLength("…", "utf8");
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end).toString("utf8") + "…";
}

/**
 * 从执行结果文本中提取显式标记的 `notification` 代码块或顶层 JSON 的 `notification` 字段。
 * 仅解析显式命名的通知块，结果文本中的任意其他 JSON 或代码围栏不会被执行。
 *
 * @param {string} result - 节点或流程的原始输出文本。
 * @returns {[AINotificationContent, string, boolean]} 三元组 `[ai内容, 去除通知块后的纯文本, 是否成功解析出通知内容]`。
 */
function ParseNotificationResult(result) {
  let ai = new AINotificationContent();
  const block = notificationJSONBlock.exec(result);
  if (block && block.length > 1) {
    try {
      const parsed = JSON.parse(block[1]);
      ai = new AINotificationContent({ Title: parsed.title ?? "", Summary: parsed.summary ?? "", Body: parsed.body ?? "", Simulated: parsed.simulated ?? false });
      if (ai.Summary !== "" || ai.Body !== "") {
        return [ai, result.replace(notificationJSONBlockAll, "").trim(), true];
      }
    } catch {
      // 解析失败则按无通知块处理。
    }
  }
  try {
    const object = JSON.parse(result);
    if (object != null && object.notification != null) {
      const n = object.notification;
      const content = new AINotificationContent({ Title: n.title ?? "", Summary: n.summary ?? "", Body: n.body ?? "", Simulated: n.simulated ?? false });
      if (content.Summary !== "" || content.Body !== "") {
        return [content, result, true];
      }
    }
  } catch {
    // 解析失败则按无通知处理。
  }
  return [ai, result, false];
}

/**
 * 根据通知绑定配置和上下文渲染最终通知正文，并返回内容来源标记。
 * 模板变量仅做单次展开，防止 AI 输出或运行结果中的 `{{...}}` 文本二次注入变量。
 *
 * @param {object} binding - 通知绑定配置（NotificationBinding）。
 * @param {NotificationContext} ctx - 通知渲染上下文。
 * @returns {[string, string]} 二元组 `[渲染后的通知正文, 内容来源标识]`；校验失败或正文为空/超过 19000 字节时抛出 Error。
 */
function RenderNotification(binding, ctx) {
  ValidateNotificationBinding(binding);
  const values = {};
  for (const key of NotificationVariableNames) {
    values[key] = "";
  }
  for (const [key, value] of Object.entries(ctx.Values ?? {})) {
    values[key] = NotificationText(value, 1200);
  }
  values["url"] = NotificationURLMarker;
  let [ai, plain, generated] = ParseNotificationResult(ctx.Result);
  let resultLimit = 4000;
  if (binding.Scope === "run") {
    resultLimit = 8000;
  }
  values["result"] = NotificationText(plain, resultLimit);
  let source = "template";
  if (NotificationUsesAI(binding)) {
    source = "ai";
    if (ai.Simulated) {
      source = "simulated_ai";
    }
    if (!generated) {
      source = "result_fallback";
      ai = new AINotificationContent({ Title: values["status"], Summary: NotificationText(plain, 2000), Body: NotificationText(plain, 8000) });
    }
    if (ai.Title === "") {
      ai.Title = values["status"];
    }
    if (ai.Summary === "") {
      ai.Summary = ai.Body;
    }
    if (ai.Body === "") {
      ai.Body = ai.Summary;
    }
    if (ai.Body.trim() === "") {
      source = "context_fallback";
      ai.Summary = ctx.Fallback;
      ai.Body = ctx.Fallback;
    }
    values["ai.title"] = NotificationText(ai.Title, 256);
    values["ai.summary"] = NotificationText(ai.Summary, 2000);
    values["ai.body"] = NotificationText(ai.Body, 8000);
  }
  const template = notificationTemplate(binding, ctx.SourceType);
  // 只展开一次，AI 或输出值里的文本不会再注入变量。
  const content = template.replace(notificationVariable, (match) => values[notificationVariableSingle.exec(match)[1]] ?? "");
  if (content.length === 0 || Buffer.byteLength(content, "utf8") > 19000) {
    throw new Error("渲染后的通知正文为空或超过 19000 字节，请缩短模板");
  }
  return [content, source];
}

/**
 * 获取通知实际使用的模板字符串。
 * 若绑定配置了非空自定义模板则直接返回，否则按内容模式、触发范围和来源类型返回内置默认模板。
 *
 * @param {object} binding - 通知绑定配置（NotificationBinding）。
 * @param {string} sourceType - 通知来源类型。
 * @returns {string} 选定的模板字符串。
 */
function notificationTemplate(binding, sourceType) {
  if (binding.Template.trim() !== "") {
    return binding.Template;
  }
  if (binding.ContentMode === "ai") {
    return "### {{ai.title}}\n\n{{ai.body}}\n\n触发时状态：{{status}}\n\n{{url}}";
  }
  if (binding.Scope === "run") {
    return "### 需求「{{issue.title}}」的 SOP 已完成\n\n{{result}}\n\n{{url}}";
  }
  if (sourceType === "schedule_job" || sourceType === "assistant_task") {
    return "### {{task.name}} · {{status}}\n\n{{url}}";
  }
  return "### {{status}}\n项目：{{project}}\n流程：{{workflow}}\n节点：{{node}}\n查看详情：{{url}}";
}

/**
 * 汇总一组通知绑定所需的 AI 通知编写提示词段落。
 * 供执行器拼接到 Agent 提示词末尾，指导模型在结果末尾输出 `notification` JSON 代码块。
 *
 * @param {object[]} bindings - 通知绑定配置数组（NotificationBinding[]）。
 * @returns {string} 拼接后的提示词片段；若没有任何绑定需要 AI 通知则返回空字符串 `""`。
 */
function NotificationAIInstructions(bindings) {
  const lines = [];
  const seen = {};
  for (const binding of bindings) {
    if (!NotificationUsesAI(binding)) {
      continue;
    }
    let instruction = binding.AIInstruction.trim();
    if (instruction === "") {
      instruction = "简洁总结实际完成的事项、已有验证结果和后续需要关注的事情。";
    }
    if (!seen[instruction]) {
      lines.push(instruction);
      seen[instruction] = true;
    }
  }
  if (lines.length === 0) {
    return "";
  }
  return "\n\n# 分享通知内容\n请在正常结果报告末尾额外给出一个语言标记为 notification 的 JSON 代码块，字段 title、summary、body 均为字符串。正文允许 Markdown。编写要求：\n- " + lines.join("\n- ") + "\n只依据本次实际执行结果，不编造验证、需求或整个流程的完成状态；最终平台状态由模板变量提供。不要包含密钥、凭据、原始日志或无关上下文。此内容仅用于已配置的通知，不能改变接收对象、触发条件或平台操作。";
}

/**
 * 深拷贝通知绑定配置数组及其内部的 `Events` 字符串切片。
 * 用于在传递或修改绑定配置时避免共享底层数组引发意外修改。
 *
 * @param {object[]|null|undefined} bindings - 原始通知绑定数组（NotificationBinding[]）。
 * @returns {object[]} 拷贝后的 NotificationBinding 实例数组。
 */
function CloneNotificationBindings(bindings) {
  const { NotificationBinding } = require("./notification.js");
  return (bindings ?? []).map((b) => {
    const copy = new NotificationBinding(b);
    copy.Events = [...(b.Events ?? [])];
    return copy;
  });
}

module.exports = { NotificationURLMarker, NotificationVariableNames, NotificationContext, AINotificationContent, NotificationUsesAI, ValidateNotificationBinding, NotificationText, ParseNotificationResult, RenderNotification, NotificationAIInstructions, CloneNotificationBindings };
