// conversation_docker_process.js —— 对应 Go 文件：internal/runtime/conversation_docker_process.go
// 作用：容器内原生 CLI 的进程包装：Linux 子收割者监管脚本与停止脚本。
// Go 原始字符串译为模板字面量。

"use strict";

const { withToolchainPath } = require("./toolchain.js"); // 对应 Go 同包函数，toolchain.js 待翻译

function dockerConversationProcessArgv(file, argv) {
  return withToolchainPath(["python3", "-c", dockerConversationProcessSupervisor, file, ...argv]);
}

function dockerConversationStopArgv(file) {
  return withToolchainPath(["python3", "-c", dockerConversationProcessStop, file]);
}

// CLI 可能为其原生 shell 工具创建新会话。只杀进程组会留下这些工具继续运行。
// Linux 子收割者拥有哪怕是孤儿与二次派生的后代，且不影响同一工作区容器内的
// 其他命令。它保留 stdin，并在退出前等待清理完成。
const dockerConversationProcessSupervisor = `import ctypes,json,os,signal,subprocess,sys,time
path=sys.argv[1]
stopped=path+'.stop'
cancelled=False
def cancel(signum,frame):
    global cancelled
    cancelled=True
for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):
    signal.signal(sig,cancel)
def stat(pid):
    try:
        with open('/proc/'+str(pid)+'/stat') as f:
            fields=f.read().rsplit(')',1)[1].split()
        return int(fields[1]),fields[19]
    except (OSError,ValueError,IndexError):
        return None
me=os.getpid()
identity=stat(me)
if identity is None or ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)!=0:
    sys.exit('native CLI requires Linux child subreaper support')
def state(status):
    temp=path+'.tmp'
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f:
        json.dump({'pid':me,'start':identity[1],'status':status},f)
    os.replace(temp,path)
def descendants():
    rows={}
    for name in os.listdir('/proc'):
        if name.isdigit():
            entry=stat(int(name))
            if entry is not None:
                rows[int(name)]=entry
    owned={me}
    while True:
        more={pid for pid,(parent,start) in rows.items() if parent in owned}
        if more.issubset(owned):
            break
        owned.update(more)
    return {pid:rows[pid][1] for pid in owned if pid!=me}
def send(pid,start,sig):
    entry=stat(pid)
    if entry is not None and entry[1]==start:
        try:
            os.kill(pid,sig)
        except ProcessLookupError:
            pass
def cleanup(child):
    # Freeze parents before killing them, then rescan for children created
    # during that snapshot. Subreaper adoption retains every owned process.
    frozen={}
    while True:
        current=descendants()
        for pid,start in current.items():
            send(pid,start,signal.SIGSTOP)
        if current.items()<=frozen.items():
            break
        frozen.update(current)
    for pid,start in frozen.items():
        send(pid,start,signal.SIGKILL)
    code=child.wait(timeout=5) if child is not None else 0
    deadline=time.monotonic()+5
    while True:
        try:
            pid,_=os.waitpid(-1,os.WNOHANG)
        except ChildProcessError:
            break
        if pid==0:
            if time.monotonic()>deadline:
                raise RuntimeError('native CLI descendants did not exit')
            time.sleep(0.01)
    return code
child=None
code=1
try:
    state('running')
    # The stop marker also fences cancellation before docker exec reaches
    # this wrapper. A late launch cannot begin a new CLI after stop returned.
    if not cancelled and not os.path.exists(stopped):
        child=subprocess.Popen(sys.argv[2:],start_new_session=True)
        while child.poll() is None and not cancelled and not os.path.exists(stopped):
            time.sleep(0.05)
finally:
    code=cleanup(child)
    state('done')
sys.exit(143 if cancelled or os.path.exists(stopped) else (code if code>=0 else 128-code))
`;

// PID 的 Linux 启动时间可防止陈旧控制文件误发信号给复用的 PID。
// 若启动尚未到达容器，停止标记会被保留。
const dockerConversationProcessStop = `import json,os,signal,sys,time
path=sys.argv[1]
stopped=path+'.stop'
try:
    fd=os.open(stopped,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    os.close(fd)
except FileExistsError:
    pass
deadline=time.monotonic()+7
while True:
    try:
        with open(path) as f:
            state=json.load(f)
    except FileNotFoundError:
        break
    if state['status']=='done':
        os.unlink(path)
        os.unlink(stopped)
        break
    try:
        with open('/proc/'+str(state['pid'])+'/stat') as f:
            start=f.read().rsplit(')',1)[1].split()[19]
    except FileNotFoundError:
        sys.exit('native CLI supervisor exited without cleanup')
    if start!=state['start']:
        sys.exit('native CLI supervisor identity changed')
    try:
        os.kill(state['pid'],signal.SIGTERM)
    except ProcessLookupError:
        pass
    if time.monotonic()>deadline:
        sys.exit('native CLI supervisor did not stop')
    time.sleep(0.05)
`;

module.exports = {
  dockerConversationProcessArgv, dockerConversationStopArgv,
  dockerConversationProcessSupervisor, dockerConversationProcessStop,
};
