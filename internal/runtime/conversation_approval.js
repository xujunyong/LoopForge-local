// conversation_approval.js —— 对应 Go 文件：internal/runtime/conversation_approval.go
// 作用：为各 Agent CLI 安装原生工具审批钩子，拦截工具调用并向网关请求批准。
// (值, error) 译为返回值、失败 throw；Go 原始字符串译为模板字面量。

"use strict";

const fs = require("node:fs"); // Go os
const path = require("node:path"); // Go path/filepath

const { AgentCLIHome, openAgentCLIHome, writeAgentCLIFile, AgentCLIZCode, AgentCLIKimi, AgentCLIPi, AgentCLIOpenCode, AgentCLICursor, AgentCLIAntigravity, AgentCLIDeepSeek } = require("./agent_cli.js"); // 对应 Go 同包类型、函数与常量，agent_cli.js 已翻译
const { zcodeConfigPath } = require("./agent_cli_zcode.js"); // 对应 Go 同包常量，agent_cli_zcode.js 已翻译
const { conversationZCodeResumeScript } = require("./conversation_zcode.js"); // 对应 Go 同包函数，conversation_zcode.js 待翻译
const { shellSingleQuote } = require("./sandbox_environment.js"); // 对应 Go 同包函数，sandbox_environment.js 待翻译

// 命令钩子需要数值看门狗：部分 CLI 在钩子触发时放行工具，取 Node 有符号
// 32 位毫秒定时器安全的最大整秒值，让钩子先自行结束。
const conversationApprovalHookWatchdog = 2147483;

// 网关持续不可达这么久后钩子拒绝，硬上限覆盖等待用户批准外部写入的情形。
// 两者都必须低于各 CLI 的钩子超时；Kimi 的超时上限是 600 秒，之后放行工具。
const conversationApprovalRetrySeconds = "120";
const conversationApprovalLimitSeconds = "570";

