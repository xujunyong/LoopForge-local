// handover.js —— 对应 Go 文件：cmd/agentflow/handover.go
// 学习用 JS 对照翻译，不是可运行的 Go 后端替代品。
// 只用纯 JavaScript，不用 TypeScript。函数名、常量名、流程顺序尽量贴近原 Go 文件，
// 方便把两个文件并排着读。
//
// Go → JS 对照（本文件用到的）：
// - const 块 → const 常量；time.Duration（纳秒整数）→ 毫秒数（Number）
// - (值, error) 多返回值 → 有错就 throw Error，没错就正常返回；
// listenMain 这种返回 (listener, inherited, err) 的，JS 里返回 { listener, inherited}，
// 有错就 throw
// - os.Getenv / os.Unsetenv → process.env 读 / delete process.env.xxx
// - net.Listener → Node 的 net.Server
// - goroutine + channel（select 等 ready / exited / 超时三选一）
// → Promise + Promise.race，见 handover()
// - <-chan struct{}（predecessorExited）→ Promise<void>
// - os/exec.Command → child_process.spawn
// - os.Pipe → 进程间用 spawn 的 stdio 额外管道近似（见 handover() 的注释）

"use strict";

const net = require("node:net");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

// 热重载（收到 SIGHUP）时，老进程把 API 监听 socket 交给新启动的进程：
// 新进程继承这个 socket、上报就绪、成为 systemd 的 MainPID；
// 老进程停止接受新请求，并把手头正在跑的工作排空
// （助手生成任务会持有无法迁移的 CLI 子进程）。
const envListenFD = "AGENTFLOW_LISTEN_FD";
const envReadyFD = "AGENTFLOW_READY_FD";

// handoverStatus 会作为 systemd 单元的 StatusText 发布；
// 部署脚本通过找 "handover" 来判断当前运行的二进制是否支持重载。
const handoverStatus = "serving; reload performs a handover";

const handoverReadyTimeout = 60 * 1000; // Go: 60 * time.Second，JS 里用毫秒

// inheritedListener：返回前任进程传过来的监听器；
// 正常启动时返回 null。
// Go 里用 os.NewFile(fd) + net.FileListener(fd) 把文件描述符变成 Listener。
// Node.js 没有把“已打开的文件描述符直接变成 net.Server”的公开等价物，
// 所以这里只做校验：环境变量为空返回 null，非法值 throw，
// 合法值（>= 3）目前也 throw 一个带标记的错误，说明这一步在 JS 里无法照搬。
// inheritedListener()
// 干什么：返回前任进程通过环境变量传过来的监听器；正常启动时返回 null。
// 入参：无（读环境变量 AGENTFLOW_LISTEN_FD）；
// 返回值：正常启动返回 null；非法值 throw Error；
// 合法值目前也 throw 一个带标记的错误（见下面的说明）。
// 背景：热重载时老进程不会直接退出，而是启动一个新进程，
// 把正在监听的 socket（文件描述符，fd）传给新进程，
// 新进程直接用这个 socket 继续接受请求，端口不用重新绑定，
// 用户感觉不到服务中断。这是 Go 后端“平滑升级”的关键机制。
// Go 原来的写法：
// raw:= strings.TrimSpace(os.Getenv(envListenFD))
// if raw == "" { return nil, nil} // 正常启动
// fd, err:= strconv.Atoi(raw)
// if err!= nil || fd < 3 { return nil, fmt.Errorf(...)} // fd 0/1/2 是标准输入输出错误，不能是监听 socket
// f:= os.NewFile(uintptr(fd), "agentflow-listener")
// ln, err:= net.FileListener(f) // 把 fd 变成 Listener
// 注意 Go 返回的是 (net.Listener, error) 两个值；
// JS 里成功返回 Listener 或 null，失败 throw，和本项目其他函数的翻译手法一致。
// Node.js 没有把“已打开的文件描述符直接变成 net.Server”的公开等价物，
// 所以这里只做校验：环境变量为空返回 null，非法值 throw，
// 合法值（>= 3）目前也 throw 一个带标记的错误，
// 说明这一步在 JS 里无法照搬。测试只覆盖“为空返回 null”和“非法值 throw”这两条。
function inheritedListener() {
  const raw = (process.env[envListenFD] || "").trim();
  if (raw === "") {
    return null;
  }
  delete process.env[envListenFD];
  const fd = Number.parseInt(raw, 10);
  if (Number.isNaN(fd) || fd < 3) {
    throw new Error(`invalid ${envListenFD} "${raw}"`);
  }
  throw new Error(
    `Node.js 无法把文件描述符 ${fd} 直接变成 net.Server；` +
      "Go 的 net.FileListener 在此没有直接等价物，本函数只保留了校验逻辑",
  );
}

