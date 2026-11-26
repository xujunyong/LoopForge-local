// docker_build_progress.js —— 对应 Go 文件：internal/runtime/docker_build_progress.go
// 作用：把 Docker 构建输出里的步骤头翻译成中文进度，并承载构建进度回调。
// Go 的 context.WithValue 没有 JS 对应写法：AbortSignal 不带值槽，回调按 ctx 存在 WeakMap 里；
// regexp 译为 RegExp；(值, error) 在此文件无出现。

"use strict";

const dockerBuildProgressReports = new WeakMap();

function WithDockerBuildProgress(ctx, report) {
  if (ctx !== null && ctx !== undefined && (typeof ctx === "object" || typeof ctx === "function")) {
    dockerBuildProgressReports.set(ctx, report);
  }
  return ctx;
}

function DockerBuildProgressObserver(ctx) {
  if (ctx === null || ctx === undefined) {
    return null;
  }
  return dockerBuildProgressReports.get(ctx) ?? null;
}

const buildKitLine = /^#[0-9]+ /;
const buildKitStep = /^\[(?:([a-zA-Z0-9._\/-]+(?: [a-zA-Z0-9._-]+)?) )?([0-9]{1,6}\/[0-9]{1,6})\] ([A-Z]+)(?: |$)/;
const legacyStep = /^Step ([0-9]{1,6}\/[0-9]{1,6}) : ([A-Z]+)(?: |$)/;

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
