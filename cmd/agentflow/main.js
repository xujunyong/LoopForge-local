// main.js —— 对应 Go 文件：cmd/agentflow/main.go
// 学习用 JS 对照翻译，不是可运行的 Go 后端替代品。
// 只用纯 JavaScript，不用 TypeScript。函数名、流程顺序尽量贴近原 Go 文件，
// 方便把两个文件并排着读。
//
// Go → JS 对照（本文件用到的）：
// - package main + func main() → 本文件的 main() 函数；
// Go 程序从 main() 开始跑，JS 里要手动调用 main()（见文件末尾的注释）
// - flag.String / flag.Int / flag.Duration / flag.Bool（命令行参数）
// → parseFlags()，手写解析 process.argv（见下面）
// - log.Fatal / log.Fatalf → fatal()：打印后 process.exit(1)；
// Go 的 log.Fatal 会直接退出进程，不走 defer，JS 里同样用 process.exit(1)
// - (值, error) 多返回值 → 有错就 throw Error，没错就正常返回；
// 例如 resolveRole()：成功返回字符串，失败 throw
// - struct（例如 http.Server{...}、engine.CloudRunnerPool{...}）
// → 普通对象字面量 {...}，字段名保持原样
// - goroutine（go func() {...}()）→ 异步函数调用 / Promise，不用等它结束；
// channel（chan struct{}、atomic.Bool）→ Promise / 简单的布尔变量
// - context.WithCancel / WithTimeout → AbortController / AbortSignal
// - signal.Notify（监听 SIGINT / SIGTERM / SIGHUP）
// → process.on('SIGINT' / 'SIGTERM' / 'SIGHUP',...)
// - time.Duration（纳秒整数）→ 毫秒数（Number）；
// time.ParseDuration("90s") → parseDuration("90s") 返回 90000
// - os.Getenv / os.Setenv → process.env 读 / 写
//
// 以下内部包在 JS 里没有真实实现，统一用带【桩】标记的占位对象代替，
// 不会悄悄假装能跑：
// repo（internal/repo，MySQL + gorm）、engine（internal/engine，SOP 引擎）、
// httpapi（internal/httpapi，Gin 路由 + 后台任务）、config（internal/config）、
// runtime（internal/runtime，执行器 / 沙箱 / MCP CLI）、
// notification（internal/notification）、preview（internal/preview）、
// tracker（internal/tracker）、managedcli（internal/managedcli）、gin 本身。
// main() 的主流程按 Go 原样翻译，但跑到第一处桩时就会 throw，
// 这是特意保留的：它帮你读懂“启动时按什么顺序做了什么”，而不是假装能启动服务。

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { runCLI } = require("./cli.js");
const {
  listenMain,
  signalReady,
  handover,
  handoverReadyTimeout,
  handoverStatus,
  predecessorExited,
} = require("./handover.js");

// ---------- 桩：Go 内部包的占位实现 ----------
// 每个桩的方法被调用时都会 throw 一个带【桩】标记的错误，
// 这样你一眼就能看出“这里在 Go 里是真实逻辑，在 JS 对照版里没有实现”。

function stubError(name) {
  return new Error(
    `【桩】${name} 是 Go 内部包的真实逻辑，JS 对照版里没有实现，无法真正运行`,
  );
}

const repoStub = {
  // 对应 repo.Open(dsn)：打开 MySQL（Go 里用 gorm）。
  open(_dsn) {
    throw stubError("repo.Open");
  },
};

const engineStub = {
  // 对应 engine.New(store, manager)：创建 SOP 引擎。
  create() {
    throw stubError("engine.New");
  },
};

const runtimeStub = {
  // 对应 runtime.RunMCPCallCLI(args)：如果本次启动是 MCP 调用就处理并返回 true。
  runMCPCallCLI(_args) {
    return false;
  },
  // 对应 runtime.RunGitHelperCLI(args)：同上，Git 助手调用。
  runGitHelperCLI(_args) {
    return false;
  },
  // 对应 runtime.EnsureBrowserImage(ctx)：构建或拉取 Agent 浏览器 sidecar 镜像。
  async ensureBrowserImage(_signal) {
    throw stubError("runtime.EnsureBrowserImage");
  },
  // 对应 runtime.SetRepositoryCacheRoot(root)：设置仓库缓存根目录。
  setRepositoryCacheRoot(_root) {
    throw stubError("runtime.SetRepositoryCacheRoot");
  },
  // 对应 runtime.NewManagerWithLimit(root, concurrency)：创建执行管理器。
  newManagerWithLimit(_root, _concurrency) {
    throw stubError("runtime.NewManagerWithLimit");
  },
};

