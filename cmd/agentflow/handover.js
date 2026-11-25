// handover.js —— 对应 Go 文件：cmd/agentflow/handover.go（学习用对照翻译，非可运行后端）
// Go 的 (值, error) 多返回值译为：成功 return，失败 throw。
// time.Duration 译为毫秒数。goroutine + channel 译为 Promise。

"use strict";

const net = require("node:net");
const fs = require("node:fs");
const dgram = require("node:dgram");
const { spawn } = require("node:child_process");

// SIGHUP 时老进程把 API 监听 socket 交给新进程：新进程继承 socket、上报就绪、
// 成为 systemd 的 MainPID；老进程停止接受新请求并排空进行中的工作。
const envListenFD = "AGENTFLOW_LISTEN_FD";
const envReadyFD = "AGENTFLOW_READY_FD";
// handoverStatus 作为 systemd 单元的 StatusText 发布；部署脚本据此判断是否支持重载。
const handoverStatus = "serving; reload performs a handover";
const handoverReadyTimeout = 60 * 1000; // Go：60 * time.Second

function inheritedListener() {
  const raw = (process.env[envListenFD] || "").trim();
  if (raw === "") return null;
  delete process.env[envListenFD];
  const fd = Number.parseInt(raw, 10);
  if (Number.isNaN(fd) || fd < 3) {
    throw new Error(`invalid ${envListenFD} "${raw}"`);
  }
  // Go：os.NewFile(fd) + net.FileListener(f)；Node 无此等价实现。
  throw new Error(`net.FileListener: no Node equivalent for fd ${fd}`);
}

async function listenMain(addr) {
  const ln = inheritedListener();
  if (ln !== null) return [ln, true]; // Go 返回 (ln, ln != nil, err)
  if (addr === "") addr = ":80"; // Go 的 ":http" 即 80 端口
  const idx = addr.lastIndexOf(":");
  const host = addr.slice(0, idx) || "0.0.0.0";
  const port = Number(addr.slice(idx + 1));
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return [server, false];
}

async function signalReady(status) {
  try {
    await sdNotify(
      `MAINPID=${process.pid}\nREADY=1\nSTATUS=${status}\n`,
    );
  } catch (err) {
    process.stderr.write(`sd_notify: ${err.message}\n`);
  }
  const raw = (process.env[envReadyFD] || "").trim();
  if (raw === "") return;
  delete process.env[envReadyFD];
  const fd = Number.parseInt(raw, 10);
  if (Number.isNaN(fd) || fd < 3) return;
  fs.writeSync(fd, "ready\n");
  fs.closeSync(fd);
}

function sdNotify(state) {
  const socket = process.env.NOTIFY_SOCKET || "";
  if (socket === "") return null;
  const name = socket.startsWith("@") ? "\0" + socket.slice(1) : socket;
  // Go：net.DialUnix("unixgram")；Node 的 dgram 无 unix_dgram 类型，下行即抛错。
  const conn = dgram.createSocket("unix_dgram");
  return new Promise((resolve, reject) => {
    conn.send(state, name, (err) => {
      conn.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

// handover(ln, timeout)：启动当前磁盘上的新二进制，把监听器交给它并等就绪。
// 出错时后继进程已被杀掉，调用方继续提供服务。
async function handover(ln, timeout) {
  if (typeof ln.file !== "function") {
    throw new Error(`listener ${ln.constructor.name} cannot be inherited`);
  }
  const lnFile = ln.file();
  const exe = process.execPath; // Go：os.Executable()
  // Go：os.Pipe() 得一对管道；ExtraFiles 的 fd 3 是监听 socket，fd 4 是就绪管道。
  // Node 的 spawn 用 stdio 数组对应 fd 3/4，监听 socket 本身无法传入（见上）。
  const child = spawn(exe, [process.argv[1], ...process.argv.slice(2)], {
    stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"],
    env: {
      ...Object.fromEntries(
        withoutHandoverEnv(
          Object.entries(process.env).map(([k, v]) => `${k}=${v}`),
        ).map((kv) => {
          const i = kv.indexOf("=");
          return [kv.slice(0, i), kv.slice(i + 1)];
        }),
      ),
      [envListenFD]: "3",
      [envReadyFD]: "4",
    },
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) =>
      resolve(new Error(`successor exited before ready: code=${code} signal=${signal}`)),
    );
  });
  const ready = new Promise((resolve, reject) => {
    const pipe = child.stdio[4];
    pipe.once("data", (buf) => {
      if (buf.length > 0) resolve(null);
      else reject(new Error("empty readiness signal"));
    });
    pipe.once("error", reject);
  });
  const timer = new Promise((resolve) =>
    setTimeout(() => resolve(new Error("timeout")), timeout),
  );
  const result = await Promise.race([
    ready.then(
      () => ({ kind: "ready" }),
      (err) => ({ kind: "ready", err }),
    ),
    exited.then((err) => ({ kind: "exited", err })),
    timer.then(() => ({ kind: "timeout" })),
  ]);
  if (result.kind === "ready" && !result.err) return child;
  child.kill("SIGKILL");
  if (result.kind === "ready") {
    throw new Error(
      `successor pid ${child.pid} did not report ready: ${result.err.message}`,
    );
  }
  if (result.kind === "exited") throw result.err;
  throw new Error(
    `successor pid ${child.pid} not ready within ${timeout}ms`,
  );
}

function withoutHandoverEnv(env) {
  const out = [];
  for (const kv of env) {
    if (kv.startsWith(envListenFD + "=") || kv.startsWith(envReadyFD + "=")) {
      continue;
    }
    out.push(kv);
  }
  return out;
}

// predecessorExited()：前任进程退出后 resolve（Go 返回 <-chan struct{}，此处译为 Promise）。
function predecessorExited() {
  const ppid = process.ppid;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (process.ppid !== ppid) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
}

module.exports = {
  envListenFD,
  envReadyFD,
  handoverStatus,
  handoverReadyTimeout,
  inheritedListener,
  listenMain,
  signalReady,
  sdNotify,
  handover,
  withoutHandoverEnv,
  predecessorExited,
};
