/**
 * @file internal/engine/workspace_checkpoint_transport.js
 * 对应 Go 源文件：internal/engine/workspace_checkpoint_transport.go
 *
 * 作用与职责边界：
 * 实现工作区快照与交互式控制通道的客户端转发（`requestWorkspaceCheckpoint`、`postWorkspaceRequest`）
 * 以及服务端 HTTP 入口（`HandleWorkspaceCheckpoint`）与空工作区容器清理（`discardEmptyWorkspaceContainer`）；
 * `Engine` 相关方法挂载于 `Engine.prototype`（`Engine` 定义于 `engine.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 与仅 `error` 返回统一按成功返回值（或 `undefined`）、失败 `throw err` 处理。
 * - Go 的 `context.Context` 译为 `AbortSignal`；`sync.Mutex`（含 `e.mu` 与 `env.nodeMu`）在单线程 JS 中省略。
 * - Go 的 `net/http` 客户端请求译为 `fetch`，服务端 `http.ResponseWriter` 错误响应译为 `writeHead`/`end`。
 * - Go 的 `r.Context()` 在 Node HTTP 回调中无等价请求上下文，以 `null` 占位。
 */

"use strict";

const fs = require("node:fs");

const { RunnerWorkspaceRequest, RunnerWorkspaceResponse, IsWorkspaceCheckpointTransferOperation, RunnerWorkspaceOperationCheckpointStatus, RunnerWorkspaceOperationCheckpointExport, RunnerWorkspaceOperationCheckpointRead, RunnerWorkspaceOperationCheckpointClose, RunnerWorkspaceOperationCheckpointUpload, RunnerWorkspaceOperationCheckpointAppend, RunnerWorkspaceOperationCheckpointCommit, RunnerWorkspaceOperationCheckpoint, RunnerWorkspaceOperationRestore, RunnerWorkspaceOperationPrepare, RunnerWorkspaceOperationPreparationStatus, RunnerWorkspaceOperationPreparationRecord, RunnerWorkspaceOperationTerminal, RunnerWorkspaceOperationReclaim, RunnerWorkspaceOperationArtifacts, RunnerWorkspaceOperationBrowser, WorkspaceErrorBusy } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.RunnerWorkspaceRequest/RunnerWorkspaceResponse/IsWorkspaceCheckpointTransferOperation/RunnerWorkspaceOperation*/WorkspaceErrorBusy，runner_workspace.js 已翻译
const { WorkspaceCheckpointStatus } = require("../runtime/workspace_checkpoint_transfer.js"); // 对应 Go 的 runtime.WorkspaceCheckpointStatus，runtime 待翻译
const { RestoreMissingWorkspaceArtifacts } = require("../runtime/workspace_artifacts.js"); // 对应 Go 的 runtime.RestoreMissingWorkspaceArtifacts，runtime 待翻译
const { CreateWorkspaceCheckpointContext, RestoreWorkspaceCheckpoint, WorkspaceDirHasContent } = require("../runtime/workspace_checkpoint.js"); // 对应 Go 的 runtime.CreateWorkspaceCheckpointContext/RestoreWorkspaceCheckpoint/WorkspaceDirHasContent，runtime 待翻译
const { RecordWorkspacePreparation } = require("../runtime/workspace_preparation.js"); // 对应 Go 的 runtime.RecordWorkspacePreparation，runtime 待翻译
const { TerminalGitCredentials } = require("../runtime/workspace_terminal.js"); // 对应 Go 的 runtime.TerminalGitCredentials，runtime 待翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { controlTokenHeader } = require("./run_control.js"); // 对应 Go 同包常量，run_control.js 已翻译
const { workspaceCheckpointTransferFromWire } = require("./workspace_checkpoint_stream.js"); // 对应 Go 同包函数，workspace_checkpoint_stream.js 已翻译
const { sharesWorkspace } = require("./workspace_owner.js"); // 对应 Go 同包函数，workspace_owner.js 已翻译

// 缺少或配置不一致的服务控制令牌属于配置错误，重试节点无法修复且不应触发上游返工。
const ErrWorkspaceControlConfiguration = new Error("工作区控制通道配置错误");

/**
 * 将工作区控制操作常量转换为用于错误提示的中文可读标签。
 * 使用场景：拼装控制通道配置错误或 HTTP 状态码失败提示文案。
 *
 * @param {string} operation - 工作区操作常量（`domain.RunnerWorkspaceOperation*`）。
 * @returns {string} 对应的中文操作描述文本。
 */
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

