// browser_view.js —— 对应 Go 文件：internal/runtime/browser_view.go
// 作用：任务面板的浏览器视图：跟随 Agent 最新标签页，用 CDP 截屏转发用户输入。
// channel 译为 Promise（Promise.withResolvers）；goroutine 译为不 await 的异步函数；
// context.Context 译为 AbortSignal；sync.Mutex 译为空操作对象，JS 单线程；
// time.Duration 译为毫秒数；(值, error) 译为返回值、失败 throw，(值, bool) 译为 [值, bool]。

"use strict";

const { BrowserState, BrowserTab } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.BrowserState/BrowserTab，domain 已翻译
const { lookupBrowserEndpoint } = require("./browser.js"); // 对应 Go 同包函数，browser.js 待翻译
const { newCDPClient } = require("./browser_cdp.js"); // 对应 Go 同包函数，browser_cdp.js 待翻译
const { handleDevServerHTTP } = require("./browser_devserver.js"); // 对应 Go 同包函数
const { handleWorkspaceFile } = require("./browser_file.js"); // 对应 Go 同包函数

const browserViewIdle = 60 * 1000;

const browserViews = {
  Lock() {},
  Unlock() {},
  items: new Map(),
};

const browserViewReads = { "": true, status: true, frame: true };

// HandleBrowser serves one task panel browser request for a run whose browser
// lives on this host (docker sidecar or host Chromium).
async function HandleBrowser(ctx, runID, req) {
  if (req.Operation === "http") {
    // Dev server preview needs the sandbox network, not the CDP view.
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
      const created = {};
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
      // Inspection never needs a frame: the panel already shows one.
      let inspection = null;
      let inspectErr = null;
      try {
        inspection = await view.inspect(ctx, req.Point, req.Detail);
      } catch (err) {
        inspectErr = err;
      }
      const state = view.state(Number.MAX_SAFE_INTEGER); // Go 的 math.MaxInt64，JS 取最大安全整数。
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
    view.mu.Lock();
    view.historyKey = "";
    view.mu.Unlock();
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

async function openBrowserView(ctx, runID) {
  browserViews.Lock();
  const existing = browserViews.items.get(runID);
  browserViews.Unlock();
  if (existing != null && !existing.client.closed()) {
    return existing;
  }
  const [endpoint, ok] = lookupBrowserEndpoint(ctx, runID);
  if (!ok) {
    throw new Error("Agent 浏览器尚未启动：Agent 用到时会自动启动，也可以现在手动启动");
  }
  const dialController = new AbortController();
  const dialTimer = setTimeout(() => dialController.abort(new Error("context deadline exceeded")), 20 * 1000);
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
    const listed = {};
    const listedOk = await view.client.call(dialCtx, "", "Target.getTargets", null, listed).then(() => true, () => false);
    if (listedOk) {
      view.mu.Lock();
      for (const info of listed.targetInfos ?? []) {
        if (info.type === "page") {
          view.targets.set(info.targetId, { ID: info.targetId, Title: info.title, URL: info.url, created: 0 });
        }
      }
      view.mu.Unlock();
    }
    const target = view.latestTarget();
    if (target !== "") {
      await view.attach(dialCtx, target).catch(() => {});
    } else {
      const created = {};
      const createdOk = await view.client.call(dialCtx, "", "Target.createTarget", { url: "about:blank" }, created).then(() => true, () => false);
      if (createdOk) {
        await view.attach(dialCtx, created.targetId).catch(() => {});
      }
    }
    view.mu.Lock();
    view.follow = true;
    view.mu.Unlock();
    browserViews.Lock();
    const old = browserViews.items.get(runID);
    if (old != null && old !== view) {
      old.client.close();
    }
    browserViews.items.set(runID, view);
    browserViews.Unlock();
    void view.reapWhenIdle();
    return view;
  } finally {
    clearTimeout(dialTimer);
  }
}

// cdpTargetInfo：CDP Target.getTargets/targetCreated 事件里的目标信息，
// wire 键为 targetId/type/title/url/attached。

// browserView is the task panel's attachment to one run browser: it follows
// the agent's newest tab, mirrors it via Page.startScreencast and forwards
// user input. Agent automation keeps its own CDP connection.
class browserView {
  constructor(runID, endpoint) {
    this.runID = runID;
    this.endpoint = endpoint;
    this.client = null;

    this.mu = { Lock() {}, Unlock() {} };
    this.targets = new Map();
    this.active = "";
    this.session = "";
    this.frame = "";
    this.seq = 0;
    this.width = 0;
    this.height = 0;
    // Document scroll position from frame metadata and content size from
    // layout metrics, refreshed at most every browserContentRefresh.
    this.scrollX = 0;
    this.scrollY = 0;
    this.contentWidth = 0;
    this.contentHeight = 0;
    this.contentAt = 0;
    this.contentBusy = false;
    this.lastUsed = Date.now();
    this.changed = Promise.withResolvers();
    this.follow = false;
    // frameWidth is the panel's device pixel width; 0 keeps the default cap.
    this.frameWidth = 0;
    // motion is set while the panel scrolls or drags: frames are captured
    // lighter until the input settles (see markMotion).
    this.motion = false;
    this.motionGen = 0;
    // settledFrameSampled, when set (tests only), runs once ensureSettledFrame
    // has recorded the frame seq it waits on.
    this.settledFrameSampled = null;
    // History flags are cached per active page URL: re-reading them on every
    // frame would add a CDP round trip to each one.
    this.historyKey = "";
    this.canGoBack = false;
    this.canGoForward = false;
  }

  touch() {
    this.mu.Lock();
    this.lastUsed = Date.now();
    this.mu.Unlock();
  }

  // reapWhenIdle stops screencasting once nobody watches, so an unattended run
  // does not keep encoding frames.
  async reapWhenIdle() {
    for (;;) {
      const outcome = await Promise.race([
        this.client.done.then(() => "done"),
        new Promise((resolve) => setTimeout(() => resolve("tick"), 10 * 1000)),
      ]);
      if (outcome === "tick") {
        this.mu.Lock();
        const idle = Date.now() - this.lastUsed > browserViewIdle;
        this.mu.Unlock();
        if (!idle) {
          continue;
        }
        this.client.close();
      }
      browserViews.Lock();
      if (browserViews.items.get(this.runID) === this) {
        browserViews.items.delete(this.runID);
      }
      browserViews.Unlock();
      return;
    }
  }

  notify() {
    this.changed.resolve();
    this.changed = Promise.withResolvers();
  }

  onEvent(msg) {
    switch (msg.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged": {
        let ev;
        try {
          ev = JSON.parse(msg.params);
        } catch {
          return;
        }
        if (ev.targetInfo.type !== "page") {
          return;
        }
        this.mu.Lock();
        let t = this.targets.get(ev.targetInfo.targetId);
        const created = t === undefined;
        if (created) {
          t = { ID: ev.targetInfo.targetId, Title: "", URL: "", created: Date.now() };
          this.targets.set(t.ID, t);
        }
        t.Title = ev.targetInfo.title;
        t.URL = ev.targetInfo.url;
        const follow = created && this.follow && msg.method === "Target.targetCreated";
        this.notify();
        this.mu.Unlock();
        if (follow) {
          // Follow tabs the agent opens so the panel shows what it works on.
          const id = t.ID;
          void (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), 10 * 1000);
            try {
              await this.attach(controller.signal, id);
            } catch {}
            finally {
              clearTimeout(timer);
            }
          })();
        }
        break;
      }
      case "Target.targetDestroyed": {
        let ev;
        try {
          ev = JSON.parse(msg.params);
        } catch {
          return;
        }
        this.mu.Lock();
        this.targets.delete(ev.targetId);
        const wasActive = this.active === ev.targetId;
        if (wasActive) {
          this.active = "";
          this.session = "";
        }
        this.notify();
        this.mu.Unlock();
        if (wasActive) {
          void (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), 10 * 1000);
            try {
              const next = this.latestTarget();
              if (next !== "") {
                await this.attach(controller.signal, next);
              }
            } catch {}
            finally {
              clearTimeout(timer);
            }
          })();
        }
        break;
      }
      case "Page.screencastFrame": {
        let ev;
        try {
          ev = JSON.parse(msg.params);
        } catch {
          return;
        }
        this.mu.Lock();
        const current = msg.sessionId === this.session;
        let refresh = false;
        if (current) {
          this.frame = ev.data;
          this.width = ev.metadata.deviceWidth;
          this.height = ev.metadata.deviceHeight;
          this.scrollX = ev.metadata.scrollOffsetX;
          this.scrollY = ev.metadata.scrollOffsetY;
          this.seq++;
          this.notify();
          if (!this.contentBusy && Date.now() - this.contentAt > browserContentRefresh) {
            this.contentBusy = true;
            refresh = true;
          }
        }
        this.mu.Unlock();
        if (refresh) {
          void this.refreshContentSize(msg.sessionId);
        }
        void (async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), 5 * 1000);
          try {
            await this.client.call(controller.signal, msg.sessionId, "Page.screencastFrameAck", { sessionId: ev.sessionId }, null);
          } catch {}
          finally {
            clearTimeout(timer);
          }
        })();
        break;
      }
      default:
        break;
    }
  }

  // browserContentRefresh bounds layout metric reads: content size changes
  // rarely, and one read per frame would add a CDP round trip to each.
  async refreshContentSize(session) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), 5 * 1000);
    const ctx = controller.signal;
    try {
      const metrics = {};
      let callErr = null;
      try {
        await this.client.call(ctx, session, "Page.getLayoutMetrics", null, metrics);
      } catch (err) {
        callErr = err;
      }
      this.mu.Lock();
      try {
        this.contentBusy = false;
        this.contentAt = Date.now();
        if (callErr === null && session === this.session) {
          this.contentWidth = metrics.cssContentSize.width;
          this.contentHeight = metrics.cssContentSize.height;
        }
      } finally {
        this.mu.Unlock();
      }
    } finally {
      clearTimeout(timer);
    }
  }

  latestTarget() {
    this.mu.Lock();
    try {
      let best = "";
      let bestAt = 0;
      for (const [id, t] of this.targets) {
        if (best === "" || t.created > bestAt || (t.created === bestAt && id > best)) {
          best = id;
          bestAt = t.created;
        }
      }
      return best;
    } finally {
      this.mu.Unlock();
    }
  }

  activeID() {
    this.mu.Lock();
    try {
      return this.active;
    } finally {
      this.mu.Unlock();
    }
  }

  async attach(ctx, targetID) {
    if (targetID === "") {
      throw new Error("标签页不存在");
    }
    this.mu.Lock();
    if (this.active === targetID && this.session !== "") {
      this.mu.Unlock();
      return;
    }
    const previous = this.session;
    this.mu.Unlock();
    const attached = {};
    await this.client.call(ctx, "", "Target.attachToTarget", { targetId: targetID, flatten: true }, attached);
    if (previous !== "") {
      await this.client.call(ctx, previous, "Page.stopScreencast", null, null).catch(() => {});
      await this.client.call(ctx, "", "Target.detachFromTarget", { sessionId: previous }, null).catch(() => {});
    }
    this.mu.Lock();
    this.active = targetID;
    this.session = attached.sessionId;
    this.notify();
    this.mu.Unlock();
    const session = attached.sessionId;
    await this.client.call(ctx, session, "Page.enable", null, null).catch(() => {});
    const metrics = {};
    const metricsOk = await this.client.call(ctx, session, "Page.getLayoutMetrics", null, metrics).then(() => true, () => false);
    if (metricsOk) {
      const shot = {};
      const shotOk = await this.client.call(ctx, session, "Page.captureScreenshot", { format: "jpeg", quality: 70 }, shot).then(() => true, () => false);
      if (shotOk && shot.data !== "") {
        this.mu.Lock();
        if (this.session === session) {
          this.frame = shot.data;
          this.width = metrics.cssVisualViewport.clientWidth;
          this.height = metrics.cssVisualViewport.clientHeight;
          this.seq++;
          this.notify();
        }
        this.mu.Unlock();
      }
    }
    return this.client.call(ctx, session, "Page.startScreencast", this.screencastParams(), null);
  }

  screencastParams() {
    this.mu.Lock();
    let width = this.frameWidth;
    const motion = this.motion;
    this.mu.Unlock();
    if (width <= 0 || width > 2560) {
      width = 2560;
    }
    // Text needs a cleaner JPEG than photos; 80 keeps edges sharp at about
    // twice the bytes of 60.
    let quality = 80;
    if (motion) {
      // Moving content is not read: half the pixels at quality 60 cut a
      // text page frame to about a fifth, so the sandbox renders and the
      // link carries several times as many while scrolling.
      width = Math.floor(width / 2);
      quality = browserMotionQuality;
    }
    width = Math.max(width, 320);
    return { format: "jpeg", quality, maxWidth: width, maxHeight: Math.min(2 * width, 4000), everyNthFrame: 1 };
  }

  // markMotion switches the screencast to light frames for scrolling and
  // dragging, and back once input has been quiet for browserMotionSettle.
  // Restarting the screencast usually makes Chromium send the current page
  // again; ensureSettledFrame covers the times it does not, so the view ends
  // on a sharp frame even when nothing moves afterwards.
  async markMotion(ctx) {
    this.mu.Lock();
    this.motionGen++;
    const gen = this.motionGen;
    const start = !this.motion;
    const session = this.session;
    this.motion = true;
    this.mu.Unlock();
    if (start && session !== "") {
      await this.restartScreencast(ctx, session);
    }
    const frameWait = browserSettledFrameWait;
    setTimeout(() => {
      this.mu.Lock();
      if (gen !== this.motionGen || !this.motion) {
        this.mu.Unlock();
        return;
      }
      this.motion = false;
      const currentSession = this.session;
      this.mu.Unlock();
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

  // ensureSettledFrame publishes a sharp screenshot when Chromium sends no frame
  // after the screencast returns to sharp. It captures only on repaint and does
  // not always re-send a page that stopped changing, which would leave the panel
  // on its last light frame.
  async ensureSettledFrame(ctx, session, wait) {
    this.mu.Lock();
    const seq = this.seq;
    const sampled = this.settledFrameSampled;
    this.mu.Unlock();
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
    this.mu.Lock();
    const ok = stale();
    this.mu.Unlock();
    if (!ok) {
      return;
    }
    const shot = {};
    const shotOk = await this.client.call(ctx, session, "Page.captureScreenshot", { format: "jpeg", quality: 80 }, shot).then(() => true, () => false);
    if (!shotOk || shot.data === "") {
      return;
    }
    this.mu.Lock();
    if (stale()) {
      this.frame = shot.data;
      this.seq++;
      this.notify();
    }
    this.mu.Unlock();
  }

  async restartScreencast(ctx, session) {
    await this.client.call(ctx, session, "Page.stopScreencast", null, null).catch(() => {});
    await this.client.call(ctx, session, "Page.startScreencast", this.screencastParams(), null).catch(() => {});
  }

  // setFrameWidth restarts the screencast when the panel's pixel width changes.
  async setFrameWidth(ctx, width) {
    this.mu.Lock();
    const changed = this.frameWidth !== width;
    this.frameWidth = width;
    const session = this.session;
    this.mu.Unlock();
    if (!changed || session === "") {
      return;
    }
    await this.client.call(ctx, session, "Page.stopScreencast", null, null).catch(() => {});
    return this.client.call(ctx, session, "Page.startScreencast", this.screencastParams(), null);
  }

  async cachedHistoryFlags(ctx, url) {
    this.mu.Lock();
    const key = this.active + "\x00" + url;
    if (key === this.historyKey) {
      const back = this.canGoBack;
      const forward = this.canGoForward;
      this.mu.Unlock();
      return [back, forward];
    }
    this.mu.Unlock();
    const [back, forward] = await this.historyFlags(ctx);
    this.mu.Lock();
    this.historyKey = key;
    this.canGoBack = back;
    this.canGoForward = forward;
    this.mu.Unlock();
    return [back, forward];
  }

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
        this.mu.Lock();
        if (this.seq > after) {
          this.mu.Unlock();
          return;
        }
        const changed = this.changed;
        this.mu.Unlock();
        const outcome = await Promise.race([
          changed.promise.then(() => "changed"),
          deadline,
          ctxDone,
          this.client.done.then(() => "done"),
        ]);
        if (outcome !== "changed") {
          return;
        }
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  state(after) {
    this.mu.Lock();
    try {
      const state = new BrowserState({ Available: !this.client.closed(), Kind: this.endpoint.Kind, Seq: this.seq, Width: this.width, Height: this.height,
        ScrollX: this.scrollX, ScrollY: this.scrollY, ContentWidth: this.contentWidth, ContentHeight: this.contentHeight });
      if (!state.Available) {
        state.Reason = "浏览器连接已断开";
      }
      if (this.seq > after) {
        state.Frame = this.frame;
      }
      for (const t of this.targets.values()) {
        const tab = new BrowserTab({ ID: t.ID, Title: t.Title, URL: t.URL, Active: t.ID === this.active });
        state.Tabs = (state.Tabs ?? []).concat([tab]);
        if (tab.Active) {
          state.URL = t.URL;
          state.Title = t.Title;
        }
      }
      sortBrowserTabs(state.Tabs ?? [], this.targets);
      return state;
    } finally {
      this.mu.Unlock();
    }
  }

  async pageCall(ctx, method, params) {
    this.mu.Lock();
    const session = this.session;
    this.mu.Unlock();
    if (session === "") {
      throw new Error("没有可操作的标签页");
    }
    return this.client.call(ctx, session, method, params, null);
  }

  async navigate(ctx, raw) {
    let target = raw.trim();
    if (target === "") {
      throw new Error("请输入网址");
    }
    if (!target.includes("://") && !target.startsWith("about:")) {
      if (target.includes(" ") || !target.includes(".") && !target.startsWith("localhost")) {
        // Go 的 url.QueryEscape 把空格编为 +，encodeURIComponent 编为 %20，其余一致。
        target = "https://www.bing.com/search?q=" + encodeURIComponent(target);
      } else if (target.startsWith("localhost") || target.startsWith("127.0.0.1")) {
        target = "http://" + target;
      } else {
        target = "https://" + target;
      }
    }
    return this.pageCall(ctx, "Page.navigate", { url: target });
  }

  // cdpHistory：Page.getNavigationHistory 的返回，wire 键为 currentIndex/entries/id。
  async navigationHistory(ctx) {
    this.mu.Lock();
    const session = this.session;
    this.mu.Unlock();
    const history = {};
    if (session === "") {
      throw new Error("没有可操作的标签页");
    }
    await this.client.call(ctx, session, "Page.getNavigationHistory", null, history);
    return history;
  }

  async historyFlags(ctx) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), 2 * 1000);
    try {
      const history = await this.navigationHistory(controller.signal);
      return [history.currentIndex > 0, history.currentIndex < history.entries.length - 1];
    } catch {
      return [false, false];
    } finally {
      clearTimeout(timer);
    }
  }

  async history(ctx, back) {
    const history = await this.navigationHistory(ctx);
    let next = history.currentIndex + 1;
    if (back) {
      next = history.currentIndex - 1;
    }
    if (next < 0 || next >= history.entries.length) {
      return;
    }
    return this.pageCall(ctx, "Page.navigateToHistoryEntry", { entryId: history.entries[next].id });
  }

  // resize sizes the browser window, not an emulation override, so the agent's
  // Playwright session sees the same viewport the user is looking at.
  async resize(ctx, width, height) {
    if (width < 800 || height < 400 || width > 2560 || height > 2560) {
      throw new Error("窗口尺寸超出范围");
    }
    const target = this.activeID();
    if (target === "") {
      throw new Error("没有可操作的标签页");
    }
    const window = {};
    await this.client.call(ctx, "", "Browser.getWindowForTarget", { targetId: target }, window);
    // Window bounds include (headless) browser chrome; size the viewport.
    const metrics = {};
    let chromeW = 0;
    let chromeH = 0;
    this.mu.Lock();
    const session = this.session;
    this.mu.Unlock();
    if (session !== "") {
      const ok = await this.client.call(ctx, session, "Page.getLayoutMetrics", null, metrics).then(() => true, () => false);
      if (ok && metrics.cssLayoutViewport.clientHeight > 0) {
        chromeW = Math.max(0, window.bounds.width - metrics.cssLayoutViewport.clientWidth);
        chromeH = Math.max(0, window.bounds.height - metrics.cssLayoutViewport.clientHeight);
      }
    }
    return this.client.call(ctx, "", "Browser.setWindowBounds", { windowId: window.windowId, bounds: { width: width + Math.trunc(chromeW), height: height + Math.trunc(chromeH), windowState: "normal" } }, null);
  }

  async input(ctx, events) {
    if (events == null) {
      events = [];
    }
    if (events.length > 200) {
      events = events.slice(0, 200);
    }
    this.mu.Lock();
    let width = this.width;
    let height = this.height;
    this.mu.Unlock();
    if (width <= 0 || height <= 0) {
      width = 1280;
      height = 800;
    }
    for (const ev of events) {
      if (ev.Type === "wheel" || ev.Type === "mouse" && ev.Action === "move" && ev.Buttons !== 0) {
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
          await this.pageCall(ctx, "Input.dispatchMouseEvent", { type: action, x, y, button, buttons: ev.Buttons, clickCount: ev.ClickCount, modifiers: ev.Modifiers });
          break;
        }
        case "wheel":
          await this.pageCall(ctx, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: ev.DeltaX, deltaY: ev.DeltaY, modifiers: ev.Modifiers });
          break;
        case "key": {
          const params = { key: ev.Key, code: ev.Code, windowsVirtualKeyCode: ev.KeyCode, nativeVirtualKeyCode: ev.KeyCode, modifiers: ev.Modifiers };
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

const browserContentRefresh = 1000;

const browserMotionQuality = 60;

// browserMotionSettle is how long after the last scroll or drag the
// screencast returns to sharp frames.
const browserMotionSettle = 400;

// browserSettledFrameWait is how long a restarted screencast gets to send the
// current page before ensureSettledFrame captures it instead.
const browserSettledFrameWait = 300;

function sortBrowserTabs(tabs, targets) {
  for (let i = 1; i < tabs.length; i++) {
    for (let j = i; j > 0; j--) {
      const a = targets.get(tabs[j - 1].ID);
      const b = targets.get(tabs[j].ID);
      if (a.created < b.created || (a.created === b.created && a.ID <= b.ID)) {
        break;
      }
      [tabs[j - 1], tabs[j]] = [tabs[j], tabs[j - 1]];
    }
  }
}

const browserMouseActions = { down: "mousePressed", up: "mouseReleased", move: "mouseMoved" };

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
