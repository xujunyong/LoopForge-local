/**
 * @file internal/runtime/browser_file.js
 * @description 对应 Go 文件：internal/runtime/browser_file.go。
 * 负责工作区本地文件的预览服务：将 Agent 以 `file://` 打开的工作区静态文件（Docker 边车内通过
 * `docker exec` 脚本读取，宿主浏览器直接读盘）安全校验后封装为 HTTP 响应返回给用户浏览器渲染。
 *
 * Go → JS 语法差异说明：
 * - `context.Context` 译为 `AbortSignal`；
 * - `(值, error)` 译为成功返回值、失败 `throw err`；`(值1, 值2, error)` 译为成功返回 `[值1, 值2]`、失败 `throw err`；
 * - Node 无内置 `mime.TypeByExtension` 与 `http.DetectContentType`，在文件底部以常见扩展名表与精简内容嗅探实现对应行为。
 */

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { BrowserState, BrowserHTTPResponse } = require("../domain/runner_workspace.js");
const { DevServerBodyLimit, devServerLookup } = require("./browser_devserver.js");

// 浏览器边车容器中工作区的挂载根目录。
const dockerWorkspaceRoot = "/workspace";

// 边车脚本退出码与宿主读取函数共用的结果状态码。
const workspaceFileOK = 0;
const workspaceFileMissing = 44;
const workspaceFileOutside = 45;
const workspaceFileDirectory = 46; // 请求目录路径时缺少末尾斜杠
const workspaceFileTooLarge = 47;
const workspaceFileNoIndexHTML = 48;

// 在 Docker 边车容器内读取工作区文件的 Node 脚本：node -e script ROOT PATH LIMIT。
// 解析软链接后再校验路径是否落在工作区内，目录路径自动尝试提供 index.html。
const workspaceFileScript = String.raw`const fs=require("fs"),path=require("path");const[root0,p,limit]=process.argv.slice(1);` +
  String.raw`const real=f=>{try{return fs.realpathSync(f)}catch(e){process.exit(44)}};const root=real(root0);` +
  String.raw`const inside=r=>r===root||r.startsWith(root.endsWith("/")?root:root+"/");` +
  String.raw`let r=real(p);if(!inside(r))process.exit(45);let st=fs.statSync(r);` +
  String.raw`if(st.isDirectory()){if(!p.endsWith("/"))process.exit(46);const i=path.join(r,"index.html");if(!fs.existsSync(i))process.exit(48);` +
  String.raw`r=real(i);if(!inside(r))process.exit(45);st=fs.statSync(r);}` +
  String.raw`if(!st.isFile())process.exit(44);if(st.size>+limit)process.exit(47);process.stdout.write(fs.readFileSync(r),()=>process.exit(0));`;

/**
 * 在 Docker 边车容器内执行 `workspaceFileScript` 读取工作区文件，可在测试中替换。
 * 退出码落在 `44..48` 区间时表示已知业务状态（不存在、越界、目录重定向、过大、缺 index.html），正常返回 `[null, code]`。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} container 浏览器边车容器名称。
 * @param {string} file 容器内文件绝对路径（如 `"/workspace/index.html"`）。
 * @returns {Promise<[Buffer | null, number]>} 成功时返回 `[文件字节或 null, 状态码]`；进程启动失败、取消或非预期退出时抛出错误。
 */
let workspaceFileExec = (ctx, container, file) => {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", container, "node", "-e", workspaceFileScript,
      dockerWorkspaceRoot, file, String(DevServerBodyLimit)]);
    const chunks = [];
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });
    let startErr = null;
    child.once("error", (err) => {
      startErr = err;
      reject(err);
    });
    child.once("close", (code, signal) => {
      if (startErr != null) {
        return;
      }
      const out = Buffer.concat(chunks);
      if (code != null && code >= workspaceFileMissing && code <= workspaceFileNoIndexHTML) {
        resolve([null, code]);
        return;
      }
      if (code === 0) {
        resolve([out, workspaceFileOK]);
        return;
      }
      if (ctx instanceof AbortSignal && ctx.aborted) {
        reject(ctx.reason);
        return;
      }
      reject(new Error(code == null ? `signal: ${signal}` : `exit status ${code}`));
    });
    if (ctx instanceof AbortSignal) {
      if (ctx.aborted) {
        child.kill();
      } else {
        ctx.addEventListener("abort", () => child.kill(), { once: true });
      }
    }
  });
};

