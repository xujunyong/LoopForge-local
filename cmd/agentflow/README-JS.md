# cmd/agentflow 的 JS 对照翻译（学习用）

> 这些 `.js` 文件是给人读的对照翻译，**不是可运行的 Go 后端替代品**。
> 不要用 `node main.js` 去启动服务——它跑到打开 MySQL 那一步就会抛错误，
> 这是特意保留的。正确用法是：左边打开 Go 文件，右边打开对应的 JS 文件，并排着读。

## 文件对照表

| JS 文件 | 对应的 Go 文件 | 讲什么 |
|---|---|---|
| `main.js` | `main.go`（422 行） | 程序入口：解析参数、读 `.env`、打开 MySQL、创建引擎、建 HTTP 服务、处理信号与优雅停机 |
| `cli.js` | `cli.go`（55 行） | `-cli-action`：本地托管 CLI 的管理操作（status / update / rollback），跑完就退出 |
| `handover.js` | `handover.go`（188 行） | 热重载：SIGHUP 时把监听 socket 交给新进程，通知 systemd，排空老进程 |
| `main.test.js` | `main_test.go` | 上面 `main.js` / `cli.js` 里能测的纯函数的测试 |
| `handover.test.js` | `handover_test.go` | 上面 `handover.js` 里能测的纯函数的测试 |

## 怎么读

1. 先读 `main.js` 的 `main()` 函数：它按 Go 原样列了启动的 10 步，
每一步都有注释，告诉你这一步在 Go 里调的是哪个包。
2. 再读 `handover.js`：它是 main 里最难的一块——
一个进程怎么把正在监听的 socket 交给另一个进程而不中断服务。
3. 最后读 `cli.js`：最短，只有 55 行 Go，对应一个独立的小功能，
适合用来对照“Go 的 context / error 是怎么翻译成 JS 的”。

每个函数的注释都写在代码旁边，讲清楚四件事：这个函数是干什么的、
入参和返回值是什么、Go 里对应的写法原来长什么样、
容易看不懂的逻辑和被占位/简化的地方。不要只读这份 README，
注释跟着代码走，README 不能代替代码里的注释。

## Go 概念 → JS 对照总表

| Go 的写法 | JS 里怎么写 | 说明 |
|---|---|---|
| `struct{...}`（例如 `http.Server{...}`） | 普通对象字面量 `{...}` | 字段名保持原样 |
| `(值, error)` 多返回值 | 成功 `return 值`，失败 `throw Error` | 调用方用 `try/catch` 接，相当于 Go 的 `if err!= nil` |
| `flag.String / Int / Duration / Bool` + `flag.Parse()` | `parseFlags()`（`main.js`） | Go 返回的是指针，用 `*addr` 取值；JS 直接放进对象，用 `flags.addr` 取值 |
| `time.Duration`（纳秒整数） | 毫秒数（`Number`） | `time.ParseDuration("90s")` → `parseDuration("90s")` 返回 `90000` |
| `context.Context`（取消 / 超时） | `AbortSignal` + `AbortController` | `context.WithTimeout` → `setTimeout` 后 `controller.abort()`；`ctx.Err()` → 检查 `signal.aborted` |
| `goroutine`（`go func(){...}()`） | 直接调用 async 函数而不 `await`，或 `process.on` 注册回调 | 后台跑，不等它结束 |
| `channel`（`chan struct{}`、select 三选一） | `Promise` + `Promise.race` | `predecessorExited()` 返回 `Promise`，`handover()` 用 `Promise.race` 等 ready / exited / 超时 |
| `log.Fatal / log.Fatalf` | `fatal()`（`main.js`） | 打印后 `process.exit(1)`，不走清理，和 Go 一样 |
| `os.Getenv / os.Setenv` | `process.env` 读 / 写 | `os.Unsetenv` → `delete process.env.xxx` |
| `signal.Notify(SIGINT/SIGTERM/SIGHUP)` | `process.on('SIGINT' / 'SIGTERM' / 'SIGHUP',...)` | 信号名一样 |
| `net.Listener` / `net.Server` | Node 的 `net.Server` | 见下面“无法照搬的地方” |
| `json.NewEncoder(w).Encode(v)` | `stdout.write(JSON.stringify(v) + "\n")` | `stdout` 是任何带 `write(string)` 方法的对象 |

