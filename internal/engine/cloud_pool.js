/**
 * @file internal/engine/cloud_pool.js
 * 对应 Go 源文件：internal/engine/cloud_pool.go
 *
 * 作用与职责边界：
 * 实现云端执行机器池的配置、项目路由判定、候选平台 Runner 筛选、会话云端 Runner 分配，
 * 以及节点启动前绑定在线池 Runner 或等待原绑定 Runner 恢复的阻塞等待流程；
 * 领域方法挂载于 `Engine.prototype`（`Engine` 定义于 `engine.js`）。
 *
 * 语法差异说明：
 * - Go 的 `(值, error)` 译为成功返回值、失败 `throw err`；`(值, bool)` 译为二元组 `[值, boolean]`。
 * - Go 的 `sync.Mutex`（`e.mu`）在单线程 JS 中不需要，直接略去。
 * - Go 的 `time.Duration` 换算为毫秒数；`select` 搭配 `time.After` / `time.NewTicker` 译为 `async` + `Promise` 定时器与 `AbortSignal` 监听。
 * - Go 的 `CloudRunnerPool.Projects` 为字符串切片，按规则零值初始化为 `[]`。
 */

"use strict";

const { Runner, RunnerStatusOnline } = require("../domain/runner.js"); // 对应 Go 的 domain.Runner/RunnerStatusOnline，runner.js 已翻译
const { ExecutionModeCloud, ExecutionModeRunner, RunnerWorkspaceLayoutShared } = require("../domain/observability.js"); // 对应 Go 的 domain.ExecutionMode*/RunnerWorkspaceLayoutShared，observability.js 已翻译
const { Engine } = require("./engine.js"); // 对应 Go 同包类型，engine.js 已翻译
const { hasCodeWorkspace, hasWorkspaceProgress } = require("./workspace_owner.js"); // 对应 Go 同包函数，workspace_owner.js 已翻译

/**
 * 云端执行机器池配置：将责任人未配置默认执行机器的运行路由到带指定 `Label` 的平台 Runner，
 * 而非在控制面主机上直接执行。`Projects` 限定生效项目列表（`"*"` 匹配全部项目），`Label` 为空时禁用池路由；
 * `Required` 为 `true` 时强制对应项目只能走池执行，主机不再兜底执行。
 */
class CloudRunnerPool {
  /**
   * 构造 `CloudRunnerPool` 实例，缺省字段严格按 Go 零值初始化。
   *
   * @param {Object} [init={}] - 可选初始字段映射。
   * @param {string} [init.Label=""] - 平台执行机器池标签；为空表示禁用云端池。
   * @param {string[]} [init.Projects=[]] - 适用该池的项目 ID 列表（`"*"` 表示全部项目）。
   * @param {boolean} [init.Required=false] - 是否强制要求上述项目只能在云端池中执行。
   * @returns {void} 无返回值。
   */
  constructor(init = {}) {
    this.Label = init.Label ?? "";
    this.Projects = init.Projects ?? [];
    this.Required = init.Required ?? false;
  }

  /**
   * 判断云端执行机器池是否已启用且覆盖指定项目 `projectID`。
   * 使用场景：路由新运行、分配对话云端 Runner 或判断项目是否强制走云端池时调用。
   *
   * @param {string} projectID - 目标项目 ID。
   * @returns {boolean} 已配置非空标签且项目在覆盖范围内返回 `true`，否则返回 `false`。
   */
  serves(projectID) {
    return this.Label !== "" && cloudPoolServes(this.Projects, projectID);
  }
}

// 节点等待在线云端池执行机器的最长时长（10 分钟，换算为毫秒）。
const poolBindWait = 10 * 60 * 1000;

/**
 * 配置引擎后续启动运行所使用的云端执行机器池参数（会对 `Label` 去除首尾空白）。
 * 使用场景：服务启动或运行时动态更新云端执行池配置时调用。
 *
 * @param {CloudRunnerPool} pool - 新的云端执行池配置对象。
 * @returns {void} 无返回值。
 */
