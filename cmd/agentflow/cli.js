// cli.js —— 对应 Go 文件：cmd/agentflow/cli.go
// 学习用 JS 对照翻译，不是可运行的 Go 后端替代品。
// 只用纯 JavaScript，不用 TypeScript。函数名、流程顺序尽量贴近原 Go 文件。
//
// Go → JS 对照（本文件用到的）：
// - context.Context（含超时 / 取消）→ AbortSignal + AbortController
// （runCLI 的第 1 个参数 ctx 是一个 { signal} 对象，signal 是 AbortSignal；
// 传 null 表示 Go 里 context.Background()）
// - (值, error) 多返回值 → 有错就 throw Error，没错就正常返回 / resolve
// - time.Duration（纳秒整数）→ 毫秒数（Number）；Go 测试里的 time.Nanosecond
// 在 JS 测试里写成 0.000001，见 main.test.js 的注释
// - io.Writer + json.NewEncoder(w).Encode(v) → 任何带 write(string) 方法的对象，
// 写 JSON.stringify(v) + "\n"
// - fmt.Errorf → new Error(...)；errors.Is(err, context.Canceled) 这类判断
// 在 JS 里用 error.message 里是否包含 "context canceled" / "context deadline exceeded" 来近似

"use strict";

// managedcli 是 Go 的 internal/managedcli 包：
// 真正负责读 CLI 管理状态、创建管理器、执行 update / rollback。
// 这里只保留 runCLI 用到的三个方法形状，默认实现返回空状态 / 抛错误，
// 供测试注入假实现（见 runCLI 的第 6 个参数 deps）。
const stubManagedcli = {
  // 对应 managedcli.ReadState(root)：读管理状态。
  async readState(_root) {
    return {};
  },
  // 对应 managedcli.NewManager(root)：创建管理器。
  async newManager(_root) {
    return {
      // 对应 manager.Rollback(ctx, provider)
      async rollback(_signal, _provider) {
        throw new Error(
          "【桩】managedcli 尚未在 JS 对照版里实现，无法真正执行 rollback",
        );
      },
      // 对应 manager.Update(ctx)
      async update(_signal) {
        throw new Error(
          "【桩】managedcli 尚未在 JS 对照版里实现，无法真正执行 update",
        );
      },
    };
  },
};