/**
 * 将工作区控制请求路由到执行机直连传输钩子、内部 API 控制通道或工作区所属远端 Worker 控制地址。
 * 使用场景：跨实例或执行机侧的快照探测、保存、恢复、环境准备、终端及浏览器请求转发。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号（对应 Go 的 `context.Context`）。
 * @param {object} run - 目标运行快照（`domain.Run`）。
 * @param {RunnerWorkspaceRequest} request - 待发送的工作区控制请求对象。
 * @returns {Promise<RunnerWorkspaceResponse>} 远端或传输钩子返回的控制响应。
 * @throws {Error} 缺少控制令牌、缺少目标控制地址或网络/认证请求失败时抛出错误。
 */
Engine.prototype.requestWorkspaceCheckpoint = async function (ctx, run, request) {
  // Go 的 sync.Mutex 在单线程 JS 中省略，直接读取配置字段。
  const apiBase = this.workspaceControlBase;
  const token = this.controlToken;
  let base = "";
  if (this.defaultExecutionRunner(run) !== "") {
    if (this.WorkspaceCheckpointTransport != null) {
      return await this.WorkspaceCheckpointTransport(ctx, run, request);
    }
    base = apiBase;
  } else if (this.foreignWorkspaceBind(run)) {
    base = this.repo.WorkspaceHostControlURL(run.WorkspaceHost);
  }
  const operation = workspaceOperationLabel(request.Operation);
  if (token === "") {
    const err = new Error(`${ErrWorkspaceControlConfiguration.message}：无法${operation}；请为 API 和 Worker 配置相同的 AGENTFLOW_CONTROL_TOKEN`);
    err.cause = ErrWorkspaceControlConfiguration;
    throw err;
  }
  if (base === "") {
    let hint = "工作区所属 Worker 未公布有效的 AGENTFLOW_CONTROL_URL";
    if (this.defaultExecutionRunner(run) !== "") {
      hint = "Worker 未配置内部 API 地址 AGENTFLOW_API_URL";
    }
    const err = new Error(`${ErrWorkspaceControlConfiguration.message}：无法${operation}；${hint}`);
    err.cause = ErrWorkspaceControlConfiguration;
    throw err;
  }
  return postWorkspaceRequest(ctx, base, token, request);
};

/**
 * 向指定控制服务的 `/internal/workspace-checkpoint` 端点发送带控制令牌的 JSON POST 请求并解析响应。
 * 使用场景：由 `requestWorkspaceCheckpoint` 在需要走 HTTP 控制通道时调用。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {string} base - 目标控制服务的基础 URL。
 * @param {string} token - 服务间认证使用的控制令牌。
 * @param {RunnerWorkspaceRequest} request - 请求体对象。
 * @returns {Promise<RunnerWorkspaceResponse>} 解析后的控制响应对象；旧服务对探针返回 400 时兼容返回 `Status: 400` 的响应对象。
 * @throws {Error} 序列化失败、网络错误、认证失败（401/403）、非 200 状态码或响应 JSON 解析失败时抛出错误。
 */
async function postWorkspaceRequest(ctx, base, token, request) {
  const operation = workspaceOperationLabel(request.Operation);
  const body = Buffer.from(JSON.stringify(request), "utf8");
  // Go 的 bytes.NewReader(body) 译为直接传递 Buffer。
  const response = await fetch(base.replace(/\/+$/, "") + "/internal/workspace-checkpoint", {
    method: "POST",
    headers: { [controlTokenHeader]: token, "Content-Type": "application/json" },
    body,
    signal: ctx instanceof AbortSignal ? ctx : undefined,
  });
  if (response.status !== 200) {
    if (response.status === 400 && request.Operation === RunnerWorkspaceOperationCheckpointStatus) {
      return new RunnerWorkspaceResponse({ Status: 400, Error: "unsupported workspace operation" });
    }
    if (response.status === 401 || response.status === 403) {
      const err = new Error(`${ErrWorkspaceControlConfiguration.message}：${operation}认证失败（HTTP ${response.status}）；请核对 API/Worker 的 AGENTFLOW_CONTROL_TOKEN 和内部 API 地址`);
      err.cause = ErrWorkspaceControlConfiguration;
      throw err;
    }
    throw new Error(`${operation}失败：工作区控制服务返回 HTTP ${response.status}`);
  }
  const raw = JSON.parse(await response.text());
  return new RunnerWorkspaceResponse({ Payload: raw.payload != null ? Buffer.from(JSON.stringify(raw.payload), "utf8") : null, Error: raw.error ?? "", Code: raw.code ?? "", Status: raw.status ?? 0 });
}