Engine.prototype.ConfigureCloudRunnerPool = function (pool) {
  pool.Label = pool.Label.trim();
  this.cloudPool = pool;
};

/**
 * 将逗号分隔的项目 ID 配置字符串拆分为去除空白后的非空项目 ID 数组。
 * 使用场景：从环境变量或配置文件解析云端执行池覆盖的项目列表。
 *
 * @param {string} raw - 逗号分隔的原始项目列表字符串。
 * @returns {string[]} 清洗后的项目 ID 数组。
 */
function ParseCloudRunnerProjects(raw) {
  const out = [];
  for (let p of raw.split(",")) {
    if ((p = p.trim()) !== "") {
      out.push(p);
    }
  }
  return out;
}

/**
 * 为指定项目的新运行随机挑选一台在线的云端池执行机器。
 * 若池对该项目未开启或当前无满足端到端执行条件的在线 Runner，则返回 `[空 Runner, false]`，由调用方回退到本机执行。
 * 使用场景：创建运行确定初始执行位置时调用。
 *
 * @param {string} projectID - 目标项目 ID。
 * @returns {[Runner, boolean]} 命中时返回 `[runner, true]`，否则返回 `[空 Runner, false]`。
 */
Engine.prototype.cloudPoolRunner = function (projectID) {
  const pool = this.cloudPool;
  if (!pool.serves(projectID)) {
    return [new Runner(), false];
  }
  return this.pickPoolRunner(pool.Label);
};

/**
 * 为对话会话一次性分配一台支持对话 CLI 的在线云端执行机器。
 * 后续对话轮次沿用会话已持久化的目标机器，不会在机器故障后自动切换。
 * 使用场景：创建或首次初始化云端模式对话工作区时调用。
 *
 * @param {string} projectID - 会话所属项目 ID。
 * @returns {string} 分配到的云端 Runner ID；若项目未开启云端池则返回空字符串 `""`。
 * @throws {Error} 项目已开启云端池但当前没有支持对话 CLI 的在线池 Runner 时抛出错误。
 */
Engine.prototype.ConversationCloudRunner = function (projectID) {
  const pool = this.cloudPool;
  if (!pool.serves(projectID)) {
    return "";
  }
  for (const runner of this.repo.Runners()) {
    if (poolRunnerEligible(runner, pool.Label) && runner.SupportsConversationCLI()) {
      return runner.ID;
    }
  }
  throw new Error("云端暂无支持对话的在线执行机器，请升级 Runner 后重试");
};

/**
 * 从带有指定标签的合格在线云端池 Runner 列表中随机选取一台。
 * 使用场景：由 `cloudPoolRunner` 与 `bindPoolRunner` 调用。
 *
 * @param {string} label - 云端执行池标签。
 * @returns {[Runner, boolean]} 存在候选机器时返回 `[随机选中的 Runner, true]`，否则返回 `[空 Runner, false]`。
 */
Engine.prototype.pickPoolRunner = function (label) {
  const candidates = this.eligiblePoolRunners(label);
  if (candidates.length === 0) {
    return [new Runner(), false];
  }
  return [candidates[Math.floor(Math.random() * candidates.length)], true];
};

/**
 * 列出当前已注册且满足指定池标签执行条件的全部平台 Runner。
 * 使用场景：挑选池执行机器或统计云端池在线容量时调用。
 *
 * @param {string} label - 云端执行池标签。
 * @returns {Runner[]} 符合条件的在线平台 Runner 数组。
 */
Engine.prototype.eligiblePoolRunners = function (label) {
  const out = [];
  for (const runner of this.repo.Runners()) {
    if (poolRunnerEligible(runner, label)) {
      out.push(runner);
    }
  }
  return out;
};

/**
 * 判断单台 Runner 是否有资格承接指定标签的云端池任务。
 * 仅允许使用平台引导令牌注册（无个人归属 `OwnerUserID === 0`）、处于在线状态、支持产物上报与集成且带有目标标签的 Runner。
 * 使用场景：筛选云端池候选机器与对话云端 Runner 时调用。
 *
 * @param {Runner} runner - 待检查的 Runner 实例。
 * @param {string} label - 期望匹配的云端池标签。
 * @returns {boolean} 满足全部资格条件返回 `true`，否则返回 `false`。
 */
