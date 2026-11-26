// browser_agent.js —— 对应 Go 文件：internal/runtime/browser_agent.go
// 作用：Agent 操作浏览器：快照、点击、输入、按键与截图。
// context.Context 译为 AbortSignal；(值, error) 译为成功返回值、失败 throw；
// Go 的 *string/*bool 等标量 out 译为单元素数组（out[0]）；select + time.After 译为 sleepOrAbort；
// context.WithTimeout 译为 withTimeout。

"use strict";

const { BrowserSnapshot } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.BrowserSnapshot，runner_workspace.js 已翻译
const { browserView } = require("./browser_view.js"); // 对应 Go 同包的 browserView，browser_view.js 待翻译
const { assignWireJSON } = require("./browser_cdp.js"); // 对应 Go 同包的 json.Unmarshal，browser_cdp.js 已翻译

const browserSnapshotElements = 150;
const browserSnapshotText = 12000;
const browserRefAttr = "data-agentflow-ref";

// browserSnapshotScript：给可见可交互元素打 ref，供语言模型按 ref 操作；String.raw 保留脚本里的 \s、\n。
const browserSnapshotScript = String.raw`(() => {
  const attr = "${browserRefAttr}", max = ${browserSnapshotElements}, limit = ${browserSnapshotText};
  document.querySelectorAll("[" + attr + "]").forEach(e => e.removeAttribute(attr));
  const visible = e => { const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(e); return s.visibility !== "hidden" && s.display !== "none"; };
  const clean = v => String(v || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const selector = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=combobox],[role=textbox],[role=switch],[contenteditable=""],[contenteditable=true],[onclick]';
  const elements = [];
  let n = 0;
  for (const e of document.querySelectorAll(selector)) {
    if (elements.length >= max) break;
    if (!visible(e)) continue;
    const ref = "e" + (++n);
    e.setAttribute(attr, ref);
    const tag = e.tagName.toLowerCase(), type = (e.getAttribute("type") || "").toLowerCase();
    const role = e.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? (type || "text") : tag);
    const buttonValue = tag === "input" && ["button", "submit", "reset"].includes(type) ? e.value : "";
    const item = { ref, role, name: clean(e.getAttribute("aria-label") || e.innerText || buttonValue || e.getAttribute("placeholder") || e.title || e.getAttribute("alt") || e.getAttribute("name")) };
    if ((tag === "input" && !["button", "submit", "reset", "password", "checkbox", "radio"].includes(type)) || tag === "textarea" || tag === "select") item.value = clean(e.value);
    if (e.checked) item.checked = true;
    if (e.disabled) item.disabled = true;
    elements.push(item);
  }
  const text = String(document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").trim();
  return { text: text.slice(0, limit), truncated: text.length > limit, elements };
})()`;

// cdpEvaluateResult：Runtime.evaluate 的返回体；Result.Value 是原始 JSON（Go 的 json.RawMessage），保持解析后的值。
class cdpEvaluateResult {
  constructor(init = {}) {
    this.Result = init.Result ?? { Value: null };
    this.ExceptionDetails = init.ExceptionDetails ?? null;
  }
}

// sleepOrAbort：等满毫秒或等到 ctx 取消，对应 Go 的 time.NewTimer + select。
function sleepOrAbort(ctx, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = () => {
      if (ctx instanceof AbortSignal) {
        ctx.removeEventListener("abort", onAbort);
      }
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(ctx.reason ?? new Error("context canceled"));
    };
    if (ctx instanceof AbortSignal) {
      if (ctx.aborted) {
        onAbort();
        return;
      }
      ctx.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// sleep：只等满毫秒，对应 Go 的 time.Sleep。
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// withTimeout：给 ctx 加一个超时，返回 [信号, 取消函数]，对应 Go 的 context.WithTimeout。
function withTimeout(ctx, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("context deadline exceeded")), ms);
  if (ctx instanceof AbortSignal) {
    if (ctx.aborted) {
      controller.abort(ctx.reason);
    } else {
      ctx.addEventListener("abort", () => controller.abort(ctx.reason), { once: true });
    }
  }
  return [controller.signal, () => clearTimeout(timer)];
}