const managedcliStub = {
  // 对应 managedcli.Start(ctx, root)：启动托管 CLI 的后台更新，返回停止函数。
  start(_signal, _root) {
    throw stubError("managedcli.Start");
  },
};

// ---------- 小工具 ----------

// fatal：对应 Go 的 log.Fatal / log.Fatalf。
// 打印到 stderr 后直接退出进程，不走任何清理（和 Go 一样）。
function fatal(message) {
  console.error(message);
  process.exit(1);
}

// parseDuration：对应 Go 的 time.ParseDuration。
// 干什么：把 "90s"、"120m"、"2h"、"1h30m"、"300ms"、"1ns" 这类 Go 时间字符串
//   转成 JS 能直接用的毫秒数（Number）。
// 入参：raw（字符串，例如 "90s"）；返回值：毫秒数，解析失败返回 null。
// 为什么这样写：
//   Go 的 time.Duration 本质是一个 int64，单位是纳秒，写代码时常写 30 * time.Second
//   这种“数字 × 单位常量”的形式；环境变量里传进来的却是字符串，要先解析。
//   JS 的 setTimeout / Date 都用毫秒，所以这里统一换算成毫秒，
//   1 秒 = 1000 毫秒，1 分钟 = 60000 毫秒，1 小时 = 3600000 毫秒。
//   正则一次可以匹配多段（"1h30m" 是 1 小时 + 30 分钟），
//   最后用 matched !== text 判断整串是否都被消耗掉，
//   只要有一段对不上（例如 "bogus"），就返回 null，调用方再用默认值。
// 容易看不懂的点：
//   单位表里 ns 是 1e-6 毫秒（1 纳秒 = 0.000001 毫秒），
//   us / µs / μs 都是微秒（注意有两个长得很像的 μ，一个是希腊字母，一个是微符号），
//   都是 0.001 毫秒。
// parseDuration(raw)
// 干什么：把 Go 的时间字符串（"90s"、"120m"、"2h"、"1h30m"、"300ms"、"1ns"）
// 转成 JS 能直接用的毫秒数（Number）。
// 入参：raw —— 字符串，例如 "90s"；返回值：毫秒数，解析失败返回 null。
// Go 原来的写法：time.ParseDuration("90s") 返回 (time.Duration, error)，
// time.Duration 本质是 int64，单位是纳秒；代码里常写 30 * time.Second 这种
// “数字 × 单位常量”的形式，环境变量里传进来的却是字符串，要先解析。
// 为什么用毫秒：JS 的 setTimeout / Date 都用毫秒，1 秒 = 1000 毫秒，
// 1 分钟 = 60000 毫秒，1 小时 = 3600000 毫秒，这里统一换算成毫秒。
// 容易看不懂的点：
// 正则一次可以匹配多段（"1h30m" 是 1 小时 + 30 分钟），
// 最后用 matched!== text 判断整串是否都被消耗掉，
// 只要有一段对不上（例如 "bogus"），就返回 null，调用方再用默认值。
// 单位表里 ns 是 1e-6 毫秒（1 纳秒 = 0.000001 毫秒），
// us / µs / μs 都是微秒（注意有两个长得很像的 μ，一个是希腊字母，一个是微符号），
// 都是 0.001 毫秒。
function parseDuration(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  const text = raw.trim();
  if (text === "0") {
    return 0;
  }
  // Go 的写法是一串“数字+单位”，例如 "1h30m"、"90s"、"1500ms"。
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/g;
  const unitToMs = {
    ns: 1e-6,
    us: 0.001,
    µs: 0.001,
    μs: 0.001,
    ms: 1,
    s: 1000,
    m: 60000,
    h: 3600000,
  };
  let total = 0;
  let matched = "";
  let m;
  while ((m = re.exec(text)) !== null) {
    matched += m[0];
    total += Number(m[1]) * unitToMs[m[2]];
  }
  if (matched !== text) {
    return null;
  }
  return total;
}

// parseBool：对应 Go 的 strconv.ParseBool，接受 "true/false/1/0/t/f" 等。
// 解析失败返回 null。
function parseBool(raw) {
  const v = String(raw).trim().toLowerCase();
  if (["1", "t", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "f", "false", "no", "n", "off"].includes(v)) return false;
  return null;
}

