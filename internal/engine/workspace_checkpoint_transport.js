// workspace_checkpoint_transport.js —— 对应 Go 文件：internal/engine/workspace_checkpoint_transport.go
// 作用：工作区快照控制通道：runner 请求转发与本地 HTTP 处理。
// context.Context 译为 AbortSignal；(值, error) 译为 [值, error]，只返回 error 的译为 error 值；net/http 客户端译为 fetch，服务端 http.Error 译为 writeHead/end；sync.Mutex 在单线程 JS 里不需要。

"use strict";

const fs = require("node:fs");

const { RunnerWorkspaceRequest, RunnerWorkspaceResponse, IsWorkspaceCheckpointTransferOperation, RunnerWorkspaceOperationCheckpointStatus, RunnerWorkspaceOperationCheckpointExport, RunnerWorkspaceOperationCheckpointRead, RunnerWorkspaceOperationCheckpointClose, RunnerWorkspaceOperationCheckpointUpload, RunnerWorkspaceOperationCheckpointAppend, RunnerWorkspaceOperationCheckpointCommit, RunnerWorkspaceOperationCheckpoint, RunnerWorkspaceOperationRestore, RunnerWorkspaceOperationPrepare, RunnerWorkspaceOperationPreparationStatus, RunnerWorkspaceOperationPreparationRecord, RunnerWorkspaceOperationTerminal, RunnerWorkspaceOperationReclaim, RunnerWorkspaceOperationArtifacts, RunnerWorkspaceOperationBrowser, RunnerWorkspaceOperationInfo, WorkspaceCheckpointTransfer, WorkspaceErrorBusy } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspaceRequest/RunnerWorkspaceResponse/IsWorkspaceCheckpointTransferOperation/RunnerWorkspaceOperation*/WorkspaceCheckpointTransfer/WorkspaceErrorBusy，runner_workspace.js 已翻译
const { WorkspaceCheckpointStatus } = require("../runtime/workspace_checkpoint_transfer.js"); // 对应 Go 的 runtime.WorkspaceCheckpointStatus，runtime 待翻译
const { RestoreMissingWorkspaceArtifacts } = require("../runtime/workspace_artifacts.js"); // 对应 Go 的 runtime.RestoreMissingWorkspaceArtifacts，runtime 待翻译
const { CreateWorkspaceCheckpointContext, RestoreWorkspaceCheckpoint, WorkspaceDirHasContent } = require("../runtime/workspace_checkpoint.js"); // 对应 Go 的 runtime.CreateWorkspaceCheckpointContext/RestoreWorkspaceCheckpoint/WorkspaceDirHasContent，runtime 待翻译
const { RecordWorkspacePreparation } = require("../runtime/workspace_preparation.js"); // 对应 Go 的 runtime.RecordWorkspacePreparation，runtime 待翻译
const { TerminalGitCredentials } = require("../runtime/workspace_terminal.js"); // 对应 Go 的 runtime.TerminalGitCredentials，runtime 待翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { controlTokenHeader } = require("./run_control.js"); // 对应 Go 同包常量，run_control.js 已翻译
const { workspaceCheckpointResponseError, workspaceCheckpointTransferFromWire } = require("./workspace_checkpoint_stream.js"); // 对应 Go 同包函数，workspace_checkpoint_stream.js 本次一同翻译

const ErrWorkspaceControlConfiguration = new Error("工作区控制通道配置错误");