browserView.prototype.evaluate = async function (ctx, expression, out) {
  // Go 的 v.mu 锁省略，JS 单线程无需加锁。
  const session = this.session;
  if (session === "") {
    throw new Error("没有可操作的标签页");
  }
  const result = new cdpEvaluateResult();
  await this.client.call(ctx, session, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, result);
  if (result.ExceptionDetails != null) {
    let msg = result.ExceptionDetails.Exception.Description;
    if (msg === "") {
      msg = result.ExceptionDetails.Text;
    }
    throw new Error(`页面脚本执行失败：${msg}`);
  }
  if (out == null || result.Result.Value == null) {
    return;
  }
  assignWireJSON(out, result.Result.Value);
};

browserView.prototype.snapshot = async function (ctx) {
  const snap = new BrowserSnapshot();
  await this.evaluate(ctx, browserSnapshotScript, snap);
  return snap;
};

// settle：等导航完成，对应 Go 的 settle。
browserView.prototype.settle = async function (ctx) {
  try {
    await sleepOrAbort(ctx, 400);
  } catch {
    return;
  }
  const deadline = Date.now() + 5 * 1000;
  while (Date.now() < deadline && !(ctx instanceof AbortSignal && ctx.aborted)) {
    const [probe, cancel] = withTimeout(ctx, 1000);
    let ready = "";
    let err = null;
    try {
      const readyBox = [""];
      await this.evaluate(probe, "document.readyState", readyBox);
      ready = readyBox[0];
    } catch (e) {
      err = e;
    }
    cancel();
    if (err == null && ready === "complete") {
      return;
    }
    await sleep(200);
  }
};

function browserRefSelector(ref) {
  ref = ref.trim();
  if (ref.length < 2 || ref[0] !== "e") {
    throw new Error("ref 无效：请先获取页面快照，使用其中的元素 ref（如 e12）");
  }
  if (!/^[+-]?\d+$/.test(ref.slice(1))) {
    throw new Error("ref 无效：请先获取页面快照，使用其中的元素 ref（如 e12）");
  }
  return `document.querySelector('[${browserRefAttr}="${ref}"]')`;
}

// clickRef：用真实鼠标事件点元素中心，与任务面板的用户点击走同一条路。
browserView.prototype.clickRef = async function (ctx, ref) {
  const selector = browserRefSelector(ref);
  const pointBox = [null];
  const script = `(() => { const e = ${selector}; if (!e) return null; e.scrollIntoView({block: "center", inline: "center"}); const r = e.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`;
  await this.evaluate(ctx, script, pointBox);
  const point = pointBox[0];
  if (point == null) {
    throw new Error(`找不到元素 ${ref}：页面可能已变化，请重新获取快照`);
  }
  for (const step of [
    { type: "mouseMoved", x: point.X, y: point.Y },
    { type: "mousePressed", x: point.X, y: point.Y, button: "left", buttons: 1, clickCount: 1 },
    { type: "mouseReleased", x: point.X, y: point.Y, button: "left", clickCount: 1 },
  ]) {
    await this.pageCall(ctx, "Input.dispatchMouseEvent", step);
  }
};

browserView.prototype.typeRef = async function (ctx, ref, text, submit) {
  await this.clickRef(ctx, ref);
  const selector = browserRefSelector(ref);
  const script = `(() => { const e = ${selector}; if (!e) return false; e.focus(); if (typeof e.select === "function") e.select(); else { const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } return true; })()`;
  const foundBox = [false];
  await this.evaluate(ctx, script, foundBox);
  const found = foundBox[0];
  if (!found) {
    throw new Error(`找不到元素 ${ref}：页面可能已变化，请重新获取快照`);
  }
  if (text === "") {
    await this.press(ctx, "Backspace");
  } else {
    await this.pageCall(ctx, "Input.insertText", { text });
  }
  if (submit) {
    return this.press(ctx, "Enter");
  }
};