// parseFlags：对应 Go 的 flag 包（flag.String / Int / Duration / Bool + flag.Parse()）。
// defs 的每一项是 { name, type: 'string'|'int'|'duration'|'bool', defaultValue}。
// 返回 { flags: {名字: 值}, positional: [位置参数]}。
// 支持 -name value、-name=value、--name value、--name=value；
// 布尔型 flag 不带值时表示 true（Go 的 flag.Bool 也是这样）。
// parseFlags(argv, defs)
// 干什么：解析命令行参数，例如把 ["-role", "worker", "--addr=:8090"]
// 变成 { flags: { role: "worker", addr: ":8090",...}, positional: []}。
// 入参：argv —— 字符串数组，一般是 process.argv.slice(2)（去掉 node 和脚本名之后的部分）；
// defs —— 参数定义表，每一项是 { name, type, defaultValue}，
// type 只能是 'string' | 'int' | 'duration' | 'bool'，
// 和 Go 的 flag.String / flag.Int / flag.Duration / flag.Bool 一一对应。
// 返回值：{ flags, positional}；flags 是“参数名 → 解析后的值”，
// positional 是不带横线的位置参数（例如 -cli-action 后面多余的 "extra"，
// Go 里用 flag.NArg() 数它，main() 发现它不为 0 就会 log.Fatal）。
// Go 原来的写法：
// addr:= flag.String("addr", "", "HTTP listen address;...") // 定义，返回 *string 指针
// flag.Parse() // 真正开始解析
// *addr // 用 *addr 取值
// 和 JS 的区别：Go 的 flag.String 返回的是指针，用的时候要加 * 解引用；
// JS 没有指针，这里直接把解析结果放进一个普通对象，用 flags.addr 取值。
// 为什么这样写：
// 先按定义表填好默认值（Go 里 flag.String 的第 2 个参数就是默认值），
// 再逐个处理 argv：遇到 "-name=value" 就按 = 拆开；遇到 "-name value" 就吃掉下一个元素当值；
// 布尔型 flag 不带值时直接当 true（Go 的 flag.Bool 也是这样，写 -browser-image 就够了）。
// 遇到没定义过的参数就 throw，对应 Go 的 flag 包遇到未知参数时打印用法并退出（exit 2）。
// 容易看不懂的点：
// arg.replace(/^-+/, '') 是把一个或两个横线都去掉，所以 -role 和 --role 都能用；
// convert() 里按 type 分别转：int 用 parseInt，duration 调 parseDuration，
// 布尔值调 parseBool，字符串原样返回。
function parseFlags(argv, defs) {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const flags = {};
  for (const d of defs) {
    flags[d.name] = d.defaultValue;
  }
  const positional = [];
  const convert = (def, raw) => {
    if (def.type === "int") {
      const n = Number.parseInt(raw, 10);
      if (Number.isNaN(n))
        throw new Error(`invalid value "${raw}" for flag -${def.name}`);
      return n;
    }
    if (def.type === "bool") {
      const b = parseBool(raw);
      if (b === null)
        throw new Error(`invalid value "${raw}" for flag -${def.name}`);
      return b;
    }
    if (def.type === "duration") {
      const ms = parseDuration(raw);
      if (ms === null)
        throw new Error(`invalid value "${raw}" for flag -${def.name}`);
      return ms;
    }
    return raw;
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    arg = arg.replace(/^-+/, "");
    let name = arg;
    let value;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      name = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    }
    const def = byName.get(name);
    if (!def) {
      throw new Error(`flag provided but not defined: -${name}`);
    }
    if (value === undefined) {
      if (def.type === "bool") {
        flags[name] = true;
        continue;
      }
      i += 1;
      if (i >= argv.length) {
        throw new Error(`flag needs an argument: -${name}`);
      }
      value = argv[i];
    }
    flags[name] = convert(def, value);
  }
  return { flags, positional };
}

// ---------- loadDotEnv ----------

