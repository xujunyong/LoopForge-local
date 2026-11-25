// handover.test.js —— 对应 Go 文件：cmd/agentflow/handover_test.go
// 学习用 JS 对照翻译，用 Node 内置的 node:test / node:assert，不用任何第三方测试库。
// 运行方法（在 cmd/agentflow/ 目录下）：node --test handover.test.js
//
// Go → JS 对照（测试写法）：
// - func TestXxx(t *testing.T) → test('...', (t) => {...})
// - net.ListenUnixgram("unixgram", ...) → Node 没有 unix 数据报 socket，
//   所以 sdNotify 的发送是【桩】，测试只验证报文格式和“无 socket 时空操作”
// - t.Setenv → 直接改 process.env，并在 t.after() 里恢复（见 main.test.js 的 setEnv 说明，
// 这里为了不依赖另一个测试文件，重新写了一个小版）
// - time.Second / time.Minute → 毫秒数：1000 / 60000
//
// 哪些 Go 测试没有照搬，为什么：
// - TestHandoverHelperProcess / TestHandoverPassesListenerAndDrainsPredecessor /
// TestHandoverKeepsServingWhenSuccessorNeverReady：
// Go 版是启动一个“迷你 API 进程”当助手子进程，真的把监听 socket 交接过去，
// 再检查新进程能不能继续服务、老进程有没有排空退出。
// 这依赖 Go 的 fd 继承（ExtraFiles）和 net.FileListener，
// JS 里没有可靠的等价做法（见 handover.js 里 handover() 的注释），
// 所以下面用 test.skip 跳过，并写明原因。
// 交接之外的纯函数（withoutHandoverEnv、listenMain、sdNotify、resolveDrainTimeout）
// 都有对应的可跑测试。

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  envListenFD,
  envReadyFD,
  handoverStatus,
  sdNotify,
  signalReady,
  listenMain,
  withoutHandoverEnv,
  predecessorExited,
} = require("./handover.js");
const { resolveDrainTimeout } = require("./main.js");

// setEnv(t, key, value)：对应 Go 的 t.Setenv，改完在测试结束时恢复。
function setEnv(t, key, value) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const old = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  t.after(() => {
    if (had) {
      process.env[key] = old;
    } else {
      delete process.env[key];
    }
  });
}

// ---------- sdNotify / signalReady：对应 Go 的 TestSDNotifySendsReadyAndMainPID ----------

test("sdNotify：报文格式是 MAINPID / READY / STATUS 三行；没有 socket 时是空操作", async (t) => {
  // Go 原版用 net.ListenUnixgram 建一个 unix 数据报 socket 来收报文；
  // Node 的 dgram 只支持 udp4 / udp6，没有 unix 数据报 socket，
  // 所以 JS 里测不了“真的收到报文”这一步。
  // 改成测两件能测的事：
  // 1. buildSdNotifyPayload() 拼出来的报文和 Go 的一模一样；
  // 2. 没有 NOTIFY_SOCKET 时 sdNotify() 是空操作，不抛错。
  // 发送本身在 handover.js 里是【桩】，见那里的注释。
  const { buildSdNotifyPayload } = require("./handover.js");
  const got = buildSdNotifyPayload(handoverStatus);
  const want = `MAINPID=${process.pid}\nREADY=1\nSTATUS=${handoverStatus}\n`;
  assert.equal(got, want);
  assert.ok(got.includes("handover"));

  // 没有 NOTIFY_SOCKET 时 sdNotify 必须是空操作（Go：return nil），不能抛错。
  setEnv(t, "NOTIFY_SOCKET", "");
  await sdNotify("READY=1");

  // 有 NOTIFY_SOCKET 但发不出去时，signalReady() 也不能抛错：
  // Go 里 sdNotify 出错只往 stderr 写一行提示，signalReady 照常继续。
  setEnv(t, "NOTIFY_SOCKET", "/nonexistent/notify.sock");
  setEnv(t, envReadyFD, "");
  await signalReady(handoverStatus);
});

// ---------- listenMain：对应 Go 的 TestListenMainBindsWithoutInheritedFD ----------

test("listenMain：正常启动绑定新端口、不报继承；非法的继承 fd 抛错", async (t) => {
  setEnv(t, envListenFD, "");
  const { listener, inherited } = await listenMain("127.0.0.1:0");
  try {
    assert.equal(inherited, false);
    assert.ok(listener.listening);
  } finally {
    listener.close();
  }

  setEnv(t, envListenFD, "nope");
  await assert.rejects(
    listenMain("127.0.0.1:0"),
    /invalid AGENTFLOW_LISTEN_FD/,
  );
});

// ---------- resolveDrainTimeout：对应 Go 的 TestResolveDrainTimeoutDefaultsToTwoHours ----------

test("resolveDrainTimeout：默认 120 分钟，环境变量能改，非法值用默认", (t) => {
  setEnv(t, "AGENTFLOW_DRAIN_TIMEOUT", "");
  assert.equal(resolveDrainTimeout(), 120 * 60 * 1000);
  setEnv(t, "AGENTFLOW_DRAIN_TIMEOUT", "90s");
  assert.equal(resolveDrainTimeout(), 90 * 1000);
  setEnv(t, "AGENTFLOW_DRAIN_TIMEOUT", "bogus");
  assert.equal(resolveDrainTimeout(), 120 * 60 * 1000);
});

// ---------- withoutHandoverEnv ----------

test("withoutHandoverEnv：只去掉交接专用的两个变量，其他原样保留", () => {
  const env = [
    "PATH=/usr/bin",
    "AGENTFLOW_LISTEN_FD=3",
    "AGENTFLOW_READY_FD=4",
    "AGENTFLOW_LISTEN_FD2=9",
    "HOME=/home/xujunyong",
  ];
  const out = withoutHandoverEnv(env);
  assert.deepEqual(out, [
    "PATH=/usr/bin",
    "AGENTFLOW_LISTEN_FD2=9",
    "HOME=/home/xujunyong",
  ]);
  // 原数组不动（Go 里也是建一个新 slice，不改原数组）。
  assert.equal(env.length, 5);
});

// ---------- predecessorExited ----------

test("predecessorExited：返回一个 Promise，不会立刻 resolve", async () => {
  // 只是验证“返回 Promise 且不会立刻完成”；真的等前任进程退出没法在测试里模拟，
  // Go 的测试也没有直接测这个函数（它只在 main() 的交接流程里被用到）。
  const p = predecessorExited();
  assert.ok(p instanceof Promise);
  const raced = await Promise.race([
    p.then(() => "resolved"),
    new Promise((resolve) =>
      setTimeout(() => resolve("not-resolved-yet"), 100),
    ),
  ]);
  assert.equal(raced, "not-resolved-yet");
});

// ---------- 涉及真实子进程交接的测试：跳过 ----------

test.skip(
  "TestHandoverPassesListenerAndDrainsPredecessor（跳过）：需要真的把监听 socket " +
    "以 fd 继承的方式交给子进程，并检查新进程继续服务、老进程排空退出；" +
    "JS 里没有 net.FileListener 的等价做法，handover() 的 fd 交接部分是",
  () => {},
);

test.skip(
  "TestHandoverKeepsServingWhenSuccessorNeverReady（跳过）：同上，" +
    "需要一个永远不报就绪的后继进程来验证“交接失败时老进程继续服务”；" +
    "依赖真实的 fd 交接，JS 对照版无法复现",
  () => {},
);
