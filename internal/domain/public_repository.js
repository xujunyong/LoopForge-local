/**
 * @file internal/domain/public_repository.js
 * @description 对应 Go 源文件：internal/domain/public_repository.go
 * 职责边界：解析公开托管平台（GitHub）的仓库链接及带前缀标识，并在非 GitHub 地址时回退到共峰仓库链接解析。
 * 语法差异说明：
 * - Go 的 `net/url` 解析译为全局 WHATWG `URL`。
 * - Go 的 `(GongfengRepoInfo, bool)` 返回译为 `[GongfengRepoInfo, boolean]` 二元数组。
 * - `githubRepositoryPath` 虽为 Go 未导出变量，但同包 `mr.js` 引用了它，因此一并导出。
 */

"use strict";

const { GongfengRepoInfo, IsGongfengHost, ParseGongfengRepoURL } = require("./project.js");

const githubRepositoryPath = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * 解析 GitHub 公开仓库或共峰仓库的链接、SSH 克隆串与 `git clone` 命令。
 * 对 GitHub 仓库会生成带 `"github:"` 前缀的 `Project` 标识以防止与企业内项目 ID 冲突；非 GitHub 地址在主机校验通过后交由 `ParseGongfengRepoURL` 解析。
 *
 * @param {string} raw - 用户输入的原始仓库链接、SSH 地址、`github:owner/repo` 或 `git clone` 命令。
 * @returns {[GongfengRepoInfo, boolean]} 二元组 `[解析出的仓库信息, 是否解析成功]`。
 */
function ParseRepositoryURL(raw) {
  let s = raw.trim();
  if (s.startsWith("git clone ")) {
    s = s.slice("git clone ".length);
  }
  s = s.replace(/^['"]+|['"]+$/g, "");
  if (s.startsWith("github:")) {
    s = "https://github.com/" + s.slice("github:".length);
  }
  for (const prefix of ["git@github.com:", "ssh://git@github.com/", "ssh://git@github.com:22/"]) {
    if (s.startsWith(prefix)) {
      s = "https://github.com/" + s.slice(prefix.length);
      break;
    }
  }
  if (s.startsWith("github.com/")) {
    s = "https://" + s;
  }
  let u = null;
  try {
    u = new URL(s);
  } catch {
    u = null;
  }
  if (u != null && u.host === "github.com" && u.username === "" && u.password === "" && (u.protocol === "https:" || u.protocol === "http:")) {
    const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2) {
      return [new GongfengRepoInfo(), false];
    }
    const second = parts[1].endsWith(".git") ? parts[1].slice(0, parts[1].length - 4) : parts[1];
    const path = parts[0] + "/" + second;
    if (!githubRepositoryPath.test(path) || parts[0] === "." || parts[0] === ".." || parts[1] === "." || parts[1] === "..") {
      return [new GongfengRepoInfo(), false];
    }
    const base = "https://github.com/" + path;
    return [new GongfengRepoInfo({ Project: "github:" + path, Name: second, WebURL: base, CloneURL: base + ".git" }), true];
  }
  if (!/[:@]/.test(s)) {
    const slash = s.indexOf("/");
    const host = slash >= 0 ? s.slice(0, slash) : s;
    if (!IsGongfengHost(host)) {
      return [new GongfengRepoInfo(), false];
    }
  }
  return ParseGongfengRepoURL(raw);
}

module.exports = { githubRepositoryPath, ParseRepositoryURL };