// loadDotEnv：从找到的第一个.env 文件加载 KEY=VALUE。
// 查找顺序：当前工作目录以及往上三级父目录（所以在子目录里运行也能找到项目根目录），
// 再到可执行文件所在目录。已有的环境变量优先，永远不会被覆盖。
// loadDotEnv()
// 干什么：启动时自动读.env 文件，把里面的配置写进环境变量，
// 这样不用每次启动都手动 export 一大堆 AGENTFLOW_ 开头的变量。
// 入参：无（读的是当前工作目录和可执行文件位置）；返回值：无。
// 查找顺序（和 Go 完全一致）：
// 1. 当前工作目录，以及往上三级父目录——一共 4 个候选，
// 所以在子目录里运行也能找到项目根目录的.env；
// 2. 可执行文件所在目录。
// 为什么“找到第一个就 return”：Go 的 for 循环里读到文件就处理完直接 return，
// 只加载一个.env，不会把多个.env 合并。
// 为什么“已有的环境变量优先”：
// Go：if k!= "" && os.Getenv(k) == "" { os.Setenv(k, v)}
// 意思是只有环境变量里还没有这个 key 时才写进去，
// 这样你在命令行 export 过的值永远不会被.env 文件覆盖。
// 逐行逻辑：
// 空行和 # 开头的注释行跳过；开头的 "export " 去掉（兼容 export KEY=VALUE 的写法）；
// 按第一个 = 切成 key 和 value；value 两边的空格和引号去掉；
// 没有 = 的行跳过（Go 用 strings.Cut，ok 为 false 时 continue）。
// Go 用 os.Executable() 拿当前可执行文件的位置；
// JS 里用 process.execPath 近似，但 node 运行时 execPath 是 node 本身的位置，
// 不是本程序的位置，对“读懂查找顺序”这个学习目标没有影响。
function loadDotEnv() {
  const candidates = [];
  const cwd = process.cwd();
  let dir = cwd;
  for (let i = 0; i < 4; i++) {
    candidates.push(path.join(dir, ".env"));
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  // Go：os.Executable() 是当前可执行文件；JS 里用 process.execPath 近似。
  candidates.push(path.join(path.dirname(process.execPath), ".env"));
  for (const p of candidates) {
    let content;
    try {
      content = fs.readFileSync(p, "utf8");
    } catch {
      continue; // Go：err!= nil 时 continue，换下一个候选
    }
    for (const rawLine of content.split("\n")) {
      let line = rawLine.trim();
      if (line === "" || line.startsWith("#")) {
        continue;
      }
      line = line.replace(/^export\s+/, "");
      const eq = line.indexOf("=");
      if (eq === -1) {
        continue;
      }
      const k = line.slice(0, eq).trim();
      const v = line
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      if (k !== "" && !process.env[k]) {
        process.env[k] = v;
      }
    }
    return;
  }
}

// ---------- main ----------

// main：程序入口，对应 Go 的 func main()。
// 流程按 Go 原样翻译：
// 1. 先看是不是 MCP / Git 助手子命令，是就处理完直接返回；
// 2. 解析命令行参数，加载.env；
// 3. --browser-image：只构建浏览器镜像并退出；
// 4. 检查 AGENTFLOW_SESSION_SECRET；
// 5. --cli-action：只做 CLI 管理，跑完就退出，不启动服务；
// 6. 解析 role、解析工作区根目录、打开 MySQL、创建引擎；
// 7. 配好执行、认领、维护等后台循环；
// 8. 按 role 分 worker / api 两条路建 HTTP 服务；
// 9. 启动信号处理 goroutine：SIGINT / SIGTERM 优雅停机，
// SIGHUP 把监听器交接给新进程；
// 10. 开始 Serve，等停机完成。
// 第 6 步开始就会碰到（repo.Open 等），所以这个 main()
// 在 JS 里跑起来会 throw 桩错误。它是用来读流程的，不是用来启动服务的。
// main(argv)
// 干什么：程序入口，对应 Go 的 func main()，整个后端从这里启动。
// 入参：argv —— 命令行参数数组，默认是 process.argv.slice(2)
// （Go 里是 os.Args[1:]，即去掉程序名之后的部分）；
// 返回值：Promise，正常跑完 resolve，致命错误时 fatal() 直接退出进程。
// 流程按 Go 原样翻译，一共 10 步（每一步在函数体里都有对应注释）：
// 1. 先看是不是 MCP / Git 助手子命令，是就处理完直接返回；
// 2. 解析命令行参数，加载.env；
// 3. --browser-image：只构建浏览器镜像并退出；
// 4. 检查 AGENTFLOW_SESSION_SECRET，没有就 log.Fatal；
// 5. --cli-action：只做 CLI 管理，跑完就退出，不启动服务；
// 6. 解析 role、解析工作区根目录、打开 MySQL、创建引擎；
// 7. 配好执行、认领、维护等后台循环；
// 8. 按 role 分 worker / api 两条路建 HTTP 服务；
// 9. 启动信号处理：SIGINT / SIGTERM 优雅停机，SIGHUP 把监听器交接给新进程；
// 10. 开始 Serve，等停机完成。
// Go 里容易看不懂的点：
// - log.Fatal / log.Fatalf：打印后直接退出进程（exit 1），不走 defer，
// JS 里用 fatal() 实现：console.error 后 process.exit(1)。
// - signal.NotifyContext / context.WithCancel：Go 用 context 在各个后台循环之间
// 传递“取消”信号；JS 里用 AbortController / AbortSignal 代替，
// 下面凡是写 controller 的地方，都是在翻译 Go 的 context。
// - go func() {...}()：Go 的 goroutine，后台跑，不等它结束；
// JS 里对应的是直接调用一个 async 函数而不 await，或者用 process.on 注册回调。
// 第 6 步开始就会碰到（repo.Open 等），所以这个 main()
// 在 JS 里跑起来会 throw 桩错误。它是用来读流程的，不是用来启动服务的。
// 想看完整流程请直接读 Go 的 main.go；函数体里也把第 6 步之后的骨架
// 用注释写下来了，顺序和 Go 完全一致。
async function main(argv = process.argv.slice(2)) {
  // Go：if runtime.RunMCPCallCLI(os.Args[1:]) { return}
  if (runtimeStub.runMCPCallCLI(argv)) {
    return;
  }
  // Go：if runtime.RunGitHelperCLI(os.Args[1:]) { return}
  if (runtimeStub.runGitHelperCLI(argv)) {
    return;
  }

  // Go：flag.String / Int / Duration / Bool 定义的全部参数。
  // 注意 worker-concurrency 默认 8，cli-timeout 默认 80 分钟（换算成毫秒）。
  const { flags, positional } = parseFlags(argv, [
    { name: "addr", type: "string", defaultValue: "" },
    { name: "workspaces", type: "string", defaultValue: "" },
    { name: "worker-concurrency", type: "int", defaultValue: 8 },
    { name: "basic-user", type: "string", defaultValue: "" },
    { name: "basic-pass", type: "string", defaultValue: "" },
    { name: "mcp-token", type: "string", defaultValue: "" },
    { name: "tls-cert", type: "string", defaultValue: "" },
    { name: "tls-key", type: "string", defaultValue: "" },
    { name: "mysql-dsn", type: "string", defaultValue: "" },
    { name: "role", type: "string", defaultValue: "" },
    { name: "cli-action", type: "string", defaultValue: "" },
    { name: "cli-provider", type: "string", defaultValue: "" },
    { name: "cli-timeout", type: "duration", defaultValue: 80 * 60 * 1000 },
    { name: "browser-image", type: "bool", defaultValue: false },
  ]);
  loadDotEnv();

  if (flags["browser-image"]) {
    const controller = new AbortController();
    const onSignal = () => controller.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      const image = await runtimeStub.ensureBrowserImage(controller.signal);
      console.log(image);
    } catch (err) {
      fatal(err.message);
    }
    return;
  }

  if (!process.env.AGENTFLOW_SESSION_SECRET && flags["cli-action"] === "") {
    fatal(
      "AGENTFLOW_SESSION_SECRET is required; generate with openssl rand -hex 32",
    );
  }
  if (!process.env.AGENTFLOW_AUTH_REQUIRED) {
    process.env.AGENTFLOW_AUTH_REQUIRED = "true";
  }

  if (flags["cli-action"] !== "" || flags["cli-provider"] !== "") {
    if (positional.length !== 0) {
      fatal("CLI administration does not accept positional arguments");
    }
    const controller = new AbortController();
    const onSignal = () => controller.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      await runCLI(
        { signal: controller.signal },
        flags["cli-action"],
        flags["cli-provider"],
        flags["cli-timeout"],
        process.stdout,
      );
    } catch (err) {
      fatal(err.message);
    }
    return;
  }

  const role = resolveRole(flags.role);
  const root = resolveWorkspaceRoot(flags.workspaces);
  try {
    runtimeStub.setRepositoryCacheRoot(root);
  } catch (err) {
    console.log(`repository cache disabled: ${err.message}`);
  }

  // 从这里开始是真实后端逻辑：打开 MySQL、创建引擎、配执行、建 HTTP 服务、
  // 启动认领循环、处理信号与优雅停机。JS 对照版把每一步的顺序和关键判断
  // 都按 Go 原样写下来，但调用的都是上面定义的桩，所以会在 repoStub.open() 处 throw。
  // 想看完整流程请直接读 Go 的 main.go；下面是它在 JS 里的骨架：
  //
  // const s = repoStub.open(flags['mysql-dsn'].trim());
  // const e = engineStub.create();
  // const instanceID =...; const leaseTTL =...; // 默认 30 秒，可用环境变量改
  // const executeRuns = role!== 'api'; // role=all 时还能用环境变量改
  // e.ConfigureExecution(instanceID, host, leaseTTL, executeRuns);
  // e.ConfigureCloudRunnerPool({ Label, Projects, Required});
  // attachPreviewStore(e, s);
  // const endpoints = config.LoadEndpoints(role, flags.addr); // 解析监听地址等
  // const { listener: mainLn, inherited} = await listenMain(endpoints.ListenAddr);
  // if (role === 'worker') { /* 只留健康检查 + 内部接口，见 workerHandler() */}
  // else { /* Gin 主服务 + agent tool gateway，见 handoverStatus */}
  // e.StartMaintenance(claimCtx);
  // if (executeRuns) e.StartClaimLoop(claimCtx); // 每 2 秒认领一次 Run
  // const stopCLIUpdates = startManagedCLIUpdates(claimCtx, role, executeRuns);
  // // 信号处理：SIGINT/SIGTERM → 停认领、排空本地 Run、停 HTTP；
  // // SIGHUP（仅非 worker）→ handover(mainLn, handoverReadyTimeout)，把监听器交给新进程。
  // signalReady(readyStatus);
  // await serve(); // srv.Serve(mainLn)，出错且不是正常关闭就 log.Fatal
  throw stubError("repo.Open（main() 从打开 MySQL 开始的真实启动流程）");
}