/**
 * 处理一次工作区文件预览请求，根据运行浏览器端点类型从容器或宿主机读取文件并推导 `Content-Type`。
 *
 * @param {AbortSignal | null | undefined} ctx 取消信号。
 * @param {string} runID 运行实例 ID。
 * @param {string} file 请求预览的文件绝对路径（必须以 `"/"` 开头且不含空字符）。
 * @returns {Promise<BrowserState>} 包含 HTTP 响应或失败提示的浏览器状态对象；路径非法时抛出错误。
 */
async function handleWorkspaceFile(ctx, runID, file) {
  if (!file.startsWith("/") || file.includes("\0")) {
    throw new Error("无效的工作区文件路径");
  }
  const [endpoint, ok] = await devServerLookup(ctx, runID);
  if (!ok) {
    return new BrowserState({ Available: false, Reason: "Agent 浏览器尚未启动：工作区文件预览需要它所在的执行环境" });
  }
  let body = null;
  let code = 0;
  let err = null;
  if (endpoint.Kind === "docker") {
    try {
      [body, code] = await workspaceFileExec(ctx, endpoint.Container, file);
    } catch (e) {
      err = e;
    }
  } else if (endpoint.Workspace === "") {
    return new BrowserState({ Available: true, Kind: endpoint.Kind, Reason: "无法确定 Agent 浏览器的工作区目录" });
  } else {
    [body, code] = serveWorkspaceFile(endpoint.Workspace, file, DevServerBodyLimit);
  }
  if (err != null) {
    return new BrowserState({ Available: true, Kind: endpoint.Kind, Reason: "读取工作区文件失败：" + err.message });
  }
  const text = (status, message) => {
    return new BrowserState({ Available: true, Kind: endpoint.Kind, HTTP: new BrowserHTTPResponse({
      Status: status, Header: { "Content-Type": ["text/plain; charset=utf-8"] }, Body: Buffer.from(message, "utf8"),
    }) });
  };
  switch (code) {
    case workspaceFileOK:
      break;
    case workspaceFileMissing:
      return text(404, "文件不存在：" + file);
    case workspaceFileOutside:
      return text(403, "只能预览工作区内的文件");
    case workspaceFileDirectory:
      // 网关收到 301 后会补全末尾斜杠，确保页面内相对链接以该目录为基准解析。
      return new BrowserState({ Available: true, Kind: endpoint.Kind, HTTP: new BrowserHTTPResponse({ Status: 301 }) });
    case workspaceFileNoIndexHTML:
      return text(404, "目录下没有 index.html：" + file);
    case workspaceFileTooLarge:
      return new BrowserState({ Available: true, Kind: endpoint.Kind, Reason: `文件超过 ${DevServerBodyLimit >> 20} MB，预览暂不支持` });
    default:
      break;
  }
  let name = file;
  if (name.endsWith("/")) {
    name += "index.html";
  }
  let contentType = mimeTypeByExtension(path.posix.extname(name));
  if (contentType === "") {
    contentType = detectContentType(body);
  }
  return new BrowserState({ Available: true, Kind: endpoint.Kind, HTTP: new BrowserHTTPResponse({
    Status: 200, Header: { "Content-Type": [contentType] }, Body: body,
  }) });
}

