/**
 * @file internal/runtime/conversation_zcode.js
 * @description 对应 Go 源文件：internal/runtime/conversation_zcode.go
 *
 * 职责与边界：
 * 负责在恢复 ZCode 原生会话前包装命令行参数并生成前置 Python 脚本，
 * 通过 ZCode 官方 `app-server --stdio` 协议将所选模型应用到目标会话，再 `exec` 交回原始命令继续执行。
 * 不负责 ZCode 凭据配置渲染或会话日志解析。
 *
 * 语法差异说明：
 * - Go 的 `encoding/json` 译为 `JSON`；`path/filepath` 译为 `path`。
 * - Go 的 `var denied []string` 未赋值时为 `nil`，JSON 序列化后为 `"null"`，JS 中以 `null` 初值严格保持一致。
 * - Go 的反引号原生字符串译为模板字符串，其中的 `\n` 转义为 `\\n` 以保持 Python 脚本原文不变。
 */

"use strict";

const path = require("node:path"); // Go path/filepath

const { zcodeHostEnv } = require("./agent_cli_zcode.js"); // 对应 Go 同包变量，agent_cli_zcode.js 已翻译

/**
 * 当 ZCode 命令包含 `--resume <session>` 时，在已绑定命令前包装前置模型设置脚本调用。
 * 在对话进程启动准备阶段（`conversation_process.js`）完成凭据绑定后调用。
 *
 * @param {string} root 会话根目录的绝对路径。
 * @param {string[]} native 绑定前的原始命令行参数数组（用于提取 CLI 路径、会话 ID 与禁用工具列表）。
 * @param {string[]} bound 经凭据与沙箱绑定后的命令行参数数组。
 * @returns {string[]} 最终要执行的命令行参数数组；非恢复会话时原样返回 `bound`。
 */
function conversationZCodeResumeArgv(root, native, bound) {
  let session = "";
  let denied = null; // Go：var denied []string，未赋值时是 nil，Marshal 后为 null
  for (let i = 1; i + 1 < native.length; i++) {
    switch (native[i]) {
      case "--resume":
        session = native[i + 1];
        break;
      case "--disallowed-tools":
        denied = native[i + 1].split(/\s+/).filter((part) => part !== "");
        break;
      default:
        break;
    }
  }
  if (session === "") {
    return bound;
  }
  const denyJSON = JSON.stringify(denied);
  return ["python3", path.join(root, "zcode-resume-model.py"), native[0], session, denyJSON, ...bound];
}

/**
 * 渲染写入会话根目录的 `zcode-resume-model.py` 脚本字节内容，注入需剔除的宿主机环境变量清单。
 * 在安装会话审批与辅助脚本（`conversation_approval.js`）时调用。
 *
 * @returns {Buffer} 渲染完成的 Python 脚本 UTF-8 字节内容。
 */
function conversationZCodeResumeScript() {
  const hostEnv = JSON.stringify(zcodeHostEnv);
  return Buffer.from(conversationZCodeResumePython.replaceAll("__HOST_ENV__", hostEnv), "utf8");
}

// conversationZCodeResumePython：Go 的反引号原生字符串译为模板字符串，其中的 \n 须写成 \\n 才保持原样。
const conversationZCodeResumePython = `import json,os,selectors,subprocess,sys,tempfile,time

def select_model():
    binary,session,denied=sys.argv[1:4]
    source=os.environ["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"]
    with open(source,"rb") as f: config=f.read()
    desired=json.loads(config)["config"]["defaultModelSelection"]
    child_env=dict(os.environ)
    for name in __HOST_ENV__: child_env.pop(name,None)
    # SessionStart removes its credential input. Give this preparatory process
    # its own copy so the actual prompt still receives its per-call file.
    fd,temporary=tempfile.mkstemp(prefix="provider_config.preflight-",suffix=".json",dir=os.path.dirname(source))
    proc=None
    try:
        with os.fdopen(fd,"wb") as f: f.write(config)
        child_env["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"]=temporary
        proc=subprocess.Popen([binary,"app-server","--stdio"],stdin=subprocess.PIPE,stdout=subprocess.PIPE,env=child_env)
        deadline=time.monotonic()+45
        buffered=b""
        selector=selectors.DefaultSelector()
        selector.register(proc.stdout,selectors.EVENT_READ)
        def request(ident,method,params):
            nonlocal buffered
            proc.stdin.write((json.dumps({"id":ident,"method":method,"params":params})+"\\n").encode())
            proc.stdin.flush()
            while True:
                while b"\\n" not in buffered:
                    remaining=deadline-time.monotonic()
                    if remaining<=0 or not selector.select(remaining): raise RuntimeError("protocol timeout")
                    chunk=os.read(proc.stdout.fileno(),65536)
                    if not chunk: raise RuntimeError("protocol closed")
                    buffered+=chunk
                    if len(buffered)>16*1024*1024: raise RuntimeError("protocol frame too large")
                line,buffered=buffered.split(b"\\n",1)
                if not line.strip(): continue
                frame=json.loads(line)
                # This operation never approves interactive requests or runs
                # a prompt. Only resume and model configuration are permitted.
                if "method" in frame:
                    if "id" in frame:
                        proc.stdin.write((json.dumps({"id":frame["id"],"error":{"code":-32601,"message":"Unsupported preparatory request"}})+"\\n").encode())
                        proc.stdin.flush()
                    continue
                if frame.get("id")!=ident: continue
                if "error" in frame or "result" not in frame: raise RuntimeError("protocol rejected model configuration")
                return frame["result"]
        try:
            cwd=os.getcwd()
            snapshot=request(1,"session/resume",{"sessionId":session,"workspace":{"workspacePath":cwd,"workspaceKey":cwd},"toolDenylist":json.loads(denied) or []})
            model=next((m for m in snapshot["settings"]["model"]["available"] if m.get("ref",{}).get("providerId")==desired["providerId"] and m.get("ref",{}).get("modelId")==desired["modelId"]),None)
            if not model or model.get("disabledReason"): raise RuntimeError("selected model unavailable")
            reasoning=model.get("reasoning",{})
            level=reasoning.get("defaultLevel")
            current=snapshot["settings"]["model"].get("current") or {}
            if current.get("providerId")==desired["providerId"] and current.get("modelId")==desired["modelId"]:
                previous=current.get("options",{}).get("reasoningLevel")
                if any(item.get("value")==previous for item in reasoning.get("levels",[])): level=previous
            if not level: raise RuntimeError("model reasoning selection unavailable")
            selection={**desired,"options":{"reasoningLevel":level}}
            result=request(2,"session/setModel",{"sessionId":session,"model":selection,"persistAsWorkspaceLastUsed":False})
            if result["settings"]["model"].get("current")!=selection: raise RuntimeError("model configuration not applied")
        finally:
            selector.close()
            proc.stdin.close()
        # EOF releases resident state without deleting the native session.
        if proc.wait(timeout=4)!=0: raise RuntimeError("protocol shutdown failed")
    finally:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try: proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        try: os.unlink(temporary)
        except FileNotFoundError: pass

try:
    select_model()
except Exception:
    print("ZCode 原生会话模型设置失败；历史已保留，请检查官方 CLI 及模型配置",file=sys.stderr)
    sys.exit(1)
os.execvpe(sys.argv[4],sys.argv[4:],os.environ)
`;

module.exports = { conversationZCodeResumeArgv, conversationZCodeResumeScript, conversationZCodeResumePython };
