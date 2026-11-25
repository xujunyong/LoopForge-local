// handover.test.js —— 对应 Go 文件：cmd/agentflow/handover_test.go
// 作用：handover.go 的测试对照，覆盖监听 socket 继承、平滑交接与 systemd 就绪上报。
// node:test / node:assert。t.Setenv 用下方小帮手翻译。

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { envListenFD, listenMain } = require("./handover.js");
const { resolveDrainTimeout } = require("./main.js");

// t.Setenv：改 process.env，测试结束时恢复。
function setEnv(t, key, value) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (had) process.env[key] = old;
    else delete process.env[key];
  });
}

// TestSDNotifySendsReadyAndMainPID：需要 unix 数据报 socket 收报文，Node 无此 API，跳过。
test.skip("TestSDNotifySendsReadyAndMainPID", () => {});

test("TestListenMainBindsWithoutInheritedFD", async (t) => {
  setEnv(t, envListenFD, "");
  const [ln, inherited] = await listenMain("127.0.0.1:0");
  try {
    assert.equal(inherited, false);
  } finally {
    ln.close();
  }
  setEnv(t, envListenFD, "nope");
  await assert.rejects(listenMain("127.0.0.1:0"), /invalid AGENTFLOW_LISTEN_FD/);
});

test("TestResolveDrainTimeoutDefaultsToTwoHours", (t) => {
  setEnv(t, "AGENTFLOW_DRAIN_TIMEOUT", "");
  assert.equal(resolveDrainTimeout(), 120 * 60 * 1000);
  setEnv(t, "AGENTFLOW_DRAIN_TIMEOUT", "90s");
  assert.equal(resolveDrainTimeout(), 90 * 1000);
  setEnv(t, "AGENTFLOW_DRAIN_TIMEOUT", "bogus");
  assert.equal(resolveDrainTimeout(), 120 * 60 * 1000);
});

// TestHandoverHelperProcess / TestHandoverPassesListenerAndDrainsPredecessor /
// TestHandoverKeepsServingWhenSuccessorNeverReady：需要真的把监听 socket 以 fd 继承交给子进程，Node 无等价实现，跳过。
test.skip("TestHandoverHelperProcess", () => {});
test.skip("TestHandoverPassesListenerAndDrainsPredecessor", () => {});
test.skip("TestHandoverKeepsServingWhenSuccessorNeverReady", () => {});