// ---------- resolveDrainTimeout ----------

// resolveDrainTimeout：停机或交接时，最多等本地 Run 和进行中任务多久。
// 默认 120 分钟；环境变量 AGENTFLOW_DRAIN_TIMEOUT 能改，非法值就用默认值。
// Go 里它在 main.go 底部，handover_test.go 也测它，所以这里导出给测试用。
// resolveDrainTimeout()
// 干什么：停机或交接时，最多等本地 Run 和进行中任务多久。
// 入参：无（读环境变量 AGENTFLOW_DRAIN_TIMEOUT）；
// 返回值：毫秒数（Number）。
// 默认 120 分钟；环境变量能改，非法值（例如 "bogus"）就用默认值。
// Go 原来的写法：
// drainTimeout:= 120 * time.Minute
// if raw:= strings.TrimSpace(os.Getenv("AGENTFLOW_DRAIN_TIMEOUT")); raw!= "" {
// if parsed, parseErr:= time.ParseDuration(raw); parseErr == nil && parsed > 0 {
// drainTimeout = parsed
//}
//}
// 注意 Go 里“解析失败或 <= 0”时是悄悄用默认值，不报错；
// 而 main() 里解析 AGENTFLOW_RUN_LEASE_TTL 失败时是 log.Fatalf 直接退出，
// 两处处理不一样，别混了。
// Go 里它在 main.go 底部，handover_test.go 也测它，所以这里导出给测试用。
function resolveDrainTimeout() {
  const defaultTimeoutMs = 120 * 60 * 1000; // Go：120 * time.Minute
  const raw = (process.env.AGENTFLOW_DRAIN_TIMEOUT || "").trim();
  if (raw !== "") {
    const parsed = parseDuration(raw);
    if (parsed !== null && parsed > 0) {
      return parsed;
    }
  }
  return defaultTimeoutMs;
}