const browserKeys = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9, text: "" },
  Escape: { code: "Escape", keyCode: 27, text: "" },
  Backspace: { code: "Backspace", keyCode: 8, text: "" },
  Delete: { code: "Delete", keyCode: 46, text: "" },
  ArrowUp: { code: "ArrowUp", keyCode: 38, text: "" },
  ArrowDown: { code: "ArrowDown", keyCode: 40, text: "" },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37, text: "" },
  ArrowRight: { code: "ArrowRight", keyCode: 39, text: "" },
  PageUp: { code: "PageUp", keyCode: 33, text: "" },
  PageDown: { code: "PageDown", keyCode: 34, text: "" },
  Home: { code: "Home", keyCode: 36, text: "" },
  End: { code: "End", keyCode: 35, text: "" },
  " ": { code: "Space", keyCode: 32, text: " " },
};

browserView.prototype.press = async function (ctx, key) {
  if (key.toLowerCase() === "space") {
    key = " ";
  }
  const spec = browserKeys[key];
  if (spec === undefined) {
    throw new Error(`不支持的按键 ${JSON.stringify(key)}`);
  }
  const down = { type: "rawKeyDown", key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
  if (spec.text !== "") {
    down.type = "keyDown";
    down.text = spec.text;
    down.unmodifiedText = spec.text;
  }
  await this.pageCall(ctx, "Input.dispatchKeyEvent", down);
  await this.pageCall(ctx, "Input.dispatchKeyEvent", { type: "keyUp", key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode });
};

browserView.prototype.screenshot = async function (ctx) {
  // Go 的 v.mu 锁省略，JS 单线程无需加锁。
  const session = this.session;
  if (session === "") {
    throw new Error("没有可操作的标签页");
  }
  // 浏览器以高设备倍率渲染给面板看；模型拿 CSS 像素截图，内容相同，图片只有四分之一大。
  const params = { format: "jpeg", quality: 75 };
  const metrics = {
    CSSVisualViewport: { PageX: 0, PageY: 0, ClientWidth: 0, ClientHeight: 0 },
  };
  const ratio = { Result: { Value: 0 } };
  let ok = false;
  try {
    await this.client.call(ctx, session, "Page.getLayoutMetrics", null, metrics);
    await this.client.call(ctx, session, "Runtime.evaluate", { expression: "window.devicePixelRatio", returnByValue: true }, ratio);
    ok = ratio.Result.Value > 1 && metrics.CSSVisualViewport.ClientWidth > 0;
  } catch {
    ok = false;
  }
  if (ok) {
    const vp = metrics.CSSVisualViewport;
    params.clip = { x: vp.PageX, y: vp.PageY, width: vp.ClientWidth, height: vp.ClientHeight, scale: 1 / ratio.Result.Value };
  }
  const shot = { Data: "" };
  await this.client.call(ctx, session, "Page.captureScreenshot", params, shot);
  return shot.Data;
};

// agentOperation：跑一次语言模型操作，改页的操作返回事后快照，让 ref 保持最新。
browserView.prototype.agentOperation = async function (ctx, req) {
  switch (req.Operation) {
    case "snapshot":
      break;
    case "screenshot": {
      const frame = await this.screenshot(ctx);
      return [null, frame];
    }
    case "click":
      await this.clickRef(ctx, req.Ref);
      break;
    case "type":
      await this.typeRef(ctx, req.Ref, req.Text, req.Submit);
      break;
    case "press":
      await this.press(ctx, req.Key);
      break;
  }
  if (req.Operation !== "snapshot") {
    await this.settle(ctx);
  }
  const snap = await this.snapshot(ctx);
  return [snap, ""];
};

module.exports = { browserSnapshotElements, browserSnapshotText, browserRefAttr, browserSnapshotScript, cdpEvaluateResult, browserRefSelector, browserKeys };