/**
 * 宿主浏览器侧的工作区文件读取实现，与容器内 `workspaceFileScript` 逻辑等价。
 * 解析软链接并校验路径不越出 `root`，目录路径自动尝试读取 `index.html`，同时校验文件大小上限。
 *
 * @param {string} root 工作区根目录路径。
 * @param {string} file 待读取文件的路径。
 * @param {number} limit 允许读取的最大字节数。
 * @returns {[Buffer | null, number]} 返回 `[文件内容或 null, 结果状态码]` 元组。
 */
function serveWorkspaceFile(root, file, limit) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return [null, workspaceFileMissing];
  }
  const inside = (p) => {
    const rel = path.relative(realRoot, p);
    return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep);
  };
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    return [null, workspaceFileMissing];
  }
  if (!inside(real)) {
    return [null, workspaceFileOutside];
  }
  let info;
  try {
    info = fs.statSync(real);
  } catch {
    return [null, workspaceFileMissing];
  }
  if (info.isDirectory()) {
    if (!file.endsWith("/")) {
      return [null, workspaceFileDirectory];
    }
    let index;
    try {
      index = fs.realpathSync(path.join(real, "index.html"));
    } catch {
      return [null, workspaceFileNoIndexHTML];
    }
    if (!inside(index)) {
      return [null, workspaceFileOutside];
    }
    try {
      info = fs.statSync(index);
    } catch {
      return [null, workspaceFileNoIndexHTML];
    }
    real = index;
  }
  if (!info.isFile()) {
    return [null, workspaceFileMissing];
  }
  if (info.size > limit) {
    return [null, workspaceFileTooLarge];
  }
  let body;
  try {
    body = fs.readFileSync(real);
  } catch {
    return [null, workspaceFileMissing];
  }
  return [body, workspaceFileOK];
}

// 常见静态资源扩展名到 MIME 类型的映射表，对应 Go 的 mime.TypeByExtension。
const mimeTypesByExtension = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

/**
 * 根据文件扩展名查询对应的 MIME 类型，对应 Go 的 `mime.TypeByExtension`。
 *
 * @param {string} ext 带前导点的文件扩展名（如 `".html"`）。
 * @returns {string} 匹配到的 MIME 类型字符串；未命中返回空字符串 `""`。
 */
function mimeTypeByExtension(ext) {
  return mimeTypesByExtension[ext.toLowerCase()] ?? "";
}

/**
 * 基于文件头部字节嗅探 MIME 类型，对应 Go 的 `http.DetectContentType` 精简实现。
 * 覆盖常见预览格式，其余内容按是否全为可打印文本回退为 `text/plain` 或 `application/octet-stream`。
 *
 * @param {Buffer} body 文件原始字节内容。
 * @returns {string} 推断出的 `Content-Type` 字符串。
 */
function detectContentType(body) {
  const text = body.subarray(0, 512).toString("latin1");
  if (/^\s*<!doctype html/i.test(text) || /^\s*<(html|head|script|style|title|body)/i.test(text)) {
    return "text/html; charset=utf-8";
  }
  if (text.startsWith("<?xml")) {
    return "text/xml; charset=utf-8";
  }
  if (body.length >= 4 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) {
    return "image/png";
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return "image/jpeg";
  }
  if (body.length >= 6 && (text.startsWith("GIF87a") || text.startsWith("GIF89a"))) {
    return "image/gif";
  }
  if (text.startsWith("%PDF-")) {
    return "application/pdf";
  }
  if (/^\s*<svg[\s>]/.test(text)) {
    return "image/svg+xml";
  }
  let printable = true;
  for (let i = 0; i < body.length; i++) {
    const b = body[i];
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
      printable = false;
      break;
    }
  }
  return printable ? "text/plain; charset=utf-8" : "application/octet-stream";
}

module.exports = {
  dockerWorkspaceRoot,
  workspaceFileOK,
  workspaceFileMissing,
  workspaceFileOutside,
  workspaceFileDirectory,
  workspaceFileTooLarge,
  workspaceFileNoIndexHTML,
  workspaceFileScript,
  workspaceFileExec,
  handleWorkspaceFile,
  serveWorkspaceFile,
  mimeTypeByExtension,
  detectContentType,
};
