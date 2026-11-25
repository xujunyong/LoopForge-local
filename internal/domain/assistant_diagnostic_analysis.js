// assistant_diagnostic_analysis.js —— 对应 Go 文件：internal/domain/assistant_diagnostic_analysis.go
// 作用：对导出的助手诊断文件做确定性分析，区分已确认事实与未知原因。

"use strict";

const { AssistantDiagnosticAssessment } = require("./assistant_diagnostics.js"); // 对应 Go 同包类型，assistant_diagnostics.js 翻译后补齐

// AnalyzeAssistantDiagnostics：确定性分析，无需数据库访问。
function AnalyzeAssistantDiagnostics(d) {
  if (d == null || d.Version < 2) {
    return;
  }
  const a = new AssistantDiagnosticAssessment({ Outcome: "undetermined", Summary: "现有证据不足以确认失败原因" });
  d.Assessment = a;
  d.Coverage = [
    "采集平台生命周期、CLI 进程状态、原生错误元数据及工具调用状态；内容为脱敏后的有限片段。",
    "未采集提示词、思考正文、工具参数、成功工具输出、完整 stdout、环境变量或凭证。",
    "CLI 未暴露的内部网络等待、死锁或上游账号状态无法从本文件确认。",
  ];
  const requestIDs = new Set();
  const traceIDs = new Set();
  const pending = analyzeDiagnosticTools(d, a, requestIDs, traceIDs);
  let hasEarlyError = false;
  for (let i = 0; i < d.Attempts.length; i++) {
    const attempt = d.Attempts[i];
    if (attempt.CLIVersion === "") {
      a.Unknowns = appendUniqueDiagnostic(a.Unknowns, "未采集到 CLI 版本。");
    }
    if (attempt.ExitCode != null) {
      a.Evidence.push(`调用 ${attempt.ID} 的进程退出码为 ${attempt.ExitCode}，协议结果为 ${attempt.Status}`);
    }
    if (attempt.FirstError != null) {
      hasEarlyError = true;
      let desc = attempt.FirstError.Kind;
      if (attempt.FirstError.StatusCode > 0) {
        desc = `${desc} (HTTP ${attempt.FirstError.StatusCode})`;
      }
      if (attempt.FirstError.RequestID !== "") {
        requestIDs.add(attempt.FirstError.RequestID);
      }
      if (attempt.FirstError.TraceID !== "") {
        traceIDs.add(attempt.FirstError.TraceID);
      }
      a.Evidence.push(`调用 ${attempt.ID} 首次捕获异常事件：${desc}`);
    }
    const p = attempt.Process;
    if (p != null) {
      if (p.State === "start_failed") {
        a.Evidence.push(`调用 ${attempt.ID} 的 CLI 进程启动失败`);
      }
      if (p.Signal !== "") {
        a.Evidence.push("调用 " + attempt.ID + " 收到进程信号 " + p.Signal);
        a.Unknowns = appendUniqueDiagnostic(a.Unknowns, "进程信号不能单独证明 OOM、管理员操作或宿主机故障。");
      }
      if ((p.State === "running" || p.State === "unknown_after_interruption") && d.Status !== "running") {
        p.State = "unknown_after_interruption";
        a.Evidence.push(`调用 ${attempt.ID} 在平台记录结束前仍处于运行态，未收到进程退出事件`);
      }
      if ((d.Status === "running" || d.Status === "cancelled" || d.Status === "interrupted") && p.State !== "start_failed" && p.StdoutLines === 0 && p.StderrLines === 0) {
        a.Evidence.push(`调用 ${attempt.ID} 的 CLI 进程已启动（PID ${p.PID}），但尚未产生任何 stdout/stderr 输出`);
      }
    }
    for (const e of attempt.Events) {
      if (e.RequestID !== "") {
        requestIDs.add(e.RequestID);
      }
      if (e.TraceID !== "") {
        traceIDs.add(e.TraceID);
      }
    }
  }
  if (d.Termination != null) {
    switch (d.Termination.Code) {
      case "USER_CANCELLED":
        a.Outcome = "cancelled_by_user";
        if (hasEarlyError) {
          a.Evidence.push("用户停止前已捕获到 CLI 或上游错误（详见 firstError），可能是导致等待过久的原因");
        }
        break;
      case "USER_STEER":
        a.Outcome = "redirected_by_user";
        break;
      default:
        a.Outcome = "termination_recorded";
        break;
    }
    a.Summary = d.Termination.Message;
    a.Evidence.push("平台记录的结束原因：" + d.Termination.Code);
    if (d.Termination.Code === "CHECKPOINT_LOST") {
      if (d.LastCheckpointAt != null) {
        // Go time.Format 版式译为 toISOString 去毫秒。
        a.Evidence.push("最后一次运行实例心跳时间：" + d.LastCheckpointAt.toISOString().replace(/\.\d{3}Z$/, "Z"));
      }
      a.Unknowns = appendUniqueDiagnostic(a.Unknowns, "只确认平台未继续保存执行状态；无法仅凭此记录区分进程崩溃、服务重启、OOM 或数据库写入中断。");
      a.NextSteps = appendUniqueDiagnostic(a.NextSteps, "按 environment.instanceId、generationId 和 lastCheckpointAt 查询平台与宿主机日志。");
    }
  } else {
    switch (d.Status) {
      case "completed":
        a.Outcome = "completed";
        a.Summary = "本轮已完成；CLI 警告和已恢复的工具错误仍保留供排查";
        break;
      case "running":
        a.Outcome = "pending";
        a.Summary = "本轮尚未结束，当前文件是执行现场快照";
        if (pending === 0) {
          a.Unknowns = appendUniqueDiagnostic(a.Unknowns, "未观察到正在执行的工具；无法仅凭没有输出区分模型推理等待、网络等待或 CLI 内部阻塞。");
        }
        break;
      case "failed":
        if (d.Failure != null) {
          a.Summary = d.Failure.Message;
          a.Evidence.push("失败阶段：" + d.Failure.Phase + "；分类：" + d.Failure.Code);
          if (d.Failure.Code !== "GENERATION_FAILED" && d.Failure.Code !== "CLI_EXIT_NONZERO" && d.Failure.Code !== "MISSING_RESULT") {
            a.Outcome = "failure_observed";
          }
          switch (d.Failure.Code) {
            case "AUTHENTICATION_FAILED":
            case "PERMISSION_DENIED":
            case "RATE_LIMITED":
            case "QUOTA_EXCEEDED":
            case "UPSTREAM_UNAVAILABLE":
              a.Unknowns = appendUniqueDiagnostic(a.Unknowns, "上游拒绝或服务异常已被观察到；账号配置、限流规则及服务内部原因需要上游记录确认。");
              break;
            case "NETWORK_ERROR":
              a.Unknowns = appendUniqueDiagnostic(a.Unknowns, "连接失败的具体网络节点或代理原因未被 CLI 暴露。");
              break;
            case "CLI_EXIT_NONZERO":
            case "MISSING_RESULT":
            case "GENERATION_FAILED":
              a.Unknowns = appendUniqueDiagnostic(a.Unknowns, "当前错误能确认执行失败，但不足以单独判定 CLI 内部根因。");
              break;
          }
        }
        break;
      case "interrupted":
      case "cancelled":
        a.Unknowns = appendUniqueDiagnostic(a.Unknowns, "未记录明确的终止发起方；不能认定为用户主动停止。");
        break;
    }
  }
  if (requestIDs.size > 0) {
    a.NextSteps = appendUniqueDiagnostic(a.NextSteps, "记录中包含真实 requestId，可据此关联上游模型服务或网关日志。");
  }
  if (traceIDs.size > 0) {
    a.NextSteps = appendUniqueDiagnostic(a.NextSteps, "记录中包含真实 traceId，可据此关联分布式链路日志。");
  }
  if (d.Status !== "completed" && d.Environment != null && d.Environment.InstanceID !== "") {
    a.NextSteps = appendUniqueDiagnostic(a.NextSteps, `可在平台服务端日志检索 diagnostic=${d.GenerationID} 与 instance=${d.Environment.InstanceID} 查看完整后台记录。`);
  }
  if (d.Truncated) {
    a.Unknowns = appendUniqueDiagnostic(a.Unknowns, "部分证据已按上限截断；首次错误、起始片段及最近记录已分别保留，截断计数见 dropped。");
  }
  if (a.Unknowns.length > 0 && d.Status !== "completed") {
    a.NextSteps = appendUniqueDiagnostic(a.NextSteps, "优先检查 firstError、失败/未完成工具（tools）、termination 和 timeline；无法确认的部分以 unknowns 为准。");
  }
}

