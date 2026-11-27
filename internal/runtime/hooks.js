// hooks.js —— 对应 Go 文件：internal/runtime/hooks.go
//
// 文件作用与职责边界：
// 负责 Agent 生命周期 Hook 的合并、物化（生成脚本与 Python 观测包装器）、执行环境注入、
// 观测文件监听启停，以及面向不同 CLI（Claude / CodeBuddy / Codex）的 Hook 配置渲染与合并。
//
// Go 与 JS 语法差异说明：
// - Go 的 `(值, error)` 译为成功返回值、失败 `throw`；仅返回 `error` 译为成功返回 `undefined`、失败 `throw`；
// - Go 的 `startHookObservation` 使用 goroutine + channel 等待监听协程退出，在 JS 中用 `AbortController` + `Promise` 表达；
// - Go 的 `strconv.Quote` 译为 `JSON.stringify`；`map[string]any` / `map[string]string` 译为普通对象 `{}`。

"use strict";

const fs = require("node:fs"); // 对应 Go 标准库 os
const path = require("node:path"); // 对应 Go 标准库 path/filepath

const { ExecutionScopeRun, ExecutionScopeRepositories } = require("../domain/observability.js"); // 对应 Go 的 domain.ExecutionScope*
const { WatchHookFile } = require("../observability/hooks.js"); // 对应 Go 的 observability.WatchHookFile，hooks.js 待翻译
const { safeID } = require("./identifier.js"); // 对应 Go 同包函数
const { writeManagedFile, readWorkspaceFile } = require("./managed_files.js"); // 对应 Go 同包函数
const { shellSingleQuote } = require("./sandbox_environment.js"); // 对应 Go 同包函数，sandbox_environment.js 待翻译

/**
 * 编译并物化后的单条 Hook 配置项，供各 CLI 适配器写入配置文件或命令行参数。
 */
class compiledHook {
  /**
   * 创建编译后的 Hook 对象，各字段按 Go 零值初始化。
   *
   * @param {Partial<compiledHook>} [init={}] 可选初始字段值。
   * @returns {compiledHook} 新的 `compiledHook` 实例。
   */
  constructor(init = {}) {
    this.Event = init.Event ?? "";
    this.Matcher = init.Matcher ?? "";
    this.Command = init.Command ?? "";
    this.TimeoutSec = init.TimeoutSec ?? 0;
  }
}

/**
 * 将运行期绑定的仓库上下文列表序列化为 `AGENTFLOW_REPOSITORIES_JSON` 环境变量映射，
 * 供仓库级作用域的 Hook 包装脚本逐仓执行时读取。
 *
 * @param {Array<{ RepositoryID?: string, Name?: string, WorkspaceDir?: string }>} repositories 仓库上下文列表。
 * @returns {Object<string, string>} 包含 `AGENTFLOW_REPOSITORIES_JSON` 键的环境变量对象。
 */
function hookExecutionEnvironment(repositories) {
  const targets = [];
  for (const repository of repositories ?? []) {
    targets.push({
      id: repository.RepositoryID ?? "",
      name: repository.Name ?? "",
      dir: repository.WorkspaceDir ?? "",
    });
  }
  const raw = JSON.stringify(targets);
  return { AGENTFLOW_REPOSITORIES_JSON: raw };
}

/**
 * 所有 provider 共用的 Hook 合并边界：系统 Hook 始终排在角色 Hook 之前执行，
 * 且两类来源之间的非空 Hook ID 必须全局唯一，防止角色配置覆盖平台自带 Hook。
 *
 * @param {Array<{ ID?: string }>} systemHooks 平台/provider 自带的系统 Hook 列表。
 * @param {Array<{ ID?: string }>} roleHooks Agent 角色定义的 Hook 列表。
 * @returns {Array<Object>} 合并后的 Hook 列表；存在重复非空 ID 时抛出 `Error`。
 */
function mergeAgentHookDefinitions(systemHooks, roleHooks) {
  const merged = [];
  const seen = {};
  const appendHooks = (source, hooks) => {
    for (const hook of hooks ?? []) {
      const id = (hook.ID ?? "").trim();
      if (id !== "" && Object.prototype.hasOwnProperty.call(seen, id)) {
        const previous = seen[id];
        throw new Error(`hook id ${JSON.stringify(id)} conflicts between ${previous} and ${source} hooks`);
      }
      if (id !== "") {
        seen[id] = source;
      }
      merged.push(hook);
    }
  };
  appendHooks("system", systemHooks);
  appendHooks("role", roleHooks);
  return merged;
}