function workspaceOperationLabel(operation) {
  switch (operation) {
    case RunnerWorkspaceOperationCheckpointStatus:
      return "检查工作区恢复状态";
    case RunnerWorkspaceOperationCheckpointExport:
    case RunnerWorkspaceOperationCheckpointRead:
    case RunnerWorkspaceOperationCheckpointClose:
      return "保存工作区快照";
    case RunnerWorkspaceOperationCheckpointUpload:
    case RunnerWorkspaceOperationCheckpointAppend:
    case RunnerWorkspaceOperationCheckpointCommit:
      return "恢复工作区快照";
    case RunnerWorkspaceOperationCheckpoint:
      return "保存工作区快照";
    case RunnerWorkspaceOperationRestore:
      return "恢复工作区快照";
    case RunnerWorkspaceOperationReclaim:
      return "回收工作区";
    case RunnerWorkspaceOperationPrepare:
      return "重建工作区环境";
    case RunnerWorkspaceOperationPreparationStatus:
      return "检查工作区环境";
    case RunnerWorkspaceOperationPreparationRecord:
      return "记录工作区准备结果";
    case RunnerWorkspaceOperationArtifacts:
      return "恢复归档产物";
    case RunnerWorkspaceOperationBrowser:
      return "连接 Agent 浏览器";
    case RunnerWorkspaceOperationTerminal:
      return "访问工作区终端";
    default:
      return "访问工作区";
  }
}

Engine.prototype.requestWorkspaceCheckpoint = async function (ctx, run, request) {
  // Go 的 sync.Mutex 在单线程 JS 里不需要，直接读字段。
  const apiBase = this.workspaceControlBase;
  const token = this.controlToken;
  let base = "";
  if (this.defaultExecutionRunner(run) !== "") {
    if (this.WorkspaceCheckpointTransport != null) {
      try {
        const response = await this.WorkspaceCheckpointTransport(ctx, run, request);
        return [response, null];
      } catch (err) {
        return [new RunnerWorkspaceResponse({}), err];
      }
    }
    base = apiBase;
  } else if (this.foreignWorkspaceBind(run)) {
    base = this.repo.WorkspaceHostControlURL(run.WorkspaceHost);
  }
  const operation = workspaceOperationLabel(request.Operation);
  if (token === "") {
    return [new RunnerWorkspaceResponse({}), new Error(`${ErrWorkspaceControlConfiguration.message}：无法${operation}；请为 API 和 Worker 配置相同的 AGENTFLOW_CONTROL_TOKEN`)];
  }
  if (base === "") {
    let hint = "工作区所属 Worker 未公布有效的 AGENTFLOW_CONTROL_URL";
    if (this.defaultExecutionRunner(run) !== "") {
      hint = "Worker 未配置内部 API 地址 AGENTFLOW_API_URL";
    }
    return [new RunnerWorkspaceResponse({}), new Error(`${ErrWorkspaceControlConfiguration.message}：无法${operation}；${hint}`)];
  }
  return postWorkspaceRequest(ctx, base, token, request);
};

async function postWorkspaceRequest(ctx, base, token, request) {
  const operation = workspaceOperationLabel(request.Operation);
  let body;
  try {
    body = Buffer.from(JSON.stringify(request), "utf8");
  } catch (err) {
    return [new RunnerWorkspaceResponse({}), err];
  }
  let response;
  try {
    // Go 的 bytes.NewReader(body) 译为直接传 Buffer。
    response = await fetch(base.replace(/\/+$/, "") + "/internal/workspace-checkpoint", {
      method: "POST",
      headers: { [controlTokenHeader]: token, "Content-Type": "application/json" },
      body,
      signal: ctx instanceof AbortSignal ? ctx : undefined,
    });
  } catch (err) {
    return [new RunnerWorkspaceResponse({}), err];
  }
  if (response.status !== 200) {
    if (response.status === 400 && request.Operation === RunnerWorkspaceOperationCheckpointStatus) {
      return [new RunnerWorkspaceResponse({ Status: 400, Error: "unsupported workspace operation" }), null];
    }
    if (response.status === 401 || response.status === 403) {
      return [new RunnerWorkspaceResponse({}), new Error(`${ErrWorkspaceControlConfiguration.message}：${operation}认证失败（HTTP ${response.status}）；请核对 API/Worker 的 AGENTFLOW_CONTROL_TOKEN 和内部 API 地址`)];
    }
    return [new RunnerWorkspaceResponse({}), new Error(`${operation}失败：工作区控制服务返回 HTTP ${response.status}`)];
  }
  let result;
  try {
    const raw = JSON.parse(await response.text());
    result = new RunnerWorkspaceResponse({ Payload: raw.payload != null ? Buffer.from(JSON.stringify(raw.payload), "utf8") : null, Error: raw.error ?? "", Code: raw.code ?? "", Status: raw.status ?? 0 });
  } catch (err) {
    return [new RunnerWorkspaceResponse({}), err];
  }
  return [result, null];
}