// listenMain：复用继承来的监听器，否则按 addr 绑定一个新的。
// 返回 { listener, inherited}；绑定失败时 throw。
// Go 签名是 (ln, inherited, err)，JS 用对象返回值 + throw 代替 error 返回值。
// listenMain(addr)
// 干什么：拿到主监听器——优先复用前任进程交接来的，
// 没有交接才按 addr 绑定一个新的。
// 入参：addr —— 监听地址字符串，例如 "127.0.0.1:0"（端口 0 表示让系统随便挑一个空闲端口，
// 测试就靠这个避免端口冲突）或 ":8090"；空字符串时 Go 用 ":http"（即 80 端口）。
// 返回值：Promise，resolve 成 { listener, inherited}，
// listener 是 Node 的 net.Server，inherited 是布尔值（true 表示复用了交接来的）；
// 绑定失败或继承的 fd 非法时 reject/throw。
// Go 原来的写法：
// func listenMain(addr string) (ln net.Listener, inherited bool, err error) {
// ln, err = inheritedListener()
// if err!= nil || ln!= nil { return ln, ln!= nil, err}
// if addr == "" { addr = ":http"}
// ln, err = net.Listen("tcp", addr)
// return ln, false, err
//}
// 注意 Go 的返回值是三个值 (ln, inherited, err)，
// 其中 inherited 的值就是 ln!= nil（有交接来的监听器就是 true）；
// JS 里把前两个包成一个对象返回，err 用 throw 代替。
// 容易看不懂的点：
// "127.0.0.1:0" 的 0 不是真的监听 0 端口，是让操作系统分配一个空闲端口，
// 测试里就是这么拿到一个不会冲突的地址的；
// listenMain 里 parseListenAddr() 是 JS 自己的小帮手，
// Go 里这一步是 net.Listen 直接做的，不用单独写。
async function listenMain(addr) {
  const ln = inheritedListener();
  if (ln !== null) {
    return { listener: ln, inherited: true };
  }
  if (addr === "") {
    addr = ":80"; // Go 的 ":http" 是指 http 服务对应的 80 端口
  }
  const server = net.createServer();
  const { host, port } = parseListenAddr(addr);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return { listener: server, inherited: false };
}

// parseListenAddr：把 Go 的 "host:port" / ":port" 形式的监听地址拆开。
// 只供 listenMain 内部使用，Go 里这一步是 net.Listen 直接做的。
function parseListenAddr(addr) {
  const idx = addr.lastIndexOf(":");
  if (idx === -1) {
    return { host: "0.0.0.0", port: Number(addr) };
  }
  const host = addr.slice(0, idx) || "0.0.0.0";
  const port = Number(addr.slice(idx + 1));
  return { host, port };
}

// signalReady：告诉 systemd（和正在等待的前任进程）本进程已经开始服务。
// systemd 在释放前任之前先知道新的 MainPID，这样单元不会观察到主进程退出。
// signalReady(status)
// 干什么：告诉 systemd（和正在等待的前任进程）“本进程已经开始服务了”。
// 入参：status —— 状态字符串，例如 handoverStatus（"serving; reload performs a handover"）；
// 返回值：Promise。
// 为什么需要它：
// 热重载时 systemd 要先知道新的 MainPID，再释放前任，
// 这样 systemd 观察到的单元永远有主进程，不会误以为服务挂了。
// 前任进程也在等这个信号，收到后才敢停掉自己。
// 做了两件事（和 Go 完全一致）：
// 1. 调 sdNotify() 发 "MAINPID=<pid>\nREADY=1\nSTATUS=<status>\n" 给 systemd；
// 发失败了只往 stderr 写一行 "sd_notify:..."（Go：fmt.Fprintf(os.Stderr,...)），
// 不让启动失败——因为开发机上根本没有 systemd，这一步本来就该是空操作。
// 2. 如果环境变量 AGENTFLOW_READY_FD 不为空，就往那个 fd 写一行 "ready\n"，
// 这是给前任进程的“管道信号”；fd 非法（< 3 或不是数字）就悄悄跳过，
// Go 里这里也是直接 return，不报错。
// Go 原来的写法是同步函数（没有返回值）；JS 里 sdNotify 返回 Promise，
// 所以 signalReady 也写成了 async，调用方要 await 它。
async function signalReady(status) {
  try {
    await sdNotify(buildSdNotifyPayload(status));
  } catch (err) {
    // Go: fmt.Fprintf(os.Stderr, "sd_notify: %v\n", err)
    process.stderr.write(`sd_notify: ${err.message}\n`);
  }
  const raw = (process.env[envReadyFD] || "").trim();
  if (raw === "") {
    return;
  }
  delete process.env[envReadyFD];
  const fd = Number.parseInt(raw, 10);
  if (Number.isNaN(fd) || fd < 3) {
    return;
  }
  // Go: f.Write([]byte("ready\n"))；JS 里用 fs.writeSync 写同一个 fd。
  fs.writeSync(fd, "ready\n");
  fs.closeSync(fd);
}