// ---------- startManagedCLIUpdates ----------

// startManagedCLIUpdates：启动托管 CLI 的后台更新，返回停止函数。
// 满足三个条件才真的启动：要执行 Run、角色是 worker 或 all、
// 环境变量 AGENTFLOW_MANAGED_CLI_ROOT 不为空。
// 不满足时返回一个什么都不做的空函数（Go：return func() {}）。
// 注意：personal runner（个人 Runner）和纯 API 进程不会被自动拉进更新。
// startManagedCLIUpdates(ctx, role, executeRuns)
// 干什么：启动托管 CLI 的后台更新，返回一个停止函数，调用方在停机时调它。
// 入参：ctx —— { signal}（Go：context.Context）；
// role —— 进程角色，"api" | "worker" | "all"；
// executeRuns —— 本进程是否执行 Run（布尔值）。
// 返回值：一个 () => {} 形式的停止函数。
// 满足三个条件才真的启动，缺一个都不启动：
// 1. executeRuns 为 true（要执行 Run 的进程才需要更新 CLI）；
// 2. 角色是 worker 或 all（纯 API 进程不参与）；
// 3. 环境变量 AGENTFLOW_MANAGED_CLI_ROOT 不为空（没配根目录就不知道去哪更新）。
// 不满足时返回一个什么都不做的空函数（Go：return func() {}），
// 调用方照样可以调它停机，不用先判断“到底有没有启动”。
// 为什么注释里写“不要推断根目录”：Go 的注释说 Never infer a root，
// 意思是根目录必须由环境变量明确给出，不能猜一个默认路径，
// 也不能把个人 Runner / 纯 API 进程自动拉进更新。
// 真的启动时调的是 managedcliStub.start()，它会 throw 桩错误，
// 因为 managedcli 是 Go 的 internal/managedcli 包，JS 里没有真实实现。
function startManagedCLIUpdates(ctx, role, executeRuns) {
  const root = (process.env.AGENTFLOW_MANAGED_CLI_ROOT || "").trim();
  if (!executeRuns || (role !== "worker" && role !== "all") || root === "") {
    return () => {};
  }
  return managedcliStub.start(ctx, root);
}