// runCLI：在打开存储、启动任何平台服务之前运行。
// 负责本地托管 CLI 的管理操作：status（查状态）、update（更新）、rollback（回滚），
// 跑完就退出，不启动服务。
// 参数：
// ctx —— { signal: AbortSignal} 或 null（Go：context.Context）
// action —— "status" | "update" | "rollback"（Go：-cli-action）
// provider —— 只有 rollback 能带（Go：-cli-provider）
// timeoutMs—— 总超时，毫秒（Go：-cli-timeout，time.Duration）
// stdout —— 带 write(string) 方法的对象（Go：io.Writer）
// deps —— 可选，{ managedcli}，测试用它注入假实现；不传就用上面的桩
// runCLI(ctx, action, provider, timeoutMs, stdout, deps)
// 干什么：在打开存储、启动任何平台服务之前，做本地托管 CLI 的管理操作，
// 跑完就退出，不启动服务。对应 Go 的 runCLI，是 -cli-action 的入口。
// 入参：
// ctx —— { signal: AbortSignal} 或 null（Go：context.Context）。
// Go 的 context 既能传取消信号，也能带超时；JS 里用 AbortSignal 代替，
// 传 null 相当于 Go 的 context.Background()（永不取消的根 context）。
// action —— "status" | "update" | "rollback"（Go：-cli-action）；
// status 查状态，update 更新 CLI，rollback 回滚到上一个版本。
// provider —— 只有 rollback 能带（Go：-cli-provider），例如 "codex"；
// 其他动作带了它会直接报错。
// timeoutMs —— 总超时，毫秒（Go：-cli-timeout，time.Duration）；
// Go 测试里常写 time.Nanosecond（1 纳秒），JS 里写成 0.000001 毫秒，见 main.test.js。
// stdout —— 带 write(string) 方法的对象（Go：io.Writer），
// 测试里传一个会攒字符串的假对象，真实运行时传 process.stdout。
// deps —— 可选，{ managedcli}，测试用它注入假实现；不传就用文件顶部的桩。
// 返回值：Promise，成功 resolve，失败 reject 一个 Error。
// Go 原来的写法：
// func runCLI(ctx context.Context, action, provider string,
// timeout time.Duration, stdout io.Writer) error
// Go 返回 error，调用方写 err:= runCLI(...) 后判断；
// JS 是 async 函数，成功就 resolve，失败就 throw，调用方用 try/catch 接。
// 校验顺序（和 Go 完全一致，先校验再干活）：
// 1. AGENTFLOW_MANAGED_CLI_ROOT 为空，或 timeout <= 0 → 报错；
// 2. action 不是 status/update/rollback → 报错；
// 3. 不是 rollback 却带了 provider → 报错；
// 4. ctx 已经取消 → 按 Go 的 ctx.Err() 抛 "context canceled" / "context deadline exceeded"。
// 执行顺序（和 Go 完全一致）：
// status：读状态 → 把状态写成一行 JSON；
// update/rollback：先创建管理器，再执行操作，最后把报告写成一行 JSON，
// 注意 Go 是“先写报告，再返回操作错误”，所以写报告和返回错误是两步，
// 下面代码里 encodeErr 和 err 分开处理就是在翻译这个顺序。
// 超时是怎么做的：
// Go：ctx, cancel:= context.WithTimeout(ctx, timeout)，超时后 ctx.Err() 就是 deadline exceeded；
// JS：用 AbortController + setTimeout(timeoutMs 后 abort)，
// 再用 mergeSignals() 把外面传进来的 signal 和超时 signal 合并成一个。
async function runCLI(ctx, action, provider, timeoutMs, stdout, deps = {}) {
  const managedcli = deps.managedcli || stubManagedcli;
  const root = (process.env.AGENTFLOW_MANAGED_CLI_ROOT || "").trim();
  if (root === "" || timeoutMs <= 0) {
    throw new Error(
      "AGENTFLOW_MANAGED_CLI_ROOT and a positive -cli-timeout are required",
    );
  }
  if (action !== "status" && action !== "update" && action !== "rollback") {
    throw new Error("invalid -cli-action: choose status, update, or rollback");
  }
  if (action !== "rollback" && provider !== "") {
    throw new Error("-cli-provider is only supported with rollback");
  }

  // Go: ctx, cancel:= context.WithTimeout(ctx, timeout)；defer cancel()
  // JS：用 AbortController 做一个 timeoutMs 后自动 abort 的 signal，
  // 再把它和外面传进来的 signal 合并成一个。
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("context deadline exceeded")),
    timeoutMs,
  );
  const signal = mergeSignals(ctx && ctx.signal, controller.signal);
  try {
    // Go：if err:= ctx.Err(); err!= nil { return err}
    // JS：调用时 signal 已经 abort 了，就直接按取消处理。
    throwIfAborted(signal);

    if (action === "status") {
      const state = await managedcli.readState(root);
      stdout.write(`${JSON.stringify(state)}\n`);
      return;
    }

    const manager = await managedcli.newManager(root);
    let report;
    let err = null;
    try {
      // Go：manager.Update / Rollback 收到 ctx 后，超时或取消时自己会停下来并返回
      // context.DeadlineExceeded / context.Canceled；JS 的假实现不会监听 signal，
      // 所以这里用 Promise.race 把操作和“超时后 reject”竞速，
      // 超时先到就按 Go 的 ctx.Err() 抛 "context deadline exceeded"。
      // 注意 setTimeout 的最小延迟约 1 毫秒，所以 Go 测试里的 1 纳秒超时
      // 在 JS 测试里写成 0.000001 毫秒，照样比假实现的 100 毫秒先到。
      const operation =
        action === "rollback"
          ? manager.rollback(signal, provider)
          : manager.update(signal);
      const deadline = new Promise((_resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error("context deadline exceeded")),
          timeoutMs,
        );
        // 操作先完成时不要让这个定时器拖住进程退出。
        if (typeof t.unref === "function") {
          t.unref();
        }
      });
      report = await Promise.race([operation, deadline]);
    } catch (e) {
      err = e;
    }
    // Go：先把 report 写出来，再返回之前的操作错误。
    // encodeErr 和 err 只要有一个不为空就返回那个错误。
    let encodeErr = null;
    try {
      stdout.write(`${JSON.stringify(report)}\n`);
    } catch (e) {
      encodeErr = e;
    }
    if (err) {
      throwIfAborted(signal, err);
      throw err;
    }
    if (encodeErr) {
      throw encodeErr;
    }
  } finally {
    clearTimeout(timer);
  }
}

