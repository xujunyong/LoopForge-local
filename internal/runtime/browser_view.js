// browser_view.js —— 对应 Go 文件：internal/runtime/browser_view.go
//
// 文件作用与职责边界：
// 管理任务面板与单次运行（run）所关联的 Agent 浏览器之间的实时视图连接。
// 负责跟随 Agent 最新打开的标签页、通过 CDP（Page.startScreencast）持续镜像画面、
// 转发用户的鼠标/滚轮/键盘/文本输入、执行导航/前进后退/刷新/缩放/标签页管理，
// 以及在长时间无人观看时自动断开连接释放资源。Agent 自动化本身保留独立的 CDP 连接。
//
// Go 与 JS 语法差异说明：
// - channel 译为 Promise（Promise.withResolvers）；goroutine 译为不 await 的异步函数；
// - context.Context 译为 AbortSignal；sync.Mutex 在单线程 JS 中不需要，已略去；
// - map[string]V 译为普通对象 {}；time.Time 译为 Date（零值 null）；time.Duration 译为毫秒数；
// - (值, error) 译为成功返回值、失败 throw；(值, bool) 译为 [值, bool]。

"use strict";

const { BrowserState, BrowserTab } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.BrowserState/BrowserTab
const { lookupBrowserEndpoint } = require("./browser.js"); // 对应 Go 同包函数
const { newCDPClient } = require("./browser_cdp.js"); // 对应 Go 同包函数
const { handleDevServerHTTP } = require("./browser_devserver.js"); // 对应 Go 同包函数
const { handleWorkspaceFile } = require("./browser_file.js"); // 对应 Go 同包函数

const browserViewIdle = 60 * 1000;

/**
 * 表示浏览器中的一个页面标签目标及其创建时间。
 * 用于跟踪当前浏览器内打开的页面标签并在面板中按创建时间排序展示。
 */
class browserTarget {
  /**
   * 构造浏览器页面标签目标对象。
   * @param {Object} [init={}] - 初始化字段集合。
   * @param {string} [init.ID=""] - CDP 目标 ID。
   * @param {string} [init.Title=""] - 页面标题。
   * @param {string} [init.URL=""] - 页面地址。
   * @param {Date|null} [init.created=null] - 标签创建时间（对应 Go time.Time，零值 null）。
   */
  constructor(init = {}) {
    this.ID = init.ID ?? "";
    this.Title = init.Title ?? "";
    this.URL = init.URL ?? "";
    this.created = init.created ?? null;
  }
}

/**
 * 任务面板附加到单个运行浏览器的视图控制器。
 * 负责维护 CDP 会话、跟踪 Agent 最新标签页、通过 Page.startScreencast 镜像画面并转发用户输入。
 */
class browserView {
  /**
   * 创建指定运行对应的浏览器视图实例。
   * @param {string} [runID=""] - 运行 ID。
   * @param {Object|null} [endpoint=null] - 浏览器连接端点对象。
   */
  constructor(runID = "", endpoint = null) {
    this.runID = runID;
    this.endpoint = endpoint;
    this.client = null;

    this.targets = {};
    this.active = "";
    this.session = "";
    this.frame = "";
    this.seq = 0;
    this.width = 0;
    this.height = 0;
    // 文档滚动位置来自帧元数据，内容尺寸来自布局指标，最多每隔 browserContentRefresh 刷新一次。
    this.scrollX = 0;
    this.scrollY = 0;
    this.contentWidth = 0;
    this.contentHeight = 0;
    this.contentAt = null;
    this.contentBusy = false;
    this.lastUsed = new Date();
    this.changed = Promise.withResolvers();
    this.follow = false;
    // frameWidth 是面板的设备像素宽度；0 表示沿用默认上限。
    this.frameWidth = 0;
    // motion 在面板滚动或拖拽期间为 true：采集更轻量的帧，直到输入稳定（见 markMotion）。
    this.motion = false;
    this.motionGen = 0;
    // settledFrameSampled 仅在测试中设置，在 ensureSettledFrame 记录完等待的帧序号后触发。
    this.settledFrameSampled = null;
    // 导航历史标记按当前激活页 URL 缓存，避免每帧增加一次 CDP 往返。
    this.historyKey = "";
    this.canGoBack = false;
    this.canGoForward = false;
  }

  /**
   * 更新视图的最近使用时间，防止空闲回收定时器过早关闭连接。
   * 在每次处理来自任务面板的浏览器请求时调用。
   * @returns {void} 无返回值。
   */
  touch() {
    this.lastUsed = new Date();
  }

  /**
   * 在无人观看视图超过空闲阈值或底层 CDP 连接断开时停止投屏并从全局表中移除视图。
   * 在 openBrowserView 建立新连接后于后台启动，避免无人值守的运行持续编码画面帧。
   * @returns {Promise<void>} 视图关闭并清理完成后结束，无返回值。
   */
  async reapWhenIdle() {
    for (;;) {
      const outcome = await Promise.race([
        this.client.donePromise.then(() => "done"),
        new Promise((resolve) => setTimeout(() => resolve("tick"), 10 * 1000)),
      ]);
      if (outcome === "tick") {
        const lastUsedMs = this.lastUsed instanceof Date ? this.lastUsed.getTime() : 0;
        const idle = Date.now() - lastUsedMs > browserViewIdle;
        if (!idle) {
          continue;
        }
        this.client.close();
      }
      if (browserViews.items[this.runID] === this) {
        delete browserViews.items[this.runID];
      }
      return;
    }
  }