function poolRunnerEligible(runner, label) {
  // 池 runner 会收到所有用户的凭证，只有用平台 bootstrap token 注册（无 owner）的才合格；
  // 个人机器不能通过给自己打标签加入执行池。
  if (runner.OwnerUserID !== 0 || runner.Status !== RunnerStatusOnline || !runner.SupportsReportedOutputs() || !runner.SupportsIntegrate()) {
    return false;
  }
  for (const runnerLabel of runner.Labels ?? []) {
    if (runnerLabel.trim() === label) {
      return true;
    }
  }
  return false;
}

/**
 * 判断项目列表配置 `projects` 是否覆盖目标 `projectID`（`"*"` 通配所有项目）。
 * 使用场景：由 `CloudRunnerPool.prototype.serves` 调用。
 *
 * @param {string[]} projects - 云端池允许的项目 ID 列表。
 * @param {string} projectID - 待判定的项目 ID。
 * @returns {boolean} 命中通配符或精确匹配非空项目 ID 返回 `true`，否则返回 `false`。
 */
function cloudPoolServes(projects, projectID) {
  projectID = projectID.trim();
  for (const p of projects ?? []) {
    if (p === "*" || (projectID !== "" && p === projectID)) {
      return true;
    }
  }
  return false;
}

/**
 * 判断指定项目的运行是否强制必须在云端执行池中执行，而不能回退到控制面主机。
 * 使用场景：节点绑定池执行机器时判断是否需要将云模式运行转换为池 Runner 执行。
 *
 * @param {string} projectID - 目标项目 ID。
 * @returns {boolean} 池已启用、覆盖该项目且开启 `Required` 时返回 `true`，否则返回 `false`。
 */
Engine.prototype.cloudPoolRequired = function (projectID) {
  const pool = this.cloudPool;
  return pool.Required && pool.serves(projectID);
};

/**
 * 查询云端执行池当前的配置状态与可用在线机器数量。
 * 使用场景：运维监控、健康检查或前端展示云端执行池可用性时调用。
 *
 * @returns {[boolean, number]} 二元组 `[是否已配置云端池, 当前可接单的在线池 Runner 数量]`。
 */
Engine.prototype.CloudPoolStatus = function () {
  const label = this.cloudPoolLabel();
  if (label === "") {
    return [false, 0];
  }
  return [true, this.eligiblePoolRunners(label).length];
};

/**
 * 读取当前引擎配置的云端执行池标签。
 * 使用场景：池状态查询与节点绑定池机器时获取当前生效标签。
 *
 * @returns {string} 云端池标签字符串；未配置时为空字符串 `""`。
 */
Engine.prototype.cloudPoolLabel = function () {
  return this.cloudPool.Label;
};

/**
 * 判断给定运行是否标记为使用云端执行池执行。
 * 使用场景：节点启动前判断是否需要执行云端池 Runner 绑定逻辑。
 *
 * @param {Object} run - 运行记录对象（`domain.Run`）。
 * @returns {boolean} `ExecutionPool` 为云端模式时返回 `true`，否则返回 `false`。
 */
function isPoolRun(run) {
  return run.ExecutionContext.ExecutionPool === ExecutionModeCloud;
}

/**
 * 在节点启动前确保云端池运行已绑定到一台在线的池执行机器：
 * - 若会话固定绑定了某台 Runner（`ExecutionPinned`），则仅校验其在线；
 * - 若原绑定池 Runner 离线且工作区已有代码改动，则等待原机器恢复而不切换；
 * - 否则在最长 `poolBindWait` 时间内轮询挑选在线池 Runner，绑定后更新运行记录并丢弃控制面本地沙箱。
 * 使用场景：调度器准备执行单个工作流节点前调用。
 *
 * @param {AbortSignal | null} ctx - 取消信号。
 * @param {Object} run - 当前运行记录对象（`domain.Run`）。
 * @param {string} nodeID - 即将执行的节点 ID。
 * @returns {Promise<Object>} 绑定完成后最新的运行记录对象（`domain.Run`）。
 * @throws {Error} 固定机器不可用、云端池未配置、等待超时、上下文取消或运行不存在时抛出错误。
 */