// ---------- workerHandler ----------

// workerHandler：worker 角色的 HTTP 处理器。
// Go 里用 http.NewServeMux，只挂三个接口：
// GET /api/health 健康检查，返回 activeRuns
// POST /internal/runs/{id}/interrupt 中断某个 Run
// POST /internal/workspace-checkpoint 工作区检查点
// JS 里返回一个 (req, res) => {} 形式的处理器，路由用 if 判断，
// 和 Go 的 mux.HandleFunc 一一对应。
// workerHandler(engine)
// 干什么：给 worker 角色做一个只留三个接口的 HTTP 处理器。
// 入参：engine —— 引擎对象（Go：*engine.Engine）；
// 返回值：一个 (req, res) => {} 形式的处理器，Node 的 http.createServer 能直接用。
// Go 原来的写法：
// mux:= http.NewServeMux()
// mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {...})
// mux.HandleFunc("POST /internal/runs/{id}/interrupt", e.HandleRunInterrupt)
// mux.HandleFunc("POST /internal/workspace-checkpoint", e.HandleWorkspaceCheckpoint)
// Go 1.22 之后 HandleFunc 的模式串可以带方法和路径参数（"POST /internal/runs/{id}/interrupt"）；
// JS 没有这种路由写法，这里用 if + url.pathname.startsWith / endsWith 手写路由，
// 和 Go 的三条路由一一对应。
// 三个接口：
// GET /api/health —— 健康检查，返回 {"status":"ok","role":"worker","activeRuns":N}；
// POST /internal/runs/{id}/interrupt —— 中断某个 Run；
// POST /internal/workspace-checkpoint —— 工作区检查点。
// 后两个接口在 JS 里 throw 桩错误，因为它们调的是引擎的真实方法，
// JS 的桩 engine 没有实现；健康检查那条是完整翻译的，
// 只是 activeRuns 在桩 engine 上没有方法时按 0 处理。
function workerHandler(engine) {
  return async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/health") {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("method not allowed");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      // Go：e.ActiveRunCount()；JS 桩的 engine 没有这个方法时按 0 处理。
      const activeRuns =
        typeof engine.activeRunCount === "function"
          ? engine.activeRunCount()
          : 0;
      res.end(`{"status":"ok","role":"worker","activeRuns":${activeRuns}}`);
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname.startsWith("/internal/runs/") &&
      url.pathname.endsWith("/interrupt")
    ) {
      // Go：mux.HandleFunc("POST /internal/runs/{id}/interrupt", e.HandleRunInterrupt)
      throw stubError("engine.HandleRunInterrupt");
    }
    if (
      req.method === "POST" &&
      url.pathname === "/internal/workspace-checkpoint"
    ) {
      // Go：mux.HandleFunc("POST /internal/workspace-checkpoint", e.HandleWorkspaceCheckpoint)
      throw stubError("engine.HandleWorkspaceCheckpoint");
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  };
}

// ---------- resolveRole ----------

// resolveRole：解析进程角色。
// 优先级：命令行 -role 参数 > 环境变量 AGENTFLOW_ROLE > 默认 "all"。
// 只接受 api / worker / all（大小写不敏感，前后空格会去掉），
// 其他值 throw，错误信息和 Go 的 fmt.Errorf 一致。
// resolveRole(override)
// 干什么：解析进程角色，决定本进程是只提供 API、只跑任务，还是两者都做。
// 入参：override —— 命令行 -role 参数的值，可能是 ""（没传）；
// 返回值："api" | "worker" | "all" 其中之一；
// 不合法的值 throw Error，错误信息和 Go 的 fmt.Errorf 一致。
// 优先级：命令行 -role 参数 > 环境变量 AGENTFLOW_ROLE > 默认 "all"。
// Go 原来的写法：
// role:= strings.ToLower(strings.TrimSpace(override))
// if role == "" { role = strings.ToLower(strings.TrimSpace(os.Getenv("AGENTFLOW_ROLE")))}
// if role == "" { role = "all"}
// switch role { case "api", "worker", "all": return role, nil; default: return "", fmt.Errorf(...)}
// 注意 Go 返回的是 (string, error) 两个值，调用方写 role, err:= resolveRole(...)；
// JS 没有多返回值，这里成功就 return 字符串，失败就 throw，
// 调用方用 try/catch 接，和 Go 的 if err!= nil 一个意思。
// 容易看不懂的点：
// 先 ToLower 再 TrimSpace，所以 "API"、" Api " 都能认出来；
// 报错信息里放的是处理过的 role（已转小写、去空格），不是原始的 override。
function resolveRole(override) {
  let role = (override || "").toLowerCase().trim();
  if (role === "") {
    role = (process.env.AGENTFLOW_ROLE || "").toLowerCase().trim();
  }
  if (role === "") {
    role = "all";
  }
  if (role === "api" || role === "worker" || role === "all") {
    return role;
  }
  // Go 原文：return "", fmt.Errorf("invalid role %q (want api, worker, or all)", role)
  // 注意 %q 里放的是处理过的 role（已转小写、去空格），不是原始的 override。
  throw new Error(`invalid role "${role}" (want api, worker, or all)`);
}