// mergeSignals：把两个 AbortSignal 合并成一个，任一 abort 就跟着 abort。
// Go 里 context.WithTimeout(parent) 天生就是“父取消或超时都会取消”；
// JS 没有内置的合并 API，这里用事件监听实现同样的语义。
// mergeSignals(a, b)
// 干什么：把两个 AbortSignal 合并成一个，任一 abort 就跟着 abort。
// 入参：a、b —— 两个 AbortSignal，其中一个可以是 null；
// 返回值：合并后的 AbortSignal。
// 为什么需要它：
// Go 里 context.WithTimeout(parent) 天生就是“父取消或超时都会取消”，
// 因为超时 context 是挂在父 context 下面的子节点；
// JS 没有内置的合并 API，这里用事件监听实现同样的语义：
// 任一 signal 触发 abort 事件，就把新 controller 也 abort 掉。
// 容易看不懂的点：
// 一进来先判断 a / b 是不是已经 abort 了，已经 abort 就直接同步 abort，
// 不用等事件；否则给两个 signal 各挂一个 once 的 abort 监听。
function mergeSignals(a, b) {
  if (!a) return b;
  if (!b) return a;
  const controller = new AbortController();
  const onAbort = () => controller.abort(a.aborted ? a.reason : b.reason);
  if (a.aborted || b.aborted) {
    onAbort();
    return controller.signal;
  }
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

// throwIfAborted：如果 signal 已 abort，就按 Go 的 ctx.Err() 抛错。
// 超时 abort 的 reason 是 "context deadline exceeded"，
// 外部取消的 reason 是 "context canceled"；
// 实在分不出来时，如果传入了原始错误就优先抛原始错误。
// throwIfAborted(signal, fallbackErr)
// 干什么：对应 Go 的 if err:= ctx.Err(); err!= nil { return err}，
// 检查 signal 是不是已经 abort 了，是就按 Go 的 ctx.Err() 抛错。
// 入参：signal —— AbortSignal；fallbackErr —— 可选，实在分不出来时优先抛的原始错误；
// 返回值：没 abort 就什么都不做直接返回，abort 了就 throw。
// 抛什么错：
// 超时 abort 的 reason 是 "context deadline exceeded"，
// 外部取消的 reason 是 "context canceled"，
// 这两个字符串和 Go 的 context.DeadlineExceeded / context.Canceled 的
// Error() 输出一致，所以测试里用字符串包含来判断（和 Go 测试里
// strings.Contains(err.Error(), "context deadline exceeded") 一个意思）。
// reason 如果是 Error 就直接抛它，是字符串就包成 Error 再抛，
// 都没有就抛 fallbackErr，最后兜底抛 "context canceled"。
function throwIfAborted(signal, fallbackErr) {
  if (!signal || !signal.aborted) {
    return;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  if (typeof reason === "string" && reason !== "") {
    throw new Error(reason);
  }
  if (fallbackErr) {
    throw fallbackErr;
  }
  throw new Error("context canceled");
}

module.exports = { runCLI, stubManagedcli, mergeSignals, throwIfAborted };