// InstallConversationApproval：只安装供应商自有的钩子。生成的脚本不含凭据；
// 其私有网关能力由进程环境提供，经运行器的控制链路转发。
function InstallConversationApproval(root, provider, command) {
  const hook = path.join(root, "native-approval.py");
  fs.writeFileSync(hook, conversationApprovalPython, { mode: 0o600 });
  const launch = "python3 " + shellSingleQuote(hook);
  const hooks = { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: launch, timeout: conversationApprovalHookWatchdog, onFailure: "block" }] }] };
  const home = new AgentCLIHome({ Base: root, Rel: "home" });
  switch (provider) {
    case "codebuddy":
    case "claude-code": {
      const settings = { hooks };
      const data = Buffer.from(JSON.stringify(settings), "utf8");
      const settingsPath = path.join(root, "native-settings.json");
      fs.writeFileSync(settingsPath, data, { mode: 0o600 });
      command.Argv = conversationReplaceFlag(command.Argv, "--settings", settingsPath);
      break;
    }
    case AgentCLIZCode: {
      fs.writeFileSync(path.join(root, "zcode-resume-model.py"), conversationZCodeResumeScript(), { mode: 0o600 });
      // ZCode 从该配置加载用户钩子；保留 MCP 与删除短期凭据文件的 SessionStart 钩子。
      const root = openAgentCLIHome(home);
      let data = null;
      let readErr = null;
      try {
        data = root.ReadFile(zcodeConfigPath);
      } catch (err) {
        readErr = err;
      }
      root.Close();
      let document = {};
      if (readErr !== null && readErr.code !== "ENOENT") {
        throw readErr;
      }
      if (readErr === null) {
        document = JSON.parse(data.toString("utf8"));
      }
      let configured = document.hooks;
      if (configured == null || typeof configured !== "object" || Array.isArray(configured)) {
        configured = {};
      }
      let events = configured.events;
      if (events == null || typeof events !== "object" || Array.isArray(events)) {
        events = {};
      }
      events.PreToolUse = [{ matcher: ".*", hooks: [{ type: "command", command: launch, timeout: conversationApprovalHookWatchdog, onError: "deny" }] }];
      configured.enabled = true;
      configured.events = events;
      document.hooks = configured;
      data = Buffer.from(JSON.stringify(document), "utf8");
      writeAgentCLIFile(home, zcodeConfigPath, data);
      break;
    }
    case "codex": {
      // Go strconv.Quote 对普通字符串与 JSON.stringify 结果相同。
      const entry = "hooks.PreToolUse=[{hooks=[{type=\"command\",command=" + JSON.stringify(launch) + ",timeout=" + String(conversationApprovalHookWatchdog) + "}]}]";
      command.Argv = [...command.Argv.slice(0, command.Argv.length - 1), "-c", "features.hooks=true", "-c", entry, command.Argv[command.Argv.length - 1]];
      break;
    }
    case AgentCLIKimi:
      // Kimi 只在退出码为 2 时拦截，其余退出码一律放行，包括解释器缺失或崩溃。
      command.AgentCLI.ApprovalCommand = launch + " || exit 2";
      break;
    case AgentCLIPi:
      writeAgentCLIFile(home, ".pi/agent/extensions/loopforge-approval.ts", Buffer.from(conversationPiApproval, "utf8"));
      break;
    case AgentCLIOpenCode:
      writeAgentCLIFile(home, ".config/opencode/plugins/loopforge-approval.js", Buffer.from(conversationOpenCodeApproval, "utf8"));
      break;
    case AgentCLICursor:
      // Cursor 的 preToolUse 钩子同时覆盖原生读、编辑与 shell。
      writeAgentCLIFile(home, ".cursor/hooks.json", Buffer.from(JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: launch + " cursor", timeout: conversationApprovalHookWatchdog, failClosed: true }] } }), "utf8"));
      break;
    case AgentCLIAntigravity: {
      const agyHooks = { "loopforge-approval": { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: launch + " agy", timeout: conversationApprovalHookWatchdog }] }] } };
      writeAgentCLIFile(home, ".gemini/config/hooks.json", Buffer.from(JSON.stringify(agyHooks), "utf8"));
      break;
    }
    case AgentCLIDeepSeek: {
      const dshPath = path.join(root, "dsh-approval.mjs");
      fs.writeFileSync(dshPath, conversationDSHApproval, { mode: 0o600 });
      const patch = Buffer.from(JSON.stringify([{ insert: [{ id: "loopforge-native-approval", name: dshPath }] }]), "utf8");
      const patchFile = path.join(root, "dsh-approval.json");
      fs.writeFileSync(patchFile, patch, { mode: 0o600 });
      command.Argv = [...command.Argv.slice(0, 3), "--patch", patchFile, ...command.Argv.slice(3)];
      break;
    }
    default:
      throw new Error(`CLI ${provider} 缺少原生审批适配`);
  }
  return command;
}

function conversationReplaceFlag(argv, name, value) {
  for (let i = 1; i < argv.length - 1; i++) {
    if (argv[i] === name) {
      argv[i + 1] = value;
      return argv;
    }
  }
  return [argv[0], name, value, ...argv.slice(1)];
}

const conversationApprovalPython = `import json,os,sys,time,uuid,urllib.request,urllib.error
allowed=False
reason="原生工具审批服务不可用，操作未执行"
limit=time.monotonic()+${conversationApprovalLimitSeconds}
deadline=min(limit,time.monotonic()+${conversationApprovalRetrySeconds})
def wait():
    time.sleep(max(0,min(1,deadline-time.monotonic())))
try:
    event=json.load(sys.stdin)
    name=event.get("tool_name") or event.get("toolName") or event.get("tool",{}).get("name") or event.get("toolCall",{}).get("name") or event.get("hook_event_name","")
    arguments=event.get("tool_input",event.get("toolInput",event.get("input",event.get("arguments",event.get("toolCall",{}).get("args",{})))))
    payload={"jsonrpc":"2.0","id":1,"method":"agentflow/nativeApproval","params":{"id":uuid.uuid4().hex,"name":name,"input":arguments}}
    url=os.environ["AGENTFLOW_NATIVE_APPROVAL_URL"]
    while True:
        remaining=deadline-time.monotonic()
        if remaining<=0:
            reason="平台网关长时间不可用，操作未执行"
            break
        try:
            request=urllib.request.Request(url,json.dumps(payload).encode(),{"Content-Type":"application/json"})
            with urllib.request.urlopen(request,timeout=min(20,remaining)) as response: rpc=json.load(response)
        except urllib.error.HTTPError as error:
            if error.code not in (408,429,502,503,504): break
            wait()
            continue
        except (urllib.error.URLError,TimeoutError,OSError):
            wait()
            continue
        result=rpc.get("result",{})
        if rpc.get("error"):
            reason="本阶段已结束，审批已失效"
            break
        if result.get("pending") is True:
            # Waiting for the user: the gateway is reachable, so restart the
            # unreachable-gateway timer; the platform bounds the wait itself.
            deadline=min(limit,time.monotonic()+${conversationApprovalRetrySeconds})
            wait()
            continue
        allowed=result.get("allow") is True
        reason=result.get("reason",reason)
        break
except Exception:
    pass
if len(sys.argv)>1 and sys.argv[1]=="agy":
    print(json.dumps({"decision":"allow" if allowed else "deny","reason":reason}))
elif len(sys.argv)>1 and sys.argv[1]=="cursor":
    print(json.dumps({"permission":"allow" if allowed else "deny","user_message":reason,"agent_message":reason}))
else:
    print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow" if allowed else "deny","permissionDecisionReason":reason}}))
if not allowed:
    print(reason,file=sys.stderr)
    sys.exit(2)
`;