// sdNotify：把状态发给 $NOTIFY_SOCKET；在 systemd 之外是空操作。
// Go 用 net.DialUnix("unixgram")；JS 没有等价的 unix 数据报 API，见下面【桩】说明。
// 返回 Promise：发完 resolve；NOTIFY_SOCKET 为空时直接 resolve(null)。
// sdNotify(state)
// 干什么：把状态字符串发给 systemd 的通知 socket（$NOTIFY_SOCKET）；
// 在 systemd 之外（例如你的开发机、测试环境）是空操作。
// 入参：state —— 要发送的字符串，例如 "MAINPID=123\nREADY=1\nSTATUS=...\n"；
// 返回值：Promise，NOTIFY_SOCKET 为空时直接 resolve(null)，发完 resolve，发送失败 reject。
// Go 原来的写法：
// socket:= os.Getenv("NOTIFY_SOCKET")
// if socket == "" { return nil} // 没有 systemd，什么都不做
// conn, err:= net.DialUnix("unixgram", nil, &net.UnixAddr{...})
// _, err = conn.Write([]byte(state))
// Go 用 net.DialUnix 拨一个 unix 数据报 socket；
// JS 里没有 dgram 的 unix_dgram 类型，发送那一步只能留桩，
// 报文格式由 buildSdNotifyPayload() 负责，测试验证的就是它。
// 容易看不懂的点：
// 以 "@" 开头的 socket 名表示 Linux 的“抽象 socket”，
// 它不在文件系统里，没有对应的 socket 文件，
// 第一个字节要换成 \0（Go：socket = "\x00" + socket[1:]），
// JS 里写成 `\0${socket.slice(1)}`，意思完全一样。
// buildSdNotifyPayload(status)：拼出 sd_notify 要发的那三行报文。
// 格式是固定的："MAINPID=<pid>\nREADY=1\nSTATUS=<status>\n"，
// signalReady() 调 sdNotify() 时传的就是这个字符串。
// 单独抽成一个函数，是为了让测试不用真的发 socket 也能验证报文格式。
function buildSdNotifyPayload(status) {
  return `MAINPID=${process.pid}\nREADY=1\nSTATUS=${status}\n`;
}

function sdNotify(state) {
  const socket = process.env.NOTIFY_SOCKET || "";
  if (socket === "") {
    return Promise.resolve(null);
  }
  // 【桩】Go 用 net.DialUnix("unixgram") 拨一个 unix 数据报 socket 再写 state；
  // Node 的 dgram 只支持 udp4 / udp6，没有 unix 数据报 socket 的公开 API
  // （dgram.createSocket("unix_dgram") 会直接抛 ERR_SOCKET_BAD_TYPE），
  // 所以这里无法照搬发送那一步。报文格式见 buildSdNotifyPayload()，
  // 抽象 socket（以 "@" 开头，第一个字节换成 \0）的处理也保留在注释里：
  // Go：socket = "\x00" + socket[1:]。
  // 调用方 signalReady() 会 catch 这个错误，只往 stderr 写一行提示，
  // 不让启动失败——和 Go 里“发失败也不影响服务”是一致的。
  return Promise.reject(
    new Error(
      '【桩】Node.js 没有 unix 数据报 socket 的公开 API，无法像 Go 的 net.DialUnix("unixgram") 那样发送 sd_notify',
    ),
  );
}