Engine.prototype.bindPoolRunner = async function (ctx, run, nodeID) {
  if (run.ExecutionContext.ExecutionPinned) {
    if (run.ExecutionContext.ExecutionRunnerID !== "") {
      const [r, ok] = this.repo.Runner(run.ExecutionContext.ExecutionRunnerID);
      if (!ok || r.Status !== RunnerStatusOnline) {
        throw new Error("会话绑定的执行机器暂不可用，请等待原机器恢复");
      }
    }
    return run;
  }
  // 并行首节点一起绑定：第一个选机器，其余重读运行后跟随。
  const release = this.lockPoolBinding(run.ID);
  try {
    // Go 的 defer release() 译为 finally。
    const [fresh, ok] = this.repo.RunState(run.ID);
    if (ok) {
      run = fresh;
    }
    const ec = run.ExecutionContext;
    let convert = ec.ExecutionMode === ExecutionModeCloud && this.cloudPoolRequired(ec.ProjectID);
    if (convert && hasCodeWorkspace(run) && hasWorkspaceProgress(run, nodeID)) {
      // 控制面检出里已有本次运行的改动。
      convert = false;
    }
    if (!isPoolRun(run) && !convert) {
      return run;
    }
    const previous = ec.ExecutionRunnerID.trim();
    if (previous !== "" && !convert) {
      const [runner, ok2] = this.repo.Runner(previous);
      if (ok2 && runner.Status === RunnerStatusOnline) {
        return run;
      }
      // 检出只在那台机器上：节点不推中间提交，换机器会丢掉前面节点的代码改动。
      if (hasCodeWorkspace(run) && hasWorkspaceProgress(run, nodeID)) {
        let name = previous;
        if (ok2 && runner.Name.trim() !== "") {
          name = runner.Name;
        }
        return await this.waitForBoundPoolRunner(ctx, run, nodeID, name);
      }
    }
    const label = this.cloudPoolLabel();
    if (label === "") {
      throw new Error("云端执行池未配置，无法为该运行分配执行机器");
    }
    const deadline = Date.now() + poolBindWait;
    let runner;
    let announced = false;
    for (;;) {
      let ok3;
      [runner, ok3] = this.pickPoolRunner(label);
      if (ok3) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`云端执行池（${label}）在 ${Math.trunc(poolBindWait / 60000)} 分钟内没有在线的执行机器，请确认执行机器已启动并在线后重试`);
      }
      if (!announced) {
        announced = true;
        this.updateRun(run.ID, (c) => {
          this.event(c, nodeID, "execution.waiting", `云端执行池（${label}）暂无在线的执行机器，最多等待 ${Math.trunc(poolBindWait / 60000)} 分钟`);
        });
      }
      // Go：select { case <-ctx.Done(): return run, ctx.Err(); case <-time.After(2 * time.Second): }
      await new Promise((resolve, reject) => {
        if (ctx instanceof AbortSignal && ctx.aborted) {
          reject(ctx.reason);
          return;
        }
        const timer = setTimeout(() => {
          if (ctx instanceof AbortSignal) {
            ctx.removeEventListener("abort", onAbort);
          }
          resolve();
        }, 2000);
        const onAbort = () => {
          clearTimeout(timer);
          reject(ctx.reason);
        };
        if (ctx instanceof AbortSignal) {
          ctx.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
    this.updateRun(run.ID, (c) => {
      c.ExecutionContext.ExecutionMode = ExecutionModeRunner;
      c.ExecutionContext.ExecutionPool = ExecutionModeCloud;
      c.ExecutionContext.ExecutionRunnerID = runner.ID;
      c.ExecutionContext.RunnerWorkspaceLayout = RunnerWorkspaceLayoutShared;
      let msg = `已分配云端执行机器 ${runner.Name}`;
      if (previous !== "") {
        let name = previous;
        const [old, ok4] = this.repo.Runner(previous);
        if (ok4 && old.Name.trim() !== "") {
          name = old.Name;
        }
        msg = `执行机器 ${name} 不可用，已切换到云端执行机器 ${runner.Name} 重新拉取代码`;
      }
      this.event(c, nodeID, "execution.bound", msg);
    });
    const [bound, ok5] = this.repo.RunState(run.ID);
    if (!ok5) {
      throw new Error("run not found");
    }
    // 本机沙箱不再是执行环境；排空仅断开连接，且空闲巡检在运行绑定 runner 后会跳过它，因此需主动丢弃旧容器。
    this.discardLocalSandbox(run.ID);
    return bound;
  } finally {
    release();
  }
};

/**
 * 等待已保存有代码工作区改动的原绑定云端执行机器重新上线（最长等待 `poolBindWait`），
 * 期间每 2 秒轮询一次其在线状态；恢复后记录恢复事件并返回最新运行状态。
 * 使用场景：部署重启或短暂断线导致已有代码进度的池运行原 Runner 离线时，由 `bindPoolRunner` 调用。
 *
 * @param {AbortSignal | null} ctx - 外层取消信号。
 * @param {Object} run - 当前运行记录对象（`domain.Run`）。
 * @param {string} nodeID - 正在等待执行的节点 ID。
 * @param {string} name - 原执行机器用于展示的名称或 ID。
 * @returns {Promise<Object>} 原机器恢复后重读的最新运行记录对象（`domain.Run`）。
 * @throws {Error} 上下文被取消、超过等待宽限期未恢复或运行记录不存在时抛出错误。
 */
Engine.prototype.waitForBoundPoolRunner = async function (ctx, run, nodeID, name) {
  // Go：waitCtx, cancel := context.WithTimeout(ctx, poolBindWait)
  const waitController = new AbortController();
  const waitTimer = setTimeout(() => waitController.abort(new Error("context deadline exceeded")), poolBindWait);
  if (ctx instanceof AbortSignal) {
    if (ctx.aborted) {
      waitController.abort(ctx.reason);
    } else {
      ctx.addEventListener("abort", () => waitController.abort(ctx.reason), { once: true });
    }
  }
  const waitCtx = waitController.signal;
  try {
    this.updateRun(run.ID, (c) => {
      this.event(c, nodeID, "execution.waiting", `执行机器 ${name} 暂时离线，等待原机器恢复以继续使用已有工作区，最多等待 ${Math.trunc(poolBindWait / 60000)} 分钟`);
    });
    for (;;) {
      if (waitCtx.aborted) {
        if (ctx instanceof AbortSignal && ctx.aborted) {
          throw ctx.reason;
        }
        throw new Error(`执行机器 ${name} 在 ${Math.trunc(poolBindWait / 60000)} 分钟内未恢复在线，工作区和之前节点的代码改动仍保留在原机器上；请等该机器恢复后重试，或从头重跑`);
      }
      const [runner, ok] = this.repo.Runner(run.ExecutionContext.ExecutionRunnerID);
      if (ok && runner.Status === RunnerStatusOnline) {
        this.updateRun(run.ID, (c) => {
          this.event(c, nodeID, "execution.resumed", `执行机器 ${name} 已恢复在线，继续使用原工作区`);
        });
        const [current, ok2] = this.repo.RunState(run.ID);
        if (!ok2) {
          throw new Error("run not found");
        }
        return current;
      }
      // Go：select { case <-waitCtx.Done(): case <-ticker.C: }，ticker 每 2 秒一跳。
      await new Promise((resolve) => {
        if (waitCtx.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          waitCtx.removeEventListener("abort", onAbort);
          resolve();
        }, 2000);
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        waitCtx.addEventListener("abort", onAbort, { once: true });
      });
    }
  } finally {
    clearTimeout(waitTimer);
  }
};

module.exports = { CloudRunnerPool, poolBindWait, ParseCloudRunnerProjects, poolRunnerEligible, cloudPoolServes, isPoolRun };
