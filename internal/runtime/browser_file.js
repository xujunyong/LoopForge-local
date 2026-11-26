// browser_file.js —— 对应 Go 文件：internal/runtime/browser_file.go
// 作用：工作区文件预览：把 Agent 以 file:// 打开的页面文件送到用户浏览器渲染。
// Go 的 mime.TypeByExtension 在 Node 里没有内置对应，这里用常见扩展名表；
// http.DetectContentType 译为精简版内容嗅探；(值, error) 译为返回值、失败 throw。

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { BrowserState, BrowserHTTPResponse } = require("../domain/runner_workspace.js"); // 对应 Go 的 domain.BrowserState/BrowserHTTPResponse，domain 已翻译
const { DevServerBodyLimit, devServerLookup } = require("./browser_devserver.js"); // 对应 Go 同包的 DevServerBodyLimit/devServerLookup

// Workspace file access: pages the Agent opens as file:// are served to the
// user's own browser so they render natively, like dev servers. Paths are
// the ones the run browser sees (/workspace/... in a docker sidecar, the host
// workspace for a host browser) and must resolve inside that workspace.

// dockerWorkspaceRoot is where the browser sidecar mounts the workspace.
const dockerWorkspaceRoot = "/workspace";

// Outcomes shared by the sidecar script (exit codes) and the host reader.
const workspaceFileOK = 0;
const workspaceFileMissing = 44;
const workspaceFileOutside = 45;
const workspaceFileDirectory = 46; // a directory asked for without a trailing slash
const workspaceFileTooLarge = 47;
const workspaceFileNoIndexHTML = 48;

// workspaceFileScript prints a workspace file inside the sidecar:
// node -e script ROOT PATH LIMIT. Symlinks are resolved before the
// containment check, and a directory serves its index.html.
const workspaceFileScript = String.raw`const fs=require("fs"),path=require("path");const[root0,p,limit]=process.argv.slice(1);` +
  String.raw`const real=f=>{try{return fs.realpathSync(f)}catch(e){process.exit(44)}};const root=real(root0);` +
  String.raw`const inside=r=>r===root||r.startsWith(root.endsWith("/")?root:root+"/");` +
  String.raw`let r=real(p);if(!inside(r))process.exit(45);let st=fs.statSync(r);` +
  String.raw`if(st.isDirectory()){if(!p.endsWith("/"))process.exit(46);const i=path.join(r,"index.html");if(!fs.existsSync(i))process.exit(48);` +
  String.raw`r=real(i);if(!inside(r))process.exit(45);st=fs.statSync(r);}` +
  String.raw`if(!st.isFile())process.exit(44);if(st.size>+limit)process.exit(47);process.stdout.write(fs.readFileSync(r),()=>process.exit(0));`;

// workspaceFileExec runs the script in a sidecar; swapped in tests.
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
        resolve([null, code, null]);
        return;
      }
      if (code === 0) {
        resolve([out, workspaceFileOK, null]);
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

async function handleWorkspaceFile(ctx, runID, file) {
  if (!file.startsWith("/") || file.includes("\0")) {
    throw new Error("无效的工作区文件路径");
  }
  const [endpoint, ok] = devServerLookup(ctx, runID);
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
      // The gateway adds the slash, so relative links resolve in the directory.
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

// serveWorkspaceFile is the host browser's counterpart of workspaceFileScript.
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

// mime.TypeByExtension 的常见扩展名表，查不到时返回 ""。
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

function mimeTypeByExtension(ext) {
  return mimeTypesByExtension[ext.toLowerCase()] ?? "";
}

// http.DetectContentType 的精简版，只覆盖预览常见类型；
// 其余按 Go 的默认规则返回 text/plain 或 application/octet-stream。
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