Engine.prototype.HandleWorkspaceCheckpoint = async function (w, r) {
  // Go 的 r.Context()：JS 里无请求上下文，用 null 表示。
  const ctx = null;
  const configured = this.controlToken !== "";
  if (!configured || !this.controlTokenOK(r.headers[controlTokenHeader.toLowerCase()] ?? "")) {
    w.writeHead(401);
    w.end("unauthorized");
    return;
  }
  let request;
  try {
    const chunks = [];
    for await (const chunk of r) {
      chunks.push(chunk);
    }
    const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    request = new RunnerWorkspaceRequest({
      RunID: raw.runId ?? "", RunStatus: raw.runStatus ?? "", RunKind: raw.runKind ?? "",
      WorkspaceLayout: raw.workspaceLayout ?? "", Operation: raw.operation ?? "",
      CheckpointTransfer: raw.checkpointTransfer != null ? workspaceCheckpointTransferFromWire(raw.checkpointTransfer) : null,
      CheckpointLease: raw.checkpointLease ?? "",
      Checkpoint: raw.checkpoint != null ? Buffer.from(raw.checkpoint, "base64") : null,
      ArtifactFiles: raw.artifactFiles ?? null, Terminal: raw.terminal ?? null,
      TerminalOwner: raw.terminalOwner ?? 0, Workflow: raw.workflow ?? null,
      Repositories: raw.repositories ?? null, PreparationNodeID: raw.preparationNodeId ?? "",
      PreparationOutput: raw.preparationOutput ?? "", Browser: raw.browser ?? null,
    });
  } catch (err) {
    w.writeHead(400);
    w.end("invalid request");
    return;
  }
  const [run, ok] = this.repo.RunState(request.RunID);
  if (!ok) {
    w.writeHead(404);
    w.end("run not found");
    return;
  }
  if (request.Operation === RunnerWorkspaceOperationBrowser) {
    w.setHeader("Content-Type", "application/json");
    w.end(JSON.stringify(this.HandleBrowserRequest(ctx, run, request.Browser)) + "\n");
    return;
  }
  const transfer = IsWorkspaceCheckpointTransferOperation(request.Operation);
  const probe = request.Operation === RunnerWorkspaceOperationCheckpointStatus;
  if (!probe && !transfer && request.Operation !== RunnerWorkspaceOperationPreparationRecord && request.Operation !== RunnerWorkspaceOperationPrepare && request.Operation !== RunnerWorkspaceOperationPreparationStatus && request.Operation !== RunnerWorkspaceOperationTerminal && request.Operation !== RunnerWorkspaceOperationCheckpoint && request.Operation !== RunnerWorkspaceOperationRestore && request.Operation !== RunnerWorkspaceOperationReclaim && request.Operation !== RunnerWorkspaceOperationArtifacts) {
    w.writeHead(400);
    w.end("unsupported operation");
    return;
  }
  if (request.Operation === RunnerWorkspaceOperationTerminal && (request.Terminal == null || request.TerminalOwner <= 0)) {
    w.writeHead(400);
    w.end("invalid terminal request");
    return;
  }
  const artifactsAllowed = request.Operation === RunnerWorkspaceOperationArtifacts && (run.IsWorkspace() || (run.Status !== "running" && run.Status !== "queued" && !run.HasActiveNode()));
  const interactive = request.Operation === RunnerWorkspaceOperationPreparationRecord || request.Operation === RunnerWorkspaceOperationPrepare || request.Operation === RunnerWorkspaceOperationPreparationStatus || request.Operation === RunnerWorkspaceOperationTerminal;
  const transferAux = transfer && request.Operation !== RunnerWorkspaceOperationCheckpointExport && request.Operation !== RunnerWorkspaceOperationCheckpointCommit;
  if (!probe && !interactive && (sharesWorkspace(run) || (!artifactsAllowed && !transferAux && !this.conversationWorkspaceIdle(run)))) {
    w.writeHead(409);
    w.end("workspace in use");
    return;
  }
  // 把执行标志绑定到持久化状态，包括转发给 Runner 的请求。
  request.RunStatus = run.Status;
  request.RunKind = run.Kind;
  request.WorkspaceLayout = run.ExecutionContext.RunnerWorkspaceLayout;
  if (interactive) {
    try {
      request = this.preparedWorkspaceRequest(run, request);
    } catch (err) {
      w.writeHead(409);
      w.end(err.message);
      return;
    }
  }
  let result = new RunnerWorkspaceResponse({});
  if (this.defaultExecutionRunner(run) !== "") {
    if (this.WorkspaceCheckpointTransport == null) {
      w.writeHead(503);
      w.end("runner transport unavailable");
      return;
    }
    try {
      result = await this.WorkspaceCheckpointTransport(ctx, run, request);
    } catch (err) {
      result.Error = err.message;
      result.Status = 503;
    }
  } else if (interactive) {
    switch (request.Operation) {
      case RunnerWorkspaceOperationPreparationRecord: {
        let env;
        try {
          env = this.acquireConversationEnvironment(ctx, run);
        } catch (err) {
          result.Error = err.message;
          result.Status = 409;
          break;
        }
        env.nodeMu.Lock();
        const [state, recordErr] = RecordWorkspacePreparation(ctx, env.sandbox, request.Workflow, request.Repositories, request.PreparationNodeID, request.PreparationOutput);
        env.nodeMu.Unlock();
        result.Payload = Buffer.from(JSON.stringify(state), "utf8");
        if (recordErr != null) {
          result.Error = recordErr.message;
          result.Status = 409;
        }
        break;
      }
      case RunnerWorkspaceOperationPrepare: {
        const [state, prepareErr] = await this.EnsureWorkspaceReady(ctx, run.ID);
        result.Payload = Buffer.from(JSON.stringify(state), "utf8");
        if (prepareErr != null) {
          result.Error = prepareErr.message;
          result.Status = 409;
        }
        break;
      }
      case RunnerWorkspaceOperationPreparationStatus: {
        const [state, statusErr] = await this.WorkspacePreparationStatus(ctx, run.ID);
        result.Payload = Buffer.from(JSON.stringify(state), "utf8");
        if (statusErr != null) {
          result.Error = statusErr.message;
          result.Status = 409;
        }
        break;
      }
      case RunnerWorkspaceOperationTerminal: {
        if (request.Terminal == null || request.TerminalOwner <= 0) {
          result.Error = "invalid terminal request";
          result.Status = 400;
          break;
        }
        const scope = `${run.ID}:${request.TerminalOwner}`;
        if (request.Terminal.Operation === "close-all") {
          this.workspaceTerminals.CloseScope(scope);
          result.Payload = Buffer.from('{"ok":true}', "utf8");
          break;
        }
        let credentials = new TerminalGitCredentials({});
        if (request.Terminal.Operation === "open") {
          credentials = this.WorkspaceTerminalGitCredentials(ctx, run, request.TerminalOwner);
        }
        const [value, terminalErr] = await this.HandlePreparedWorkspaceTerminal(ctx, run, this.workspaceTerminals, scope, request.Terminal, credentials);
        result.Payload = Buffer.from(JSON.stringify(value), "utf8");
        if (terminalErr != null) {
          result.Error = terminalErr.message;
          result.Status = 409;
        }
        break;
      }
      default:
        break;
    }
  } else {
    const [root, reason] = this.LocalRunWorkspace(run);
    if (reason !== "") {
      w.writeHead(409);
      w.end(reason);
      return;
    }
    if (probe) {
      if (!this.conversationWorkspaceIdle(run)) {
        result = new RunnerWorkspaceResponse({ Status: 409, Code: WorkspaceErrorBusy, Error: "workspace is still in use" });
      } else {
        result = WorkspaceCheckpointStatus(root);
      }
    } else if (transfer) {
      if (request.Operation === RunnerWorkspaceOperationCheckpointCommit) {
        const discardErr = await this.discardEmptyWorkspaceContainer(ctx, run.ID, root);
        if (discardErr != null) {
          result.Error = discardErr.message;
        }
      }
      if (result.Error === "") {
        result = this.checkpointTransfers.Handle(ctx, root, request);
      }
    } else if (request.Operation === RunnerWorkspaceOperationReclaim) {
      const [meta, saved] = this.repo.WorkspaceCheckpoint(run.ID);
      if (!saved || meta.SavedAt == null || meta.Error !== "" || run.WorkspaceCleanedAt == null || request.CheckpointLease === "" || meta.LeaseToken !== request.CheckpointLease || meta.LeaseUntil == null || meta.LeaseUntil.getTime() <= Date.now()) {
        w.writeHead(409);
        w.end("workspace cleanup not reserved");
        return;
      }
      const releaseErr = this.releaseRunEnvironment(run.ID, true);
      if (releaseErr != null) {
        result.Error = releaseErr.message;
      } else {
        result.Payload = Buffer.from('{"reclaimed":true}', "utf8");
      }
    } else if (request.Operation === RunnerWorkspaceOperationArtifacts) {
      const [restored, restoreErr] = RestoreMissingWorkspaceArtifacts(root, request.ArtifactFiles);
      if (restoreErr != null) {
        result.Error = restoreErr.message;
      } else {
        result.Payload = Buffer.from(JSON.stringify({ restoredArtifacts: restored }), "utf8");
      }
    } else if (request.Operation === RunnerWorkspaceOperationCheckpoint) {
      const [archive, checkpointErr] = CreateWorkspaceCheckpointContext(ctx, root);
      if (checkpointErr != null) {
        result.Error = checkpointErr.message;
      } else {
        result.Payload = Buffer.from(JSON.stringify({ checkpoint: archive.toString("base64") }), "utf8");
      }
    } else {
      const discardErr = await this.discardEmptyWorkspaceContainer(ctx, run.ID, root);
      if (discardErr != null) {
        result.Error = discardErr.message;
      } else {
        const restoreErr = RestoreWorkspaceCheckpoint(root, request.Checkpoint);
        if (restoreErr != null) {
          result.Error = restoreErr.message;
        } else {
          result.Payload = Buffer.from('{"restored":true}', "utf8");
        }
      }
    }
  }
  w.setHeader("Content-Type", "application/json");
  w.end(JSON.stringify(result) + "\n");
};

Engine.prototype.discardEmptyWorkspaceContainer = function (ctx, runID, root) {
  let info;
  try {
    info = fs.lstatSync(root);
  } catch (err) {
    return null;
  }
  if (!info.isDirectory()) {
    return null;
  }
  const [hasContent, hasErr] = WorkspaceDirHasContent(root);
  if (hasErr != null || hasContent) {
    return null;
  }
  const releaseErr = this.releaseRunEnvironment(runID, false);
  if (releaseErr != null) {
    return releaseErr;
  }
  this.sandboxes.DiscardRunContainer(ctx, runID);
  return null;
};

module.exports = { ErrWorkspaceControlConfiguration, workspaceOperationLabel, postWorkspaceRequest };