// analyzeDiagnosticTools：记录工具失败与未完成工具证据，返回待处理工具数。
// Go map[string]bool 译为 Set。
function analyzeDiagnosticTools(d, a, requestIDs, traceIDs) {
  let toolFailures = 0;
  let pending = 0;
  let firstFailedTool = "";
  for (let i = 0; i < d.Tools.length; i++) {
    const t = d.Tools[i];
    if (t.Status === "failed") {
      toolFailures++;
      if (firstFailedTool === "") {
        firstFailedTool = `${t.Name}（来源：${t.Source}）`;
      }
    }
    if (t.Status === "running" || t.Status === "unfinished") {
      if (d.Status !== "running") {
        t.Status = "unfinished";
      }
      pending++;
      a.Evidence.push(`工具 ${t.Name}（${t.ID}，来源：${t.Source}）有开始记录，未收到结束记录`);
    }
    if (t.RequestID !== "") {
      requestIDs.add(t.RequestID);
    }
    if (t.TraceID !== "") {
      traceIDs.add(t.TraceID);
    }
  }
  if (toolFailures > 0) {
    a.Evidence.push(`记录到 ${toolFailures} 次工具失败（首个：${firstFailedTool}）；工具错误本身不直接等同于整轮生成失败`);
  }
  return pending;
}

function appendUniqueDiagnostic(items, value) {
  for (const item of items) {
    if (item.toLowerCase() === value.toLowerCase()) {
      return items;
    }
  }
  return [...items, value];
}

module.exports = { AnalyzeAssistantDiagnostics, analyzeDiagnosticTools, appendUniqueDiagnostic };