const conversationApprovalJS = `import {randomUUID} from "node:crypto";
async function approve(name,input,signal) {
  const payload=JSON.stringify({jsonrpc:"2.0",id:1,method:"agentflow/nativeApproval",params:{id:randomUUID(),name,input}});
  const limit=Date.now()+${conversationApprovalLimitSeconds}*1000;
  let deadline=Math.min(limit,Date.now()+${conversationApprovalRetrySeconds}*1000);
  for(;;) {
    if(signal?.aborted) throw new Error("本轮已停止");
    const remaining=deadline-Date.now();
    if(remaining<=0) throw new Error("平台网关长时间不可用，操作未执行");
    let rpc;
    try {
      const timeout=AbortSignal.timeout(Math.min(20000,remaining));
      const response=await fetch(process.env.AGENTFLOW_NATIVE_APPROVAL_URL,{method:"POST",headers:{"content-type":"application/json"},body:payload,signal:signal?AbortSignal.any([signal,timeout]):timeout});
      if(!response.ok) {
        if(![408,429,502,503,504].includes(response.status)) throw Object.assign(new Error("本阶段已结束，审批已失效"),{terminal:true});
      } else { rpc=await response.json(); }
    } catch(error) {
      if(error.terminal) throw error;
      if(signal?.aborted) throw new Error("本轮已停止");
    }
    if(rpc) {
      if(rpc.error) throw new Error("本阶段已结束，审批已失效");
      if(rpc.result?.pending!==true) {
        if(rpc.result?.allow!==true) throw new Error(rpc.result?.reason||"操作未批准");
        return;
      }
      deadline=Math.min(limit,Date.now()+${conversationApprovalRetrySeconds}*1000);
    }
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Math.min(1000,deadline-Date.now()))));
  }
}
`;

const conversationPiApproval = conversationApprovalJS + `
export default function(pi) {
  // Codemode runs in QuickJS without filesystem/network access. Its nested
  // calls enter this same tool_call pipeline, where each concrete tool is
  // checked separately. Checking the wrapper would block platform MCP reads.
  pi.on("tool_call",async(event,ctx)=>{if(event.toolName==="codemode")return;try{await approve(event.toolName,event.input,ctx.signal)}catch(error){return {block:true,reason:String(error.message)}}});
}
`;

const conversationOpenCodeApproval = conversationApprovalJS + `
export const LoopForgeApproval=async()=>({"tool.execute.before":async(input,output)=>{await approve(input.tool,output.args)}});
`;

const conversationDSHApproval = conversationApprovalJS + `
export const inject=["tools"];
export function apply(ctx) {
  ctx.on("tools/pre-execute",async(exec,next)=>{
    try { await approve(exec.name,exec.arguments,exec.signal); return next(); }
    catch(error) { return {kind:"deny",reason:String(error.message)}; }
  });
}
`;

module.exports = {
  conversationApprovalHookWatchdog, conversationApprovalRetrySeconds, conversationApprovalLimitSeconds,
  InstallConversationApproval, conversationReplaceFlag,
  conversationApprovalPython, conversationApprovalJS, conversationPiApproval, conversationOpenCodeApproval, conversationDSHApproval,
};
