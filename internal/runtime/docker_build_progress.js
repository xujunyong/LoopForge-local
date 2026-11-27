// docker_build_progress.js —— 对应 Go 文件：internal/runtime/docker_build_progress.go
// 作用与职责边界：把 Docker 构建日志中的步骤头解析为可读中文进度文案，并在上下文上挂载与读取构建进度回调函数。
// 语法差异说明：
// - Go 的 context.WithValue 在 JS 中无内置值槽，此处以 ctx（通常为 AbortSignal）为键将回调存入 WeakMap；
// - Go 的 regexp.MustCompile 译为 JS 正则字面量；未命中的捕获组在 JS 中为 undefined，通过 ?? "" 对齐 Go 空串。

"use strict";

const dockerBuildProgressReports = new WeakMap();

/**
 * 将 Docker 镜像构建进度回调函数绑定到上下文对象上，用于在构建执行链中透传进度上报器。
 *
 * @param {AbortSignal|object|null} ctx 上下文对象（通常为 AbortSignal）。
 * @param {Function} report 进度回调函数，入参为构建进度对象（WorkspaceImageBuildProgress）。
 * @returns {AbortSignal|object|null} 原样返回传入的上下文对象。
 */
function WithDockerBuildProgress(ctx, report) {
  if (ctx !== null && ctx !== undefined && (typeof ctx === "object" || typeof ctx === "function")) {
    dockerBuildProgressReports.set(ctx, report);
  }
  return ctx;
}

/**
 * 从上下文对象中读取已绑定的 Docker 镜像构建进度回调函数，供构建器在收到日志行时触发上报。
 *
 * @param {AbortSignal|object|null} ctx 上下文对象。
 * @returns {Function|null} 已绑定的进度回调函数；未绑定或上下文为空时返回 null。
 */
function DockerBuildProgressObserver(ctx) {
  if (ctx === null || ctx === undefined) {
    return null;
  }
  return dockerBuildProgressReports.get(ctx) ?? null;
}

const buildKitLine = /^#[0-9]+ /;
const buildKitStep = /^\[(?:([a-zA-Z0-9._\/-]+(?: [a-zA-Z0-9._-]+)?) )?([0-9]{1,6}\/[0-9]{1,6})\] ([A-Z]+)(?: |$)/;
const legacyStep = /^Step ([0-9]{1,6}\/[0-9]{1,6}) : ([A-Z]+)(?: |$)/;

/**
 * 识别单行 Docker 构建输出中的步骤头并转换为中文进度提示；仅匹配步骤头而不复制指令参数或输出，避免泄露凭据。
 *
 * @param {string} line 单行 Docker 构建日志文本。
 * @returns {string} 对应的中文进度描述；非步骤头行时返回空字符串。
 */
function dockerBuildStep(line) {
  const legacy = legacyStep.exec(line);
  if (legacy !== null) {
    return dockerInstructionStep("", legacy[1], legacy[2]);
  }
  const header = buildKitLine.exec(line);
  if (header === null) {
    return "";
  }
  line = line.slice(header[0].length);
  const step = buildKitStep.exec(line);
  if (step !== null) {
    return dockerInstructionStep(step[1] ?? "", step[2], step[3]);
  }
  if (line.startsWith("[internal] load build definition ")) {
    return "读取 Dockerfile";
  }
  if (line.startsWith("[internal] load metadata for ")) {
    return "读取基础镜像信息";
  }
  if (line.startsWith("[internal] load build context")) {
    return "传输构建上下文";
  }
  if (line.startsWith("exporting to ")) {
    return "导出镜像";
  }
  return "";
}

/**
 * 根据 Dockerfile 阶段名、步骤编号和指令类型拼接中文构建步骤提示，用于 dockerBuildStep 格式化输出。
 *
 * @param {string} stage 多阶段构建的阶段名称；单阶段构建时为空字符串。
 * @param {string} step 步骤进度编号（如 "2/5"）。
 * @param {string} instruction Dockerfile 指令名（如 "FROM"、"RUN"）。
 * @returns {string} 格式化后的中文步骤进度描述。
 */
function dockerInstructionStep(stage, step, instruction) {
  if (stage !== "") {
    if (instruction === "FROM") {
      return `准备 Dockerfile 阶段 ${stage} 的基础镜像`;
    }
    return `执行 Dockerfile 阶段 ${stage} 的第 ${step} 步`;
  }
  if (instruction === "FROM") {
    return "准备基础镜像";
  }
  return `执行 Dockerfile 第 ${step} 步`;
}

module.exports = { WithDockerBuildProgress, DockerBuildProgressObserver, buildKitLine, buildKitStep, legacyStep, dockerBuildStep, dockerInstructionStep };