// ---------- resolveWorkspaceRoot ----------

// resolveWorkspaceRoot：解析沙箱工作区的根目录。
// 有 -workspaces 参数就用它；否则默认是用户家目录下的.agentflow/workspace。
// Go：filepath.Join(home, ".agentflow", "workspace")；
// JS：path.join(os.homedir(), '.agentflow', 'workspace')。
// resolveWorkspaceRoot(override)
// 干什么：解析沙箱工作区的根目录，即 Runner 在本机检出代码、跑任务的目录。
// 入参：override —— 命令行 -workspaces 参数的值，可能是 ""（没传）；
// 返回值：一个绝对路径字符串；家目录取不到或为空时 throw。
// 优先级：有 -workspaces 参数就用它；否则默认是用户家目录下的.agentflow/workspace。
// Go 原来的写法：
// home, err:= os.UserHomeDir() // 可能失败，所以返回 (string, error)
// return filepath.Join(home, ".agentflow", "workspace"), nil
// filepath.Join 会按操作系统拼路径，Linux 上是 /home/xxx/.agentflow/workspace；
// JS 里用 path.join(os.homedir(), '.agentflow', 'workspace')，作用完全一样。
// Go 里这个函数返回 (string, error)，JS 里成功 return 字符串、失败 throw，
// 和 resolveRole 是一样的翻译手法。
function resolveWorkspaceRoot(override) {
  const root = (override || "").trim();
  if (root !== "") {
    return root;
  }
  const home = os.homedir();
  if (!home || home.trim() === "") {
    throw new Error(
      "resolve default sandbox workspace root: user home is empty",
    );
  }
  return path.join(home, ".agentflow", "workspace");
}

// ---------- attachPreviewStore ----------

// attachPreviewStore：给引擎接上预览（preview）存储。
// Go 里读预览配置、创建 preview.Service 并交给引擎；
// JS 里只保留调用形状，不做真实配置加载。
// attachPreviewStore(engine, store)
// 干什么：给引擎接上预览（preview）存储，让 Run 产出的预览页面能通过
// /preview/{token}/ 这样的地址被访问到。
// 入参：engine —— 引擎对象（Go：*engine.Engine）；store —— 数据存储（Go：*repo.Store）；
// 返回值：无。
// Go 原来的写法：
// cfg:= preview.LoadConfig() // 读预览配置
// e.SetPreview(preview.NewService(s, preview.NewDBStore(s), cfg)) // 建服务并交给引擎
// 再按 cfg.PublicHost 是否为空打一条日志，告诉你预览网关的公开地址。
// JS 里只保留调用形状，不做真实配置加载，调用就会 throw 桩错误，
// 因为 preview 是 Go 的 internal/preview 包，JS 里没有真实实现。
function attachPreviewStore(_engine, _store) {
  throw stubError(
    "preview.LoadConfig / preview.NewService（attachPreviewStore）",
  );
}

// 只在直接用 node 运行本文件时才执行 main()（Go 里程序启动就会跑 main）。
// 平时被测试 require 进来时不会执行。
if (require.main === module) {
  main().catch((err) => fatal(err.message));
}

module.exports = {
  main,
  fatal,
  parseDuration,
  parseBool,
  parseFlags,
  loadDotEnv,
  resolveDrainTimeout,
  startManagedCLIUpdates,
  workerHandler,
  resolveRole,
  resolveWorkspaceRoot,
  attachPreviewStore,
  repoStub,
  engineStub,
  runtimeStub,
  managedcliStub,
  httpServerStub: http.createServer,
};
