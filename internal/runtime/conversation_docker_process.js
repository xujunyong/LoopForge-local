/**
 * @file 对应 Go 源文件：internal/runtime/conversation_docker_process.go
 * 职责边界：构造容器内运行与停止原生 CLI 所需的进程包装命令参数，内嵌基于 Linux 子收割者
 * （PR_SET_CHILD_SUBREAPER）的 Python 监管脚本与停止脚本，确保孤儿及派生子进程能被彻底清理。
 * 语法差异说明：
 * - Go 原始字符串（反引号）译为 JS 模板字面量；
 * - Go 切片拼接（append）译为数组展开语法。
 */

"use strict";

const { withToolchainPath } = require("./toolchain.js"); // 对应 Go 同包函数，toolchain.js 待翻译

/**
 * 构造容器内通过子收割者监管脚本启动原生 CLI 的命令行参数。
 * 使用场景：在 Docker 容器中启动原生 CLI 进程时包装原始命令，用于跟踪并清理其全部后代进程。
 * @param {string} file 进程状态控制文件路径（同时会派生同前缀的 .tmp 与 .stop 文件）。
 * @param {string[]} argv 实际要执行的原生 CLI 命令及其参数列表。
 * @returns {string[]} 附加工具链路径包装后的完整命令参数数组。
 */
function dockerConversationProcessArgv(file, argv) {
  return withToolchainPath(["python3", "-c", dockerConversationProcessSupervisor, file, ...argv]);
}

/**
 * 构造容器内停止受监管原生 CLI 进程的命令行参数。
 * 使用场景：需要取消或终止容器内正在运行的原生 CLI 会话时，通过停止脚本写入标记并向监管进程发送 SIGTERM。
 * @param {string} file 进程状态控制文件路径，与启动时传入的 file 一致。
 * @returns {string[]} 附加工具链路径包装后的停止命令参数数组。
 */
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