// handover：启动当前磁盘上的新二进制，把监听器 ln 交给它，并等它就绪。
// 出错时后继进程已被杀掉，调用方继续提供服务。
// 返回后继进程的 ChildProcess；三种失败都会 throw：
// 后继进程没在规定时间内报就绪、后继进程提前退出、读就绪信号出错。
// Go 里用 select 同时等 ready / exited / 超时三个 channel；
// JS 里用 Promise.race 等三个 Promise。
// Go 把监听 socket 以 ExtraFiles 的第 3 个 fd（fd 3）传给后继进程，
// 就绪管道是第 4 个 fd（fd 4）。Node 的 spawn 也可以传额外 stdio，
// 但把一个正在监听的 net.Server 的底层 fd 原样递过去并在子进程里还原成 Server，
// 在 JS 里没有可靠的等价做法。下面只保留“启动后继进程、等就绪、超时杀掉”
// 的控制流，fd 继承本身用普通管道近似，不代表真的交接了监听 socket。
// handover(listener, timeoutMs)
// 干什么：启动当前磁盘上的新二进制，把监听器 ln 交给它，并等它报就绪。
// 出错时后继进程会被杀掉，调用方继续提供服务，用户感觉不到中断。
// 入参：listener —— 正在监听的 net.Server（Go：net.Listener）；
// timeoutMs —— 等后继进程报就绪的最长等待时间，毫秒
// （Go：handoverReadyTimeout = 60 * time.Second，即 60000 毫秒）。
// 返回值：Promise，成功 resolve 成后继进程的 ChildProcess；
// 三种失败都会 reject/throw：
// 1. 后继进程在规定时间内没报就绪 → 杀掉它，throw "not ready within..."；
// 2. 后继进程提前退出 → throw "successor exited before ready:..."；
// 3. 读就绪信号出错（例如读到空）→ throw "empty readiness signal"。
// Go 原来的写法：
// filer, ok:= ln.(interface{ File() (*os.File, error)})
// if!ok { return nil, fmt.Errorf("listener %T cannot be inherited", ln)}
// 上面这段是 Go 的“类型断言”：先问监听器“你能不能取出底层文件”，
// 不能就报错；JS 的 net.Server 没有 File() 方法，
// 这里改成校验 listener 确实在 listening，否则 throw 同样意思的错误。
// 然后 Go 用 os.Pipe() 建一对管道、exec.Command 启动后继进程、
// 把监听 socket 和就绪管道以 ExtraFiles 的形式传过去（fd 3 是监听 socket，fd 4 是就绪管道），
// 再用 select 同时等 ready / exited / 超时三个 channel；
// JS 里用 Promise.race 等三个 Promise，ready / exited / timeout 三选一，
// 和 Go 的 select 是同一个意思。
// Go 把监听 socket 以 ExtraFiles 的第 3 个 fd 传给后继进程，
// 就绪管道是第 4 个 fd。Node 的 spawn 也可以传额外 stdio，
// 但把一个正在监听的 net.Server 的底层 fd 原样递过去、
// 并在子进程里还原成 Server，在 JS 里没有可靠的等价做法。
// 下面只保留“启动后继进程、等就绪、超时杀掉”的控制流，
// fd 继承本身用普通管道近似，不代表真的交接了监听 socket。
// 测试里涉及 handover 真正交接的子进程用例（Go 的 TestHandover*）
// 在 JS 测试里跳过，原因写在 handover.test.js 里。
async function handover(listener, timeoutMs) {
  if (!listener || typeof listener !== "object") {
    throw new Error(`listener ${typeof listener} cannot be inherited`);
  }
  // Go: ln.(interface{ File() (*os.File, error)}) —— 断言监听器能取出底层文件。
  // JS 的 net.Server 没有 File() 方法，这里只校验它确实在监听。
  if (typeof listener.listening !== "boolean" || !listener.listening) {
    throw new Error("listener cannot be inherited: it is not listening");
  }

  const exe = process.execPath; // Go: os.Executable()，当前可执行文件
  const entry = process.argv[1]; // JS 程序的入口文件，Go 没有这一层
  const child = spawn(
    exe,
    entry ? [entry, ...process.argv.slice(2)] : process.argv.slice(2),
    {
      stdio: ["inherit", "inherit", "inherit", "pipe"], // 第 4 个管道近似 Go 的就绪管道（fd 4）
      env: {
        ...withoutHandoverEnv(
          Object.entries(process.env).map(([k, v]) => `${k}=${v}`),
        ).reduce((acc, kv) => {
          const i = kv.indexOf("=");
          acc[kv.slice(0, i)] = kv.slice(i + 1);
          return acc;
        }, {}),
        [envListenFD]: "3",
        [envReadyFD]: "4",
      },
    },
  );
  const readyPipe = child.stdio[3];

  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) =>
      resolve(
        new Error(
          `successor exited before ready: code=${code} signal=${signal}`,
        ),
      ),
    );
  });
  const ready = new Promise((resolve, reject) => {
    if (!readyPipe) {
      reject(new Error("empty readiness signal"));
      return;
    }
    readyPipe.once("data", (buf) => {
      if (buf.length > 0) resolve(null);
      else reject(new Error("empty readiness signal"));
    });
    readyPipe.once("error", reject);
  });
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(new Error("timeout")), timeoutMs);
  });

  const result = await Promise.race([
    ready.then(() => ({ kind: "ready" })),
    exited.then((err) => ({ kind: "exited", err })),
    timeout.then((err) => ({ kind: "timeout", err })),
  ]);
  if (result.kind === "ready") {
    return child;
  }
  child.kill("SIGKILL");
  if (result.kind === "exited") {
    throw new Error(`successor exited before ready: ${result.err.message}`);
  }
  throw new Error(`successor pid ${child.pid} not ready within ${timeoutMs}ms`);
}

