// notification_template.js —— 对应 Go 文件：internal/domain/notification_template.go
// 作用：通知模板校验、渲染与 AI 通知内容解析。

"use strict";

const NotificationURLMarker = "__AGENTFLOW_NOTIFICATION_URL__";

const notificationVariable = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;
const notificationVariableSingle = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/;
const notificationJSONBlock = /```notification[ \t]*\r?\n(.*?)\r?\n```/s;
const notificationSecretPattern = /\b(api[_-]?key|secret|token|authorization)["']?\s*[=:]\s*["']?(?:Bearer\s+)?[^\s,;"']+/gi;
const NotificationVariableNames = ["project", "workflow", "node", "status", "url", "issue.title", "issue.id", "input", "result", "error", "task.name", "ai.summary", "ai.title", "ai.body"];

// NotificationContext：渲染通知模板的上下文。
class NotificationContext {
  constructor(init = {}) {
    this.Values = init.Values ?? {};
    this.Result = init.Result ?? "";
    this.Fallback = init.Fallback ?? "";
    this.SourceType = init.SourceType ?? "";
  }
}

// AINotificationContent：AI 生成的通知标题、摘要与正文。
class AINotificationContent {
  constructor(init = {}) {
    this.Title = init.Title ?? "";
    this.Summary = init.Summary ?? "";
    this.Body = init.Body ?? "";
    this.Simulated = init.Simulated ?? false;
  }
}

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

// ValidateNotificationBinding：校验绑定，失败时 throw。
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

// validateNotificationTemplate：只接受白名单 {{变量}}，其余 {{ 或 }} 均拒绝。
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

// validateNotificationEvents：要求 1 到 3 个不重复的支持事件；run 级绑定不能用 waiting。
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

// ParseNotificationResult：只取显式命名的 notification 代码块；结果里的任意 JSON 或代码围栏都不会执行。
function ParseNotificationResult(result) {
  let ai = new AINotificationContent();
  const block = notificationJSONBlock.exec(result);
  if (block && block.length > 1) {
    try {
      const parsed = JSON.parse(block[1]);
      ai = new AINotificationContent({ Title: parsed.title ?? "", Summary: parsed.summary ?? "", Body: parsed.body ?? "", Simulated: parsed.simulated ?? false });
      if (ai.Summary !== "" || ai.Body !== "") {
        return [ai, result.replace(notificationJSONBlock, "").trim(), true];
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

// RenderNotification：渲染通知正文，返回 [正文, 来源]，失败时 throw。
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

// notificationTemplate：有绑定模板就用它，否则按内容方式、范围与来源取内置默认模板。
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

function CloneNotificationBindings(bindings) {
  return (bindings ?? []).map((b) => {
    const copy = new NotificationBinding(b);
    copy.Events = [...(b.Events ?? [])];
    return copy;
  });
}

module.exports = { NotificationURLMarker, NotificationVariableNames, NotificationContext, AINotificationContent, NotificationUsesAI, ValidateNotificationBinding, NotificationText, ParseNotificationResult, RenderNotification, NotificationAIInstructions, CloneNotificationBindings };
