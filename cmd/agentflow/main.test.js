// main.test.js —— 对应 Go 文件：cmd/agentflow/main_test.go
// 学习用 JS 对照翻译，用 Node 内置的 node:test / node:assert，不用任何第三方测试库。
// 运行方法（在 cmd/agentflow/ 目录下）：node --test main.test.js
//
// Go → JS 对照（测试写法）：
// - func TestXxx(t *testing.T) → test('...', (t) => {...})，t 是 node:test 的 TestContext
// - t.Fatalf(...) → assert.fail(...) 或直接 throw
// - t.Setenv(k, v) → 直接改 process.env，并在 t.after() 里恢复
//   （Node 没有 t.Setenv，所以下面写了一个小帮手 setEnv(t, key, value)）
// - t.TempDir() → fs.mkdtempSync(path.join(os.tmpdir(), '...'))
// - time.Minute / time.Second / time.Nanosecond → 毫秒数：
//   time.Minute = 60000，time.Second = 1000，time.Nanosecond = 0.000001
// - errors.Is(err, context.Canceled) → 检查 error.message 里是否包含
//   "context canceled" / "context deadline exceeded"（见 cli.js 的 throwIfAborted）
//
// 哪些 Go 测试没有照搬，为什么：
// - TestCLIAdminExitsBeforeServices：Go 版是把测试二进制自己当子进程跑，
//   再检查 main() 提前退出；JS 对照版的 main() 是桩，跑起来会 throw 桩错误，
//   没有一个真实可执行的二进制可以这样测，所以下面用 test.skip 跳过，
//   并写明原因。runCLI 本身的校验逻辑由下面的 TestCLIAdmin 覆盖。
// - TestCLIAdmin 里依赖真实 managedcli 的用例（例如 rollback "codex" 报
//   "no previous managed version"、update 超时报 "context deadline exceeded"）：
//   managedcli 是 Go 的 internal/managedcli 包，JS 里只有桩，
//   下面改用注入的假 managedcli（fakeManagedcli）来覆盖同样的校验分支，
//   真实 update / rollback 的行为不在本测试的翻译范围内，见 README-JS.md。

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  parseDuration,
  parseFlags,
  loadDotEnv,
  resolveDrainTimeout,
  startManagedCLIUpdates,
  resolveRole,
  resolveWorkspaceRoot,
} = require("./main.js");
const { runCLI } = require("./cli.js");

// setEnv(t, key, value)：对应 Go 的 t.Setenv。
// 改 process.env，并注册 t.after() 在测试结束时恢复原值，
// 这样一个测试改的环境变量不会漏到下一个测试里。
// value 传 undefined 表示测试期间删掉这个变量。
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

// makeTempDir：对应 Go 的 t.TempDir()，返回一个空的临时目录。
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-test-"));
}

// 收集标准输出的假 stdout：对应 Go 测试里的 var out bytes.Buffer。
// runCLI 往里写 JSON，测试再拿 out.text 检查是不是合法 JSON。
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

// ---------- parseDuration：对应 Go 的 time.ParseDuration ----------

test("parseDuration：能解析 Go 的时间字符串，非法值返回 null", () => {
  assert.equal(parseDuration("90s"), 90000);
  assert.equal(parseDuration("120m"), 120 * 60 * 1000);
  assert.equal(parseDuration("2h"), 2 * 60 * 60 * 1000);
  assert.equal(parseDuration("1h30m"), 90 * 60 * 1000);
  assert.equal(parseDuration("300ms"), 300);
  assert.equal(parseDuration("0"), 0);
  assert.equal(parseDuration("bogus"), null);
  assert.equal(parseDuration(""), null);
});

// ---------- parseFlags：对应 Go 的 flag 包 ----------

test("parseFlags：支持 -name value、-name=value、--name 和布尔 flag", () => {
  const defs = [
    { name: "role", type: "string", defaultValue: "" },
    { name: "worker-concurrency", type: "int", defaultValue: 8 },
    { name: "cli-timeout", type: "duration", defaultValue: 80 * 60 * 1000 },
    { name: "browser-image", type: "bool", defaultValue: false },
  ];
  const { flags, positional } = parseFlags(
    ["-role", "worker", "--worker-concurrency=4", "-browser-image"],
    defs,
  );
  assert.equal(flags.role, "worker");
  assert.equal(flags["worker-concurrency"], 4);
  assert.equal(flags["browser-image"], true);
  assert.equal(flags["cli-timeout"], 80 * 60 * 1000); // 没传就用默认值
  assert.deepEqual(positional, []);

  const withPositional = parseFlags(
    ["-cli-action=status", "extra"],
    [{ name: "cli-action", type: "string", defaultValue: "" }],
  );
  assert.deepEqual(withPositional.positional, ["extra"]);
  assert.throws(() => parseFlags(["-no-such-flag"], defs), /not defined/);
});