/**
 * 内部服务专用的有界工作区控制通道 HTTP 处理函数：校验控制令牌后按操作类型转发给执行机或在本机执行
 * 浏览器代理、环境准备、终端交互、快照探针/分块传输、工作区回收、产物恢复及整包快照读写。
 * 使用场景：挂载于内部控制端口的 `/internal/workspace-checkpoint` 路由。
 *
 * @param {object} w - HTTP 响应写入器（`http.ServerResponse`）。
 * @param {object} r - HTTP 请求对象（`http.IncomingMessage`）。
 * @returns {Promise<void>} 无返回值，结果直接写入 `w`。
 */
Engine.prototype.HandleWorkspaceCheckpoint = async function (w, r) {
  // Go 的 r.Context()：JS 无请求上下文对象，用 null 表示。
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
  // 将执行标志绑定到持久化状态，包括转发给执行机的请求。
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
        // Go 的 env.nodeMu.Lock()/Unlock() 在单线程 JS 中省略。
        try {
          const state = RecordWorkspacePreparation(ctx, env.sandbox, request.Workflow, request.Repositories, request.PreparationNodeID, request.PreparationOutput);
          result.Payload = Buffer.from(JSON.stringify(state), "utf8");
        } catch (recordErr) {
          result.Error = recordErr.message;
          result.Status = 409;
        }
        break;
      }
      case RunnerWorkspaceOperationPrepare: {
        try {
          const state = await this.EnsureWorkspaceReady(ctx, run.ID);
          result.Payload = Buffer.from(JSON.stringify(state), "utf8");
        } catch (prepareErr) {
          result.Error = prepareErr.message;
          result.Status = 409;
        }
        break;
      }
      case RunnerWorkspaceOperationPreparationStatus: {
        try {
          const state = await this.WorkspacePreparationStatus(ctx, run.ID);
          result.Payload = Buffer.from(JSON.stringify(state), "utf8");
        } catch (statusErr) {
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
        try {
          const value = await this.HandlePreparedWorkspaceTerminal(ctx, run, this.workspaceTerminals, scope, request.Terminal, credentials);
          result.Payload = Buffer.from(JSON.stringify(value), "utf8");
        } catch (terminalErr) {
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
        try {
          this.discardEmptyWorkspaceContainer(ctx, run.ID, root);
        } catch (discardErr) {
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
      try {
        this.releaseRunEnvironment(run.ID, true);
        result.Payload = Buffer.from('{"reclaimed":true}', "utf8");
      } catch (releaseErr) {
        result.Error = releaseErr.message;
      }
    } else if (request.Operation === RunnerWorkspaceOperationArtifacts) {
      try {
        const restored = RestoreMissingWorkspaceArtifacts(root, request.ArtifactFiles);
        result.Payload = Buffer.from(JSON.stringify({ restoredArtifacts: restored }), "utf8");
      } catch (restoreErr) {
        result.Error = restoreErr.message;
      }
    } else if (request.Operation === RunnerWorkspaceOperationCheckpoint) {
      try {
        const archive = CreateWorkspaceCheckpointContext(ctx, root);
        result.Payload = Buffer.from(JSON.stringify({ checkpoint: archive.toString("base64") }), "utf8");
      } catch (checkpointErr) {
        result.Error = checkpointErr.message;
      }
    } else {
      try {
        this.discardEmptyWorkspaceContainer(ctx, run.ID, root);
        RestoreWorkspaceCheckpoint(root, request.Checkpoint);
        result.Payload = Buffer.from('{"restored":true}', "utf8");
      } catch (err) {
        result.Error = err.message;
      }
    }
  }
  w.setHeader("Content-Type", "application/json");
  w.end(JSON.stringify(result) + "\n");
};

/**
 * 若本地工作区目录存在且为空目录，释放其内存运行环境并丢弃对应沙箱容器，以便后续快照恢复原子替换目录内容。
 * 使用场景：本地执行分块快照提交或整包快照恢复前调用。
 *
 * @param {AbortSignal|null} ctx - 取消控制信号。
 * @param {string} runID - 运行记录主键 ID。
 * @param {string} root - 本地工作区根目录路径。
 * @returns {void} 无返回值。
 * @throws {Error} 释放运行环境失败时抛出错误。
 */
Engine.prototype.discardEmptyWorkspaceContainer = function (ctx, runID, root) {
  let info;
  try {
    info = fs.lstatSync(root);
  } catch {
    return;
  }
  if (!info.isDirectory()) {
    return;
  }
  let hasContent;
  try {
    hasContent = WorkspaceDirHasContent(root);
  } catch {
    return;
  }
  if (hasContent) {
    return;
  }
  this.releaseRunEnvironment(runID, false);
  this.sandboxes.DiscardRunContainer(ctx, runID);
};

module.exports = { ErrWorkspaceControlConfiguration, workspaceOperationLabel, postWorkspaceRequest };