## Go 特有基础设施是怎么处理的

下面这些在 JS 里没有真实实现，统一用带标记的占位对象或 `throw` 代替，
**不会悄悄假装能跑**，在代码里搜 `` 就能找到全部：

- `repo`（MySQL + gorm）、`engine`（SOP 引擎）、`httpapi`（Gin 路由 + 后台任务）、
`config`、`runtime`（执行器 / 沙箱 / MCP CLI）、`notification`、`preview`、
`tracker`、`managedcli`、Gin 本身。
- `main()` 的主流程按 Go 原样翻译，但跑到第一处桩（`repo.Open`）就会 throw，
它帮你读懂“启动时按什么顺序做了什么”，而不是假装能启动服务。
- `handover()` 的 fd 继承：Go 把监听 socket 以 `ExtraFiles` 的 fd 3 传给后继进程，
就绪管道是 fd 4；Node 没有把“已打开的文件描述符直接变成 net.Server”的公开等价物，
所以 `inheritedListener()` 只保留了校验逻辑，`handover()` 只保留了
“启动后继进程、等就绪、超时杀掉”的控制流，fd 交接本身用普通管道近似。
- `signalReady()` / `sdNotify()`：Go 用 `net.DialUnix("unixgram")`；
  Node 的 dgram 只支持 udp4 / udp6，没有 unix 数据报 socket 的公开 API，
  所以发送那一步是【桩】，报文格式由 `buildSdNotifyPayload()` 负责，
  测试验证的就是报文格式和“没有 NOTIFY_SOCKET 时是空操作”。
- `loadDotEnv()` 里找可执行文件目录那一步：Go 用 `os.Executable()`，
JS 用 `process.execPath` 近似（node 运行时它是 node 本身的位置），
对“读懂查找顺序”没有影响。
- `parseFlags()` 是手写的 Go flag 包近似实现，不是 Node 的第三方库，
这样你能直接看到 Go 的 flag 是怎么解析 `-role worker` / `--addr=:8090` 的。

## 测试怎么跑

在 `cmd/agentflow/` 目录下：

```bash
node --test main.test.js handover.test.js
```

也可以先只检查语法，不跑测试：

```bash
node --check main.js
node --check cli.js
node --check handover.js
node --check main.test.js
node --check handover.test.js
```

### 哪些 Go 测试没有照搬，为什么

- `TestCLIAdminExitsBeforeServices`（`main_test.go`）：
Go 版是把测试二进制自己当子进程跑，验证 `main()` 在 `-cli-action` 下提前退出；
JS 对照版的 `main()` 是桩，没有真实可执行的二进制可以这样测，所以跳过，
`runCLI` 本身的校验逻辑由 `main.test.js` 里的 `runCLI` 测试覆盖。
- `TestCLIAdmin` 里依赖真实 `managedcli` 的用例（例如 rollback "codex" 报
"no previous managed version"、update 超时报 "context deadline exceeded"）：
测试里用注入的假 `managedcli` 覆盖同样的校验分支，真实 update / rollback
的行为不在翻译范围内。
- `TestHandoverHelperProcess` / `TestHandoverPassesListenerAndDrainsPredecessor` /
`TestHandoverKeepsServingWhenSuccessorNeverReady`（`handover_test.go`）：
需要真的把监听 socket 以 fd 继承的方式交给子进程，JS 里没有等价做法，所以跳过；
- `TestManagedCLIShutdown`：不满足启动条件时验证 stop 是空函数且调两次不卡住；
  满足启动条件的那几组验证“守卫条件放行后确实走到了桩的 `managedcli.start()`”，
  Go 原版则会真的启动一个更新器再停掉它。

## 注意事项

- 纯 JavaScript，没有 TypeScript；注释和说明都是简体中文。
- 不要修改任何 `.go` 文件；这些 `.js` 文件和 Go 源文件放一起只是为了方便并排读，
不是要替代它们。
- 如果 Go 文件以后改了，对应的 JS 文件也要跟着改，否则两边会对不上。
改的时候先改 Go，再改 JS，注释里写清楚改了哪一段。