  /**
   * 唤醒所有正在等待新帧或状态变化的调用方，并重置下一轮通知 Promise。
   * 在标签页列表、激活会话或最新画面帧发生变更时调用。
   * @returns {void} 无返回值。
   */
  notify() {
    this.changed.resolve();
    this.changed = Promise.withResolvers();
  }

  /**
   * 处理底层 CDP 客户端推送的事件消息。
   * 在收到标签页创建/信息变更/销毁事件以及投屏帧事件时被 cdpClient 回调调用。
   * @param {Object} msg - CDP 事件消息对象（包含 method、sessionId、params）。
   * @returns {void} 无返回值。
   */
  onEvent(msg) {
    switch (msg.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged": {
        let ev;
        try {
          ev = typeof msg.params === "string" ? JSON.parse(msg.params) : msg.params;
        } catch {
          return;
        }
        if (!ev || !ev.targetInfo || ev.targetInfo.type !== "page") {
          return;
        }
        let t = this.targets[ev.targetInfo.targetId];
        const created = t === undefined;
        if (created) {
          t = new browserTarget({ ID: ev.targetInfo.targetId, created: new Date() });
          this.targets[t.ID] = t;
        }
        t.Title = ev.targetInfo.title ?? "";
        t.URL = ev.targetInfo.url ?? "";
        const follow = created && this.follow && msg.method === "Target.targetCreated";
        this.notify();
        if (follow) {
          // 自动跟随 Agent 新打开的标签页，使面板始终展示其当前工作内容。
          const id = t.ID;
          void (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), 10 * 1000);
            try {
              await this.attach(controller.signal, id);
            } catch {
              // 忽略自动跟随附着失败，对应 Go `_ = v.attach(...)`。
            } finally {
              clearTimeout(timer);
            }
          })();
        }
        break;
      }
      case "Target.targetDestroyed": {
        let ev;
        try {
          ev = typeof msg.params === "string" ? JSON.parse(msg.params) : msg.params;
        } catch {
          return;
        }
        if (!ev) {
          return;
        }
        delete this.targets[ev.targetId];
        const wasActive = this.active === ev.targetId;
        if (wasActive) {
          this.active = "";
          this.session = "";
        }
        this.notify();
        if (wasActive) {
          void (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), 10 * 1000);
            try {
              const next = this.latestTarget();
              if (next !== "") {
                await this.attach(controller.signal, next);
              }
            } catch {
              // 忽略自动切换标签页失败。
            } finally {
              clearTimeout(timer);
            }
          })();
        }
        break;
      }
      case "Page.screencastFrame": {
        let ev;
        try {
          ev = typeof msg.params === "string" ? JSON.parse(msg.params) : msg.params;
        } catch {
          return;
        }
        if (!ev) {
          return;
        }
        const current = msg.sessionId === this.session;
        let refresh = false;
        if (current) {
          const meta = ev.metadata ?? {};
          this.frame = ev.data ?? "";
          this.width = meta.deviceWidth ?? 0;
          this.height = meta.deviceHeight ?? 0;
          this.scrollX = meta.scrollOffsetX ?? 0;
          this.scrollY = meta.scrollOffsetY ?? 0;
          this.seq++;
          this.notify();
          const contentAtMs = this.contentAt instanceof Date ? this.contentAt.getTime() : 0;
          if (!this.contentBusy && Date.now() - contentAtMs > browserContentRefresh) {
            this.contentBusy = true;
            refresh = true;
          }
        }
        if (refresh) {
          void this.refreshContentSize(msg.sessionId);
        }
        void (async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), 5 * 1000);
          try {
            await this.client.call(controller.signal, msg.sessionId, "Page.screencastFrameAck", { sessionId: ev.sessionId }, null);
          } catch {
            // 忽略帧确认失败。
          } finally {
            clearTimeout(timer);
          }
        })();
        break;
      }
      default:
        break;
    }
  }

  /**
   * 异步读取当前页面的 CSS 内容尺寸并更新缓存。
   * 在收到投屏帧且距离上次刷新超过 browserContentRefresh 时触发，用于支撑滚动条比例计算。
   * @param {string} session - 目标页面的 CDP 会话 ID。
   * @returns {Promise<void>} 刷新完成后结束，无返回值。
   */
  async refreshContentSize(session) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), 5 * 1000);
    const ctx = controller.signal;
    try {
      const metrics = { cssContentSize: { width: 0, height: 0 } };
      let callErr = null;
      try {
        await this.client.call(ctx, session, "Page.getLayoutMetrics", null, metrics);
      } catch (err) {
        callErr = err;
      }
      this.contentBusy = false;
      this.contentAt = new Date();
      if (callErr === null && session === this.session) {
        this.contentWidth = metrics.cssContentSize?.width ?? 0;
        this.contentHeight = metrics.cssContentSize?.height ?? 0;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 选出当前已知页面标签中创建时间最新的目标 ID（时间相同时取 ID 字典序较大者）。
   * 用于初始化附着或当前激活标签被关闭后的自动回退。
   * @returns {string} 最新标签页的目标 ID；没有任何页面标签时返回空字符串。
   */
  latestTarget() {
    let best = "";
    let bestAt = 0;
    for (const [id, t] of Object.entries(this.targets)) {
      const createdAt = t.created instanceof Date ? t.created.getTime() : 0;
      if (best === "" || createdAt > bestAt || (createdAt === bestAt && id > best)) {
        best = id;
        bestAt = createdAt;
      }
    }
    return best;
  }

  /**
   * 返回当前已激活的页面标签 ID。
   * 在关闭当前标签页或调整窗口尺寸时用于确定目标页面。
   * @returns {string} 当前激活标签页的 targetId；未激活时返回空字符串。
   */
  activeID() {
    return this.active;
  }

  /**
   * 将视图附着到指定的页面标签，先抓一张首帧截图，再启动 CDP 投屏。
   * 在首次打开浏览器视图、切换标签页、新建标签页或跟随 Agent 新开页时调用。
   * @param {AbortSignal} ctx - 取消信号。
   * @param {string} targetID - 要附着的页面目标 ID。
   * @returns {Promise<void>} 启动投屏成功后无返回值；失败时抛出 Error。
   */
  async attach(ctx, targetID) {
    if (targetID === "") {
      throw new Error("标签页不存在");
    }
    if (this.active === targetID && this.session !== "") {
      return;
    }
    const previous = this.session;
    const attached = { sessionId: "" };
    await this.client.call(ctx, "", "Target.attachToTarget", { targetId: targetID, flatten: true }, attached);
    if (previous !== "") {
      await this.client.call(ctx, previous, "Page.stopScreencast", null, null).catch(() => {});
      await this.client.call(ctx, "", "Target.detachFromTarget", { sessionId: previous }, null).catch(() => {});
    }
    this.active = targetID;
    this.session = attached.sessionId;
    this.notify();
    const session = attached.sessionId;
    await this.client.call(ctx, session, "Page.enable", null, null).catch(() => {});
    const metrics = { cssVisualViewport: { clientWidth: 0, clientHeight: 0 } };
    const metricsOk = await this.client.call(ctx, session, "Page.getLayoutMetrics", null, metrics).then(() => true, () => false);
    if (metricsOk) {
      const shot = { data: "" };
      const shotOk = await this.client.call(ctx, session, "Page.captureScreenshot", { format: "jpeg", quality: 70 }, shot).then(() => true, () => false);
      if (shotOk && shot.data !== "") {
        if (this.session === session) {
          this.frame = shot.data;
          this.width = metrics.cssVisualViewport?.clientWidth ?? 0;
          this.height = metrics.cssVisualViewport?.clientHeight ?? 0;
          this.seq++;
          this.notify();
        }
      }
    }
    return this.client.call(ctx, session, "Page.startScreencast", this.screencastParams(), null);
  }

  /**
   * 根据当前面板宽度和是否处于滚动/拖拽运动状态计算 Page.startScreencast 参数。
   * 在附着页面、修改帧宽度或切换高/低质量投屏模式时调用。
   * @returns {{format: string, quality: number, maxWidth: number, maxHeight: number, everyNthFrame: number}} CDP 投屏参数对象。
   */
  screencastParams() {
    let width = this.frameWidth;
    const motion = this.motion;
    if (width <= 0 || width > 2560) {
      width = 2560;
    }
    // 文字页面需要比照片更清晰的 JPEG；质量 80 能保持边缘锐利，体积约为 60 的两倍。
    let quality = 80;
    if (motion) {
      // 移动中的画面不需要精读：宽高减半且质量降为 60 可将文本页帧体积压到约五分之一，
      // 让沙箱渲染和传输链路在滚动期间保持更高帧率。
      width = Math.floor(width / 2);
      quality = browserMotionQuality;
    }
    width = Math.max(width, 320);
    return { format: "jpeg", quality, maxWidth: width, maxHeight: Math.min(2 * width, 4000), everyNthFrame: 1 };
  }

  /**
   * 在滚动或拖拽期间切换为轻量级投屏帧，并在输入静默 browserMotionSettle 毫秒后恢复清晰帧。
   * 重启投屏通常会让 Chromium 重新推送当前页；若未推送，则由 ensureSettledFrame 补拍一帧清晰图。
   * @param {AbortSignal} ctx - 取消信号。
   * @returns {Promise<void>} 启动轻量模式及定时器后无返回值。
   */
  async markMotion(ctx) {
    this.motionGen++;
    const gen = this.motionGen;
    const start = !this.motion;
    const session = this.session;
    this.motion = true;
    if (start && session !== "") {
      await this.restartScreencast(ctx, session);
    }
    const frameWait = browserSettledFrameWait;
    setTimeout(() => {
      if (gen !== this.motionGen || !this.motion) {
        return;
      }
      this.motion = false;
      const currentSession = this.session;
      if (currentSession === "") {
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), 5 * 1000);
      const motionCtx = controller.signal;
      void (async () => {
        try {
          await this.restartScreencast(motionCtx, currentSession);
          await this.ensureSettledFrame(motionCtx, currentSession, frameWait);
        } finally {
          clearTimeout(timer);
        }
      })();
    }, browserMotionSettle);
  }

  /**
   * 当投屏恢复高清模式后 Chromium 未主动推送新帧时，补拍一张清晰截图并发布。
   * 避免页面静止时面板长期停留在滚动期间的最后一帧低清画面上。
   * @param {AbortSignal} ctx - 取消信号。
   * @param {string} session - 目标页面的 CDP 会话 ID。
   * @param {number} wait - 等待 Chromium 主动推帧的毫秒数。
   * @returns {Promise<void>} 补帧判断及发布完成后无返回值。
   */
  async ensureSettledFrame(ctx, session, wait) {
    const seq = this.seq;
    const sampled = this.settledFrameSampled;
    if (sampled != null) {
      sampled();
    }
    const ctxDone = new Promise((resolve) => {
      if (!(ctx instanceof AbortSignal)) {
        return;
      }
      if (ctx.aborted) {
        resolve();
      } else {
        ctx.addEventListener("abort", () => resolve(), { once: true });
      }
    });
    const outcome = await Promise.race([
      new Promise((resolve) => setTimeout(() => resolve("timer"), wait)),
      ctxDone.then(() => "ctx"),
    ]);
    if (outcome === "ctx") {
      return;
    }
    const stale = () => this.session === session && this.seq === seq && !this.motion;
    if (!stale()) {
      return;
    }
    const shot = { data: "" };
    const shotOk = await this.client.call(ctx, session, "Page.captureScreenshot", { format: "jpeg", quality: 80 }, shot).then(() => true, () => false);
    if (!shotOk || shot.data === "") {
      return;
    }
    if (stale()) {
      this.frame = shot.data;
      this.seq++;
      this.notify();
    }
  }

  /**
   * 使用最新参数重启指定会话的 CDP 投屏。
   * 在进入或退出滚动/拖拽低清模式时调用。
   * @param {AbortSignal} ctx - 取消信号。
   * @param {string} session - 目标页面的 CDP 会话 ID。
   * @returns {Promise<void>} 重启完成后无返回值。
   */
  async restartScreencast(ctx, session) {
    await this.client.call(ctx, session, "Page.stopScreencast", null, null).catch(() => {});
    await this.client.call(ctx, session, "Page.startScreencast", this.screencastParams(), null).catch(() => {});
  }

  /**
   * 更新面板请求的帧像素宽度；若宽度变化且存在活跃会话，则重启投屏以生效。
   * 在处理 resize 请求且传入 FrameWidth 时调用。
   * @param {AbortSignal} ctx - 取消信号。
   * @param {number} width - 面板设备像素宽度。
   * @returns {Promise<void>} 更新完成或投屏重启后无返回值；CDP 调用失败时抛出 Error。
   */
  async setFrameWidth(ctx, width) {
    const changed = this.frameWidth !== width;
    this.frameWidth = width;
    const session = this.session;
    if (!changed || session === "") {
      return;
    }
    await this.client.call(ctx, session, "Page.stopScreencast", null, null).catch(() => {});
    return this.client.call(ctx, session, "Page.startScreencast", this.screencastParams(), null);
  }

  /**
   * 按“当前标签 ID + 页面 URL”缓存并返回浏览器前进/后退可用标记。
   * 在只读请求（status/frame）时调用，避免每帧都发起一次导航历史 CDP 查询。
   * @param {AbortSignal} ctx - 取消信号。
   * @param {string} url - 当前激活页面的 URL。
   * @returns {Promise<[boolean, boolean]>} 返回 `[canGoBack, canGoForward]` 元组。
   */
  async cachedHistoryFlags(ctx, url) {
    const key = this.active + "\x00" + url;
    if (key === this.historyKey) {
      return [this.canGoBack, this.canGoForward];
    }
    const [back, forward] = await this.historyFlags(ctx);
    this.historyKey = key;
    this.canGoBack = back;
    this.canGoForward = forward;
    return [back, forward];
  }

  /**
   * 长轮询等待比 after 更新的画面帧，直到新帧到达、超时、请求取消或连接断开。
   * 在处理 `frame` 操作时调用。
   * @param {AbortSignal} ctx - 取消信号。
   * @param {number} after - 客户端已持有的最新帧序号。
   * @param {number} waitMs - 最长等待毫秒数（<=0 或 >4000 时归一化为 4000）。
   * @returns {Promise<void>} 等待结束后无返回值。
   */
  async waitFrame(ctx, after, waitMs) {
    if (waitMs <= 0 || waitMs > 4000) {
      waitMs = 4000;
    }
    let deadlineResolve;
    const deadline = new Promise((resolve) => { deadlineResolve = resolve; });
    const deadlineTimer = setTimeout(() => deadlineResolve("deadline"), waitMs);
    const ctxDone = new Promise((resolve) => {
      if (!(ctx instanceof AbortSignal)) {
        return;
      }
      if (ctx.aborted) {
        resolve("ctx");
      } else {
        ctx.addEventListener("abort", () => resolve("ctx"), { once: true });
      }
    });
    try {
      for (;;) {
        if (this.seq > after) {
          return;
        }
        const changed = this.changed;
        const outcome = await Promise.race([
          changed.promise.then(() => "changed"),
          deadline,
          ctxDone,
          this.client.donePromise.then(() => "done"),
        ]);
        if (outcome !== "changed") {
          return;
        }
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  /**
   * 构造当前浏览器视图的对外状态快照（含连接可用性、视口尺寸、滚动位置、标签列表及可选画面帧）。
   * 在每次 HandleBrowser 响应组装时调用。
   * @param {number} after - 客户端已持有的帧序号；仅当当前序号大于 after 时才携带 Frame 数据。
   * @returns {BrowserState} 当前浏览器状态对象。
   */
  state(after) {
    const state = new BrowserState({
      Available: !this.client.closed(),
      Kind: this.endpoint.Kind,
      Seq: this.seq,
      Width: this.width,
      Height: this.height,
      ScrollX: this.scrollX,
      ScrollY: this.scrollY,
      ContentWidth: this.contentWidth,
      ContentHeight: this.contentHeight,
    });
    if (!state.Available) {
      state.Reason = "浏览器连接已断开";
    }
    if (this.seq > after) {
      state.Frame = this.frame;
    }
    for (const t of Object.values(this.targets)) {
      const tab = new BrowserTab({ ID: t.ID, Title: t.Title, URL: t.URL, Active: t.ID === this.active });
      state.Tabs = (state.Tabs ?? []).concat([tab]);
      if (tab.Active) {
        state.URL = t.URL;
        state.Title = t.Title;
      }
    }
    sortBrowserTabs(state.Tabs ?? [], this.targets);
    return state;
  }

  /**
   * 向当前激活标签页对应的 CDP 会话发送无返回值的命令。
   * 用于刷新、导航、历史跳转与输入事件分发。
   * @param {AbortSignal} ctx - 取消信号。
   * @param {string} method - CDP 方法名。
   * @param {Object|null} params - CDP 方法参数对象。
   * @returns {Promise<void>} 调用成功无返回值；无激活会话或调用失败时抛出 Error。
   */
  async pageCall(ctx, method, params) {
    const session = this.session;
    if (session === "") {
      throw new Error("没有可操作的标签页");
    }
    return this.client.call(ctx, session, method, params, null);
  }

  /**
   * 解析用户输入的地址或搜索词，并导航当前标签页到目标 URL。
   * 支持裸域名补全 `https://`、本地地址补全 `http://` 以及普通搜索词跳转 Bing 搜索。
   * @param {AbortSignal} ctx - 取消信号。
   * @param {string} raw - 用户输入的原始网址或关键词。
   * @returns {Promise<void>} 导航命令发送成功后无返回值；输入为空或调用失败时抛出 Error。
   */
  async navigate(ctx, raw) {
    let target = raw.trim();
    if (target === "") {
      throw new Error("请输入网址");
    }
    if (!target.includes("://") && !target.startsWith("about:")) {
      if (target.includes(" ") || (!target.includes(".") && !target.startsWith("localhost"))) {
        // Go 的 url.QueryEscape 将空格编为 +，encodeURIComponent 编为 %20，其余等价。
        target = "https://www.bing.com/search?q=" + encodeURIComponent(target);
      } else if (target.startsWith("localhost") || target.startsWith("127.0.0.1")) {
        target = "http://" + target;
      } else {
        target = "https://" + target;
      }
    }
    return this.pageCall(ctx, "Page.navigate", { url: target });
  }

  /**
   * 查询当前激活标签页的 CDP 导航历史记录。
   * 供 historyFlags 与 history（前进/后退）调用。
   * @param {AbortSignal} ctx - 取消信号。
   * @returns {Promise<{currentIndex: number, entries: Array<{id?: number, Id?: number}>}>} 导航历史对象；失败时抛出 Error。
   */
  async navigationHistory(ctx) {
    const session = this.session;
    const history = { currentIndex: 0, entries: [] };
    if (session === "") {
      throw new Error("没有可操作的标签页");
    }
    await this.client.call(ctx, session, "Page.getNavigationHistory", null, history);
    return history;
  }

  /**
   * 在 2 秒超时内查询当前页面是否可后退与可前进。
   * 查询失败时安全降级为 `[false, false]`，避免阻塞状态轮询。
   * @param {AbortSignal} ctx - 父取消信号（超时由内部 2 秒控制器控制）。
   * @returns {Promise<[boolean, boolean]>} 返回 `[canGoBack, canGoForward]` 元组。
   */
  async historyFlags(ctx) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), 2 * 1000);
    if (ctx instanceof AbortSignal) {
      if (ctx.aborted) {
        controller.abort(ctx.reason);
      } else {
        ctx.addEventListener("abort", () => controller.abort(ctx.reason), { once: true });
      }
    }
    try {
      const history = await this.navigationHistory(controller.signal);
      const entries = history.entries ?? [];
      return [history.currentIndex > 0, history.currentIndex < entries.length - 1];
    } catch {
      return [false, false];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 在当前标签页的导航历史中后退或前进一条记录。
   * 越界时静默返回而不报错。
   * @param {AbortSignal} ctx - 取消信号。
   * @param {boolean} back - 为 true 时后退，为 false 时前进。
   * @returns {Promise<void>} 跳转完成或已到历史边界时无返回值；CDP 失败时抛出 Error。
   */
  async history(ctx, back) {
    const history = await this.navigationHistory(ctx);
    let next = history.currentIndex + 1;
    if (back) {
      next = history.currentIndex - 1;
    }
    const entries = history.entries ?? [];
    if (next < 0 || next >= entries.length) {
      return;
    }
    const entry = entries[next];
    return this.pageCall(ctx, "Page.navigateToHistoryEntry", { entryId: entry.id ?? entry.Id });
  }

  /**
   * 调整真实浏览器窗口尺寸（而非模拟视口覆盖），保证 Agent 的 Playwright 会话与用户看到一致的视口。
   * 会先测算浏览器边框占用高度/宽度，再按目标视口宽高反推窗口外部边界。
   * @param {AbortSignal} ctx - 取消信号。
   * @param {number} width - 目标视口宽度（范围 800~2560）。
   * @param {number} height - 目标视口高度（范围 400~2560）。
   * @returns {Promise<void>} 设置窗口尺寸成功后无返回值；参数越界或调用失败时抛出 Error。
   */
  async resize(ctx, width, height) {
    if (width < 800 || height < 400 || width > 2560 || height > 2560) {
      throw new Error("窗口尺寸超出范围");
    }
    const target = this.activeID();
    if (target === "") {
      throw new Error("没有可操作的标签页");
    }
    const win = { windowId: 0, bounds: { width: 0, height: 0 } };
    await this.client.call(ctx, "", "Browser.getWindowForTarget", { targetId: target }, win);
    // 窗口外部边界包含（无头）浏览器边框；此处按视口尺寸补回边框差值。
    const metrics = { cssLayoutViewport: { clientWidth: 0, clientHeight: 0 } };
    let chromeW = 0;
    let chromeH = 0;
    const session = this.session;
    if (session !== "") {
      const ok = await this.client.call(ctx, session, "Page.getLayoutMetrics", null, metrics).then(() => true, () => false);
      if (ok && (metrics.cssLayoutViewport?.clientHeight ?? 0) > 0) {
        chromeW = Math.max(0, (win.bounds?.width ?? 0) - metrics.cssLayoutViewport.clientWidth);
        chromeH = Math.max(0, (win.bounds?.height ?? 0) - metrics.cssLayoutViewport.clientHeight);
      }
    }
    return this.client.call(
      ctx,
      "",
      "Browser.setWindowBounds",
      {
        windowId: win.windowId,
        bounds: { width: width + Math.trunc(chromeW), height: height + Math.trunc(chromeH), windowState: "normal" },
      },
      null,
    );
  }

  /**
   * 将来自任务面板的一批归一化输入事件（鼠标、滚轮、按键、文本）转换为 CDP 输入命令并依次分发。
   * 单次最多处理 200 条事件；检测到滚轮或按住鼠标拖动时触发低清高帧率模式。
   * @param {AbortSignal} ctx - 取消信号。
   * @param {Array<Object>} events - 浏览器输入事件列表（对应 Go `[]domain.BrowserInputEvent`）。
   * @returns {Promise<void>} 全部事件分发成功后无返回值；任意事件分发失败时抛出 Error。
   */
  async input(ctx, events) {
    if (events == null) {
      events = [];
    }
    if (events.length > 200) {
      events = events.slice(0, 200);
    }
    let width = this.width;
    let height = this.height;
    if (width <= 0 || height <= 0) {
      width = 1280;
      height = 800;
    }
    for (const ev of events) {
      if (ev.Type === "wheel" || (ev.Type === "mouse" && ev.Action === "move" && ev.Buttons !== 0)) {
        await this.markMotion(ctx);
        break;
      }
    }
    for (const ev of events) {
      const x = clampUnit(ev.X) * width;
      const y = clampUnit(ev.Y) * height;
      switch (ev.Type) {
        case "mouse": {
          const action = browserMouseActions[ev.Action];
          if (!action) {
            continue;
          }
          let button = ev.Button;
          if (button === "") {
            button = "none";
          }
          await this.pageCall(ctx, "Input.dispatchMouseEvent", {
            type: action,
            x,
            y,
            button,
            buttons: ev.Buttons,
            clickCount: ev.ClickCount,
            modifiers: ev.Modifiers,
          });
          break;
        }
        case "wheel":
          await this.pageCall(ctx, "Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x,
            y,
            deltaX: ev.DeltaX,
            deltaY: ev.DeltaY,
            modifiers: ev.Modifiers,
          });
          break;
        case "key": {
          const params = {
            key: ev.Key,
            code: ev.Code,
            windowsVirtualKeyCode: ev.KeyCode,
            nativeVirtualKeyCode: ev.KeyCode,
            modifiers: ev.Modifiers,
          };
          switch (ev.Action) {
            case "down":
              params.type = "rawKeyDown";
              if (ev.Text !== "") {
                params.type = "keyDown";
                params.text = ev.Text;
                params.unmodifiedText = ev.Text;
              }
              break;
            case "up":
              params.type = "keyUp";
              break;
            default:
              continue;
          }
          await this.pageCall(ctx, "Input.dispatchKeyEvent", params);
          break;
        }
        case "text":
          if (ev.Text !== "") {
            await this.pageCall(ctx, "Input.insertText", { text: ev.Text });
          }
          break;
        default:
          break;
      }
    }
  }
}

const browserViews = {
  items: {},
};

const browserViewReads = { "": true, status: true, frame: true };

/**
 * 处理宿主机上某次运行（Docker sidecar 或宿主机 Chromium）的一条任务面板浏览器请求。
 * 负责将 http/file 请求分流至开发服务器代理或工作区文件读取，其余操作通过 CDP 视图执行并返回最新状态。
 * @param {AbortSignal} ctx - 取消信号。
 * @param {string} runID - 运行 ID。
 * @param {Object} req - 浏览器请求对象（对应 Go `domain.BrowserRequest`）。
 * @returns {Promise<BrowserState>} 处理后的浏览器状态对象；操作执行失败时抛出 Error。
 */
async function HandleBrowser(ctx, runID, req) {
  if (req.Operation === "http") {
    // 开发服务器预览走沙箱网络，不走 CDP 视图。
    return handleDevServerHTTP(ctx, runID, req.HTTP);
  }
  if (req.Operation === "file") {
    return handleWorkspaceFile(ctx, runID, req.File);
  }
  let view;
  try {
    view = await openBrowserView(ctx, runID);
  } catch (err) {
    return new BrowserState({ Available: false, Reason: err.message });
  }
  view.touch();
  switch (req.Operation) {
    case "":
    case "status":
    case "start":
      break;
    case "frame":
      await view.waitFrame(ctx, req.After, req.WaitMs);
      break;
    case "input":
      await view.input(ctx, req.Events);
      break;
    case "navigate":
      await view.navigate(ctx, req.URL);
      break;
    case "back":
    case "forward":
      await view.history(ctx, req.Operation === "back");
      break;
    case "reload":
      await view.pageCall(ctx, "Page.reload", {});
      break;
    case "resize":
      if (req.Width > 0 || req.Height > 0) {
        await view.resize(ctx, req.Width, req.Height);
      }
      if (req.FrameWidth > 0) {
        await view.setFrameWidth(ctx, req.FrameWidth);
      }
      break;
    case "activate":
      await view.attach(ctx, req.TargetID);
      break;
    case "newTab": {
      const created = { targetId: "" };
      await view.client.call(ctx, "", "Target.createTarget", { url: "about:blank" }, created);
      await view.attach(ctx, created.targetId);
      break;
    }
    case "closeTab": {
      let target = req.TargetID;
      if (target === "") {
        target = view.activeID();
      }
      await view.client.call(ctx, "", "Target.closeTarget", { targetId: target }, null);
      break;
    }
    case "inspect": {
      // 元素检查不需要返回画面帧：面板上已经显示了当前画面。
      let inspection = null;
      let inspectErr = null;
      try {
        inspection = await view.inspect(ctx, req.Point, req.Detail);
      } catch (err) {
        inspectErr = err;
      }
      const state = view.state(Number.MAX_SAFE_INTEGER); // 对应 Go 的 math.MaxInt64，JS 取最大安全整数。
      state.Inspect = inspection;
      if (inspectErr != null) {
        throw inspectErr;
      }
      return state;
    }
    case "snapshot":
    case "screenshot":
    case "click":
    case "type":
    case "press": {
      let snap = null;
      let frame = "";
      let opErr = null;
      try {
        [snap, frame] = await view.agentOperation(ctx, req);
      } catch (err) {
        opErr = err;
      }
      const state = view.state(req.After);
      state.Snapshot = snap;
      if (frame !== "") {
        state.Frame = frame;
      }
      if (opErr != null) {
        throw opErr;
      }
      return state;
    }
    default:
      throw new Error(`不支持的浏览器操作 ${JSON.stringify(req.Operation)}`);
  }
  if (!browserViewReads[req.Operation]) {
    view.historyKey = "";
  }
  let state = view.state(req.After);
  if (req.WithSnapshot) {
    await view.settle(ctx);
    let snap = null;
    let snapErr = null;
    try {
      snap = await view.snapshot(ctx);
    } catch (err) {
      snapErr = err;
    }
    state = view.state(req.After);
    state.Snapshot = snap;
    if (snapErr != null) {
      throw snapErr;
    }
  }
  if (browserViewReads[req.Operation]) {
    [state.CanGoBack, state.CanGoForward] = await view.cachedHistoryFlags(ctx, state.URL);
  }
  return state;
}

/**
 * 获取或建立指定运行对应的 CDP 浏览器视图连接。
 * 若缓存中已有未关闭的视图则直接复用；否则查找浏览器端点、建立连接、发现并附着页面标签，
 * 最后注册进全局缓存并启动空闲回收任务。
 * @param {AbortSignal} ctx - 取消信号。
 * @param {string} runID - 运行 ID。
 * @returns {Promise<browserView>} 可用的浏览器视图实例；浏览器未启动或建连失败时抛出 Error。
 */
async function openBrowserView(ctx, runID) {
  const existing = browserViews.items[runID];
  if (existing != null && !existing.client.closed()) {
    return existing;
  }
  const [endpoint, ok] = lookupBrowserEndpoint(ctx, runID);
  if (!ok) {
    throw new Error("Agent 浏览器尚未启动：Agent 用到时会自动启动，也可以现在手动启动");
  }
  const dialController = new AbortController();
  const dialTimer = setTimeout(() => dialController.abort(new Error("context deadline exceeded")), 20 * 1000);
  if (ctx instanceof AbortSignal) {
    if (ctx.aborted) {
      dialController.abort(ctx.reason);
    } else {
      ctx.addEventListener("abort", () => dialController.abort(ctx.reason), { once: true });
    }
  }
  const dialCtx = dialController.signal;
  try {
    const transport = await endpoint.dial(dialCtx);
    const view = new browserView(runID, endpoint);
    view.client = newCDPClient(transport, view.onEvent.bind(view));
    try {
      await view.client.call(dialCtx, "", "Target.setDiscoverTargets", { discover: true }, null);
    } catch (err) {
      view.client.close();
      throw err;
    }
    const listed = { targetInfos: [] };
    const listedOk = await view.client.call(dialCtx, "", "Target.getTargets", null, listed).then(() => true, () => false);
    if (listedOk) {
      for (const info of listed.targetInfos ?? []) {
        const infoType = info.type ?? info.Type ?? "";
        if (infoType === "page") {
          const id = info.targetId ?? info.TargetId ?? "";
          view.targets[id] = new browserTarget({
            ID: id,
            Title: info.title ?? info.Title ?? "",
            URL: info.url ?? info.Url ?? "",
          });
        }
      }
    }
    const target = view.latestTarget();
    if (target !== "") {
      await view.attach(dialCtx, target).catch(() => {});
    } else {
      const created = { targetId: "" };
      const createdOk = await view.client.call(dialCtx, "", "Target.createTarget", { url: "about:blank" }, created).then(() => true, () => false);
      if (createdOk) {
        await view.attach(dialCtx, created.targetId).catch(() => {});
      }
    }
    view.follow = true;
    const old = browserViews.items[runID];
    if (old != null && old !== view) {
      old.client.close();
    }
    browserViews.items[runID] = view;
    void view.reapWhenIdle();
    return view;
  } finally {
    clearTimeout(dialTimer);
  }
}

// browserContentRefresh 限制布局指标读取频率：内容尺寸很少变化，每帧都读会增加一次 CDP 往返。
const browserContentRefresh = 1000;

const browserMotionQuality = 60;

// browserMotionSettle 表示最后一次滚动或拖拽后，投屏切回清晰帧的等待时长（毫秒）。
let browserMotionSettle = 400;

// browserSettledFrameWait 表示投屏重启后等待浏览器主动推帧的时长（毫秒），超时则补拍截图。
let browserSettledFrameWait = 300;

/**
 * 原地按目标创建时间升序排列浏览器标签页数组（时间相同时按 ID 升序）。
 * 在 browserView.state 组装标签栏数据时调用。
 * @param {Array<BrowserTab>} tabs - 待排序的标签页数组。
 * @param {Object<string, browserTarget>} targets - 以 targetId 为键的页面目标映射表。
 * @returns {void} 无返回值（原地修改 tabs）。
 */
function sortBrowserTabs(tabs, targets) {
  for (let i = 1; i < tabs.length; i++) {
    for (let j = i; j > 0; j--) {
      const a = targets[tabs[j - 1].ID];
      const b = targets[tabs[j].ID];
      const aCreated = a.created instanceof Date ? a.created.getTime() : 0;
      const bCreated = b.created instanceof Date ? b.created.getTime() : 0;
      if (aCreated < bCreated || (aCreated === bCreated && a.ID <= b.ID)) {
        break;
      }
      [tabs[j - 1], tabs[j]] = [tabs[j], tabs[j - 1]];
    }
  }
}

const browserMouseActions = { down: "mousePressed", up: "mouseReleased", move: "mouseMoved" };

/**
 * 将归一化坐标值钳制在 `[0, 1]` 区间内。
 * 在把面板相对坐标换算为页面像素坐标以及元素拾取时调用。
 * @param {number} value - 原始归一化坐标值。
 * @returns {number} 落在 `[0, 1]` 范围内的数值。
 */
function clampUnit(value) {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

module.exports = {
  browserViewIdle,
  browserTarget,
  browserView,
  browserViewReads,
  HandleBrowser,
  openBrowserView,
  browserContentRefresh,
  browserMotionQuality,
  browserMotionSettle,
  browserSettledFrameWait,
  sortBrowserTabs,
  browserMouseActions,
  clampUnit,
};