// ---------- loadDotEnv ----------

test("loadDotEnv：读 .env，注释和 export 行跳过，已有环境变量不覆盖", (t) => {
  const dir = makeTempDir();
  fs.writeFileSync(
    path.join(dir, ".env"),
    "# 注释\n" +
      "export FOO=from-dotenv\n" +
      'BAR="quoted value"\n' +
      "EMPTYLINE_BELOW=\n" +
      "NO_EQUALS_LINE\n",
  );
  setEnv(t, "FOO", "already-set");
  const oldCwd = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(oldCwd));
  loadDotEnv();
  assert.equal(process.env.FOO, "already-set"); // 已有的不覆盖
  assert.equal(process.env.BAR, "quoted value"); // 两边引号去掉
});

// ---------- resolveRole：对应 Go 的 TestResolveRole ----------

test("resolveRole：空值默认 all，大小写不敏感，非法值抛错", (t) => {
  setEnv(t, "AGENTFLOW_ROLE", "");
  assert.equal(resolveRole(""), "all");
  assert.equal(resolveRole("API"), "api");
  assert.equal(resolveRole(" worker "), "worker");
  assert.throws(() => resolveRole("scheduler"), /invalid role/);
  // 命令行没传时读环境变量
  setEnv(t, "AGENTFLOW_ROLE", "worker");
  assert.equal(resolveRole(""), "worker");
});

// ---------- resolveWorkspaceRoot ----------

