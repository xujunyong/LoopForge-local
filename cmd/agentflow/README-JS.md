# cmd/agentflow 的 JS 对照翻译（学习用）

这些 `.js` 文件是 Go 源文件的 1:1 对照翻译，只为方便并排读懂 Go 代码，**不是可运行的后端**。函数名、顺序、参数名与 Go 文件一致；Go 的多返回值译为成功 return、失败 throw，`time.Duration` 译为毫秒数，`context` 译为 `AbortSignal`，`goroutine` / `channel` 译为 Promise。

| JS 文件 | 对应的 Go 文件 |
|---|---|
| `main.js` | `main.go` |
| `cli.js` | `cli.go` |
| `handover.js` | `handover.go` |
| `main.test.js` | `main_test.go` |
| `handover.test.js` | `handover_test.go` |

Go 文件里 import 的内部包（如 `internal/managedcli`、`internal/repo`、`internal/engine`）在 JS 里只写成指向对应未来 JS 文件的 `require`，**没有在此实现**；等那些包转写完再补全。在此之前，调用 `main()` / `runCLI()` 等用到它们的函数会报找不到模块；不依赖内部包的纯函数（如 `resolveRole`、`resolveDrainTimeout`、`listenMain`）及其测试仍能跑。

纯 JavaScript，无 TypeScript；注释为简体中文，只在 Go 语法与 JS 不同处作简短说明。
