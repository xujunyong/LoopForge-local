// public_repository.js —— 对应 Go 文件：internal/domain/public_repository.go
// 作用：公开托管仓库链接解析。

"use strict";

const githubRepositoryPath = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// ParseRepositoryURL：接入公开托管，不改动上游适配器；带前缀的远端标识防止与企业项目 ID 冲突。返回 [信息, 是否成功]。
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

module.exports = { ParseRepositoryURL };