/**
 * 启动后台异步监听，持续读取编译配置指定的 Hook NDJSON 观测文件并将事件转发至 `sink`。
 * 返回的停止函数会取消监听并等待监听任务结束（对应 Go 的 goroutine + `<-done`）。
 *
 * @param {AbortSignal | null} ctx 上级上下文取消信号。
 * @param {{ HookFile?: string }} compiled 编译后的运行时配置对象。
 * @param {Object | null} sink 观测事件接收器。
 * @returns {() => Promise<void> | void} 停止并等待观测任务结束的取消函数。
 */
function startHookObservation(ctx, compiled, sink) {
  if (!compiled.HookFile || sink == null) {
    return () => {};
  }
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(ctx.reason);
  if (ctx instanceof AbortSignal) {
    if (ctx.aborted) {
      controller.abort(ctx.reason);
    } else {
      ctx.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  // 对应 Go 的 goroutine + done channel：通过微任务启动观测，停止函数 abort 后返回 Promise 供调用方等待结束。
  const done = Promise.resolve().then(() => WatchHookFile(controller.signal, compiled.HookFile, sink));
  return () => {
    controller.abort();
    if (ctx instanceof AbortSignal) {
      ctx.removeEventListener("abort", onParentAbort);
    }
    return done;
  };
}

/**
 * 将 Agent 的 Hook 定义物化到工作区配置目录的 `hooks/` 子目录下：
 * 为每条 Hook 写出原始脚本文件与对应的 Python 观测包装脚本，并返回编译后的 `compiledHook` 列表。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {string} configRoot 当前 Agent 的配置目录路径（`.agentflow/config/<agentID>`）。
 * @param {string} agentRel Agent 控制目录相对工作区的路径（`.agentflow/<agentID>`）。
 * @param {string} provider 执行器 provider 名称（写入观测记录）。
 * @param {Array<Object>} hooks 待物化的 `domain.AgentHook` 列表。
 * @returns {compiledHook[] | null} 编译后的 Hook 列表；输入为空时返回 `null`，ID 非法或写盘失败时抛出 `Error`。
 */
function materializeAgentHooks(workspace, configRoot, agentRel, provider, hooks) {
  if ((hooks ?? []).length === 0) {
    return null;
  }
  const root = path.join(configRoot, "hooks");
  fs.mkdirSync(root, { mode: 0o700 });
  const compiled = [];
  for (const hook of hooks) {
    let ext = ".sh";
    let interpreter = "sh";
    if (hook.Language === "python") {
      ext = ".py";
      interpreter = "python3";
    }
    const name = safeID(hook.ID);
    if (name === "") {
      throw new Error(`invalid hook id ${JSON.stringify(hook.ID)}`);
    }
    const file = path.join(root, name + ext);
    let body = hook.Script ?? "";
    if (!body.endsWith("\n")) {
      body += "\n";
    }
    writeManagedFile(workspace, file, Buffer.from(body, "utf8"), 0o700);
    const wrapperName = name + "-agentflow.py";
    const wrapper = hookWrapperPython(name + ext, interpreter, provider, hook);
    writeManagedFile(workspace, path.join(root, wrapperName), Buffer.from(wrapper, "utf8"), 0o700);
    const rel = path.join(agentRel, "..", "config", path.basename(configRoot), "hooks", wrapperName).split(path.sep).join("/");
    compiled.push(
      new compiledHook({
        Event: hook.Event,
        Matcher: hook.Matcher,
        Command: "python3 " + shellSingleQuote(rel),
        TimeoutSec: hook.TimeoutSec,
      }),
    );
  }
  return compiled;
}

/**
 * 生成单条 Hook 对应的 Python 包装脚本源码。该包装器负责解析 stdin 负载、记录 start/finish 观测事件到
 * `AGENTFLOW_HOOK_OUTPUT`，并按 `run` 或 `repositories` 作用域调度底层脚本执行。
 *
 * @param {string} scriptName 同目录下真实 Hook 脚本的文件名。
 * @param {string} interpreter 解释器名称（`"sh"` 或 `"python3"`）。
 * @param {string} provider 执行器 provider 名称。
 * @param {Object} hook 原始 `domain.AgentHook` 定义对象。
 * @returns {string} 可直接写入磁盘的完整 Python3 包装脚本内容。
 */
function hookWrapperPython(scriptName, interpreter, provider, hook) {
  return `#!/usr/bin/env python3
import json, os, shutil, subprocess, sys, tempfile, time
raw = sys.stdin.buffer.read()
try:
    payload = json.loads(raw.decode("utf-8")) if raw.strip() else {}
except Exception:
    payload = {"raw": raw[:4000].decode("utf-8", errors="replace")}
if not isinstance(payload, dict):
    payload = {"payload": payload}
payload["_agentflow_hook_id"] = ${JSON.stringify(hook.ID ?? "")}
payload["_agentflow_hook_name"] = ${JSON.stringify(hook.Name ?? "")}
payload["_agentflow_provider"] = ${JSON.stringify(provider ?? "")}
payload["_agentflow_matcher"] = ${JSON.stringify(hook.Matcher ?? "")}
payload["_agentflow_language"] = ${JSON.stringify(hook.Language ?? "")}
output = os.environ.get("AGENTFLOW_HOOK_OUTPUT", "")
def emit(phase, duration_ms=None, exit_code=None, stdout="", stderr="", target=None):
    if not output:
        return
    record = dict(payload)
    record["_agentflow_execution_phase"] = phase
    record["_ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    if duration_ms is not None:
        record["_agentflow_duration_ms"] = duration_ms
    if exit_code is not None:
        record["_agentflow_exit_code"] = exit_code
    if stdout:
        record["_agentflow_stdout"] = stdout
    if stderr:
        record["_agentflow_stderr"] = stderr
    if target:
        record["_agentflow_repository_id"] = str(target.get("id", ""))
        record["_agentflow_repository_name"] = str(target.get("name", ""))
        record["_agentflow_repository_dir"] = str(target.get("dir", ""))
    parent = os.path.dirname(output)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(output, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False) + "\\n")
def preview(stream, limit=2000):
    stream.flush()
    stream.seek(0)
    return stream.read(limit).decode("utf-8", errors="replace").strip()
script = os.path.join(os.path.dirname(os.path.abspath(__file__)), ${JSON.stringify(scriptName)})
scope = ${JSON.stringify(normalizeHookExecutionScope(hook.ExecutionScope))}
workspace = os.getcwd()
targets = [{}]
if scope == "repositories":
    try:
        targets = json.loads(os.environ.get("AGENTFLOW_REPOSITORIES_JSON", "[]"))
    except Exception:
        targets = []
    if not targets:
        message = "repository-scoped hook requires at least one bound repository"
        emit("finish", 0, 2, "", message)
        print(message, file=sys.stderr)
        raise SystemExit(2)
result = None
for target in targets:
    emit("start", target=target)
    started = time.monotonic()
    with tempfile.TemporaryFile() as stdout_buffer, tempfile.TemporaryFile() as stderr_buffer:
        env = os.environ.copy()
        env["AGENTFLOW_WORKSPACE"] = workspace
        env["AGENTFLOW_EXECUTION_SCOPE"] = scope
        af_bin = env.get("AGENTFLOW_BIN") or ""
        if af_bin and os.path.isfile(af_bin) and os.access(af_bin, os.X_OK):
            env["PATH"] = os.path.dirname(os.path.abspath(af_bin)) + os.pathsep + env.get("PATH", "")
        cwd = workspace
        if scope == "repositories":
            directory = str(target.get("dir", ""))
            env["AGENTFLOW_REPOSITORY_ID"] = str(target.get("id", ""))
            env["AGENTFLOW_REPOSITORY_NAME"] = str(target.get("name", ""))
            env["AGENTFLOW_REPOSITORY_DIR"] = directory
            if directory:
                cwd = os.path.join(workspace, directory)
        try:
            result = subprocess.run([${JSON.stringify(interpreter)}, script], input=raw, stdout=stdout_buffer, stderr=stderr_buffer, cwd=cwd, env=env)
        except Exception as error:
            duration_ms = int((time.monotonic() - started) * 1000)
            emit("finish", duration_ms, 127, "", str(error), target)
            print(str(error), file=sys.stderr)
            raise
        duration_ms = int((time.monotonic() - started) * 1000)
        stdout_preview = preview(stdout_buffer)
        stderr_preview = preview(stderr_buffer)
        emit("finish", duration_ms, result.returncode, stdout_preview, stderr_preview, target)
        if scope == "run":
            stdout_buffer.seek(0)
            stderr_buffer.seek(0)
            shutil.copyfileobj(stdout_buffer, sys.stdout.buffer)
            shutil.copyfileobj(stderr_buffer, sys.stderr.buffer)
        elif result.returncode != 0:
            stderr_buffer.seek(0)
            shutil.copyfileobj(stderr_buffer, sys.stderr.buffer)
    if result.returncode != 0:
        break
raise SystemExit(result.returncode)
`;
}

/**
 * 规范化 Hook 的执行作用域，仅在忽略大小写匹配 `repositories` 时返回仓库级作用域，其余统一回落为 `run`。
 *
 * @param {string} scope 原始执行作用域字符串。
 * @returns {string} 规范化后的执行作用域常量（`"repositories"` 或 `"run"`）。
 */
function normalizeHookExecutionScope(scope) {
  if ((scope ?? "").trim().toLowerCase() === ExecutionScopeRepositories.toLowerCase()) {
    return ExecutionScopeRepositories;
  }
  return ExecutionScopeRun;
}

/**
 * 将编译后的 Hook 列表组装为 Claude / CodeBuddy 通用的 JSON settings 对象结构（按事件名分组）。
 *
 * @param {compiledHook[]} hooks 编译后的 Hook 列表。
 * @returns {{ hooks: Object<string, Array<Object>> }} 可直接序列化为 settings JSON 的对象。
 */
function hookSettings(hooks) {
  const events = {};
  for (const hook of hooks ?? []) {
    const group = {
      hooks: [{ type: "command", command: hook.Command, timeout: hook.TimeoutSec }],
    };
    if (hook.Matcher !== "") {
      group.matcher = hook.Matcher;
    }
    if (!Object.prototype.hasOwnProperty.call(events, hook.Event)) {
      events[hook.Event] = [];
    }
    events[hook.Event].push(group);
  }
  return { hooks: events };
}

/**
 * 将编译后的 Hook 配置格式化为缩进 JSON 并安全写入工作区目标文件（权限 0600）。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {string} filePath 目标 settings 文件路径。
 * @param {compiledHook[]} hooks 编译后的 Hook 列表。
 * @returns {void} 无返回值；序列化或写盘失败时抛出 `Error`。
 */
function writeHookSettings(workspace, filePath, hooks) {
  const raw = Buffer.from(JSON.stringify(hookSettings(hooks), null, 2), "utf8");
  writeManagedFile(workspace, filePath, raw, 0o600);
}

/**
 * 读取已有的 settings JSON 文件，将编译后的 Hook 分组追加合并到其 `hooks` 字段中并安全写回（权限 0600）。
 *
 * @param {string} workspace 工作区根目录路径。
 * @param {string} filePath 已有 settings 文件路径。
 * @param {compiledHook[]} hooks 待追加的编译后 Hook 列表。
 * @returns {void} 无返回值；列表为空时直接返回，读写或解析失败时抛出 `Error`。
 */
function mergeHookSettings(workspace, filePath, hooks) {
  if ((hooks ?? []).length === 0) {
    return;
  }
  const raw = readWorkspaceFile(workspace, filePath);
  const settings = JSON.parse(raw.toString("utf8"));
  let events = settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) ? settings.hooks : null;
  if (events == null) {
    events = {};
    settings.hooks = events;
  }
  const userEvents = hookSettings(hooks).hooks;
  for (const [event, groups] of Object.entries(userEvents)) {
    const existing = Array.isArray(events[event]) ? events[event] : [];
    events[event] = existing.concat(groups);
  }
  const merged = Buffer.from(JSON.stringify(settings, null, 2), "utf8");
  writeManagedFile(workspace, filePath, merged, 0o600);
}

/**
 * 将编译后的 Hook 列表按事件首次出现顺序分组，编码为 Codex CLI 的 `-c hooks.<event>=[...]` 命令行参数数组。
 *
 * @param {compiledHook[]} hooks 编译后的 Hook 列表。
 * @returns {string[] | null} Codex CLI `-c` 参数对数组；输入为空时返回 `null`。
 */
function codexHookConfigArgs(hooks) {
  if ((hooks ?? []).length === 0) {
    return null;
  }
  const grouped = {};
  const order = [];
  for (const hook of hooks) {
    if (!Object.prototype.hasOwnProperty.call(grouped, hook.Event)) {
      order.push(hook.Event);
      grouped[hook.Event] = [];
    }
    grouped[hook.Event].push(hook);
  }
  const args = [];
  for (const event of order) {
    const groups = [];
    for (const hook of grouped[event]) {
      let group =
        '{hooks=[{type="command",command=' + JSON.stringify(hook.Command) + ",timeout=" + String(hook.TimeoutSec) + "}]";
      if (hook.Matcher !== "") {
        group += ",matcher=" + JSON.stringify(hook.Matcher);
      }
      groups.push(group + "}");
    }
    args.push("-c", "hooks." + event + "=[" + groups.join(",") + "]");
  }
  return args;
}

module.exports = {
  compiledHook,
  hookExecutionEnvironment,
  mergeAgentHookDefinitions,
  startHookObservation,
  materializeAgentHooks,
  hookWrapperPython,
  normalizeHookExecutionScope,
  hookSettings,
  writeHookSettings,
  mergeHookSettings,
  codexHookConfigArgs,
};