// withoutHandoverEnv：去掉环境变量里的交接专用项，
// 防止后继进程误以为自己也是被交接启动的。
// withoutHandoverEnv(env)
// 干什么：去掉环境变量里的交接专用项，防止后继进程误以为自己也是被交接启动的。
// 入参：env —— 字符串数组，每一项是 "KEY=VALUE" 的形式（Go：os.Environ() 的返回值）；
// 返回值：去掉 AGENTFLOW_LISTEN_FD / AGENTFLOW_READY_FD 之后的新数组，原数组不动。
// Go 原来的写法：
// out:= make([]string, 0, len(env))
// for _, kv:= range env {
// if strings.HasPrefix(kv, envListenFD+"=") || strings.HasPrefix(kv, envReadyFD+"=") {
// continue
//}
// out = append(out, kv)
//}
// 注意判断用的是 HasPrefix(kv, "AGENTFLOW_LISTEN_FD=")，带上等号，
// 这样 "AGENTFLOW_LISTEN_FD2=..." 这种名字相近的变量不会被误删；
// JS 里用 startsWith 做同样的判断。
// 为什么需要它：handover() 启动后继进程时要传一套新的环境变量，
// 里面要新写一遍交接用的 fd；如果旧的还留着，后继进程会读到两份，
// 所以先过滤掉旧的，再追加新的。
function withoutHandoverEnv(env) {
  const out = [];
  for (const kv of env) {
    if (kv.startsWith(`${envListenFD}=`) || kv.startsWith(`${envReadyFD}=`)) {
      continue;
    }
    out.push(kv);
  }
  return out;
}

// predecessorExited：返回一个 Promise，在交接给我们的前任进程退出后 resolve。
// （我们会被 reparent，父进程 id 会变，以此判断前任已经不在了。）
// Go 返回 <-chan struct{}，JS 用 Promise 代替 channel；
// 轮询间隔 1 秒，和 Go 的 time.Sleep(time.Second) 一致。
// predecessorExited()
// 干什么：返回一个 Promise，在交接给我们的前任进程退出后 resolve。
// 入参：无；返回值：Promise<void>，前任退出时 resolve，永不 reject。
// 背景：新进程刚接手时，前任可能还在排空手头的工作，
// 有些恢复操作必须等前任彻底退出才能做（否则两边会同时动同一份数据）。
// 怎么判断前任退出了呢？Unix 有一个特性：父进程退出后，子进程会被 reparent，
// 也就是 process.ppid（父进程 id）会变；
// 所以只要每隔 1 秒看一次 ppid 变了没有，变了就说明前任不在了。
// Go 原来的写法：
// func predecessorExited() <-chan struct{} {
// ppid:= os.Getppid()
// done:= make(chan struct{})
// go func() {
// for os.Getppid() == ppid { time.Sleep(time.Second)}
// close(done)
//}()
// return done
//}
// Go 返回的是一个 channel（<-chan struct{}），调用方写 <-predecessorExited() 来等；
// JS 没有 channel，这里返回 Promise，调用方写 await predecessorExited()，意思一样。
// Go 里 for 循环 + Sleep(1 秒) 对应 JS 里的 setInterval(..., 1000)。
// 容易看不懂的点：
// timer.unref() 是让这个轮询不拖住进程退出——
// 如果主流程都跑完了，只剩这个定时器在等，Node 也能正常退出，
// 和 Go 的 goroutine 不阻止进程退出是一个意思。
function predecessorExited() {
  const ppid = process.ppid;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (process.ppid !== ppid) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
    // 不让这个轮询本身拖住进程退出（Go 的 goroutine 也不阻止退出）。
    timer.unref();
  });
}

module.exports = {
  envListenFD,
  envReadyFD,
  handoverStatus,
  handoverReadyTimeout,
  inheritedListener,
  listenMain,
  parseListenAddr,
  signalReady,
  sdNotify,
  buildSdNotifyPayload,
  handover,
  withoutHandoverEnv,
  predecessorExited,
};
