/**
 * @file internal/runtime/browser_agent.js
 * @description 对应 Go 文件：internal/runtime/browser_agent.go。
 * 负责在 `browserView` 上提供面向语言模型的浏览器操作能力，包括页面脚本求值、
 * 可交互元素快照（打 ref 标记）、导航等待、按 ref 点击与输入、按键分发以及 CSS 像素截图。
 *
 * Go → JS 语法差异说明：
 * - `context.Context` 译为 `AbortSignal`；
 * - `(值, error)` 译为成功返回值、失败 `throw err`；`(值1, 值2, error)` 译为成功返回 `[值1, 值2]`、失败 `throw err`；
 * - Go 的 `*string` / `*bool` 等标量出参指针译为单元素数组（`out[0]`）；
 * - `sync.Mutex` 在单线程 JS 中省略；`select` + `time.After` 译为 `sleepOrAbort`；`context.WithTimeout` 译为 `withTimeout`；
 * - 同包跨文件方法挂载到 `browserView.prototype`。
 */

"use strict";

const { BrowserSnapshot } = require("../domain/runner_workspace.js");
const { browserView } = require("./browser_view.js");
const { assignWireJSON } = require("./browser_cdp.js");

const browserSnapshotElements = 150;
const browserSnapshotText = 12000;
const browserRefAttr = "data-agentflow-ref";

// 给可见可交互元素打 ref 属性，供语言模型无需坐标直接操作；使用 String.raw 保留脚本内反斜杠。
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

/**
 * 表示 CDP `Runtime.evaluate` 的响应结构体，对应 Go 的 `cdpEvaluateResult`。
 */
class cdpEvaluateResult {
  /**
   * 构造 `Runtime.evaluate` 响应对象，字段按 Go 零值初始化。
   *
   * @param {object} [init={}] 初始字段对象。
   * @param {{ Value: any }} [init.Result] 表达式求值结果包装对象。
   * @param {{ Text: string, Exception: { Description: string } } | null} [init.ExceptionDetails=null] 脚本异常详情。
   */
  constructor(init = {}) {
    this.Result = init.Result ?? { Value: null };
    this.ExceptionDetails = init.ExceptionDetails ?? null;
  }
}

/**
 * 等待指定毫秒数，若期间 `ctx` 取消则提前拒绝，对应 Go 的 `time.NewTimer` + `select`。
 * 用于 `settle` 开始前的短暂停顿。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {number} ms 等待毫秒数。
 * @returns {Promise<void>} 无返回值；取消时拒绝并抛出取消原因。
 */
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

/**
 * 固定等待指定毫秒数，对应 Go 的 `time.Sleep`。
 *
 * @param {number} ms 等待毫秒数。
 * @returns {Promise<void>} 无返回值。
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 基于父信号创建带超时的子取消信号，对应 Go 的 `context.WithTimeout`。
 * 用于 `settle` 每次探测 `document.readyState` 的 1 秒超时。
 *
 * @param {AbortSignal | null | undefined} ctx 父级取消信号。
 * @param {number} ms 超时毫秒数。
 * @returns {[AbortSignal, () => void]} 返回 `[子信号, 清理定时器函数]` 元组。
 */
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

/**
 * 在当前活动标签页内执行 JS 表达式，并将返回值解码写入 `out`。
 * 若页面脚本抛出异常则提取异常描述并抛出错误。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} expression 要在页面上下文执行的 JS 表达式。
 * @param {object | any[] | null | undefined} out 接收解码结果的目标对象或单元素数组（可为 `null`）。
 * @returns {Promise<void>} 无返回值；无活动标签页或脚本异常时抛出错误。
 */
browserView.prototype.evaluate = async function (ctx, expression, out) {
  // Go 的 v.mu 锁省略，JS 单线程无需加锁。
  const session = this.session;
  if (session === "") {
    throw new Error("没有可操作的标签页");
  }
  const result = new cdpEvaluateResult();
  await this.client.call(ctx, session, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, result);
  if (result.ExceptionDetails != null) {
    let msg = result.ExceptionDetails.Exception?.Description ?? "";
    if (msg === "") {
      msg = result.ExceptionDetails.Text ?? "";
    }
    throw new Error(`页面脚本执行失败：${msg}`);
  }
  if (out == null || result.Result.Value == null) {
    return;
  }
  assignWireJSON(out, result.Result.Value);
};

/**
 * 获取当前页面的文本内容与可见可交互元素快照，并为元素打上 ref 属性。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @returns {Promise<BrowserSnapshot>} 页面快照对象。
 */
browserView.prototype.snapshot = async function (ctx) {
  const snap = new BrowserSnapshot();
  await this.evaluate(ctx, browserSnapshotScript, snap);
  return snap;
};

/**
 * 在页面变更类操作后短暂等待导航稳定（先等待 400ms，再最多轮询 5 秒直到 `document.readyState === "complete"`）。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @returns {Promise<void>} 无返回值。
 */
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

/**
 * 校验元素 ref 格式（如 `"e12"`）并构造对应的 DOM 查询表达式。
 *
 * @param {string} ref 页面快照中返回的元素引用标识。
 * @returns {string} 可直接在页面求值的 `document.querySelector(...)` 表达式字符串。
 */
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

/**
 * 将指定 ref 对应的元素滚动到视口中央，并通过真实 CDP 鼠标事件点击其中心坐标。
 * 与任务面板的用户点击走同一条输入事件链路。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} ref 元素引用标识（如 `"e1"`）。
 * @returns {Promise<void>} 无返回值；元素不存在或事件分发失败时抛出错误。
 */
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

/**
 * 点击并全选指定 ref 元素的现有内容，随后输入指定文本（空串时按 Backspace 清空），可选按下回车提交。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} ref 元素引用标识。
 * @param {string} text 要输入的文本内容；为空字符串时清空原内容。
 * @param {boolean} submit 输入完成后是否按下 Enter 键提交。
 * @returns {Promise<void>} 无返回值；元素消失或 CDP 调用失败时抛出错误。
 */
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
    await this.press(ctx, "Enter");
  }
};

// 支持的常用控制键与 CDP 虚拟键码映射表，对应 Go 的 map[string]struct{...}。
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

/**
 * 向当前活动页面发送一次完整的键盘按下与抬起事件。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} key 按键名称（如 `"Enter"`、`"Escape"`、`"space"`）。
 * @returns {Promise<void>} 无返回值；不支持的按键或分发失败时抛出错误。
 */
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

/**
 * 截取当前活动标签页的 JPEG 画面并返回 Base64 字符串。
 * 当浏览器处于高设备像素比（`devicePixelRatio > 1`）时按 CSS 像素裁剪缩放，以减小传给模型的图片体积。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @returns {Promise<string>} Base64 编码的 JPEG 截图数据。
 */
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

/**
 * 执行一次语言模型发起的浏览器操作（快照、截图、点击、输入、按键）。
 * 对会改变页面状态的操作先等待页面稳定，再返回最新快照以保持 ref 有效。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {object} req 浏览器操作请求（`domain.BrowserRequest`，含 `Operation`/`Ref`/`Text`/`Submit`/`Key`）。
 * @returns {Promise<[BrowserSnapshot | null, string]>} 返回 `[页面快照或 null, 截图 Base64 或空串]` 元组。
 */
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