test("resolveWorkspaceRoot：有参数就用参数，否则用家目录下的 .agentflow/workspace", () => {
  assert.equal(resolveWorkspaceRoot("/tmp/my-work"), "/tmp/my-work");
  assert.equal(
    resolveWorkspaceRoot("  "),
    path.join(os.homedir(), ".agentflow", "workspace"),
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

// ---------- startManagedCLIUpdates：对应 Go 的 TestManagedCLIShutdown ----------

test("startManagedCLIUpdates：不满足条件时返回空函数，调两次也不会卡住", (t) => {
  // Go 的测试用例表（role / execute / root）照搬过来：
  // worker+true+有根目录、all+true+有根目录、api+true+有根目录、
  // runner+true+有根目录、worker+false、all+false、worker+true+空根目录、all+true+空白根目录。
  // JS 的桩 managedcli.start() 会 throw，所以“真的启动”那几组
  // 在这里只验证“返回的 stop 函数存在且可调用”这一半——
  // 桩的限制见 README-JS.md，Go 原版则会真的启动一个更新器再停掉它。
  setEnv(t, "AGENTFLOW_MANAGED_CLI_CONFIG", "invalid-policy.json");
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
    const shouldStart =
      tc.execute &&
      (tc.role === "worker" || tc.role === "all") &&
      tc.root.trim() !== "";
    if (!shouldStart) {
      // 不满足启动条件的几组：返回的 stop() 必须是什么都不做的空函数，
      // 调两次也不能卡住（对应 Go 测试里 go func() { stop(); stop(); } 的部分）。
      const stop = startManagedCLIUpdates(
        { signal: undefined },
        tc.role,
        tc.execute,
      );
      assert.equal(typeof stop, "function");
      stop();
      stop();
      continue;
    }
    // 满足启动条件的几组（worker+true+有根目录、all+true+有根目录）：
    // Go 原版会真的启动一个更新器再停掉它；
    // JS 里 managedcli.start() 是【桩】，调用就 throw 桩错误，
    // 这里只验证“守卫条件放行后确实走到了桩”，而不是假装启动成功。
    assert.throws(
      () => startManagedCLIUpdates({ signal: undefined }, tc.role, tc.execute),
      /【桩】managedcli\.Start/,
    );
  }
});

// ---------- runCLI：对应 Go 的 TestCLIAdmin（校验分支） ----------

// fakeManagedcli：测试注入的假 managedcli，代替 Go 测试里真实的
// internal/managedcli。update() 故意睡 100 毫秒，
// 这样 runCLI 用一个很小的超时调它时，一定会先触发“context deadline exceeded”。
const fakeManagedcli = {
  async readState(_root) {
    return { providers: {} };
  },
  async newManager(_root) {
    return {
      async rollback(_signal, provider) {
        if (provider === "unknown" || provider === "") {
          throw new Error('known provider "codex" / "codebuddy" required');
        }
        if (provider === "codex") {
          throw new Error("no previous managed version for codex");
        }
        return { action: "rollback", provider };
      },
      async update(_signal) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { action: "update" };
      },
    };
  },
};

test("runCLI：校验分支和 Go 的 TestCLIAdmin 用例表一致", async (t) => {
  const root = makeTempDir();
  setEnv(t, "AGENTFLOW_MANAGED_CLI_CONFIG", "/nonexistent/invalid.json");
  setEnv(t, "AGENTFLOW_MANAGED_CLI_ROOT", root);
  const minute = 60 * 1000;
  // Go 用例表（action / provider / timeout / 想要的错误子串）：
  // status 能成功并输出合法 JSON；update 用 1 纳秒超时一定报 deadline exceeded；
  // rollback 未知 provider / 没带 provider 报 "known provider"；
  // rollback codex 报 "no previous managed version"；
  // 非法 action 报 "invalid -cli-action"；非 rollback 带 provider 报 "only supported with rollback"。
  const cases = [
    { action: "status", provider: "", timeout: minute, wantError: "" },
    {
      action: "update",
      provider: "",
      timeout: 0.000001,
      wantError: "context deadline exceeded",
    },
    {
      action: "rollback",
      provider: "unknown",
      timeout: minute,
      wantError: "known provider",
    },
    {
      action: "rollback",
      provider: "",
      timeout: minute,
      wantError: "known provider",
    },
    {
      action: "rollback",
      provider: "codex",
      timeout: minute,
      wantError: "no previous managed version",
    },
    {
      action: "install",
      provider: "",
      timeout: minute,
      wantError: "invalid -cli-action",
    },
    {
      action: "status",
      provider: "codex",
      timeout: minute,
      wantError: "only supported with rollback",
    },
    {
      action: "update",
      provider: "codex",
      timeout: minute,
      wantError: "only supported with rollback",
    },
  ];
  for (const tc of cases) {
    const out = makeOutput();
    let err = null;
    try {
      await runCLI(null, tc.action, tc.provider, tc.timeout, out, {
        managedcli: fakeManagedcli,
      });
    } catch (e) {
      err = e;
    }
    if (tc.wantError === "") {
      assert.equal(err, null, `${JSON.stringify(tc)} 不该报错，实际：${err}`);
      assert.doesNotThrow(
        () => JSON.parse(out.text),
        `${JSON.stringify(tc)} 输出不是合法 JSON：${out.text}`,
      );
    } else {
      assert.ok(err, `${JSON.stringify(tc)} 应该报错`);
      assert.ok(
        err.message.includes(tc.wantError),
        `${JSON.stringify(tc)} 错误信息里应该包含 "${tc.wantError}"，实际：${err.message}`,
      );
    }
  }

  // 相对路径的根目录：Go 的 managedcli 要求绝对路径，这里用假实现模拟同样的报错。
  // （Go 原版报 "absolute"；JS 桩不校验这个，测试只覆盖上面用例表里的分支。）
  // 根目录为空 / 超时 <= 0：runCLI 在碰 managedcli 之前就报错。
  setEnv(t, "AGENTFLOW_MANAGED_CLI_ROOT", "");
  await assert.rejects(
    runCLI(null, "status", "", minute, makeOutput(), {
      managedcli: fakeManagedcli,
    }),
    /required/,
  );
  setEnv(t, "AGENTFLOW_MANAGED_CLI_ROOT", root);
  await assert.rejects(
    runCLI(null, "status", "", 0, makeOutput(), { managedcli: fakeManagedcli }),
    /positive/,
  );
  await assert.rejects(
    runCLI(null, "status", "", -1000, makeOutput(), {
      managedcli: fakeManagedcli,
    }),
    /positive/,
  );

  // 已经取消的 context：Go 里 errors.Is(err, context.Canceled)；
  // JS 里用一个已经 abort 的 AbortSignal，错误信息里应包含 "context canceled"。
  const controller = new AbortController();
  controller.abort(new Error("context canceled"));
  await assert.rejects(
    runCLI({ signal: controller.signal }, "update", "", minute, makeOutput(), {
      managedcli: fakeManagedcli,
    }),
    /context canceled/,
  );
});

// ---------- TestCLIAdminExitsBeforeServices：跳过 ----------

test.skip(
  "TestCLIAdminExitsBeforeServices（跳过）：Go 版把测试二进制自己当子进程跑，" +
    "验证 main() 在 -cli-action 下提前退出；JS 对照版的 main() 是桩，" +
    "没有真实可执行的二进制可以这样测，runCLI 的校验逻辑已由上一条测试覆盖",
  () => {},
);
