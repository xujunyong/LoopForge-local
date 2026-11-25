// main.test.js —— 对应 Go 文件：cmd/agentflow/main_test.go
// node:test / node:assert。t.Setenv、t.TempDir()、bytes.Buffer 用下方小帮手翻译。
// 注意：本文件 require 的 main.js / cli.js 引用了尚未转写的 internal 包，
// 在那些包转写完之前，本文件加载即失败，见 README-JS.md。

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { startManagedCLIUpdates, resolveRole } = require("./main.js");
const { runCLI } = require("./cli.js");

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

// t.TempDir()
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-test-"));
}

// bytes.Buffer：收集 runCLI 写出的 JSON。
function makeOutput() {
  let text = "";
  return {
    write(chunk) {
      text += chunk;
      return true;
    },
    get text() {
      return text;
    },
  };
}

test("TestManagedCLIShutdown", async (t) => {
  setEnv(t, "AGENTFLOW_MANAGED_CLI_CONFIG", "invalid-policy.json");
  const controller = new AbortController();
  controller.abort(); // Go：ctx, cancel := context.WithCancel(...); cancel()
  const cases = [
    { role: "worker", execute: true, root: makeTempDir() },
    { role: "all", execute: true, root: makeTempDir() },
    { role: "api", execute: true, root: makeTempDir() },
    { role: "runner", execute: true, root: makeTempDir() },
    { role: "worker", execute: false, root: makeTempDir() },
    { role: "all", execute: false, root: makeTempDir() },
    { role: "worker", execute: true, root: "" },
    { role: "all", execute: true, root: "  " },
  ];
  for (const tc of cases) {
    setEnv(t, "AGENTFLOW_MANAGED_CLI_ROOT", tc.root);
    const stop = startManagedCLIUpdates(controller.signal, tc.role, tc.execute);
    // Go：select 等 done 或 3 秒超时；此处用 Promise.race 等同。
    await Promise.race([
      (async () => {
        stop();
        stop();
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`shutdown blocked: ${JSON.stringify(tc)}`)), 3000),
      ),
    ]);
  }
});

test("TestCLIAdmin", async (t) => {
  const root = makeTempDir();
  setEnv(t, "AGENTFLOW_MANAGED_CLI_CONFIG", path.join(root, "invalid.json"));
  const cases = [
    { action: "status", provider: "", root, timeout: 60000, wantError: "" },
    { action: "update", provider: "", root, timeout: 0.000001, wantError: "context deadline exceeded" },
    { action: "rollback", provider: "unknown", root, timeout: 60000, wantError: "known provider" },
    { action: "rollback", provider: "", root, timeout: 60000, wantError: "known provider" },
    { action: "rollback", provider: "codex", root, timeout: 60000, wantError: "no previous managed version" },
    { action: "install", provider: "", root, timeout: 60000, wantError: "invalid -cli-action" },
    { action: "status", provider: "codex", root, timeout: 60000, wantError: "only supported with rollback" },
    { action: "update", provider: "codex", root, timeout: 60000, wantError: "only supported with rollback" },
    { action: "status", provider: "", root: "relative", timeout: 60000, wantError: "absolute" },
    { action: "status", provider: "", root: "", timeout: 60000, wantError: "required" },
    { action: "status", provider: "", root, timeout: 0, wantError: "positive" },
    { action: "status", provider: "", root, timeout: -1000, wantError: "positive" },
  ];
  for (const tc of cases) {
    setEnv(t, "AGENTFLOW_MANAGED_CLI_ROOT", tc.root);
    const out = makeOutput();
    let err = null;
    try {
      await runCLI(null, tc.action, tc.provider, tc.timeout, out);
    } catch (e) {
      err = e;
    }
    if (tc.wantError === "") {
      assert.equal(err, null, `${JSON.stringify(tc)}: output=${out.text} err=${err}`);
      assert.doesNotThrow(() => JSON.parse(out.text));
    } else {
      assert.ok(err && err.message.includes(tc.wantError), `${JSON.stringify(tc)}: output=${out.text} err=${err}`);
    }
  }
  setEnv(t, "AGENTFLOW_MANAGED_CLI_ROOT", root);
  const controller = new AbortController();
  controller.abort(new Error("context canceled"));
  let err = null;
  try {
    await runCLI(controller.signal, "update", "", 60000, makeOutput());
  } catch (e) {
    err = e;
  }
  assert.ok(err && err.message.includes("context canceled"), `cancelled administration: ${err}`);
});

test("TestCLIAdminIgnoresLegacyConfig", async (t) => {
  for (const content of [`{"enabled":false}`, "invalid JSON"]) {
    const root = path.join(makeTempDir(), "absent");
    const configPath = path.join(makeTempDir(), "legacy.json");
    fs.writeFileSync(configPath, content, { mode: 0o600 });
    setEnv(t, "AGENTFLOW_MANAGED_CLI_ROOT", root);
    setEnv(t, "AGENTFLOW_MANAGED_CLI_CONFIG", configPath);
    const out = makeOutput();
    let err = null;
    try {
      await runCLI(null, "status", "", 60000, out);
    } catch (e) {
      err = e;
    }
    assert.equal(err, null, `status with legacy config ${content}: ${out.text} ${err}`);
    assert.doesNotThrow(() => JSON.parse(out.text));
    try {
      await runCLI(null, "update", "", 0.000001, out);
      assert.fail(`update with legacy config ${content}: should exceed deadline`);
    } catch (e) {
      assert.ok(e.message.includes("context deadline exceeded"), `${content}: ${e}`);
    }
    assert.throws(() => fs.statSync(root), /ENOENT/);
  }
});

// TestCLIAdminExitsBeforeServices：Go 版把测试二进制当子进程重跑，Node 无等价做法，跳过。
test.skip("TestCLIAdminExitsBeforeServices", () => {});

test("TestResolveRole", (t) => {
  setEnv(t, "AGENTFLOW_ROLE", "");
  for (const [input, want] of [["", "all"], ["API", "api"], ["scheduler", ""]]) {
    let got;
    let err = null;
    try {
      got = resolveRole(input);
    } catch (e) {
      err = e;
      got = "";
    }
    assert.equal(got, want, `role ${input}: ${got}, ${err}`);
    assert.equal(err !== null, want === "");
  }
});
